import { SessionDetachReason, type SpawnOptions, type Device } from "frida";
import { randomUUID } from "node:crypto";

import frida from "./lib/xvii.ts";
import env from "./lib/env.ts";
import { resolveDevice } from "./lib/device.ts";
import { agent } from "./lib/assets.ts";
import { check as isRestrictedBundle } from "./lib/regulation.ts";
import { LogWriter } from "./lib/log-writer.ts";
import { fnv1a } from "./lib/hash.ts";
import { NSURLStore } from "./lib/store/nsurl.ts";
import { HookStore } from "./lib/store/hooks.ts";
import { CryptoStore } from "./lib/store/crypto.ts";
import { FlutterStore } from "./lib/store/flutter.ts";
import { JNIStore } from "./lib/store/jni.ts";
import { XPCStore } from "./lib/store/xpc.ts";
import { HermesStore } from "./lib/store/hermes.ts";
import { PrivacyStore } from "./lib/store/privacy.ts";
import {
  createHookScriptStore,
  createHookScriptPresetStore,
  ensureBuiltinHookScripts,
  type HookScriptRecord,
} from "./lib/store/scripts.ts";
import { setup as setupRelay } from "./relay.ts";
import type { BaseMessage } from "@agent/common/hooks/context";
import type {
  Platform,
  SessionParams,
  SessionSocket,
  SessionStores,
} from "./types.ts";

const manager = frida.getDeviceManager();
const spawnLocks = new Map<string, Promise<number>>();
const SCRIPT_APPLY_ACK_FIELD = "__igf_script_apply_ack";
const SCRIPT_APPLY_ERROR_FIELD = "scriptApplyAck";

export { manager };

async function waitForAppPid(
  device: Device,
  bundleId: string,
  timeoutMs = 8_000,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const apps = await device.enumerateApplications({
      identifiers: [bundleId],
      scope: frida.Scope.Full,
    });

    const app = apps.at(0);
    if (app?.pid && app.pid > 0) return app.pid;

    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function waitForAppStopped(
  device: Device,
  bundleId: string,
  timeoutMs = 4_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await waitForAppPid(device, bundleId, 250);
    if (!pid) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function spawnWithLock(
  device: Device,
  bundleId: string,
  opt: SpawnOptions,
): Promise<number> {
  const deviceKey = (device as unknown as { id?: string }).id || "device";
  const key = `${deviceKey}:${bundleId}`;

  let pending = spawnLocks.get(key);
  if (!pending) {
    pending = device.spawn(bundleId, opt).finally(() => {
      spawnLocks.delete(key);
    });
    spawnLocks.set(key, pending);
  }

  return pending;
}

async function resolveAppPid(
  device: Device,
  bundleId: string,
  platform: Platform,
  options: { preferSpawn?: boolean } = {},
): Promise<{ pid: number; spawned: boolean }> {
  const match = await device.enumerateApplications({
    identifiers: [bundleId],
    scope: frida.Scope.Full,
  });

  const app = match.at(0);
  if (!app) throw new Error(`Application ${bundleId} not found on device`);

  const preferSpawn = platform === "droid" && options.preferSpawn === true;

  // Android sessions are generally more stable when attaching to an already
  // running process instead of forcing a new spawn.
  if (platform === "droid" && app.pid > 0 && !preferSpawn) {
    return { pid: app.pid, spawned: false };
  }

  if (!preferSpawn) {
    const frontmost = await device.getFrontmostApplication();
    if (frontmost?.pid === app.pid) return { pid: app.pid, spawned: false };
  }

  const devParams = await device.querySystemParameters();
  const opt: SpawnOptions = {};

  if (platform === "fruity") {
    if (devParams.access === "full" && devParams.os.id === "ios") {
      opt.env = {
        DISABLE_TWEAKS: "1", // workaround for ellekit crash
      };
    }
  }

  try {
    if (preferSpawn && app.pid > 0) {
      try {
        await device.kill(app.pid);
        await waitForAppStopped(device, bundleId);
      } catch (killError) {
        console.warn(`failed to stop app before spawn: ${bundleId}`, killError);
      }
    }
    return { pid: await spawnWithLock(device, bundleId, opt), spawned: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("Spawn already in progress") ||
      message.includes("The connection is closed")
    ) {
      const existingPid = await waitForAppPid(device, bundleId);
      if (existingPid) return { pid: existingPid, spawned: false };
    }
    throw err;
  }
}

function rpcErrorMessage(ns: string, method: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `RPC method ${ns}.${method} failed: ${msg}`;
}

interface ScriptApplyAckPayload {
  scriptName: string;
  compileOk: boolean;
  hookedMethods: number;
  installedHooksSync: number;
  failedMethods: string[];
  hitCount: number;
  firstHitAt?: string;
  lastHitAt?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseScriptApplyAck(raw: unknown): ScriptApplyAckPayload | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.scriptName !== "string" || raw.scriptName.length === 0) return null;
  if (typeof raw.compileOk !== "boolean") return null;

  const failedMethods = Array.isArray(raw.failedMethods)
    ? raw.failedMethods
        .filter((item): item is string => typeof item === "string")
        .slice(0, 100)
    : [];

  return {
    scriptName: raw.scriptName,
    compileOk: raw.compileOk,
    hookedMethods:
      typeof raw.hookedMethods === "number" && Number.isFinite(raw.hookedMethods)
        ? Math.max(0, Math.floor(raw.hookedMethods))
        : 0,
    installedHooksSync:
      typeof raw.installedHooksSync === "number" && Number.isFinite(raw.installedHooksSync)
        ? Math.max(0, Math.floor(raw.installedHooksSync))
        : typeof raw.hookedMethods === "number" && Number.isFinite(raw.hookedMethods)
          ? Math.max(0, Math.floor(raw.hookedMethods))
          : 0,
    failedMethods,
    hitCount:
      typeof raw.hitCount === "number" && Number.isFinite(raw.hitCount)
        ? Math.max(0, Math.floor(raw.hitCount))
        : 0,
    firstHitAt: typeof raw.firstHitAt === "string" ? raw.firstHitAt : undefined,
    lastHitAt: typeof raw.lastHitAt === "string" ? raw.lastHitAt : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
    finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : undefined,
    durationMs:
      typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs)
        ? Math.max(0, Math.floor(raw.durationMs))
        : undefined,
  };
}

function extractScriptApplyAckFromResult(result: unknown): {
  ack: ScriptApplyAckPayload | null;
  value: unknown;
} {
  if (!isRecord(result)) {
    return { ack: null, value: result };
  }
  const ack = parseScriptApplyAck(result[SCRIPT_APPLY_ACK_FIELD]);
  if (!ack) {
    return { ack: null, value: result };
  }

  const value =
    Object.prototype.hasOwnProperty.call(result, "value")
      ? result.value
      : undefined;
  return { ack, value };
}

function extractScriptApplyAckFromError(error: unknown): ScriptApplyAckPayload | null {
  if (!isRecord(error)) return null;
  return parseScriptApplyAck(error[SCRIPT_APPLY_ERROR_FIELD]);
}

function scriptApplyFallbackAck(
  scriptName: string,
  compileOk: boolean,
  error?: unknown,
): ScriptApplyAckPayload {
  return {
    scriptName,
    compileOk,
    hookedMethods: 0,
    installedHooksSync: 0,
    failedMethods: [],
    hitCount: 0,
    error: error ? (error instanceof Error ? error.message : String(error)) : undefined,
  };
}

function toScriptApplyHookEvent(
  ack: ScriptApplyAckPayload,
  source: "manual" | "startup",
  context?: { pid?: number; sessionId?: string },
): BaseMessage {
  const summary = [
    `script_apply_ack ${ack.scriptName}`,
    `source=${source}`,
    `compileOk=${ack.compileOk}`,
    `hookedMethods=${ack.installedHooksSync}`,
    `installedHooksSync=${ack.installedHooksSync}`,
    `failedMethods=${ack.failedMethods.length}`,
    `hitCount=${ack.hitCount}`,
  ].join(" ");

  return {
    subject: "hook",
    category: "script.apply.ack",
    symbol: ack.scriptName,
    dir: "leave",
    line: summary,
    extra: {
      pid: context?.pid,
      sessionId: context?.sessionId,
      source,
      compileOk: ack.compileOk,
      hookedMethods: ack.installedHooksSync,
      installedHooksSync: ack.installedHooksSync,
      failedMethods: ack.failedMethods,
      hitCount: ack.hitCount,
      firstHitAt: ack.firstHitAt,
      lastHitAt: ack.lastHitAt,
      error: ack.error,
      startedAt: ack.startedAt,
      finishedAt: ack.finishedAt,
      durationMs: ack.durationMs,
    },
  };
}

function emitScriptApplyAck(
  socket: SessionSocket,
  stores: SessionStores,
  source: "manual" | "startup",
  ack: ScriptApplyAckPayload,
  context?: { pid?: number; sessionId?: string },
) {
  const event = toScriptApplyHookEvent(ack, source, context);
  socket.emit("hook", event);
  stores.hooks.append(event);
}

function setupSocketHandlers(
  socket: SessionSocket,
  script: Awaited<
    ReturnType<typeof import("frida").Session.prototype.createScript>
  >,
  session: Awaited<ReturnType<typeof import("frida").Device.prototype.attach>>,
  logger: LogWriter,
  relay: { flush: () => Promise<void> },
  stores: SessionStores,
  context?: { pid?: number; sessionId?: string },
) {
  session.detached.connect((reason, crash) => {
    console.error("session detached:", reason, crash);
    switch (reason) {
      case SessionDetachReason.ApplicationRequested:
        break;
      case SessionDetachReason.DeviceLost:
        console.error("device lost");
        break;
      case SessionDetachReason.ProcessTerminated:
      case SessionDetachReason.ProcessReplaced:
        console.error("process was terminated or replaced");
    }
    socket.emit("detached", reason as string);
    socket.disconnect(true);
  });

  socket
    .on("rpc", (ns, method, args, ack) => {
      if (
        typeof ns !== "string" ||
        typeof method !== "string" ||
        !Array.isArray(args)
      ) {
        console.warn(`invalid RPC call ${ns}.${method}, dropping`, args);
        return;
      }

      console.info(`RPC method: ${ns}.${method}`, ...args);
      script.exports
        .invoke(ns, method, args)
        .then((result) => ack(null, result))
        .catch((err: Error) => {
          console.error(`RPC method ${method} failed:`, err);
          ack(rpcErrorMessage(ns, method, err), null);
        });
    })
    .on("eval", (source, name, ack) => {
      console.info(`evaluating script: ${name}`);
      script.exports
        .invoke("script", "evaluate", [source, name])
        .then((result: unknown) => {
          const extracted = extractScriptApplyAckFromResult(result);
          const applyAck =
            extracted.ack ?? scriptApplyFallbackAck(name, true);
          emitScriptApplyAck(socket, stores, "manual", applyAck, context);
          ack(null, extracted.value);
        })
        .catch((err: unknown) => {
          const applyAck =
            extractScriptApplyAckFromError(err) ??
            scriptApplyFallbackAck(name, false, err);
          emitScriptApplyAck(socket, stores, "manual", applyAck, context);
          ack(rpcErrorMessage("script", "evaluate", err), null);
        });
    })
    .on("clearLog", (type, ack) => {
      logger
        .empty(type)
        .then(() => ack(null, true))
        .catch((err) =>
          ack(rpcErrorMessage("log", "clearLog", err), null),
        );
    })
    .on("disconnect", () => {
      console.info("socket disconnected");
      script
        .unload()
        .catch((err) => {
          console.debug("script unload ignored:", err);
        })
        .finally(() =>
          session.detach().catch((err) => {
            console.debug("session detach ignored:", err);
          }),
        )
        .finally(() =>
          relay.flush().catch((err) => {
            console.debug("relay flush ignored:", err);
          }),
        )
        .finally(() => logger.close());
    });
}

async function runAutoLaunchScripts(
  script: Awaited<
    ReturnType<typeof import("frida").Session.prototype.createScript>
  >,
  scripts: HookScriptRecord[],
  options: {
    platform: Platform;
    spawned: boolean;
    onScriptApplyAck?: (ack: ScriptApplyAckPayload) => void;
  },
) {
  const runnable = scripts.filter((item) => item.enabled && item.runOnAppLaunch);
  for (const item of runnable) {
    try {
      // In Android spawn mode, Java.perform callbacks may run too late for
      // onCreate checks. Promote Java.perform(...) to Java.performNow(...)
      // for startup scripts.
      let source = item.content;
      if (options.platform === "droid" && options.spawned) {
        source = [
          "if (typeof Java !== 'undefined' && typeof Java.performNow !== 'function' && typeof Java.perform === 'function') {",
          "  Java.performNow = Java.perform;",
          "}",
          source.replace(/\bJava\.perform\s*\(/g, "Java.performNow("),
        ].join("\n");
        console.info(`startup script accelerated for droid spawn: ${item.name}`);
      }

      const result = await script.exports.invoke("script", "evaluate", [
        source,
        `startup:${item.name}`,
      ]);
      const extracted = extractScriptApplyAckFromResult(result);
      options.onScriptApplyAck?.(
        extracted.ack ?? scriptApplyFallbackAck(`startup:${item.name}`, true),
      );
      console.info(`startup script executed: ${item.name}`);
    } catch (err) {
      const extracted = extractScriptApplyAckFromError(err);
      options.onScriptApplyAck?.(
        extracted ?? scriptApplyFallbackAck(`startup:${item.name}`, false, err),
      );
      console.error(`failed to execute startup script ${item.name}:`, err);
    }
  }
}

export function parse(query: Record<string, unknown>): SessionParams | null {
  const { device, platform, mode, bundle, pid, name } = query;

  if (typeof device !== "string") return null;
  if (platform !== "fruity" && platform !== "droid") return null;
  if (mode !== "app" && mode !== "daemon") return null;

  if (mode === "app" && typeof bundle !== "string") return null;
  if (mode === "daemon" && typeof pid !== "string") return null;

  return {
    deviceId: device,
    platform: platform as Platform,
    mode: mode as "app" | "daemon",
    bundle: mode === "app" ? (bundle as string) : undefined,
    pid: mode === "daemon" ? parseInt(pid as string, 10) : undefined,
    name: typeof name === "string" ? name : undefined,
  };
}

export async function connect(socket: SessionSocket, params: SessionParams) {
  const {
    platform,
    mode,
    deviceId,
    bundle,
    pid: targetPid,
    name: processName,
  } = params;
  const device = await resolveDevice(deviceId);
  const appIdentifier = mode === "app" ? bundle : undefined;

  // For app mode we can resolve scripts up front (identifier is bundle).
  let appScripts: HookScriptRecord[] = [];
  let hasStartupScripts = false;
  if (mode === "app") {
    if (!appIdentifier) throw new Error("bundle is required for app mode");
    const builtinAdded = ensureBuiltinHookScripts(
      deviceId,
      appIdentifier,
      platform,
    );
    if (builtinAdded > 0) {
      console.info(
        `builtin startup scripts provisioned: ${builtinAdded} for ${appIdentifier}`,
      );
    }
    const scriptStore = createHookScriptStore(deviceId, appIdentifier);
    const presetStore = createHookScriptPresetStore(deviceId, appIdentifier);
    const startupPreset = presetStore.getAutoApplyOnAppLaunch();
    if (startupPreset) {
      scriptStore.applyPreset(startupPreset.items);
      console.info(`startup preset applied: ${startupPreset.name}`);
    }
    appScripts = scriptStore.list();
    hasStartupScripts = appScripts.some(
      (item) => item.enabled && item.runOnAppLaunch,
    );
  }

  let pid: number;
  let spawned = false;
  if (mode === "app") {
    if (!appIdentifier) throw new Error("bundle is required for app mode");

    if (isRestrictedBundle(appIdentifier)) {
      socket.emit("denied");
      setTimeout(() => socket.disconnect(true), 100);
      return;
    }

    const resolved = await resolveAppPid(device, appIdentifier, platform, {
      preferSpawn: platform === "droid" && hasStartupScripts,
    });
    pid = resolved.pid;
    spawned = resolved.spawned;
  } else {
    if (!targetPid) throw new Error("pid is required for daemon mode");
    pid = targetPid;
  }

  const session = await device.attach(pid);

  // Compute project identifier
  let identifier: string;
  if (mode === "app") {
    if (!appIdentifier) throw new Error("bundle is required for app mode");
    identifier = appIdentifier;
  } else {
    const pname = processName || `pid`;
    identifier = `${pname}-${fnv1a(pname + pid)}`;
  }

  // Create store instances
  const stores: SessionStores = {
    nsurl: new NSURLStore(deviceId, identifier),
    hooks: new HookStore(deviceId, identifier),
    crypto: new CryptoStore(deviceId, identifier),
    flutter: new FlutterStore(deviceId, identifier),
    jni: new JNIStore(deviceId, identifier),
    xpc: new XPCStore(deviceId, identifier),
    hermes: new HermesStore(deviceId, identifier),
    privacy: new PrivacyStore(deviceId, identifier),
  };
  const logHandles = await LogWriter.open(deviceId, identifier);
  const script = await session.createScript(await agent(platform));
  const sessionId = randomUUID();

  const relay = setupRelay(socket, script, logHandles, stores, {
    pid,
    sessionId,
  });
  setupSocketHandlers(socket, script, session, logHandles, relay, stores, {
    pid,
    sessionId,
  });

  await script.load();

  if (mode === "app") {
    if (platform === "droid" && hasStartupScripts && !spawned) {
      throw new Error(
        "failed to spawn android app for startup scripts; early lifecycle hooks would be unreliable. Stop the app and reconnect.",
      );
    }

    if (hasStartupScripts) {
      await runAutoLaunchScripts(script, appScripts, {
        platform,
        spawned,
        onScriptApplyAck: (ack) =>
          emitScriptApplyAck(socket, stores, "startup", ack, {
            pid,
            sessionId,
          }),
      });
    }

    if (spawned) {
      try {
        await device.resume(pid);
      } catch (error) {
        console.warn(`failed to resume process ${pid}:`, error);
      }
      if (platform === "droid" && appIdentifier) {
        const stablePid = await waitForAppPid(device, appIdentifier, 3_000);
        if (stablePid && stablePid !== pid) {
          console.info(`android app pid stabilized from ${pid} to ${stablePid}`);
        }
      }
    }
  }

  socket.emit("ready", session.pid);
}
