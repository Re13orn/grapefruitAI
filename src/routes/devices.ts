import { Hono } from "hono";
import frida from "../lib/xvii.ts";
import {
  app as serializeApp,
  device as serializeDevice,
  process as serializeProcess,
} from "../lib/serializer.ts";
import { getDeviceMiddleware } from "../lib/middleware.ts";
import { resolveDevice } from "../lib/device.ts";
import env from "../lib/env.ts";

const manager = frida.getDeviceManager();
const SOCKET_PREFIX = "socket@";

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

const routes = new Hono()
  .get("/devices", async (c) => {
    const skip = new Set(["local", "socket", "barebone"]);
    const devices = await frida.enumerateDevices();
    return c.json(
      devices.filter((dev) => !skip.has(dev.id)).map(serializeDevice),
    );
  })
  .get("/device/:device/apps", getDeviceMiddleware, async (c) => {
    const device = c.get("device");
    const apps = await device.enumerateApplications();

    // Some Android environments may return duplicate entries for the same
    // package name. Keep one row per identifier to avoid unstable UI keys.
    const dedup = new Map<string, ReturnType<typeof serializeApp>>();
    for (const app of apps) {
      const next = serializeApp(app);
      const current = dedup.get(next.identifier);

      if (!current) {
        dedup.set(next.identifier, next);
        continue;
      }

      // Prefer running instance over background/unknown pid.
      if (current.pid === 0 && next.pid !== 0) {
        dedup.set(next.identifier, next);
      }
    }

    return c.json(Array.from(dedup.values()));
  })
  .get("/device/:device/processes", getDeviceMiddleware, async (c) => {
    const device = c.get("device");
    const processes = await device.enumerateProcesses({
      scope: frida.Scope.Metadata,
    });
    // filter out launchd for safety
    return c.json(
      processes
        .filter((proc) => proc.pid !== 1 && proc.name !== "launchd")
        .map(serializeProcess),
    );
  })
  .get("/device/:device/icon/:bundle", async (c) => {
    const deviceId = c.req.param("device");
    const bundle = c.req.param("bundle");

    if (!deviceId) {
      return c.text("device not found", 404);
    }

    const device = await resolveDevice(deviceId).catch(() => null);
    if (!device) {
      return c.text("device not found", 404);
    }

    const apps = await device
      .enumerateApplications({
        identifiers: [bundle],
        scope: frida.Scope.Full,
      })
      .catch(() => []);

    const app = apps.at(0);
    if (!app) {
      return c.text("application not found", 404);
    }

    const { icons } = app.parameters as {
      icons?: { format: string; image: Buffer }[];
    };

    if (icons && icons.length) {
      const ico = icons.find((i) => i.format === "png");
      if (ico && ico.image) {
        c.header("Content-Type", "image/png");
        c.header("Cache-Control", "public, max-age=604800"); // 7 days
        return c.body(new Uint8Array(ico.image));
      }
    }

    return c.text("icon not found", 404);
  })
  .get("/device/:device/info", getDeviceMiddleware, async (c) => {
    const device = c.get("device");
    return c.json(await device.querySystemParameters());
  })
  .post("/device/:device/kill/:pid", getDeviceMiddleware, async (c) => {
    const device = c.get("device");
    const pid = parseInt(c.req.param("pid"), 10);
    if (isNaN(pid)) {
      return c.json({ error: "invalid pid" }, 400);
    }
    try {
      await device.kill(pid);
      return c.body(null, 204);
    } catch (e) {
      console.error("Failed to kill process:", e);
      return c.json({ error: "failed to kill process" }, 500);
    }
  })
  .put("/devices/remote/:hostname", async (c) => {
    const hostname = c.req.param("hostname");
    await manager.addRemoteDevice(normalizeRemoteHost(hostname));
    return c.body(null, 204);
  })
  .delete("/devices/remote/:hostname", async (c) => {
    const hostname = c.req.param("hostname");
    const dev = await findRemoteDevice(hostname);
    const deviceExists = !!dev;

    if (deviceExists) {
      const host = normalizeRemoteHost(hostname);
      await manager.removeRemoteDevice(host);
      return c.body(null, 204);
    } else {
      return c.json({ error: "remote device not found" }, 404);
    }
  });

export default routes;
