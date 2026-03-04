import { type ReactNode, useMemo, useEffect, useRef, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router";
import { io, Socket } from "socket.io-client";

import {
  Status,
  Mode,
  SessionContext,
  type StatusType,
  type PlatformType,
  type ModeType,
} from "@/context/SessionContext";

import {
  createAPI,
  type SessionClientEvents,
  type SessionServerEvents,
} from "@/lib/rpc";
import { fnv1a } from "@/lib/hash";

import { CrashDialog, type CrashDetail } from "@/components/shared/CrashDialog";
import { DeniedDialog } from "@/components/shared/DeniedDialog";

const INVALID_RELOAD_GUARD_KEY = "igf.invalid.reload.guard";
const RECONNECT_WATCHDOG_MS = 3000;
const RECONNECT_BASE_DELAY_MS = 400;
const RECONNECT_MAX_DELAY_MS = 5000;

type ReadyAwareSocket = Socket<SessionClientEvents, SessionServerEvents> & {
  __igfReady?: boolean;
};

function SessionProvider({ children }: { children: ReactNode }) {
  const params = useParams();
  const [searchParams] = useSearchParams();

  // Extract platform, mode, device from route params
  const platform = params.platform as PlatformType | undefined;
  const mode = params.mode as ModeType | undefined;
  const device = params.device;

  // For app mode, use bundle; for daemon mode, use pid from URL
  const bundle = mode === Mode.App ? params.target : undefined;
  const targetPid = mode === Mode.Daemon ? parseInt(params.target || "0", 10) : undefined;
  const processName = mode === Mode.Daemon ? (searchParams.get("name") ?? undefined) : undefined;

  const [status, setStatus] = useState<StatusType>(Status.Disconnected);
  const [pid, setPid] = useState<number | undefined>(targetPid);
  const [fridaMajor, setFridaMajor] = useState(17);
  const [crashDetail, setCrashDetail] = useState<CrashDetail | null>(null);
  const [denied, setDenied] = useState(false);
  const [socket, setSocket] = useState<
    Socket<SessionClientEvents, SessionServerEvents> | null
  >(null);
  const deniedRef = useRef(false);
  const invalidRetriesRef = useRef(0);

  useEffect(() => {
    fetch("/api/version")
      .then((r) => r.json())
      .then((v: { frida: string }) => {
        const major = parseInt(v.frida, 10);
        if (major === 16 || major === 17) setFridaMajor(major);
      })
      .catch(() => {});
  }, []);

  // Compute project identifier matching server-side logic
  const identifier = useMemo(() => {
    if (mode === Mode.App && bundle) return bundle;
    if (mode === Mode.Daemon && targetPid) {
      const pname = processName || "pid";
      return `${pname}-${fnv1a(pname + targetPid)}`;
    }
    return undefined;
  }, [mode, bundle, targetPid, processName]);

  useEffect(() => {
    if (!device || !platform || !mode) {
      setStatus(Status.Disconnected);
      setSocket(null);
      return;
    }
    if (mode === Mode.App && !bundle) {
      setStatus(Status.Disconnected);
      setSocket(null);
      return;
    }
    if (mode === Mode.Daemon && !targetPid) {
      setStatus(Status.Disconnected);
      setSocket(null);
      return;
    }

    deniedRef.current = false;
    invalidRetriesRef.current = 0;
    setDenied(false);
    setCrashDetail(null);
    setStatus(Status.Connecting);
    if (mode === Mode.App) {
      setPid(undefined);
    } else {
      setPid(targetPid);
    }

    const query: Record<string, string> = { device, platform, mode };
    if (mode === Mode.App && bundle) {
      query.bundle = bundle;
    } else if (mode === Mode.Daemon && targetPid) {
      query.pid = String(targetPid);
      if (processName) query.name = processName;
    }

    const nextSocket: ReadyAwareSocket = io(
      "/session",
      {
        query,
        reconnection: false,
        timeout: 10000,
      },
    );
    nextSocket.__igfReady = false;
    setSocket(nextSocket);

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = (reason: string, immediate = false) => {
      if (disposed || deniedRef.current) return;
      if (!nextSocket.disconnected) return;
      if (reconnectTimer !== null) return;

      reconnectAttempts += 1;
      const delay = immediate
        ? 0
        : Math.min(
            RECONNECT_BASE_DELAY_MS * 2 ** Math.min(reconnectAttempts - 1, 4),
            RECONNECT_MAX_DELAY_MS,
          );

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (disposed || deniedRef.current || !nextSocket.disconnected) return;
        console.debug(
          `reconnecting session socket (attempt=${reconnectAttempts}, reason=${reason})`,
        );
        setStatus(Status.Connecting);
        nextSocket.connect();
      }, delay);
    };

    const reconnectWatchdog = setInterval(() => {
      if (disposed || deniedRef.current) return;
      if (nextSocket.disconnected) {
        scheduleReconnect("watchdog");
      }
    }, RECONNECT_WATCHDOG_MS);

    const onDenied = () => {
      deniedRef.current = true;
      nextSocket.__igfReady = false;
      setDenied(true);
      clearReconnectTimer();
    };

    const onInvalid = () => {
      invalidRetriesRef.current += 1;
      if (invalidRetriesRef.current <= 2) {
        scheduleReconnect("invalid", true);
        return;
      }

      const guardId = [
        device,
        platform,
        mode,
        bundle ?? "",
        targetPid ? String(targetPid) : "",
      ].join("|");
      const previous = sessionStorage.getItem(INVALID_RELOAD_GUARD_KEY);
      if (previous === guardId) {
        console.error("session invalid persisted after reload, stopping auto-reload");
        setStatus(Status.Disconnected);
        return;
      }

      sessionStorage.setItem(INVALID_RELOAD_GUARD_KEY, guardId);
      location.reload();
    };

    const onReady = (newPid: number) => {
      nextSocket.__igfReady = true;
      sessionStorage.removeItem(INVALID_RELOAD_GUARD_KEY);
      reconnectAttempts = 0;
      clearReconnectTimer();
      setStatus(Status.Ready);
      setPid(newPid);
    };

    const onConnect = () => {
      reconnectAttempts = 0;
      clearReconnectTimer();
      setStatus(Status.Connecting);
    };

    const onDetached = (reason: string) => {
      console.debug("session detached", reason);
      if (reason === "process-terminated" || reason === "process-replaced") {
        scheduleReconnect(`detached:${reason}`, true);
      } else {
        scheduleReconnect(`detached:${reason}`);
      }
    };

    const onDisconnect = (reason: string) => {
      console.debug("socket.io disconnect", reason);
      nextSocket.__igfReady = false;
      setStatus(Status.Disconnected);
      if (mode === Mode.App) {
        setPid(undefined);
      }
      if (reason !== "io client disconnect") {
        scheduleReconnect(`disconnect:${reason}`);
      }
    };

    const onConnectError = (err: Error) => {
      console.warn("socket.io connect_error", err.message);
      setStatus(Status.Disconnected);
      scheduleReconnect(`connect_error:${err.message}`);
    };

    const onFatal = (detail: unknown) => {
      setCrashDetail(detail as CrashDetail);
    };

    const onLog = (level: string, message: string) => {
      console.log("agent log", level, message);
    };

    const onSyslog = (message: string) => {
      console.log("syslog", message);
    };

    nextSocket.on("denied", onDenied);
    nextSocket.on("invalid", onInvalid);
    nextSocket.on("ready", onReady);
    nextSocket.on("detached", onDetached);
    nextSocket.on("log", onLog);
    nextSocket.on("syslog", onSyslog);
    nextSocket.on("connect", onConnect);
    nextSocket.on("connect_error", onConnectError);
    nextSocket.on("fatal", onFatal);
    nextSocket.on("disconnect", onDisconnect);

    return () => {
      disposed = true;
      clearReconnectTimer();
      clearInterval(reconnectWatchdog);
      nextSocket.off("denied", onDenied);
      nextSocket.off("invalid", onInvalid);
      nextSocket.off("ready", onReady);
      nextSocket.off("detached", onDetached);
      nextSocket.off("log", onLog);
      nextSocket.off("syslog", onSyslog);
      nextSocket.off("connect", onConnect);
      nextSocket.off("connect_error", onConnectError);
      nextSocket.off("fatal", onFatal);
      nextSocket.off("disconnect", onDisconnect);
      nextSocket.disconnect();
      setSocket((current) => (current === nextSocket ? null : current));
    };
  }, [device, platform, mode, bundle, targetPid, processName]);

  const { fruity, droid } = useMemo(() => {
    if (!socket || !platform) {
      return { fruity: null, droid: null };
    }
    const apis = createAPI(socket, platform);
    if (platform === "fruity") {
      return { fruity: apis.fruity, droid: null };
    }
    return { fruity: null, droid: apis.droid };
  }, [socket, platform]);

  const contextValue = useMemo(
    () => ({
      platform,
      mode,
      device,
      bundle,
      pid,
      identifier,
      fruity,
      droid,
      status,
      socket,
      fridaMajor,
    }),
    [platform, mode, device, bundle, pid, identifier, fruity, droid, status, socket, fridaMajor],
  );

  // Validate required params
  if (!device || !platform || !mode) {
    return <Navigate to="/" replace />;
  }

  // For app mode, bundle is required
  if (mode === Mode.App && !bundle) {
    return <Navigate to="/" replace />;
  }

  // For daemon mode, pid is required
  if (mode === Mode.Daemon && !targetPid) {
    return <Navigate to="/" replace />;
  }

  return (
    <SessionContext.Provider value={contextValue}>
      {children}
      <DeniedDialog open={denied} />
      <CrashDialog detail={crashDetail} showRelaunch={mode === Mode.App} />
    </SessionContext.Provider>
  );
}

export default SessionProvider;
