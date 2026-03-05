const bridges = ["ObjC", "Swift", "Java"] as const;
const SCRIPT_APPLY_ACK_FIELD = "__igf_script_apply_ack";
const SCRIPT_APPLY_ERROR_FIELD = "scriptApplyAck";

interface ScriptApplyAck {
  scriptName: string;
  compileOk: boolean;
  hookedMethods: number;
  installedHooksSync: number;
  failedMethods: string[];
  hitCount: number;
  firstHitAt?: string;
  lastHitAt?: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

interface ScriptApplyResult {
  [SCRIPT_APPLY_ACK_FIELD]: ScriptApplyAck;
  value: unknown;
}

interface PingbackMessage {
  filename: string;
  source: string;
}

function loadBridge(name: (typeof bridges)[number]) {
  let bridge: unknown;

  send({ subject: "frida:load-bridge", name });
  recv("frida:bridge-loaded", (message: PingbackMessage) => {
    bridge = Script.evaluate(
      `/frida/bridges/${message.filename}`,
      "(function () { " +
        [
          message.source,
          `Object.defineProperty(globalThis, '${name}', { value: bridge });`,
          `return bridge;`,
        ].join("\n") +
        " })();",
    );
  }).wait();

  return bridge;
}

function init() {
  for (const name of bridges) {
    Object.defineProperty(globalThis, name, {
      enumerable: true,
      configurable: true,
      get: () => loadBridge(name),
    });
  }
}

let initialized = false;

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeLabel(label: unknown): string {
  if (typeof label === "string" && label.trim().length > 0) return label;
  if (typeof label === "symbol") return label.toString();
  return String(label);
}

function tryPatchMethod(
  target: object,
  key: string,
  replacement: unknown,
): (() => void) | null {
  const record = target as Record<string, unknown>;
  const original = record[key];
  try {
    record[key] = replacement;
  } catch {
    return null;
  }
  return () => {
    try {
      record[key] = original;
    } catch {
      // ignored
    }
  };
}

class ScriptHookTracker {
  readonly startedAt = new Date().toISOString();
  private readonly hooked = new Set<string>();
  private readonly failed = new Map<string, string>();
  private scriptName = "userscript";
  private hitCount = 0;
  private firstHitAt: string | undefined;
  private lastHitAt: string | undefined;

  bindScriptName(name: string) {
    this.scriptName = name.trim().length > 0 ? name : "userscript";
  }

  trackHook(name: string) {
    if (name.trim().length === 0) return;
    this.hooked.add(name);
  }

  trackFailure(name: string, error: unknown) {
    const key = name.trim().length > 0 ? name : "unknown";
    if (this.failed.has(key)) return;
    this.failed.set(key, normalizeError(error));
  }

  trackRuntimeHit(hookLabel: string) {
    const timestamp = new Date().toISOString();
    this.hitCount += 1;
    if (!this.firstHitAt) {
      this.firstHitAt = timestamp;
    }
    this.lastHitAt = timestamp;

    try {
      send({
        subject: "hook",
        category: "script.apply.hit",
        symbol: this.scriptName,
        dir: "leave",
        line: `script_apply_hit ${this.scriptName} count=${this.hitCount}`,
        extra: {
          scriptName: this.scriptName,
          hookLabel,
          hitCount: this.hitCount,
          firstHitAt: this.firstHitAt,
          lastHitAt: this.lastHitAt,
        },
      });
    } catch {
      // ignore send failures in hook wrappers
    }
  }

  build(scriptName: string, compileOk: boolean, error?: unknown): ScriptApplyAck {
    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(
      0,
      Date.parse(finishedAt) - Date.parse(this.startedAt),
    );
    return {
      scriptName,
      compileOk,
      hookedMethods: this.hooked.size,
      installedHooksSync: this.hooked.size,
      failedMethods: Array.from(this.failed.keys()).slice(0, 100),
      hitCount: this.hitCount,
      firstHitAt: this.firstHitAt,
      lastHitAt: this.lastHitAt,
      error: typeof error === "undefined" ? undefined : normalizeError(error),
      startedAt: this.startedAt,
      finishedAt,
      durationMs,
    };
  }
}

function withInterceptorTracking(
  tracker: ScriptHookTracker,
): (() => void) | null {
  const interceptor = (
    globalThis as unknown as { Interceptor?: { attach?: unknown } }
  ).Interceptor;
  if (!interceptor || typeof interceptor.attach !== "function") return null;

  const originalAttach = interceptor.attach;
  const restoreAttach = tryPatchMethod(interceptor as object, "attach", function patchedAttach(
    this: unknown,
    target: unknown,
    callbacks: unknown,
    data?: unknown,
  ) {
      const label = `Interceptor.attach(${String(target)})`;
      try {
        const attach = originalAttach as (
          target: unknown,
          callbacks: unknown,
          data?: unknown,
        ) => unknown;
        const callbackObj =
          callbacks && typeof callbacks === "object"
            ? (callbacks as Record<string, unknown>)
            : {};
        const wrappedCallbacks: Record<string, unknown> = { ...callbackObj };
        for (const phase of ["onEnter", "onLeave"] as const) {
          const fn = callbackObj[phase];
          if (typeof fn !== "function") continue;
          wrappedCallbacks[phase] = function (this: unknown, ...args: unknown[]) {
            tracker.trackRuntimeHit(`${label}.${phase}`);
            return (fn as (...inner: unknown[]) => unknown).apply(this, args);
          };
        }
        const listener = attach.call(this, target, wrappedCallbacks, data);
        tracker.trackHook(label);
        return listener;
      } catch (error) {
        tracker.trackFailure(label, error);
        throw error;
    }
  });
  if (!restoreAttach) {
    tracker.trackFailure("Interceptor.attach", "attach is read-only");
    return null;
  }
  return restoreAttach;
}

function withObjCImplementTracking(
  tracker: ScriptHookTracker,
): (() => void) | null {
  const objc = (
    globalThis as unknown as { ObjC?: { implement?: unknown } }
  ).ObjC;
  if (!objc || typeof objc.implement !== "function") return null;

  const originalImplement = objc.implement;
  const restoreImplement = tryPatchMethod(objc as object, "implement", function patchedImplement(
    this: unknown,
    method: unknown,
    fn: unknown,
  ) {
    const label = `ObjC.implement(${String(method)})`;
    try {
      const implement = originalImplement as (
        method: unknown,
        fn: unknown,
      ) => unknown;
      const wrappedFn =
        typeof fn === "function"
          ? function (this: unknown, ...args: unknown[]) {
              tracker.trackRuntimeHit(label);
              return (fn as (...inner: unknown[]) => unknown).apply(this, args);
            }
          : fn;
      const result = implement.call(this, method, wrappedFn);
      tracker.trackHook(label);
      return result;
    } catch (error) {
      tracker.trackFailure(label, error);
      throw error;
    }
  });
  if (!restoreImplement) {
    tracker.trackFailure("ObjC.implement", "implement is read-only");
    return null;
  }
  return restoreImplement;
}

function createJavaMethodProxy(
  value: object,
  label: string,
  tracker: ScriptHookTracker,
  methodCache: WeakMap<object, unknown>,
): unknown {
  const cached = methodCache.get(value);
  if (cached) return cached;

  const proxy = new Proxy(value, {
    get(target, prop, receiver) {
      const result = Reflect.get(target, prop, receiver);
      if (prop === "overload" && typeof result === "function") {
        return (...args: unknown[]) => {
          const overloadLabel = `${label}.overload(${args
            .map((arg) => String(arg))
            .join(",")})`;
          try {
            const overload = Reflect.apply(result, target, args);
            if (
              overload &&
              (typeof overload === "object" || typeof overload === "function")
            ) {
              return createJavaMethodProxy(
                overload as object,
                overloadLabel,
                tracker,
                methodCache,
              );
            }
            return overload;
          } catch (error) {
            tracker.trackFailure(overloadLabel, error);
            throw error;
          }
        };
      }
      return result;
    },
    set(target, prop, newValue, receiver) {
      if (prop === "implementation") {
        const implLabel = `${label}.implementation`;
        try {
          const wrappedValue =
            typeof newValue === "function"
              ? function (this: unknown, ...args: unknown[]) {
                  tracker.trackRuntimeHit(implLabel);
                  return (newValue as (...inner: unknown[]) => unknown).apply(
                    this,
                    args,
                  );
                }
              : newValue;
          const ok = Reflect.set(target, prop, wrappedValue, receiver);
          if (ok) tracker.trackHook(implLabel);
          else tracker.trackFailure(implLabel, "implementation assignment failed");
          return ok;
        } catch (error) {
          tracker.trackFailure(implLabel, error);
          throw error;
        }
      }
      return Reflect.set(target, prop, newValue, receiver);
    },
  });

  methodCache.set(value, proxy);
  return proxy;
}

function createJavaClassProxy(
  cls: object,
  className: string,
  tracker: ScriptHookTracker,
  classCache: WeakMap<object, unknown>,
  methodCache: WeakMap<object, unknown>,
): unknown {
  const cached = classCache.get(cls);
  if (cached) return cached;

  const proxy = new Proxy(cls, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (!value || (typeof value !== "object" && typeof value !== "function")) {
        return value;
      }
      return createJavaMethodProxy(
        value as object,
        `${className}.${normalizeLabel(prop)}`,
        tracker,
        methodCache,
      );
    },
  });
  classCache.set(cls, proxy);
  return proxy;
}

function withJavaImplementationTracking(
  tracker: ScriptHookTracker,
): (() => void) | null {
  const java = (globalThis as unknown as { Java?: { use?: unknown } }).Java;
  if (!java || typeof java.use !== "function") return null;

  const originalUse = java.use;
  const classCache = new WeakMap<object, unknown>();
  const methodCache = new WeakMap<object, unknown>();

  const restoreUse = tryPatchMethod(java as object, "use", function patchedJavaUse(
    this: unknown,
    className: string,
  ) {
    const label = `Java.use(${className})`;
    try {
      const use = originalUse as (className: string) => unknown;
      const cls = use.call(this, className);
      if (!cls || (typeof cls !== "object" && typeof cls !== "function")) {
        tracker.trackFailure(label, "Java.use returned non-object");
        return cls;
      }
      return createJavaClassProxy(
        cls as object,
        className,
        tracker,
        classCache,
        methodCache,
      );
    } catch (error) {
      tracker.trackFailure(label, error);
      throw error;
    }
  });
  if (!restoreUse) {
    tracker.trackFailure("Java.use", "use is read-only");
    return null;
  }
  return restoreUse;
}

function withHookTracking(tracker: ScriptHookTracker): () => void {
  const restoreTasks = [
    withJavaImplementationTracking(tracker),
    withInterceptorTracking(tracker),
    withObjCImplementTracking(tracker),
  ].filter((item): item is () => void => typeof item === "function");

  return () => {
    for (let i = restoreTasks.length - 1; i >= 0; i--) {
      try {
        restoreTasks[i]!();
      } catch {
        // ignored
      }
    }
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function evaluate(source: string, name = "userscript"): any {
  if (!initialized) {
    init();
    initialized = true;
  }

  const tracker = new ScriptHookTracker();
  tracker.bindScriptName(name);
  const restore = withHookTracking(tracker);

  try {
    const value = Script.evaluate(name, source);
    const ack = tracker.build(name, true);
    const result: ScriptApplyResult = {
      [SCRIPT_APPLY_ACK_FIELD]: ack,
      value,
    };
    return result;
  } catch (error) {
    const ack = tracker.build(name, false, error);
    const wrapped = new Error(normalizeError(error));
    (wrapped as Error & { [SCRIPT_APPLY_ERROR_FIELD]: ScriptApplyAck })[
      SCRIPT_APPLY_ERROR_FIELD
    ] = ack;
    throw wrapped;
  } finally {
    restore();
  }
}
