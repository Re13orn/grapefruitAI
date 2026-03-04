import type { Device } from "frida";

import frida from "./xvii.ts";
import env from "./env.ts";

const manager = frida.getDeviceManager();
const SOCKET_PREFIX = "socket@";

export function toRemoteHost(deviceId: string): string | null {
  const host = deviceId.startsWith(SOCKET_PREFIX)
    ? deviceId.slice(SOCKET_PREFIX.length)
    : deviceId;

  return host.includes(":") ? host : null;
}

export async function resolveDevice(deviceId: string): Promise<Device> {
  try {
    return await manager.getDeviceById(deviceId, env.timeout);
  } catch (originalError) {
    const remoteHost = toRemoteHost(deviceId);
    if (!remoteHost) throw originalError;

    await manager.addRemoteDevice(remoteHost);

    try {
      return await manager.getDeviceById(deviceId, env.timeout);
    } catch {
      const altId = deviceId.startsWith(SOCKET_PREFIX)
        ? remoteHost
        : `${SOCKET_PREFIX}${remoteHost}`;
      return await manager.getDeviceById(altId, env.timeout);
    }
  }
}
