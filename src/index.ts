import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import app from "./app.ts";
import attach from "./ws.ts";
import env from "./lib/env.ts";
import { asset } from "./lib/assets.ts";

{
  if (!["16", "17"].includes(String(env.frida))) {
    console.error(
      "Invalid Frida version specified. Use --frida 16 or --frida 17.",
    );
    process.exit(1);
  }
}

{
  function serveWeb(root: string) {
    app.use("/assets/*", serveStatic({ root }));
    app.use("/*", serveStatic({ root, path: "index.html" }));
  }

  // bug: when compiled by bun single-file executable, the runtime will set
  // NODE_ENV to "development". Does it make any sense?

  if (env.bunSEA || !env.dev) {
    serveWeb(await asset("gui", "dist"));
  }
}

const server = serve(
  {
    fetch: app.fetch,
    port: env.port,
    hostname: env.host,
  },
  (info) => {
    const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
    console.info(`Server is running on http://${host}:${info.port}`);
    attach(server);
  },
);

const shutdownSignals: NodeJS.Signals[] = [
  "SIGINT",
  "SIGTERM",
  ...(process.platform === "win32" ? (["SIGBREAK"] as const) : []),
];
let shuttingDown = false;

for (const sig of shutdownSignals) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log("received signal", sig);
    const forceExitTimer = setTimeout(() => {
      console.warn("force exiting after graceful shutdown timeout");
      process.exit(1);
    }, 5_000);
    forceExitTimer.unref();

    server.close(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  });
}

process
  .on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
  })
  .on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  });
