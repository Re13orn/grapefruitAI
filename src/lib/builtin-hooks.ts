import fs from "node:fs";
import nodePath from "node:path";

export type BuiltinHookPlatform = "droid" | "fruity" | "any";

export interface BuiltinHookScriptTemplate {
  id: string;
  name: string;
  description: string;
  platform: BuiltinHookPlatform;
  identifiers: string[];
  content: string;
  enabled: boolean;
  runOnAppLaunch: boolean;
}

export const UNCRACKABLE1_ROOT_BYPASS_SCRIPT = [
  "Java.perform(function () {",
  "  function mark(symbol, phase, extra) {",
  "    try {",
  "      send({",
  "        subject: 'hook',",
  "        category: 'builtin.uncrackable1',",
  "        symbol: symbol,",
  "        dir: phase === 'enter' ? 'enter' : 'leave',",
  "        line: phase + ' ' + symbol,",
  "        extra: Object.assign({ phase: phase }, extra || {}),",
  "      });",
  "    } catch (_) {}",
  "  }",
  "",
  "  try {",
  "    const RootCheck = Java.use('sg.vantagepoint.a.c');",
  "    RootCheck.a.implementation = function () {",
  "      mark('sg.vantagepoint.a.c.a', 'leave', { bypass: true });",
  "      return false;",
  "    };",
  "    RootCheck.b.implementation = function () {",
  "      mark('sg.vantagepoint.a.c.b', 'leave', { bypass: true });",
  "      return false;",
  "    };",
  "    RootCheck.c.implementation = function () {",
  "      mark('sg.vantagepoint.a.c.c', 'leave', { bypass: true });",
  "      return false;",
  "    };",
  "  } catch (e) {",
  "    mark('sg.vantagepoint.a.c', 'error', { message: String(e) });",
  "  }",
  "",
  "  try {",
  "    const DebugCheck = Java.use('sg.vantagepoint.a.b');",
  "    const isDebuggable = DebugCheck.a.overload('android.content.Context');",
  "    isDebuggable.implementation = function (_ctx) {",
  "      mark('sg.vantagepoint.a.b.a', 'leave', { bypass: true });",
  "      return false;",
  "    };",
  "  } catch (e) {",
  "    mark('sg.vantagepoint.a.b', 'error', { message: String(e) });",
  "  }",
  "",
  "  try {",
  "    const MainActivity = Java.use('sg.vantagepoint.uncrackable1.MainActivity');",
  "    if (MainActivity.a) {",
  "      MainActivity.a.overload('java.lang.String').implementation = function (msg) {",
  "        mark('MainActivity.a', 'enter', { message: String(msg), bypass: true });",
  "        return;",
  "      };",
  "    }",
  "  } catch (e) {",
  "    mark('sg.vantagepoint.uncrackable1.MainActivity.a', 'error', { message: String(e) });",
  "  }",
  "",
  "  try {",
  "    const System = Java.use('java.lang.System');",
  "    System.exit.overload('int').implementation = function (code) {",
  "      mark('System.exit', 'enter', { code: code, blocked: true });",
  "      return;",
  "    };",
  "  } catch (e) {",
  "    mark('java.lang.System.exit', 'error', { message: String(e) });",
  "  }",
  "});",
].join("\n");

export const UNCRACKABLE2_EARLY_BYPASS_SCRIPT = [
  "if (typeof Java !== 'undefined' && Java.available) {",
  "  const run = typeof Java.performNow === 'function' ? Java.performNow : Java.perform;",
  "  run(function () {",
  "    function mark(symbol, phase, extra) {",
  "      try {",
  "        send({",
  "          subject: 'hook',",
  "          category: 'builtin.uncrackable2',",
  "          symbol: symbol,",
  "          dir: phase === 'enter' ? 'enter' : 'leave',",
  "          line: phase + ' ' + symbol,",
  "          extra: Object.assign({ phase: phase }, extra || {}),",
  "        });",
  "      } catch (_) {}",
  "    }",
  "",
  "    function protect(name, installer) {",
  "      try {",
  "        installer();",
  "        mark(name, 'leave', { installed: true });",
  "      } catch (e) {",
  "        mark(name, 'error', { message: String(e) });",
  "      }",
  "    }",
  "",
  "    protect('root-check', function () {",
  "      const RootCheck = Java.use('sg.vantagepoint.a.c');",
  "      RootCheck.a.implementation = function () { return false; };",
  "      RootCheck.b.implementation = function () { return false; };",
  "      RootCheck.c.implementation = function () { return false; };",
  "    });",
  "",
  "    protect('debug-check', function () {",
  "      const DebugCheck = Java.use('sg.vantagepoint.a.b');",
  "      DebugCheck.a.overload('android.content.Context').implementation = function () {",
  "        return false;",
  "      };",
  "      const Debug = Java.use('android.os.Debug');",
  "      Debug.isDebuggerConnected.implementation = function () { return false; };",
  "      Debug.waitingForDebugger.implementation = function () { return false; };",
  "    });",
  "",
  "    protect('app-exit', function () {",
  "      const System = Java.use('java.lang.System');",
  "      System.exit.overload('int').implementation = function (code) {",
  "        mark('System.exit', 'enter', { blocked: true, code: code });",
  "        return;",
  "      };",
  "      const Process = Java.use('android.os.Process');",
  "      Process.killProcess.overload('int').implementation = function (pid) {",
  "        mark('Process.killProcess', 'enter', { blocked: true, pid: pid });",
  "        return;",
  "      };",
  "    });",
  "",
  "    protect('dialog-bypass', function () {",
  "      const MainActivity = Java.use('sg.vantagepoint.uncrackable2.MainActivity');",
  "      if (MainActivity.a) {",
  "        MainActivity.a.overload('java.lang.String').implementation = function (msg) {",
  "          mark('MainActivity.a', 'enter', { blocked: true, message: String(msg) });",
  "          return;",
  "        };",
  "      }",
  "    });",
  "  });",
  "}",
  "",
  "try {",
  "  const ptrace = Module.findExportByName(null, 'ptrace');",
  "  if (ptrace) {",
  "    Interceptor.attach(ptrace, {",
  "      onEnter(args) {",
  "        this.req = args[0].toInt32();",
  "      },",
  "      onLeave(retval) {",
  "        if (this.req === 0 || this.req === 31) {",
  "          retval.replace(ptr(0));",
  "          try {",
  "            send({",
  "              subject: 'hook',",
  "              category: 'builtin.uncrackable2',",
  "              symbol: 'ptrace',",
  "              dir: 'leave',",
  "              line: 'leave ptrace',",
  "              extra: { bypass: true, request: this.req },",
  "            });",
  "          } catch (_) {}",
  "        }",
  "      },",
  "    });",
  "  }",
  "} catch (_) {}",
].join("\n");

export const ANDROID_ADAPTIVE_ROOT_DEBUG_BYPASS_SCRIPT = [
  "Java.perform(function () {",
  "  const MAX_DYNAMIC_HOOKS = 200;",
  "",
  "  function mark(symbol, phase, extra) {",
  "    try {",
  "      send({",
  "        subject: 'hook',",
  "        category: 'builtin.android.adaptive-bypass',",
  "        symbol: symbol,",
  "        dir: phase === 'enter' ? 'enter' : 'leave',",
  "        line: phase + ' ' + symbol,",
  "        extra: Object.assign({ phase: phase }, extra || {}),",
  "      });",
  "    } catch (_) {}",
  "  }",
  "",
  "  function protect(name, install) {",
  "    try {",
  "      install();",
  "      mark(name, 'leave', { installed: true });",
  "    } catch (e) {",
  "      mark(name, 'error', { message: String(e) });",
  "    }",
  "  }",
  "",
  "  function shouldBlockCommand(cmd) {",
  "    const value = String(cmd || '').toLowerCase();",
  "    return (",
  "      value.indexOf('su') >= 0 ||",
  "      value.indexOf('magisk') >= 0 ||",
  "      value.indexOf('busybox') >= 0 ||",
  "      value.indexOf('which') >= 0 ||",
  "      value.indexOf('getprop') >= 0 ||",
  "      value.indexOf('mount') >= 0 ||",
  "      value.indexOf('id') >= 0",
  "    );",
  "  }",
  "",
  "  protect('android.os.Debug', function () {",
  "    const Debug = Java.use('android.os.Debug');",
  "    Debug.isDebuggerConnected.implementation = function () {",
  "      mark('Debug.isDebuggerConnected', 'leave', { bypass: true });",
  "      return false;",
  "    };",
  "    Debug.waitingForDebugger.implementation = function () {",
  "      mark('Debug.waitingForDebugger', 'leave', { bypass: true });",
  "      return false;",
  "    };",
  "  });",
  "",
  "  protect('android.os.SystemProperties', function () {",
  "    const SystemProperties = Java.use('android.os.SystemProperties');",
  "    const suspicious = {",
  "      'ro.debuggable': '0',",
  "      'ro.secure': '1',",
  "      'service.adb.root': '0',",
  "    };",
  "    const getString = SystemProperties.get.overload('java.lang.String');",
  "    getString.implementation = function (key) {",
  "      const k = String(key);",
  "      if (Object.prototype.hasOwnProperty.call(suspicious, k)) {",
  "        mark('SystemProperties.get', 'leave', { key: k, bypass: true });",
  "        return suspicious[k];",
  "      }",
  "      return getString.call(this, key);",
  "    };",
  "  });",
  "",
  "  protect('java.io.File.exists', function () {",
  "    const File = Java.use('java.io.File');",
  "    const exists = File.exists.overload();",
  "    const rootPaths = [",
  "      '/system/xbin/su',",
  "      '/system/bin/su',",
  "      '/sbin/su',",
  "      '/su/bin/su',",
  "      '/system/app/Superuser.apk',",
  "      '/system/etc/init.d/99SuperSUDaemon',",
  "      '/system/bin/.ext/.su',",
  "      '/system/usr/we-need-root/su',",
  "    ];",
  "    exists.implementation = function () {",
  "      const path = String(this.getAbsolutePath());",
  "      if (rootPaths.indexOf(path) >= 0) {",
  "        mark('File.exists', 'leave', { path: path, bypass: true });",
  "        return false;",
  "      }",
  "      return exists.call(this);",
  "    };",
  "  });",
  "",
  "  protect('java.lang.Runtime.exec', function () {",
  "    const Runtime = Java.use('java.lang.Runtime');",
  "    const IOException = Java.use('java.io.IOException');",
  "    Runtime.exec.overloads.forEach(function (overload) {",
  "      overload.implementation = function () {",
  "        const args = Array.prototype.slice.call(arguments);",
  "        const cmd = args.length > 0 ? args[0] : '';",
  "        if (shouldBlockCommand(cmd)) {",
  "          mark('Runtime.exec', 'enter', { command: String(cmd), blocked: true });",
  "          throw IOException.$new('blocked suspicious command');",
  "        }",
  "        return overload.call(this, ...args);",
  "      };",
  "    });",
  "  });",
  "",
  "  protect('java.lang.ProcessBuilder.start', function () {",
  "    const ProcessBuilder = Java.use('java.lang.ProcessBuilder');",
  "    const IOException = Java.use('java.io.IOException');",
  "    const start = ProcessBuilder.start.overload();",
  "    start.implementation = function () {",
  "      const cmd = String(this.command());",
  "      if (shouldBlockCommand(cmd)) {",
  "        mark('ProcessBuilder.start', 'enter', { command: cmd, blocked: true });",
  "        throw IOException.$new('blocked suspicious process builder command');",
  "      }",
  "      return start.call(this);",
  "    };",
  "  });",
  "",
  "  protect('dynamic.boolean.heuristics', function () {",
  "    let packageName = '';",
  "    try {",
  "      const ActivityThread = Java.use('android.app.ActivityThread');",
  "      packageName = String(ActivityThread.currentPackageName() || '');",
  "    } catch (_) {}",
  "",
  "    const re = /(root|debug|tamper|hook|frida|emulator|xposed|jailbreak)/i;",
  "    let installed = 0;",
  "    Java.enumerateLoadedClassesSync().forEach(function (className) {",
  "      if (installed >= MAX_DYNAMIC_HOOKS) return;",
  "      if (packageName && className.indexOf(packageName) !== 0) return;",
  "      if (className.indexOf('$') >= 0) return;",
  "      if (className.indexOf('java.') === 0 || className.indexOf('android.') === 0) return;",
  "",
  "      let klass = null;",
  "      try {",
  "        klass = Java.use(className);",
  "      } catch (_) {",
  "        return;",
  "      }",
  "",
  "      Object.keys(klass).forEach(function (methodName) {",
  "        if (installed >= MAX_DYNAMIC_HOOKS) return;",
  "        if (!re.test(methodName)) return;",
  "        const method = klass[methodName];",
  "        if (!method || !method.overloads) return;",
  "",
  "        method.overloads.forEach(function (overload) {",
  "          if (installed >= MAX_DYNAMIC_HOOKS) return;",
  "          if (String(overload.returnType.className) !== 'boolean') return;",
  "          overload.implementation = function () {",
  "            mark(className + '.' + methodName, 'leave', { bypass: true, dynamic: true });",
  "            return false;",
  "          };",
  "          installed += 1;",
  "        });",
  "      });",
  "    });",
  "    mark('dynamic.boolean.heuristics', 'leave', { installed: installed });",
  "  });",
  "});",
].join("\n");

export const ANDROID_CLASSLOADER_AWARE_BYPASS_SCRIPT = [
  "Java.perform(function () {",
  "  function mark(symbol, phase, extra) {",
  "    try {",
  "      send({",
  "        subject: 'hook',",
  "        category: 'builtin.android.classloader-aware',",
  "        symbol: symbol,",
  "        dir: phase === 'enter' ? 'enter' : 'leave',",
  "        line: phase + ' ' + symbol,",
  "        extra: Object.assign({ phase: phase }, extra || {}),",
  "      });",
  "    } catch (_) {}",
  "  }",
  "",
  "  const pending = new Map();",
  "  const installed = new Set();",
  "  const failed = new Set();",
  "",
  "  function shouldRetryOnClassLoad(message) {",
  "    return (",
  "      message.indexOf('classnotfoundexception') >= 0 ||",
  "      message.indexOf('class not found') >= 0 ||",
  "      message.indexOf('did not find class') >= 0 ||",
  "      message.indexOf('java.use') >= 0",
  "    );",
  "  }",
  "",
  "  function installTarget(target, trigger) {",
  "    if (installed.has(target.label)) return true;",
  "    try {",
  "      target.install();",
  "      installed.add(target.label);",
  "      pending.delete(target.className);",
  "      mark(target.label, 'leave', { installed: true, trigger: trigger });",
  "      return true;",
  "    } catch (e) {",
  "      const message = String(e);",
  "      if (shouldRetryOnClassLoad(message.toLowerCase())) {",
  "        pending.set(target.className, target);",
  "        return false;",
  "      }",
  "      const key = target.label + '|' + message;",
  "      if (!failed.has(key)) {",
  "        failed.add(key);",
  "        mark(target.label, 'error', { trigger: trigger, message: message });",
  "      }",
  "      return false;",
  "    }",
  "  }",
  "",
  "  function installByClassName(className, trigger) {",
  "    const key = String(className || '');",
  "    if (!key) return;",
  "    const target = pending.get(key);",
  "    if (!target) return;",
  "    installTarget(target, trigger);",
  "  }",
  "",
  "  const targets = [",
  "    {",
  "      className: 'android.os.Debug',",
  "      label: 'android.os.Debug',",
  "      install: function () {",
  "        const Debug = Java.use('android.os.Debug');",
  "        Debug.isDebuggerConnected.implementation = function () { return false; };",
  "        Debug.waitingForDebugger.implementation = function () { return false; };",
  "      },",
  "    },",
  "    {",
  "      className: 'java.lang.System',",
  "      label: 'java.lang.System.exit',",
  "      install: function () {",
  "        const System = Java.use('java.lang.System');",
  "        System.exit.overload('int').implementation = function (code) {",
  "          mark('System.exit', 'enter', { blocked: true, code: code });",
  "          return;",
  "        };",
  "      },",
  "    },",
  "    {",
  "      className: 'android.os.Process',",
  "      label: 'android.os.Process.killProcess',",
  "      install: function () {",
  "        const Process = Java.use('android.os.Process');",
  "        Process.killProcess.overload('int').implementation = function (pid) {",
  "          mark('Process.killProcess', 'enter', { blocked: true, pid: pid });",
  "          return;",
  "        };",
  "      },",
  "    },",
  "    {",
  "      className: 'sg.vantagepoint.a.c',",
  "      label: 'sg.vantagepoint.a.c',",
  "      install: function () {",
  "        const RootCheck = Java.use('sg.vantagepoint.a.c');",
  "        RootCheck.a.implementation = function () { return false; };",
  "        RootCheck.b.implementation = function () { return false; };",
  "        RootCheck.c.implementation = function () { return false; };",
  "      },",
  "    },",
  "    {",
  "      className: 'sg.vantagepoint.a.b',",
  "      label: 'sg.vantagepoint.a.b',",
  "      install: function () {",
  "        const DebugCheck = Java.use('sg.vantagepoint.a.b');",
  "        DebugCheck.a.overload('android.content.Context').implementation = function () {",
  "          return false;",
  "        };",
  "      },",
  "    },",
  "  ];",
  "",
  "  targets.forEach(function (target) {",
  "    pending.set(target.className, target);",
  "    installTarget(target, 'initial');",
  "  });",
  "",
  "  try {",
  "    const ClassLoader = Java.use('java.lang.ClassLoader');",
  "    const loadClassOverloads = [",
  "      ClassLoader.loadClass.overload('java.lang.String'),",
  "      ClassLoader.loadClass.overload('java.lang.String', 'boolean'),",
  "    ];",
  "    loadClassOverloads.forEach(function (overload, index) {",
  "      const original = overload;",
  "      overload.implementation = function () {",
  "        const args = Array.prototype.slice.call(arguments);",
  "        const result = original.apply(this, args);",
  "        const className = args.length > 0 ? String(args[0]) : '';",
  "        installByClassName(className, 'ClassLoader.loadClass#' + index);",
  "        return result;",
  "      };",
  "    });",
  "    mark('java.lang.ClassLoader.loadClass', 'leave', {",
  "      installed: true,",
  "      pendingTargets: pending.size,",
  "    });",
  "  } catch (e) {",
  "    mark('java.lang.ClassLoader.loadClass', 'error', { message: String(e) });",
  "  }",
  "",
  "  try {",
  "    const Class = Java.use('java.lang.Class');",
  "    const forName1 = Class.forName.overload('java.lang.String');",
  "    forName1.implementation = function (name) {",
  "      const result = forName1.call(this, name);",
  "      installByClassName(String(name), 'Class.forName');",
  "      return result;",
  "    };",
  "    mark('java.lang.Class.forName', 'leave', { installed: true });",
  "  } catch (e) {",
  "    mark('java.lang.Class.forName', 'error', { message: String(e) });",
  "  }",
  "",
  "  mark('classloader-aware.summary', 'leave', {",
  "    targets: targets.length,",
  "    pendingTargets: pending.size,",
  "  });",
  "});",
].join("\n");

const BUILTIN_STATIC_HOOK_SCRIPT_TEMPLATES: BuiltinHookScriptTemplate[] = [
  {
    id: "builtin-android-adaptive-root-debug-bypass",
    name: "android-adaptive-root-debug-bypass",
    description:
      "Adaptive Android root/debug bypass using API-level hooks and heuristic boolean method patching.",
    platform: "droid",
    identifiers: [],
    content: ANDROID_ADAPTIVE_ROOT_DEBUG_BYPASS_SCRIPT,
    enabled: false,
    runOnAppLaunch: false,
  },
  {
    id: "builtin-android-classloader-aware-bypass",
    name: "android-classloader-aware-bypass",
    description:
      "ClassLoader-aware bypass scaffold: retries hook installation when classes are loaded dynamically.",
    platform: "droid",
    identifiers: [],
    content: ANDROID_CLASSLOADER_AWARE_BYPASS_SCRIPT,
    enabled: false,
    runOnAppLaunch: false,
  },
  {
    id: "builtin-uncrackable1-root-bypass",
    name: "uncrackable1-root-bypass",
    description:
      "Bypass root/debug checks and app termination flow for owasp.mstg.uncrackable1.",
    platform: "droid",
    identifiers: ["owasp.mstg.uncrackable1"],
    content: UNCRACKABLE1_ROOT_BYPASS_SCRIPT,
    enabled: true,
    runOnAppLaunch: true,
  },
  {
    id: "builtin-uncrackable2-early-bypass",
    name: "uncrackable2-early-bypass",
    description:
      "Early root/debug and anti-exit bypass template for owasp.mstg.uncrackable2 (Java + ptrace path).",
    platform: "droid",
    identifiers: ["owasp.mstg.uncrackable2"],
    content: UNCRACKABLE2_EARLY_BYPASS_SCRIPT,
    enabled: true,
    runOnAppLaunch: true,
  },
];

const BUILTIN_FRIDA_SCRIPT_DIR_CANDIDATES = [
  process.env.GRAPEFRUIT_BUILTIN_FRIDA_SCRIPT_DIR,
  nodePath.join(process.cwd(), "builtin-frida-script"),
  // Backward compatibility for legacy temporary directory.
  process.env.GRAPEFRUIT_PUBLIC_FRIDA_SCRIPT_DIR,
  nodePath.join(process.cwd(), "public-frida-script"),
  nodePath.resolve(import.meta.dirname, "../../builtin-frida-script"),
  nodePath.resolve(import.meta.dirname, "../builtin-frida-script"),
  nodePath.resolve(import.meta.dirname, "../../public-frida-script"),
  nodePath.resolve(import.meta.dirname, "../public-frida-script"),
].filter(
  (value): value is string => typeof value === "string" && value.trim().length > 0,
);

const PUBLIC_FRIDA_SCRIPT_DESCRIPTION_BY_BASENAME: Record<string, string> = {
  anti_frida_bypass_01:
    "General anti-Frida detection bypass strategy pack (variant 01).",
  anti_frida_bypass_02:
    "General anti-Frida detection bypass strategy pack (variant 02).",
  anti_frida_bypass_03:
    "General anti-Frida detection bypass strategy pack (variant 03).",
  anti_rooted_bypass:
    "General Android root-check bypass helper script.",
  "frida-multiple-bypass":
    "Collection of multiple generic bypass hooks for anti-debug, anti-root, and anti-Frida checks.",
  Universal_android_ssl_pinning_bypass:
    "Universal Android SSL pinning bypass template.",
};

function toKebabCase(input: string): string {
  return input
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function inferPlatform(
  fileName: string,
  content: string,
): BuiltinHookPlatform {
  const lowerName = fileName.toLowerCase();
  if (lowerName.includes("android")) return "droid";
  if (lowerName.includes("ios") || lowerName.includes("objc")) return "fruity";
  if (content.includes("Java.perform") || content.includes("Java.use(")) {
    return "droid";
  }
  if (content.includes("ObjC.classes") || content.includes("ObjC.schedule")) {
    return "fruity";
  }
  return "any";
}

function listPublicFridaScriptTemplates(): BuiltinHookScriptTemplate[] {
  const visitedDirs = new Set<string>();
  const allEntries: Array<{ dir: string; entry: fs.Dirent }> = [];
  for (const dir of BUILTIN_FRIDA_SCRIPT_DIR_CANDIDATES) {
    const normalizedDir = nodePath.resolve(dir);
    if (visitedDirs.has(normalizedDir)) continue;
    visitedDirs.add(normalizedDir);
    try {
      const entries = fs.readdirSync(normalizedDir, { withFileTypes: true });
      for (const entry of entries) {
        allEntries.push({ dir: normalizedDir, entry });
      }
    } catch {
      // ignore missing / inaccessible candidate directory
    }
  }
  if (allEntries.length === 0) {
    return [];
  }

  const templates: BuiltinHookScriptTemplate[] = [];
  const usedIds = new Set<string>();
  const seenFileNames = new Set<string>();
  for (const { dir, entry } of allEntries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".js")) continue;

    const fileNameKey = entry.name.toLowerCase();
    if (seenFileNames.has(fileNameKey)) continue;
    seenFileNames.add(fileNameKey);

    const fullPath = nodePath.join(dir, entry.name);
    let content = "";
    try {
      content = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    if (content.trim().length === 0) continue;

    const baseName = nodePath.basename(entry.name, ".js");
    const baseId = toKebabCase(baseName) || "script";
    let id = `builtin-public-${baseId}`;
    let suffix = 1;
    while (usedIds.has(id)) {
      suffix += 1;
      id = `builtin-public-${baseId}-${suffix}`;
    }
    usedIds.add(id);

    templates.push({
      id,
      name: baseName,
      description:
        PUBLIC_FRIDA_SCRIPT_DESCRIPTION_BY_BASENAME[baseName] ??
        `Imported from builtin-frida-script/${entry.name}.`,
      platform: inferPlatform(entry.name, content),
      identifiers: [],
      content,
      enabled: false,
      runOnAppLaunch: false,
    });
  }

  templates.sort((a, b) => a.name.localeCompare(b.name));
  return templates;
}

export function listBuiltinHookScriptTemplates(
  platform?: BuiltinHookPlatform,
  identifier?: string,
): BuiltinHookScriptTemplate[] {
  const templates = [
    ...BUILTIN_STATIC_HOOK_SCRIPT_TEMPLATES,
    ...listPublicFridaScriptTemplates(),
  ];

  return templates.filter((template) => {
    const platformMatched =
      !platform ||
      platform === "any" ||
      template.platform === "any" ||
      template.platform === platform;
    const identifierMatched =
      !identifier ||
      template.identifiers.length === 0 ||
      template.identifiers.includes(identifier);
    return platformMatched && identifierMatched;
  }).map((template) => ({ ...template }));
}
