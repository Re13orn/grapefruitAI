import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface SkillManifest {
  name: string;
  version: string;
  schemaVersion: number;
  skills: SkillEntry[];
}

interface SkillEntry {
  id: string;
  title: string;
  description: string;
  skillPath: string;
  templates: string[];
  requiredMcpTools: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

function parseManifest(raw: string): SkillManifest {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("skills/index.json must be an object");
  }

  const { name, version, schemaVersion, skills } = parsed;
  if (!isNonEmptyString(name)) {
    throw new Error('"name" must be a non-empty string');
  }
  if (!isNonEmptyString(version)) {
    throw new Error('"version" must be a non-empty string');
  }
  if (typeof schemaVersion !== "number" || !Number.isFinite(schemaVersion)) {
    throw new Error('"schemaVersion" must be a finite number');
  }
  if (!Array.isArray(skills)) {
    throw new Error('"skills" must be an array');
  }

  const normalized: SkillEntry[] = [];
  for (let index = 0; index < skills.length; index++) {
    const item = skills[index];
    if (!isRecord(item)) {
      throw new Error(`skills[${index}] must be an object`);
    }

    if (!isNonEmptyString(item.id)) {
      throw new Error(`skills[${index}].id must be a non-empty string`);
    }
    if (!isNonEmptyString(item.title)) {
      throw new Error(`skills[${index}].title must be a non-empty string`);
    }
    if (!isNonEmptyString(item.description)) {
      throw new Error(
        `skills[${index}].description must be a non-empty string`,
      );
    }
    if (!isNonEmptyString(item.skillPath)) {
      throw new Error(`skills[${index}].skillPath must be a non-empty string`);
    }
    if (!isStringArray(item.templates)) {
      throw new Error(`skills[${index}].templates must be a string array`);
    }
    if (!isStringArray(item.requiredMcpTools)) {
      throw new Error(
        `skills[${index}].requiredMcpTools must be a string array`,
      );
    }

    normalized.push({
      id: item.id,
      title: item.title,
      description: item.description,
      skillPath: item.skillPath,
      templates: item.templates,
      requiredMcpTools: item.requiredMcpTools,
    });
  }

  return {
    name,
    version,
    schemaVersion,
    skills: normalized,
  };
}

function main() {
  const root = resolve(import.meta.dirname!, "..");
  const manifestPath = resolve(root, "skills/index.json");
  if (!existsSync(manifestPath)) {
    throw new Error("skills/index.json not found");
  }

  const raw = readFileSync(manifestPath, "utf8");
  const manifest = parseManifest(raw);

  if (manifest.skills.length === 0) {
    throw new Error('"skills" must contain at least one entry');
  }

  const skillIds = new Set<string>();
  for (const skill of manifest.skills) {
    if (!/^[a-z0-9-]+$/.test(skill.id)) {
      throw new Error(
        `invalid skill id "${skill.id}": use lowercase letters, numbers, and "-"`,
      );
    }
    if (skillIds.has(skill.id)) {
      throw new Error(`duplicate skill id "${skill.id}"`);
    }
    skillIds.add(skill.id);

    const skillDocPath = resolve(root, skill.skillPath);
    if (!existsSync(skillDocPath)) {
      throw new Error(
        `skill "${skill.id}" references missing file: ${skill.skillPath}`,
      );
    }

    for (const templatePath of skill.templates) {
      if (!existsSync(resolve(root, templatePath))) {
        throw new Error(
          `skill "${skill.id}" references missing template: ${templatePath}`,
        );
      }
    }

    const toolNames = new Set<string>();
    for (const toolName of skill.requiredMcpTools) {
      if (!/^[a-z0-9_]+$/.test(toolName)) {
        throw new Error(
          `skill "${skill.id}" has invalid MCP tool name "${toolName}"`,
        );
      }
      if (toolNames.has(toolName)) {
        throw new Error(
          `skill "${skill.id}" has duplicate MCP tool "${toolName}"`,
        );
      }
      toolNames.add(toolName);
    }
  }

  console.log(
    `skills manifest valid: ${manifest.skills.length} skills, schema v${manifest.schemaVersion}`,
  );
}

main();
