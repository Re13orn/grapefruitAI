import { Hono } from "hono";

import fs from "node:fs/promises";
import nodePath from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import frida from "../lib/xvii.ts";
import env from "../lib/env.ts";
import paths from "../lib/paths.ts";
import { app as serializeApp, device as serializeDevice, process as serializeProcess } from "../lib/serializer.ts";
import { resolveDevice } from "../lib/device.ts";
import { agent } from "../lib/assets.ts";
import { listBuiltinHookScriptTemplates } from "../lib/builtin-hooks.ts";
import {
  getMCPConfig,
  rotateMCPToken,
  setMCPEnabled,
  setMCPShowTargetedCapabilities,
  verifyMCPToken,
} from "../lib/mcp-config.ts";
import { HookStore } from "../lib/store/hooks.ts";
import { CryptoStore } from "../lib/store/crypto.ts";
import { NSURLStore } from "../lib/store/nsurl.ts";
import { FlutterStore } from "../lib/store/flutter.ts";
import { JNIStore } from "../lib/store/jni.ts";
import { XPCStore } from "../lib/store/xpc.ts";
import { HermesStore } from "../lib/store/hermes.ts";
import { PrivacyStore } from "../lib/store/privacy.ts";
import {
  createHookScriptStore,
  createHookScriptPresetStore,
} from "../lib/store/scripts.ts";
import {
  createScenarioDraftFromTemplate,
  findScenarioByTemplateTag,
  listScenarioTemplates,
} from "../lib/scenario-templates.ts";
import {
  createScenarioStore,
  createScenarioRunStore,
  normalizeScenarioDraft,
  normalizeScenarioPatch,
} from "../lib/store/scenarios.ts";
import { runScenario } from "../lib/scenario-runner.ts";
import {
  appendFindings,
  clearFindings,
  createArtifact,
  createCustomHookPack,
  createTestPlanRunStore,
  createTestPlanStore,
  getArtifact,
  getEnabledRuleSets,
  getHookPack,
  listArtifacts,
  listFindings,
  listHookPacks,
  listRuleSets,
  readArtifactContent,
  removeCustomHookPack,
  setEnabledRuleSets,
  updateCustomHookPack,
  type FindingRisk,
  type HookPackPlatform,
  type TestPlanRunRecord,
  type TestPlanRunStatus,
} from "../lib/store/mcp-automation.ts";

type JsonRpcId = string | number | null;

type MCPPlatform = "fruity" | "droid";
type MCPMode = "app" | "daemon";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MCPToolResult {
  status: "ok" | "error";
  ok: boolean;
  code: string;
  message: string;
  data: unknown;
  artifacts: unknown[];
}

type MCPToolRunStatus =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "canceling"
  | "canceled";

interface MCPToolRunRecord {
  runId: string;
  name: string;
  status: MCPToolRunStatus;
  acceptedAt: string;
  startedAt?: string;
  endedAt?: string;
  timeoutAt?: string;
  heartbeatAt?: string;
  updatedAt: string;
  cancelRequested: boolean;
  cancelRequestedAt?: string;
  deviceId?: string;
  result?: MCPToolResult;
}

interface LaunchTimelineEvent {
  stage: string;
  at: string;
  pid?: number;
  detail?: string;
  error?: string;
  session?: {
    status: SessionRuntimeState["status"];
    version: number;
    reason?: string;
  };
}

interface LaunchTimelineRecord {
  timelineId: string;
  deviceId: string;
  bundle: string;
  platform?: MCPPlatform;
  restart: boolean;
  suspended: boolean;
  wasRunning: boolean;
  pid: number | null;
  status: "running" | "launched" | "failed";
  createdAt: string;
  updatedAt: string;
  events: LaunchTimelineEvent[];
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

interface ScriptApplyReceipt {
  scriptId?: string;
  scriptName: string;
  compiled: boolean;
  loaded: boolean;
  installedHooks: number;
  installedHooksSync: number;
  failedHooks: string[];
  hitCount: number;
  firstHitAt?: string;
  lastHitAt?: string;
  targetPid: number;
  source: "manual" | "preset";
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

class ToolExecutionError extends Error {
  readonly code: string;
  readonly data: unknown;

  constructor(message: string, code = "TOOL_ERROR", data: unknown = null) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
    this.data = data;
  }
}

const manager = frida.getDeviceManager();
const SOCKET_PREFIX = "socket@";
const LOG_TAIL_BYTES = 1024 * 1024;
const AGENT_SCRIPT_RETRY_LIMIT = 3;
const AGENT_SCRIPT_RETRY_DELAY_MS = 400;
const SCRIPT_APPLY_ACK_FIELD = "__igf_script_apply_ack";
const SCRIPT_APPLY_ERROR_FIELD = "scriptApplyAck";
const MCP_TOOL_TIMEOUT_MS = (() => {
  const raw = process.env.GRAPEFRUIT_MCP_TOOL_TIMEOUT_MS;
  if (!raw) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30_000;
  return parsed;
})();
const MCP_ASYNC_TOOL_TIMEOUT_MS = (() => {
  const raw = process.env.GRAPEFRUIT_MCP_ASYNC_TOOL_TIMEOUT_MS;
  if (!raw) return 120_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 120_000;
  return parsed;
})();
const MCP_ASYNC_TOOL_HEARTBEAT_MS = (() => {
  const raw = process.env.GRAPEFRUIT_MCP_ASYNC_TOOL_HEARTBEAT_MS;
  if (!raw) return 2_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 250) return 2_000;
  return parsed;
})();
const MCP_ASYNC_TOOL_STALE_GRACE_MS = (() => {
  const raw = process.env.GRAPEFRUIT_MCP_ASYNC_TOOL_STALE_GRACE_MS;
  if (!raw) return 5_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 5_000;
  return parsed;
})();
const MCP_ASYNC_TOOL_RETENTION_MS = (() => {
  const raw = process.env.GRAPEFRUIT_MCP_ASYNC_TOOL_RETENTION_MS;
  if (!raw) return 60 * 60_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 60 * 60_000;
  return parsed;
})();
const MCP_ASYNC_TOOL_MAX_RECORDS = (() => {
  const raw = process.env.GRAPEFRUIT_MCP_ASYNC_TOOL_MAX_RECORDS;
  if (!raw) return 500;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 500;
  return parsed;
})();

const ASYNC_LONG_RUNNING_TOOLS = new Set<string>([
  "launch_app",
  "resume_app",
  "stop_app",
  "tap",
  "input_text",
  "swipe",
  "back",
  "home",
  "wait_for",
  "snapshot_ui",
  "find_element",
  "tap_element",
  "input_element",
  "assert_element",
  "apply_hook_script",
  "apply_hook_script_preset",
  "validate_hook_script",
  "apply_hook_pack",
  "evaluate_findings",
  "export_report",
  "recover_session",
  "list_agent_interfaces",
  "invoke_agent_rpc",
  "run_test_scenario",
]);

interface DeviceLeaseLock {
  owner: string;
  acquiredAt: string;
  expiresAt: number;
}

interface SessionRuntimeState {
  deviceId: string;
  platform?: MCPPlatform;
  mode?: MCPMode;
  bundle?: string;
  pid?: number;
  status: "idle" | "attached" | "recovering" | "error";
  version: number;
  updatedAt: string;
  lastError?: string;
  lastTransitionReason?: string;
}

interface AndroidUINode {
  index: number;
  text: string;
  resourceId: string;
  className: string;
  packageName: string;
  contentDesc: string;
  clickable: boolean;
  enabled: boolean;
  bounds: [number, number, number, number];
  center: { x: number; y: number };
}

interface IOSUINode {
  path: string;
  className: string;
  description: string;
  frame: [number, number, number, number] | null;
  center: { x: number; y: number } | null;
}

type UISnapshot =
  | {
      platform: "droid";
      capturedAt: string;
      nodes: AndroidUINode[];
    }
  | {
      platform: "fruity";
      capturedAt: string;
      nodes: IOSUINode[];
      tree: unknown;
    };

const deviceLeaseLocks = new Map<string, DeviceLeaseLock>();
const sessionRuntime = new Map<string, SessionRuntimeState>();
const testPlanCancelTokens = new Set<string>();
const testPlanRunWorkers = new Map<string, Promise<void>>();
const toolRunStore = new Map<string, MCPToolRunRecord>();
const toolRunWorkers = new Map<string, Promise<void>>();
const toolRunAbortControllers = new Map<string, AbortController>();
const launchTimelineStore = new Map<string, LaunchTimelineRecord>();
const launchTimelineByTarget = new Map<string, string>();
let mcpLastAuthFailure:
  | {
      reason: string;
      at: string;
      guidance: string;
    }
  | null = null;
const SESSION_TRANSITIONS: Record<
  SessionRuntimeState["status"],
  SessionRuntimeState["status"][]
> = {
  idle: ["idle", "recovering", "attached", "error"],
  recovering: ["recovering", "attached", "error", "idle"],
  attached: ["attached", "recovering", "error", "idle"],
  error: ["error", "recovering", "attached", "idle"],
};

const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_devices",
    description: "List connected devices known to Grapefruit.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "add_remote_device",
    description: "Add a remote device by host:port.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
      },
      required: ["host"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_remote_device",
    description: "Remove a remote device by host:port or socket@host:port.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
      },
      required: ["host"],
      additionalProperties: false,
    },
  },
  {
    name: "list_apps",
    description: "List applications on a device.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_processes",
    description: "List processes on a device.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_device_info",
    description: "Get device system parameters.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "launch_app",
    description:
      "Launch an app by bundle/package identifier. Supports suspended spawn for pre-resume injection.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        restart: { type: "boolean" },
        suspended: { type: "boolean" },
        waitMs: { type: "number" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "bundle"],
      additionalProperties: false,
    },
  },
  {
    name: "resume_app",
    description: "Resume a previously suspended process by pid or bundle/package identifier.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        pid: { type: "number" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_app",
    description: "Stop an app by pid or bundle/package identifier.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        pid: { type: "number" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "tap",
    description: "Perform tap action at screen coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "input_text",
    description: "Perform text input action.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        text: { type: "string" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "swipe",
    description: "Perform swipe action between two points.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        durationMs: { type: "number" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "x1", "y1", "x2", "y2"],
      additionalProperties: false,
    },
  },
  {
    name: "back",
    description: "Perform back navigation action.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "home",
    description: "Perform home navigation action.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for",
    description: "Wait by duration or app running/stopped state.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        ms: { type: "number" },
        bundle: { type: "string" },
        state: { type: "string", enum: ["running", "stopped"] },
        timeoutMs: { type: "number" },
        intervalMs: { type: "number" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_tool_run",
    description: "Poll one asynchronous MCP tool run by runId.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_tool_run",
    description: "Request cancellation for one asynchronous MCP tool run.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "launch_timeline",
    description:
      "Get launch timeline events (spawn/attach/inject/resume/exit) by timelineId or latest deviceId+bundle.",
    inputSchema: {
      type: "object",
      properties: {
        timelineId: { type: "string" },
        deviceId: { type: "string" },
        bundle: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_history",
    description:
      "Query captured history from stores: hooks, crypto, nsurl, flutter, jni, xpc, privacy, hermes.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        deviceId: { type: "string" },
        identifier: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
        filter: { type: "object" },
      },
      required: ["kind", "deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "get_script_apply_acks",
    description:
      "Get structured script apply acknowledgements (compile/install/hit stages, failures) from hook history.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        scriptName: { type: "string" },
        source: { type: "string", enum: ["manual", "startup"] },
        sessionId: { type: "string" },
        pid: { type: "number" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "clear_history",
    description:
      "Clear captured history by kind: hooks, crypto, nsurl, flutter, jni, xpc, privacy, hermes.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        deviceId: { type: "string" },
        identifier: { type: "string" },
      },
      required: ["kind", "deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "get_logs",
    description: "Read syslog or agent log tail for a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        type: { type: "string", enum: ["syslog", "agent"] },
        tailBytes: { type: "number" },
      },
      required: ["deviceId", "identifier", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "clear_logs",
    description: "Delete logs directory for a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "list_hook_scripts",
    description: "List saved custom hook scripts for a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "create_hook_script",
    description: "Create a hook script entry.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        name: { type: "string" },
        content: { type: "string" },
        enabled: { type: "boolean" },
        runOnAppLaunch: { type: "boolean" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "identifier", "name", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "update_hook_script",
    description: "Update fields of a hook script entry.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        content: { type: "string" },
        enabled: { type: "boolean" },
        runOnAppLaunch: { type: "boolean" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "identifier", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_hook_script",
    description: "Delete a hook script entry.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        id: { type: "string" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "identifier", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_hook_script_presets",
    description: "List hook script presets for a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "create_hook_script_preset",
    description: "Create a hook script preset.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        name: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scriptId: { type: "string" },
              enabled: { type: "boolean" },
              runOnAppLaunch: { type: "boolean" },
            },
            required: ["scriptId", "enabled", "runOnAppLaunch"],
            additionalProperties: false,
          },
        },
        autoApplyOnAppLaunch: { type: "boolean" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "identifier", "name", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_hook_script_preset",
    description:
      "Apply a script preset to script enabled/startup flags and optionally execute enabled scripts immediately.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        presetId: { type: "string" },
        execute: { type: "boolean" },
        platform: { type: "string", enum: ["droid", "fruity"] },
        mode: { type: "string", enum: ["app", "daemon"] },
        bundle: { type: "string" },
        pid: { type: "number" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "identifier", "presetId"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_hook_script",
    description:
      "Apply one hook script immediately and return structured execution receipt.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        scriptId: { type: "string" },
        scriptName: { type: "string" },
        content: { type: "string" },
        platform: { type: "string", enum: ["droid", "fruity"] },
        mode: { type: "string", enum: ["app", "daemon"] },
        bundle: { type: "string" },
        pid: { type: "number" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "validate_hook_script",
    description:
      "Pre-validate hook script syntax and referenced Java/ObjC classes before runtime apply.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        scriptId: { type: "string" },
        scriptName: { type: "string" },
        content: { type: "string" },
        platform: { type: "string", enum: ["droid", "fruity"] },
        mode: { type: "string", enum: ["app", "daemon"] },
        bundle: { type: "string" },
        pid: { type: "number" },
        checkSymbols: { type: "boolean" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "get_hook_stats",
    description:
      "Aggregate hook hit counts and recent timestamps by symbol and script.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        limit: { type: "number" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "list_hook_packs",
    description:
      "List builtin and custom hook packs. Defaults to generic packs; targeted/sample packs require includeTargeted=true.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["droid", "fruity", "any"] },
        identifier: { type: "string" },
        includeTargeted: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_hook_pack",
    description: "Create a custom reusable hook pack.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        platform: { type: "string", enum: ["droid", "fruity", "any"] },
        scripts: { type: "array" },
      },
      required: ["name", "scripts"],
      additionalProperties: false,
    },
  },
  {
    name: "update_hook_pack",
    description: "Update a custom hook pack.",
    inputSchema: {
      type: "object",
      properties: {
        packId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        platform: { type: "string", enum: ["droid", "fruity", "any"] },
        scripts: { type: "array" },
      },
      required: ["packId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_hook_pack",
    description: "Delete a custom hook pack.",
    inputSchema: {
      type: "object",
      properties: {
        packId: { type: "string" },
      },
      required: ["packId"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_hook_pack",
    description:
      "Apply hook pack scripts to a target and create/apply a matching preset.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        packId: { type: "string" },
        autoApplyOnAppLaunch: { type: "boolean" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "identifier", "packId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_rulesets",
    description: "List available security rulesets.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "enable_ruleset",
    description: "Set enabled rulesets for a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        rulesetIds: { type: "array" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "identifier", "rulesetIds"],
      additionalProperties: false,
    },
  },
  {
    name: "evaluate_findings",
    description: "Evaluate enabled rulesets and produce findings.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        rulesetIds: { type: "array" },
        save: { type: "boolean" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "list_findings",
    description: "List findings for a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        risk: { type: "string", enum: ["high", "medium", "low"] },
        status: { type: "string", enum: ["open", "mitigated", "accepted"] },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "clear_findings",
    description: "Clear findings for a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "list_artifacts",
    description: "List generated artifacts for a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        type: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "get_artifact",
    description: "Read an artifact content preview by id.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        artifactId: { type: "string" },
        maxBytes: { type: "number" },
      },
      required: ["deviceId", "identifier", "artifactId"],
      additionalProperties: false,
    },
  },
  {
    name: "export_report",
    description: "Export test report artifact for a plan run.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        runId: { type: "string" },
        name: { type: "string" },
      },
      required: ["deviceId", "identifier", "runId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_test_plans",
    description: "List test plans for a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "create_test_plan",
    description: "Create an automated test plan.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        plan: { type: "object" },
      },
      required: ["deviceId", "identifier", "plan"],
      additionalProperties: false,
    },
  },
  {
    name: "update_test_plan",
    description: "Update an existing test plan.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        planId: { type: "string" },
        patch: { type: "object" },
      },
      required: ["deviceId", "identifier", "planId", "patch"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_test_plan",
    description: "Delete a test plan.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        planId: { type: "string" },
      },
      required: ["deviceId", "identifier", "planId"],
      additionalProperties: false,
    },
  },
  {
    name: "run_test_plan",
    description: "Start test plan run asynchronously.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        planId: { type: "string" },
        target: { type: "object" },
        stopOnFailure: { type: "boolean" },
      },
      required: ["deviceId", "identifier", "planId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_test_run",
    description: "Get one test plan run by id.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        runId: { type: "string" },
      },
      required: ["deviceId", "identifier", "runId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_test_plan_runs",
    description: "List test plan runs for a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        planId: { type: "string" },
        status: {
          type: "string",
          enum: ["queued", "running", "passed", "failed", "error", "canceling", "canceled"],
        },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_test_run",
    description: "Request cancellation for a running test plan run.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        runId: { type: "string" },
      },
      required: ["deviceId", "identifier", "runId"],
      additionalProperties: false,
    },
  },
  {
    name: "rerun_failed_steps",
    description: "Create and run a new plan from failed scenarios of a previous run.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        runId: { type: "string" },
      },
      required: ["deviceId", "identifier", "runId"],
      additionalProperties: false,
    },
  },
  {
    name: "snapshot_ui",
    description: "Capture UI snapshot for semantic automation.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        platform: { type: "string", enum: ["droid", "fruity"] },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "find_element",
    description: "Find a UI element by semantic query.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        platform: { type: "string", enum: ["droid", "fruity"] },
        query: { type: "object" },
      },
      required: ["deviceId", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "tap_element",
    description: "Find and tap an element by query.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        platform: { type: "string", enum: ["droid", "fruity"] },
        query: { type: "object" },
      },
      required: ["deviceId", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "input_element",
    description: "Find an element, focus it, then input text.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        platform: { type: "string", enum: ["droid", "fruity"] },
        query: { type: "object" },
        text: { type: "string" },
      },
      required: ["deviceId", "query", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "assert_element",
    description: "Assert whether an element exists for a semantic query.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
        platform: { type: "string", enum: ["droid", "fruity"] },
        query: { type: "object" },
        shouldExist: { type: "boolean" },
      },
      required: ["deviceId", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "acquire_device_lock",
    description: "Acquire an exclusive device lock for one agent owner.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        owner: { type: "string" },
        ttlMs: { type: "number" },
      },
      required: ["deviceId", "owner"],
      additionalProperties: false,
    },
  },
  {
    name: "release_device_lock",
    description: "Release a device lock held by owner.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        owner: { type: "string" },
      },
      required: ["deviceId", "owner"],
      additionalProperties: false,
    },
  },
  {
    name: "get_session_state",
    description: "Get current MCP session state for target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        bundle: { type: "string" },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "recover_session",
    description: "Recover disconnected session by relaunching and re-attaching app target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        platform: { type: "string", enum: ["droid", "fruity"] },
        mode: { type: "string", enum: ["app", "daemon"] },
        bundle: { type: "string" },
        pid: { type: "number" },
        relaunch: { type: "boolean" },
        rescue: { type: "boolean" },
        replayPreset: { type: "boolean" },
        waitMs: { type: "number" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_platform_capabilities",
    description:
      "Return platform-agnostic Grapefruit MCP capability matrix. Defaults to generic capabilities only.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["droid", "fruity"] },
        includeTargeted: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_scenario_templates",
    description: "List builtin scenario DSL templates.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "import_scenario_template",
    description: "Import one builtin scenario template into a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        templateId: { type: "string" },
        overwrite: { type: "boolean" },
        name: { type: "string" },
        description: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["deviceId", "identifier", "templateId"],
      additionalProperties: false,
    },
  },
  {
    name: "import_all_scenario_templates",
    description: "Import all builtin scenario templates into a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        overwrite: { type: "boolean" },
        templateIds: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "list_test_scenarios",
    description: "List saved DSL test scenarios for a target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "create_test_scenario",
    description: "Create a test scenario using Grapefruit DSL steps.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        scenario: { type: "object" },
      },
      required: ["deviceId", "identifier", "scenario"],
      additionalProperties: false,
    },
  },
  {
    name: "update_test_scenario",
    description: "Update an existing test scenario.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        scenarioId: { type: "string" },
        patch: { type: "object" },
      },
      required: ["deviceId", "identifier", "scenarioId", "patch"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_test_scenario",
    description: "Delete a test scenario.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        scenarioId: { type: "string" },
      },
      required: ["deviceId", "identifier", "scenarioId"],
      additionalProperties: false,
    },
  },
  {
    name: "run_test_scenario",
    description: "Execute a DSL test scenario and return structured assertion results.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        scenarioId: { type: "string" },
        target: { type: "object" },
        stopOnFailure: { type: "boolean" },
      },
      required: ["deviceId", "identifier", "scenarioId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_test_runs",
    description: "List stored scenario run results.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        identifier: { type: "string" },
        scenarioId: { type: "string" },
      },
      required: ["deviceId", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "list_agent_interfaces",
    description: "Load agent and return RPC interfaces for a running target.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        platform: { type: "string", enum: ["fruity", "droid"] },
        mode: { type: "string", enum: ["app", "daemon"] },
        bundle: { type: "string" },
        pid: { type: "number" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "platform", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "invoke_agent_rpc",
    description:
      "Invoke agent RPC namespace/method for a running target. App mode requires bundle and running process.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        platform: { type: "string", enum: ["fruity", "droid"] },
        mode: { type: "string", enum: ["app", "daemon"] },
        bundle: { type: "string" },
        pid: { type: "number" },
        namespace: { type: "string" },
        method: { type: "string" },
        args: { type: "array" },
        expectedState: { type: "string", enum: ["idle", "recovering", "attached", "error"] },
        expectedVersion: { type: "number" },
      },
      required: ["deviceId", "platform", "mode", "namespace", "method"],
      additionalProperties: false,
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"${key}" must be a non-empty string`);
  }
  return value;
}

function asOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "string") {
    throw new Error(`"${key}" must be a string`);
  }
  return value;
}

function asOptionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`"${key}" must be a finite number`);
  }
  return value;
}

function asNumber(input: Record<string, unknown>, key: string): number {
  const value = asOptionalNumber(input, key);
  if (typeof value !== "number") {
    throw new Error(`"${key}" must be a finite number`);
  }
  return value;
}

function asBoolean(input: Record<string, unknown>, key: string): boolean {
  const value = asOptionalBoolean(input, key);
  if (typeof value !== "boolean") {
    throw new Error(`"${key}" must be a boolean`);
  }
  return value;
}

function asOptionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`"${key}" must be a boolean`);
  }
  return value;
}

function parseScenarioRunTarget(input: unknown) {
  const target = asObject(input ?? {}, "target");
  const next: {
    platform?: "fruity" | "droid";
    mode?: "app" | "daemon";
    bundle?: string;
    pid?: number;
  } = {};

  const platform = asOptionalString(target, "platform");
  if (platform) {
    if (platform !== "fruity" && platform !== "droid") {
      throw new Error('"target.platform" must be "fruity" or "droid"');
    }
    next.platform = platform;
  }

  const mode = asOptionalString(target, "mode");
  if (mode) {
    if (mode !== "app" && mode !== "daemon") {
      throw new Error('"target.mode" must be "app" or "daemon"');
    }
    next.mode = mode;
  }

  const bundle = asOptionalString(target, "bundle");
  if (bundle) next.bundle = bundle;
  const pid = asOptionalNumber(target, "pid");
  if (typeof pid === "number") next.pid = Math.floor(pid);

  return next;
}

function asObject(input: unknown, label = "arguments"): Record<string, unknown> {
  if (!isRecord(input)) throw new Error(`${label} must be an object`);
  return input;
}

function asArray(input: Record<string, unknown>, key: string): unknown[] {
  const value = input[key];
  if (!Array.isArray(value)) throw new Error(`"${key}" must be an array`);
  return value;
}

function asOptionalStringArray(
  input: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = input[key];
  if (typeof value === "undefined") return undefined;
  if (!Array.isArray(value)) throw new Error(`"${key}" must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`"${key}[${index}]" must be a string`);
    }
    return item.trim();
  }).filter((item) => item.length > 0);
}

function normalizeRemoteHost(hostOrId: string): string {
  return hostOrId.startsWith(SOCKET_PREFIX)
    ? hostOrId.slice(SOCKET_PREFIX.length)
    : hostOrId;
}

async function findRemoteDevice(hostOrId: string) {
  const candidates = [hostOrId];
  if (!hostOrId.startsWith(SOCKET_PREFIX)) {
    candidates.push(`${SOCKET_PREFIX}${hostOrId}`);
  }

  for (const id of candidates) {
    const dev = await manager.getDeviceById(id, env.timeout).catch(() => null);
    if (dev && dev.type === "remote") return dev;
  }
  return null;
}

function waitMs(ms: number, signal?: AbortSignal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function getRunningAppPid(
  device: Awaited<ReturnType<typeof resolveDevice>>,
  bundle: string,
  options: { signal?: AbortSignal } = {},
) {
  throwIfAborted(options.signal);
  const apps = await device.enumerateApplications({
    identifiers: [bundle],
    scope: frida.Scope.Full,
  });
  throwIfAborted(options.signal);
  const app = apps.at(0);
  if (!app) return null;
  if (!app.pid || app.pid <= 0) return null;
  return app.pid;
}

async function waitForRunningAppPid(
  device: Awaited<ReturnType<typeof resolveDevice>>,
  bundle: string,
  timeoutMs = 4000,
  intervalMs = 200,
  options: { signal?: AbortSignal } = {},
) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    throwIfAborted(options.signal);
    const pid = await getRunningAppPid(device, bundle, options);
    if (pid) return pid;
    await waitMs(intervalMs, options.signal);
  }
  throwIfAborted(options.signal);
  return null;
}

const deviceTaskQueue = new Map<string, Promise<unknown>>();

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  if (typeof reason === "string" && reason.trim().length > 0) {
    throw new Error(reason);
  }
  throw new Error("request aborted");
}

async function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return await promise;
  if (signal.aborted) {
    throwIfAborted(signal);
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function createToolExecutionSignal(signal?: AbortSignal): AbortSignal | undefined {
  if (MCP_TOOL_TIMEOUT_MS <= 0) return signal;
  const timeoutSignal = AbortSignal.timeout(MCP_TOOL_TIMEOUT_MS);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

function createAsyncToolRunSignal(signal: AbortSignal) {
  if (MCP_ASYNC_TOOL_TIMEOUT_MS <= 0) return signal;
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(MCP_ASYNC_TOOL_TIMEOUT_MS),
  ]);
}

function isToolRunTerminal(status: MCPToolRunStatus) {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function toToolRunView(run: MCPToolRunRecord) {
  return {
    runId: run.runId,
    name: run.name,
    status: run.status,
    done: isToolRunTerminal(run.status),
    acceptedAt: run.acceptedAt,
    startedAt: run.startedAt ?? null,
    endedAt: run.endedAt ?? null,
    timeoutAt: run.timeoutAt ?? null,
    heartbeatAt: run.heartbeatAt ?? null,
    updatedAt: run.updatedAt,
    cancelRequested: run.cancelRequested,
    cancelRequestedAt: run.cancelRequestedAt ?? null,
    deviceId: run.deviceId ?? null,
    result: run.result ?? null,
    poll: {
      name: "get_tool_run",
      arguments: { runId: run.runId },
    },
    cancel: {
      name: "cancel_tool_run",
      arguments: { runId: run.runId },
    },
  };
}

function finalizeStaleToolRuns() {
  if (MCP_ASYNC_TOOL_TIMEOUT_MS <= 0) return;
  const nowMs = Date.now();
  for (const [runId, run] of Array.from(toolRunStore.entries())) {
    if (isToolRunTerminal(run.status)) continue;
    const timeoutAtMs = run.timeoutAt ? Date.parse(run.timeoutAt) : NaN;
    if (!Number.isFinite(timeoutAtMs)) continue;
    if (nowMs <= timeoutAtMs + MCP_ASYNC_TOOL_STALE_GRACE_MS) continue;

    const controller = toolRunAbortControllers.get(runId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(`tool run ${runId} timed out`));
    }
    updateToolRun(runId, {
      status: run.cancelRequested ? "canceled" : "failed",
      endedAt: new Date().toISOString(),
      result: run.cancelRequested
        ? toolError("tool run canceled after timeout", "CANCELED")
        : toolError("tool run timeout", "TIMEOUT"),
    });
  }
}

function updateToolRun(
  runId: string,
  patch: Partial<Omit<MCPToolRunRecord, "runId" | "name" | "acceptedAt">>,
) {
  const current = toolRunStore.get(runId);
  if (!current) return null;
  const next: MCPToolRunRecord = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  toolRunStore.set(runId, next);
  return next;
}

function cleanupToolRuns() {
  finalizeStaleToolRuns();
  const now = Date.now();
  const entries = Array.from(toolRunStore.entries());
  for (const [runId, run] of entries) {
    if (!isToolRunTerminal(run.status)) continue;
    const endedAtMs = run.endedAt
      ? Date.parse(run.endedAt)
      : Date.parse(run.updatedAt);
    if (!Number.isFinite(endedAtMs)) continue;
    if (now - endedAtMs > MCP_ASYNC_TOOL_RETENTION_MS) {
      toolRunStore.delete(runId);
      toolRunWorkers.delete(runId);
      toolRunAbortControllers.delete(runId);
    }
  }

  if (toolRunStore.size <= MCP_ASYNC_TOOL_MAX_RECORDS) return;

  const terminalEntries = Array.from(toolRunStore.entries())
    .filter(([, run]) => isToolRunTerminal(run.status))
    .sort((a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt));

  for (const [runId] of terminalEntries) {
    if (toolRunStore.size <= MCP_ASYNC_TOOL_MAX_RECORDS) break;
    toolRunStore.delete(runId);
    toolRunWorkers.delete(runId);
    toolRunAbortControllers.delete(runId);
  }
}

function isKnownTool(name: string) {
  return TOOL_SPECS.some((spec) => spec.name === name);
}

function shouldRunToolAsync(name: string, args: Record<string, unknown>) {
  if (name === "get_tool_run" || name === "cancel_tool_run") return false;
  if (args.sync === true || args.async === false) return false;
  if (args.async === true) return true;
  return ASYNC_LONG_RUNNING_TOOLS.has(name);
}

async function startAsyncToolRun(name: string, args: Record<string, unknown>) {
  cleanupToolRuns();
  const runId = randomUUID();
  const acceptedAt = new Date().toISOString();
  const timeoutAt =
    MCP_ASYNC_TOOL_TIMEOUT_MS > 0
      ? new Date(Date.now() + MCP_ASYNC_TOOL_TIMEOUT_MS).toISOString()
      : undefined;
  const deviceId =
    typeof args.deviceId === "string" && args.deviceId.length > 0
      ? args.deviceId
      : undefined;
  const initial: MCPToolRunRecord = {
    runId,
    name,
    status: "accepted",
    acceptedAt,
    timeoutAt,
    updatedAt: acceptedAt,
    cancelRequested: false,
    deviceId,
  };
  toolRunStore.set(runId, initial);

  const controller = new AbortController();
  toolRunAbortControllers.set(runId, controller);
  const signal = createAsyncToolRunSignal(controller.signal);

  const worker = (async () => {
    const heartbeatTimer =
      MCP_ASYNC_TOOL_HEARTBEAT_MS > 0
        ? setInterval(() => {
            const current = toolRunStore.get(runId);
            if (!current || isToolRunTerminal(current.status)) return;
            updateToolRun(runId, {
              heartbeatAt: new Date().toISOString(),
            });
          }, MCP_ASYNC_TOOL_HEARTBEAT_MS)
        : null;
    if (
      heartbeatTimer &&
      typeof heartbeatTimer === "object" &&
      "unref" in heartbeatTimer &&
      typeof heartbeatTimer.unref === "function"
    ) {
      heartbeatTimer.unref();
    }
    try {
      const beforeRun = toolRunStore.get(runId);
      if (!beforeRun) return;
      if (beforeRun.cancelRequested || signal.aborted) {
        updateToolRun(runId, {
          status: "canceled",
          endedAt: new Date().toISOString(),
          result: toolError("tool run canceled", "CANCELED"),
        });
        return;
      }

      updateToolRun(runId, {
        status: "running",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      });

      const result = await executeTool(name, args, {
        signal,
        allowAsyncDispatch: false,
      });

      const current = toolRunStore.get(runId);
      if (!current || isToolRunTerminal(current.status)) return;
      const canceled =
        current.cancelRequested || result.code === "CANCELED" || signal.aborted;
      updateToolRun(runId, {
        status: canceled
          ? "canceled"
          : result.ok
            ? "succeeded"
            : "failed",
        endedAt: new Date().toISOString(),
        result,
      });
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    }
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const current = toolRunStore.get(runId);
    if (!current || isToolRunTerminal(current.status)) return;
    updateToolRun(runId, {
      status: "failed",
      endedAt: new Date().toISOString(),
      result: toolError(message, classifyToolErrorCode(message)),
    });
  }).finally(() => {
    toolRunWorkers.delete(runId);
    toolRunAbortControllers.delete(runId);
    cleanupToolRuns();
  });

  toolRunWorkers.set(runId, worker);
  return toToolRunView(initial);
}

function getToolRunOrThrow(runId: string) {
  cleanupToolRuns();
  finalizeStaleToolRuns();
  const run = toolRunStore.get(runId);
  if (!run) throw new Error(`tool run not found: ${runId}`);
  return run;
}

function cancelToolRun(runId: string) {
  const run = getToolRunOrThrow(runId);
  if (isToolRunTerminal(run.status)) {
    return toToolRunView(run);
  }

  const now = new Date().toISOString();
  const next = updateToolRun(runId, {
    cancelRequested: true,
    cancelRequestedAt: now,
    status: run.status === "accepted" || run.status === "running" ? "canceling" : run.status,
  });
  const controller = toolRunAbortControllers.get(runId);
  if (controller && !controller.signal.aborted) {
    controller.abort(new Error(`tool run ${runId} canceled by user`));
  }
  return toToolRunView(next ?? run);
}

async function withDeviceLock<T>(
  deviceId: string,
  action: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
) {
  const pending = deviceTaskQueue.get(deviceId) ?? Promise.resolve();
  const waitPending = withAbortSignal(pending, options.signal);
  const run = waitPending.then(
    async () => {
      throwIfAborted(options.signal);
      return await action();
    },
    async () => {
      throwIfAborted(options.signal);
      return await action();
    },
  );
  // Keep queue tail resolved so one failed task never poisons the queue.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  deviceTaskQueue.set(deviceId, tail);

  try {
    return await run;
  } finally {
    if (deviceTaskQueue.get(deviceId) === tail) {
      deviceTaskQueue.delete(deviceId);
    }
  }
}

const RETRYABLE_ERROR_PATTERNS = [
  /connection is closed/i,
  /device not found/i,
  /device lost/i,
  /session is detached/i,
  /script is destroyed/i,
  /process (?:was )?terminated/i,
  /process replaced/i,
  /transport.*closed/i,
  /read econnreset/i,
];

function isRetryableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function adbSerial(deviceId: string) {
  return deviceId.startsWith(SOCKET_PREFIX)
    ? deviceId.slice(SOCKET_PREFIX.length)
    : deviceId;
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 15_000,
  options: { signal?: AbortSignal } = {},
) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    throwIfAborted(options.signal);
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const onDone = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      onDone(() => {
        options.signal?.removeEventListener("abort", onAbort);
        child.kill("SIGKILL");
        reject(
          new Error(
            `command timeout after ${timeoutMs}ms: ${command} ${args.join(" ")}`,
          ),
        );
      });
    }, Math.max(1000, timeoutMs));

    const onAbort = () => {
      onDone(() => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        child.kill("SIGKILL");
        try {
          throwIfAborted(options.signal);
        } catch (error) {
          reject(error);
        }
      });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      onDone(() => reject(error));
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      onDone(() => {
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
          return;
        }

        reject(
          new Error(
            [
              `${command} exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`,
              args.length ? `args: ${args.join(" ")}` : "",
              stderr.trim() ? `stderr: ${stderr.trim()}` : "",
              stdout.trim() ? `stdout: ${stdout.trim()}` : "",
            ]
              .filter(Boolean)
              .join(" | "),
          ),
        );
      });
    });
  });
}

async function runAdbShell(
  deviceId: string,
  shellArgs: string[],
  options: { signal?: AbortSignal } = {},
) {
  const serial = adbSerial(deviceId);
  const result = await runCommand(
    "adb",
    ["-s", serial, "shell", ...shellArgs],
    15_000,
    options,
  );
  return {
    serial,
    ...result,
  };
}

function encodeAdbInputText(value: string) {
  return value.replace(/ /g, "%s");
}

function asMCPPlatform(input: string): MCPPlatform | null {
  const value = input.toLowerCase();
  if (value === "droid" || value === "android") return "droid";
  if (value === "fruity" || value === "ios" || value === "macos") return "fruity";
  return null;
}

async function detectDevicePlatform(deviceId: string): Promise<MCPPlatform> {
  const device = await resolveDevice(deviceId);
  const info = await device.querySystemParameters();

  const osPlatform = asMCPPlatform(info.os?.id ?? "");
  if (osPlatform) return osPlatform;

  const kernelPlatform = asMCPPlatform(info.platform ?? "");
  if (kernelPlatform) return kernelPlatform;

  throw new Error(
    `Unsupported device platform: ${info.os?.id ?? info.platform ?? "unknown"}`,
  );
}

async function invokeFruityAutomation(
  deviceId: string,
  bundle: string | undefined,
  method: "tap" | "inputText" | "swipe" | "back" | "home",
  methodArgs: unknown[],
  options: { signal?: AbortSignal } = {},
) {
  throwIfAborted(options.signal);
  if (bundle) {
    return await withAgentScript(
      {
        deviceId,
        platform: "fruity",
        mode: "app",
        bundle,
      },
      async (script) =>
        await script.exports.invoke("automation", method, methodArgs),
      options,
    );
  }

  const device = await resolveDevice(deviceId);
  const frontmost = await device.getFrontmostApplication();
  if (!frontmost?.pid || frontmost.pid <= 0) {
    throw new Error(
      'iOS automation requires a foreground app. Bring app to foreground or pass "bundle".',
    );
  }

  return await withAgentScript(
    {
      deviceId,
      platform: "fruity",
      mode: "daemon",
      pid: frontmost.pid,
    },
    async (script) =>
      await script.exports.invoke("automation", method, methodArgs),
    options,
  );
}

function sessionKey(deviceId: string, bundle?: string) {
  return `${deviceId}|${bundle ?? "*"}`;
}

function normalizeSessionStatus(
  input: string,
  field: string,
): SessionRuntimeState["status"] {
  if (
    input === "idle" ||
    input === "recovering" ||
    input === "attached" ||
    input === "error"
  ) {
    return input;
  }
  throw new Error(`"${field}" must be one of: idle, recovering, attached, error`);
}

function parseExpectedSessionState(args: Record<string, unknown>) {
  const expectedStateRaw = asOptionalString(args, "expectedState");
  return expectedStateRaw
    ? normalizeSessionStatus(expectedStateRaw, "expectedState")
    : undefined;
}

function parseExpectedSessionVersion(args: Record<string, unknown>) {
  const expectedVersionRaw = asOptionalNumber(args, "expectedVersion");
  if (typeof expectedVersionRaw === "undefined") return undefined;
  const expectedVersion = Math.floor(expectedVersionRaw);
  if (expectedVersion < 0) {
    throw new Error('"expectedVersion" must be a non-negative integer');
  }
  return expectedVersion;
}

function timelineKey(deviceId: string, bundle: string) {
  return `${deviceId}|${bundle}`;
}

function nowIso() {
  return new Date().toISOString();
}

function createLaunchTimeline(input: {
  deviceId: string;
  bundle: string;
  platform?: MCPPlatform;
  restart: boolean;
  suspended: boolean;
  wasRunning: boolean;
}) {
  const timestamp = nowIso();
  const record: LaunchTimelineRecord = {
    timelineId: randomUUID(),
    deviceId: input.deviceId,
    bundle: input.bundle,
    platform: input.platform,
    restart: input.restart,
    suspended: input.suspended,
    wasRunning: input.wasRunning,
    pid: null,
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [],
  };
  launchTimelineStore.set(record.timelineId, record);
  launchTimelineByTarget.set(
    timelineKey(input.deviceId, input.bundle),
    record.timelineId,
  );
  return record;
}

function pushLaunchTimelineEvent(
  record: LaunchTimelineRecord,
  patch: Omit<LaunchTimelineEvent, "at"> & { at?: string },
) {
  const event: LaunchTimelineEvent = {
    ...patch,
    at: patch.at ?? nowIso(),
  };
  record.events.push(event);
  record.updatedAt = event.at;
}

function finishLaunchTimeline(
  record: LaunchTimelineRecord,
  patch: {
    status: LaunchTimelineRecord["status"];
    pid?: number | null;
  },
) {
  record.status = patch.status;
  if (typeof patch.pid !== "undefined") {
    record.pid = patch.pid;
  }
  record.updatedAt = nowIso();
}

function getLaunchTimeline(params: {
  timelineId?: string;
  deviceId?: string;
  bundle?: string;
}) {
  if (params.timelineId) {
    return launchTimelineStore.get(params.timelineId) ?? null;
  }
  if (params.deviceId && params.bundle) {
    const latestId = launchTimelineByTarget.get(
      timelineKey(params.deviceId, params.bundle),
    );
    if (!latestId) return null;
    return launchTimelineStore.get(latestId) ?? null;
  }
  return null;
}

function normalizeErrorString(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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

function fallbackScriptApplyAck(
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
    error: typeof error === "undefined" ? undefined : normalizeErrorString(error),
  };
}

function toScriptApplyReceipt(
  ack: ScriptApplyAckPayload,
  options: {
    source: ScriptApplyReceipt["source"];
    targetPid: number;
    scriptId?: string;
  },
): ScriptApplyReceipt {
  return {
    scriptId: options.scriptId,
    scriptName: ack.scriptName,
    compiled: ack.compileOk,
    loaded: ack.compileOk,
    installedHooks: ack.installedHooksSync,
    installedHooksSync: ack.installedHooksSync,
    failedHooks: ack.failedMethods,
    hitCount: ack.hitCount,
    firstHitAt: ack.firstHitAt,
    lastHitAt: ack.lastHitAt,
    targetPid: options.targetPid,
    source: options.source,
    error: ack.error,
    startedAt: ack.startedAt,
    finishedAt: ack.finishedAt,
    durationMs: ack.durationMs,
  };
}

function appendScriptApplyEvidence(
  deviceId: string,
  identifier: string,
  receipt: ScriptApplyReceipt,
  options: {
    sessionId?: string;
  } = {},
) {
  const store = new HookStore(deviceId, identifier);
  store.append({
    category: "script.apply.ack",
    symbol: receipt.scriptName,
    dir: "leave",
    line: [
      `script_apply_ack ${receipt.scriptName}`,
      `source=${receipt.source}`,
      `compileOk=${receipt.compiled}`,
      `hookedMethods=${receipt.installedHooksSync}`,
      `installedHooksSync=${receipt.installedHooksSync}`,
      `failedMethods=${receipt.failedHooks.length}`,
      `hitCount=${receipt.hitCount}`,
    ].join(" "),
    extra: {
      source: receipt.source,
      compileOk: receipt.compiled,
      hookedMethods: receipt.installedHooksSync,
      installedHooksSync: receipt.installedHooksSync,
      failedMethods: receipt.failedHooks,
      hitCount: receipt.hitCount,
      firstHitAt: receipt.firstHitAt,
      lastHitAt: receipt.lastHitAt,
      error: receipt.error,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
      durationMs: receipt.durationMs,
      pid: receipt.targetPid,
      sessionId: options.sessionId,
      scriptId: receipt.scriptId,
    },
  });
}

function buildEvidenceArtifacts(input: {
  deviceId: string;
  identifier: string;
  pid?: number | null;
  runHint?: string;
}) {
  const now = nowIso();
  return [
    {
      type: "agent-log-tail",
      capturedAt: now,
      poll: {
        name: "get_logs",
        arguments: {
          deviceId: input.deviceId,
          identifier: input.identifier,
          type: "agent",
        },
      },
    },
    {
      type: "syslog-tail",
      capturedAt: now,
      poll: {
        name: "get_logs",
        arguments: {
          deviceId: input.deviceId,
          identifier: input.identifier,
          type: "syslog",
        },
      },
    },
    {
      type: "hook-events",
      capturedAt: now,
      poll: {
        name: "get_history",
        arguments: {
          kind: "hooks",
          deviceId: input.deviceId,
          identifier: input.identifier,
          limit: 200,
          ...(typeof input.pid === "number" ? { filter: { pid: input.pid } } : {}),
        },
      },
      runHint: input.runHint,
    },
  ];
}

function withSessionCAS(
  deviceId: string,
  bundle: string | undefined,
  args: Record<string, unknown>,
) {
  const expectedState = parseExpectedSessionState(args);
  const expectedVersion = parseExpectedSessionVersion(args);
  if (typeof expectedState === "undefined" && typeof expectedVersion === "undefined") {
    return;
  }
  const current = getSessionState(deviceId, bundle);
  if (typeof expectedState !== "undefined" && current.status !== expectedState) {
    throw new ToolExecutionError(
      `session state conflict: expected ${expectedState}, got ${current.status}`,
      "STATE_CONFLICT",
      {
        expectedState,
        actualState: current.status,
        bundle: bundle ?? null,
        currentVersion: current.version,
      },
    );
  }
  if (
    typeof expectedVersion === "number" &&
    current.version !== expectedVersion
  ) {
    throw new ToolExecutionError(
      `session version conflict: expected ${expectedVersion}, got ${current.version}`,
      "STATE_CONFLICT",
      {
        expectedVersion,
        actualVersion: current.version,
        bundle: bundle ?? null,
        currentState: current.status,
      },
    );
  }
}

async function evaluateHookScriptInSession(options: {
  deviceId: string;
  identifier: string;
  platform: MCPPlatform;
  mode: MCPMode;
  bundle?: string;
  pid?: number;
  scriptName: string;
  sourceCode: string;
  source: ScriptApplyReceipt["source"];
  scriptId?: string;
  signal?: AbortSignal;
}) {
  const result = await withAgentScript(
    {
      deviceId: options.deviceId,
      platform: options.platform,
      mode: options.mode,
      bundle: options.bundle,
      pid: options.pid,
    },
    async (script, context) => {
      const sessionId = randomUUID();
      try {
        const runResult = await script.exports.invoke("script", "evaluate", [
          options.sourceCode,
          options.scriptName,
        ]);
        const extracted = extractScriptApplyAckFromResult(runResult);
        const ack =
          extracted.ack ??
          fallbackScriptApplyAck(options.scriptName, true);
        return {
          targetPid: context.pid,
          sessionId,
          receipt: toScriptApplyReceipt(ack, {
            scriptId: options.scriptId,
            source: options.source,
            targetPid: context.pid,
          }),
        };
      } catch (error) {
        const ack =
          extractScriptApplyAckFromError(error) ??
          fallbackScriptApplyAck(options.scriptName, false, error);
        return {
          targetPid: context.pid,
          sessionId,
          receipt: toScriptApplyReceipt(ack, {
            scriptId: options.scriptId,
            source: options.source,
            targetPid: context.pid,
          }),
        };
      }
    },
    { signal: options.signal },
  );

  const payload = asObject(result, "script apply result");
  const targetPid = Math.floor(asNumber(payload, "targetPid"));
  const sessionId = asString(payload, "sessionId");
  const receiptRaw = asObject(payload.receipt, "script apply result.receipt");
  const receipt: ScriptApplyReceipt = {
    scriptId: asOptionalString(receiptRaw, "scriptId"),
    scriptName: asString(receiptRaw, "scriptName"),
    compiled: asBoolean(receiptRaw, "compiled"),
    loaded: asBoolean(receiptRaw, "loaded"),
    installedHooks: Math.max(0, Math.floor(asNumber(receiptRaw, "installedHooks"))),
    installedHooksSync: Math.max(
      0,
      Math.floor(
        asOptionalNumber(receiptRaw, "installedHooksSync") ??
          asNumber(receiptRaw, "installedHooks"),
      ),
    ),
    failedHooks: Array.isArray(receiptRaw.failedHooks)
      ? receiptRaw.failedHooks
          .filter((item): item is string => typeof item === "string")
          .slice(0, 100)
      : [],
    hitCount: Math.max(0, Math.floor(asOptionalNumber(receiptRaw, "hitCount") ?? 0)),
    firstHitAt: asOptionalString(receiptRaw, "firstHitAt"),
    lastHitAt: asOptionalString(receiptRaw, "lastHitAt"),
    targetPid: Math.floor(asNumber(receiptRaw, "targetPid")),
    source:
      asString(receiptRaw, "source") === "preset" ? "preset" : "manual",
    error: asOptionalString(receiptRaw, "error"),
    startedAt: asOptionalString(receiptRaw, "startedAt"),
    finishedAt: asOptionalString(receiptRaw, "finishedAt"),
    durationMs: asOptionalNumber(receiptRaw, "durationMs"),
  };
  appendScriptApplyEvidence(options.deviceId, options.identifier, receipt, {
    sessionId,
  });
  if (options.mode === "app" && options.bundle) {
    const timeline = getLaunchTimeline({
      deviceId: options.deviceId,
      bundle: options.bundle,
    });
    if (timeline) {
      pushLaunchTimelineEvent(timeline, {
        stage: "inject",
        pid: targetPid,
        detail: `${receipt.scriptName} installedHooksSync=${receipt.installedHooksSync} hitCount=${receipt.hitCount}`,
        error: receipt.error,
      });
    }
  }
  return {
    targetPid,
    sessionId,
    receipt,
  } as {
    targetPid: number;
    sessionId: string;
    receipt: ScriptApplyReceipt;
  };
}

function buildPlatformCapabilities(
  platform?: MCPPlatform,
  options: {
    includeTargeted?: boolean;
  } = {},
) {
  const includeTargeted = options.includeTargeted === true;
  const selectedPlatforms = platform ? [platform] : (["droid", "fruity"] as const);
  const hookPacks = listHookPacks(platform ?? "any", {
    includeTargeted,
  });
  const scriptTemplates = listBuiltinHookScriptTemplates(platform ?? "any").filter(
    (template) => includeTargeted || template.identifiers.length === 0,
  );
  const rulesets = listRuleSets();
  const scenarioTemplates = listScenarioTemplates();

  return {
    genericFirst: true,
    includeTargeted,
    platforms: selectedPlatforms,
    transport: {
      protocol: "mcp-jsonrpc",
      asyncPattern: "start->runId->poll->cancel",
      envelope: {
        fields: ["status", "ok", "code", "message", "data", "artifacts"],
      },
    },
    automation: {
      deviceActions: [
        "launch_app",
        "resume_app",
        "stop_app",
        "tap",
        "input_text",
        "swipe",
        "back",
        "home",
        "wait_for",
      ],
      uiSemanticActions: [
        "snapshot_ui",
        "find_element",
        "tap_element",
        "input_element",
        "assert_element",
      ],
      sessionResilience: [
        "get_session_state",
        "recover_session",
        "acquire_device_lock",
        "release_device_lock",
      ],
    },
    hooks: {
      scriptTemplates: scriptTemplates.map((item) => ({
        id: item.id,
        name: item.name,
        platform: item.platform,
        targeted: item.identifiers.length > 0,
        targetIdentifiers: item.identifiers,
      })),
      hookPacks: hookPacks.map((item) => ({
        id: item.id,
        name: item.name,
        platform: item.platform,
        builtin: item.builtin,
        scope: item.scope,
        targeted: item.targetIdentifiers.length > 0,
        targetIdentifiers: item.targetIdentifiers,
      })),
    },
    detection: {
      rulesets: rulesets.map((item) => ({
        id: item.id,
        name: item.name,
        severity: item.severity,
      })),
      historyKinds: ["hooks", "crypto", "nsurl", "flutter", "jni", "xpc", "privacy", "hermes"],
      logs: ["syslog", "agent"],
      scriptApplyEvidence: true,
      scriptValidation: true,
      hookStats: true,
    },
    scenarioDsl: {
      templates: scenarioTemplates.map((item) => ({
        id: item.id,
        name: item.name,
        regression: item.tags.includes("regression"),
      })),
      baselineRegressionTemplates: scenarioTemplates
        .filter((item) => item.tags.includes("regression"))
        .map((item) => item.id),
      stepTypes: ["note", "sleep", "clear_history", "clear_logs", "agent_rpc", "assert"],
      assertionTypes: [
        "history_count",
        "history_contains",
        "log_contains",
        "saved_value",
        "script_applied",
      ],
    },
  };
}

function getSessionState(deviceId: string, bundle?: string) {
  const state = sessionRuntime.get(sessionKey(deviceId, bundle));
  if (state) return state;
  return {
    deviceId,
    bundle,
    status: "idle" as const,
    version: 0,
    updatedAt: new Date().toISOString(),
  };
}

function transitionSessionState(
  deviceId: string,
  patch: {
    status: SessionRuntimeState["status"];
    platform?: MCPPlatform;
    mode?: MCPMode;
    bundle?: string;
    pid?: number;
    lastError?: string;
    updatedAt?: string;
  },
  options: {
    expectedState?: SessionRuntimeState["status"];
    expectedVersion?: number;
    reason?: string;
  } = {},
) {
  const key = sessionKey(deviceId, patch.bundle);
  const current = getSessionState(deviceId, patch.bundle);
  const currentStatus = current.status;
  const currentVersion = current.version;
  const nextStatus = patch.status;

  if (
    typeof options.expectedState !== "undefined" &&
    currentStatus !== options.expectedState
  ) {
    throw new ToolExecutionError(
      `session state conflict: expected ${options.expectedState}, got ${currentStatus}`,
      "STATE_CONFLICT",
      {
        expectedState: options.expectedState,
        actualState: currentStatus,
        bundle: patch.bundle ?? null,
        currentVersion,
      },
    );
  }
  if (
    typeof options.expectedVersion === "number" &&
    currentVersion !== options.expectedVersion
  ) {
    throw new ToolExecutionError(
      `session version conflict: expected ${options.expectedVersion}, got ${currentVersion}`,
      "STATE_CONFLICT",
      {
        expectedVersion: options.expectedVersion,
        actualVersion: currentVersion,
        bundle: patch.bundle ?? null,
        currentStatus,
      },
    );
  }

  const allowed = SESSION_TRANSITIONS[currentStatus];
  if (!allowed.includes(nextStatus)) {
    throw new ToolExecutionError(
      `invalid session transition: ${currentStatus} -> ${nextStatus}`,
      "STATE_CONFLICT",
      {
        from: currentStatus,
        to: nextStatus,
        bundle: patch.bundle ?? null,
        currentVersion,
      },
    );
  }

  const next: SessionRuntimeState = {
    deviceId,
    status: nextStatus,
    platform: patch.platform ?? current.platform,
    mode: patch.mode ?? current.mode,
    bundle: patch.bundle ?? current.bundle,
    pid: patch.pid ?? current.pid,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
    version: currentVersion + 1,
    lastError: patch.lastError,
    lastTransitionReason: options.reason,
  };
  sessionRuntime.set(key, next);

  if (next.bundle) {
    const timeline = getLaunchTimeline({
      deviceId,
      bundle: next.bundle,
    });
    if (timeline) {
      pushLaunchTimelineEvent(timeline, {
        stage: `session:${next.status}`,
        pid: next.pid,
        detail: options.reason ?? `transition ${currentStatus}->${next.status}`,
        session: {
          status: next.status,
          version: next.version,
          reason: options.reason,
        },
      });
    }
  }
  return next;
}

function cleanupExpiredDeviceLocks() {
  const now = Date.now();
  for (const [deviceId, lock] of deviceLeaseLocks.entries()) {
    if (lock.expiresAt <= now) {
      deviceLeaseLocks.delete(deviceId);
    }
  }
}

function isDeviceLockBypassTool(toolName: string) {
  return (
    toolName === "acquire_device_lock" ||
    toolName === "release_device_lock" ||
    toolName === "get_session_state" ||
    toolName === "recover_session" ||
    toolName === "list_devices" ||
    toolName === "launch_timeline"
  );
}

function assertDeviceLockAccess(
  toolName: string,
  args: Record<string, unknown>,
) {
  if (isDeviceLockBypassTool(toolName)) return;
  const deviceId = typeof args.deviceId === "string" ? args.deviceId : null;
  if (!deviceId) return;

  cleanupExpiredDeviceLocks();
  const lock = deviceLeaseLocks.get(deviceId);
  if (!lock) return;

  const owner =
    typeof args.lockOwner === "string" && args.lockOwner.length > 0
      ? args.lockOwner
      : "";
  if (owner !== lock.owner) {
    throw new Error(
      `device ${deviceId} is locked by owner "${lock.owner}". provide lockOwner to continue`,
    );
  }
}

function parseAndroidBounds(bounds: string) {
  const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return [0, 0, 0, 0] as [number, number, number, number];
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
  ] as [number, number, number, number];
}

function parseAndroidNodeLine(line: string): AndroidUINode | null {
  if (!line.includes("<node ")) return null;
  const attrs = new Map<string, string>();
  for (const match of line.matchAll(/([\w-]+)="([^"]*)"/g)) {
    attrs.set(match[1]!, match[2] ?? "");
  }

  const bounds = parseAndroidBounds(attrs.get("bounds") ?? "");
  const center = {
    x: Math.floor((bounds[0] + bounds[2]) / 2),
    y: Math.floor((bounds[1] + bounds[3]) / 2),
  };
  return {
    index: Number(attrs.get("index") ?? 0),
    text: attrs.get("text") ?? "",
    resourceId: attrs.get("resource-id") ?? "",
    className: attrs.get("class") ?? "",
    packageName: attrs.get("package") ?? "",
    contentDesc: attrs.get("content-desc") ?? "",
    clickable: attrs.get("clickable") === "true",
    enabled: attrs.get("enabled") !== "false",
    bounds,
    center,
  };
}

async function captureAndroidUISnapshot(
  deviceId: string,
  options: { signal?: AbortSignal } = {},
): Promise<UISnapshot> {
  await runAdbShell(deviceId, ["uiautomator", "dump", "/sdcard/igf-ui.xml"], options);
  const serial = adbSerial(deviceId);
  const { stdout } = await runCommand("adb", [
    "-s",
    serial,
    "shell",
    "cat",
    "/sdcard/igf-ui.xml",
  ], 15_000, options);

  const nodes = stdout
    .split("\n")
    .map((line) => parseAndroidNodeLine(line))
    .filter((item): item is AndroidUINode => item !== null);

  return {
    platform: "droid",
    capturedAt: new Date().toISOString(),
    nodes,
  };
}

function flattenIOSNodes(
  node: unknown,
  path = "0",
  result: IOSUINode[] = [],
): IOSUINode[] {
  if (!isRecord(node)) return result;
  const description = typeof node.description === "string" ? node.description : "";
  const className = typeof node.clazz === "string" ? node.clazz : "";
  const frameRaw = Array.isArray(node.frame) ? node.frame : null;

  let frame: [number, number, number, number] | null = null;
  let center: { x: number; y: number } | null = null;
  if (
    frameRaw &&
    Array.isArray(frameRaw[0]) &&
    Array.isArray(frameRaw[1]) &&
    frameRaw[0].length >= 2 &&
    frameRaw[1].length >= 2
  ) {
    const x = Number(frameRaw[0][0] ?? 0);
    const y = Number(frameRaw[0][1] ?? 0);
    const w = Number(frameRaw[1][0] ?? 0);
    const h = Number(frameRaw[1][1] ?? 0);
    frame = [x, y, w, h];
    center = { x: Math.floor(x + w / 2), y: Math.floor(y + h / 2) };
  }

  result.push({
    path,
    className,
    description,
    frame,
    center,
  });

  const children = Array.isArray(node.children) ? node.children : [];
  for (let i = 0; i < children.length; i++) {
    flattenIOSNodes(children[i], `${path}.${i}`, result);
  }
  return result;
}

async function captureIOSUISnapshot(
  deviceId: string,
  bundle?: string,
  options: { signal?: AbortSignal } = {},
): Promise<UISnapshot> {
  throwIfAborted(options.signal);
  if (!bundle) {
    throw new Error('"bundle" is required for iOS UI snapshot');
  }
  const tree = await withAgentScript(
    {
      deviceId,
      platform: "fruity",
      mode: "app",
      bundle,
    },
    async (script) => await script.exports.invoke("ui", "dump", []),
    options,
  );
  const nodes = flattenIOSNodes(tree);
  return {
    platform: "fruity",
    capturedAt: new Date().toISOString(),
    nodes,
    tree,
  };
}

async function captureUISnapshot(
  deviceId: string,
  bundle?: string,
  forcedPlatform?: MCPPlatform,
  options: { signal?: AbortSignal } = {},
): Promise<UISnapshot> {
  throwIfAborted(options.signal);
  const platform = forcedPlatform ?? (await detectDevicePlatform(deviceId));
  return platform === "droid"
    ? await captureAndroidUISnapshot(deviceId, options)
    : await captureIOSUISnapshot(deviceId, bundle, options);
}

function matchNodeText(source: string, query: string, exact = false) {
  const s = source.toLowerCase();
  const q = query.toLowerCase();
  return exact ? s === q : s.includes(q);
}

function findElementInSnapshot(
  snapshot: UISnapshot,
  query: Record<string, unknown>,
) {
  const text = typeof query.text === "string" ? query.text.trim() : "";
  const resourceId =
    typeof query.resourceId === "string" ? query.resourceId.trim() : "";
  const className =
    typeof query.className === "string" ? query.className.trim() : "";
  const exact = query.exact === true;

  if (snapshot.platform === "droid") {
    const candidates = snapshot.nodes.filter((node) => {
      if (text && !matchNodeText(`${node.text} ${node.contentDesc}`, text, exact)) {
        return false;
      }
      if (resourceId && node.resourceId !== resourceId) return false;
      if (className && node.className !== className) return false;
      return true;
    });
    return candidates.at(0) ?? null;
  }

  const candidates = snapshot.nodes.filter((node) => {
    if (text && !matchNodeText(node.description, text, exact)) return false;
    if (className && node.className !== className) return false;
    return true;
  });
  return candidates.at(0) ?? null;
}

function summarizeFindingRisk(records: Array<{ risk: FindingRisk }>) {
  const summary = { high: 0, medium: 0, low: 0 };
  for (const finding of records) {
    summary[finding.risk] += 1;
  }
  return summary;
}

function securityKeywordRegex() {
  return /(token|secret|password|passwd|auth|bearer|session|apikey|access[_-]?key)/i;
}

function includesSecurityKeyword(input: unknown) {
  const text =
    typeof input === "string"
      ? input
      : (() => {
          try {
            return JSON.stringify(input);
          } catch {
            return String(input);
          }
        })();
  return securityKeywordRegex().test(text);
}

function evaluateRulesForTarget(
  deviceId: string,
  identifier: string,
  rulesetIds: string[],
) {
  const findings: Array<{
    rulesetId: string;
    risk: FindingRisk;
    title: string;
    reason: string;
    recommendation: string;
    evidence: Array<{ kind: string; ref: string }>;
    status: "open";
  }> = [];

  if (rulesetIds.includes("builtin-secret-in-crypto")) {
    const cryptoLogs = new CryptoStore(deviceId, identifier).query({ limit: 300 }, 300);
    for (const log of cryptoLogs) {
      const extra = log.extra ? JSON.parse(log.extra) : null;
      if (includesSecurityKeyword(log.line) || includesSecurityKeyword(extra)) {
        findings.push({
          rulesetId: "builtin-secret-in-crypto",
          risk: "high",
          title: "Sensitive keyword found in crypto trace",
          reason: log.line ?? "crypto log contains sensitive keyword pattern",
          recommendation:
            "Avoid exposing plaintext secrets in crypto call paths or logs.",
          evidence: [{ kind: "crypto", ref: `${log.symbol}#${log.id}` }],
          status: "open",
        });
      }
      if (findings.length >= 50) break;
    }
  }

  if (rulesetIds.includes("builtin-sensitive-sharedpref")) {
    const hooksLogs = new HookStore(deviceId, identifier).query(
      {
        limit: 300,
        filters: { category: "sharedpref" },
      },
      300,
    );
    for (const log of hooksLogs) {
      const extra = log.extra ? JSON.parse(log.extra) : null;
      if (includesSecurityKeyword(log.line) || includesSecurityKeyword(extra)) {
        findings.push({
          rulesetId: "builtin-sensitive-sharedpref",
          risk: "medium",
          title: "Potential sensitive preference access",
          reason: log.line ?? "shared preference access matched sensitive keyword",
          recommendation:
            "Do not store sensitive values in plaintext SharedPreferences.",
          evidence: [{ kind: "hooks", ref: `${log.symbol}#${log.id}` }],
          status: "open",
        });
      }
      if (findings.length >= 100) break;
    }
  }

  if (rulesetIds.includes("builtin-cleartext-url")) {
    const urlLogs = new NSURLStore(deviceId, identifier).query({ limit: 300, offset: 0 });
    for (const req of urlLogs) {
      if (typeof req.url !== "string") continue;
      if (!req.url.startsWith("http://")) continue;
      findings.push({
        rulesetId: "builtin-cleartext-url",
        risk: "high",
        title: "Cleartext HTTP request detected",
        reason: `cleartext request to ${req.url}`,
        recommendation: "Use HTTPS/TLS for all sensitive API traffic.",
        evidence: [{ kind: "nsurl", ref: `${req.method} ${req.url}` }],
        status: "open",
      });
      if (findings.length >= 150) break;
    }
  }

  return findings;
}

function markdownForTestPlanReport(run: TestPlanRunRecord, findings: ReturnType<typeof listFindings>) {
  const lines: string[] = [];
  lines.push(`# Test Plan Report`);
  lines.push("");
  lines.push(`- Plan: ${run.planName}`);
  lines.push(`- Run ID: ${run.id}`);
  lines.push(`- Status: ${run.status}`);
  lines.push(`- Started: ${run.startedAt ?? "n/a"}`);
  lines.push(`- Ended: ${run.endedAt ?? "n/a"}`);
  lines.push(`- Duration: ${run.durationMs ?? 0} ms`);
  lines.push("");
  lines.push("## Scenario Steps");
  lines.push("");
  for (const step of run.stepResults) {
    lines.push(`- [${step.status}] ${step.scenarioId} (${step.durationMs} ms)`);
    if (step.detail) {
      lines.push(`  - ${step.detail}`);
    }
  }
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  lines.push(
    `- High: ${run.findingsSummary.high}, Medium: ${run.findingsSummary.medium}, Low: ${run.findingsSummary.low}`,
  );
  for (const finding of findings.findings.slice(0, 50)) {
    lines.push(`- [${finding.risk}] ${finding.title}: ${finding.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

function classifyToolErrorCode(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout")) {
    return "TIMEOUT";
  }
  if (
    normalized.includes("state conflict") ||
    normalized.includes("version conflict") ||
    normalized.includes("invalid session transition")
  ) {
    return "STATE_CONFLICT";
  }
  if (
    normalized.includes("aborted") ||
    normalized.includes("canceled") ||
    normalized.includes("cancelled")
  ) {
    return "CANCELED";
  }
  if (normalized.includes("must be") || normalized.includes("required")) {
    return "INVALID_ARGUMENT";
  }
  if (normalized.includes("not found") || normalized.includes("unknown tool")) {
    return "NOT_FOUND";
  }
  if (normalized.includes("unsupported") || normalized.includes("android only")) {
    return "NOT_SUPPORTED";
  }
  return "TOOL_ERROR";
}

function extractToolArtifacts(data: unknown): unknown[] {
  if (!isRecord(data)) return [];
  const artifacts = data.artifacts;
  if (!Array.isArray(artifacts)) return [];
  return artifacts;
}

function toolOk(
  data: unknown,
  message = "ok",
  artifacts: unknown[] = [],
): MCPToolResult {
  return {
    status: "ok",
    ok: true,
    code: "OK",
    message,
    data,
    artifacts,
  };
}

function toolError(message: string, code = "TOOL_ERROR", data: unknown = null): MCPToolResult {
  return {
    status: "error",
    ok: false,
    code,
    message,
    data,
    artifacts: [],
  };
}

function toolText(result: MCPToolResult) {
  return JSON.stringify(result, null, 2);
}

function mapHooks(records: ReturnType<HookStore["query"]>) {
  return records.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    category: r.category,
    symbol: r.symbol,
    direction: r.direction,
    line: r.line,
    extra: r.extra ? JSON.parse(r.extra) : undefined,
    createdAt: r.createdAt,
  }));
}

function mapCrypto(records: ReturnType<CryptoStore["query"]>) {
  return records.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    symbol: r.symbol,
    direction: r.direction,
    line: r.line,
    extra: r.extra ? JSON.parse(r.extra) : undefined,
    backtrace: r.backtrace ? JSON.parse(r.backtrace) : undefined,
    data: r.data ? Buffer.from(r.data).toString("base64") : undefined,
    createdAt: r.createdAt,
  }));
}

function mapJNI(records: ReturnType<JNIStore["query"]>) {
  return records.map((r) => ({
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
  }));
}

function mapFlutter(records: ReturnType<FlutterStore["query"]>) {
  return records.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    type: r.type,
    direction: r.direction,
    channel: r.channel,
    data: r.data ? JSON.parse(r.data) : undefined,
    createdAt: r.createdAt,
  }));
}

function mapXPC(records: ReturnType<XPCStore["query"]>) {
  return records.map((r) => ({
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
  }));
}

function mapPrivacy(records: ReturnType<PrivacyStore["query"]>) {
  return records.map((r) => ({
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
  }));
}

async function readLogTail(logPath: string, tailBytes: number) {
  const stat = await fs.stat(logPath).catch(() => null);
  if (!stat) return "";

  const size = stat.size;
  if (size <= tailBytes) return await fs.readFile(logPath, "utf8");

  const handle = await fs.open(logPath, "r");
  const buf = Buffer.alloc(tailBytes);

  try {
    await handle.read(buf, 0, tailBytes, size - tailBytes);
    const chunk = buf.toString("utf8");
    const idx = chunk.indexOf("\n");
    return idx === -1 ? chunk : chunk.slice(idx + 1);
  } finally {
    await handle.close();
  }
}

async function withAgentScript(
  params: {
    deviceId: string;
    platform: MCPPlatform;
    mode: MCPMode;
    bundle?: string;
    pid?: number;
  },
  handler: (
    script: Awaited<
      ReturnType<typeof import("frida").Session.prototype.createScript>
    >,
    context: {
      pid: number;
    },
  ) => Promise<unknown>,
  options: { signal?: AbortSignal } = {},
) {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= AGENT_SCRIPT_RETRY_LIMIT; attempt++) {
    throwIfAborted(options.signal);
    const device = await resolveDevice(params.deviceId);
    let attachPid: number;
    let session: Awaited<
      ReturnType<typeof import("frida").Device.prototype.attach>
    > | null = null;
    let script: Awaited<
      ReturnType<typeof import("frida").Session.prototype.createScript>
    > | null = null;

    try {
      if (params.mode === "app") {
        if (!params.bundle) throw new Error('"bundle" is required in app mode');

        const apps = await device.enumerateApplications({
          identifiers: [params.bundle],
          scope: frida.Scope.Full,
        });
        const app = apps.at(0);
        if (!app) throw new Error(`Application ${params.bundle} not found on device`);

        const pid =
          app.pid && app.pid > 0
            ? app.pid
            : await waitForRunningAppPid(device, params.bundle, 4000, 200, options);
        if (!pid) {
          throw new Error(
            `Application ${params.bundle} is not running. Launch app before MCP RPC call.`,
          );
        }
        attachPid = pid;
      } else {
        if (!params.pid || !Number.isFinite(params.pid)) {
          throw new Error('"pid" is required in daemon mode');
        }
        attachPid = params.pid;
      }

      session = await device.attach(attachPid);
      script = await session.createScript(await agent(params.platform));
      await script.load();
      return await handler(script, { pid: attachPid });
    } catch (error) {
      lastError = error;

      if (
        attempt < AGENT_SCRIPT_RETRY_LIMIT &&
        isRetryableError(error)
      ) {
        await waitMs(AGENT_SCRIPT_RETRY_DELAY_MS * attempt, options.signal);
        continue;
      }
      throw error;
    } finally {
      await script?.unload().catch(() => {});
      await session?.detach().catch(() => {});
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function jsonRpcOk(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcErr(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

function parseBearer(authHeader: string | undefined) {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

function recordAuthFailure(reason: string, guidance: string) {
  mcpLastAuthFailure = {
    reason,
    guidance,
    at: nowIso(),
  };
}

function clearAuthFailure() {
  mcpLastAuthFailure = null;
}

function mcpStatusResponse(url: string) {
  const config = getMCPConfig();
  const origin = new URL(url).origin;
  const endpoint = `${origin}/api/mcp`;
  const tokenEnvVar = "GRAPEFRUIT_MCP_TOKEN";
  const authHeaderValue = `Bearer ${config.token}`;

  return {
    enabled: config.enabled,
    showTargetedCapabilities: config.showTargetedCapabilities,
    endpoint,
    token: config.token,
    tokenExpiresAt: null,
    tokenEnvVar,
    toolCount: TOOL_SPECS.length,
    protocolVersion: "2024-11-05",
    serverName: "grapefruit-mcp",
    authFailedReason: mcpLastAuthFailure?.reason ?? null,
    authFailedAt: mcpLastAuthFailure?.at ?? null,
    authRefreshGuidance:
      mcpLastAuthFailure?.guidance ??
      `If auth fails, rotate token and update Authorization header to ${authHeaderValue}`,
    codexAddCommand:
      `codex mcp add grapefruit --url ${endpoint} ` +
      `--bearer-token-env-var ${tokenEnvVar}`,
    claudeConfigSnippet: {
      mcpServers: {
        grapefruit: {
          type: "http",
          url: endpoint,
          headers: {
            Authorization: authHeaderValue,
          },
        },
      },
    },
    antigravityConfigSnippet: {
      mcpServers: {
        grapefruit: {
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            endpoint,
            "--header",
            "Authorization: Bearer ${GRAPEFRUIT_MCP_TOKEN}",
          ],
          env: {
            GRAPEFRUIT_MCP_TOKEN: config.token,
          },
        },
      },
    },
    configSnippet: {
      mcpServers: {
        grapefruit: {
          type: "http",
          // Keep "transport" for older clients that still read this key.
          transport: "http",
          url: endpoint,
          headers: {
            Authorization: authHeaderValue,
          },
        },
      },
    },
  };
}

async function executeTestPlanWorker(options: {
  deviceId: string;
  identifier: string;
  runId: string;
  plan: {
    id: string;
    name: string;
    scenarioIds: string[];
    rulesetIds: string[];
    target?: {
      platform?: "fruity" | "droid";
      mode?: "app" | "daemon";
      bundle?: string;
      pid?: number;
    };
    stopOnFailure: boolean;
  };
}) {
  const runStore = createTestPlanRunStore(options.deviceId, options.identifier);
  const scenarioStore = createScenarioStore(options.deviceId, options.identifier);
  const scenarioRunStore = createScenarioRunStore(options.deviceId, options.identifier);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  runStore.update(options.runId, {
    status: "running",
    startedAt,
    error: undefined,
  });

  const stepResults: TestPlanRunRecord["stepResults"] = [];
  let stopEarly = false;

  for (const scenarioId of options.plan.scenarioIds) {
    if (testPlanCancelTokens.has(options.runId)) {
      stopEarly = true;
      stepResults.push({
        id: randomUUID(),
        scenarioId,
        status: "canceled",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 0,
        detail: "canceled by user",
      });
      break;
    }

    const scenario = scenarioStore.get(scenarioId);
    if (!scenario) {
      stepResults.push({
        id: randomUUID(),
        scenarioId,
        status: "error",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 0,
        detail: "scenario not found",
      });
      if (options.plan.stopOnFailure) {
        stopEarly = true;
        break;
      }
      continue;
    }

    const baseStart = Date.now();
    const baseStartedAt = new Date().toISOString();
    try {
      const run = await runScenario({
        deviceId: options.deviceId,
        identifier: options.identifier,
        scenario,
        target: options.plan.target ?? {},
        stopOnFailure: options.plan.stopOnFailure,
      });
      scenarioRunStore.append(run);
      stepResults.push({
        id: randomUUID(),
        scenarioId,
        status: run.status === "passed" ? "passed" : "failed",
        startedAt: baseStartedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - baseStart,
        scenarioRunId: run.id,
        detail: run.status,
      });
      if (run.status !== "passed" && options.plan.stopOnFailure) {
        stopEarly = true;
        break;
      }
    } catch (error) {
      stepResults.push({
        id: randomUUID(),
        scenarioId,
        status: "error",
        startedAt: baseStartedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - baseStart,
        detail: error instanceof Error ? error.message : String(error),
      });
      if (options.plan.stopOnFailure) {
        stopEarly = true;
        break;
      }
    }
  }

  const evaluatedRuleSetIds =
    options.plan.rulesetIds.length > 0
      ? options.plan.rulesetIds
      : getEnabledRuleSets(options.deviceId, options.identifier);
  const evaluatedFindings = evaluateRulesForTarget(
    options.deviceId,
    options.identifier,
    evaluatedRuleSetIds,
  );
  const persistedFindings = appendFindings(
    options.deviceId,
    options.identifier,
    evaluatedFindings,
  );
  const findingsSummary = summarizeFindingRisk(
    persistedFindings.map((item) => ({ risk: item.risk })),
  );

  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - startedMs;
  const hasError = stepResults.some((step) => step.status === "error");
  const hasFailed = stepResults.some((step) => step.status === "failed");
  const status: TestPlanRunStatus = stopEarly && testPlanCancelTokens.has(options.runId)
    ? "canceled"
    : hasError
      ? "error"
      : hasFailed
        ? "failed"
        : "passed";

  const payloadArtifact = await createArtifact(options.deviceId, options.identifier, {
    type: "test-plan-run-json",
    name: `test-plan-run-${options.runId}`,
    mime: "application/json",
    content: JSON.stringify(
      {
        runId: options.runId,
        status,
        stepResults,
        findingsSummary,
      },
      null,
      2,
    ),
    meta: {
      runId: options.runId,
      planId: options.plan.id,
    },
  });

  const findings = listFindings(options.deviceId, options.identifier, { limit: 200 });
  const reportArtifact = await createArtifact(options.deviceId, options.identifier, {
    type: "test-plan-report-md",
    name: `test-plan-report-${options.runId}`,
    mime: "text/markdown",
    content: markdownForTestPlanReport(
      {
        id: options.runId,
        planId: options.plan.id,
        planName: options.plan.name,
        deviceId: options.deviceId,
        identifier: options.identifier,
        status,
        createdAt: startedAt,
        startedAt,
        endedAt,
        durationMs,
        stepResults,
        artifacts: [],
        findingsSummary,
      },
      findings,
    ),
    meta: {
      runId: options.runId,
      planId: options.plan.id,
    },
  });

  runStore.update(options.runId, {
    status,
    endedAt,
    durationMs,
    stepResults,
    findingsSummary,
    artifacts: [payloadArtifact.id, reportArtifact.id],
  });
}

async function callTool(
  name: string,
  rawArgs: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<unknown> {
  throwIfAborted(options.signal);
  const args = asObject(rawArgs ?? {});

  switch (name) {
    case "list_devices": {
      const skip = new Set(["local", "socket", "barebone"]);
      const devices = await frida.enumerateDevices();
      return devices.filter((dev) => !skip.has(dev.id)).map(serializeDevice);
    }

    case "add_remote_device": {
      const host = normalizeRemoteHost(asString(args, "host"));
      await manager.addRemoteDevice(host);
      return { ok: true, host };
    }

    case "remove_remote_device": {
      const host = asString(args, "host");
      const dev = await findRemoteDevice(host);
      if (!dev) throw new Error("remote device not found");

      const normalizedHost = normalizeRemoteHost(host);
      await manager.removeRemoteDevice(normalizedHost);
      return { ok: true, host: normalizedHost };
    }

    case "list_apps": {
      const deviceId = asString(args, "deviceId");
      const device = await resolveDevice(deviceId);
      const apps = await device.enumerateApplications();

      const dedup = new Map<string, ReturnType<typeof serializeApp>>();
      for (const app of apps) {
        const next = serializeApp(app);
        const current = dedup.get(next.identifier);
        if (!current) {
          dedup.set(next.identifier, next);
          continue;
        }
        if (current.pid === 0 && next.pid !== 0) {
          dedup.set(next.identifier, next);
        }
      }
      return Array.from(dedup.values());
    }

    case "list_processes": {
      const deviceId = asString(args, "deviceId");
      const device = await resolveDevice(deviceId);
      const processes = await device.enumerateProcesses({
        scope: frida.Scope.Metadata,
      });
      return processes
        .filter((proc) => proc.pid !== 1 && proc.name !== "launchd")
        .map(serializeProcess);
    }

    case "get_device_info": {
      const deviceId = asString(args, "deviceId");
      const device = await resolveDevice(deviceId);
      return await device.querySystemParameters();
    }

    case "launch_app": {
      const deviceId = asString(args, "deviceId");
      const bundle = asString(args, "bundle");
      const restart = asOptionalBoolean(args, "restart") === true;
      const suspended = asOptionalBoolean(args, "suspended") === true;
      const wait = Math.max(0, Math.floor(asOptionalNumber(args, "waitMs") ?? 0));
      withSessionCAS(deviceId, bundle, args);

      const platform = await detectDevicePlatform(deviceId);
      const device = await resolveDevice(deviceId);

      const apps = await device.enumerateApplications({
        identifiers: [bundle],
        scope: frida.Scope.Full,
      });
      if (apps.length === 0) {
        throw new Error(`Application ${bundle} not found on device`);
      }

      const runningPid = await getRunningAppPid(device, bundle, options);
      const timeline = createLaunchTimeline({
        deviceId,
        bundle,
        platform,
        restart,
        suspended,
        wasRunning: !!runningPid,
      });
      pushLaunchTimelineEvent(timeline, {
        stage: "precheck",
        pid: runningPid ?? undefined,
        detail: runningPid
          ? `existing pid ${runningPid}`
          : "no running process",
      });

      if (runningPid && restart) {
        pushLaunchTimelineEvent(timeline, {
          stage: "kill",
          pid: runningPid,
          detail: "restart requested, stopping existing process",
        });
        await device.kill(runningPid).catch(() => {});
        await waitMs(200, options.signal);
      }

      let pid = runningPid;
      let spawned = false;
      if (!pid || restart) {
        pushLaunchTimelineEvent(timeline, {
          stage: "spawn:start",
        });
        try {
          pid = await device.spawn(bundle);
          spawned = true;
          pushLaunchTimelineEvent(timeline, {
            stage: "spawn:ok",
            pid,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          pushLaunchTimelineEvent(timeline, {
            stage: "spawn:error",
            error: message,
          });
          if (!message.includes("Spawn already in progress")) {
            finishLaunchTimeline(timeline, { status: "failed", pid: pid ?? null });
            throw error;
          }
          const existingPid = await waitForRunningAppPid(device, bundle, 3000, 200, options);
          if (!existingPid) throw error;
          pid = existingPid;
          pushLaunchTimelineEvent(timeline, {
            stage: "spawn:reuse_existing",
            pid,
          });
        }
      }

      if (spawned && pid && !suspended) {
        pushLaunchTimelineEvent(timeline, {
          stage: "resume:start",
          pid,
        });
        await device.resume(pid).catch((error) => {
          pushLaunchTimelineEvent(timeline, {
            stage: "resume:error",
            pid,
            error: normalizeErrorString(error),
          });
        });
        pushLaunchTimelineEvent(timeline, {
          stage: "resume:ok",
          pid,
        });
      }
      if (spawned && pid && suspended) {
        pushLaunchTimelineEvent(timeline, {
          stage: "resume:deferred",
          pid,
          detail: "spawned in suspended mode",
        });
      }

      if (wait > 0) {
        pushLaunchTimelineEvent(timeline, {
          stage: "wait",
          detail: `wait ${wait}ms`,
        });
        await waitMs(wait, options.signal);
      }

      const attachedPid =
        spawned && suspended
          ? pid
          : await waitForRunningAppPid(device, bundle, 3000, 200, options);
      finishLaunchTimeline(timeline, {
        status: "launched",
        pid: attachedPid ?? pid ?? null,
      });
      return {
        deviceId,
        bundle,
        platform,
        pid: attachedPid ?? pid ?? null,
        spawned,
        suspended,
        pendingResume: spawned && suspended,
        restart,
        wasRunning: !!runningPid,
        launchTimeline: timeline,
      };
    }

    case "resume_app": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      const pidRaw = asOptionalNumber(args, "pid");
      const pid = typeof pidRaw === "number" ? Math.floor(pidRaw) : undefined;
      if (typeof pid === "number" && pid <= 0) {
        throw new Error('"pid" must be a positive number');
      }
      if (!bundle && typeof pid !== "number") {
        throw new Error('"bundle" or "pid" is required');
      }
      withSessionCAS(deviceId, bundle, args);

      const device = await resolveDevice(deviceId);
      const targetPid =
        typeof pid === "number"
          ? pid
          : await getRunningAppPid(device, bundle!, options);
      if (!targetPid) {
        throw new Error("process not found for resume");
      }
      await device.resume(targetPid);
      const timeline =
        bundle ? getLaunchTimeline({ deviceId, bundle }) : null;
      if (timeline) {
        pushLaunchTimelineEvent(timeline, {
          stage: "resume:manual",
          pid: targetPid,
          detail: "resume_app tool invoked",
        });
      }
      return {
        deviceId,
        bundle: bundle ?? null,
        pid: targetPid,
        resumed: true,
        launchTimeline: timeline,
      };
    }

    case "stop_app": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      const pidRaw = asOptionalNumber(args, "pid");
      const pid = typeof pidRaw === "number" ? Math.floor(pidRaw) : undefined;
      if (typeof pid === "number" && pid <= 0) {
        throw new Error('"pid" must be a positive number');
      }
      if (!bundle && typeof pid !== "number") {
        throw new Error('"bundle" or "pid" is required');
      }
      withSessionCAS(deviceId, bundle, args);

      const device = await resolveDevice(deviceId);
      const targetPid =
        typeof pid === "number"
          ? pid
          : await getRunningAppPid(device, bundle!, options);

      if (!targetPid) {
        return {
          deviceId,
          bundle: bundle ?? null,
          pid: null,
          stopped: false,
          reason: "process not running",
        };
      }

      await device.kill(targetPid);
      const timeline =
        bundle ? getLaunchTimeline({ deviceId, bundle }) : null;
      if (timeline) {
        pushLaunchTimelineEvent(timeline, {
          stage: "exit",
          pid: targetPid,
          detail: "process stopped by stop_app",
        });
      }
      return {
        deviceId,
        bundle: bundle ?? null,
        pid: targetPid,
        stopped: true,
      };
    }

    case "tap": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      withSessionCAS(deviceId, bundle, args);
      const x = Math.floor(asNumber(args, "x"));
      const y = Math.floor(asNumber(args, "y"));
      const platform = await detectDevicePlatform(deviceId);

      if (platform === "droid") {
        const result = await runAdbShell(deviceId, [
          "input",
          "tap",
          `${x}`,
          `${y}`,
        ], options);
        return { deviceId, action: "tap", platform, x, y, ...result };
      }

      const result = await invokeFruityAutomation(
        deviceId,
        bundle,
        "tap",
        [x, y],
        options,
      );
      return { deviceId, action: "tap", platform, bundle: bundle ?? null, x, y, result };
    }

    case "input_text": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      withSessionCAS(deviceId, bundle, args);
      const text = asString(args, "text");
      const platform = await detectDevicePlatform(deviceId);

      if (platform === "droid") {
        const encoded = encodeAdbInputText(text);
        const result = await runAdbShell(deviceId, ["input", "text", encoded], options);
        return { deviceId, action: "input_text", platform, text, ...result };
      }

      const result = await invokeFruityAutomation(
        deviceId,
        bundle,
        "inputText",
        [text],
        options,
      );
      return {
        deviceId,
        action: "input_text",
        platform,
        bundle: bundle ?? null,
        text,
        result,
      };
    }

    case "swipe": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      withSessionCAS(deviceId, bundle, args);
      const x1 = Math.floor(asNumber(args, "x1"));
      const y1 = Math.floor(asNumber(args, "y1"));
      const x2 = Math.floor(asNumber(args, "x2"));
      const y2 = Math.floor(asNumber(args, "y2"));
      const durationMs = Math.max(
        0,
        Math.floor(asOptionalNumber(args, "durationMs") ?? 300),
      );
      const platform = await detectDevicePlatform(deviceId);

      if (platform === "droid") {
        const result = await runAdbShell(deviceId, [
          "input",
          "swipe",
          `${x1}`,
          `${y1}`,
          `${x2}`,
          `${y2}`,
          `${durationMs}`,
        ], options);
        return {
          deviceId,
          action: "swipe",
          platform,
          x1,
          y1,
          x2,
          y2,
          durationMs,
          ...result,
        };
      }

      const result = await invokeFruityAutomation(
        deviceId,
        bundle,
        "swipe",
        [x1, y1, x2, y2],
        options,
      );
      return {
        deviceId,
        action: "swipe",
        platform,
        bundle: bundle ?? null,
        x1,
        y1,
        x2,
        y2,
        durationMs,
        result,
      };
    }

    case "back": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      withSessionCAS(deviceId, bundle, args);
      const platform = await detectDevicePlatform(deviceId);

      if (platform === "droid") {
        const result = await runAdbShell(deviceId, ["input", "keyevent", "4"], options);
        return { deviceId, action: "back", platform, ...result };
      }

      const result = await invokeFruityAutomation(deviceId, bundle, "back", [], options);
      return { deviceId, action: "back", platform, bundle: bundle ?? null, result };
    }

    case "home": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      withSessionCAS(deviceId, bundle, args);
      const platform = await detectDevicePlatform(deviceId);

      if (platform === "droid") {
        const result = await runAdbShell(deviceId, ["input", "keyevent", "3"], options);
        return { deviceId, action: "home", platform, ...result };
      }

      const result = await invokeFruityAutomation(deviceId, bundle, "home", [], options);
      return { deviceId, action: "home", platform, bundle: bundle ?? null, result };
    }

    case "wait_for": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      withSessionCAS(deviceId, bundle, args);
      const ms = asOptionalNumber(args, "ms");
      if (typeof ms === "number") {
        const sleepFor = Math.max(0, Math.floor(ms));
        await waitMs(sleepFor, options.signal);
        return { deviceId, mode: "sleep", waitedMs: sleepFor };
      }
      if (!bundle) {
        throw new Error('"bundle" is required when "ms" is not provided');
      }

      const state = (asOptionalString(args, "state") ?? "running").toLowerCase();
      if (state !== "running" && state !== "stopped") {
        throw new Error('"state" must be "running" or "stopped"');
      }

      const timeoutMs = Math.max(
        0,
        Math.floor(asOptionalNumber(args, "timeoutMs") ?? 10_000),
      );
      const intervalMs = Math.max(
        50,
        Math.floor(asOptionalNumber(args, "intervalMs") ?? 200),
      );
      const device = await resolveDevice(deviceId);
      const started = Date.now();

      while (Date.now() - started <= timeoutMs) {
        throwIfAborted(options.signal);
        const pid = await getRunningAppPid(device, bundle, options);
        const isRunning = typeof pid === "number" && pid > 0;
        const matched =
          (state === "running" && isRunning) ||
          (state === "stopped" && !isRunning);

        if (matched) {
          return {
            deviceId,
            mode: "app_state",
            bundle,
            state,
            pid: pid ?? null,
            elapsedMs: Date.now() - started,
          };
        }
        await waitMs(intervalMs, options.signal);
      }

      throw new Error(
        `wait_for timeout after ${timeoutMs}ms for ${bundle} to become ${state}`,
      );
    }

    case "get_tool_run": {
      const runId = asString(args, "runId");
      const run = getToolRunOrThrow(runId);
      return toToolRunView(run);
    }

    case "cancel_tool_run": {
      const runId = asString(args, "runId");
      return cancelToolRun(runId);
    }

    case "launch_timeline": {
      const timelineId = asOptionalString(args, "timelineId");
      const deviceId = asOptionalString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      if (!timelineId && (!deviceId || !bundle)) {
        throw new Error(
          '"timelineId" or both "deviceId" and "bundle" are required',
        );
      }
      const timeline = getLaunchTimeline({ timelineId, deviceId, bundle });
      if (!timeline) {
        throw new Error("launch timeline not found");
      }
      return timeline;
    }

    case "get_history": {
      const kind = asString(args, "kind").toLowerCase();
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const limit = asOptionalNumber(args, "limit");
      const offset = asOptionalNumber(args, "offset");
      const filter = isRecord(args.filter) ? args.filter : {};

      switch (kind) {
        case "hooks": {
          const store = new HookStore(deviceId, identifier);
          const logs = store.query(
            {
              limit,
              offset,
              filters: {
                category:
                  typeof filter.category === "string" ? filter.category : undefined,
              },
            },
            1000,
          );
          return { logs: mapHooks(logs), total: store.count() };
        }
        case "crypto": {
          const store = new CryptoStore(deviceId, identifier);
          const logs = store.query({ limit, offset }, 1000);
          return { logs: mapCrypto(logs), total: store.count() };
        }
        case "nsurl": {
          const store = new NSURLStore(deviceId, identifier);
          const logs = store.query({ limit, offset });
          return { logs, total: store.count() };
        }
        case "flutter": {
          const store = new FlutterStore(deviceId, identifier);
          const logs = store.query({ limit, offset }, 5000);
          return { logs: mapFlutter(logs), total: store.count() };
        }
        case "jni": {
          const store = new JNIStore(deviceId, identifier);
          const logs = store.query(
            {
              limit,
              offset,
              filters: {
                method: typeof filter.method === "string" ? filter.method : undefined,
              },
            },
            5000,
          );
          return { logs: mapJNI(logs), total: store.count() };
        }
        case "xpc": {
          const store = new XPCStore(deviceId, identifier);
          const logs = store.query(
            {
              limit,
              offset,
              filters: {
                protocol:
                  typeof filter.protocol === "string" ? filter.protocol : undefined,
              },
            },
            5000,
          );
          return { logs: mapXPC(logs), total: store.count() };
        }
        case "privacy": {
          const store = new PrivacyStore(deviceId, identifier);
          const logs = store.query(
            {
              limit,
              offset,
              filters: {
                category:
                  typeof filter.category === "string" ? filter.category : undefined,
                severity:
                  typeof filter.severity === "string" ? filter.severity : undefined,
              },
            },
            1000,
          );
          return { logs: mapPrivacy(logs), total: store.count() };
        }
        case "hermes": {
          const store = new HermesStore(deviceId, identifier);
          const logs = store.query({ limit: limit ?? 100, offset: offset ?? 0 });
          return {
            logs: logs.map((r) => ({
              id: r.id,
              url: r.url,
              hash: r.hash,
              size: r.size,
              createdAt: r.createdAt,
            })),
            total: store.count(),
          };
        }
        default:
          throw new Error(`unsupported history kind: ${kind}`);
      }
    }

    case "get_script_apply_acks": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const scriptName = asOptionalString(args, "scriptName")?.trim();
      const source = asOptionalString(args, "source");
      const sessionId = asOptionalString(args, "sessionId");
      const pid = asOptionalNumber(args, "pid");
      const limitRaw = asOptionalNumber(args, "limit");
      const offsetRaw = asOptionalNumber(args, "offset");

      if (source && source !== "manual" && source !== "startup") {
        throw new Error('"source" must be "manual" or "startup"');
      }

      const offset = Math.max(0, Math.floor(offsetRaw ?? 0));
      const limit = Math.min(1000, Math.max(1, Math.floor(limitRaw ?? 100)));

      const store = new HookStore(deviceId, identifier);
      const all = mapHooks(
        store.query(
          {
            filters: {
              category: "script.apply.ack",
            },
          },
          5000,
        ),
      );
      const hitLogs = mapHooks(
        store.query(
          {
            filters: {
              category: "script.apply.hit",
            },
          },
          20_000,
        ),
      );

      type ScriptApplyHitRecord = {
        timestamp: string;
        hitCount: number;
        firstHitAt?: string;
        lastHitAt?: string;
      };
      const hitsBySessionAndScript = new Map<string, ScriptApplyHitRecord[]>();
      const hitsByScript = new Map<string, ScriptApplyHitRecord[]>();

      for (const hit of hitLogs) {
        const symbol = hit.symbol?.trim();
        if (!symbol) continue;
        const extra = isRecord(hit.extra) ? hit.extra : {};
        const row: ScriptApplyHitRecord = {
          timestamp: hit.timestamp,
          hitCount:
            typeof extra.hitCount === "number" && Number.isFinite(extra.hitCount)
              ? Math.max(1, Math.floor(extra.hitCount))
              : 1,
          firstHitAt: typeof extra.firstHitAt === "string" ? extra.firstHitAt : hit.timestamp,
          lastHitAt: typeof extra.lastHitAt === "string" ? extra.lastHitAt : hit.timestamp,
        };
        const list = hitsByScript.get(symbol) ?? [];
        list.push(row);
        hitsByScript.set(symbol, list);
        if (typeof extra.sessionId === "string" && extra.sessionId.length > 0) {
          const key = `${extra.sessionId}|${symbol}`;
          const sessionList = hitsBySessionAndScript.get(key) ?? [];
          sessionList.push(row);
          hitsBySessionAndScript.set(key, sessionList);
        }
      }

      const filtered = all.filter((record) => {
        const extra = isRecord(record.extra) ? record.extra : {};
        if (scriptName && !record.symbol.includes(scriptName)) return false;
        if (source && extra.source !== source) return false;
        if (sessionId && extra.sessionId !== sessionId) return false;
        if (typeof pid === "number" && extra.pid !== pid) return false;
        return true;
      });

      let success = 0;
      let failed = 0;
      let withHooks = 0;
      let withoutHooks = 0;
      let withHits = 0;
      let withoutHits = 0;

      for (const record of filtered) {
        const extra = isRecord(record.extra) ? record.extra : {};
        const compileOk = extra.compileOk === true;
        const hookedMethods =
          typeof extra.installedHooksSync === "number"
            ? extra.installedHooksSync
            : typeof extra.hookedMethods === "number"
              ? extra.hookedMethods
              : 0;
        const scriptName = record.symbol?.trim();
        const sessionIdValue =
          typeof extra.sessionId === "string" && extra.sessionId.length > 0
            ? extra.sessionId
            : undefined;
        const hitCandidates = sessionIdValue && scriptName
          ? hitsBySessionAndScript.get(`${sessionIdValue}|${scriptName}`) ?? []
          : scriptName
            ? hitsByScript.get(scriptName) ?? []
            : [];
        let hitCount = 0;
        for (const hit of hitCandidates) {
          if (hit.timestamp < record.timestamp) continue;
          hitCount = Math.max(hitCount, hit.hitCount);
        }
        if (hitCount === 0 && typeof extra.hitCount === "number") {
          hitCount = Math.max(0, Math.floor(extra.hitCount));
        }
        if (compileOk) success += 1;
        else failed += 1;
        if (hookedMethods > 0) withHooks += 1;
        else withoutHooks += 1;
        if (hitCount > 0) withHits += 1;
        else withoutHits += 1;
      }

      return {
        logs: filtered.slice(offset, offset + limit).map((record) => {
          const extra = isRecord(record.extra) ? record.extra : {};
          const failedMethods = Array.isArray(extra.failedMethods)
            ? extra.failedMethods.filter(
                (item): item is string => typeof item === "string",
              )
            : [];
          const scriptName = record.symbol?.trim();
          const sessionIdValue =
            typeof extra.sessionId === "string" && extra.sessionId.length > 0
              ? extra.sessionId
              : undefined;
          const hitCandidates = sessionIdValue && scriptName
            ? hitsBySessionAndScript.get(`${sessionIdValue}|${scriptName}`) ?? []
            : scriptName
              ? hitsByScript.get(scriptName) ?? []
              : [];
          let hitCount = 0;
          let firstHitAt: string | undefined;
          let lastHitAt: string | undefined;
          for (const hit of hitCandidates) {
            if (hit.timestamp < record.timestamp) continue;
            hitCount = Math.max(hitCount, hit.hitCount);
            const candidateFirst = hit.firstHitAt ?? hit.timestamp;
            const candidateLast = hit.lastHitAt ?? hit.timestamp;
            if (!firstHitAt || candidateFirst < firstHitAt) {
              firstHitAt = candidateFirst;
            }
            if (!lastHitAt || candidateLast > lastHitAt) {
              lastHitAt = candidateLast;
            }
          }
          if (typeof extra.hitCount === "number") {
            hitCount = Math.max(hitCount, Math.max(0, Math.floor(extra.hitCount)));
          }
          if (!firstHitAt && typeof extra.firstHitAt === "string") {
            firstHitAt = extra.firstHitAt;
          }
          if (!lastHitAt && typeof extra.lastHitAt === "string") {
            lastHitAt = extra.lastHitAt;
          }
          const installedHooksSync =
            typeof extra.installedHooksSync === "number"
              ? extra.installedHooksSync
              : typeof extra.hookedMethods === "number"
                ? extra.hookedMethods
                : 0;
          return {
            id: record.id,
            timestamp: record.timestamp,
            scriptName: record.symbol,
            source: extra.source === "startup" ? "startup" : "manual",
            compileOk: extra.compileOk === true,
            installedHooksSync,
            hookedMethods:
              typeof extra.hookedMethods === "number"
                ? extra.hookedMethods
                : installedHooksSync,
            failedMethods,
            hitCount,
            firstHitAt,
            lastHitAt,
            error:
              typeof extra.error === "string" && extra.error.length > 0
                ? extra.error
                : undefined,
            durationMs:
              typeof extra.durationMs === "number" ? extra.durationMs : undefined,
            startedAt:
              typeof extra.startedAt === "string" ? extra.startedAt : undefined,
            finishedAt:
              typeof extra.finishedAt === "string" ? extra.finishedAt : undefined,
            pid: typeof extra.pid === "number" ? extra.pid : undefined,
            sessionId:
              typeof extra.sessionId === "string" ? extra.sessionId : undefined,
            line: record.line,
            createdAt: record.createdAt,
          };
        }),
        total: filtered.length,
        summary: {
          total: filtered.length,
          success,
          failed,
          withHooks,
          withoutHooks,
          withHits,
          withoutHits,
        },
        offset,
        limit,
      };
    }

    case "clear_history": {
      const kind = asString(args, "kind").toLowerCase();
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");

      switch (kind) {
        case "hooks":
          new HookStore(deviceId, identifier).rm();
          break;
        case "crypto":
          new CryptoStore(deviceId, identifier).rm();
          break;
        case "nsurl":
          new NSURLStore(deviceId, identifier).rm();
          break;
        case "flutter":
          new FlutterStore(deviceId, identifier).rm();
          break;
        case "jni":
          new JNIStore(deviceId, identifier).rm();
          break;
        case "xpc":
          new XPCStore(deviceId, identifier).rm();
          break;
        case "privacy":
          new PrivacyStore(deviceId, identifier).rm();
          break;
        case "hermes":
          new HermesStore(deviceId, identifier).rm();
          break;
        default:
          throw new Error(`unsupported history kind: ${kind}`);
      }
      return { ok: true, kind, deviceId, identifier };
    }

    case "get_logs": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const type = asString(args, "type");
      if (!["syslog", "agent"].includes(type)) {
        throw new Error('"type" must be "syslog" or "agent"');
      }
      const tailBytes = asOptionalNumber(args, "tailBytes") ?? LOG_TAIL_BYTES;
      const filename = `${type}.log`;
      const logPath = nodePath.join(paths.data, "logs", deviceId, identifier, filename);
      return {
        type,
        text: await readLogTail(logPath, Math.max(1024, Math.floor(tailBytes))),
      };
    }

    case "clear_logs": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const logsDir = nodePath.join(paths.data, "logs", deviceId, identifier);
      await fs.rm(logsDir, { recursive: true, force: true });
      return { ok: true, deviceId, identifier };
    }

    case "list_hook_scripts": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      return createHookScriptStore(deviceId, identifier).list();
    }

    case "create_hook_script": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      withSessionCAS(deviceId, identifier, args);
      const name = asString(args, "name");
      const content = asString(args, "content");
      const enabled = asOptionalBoolean(args, "enabled");
      const runOnAppLaunch = asOptionalBoolean(args, "runOnAppLaunch");
      return createHookScriptStore(deviceId, identifier).create({
        name,
        content,
        enabled,
        runOnAppLaunch,
      });
    }

    case "update_hook_script": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      withSessionCAS(deviceId, identifier, args);
      const id = asString(args, "id");
      const name = asOptionalString(args, "name");
      const content = asOptionalString(args, "content");
      const enabled = asOptionalBoolean(args, "enabled");
      const runOnAppLaunch = asOptionalBoolean(args, "runOnAppLaunch");
      const updated = createHookScriptStore(deviceId, identifier).update(id, {
        name,
        content,
        enabled,
        runOnAppLaunch,
      });
      if (!updated) throw new Error(`script not found: ${id}`);
      return updated;
    }

    case "delete_hook_script": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      withSessionCAS(deviceId, identifier, args);
      const id = asString(args, "id");
      const removed = createHookScriptStore(deviceId, identifier).remove(id);
      if (!removed) throw new Error(`script not found: ${id}`);
      return { ok: true, id };
    }

    case "list_hook_script_presets": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      return createHookScriptPresetStore(deviceId, identifier).list();
    }

    case "create_hook_script_preset": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      withSessionCAS(deviceId, identifier, args);
      const name = asString(args, "name");
      const items = asArray(args, "items").map((raw) => {
        const item = asObject(raw, "items[]");
        return {
          scriptId: asString(item, "scriptId"),
          enabled: item.enabled === true,
          runOnAppLaunch: item.runOnAppLaunch === true,
        };
      });
      const autoApplyOnAppLaunch = asOptionalBoolean(args, "autoApplyOnAppLaunch");

      return createHookScriptPresetStore(deviceId, identifier).create({
        name,
        items,
        autoApplyOnAppLaunch,
      });
    }

    case "apply_hook_script_preset": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const presetId = asString(args, "presetId");
      const execute = asOptionalBoolean(args, "execute") !== false;
      const modeRaw = asOptionalString(args, "mode");
      const mode: MCPMode = modeRaw === "daemon" ? "daemon" : "app";
      const bundle = asOptionalString(args, "bundle") ?? identifier;
      const pid = asOptionalNumber(args, "pid");
      const platformRaw = asOptionalString(args, "platform");
      const platform: MCPPlatform =
        platformRaw === "droid" || platformRaw === "fruity"
          ? platformRaw
          : await detectDevicePlatform(deviceId);
      withSessionCAS(deviceId, mode === "app" ? bundle : undefined, args);

      const presetStore = createHookScriptPresetStore(deviceId, identifier);
      const preset = presetStore.get(presetId);
      if (!preset) throw new Error(`preset not found: ${presetId}`);

      const scriptStore = createHookScriptStore(deviceId, identifier);
      const scripts = scriptStore.applyPreset(preset.items);
      const activeScripts = scripts.filter((item) => item.enabled);
      const receipts: ScriptApplyReceipt[] = [];

      if (execute && activeScripts.length > 0) {
        if (mode === "daemon" && (!pid || !Number.isFinite(pid))) {
          throw new Error('"pid" is required when mode="daemon"');
        }
        for (const script of activeScripts) {
          const applied = await evaluateHookScriptInSession({
            deviceId,
            identifier,
            platform,
            mode,
            bundle,
            pid,
            scriptId: script.id,
            scriptName: `preset:${preset.name}:${script.name}`,
            sourceCode: script.content,
            source: "preset",
            signal: options.signal,
          });
          receipts.push(applied.receipt);
        }
      }

      const failed = receipts.filter((item) => !item.compiled);
      const response = {
        ok: failed.length === 0,
        preset,
        scripts,
        executed: execute,
        execution: {
          total: receipts.length,
          success: receipts.length - failed.length,
          failed: failed.length,
          targetPid: receipts[0]?.targetPid ?? null,
          receipts,
        },
        artifacts: buildEvidenceArtifacts({
          deviceId,
          identifier,
          pid: receipts[0]?.targetPid ?? null,
          runHint: `apply_hook_script_preset:${preset.name}`,
        }),
      };
      if (failed.length > 0) {
        throw new ToolExecutionError(
          `${failed.length} preset scripts failed to compile/load`,
          "SCRIPT_APPLY_FAILED",
          response,
        );
      }
      return response;
    }

    case "apply_hook_script": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const scriptId = asOptionalString(args, "scriptId");
      const scriptNameInput = asOptionalString(args, "scriptName");
      const contentInput = asOptionalString(args, "content");
      const modeRaw = asOptionalString(args, "mode");
      const mode: MCPMode = modeRaw === "daemon" ? "daemon" : "app";
      const bundle = asOptionalString(args, "bundle") ?? identifier;
      const pid = asOptionalNumber(args, "pid");
      const platformRaw = asOptionalString(args, "platform");
      const platform: MCPPlatform =
        platformRaw === "droid" || platformRaw === "fruity"
          ? platformRaw
          : await detectDevicePlatform(deviceId);
      withSessionCAS(deviceId, mode === "app" ? bundle : undefined, args);

      const scriptStore = createHookScriptStore(deviceId, identifier);
      const scripts = scriptStore.list();
      const stored = scriptId
        ? scripts.find((item) => item.id === scriptId)
        : undefined;
      if (scriptId && !stored) {
        throw new Error(`script not found: ${scriptId}`);
      }

      const sourceCode = contentInput ?? stored?.content;
      if (!sourceCode || sourceCode.trim().length === 0) {
        throw new Error('"content" is required when scriptId is missing');
      }

      const scriptName =
        scriptNameInput ??
        stored?.name ??
        (scriptId ? `script:${scriptId}` : `script:${randomUUID()}`);
      if (mode === "daemon" && (!pid || !Number.isFinite(pid))) {
        throw new Error('"pid" is required when mode="daemon"');
      }

      const applied = await evaluateHookScriptInSession({
        deviceId,
        identifier,
        platform,
        mode,
        bundle,
        pid,
        scriptId: stored?.id,
        scriptName,
        sourceCode,
        source: "manual",
        signal: options.signal,
      });
      const receipt = applied.receipt;
      const timeline =
        mode === "app" ? getLaunchTimeline({ deviceId, bundle }) : null;

      const response = {
        ok: receipt.compiled,
        deviceId,
        identifier,
        mode,
        bundle: mode === "app" ? bundle : null,
        targetPid: applied.targetPid,
        compiled: receipt.compiled,
        loaded: receipt.loaded,
        installedHooks: receipt.installedHooks,
        installedHooksSync: receipt.installedHooksSync,
        hitCount: receipt.hitCount,
        firstHitAt: receipt.firstHitAt,
        lastHitAt: receipt.lastHitAt,
        errors: receipt.error ? [receipt.error] : [],
        receipt,
        launchTimeline: timeline,
        artifacts: buildEvidenceArtifacts({
          deviceId,
          identifier,
          pid: applied.targetPid,
          runHint: `apply_hook_script:${scriptName}`,
        }),
      };
      if (!receipt.compiled) {
        throw new ToolExecutionError(
          "hook script failed to compile/load",
          "SCRIPT_APPLY_FAILED",
          response,
        );
      }
      return response;
    }

    case "validate_hook_script": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const scriptId = asOptionalString(args, "scriptId");
      const scriptNameInput = asOptionalString(args, "scriptName");
      const contentInput = asOptionalString(args, "content");
      const checkSymbols = asOptionalBoolean(args, "checkSymbols") !== false;
      const modeRaw = asOptionalString(args, "mode");
      const mode: MCPMode = modeRaw === "daemon" ? "daemon" : "app";
      const bundle = asOptionalString(args, "bundle") ?? identifier;
      const pid = asOptionalNumber(args, "pid");
      const platformRaw = asOptionalString(args, "platform");
      const platform: MCPPlatform =
        platformRaw === "droid" || platformRaw === "fruity"
          ? platformRaw
          : await detectDevicePlatform(deviceId);
      withSessionCAS(deviceId, mode === "app" ? bundle : undefined, args);

      const scripts = createHookScriptStore(deviceId, identifier).list();
      const stored = scriptId
        ? scripts.find((item) => item.id === scriptId)
        : undefined;
      if (scriptId && !stored) {
        throw new Error(`script not found: ${scriptId}`);
      }

      const sourceCode = contentInput ?? stored?.content;
      if (!sourceCode || sourceCode.trim().length === 0) {
        throw new Error('"content" is required when scriptId is missing');
      }
      const scriptName =
        scriptNameInput ??
        stored?.name ??
        (scriptId ? `script:${scriptId}` : "inline-script");

      let syntaxError: string | null = null;
      try {
        new Function(sourceCode);
      } catch (error) {
        syntaxError = normalizeErrorString(error);
      }

      const javaClassRefs = Array.from(
        new Set(
          [...sourceCode.matchAll(/Java\.use\(\s*["']([^"']+)["']\s*\)/g)].map(
            (m) => m[1]!,
          ),
        ),
      );
      const objcClassRefs = Array.from(
        new Set(
          [
            ...sourceCode.matchAll(/ObjC\.classes(?:\.|\[\s*["'])([A-Za-z0-9_.$]+)["']?\s*\]?/g),
          ].map((m) => m[1]!),
        ),
      );

      const classChecks: {
        java: Array<{ name: string; exists: boolean; error?: string }>;
        objc: Array<{ name: string; exists: boolean; error?: string }>;
      } = {
        java: javaClassRefs.map((name) => ({ name, exists: false })),
        objc: objcClassRefs.map((name) => ({ name, exists: false })),
      };

      if (
        checkSymbols &&
        !syntaxError &&
        (classChecks.java.length > 0 || classChecks.objc.length > 0)
      ) {
        const symbolResult = await withAgentScript(
          {
            deviceId,
            platform,
            mode,
            bundle,
            pid,
          },
          async (script) => {
            const source = `
              (function () {
                var javaClasses = ${JSON.stringify(javaClassRefs)};
                var objcClasses = ${JSON.stringify(objcClassRefs)};
                var result = { java: [], objc: [] };
                if (typeof Java !== "undefined" && Java.available) {
                  Java.performNow(function () {
                    javaClasses.forEach(function (name) {
                      try {
                        Java.use(name);
                        result.java.push({ name: name, exists: true });
                      } catch (e) {
                        result.java.push({ name: name, exists: false, error: String(e) });
                      }
                    });
                  });
                } else {
                  javaClasses.forEach(function (name) {
                    result.java.push({ name: name, exists: false, error: "Java bridge unavailable" });
                  });
                }
                if (typeof ObjC !== "undefined" && ObjC.available) {
                  objcClasses.forEach(function (name) {
                    try {
                      var klass = ObjC.classes[name];
                      if (klass) {
                        result.objc.push({ name: name, exists: true });
                      } else {
                        result.objc.push({ name: name, exists: false, error: "class not found" });
                      }
                    } catch (e) {
                      result.objc.push({ name: name, exists: false, error: String(e) });
                    }
                  });
                } else {
                  objcClasses.forEach(function (name) {
                    result.objc.push({ name: name, exists: false, error: "ObjC bridge unavailable" });
                  });
                }
                return result;
              })();
            `;
            return await script.exports.invoke("script", "evaluate", [
              source,
              `validate:${scriptName}`,
            ]);
          },
          options,
        );
        const parsed = asObject(symbolResult, "symbol validation result");
        const java = Array.isArray(parsed.java) ? parsed.java : [];
        const objc = Array.isArray(parsed.objc) ? parsed.objc : [];
        classChecks.java = java.map((row) => {
          const item = asObject(row, "java[]");
          return {
            name: asString(item, "name"),
            exists: item.exists === true,
            error: asOptionalString(item, "error"),
          };
        });
        classChecks.objc = objc.map((row) => {
          const item = asObject(row, "objc[]");
          return {
            name: asString(item, "name"),
            exists: item.exists === true,
            error: asOptionalString(item, "error"),
          };
        });
      }

      const warnings: string[] = [];
      if (sourceCode.includes("Java.perform(") && !sourceCode.includes("Java.performNow(")) {
        warnings.push(
          "Script uses Java.perform; for early lifecycle hooks prefer Java.performNow or suspended launch.",
        );
      }
      const conflicts = scripts
        .filter((item) => item.id !== stored?.id && item.name === scriptName)
        .map((item) => ({
          type: "duplicate_name",
          scriptId: item.id,
          scriptName: item.name,
        }));
      const missingJava = classChecks.java.filter((item) => !item.exists).length;
      const missingObjc = classChecks.objc.filter((item) => !item.exists).length;
      const valid = !syntaxError && missingJava === 0 && missingObjc === 0;
      return {
        valid,
        scriptName,
        syntax: {
          ok: !syntaxError,
          error: syntaxError,
        },
        references: {
          javaClasses: javaClassRefs,
          objcClasses: objcClassRefs,
        },
        classChecks,
        conflicts,
        warnings,
      };
    }

    case "get_hook_stats": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const limit = Math.min(20_000, Math.max(100, Math.floor(asOptionalNumber(args, "limit") ?? 5000)));
      const scripts = createHookScriptStore(deviceId, identifier).list();
      const scriptByName = new Map(scripts.map((item) => [item.name, item.id]));
      const logs = mapHooks(new HookStore(deviceId, identifier).query({}, limit));

      const bySymbol = new Map<
        string,
        {
          symbol: string;
          hitCount: number;
          firstHitAt: string;
          lastHitAt: string;
          categories: Set<string>;
          scriptId?: string;
        }
      >();
      const byScript = new Map<
        string,
        {
          scriptId: string;
          scriptName: string;
          hitCount: number;
          firstHitAt: string | null;
          lastHitAt: string | null;
          lastApplyAt: string | null;
          lastCompileOk: boolean | null;
          installedHooks: number;
        }
      >();

      for (const script of scripts) {
        byScript.set(script.id, {
          scriptId: script.id,
          scriptName: script.name,
          hitCount: 0,
          firstHitAt: null,
          lastHitAt: null,
          lastApplyAt: null,
          lastCompileOk: null,
          installedHooks: 0,
        });
      }

      for (const log of logs) {
        const key = log.symbol || "unknown";
        const bucket = bySymbol.get(key) ?? {
          symbol: key,
          hitCount: 0,
          firstHitAt: log.timestamp,
          lastHitAt: log.timestamp,
          categories: new Set<string>(),
          scriptId: scriptByName.get(key),
        };
        bucket.hitCount += 1;
        if (log.timestamp < bucket.firstHitAt) {
          bucket.firstHitAt = log.timestamp;
        }
        if (log.timestamp > bucket.lastHitAt) {
          bucket.lastHitAt = log.timestamp;
        }
        bucket.categories.add(log.category);
        bySymbol.set(key, bucket);

        const extra = isRecord(log.extra) ? log.extra : {};
        const scriptId = typeof extra.scriptId === "string" ? extra.scriptId : scriptByName.get(key);
        if (scriptId && byScript.has(scriptId)) {
          const scriptStats = byScript.get(scriptId)!;
          scriptStats.hitCount += 1;
          if (!scriptStats.firstHitAt || log.timestamp < scriptStats.firstHitAt) {
            scriptStats.firstHitAt = log.timestamp;
          }
          if (!scriptStats.lastHitAt || log.timestamp > scriptStats.lastHitAt) {
            scriptStats.lastHitAt = log.timestamp;
          }
          if (log.category === "script.apply.ack") {
            scriptStats.lastApplyAt = log.timestamp;
            scriptStats.lastCompileOk =
              typeof extra.compileOk === "boolean" ? extra.compileOk : scriptStats.lastCompileOk;
            scriptStats.installedHooks =
              typeof extra.installedHooksSync === "number"
                ? Math.max(scriptStats.installedHooks, Math.floor(extra.installedHooksSync))
                : typeof extra.hookedMethods === "number"
                  ? Math.max(scriptStats.installedHooks, Math.floor(extra.hookedMethods))
                : scriptStats.installedHooks;
          }
        }
      }

      return {
        symbolStats: Array.from(bySymbol.values())
          .map((item) => ({
            symbol: item.symbol,
            scriptId: item.scriptId,
            hitCount: item.hitCount,
            firstHitAt: item.firstHitAt,
            lastHitAt: item.lastHitAt,
            categories: Array.from(item.categories),
          }))
          .sort((a, b) => b.hitCount - a.hitCount),
        scriptStats: Array.from(byScript.values()).sort((a, b) => b.hitCount - a.hitCount),
        totalLogsScanned: logs.length,
      };
    }

    case "list_hook_packs": {
      const platformValue = asOptionalString(args, "platform");
      const platform: HookPackPlatform | undefined =
        platformValue === "droid" || platformValue === "fruity" || platformValue === "any"
          ? platformValue
          : undefined;
      const identifier = asOptionalString(args, "identifier");
      const includeTargeted = asOptionalBoolean(args, "includeTargeted") === true;
      return listHookPacks(platform, {
        identifier,
        includeTargeted,
      });
    }

    case "create_hook_pack": {
      const name = asString(args, "name");
      const description = asOptionalString(args, "description");
      const platformValue = asOptionalString(args, "platform");
      const scripts = asArray(args, "scripts").map((raw) => {
        const row = asObject(raw, "scripts[]");
        return {
          name: asString(row, "name"),
          content: asString(row, "content"),
          enabled: asOptionalBoolean(row, "enabled"),
          runOnAppLaunch: asOptionalBoolean(row, "runOnAppLaunch"),
        };
      });
      const platform: HookPackPlatform =
        platformValue === "droid" || platformValue === "fruity" || platformValue === "any"
          ? platformValue
          : "any";
      return createCustomHookPack({
        name,
        description,
        platform,
        scripts,
      });
    }

    case "update_hook_pack": {
      const packId = asString(args, "packId");
      const name = asOptionalString(args, "name");
      const description = asOptionalString(args, "description");
      const platformValue = asOptionalString(args, "platform");
      const scriptsRaw = args.scripts;
      const scripts = Array.isArray(scriptsRaw)
        ? scriptsRaw.map((raw) => {
            const row = asObject(raw, "scripts[]");
            return {
              name: asString(row, "name"),
              content: asString(row, "content"),
              enabled: asOptionalBoolean(row, "enabled"),
              runOnAppLaunch: asOptionalBoolean(row, "runOnAppLaunch"),
            };
          })
        : undefined;
      const platform: HookPackPlatform | undefined =
        platformValue === "droid" || platformValue === "fruity" || platformValue === "any"
          ? platformValue
          : undefined;
      const updated = updateCustomHookPack(packId, {
        name,
        description,
        platform,
        scripts,
      });
      if (!updated) throw new Error(`hook pack not found: ${packId}`);
      return updated;
    }

    case "delete_hook_pack": {
      const packId = asString(args, "packId");
      const removed = removeCustomHookPack(packId);
      if (!removed) throw new Error(`hook pack not found: ${packId}`);
      return { ok: true, packId };
    }

    case "apply_hook_pack": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const packId = asString(args, "packId");
      const autoApplyOnAppLaunch = asOptionalBoolean(args, "autoApplyOnAppLaunch");
      withSessionCAS(deviceId, identifier, args);
      const pack = getHookPack(packId);
      if (!pack) throw new Error(`hook pack not found: ${packId}`);

      const platform = await detectDevicePlatform(deviceId);
      if (pack.platform !== "any" && pack.platform !== platform) {
        throw new Error(
          `hook pack ${pack.name} targets ${pack.platform}, but device is ${platform}`,
        );
      }

      const scriptStore = createHookScriptStore(deviceId, identifier);
      const currentScripts = scriptStore.list();
      const byName = new Map(currentScripts.map((item) => [item.name, item]));

      const affectedScripts = [];
      for (const tpl of pack.scripts) {
        const existing = byName.get(tpl.name);
        if (existing) {
          const updated = scriptStore.update(existing.id, {
            content: tpl.content,
            enabled: tpl.enabled,
            runOnAppLaunch: tpl.runOnAppLaunch,
          });
          if (updated) affectedScripts.push(updated);
        } else {
          const created = scriptStore.create({
            name: tpl.name,
            content: tpl.content,
            enabled: tpl.enabled,
            runOnAppLaunch: tpl.runOnAppLaunch,
          });
          affectedScripts.push(created);
        }
      }

      const presetStore = createHookScriptPresetStore(deviceId, identifier);
      const presetName = `[pack] ${pack.name}`;
      const existingPreset = presetStore.list().find((item) => item.name === presetName);
      const presetItems = affectedScripts.map((item) => ({
        scriptId: item.id,
        enabled: item.enabled,
        runOnAppLaunch: item.runOnAppLaunch,
      }));
      const preset = existingPreset
        ? presetStore.update(existingPreset.id, {
            items: presetItems,
            autoApplyOnAppLaunch: autoApplyOnAppLaunch ?? true,
          })
        : presetStore.create({
            name: presetName,
            items: presetItems,
            autoApplyOnAppLaunch: autoApplyOnAppLaunch ?? true,
          });
      if (!preset) {
        throw new Error("failed to create or update hook pack preset");
      }
      const scripts = scriptStore.applyPreset(preset.items);
      return { ok: true, pack, preset, scripts };
    }

    case "list_rulesets": {
      return listRuleSets();
    }

    case "enable_ruleset": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      withSessionCAS(deviceId, identifier, args);
      const rulesetIds = asArray(args, "rulesetIds").map((item) => String(item));
      const enabled = setEnabledRuleSets(deviceId, identifier, rulesetIds);
      return { ok: true, enabled };
    }

    case "evaluate_findings": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      withSessionCAS(deviceId, identifier, args);
      const save = asOptionalBoolean(args, "save") !== false;
      const rulesetIdsInput = Array.isArray(args.rulesetIds)
        ? args.rulesetIds.map((item) => String(item))
        : [];
      const activeRulesetIds =
        rulesetIdsInput.length > 0
          ? rulesetIdsInput
          : getEnabledRuleSets(deviceId, identifier);
      const fallbackRulesets = activeRulesetIds.length
        ? activeRulesetIds
        : listRuleSets().map((item) => item.id);

      const findings = evaluateRulesForTarget(
        deviceId,
        identifier,
        fallbackRulesets,
      );
      const persisted = save
        ? appendFindings(deviceId, identifier, findings)
        : findings.map((item) => ({
            ...item,
            id: randomUUID(),
            deviceId,
            identifier,
            createdAt: new Date().toISOString(),
          }));
      const summary = summarizeFindingRisk(persisted.map((item) => ({ risk: item.risk })));
      return {
        rulesetIds: fallbackRulesets,
        save,
        summary,
        findings: persisted,
      };
    }

    case "list_findings": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const riskRaw = asOptionalString(args, "risk");
      const risk: FindingRisk | undefined =
        riskRaw === "high" || riskRaw === "medium" || riskRaw === "low"
          ? riskRaw
          : undefined;
      const statusRaw = asOptionalString(args, "status");
      const status =
        statusRaw === "open" || statusRaw === "mitigated" || statusRaw === "accepted"
          ? statusRaw
          : undefined;
      const limit = asOptionalNumber(args, "limit");
      const offset = asOptionalNumber(args, "offset");
      return listFindings(deviceId, identifier, { risk, status, limit, offset });
    }

    case "clear_findings": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      withSessionCAS(deviceId, identifier, args);
      clearFindings(deviceId, identifier);
      return { ok: true, deviceId, identifier };
    }

    case "list_artifacts": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const type = asOptionalString(args, "type");
      const limit = asOptionalNumber(args, "limit");
      const offset = asOptionalNumber(args, "offset");
      return listArtifacts(deviceId, identifier, { type, limit, offset });
    }

    case "get_artifact": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const artifactId = asString(args, "artifactId");
      const maxBytes = asOptionalNumber(args, "maxBytes") ?? 512 * 1024;
      const artifact = getArtifact(deviceId, identifier, artifactId);
      if (!artifact) throw new Error(`artifact not found: ${artifactId}`);
      const content = await readArtifactContent(artifact, Math.floor(maxBytes));
      return {
        artifact,
        content,
      };
    }

    case "export_report": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const runId = asString(args, "runId");
      const reportName = asOptionalString(args, "name") ?? `report-${runId}`;
      const run = createTestPlanRunStore(deviceId, identifier).get(runId);
      if (!run) throw new Error(`test run not found: ${runId}`);
      const findings = listFindings(deviceId, identifier, { limit: 300 });
      const content = markdownForTestPlanReport(run, findings);
      const artifact = await createArtifact(deviceId, identifier, {
        type: "exported-report-md",
        name: reportName,
        mime: "text/markdown",
        content,
        meta: {
          runId,
        },
      });
      return { ok: true, artifact };
    }

    case "list_test_plans": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      return createTestPlanStore(deviceId, identifier).list();
    }

    case "create_test_plan": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const plan = asObject(args.plan, "plan");
      const target = isRecord(plan.target)
        ? parseScenarioRunTarget(plan.target)
        : undefined;
      return createTestPlanStore(deviceId, identifier).create({
        name: asString(plan, "name"),
        description: asOptionalString(plan, "description"),
        tags: Array.isArray(plan.tags) ? plan.tags.map((item) => String(item)) : [],
        scenarioIds: asArray(plan, "scenarioIds").map((item) => String(item)),
        hookPackIds: Array.isArray(plan.hookPackIds)
          ? plan.hookPackIds.map((item) => String(item))
          : [],
        rulesetIds: Array.isArray(plan.rulesetIds)
          ? plan.rulesetIds.map((item) => String(item))
          : [],
        target,
        stopOnFailure: asOptionalBoolean(plan, "stopOnFailure") !== false,
      });
    }

    case "update_test_plan": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const planId = asString(args, "planId");
      const patch = asObject(args.patch, "patch");
      const target = isRecord(patch.target)
        ? parseScenarioRunTarget(patch.target)
        : undefined;
      const updated = createTestPlanStore(deviceId, identifier).update(planId, {
        name: asOptionalString(patch, "name"),
        description: asOptionalString(patch, "description"),
        tags: Array.isArray(patch.tags) ? patch.tags.map((item) => String(item)) : undefined,
        scenarioIds: Array.isArray(patch.scenarioIds)
          ? patch.scenarioIds.map((item) => String(item))
          : undefined,
        hookPackIds: Array.isArray(patch.hookPackIds)
          ? patch.hookPackIds.map((item) => String(item))
          : undefined,
        rulesetIds: Array.isArray(patch.rulesetIds)
          ? patch.rulesetIds.map((item) => String(item))
          : undefined,
        target,
        stopOnFailure: asOptionalBoolean(patch, "stopOnFailure"),
      });
      if (!updated) throw new Error(`test plan not found: ${planId}`);
      return updated;
    }

    case "delete_test_plan": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const planId = asString(args, "planId");
      const removed = createTestPlanStore(deviceId, identifier).remove(planId);
      if (!removed) throw new Error(`test plan not found: ${planId}`);
      return { ok: true, planId };
    }

    case "run_test_plan": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const planId = asString(args, "planId");
      const store = createTestPlanStore(deviceId, identifier);
      const plan = store.get(planId);
      if (!plan) throw new Error(`test plan not found: ${planId}`);

      for (const packId of plan.hookPackIds) {
        await callTool("apply_hook_pack", {
          deviceId,
          identifier,
          packId,
          autoApplyOnAppLaunch: true,
        }, options);
      }

      const target = isRecord(args.target)
        ? parseScenarioRunTarget(args.target)
        : plan.target ?? {};
      const stopOnFailure = asOptionalBoolean(args, "stopOnFailure");
      const runStore = createTestPlanRunStore(deviceId, identifier);
      const run = runStore.create({
        planId: plan.id,
        planName: plan.name,
        status: "queued",
        stepResults: [],
        artifacts: [],
        findingsSummary: { high: 0, medium: 0, low: 0 },
      });

      const worker = withDeviceLock(deviceId, async () => {
        try {
          await executeTestPlanWorker({
            deviceId,
            identifier,
            runId: run.id,
            plan: {
              id: plan.id,
              name: plan.name,
              scenarioIds: plan.scenarioIds,
              rulesetIds: plan.rulesetIds,
              target,
              stopOnFailure: stopOnFailure ?? plan.stopOnFailure,
            },
          });
        } catch (error) {
          runStore.update(run.id, {
            status: "error",
            endedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          testPlanCancelTokens.delete(run.id);
          testPlanRunWorkers.delete(run.id);
        }
      });
      testPlanRunWorkers.set(run.id, worker);
      return run;
    }

    case "get_test_run": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const runId = asString(args, "runId");
      const run = createTestPlanRunStore(deviceId, identifier).get(runId);
      if (!run) throw new Error(`test run not found: ${runId}`);
      return run;
    }

    case "list_test_plan_runs": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const planId = asOptionalString(args, "planId");
      const statusRaw = asOptionalString(args, "status");
      const status: TestPlanRunStatus | undefined =
        statusRaw === "queued" ||
        statusRaw === "running" ||
        statusRaw === "passed" ||
        statusRaw === "failed" ||
        statusRaw === "error" ||
        statusRaw === "canceling" ||
        statusRaw === "canceled"
          ? statusRaw
          : undefined;
      return createTestPlanRunStore(deviceId, identifier).list({
        planId: planId || undefined,
        status,
      });
    }

    case "cancel_test_run": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const runId = asString(args, "runId");
      const runStore = createTestPlanRunStore(deviceId, identifier);
      const run = runStore.get(runId);
      if (!run) throw new Error(`test run not found: ${runId}`);
      testPlanCancelTokens.add(runId);
      const next = runStore.update(runId, {
        status: run.status === "queued" ? "canceled" : "canceling",
      });
      return {
        ok: true,
        run: next ?? run,
      };
    }

    case "rerun_failed_steps": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const runId = asString(args, "runId");
      const runStore = createTestPlanRunStore(deviceId, identifier);
      const previousRun = runStore.get(runId);
      if (!previousRun) throw new Error(`test run not found: ${runId}`);
      const failedScenarioIds = previousRun.stepResults
        .filter((step) => step.status === "failed" || step.status === "error")
        .map((step) => step.scenarioId);
      if (failedScenarioIds.length === 0) {
        throw new Error("no failed steps to rerun");
      }

      const rerun = runStore.create({
        planId: previousRun.planId,
        planName: `${previousRun.planName} (rerun failed)`,
        status: "queued",
        stepResults: [],
        artifacts: [],
        findingsSummary: { high: 0, medium: 0, low: 0 },
      });

      const worker = withDeviceLock(deviceId, async () => {
        try {
          await executeTestPlanWorker({
            deviceId,
            identifier,
            runId: rerun.id,
            plan: {
              id: previousRun.planId,
              name: rerun.planName,
              scenarioIds: failedScenarioIds,
              rulesetIds: [],
              stopOnFailure: true,
            },
          });
        } catch (error) {
          runStore.update(rerun.id, {
            status: "error",
            endedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          testPlanCancelTokens.delete(rerun.id);
          testPlanRunWorkers.delete(rerun.id);
        }
      });
      testPlanRunWorkers.set(rerun.id, worker);
      return rerun;
    }

    case "snapshot_ui": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      const platformRaw = asOptionalString(args, "platform");
      const platform: MCPPlatform | undefined =
        platformRaw === "droid" || platformRaw === "fruity" ? platformRaw : undefined;
      return await captureUISnapshot(deviceId, bundle, platform, options);
    }

    case "find_element": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      const platformRaw = asOptionalString(args, "platform");
      const platform: MCPPlatform | undefined =
        platformRaw === "droid" || platformRaw === "fruity" ? platformRaw : undefined;
      const query = asObject(args.query, "query");
      const snapshot = await captureUISnapshot(deviceId, bundle, platform, options);
      const element = findElementInSnapshot(snapshot, query);
      if (!element) {
        return {
          found: false,
          snapshotMeta: {
            platform: snapshot.platform,
            capturedAt: snapshot.capturedAt,
            nodeCount: snapshot.nodes.length,
          },
        };
      }
      return {
        found: true,
        element,
        snapshotMeta: {
          platform: snapshot.platform,
          capturedAt: snapshot.capturedAt,
          nodeCount: snapshot.nodes.length,
        },
      };
    }

    case "tap_element": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      const platformRaw = asOptionalString(args, "platform");
      const platform: MCPPlatform | undefined =
        platformRaw === "droid" || platformRaw === "fruity" ? platformRaw : undefined;
      const query = asObject(args.query, "query");
      const snapshot = await captureUISnapshot(deviceId, bundle, platform, options);
      const element = findElementInSnapshot(snapshot, query);
      if (!element) throw new Error("element not found");

      const center =
        snapshot.platform === "droid"
          ? element.center
          : (element.center as { x: number; y: number } | null);
      if (!center) throw new Error("element found but no tappable center");

      const action = await callTool("tap", {
        deviceId,
        bundle,
        x: center.x,
        y: center.y,
      }, options);
      return {
        found: true,
        element,
        action,
      };
    }

    case "input_element": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      const platformRaw = asOptionalString(args, "platform");
      const platform: MCPPlatform | undefined =
        platformRaw === "droid" || platformRaw === "fruity" ? platformRaw : undefined;
      const query = asObject(args.query, "query");
      const text = asString(args, "text");

      const tapped = await callTool("tap_element", {
        deviceId,
        bundle,
        platform,
        query,
      }, options);
      const action = await callTool("input_text", {
        deviceId,
        bundle,
        text,
      }, options);
      return {
        tapped,
        action,
      };
    }

    case "assert_element": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      const platformRaw = asOptionalString(args, "platform");
      const platform: MCPPlatform | undefined =
        platformRaw === "droid" || platformRaw === "fruity" ? platformRaw : undefined;
      const query = asObject(args.query, "query");
      const shouldExist = asOptionalBoolean(args, "shouldExist");
      const expected = shouldExist !== false;

      const snapshot = await captureUISnapshot(deviceId, bundle, platform, options);
      const element = findElementInSnapshot(snapshot, query);
      const found = !!element;
      return {
        pass: found === expected,
        found,
        expected,
        element: element ?? null,
      };
    }

    case "acquire_device_lock": {
      cleanupExpiredDeviceLocks();
      const deviceId = asString(args, "deviceId");
      const owner = asString(args, "owner");
      const ttlMs = Math.max(30_000, Math.floor(asOptionalNumber(args, "ttlMs") ?? 15 * 60_000));
      const existing = deviceLeaseLocks.get(deviceId);
      if (existing && existing.owner !== owner) {
        throw new Error(`device lock is already owned by "${existing.owner}"`);
      }
      const lock: DeviceLeaseLock = {
        owner,
        acquiredAt: new Date().toISOString(),
        expiresAt: Date.now() + ttlMs,
      };
      deviceLeaseLocks.set(deviceId, lock);
      return {
        ok: true,
        deviceId,
        lock,
      };
    }

    case "release_device_lock": {
      cleanupExpiredDeviceLocks();
      const deviceId = asString(args, "deviceId");
      const owner = asString(args, "owner");
      const existing = deviceLeaseLocks.get(deviceId);
      if (!existing) {
        return { ok: true, deviceId, released: false };
      }
      if (existing.owner !== owner) {
        throw new Error(`device lock is owned by "${existing.owner}"`);
      }
      deviceLeaseLocks.delete(deviceId);
      return { ok: true, deviceId, released: true };
    }

    case "get_session_state": {
      cleanupExpiredDeviceLocks();
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      const state = getSessionState(deviceId, bundle);
      const lock = deviceLeaseLocks.get(deviceId) ?? null;
      let app = null;
      if (bundle) {
        try {
          const device = await resolveDevice(deviceId);
          const pid = await getRunningAppPid(device, bundle, options);
          app = {
            bundle,
            running: !!pid,
            pid: pid ?? null,
          };
        } catch (error) {
          app = {
            bundle,
            running: false,
            pid: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      return {
        deviceId,
        lock,
        state,
        app,
      };
    }

    case "recover_session": {
      const deviceId = asString(args, "deviceId");
      const bundle = asOptionalString(args, "bundle");
      const modeRaw = asOptionalString(args, "mode");
      const mode: MCPMode = modeRaw === "daemon" ? "daemon" : "app";
      const relaunch = asOptionalBoolean(args, "relaunch") === true;
      const rescue = asOptionalBoolean(args, "rescue") === true;
      const replayPreset =
        asOptionalBoolean(args, "replayPreset") ??
        rescue;
      const waitMsRaw = Math.max(0, Math.floor(asOptionalNumber(args, "waitMs") ?? 3000));
      const expectedState = parseExpectedSessionState(args);
      const expectedVersion = parseExpectedSessionVersion(args);
      const platformRaw = asOptionalString(args, "platform");
      let platform: MCPPlatform | undefined =
        platformRaw === "droid" || platformRaw === "fruity" ? platformRaw : undefined;
      let ticket = transitionSessionState(
        deviceId,
        {
          platform,
          mode,
          bundle,
          status: "recovering",
          lastError: undefined,
        },
        {
          expectedState,
          expectedVersion,
          reason: "recover_session:start",
        },
      );

      try {
        if (!platform) {
          platform = await detectDevicePlatform(deviceId);
        }
        if (mode === "app") {
          if (!bundle) {
            throw new Error('"bundle" is required to recover app mode session');
          }
          let timeline = getLaunchTimeline({ deviceId, bundle });
          if (!timeline) {
            timeline = createLaunchTimeline({
              deviceId,
              bundle,
              platform,
              restart: relaunch,
              suspended: replayPreset,
              wasRunning: false,
            });
          }
          pushLaunchTimelineEvent(timeline, {
            stage: "recover:start",
            detail: `rescue=${rescue} replayPreset=${replayPreset}`,
          });

          let launched:
            | {
                pid: number | null;
                pendingResume: boolean;
                launchTimeline?: unknown;
              }
            | undefined;
          if (relaunch || rescue) {
            launched = (await callTool("launch_app", {
              deviceId,
              bundle,
              restart: relaunch,
              suspended: replayPreset,
              waitMs: waitMsRaw,
            }, options)) as {
              pid: number | null;
              pendingResume: boolean;
              launchTimeline?: unknown;
            };
            pushLaunchTimelineEvent(timeline, {
              stage: "recover:launch",
              pid: launched.pid ?? undefined,
              detail: `relaunch=${relaunch} suspended=${replayPreset}`,
            });
          }
          const device = await resolveDevice(deviceId);
          let pid = await waitForRunningAppPid(
            device,
            bundle,
            Math.max(waitMsRaw, 3000),
            200,
            options,
          );
          if (!pid && launched?.pid) {
            pid = launched.pid;
          }
          if (!pid && rescue) {
            const fallbackLaunch = (await callTool("launch_app", {
              deviceId,
              bundle,
              restart: true,
              suspended: replayPreset,
              waitMs: waitMsRaw,
            }, options)) as {
              pid: number | null;
              pendingResume: boolean;
              launchTimeline?: unknown;
            };
            launched = fallbackLaunch;
            pid = fallbackLaunch.pid;
            pushLaunchTimelineEvent(timeline, {
              stage: "recover:rescue-relaunch",
              pid: pid ?? undefined,
              detail: "fallback relaunch triggered",
            });
          }
          if (!pid) {
            throw new Error(`failed to recover session: ${bundle} is not running`);
          }
          pushLaunchTimelineEvent(timeline, {
            stage: "recover:pid",
            pid,
            detail: "target pid ready",
          });

          const startupReceipts: ScriptApplyReceipt[] = [];
          let startupPreset: ReturnType<
            ReturnType<typeof createHookScriptPresetStore>["getAutoApplyOnAppLaunch"]
          > | null = null;
          if (replayPreset) {
            const presetStore = createHookScriptPresetStore(deviceId, bundle);
            const scriptStore = createHookScriptStore(deviceId, bundle);
            startupPreset = presetStore.getAutoApplyOnAppLaunch();
            if (startupPreset) {
              const scripts = scriptStore.applyPreset(startupPreset.items);
              const runnable = scripts.filter(
                (item) => item.enabled && item.runOnAppLaunch,
              );
              for (const script of runnable) {
                const applied = await evaluateHookScriptInSession({
                  deviceId,
                  identifier: bundle,
                  platform,
                  mode: "app",
                  bundle,
                  scriptId: script.id,
                  scriptName: `recover:${startupPreset.name}:${script.name}`,
                  sourceCode: script.content,
                  source: "preset",
                  signal: options.signal,
                });
                startupReceipts.push(applied.receipt);
              }
            }
          }

          if (launched?.pendingResume) {
            await callTool("resume_app", {
              deviceId,
              bundle,
              pid,
            }, options);
            pushLaunchTimelineEvent(timeline, {
              stage: "recover:resume",
              pid,
              detail: "resumed suspended process after replay",
            });
          }
          ticket = transitionSessionState(
            deviceId,
            {
              platform,
              mode,
              bundle,
              pid,
              status: "attached",
              lastError: undefined,
            },
            {
              expectedVersion: ticket.version,
              reason: "recover_session:attached",
            },
          );
          return {
            ok: true,
            deviceId,
            platform,
            mode,
            bundle,
            pid,
            session: ticket,
            rescue: {
              enabled: rescue,
              relaunchTriggered: relaunch || (!!launched && rescue),
              replayPreset,
              presetName: startupPreset?.name ?? null,
              receipts: startupReceipts,
              launchTimeline: launched?.launchTimeline ?? null,
            },
            artifacts: buildEvidenceArtifacts({
              deviceId,
              identifier: bundle,
              pid,
              runHint: "recover_session",
            }),
          };
        }

        const pid = asOptionalNumber(args, "pid");
        if (!pid) throw new Error('"pid" is required for daemon mode recovery');
        await withAgentScript(
          {
            deviceId,
            platform,
            mode: "daemon",
            pid,
          },
          async (script) => await script.exports.interfaces(),
          options,
        );
        ticket = transitionSessionState(
          deviceId,
          {
            platform,
            mode: "daemon",
            pid,
            bundle,
            status: "attached",
            lastError: undefined,
          },
          {
            expectedVersion: ticket.version,
            reason: "recover_session:attached",
          },
        );
        return {
          ok: true,
          deviceId,
          platform,
          mode: "daemon",
          pid,
          session: ticket,
          artifacts: buildEvidenceArtifacts({
            deviceId,
            identifier: bundle ?? `pid:${pid}`,
            pid,
            runHint: "recover_session",
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (bundle) {
          const timeline = getLaunchTimeline({ deviceId, bundle });
          if (timeline) {
            pushLaunchTimelineEvent(timeline, {
              stage: "recover:error",
              error: message,
            });
            finishLaunchTimeline(timeline, {
              status: "failed",
            });
          }
        }
        try {
          transitionSessionState(
            deviceId,
            {
              platform,
              mode,
              bundle,
              status: "error",
              lastError: message,
            },
            {
              expectedVersion: ticket.version,
              reason: "recover_session:error",
            },
          );
        } catch {
          // Ignore secondary state conflict while surfacing the original error.
        }
        throw error;
      }
    }

    case "get_platform_capabilities": {
      const platformRaw = asOptionalString(args, "platform");
      const platform: MCPPlatform | undefined =
        platformRaw === "droid" || platformRaw === "fruity" ? platformRaw : undefined;
      const includeTargeted = asOptionalBoolean(args, "includeTargeted") === true;
      return buildPlatformCapabilities(platform, {
        includeTargeted,
      });
    }

    case "list_scenario_templates": {
      return listScenarioTemplates();
    }

    case "import_scenario_template": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const templateId = asString(args, "templateId");
      const overwrite = asOptionalBoolean(args, "overwrite") === true;
      const name = asOptionalString(args, "name");
      const description = asOptionalString(args, "description");
      const tags = asOptionalStringArray(args, "tags");

      const draft = createScenarioDraftFromTemplate(templateId, {
        name,
        description,
        tags,
      });
      const store = createScenarioStore(deviceId, identifier);
      const existing = findScenarioByTemplateTag(store.list(), templateId);
      const scenario =
        overwrite && existing
          ? store.update(existing.id, {
              name: draft.name,
              description: draft.description,
              tags: draft.tags,
              steps: draft.steps,
            })
          : store.create(draft);
      if (!scenario) throw new Error(`failed to import scenario template: ${templateId}`);

      return {
        templateId,
        action: overwrite && existing ? "updated" : "created",
        scenario,
      };
    }

    case "import_all_scenario_templates": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const overwrite = asOptionalBoolean(args, "overwrite") === true;
      const explicitTemplateIds = asOptionalStringArray(args, "templateIds");
      const templateIds = Array.from(
        new Set(
          explicitTemplateIds && explicitTemplateIds.length > 0
            ? explicitTemplateIds
            : listScenarioTemplates().map((template) => template.id),
        ),
      );

      const store = createScenarioStore(deviceId, identifier);
      const created: string[] = [];
      const updated: string[] = [];
      const skipped: string[] = [];

      for (const templateId of templateIds) {
        const draft = createScenarioDraftFromTemplate(templateId);
        const existing = findScenarioByTemplateTag(store.list(), templateId);

        if (existing && !overwrite) {
          skipped.push(templateId);
          continue;
        }

        if (existing) {
          const scenario = store.update(existing.id, {
            name: draft.name,
            description: draft.description,
            tags: draft.tags,
            steps: draft.steps,
          });
          if (scenario) {
            updated.push(templateId);
          } else {
            skipped.push(templateId);
          }
          continue;
        }

        store.create(draft);
        created.push(templateId);
      }

      return {
        total: templateIds.length,
        created,
        updated,
        skipped,
      };
    }

    case "list_test_scenarios": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      return createScenarioStore(deviceId, identifier).list();
    }

    case "create_test_scenario": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const scenario = normalizeScenarioDraft(args.scenario);
      return createScenarioStore(deviceId, identifier).create(scenario);
    }

    case "update_test_scenario": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const scenarioId = asString(args, "scenarioId");
      const patch = normalizeScenarioPatch(args.patch);
      const updated = createScenarioStore(deviceId, identifier).update(
        scenarioId,
        patch,
      );
      if (!updated) throw new Error(`scenario not found: ${scenarioId}`);
      return updated;
    }

    case "delete_test_scenario": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const scenarioId = asString(args, "scenarioId");
      const removed = createScenarioStore(deviceId, identifier).remove(scenarioId);
      if (!removed) throw new Error(`scenario not found: ${scenarioId}`);
      return { ok: true, scenarioId };
    }

    case "run_test_scenario": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const scenarioId = asString(args, "scenarioId");
      const scenarioStore = createScenarioStore(deviceId, identifier);
      const runStore = createScenarioRunStore(deviceId, identifier);
      const scenario = scenarioStore.get(scenarioId);
      if (!scenario) throw new Error(`scenario not found: ${scenarioId}`);

      const target = parseScenarioRunTarget(args.target);
      const stopOnFailure = asOptionalBoolean(args, "stopOnFailure");
      const run = await runScenario({
        deviceId,
        identifier,
        scenario,
        target,
        stopOnFailure: stopOnFailure !== false,
      });
      runStore.append(run);
      return run;
    }

    case "list_test_runs": {
      const deviceId = asString(args, "deviceId");
      const identifier = asString(args, "identifier");
      const scenarioId = asOptionalString(args, "scenarioId");
      return createScenarioRunStore(deviceId, identifier).list({
        scenarioId: scenarioId || undefined,
      });
    }

    case "list_agent_interfaces": {
      const deviceId = asString(args, "deviceId");
      const platform = asString(args, "platform") as MCPPlatform;
      const mode = asString(args, "mode") as MCPMode;
      const bundle = asOptionalString(args, "bundle");
      const pid = asOptionalNumber(args, "pid");
      const expectedState = parseExpectedSessionState(args);
      const expectedVersion = parseExpectedSessionVersion(args);
      let ticket = transitionSessionState(
        deviceId,
        {
          platform,
          mode,
          bundle,
          pid,
          status: "recovering",
          lastError: undefined,
        },
        {
          expectedState,
          expectedVersion,
          reason: "list_agent_interfaces:start",
        },
      );

      try {
        const result = await withAgentScript(
          { deviceId, platform, mode, bundle, pid },
          async (script) => await script.exports.interfaces(),
          options,
        );
        ticket = transitionSessionState(
          deviceId,
          {
            platform,
            mode,
            bundle,
            pid,
            status: "attached",
            lastError: undefined,
          },
          {
            expectedVersion: ticket.version,
            reason: "list_agent_interfaces:attached",
          },
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          transitionSessionState(
            deviceId,
            {
              platform,
              mode,
              bundle,
              pid,
              status: "error",
              lastError: message,
            },
            {
              expectedVersion: ticket.version,
              reason: "list_agent_interfaces:error",
            },
          );
        } catch {
          // Ignore secondary state conflict while surfacing the original error.
        }
        throw error;
      }
    }

    case "invoke_agent_rpc": {
      const deviceId = asString(args, "deviceId");
      const platform = asString(args, "platform") as MCPPlatform;
      const mode = asString(args, "mode") as MCPMode;
      const bundle = asOptionalString(args, "bundle");
      const pid = asOptionalNumber(args, "pid");
      const namespace = asString(args, "namespace");
      const method = asString(args, "method");
      const rpcArgs = Array.isArray(args.args) ? args.args : [];
      const expectedState = parseExpectedSessionState(args);
      const expectedVersion = parseExpectedSessionVersion(args);
      let ticket = transitionSessionState(
        deviceId,
        {
          platform,
          mode,
          bundle,
          pid,
          status: "recovering",
          lastError: undefined,
        },
        {
          expectedState,
          expectedVersion,
          reason: "invoke_agent_rpc:start",
        },
      );

      try {
        const result = await withAgentScript(
          { deviceId, platform, mode, bundle, pid },
          async (script) => await script.exports.invoke(namespace, method, rpcArgs),
          options,
        );
        ticket = transitionSessionState(
          deviceId,
          {
            platform,
            mode,
            bundle,
            pid,
            status: "attached",
            lastError: undefined,
          },
          {
            expectedVersion: ticket.version,
            reason: "invoke_agent_rpc:attached",
          },
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          transitionSessionState(
            deviceId,
            {
              platform,
              mode,
              bundle,
              pid,
              status: "error",
              lastError: message,
            },
            {
              expectedVersion: ticket.version,
              reason: "invoke_agent_rpc:error",
            },
          );
        } catch {
          // Ignore secondary state conflict while surfacing the original error.
        }
        throw error;
      }
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function executeTool(
  name: string,
  rawArgs: unknown,
  options: { signal?: AbortSignal; allowAsyncDispatch?: boolean } = {},
): Promise<MCPToolResult> {
  try {
    const args = asObject(rawArgs ?? {});
    throwIfAborted(options.signal);
    if (!isKnownTool(name)) {
      throw new Error(`unknown tool: ${name}`);
    }
    assertDeviceLockAccess(name, args);
    if (options.allowAsyncDispatch !== false && shouldRunToolAsync(name, args)) {
      const run = await startAsyncToolRun(name, args);
      return toolOk(run, `accepted async tool run: ${run.runId}`);
    }
    const deviceId =
      typeof args.deviceId === "string" && args.deviceId.length > 0
        ? args.deviceId
        : undefined;

    const run = async () => {
      throwIfAborted(options.signal);
      return await callTool(name, args, { signal: options.signal });
    };
    const execution = deviceId
      ? withDeviceLock(deviceId, run, { signal: options.signal })
      : run();
    const data = await withAbortSignal(execution, options.signal);
    return toolOk(data, "ok", extractToolArtifacts(data));
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      return toolError(error.message, error.code, error.data);
    }
    const message = error instanceof Error ? error.message : String(error);
    return toolError(message, classifyToolErrorCode(message));
  }
}

const routes = new Hono()
  .get("/mcp/status", (c) => {
    return c.json(mcpStatusResponse(c.req.url));
  })
  .put("/mcp/status", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!isRecord(body)) {
      return c.json({ error: "payload must be an object" }, 400);
    }

    const enabled = body.enabled;
    const showTargetedCapabilities = body.showTargetedCapabilities;

    if (
      typeof enabled !== "undefined" &&
      typeof enabled !== "boolean"
    ) {
      return c.json({ error: '"enabled" must be boolean' }, 400);
    }
    if (
      typeof showTargetedCapabilities !== "undefined" &&
      typeof showTargetedCapabilities !== "boolean"
    ) {
      return c.json({ error: '"showTargetedCapabilities" must be boolean' }, 400);
    }
    if (
      typeof enabled === "undefined" &&
      typeof showTargetedCapabilities === "undefined"
    ) {
      return c.json(
        { error: 'at least one of "enabled" or "showTargetedCapabilities" is required' },
        400,
      );
    }

    if (typeof enabled === "boolean") {
      setMCPEnabled(enabled);
    }
    if (typeof showTargetedCapabilities === "boolean") {
      setMCPShowTargetedCapabilities(showTargetedCapabilities);
    }

    return c.json(mcpStatusResponse(c.req.url));
  })
  .post("/mcp/token/rotate", (c) => {
    rotateMCPToken();
    return c.json(mcpStatusResponse(c.req.url));
  })
  .post("/mcp", async (c) => {
    const req = (await c.req.json().catch(() => null)) as JsonRpcRequest | null;

    if (!req || typeof req !== "object") {
      return c.json(jsonRpcErr(null, -32700, "Parse error"), 400);
    }

    const id: JsonRpcId = typeof req.id === "undefined" ? null : req.id;
    const config = getMCPConfig();

    if (!config.enabled) {
      return c.json(
        jsonRpcErr(id, -32000, "MCP is disabled. Enable it from Grapefruit UI first."),
        403,
      );
    }

    const authHeader = c.req.header("authorization");
    const token = parseBearer(authHeader);
    if (!authHeader) {
      recordAuthFailure(
        "missing_authorization_header",
        "Provide Authorization: Bearer <token> header in MCP client configuration.",
      );
      return c.json(jsonRpcErr(id, -32001, "Unauthorized MCP token"), 401);
    }
    if (!token) {
      recordAuthFailure(
        "invalid_authorization_header",
        'Authorization header must use "Bearer <token>" format.',
      );
      return c.json(jsonRpcErr(id, -32001, "Unauthorized MCP token"), 401);
    }
    if (!verifyMCPToken(token)) {
      recordAuthFailure(
        "token_mismatch",
        "Token mismatch. Rotate MCP token from Grapefruit UI and update client config.",
      );
      return c.json(jsonRpcErr(id, -32001, "Unauthorized MCP token"), 401);
    }
    clearAuthFailure();

    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return c.json(jsonRpcErr(id, -32600, "Invalid Request"), 400);
    }

    try {
      switch (req.method) {
        case "initialize":
          return c.json(
            jsonRpcOk(id, {
              protocolVersion: "2024-11-05",
              serverInfo: {
                name: "grapefruit-mcp",
                version: "0.1.0",
              },
              capabilities: {
                tools: {},
              },
            }),
          );
        case "notifications/initialized":
          return c.body(null, 204);
        case "ping":
          return c.json(jsonRpcOk(id, { ok: true }));
        case "tools/list":
          return c.json(jsonRpcOk(id, { tools: TOOL_SPECS }));
        case "tools/call": {
          const params = asObject(req.params, "params");
          const name = asString(params, "name");
          const args = params.arguments;
          const signal = createToolExecutionSignal(c.req.raw.signal);

          const result = await executeTool(name, args, { signal });
          const text = toolText(result);

          return c.json(
            jsonRpcOk(id, {
              content: [
                {
                  type: "text",
                  text,
                },
              ],
              structuredContent: result,
              isError: !result.ok,
            }),
          );
        }
        default:
          return c.json(
            jsonRpcErr(id, -32601, `Method not found: ${req.method}`),
            404,
          );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        jsonRpcErr(id, -32002, "Tool execution failed", { message }),
        500,
      );
    }
  });

export default routes;
