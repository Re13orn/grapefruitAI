import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import nodePath from "node:path";

import app from "../app.ts";
import paths from "../lib/paths.ts";
import { HookStore } from "../lib/store/hooks.ts";
import { CryptoStore } from "../lib/store/crypto.ts";
import { NSURLStore } from "../lib/store/nsurl.ts";
import { FlutterStore } from "../lib/store/flutter.ts";
import { JNIStore } from "../lib/store/jni.ts";
import { XPCStore } from "../lib/store/xpc.ts";
import { createTapStore } from "../lib/store/taps.ts";
import {
  createHookScriptStore,
  createHookScriptPresetStore,
  ensureBuiltinHookScripts,
} from "../lib/store/scripts.ts";
import {
  createScenarioStore,
  createScenarioRunStore,
} from "../lib/store/scenarios.ts";
import {
  getMCPConfig,
  rotateMCPToken,
  setMCPEnabled,
  setMCPShowTargetedCapabilities,
} from "../lib/mcp-config.ts";

const device = "test-device";
const identifier = "com.test.app";

function getStores() {
  return {
    hooks: new HookStore(device, identifier),
    crypto: new CryptoStore(device, identifier),
    nsurl: new NSURLStore(device, identifier),
    flutter: new FlutterStore(device, identifier),
    jni: new JNIStore(device, identifier),
    xpc: new XPCStore(device, identifier),
  };
}

describe("API tests", () => {
  it("should start http server", async () => {
    const r0 = await app.request("/api/version");
    const version = await r0.json();
    console.debug("version", version);
    assert("frida" in version);
    assert("igf" in version);

    const r1 = await app.request("/api/devices");
    const devices = await r1.json();
    console.debug("devices", devices);
    assert(Array.isArray(devices), "Devices should be an array");

    const udid = process.env.UDID;
    if (typeof udid !== "string") {
      console.warn("!! UDID env not set, skipping devices related tests");
      return;
    }

    const r2 = await app.request(`/api/device/${udid}/info`);
    const deviceInfo = (await r2.json()) as object;
    console.debug("deviceInfo", deviceInfo);
    assert("name" in deviceInfo);
    assert("platform" in deviceInfo);
    assert("arch" in deviceInfo);

    const r3 = await app.request(`/api/device/${udid}/apps`);
    const apps = await r3.json();
    console.debug("apps", apps.slice(0, 10));
    assert(Array.isArray(apps), "Apps should be an array");

    const r4 = await app.request(`/api/device/${udid}/processes`);
    const processes = (await r4.json()) as { name: string; pid: number }[];
    console.debug("processes", processes.slice(0, 10));
    assert(Array.isArray(processes), "Processes should be an array");
    if (processes.length > 0) {
      assert("name" in processes[0], "Process should have name");
      assert("pid" in processes[0], "Process should have pid");
    }
  });

  it("should return error for non-existent device", async () => {
    const r = await app.request("/api/device/nonexistent-device/apps");
    // Note: getDeviceMiddleware throws when device is not found, resulting in 500
    assert(
      r.status === 404 || r.status === 500,
      "Should return 404 or 500 for non-existent device",
    );
  });

  it("should return 404 for missing device param", async () => {
    const r = await app.request("/api/device//apps");
    assert.strictEqual(r.status, 404);
  });

  it("should handle remote device management", async () => {
    // Test adding a remote device
    const r1 = await app.request("/api/devices/remote/invalid-hostname", {
      method: "PUT",
    });
    // PUT returns 204 on success
    assert(
      r1.status === 204 || r1.status === 200 || r1.status >= 400,
      "PUT should return appropriate status",
    );

    // Test removing a non-existent remote device
    const r2 = await app.request("/api/devices/remote/nonexistent", {
      method: "DELETE",
    });
    assert.strictEqual(
      r2.status,
      404,
      "DELETE should return 404 for non-existent device",
    );
  });

  it("should return 404 for non-existent app icon", async () => {
    const udid = process.env.UDID;
    if (!udid) {
      console.warn("Skipping icon test: UDID environment variable not set");
      return;
    }

    const r = await app.request(
      `/api/device/${udid}/icon/com.nonexistent.bundle`,
    );
    assert.strictEqual(r.status, 404, "Should return 404 for non-existent app");
  });

  it("should handle download request validation", async () => {
    const udid = process.env.UDID;
    if (!udid) {
      console.warn("Skipping download test: UDID environment variable not set");
      return;
    }

    // Test missing path parameter
    const r1 = await app.request(`/api/download/${udid}/1234`);
    assert.strictEqual(r1.status, 400, "Should return 400 for missing path");

    // Test range request not implemented
    const r2 = await app.request(`/api/download/${udid}/1234?path=/test`, {
      headers: { Range: "bytes=0-100" },
    });
    assert.strictEqual(r2.status, 501, "Should return 501 for range requests");
  });

  it("should handle upload request validation", async () => {
    const udid = process.env.UDID;
    if (!udid) {
      console.warn("Skipping upload test: UDID environment variable not set");
      return;
    }

    // Test missing path parameter
    const r1 = await app.request(`/api/upload/${udid}/1234`, {
      method: "POST",
    });
    assert.strictEqual(r1.status, 400, "Should return 400 for missing path");
  });
});

describe("MCP API", () => {
  async function mcpCall(token: string, id: number, method: string, params?: unknown) {
    return await app.request("/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }),
    });
  }

  it("should expose mcp status", async () => {
    const r = await app.request("/api/mcp/status");
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(typeof body.enabled, "boolean");
    assert.strictEqual(typeof body.showTargetedCapabilities, "boolean");
    assert.strictEqual(typeof body.endpoint, "string");
    assert.strictEqual(typeof body.token, "string");
    assert.strictEqual(typeof body.tokenEnvVar, "string");
    assert.strictEqual(typeof body.codexAddCommand, "string");
    assert.strictEqual(
      body.claudeConfigSnippet?.mcpServers?.grapefruit?.type,
      "http",
    );
    assert.strictEqual(
      body.antigravityConfigSnippet?.mcpServers?.grapefruit?.command,
      "npx",
    );
    assert.strictEqual(
      body.configSnippet?.mcpServers?.grapefruit?.type,
      "http",
    );
  });

  it("should update targeted capability visibility in mcp status", async () => {
    setMCPEnabled(true);
    setMCPShowTargetedCapabilities(false);

    const r = await app.request("/api/mcp/status", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        showTargetedCapabilities: true,
      }),
    });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.showTargetedCapabilities, true);

    const r2 = await app.request("/api/mcp/status");
    assert.strictEqual(r2.status, 200);
    const body2 = await r2.json();
    assert.strictEqual(body2.showTargetedCapabilities, true);

    setMCPShowTargetedCapabilities(false);
  });

  it("should require token for /api/mcp", async () => {
    setMCPEnabled(true);
    const r = await app.request("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    assert.strictEqual(r.status, 401);
  });

  it("should list tools with valid token", async () => {
    setMCPEnabled(true);
    const token = getMCPConfig().token;
    const r = await mcpCall(token, 2, "tools/list");

    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.jsonrpc, "2.0");
    assert(Array.isArray(body.result.tools));
    assert(body.result.tools.length > 0);

    const names = body.result.tools.map((tool: { name: string }) => tool.name);
    assert(names.includes("launch_app"));
    assert(names.includes("stop_app"));
    assert(names.includes("tap"));
    assert(names.includes("input_text"));
    assert(names.includes("swipe"));
    assert(names.includes("back"));
    assert(names.includes("home"));
    assert(names.includes("wait_for"));
    assert(names.includes("get_tool_run"));
    assert(names.includes("cancel_tool_run"));
    assert(names.includes("list_scenario_templates"));
    assert(names.includes("import_scenario_template"));
    assert(names.includes("import_all_scenario_templates"));
    assert(names.includes("get_script_apply_acks"));
    assert(names.includes("list_hook_packs"));
    assert(names.includes("list_rulesets"));
    assert(names.includes("create_test_plan"));
    assert(names.includes("run_test_plan"));
    assert(names.includes("snapshot_ui"));
    assert(names.includes("acquire_device_lock"));
    assert(names.includes("get_platform_capabilities"));
  });

  it("should return unified envelope for tools/call success", async () => {
    setMCPEnabled(true);
    const token = getMCPConfig().token;
    const r = await app.request("/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "list_devices",
          arguments: {},
        },
      }),
    });

    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.result.isError, false);
    assert.strictEqual(body.result.structuredContent.status, "ok");
    assert.strictEqual(body.result.structuredContent.ok, true);
    assert.strictEqual(body.result.structuredContent.code, "OK");
    assert.strictEqual(typeof body.result.structuredContent.message, "string");
    assert("data" in body.result.structuredContent);
    assert(Array.isArray(body.result.structuredContent.artifacts));
  });

  it("should return unified envelope for tools/call errors", async () => {
    setMCPEnabled(true);
    const token = getMCPConfig().token;
    const r = await app.request("/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "unknown_tool",
          arguments: {},
        },
      }),
    });

    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.result.isError, true);
    assert.strictEqual(body.result.structuredContent.status, "error");
    assert.strictEqual(body.result.structuredContent.ok, false);
    assert.strictEqual(body.result.structuredContent.code, "NOT_FOUND");
    assert(Array.isArray(body.result.structuredContent.artifacts));
  });

  it("should dispatch long tools asynchronously by default", async () => {
    setMCPEnabled(true);
    const token = getMCPConfig().token;
    const startRes = await mcpCall(token, 5, "tools/call", {
      name: "wait_for",
      arguments: {
        deviceId: device,
        ms: 60_000,
      },
    });
    assert.strictEqual(startRes.status, 200);
    const startBody = await startRes.json();
    assert.strictEqual(startBody.result.structuredContent.ok, true);
    const started = startBody.result.structuredContent.data as {
      runId: string;
      status: string;
    };
    assert.strictEqual(typeof started.runId, "string");
    assert.strictEqual(started.status, "accepted");

    const cancelRes = await mcpCall(token, 6, "tools/call", {
      name: "cancel_tool_run",
      arguments: {
        runId: started.runId,
      },
    });
    assert.strictEqual(cancelRes.status, 200);
    const cancelBody = await cancelRes.json();
    assert.strictEqual(cancelBody.result.structuredContent.ok, true);

    let canceled = false;
    for (let i = 0; i < 40; i++) {
      const pollRes = await mcpCall(token, 20 + i, "tools/call", {
        name: "get_tool_run",
        arguments: {
          runId: started.runId,
        },
      });
      assert.strictEqual(pollRes.status, 200);
      const pollBody = await pollRes.json();
      const run = pollBody.result.structuredContent.data as {
        status: string;
        done: boolean;
      };
      if (run.status === "canceled") {
        canceled = true;
        break;
      }
      if (run.done && run.status !== "canceling") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.strictEqual(canceled, true);
  });

  it("should enforce session state CAS for session writes", async () => {
    setMCPEnabled(true);
    const token = getMCPConfig().token;

    const stateRes = await mcpCall(token, 7, "tools/call", {
      name: "get_session_state",
      arguments: {
        deviceId: device,
        bundle: "com.test.session",
      },
    });
    assert.strictEqual(stateRes.status, 200);
    const stateBody = await stateRes.json();
    assert.strictEqual(stateBody.result.structuredContent.ok, true);
    assert.strictEqual(
      typeof stateBody.result.structuredContent.data.state.version,
      "number",
    );
    assert.strictEqual(
      stateBody.result.structuredContent.data.state.status,
      "idle",
    );

    const recoverRes = await mcpCall(token, 8, "tools/call", {
      name: "recover_session",
      arguments: {
        deviceId: device,
        bundle: "com.test.session",
        platform: "droid",
        mode: "daemon",
        pid: 1,
        expectedState: "attached",
        sync: true,
      },
    });
    assert.strictEqual(recoverRes.status, 200);
    const recoverBody = await recoverRes.json();
    assert.strictEqual(recoverBody.result.structuredContent.ok, false);
    assert.strictEqual(
      recoverBody.result.structuredContent.code,
      "STATE_CONFLICT",
    );
  });

  it("should return structured script apply acknowledgements", async () => {
    setMCPEnabled(true);
    const token = getMCPConfig().token;
    const store = new HookStore(device, identifier);
    store.rm();

    store.append({
      category: "script.apply.ack",
      symbol: "startup:root-bypass",
      dir: "leave",
      line: "script_apply_ack startup:root-bypass source=startup compileOk=true",
      extra: {
        source: "startup",
        compileOk: true,
        hookedMethods: 3,
        failedMethods: [],
        durationMs: 8,
        pid: 1234,
        sessionId: "sess-1",
      },
    });
    store.append({
      category: "script.apply.ack",
      symbol: "manual:test-fail",
      dir: "leave",
      line: "script_apply_ack manual:test-fail source=manual compileOk=false",
      extra: {
        source: "manual",
        compileOk: false,
        hookedMethods: 0,
        failedMethods: ["A.b"],
        error: "compile error",
        pid: 1234,
        sessionId: "sess-1",
      },
    });

    const r = await mcpCall(token, 81, "tools/call", {
      name: "get_script_apply_acks",
      arguments: {
        deviceId: device,
        identifier,
        sessionId: "sess-1",
      },
    });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.result.structuredContent.ok, true);
    const data = body.result.structuredContent.data as {
      total: number;
      summary: { success: number; failed: number; withHooks: number };
      logs: Array<{
        scriptName: string;
        compileOk: boolean;
        hookedMethods: number;
        source: string;
      }>;
    };
    assert.strictEqual(data.total, 2);
    assert.strictEqual(data.summary.success, 1);
    assert.strictEqual(data.summary.failed, 1);
    assert.strictEqual(data.summary.withHooks, 1);
    assert.strictEqual(data.logs.length, 2);
    assert(
      data.logs.some(
        (item) =>
          item.scriptName === "startup:root-bypass" &&
          item.source === "startup" &&
          item.compileOk === true &&
          item.hookedMethods === 3,
      ),
    );
    assert(
      data.logs.some(
        (item) =>
          item.scriptName === "manual:test-fail" &&
          item.source === "manual" &&
          item.compileOk === false &&
          item.hookedMethods === 0,
      ),
    );

    store.rm();
  });

  it("should rotate token", async () => {
    const before = getMCPConfig().token;
    rotateMCPToken();
    const after = getMCPConfig().token;
    assert.notStrictEqual(before, after);
  });

  it("should support hook packs, rulesets, and test plans", async () => {
    setMCPEnabled(true);
    const token = getMCPConfig().token;
    const testIdentifier = `${identifier}.mcp`;

    const scenarios = createScenarioStore(device, testIdentifier);
    scenarios.clear();
    createScenarioRunStore(device, testIdentifier).clear();
    const scenario = scenarios.create({
      name: "MCP test scenario",
      steps: [{ id: "s1", type: "note", text: "hello" }],
    });

    const packsRes = await mcpCall(token, 10, "tools/call", {
      name: "list_hook_packs",
      arguments: {},
    });
    assert.strictEqual(packsRes.status, 200);
    const packsBody = await packsRes.json();
    assert.strictEqual(packsBody.result.structuredContent.ok, true);

    const rulesRes = await mcpCall(token, 11, "tools/call", {
      name: "list_rulesets",
      arguments: {},
    });
    assert.strictEqual(rulesRes.status, 200);
    const rulesBody = await rulesRes.json();
    assert.strictEqual(rulesBody.result.structuredContent.ok, true);
    const rules = rulesBody.result.structuredContent.data as Array<{ id: string }>;
    assert(rules.length > 0);

    const enableRes = await mcpCall(token, 12, "tools/call", {
      name: "enable_ruleset",
      arguments: {
        deviceId: device,
        identifier: testIdentifier,
        rulesetIds: [rules[0]!.id],
      },
    });
    assert.strictEqual(enableRes.status, 200);
    const enableBody = await enableRes.json();
    assert.strictEqual(enableBody.result.structuredContent.ok, true);

    const createPlanRes = await mcpCall(token, 13, "tools/call", {
      name: "create_test_plan",
      arguments: {
        deviceId: device,
        identifier: testIdentifier,
        plan: {
          name: "MCP test plan",
          scenarioIds: [scenario.id],
          rulesetIds: [rules[0]!.id],
        },
      },
    });
    assert.strictEqual(createPlanRes.status, 200);
    const createPlanBody = await createPlanRes.json();
    assert.strictEqual(createPlanBody.result.structuredContent.ok, true);
    const plan = createPlanBody.result.structuredContent.data as { id: string };
    assert.strictEqual(typeof plan.id, "string");

    const runRes = await mcpCall(token, 14, "tools/call", {
      name: "run_test_plan",
      arguments: {
        deviceId: device,
        identifier: testIdentifier,
        planId: plan.id,
      },
    });
    assert.strictEqual(runRes.status, 200);
    const runBody = await runRes.json();
    assert.strictEqual(runBody.result.structuredContent.ok, true);
    const run = runBody.result.structuredContent.data as { id: string };
    assert.strictEqual(typeof run.id, "string");

    let done = false;
    for (let i = 0; i < 20; i++) {
      const getRunRes = await mcpCall(token, 15 + i, "tools/call", {
        name: "get_test_run",
        arguments: {
          deviceId: device,
          identifier: testIdentifier,
          runId: run.id,
        },
      });
      const getRunBody = await getRunRes.json();
      const status = getRunBody.result.structuredContent.data.status as string;
      if (!["queued", "running", "canceling"].includes(status)) {
        done = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.strictEqual(done, true);

    const artifactsRes = await mcpCall(token, 40, "tools/call", {
      name: "list_artifacts",
      arguments: {
        deviceId: device,
        identifier: testIdentifier,
      },
    });
    assert.strictEqual(artifactsRes.status, 200);
    const artifactsBody = await artifactsRes.json();
    assert.strictEqual(artifactsBody.result.structuredContent.ok, true);
  });

  it("should keep list_hook_packs generic by default", async () => {
    setMCPEnabled(true);
    const token = getMCPConfig().token;

    const baseRes = await mcpCall(token, 70, "tools/call", {
      name: "list_hook_packs",
      arguments: { platform: "droid" },
    });
    assert.strictEqual(baseRes.status, 200);
    const baseBody = await baseRes.json();
    assert.strictEqual(baseBody.result.structuredContent.ok, true);
    const basePacks = baseBody.result.structuredContent.data as Array<{
      id: string;
      scope: string;
    }>;
    assert(basePacks.every((pack) => pack.scope !== "targeted"));
    assert(basePacks.every((pack) => !pack.id.includes("uncrackable1")));

    const targetedRes = await mcpCall(token, 71, "tools/call", {
      name: "list_hook_packs",
      arguments: {
        platform: "droid",
        includeTargeted: true,
      },
    });
    assert.strictEqual(targetedRes.status, 200);
    const targetedBody = await targetedRes.json();
    assert.strictEqual(targetedBody.result.structuredContent.ok, true);
    const targetedPacks = targetedBody.result.structuredContent.data as Array<{
      id: string;
      scope: string;
    }>;
    assert(targetedPacks.some((pack) => pack.scope === "targeted"));
    assert(targetedPacks.some((pack) => pack.id.includes("uncrackable1")));
  });

  it("should list and import scenario templates via MCP", async () => {
    setMCPEnabled(true);
    const token = getMCPConfig().token;
    const testIdentifier = `${identifier}.scenario-template-mcp`;
    createScenarioStore(device, testIdentifier).clear();
    createScenarioRunStore(device, testIdentifier).clear();

    const listRes = await mcpCall(token, 301, "tools/call", {
      name: "list_scenario_templates",
      arguments: {},
    });
    assert.strictEqual(listRes.status, 200);
    const listBody = await listRes.json();
    assert.strictEqual(listBody.result.structuredContent.ok, true);
    const templates = listBody.result.structuredContent.data as Array<{ id: string }>;
    assert(templates.length > 0);

    const templateId = templates[0]!.id;
    const importRes = await mcpCall(token, 302, "tools/call", {
      name: "import_scenario_template",
      arguments: {
        deviceId: device,
        identifier: testIdentifier,
        templateId,
      },
    });
    assert.strictEqual(importRes.status, 200);
    const importBody = await importRes.json();
    assert.strictEqual(importBody.result.structuredContent.ok, true);
    const importData = importBody.result.structuredContent.data as {
      action: string;
      scenario: { id: string; tags: string[] };
    };
    assert.strictEqual(importData.action, "created");
    assert.strictEqual(typeof importData.scenario.id, "string");
    assert(importData.scenario.tags.includes(`template:${templateId}`));

    const importAllRes = await mcpCall(token, 303, "tools/call", {
      name: "import_all_scenario_templates",
      arguments: {
        deviceId: device,
        identifier: testIdentifier,
      },
    });
    assert.strictEqual(importAllRes.status, 200);
    const importAllBody = await importAllRes.json();
    assert.strictEqual(importAllBody.result.structuredContent.ok, true);
    const importAllData = importAllBody.result.structuredContent.data as {
      total: number;
      created: string[];
      skipped: string[];
    };
    assert(importAllData.total > 0);
    assert(importAllData.created.length + importAllData.skipped.length > 0);
  });

  it("should expose generic-first platform capabilities", async () => {
    setMCPEnabled(true);
    const token = getMCPConfig().token;
    const r = await mcpCall(token, 320, "tools/call", {
      name: "get_platform_capabilities",
      arguments: {},
    });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.result.structuredContent.ok, true);
    const data = body.result.structuredContent.data as {
      genericFirst: boolean;
      hooks: { hookPacks: Array<{ scope: string }> };
    };
    assert.strictEqual(data.genericFirst, true);
    assert(data.hooks.hookPacks.every((item) => item.scope !== "targeted"));
  });

  it("should keep device queue runnable after a failed task", async () => {
    setMCPEnabled(true);
    const token = getMCPConfig().token;
    const testIdentifier = `${identifier}.queue-resilience`;
    createScenarioStore(device, testIdentifier).clear();

    const failedRes = await mcpCall(token, 350, "tools/call", {
      name: "import_scenario_template",
      arguments: {
        deviceId: device,
        identifier: testIdentifier,
        templateId: "not-exists-template",
      },
    });
    assert.strictEqual(failedRes.status, 200);
    const failedBody = await failedRes.json();
    assert.strictEqual(failedBody.result.structuredContent.ok, false);

    const nextRes = await mcpCall(token, 351, "tools/call", {
      name: "list_test_scenarios",
      arguments: {
        deviceId: device,
        identifier: testIdentifier,
      },
    });
    assert.strictEqual(nextRes.status, 200);
    const nextBody = await nextRes.json();
    assert.strictEqual(nextBody.result.structuredContent.ok, true);
    assert(Array.isArray(nextBody.result.structuredContent.data));
  });
});

describe("Scenario DSL API", () => {
  afterEach(() => {
    createScenarioStore(device, identifier).clear();
    createScenarioRunStore(device, identifier).clear();
    getStores().hooks.rm();
  });

  it("should create and list scenarios", async () => {
    const payload = {
      name: "Crypto smoke",
      tags: ["smoke", "crypto"],
      steps: [
        {
          type: "note",
          text: "start",
        },
        {
          type: "assert",
          assertion: {
            type: "history_count",
            kind: "hooks",
            op: "eq",
            value: 0,
          },
        },
      ],
    };

    const r0 = await app.request(`/api/scenarios/${device}/${identifier}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(r0.status, 201);
    const created = await r0.json();
    assert(created.id);
    assert.strictEqual(created.name, payload.name);

    const r1 = await app.request(`/api/scenarios/${device}/${identifier}`);
    assert.strictEqual(r1.status, 200);
    const list = await r1.json();
    assert(Array.isArray(list));
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, payload.name);
  });

  it("should run scenario and persist run result", async () => {
    const stores = getStores();
    stores.hooks.append({
      category: "crypto",
      symbol: "Cipher.doFinal",
      dir: "leave",
      line: "Cipher.doFinal() => ...",
      extra: { algo: "AES/GCM/NoPadding" },
    });

    const createRes = await app.request(`/api/scenarios/${device}/${identifier}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Hook assertion",
        steps: [
          {
            type: "assert",
            assertion: {
              type: "history_count",
              kind: "hooks",
              op: "gte",
              value: 1,
            },
          },
          {
            type: "assert",
            assertion: {
              type: "history_contains",
              kind: "hooks",
              keyword: "Cipher.doFinal",
            },
          },
        ],
      }),
    });
    const scenario = await createRes.json();

    const runRes = await app.request(
      `/api/scenarios/${device}/${identifier}/${scenario.id}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stopOnFailure: true }),
      },
    );
    assert.strictEqual(runRes.status, 200);
    const run = await runRes.json();
    assert.strictEqual(run.status, "passed");
    assert.strictEqual(run.assertionsTotal, 2);
    assert.strictEqual(run.assertionsFailed, 0);
    assert(Array.isArray(run.stepResults));
    assert.strictEqual(run.stepResults.length, 2);

    const listRunsRes = await app.request(`/api/scenario-runs/${device}/${identifier}`);
    assert.strictEqual(listRunsRes.status, 200);
    const runs = await listRunsRes.json();
    assert(Array.isArray(runs));
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].scenarioId, scenario.id);
  });

  it("should list and import scenario templates", async () => {
    const listRes = await app.request("/api/scenario-templates");
    assert.strictEqual(listRes.status, 200);
    const templates = await listRes.json();
    assert(Array.isArray(templates));
    assert(templates.length > 0);
    assert.strictEqual(typeof templates[0].id, "string");

    const importOneRes = await app.request(
      `/api/scenarios/${device}/${identifier}/import-template`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateId: templates[0].id,
        }),
      },
    );
    assert.strictEqual(importOneRes.status, 201);
    const imported = await importOneRes.json();
    assert.strictEqual(imported.templateId, templates[0].id);
    assert.strictEqual(imported.action, "created");
    assert(Array.isArray(imported.scenario.tags));
    assert(imported.scenario.tags.includes(`template:${templates[0].id}`));

    const importAllRes = await app.request(
      `/api/scenarios/${device}/${identifier}/import-templates`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.strictEqual(importAllRes.status, 200);
    const summary = await importAllRes.json();
    assert(summary.total >= templates.length);
    assert(Array.isArray(summary.created));
    assert(Array.isArray(summary.skipped));
  });

  it("should support script_applied assertion", async () => {
    const stores = getStores();
    stores.hooks.append({
      category: "script.apply.ack",
      symbol: "startup:uncrackable1-root-bypass",
      dir: "leave",
      line: "script_apply_ack startup:uncrackable1-root-bypass source=startup compileOk=true hookedMethods=4",
      extra: {
        source: "startup",
        compileOk: true,
        hookedMethods: 4,
        failedMethods: [],
        sessionId: "sess-script",
        pid: 1337,
      },
    });

    const createRes = await app.request(`/api/scenarios/${device}/${identifier}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Script apply assertion",
        steps: [
          {
            type: "assert",
            assertion: {
              type: "script_applied",
              scriptName: "uncrackable1-root-bypass",
              source: "startup",
              compileOk: true,
              minHookedMethods: 1,
              sessionId: "sess-script",
              pid: 1337,
            },
          },
        ],
      }),
    });
    assert.strictEqual(createRes.status, 201);
    const scenario = await createRes.json();

    const runRes = await app.request(
      `/api/scenarios/${device}/${identifier}/${scenario.id}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stopOnFailure: true }),
      },
    );
    assert.strictEqual(runRes.status, 200);
    const run = await runRes.json();
    assert.strictEqual(run.status, "passed");
    assert.strictEqual(run.assertionsTotal, 1);
    assert.strictEqual(run.assertionsFailed, 0);
  });

  it("should mark scenario run as failed when assertion fails", async () => {
    const createRes = await app.request(`/api/scenarios/${device}/${identifier}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Failing assertion",
        steps: [
          {
            type: "assert",
            assertion: {
              type: "history_count",
              kind: "hooks",
              op: "gt",
              value: 99,
            },
          },
        ],
      }),
    });
    const scenario = await createRes.json();

    const runRes = await app.request(
      `/api/scenarios/${device}/${identifier}/${scenario.id}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stopOnFailure: true }),
      },
    );
    assert.strictEqual(runRes.status, 200);
    const run = await runRes.json();
    assert.strictEqual(run.status, "failed");
    assert.strictEqual(run.assertionsFailed, 1);
  });
});

describe("Logs API", () => {
  const logsDir = nodePath.join(paths.data, "logs", device, identifier);

  afterEach(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
  });

  it("should reject invalid log type", async () => {
    const r = await app.request(`/api/logs/${device}/${identifier}/invalid`);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(await r.text(), "invalid log type");
  });

  it("should return empty string for missing log file", async () => {
    const r = await app.request(`/api/logs/${device}/${identifier}/syslog`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await r.text(), "");
  });

  it("should return syslog content", async () => {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(
      nodePath.join(logsDir, "syslog.log"),
      "line1\nline2\nline3\n",
    );

    const r = await app.request(`/api/logs/${device}/${identifier}/syslog`);
    assert.strictEqual(r.status, 200);
    const text = await r.text();
    assert(text.includes("line1"));
    assert(text.includes("line3"));
  });

  it("should return agent log content", async () => {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(nodePath.join(logsDir, "agent.log"), "[info] hello\n");

    const r = await app.request(`/api/logs/${device}/${identifier}/agent`);
    assert.strictEqual(r.status, 200);
    assert(await r.text(), "[info] hello");
  });

  it("should return full content for small files", async () => {
    await fs.mkdir(logsDir, { recursive: true });
    const lines =
      Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n") + "\n";
    await fs.writeFile(nodePath.join(logsDir, "syslog.log"), lines);

    const r = await app.request(`/api/logs/${device}/${identifier}/syslog`);
    const text = await r.text();
    const returned = text.split("\n").filter(Boolean);
    assert.strictEqual(returned.length, 10);
    assert.strictEqual(returned[0], "line0");
  });

  it("should delete logs directory", async () => {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(nodePath.join(logsDir, "syslog.log"), "data\n");

    const r = await app.request(`/api/logs/${device}/${identifier}`, {
      method: "DELETE",
    });
    assert.strictEqual(r.status, 204);

    const exists = await fs.access(logsDir).then(
      () => true,
      () => false,
    );
    assert.strictEqual(exists, false);
  });
});

describe("Hooks API", () => {
  afterEach(() => {
    getStores().hooks.rm();
  });

  it("should return empty hooks list", async () => {
    const r = await app.request(`/api/hooks/${device}/${identifier}`);
    assert.strictEqual(r.status, 200);
    const body = (await r.json()) as {
      hooks: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    assert.deepStrictEqual(body.hooks, []);
    assert.strictEqual(body.total, 0);
    assert.strictEqual(body.limit, 1000);
    assert.strictEqual(body.offset, 0);
  });

  it("should return inserted hooks", async () => {
    const { hooks: hookStore } = getStores();
    hookStore.append({
      category: "network",
      symbol: "send",
      dir: "out",
    });
    hookStore.append({
      category: "crypto",
      symbol: "encrypt",
      dir: "in",
    });

    const r = await app.request(`/api/hooks/${device}/${identifier}`);
    const body = (await r.json()) as { hooks: any[]; total: number };
    assert.strictEqual(body.total, 2);
    assert.strictEqual(body.hooks.length, 2);
    // newest first
    assert.strictEqual(body.hooks[0].category, "crypto");
    assert.strictEqual(body.hooks[1].category, "network");
    assert.strictEqual(body.hooks[0].symbol, "encrypt");
    assert.strictEqual(body.hooks[0].direction, "in");
  });

  it("should return extra as parsed object", async () => {
    const { hooks: hookStore } = getStores();
    hookStore.append({
      category: "c",
      symbol: "s",
      dir: "out",
      extra: { key: "value", num: 42 },
    });

    const r = await app.request(`/api/hooks/${device}/${identifier}`);
    const body = (await r.json()) as { hooks: any[] };
    assert.strictEqual(typeof body.hooks[0].extra, "object");
    assert.strictEqual(body.hooks[0].extra.key, "value");
    assert.strictEqual(body.hooks[0].extra.num, 42);
  });

  it("should filter by category", async () => {
    const { hooks: hookStore } = getStores();
    hookStore.append({
      category: "network",
      symbol: "send",
      dir: "out",
    });
    hookStore.append({
      category: "crypto",
      symbol: "enc",
      dir: "in",
    });

    const r = await app.request(
      `/api/hooks/${device}/${identifier}?category=crypto`,
    );
    const body = (await r.json()) as { hooks: any[]; total: number };
    assert.strictEqual(body.total, 1);
    assert.strictEqual(body.hooks.length, 1);
    assert.strictEqual(body.hooks[0].category, "crypto");
  });

  it("should store and query flutter.channel hooks", async () => {
    const { hooks: hookStore } = getStores();
    hookStore.append({
      category: "flutter.channel",
      symbol: "flutter.method",
      dir: "leave",
      line: "plugins.flutter.io/share",
      extra: {
        type: "method",
        dir: "native",
        channel: "plugins.flutter.io/share",
        method: "share",
        args: { text: "hello" },
      },
    });

    const r = await app.request(
      `/api/hooks/${device}/${identifier}?category=flutter.channel`,
    );
    assert.strictEqual(r.status, 200);

    const body = (await r.json()) as { hooks: any[]; total: number };
    assert.strictEqual(body.total, 1);
    assert.strictEqual(body.hooks.length, 1);
    assert.strictEqual(body.hooks[0].category, "flutter.channel");
    assert.strictEqual(body.hooks[0].extra.channel, "plugins.flutter.io/share");
    assert.strictEqual(body.hooks[0].extra.method, "share");
  });

  it("should paginate with limit and offset", async () => {
    const { hooks: hookStore } = getStores();
    for (let i = 0; i < 5; i++) {
      hookStore.append({
        category: "c",
        symbol: `s${i}`,
        dir: "out",
      });
    }

    const r = await app.request(
      `/api/hooks/${device}/${identifier}?limit=2&offset=1`,
    );
    const body = (await r.json()) as {
      hooks: any[];
      total: number;
      limit: number;
      offset: number;
    };
    assert.strictEqual(body.hooks.length, 2);
    assert.strictEqual(body.limit, 2);
    assert.strictEqual(body.offset, 1);
    assert.strictEqual(body.total, 5);
  });

  it("should clear hooks", async () => {
    const { hooks: hookStore } = getStores();
    hookStore.append({
      category: "c",
      symbol: "s",
      dir: "out",
    });

    const r = await app.request(`/api/hooks/${device}/${identifier}`, {
      method: "DELETE",
    });
    assert.strictEqual(r.status, 204);

    const r2 = await app.request(`/api/hooks/${device}/${identifier}`);
    const body = (await r2.json()) as { total: number };
    assert.strictEqual(body.total, 0);
  });

  it("should isolate hooks by device/identifier", async () => {
    const { hooks: hookStore } = getStores();
    hookStore.append({
      category: "c",
      symbol: "s",
      dir: "out",
    });

    const otherHooks = new HookStore(device, "com.other.app");
    otherHooks.append({
      category: "c",
      symbol: "s",
      dir: "out",
    });

    const r = await app.request(`/api/hooks/${device}/${identifier}`);
    const body = (await r.json()) as { total: number };
    assert.strictEqual(body.total, 1);

    // cleanup other
    otherHooks.rm();
  });
});

describe("Crypto Logs API", () => {
  afterEach(() => {
    getStores().crypto.rm();
  });

  it("should return empty crypto logs", async () => {
    const r = await app.request(`/api/history/crypto/${device}/${identifier}`);
    assert.strictEqual(r.status, 200);
    const body = (await r.json()) as { logs: unknown[]; total: number };
    assert.deepStrictEqual(body.logs, []);
    assert.strictEqual(body.total, 0);
  });

  it("should return inserted crypto logs", async () => {
    const { crypto: cryptoStore } = getStores();
    cryptoStore.append({
      symbol: "CCCrypt",
      dir: "encrypt",
    });
    cryptoStore.append({
      symbol: "SecKeyEncrypt",
      dir: "decrypt",
    });

    const r = await app.request(`/api/history/crypto/${device}/${identifier}`);
    const body = (await r.json()) as { logs: any[]; total: number };
    assert.strictEqual(body.total, 2);
    assert.strictEqual(body.logs.length, 2);
    // newest first
    assert.strictEqual(body.logs[0].symbol, "SecKeyEncrypt");
    assert.strictEqual(body.logs[1].symbol, "CCCrypt");
  });

  it("should return extra and backtrace as parsed objects", async () => {
    const { crypto: cryptoStore } = getStores();
    cryptoStore.append({
      symbol: "CCCrypt",
      dir: "encrypt",
      extra: { algo: "AES" },
      backtrace: ["0x1000", "0x2000"],
    });

    const r = await app.request(`/api/history/crypto/${device}/${identifier}`);
    const body = (await r.json()) as { logs: any[] };
    assert.strictEqual(typeof body.logs[0].extra, "object");
    assert.strictEqual(body.logs[0].extra.algo, "AES");
    assert(Array.isArray(body.logs[0].backtrace));
    assert.strictEqual(body.logs[0].backtrace[0], "0x1000");
  });

  it("should paginate crypto logs", async () => {
    const { crypto: cryptoStore } = getStores();
    for (let i = 0; i < 5; i++) {
      cryptoStore.append({ symbol: `sym${i}`, dir: "enc" });
    }

    const r = await app.request(
      `/api/history/crypto/${device}/${identifier}?limit=2&offset=1`,
    );
    const body = (await r.json()) as {
      logs: any[];
      total: number;
      limit: number;
      offset: number;
    };
    assert.strictEqual(body.logs.length, 2);
    assert.strictEqual(body.total, 5);
  });

  it("should clear crypto logs", async () => {
    const { crypto: cryptoStore } = getStores();
    cryptoStore.append({ symbol: "s", dir: "enc" });

    const r = await app.request(`/api/history/crypto/${device}/${identifier}`, {
      method: "DELETE",
    });
    assert.strictEqual(r.status, 204);

    const r2 = await app.request(`/api/history/crypto/${device}/${identifier}`);
    const body = (await r2.json()) as { total: number };
    assert.strictEqual(body.total, 0);
  });
});

describe("NSURL API", () => {
  afterEach(() => {
    getStores().nsurl.rm();
  });

  it("should return empty NSURL records", async () => {
    const r = await app.request(`/api/history/nsurl/${device}/${identifier}`);
    assert.strictEqual(r.status, 200);
    const body = (await r.json()) as { requests: unknown[]; total: number };
    assert.deepStrictEqual(body.requests, []);
    assert.strictEqual(body.total, 0);
  });

  it("should return upserted NSURL requests", async () => {
    const { nsurl: nsurlStore } = getStores();
    nsurlStore.upsert({
      event: "requestWillBeSent",
      requestId: "req-1",
      timestamp: 1000,
      request: { method: "GET", url: "https://example.com/api", headers: {} },
    });
    nsurlStore.upsert({
      event: "responseReceived",
      requestId: "req-1",
      timestamp: 1100,
      response: { statusCode: 200, mimeType: "application/json", expectedContentLength: 0, headers: {} },
    });

    const r = await app.request(`/api/history/nsurl/${device}/${identifier}`);
    const body = (await r.json()) as { requests: any[]; total: number };
    assert.strictEqual(body.total, 1);
    assert.strictEqual(body.requests[0].method, "GET");
    assert.strictEqual(body.requests[0].url, "https://example.com/api");
    assert.strictEqual(body.requests[0].statusCode, 200);
  });

  it("should clear NSURL records", async () => {
    const { nsurl: nsurlStore } = getStores();
    nsurlStore.upsert({
      event: "requestWillBeSent",
      requestId: "req-1",
      timestamp: 1000,
      request: { method: "POST", url: "https://example.com", headers: {} },
    });

    const r = await app.request(`/api/history/nsurl/${device}/${identifier}`, {
      method: "DELETE",
    });
    assert.strictEqual(r.status, 204);

    const r2 = await app.request(`/api/history/nsurl/${device}/${identifier}`);
    const body = (await r2.json()) as { total: number };
    assert.strictEqual(body.total, 0);
  });

  it("should isolate NSURL records by device/identifier", async () => {
    const { nsurl: nsurlStore } = getStores();
    nsurlStore.upsert({
      event: "requestWillBeSent",
      requestId: "req-1",
      timestamp: 1000,
      request: { method: "GET", url: "https://a.com", headers: {} },
    });

    const otherNsurl = new NSURLStore(device, "com.other.app");
    otherNsurl.upsert({
      event: "requestWillBeSent",
      requestId: "req-2",
      timestamp: 1000,
      request: { method: "GET", url: "https://b.com", headers: {} },
    });

    const r = await app.request(`/api/history/nsurl/${device}/${identifier}`);
    const body = (await r.json()) as { total: number };
    assert.strictEqual(body.total, 1);

    // cleanup other
    otherNsurl.rm();
  });
});

describe("Flutter Logs API", () => {
  afterEach(() => {
    getStores().flutter.rm();
  });

  it("should return empty flutter logs", async () => {
    const r = await app.request(`/api/history/flutter/${device}/${identifier}`);
    assert.strictEqual(r.status, 200);
    const body = (await r.json()) as { logs: unknown[]; total: number };
    assert.deepStrictEqual(body.logs, []);
    assert.strictEqual(body.total, 0);
  });

  it("should return inserted flutter logs", async () => {
    const { flutter: store } = getStores();
    store.append({
      type: "method",
      dir: "native",
      channel: "plugins.flutter.io/share",
      method: "share",
      args: { text: "hello" },
    });
    store.append({
      type: "event",
      dir: "dart",
      channel: "flutter/lifecycle",
    });

    const r = await app.request(`/api/history/flutter/${device}/${identifier}`);
    const body = (await r.json()) as { logs: any[]; total: number };
    assert.strictEqual(body.total, 2);
    assert.strictEqual(body.logs.length, 2);
    // newest first
    assert.strictEqual(body.logs[0].channel, "flutter/lifecycle");
    assert.strictEqual(body.logs[0].type, "event");
    assert.strictEqual(body.logs[1].channel, "plugins.flutter.io/share");
    assert.strictEqual(body.logs[1].data.method, "share");
    assert.strictEqual(body.logs[1].data.args.text, "hello");
  });

  it("should clear flutter logs", async () => {
    const { flutter: store } = getStores();
    store.append({
      type: "method",
      dir: "native",
      channel: "test/channel",
    });

    const r = await app.request(
      `/api/history/flutter/${device}/${identifier}`,
      {
        method: "DELETE",
      },
    );
    assert.strictEqual(r.status, 204);

    const r2 = await app.request(
      `/api/history/flutter/${device}/${identifier}`,
    );
    const body = (await r2.json()) as { total: number };
    assert.strictEqual(body.total, 0);
  });
});

describe("JNI Logs API", () => {
  afterEach(() => {
    getStores().jni.rm();
  });

  it("should return empty jni logs", async () => {
    const r = await app.request(`/api/history/jni/${device}/${identifier}`);
    assert.strictEqual(r.status, 200);
    const body = (await r.json()) as { logs: unknown[]; total: number };
    assert.deepStrictEqual(body.logs, []);
    assert.strictEqual(body.total, 0);
  });

  it("should return inserted jni logs", async () => {
    const { jni: store } = getStores();
    store.append({
      subject: "jni",
      type: "call",
      method: "GetStringUTFChars",
      callType: "JNIEnv",
      threadId: 1,
      args: ["0x1234"],
      ret: "hello",
      library: "libnative.so",
    });
    store.append({
      subject: "jni",
      type: "call",
      method: "FindClass",
      callType: "JNIEnv",
      threadId: 2,
      args: ["com/example/Test"],
      ret: "0x5678",
    });

    const r = await app.request(`/api/history/jni/${device}/${identifier}`);
    const body = (await r.json()) as { logs: any[]; total: number };
    assert.strictEqual(body.total, 2);
    assert.strictEqual(body.logs.length, 2);
    // newest first
    assert.strictEqual(body.logs[0].method, "FindClass");
    assert.strictEqual(body.logs[1].method, "GetStringUTFChars");
    assert.strictEqual(body.logs[1].library, "libnative.so");
  });

  it("should filter by method", async () => {
    const { jni: store } = getStores();
    store.append({
      subject: "jni",
      type: "call",
      method: "GetStringUTFChars",
      callType: "JNIEnv",
      threadId: 1,
      args: [],
      ret: "",
    });
    store.append({
      subject: "jni",
      type: "call",
      method: "FindClass",
      callType: "JNIEnv",
      threadId: 1,
      args: [],
      ret: "",
    });

    const r = await app.request(
      `/api/history/jni/${device}/${identifier}?method=FindClass`,
    );
    const body = (await r.json()) as { logs: any[]; total: number };
    assert.strictEqual(body.total, 1);
    assert.strictEqual(body.logs[0].method, "FindClass");
  });

  it("should clear jni logs", async () => {
    const { jni: store } = getStores();
    store.append({
      subject: "jni",
      type: "call",
      method: "FindClass",
      callType: "JNIEnv",
      threadId: 1,
      args: [],
      ret: "",
    });

    const r = await app.request(`/api/history/jni/${device}/${identifier}`, {
      method: "DELETE",
    });
    assert.strictEqual(r.status, 204);

    const r2 = await app.request(`/api/history/jni/${device}/${identifier}`);
    const body = (await r2.json()) as { total: number };
    assert.strictEqual(body.total, 0);
  });
});

describe("XPC Logs API", () => {
  afterEach(() => {
    getStores().xpc.rm();
  });

  it("should return empty xpc logs", async () => {
    const r = await app.request(`/api/history/xpc/${device}/${identifier}`);
    assert.strictEqual(r.status, 200);
    const body = (await r.json()) as { logs: unknown[]; total: number };
    assert.deepStrictEqual(body.logs, []);
    assert.strictEqual(body.total, 0);
  });

  it("should return inserted xpc logs", async () => {
    const { xpc: store } = getStores();
    store.append({
      event: "sent",
      dir: ">",
      name: "com.apple.springboard",
      peer: 42,
      message: { type: "xpc", key: "value" },
    });
    store.append({
      event: "received",
      dir: "<",
      name: "com.apple.cfprefsd",
      message: { type: "nsxpc", method: "getPrefs" },
    });

    const r = await app.request(`/api/history/xpc/${device}/${identifier}`);
    const body = (await r.json()) as { logs: any[]; total: number };
    assert.strictEqual(body.total, 2);
    assert.strictEqual(body.logs.length, 2);
    // newest first
    assert.strictEqual(body.logs[0].protocol, "nsxpc");
    assert.strictEqual(body.logs[0].service, "com.apple.cfprefsd");
    assert.strictEqual(body.logs[1].protocol, "xpc");
    assert.strictEqual(body.logs[1].peer, 42);
  });

  it("should filter by protocol", async () => {
    const { xpc: store } = getStores();
    store.append({
      event: "sent",
      dir: ">",
      message: { type: "xpc" },
    });
    store.append({
      event: "sent",
      dir: ">",
      message: { type: "nsxpc" },
    });

    const r = await app.request(
      `/api/history/xpc/${device}/${identifier}?protocol=nsxpc`,
    );
    const body = (await r.json()) as { logs: any[]; total: number };
    assert.strictEqual(body.total, 1);
    assert.strictEqual(body.logs[0].protocol, "nsxpc");
  });

  it("should clear xpc logs", async () => {
    const { xpc: store } = getStores();
    store.append({
      event: "sent",
      dir: ">",
      message: { type: "xpc" },
    });

    const r = await app.request(`/api/history/xpc/${device}/${identifier}`, {
      method: "DELETE",
    });
    assert.strictEqual(r.status, 204);

    const r2 = await app.request(`/api/history/xpc/${device}/${identifier}`);
    const body = (await r2.json()) as { total: number };
    assert.strictEqual(body.total, 0);
  });
});

describe("Taps API", () => {
  afterEach(() => {
    createTapStore(device, identifier).clear();
  });

  it("should return null for empty taps", async () => {
    const r = await app.request(`/api/taps/${device}/${identifier}`);
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body, null);
  });

  it("should return saved taps", async () => {
    const store = createTapStore(device, identifier);
    const rules = [
      { type: "builtin" as const, id: "crypto" },
      {
        type: "objc" as const,
        cls: "NSURLSession",
        sel: "dataTaskWithRequest:",
      },
    ];
    store.save(rules);

    const r = await app.request(`/api/taps/${device}/${identifier}`);
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.length, 2);
    assert.strictEqual(body[0].type, "builtin");
    assert.strictEqual(body[0].id, "crypto");
    assert.strictEqual(body[1].type, "objc");
    assert.strictEqual(body[1].cls, "NSURLSession");
  });

  it("should clear taps", async () => {
    const store = createTapStore(device, identifier);
    store.save([{ type: "builtin" as const, id: "crypto" }]);

    const r = await app.request(`/api/taps/${device}/${identifier}`, {
      method: "DELETE",
    });
    assert.strictEqual(r.status, 204);

    const r2 = await app.request(`/api/taps/${device}/${identifier}`);
    const body = await r2.json();
    assert.strictEqual(body, null);
  });
});

describe("Hook Scripts API", () => {
  afterEach(() => {
    createHookScriptStore(device, identifier).clear();
    createHookScriptPresetStore(device, identifier).clear();
  });

  it("should return empty script list", async () => {
    const r = await app.request(`/api/scripts/${device}/${identifier}`);
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.deepStrictEqual(body, []);
  });

  it("should list builtin script templates for platform", async () => {
    const r0 = await app.request(
      `/api/script-templates/droid?device=${device}&identifier=${identifier}`,
    );
    assert.strictEqual(r0.status, 200);
    const templates0 = (await r0.json()) as Array<{
      id: string;
      name: string;
      recommended: boolean;
      imported: boolean;
    }>;
    const target = templates0.find(
      (item) => item.id === "builtin-uncrackable1-root-bypass",
    );
    const adaptive = templates0.find(
      (item) => item.id === "builtin-android-adaptive-root-debug-bypass",
    );
    assert(adaptive);
    assert.strictEqual(target, undefined);
    assert.strictEqual(adaptive.recommended, false);
    assert.strictEqual(adaptive.imported, false);

    const store = createHookScriptStore(device, identifier);
    store.create({
      name: adaptive.name,
      content: "/* local */",
      enabled: true,
      runOnAppLaunch: true,
    });

    const r1 = await app.request(
      `/api/script-templates/droid?device=${device}&identifier=${identifier}`,
    );
    assert.strictEqual(r1.status, 200);
    const templates1 = (await r1.json()) as Array<{
      id: string;
      imported: boolean;
    }>;
    const target1 = templates1.find(
      (item) => item.id === "builtin-uncrackable1-root-bypass",
    );
    const adaptive1 = templates1.find(
      (item) => item.id === "builtin-android-adaptive-root-debug-bypass",
    );
    assert(adaptive1);
    assert.strictEqual(target1, undefined);
    assert.strictEqual(adaptive1.imported, true);

    const targetIdentifier = "owasp.mstg.uncrackable1";
    const r2 = await app.request(
      `/api/script-templates/droid?device=${device}&identifier=${targetIdentifier}`,
    );
    assert.strictEqual(r2.status, 200);
    const templates2 = (await r2.json()) as Array<{
      id: string;
      recommended: boolean;
    }>;
    const targeted = templates2.find(
      (item) => item.id === "builtin-uncrackable1-root-bypass",
    );
    assert.strictEqual(targeted, undefined);

    const r3 = await app.request(
      `/api/script-templates/droid?device=${device}&identifier=${targetIdentifier}&includeTargeted=1`,
    );
    assert.strictEqual(r3.status, 200);
    const templates3 = (await r3.json()) as Array<{
      id: string;
      recommended: boolean;
    }>;
    const targeted3 = templates3.find(
      (item) => item.id === "builtin-uncrackable1-root-bypass",
    );
    assert(targeted3);
    assert.strictEqual(targeted3.recommended, true);
  });

  it("should include builtin scripts when platform is provided", async () => {
    const target = "owasp.mstg.uncrackable1";
    createHookScriptStore(device, target).clear();
    createHookScriptPresetStore(device, target).clear();

    const r0 = await app.request(`/api/scripts/${device}/${target}?platform=droid`);
    assert.strictEqual(r0.status, 200);
    const scripts0 = (await r0.json()) as Array<{ name: string }>;
    assert(
      scripts0.some((item) => item.name === "android-adaptive-root-debug-bypass"),
      "generic builtin script should be provisioned for droid platform",
    );
    assert(
      scripts0.every((item) => item.name !== "uncrackable1-root-bypass"),
      "targeted builtin script should not be auto-provisioned",
    );

    const r1 = await app.request(`/api/scripts/${device}/${target}?platform=droid`);
    assert.strictEqual(r1.status, 200);
    const scripts1 = (await r1.json()) as Array<{ name: string }>;
    assert.strictEqual(
      scripts1.filter((item) => item.name === "android-adaptive-root-debug-bypass").length,
      1,
      "builtin script should not be duplicated",
    );

    createHookScriptStore(device, target).clear();
    createHookScriptPresetStore(device, target).clear();
  });

  it("should create and query script", async () => {
    const payload = {
      name: "Auto Hook",
      content: "Interceptor.attach(...)",
      enabled: true,
      runOnAppLaunch: true,
    };
    const r0 = await app.request(`/api/scripts/${device}/${identifier}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(r0.status, 201);
    const created = (await r0.json()) as { id: string; name: string };
    assert.strictEqual(created.name, payload.name);
    assert(created.id);

    const r1 = await app.request(`/api/scripts/${device}/${identifier}`);
    assert.strictEqual(r1.status, 200);
    const scripts = (await r1.json()) as Array<{ id: string; name: string }>;
    assert.strictEqual(scripts.length, 1);
    assert.strictEqual(scripts[0].name, payload.name);
  });

  it("should update script fields", async () => {
    const store = createHookScriptStore(device, identifier);
    const created = store.create({
      name: "A",
      content: "1",
      enabled: true,
      runOnAppLaunch: true,
    });

    const r = await app.request(
      `/api/scripts/${device}/${identifier}/${created.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "B",
          enabled: false,
          runOnAppLaunch: false,
        }),
      },
    );
    assert.strictEqual(r.status, 200);
    const updated = (await r.json()) as {
      name: string;
      enabled: boolean;
      runOnAppLaunch: boolean;
    };
    assert.strictEqual(updated.name, "B");
    assert.strictEqual(updated.enabled, false);
    assert.strictEqual(updated.runOnAppLaunch, false);
  });

  it("should delete script", async () => {
    const store = createHookScriptStore(device, identifier);
    const created = store.create({
      name: "ToDelete",
      content: "x",
      enabled: true,
      runOnAppLaunch: true,
    });

    const r0 = await app.request(
      `/api/scripts/${device}/${identifier}/${created.id}`,
      {
        method: "DELETE",
      },
    );
    assert.strictEqual(r0.status, 204);

    const r1 = await app.request(`/api/scripts/${device}/${identifier}`);
    const body = (await r1.json()) as unknown[];
    assert.strictEqual(body.length, 0);
  });

  it("should provision builtin script for uncrackable1", () => {
    const target = "owasp.mstg.uncrackable1";
    createHookScriptStore(device, target).clear();
    createHookScriptPresetStore(device, target).clear();

    const first = ensureBuiltinHookScripts(device, target, "droid");
    const second = ensureBuiltinHookScripts(device, target, "droid");
    const scripts = createHookScriptStore(device, target).list();
    const rootBypass = scripts.find(
      (item) => item.name === "uncrackable1-root-bypass",
    );
    const adaptiveBypass = scripts.find(
      (item) => item.name === "android-adaptive-root-debug-bypass",
    );

    assert(first >= 1);
    assert.strictEqual(second, 0);
    assert.strictEqual(rootBypass, undefined);
    assert(adaptiveBypass);
    assert.strictEqual(adaptiveBypass.enabled, false);
    assert.strictEqual(adaptiveBypass.runOnAppLaunch, false);

    const targetedCreated = ensureBuiltinHookScripts(device, target, "droid", {
      includeTargeted: true,
    });
    const scripts2 = createHookScriptStore(device, target).list();
    const rootBypass2 = scripts2.find(
      (item) => item.name === "uncrackable1-root-bypass",
    );
    assert(targetedCreated >= 1);
    assert(rootBypass2);
    assert.strictEqual(rootBypass2.enabled, true);
    assert.strictEqual(rootBypass2.runOnAppLaunch, true);

    createHookScriptStore(device, target).clear();
    createHookScriptPresetStore(device, target).clear();
  });
});

describe("Hook Script Presets API", () => {
  afterEach(() => {
    createHookScriptStore(device, identifier).clear();
    createHookScriptPresetStore(device, identifier).clear();
  });

  it("should create/query/apply script preset", async () => {
    const scriptStore = createHookScriptStore(device, identifier);
    const s1 = scriptStore.create({
      name: "A",
      content: "a()",
      enabled: false,
      runOnAppLaunch: false,
    });
    const s2 = scriptStore.create({
      name: "B",
      content: "b()",
      enabled: true,
      runOnAppLaunch: false,
    });

    const r0 = await app.request(`/api/script-presets/${device}/${identifier}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Auto Attach",
        autoApplyOnAppLaunch: true,
        items: [
          {
            scriptId: s1.id,
            enabled: true,
            runOnAppLaunch: true,
          },
          {
            scriptId: s2.id,
            enabled: false,
            runOnAppLaunch: false,
          },
        ],
      }),
    });
    assert.strictEqual(r0.status, 201);
    const preset = (await r0.json()) as { id: string; name: string };
    assert(preset.id);
    assert.strictEqual(preset.name, "Auto Attach");

    const r1 = await app.request(`/api/script-presets/${device}/${identifier}`);
    assert.strictEqual(r1.status, 200);
    const presets = (await r1.json()) as Array<{ id: string }>;
    assert.strictEqual(presets.length, 1);

    const r2 = await app.request(
      `/api/script-presets/${device}/${identifier}/${preset.id}/apply`,
      {
        method: "POST",
      },
    );
    assert.strictEqual(r2.status, 200);

    const scripts = createHookScriptStore(device, identifier).list();
    const updatedS1 = scripts.find((item) => item.id === s1.id);
    const updatedS2 = scripts.find((item) => item.id === s2.id);
    assert(updatedS1);
    assert(updatedS2);
    assert.strictEqual(updatedS1.enabled, true);
    assert.strictEqual(updatedS1.runOnAppLaunch, true);
    assert.strictEqual(updatedS2.enabled, false);
    assert.strictEqual(updatedS2.runOnAppLaunch, false);
  });

  it("should update and delete script preset", async () => {
    const presetStore = createHookScriptPresetStore(device, identifier);
    const created = presetStore.create({
      name: "P1",
      items: [],
    });

    const r0 = await app.request(
      `/api/script-presets/${device}/${identifier}/${created.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "P2" }),
      },
    );
    assert.strictEqual(r0.status, 200);
    const updated = (await r0.json()) as { name: string };
    assert.strictEqual(updated.name, "P2");

    const r1 = await app.request(
      `/api/script-presets/${device}/${identifier}/${created.id}`,
      {
        method: "DELETE",
      },
    );
    assert.strictEqual(r1.status, 204);

    const r2 = await app.request(`/api/script-presets/${device}/${identifier}`);
    const list = (await r2.json()) as unknown[];
    assert.strictEqual(list.length, 0);
  });

  it("should keep only one auto-apply preset", async () => {
    const r0 = await app.request(`/api/script-presets/${device}/${identifier}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "P1",
        autoApplyOnAppLaunch: true,
        items: [],
      }),
    });
    assert.strictEqual(r0.status, 201);
    const p1 = (await r0.json()) as { id: string };

    const r1 = await app.request(`/api/script-presets/${device}/${identifier}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "P2",
        autoApplyOnAppLaunch: true,
        items: [],
      }),
    });
    assert.strictEqual(r1.status, 201);
    const p2 = (await r1.json()) as { id: string };

    const r2 = await app.request(`/api/script-presets/${device}/${identifier}`);
    assert.strictEqual(r2.status, 200);
    const presets = (await r2.json()) as Array<{
      id: string;
      autoApplyOnAppLaunch: boolean;
    }>;

    const p1Fetched = presets.find((item) => item.id === p1.id);
    const p2Fetched = presets.find((item) => item.id === p2.id);
    assert(p1Fetched);
    assert(p2Fetched);
    assert.strictEqual(p1Fetched.autoApplyOnAppLaunch, false);
    assert.strictEqual(p2Fetched.autoApplyOnAppLaunch, true);
  });
});
