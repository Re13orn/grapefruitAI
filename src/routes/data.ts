import { Hono } from "hono";

import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import nodePath from "node:path";

import paths from "../lib/paths.ts";
import { HookStore } from "../lib/store/hooks.ts";
import { CryptoStore } from "../lib/store/crypto.ts";
import { NSURLStore } from "../lib/store/nsurl.ts";
import { FlutterStore } from "../lib/store/flutter.ts";
import { JNIStore } from "../lib/store/jni.ts";
import { XPCStore } from "../lib/store/xpc.ts";
import { HermesStore } from "../lib/store/hermes.ts";
import { PrivacyStore } from "../lib/store/privacy.ts";
import { createTapStore } from "../lib/store/taps.ts";
import {
  createHookScriptStore,
  createHookScriptPresetStore,
  ensureBuiltinHookScripts,
  type HookScriptInput,
  type HookScriptPatch,
  type HookScriptPresetInput,
  type HookScriptPresetPatch,
  type HookScriptPresetItem,
} from "../lib/store/scripts.ts";
import { listBuiltinHookScriptTemplates } from "../lib/builtin-hooks.ts";
import { toHAR } from "../lib/har.ts";
const LOG_TAIL_BYTES = 1024 * 1024; // 1MB

interface QueryOptions {
  limit?: number;
  offset?: number;
  since?: string;
  filters?: Record<string, string | number | boolean | undefined>;
}

interface LogStore<TRecord> {
  query(options: QueryOptions, defaultLimit: number): TRecord[];
  count(filters?: Record<string, string | number | boolean>): number;
  rm(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseScriptInput(body: unknown): HookScriptInput | null {
  if (!isRecord(body)) return null;
  const { name, content, enabled, runOnAppLaunch } = body;
  if (typeof name !== "string" || typeof content !== "string") return null;
  if (typeof enabled !== "undefined" && typeof enabled !== "boolean")
    return null;
  if (
    typeof runOnAppLaunch !== "undefined" &&
    typeof runOnAppLaunch !== "boolean"
  )
    return null;

  return { name, content, enabled, runOnAppLaunch };
}

function parseScriptPatch(body: unknown): HookScriptPatch | null {
  if (!isRecord(body)) return null;
  const patch: HookScriptPatch = {};

  if ("name" in body) {
    if (typeof body.name !== "string") return null;
    patch.name = body.name;
  }
  if ("content" in body) {
    if (typeof body.content !== "string") return null;
    patch.content = body.content;
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") return null;
    patch.enabled = body.enabled;
  }
  if ("runOnAppLaunch" in body) {
    if (typeof body.runOnAppLaunch !== "boolean") return null;
    patch.runOnAppLaunch = body.runOnAppLaunch;
  }

  if (Object.keys(patch).length === 0) return null;
  return patch;
}

function parseScriptPresetItems(value: unknown): HookScriptPresetItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: HookScriptPresetItem[] = [];

  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const { scriptId, enabled, runOnAppLaunch } = raw;
    if (typeof scriptId !== "string") return null;
    if (typeof enabled !== "boolean") return null;
    if (typeof runOnAppLaunch !== "boolean") return null;
    items.push({ scriptId, enabled, runOnAppLaunch });
  }

  return items;
}

function parseScriptPresetInput(body: unknown): HookScriptPresetInput | null {
  if (!isRecord(body)) return null;
  const { name, items, autoApplyOnAppLaunch } = body;
  if (typeof name !== "string") return null;
  const parsedItems = parseScriptPresetItems(items);
  if (!parsedItems) return null;
  if (
    typeof autoApplyOnAppLaunch !== "undefined" &&
    typeof autoApplyOnAppLaunch !== "boolean"
  ) {
    return null;
  }
  return { name, items: parsedItems, autoApplyOnAppLaunch };
}

function parseScriptPresetPatch(body: unknown): HookScriptPresetPatch | null {
  if (!isRecord(body)) return null;
  const patch: HookScriptPresetPatch = {};

  if ("name" in body) {
    if (typeof body.name !== "string") return null;
    patch.name = body.name;
  }

  if ("items" in body) {
    const parsedItems = parseScriptPresetItems(body.items);
    if (!parsedItems) return null;
    patch.items = parsedItems;
  }
  if ("autoApplyOnAppLaunch" in body) {
    if (typeof body.autoApplyOnAppLaunch !== "boolean") return null;
    patch.autoApplyOnAppLaunch = body.autoApplyOnAppLaunch;
  }

  if (Object.keys(patch).length === 0) return null;
  return patch;
}

function parseHookPlatform(value: string | undefined): "droid" | "fruity" | null {
  if (value === "droid" || value === "fruity") return value;
  return null;
}

function parseBooleanQuery(value: string | undefined): boolean | undefined {
  if (typeof value === "undefined") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return undefined;
}

/**
 * Factory to create GET + DELETE route pair for a DB-backed log store.
 */
function createHistoryRoutes<TRecord>(config: {
  path: string;
  createStore: (deviceId: string, identifier: string) => LogStore<TRecord>;
  responseKey: string;
  defaultLimit: number;
  mapRecord: (record: TRecord) => unknown;
  extraQueryParams?: string[];
}) {
  const app = new Hono();

  app.get(`/${config.path}/:device/:identifier`, (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");

    const limit = parseInt(
      c.req.query("limit") || String(config.defaultLimit),
      10,
    );
    const offset = parseInt(c.req.query("offset") || "0", 10);
    const since = c.req.query("since");

    const filters: Record<string, string | undefined> = {};
    for (const param of config.extraQueryParams ?? []) {
      filters[param] = c.req.query(param);
    }
    const hasFilters = Object.values(filters).some((v) => v !== undefined);

    try {
      const store = config.createStore(deviceId, identifier);

      const records = store.query(
        { limit, offset, since, filters: hasFilters ? filters : undefined },
        config.defaultLimit,
      );
      const mapped = records.map(config.mapRecord);

      const countFilters: Record<string, string> = {};
      for (const param of config.extraQueryParams ?? []) {
        const v = filters[param];
        if (v) countFilters[param] = v;
      }
      const total = store.count(
        Object.keys(countFilters).length > 0 ? countFilters : undefined,
      );

      return c.json({ [config.responseKey]: mapped, total, limit, offset });
    } catch (e) {
      console.error(`Failed to query ${config.path}:`, e);
      return c.json({ [config.responseKey]: [], total: 0, limit, offset });
    }
  });

  app.delete(`/${config.path}/:device/:identifier`, (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");

    try {
      config.createStore(deviceId, identifier).rm();
      return c.body(null, 204);
    } catch (e) {
      console.error(`Failed to clear ${config.path}:`, e);
      return c.text(`Failed to clear ${config.path}`, 500);
    }
  });

  return app;
}

const hookRoutes = createHistoryRoutes({
  path: "hooks",
  createStore: (d, i) => new HookStore(d, i),
  responseKey: "hooks",
  defaultLimit: 1000,
  extraQueryParams: ["category"],
  mapRecord: (r) => ({
    id: r.id,
    timestamp: r.timestamp,
    category: r.category,
    symbol: r.symbol,
    direction: r.direction,
    line: r.line,
    extra: r.extra ? JSON.parse(r.extra) : undefined,
    createdAt: r.createdAt,
  }),
});

const cryptoRoutes = createHistoryRoutes({
  path: "history/crypto",
  createStore: (d, i) => new CryptoStore(d, i),
  responseKey: "logs",
  defaultLimit: 1000,
  mapRecord: (r) => ({
    id: r.id,
    timestamp: r.timestamp,
    symbol: r.symbol,
    direction: r.direction,
    line: r.line,
    extra: r.extra ? JSON.parse(r.extra) : undefined,
    backtrace: r.backtrace ? JSON.parse(r.backtrace) : undefined,
    data: r.data ? Buffer.from(r.data).toString("base64") : undefined,
    createdAt: r.createdAt,
  }),
});

const jniRoutes = createHistoryRoutes({
  path: "history/jni",
  createStore: (d, i) => new JNIStore(d, i),
  responseKey: "logs",
  defaultLimit: 5000,
  extraQueryParams: ["method"],
  mapRecord: (r) => ({
    id: r.id,
    timestamp: r.timestamp,
    type: r.type,
    method: r.method,
    callType: r.callType,
    threadId: r.threadId,
    args: r.args ? JSON.parse(r.args) : undefined,
    ret: r.ret,
    backtrace: r.backtrace ? JSON.parse(r.backtrace) : undefined,
    library: r.library,
    createdAt: r.createdAt,
  }),
});

const flutterRoutes = createHistoryRoutes({
  path: "history/flutter",
  createStore: (d, i) => new FlutterStore(d, i),
  responseKey: "logs",
  defaultLimit: 5000,
  mapRecord: (r) => ({
    id: r.id,
    timestamp: r.timestamp,
    type: r.type,
    direction: r.direction,
    channel: r.channel,
    data: r.data ? JSON.parse(r.data) : undefined,
    createdAt: r.createdAt,
  }),
});

const xpcRoutes = createHistoryRoutes({
  path: "history/xpc",
  createStore: (d, i) => new XPCStore(d, i),
  responseKey: "logs",
  defaultLimit: 5000,
  extraQueryParams: ["protocol"],
  mapRecord: (r) => ({
    id: r.id,
    timestamp: r.timestamp,
    protocol: r.protocol,
    event: r.event,
    direction: r.direction,
    service: r.service,
    peer: r.peer,
    message: r.message ? JSON.parse(r.message) : undefined,
    backtrace: r.backtrace ? JSON.parse(r.backtrace) : undefined,
    createdAt: r.createdAt,
  }),
});

const privacyRoutes = createHistoryRoutes({
  path: "history/privacy",
  createStore: (d, i) => new PrivacyStore(d, i),
  responseKey: "logs",
  defaultLimit: 1000,
  extraQueryParams: ["category", "severity"],
  mapRecord: (r) => ({
    id: r.id,
    timestamp: r.timestamp,
    category: r.category,
    severity: r.severity,
    symbol: r.symbol,
    direction: r.direction,
    line: r.line,
    extra: r.extra ? JSON.parse(r.extra) : undefined,
    backtrace: r.backtrace ? JSON.parse(r.backtrace) : undefined,
    createdAt: r.createdAt,
  }),
});

const routes = new Hono()
  .get("/logs/:device/:identifier/:type", async (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const type = c.req.param("type");

    if (!["syslog", "agent"].includes(type)) {
      return c.text("invalid log type", 400);
    }

    const filename = `${type}.log`;
    const logPath = nodePath.join(
      paths.data,
      "logs",
      deviceId,
      identifier,
      filename,
    );

    const stat = await fs.stat(logPath).catch(() => null);
    if (!stat) return c.text("");

    const { size } = stat;

    if (c.req.query("download")) {
      c.header(
        "Content-Disposition",
        `attachment; filename="${identifier}-${filename}"`,
      );
      c.header("Content-Type", "text/plain");
      c.header("Content-Length", size.toString());
      return c.body(
        Readable.toWeb(createReadStream(logPath)) as unknown as ReadableStream,
      );
    }

    if (size <= LOG_TAIL_BYTES)
      return c.text(await fs.readFile(logPath, "utf-8"));

    const handle = await fs.open(logPath, "r");
    const buf = Buffer.alloc(LOG_TAIL_BYTES);

    try {
      await handle.read(buf, 0, LOG_TAIL_BYTES, size - LOG_TAIL_BYTES);
      const chunk = buf.toString("utf-8");
      const idx = chunk.indexOf("\n");
      return c.text(idx === -1 ? chunk : chunk.slice(idx + 1));
    } finally {
      await handle.close();
    }
  })
  .delete("/logs/:device/:identifier", async (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");

    const logsDir = nodePath.join(paths.data, "logs", deviceId, identifier);
    await fs.rm(logsDir, { recursive: true, force: true });

    return c.body(null, 204);
  })
  // DB-backed log stores
  .route("/", hookRoutes)
  .route("/", cryptoRoutes)
  .route("/", jniRoutes)
  .route("/", flutterRoutes)
  // NSURL endpoints (not factored — different pattern)
  .get("/history/nsurl/:device/:identifier/har", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");

    try {
      const nsurlStore = new NSURLStore(deviceId, identifier);
      const requests = nsurlStore.query({ limit: 10000, offset: 0 });
      const har = toHAR(requests);

      c.header(
        "Content-Disposition",
        `attachment; filename="${identifier}.har"`,
      );
      return c.json(har);
    } catch (e) {
      console.error("Failed to export HAR:", e);
      return c.text("Failed to export HAR", 500);
    }
  })
  .get("/history/nsurl/:device/:identifier", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");

    const limit = parseInt(c.req.query("limit") || "5000", 10);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    try {
      const nsurlStore = new NSURLStore(deviceId, identifier);

      const requests = nsurlStore.query({ limit, offset });
      const total = nsurlStore.count();

      return c.json({ requests, total, limit, offset });
    } catch (e) {
      console.error("Failed to query NSURL records:", e);
      return c.json({ requests: [], total: 0, limit, offset });
    }
  })
  .delete("/history/nsurl/:device/:identifier", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");

    try {
      new NSURLStore(deviceId, identifier).rm();
      return c.body(null, 204);
    } catch (e) {
      console.error("Failed to clear NSURL records:", e);
      return c.text("Failed to clear NSURL records", 500);
    }
  })
  .get(
    "/history/nsurl/:device/:identifier/attachment/:requestId",
    async (c) => {
      const deviceId = c.req.param("device");
      const identifier = c.req.param("identifier");
      const requestId = c.req.param("requestId");

      try {
        const nsurlStore = new NSURLStore(deviceId, identifier);

        const attachment = nsurlStore.getAttachment(requestId);

        if (!attachment) {
          return c.text("No attachment found", 404);
        }

        const stat = await fs.stat(attachment.path).catch(() => null);
        if (!stat) {
          return c.text("Attachment file not found", 404);
        }

        c.header(
          "Content-Type",
          attachment.mimeType || "application/octet-stream",
        );
        c.header("Content-Length", stat.size.toString());
        return c.body(
          Readable.toWeb(
            createReadStream(attachment.path),
          ) as unknown as ReadableStream,
        );
      } catch (e) {
        console.error("Failed to serve attachment:", e);
        return c.text("Failed to serve attachment", 500);
      }
    },
  )
  .route("/", xpcRoutes)
  .route("/", privacyRoutes)
  // Hermes capture endpoints
  .get("/hermes/:device/:identifier", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const limit = parseInt(c.req.query("limit") || "100", 10);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    try {
      const store = new HermesStore(deviceId, identifier);
      const records = store.query({ limit, offset });
      const total = store.count();

      return c.json({
        logs: records.map((r) => ({
          id: r.id,
          url: r.url,
          hash: r.hash,
          size: r.size,
          createdAt: r.createdAt,
        })),
        total,
        limit,
        offset,
      });
    } catch (e) {
      console.error("Failed to query Hermes records:", e);
      return c.json({ logs: [], total: 0, limit, offset });
    }
  })
  .get("/hermes/:device/:identifier/download/:id", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const id = parseInt(c.req.param("id"), 10);

    try {
      const store = new HermesStore(deviceId, identifier);
      const blob = store.getBlob(id);
      if (!blob) return c.text("Not found", 404);

      const filename = blob.url.split("/").pop() || `hermes-${id}.bin`;
      c.header("Content-Disposition", `attachment; filename="${filename}"`);
      c.header("Content-Type", "application/octet-stream");
      c.header("Content-Length", blob.data.length.toString());
      return c.body(new Uint8Array(blob.data).buffer as ArrayBuffer);
    } catch (e) {
      console.error("Failed to serve Hermes blob:", e);
      return c.text("Failed to serve Hermes blob", 500);
    }
  })
  .delete("/hermes/:device/:identifier/:id", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const id = Number(c.req.param("id"));

    try {
      new HermesStore(deviceId, identifier).rmOne(id);
      return c.body(null, 204);
    } catch (e) {
      console.error("Failed to delete Hermes record:", e);
      return c.text("Failed to delete Hermes record", 500);
    }
  })
  .delete("/hermes/:device/:identifier", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");

    try {
      new HermesStore(deviceId, identifier).rm();
      return c.body(null, 204);
    } catch (e) {
      console.error("Failed to clear Hermes records:", e);
      return c.text("Failed to clear Hermes records", 500);
    }
  })
  // Taps snapshot endpoints
  .get("/taps/:device/:identifier", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");

    const store = createTapStore(deviceId, identifier);
    const snapshot = store.load();
    if (!snapshot) {
      return c.json(null);
    }
    return c.json(snapshot);
  })
  .delete("/taps/:device/:identifier", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");

    createTapStore(deviceId, identifier).clear();
    return c.body(null, 204);
  })
  .get("/script-templates/:platform", (c) => {
    const platform = parseHookPlatform(c.req.param("platform"));
    if (!platform) {
      return c.json({ error: "invalid platform" }, 400);
    }

    const deviceId = c.req.query("device");
    const identifier = c.req.query("identifier");
    const includeTargeted = parseBooleanQuery(c.req.query("includeTargeted")) === true;
    const importedNames = new Set<string>();

    if (typeof deviceId === "string" && typeof identifier === "string") {
      const scripts = createHookScriptStore(deviceId, identifier).list();
      for (const item of scripts) {
        importedNames.add(item.name);
      }
    }

    const normalizedIdentifier =
      typeof identifier === "string" && identifier.trim().length > 0
        ? identifier.trim()
        : undefined;
    const builtinTemplates = listBuiltinHookScriptTemplates(
      platform,
      normalizedIdentifier,
    ).filter((tpl) => includeTargeted || tpl.identifiers.length === 0);

    const templates = builtinTemplates.map((tpl) => ({
      id: tpl.id,
      name: tpl.name,
      description: tpl.description,
      platform: tpl.platform,
      identifiers: tpl.identifiers,
      content: tpl.content,
      enabled: tpl.enabled,
      runOnAppLaunch: tpl.runOnAppLaunch,
      recommended:
        typeof normalizedIdentifier === "string" &&
        tpl.identifiers.length > 0 &&
        tpl.identifiers.includes(normalizedIdentifier),
      imported: importedNames.has(tpl.name),
    }));

    return c.json(templates);
  })
  // Custom hook scripts endpoints
  .get("/scripts/:device/:identifier", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const platform = parseHookPlatform(c.req.query("platform"));
    const includeTargeted = parseBooleanQuery(c.req.query("includeTargeted")) === true;
    if (platform) {
      ensureBuiltinHookScripts(deviceId, identifier, platform, {
        includeTargeted,
      });
    }
    const store = createHookScriptStore(deviceId, identifier);
    return c.json(store.list());
  })
  .post("/scripts/:device/:identifier", async (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const body = await c.req.json().catch(() => null);
    const input = parseScriptInput(body);
    if (!input) {
      return c.json({ error: "invalid script payload" }, 400);
    }

    if (input.content.length > 200_000) {
      return c.json({ error: "script content is too large" }, 400);
    }

    const created = createHookScriptStore(deviceId, identifier).create(input);
    return c.json(created, 201);
  })
  .put("/scripts/:device/:identifier/:id", async (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const patch = parseScriptPatch(body);
    if (!patch) {
      return c.json({ error: "invalid script patch payload" }, 400);
    }
    if (typeof patch.content === "string" && patch.content.length > 200_000) {
      return c.json({ error: "script content is too large" }, 400);
    }

    const updated = createHookScriptStore(deviceId, identifier).update(id, patch);
    if (!updated) {
      return c.json({ error: "script not found" }, 404);
    }
    return c.json(updated);
  })
  .delete("/scripts/:device/:identifier/:id", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const id = c.req.param("id");
    const removed = createHookScriptStore(deviceId, identifier).remove(id);
    if (!removed) {
      return c.json({ error: "script not found" }, 404);
    }
    return c.body(null, 204);
  })
  // Script presets endpoints
  .get("/script-presets/:device/:identifier", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const store = createHookScriptPresetStore(deviceId, identifier);
    return c.json(store.list());
  })
  .post("/script-presets/:device/:identifier", async (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const body = await c.req.json().catch(() => null);
    const input = parseScriptPresetInput(body);
    if (!input) {
      return c.json({ error: "invalid script preset payload" }, 400);
    }
    if (input.items.length > 500) {
      return c.json({ error: "too many items in preset" }, 400);
    }

    const created = createHookScriptPresetStore(deviceId, identifier).create(input);
    return c.json(created, 201);
  })
  .put("/script-presets/:device/:identifier/:id", async (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const patch = parseScriptPresetPatch(body);
    if (!patch) {
      return c.json({ error: "invalid script preset patch payload" }, 400);
    }
    if (Array.isArray(patch.items) && patch.items.length > 500) {
      return c.json({ error: "too many items in preset" }, 400);
    }

    const updated = createHookScriptPresetStore(deviceId, identifier).update(
      id,
      patch,
    );
    if (!updated) {
      return c.json({ error: "script preset not found" }, 404);
    }
    return c.json(updated);
  })
  .post("/script-presets/:device/:identifier/:id/apply", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const id = c.req.param("id");
    const presetStore = createHookScriptPresetStore(deviceId, identifier);
    const preset = presetStore.get(id);
    if (!preset) {
      return c.json({ error: "script preset not found" }, 404);
    }

    const scripts = createHookScriptStore(deviceId, identifier).applyPreset(
      preset.items,
    );
    return c.json({
      presetId: preset.id,
      applied: preset.items.length,
      scripts,
    });
  })
  .delete("/script-presets/:device/:identifier/:id", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const id = c.req.param("id");
    const removed = createHookScriptPresetStore(deviceId, identifier).remove(id);
    if (!removed) {
      return c.json({ error: "script preset not found" }, 404);
    }
    return c.body(null, 204);
  });

export default routes;
