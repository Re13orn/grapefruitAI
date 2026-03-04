import { createMiddleware } from "hono/factory";
import { type Device } from "frida";

import { resolveDevice } from "./device.ts";

export const getDeviceMiddleware = createMiddleware<{
  Variables: {
    device: Device;
    bundle?: string;
  };
}>(async (c, next) => {
  const deviceId = c.req.param("device");
  if (!deviceId) {
    return c.json({ error: "device not found" }, 404);
  }

  const device = await resolveDevice(deviceId).catch(() => null);
  if (!device) {
    return c.json({ error: "device not found" }, 404);
  }

  c.set("device", device);
  await next();
});
