import { randomUUID } from "node:crypto";

import {
  listBuiltinHookScriptTemplates,
  type BuiltinHookPlatform,
} from "../builtin-hooks.ts";
import * as preferences from "./preferences.ts";

export interface HookScriptRecord {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  runOnAppLaunch: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HookScriptInput {
  name: string;
  content: string;
  enabled?: boolean;
  runOnAppLaunch?: boolean;
}

export interface HookScriptPatch {
  name?: string;
  content?: string;
  enabled?: boolean;
  runOnAppLaunch?: boolean;
}

export interface HookScriptPresetItem {
  scriptId: string;
  enabled: boolean;
  runOnAppLaunch: boolean;
}

export interface HookScriptPresetRecord {
  id: string;
  name: string;
  items: HookScriptPresetItem[];
  autoApplyOnAppLaunch: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HookScriptPresetInput {
  name: string;
  items: HookScriptPresetItem[];
  autoApplyOnAppLaunch?: boolean;
}

export interface HookScriptPresetPatch {
  name?: string;
  items?: HookScriptPresetItem[];
  autoApplyOnAppLaunch?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "Untitled Script";
}

function normalizePresetName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "Untitled Preset";
}

function isValidPresetItem(value: unknown): value is HookScriptPresetItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.scriptId === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.runOnAppLaunch === "boolean"
  );
}

function normalizePresetItems(items: HookScriptPresetItem[]): HookScriptPresetItem[] {
  const dedup = new Map<string, HookScriptPresetItem>();
  for (const item of items) {
    const scriptId = item.scriptId.trim();
    if (!scriptId) continue;
    dedup.set(scriptId, {
      scriptId,
      enabled: item.enabled,
      runOnAppLaunch: item.runOnAppLaunch,
    });
  }
  return Array.from(dedup.values());
}

function loadScripts(key: string): HookScriptRecord[] {
  const saved = preferences.get(key);
  if (!Array.isArray(saved)) return [];

  const scripts: HookScriptRecord[] = [];
  for (const item of saved) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== "string") continue;
    if (typeof item.name !== "string") continue;
    if (typeof item.content !== "string") continue;

    scripts.push({
      id: item.id,
      name: normalizeName(item.name),
      content: item.content,
      enabled: item.enabled !== false,
      runOnAppLaunch: item.runOnAppLaunch !== false,
      createdAt:
        typeof item.createdAt === "string"
          ? item.createdAt
          : new Date().toISOString(),
      updatedAt:
        typeof item.updatedAt === "string"
          ? item.updatedAt
          : new Date().toISOString(),
    });
  }

  return scripts;
}

function loadPresets(key: string): HookScriptPresetRecord[] {
  const saved = preferences.get(key);
  if (!Array.isArray(saved)) return [];

  const presets: HookScriptPresetRecord[] = [];
  for (const item of saved) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== "string") continue;
    if (typeof item.name !== "string") continue;
    if (!Array.isArray(item.items)) continue;

    const validItems = item.items.filter(isValidPresetItem);
    presets.push({
      id: item.id,
      name: normalizePresetName(item.name),
      items: normalizePresetItems(validItems),
      autoApplyOnAppLaunch: item.autoApplyOnAppLaunch === true,
      createdAt:
        typeof item.createdAt === "string"
          ? item.createdAt
          : new Date().toISOString(),
      updatedAt:
        typeof item.updatedAt === "string"
          ? item.updatedAt
          : new Date().toISOString(),
    });
  }

  return presets;
}

export function createHookScriptStore(deviceId: string, identifier: string) {
  const key = `scripts:${deviceId}|${identifier}`;

  function saveAll(records: HookScriptRecord[]): void {
    preferences.set(key, records);
  }

  return {
    list(): HookScriptRecord[] {
      const records = loadScripts(key);
      records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return records;
    },

    create(input: HookScriptInput): HookScriptRecord {
      const now = new Date().toISOString();
      const record: HookScriptRecord = {
        id: randomUUID(),
        name: normalizeName(input.name),
        content: input.content,
        enabled: input.enabled !== false,
        runOnAppLaunch: input.runOnAppLaunch !== false,
        createdAt: now,
        updatedAt: now,
      };

      const records = loadScripts(key);
      records.push(record);
      saveAll(records);
      return record;
    },

    update(id: string, patch: HookScriptPatch): HookScriptRecord | null {
      const records = loadScripts(key);
      const idx = records.findIndex((item) => item.id === id);
      if (idx === -1) return null;

      const current = records[idx];
      const next: HookScriptRecord = {
        ...current,
        name:
          typeof patch.name === "string"
            ? normalizeName(patch.name)
            : current.name,
        content:
          typeof patch.content === "string" ? patch.content : current.content,
        enabled:
          typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
        runOnAppLaunch:
          typeof patch.runOnAppLaunch === "boolean"
            ? patch.runOnAppLaunch
            : current.runOnAppLaunch,
        updatedAt: new Date().toISOString(),
      };

      records[idx] = next;
      saveAll(records);
      return next;
    },

    remove(id: string): boolean {
      const records = loadScripts(key);
      const next = records.filter((item) => item.id !== id);
      if (next.length === records.length) return false;
      saveAll(next);
      return true;
    },

    clear(): void {
      preferences.rm(key);
    },

    applyPreset(items: HookScriptPresetItem[]): HookScriptRecord[] {
      const normalizedItems = normalizePresetItems(items);
      if (normalizedItems.length === 0) return this.list();

      const records = loadScripts(key);
      const patchById = new Map(
        normalizedItems.map((item) => [item.scriptId, item]),
      );

      let changed = false;
      const now = new Date().toISOString();
      const next = records.map((record) => {
        const patch = patchById.get(record.id);
        if (!patch) return record;

        if (
          record.enabled === patch.enabled &&
          record.runOnAppLaunch === patch.runOnAppLaunch
        ) {
          return record;
        }

        changed = true;
        return {
          ...record,
          enabled: patch.enabled,
          runOnAppLaunch: patch.runOnAppLaunch,
          updatedAt: now,
        };
      });

      if (changed) saveAll(next);
      next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return next;
    },
  };
}

export function ensureBuiltinHookScripts(
  deviceId: string,
  identifier: string,
  platform: BuiltinHookPlatform,
  options: {
    includeTargeted?: boolean;
  } = {},
) {
  const templates = listBuiltinHookScriptTemplates(platform, identifier).filter(
    (template) => options.includeTargeted === true || template.identifiers.length === 0,
  );
  if (templates.length === 0) return 0;

  const key = `scripts:${deviceId}|${identifier}`;
  const records = loadScripts(key);
  const byName = new Set(records.map((item) => item.name));
  const now = new Date().toISOString();
  let created = 0;

  for (const template of templates) {
    if (byName.has(template.name)) continue;
    records.push({
      id: randomUUID(),
      name: normalizeName(template.name),
      content: template.content,
      enabled: template.enabled,
      runOnAppLaunch: template.runOnAppLaunch,
      createdAt: now,
      updatedAt: now,
    });
    byName.add(template.name);
    created += 1;
  }

  if (created > 0) {
    preferences.set(key, records);
  }

  return created;
}

export function createHookScriptPresetStore(deviceId: string, identifier: string) {
  const key = `script-presets:${deviceId}|${identifier}`;

  function saveAll(records: HookScriptPresetRecord[]): void {
    preferences.set(key, records);
  }

  function clearAutoApplyOnOthers(
    records: HookScriptPresetRecord[],
    exceptId?: string,
  ): void {
    for (const item of records) {
      if (item.id === exceptId) continue;
      if (item.autoApplyOnAppLaunch) {
        item.autoApplyOnAppLaunch = false;
      }
    }
  }

  return {
    list(): HookScriptPresetRecord[] {
      const records = loadPresets(key);
      records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return records;
    },

    get(id: string): HookScriptPresetRecord | null {
      const records = loadPresets(key);
      return records.find((item) => item.id === id) ?? null;
    },

    create(input: HookScriptPresetInput): HookScriptPresetRecord {
      const now = new Date().toISOString();
      const record: HookScriptPresetRecord = {
        id: randomUUID(),
        name: normalizePresetName(input.name),
        items: normalizePresetItems(input.items),
        autoApplyOnAppLaunch: input.autoApplyOnAppLaunch === true,
        createdAt: now,
        updatedAt: now,
      };

      const records = loadPresets(key);
      if (record.autoApplyOnAppLaunch) {
        clearAutoApplyOnOthers(records);
      }
      records.push(record);
      saveAll(records);
      return record;
    },

    update(id: string, patch: HookScriptPresetPatch): HookScriptPresetRecord | null {
      const records = loadPresets(key);
      const idx = records.findIndex((item) => item.id === id);
      if (idx === -1) return null;

      const current = records[idx];
      const nextAutoApply =
        typeof patch.autoApplyOnAppLaunch === "boolean"
          ? patch.autoApplyOnAppLaunch
          : current.autoApplyOnAppLaunch;
      const next: HookScriptPresetRecord = {
        ...current,
        name:
          typeof patch.name === "string"
            ? normalizePresetName(patch.name)
            : current.name,
        items:
          Array.isArray(patch.items)
            ? normalizePresetItems(patch.items)
            : current.items,
        autoApplyOnAppLaunch: nextAutoApply,
        updatedAt: new Date().toISOString(),
      };

      if (next.autoApplyOnAppLaunch) {
        clearAutoApplyOnOthers(records, id);
      }

      records[idx] = next;
      saveAll(records);
      return next;
    },

    remove(id: string): boolean {
      const records = loadPresets(key);
      const next = records.filter((item) => item.id !== id);
      if (next.length === records.length) return false;
      saveAll(next);
      return true;
    },

    clear(): void {
      preferences.rm(key);
    },

    getAutoApplyOnAppLaunch(): HookScriptPresetRecord | null {
      const records = this.list();
      return records.find((item) => item.autoApplyOnAppLaunch) ?? null;
    },
  };
}
