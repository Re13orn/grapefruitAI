import fs from "node:fs";
import nodePath from "node:path";
import envPaths from "env-paths";

const defaults = envPaths("ist.codecolor.grapefruit", { suffix: "" });
const paths = {
  data: defaults.data,
  config: defaults.config,
  cache: defaults.cache,
  log: defaults.log,
  temp: defaults.temp,
};
const keys = Object.keys(paths) as Array<keyof typeof paths>;
const keySet = new Set<string>(keys);

const fallbackBase =
  process.env.IGF_STATE_DIR ||
  nodePath.join(process.cwd(), ".grapefruit-state");

const overrides: Partial<Record<keyof typeof paths, string | undefined>> = {
  data: process.env.IGF_DATA_DIR,
  cache: process.env.IGF_CACHE_DIR,
  config: process.env.IGF_CONFIG_DIR,
  log: process.env.IGF_LOG_DIR,
  temp: process.env.IGF_TEMP_DIR,
};

for (const key of keys) {
  const overridden = overrides[key];
  if (typeof overridden === "string" && overridden.length > 0) {
    paths[key] = overridden;
  }
}

function isWritableDir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const proxy = new Proxy(paths, {
  get(target, prop, receiver) {
    const original = Reflect.get(target, prop, receiver);

    if (typeof prop !== "string" || !keySet.has(prop)) {
      return original;
    }

    const key = prop as keyof typeof paths;
    const dir = String(target[key]);
    if (isWritableDir(dir)) {
      return dir;
    }

    const fallback = nodePath.join(fallbackBase, prop);
    if (isWritableDir(fallback)) {
      target[key] = fallback;
      return fallback;
    }

    return dir;
  },
});

export default proxy;
