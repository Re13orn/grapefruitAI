import { randomUUID, timingSafeEqual } from "node:crypto";

import * as preferences from "./store/preferences.ts";

const MCP_CONFIG_KEY = "mcp:config:v1";

export interface MCPConfig {
  enabled: boolean;
  token: string;
  showTargetedCapabilities: boolean;
  updatedAt: string;
}

function nowIso() {
  return new Date().toISOString();
}

function newToken() {
  return randomUUID().replaceAll("-", "");
}

function normalize(value: unknown): MCPConfig {
  if (typeof value !== "object" || value === null) {
    return {
      enabled: false,
      token: newToken(),
      showTargetedCapabilities: false,
      updatedAt: nowIso(),
    };
  }

  const row = value as Record<string, unknown>;
  const token =
    typeof row.token === "string" && row.token.length > 0
      ? row.token
      : newToken();

  return {
    enabled: row.enabled === true,
    token,
    showTargetedCapabilities: row.showTargetedCapabilities === true,
    updatedAt:
      typeof row.updatedAt === "string" && row.updatedAt.length > 0
        ? row.updatedAt
        : nowIso(),
  };
}

function save(config: MCPConfig): MCPConfig {
  preferences.set(MCP_CONFIG_KEY, config);
  return config;
}

export function getMCPConfig(): MCPConfig {
  const raw = preferences.get(MCP_CONFIG_KEY);
  const normalized = normalize(raw);

  const needsInit =
    typeof raw !== "object" ||
    raw === null ||
    (typeof (raw as Record<string, unknown>).token !== "string");

  if (needsInit) {
    return save(normalized);
  }

  return normalized;
}

export function setMCPEnabled(enabled: boolean): MCPConfig {
  const current = getMCPConfig();
  if (current.enabled === enabled) return current;
  return save({ ...current, enabled, updatedAt: nowIso() });
}

export function setMCPShowTargetedCapabilities(
  showTargetedCapabilities: boolean,
): MCPConfig {
  const current = getMCPConfig();
  if (current.showTargetedCapabilities === showTargetedCapabilities) {
    return current;
  }
  return save({ ...current, showTargetedCapabilities, updatedAt: nowIso() });
}

export function rotateMCPToken(): MCPConfig {
  const current = getMCPConfig();
  return save({ ...current, token: newToken(), updatedAt: nowIso() });
}

export function verifyMCPToken(candidate: string | null | undefined): boolean {
  if (!candidate) return false;

  const expected = getMCPConfig().token;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
