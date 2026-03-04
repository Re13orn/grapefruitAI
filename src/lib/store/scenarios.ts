import { randomUUID } from "node:crypto";

import * as preferences from "./preferences.ts";

const MAX_SCENARIOS = 100;
const MAX_RUNS = 200;
const MAX_STEPS = 300;

export type ScenarioLogType = "syslog" | "agent";
export type ScenarioHistoryKind =
  | "hooks"
  | "crypto"
  | "nsurl"
  | "flutter"
  | "jni"
  | "xpc"
  | "privacy"
  | "hermes";

export type ScenarioPlatform = "fruity" | "droid";
export type ScenarioMode = "app" | "daemon";

export type NumericCompareOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
export type ValueCompareOp = "exists" | "eq" | "contains" | "match";

interface AssertionBase {
  negate?: boolean;
  message?: string;
}

export interface HistoryCountAssertion extends AssertionBase {
  type: "history_count";
  kind: ScenarioHistoryKind;
  op: NumericCompareOp;
  value: number;
  filter?: Record<string, string | number | boolean>;
}

export interface HistoryContainsAssertion extends AssertionBase {
  type: "history_contains";
  kind: ScenarioHistoryKind;
  keyword: string;
  field?: string;
  limit?: number;
  caseSensitive?: boolean;
}

export interface LogContainsAssertion extends AssertionBase {
  type: "log_contains";
  log: ScenarioLogType;
  keyword: string;
  caseSensitive?: boolean;
  tailBytes?: number;
}

export interface SavedValueAssertion extends AssertionBase {
  type: "saved_value";
  key: string;
  path?: string;
  op: ValueCompareOp;
  value?: unknown;
  caseSensitive?: boolean;
}

export interface ScriptAppliedAssertion extends AssertionBase {
  type: "script_applied";
  scriptName?: string;
  source?: "manual" | "startup";
  compileOk?: boolean;
  minHookedMethods?: number;
  sessionId?: string;
  pid?: number;
}

export type ScenarioAssertion =
  | HistoryCountAssertion
  | HistoryContainsAssertion
  | LogContainsAssertion
  | SavedValueAssertion
  | ScriptAppliedAssertion;

interface StepBase {
  id: string;
}

export interface NoteStep extends StepBase {
  type: "note";
  text: string;
}

export interface SleepStep extends StepBase {
  type: "sleep";
  ms: number;
}

export interface ClearHistoryStep extends StepBase {
  type: "clear_history";
  kind: ScenarioHistoryKind;
}

export interface ClearLogsStep extends StepBase {
  type: "clear_logs";
  log?: ScenarioLogType | "all";
}

export interface AgentRPCStep extends StepBase {
  type: "agent_rpc";
  namespace: string;
  method: string;
  args?: unknown[];
  saveAs?: string;
  expectError?: boolean;
}

export interface AssertStep extends StepBase {
  type: "assert";
  assertion: ScenarioAssertion;
  continueOnFailure?: boolean;
}

export type ScenarioStep =
  | NoteStep
  | SleepStep
  | ClearHistoryStep
  | ClearLogsStep
  | AgentRPCStep
  | AssertStep;

export interface ScenarioRecord {
  id: string;
  name: string;
  description: string;
  tags: string[];
  steps: ScenarioStep[];
  createdAt: string;
  updatedAt: string;
}

export interface ScenarioDraft {
  name: string;
  description?: string;
  tags?: string[];
  steps: ScenarioStep[];
}

export interface ScenarioPatch {
  name?: string;
  description?: string;
  tags?: string[];
  steps?: ScenarioStep[];
}

export interface ScenarioAssertionResult {
  passed: boolean;
  message?: string;
  detail?: string;
  actual?: unknown;
  expected?: unknown;
}

export type ScenarioStepRunStatus =
  | "passed"
  | "failed"
  | "error"
  | "skipped";

export interface ScenarioStepRunRecord {
  stepId: string;
  index: number;
  type: ScenarioStep["type"];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: ScenarioStepRunStatus;
  detail?: string;
  output?: unknown;
  assertion?: ScenarioAssertionResult;
}

export type ScenarioRunStatus = "passed" | "failed" | "error";

export interface ScenarioRunTarget {
  platform?: ScenarioPlatform;
  mode?: ScenarioMode;
  bundle?: string;
  pid?: number;
}

export interface ScenarioRunRecord {
  id: string;
  scenarioId: string;
  scenarioName: string;
  deviceId: string;
  identifier: string;
  target: ScenarioRunTarget;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: ScenarioRunStatus;
  stepResults: ScenarioStepRunRecord[];
  assertionsTotal: number;
  assertionsPassed: number;
  assertionsFailed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertString(
  value: unknown,
  field: string,
  options: { optional?: boolean; max?: number } = {},
): string {
  if (typeof value === "undefined" && options.optional) return "";
  if (typeof value !== "string") {
    throw new Error(`"${field}" must be a string`);
  }
  const trimmed = value.trim();
  if (!options.optional && trimmed.length === 0) {
    throw new Error(`"${field}" must not be empty`);
  }
  if (options.max && trimmed.length > options.max) {
    throw new Error(`"${field}" is too long`);
  }
  return trimmed;
}

function assertBoolean(value: unknown, field: string, fallback = false): boolean {
  if (typeof value === "undefined") return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`"${field}" must be a boolean`);
  }
  return value;
}

function assertNumber(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; fallback?: number } = {},
): number {
  if (typeof value === "undefined") {
    if (typeof options.fallback === "number") return options.fallback;
    throw new Error(`"${field}" must be a number`);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`"${field}" must be a finite number`);
  }
  if (typeof options.min === "number" && value < options.min) {
    throw new Error(`"${field}" must be >= ${options.min}`);
  }
  if (typeof options.max === "number" && value > options.max) {
    throw new Error(`"${field}" must be <= ${options.max}`);
  }
  return value;
}

function assertOptionalNumber(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  if (typeof value === "undefined") return undefined;
  return assertNumber(value, field, options);
}

function assertEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`"${field}" must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function normalizeTags(value: unknown): string[] {
  if (typeof value === "undefined") return [];
  if (!Array.isArray(value)) throw new Error('"tags" must be an array');
  const uniq = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim();
    if (!tag) continue;
    uniq.add(tag.slice(0, 48));
  }
  return [...uniq].slice(0, 30);
}

function normalizeHistoryKind(value: unknown, field: string): ScenarioHistoryKind {
  return assertEnum(value, field, [
    "hooks",
    "crypto",
    "nsurl",
    "flutter",
    "jni",
    "xpc",
    "privacy",
    "hermes",
  ] as const);
}

function normalizeAssertion(raw: unknown): ScenarioAssertion {
  const obj = raw && isRecord(raw) ? raw : null;
  if (!obj) throw new Error("assertion must be an object");

  const type = assertString(obj.type, "assertion.type");
  const negate = assertBoolean(obj.negate, "assertion.negate", false);
  const message = assertString(obj.message, "assertion.message", {
    optional: true,
    max: 256,
  });

  switch (type) {
    case "history_count": {
      const op = assertEnum(obj.op, "assertion.op", [
        "eq",
        "ne",
        "gt",
        "gte",
        "lt",
        "lte",
      ] as const);
      const filter: Record<string, string | number | boolean> | undefined =
        isRecord(obj.filter)
          ? Object.fromEntries(
              Object.entries(obj.filter).flatMap(([key, value]) => {
                if (
                  typeof value === "string" ||
                  typeof value === "number" ||
                  typeof value === "boolean"
                ) {
                  return [[key, value] as const];
                }
                return [];
              }),
            )
          : undefined;
      return {
        type,
        kind: normalizeHistoryKind(obj.kind, "assertion.kind"),
        op,
        value: assertNumber(obj.value, "assertion.value", { min: 0 }),
        filter,
        negate,
        message: message || undefined,
      };
    }
    case "history_contains":
      return {
        type,
        kind: normalizeHistoryKind(obj.kind, "assertion.kind"),
        keyword: assertString(obj.keyword, "assertion.keyword", { max: 256 }),
        field: assertString(obj.field, "assertion.field", {
          optional: true,
          max: 128,
        }) || undefined,
        limit: assertNumber(obj.limit, "assertion.limit", {
          min: 1,
          max: 5000,
          fallback: 200,
        }),
        caseSensitive: assertBoolean(
          obj.caseSensitive,
          "assertion.caseSensitive",
          false,
        ),
        negate,
        message: message || undefined,
      };
    case "log_contains":
      return {
        type,
        log: assertEnum(obj.log, "assertion.log", ["syslog", "agent"] as const),
        keyword: assertString(obj.keyword, "assertion.keyword", { max: 256 }),
        caseSensitive: assertBoolean(
          obj.caseSensitive,
          "assertion.caseSensitive",
          false,
        ),
        tailBytes: assertNumber(obj.tailBytes, "assertion.tailBytes", {
          min: 1024,
          max: 4 * 1024 * 1024,
          fallback: 1024 * 1024,
        }),
        negate,
        message: message || undefined,
      };
    case "saved_value":
      return {
        type,
        key: assertString(obj.key, "assertion.key", { max: 96 }),
        path: assertString(obj.path, "assertion.path", {
          optional: true,
          max: 128,
        }) || undefined,
        op: assertEnum(obj.op, "assertion.op", [
          "exists",
          "eq",
          "contains",
          "match",
        ] as const),
        value: obj.value,
        caseSensitive: assertBoolean(
          obj.caseSensitive,
          "assertion.caseSensitive",
          false,
        ),
        negate,
        message: message || undefined,
      };
    case "script_applied": {
      const scriptName =
        assertString(obj.scriptName, "assertion.scriptName", {
          optional: true,
          max: 256,
        }) || undefined;
      const sourceRaw = obj.source;
      const source =
        typeof sourceRaw === "undefined"
          ? undefined
          : assertEnum(sourceRaw, "assertion.source", [
              "manual",
              "startup",
            ] as const);
      const sessionId =
        assertString(obj.sessionId, "assertion.sessionId", {
          optional: true,
          max: 128,
        }) || undefined;
      return {
        type,
        scriptName,
        source,
        compileOk: assertBoolean(obj.compileOk, "assertion.compileOk", true),
        minHookedMethods: assertNumber(
          obj.minHookedMethods,
          "assertion.minHookedMethods",
          {
            min: 0,
            max: 10_000,
            fallback: 1,
          },
        ),
        sessionId,
        pid: assertOptionalNumber(obj.pid, "assertion.pid", { min: 1 }),
        negate,
        message: message || undefined,
      };
    }
    default:
      throw new Error(`unsupported assertion type: ${type}`);
  }
}

function normalizeStep(raw: unknown): ScenarioStep {
  const obj = raw && isRecord(raw) ? raw : null;
  if (!obj) throw new Error("step must be an object");

  const type = assertString(obj.type, "step.type");
  const id = assertString(obj.id, "step.id", { optional: true, max: 96 }) || randomUUID();

  switch (type) {
    case "note":
      return {
        type,
        id,
        text: assertString(obj.text, "step.text", { max: 500 }),
      };
    case "sleep":
      return {
        type,
        id,
        ms: assertNumber(obj.ms, "step.ms", { min: 1, max: 600_000 }),
      };
    case "clear_history":
      return {
        type,
        id,
        kind: normalizeHistoryKind(obj.kind, "step.kind"),
      };
    case "clear_logs":
      return {
        type,
        id,
        log: assertEnum(obj.log ?? "all", "step.log", [
          "syslog",
          "agent",
          "all",
        ] as const),
      };
    case "agent_rpc":
      return {
        type,
        id,
        namespace: assertString(obj.namespace, "step.namespace", { max: 64 }),
        method: assertString(obj.method, "step.method", { max: 64 }),
        args: Array.isArray(obj.args) ? obj.args : [],
        saveAs: assertString(obj.saveAs, "step.saveAs", {
          optional: true,
          max: 96,
        }) || undefined,
        expectError: assertBoolean(obj.expectError, "step.expectError", false),
      };
    case "assert":
      return {
        type,
        id,
        assertion: normalizeAssertion(obj.assertion),
        continueOnFailure: assertBoolean(
          obj.continueOnFailure,
          "step.continueOnFailure",
          false,
        ),
      };
    default:
      throw new Error(`unsupported step type: ${type}`);
  }
}

function normalizeSteps(raw: unknown): ScenarioStep[] {
  if (!Array.isArray(raw)) throw new Error('"steps" must be an array');
  if (raw.length === 0) throw new Error('"steps" must contain at least one step');
  if (raw.length > MAX_STEPS) throw new Error(`too many steps, max ${MAX_STEPS}`);
  return raw.map(normalizeStep);
}

function normalizeStoredScenario(raw: unknown): ScenarioRecord | null {
  try {
    const obj = raw && isRecord(raw) ? raw : null;
    if (!obj) return null;
    const createdAt = assertString(obj.createdAt, "createdAt");
    const updatedAt = assertString(obj.updatedAt, "updatedAt");
    return {
      id: assertString(obj.id, "id", { max: 96 }),
      name: assertString(obj.name, "name", { max: 120 }),
      description:
        assertString(obj.description, "description", {
          optional: true,
          max: 1000,
        }) || "",
      tags: normalizeTags(obj.tags),
      steps: normalizeSteps(obj.steps),
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function normalizeStoredRun(raw: unknown): ScenarioRunRecord | null {
  const obj = raw && isRecord(raw) ? raw : null;
  if (!obj) return null;

  const stepResultsRaw = obj.stepResults;
  if (!Array.isArray(stepResultsRaw)) return null;

  const stepResults: ScenarioStepRunRecord[] = stepResultsRaw
    .filter(isRecord)
    .map((item, index) => {
      const fallbackAt = new Date().toISOString();
      return {
        stepId: typeof item.stepId === "string" ? item.stepId : randomUUID(),
        index:
          typeof item.index === "number" && Number.isFinite(item.index)
            ? item.index
            : index,
        type:
          item.type === "note" ||
          item.type === "sleep" ||
          item.type === "clear_history" ||
          item.type === "clear_logs" ||
          item.type === "agent_rpc" ||
          item.type === "assert"
            ? item.type
            : "note",
        startedAt:
          typeof item.startedAt === "string" ? item.startedAt : fallbackAt,
        endedAt: typeof item.endedAt === "string" ? item.endedAt : fallbackAt,
        durationMs:
          typeof item.durationMs === "number" && Number.isFinite(item.durationMs)
            ? item.durationMs
            : 0,
        status:
          item.status === "passed" ||
          item.status === "failed" ||
          item.status === "error" ||
          item.status === "skipped"
            ? item.status
            : "error",
        detail: typeof item.detail === "string" ? item.detail : undefined,
        output: item.output,
        assertion: isRecord(item.assertion)
          ? {
              passed: item.assertion.passed === true,
              message:
                typeof item.assertion.message === "string"
                  ? item.assertion.message
                  : undefined,
              detail:
                typeof item.assertion.detail === "string"
                  ? item.assertion.detail
                  : undefined,
              actual: item.assertion.actual,
              expected: item.assertion.expected,
            }
          : undefined,
      };
    });

  return {
    id: typeof obj.id === "string" ? obj.id : randomUUID(),
    scenarioId: typeof obj.scenarioId === "string" ? obj.scenarioId : "",
    scenarioName: typeof obj.scenarioName === "string" ? obj.scenarioName : "",
    deviceId: typeof obj.deviceId === "string" ? obj.deviceId : "",
    identifier: typeof obj.identifier === "string" ? obj.identifier : "",
    target: isRecord(obj.target) ? (obj.target as ScenarioRunTarget) : {},
    startedAt: typeof obj.startedAt === "string" ? obj.startedAt : new Date().toISOString(),
    endedAt: typeof obj.endedAt === "string" ? obj.endedAt : new Date().toISOString(),
    durationMs: typeof obj.durationMs === "number" ? obj.durationMs : 0,
    status:
      obj.status === "passed" || obj.status === "failed" || obj.status === "error"
        ? obj.status
        : "error",
    stepResults,
    assertionsTotal:
      typeof obj.assertionsTotal === "number" ? obj.assertionsTotal : 0,
    assertionsPassed:
      typeof obj.assertionsPassed === "number" ? obj.assertionsPassed : 0,
    assertionsFailed:
      typeof obj.assertionsFailed === "number" ? obj.assertionsFailed : 0,
  };
}

export function normalizeScenarioDraft(raw: unknown): ScenarioDraft {
  const obj = raw && isRecord(raw) ? raw : null;
  if (!obj) throw new Error("scenario payload must be an object");
  return {
    name: assertString(obj.name, "name", { max: 120 }),
    description:
      assertString(obj.description, "description", {
        optional: true,
        max: 1000,
      }) || undefined,
    tags: normalizeTags(obj.tags),
    steps: normalizeSteps(obj.steps),
  };
}

export function normalizeScenarioPatch(raw: unknown): ScenarioPatch {
  const obj = raw && isRecord(raw) ? raw : null;
  if (!obj) throw new Error("scenario patch payload must be an object");

  const patch: ScenarioPatch = {};
  if ("name" in obj) {
    patch.name = assertString(obj.name, "name", { max: 120 });
  }
  if ("description" in obj) {
    patch.description =
      assertString(obj.description, "description", {
        optional: true,
        max: 1000,
      }) || "";
  }
  if ("tags" in obj) {
    patch.tags = normalizeTags(obj.tags);
  }
  if ("steps" in obj) {
    patch.steps = normalizeSteps(obj.steps);
  }

  if (Object.keys(patch).length === 0) {
    throw new Error("empty scenario patch");
  }
  return patch;
}

function loadScenarioRecords(key: string): ScenarioRecord[] {
  const raw = preferences.get(key);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeStoredScenario)
    .filter((item): item is ScenarioRecord => !!item)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function loadRunRecords(key: string): ScenarioRunRecord[] {
  const raw = preferences.get(key);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeStoredRun)
    .filter((item): item is ScenarioRunRecord => !!item)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function createScenarioStore(deviceId: string, identifier: string) {
  const key = `scenarios:${deviceId}|${identifier}`;

  function saveAll(records: ScenarioRecord[]) {
    preferences.set(key, records.slice(0, MAX_SCENARIOS));
  }

  return {
    list(): ScenarioRecord[] {
      return loadScenarioRecords(key);
    },
    get(id: string): ScenarioRecord | null {
      return loadScenarioRecords(key).find((item) => item.id === id) ?? null;
    },
    create(draft: ScenarioDraft): ScenarioRecord {
      const now = new Date().toISOString();
      const record: ScenarioRecord = {
        id: randomUUID(),
        name: draft.name,
        description: draft.description ?? "",
        tags: draft.tags ?? [],
        steps: draft.steps,
        createdAt: now,
        updatedAt: now,
      };
      const records = loadScenarioRecords(key);
      records.unshift(record);
      saveAll(records);
      return record;
    },
    update(id: string, patch: ScenarioPatch): ScenarioRecord | null {
      const records = loadScenarioRecords(key);
      const idx = records.findIndex((item) => item.id === id);
      if (idx === -1) return null;

      const current = records[idx];
      const next: ScenarioRecord = {
        ...current,
        name: typeof patch.name === "string" ? patch.name : current.name,
        description:
          typeof patch.description === "string"
            ? patch.description
            : current.description,
        tags: Array.isArray(patch.tags) ? patch.tags : current.tags,
        steps: Array.isArray(patch.steps) ? patch.steps : current.steps,
        updatedAt: new Date().toISOString(),
      };

      records[idx] = next;
      saveAll(records);
      return next;
    },
    remove(id: string): boolean {
      const records = loadScenarioRecords(key);
      const next = records.filter((item) => item.id !== id);
      if (next.length === records.length) return false;
      saveAll(next);
      return true;
    },
    clear(): void {
      preferences.rm(key);
    },
  };
}

export function createScenarioRunStore(deviceId: string, identifier: string) {
  const key = `scenario-runs:${deviceId}|${identifier}`;

  function saveAll(records: ScenarioRunRecord[]) {
    preferences.set(key, records.slice(0, MAX_RUNS));
  }

  return {
    list(options: { scenarioId?: string } = {}): ScenarioRunRecord[] {
      const records = loadRunRecords(key);
      if (!options.scenarioId) return records;
      return records.filter((run) => run.scenarioId === options.scenarioId);
    },
    get(id: string): ScenarioRunRecord | null {
      return loadRunRecords(key).find((item) => item.id === id) ?? null;
    },
    append(run: ScenarioRunRecord): ScenarioRunRecord {
      const records = loadRunRecords(key);
      records.unshift(run);
      saveAll(records);
      return run;
    },
    remove(id: string): boolean {
      const records = loadRunRecords(key);
      const next = records.filter((item) => item.id !== id);
      if (next.length === records.length) return false;
      saveAll(next);
      return true;
    },
    clear(): void {
      preferences.rm(key);
    },
  };
}
