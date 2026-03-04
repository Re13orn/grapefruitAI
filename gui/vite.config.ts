import fs from "fs";
import path from "path";

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Do not use generic PORT here.
// In some environments PORT points to Vite dev server port (e.g. 5173),
// which makes /api proxy loop back to frontend and return index.html.
const backendPort =
  process.env.BACKEND_PORT ||
  process.env.GRAPEFRUIT_BACKEND_PORT ||
  "31337";
const backendHost =
  process.env.BACKEND_HOST ||
  process.env.GRAPEFRUIT_BACKEND_HOST ||
  "127.0.0.1";

function formatHostForUrl(host: string) {
  return host.includes(":") && !host.startsWith("[")
    ? `[${host}]`
    : host;
}

const api = `http://${formatHostForUrl(backendHost)}:${backendPort}`;

const R2_WASM_PATH = path.join(
  import.meta.dirname,
  "node_modules",
  "@frida",
  "react-use-r2",
  "dist",
  "r2.wasm",
);

const r2WasmPlugin: Plugin = {
  name: "r2-wasm-plugin",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.originalUrl?.endsWith("/r2.wasm")) {
        const data = fs.readFileSync(R2_WASM_PATH);
        res.setHeader("Content-Length", data.length);
        res.setHeader("Content-Type", "application/wasm");
        res.end(data, "binary");
        return;
      }
      next();
    });
  },
};

// https://vite.dev/config/
export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: api,
        changeOrigin: true,
        secure: false,
      },
      "/socket.io/": {
        target: api,
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
  plugins: [react(), tailwindcss(), r2WasmPlugin],
  assetsInclude: "**/*.wasm",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@agent": path.resolve(__dirname, "..", "agent", "types"),
    },
  },
});
