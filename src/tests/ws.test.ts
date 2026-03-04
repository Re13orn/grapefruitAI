import { type AddressInfo } from "node:net";
import { createServer } from "node:http";
import { describe, it, expect } from "bun:test";

import frida from "frida";
import ioc from "socket.io-client";
import type { Server } from "socket.io";

import attach from "../ws.ts";
import { getUDID, probeLocalTcpListener } from "./helpers/environment.ts";

function createTestServer() {
  const server = createServer();
  const io = attach(server) as Server;
  return { server, io };
}

async function startTestServer() {
  const { server, io } = createTestServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, io };
}

async function closeTestServer(
  server: ReturnType<typeof createServer>,
  io: Server,
) {
  io.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const listenProbe = await probeLocalTcpListener();
if (!listenProbe.ok) {
  console.warn(
    `Skipping ws tests requiring local TCP listener: ${listenProbe.reason}`,
  );
}

const udid = getUDID();
const hasUDID = udid !== null;
if (!hasUDID) {
  console.warn("Skipping /session test: UDID environment variable not set");
}

describe("socket.io tests", () => {
  it.skipIf(!listenProbe.ok)(
    "should notify clients on device change",
    async () => {
      const { server, io } = await startTestServer();

      const mgr = frida.getDeviceManager();
      const { port } = server.address() as AddressInfo;
      const socket = ioc(`http://localhost:${port}/devices`);

      try {
        let receivedChange = false;
        let connected = false;

        socket.on("change", () => {
          receivedChange = true;
          console.debug("Received device change event");
          socket.disconnect();
        });

        socket.on("connect", () => {
          connected = true;
          expect(socket.connected).toBe(true);
          mgr.addRemoteDevice("127.0.0.1");
        });

        // Wait for events
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(connected).toBe(true);
        expect(receivedChange).toBe(true);
      } finally {
        socket.disconnect();
        await closeTestServer(server, io);
      }
    },
    { timeout: 5000 },
  );

  it.skipIf(!listenProbe.ok || !hasUDID)(
    "should run rpc tests",
    async () => {
      const deviceId = udid as string;

      const { server, io } = await startTestServer();

      const { port } = server.address() as AddressInfo;
      const query = new URLSearchParams({
        device: deviceId,
        bundle: "com.apple.mobilesafari",
      });
      const socket = ioc(
        `http://localhost:${port}/session?${query.toString()}`,
      );

      try {
        let receivedReady = false;

        socket.on("ready", () => {
          receivedReady = true;
          console.debug("Session ready, connection established");
          socket.emit("rpc", "invalid");
          socket.emit(
            "rpc",
            "fs",
            "ls",
            ["bundle"],
            (err: Error | null, result: any) => {
              console.log("rpc result:", result);
              socket.disconnect();
            },
          );
        });

        // Wait for events
        await new Promise((resolve) => setTimeout(resolve, 8000));

        expect(receivedReady).toBe(true);
      } finally {
        socket.disconnect();
        await closeTestServer(server, io);
      }
    },
    { timeout: 15000 },
  );
});
