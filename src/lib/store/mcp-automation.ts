import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import nodePath from "node:path";

import paths from "../paths.ts";
import {
  UNCRACKABLE1_ROOT_BYPASS_SCRIPT,
  UNCRACKABLE2_EARLY_BYPASS_SCRIPT,
} from "../builtin-hooks.ts";
import * as preferences from "./preferences.ts";
import type { ScenarioRunTarget } from "./scenarios.ts";

const MAX_CUSTOM_HOOK_PACKS = 100;
const MAX_FINDINGS = 1000;
const MAX_ARTIFACTS = 1000;
const MAX_TEST_PLANS = 200;
const MAX_TEST_PLAN_RUNS = 500;

export type HookPackPlatform = "droid" | "fruity" | "any";
export type HookPackScope = "generic" | "targeted";
export type FindingRisk = "high" | "medium" | "low";
export type TestPlanRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "error"
  | "canceling"
  | "canceled";

export interface HookPackScriptTemplate {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  runOnAppLaunch: boolean;
}

export interface HookPackRecord {
  id: string;
  name: string;
  description: string;
  platform: HookPackPlatform;
  scope: HookPackScope;
  targetIdentifiers: string[];
  builtin: boolean;
  scripts: HookPackScriptTemplate[];
  createdAt: string;
  updatedAt: string;
}

export interface RuleSetRecord {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  severity: FindingRisk;
  createdAt: string;
  updatedAt: string;
}

export interface FindingRecord {
  id: string;
  deviceId: string;
  identifier: string;
  rulesetId: string;
  risk: FindingRisk;
  title: string;
  reason: string;
  recommendation: string;
  evidence: Array<{
    kind: string;
    ref: string;
  }>;
  status: "open" | "mitigated" | "accepted";
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  deviceId: string;
  identifier: string;
  type: string;
  name: string;
  mime: string;
  ext: string;
  path: string;
  size: number;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export interface TestPlanRecord {
  id: string;
  name: string;
  description: string;
  tags: string[];
  scenarioIds: string[];
  hookPackIds: string[];
  rulesetIds: string[];
  target?: ScenarioRunTarget;
  stopOnFailure: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TestPlanRunStep {
  id: string;
  scenarioId: string;
  status: "passed" | "failed" | "error" | "canceled" | "skipped";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  detail?: string;
  scenarioRunId?: string;
}

export interface TestPlanRunRecord {
  id: string;
  planId: string;
  planName: string;
  deviceId: string;
  identifier: string;
  status: TestPlanRunStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  stepResults: TestPlanRunStep[];
  artifacts: string[];
  findingsSummary: {
    high: number;
    medium: number;
    low: number;
  };
  error?: string;
}

interface HookPackDraft {
  name: string;
  description?: string;
  platform?: HookPackPlatform;
  scripts: Array<{
    name: string;
    content: string;
    enabled?: boolean;
    runOnAppLaunch?: boolean;
  }>;
}

interface HookPackPatch {
  name?: string;
  description?: string;
  platform?: HookPackPlatform;
  scripts?: Array<{
    name: string;
    content: string;
    enabled?: boolean;
    runOnAppLaunch?: boolean;
  }>;
}

interface TestPlanDraft {
  name: string;
  description?: string;
  tags?: string[];
  scenarioIds: string[];
  hookPackIds?: string[];
  rulesetIds?: string[];
  target?: ScenarioRunTarget;
  stopOnFailure?: boolean;
}

interface TestPlanPatch {
  name?: string;
  description?: string;
  tags?: string[];
  scenarioIds?: string[];
  hookPackIds?: string[];
  rulesetIds?: string[];
  target?: ScenarioRunTarget;
  stopOnFailure?: boolean;
}

function nowIso() {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function trimString(value: unknown, fallback = "") {
  const text = asString(value, fallback).trim();
  return text.length > 0 ? text : fallback;
}

function normalizeStringArray(value: unknown, max = 128) {
  if (!Array.isArray(value)) return [];
  const next: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(normalized);
    if (next.length >= max) break;
  }
  return next;
}

function artifactExtFromMime(mime: string) {
  if (mime.includes("json")) return "json";
  if (mime.includes("markdown")) return "md";
  if (mime.includes("text")) return "txt";
  return "bin";
}

const BUILTIN_HOOK_PACKS: HookPackRecord[] = [
  {
    id: "builtin-droid-uncrackable1-root-bypass",
    name: "Android Root/Debug Bypass (UnCrackable1)",
    description:
      "Bypass root/debug checks and termination flow used by owasp.mstg.uncrackable1.",
    platform: "droid",
    scope: "targeted",
    targetIdentifiers: ["owasp.mstg.uncrackable1"],
    builtin: true,
    scripts: [
      {
        id: "droid-uncrackable1-root-bypass-script",
        name: "uncrackable1-root-bypass",
        enabled: true,
        runOnAppLaunch: true,
        content: UNCRACKABLE1_ROOT_BYPASS_SCRIPT,
      },
    ],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-droid-uncrackable2-early-bypass",
    name: "Android Early Bypass (UnCrackable2)",
    description:
      "Early root/debug + anti-exit bypass for owasp.mstg.uncrackable2, intended for suspended launch injection.",
    platform: "droid",
    scope: "targeted",
    targetIdentifiers: ["owasp.mstg.uncrackable2"],
    builtin: true,
    scripts: [
      {
        id: "droid-uncrackable2-early-bypass-script",
        name: "uncrackable2-early-bypass",
        enabled: true,
        runOnAppLaunch: true,
        content: UNCRACKABLE2_EARLY_BYPASS_SCRIPT,
      },
    ],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-droid-crypto-core",
    name: "Android Crypto Core",
    description: "Hook Cipher/MessageDigest/mac/KeyStore sensitive paths.",
    platform: "droid",
    scope: "generic",
    targetIdentifiers: [],
    builtin: true,
    scripts: [
      {
        id: "droid-crypto-core-script",
        name: "crypto-core",
        enabled: true,
        runOnAppLaunch: true,
        content: [
          "Java.perform(function () {",
          "  const Cipher = Java.use('javax.crypto.Cipher');",
          "  const init = Cipher.init.overload('int', 'java.security.Key');",
          "  init.implementation = function (mode, key) {",
          "    send({ type: 'hook', symbol: 'Cipher.init', dir: 'enter', mode: mode });",
          "    return init.call(this, mode, key);",
          "  };",
          "  const doFinal = Cipher.doFinal.overload('[B');",
          "  doFinal.implementation = function (input) {",
          "    send({ type: 'hook', symbol: 'Cipher.doFinal', dir: 'enter' });",
          "    const out = doFinal.call(this, input);",
          "    send({ type: 'hook', symbol: 'Cipher.doFinal', dir: 'leave' });",
          "    return out;",
          "  };",
          "});",
        ].join("\n"),
      },
      {
        id: "droid-storage-core-script",
        name: "storage-sharedpref",
        enabled: true,
        runOnAppLaunch: true,
        content: [
          "Java.perform(function () {",
          "  const SP = Java.use('android.app.SharedPreferencesImpl');",
          "  SP.getString.overload('java.lang.String', 'java.lang.String').implementation = function (k, d) {",
          "    const v = this.getString(k, d);",
          "    send({ type: 'hook', symbol: 'SharedPreferences.getString', dir: 'leave', key: k, value: String(v) });",
          "    return v;",
          "  };",
          "});",
        ].join("\n"),
      },
    ],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-fruity-security-core",
    name: "iOS Security Core",
    description: "Hook keychain and URL session related paths.",
    platform: "fruity",
    scope: "generic",
    targetIdentifiers: [],
    builtin: true,
    scripts: [
      {
        id: "fruity-keychain-core-script",
        name: "keychain-core",
        enabled: true,
        runOnAppLaunch: true,
        content: [
          "if (ObjC.available) {",
          "  const SecItemCopyMatching = Module.findExportByName(null, 'SecItemCopyMatching');",
          "  if (SecItemCopyMatching) {",
          "    Interceptor.attach(SecItemCopyMatching, {",
          "      onEnter(args) { send({ type: 'hook', symbol: 'SecItemCopyMatching', dir: 'enter' }); },",
          "      onLeave(ret) { send({ type: 'hook', symbol: 'SecItemCopyMatching', dir: 'leave', ret: ret.toInt32() }); },",
          "    });",
          "  }",
          "}",
        ].join("\n"),
      },
      {
        id: "fruity-url-core-script",
        name: "nsurl-core",
        enabled: true,
        runOnAppLaunch: true,
        content: [
          "if (ObjC.available) {",
          "  const cls = ObjC.classes.NSURLSession;",
          "  if (cls && cls['- dataTaskWithRequest:']) {",
          "    Interceptor.attach(cls['- dataTaskWithRequest:'].implementation, {",
          "      onEnter() { send({ type: 'hook', symbol: 'NSURLSession.dataTaskWithRequest', dir: 'enter' }); },",
          "    });",
          "  }",
          "}",
        ].join("\n"),
      },
    ],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
];

const BUILTIN_RULESETS: RuleSetRecord[] = [
  {
    id: "builtin-secret-in-crypto",
    name: "Secret In Crypto Buffers",
    description: "Detect potential secret/token keywords in crypto call context.",
    builtin: true,
    severity: "high",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-sensitive-sharedpref",
    name: "Sensitive SharedPreferences Access",
    description: "Detect likely sensitive keys read from SharedPreferences.",
    builtin: true,
    severity: "medium",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-cleartext-url",
    name: "Cleartext URL Traffic",
    description: "Detect HTTP endpoints in captured network history.",
    builtin: true,
    severity: "high",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
];

function customHookPackKey() {
  return "mcp-hook-packs";
}

function enabledRuleSetKey(deviceId: string, identifier: string) {
  return `mcp-rulesets-enabled:${deviceId}|${identifier}`;
}

function findingsKey(deviceId: string, identifier: string) {
  return `mcp-findings:${deviceId}|${identifier}`;
}

function artifactsKey(deviceId: string, identifier: string) {
  return `mcp-artifacts:${deviceId}|${identifier}`;
}

function testPlansKey(deviceId: string, identifier: string) {
  return `mcp-test-plans:${deviceId}|${identifier}`;
}

function testPlanRunsKey(deviceId: string, identifier: string) {
  return `mcp-test-plan-runs:${deviceId}|${identifier}`;
}

function normalizeHookPackScripts(
  scripts: HookPackDraft["scripts"],
): HookPackScriptTemplate[] {
  const normalized: HookPackScriptTemplate[] = [];
  const seen = new Set<string>();

  for (const raw of scripts) {
    const name = trimString(raw?.name, "script");
    if (seen.has(name)) continue;
    seen.add(name);
    const content = asString(raw?.content, "");
    if (!content.trim()) continue;
    normalized.push({
      id: randomUUID(),
      name,
      content,
      enabled: raw?.enabled !== false,
      runOnAppLaunch: raw?.runOnAppLaunch !== false,
    });
  }

  return normalized;
}

function normalizeHookPack(
  input: HookPackDraft,
  existing?: HookPackRecord,
): HookPackRecord {
  const now = nowIso();
  const scripts = normalizeHookPackScripts(input.scripts);
  if (scripts.length === 0) {
    throw new Error("hook pack requires at least one non-empty script");
  }

  const platform: HookPackPlatform =
    input.platform === "droid" || input.platform === "fruity" || input.platform === "any"
      ? input.platform
      : "any";

  return {
    id: existing?.id ?? randomUUID(),
    name: trimString(input.name, existing?.name ?? "Untitled Hook Pack"),
    description: trimString(input.description, existing?.description ?? ""),
    platform,
    scope: "generic",
    targetIdentifiers: [],
    builtin: false,
    scripts,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function loadCustomHookPacks(): HookPackRecord[] {
  const saved = preferences.get(customHookPackKey());
  if (!Array.isArray(saved)) return [];

  const records: HookPackRecord[] = [];
  for (const row of saved) {
    if (!isRecord(row)) continue;
    if (typeof row.id !== "string") continue;
    if (typeof row.name !== "string") continue;
    if (!Array.isArray(row.scripts)) continue;

    const scripts: HookPackScriptTemplate[] = [];
    for (const script of row.scripts) {
      if (!isRecord(script)) continue;
      if (typeof script.id !== "string") continue;
      if (typeof script.name !== "string") continue;
      if (typeof script.content !== "string") continue;
      scripts.push({
        id: script.id,
        name: script.name,
        content: script.content,
        enabled: script.enabled !== false,
        runOnAppLaunch: script.runOnAppLaunch !== false,
      });
    }

    if (scripts.length === 0) continue;

    records.push({
      id: row.id,
      name: trimString(row.name, "Untitled Hook Pack"),
      description: trimString(row.description, ""),
      platform:
        row.platform === "droid" || row.platform === "fruity" || row.platform === "any"
          ? row.platform
          : "any",
      scope: row.scope === "targeted" ? "targeted" : "generic",
      targetIdentifiers: normalizeStringArray(row.targetIdentifiers, 32),
      builtin: false,
      scripts,
      createdAt: asString(row.createdAt, nowIso()),
      updatedAt: asString(row.updatedAt, nowIso()),
    });
  }

  return records;
}

function saveCustomHookPacks(records: HookPackRecord[]) {
  preferences.set(customHookPackKey(), records);
}

function allHookPacks(): HookPackRecord[] {
  return [...BUILTIN_HOOK_PACKS, ...loadCustomHookPacks()];
}

export function listHookPacks(
  platform?: HookPackPlatform,
  options: {
    includeTargeted?: boolean;
    identifier?: string;
  } = {},
): HookPackRecord[] {
  const merged = allHookPacks();
  const filtered =
    platform && platform !== "any"
      ? merged.filter((pack) => pack.platform === "any" || pack.platform === platform)
      : merged;
  const identifier = options.identifier?.trim();
  const includeTargeted = options.includeTargeted === true;
  const scopeFiltered = filtered.filter((pack) => {
    if (pack.scope !== "targeted") return true;
    if (!includeTargeted) return false;
    if (identifier) return pack.targetIdentifiers.includes(identifier);
    return true;
  });

  return scopeFiltered.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function getHookPack(packId: string): HookPackRecord | null {
  return allHookPacks().find((item) => item.id === packId) ?? null;
}

export function createCustomHookPack(input: HookPackDraft): HookPackRecord {
  const records = loadCustomHookPacks();
  if (records.length >= MAX_CUSTOM_HOOK_PACKS) {
    throw new Error(`too many custom hook packs (max ${MAX_CUSTOM_HOOK_PACKS})`);
  }
  const record = normalizeHookPack(input);
  records.push(record);
  saveCustomHookPacks(records);
  return record;
}

export function updateCustomHookPack(
  packId: string,
  patch: HookPackPatch,
): HookPackRecord | null {
  const records = loadCustomHookPacks();
  const idx = records.findIndex((item) => item.id === packId);
  if (idx === -1) return null;

  const current = records[idx]!;
  const next = normalizeHookPack(
    {
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      platform: patch.platform ?? current.platform,
      scripts:
        patch.scripts ??
        current.scripts.map((s) => ({
          name: s.name,
          content: s.content,
          enabled: s.enabled,
          runOnAppLaunch: s.runOnAppLaunch,
        })),
    },
    current,
  );
  records[idx] = next;
  saveCustomHookPacks(records);
  return next;
}

export function removeCustomHookPack(packId: string): boolean {
  const records = loadCustomHookPacks();
  const next = records.filter((item) => item.id !== packId);
  if (next.length === records.length) return false;
  saveCustomHookPacks(next);
  return true;
}

export function listRuleSets(): RuleSetRecord[] {
  return BUILTIN_RULESETS.map((item) => ({ ...item }));
}

export function setEnabledRuleSets(
  deviceId: string,
  identifier: string,
  rulesetIds: string[],
) {
  const allowed = new Set(BUILTIN_RULESETS.map((item) => item.id));
  const normalized = normalizeStringArray(rulesetIds, 64).filter((id) =>
    allowed.has(id),
  );
  preferences.set(enabledRuleSetKey(deviceId, identifier), normalized);
  return normalized;
}

export function getEnabledRuleSets(deviceId: string, identifier: string) {
  const saved = preferences.get(enabledRuleSetKey(deviceId, identifier));
  const ids = normalizeStringArray(saved, 64);
  const allowed = new Set(BUILTIN_RULESETS.map((item) => item.id));
  return ids.filter((id) => allowed.has(id));
}

function loadFindings(deviceId: string, identifier: string): FindingRecord[] {
  const saved = preferences.get(findingsKey(deviceId, identifier));
  if (!Array.isArray(saved)) return [];

  const records: FindingRecord[] = [];
  for (const row of saved) {
    if (!isRecord(row)) continue;
    if (typeof row.id !== "string") continue;
    if (typeof row.rulesetId !== "string") continue;
    if (typeof row.risk !== "string") continue;
    if (typeof row.title !== "string") continue;
    if (typeof row.reason !== "string") continue;
    if (typeof row.recommendation !== "string") continue;

    records.push({
      id: row.id,
      deviceId,
      identifier,
      rulesetId: row.rulesetId,
      risk:
        row.risk === "high" || row.risk === "medium" || row.risk === "low"
          ? row.risk
          : "low",
      title: row.title,
      reason: row.reason,
      recommendation: row.recommendation,
      evidence: Array.isArray(row.evidence)
        ? row.evidence
            .filter(isRecord)
            .map((it) => ({
              kind: asString(it.kind, "unknown"),
              ref: asString(it.ref, ""),
            }))
            .filter((it) => it.ref.length > 0)
        : [],
      status:
        row.status === "mitigated" || row.status === "accepted" ? row.status : "open",
      createdAt: asString(row.createdAt, nowIso()),
    });
  }
  return records;
}

function saveFindings(deviceId: string, identifier: string, records: FindingRecord[]) {
  preferences.set(findingsKey(deviceId, identifier), records.slice(-MAX_FINDINGS));
}

export function appendFindings(
  deviceId: string,
  identifier: string,
  findings: Array<Omit<FindingRecord, "id" | "deviceId" | "identifier" | "createdAt">>,
): FindingRecord[] {
  const existing = loadFindings(deviceId, identifier);
  const created = findings.map((finding) => ({
    id: randomUUID(),
    deviceId,
    identifier,
    rulesetId: finding.rulesetId,
    risk: finding.risk,
    title: finding.title,
    reason: finding.reason,
    recommendation: finding.recommendation,
    evidence: finding.evidence,
    status: finding.status,
    createdAt: nowIso(),
  }));
  const merged = [...existing, ...created].slice(-MAX_FINDINGS);
  saveFindings(deviceId, identifier, merged);
  return created;
}

export function listFindings(
  deviceId: string,
  identifier: string,
  options: {
    risk?: FindingRisk;
    status?: FindingRecord["status"];
    limit?: number;
    offset?: number;
  } = {},
) {
  const records = loadFindings(deviceId, identifier).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const filtered = records.filter((item) => {
    if (options.risk && item.risk !== options.risk) return false;
    if (options.status && item.status !== options.status) return false;
    return true;
  });
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.floor(options.limit ?? 200));
  return {
    total: filtered.length,
    findings: filtered.slice(offset, offset + limit),
  };
}

export function clearFindings(deviceId: string, identifier: string) {
  preferences.rm(findingsKey(deviceId, identifier));
}

function loadArtifacts(deviceId: string, identifier: string): ArtifactRecord[] {
  const saved = preferences.get(artifactsKey(deviceId, identifier));
  if (!Array.isArray(saved)) return [];

  const records: ArtifactRecord[] = [];
  for (const row of saved) {
    if (!isRecord(row)) continue;
    if (typeof row.id !== "string") continue;
    if (typeof row.path !== "string") continue;
    if (typeof row.name !== "string") continue;
    if (typeof row.type !== "string") continue;

    records.push({
      id: row.id,
      deviceId,
      identifier,
      type: row.type,
      name: row.name,
      mime: asString(row.mime, "application/octet-stream"),
      ext: asString(row.ext, "bin"),
      path: row.path,
      size: typeof row.size === "number" ? row.size : 0,
      createdAt: asString(row.createdAt, nowIso()),
      meta: isRecord(row.meta) ? row.meta : undefined,
    });
  }
  return records;
}

function saveArtifacts(deviceId: string, identifier: string, records: ArtifactRecord[]) {
  preferences.set(artifactsKey(deviceId, identifier), records.slice(-MAX_ARTIFACTS));
}

export async function createArtifact(
  deviceId: string,
  identifier: string,
  input: {
    type: string;
    name: string;
    mime?: string;
    ext?: string;
    content: string | Buffer;
    meta?: Record<string, unknown>;
  },
) {
  const id = randomUUID();
  const mime = input.mime ?? "application/json";
  const ext = (input.ext ?? artifactExtFromMime(mime)).replace(/^\./, "");

  const baseDir = nodePath.join(paths.data, "artifacts", deviceId, identifier);
  await fs.mkdir(baseDir, { recursive: true });

  const filePath = nodePath.join(baseDir, `${id}.${ext}`);
  if (Buffer.isBuffer(input.content)) {
    await fs.writeFile(filePath, input.content);
  } else {
    await fs.writeFile(filePath, input.content, "utf8");
  }

  const stat = await fs.stat(filePath);
  const record: ArtifactRecord = {
    id,
    deviceId,
    identifier,
    type: trimString(input.type, "artifact"),
    name: trimString(input.name, "artifact"),
    mime,
    ext,
    path: filePath,
    size: stat.size,
    createdAt: nowIso(),
    meta: input.meta,
  };

  const records = loadArtifacts(deviceId, identifier);
  records.push(record);
  saveArtifacts(deviceId, identifier, records);
  return record;
}

export function listArtifacts(
  deviceId: string,
  identifier: string,
  options: {
    type?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  const records = loadArtifacts(deviceId, identifier)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((item) => (options.type ? item.type === options.type : true));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.floor(options.limit ?? 200));
  return {
    total: records.length,
    artifacts: records.slice(offset, offset + limit),
  };
}

export function getArtifact(
  deviceId: string,
  identifier: string,
  artifactId: string,
) {
  const records = loadArtifacts(deviceId, identifier);
  return records.find((item) => item.id === artifactId) ?? null;
}

export async function readArtifactContent(
  artifact: ArtifactRecord,
  maxBytes = 512 * 1024,
) {
  const stat = await fs.stat(artifact.path).catch(() => null);
  if (!stat) {
    throw new Error("artifact file not found");
  }
  const size = Math.min(stat.size, Math.max(1024, maxBytes));
  const content = await fs.readFile(artifact.path);
  const head = content.subarray(0, size);
  if (artifact.mime.includes("json") || artifact.mime.startsWith("text/") || artifact.ext === "md") {
    return {
      truncated: stat.size > size,
      encoding: "utf8" as const,
      text: head.toString("utf8"),
    };
  }
  return {
    truncated: stat.size > size,
    encoding: "base64" as const,
    base64: head.toString("base64"),
  };
}

function normalizeTestPlanDraft(input: TestPlanDraft, existing?: TestPlanRecord): TestPlanRecord {
  const now = nowIso();
  const scenarioIds = normalizeStringArray(input.scenarioIds, 500);
  if (scenarioIds.length === 0) {
    throw new Error("test plan requires at least one scenarioId");
  }

  const hookPackIds = normalizeStringArray(input.hookPackIds, 64);
  const rulesetIds = normalizeStringArray(input.rulesetIds, 64);
  const tags = normalizeStringArray(input.tags, 64);

  return {
    id: existing?.id ?? randomUUID(),
    name: trimString(input.name, existing?.name ?? "Untitled Test Plan"),
    description: trimString(input.description, existing?.description ?? ""),
    tags,
    scenarioIds,
    hookPackIds,
    rulesetIds,
    target: input.target ?? existing?.target,
    stopOnFailure: input.stopOnFailure ?? existing?.stopOnFailure ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function loadTestPlans(deviceId: string, identifier: string): TestPlanRecord[] {
  const saved = preferences.get(testPlansKey(deviceId, identifier));
  if (!Array.isArray(saved)) return [];
  const records: TestPlanRecord[] = [];
  for (const row of saved) {
    if (!isRecord(row)) continue;
    if (typeof row.id !== "string") continue;
    if (typeof row.name !== "string") continue;
    records.push({
      id: row.id,
      name: trimString(row.name, "Untitled Test Plan"),
      description: trimString(row.description, ""),
      tags: normalizeStringArray(row.tags, 64),
      scenarioIds: normalizeStringArray(row.scenarioIds, 500),
      hookPackIds: normalizeStringArray(row.hookPackIds, 64),
      rulesetIds: normalizeStringArray(row.rulesetIds, 64),
      target: isRecord(row.target) ? (row.target as ScenarioRunTarget) : undefined,
      stopOnFailure: row.stopOnFailure !== false,
      createdAt: asString(row.createdAt, nowIso()),
      updatedAt: asString(row.updatedAt, nowIso()),
    });
  }
  return records;
}

function saveTestPlans(deviceId: string, identifier: string, records: TestPlanRecord[]) {
  preferences.set(testPlansKey(deviceId, identifier), records.slice(-MAX_TEST_PLANS));
}

function loadTestPlanRuns(deviceId: string, identifier: string): TestPlanRunRecord[] {
  const saved = preferences.get(testPlanRunsKey(deviceId, identifier));
  if (!Array.isArray(saved)) return [];
  const records: TestPlanRunRecord[] = [];

  for (const row of saved) {
    if (!isRecord(row)) continue;
    if (typeof row.id !== "string") continue;
    if (typeof row.planId !== "string") continue;
    if (typeof row.planName !== "string") continue;
    if (typeof row.status !== "string") continue;
    if (!Array.isArray(row.stepResults)) continue;

    records.push({
      id: row.id,
      planId: row.planId,
      planName: row.planName,
      deviceId,
      identifier,
      status: row.status as TestPlanRunStatus,
      createdAt: asString(row.createdAt, nowIso()),
      startedAt: typeof row.startedAt === "string" ? row.startedAt : undefined,
      endedAt: typeof row.endedAt === "string" ? row.endedAt : undefined,
      durationMs: typeof row.durationMs === "number" ? row.durationMs : undefined,
      stepResults: row.stepResults
        .filter(isRecord)
        .map((it) => ({
          id: asString(it.id, randomUUID()),
          scenarioId: asString(it.scenarioId, ""),
          status:
            it.status === "passed" ||
            it.status === "failed" ||
            it.status === "error" ||
            it.status === "canceled" ||
            it.status === "skipped"
              ? it.status
              : "error",
          startedAt: asString(it.startedAt, nowIso()),
          endedAt: asString(it.endedAt, nowIso()),
          durationMs: typeof it.durationMs === "number" ? it.durationMs : 0,
          detail: typeof it.detail === "string" ? it.detail : undefined,
          scenarioRunId:
            typeof it.scenarioRunId === "string" ? it.scenarioRunId : undefined,
        })),
      artifacts: normalizeStringArray(row.artifacts, 256),
      findingsSummary: isRecord(row.findingsSummary)
        ? {
            high:
              typeof row.findingsSummary.high === "number"
                ? row.findingsSummary.high
                : 0,
            medium:
              typeof row.findingsSummary.medium === "number"
                ? row.findingsSummary.medium
                : 0,
            low:
              typeof row.findingsSummary.low === "number"
                ? row.findingsSummary.low
                : 0,
          }
        : { high: 0, medium: 0, low: 0 },
      error: typeof row.error === "string" ? row.error : undefined,
    });
  }

  return records;
}

function saveTestPlanRuns(
  deviceId: string,
  identifier: string,
  records: TestPlanRunRecord[],
) {
  preferences.set(testPlanRunsKey(deviceId, identifier), records.slice(-MAX_TEST_PLAN_RUNS));
}

export function createTestPlanStore(deviceId: string, identifier: string) {
  return {
    list() {
      return loadTestPlans(deviceId, identifier).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
    },
    get(id: string) {
      return loadTestPlans(deviceId, identifier).find((item) => item.id === id) ?? null;
    },
    create(draft: TestPlanDraft) {
      const records = loadTestPlans(deviceId, identifier);
      if (records.length >= MAX_TEST_PLANS) {
        throw new Error(`too many test plans (max ${MAX_TEST_PLANS})`);
      }
      const record = normalizeTestPlanDraft(draft);
      records.push(record);
      saveTestPlans(deviceId, identifier, records);
      return record;
    },
    update(id: string, patch: TestPlanPatch) {
      const records = loadTestPlans(deviceId, identifier);
      const idx = records.findIndex((item) => item.id === id);
      if (idx === -1) return null;

      const current = records[idx]!;
      const next = normalizeTestPlanDraft(
        {
          name: patch.name ?? current.name,
          description: patch.description ?? current.description,
          tags: patch.tags ?? current.tags,
          scenarioIds: patch.scenarioIds ?? current.scenarioIds,
          hookPackIds: patch.hookPackIds ?? current.hookPackIds,
          rulesetIds: patch.rulesetIds ?? current.rulesetIds,
          target: patch.target ?? current.target,
          stopOnFailure:
            typeof patch.stopOnFailure === "boolean"
              ? patch.stopOnFailure
              : current.stopOnFailure,
        },
        current,
      );
      records[idx] = next;
      saveTestPlans(deviceId, identifier, records);
      return next;
    },
    remove(id: string) {
      const records = loadTestPlans(deviceId, identifier);
      const next = records.filter((item) => item.id !== id);
      if (next.length === records.length) return false;
      saveTestPlans(deviceId, identifier, next);
      return true;
    },
    clear() {
      preferences.rm(testPlansKey(deviceId, identifier));
    },
  };
}

export function createTestPlanRunStore(deviceId: string, identifier: string) {
  return {
    list(options: { planId?: string; status?: TestPlanRunStatus } = {}) {
      const rows = loadTestPlanRuns(deviceId, identifier).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      return rows.filter((item) => {
        if (options.planId && item.planId !== options.planId) return false;
        if (options.status && item.status !== options.status) return false;
        return true;
      });
    },
    get(id: string) {
      return loadTestPlanRuns(deviceId, identifier).find((item) => item.id === id) ?? null;
    },
    create(
      input: Omit<
        TestPlanRunRecord,
        "id" | "createdAt" | "deviceId" | "identifier"
      >,
    ) {
      const records = loadTestPlanRuns(deviceId, identifier);
      if (records.length >= MAX_TEST_PLAN_RUNS) {
        records.splice(0, records.length - MAX_TEST_PLAN_RUNS + 1);
      }
      const row: TestPlanRunRecord = {
        id: randomUUID(),
        deviceId,
        identifier,
        createdAt: nowIso(),
        ...input,
      };
      records.push(row);
      saveTestPlanRuns(deviceId, identifier, records);
      return row;
    },
    update(id: string, patch: Partial<TestPlanRunRecord>) {
      const records = loadTestPlanRuns(deviceId, identifier);
      const idx = records.findIndex((item) => item.id === id);
      if (idx === -1) return null;
      const current = records[idx]!;
      const next: TestPlanRunRecord = {
        ...current,
        ...patch,
        id: current.id,
        planId: patch.planId ?? current.planId,
        planName: patch.planName ?? current.planName,
        deviceId: current.deviceId,
        identifier: current.identifier,
      };
      records[idx] = next;
      saveTestPlanRuns(deviceId, identifier, records);
      return next;
    },
    remove(id: string) {
      const records = loadTestPlanRuns(deviceId, identifier);
      const next = records.filter((item) => item.id !== id);
      if (next.length === records.length) return false;
      saveTestPlanRuns(deviceId, identifier, next);
      return true;
    },
    clear() {
      preferences.rm(testPlanRunsKey(deviceId, identifier));
    },
  };
}
