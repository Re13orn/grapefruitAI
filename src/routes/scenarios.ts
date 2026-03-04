import { Hono } from "hono";

import { runScenario } from "../lib/scenario-runner.ts";
import {
  createScenarioDraftFromTemplate,
  findScenarioByTemplateTag,
  listScenarioTemplates,
} from "../lib/scenario-templates.ts";
import {
  createScenarioRunStore,
  createScenarioStore,
  normalizeScenarioDraft,
  normalizeScenarioPatch,
  type ScenarioMode,
  type ScenarioPlatform,
  type ScenarioRunTarget,
} from "../lib/store/scenarios.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "string") {
    throw new Error("value must be a string");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value === "undefined") return [];
  if (!Array.isArray(value)) {
    throw new Error('"tags" must be an array of strings');
  }
  const set = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error('"tags" must be an array of strings');
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    set.add(trimmed);
  }
  return [...set];
}

function parseRunTarget(body: unknown): ScenarioRunTarget {
  if (!isRecord(body)) return {};

  const platform = body.platform;
  const mode = body.mode;
  const bundle = body.bundle;
  const pid = body.pid;

  const target: ScenarioRunTarget = {};

  if (typeof platform !== "undefined") {
    if (platform !== "fruity" && platform !== "droid") {
      throw new Error('"platform" must be "fruity" or "droid"');
    }
    target.platform = platform as ScenarioPlatform;
  }

  if (typeof mode !== "undefined") {
    if (mode !== "app" && mode !== "daemon") {
      throw new Error('"mode" must be "app" or "daemon"');
    }
    target.mode = mode as ScenarioMode;
  }

  if (typeof bundle !== "undefined") {
    if (typeof bundle !== "string" || bundle.trim().length === 0) {
      throw new Error('"bundle" must be a non-empty string');
    }
    target.bundle = bundle.trim();
  }

  if (typeof pid !== "undefined") {
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
      throw new Error('"pid" must be a positive number');
    }
    target.pid = Math.floor(pid);
  }

  return target;
}

const routes = new Hono()
  .get("/scenario-templates", (c) => {
    return c.json(listScenarioTemplates());
  })
  .post("/scenarios/:device/:identifier/import-template", async (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const body = await c.req.json().catch(() => null);

    if (!isRecord(body)) {
      return c.json({ error: "invalid payload" }, 400);
    }

    try {
      if (typeof body.templateId !== "string" || body.templateId.trim().length === 0) {
        throw new Error('"templateId" must be a non-empty string');
      }

      const templateId = body.templateId.trim();
      const overwrite = body.overwrite === true;
      const name = asOptionalString(body.name);
      const description = asOptionalString(body.description);
      const tags = parseStringArray(body.tags);

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
      if (!scenario) throw new Error(`failed to import template: ${templateId}`);

      return c.json(
        {
          templateId,
          action: overwrite && existing ? "updated" : "created",
          scenario,
        },
        overwrite && existing ? 200 : 201,
      );
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : "failed to import template",
        },
        400,
      );
    }
  })
  .post("/scenarios/:device/:identifier/import-templates", async (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const body = await c.req.json().catch(() => ({}));
    const payload = isRecord(body) ? body : {};

    try {
      const overwrite = payload.overwrite === true;
      const templateIds = Array.isArray(payload.templateIds)
        ? payload.templateIds
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : listScenarioTemplates().map((template) => template.id);

      const dedupTemplateIds = Array.from(new Set(templateIds));
      const store = createScenarioStore(deviceId, identifier);
      const scenarios = store.list();
      const created: string[] = [];
      const updated: string[] = [];
      const skipped: string[] = [];

      for (const templateId of dedupTemplateIds) {
        const draft = createScenarioDraftFromTemplate(templateId);
        const existing = findScenarioByTemplateTag(scenarios, templateId);

        if (existing && !overwrite) {
          skipped.push(templateId);
          continue;
        }

        if (existing) {
          const next = store.update(existing.id, {
            name: draft.name,
            description: draft.description,
            tags: draft.tags,
            steps: draft.steps,
          });
          if (next) {
            updated.push(templateId);
          } else {
            skipped.push(templateId);
          }
        } else {
          store.create(draft);
          created.push(templateId);
        }
      }

      return c.json({
        total: dedupTemplateIds.length,
        created,
        updated,
        skipped,
      });
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : "failed to import templates",
        },
        400,
      );
    }
  })
  .get("/scenarios/:device/:identifier", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    return c.json(createScenarioStore(deviceId, identifier).list());
  })
  .post("/scenarios/:device/:identifier", async (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const body = await c.req.json().catch(() => null);

    try {
      const draft = normalizeScenarioDraft(body);
      const created = createScenarioStore(deviceId, identifier).create(draft);
      return c.json(created, 201);
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : "invalid scenario payload",
        },
        400,
      );
    }
  })
  .put("/scenarios/:device/:identifier/:id", async (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);

    try {
      const patch = normalizeScenarioPatch(body);
      const updated = createScenarioStore(deviceId, identifier).update(id, patch);
      if (!updated) return c.json({ error: "scenario not found" }, 404);
      return c.json(updated);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "invalid scenario patch" },
        400,
      );
    }
  })
  .delete("/scenarios/:device/:identifier/:id", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const id = c.req.param("id");

    const removed = createScenarioStore(deviceId, identifier).remove(id);
    if (!removed) return c.json({ error: "scenario not found" }, 404);
    return c.body(null, 204);
  })
  .post("/scenarios/:device/:identifier/:id/run", async (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const id = c.req.param("id");

    const scenarioStore = createScenarioStore(deviceId, identifier);
    const runStore = createScenarioRunStore(deviceId, identifier);
    const scenario = scenarioStore.get(id);
    if (!scenario) return c.json({ error: "scenario not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    let target: ScenarioRunTarget = {};
    try {
      target = parseRunTarget(body);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "invalid run payload" },
        400,
      );
    }

    const stopOnFailure = isRecord(body) ? body.stopOnFailure !== false : true;
    try {
      const run = await runScenario({
        deviceId,
        identifier,
        scenario,
        target,
        stopOnFailure,
      });
      runStore.append(run);
      return c.json(run);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "scenario run failed" },
        500,
      );
    }
  })
  .get("/scenario-runs/:device/:identifier", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const scenarioId = c.req.query("scenarioId");
    return c.json(
      createScenarioRunStore(deviceId, identifier).list({
        scenarioId: scenarioId || undefined,
      }),
    );
  })
  .get("/scenario-runs/:device/:identifier/:runId", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const runId = c.req.param("runId");

    const run = createScenarioRunStore(deviceId, identifier).get(runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    return c.json(run);
  })
  .delete("/scenario-runs/:device/:identifier/:runId", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    const runId = c.req.param("runId");

    const removed = createScenarioRunStore(deviceId, identifier).remove(runId);
    if (!removed) return c.json({ error: "run not found" }, 404);
    return c.body(null, 204);
  })
  .delete("/scenario-runs/:device/:identifier", (c) => {
    const deviceId = c.req.param("device");
    const identifier = c.req.param("identifier");
    createScenarioRunStore(deviceId, identifier).clear();
    return c.body(null, 204);
  });

export default routes;
