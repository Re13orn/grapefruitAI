import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  Braces,
  Loader2,
  Play,
  Plus,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Mode, useSession } from "@/context/SessionContext";
import { useQueryClient } from "@/lib/queries";
import { cn } from "@/lib/utils";

interface ScenarioStep {
  id?: string;
  type: string;
  [key: string]: unknown;
}

interface ScenarioRecord {
  id: string;
  name: string;
  description: string;
  tags: string[];
  steps: ScenarioStep[];
  createdAt: string;
  updatedAt: string;
}

interface ScenarioTemplateRecord {
  id: string;
  name: string;
  description: string;
  tags: string[];
  steps: ScenarioStep[];
}

type ScenarioStepRunStatus = "passed" | "failed" | "error" | "skipped";
type ScenarioRunStatus = "passed" | "failed" | "error";

interface ScenarioAssertionResult {
  passed: boolean;
  message?: string;
  detail?: string;
  actual?: unknown;
  expected?: unknown;
}

interface ScenarioStepRunRecord {
  stepId: string;
  index: number;
  type: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: ScenarioStepRunStatus;
  detail?: string;
  output?: unknown;
  assertion?: ScenarioAssertionResult;
}

interface ScenarioRunRecord {
  id: string;
  scenarioId: string;
  scenarioName: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: ScenarioRunStatus;
  stepResults: ScenarioStepRunRecord[];
  assertionsTotal: number;
  assertionsPassed: number;
  assertionsFailed: number;
}

interface ScenarioEditorState {
  name: string;
  description: string;
  tagsText: string;
  steps: ScenarioStep[];
  stepsText: string;
}

interface ScenarioDraftPayload {
  name: string;
  description: string;
  tags: string[];
  steps: ScenarioStep[];
}

interface ImportTemplatesPayload {
  overwrite: boolean;
  templateIds?: string[];
}

type StepType =
  | "note"
  | "sleep"
  | "clear_history"
  | "clear_logs"
  | "agent_rpc"
  | "assert";

type AssertionType =
  | "history_count"
  | "history_contains"
  | "log_contains"
  | "saved_value"
  | "script_applied";

type HistoryKind =
  | "hooks"
  | "crypto"
  | "nsurl"
  | "flutter"
  | "jni"
  | "xpc"
  | "privacy"
  | "hermes";

type NumericOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
type ValueOp = "exists" | "eq" | "contains" | "match";
type LogType = "syslog" | "agent";
type ClearLogType = LogType | "all";
type ScriptSource = "manual" | "startup";

const STEP_TYPES: StepType[] = [
  "note",
  "sleep",
  "clear_history",
  "clear_logs",
  "agent_rpc",
  "assert",
];

const ASSERTION_TYPES: AssertionType[] = [
  "history_count",
  "history_contains",
  "log_contains",
  "saved_value",
  "script_applied",
];

const HISTORY_KINDS: HistoryKind[] = [
  "hooks",
  "crypto",
  "nsurl",
  "flutter",
  "jni",
  "xpc",
  "privacy",
  "hermes",
];

const NUMERIC_OPS: NumericOp[] = ["eq", "ne", "gt", "gte", "lt", "lte"];
const VALUE_OPS: ValueOp[] = ["exists", "eq", "contains", "match"];
const LOG_TYPES: LogType[] = ["syslog", "agent"];
const CLEAR_LOG_TYPES: ClearLogType[] = ["all", "syslog", "agent"];
const SCRIPT_SOURCES: ScriptSource[] = ["manual", "startup"];
const REGRESSION_TEMPLATE_IDS = [
  "startup-injection-window-regression",
  "uncrackable2-early-bypass-regression",
] as const;

function scenarioTemplateTag(templateId: string) {
  return `template:${templateId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function createStepId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `step_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseTags(input: string): string[] {
  const uniq = new Set<string>();
  for (const raw of input.split(",")) {
    const tag = raw.trim();
    if (!tag) continue;
    uniq.add(tag);
  }
  return [...uniq];
}

function formatDateTime(value: string) {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value;
  return new Date(ts).toLocaleString();
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(2)}s`;
  return `${(sec / 60).toFixed(2)}m`;
}

function stringifyPretty(value: unknown) {
  if (typeof value === "undefined") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseLooseValue(raw: string): unknown {
  const value = raw.trim();
  if (value.length === 0) return "";

  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return raw;
    }
  }

  return raw;
}

function formatLooseValue(value: unknown) {
  if (typeof value === "undefined") return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatFilterInput(filter: unknown): string {
  if (!isRecord(filter)) return "";
  const pairs = Object.entries(filter)
    .filter(
      ([, v]) =>
        typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    )
    .map(([k, v]) => `${k}=${String(v)}`);
  return pairs.join(",");
}

function parseFilterInput(input: string): Record<string, string | number | boolean> | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const out: Record<string, string | number | boolean> = {};
  for (const chunk of trimmed.split(",")) {
    const item = chunk.trim();
    if (!item) continue;
    const index = item.indexOf("=");
    if (index <= 0) continue;

    const key = item.slice(0, index).trim();
    const valueRaw = item.slice(index + 1).trim();
    if (!key) continue;

    const value = parseLooseValue(valueRaw);
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function createDefaultAssertion(type: AssertionType): Record<string, unknown> {
  switch (type) {
    case "history_count":
      return {
        type,
        kind: "hooks",
        op: "gte",
        value: 1,
      };
    case "history_contains":
      return {
        type,
        kind: "hooks",
        keyword: "Cipher.doFinal",
        limit: 200,
        caseSensitive: false,
      };
    case "log_contains":
      return {
        type,
        log: "syslog",
        keyword: "error",
        caseSensitive: false,
        tailBytes: 1048576,
      };
    case "saved_value":
      return {
        type,
        key: "result",
        op: "exists",
        caseSensitive: false,
      };
    case "script_applied":
      return {
        type,
        scriptName: "",
        source: "",
        compileOk: true,
        minHookedMethods: 1,
        sessionId: "",
        pid: undefined,
      };
  }
}

function asStepType(value: unknown): StepType | null {
  return typeof value === "string" && STEP_TYPES.includes(value as StepType)
    ? (value as StepType)
    : null;
}

function asAssertionType(value: unknown): AssertionType {
  return typeof value === "string" && ASSERTION_TYPES.includes(value as AssertionType)
    ? (value as AssertionType)
    : "history_count";
}

function normalizeAssertion(raw: unknown): Record<string, unknown> {
  const source = isRecord(raw) ? { ...raw } : {};
  const type = asAssertionType(source.type);
  const next: Record<string, unknown> = {
    ...createDefaultAssertion(type),
    ...source,
    type,
  };

  if (typeof next.message !== "string") {
    delete next.message;
  }
  next.negate = asBoolean(next.negate, false);

  switch (type) {
    case "history_count":
      next.kind = HISTORY_KINDS.includes(next.kind as HistoryKind)
        ? next.kind
        : "hooks";
      next.op = NUMERIC_OPS.includes(next.op as NumericOp) ? next.op : "gte";
      next.value = asNumber(next.value, 1);
      if (!isRecord(next.filter)) {
        delete next.filter;
      }
      return next;
    case "history_contains":
      next.kind = HISTORY_KINDS.includes(next.kind as HistoryKind)
        ? next.kind
        : "hooks";
      next.keyword = asString(next.keyword);
      next.field = asString(next.field);
      next.limit = asNumber(next.limit, 200);
      next.caseSensitive = asBoolean(next.caseSensitive, false);
      return next;
    case "log_contains":
      next.log = LOG_TYPES.includes(next.log as LogType) ? next.log : "syslog";
      next.keyword = asString(next.keyword);
      next.caseSensitive = asBoolean(next.caseSensitive, false);
      next.tailBytes = asNumber(next.tailBytes, 1048576);
      return next;
    case "saved_value":
      next.key = asString(next.key);
      next.path = asString(next.path);
      next.op = VALUE_OPS.includes(next.op as ValueOp) ? next.op : "exists";
      next.caseSensitive = asBoolean(next.caseSensitive, false);
      return next;
    case "script_applied":
      next.scriptName = asString(next.scriptName);
      next.source = SCRIPT_SOURCES.includes(next.source as ScriptSource)
        ? next.source
        : "";
      next.compileOk = asBoolean(next.compileOk, true);
      next.minHookedMethods = asNumber(next.minHookedMethods, 1);
      next.sessionId = asString(next.sessionId);
      next.pid =
        typeof next.pid === "number" && Number.isFinite(next.pid) && next.pid > 0
          ? next.pid
          : undefined;
      return next;
  }
}

function createDefaultStep(type: StepType): ScenarioStep {
  switch (type) {
    case "note":
      return {
        id: createStepId(),
        type,
        text: "describe your action here",
      };
    case "sleep":
      return {
        id: createStepId(),
        type,
        ms: 1000,
      };
    case "clear_history":
      return {
        id: createStepId(),
        type,
        kind: "hooks",
      };
    case "clear_logs":
      return {
        id: createStepId(),
        type,
        log: "all",
      };
    case "agent_rpc":
      return {
        id: createStepId(),
        type,
        namespace: "app",
        method: "info",
        args: [],
        saveAs: "result",
        expectError: false,
      };
    case "assert":
      return {
        id: createStepId(),
        type,
        continueOnFailure: false,
        assertion: createDefaultAssertion("history_count"),
      };
  }
}

function normalizeStepForEditor(raw: ScenarioStep): ScenarioStep {
  const source: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  const id = typeof source.id === "string" && source.id.length > 0
    ? source.id
    : createStepId();
  const stepType = typeof source.type === "string" ? source.type : "note";
  const knownType = asStepType(stepType);

  if (!knownType) {
    return {
      ...source,
      id,
      type: stepType,
    } as ScenarioStep;
  }

  switch (knownType) {
    case "note":
      return {
        ...source,
        id,
        type: knownType,
        text: asString(source.text),
      };
    case "sleep":
      return {
        ...source,
        id,
        type: knownType,
        ms: asNumber(source.ms, 1000),
      };
    case "clear_history":
      return {
        ...source,
        id,
        type: knownType,
        kind: HISTORY_KINDS.includes(source.kind as HistoryKind)
          ? source.kind
          : "hooks",
      };
    case "clear_logs":
      return {
        ...source,
        id,
        type: knownType,
        log: CLEAR_LOG_TYPES.includes(source.log as ClearLogType)
          ? source.log
          : "all",
      };
    case "agent_rpc":
      return {
        ...source,
        id,
        type: knownType,
        namespace: asString(source.namespace),
        method: asString(source.method),
        args: asArray(source.args),
        saveAs: asString(source.saveAs),
        expectError: asBoolean(source.expectError, false),
      };
    case "assert":
      return {
        ...source,
        id,
        type: knownType,
        continueOnFailure: asBoolean(source.continueOnFailure, false),
        assertion: normalizeAssertion(source.assertion),
      };
  }
}

function normalizeStepsForEditor(raw: ScenarioStep[]): ScenarioStep[] {
  return raw.map((step) => normalizeStepForEditor(step));
}

function serializeSteps(steps: ScenarioStep[]): string {
  try {
    return JSON.stringify(steps, null, 2);
  } catch {
    return "[]";
  }
}

function validateSteps(
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): ScenarioStep[] {
  if (!Array.isArray(value)) {
    throw new Error("steps must be an array");
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new Error("steps must not be empty");
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`step #${index + 1} must be an object`);
    }
    if (typeof item.type !== "string" || item.type.trim().length === 0) {
      throw new Error(`step #${index + 1} requires a non-empty \"type\"`);
    }
    return normalizeStepForEditor(item as ScenarioStep);
  });
}

function parseStepsText(
  text: string,
  options: { allowEmpty?: boolean } = {},
): { steps: ScenarioStep[] | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) {
    if (options.allowEmpty) {
      return { steps: [], error: null };
    }
    return { steps: null, error: "steps must not be empty" };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const steps = validateSteps(parsed, options);
    return { steps, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid steps JSON";
    return { steps: null, error: message };
  }
}

function toEditorState(record: ScenarioRecord): ScenarioEditorState {
  const steps = normalizeStepsForEditor(Array.isArray(record.steps) ? record.steps : []);
  return {
    name: record.name,
    description: record.description ?? "",
    tagsText: (record.tags ?? []).join(", "),
    steps,
    stepsText: serializeSteps(steps),
  };
}

function createNewEditorState(): ScenarioEditorState {
  const steps = [createDefaultStep("note"), createDefaultStep("assert")];
  return {
    name: "",
    description: "",
    tagsText: "",
    steps,
    stepsText: serializeSteps(steps),
  };
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text || `request failed (${response.status})`;

    if (text) {
      try {
        const payload = JSON.parse(text) as { error?: string };
        if (typeof payload.error === "string" && payload.error.trim().length > 0) {
          message = payload.error;
        }
      } catch {
        // keep plain text
      }
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

function runStatusClass(status: ScenarioRunStatus) {
  switch (status) {
    case "passed":
      return "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200";
    case "failed":
      return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-200";
    case "error":
      return "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-200";
  }
}

function stepStatusClass(status: ScenarioStepRunStatus) {
  switch (status) {
    case "passed":
      return "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200";
    case "failed":
      return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-200";
    case "error":
      return "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-200";
    case "skipped":
      return "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-200";
  }
}

export function ScenarioManager() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { device, identifier, platform, mode, bundle, pid } = useSession();

  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [editorMode, setEditorMode] = useState<"visual" | "json">("visual");
  const [editor, setEditor] = useState<ScenarioEditorState>(() =>
    createNewEditorState(),
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [isRunningRegressionSuite, setIsRunningRegressionSuite] =
    useState(false);

  const scenariosUrl = useMemo(() => {
    if (!device || !identifier) return null;
    return `/api/scenarios/${encodeURIComponent(device)}/${encodeURIComponent(identifier)}`;
  }, [device, identifier]);

  const runsBaseUrl = useMemo(() => {
    if (!device || !identifier) return null;
    return `/api/scenario-runs/${encodeURIComponent(device)}/${encodeURIComponent(identifier)}`;
  }, [device, identifier]);

  const runTarget = useMemo(() => {
    if (!platform || !mode) return null;

    if (mode === Mode.App) {
      if (!bundle) return null;
      return { platform, mode, bundle };
    }

    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
      return null;
    }

    return { platform, mode, pid };
  }, [platform, mode, bundle, pid]);

  const runTargetLabel = useMemo(() => {
    if (!runTarget) return t("scenario_run_target_unavailable");
    if ("bundle" in runTarget) {
      return `${runTarget.platform}/${runTarget.mode}/${runTarget.bundle}`;
    }
    return `${runTarget.platform}/${runTarget.mode}/pid:${runTarget.pid}`;
  }, [runTarget, t]);

  const { data: scenarios = [], isLoading: isLoadingScenarios } = useQuery<
    ScenarioRecord[]
  >({
    queryKey: ["scenarios", device, identifier],
    queryFn: () => apiRequest<ScenarioRecord[]>(scenariosUrl!),
    enabled: !!scenariosUrl,
  });

  const { data: scenarioTemplates = [] } = useQuery<ScenarioTemplateRecord[]>({
    queryKey: ["scenarioTemplates"],
    queryFn: () => apiRequest<ScenarioTemplateRecord[]>("/api/scenario-templates"),
  });

  const activeScenarioId = isCreatingNew ? null : selectedScenarioId;
  const { data: runs = [], isLoading: isLoadingRuns } = useQuery<
    ScenarioRunRecord[]
  >({
    queryKey: ["scenarioRuns", device, identifier, activeScenarioId],
    queryFn: () =>
      apiRequest<ScenarioRunRecord[]>(
        `${runsBaseUrl}?scenarioId=${encodeURIComponent(activeScenarioId!)}`,
      ),
    enabled: !!runsBaseUrl && !!activeScenarioId,
  });

  const createMutation = useMutation({
    mutationFn: (payload: ScenarioDraftPayload) =>
      apiRequest<ScenarioRecord>(scenariosUrl!, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ScenarioDraftPayload }) =>
      apiRequest<ScenarioRecord>(`${scenariosUrl}/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
  });

  const deleteScenarioMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`${scenariosUrl}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  });

  const runMutation = useMutation({
    mutationFn: (scenarioId: string) =>
      apiRequest<ScenarioRunRecord>(
        `${scenariosUrl}/${encodeURIComponent(scenarioId)}/run`,
        {
          method: "POST",
          body: JSON.stringify({
            target: runTarget ?? undefined,
            stopOnFailure,
          }),
        },
      ),
  });

  const deleteRunMutation = useMutation({
    mutationFn: (runId: string) =>
      apiRequest<void>(`${runsBaseUrl}/${encodeURIComponent(runId)}`, {
        method: "DELETE",
      }),
  });

  const clearRunsMutation = useMutation({
    mutationFn: () =>
      apiRequest<void>(runsBaseUrl!, {
        method: "DELETE",
      }),
  });

  const importTemplateMutation = useMutation({
    mutationFn: (payload: {
      templateId: string;
      overwrite?: boolean;
    }) =>
      apiRequest<{
        templateId: string;
        action: "created" | "updated";
        scenario: ScenarioRecord;
      }>(`${scenariosUrl}/import-template`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
  });

  const importAllTemplatesMutation = useMutation({
    mutationFn: (payload: ImportTemplatesPayload) =>
      apiRequest<{
        total: number;
        created: string[];
        updated: string[];
        skipped: string[];
      }>(`${scenariosUrl}/import-templates`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
  });

  useEffect(() => {
    if (isCreatingNew) return;
    if (scenarios.length === 0) {
      setSelectedScenarioId(null);
      return;
    }
    if (selectedScenarioId && scenarios.some((item) => item.id === selectedScenarioId)) {
      return;
    }
    setSelectedScenarioId(scenarios[0]?.id ?? null);
  }, [isCreatingNew, scenarios, selectedScenarioId]);

  useEffect(() => {
    if (isCreatingNew || !selectedScenarioId) return;
    const selected = scenarios.find((item) => item.id === selectedScenarioId);
    if (!selected) return;
    setEditor(toEditorState(selected));
  }, [isCreatingNew, selectedScenarioId, scenarios]);

  useEffect(() => {
    if (scenarioTemplates.length === 0) {
      setSelectedTemplateId("");
      return;
    }
    if (selectedTemplateId && scenarioTemplates.some((item) => item.id === selectedTemplateId)) {
      return;
    }
    setSelectedTemplateId(scenarioTemplates[0]!.id);
  }, [scenarioTemplates, selectedTemplateId]);

  useEffect(() => {
    setSelectedRunId(null);
    setSelectedStepId(null);
  }, [activeScenarioId]);

  useEffect(() => {
    if (runs.length === 0) {
      setSelectedRunId(null);
      setSelectedStepId(null);
      return;
    }
    if (selectedRunId && runs.some((item) => item.id === selectedRunId)) {
      return;
    }
    setSelectedRunId(runs[0]?.id ?? null);
  }, [runs, selectedRunId]);

  const selectedRun = useMemo(
    () => runs.find((item) => item.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  useEffect(() => {
    if (!selectedRun || selectedRun.stepResults.length === 0) {
      setSelectedStepId(null);
      return;
    }

    if (
      selectedStepId &&
      selectedRun.stepResults.some((step) => step.stepId === selectedStepId)
    ) {
      return;
    }

    setSelectedStepId(selectedRun.stepResults[0]?.stepId ?? null);
  }, [selectedRun, selectedStepId]);

  const selectedStep = useMemo(() => {
    if (!selectedRun) return null;
    return (
      selectedRun.stepResults.find((step) => step.stepId === selectedStepId) ?? null
    );
  }, [selectedRun, selectedStepId]);

  const visualStepsValidation = useMemo(() => {
    try {
      const steps = validateSteps(editor.steps);
      return { steps, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid steps";
      return { steps: null, error: message };
    }
  }, [editor.steps]);

  const jsonStepsValidation = useMemo(
    () => parseStepsText(editor.stepsText),
    [editor.stepsText],
  );

  const stepsValidation = editorMode === "visual" ? visualStepsValidation : jsonStepsValidation;

  const canSave =
    editor.name.trim().length > 0 &&
    !!stepsValidation.steps &&
    !stepsValidation.error &&
    !createMutation.isPending &&
    !updateMutation.isPending;

  const isBusy =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteScenarioMutation.isPending ||
    runMutation.isPending ||
    importTemplateMutation.isPending ||
    importAllTemplatesMutation.isPending ||
    isRunningRegressionSuite;

  const updateEditorSteps = (updater: (steps: ScenarioStep[]) => ScenarioStep[]) => {
    setEditor((prev) => {
      const next = normalizeStepsForEditor(updater(prev.steps));
      return {
        ...prev,
        steps: next,
        stepsText: serializeSteps(next),
      };
    });
  };

  const updateStepAt = (
    index: number,
    updater: (step: ScenarioStep) => ScenarioStep,
  ) => {
    updateEditorSteps((steps) =>
      steps.map((step, i) => (i === index ? updater(step) : step)),
    );
  };

  const updateAssertionAt = (
    stepIndex: number,
    updater: (assertion: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    updateStepAt(stepIndex, (step) => {
      const assertion = normalizeAssertion(step.assertion);
      return {
        ...step,
        type: "assert",
        assertion: normalizeAssertion(updater(assertion)),
      };
    });
  };

  const resetEditorToNew = () => {
    setEditor(createNewEditorState());
    setEditorMode("visual");
    setIsCreatingNew(true);
    setSelectedScenarioId(null);
  };

  const handleSelectScenario = (id: string) => {
    setIsCreatingNew(false);
    setSelectedScenarioId(id);
  };

  const handleSwitchToJson = () => {
    setEditor((prev) => ({
      ...prev,
      stepsText: serializeSteps(prev.steps),
    }));
    setEditorMode("json");
  };

  const handleSwitchToVisual = () => {
    const parsed = parseStepsText(editor.stepsText, { allowEmpty: true });
    if (parsed.error || !parsed.steps) {
      toast.error(t("scenario_json_apply_failed"));
      return;
    }

    setEditor((prev) => ({
      ...prev,
      steps: parsed.steps ?? [],
      stepsText: serializeSteps(parsed.steps ?? []),
    }));
    setEditorMode("visual");
    toast.success(t("scenario_json_apply_success"));
  };

  const handleAddStep = (type: StepType) => {
    updateEditorSteps((steps) => [...steps, createDefaultStep(type)]);
  };

  const handleMoveStep = (index: number, direction: -1 | 1) => {
    updateEditorSteps((steps) => {
      const target = index + direction;
      if (target < 0 || target >= steps.length) return steps;
      const next = [...steps];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleRemoveStep = (index: number) => {
    updateEditorSteps((steps) => steps.filter((_, i) => i !== index));
  };

  const handleChangeStepType = (index: number, type: StepType) => {
    updateStepAt(index, (current) => {
      const next = createDefaultStep(type);
      if (typeof current.id === "string" && current.id.length > 0) {
        next.id = current.id;
      }
      return next;
    });
  };

  const handleSaveScenario = async () => {
    if (!scenariosUrl) return;
    if (!canSave || !stepsValidation.steps) return;

    const payload: ScenarioDraftPayload = {
      name: editor.name.trim(),
      description: editor.description.trim(),
      tags: parseTags(editor.tagsText),
      steps: stepsValidation.steps,
    };

    try {
      let saved: ScenarioRecord;
      if (isCreatingNew || !selectedScenarioId) {
        saved = await createMutation.mutateAsync(payload);
      } else {
        saved = await updateMutation.mutateAsync({
          id: selectedScenarioId,
          payload,
        });
      }

      setIsCreatingNew(false);
      setSelectedScenarioId(saved.id);
      setEditor(toEditorState(saved));
      setEditorMode("visual");
      await queryClient.invalidateQueries({
        queryKey: ["scenarios", device, identifier],
      });
      toast.success(t("scenario_save_success"));
    } catch (error) {
      console.error("Failed to save scenario:", error);
      toast.error(t("scenario_save_failed"));
    }
  };

  const handleDeleteScenario = async (scenarioId: string) => {
    try {
      await deleteScenarioMutation.mutateAsync(scenarioId);
      await queryClient.invalidateQueries({
        queryKey: ["scenarios", device, identifier],
      });
      await queryClient.invalidateQueries({
        queryKey: ["scenarioRuns", device, identifier],
      });

      if (selectedScenarioId === scenarioId) {
        setSelectedScenarioId(null);
      }
      toast.success(t("scenario_delete_success"));
    } catch (error) {
      console.error("Failed to delete scenario:", error);
      toast.error(t("scenario_delete_failed"));
    }
  };

  const handleRunScenario = async (scenarioId: string) => {
    if (!runTarget) {
      toast.error(t("scenario_run_target_unavailable"));
      return;
    }

    setIsCreatingNew(false);
    setSelectedScenarioId(scenarioId);

    try {
      const run = await runMutation.mutateAsync(scenarioId);
      await queryClient.invalidateQueries({
        queryKey: ["scenarioRuns", device, identifier],
      });
      setSelectedRunId(run.id);
      setSelectedStepId(run.stepResults[0]?.stepId ?? null);
      toast.success(t("scenario_run_success"));
    } catch (error) {
      console.error("Failed to run scenario:", error);
      toast.error(t("scenario_run_failed"));
    }
  };

  const handleDeleteRun = async (runId: string) => {
    try {
      await deleteRunMutation.mutateAsync(runId);
      await queryClient.invalidateQueries({
        queryKey: ["scenarioRuns", device, identifier],
      });
      toast.success(t("scenario_delete_run_success"));
    } catch (error) {
      console.error("Failed to delete run:", error);
      toast.error(t("scenario_delete_run_failed"));
    }
  };

  const handleClearRuns = async () => {
    if (!runsBaseUrl) return;
    try {
      await clearRunsMutation.mutateAsync();
      await queryClient.invalidateQueries({
        queryKey: ["scenarioRuns", device, identifier],
      });
      setSelectedRunId(null);
      setSelectedStepId(null);
      toast.success(t("scenario_clear_runs_success"));
    } catch (error) {
      console.error("Failed to clear runs:", error);
      toast.error(t("scenario_clear_runs_failed"));
    }
  };

  const handleImportTemplate = async () => {
    if (!scenariosUrl || !selectedTemplateId) return;
    try {
      const result = await importTemplateMutation.mutateAsync({
        templateId: selectedTemplateId,
      });
      await queryClient.invalidateQueries({
        queryKey: ["scenarios", device, identifier],
      });
      setIsCreatingNew(false);
      setSelectedScenarioId(result.scenario.id);
      toast.success(t("scenario_template_import_success"));
    } catch (error) {
      console.error("Failed to import scenario template:", error);
      toast.error(t("scenario_template_import_failed"));
    }
  };

  const handleImportAllTemplates = async () => {
    if (!scenariosUrl) return;
    try {
      const result = await importAllTemplatesMutation.mutateAsync({
        overwrite: false,
      });
      await queryClient.invalidateQueries({
        queryKey: ["scenarios", device, identifier],
      });
      const importedCount = result.created.length + result.updated.length;
      toast.success(
        t("scenario_template_import_all_success", {
          count: importedCount,
        }),
      );
    } catch (error) {
      console.error("Failed to import all scenario templates:", error);
      toast.error(t("scenario_template_import_all_failed"));
    }
  };

  const handleImportAndRunRegressionSuite = async () => {
    if (!scenariosUrl) return;
    if (!runTarget) {
      toast.error(t("scenario_run_target_unavailable"));
      return;
    }

    setIsRunningRegressionSuite(true);
    try {
      const importResult = await importAllTemplatesMutation.mutateAsync({
        overwrite: true,
        templateIds: [...REGRESSION_TEMPLATE_IDS],
      });
      await queryClient.invalidateQueries({
        queryKey: ["scenarios", device, identifier],
      });

      const latestScenarios = await queryClient.fetchQuery({
        queryKey: ["scenarios", device, identifier],
        queryFn: () => apiRequest<ScenarioRecord[]>(scenariosUrl),
      });

      const scenarioIdByTemplate = new Map<string, string>();
      for (const scenario of latestScenarios) {
        for (const templateId of REGRESSION_TEMPLATE_IDS) {
          if (scenario.tags.includes(scenarioTemplateTag(templateId))) {
            scenarioIdByTemplate.set(templateId, scenario.id);
          }
        }
      }

      const missingTemplates = REGRESSION_TEMPLATE_IDS.filter(
        (templateId) => !scenarioIdByTemplate.has(templateId),
      );
      if (missingTemplates.length > 0) {
        throw new Error(
          t("scenario_regression_suite_missing_templates", {
            templates: missingTemplates.join(", "),
          }),
        );
      }

      const runResults: ScenarioRunRecord[] = [];
      const failedRuns: Array<{ templateId: string; reason: string }> = [];

      for (const templateId of REGRESSION_TEMPLATE_IDS) {
        const scenarioId = scenarioIdByTemplate.get(templateId);
        if (!scenarioId) continue;

        try {
          const run = await apiRequest<ScenarioRunRecord>(
            `${scenariosUrl}/${encodeURIComponent(scenarioId)}/run`,
            {
              method: "POST",
              body: JSON.stringify({
                target: runTarget,
                stopOnFailure,
              }),
            },
          );
          runResults.push(run);
          if (run.status !== "passed") {
            failedRuns.push({ templateId, reason: run.status });
          }
        } catch (error) {
          failedRuns.push({
            templateId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await queryClient.invalidateQueries({
        queryKey: ["scenarioRuns", device, identifier],
      });

      const firstRun = runResults[0];
      if (firstRun) {
        setIsCreatingNew(false);
        setSelectedScenarioId(firstRun.scenarioId);
        setSelectedRunId(firstRun.id);
        setSelectedStepId(firstRun.stepResults[0]?.stepId ?? null);
      }

      if (failedRuns.length === 0) {
        toast.success(
          t("scenario_regression_suite_success", {
            imported:
              importResult.created.length + importResult.updated.length,
            runCount: runResults.length,
          }),
        );
      } else {
        toast.error(
          t("scenario_regression_suite_partial_failed", {
            passed: runResults.length - failedRuns.length,
            failed: failedRuns.length,
          }),
        );
      }
    } catch (error) {
      console.error("Failed to import and run regression suite:", error);
      const message =
        error instanceof Error
          ? error.message
          : t("scenario_regression_suite_failed");
      toast.error(message);
    } finally {
      setIsRunningRegressionSuite(false);
    }
  };

  const stepTypeLabel = (type: string) => {
    const key = `scenario_template_${type}`;
    const translated = t(key);
    return translated === key ? type : translated;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{t("test_scenarios")}</div>
        <div className="flex items-center gap-2">
          <Select
            value={selectedTemplateId}
            onValueChange={(value) => setSelectedTemplateId(value ?? "")}
            disabled={scenarioTemplates.length === 0 || isBusy}
          >
            <SelectTrigger className="h-7 w-[220px] text-xs">
              <SelectValue placeholder={t("scenario_template_select")} />
            </SelectTrigger>
            <SelectContent>
              {scenarioTemplates.map((template) => (
                <SelectItem
                  key={template.id}
                  value={template.id}
                  className="text-xs"
                >
                  {template.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => void handleImportTemplate()}
            disabled={!selectedTemplateId || isBusy}
          >
            {t("scenario_template_import")}
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => void handleImportAllTemplates()}
            disabled={isBusy}
          >
            {t("scenario_template_import_all")}
          </Button>

          <Button
            variant="secondary"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => void handleImportAndRunRegressionSuite()}
            disabled={isBusy || !runTarget}
          >
            {isRunningRegressionSuite ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <Play className="h-3.5 w-3.5 mr-1" />
            )}
            {t("scenario_regression_suite_run")}
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={resetEditorToNew}
            disabled={isBusy}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t("scenario_new")}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t("test_scenarios_desc")}</p>
      <p className="text-[11px] text-muted-foreground">
        {t("scenario_regression_suite_desc")}
      </p>

      <div className="grid gap-3 xl:grid-cols-[240px_minmax(0,1fr)]">
        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
            {t("scenario_list")}
          </div>
          <ScrollArea className="h-80">
            <div className="p-2 space-y-2">
              {isLoadingScenarios ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground p-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("loading")}...
                </div>
              ) : scenarios.length === 0 ? (
                <div className="text-xs text-muted-foreground italic p-2">
                  {t("scenario_empty")}
                </div>
              ) : (
                scenarios.map((item) => {
                  const selected = !isCreatingNew && selectedScenarioId === item.id;
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleSelectScenario(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          handleSelectScenario(item.id);
                        }
                      }}
                      className={cn(
                        "group rounded-md border px-2 py-2 transition-colors",
                        selected
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-muted/30",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{item.name}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {t("scenario_steps_count", {
                              count: item.steps.length,
                            })}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            title={t("scenario_run_now")}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleRunScenario(item.id);
                            }}
                            disabled={runMutation.isPending}
                          >
                            {runMutation.isPending ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-destructive hover:text-destructive"
                            title={t("delete")}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDeleteScenario(item.id);
                            }}
                            disabled={deleteScenarioMutation.isPending}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </div>

        <div className="space-y-3">
          <div className="rounded-md border border-border p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium">{t("scenario_editor")}</div>
              <Button
                size="sm"
                className="h-8"
                onClick={handleSaveScenario}
                disabled={!canSave}
              >
                {createMutation.isPending || updateMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                ) : null}
                {t("save")}
              </Button>
            </div>

            <div className="grid gap-3 xl:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">{t("name")}</Label>
                <Input
                  value={editor.name}
                  onChange={(event) =>
                    setEditor((prev) => ({ ...prev, name: event.target.value }))
                  }
                  placeholder={t("scenario_name_placeholder")}
                  disabled={isBusy}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("scenario_tags")}</Label>
                <Input
                  value={editor.tagsText}
                  onChange={(event) =>
                    setEditor((prev) => ({ ...prev, tagsText: event.target.value }))
                  }
                  placeholder={t("scenario_tags_placeholder")}
                  disabled={isBusy}
                  className="h-8"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t("description")}</Label>
              <Textarea
                value={editor.description}
                onChange={(event) =>
                  setEditor((prev) => ({ ...prev, description: event.target.value }))
                }
                placeholder={t("scenario_description_placeholder")}
                className="min-h-16 text-xs"
                disabled={isBusy}
              />
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-medium">{t("scenario_steps_dsl")}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {t("scenario_steps_desc")}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant={editorMode === "visual" ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setEditorMode("visual")}
                    disabled={editorMode === "visual"}
                  >
                    {t("scenario_visual_mode")}
                  </Button>
                  <Button
                    variant={editorMode === "json" ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={handleSwitchToJson}
                    disabled={editorMode === "json"}
                  >
                    <Braces className="h-3.5 w-3.5 mr-1" />
                    {t("scenario_json_mode")}
                  </Button>
                </div>
              </div>

              {editorMode === "visual" ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    {STEP_TYPES.map((type) => (
                      <Button
                        key={type}
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => handleAddStep(type)}
                        disabled={isBusy}
                      >
                        + {stepTypeLabel(type)}
                      </Button>
                    ))}
                  </div>

                  {editor.steps.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
                      {t("scenario_visual_empty")}
                    </div>
                  ) : (
                    <ScrollArea className="h-[28rem] rounded-md border border-border">
                      <div className="p-2 space-y-2">
                        {editor.steps.map((step, index) => {
                          const knownType = asStepType(step.type);
                          const typeValue = knownType ?? "__unknown";

                          return (
                            <div key={step.id ?? `${step.type}:${index}`} className="rounded-md border border-border p-2 space-y-2">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="text-xs font-medium">
                                  {t("scenario_step")} #{index + 1}
                                </div>
                                <div className="flex items-center gap-1">
                                  <Select
                                    value={typeValue}
                                    onValueChange={(value) => {
                                      if (!value || value === "__unknown") return;
                                      handleChangeStepType(index, value as StepType);
                                    }}
                                  >
                                    <SelectTrigger className="h-7 w-42 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {STEP_TYPES.map((type) => (
                                        <SelectItem key={type} value={type}>
                                          {stepTypeLabel(type)}
                                        </SelectItem>
                                      ))}
                                      {!knownType ? (
                                        <SelectItem value="__unknown" disabled>
                                          {step.type}
                                        </SelectItem>
                                      ) : null}
                                    </SelectContent>
                                  </Select>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={() => handleMoveStep(index, -1)}
                                    disabled={index === 0}
                                    title={t("scenario_step_move_up")}
                                  >
                                    <ArrowUp className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={() => handleMoveStep(index, 1)}
                                    disabled={index === editor.steps.length - 1}
                                    title={t("scenario_step_move_down")}
                                  >
                                    <ArrowDown className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-destructive hover:text-destructive"
                                    onClick={() => handleRemoveStep(index)}
                                    title={t("scenario_step_remove")}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </div>

                              {!knownType ? (
                                <div className="text-xs text-muted-foreground rounded-md border border-dashed border-border px-2.5 py-2">
                                  {t("scenario_unknown_step_type", { type: step.type })}
                                </div>
                              ) : null}

                              {knownType === "note" ? (
                                <div className="space-y-1">
                                  <Label className="text-xs">{t("scenario_note_text")}</Label>
                                  <Textarea
                                    value={asString(step.text)}
                                    onChange={(event) =>
                                      updateStepAt(index, (current) => ({
                                        ...current,
                                        text: event.target.value,
                                      }))
                                    }
                                    className="min-h-16 text-xs"
                                  />
                                </div>
                              ) : null}

                              {knownType === "sleep" ? (
                                <div className="space-y-1">
                                  <Label className="text-xs">{t("scenario_sleep_ms")}</Label>
                                  <Input
                                    type="number"
                                    min={1}
                                    value={String(asNumber(step.ms, 1000))}
                                    onChange={(event) => {
                                      const value = Number(event.target.value);
                                      updateStepAt(index, (current) => ({
                                        ...current,
                                        ms: Number.isFinite(value) ? value : 0,
                                      }));
                                    }}
                                    className="h-8"
                                  />
                                </div>
                              ) : null}

                              {knownType === "clear_history" ? (
                                <div className="space-y-1">
                                  <Label className="text-xs">{t("scenario_history_kind")}</Label>
                                  <Select
                                    value={
                                      HISTORY_KINDS.includes(step.kind as HistoryKind)
                                        ? (step.kind as HistoryKind)
                                        : "hooks"
                                    }
                                    onValueChange={(value) => {
                                      if (!value) return;
                                      updateStepAt(index, (current) => ({
                                        ...current,
                                        kind: value,
                                      }));
                                    }}
                                  >
                                    <SelectTrigger className="h-8 text-xs w-44">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {HISTORY_KINDS.map((item) => (
                                        <SelectItem key={item} value={item}>
                                          {item}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              ) : null}

                              {knownType === "clear_logs" ? (
                                <div className="space-y-1">
                                  <Label className="text-xs">{t("scenario_log_type")}</Label>
                                  <Select
                                    value={
                                      CLEAR_LOG_TYPES.includes(step.log as ClearLogType)
                                        ? (step.log as ClearLogType)
                                        : "all"
                                    }
                                    onValueChange={(value) => {
                                      if (!value) return;
                                      updateStepAt(index, (current) => ({
                                        ...current,
                                        log: value,
                                      }));
                                    }}
                                  >
                                    <SelectTrigger className="h-8 text-xs w-44">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {CLEAR_LOG_TYPES.map((item) => (
                                        <SelectItem key={item} value={item}>
                                          {item}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              ) : null}

                              {knownType === "agent_rpc" ? (
                                <div className="space-y-2">
                                  <div className="grid gap-2 xl:grid-cols-2">
                                    <div className="space-y-1">
                                      <Label className="text-xs">{t("scenario_agent_namespace")}</Label>
                                      <Input
                                        value={asString(step.namespace)}
                                        onChange={(event) =>
                                          updateStepAt(index, (current) => ({
                                            ...current,
                                            namespace: event.target.value,
                                          }))
                                        }
                                        className="h-8"
                                      />
                                    </div>
                                    <div className="space-y-1">
                                      <Label className="text-xs">{t("scenario_agent_method")}</Label>
                                      <Input
                                        value={asString(step.method)}
                                        onChange={(event) =>
                                          updateStepAt(index, (current) => ({
                                            ...current,
                                            method: event.target.value,
                                          }))
                                        }
                                        className="h-8"
                                      />
                                    </div>
                                  </div>

                                  <div className="space-y-1">
                                    <Label className="text-xs">{t("scenario_agent_args")}</Label>
                                    <div className="space-y-1">
                                      {asArray(step.args).map((arg, argIndex) => (
                                        <div key={`arg-${argIndex}`} className="flex items-center gap-2">
                                          <Input
                                            value={formatLooseValue(arg)}
                                            onChange={(event) =>
                                              updateStepAt(index, (current) => {
                                                const args = [...asArray(current.args)];
                                                args[argIndex] = parseLooseValue(event.target.value);
                                                return {
                                                  ...current,
                                                  args,
                                                };
                                              })
                                            }
                                            className="h-8"
                                          />
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-7 w-7 text-destructive hover:text-destructive"
                                            onClick={() =>
                                              updateStepAt(index, (current) => {
                                                const args = asArray(current.args).filter(
                                                  (_, i) => i !== argIndex,
                                                );
                                                return {
                                                  ...current,
                                                  args,
                                                };
                                              })
                                            }
                                          >
                                            <Trash2 className="h-3.5 w-3.5" />
                                          </Button>
                                        </div>
                                      ))}
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 px-2 text-xs"
                                        onClick={() =>
                                          updateStepAt(index, (current) => ({
                                            ...current,
                                            args: [...asArray(current.args), ""],
                                          }))
                                        }
                                      >
                                        <Plus className="h-3.5 w-3.5 mr-1" />
                                        {t("scenario_agent_add_arg")}
                                      </Button>
                                    </div>
                                  </div>

                                  <div className="grid gap-2 xl:grid-cols-2">
                                    <div className="space-y-1">
                                      <Label className="text-xs">{t("scenario_agent_save_as")}</Label>
                                      <Input
                                        value={asString(step.saveAs)}
                                        onChange={(event) =>
                                          updateStepAt(index, (current) => ({
                                            ...current,
                                            saveAs: event.target.value,
                                          }))
                                        }
                                        className="h-8"
                                      />
                                    </div>
                                    <label className="flex items-center gap-2 text-xs pt-6">
                                      <Switch
                                        checked={asBoolean(step.expectError, false)}
                                        onCheckedChange={(checked) =>
                                          updateStepAt(index, (current) => ({
                                            ...current,
                                            expectError: checked,
                                          }))
                                        }
                                      />
                                      <span>{t("scenario_agent_expect_error")}</span>
                                    </label>
                                  </div>
                                </div>
                              ) : null}

                              {knownType === "assert" ? (
                                (() => {
                                  const assertion = normalizeAssertion(step.assertion);
                                  const assertionType = asAssertionType(assertion.type);

                                  return (
                                    <div className="space-y-2">
                                      <div className="grid gap-2 xl:grid-cols-2">
                                        <div className="space-y-1">
                                          <Label className="text-xs">{t("scenario_assertion_type")}</Label>
                                          <Select
                                            value={assertionType}
                                            onValueChange={(value) => {
                                              if (!value) return;
                                              updateAssertionAt(index, (current) => {
                                                const next = createDefaultAssertion(
                                                  value as AssertionType,
                                                );
                                                next.negate = asBoolean(current.negate, false);
                                                const message = asString(current.message);
                                                if (message) next.message = message;
                                                return next;
                                              });
                                            }}
                                          >
                                            <SelectTrigger className="h-8 text-xs w-52">
                                              <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                              {ASSERTION_TYPES.map((item) => (
                                                <SelectItem key={item} value={item}>
                                                  {(() => {
                                                    const key = `scenario_assertion_type_${item}`;
                                                    const translated = t(key);
                                                    return translated === key ? item : translated;
                                                  })()}
                                                </SelectItem>
                                              ))}
                                            </SelectContent>
                                          </Select>
                                        </div>
                                        <label className="flex items-center gap-2 text-xs pt-6">
                                          <Switch
                                            checked={asBoolean(step.continueOnFailure, false)}
                                            onCheckedChange={(checked) =>
                                              updateStepAt(index, (current) => ({
                                                ...current,
                                                continueOnFailure: checked,
                                              }))
                                            }
                                          />
                                          <span>{t("scenario_continue_on_failure")}</span>
                                        </label>
                                      </div>

                                      <div className="grid gap-2 xl:grid-cols-2">
                                        <div className="space-y-1">
                                          <Label className="text-xs">{t("scenario_assertion_message")}</Label>
                                          <Input
                                            value={asString(assertion.message)}
                                            onChange={(event) =>
                                              updateAssertionAt(index, (current) => ({
                                                ...current,
                                                message: event.target.value,
                                              }))
                                            }
                                            className="h-8"
                                          />
                                        </div>
                                        <label className="flex items-center gap-2 text-xs pt-6">
                                          <Switch
                                            checked={asBoolean(assertion.negate, false)}
                                            onCheckedChange={(checked) =>
                                              updateAssertionAt(index, (current) => ({
                                                ...current,
                                                negate: checked,
                                              }))
                                            }
                                          />
                                          <span>{t("scenario_assertion_negate")}</span>
                                        </label>
                                      </div>

                                      {assertionType === "history_count" ? (
                                        <div className="grid gap-2 xl:grid-cols-2">
                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_history_kind")}</Label>
                                            <Select
                                              value={
                                                HISTORY_KINDS.includes(assertion.kind as HistoryKind)
                                                  ? (assertion.kind as HistoryKind)
                                                  : "hooks"
                                              }
                                              onValueChange={(value) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  kind: value,
                                                }))
                                              }
                                            >
                                              <SelectTrigger className="h-8 text-xs w-44">
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                {HISTORY_KINDS.map((item) => (
                                                  <SelectItem key={item} value={item}>
                                                    {item}
                                                  </SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_compare")}</Label>
                                            <Select
                                              value={
                                                NUMERIC_OPS.includes(assertion.op as NumericOp)
                                                  ? (assertion.op as NumericOp)
                                                  : "gte"
                                              }
                                              onValueChange={(value) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  op: value,
                                                }))
                                              }
                                            >
                                              <SelectTrigger className="h-8 text-xs w-36">
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                {NUMERIC_OPS.map((item) => (
                                                  <SelectItem key={item} value={item}>
                                                    {item}
                                                  </SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_value")}</Label>
                                            <Input
                                              type="number"
                                              value={String(asNumber(assertion.value, 1))}
                                              onChange={(event) => {
                                                const value = Number(event.target.value);
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  value: Number.isFinite(value) ? value : 0,
                                                }));
                                              }}
                                              className="h-8"
                                            />
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_filter")}</Label>
                                            <Input
                                              value={formatFilterInput(assertion.filter)}
                                              onChange={(event) => {
                                                const filter = parseFilterInput(event.target.value);
                                                updateAssertionAt(index, (current) => {
                                                  const next = { ...current };
                                                  if (filter) next.filter = filter;
                                                  else delete next.filter;
                                                  return next;
                                                });
                                              }}
                                              placeholder={t("scenario_assertion_filter_hint")}
                                              className="h-8"
                                            />
                                          </div>
                                        </div>
                                      ) : null}

                                      {assertionType === "history_contains" ? (
                                        <div className="grid gap-2 xl:grid-cols-2">
                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_history_kind")}</Label>
                                            <Select
                                              value={
                                                HISTORY_KINDS.includes(assertion.kind as HistoryKind)
                                                  ? (assertion.kind as HistoryKind)
                                                  : "hooks"
                                              }
                                              onValueChange={(value) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  kind: value,
                                                }))
                                              }
                                            >
                                              <SelectTrigger className="h-8 text-xs w-44">
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                {HISTORY_KINDS.map((item) => (
                                                  <SelectItem key={item} value={item}>
                                                    {item}
                                                  </SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_keyword")}</Label>
                                            <Input
                                              value={asString(assertion.keyword)}
                                              onChange={(event) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  keyword: event.target.value,
                                                }))
                                              }
                                              className="h-8"
                                            />
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_field")}</Label>
                                            <Input
                                              value={asString(assertion.field)}
                                              onChange={(event) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  field: event.target.value,
                                                }))
                                              }
                                              className="h-8"
                                            />
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_limit")}</Label>
                                            <Input
                                              type="number"
                                              min={1}
                                              value={String(asNumber(assertion.limit, 200))}
                                              onChange={(event) => {
                                                const value = Number(event.target.value);
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  limit: Number.isFinite(value) ? value : 0,
                                                }));
                                              }}
                                              className="h-8"
                                            />
                                          </div>

                                          <label className="flex items-center gap-2 text-xs pt-6">
                                            <Switch
                                              checked={asBoolean(assertion.caseSensitive, false)}
                                              onCheckedChange={(checked) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  caseSensitive: checked,
                                                }))
                                              }
                                            />
                                            <span>{t("scenario_assertion_case_sensitive")}</span>
                                          </label>
                                        </div>
                                      ) : null}

                                      {assertionType === "log_contains" ? (
                                        <div className="grid gap-2 xl:grid-cols-2">
                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_log_type")}</Label>
                                            <Select
                                              value={
                                                LOG_TYPES.includes(assertion.log as LogType)
                                                  ? (assertion.log as LogType)
                                                  : "syslog"
                                              }
                                              onValueChange={(value) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  log: value,
                                                }))
                                              }
                                            >
                                              <SelectTrigger className="h-8 text-xs w-36">
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                {LOG_TYPES.map((item) => (
                                                  <SelectItem key={item} value={item}>
                                                    {item}
                                                  </SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_keyword")}</Label>
                                            <Input
                                              value={asString(assertion.keyword)}
                                              onChange={(event) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  keyword: event.target.value,
                                                }))
                                              }
                                              className="h-8"
                                            />
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_tail_bytes")}</Label>
                                            <Input
                                              type="number"
                                              min={1024}
                                              value={String(asNumber(assertion.tailBytes, 1048576))}
                                              onChange={(event) => {
                                                const value = Number(event.target.value);
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  tailBytes: Number.isFinite(value) ? value : 0,
                                                }));
                                              }}
                                              className="h-8"
                                            />
                                          </div>

                                          <label className="flex items-center gap-2 text-xs pt-6">
                                            <Switch
                                              checked={asBoolean(assertion.caseSensitive, false)}
                                              onCheckedChange={(checked) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  caseSensitive: checked,
                                                }))
                                              }
                                            />
                                            <span>{t("scenario_assertion_case_sensitive")}</span>
                                          </label>
                                        </div>
                                      ) : null}

                                      {assertionType === "saved_value" ? (
                                        <div className="grid gap-2 xl:grid-cols-2">
                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_saved_key")}</Label>
                                            <Input
                                              value={asString(assertion.key)}
                                              onChange={(event) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  key: event.target.value,
                                                }))
                                              }
                                              className="h-8"
                                            />
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_saved_path")}</Label>
                                            <Input
                                              value={asString(assertion.path)}
                                              onChange={(event) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  path: event.target.value,
                                                }))
                                              }
                                              className="h-8"
                                            />
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_saved_op")}</Label>
                                            <Select
                                              value={
                                                VALUE_OPS.includes(assertion.op as ValueOp)
                                                  ? (assertion.op as ValueOp)
                                                  : "exists"
                                              }
                                              onValueChange={(value) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  op: value,
                                                }))
                                              }
                                            >
                                              <SelectTrigger className="h-8 text-xs w-40">
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                {VALUE_OPS.map((item) => (
                                                  <SelectItem key={item} value={item}>
                                                    {item}
                                                  </SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          </div>

                                          {(assertion.op as ValueOp) !== "exists" ? (
                                            <div className="space-y-1 xl:col-span-2">
                                              <Label className="text-xs">{t("scenario_assertion_saved_value")}</Label>
                                              <Input
                                                value={formatLooseValue(assertion.value)}
                                                onChange={(event) =>
                                                  updateAssertionAt(index, (current) => ({
                                                    ...current,
                                                    value: parseLooseValue(event.target.value),
                                                  }))
                                                }
                                                className="h-8"
                                              />
                                            </div>
                                          ) : null}

                                          <label className="flex items-center gap-2 text-xs pt-6">
                                            <Switch
                                              checked={asBoolean(assertion.caseSensitive, false)}
                                              onCheckedChange={(checked) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  caseSensitive: checked,
                                                }))
                                              }
                                            />
                                            <span>{t("scenario_assertion_case_sensitive")}</span>
                                          </label>
                                        </div>
                                      ) : null}

                                      {assertionType === "script_applied" ? (
                                        <div className="grid gap-2 xl:grid-cols-2">
                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_script_name")}</Label>
                                            <Input
                                              value={asString(assertion.scriptName)}
                                              onChange={(event) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  scriptName: event.target.value,
                                                }))
                                              }
                                              className="h-8"
                                              placeholder="startup:uncrackable1-root-bypass"
                                            />
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_script_source")}</Label>
                                            <Select
                                              value={
                                                SCRIPT_SOURCES.includes(
                                                  assertion.source as ScriptSource,
                                                )
                                                  ? (assertion.source as ScriptSource)
                                                  : "any"
                                              }
                                              onValueChange={(value) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  source: value === "any" ? "" : value,
                                                }))
                                              }
                                            >
                                              <SelectTrigger className="h-8 text-xs w-44">
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                <SelectItem value="any">
                                                  {t("scenario_assertion_script_source_any")}
                                                </SelectItem>
                                                <SelectItem value="manual">
                                                  {t("scenario_assertion_script_source_manual")}
                                                </SelectItem>
                                                <SelectItem value="startup">
                                                  {t("scenario_assertion_script_source_startup")}
                                                </SelectItem>
                                              </SelectContent>
                                            </Select>
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_script_min_hooked")}</Label>
                                            <Input
                                              type="number"
                                              min={0}
                                              value={String(asNumber(assertion.minHookedMethods, 1))}
                                              onChange={(event) => {
                                                const value = Number(event.target.value);
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  minHookedMethods: Number.isFinite(value)
                                                    ? value
                                                    : 0,
                                                }));
                                              }}
                                              className="h-8"
                                            />
                                          </div>

                                          <div className="space-y-1">
                                            <Label className="text-xs">{t("scenario_assertion_script_pid")}</Label>
                                            <Input
                                              type="number"
                                              min={1}
                                              value={
                                                typeof assertion.pid === "number"
                                                  ? String(assertion.pid)
                                                  : ""
                                              }
                                              onChange={(event) => {
                                                const value = Number(event.target.value);
                                                updateAssertionAt(index, (current) => {
                                                  if (
                                                    Number.isFinite(value) &&
                                                    value > 0
                                                  ) {
                                                    return {
                                                      ...current,
                                                      pid: value,
                                                    };
                                                  }
                                                  const next = { ...current };
                                                  delete next.pid;
                                                  return next;
                                                });
                                              }}
                                              className="h-8"
                                              placeholder={t("scenario_assertion_optional")}
                                            />
                                          </div>

                                          <div className="space-y-1 xl:col-span-2">
                                            <Label className="text-xs">{t("scenario_assertion_script_session_id")}</Label>
                                            <Input
                                              value={asString(assertion.sessionId)}
                                              onChange={(event) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  sessionId: event.target.value,
                                                }))
                                              }
                                              className="h-8"
                                              placeholder="session-uuid"
                                            />
                                          </div>

                                          <label className="flex items-center gap-2 text-xs pt-6 xl:col-span-2">
                                            <Switch
                                              checked={asBoolean(assertion.compileOk, true)}
                                              onCheckedChange={(checked) =>
                                                updateAssertionAt(index, (current) => ({
                                                  ...current,
                                                  compileOk: checked,
                                                }))
                                              }
                                            />
                                            <span>{t("scenario_assertion_script_compile_ok")}</span>
                                          </label>
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                })()
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                  )}

                  {stepsValidation.error ? (
                    <div className="text-xs text-destructive">
                      {t("scenario_steps_invalid")}: {stepsValidation.error}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      {t("scenario_steps_valid", {
                        count: stepsValidation.steps?.length ?? 0,
                      })}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <Textarea
                    value={editor.stepsText}
                    onChange={(event) =>
                      setEditor((prev) => ({ ...prev, stepsText: event.target.value }))
                    }
                    placeholder={t("scenario_steps_placeholder")}
                    className="min-h-56 font-mono text-xs"
                    disabled={isBusy}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        const parsed = parseStepsText(editor.stepsText, {
                          allowEmpty: true,
                        });
                        if (parsed.error || !parsed.steps) {
                          toast.error(t("scenario_steps_invalid"));
                          return;
                        }
                        setEditor((prev) => ({
                          ...prev,
                          steps: parsed.steps ?? [],
                          stepsText: serializeSteps(parsed.steps ?? []),
                        }));
                      }}
                    >
                      {t("scenario_format_steps")}
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={handleSwitchToVisual}
                    >
                      {t("scenario_json_apply")}
                    </Button>
                  </div>

                  {stepsValidation.error ? (
                    <div className="text-xs text-destructive">
                      {t("scenario_steps_invalid")}: {stepsValidation.error}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      {t("scenario_steps_valid", {
                        count: stepsValidation.steps?.length ?? 0,
                      })}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2">
              <label className="flex items-center gap-2 text-xs">
                <Switch
                  checked={stopOnFailure}
                  onCheckedChange={setStopOnFailure}
                  disabled={runMutation.isPending}
                />
                <span>{t("scenario_stop_on_failure")}</span>
              </label>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {t("scenario_run_target", { target: runTargetLabel })}
                </span>
                <Button
                  size="sm"
                  className="h-8"
                  onClick={() => {
                    if (!activeScenarioId) return;
                    void handleRunScenario(activeScenarioId);
                  }}
                  disabled={!activeScenarioId || !runTarget || runMutation.isPending}
                >
                  {runMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  ) : (
                    <Play className="h-3.5 w-3.5 mr-1" />
                  )}
                  {t("scenario_run_now")}
                </Button>
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium">{t("scenario_replay")}</div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleClearRuns}
                disabled={clearRunsMutation.isPending || !activeScenarioId}
              >
                {clearRunsMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                )}
                {t("scenario_clear_runs")}
              </Button>
            </div>

            {!activeScenarioId ? (
              <div className="text-xs text-muted-foreground italic">
                {t("scenario_runs_empty")}
              </div>
            ) : isLoadingRuns ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("loading")}...
              </div>
            ) : runs.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">
                {t("scenario_runs_empty")}
              </div>
            ) : (
              <div className="grid gap-3 xl:grid-cols-[260px_minmax(0,1fr)]">
                <ScrollArea className="h-72 rounded-md border border-border">
                  <div className="p-2 space-y-2">
                    {runs.map((run) => {
                      const selected = selectedRunId === run.id;
                      return (
                        <div
                          key={run.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedRunId(run.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedRunId(run.id);
                            }
                          }}
                          className={cn(
                            "group rounded-md border px-2 py-2 transition-colors",
                            selected
                              ? "border-primary bg-primary/5"
                              : "border-border hover:bg-muted/30",
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 space-y-1">
                              <Badge
                                variant="outline"
                                className={cn("text-[10px]", runStatusClass(run.status))}
                              >
                                {t(`scenario_status_${run.status}`)}
                              </Badge>
                              <div className="text-[11px] text-muted-foreground truncate">
                                {formatDateTime(run.startedAt)}
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                {formatDuration(run.durationMs)}
                              </div>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-destructive hover:text-destructive opacity-0 transition-opacity group-hover:opacity-100"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleDeleteRun(run.id);
                              }}
                              disabled={deleteRunMutation.isPending}
                              title={t("delete")}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {t("scenario_run_assertions", {
                              passed: run.assertionsPassed,
                              total: run.assertionsTotal,
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>

                <div className="space-y-3">
                  {!selectedRun ? (
                    <div className="text-xs text-muted-foreground italic">
                      {t("scenario_runs_empty")}
                    </div>
                  ) : (
                    <>
                      <div className="rounded-md border border-border p-2 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px]",
                              runStatusClass(selectedRun.status),
                            )}
                          >
                            {t(`scenario_status_${selectedRun.status}`)}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {t("scenario_run_started")}: {" "}
                            {formatDateTime(selectedRun.startedAt)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {t("scenario_run_duration")}: {" "}
                            {formatDuration(selectedRun.durationMs)}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t("scenario_run_assertions", {
                            passed: selectedRun.assertionsPassed,
                            total: selectedRun.assertionsTotal,
                          })}
                        </div>
                      </div>

                      <ScrollArea className="h-32 rounded-md border border-border">
                        <div className="p-2 space-y-2">
                          {selectedRun.stepResults.map((step) => {
                            const selected = selectedStepId === step.stepId;
                            return (
                              <div
                                key={`${step.stepId}:${step.index}`}
                                role="button"
                                tabIndex={0}
                                onClick={() => setSelectedStepId(step.stepId)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setSelectedStepId(step.stepId);
                                  }
                                }}
                                className={cn(
                                  "rounded-md border px-2 py-1.5 transition-colors",
                                  selected
                                    ? "border-primary bg-primary/5"
                                    : "border-border hover:bg-muted/20",
                                )}
                              >
                                <div className="flex items-center gap-2 text-xs">
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      "text-[10px]",
                                      stepStatusClass(step.status),
                                    )}
                                  >
                                    {t(`scenario_status_${step.status}`)}
                                  </Badge>
                                  <span className="font-medium">
                                    #{step.index + 1} · {step.type}
                                  </span>
                                </div>
                                {step.detail ? (
                                  <div className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
                                    {step.detail}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </ScrollArea>

                      <div className="space-y-2">
                        <div className="text-xs font-medium">{t("scenario_step_detail")}</div>
                        {!selectedStep ? (
                          <div className="text-xs text-muted-foreground italic">
                            {t("scenario_run_select_step")}
                          </div>
                        ) : (
                          <>
                            {selectedStep.detail ? (
                              <div className="rounded-md border border-border bg-muted/20 px-2 py-2 text-xs">
                                {selectedStep.detail}
                              </div>
                            ) : null}
                            {selectedStep.assertion ? (
                              <div className="rounded-md border border-border p-2 space-y-2">
                                <div className="text-xs font-medium">
                                  {t("scenario_run_assertion_detail")}
                                </div>
                                <Textarea
                                  value={stringifyPretty(selectedStep.assertion)}
                                  readOnly
                                  className="min-h-20 text-xs font-mono"
                                />
                              </div>
                            ) : null}
                            {typeof selectedStep.output !== "undefined" ? (
                              <div className="rounded-md border border-border p-2 space-y-2">
                                <div className="text-xs font-medium">
                                  {t("scenario_run_output")}
                                </div>
                                <Textarea
                                  value={stringifyPretty(selectedStep.output)}
                                  readOnly
                                  className="min-h-24 text-xs font-mono"
                                />
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
