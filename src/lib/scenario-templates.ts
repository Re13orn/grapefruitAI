import {
  normalizeScenarioDraft,
  type ScenarioDraft,
  type ScenarioRecord,
  type ScenarioStep,
} from "./store/scenarios.ts";

export interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  steps: ScenarioStep[];
}

export interface ScenarioTemplateCreateOptions {
  name?: string;
  description?: string;
  tags?: string[];
}

const BUILTIN_SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  {
    id: "startup-injection-window-regression",
    name: "Startup Injection Window Regression",
    description:
      "Release-gate baseline: confirm startup scripts compile and install hooks during app launch window.",
    tags: ["builtin", "regression", "startup", "hook"],
    steps: [
      {
        type: "clear_history",
        id: "clear-hooks",
        kind: "hooks",
      },
      {
        type: "note",
        id: "note-startup-regression",
        text: "Run this right after launch_app(suspended=true) + apply preset + resume_app.",
      },
      {
        type: "assert",
        id: "assert-startup-script-applied",
        assertion: {
          type: "script_applied",
          source: "startup",
          compileOk: true,
          minHookedMethods: 1,
        },
      },
    ],
  },
  {
    id: "script-apply-ack-smoke",
    name: "Script Apply ACK Smoke",
    description:
      "Verify startup hook scripts were compiled and at least one method was installed.",
    tags: ["builtin", "smoke", "hook", "ack"],
    steps: [
      {
        type: "note",
        id: "note-ack",
        text: "Validate script apply evidence after app launch.",
      },
      {
        type: "assert",
        id: "assert-ack",
        assertion: {
          type: "script_applied",
          source: "startup",
          compileOk: true,
          minHookedMethods: 1,
        },
      },
    ],
  },
  {
    id: "crypto-capture-smoke",
    name: "Crypto Capture Smoke",
    description:
      "Check whether crypto hook events were captured after triggering app actions.",
    tags: ["builtin", "smoke", "crypto"],
    steps: [
      {
        type: "clear_history",
        id: "clear-hooks",
        kind: "hooks",
      },
      {
        type: "sleep",
        id: "sleep-capture",
        ms: 1200,
      },
      {
        type: "assert",
        id: "assert-cipher",
        assertion: {
          type: "history_contains",
          kind: "hooks",
          keyword: "Cipher.",
        },
      },
    ],
  },
  {
    id: "storage-access-smoke",
    name: "Storage Access Smoke",
    description:
      "Check sensitive storage access traces such as SharedPreferences and KeyStore.",
    tags: ["builtin", "smoke", "storage"],
    steps: [
      {
        type: "clear_history",
        id: "clear-storage-hooks",
        kind: "hooks",
      },
      {
        type: "sleep",
        id: "sleep-storage",
        ms: 1000,
      },
      {
        type: "assert",
        id: "assert-sharedpref",
        assertion: {
          type: "history_contains",
          kind: "hooks",
          keyword: "SharedPreferences",
        },
        continueOnFailure: true,
      },
      {
        type: "assert",
        id: "assert-keystore",
        assertion: {
          type: "history_contains",
          kind: "hooks",
          keyword: "KeyStore",
        },
      },
    ],
  },
  {
    id: "uncrackable2-early-bypass-regression",
    name: "UnCrackable2 Early Bypass Regression",
    description:
      "Targeted regression for owasp.mstg.uncrackable2: ensure early bypass script is applied with effective hooks.",
    tags: ["builtin", "regression", "targeted", "uncrackable2"],
    steps: [
      {
        type: "clear_history",
        id: "clear-uncrackable2-hooks",
        kind: "hooks",
      },
      {
        type: "note",
        id: "note-uncrackable2-flow",
        text: "Use with targeted template uncrackable2-early-bypass and suspended launch for best reliability.",
      },
      {
        type: "assert",
        id: "assert-uncrackable2-ack",
        assertion: {
          type: "script_applied",
          scriptName: "uncrackable2",
          source: "startup",
          compileOk: true,
          minHookedMethods: 1,
        },
      },
      {
        type: "assert",
        id: "assert-uncrackable2-hooks",
        assertion: {
          type: "history_contains",
          kind: "hooks",
          keyword: "builtin.uncrackable2",
        },
        continueOnFailure: true,
      },
    ],
  },
];

function uniqStrings(values: string[]): string[] {
  const set = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    set.add(trimmed);
  }
  return [...set];
}

function cloneSteps(steps: ScenarioStep[]): ScenarioStep[] {
  return JSON.parse(JSON.stringify(steps)) as ScenarioStep[];
}

export function scenarioTemplateTag(templateId: string) {
  return `template:${templateId}`;
}

export function listScenarioTemplates(): ScenarioTemplate[] {
  return BUILTIN_SCENARIO_TEMPLATES.map((template) => ({
    ...template,
    tags: [...template.tags],
    steps: cloneSteps(template.steps),
  }));
}

export function getScenarioTemplate(templateId: string): ScenarioTemplate | null {
  const template = BUILTIN_SCENARIO_TEMPLATES.find((item) => item.id === templateId);
  if (!template) return null;
  return {
    ...template,
    tags: [...template.tags],
    steps: cloneSteps(template.steps),
  };
}

export function createScenarioDraftFromTemplate(
  templateId: string,
  options: ScenarioTemplateCreateOptions = {},
): ScenarioDraft {
  const template = getScenarioTemplate(templateId);
  if (!template) {
    throw new Error(`scenario template not found: ${templateId}`);
  }

  const draft = {
    name: options.name?.trim() || template.name,
    description:
      typeof options.description === "string"
        ? options.description.trim()
        : template.description,
    tags: uniqStrings([
      ...template.tags,
      scenarioTemplateTag(template.id),
      ...(options.tags ?? []),
    ]),
    steps: cloneSteps(template.steps),
  };
  return normalizeScenarioDraft(draft);
}

export function findScenarioByTemplateTag(
  scenarios: ScenarioRecord[],
  templateId: string,
): ScenarioRecord | null {
  const tag = scenarioTemplateTag(templateId);
  return scenarios.find((scenario) => scenario.tags.includes(tag)) ?? null;
}
