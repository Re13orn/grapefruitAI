import Java from "frida-java-bridge";

function hasLiveHandle(value: unknown): value is Java.Wrapper {
  if (!value || typeof value !== "object") return false;
  const holder = value as {
    $h?: { isNull?: () => boolean } | null;
  };
  if (!("$h" in holder)) return true;
  if (holder.$h === null) return false;
  if (holder.$h && typeof holder.$h.isNull === "function") {
    try {
      return holder.$h.isNull() === false;
    } catch {
      return false;
    }
  }
  return true;
}

function tryGetApplicationContext(app: unknown): Java.Wrapper | null {
  if (!hasLiveHandle(app)) return null;
  const candidate = app as Java.Wrapper & {
    getApplicationContext?: () => Java.Wrapper | null;
  };
  if (typeof candidate.getApplicationContext !== "function") return null;

  try {
    const ctx = candidate.getApplicationContext();
    return hasLiveHandle(ctx) ? ctx : null;
  } catch {
    return null;
  }
}

export function getContext(timeoutMs = 5_000): Java.Wrapper {
  const ActivityThread = Java.use(
    "android.app.ActivityThread",
  ) as unknown as {
    currentApplication: () => Java.Wrapper | null;
    currentActivityThread: () => (Java.Wrapper & {
      getApplication?: () => Java.Wrapper | null;
    }) | null;
  };
  const SystemClock = Java.use("android.os.SystemClock");

  let AppGlobals:
    | { getInitialApplication: () => Java.Wrapper | null }
    | null = null;
  try {
    AppGlobals = Java.use("android.app.AppGlobals") as unknown as {
      getInitialApplication: () => Java.Wrapper | null;
    };
  } catch {
    AppGlobals = null;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctx = tryGetApplicationContext(ActivityThread.currentApplication());
      if (ctx) return ctx;
    } catch {
      // Ignore and keep polling until timeout.
    }

    if (AppGlobals) {
      try {
        const ctx = tryGetApplicationContext(AppGlobals.getInitialApplication());
        if (ctx) return ctx;
      } catch {
        // Ignore and keep polling until timeout.
      }
    }

    try {
      const thread = ActivityThread.currentActivityThread();
      const ctx = tryGetApplicationContext(thread?.getApplication?.());
      if (ctx) return ctx;
    } catch {
      // Ignore and keep polling until timeout.
    }

    SystemClock.sleep(50);
  }

  throw new Error(
    "Application context is not available yet (app may still be starting)",
  );
}
