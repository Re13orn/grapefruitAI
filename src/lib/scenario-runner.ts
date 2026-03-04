import fs from "node:fs/promises";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";

import frida from "./xvii.ts";
import paths from "./paths.ts";
import { agent } from "./assets.ts";
import { resolveDevice } from "./device.ts";
import { HookStore } from "./store/hooks.ts";
import { CryptoStore } from "./store/crypto.ts";
import { NSURLStore } from "./store/nsurl.ts";
import { FlutterStore } from "./store/flutter.ts";
import { JNIStore } from "./store/jni.ts";
import { XPCStore } from "./store/xpc.ts";
import { PrivacyStore } from "./store/privacy.ts";
import { HermesStore } from "./store/hermes.ts";
import type {
  AgentRPCStep,
  AssertStep,
  NumericCompareOp,
  ScenarioAssertion,
  ScenarioAssertionResult,
  ScenarioHistoryKind,
  ScenarioLogType,
  ScenarioRecord,
  ScenarioRunRecord,
  ScenarioRunTarget,
  ScenarioStep,
  ScenarioStepRunRecord,
  ValueCompareOp,
} from "./store/scenarios.ts";

const LOG_TAIL_BYTES = 1024 * 1024;

interface ScenarioRunOptions {
  deviceId: string;
  identifier: string;
  scenario: ScenarioRecord;
  target?: ScenarioRunTarget;
  stopOnFailure?: boolean;
}

interface RuntimeContext {
  deviceId: string;
  identifier: string;
  saved: Record<string, unknown>;
}

function nowIso() {
  return new Date().toISOString();
}

function toRuntimeError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function containsText(
  source: string,
  keyword: string,
  caseSensitive = false,
): boolean {
  if (caseSensitive) return source.includes(keyword);
  return source.toLowerCase().includes(keyword.toLowerCase());
}

function compareNumber(actual: number, op: NumericCompareOp, expected: number) {
  switch (op) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "gt":
      return actual > expected;
    case "gte":
      return actual >= expected;
    case "lt":
      return actual < expected;
    case "lte":
      return actual <= expected;
  }
}

function pickValueByPath(source: unknown, path?: string): unknown {
  if (!path) return source;
  if (typeof source === "undefined" || source === null) return undefined;
  const keys = path.split(".").map((k) => k.trim()).filter(Boolean);
  let cur: unknown = source;
  for (const key of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function parseJSONRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function compareValue(
  actual: unknown,
  op: ValueCompareOp,
  expected: unknown,
  caseSensitive = false,
) {
  switch (op) {
    case "exists":
      return typeof actual !== "undefined" && actual !== null;
    case "eq":
      return JSON.stringify(actual) === JSON.stringify(expected);
    case "contains": {
      const source =
        typeof actual === "string" ? actual : JSON.stringify(actual ?? "");
      const keyword =
        typeof expected === "string" ? expected : JSON.stringify(expected ?? "");
      return containsText(source, keyword, caseSensitive);
    }
    case "match": {
      const source =
        typeof actual === "string" ? actual : JSON.stringify(actual ?? "");
      if (typeof expected !== "string") return false;
      try {
        const pattern = new RegExp(expected, caseSensitive ? "" : "i");
        return pattern.test(source);
      } catch {
        return false;
      }
    }
  }
}

function stringifyCompact(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createStepRunBase(index: number, step: ScenarioStep) {
  return {
    index,
    stepId: step.id,
    type: step.type,
    startedAt: nowIso(),
  };
}

function makeStepRecord(
  base: ReturnType<typeof createStepRunBase>,
  status: ScenarioStepRunRecord["status"],
  ext: Omit<ScenarioStepRunRecord, "index" | "stepId" | "type" | "startedAt" | "endedAt" | "durationMs" | "status"> = {},
): ScenarioStepRunRecord {
  const endedAt = nowIso();
  return {
    ...base,
    endedAt,
    durationMs:
      Math.max(
        0,
        new Date(endedAt).getTime() - new Date(base.startedAt).getTime(),
      ) || 0,
    status,
    ...ext,
  };
}

async function queryHistory(
  kind: ScenarioHistoryKind,
  deviceId: string,
  identifier: string,
  options: {
    limit?: number;
    offset?: number;
    filter?: Record<string, string | number | boolean>;
  } = {},
) {
  const limit = options.limit;
  const offset = options.offset ?? 0;
  const filter = options.filter ?? {};

  switch (kind) {
    case "hooks": {
      const store = new HookStore(deviceId, identifier);
      const records = store.query(
        {
          limit,
          offset,
          filters: filter,
        },
        1000,
      );
      return { count: store.count(filter), records };
    }
    case "crypto": {
      const store = new CryptoStore(deviceId, identifier);
      const records = store.query({ limit, offset }, 1000);
      return { count: store.count(), records };
    }
    case "flutter": {
      const store = new FlutterStore(deviceId, identifier);
      const records = store.query({ limit, offset }, 5000);
      return { count: store.count(), records };
    }
    case "jni": {
      const store = new JNIStore(deviceId, identifier);
      const records = store.query(
        {
          limit,
          offset,
          filters: filter,
        },
        5000,
      );
      return { count: store.count(filter), records };
    }
    case "xpc": {
      const store = new XPCStore(deviceId, identifier);
      const records = store.query(
        {
          limit,
          offset,
          filters: filter,
        },
        5000,
      );
      return { count: store.count(filter), records };
    }
    case "privacy": {
      const store = new PrivacyStore(deviceId, identifier);
      const records = store.query(
        {
          limit,
          offset,
          filters: filter,
        },
        1000,
      );
      return { count: store.count(filter), records };
    }
    case "nsurl": {
      const store = new NSURLStore(deviceId, identifier);
      const records = store.query({ limit: limit ?? 5000, offset });
      return { count: store.count(), records };
    }
    case "hermes": {
      const store = new HermesStore(deviceId, identifier);
      const records = store.query({
        limit: limit ?? 100,
        offset,
      });
      return { count: store.count(), records };
    }
  }
}

function clearHistory(
  kind: ScenarioHistoryKind,
  deviceId: string,
  identifier: string,
) {
  switch (kind) {
    case "hooks":
      new HookStore(deviceId, identifier).rm();
      return;
    case "crypto":
      new CryptoStore(deviceId, identifier).rm();
      return;
    case "flutter":
      new FlutterStore(deviceId, identifier).rm();
      return;
    case "jni":
      new JNIStore(deviceId, identifier).rm();
      return;
    case "xpc":
      new XPCStore(deviceId, identifier).rm();
      return;
    case "privacy":
      new PrivacyStore(deviceId, identifier).rm();
      return;
    case "nsurl":
      new NSURLStore(deviceId, identifier).rm();
      return;
    case "hermes":
      new HermesStore(deviceId, identifier).rm();
      return;
  }
}

async function readLogTail(
  deviceId: string,
  identifier: string,
  type: ScenarioLogType,
  maxBytes = LOG_TAIL_BYTES,
) {
  const filename = `${type}.log`;
  const logPath = nodePath.join(paths.data, "logs", deviceId, identifier, filename);
  const stat = await fs.stat(logPath).catch(() => null);
  if (!stat) return "";

  if (stat.size <= maxBytes) {
    return await fs.readFile(logPath, "utf8");
  }

  const handle = await fs.open(logPath, "r");
  const buf = Buffer.alloc(maxBytes);
  try {
    await handle.read(buf, 0, maxBytes, stat.size - maxBytes);
    const chunk = buf.toString("utf8");
    const idx = chunk.indexOf("\n");
    return idx === -1 ? chunk : chunk.slice(idx + 1);
  } finally {
    await handle.close();
  }
}

async function clearLogs(
  deviceId: string,
  identifier: string,
  logType: ScenarioLogType | "all" = "all",
) {
  const logsDir = nodePath.join(paths.data, "logs", deviceId, identifier);
  if (logType === "all") {
    await fs.rm(logsDir, { recursive: true, force: true });
    return;
  }
  const filename = `${logType}.log`;
  await fs.rm(nodePath.join(logsDir, filename), { force: true });
}

class AgentRPCInvoker {
  private session: Awaited<
    ReturnType<typeof import("frida").Device.prototype.attach>
  > | null = null;
  private script: Awaited<
    ReturnType<typeof import("frida").Session.prototype.createScript>
  > | null = null;

  constructor(
    private target: ScenarioRunTarget,
    private deviceId: string,
  ) {}

  private async ensure() {
    if (this.session && this.script) return;

    if (!this.target.platform || !this.target.mode) {
      throw new Error(
        'agent_rpc step requires run target "platform" and "mode"',
      );
    }

    const device = await resolveDevice(this.deviceId);
    let pid: number | undefined;

    if (this.target.mode === "app") {
      if (!this.target.bundle) {
        throw new Error('agent_rpc in app mode requires target "bundle"');
      }
      const apps = await device.enumerateApplications({
        identifiers: [this.target.bundle],
        scope: frida.Scope.Full,
      });
      const app = apps.at(0);
      if (!app?.pid) {
        throw new Error(
          `Application ${this.target.bundle} is not running on target device`,
        );
      }
      pid = app.pid;
    } else {
      if (typeof this.target.pid !== "number") {
        throw new Error('agent_rpc in daemon mode requires target "pid"');
      }
      pid = this.target.pid;
    }

    this.session = await device.attach(pid);
    this.script = await this.session.createScript(await agent(this.target.platform));
    await this.script.load();
  }

  async invoke(namespace: string, method: string, args: unknown[]) {
    await this.ensure();
    return await this.script!.exports.invoke(namespace, method, args);
  }

  async close() {
    const script = this.script;
    const session = this.session;
    this.script = null;
    this.session = null;
    await script?.unload().catch(() => {});
    await session?.detach().catch(() => {});
  }
}

async function evaluateAssertion(
  assertion: ScenarioAssertion,
  ctx: RuntimeContext,
): Promise<ScenarioAssertionResult> {
  const withNegate = (passed: boolean) =>
    assertion.negate ? !passed : passed;

  switch (assertion.type) {
    case "history_count": {
      const result = await queryHistory(assertion.kind, ctx.deviceId, ctx.identifier, {
        filter: assertion.filter,
      });
      const matched = compareNumber(result.count, assertion.op, assertion.value);
      const passed = withNegate(matched);
      return {
        passed,
        actual: result.count,
        expected: `${assertion.op} ${assertion.value}`,
        detail:
          assertion.message ||
          `${assertion.kind} count ${assertion.op} ${assertion.value}`,
      };
    }
    case "history_contains": {
      const result = await queryHistory(assertion.kind, ctx.deviceId, ctx.identifier, {
        limit: assertion.limit,
      });

      const matched = result.records.some((record) => {
        const target = assertion.field
          ? pickValueByPath(record, assertion.field)
          : record;
        return containsText(
          stringifyCompact(target),
          assertion.keyword,
          assertion.caseSensitive,
        );
      });

      const passed = withNegate(matched);
      return {
        passed,
        actual: matched,
        expected: assertion.keyword,
        detail:
          assertion.message ||
          `${assertion.kind} contains ${assertion.keyword}`,
      };
    }
    case "log_contains": {
      const text = await readLogTail(
        ctx.deviceId,
        ctx.identifier,
        assertion.log,
        assertion.tailBytes ?? LOG_TAIL_BYTES,
      );
      const matched = containsText(text, assertion.keyword, assertion.caseSensitive);
      const passed = withNegate(matched);
      return {
        passed,
        actual: matched,
        expected: assertion.keyword,
        detail:
          assertion.message ||
          `${assertion.log} log contains ${assertion.keyword}`,
      };
    }
    case "saved_value": {
      const value = pickValueByPath(ctx.saved[assertion.key], assertion.path);
      const matched = compareValue(
        value,
        assertion.op,
        assertion.value,
        assertion.caseSensitive,
      );
      const passed = withNegate(matched);
      return {
        passed,
        actual: value,
        expected: assertion.value,
        detail:
          assertion.message ||
          `saved value ${assertion.key}${assertion.path ? `.${assertion.path}` : ""} ${assertion.op}`,
      };
    }
    case "script_applied": {
      const store = new HookStore(ctx.deviceId, ctx.identifier);
      const records = store.query(
        {
          filters: {
            category: "script.apply.ack",
          },
        },
        1000,
      );

      const matchedRecords = records
        .map((record) => {
          const extra = parseJSONRecord(record.extra);
          const source = extra.source;
          const compileOk = extra.compileOk === true;
          const hookedMethods =
            typeof extra.hookedMethods === "number" ? extra.hookedMethods : 0;
          const sessionId =
            typeof extra.sessionId === "string" ? extra.sessionId : undefined;
          const pid = typeof extra.pid === "number" ? extra.pid : undefined;
          return {
            record,
            source:
              source === "startup" || source === "manual" ? source : undefined,
            compileOk,
            hookedMethods,
            sessionId,
            pid,
          };
        })
        .filter(({ record, source, sessionId, pid }) => {
          if (
            assertion.scriptName &&
            !record.symbol.includes(assertion.scriptName)
          ) {
            return false;
          }
          if (assertion.source && source !== assertion.source) return false;
          if (assertion.sessionId && sessionId !== assertion.sessionId) return false;
          if (typeof assertion.pid === "number" && pid !== assertion.pid) return false;
          return true;
        });

      const latest = matchedRecords.at(0);
      const matched =
        !!latest &&
        latest.compileOk === (assertion.compileOk ?? true) &&
        latest.hookedMethods >= (assertion.minHookedMethods ?? 1);
      const passed = withNegate(matched);
      return {
        passed,
        actual: latest
          ? {
              scriptName: latest.record.symbol,
              source: latest.source,
              compileOk: latest.compileOk,
              hookedMethods: latest.hookedMethods,
              sessionId: latest.sessionId,
              pid: latest.pid,
            }
          : null,
        expected: {
          scriptName: assertion.scriptName ?? "*",
          source: assertion.source ?? "any",
          compileOk: assertion.compileOk ?? true,
          minHookedMethods: assertion.minHookedMethods ?? 1,
          sessionId: assertion.sessionId ?? "any",
          pid: assertion.pid ?? "any",
        },
        detail:
          assertion.message ||
          `script apply matched ${matchedRecords.length} records, latest compileOk=${latest?.compileOk ?? "n/a"}, hookedMethods=${latest?.hookedMethods ?? 0}`,
      };
    }
  }
}

async function runAgentStep(
  step: AgentRPCStep,
  invoker: AgentRPCInvoker,
  ctx: RuntimeContext,
) {
  try {
    const output = await invoker.invoke(step.namespace, step.method, step.args ?? []);
    if (step.expectError) {
      return {
        status: "failed" as const,
        detail: `expected error but call succeeded: ${step.namespace}.${step.method}`,
        output,
      };
    }
    if (step.saveAs) {
      ctx.saved[step.saveAs] = output;
    }
    return {
      status: "passed" as const,
      detail: `${step.namespace}.${step.method} ok`,
      output,
    };
  } catch (err) {
    const message = toRuntimeError(err).message;
    if (step.expectError) {
      if (step.saveAs) {
        ctx.saved[step.saveAs] = { error: message };
      }
      return {
        status: "passed" as const,
        detail: `expected error received: ${message}`,
        output: { error: message },
      };
    }
    return {
      status: "error" as const,
      detail: message,
      output: { error: message },
    };
  }
}

export async function runScenario(
  options: ScenarioRunOptions,
): Promise<ScenarioRunRecord> {
  const startedAt = nowIso();
  const stopOnFailure = options.stopOnFailure !== false;
  const ctx: RuntimeContext = {
    deviceId: options.deviceId,
    identifier: options.identifier,
    saved: {},
  };

  let invoker: AgentRPCInvoker | null = null;
  const stepResults: ScenarioStepRunRecord[] = [];

  let assertionsTotal = 0;
  let assertionsPassed = 0;
  let assertionsFailed = 0;
  let runStatus: ScenarioRunRecord["status"] = "passed";
  let aborted = false;
  let abortIndex = -1;

  try {
    for (let index = 0; index < options.scenario.steps.length; index++) {
      const step = options.scenario.steps[index]!;
      const base = createStepRunBase(index, step);

      try {
        switch (step.type) {
          case "note": {
            stepResults.push(
              makeStepRecord(base, "passed", {
                detail: step.text,
              }),
            );
            break;
          }
          case "sleep": {
            await new Promise((resolve) => setTimeout(resolve, step.ms));
            stepResults.push(
              makeStepRecord(base, "passed", {
                detail: `slept ${step.ms}ms`,
              }),
            );
            break;
          }
          case "clear_history": {
            clearHistory(step.kind, ctx.deviceId, ctx.identifier);
            stepResults.push(
              makeStepRecord(base, "passed", {
                detail: `history cleared: ${step.kind}`,
              }),
            );
            break;
          }
          case "clear_logs": {
            await clearLogs(ctx.deviceId, ctx.identifier, step.log ?? "all");
            stepResults.push(
              makeStepRecord(base, "passed", {
                detail: `logs cleared: ${step.log ?? "all"}`,
              }),
            );
            break;
          }
          case "agent_rpc": {
            if (!invoker) {
              invoker = new AgentRPCInvoker(options.target ?? {}, ctx.deviceId);
            }
            const result = await runAgentStep(step, invoker, ctx);
            stepResults.push(
              makeStepRecord(base, result.status, {
                detail: result.detail,
                output: result.output,
              }),
            );
            if (result.status !== "passed") {
              runStatus = result.status === "failed" ? "failed" : "error";
              if (stopOnFailure) {
                aborted = true;
                abortIndex = index;
              }
            }
            break;
          }
          case "assert": {
            assertionsTotal += 1;
            const assertion = await evaluateAssertion(step.assertion, ctx);
            if (assertion.passed) {
              assertionsPassed += 1;
            } else {
              assertionsFailed += 1;
              if (runStatus === "passed") runStatus = "failed";
            }

            stepResults.push(
              makeStepRecord(base, assertion.passed ? "passed" : "failed", {
                detail: assertion.detail,
                assertion,
              }),
            );

            if (!assertion.passed && stopOnFailure && !step.continueOnFailure) {
              aborted = true;
              abortIndex = index;
            }
            break;
          }
        }
      } catch (err) {
        const error = toRuntimeError(err);
        stepResults.push(
          makeStepRecord(base, "error", {
            detail: error.message,
            output: { error: error.message },
          }),
        );
        runStatus = "error";
        if (stopOnFailure) {
          aborted = true;
          abortIndex = index;
        }
      }

      if (aborted) break;
    }

    if (aborted && abortIndex >= 0) {
      for (let i = abortIndex + 1; i < options.scenario.steps.length; i++) {
        const step = options.scenario.steps[i]!;
        const started = nowIso();
        stepResults.push({
          index: i,
          stepId: step.id,
          type: step.type,
          startedAt: started,
          endedAt: started,
          durationMs: 0,
          status: "skipped",
          detail: "skipped because previous step failed",
        });
      }
    }
  } finally {
    await invoker?.close();
  }

  const endedAt = nowIso();
  return {
    id: randomUUID(),
    scenarioId: options.scenario.id,
    scenarioName: options.scenario.name,
    deviceId: options.deviceId,
    identifier: options.identifier,
    target: options.target ?? {},
    startedAt,
    endedAt,
    durationMs:
      Math.max(
        0,
        new Date(endedAt).getTime() - new Date(startedAt).getTime(),
      ) || 0,
    status: runStatus,
    stepResults,
    assertionsTotal,
    assertionsPassed,
    assertionsFailed,
  };
}
