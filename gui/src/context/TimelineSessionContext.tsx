import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { BaseMessage as BaseHookMessage } from "@agent/common/hooks/context";
import type { NSURLEvent } from "@/lib/rpc";
import { Status, useSession } from "./SessionContext";

const STORAGE_PREFIX = "TIMELINE_SESSIONS_V1";
const MAX_SESSIONS = 20;
const MAX_EVENTS_PER_SESSION = 2000;

export type TimelineRiskLevel = "ok" | "info" | "medium" | "high";

export type TimelineSource =
  | "hook"
  | "crypto"
  | "network"
  | "syslog"
  | "agent"
  | "marker";

export interface TimelineEventRecord {
  id: string;
  at: number;
  source: TimelineSource;
  callId?: string;
  direction?: "enter" | "leave";
  title: string;
  summary: string;
  tags: string[];
  keyEvent: boolean;
  highlightReasons: string[];
  risk: TimelineRiskLevel;
  starred: boolean;
  note: string;
  argsSummary?: string;
  returnSummary?: string;
  detail?: string;
  raw?: unknown;
}

export interface TimelineSessionRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  stoppedAt: number | null;
  events: TimelineEventRecord[];
}

type TimelineEventDraft = Omit<
  TimelineEventRecord,
  "id" | "keyEvent" | "highlightReasons" | "risk" | "starred" | "note"
>;

type PersistedTimelineEvent = Omit<
  TimelineEventRecord,
  "keyEvent" | "highlightReasons" | "risk" | "starred" | "note"
> &
  Partial<
    Pick<
      TimelineEventRecord,
      "keyEvent" | "highlightReasons" | "risk" | "starred" | "note"
    >
  >;

interface TimelineState {
  sessions: TimelineSessionRecord[];
  activeSessionId: string | null;
  isRecording: boolean;
}

interface TimelineSessionContextType {
  sessions: TimelineSessionRecord[];
  activeSession: TimelineSessionRecord | null;
  activeSessionId: string | null;
  isRecording: boolean;
  createSession: (name?: string) => string;
  selectSession: (id: string) => void;
  renameSession: (id: string, name: string) => void;
  deleteSession: (id: string) => void;
  clearSessionEvents: (id: string) => void;
  startRecording: () => void;
  stopRecording: () => void;
  addMarker: (text: string) => void;
  updateEvent: (
    eventId: string,
    patch: Partial<Pick<TimelineEventRecord, "starred" | "note" | "risk">>,
  ) => void;
}

const defaultState: TimelineState = {
  sessions: [],
  activeSessionId: null,
  isRecording: false,
};

const TimelineSessionContext = createContext<TimelineSessionContextType | null>(
  null,
);

function maxRisk(
  a: TimelineRiskLevel,
  b: TimelineRiskLevel,
): TimelineRiskLevel {
  const rank: Record<TimelineRiskLevel, number> = {
    ok: 0,
    info: 1,
    medium: 2,
    high: 3,
  };
  return rank[a] >= rank[b] ? a : b;
}

function includesAny(haystack: string, keywords: string[]) {
  return keywords.some((keyword) => haystack.includes(keyword));
}

function stringifyCompact(value: unknown, max = 500): string | undefined {
  if (typeof value === "undefined") return undefined;
  if (value === null) return "null";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function parseReturnFromLine(line?: string): string | undefined {
  if (!line) return undefined;
  const match = line.match(/(?:=>|->|→)\s*(.+)$/);
  return match?.[1]?.trim() || undefined;
}

function parseArgsFromLine(line?: string): string | undefined {
  if (!line) return undefined;
  const match = line.match(/\((.*)\)/);
  const args = match?.[1]?.trim();
  return args && args !== "..." ? args : undefined;
}

function splitExtraForArgsAndReturn(
  extra: Record<string, unknown> | undefined,
  direction: "enter" | "leave",
): { argsSummary?: string; returnSummary?: string } {
  if (!extra) return {};

  const returnKeys = new Set([
    "ret",
    "result",
    "return",
    "retval",
    "returnValue",
    "written",
    "outOffset",
  ]);

  let returnSummary: string | undefined;
  const argExtra: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(extra)) {
    if (returnKeys.has(key)) {
      if (typeof returnSummary === "undefined") {
        returnSummary = stringifyCompact(
          key === "written" && "outOffset" in extra
            ? { written: extra.written, outOffset: extra.outOffset }
            : value,
        );
      }
      continue;
    }

    if (direction === "leave" && key === "value" && extra.op === "read") {
      returnSummary = stringifyCompact(value);
      continue;
    }

    argExtra[key] = value;
  }

  const argsSummary =
    "args" in extra
      ? stringifyCompact(extra.args)
      : Object.keys(argExtra).length > 0
        ? stringifyCompact(argExtra)
        : undefined;

  return { argsSummary, returnSummary };
}

function extractCallId(extra: Record<string, unknown> | undefined) {
  return typeof extra?.callId === "string" ? extra.callId : undefined;
}

function extractHookPayloads(message: BaseHookMessage): {
  callId?: string;
  direction: "enter" | "leave";
  argsSummary?: string;
  returnSummary?: string;
} {
  const extra = (message.extra ?? {}) as Record<string, unknown>;
  const fromExtra = splitExtraForArgsAndReturn(extra, message.dir);

  let argsSummary = fromExtra.argsSummary;
  let returnSummary = fromExtra.returnSummary;

  if (!argsSummary) {
    argsSummary = parseArgsFromLine(message.line);
  }

  if (!returnSummary) {
    returnSummary = parseReturnFromLine(message.line);
  }

  return {
    callId: extractCallId(extra),
    direction: message.dir,
    argsSummary,
    returnSummary,
  };
}

function collectDerivedMetadata(
  source: TimelineSource,
  seed: {
    direction?: "enter" | "leave";
    title: string;
    summary: string;
    tags: string[];
    argsSummary?: string;
    returnSummary?: string;
    detail?: string;
    raw?: unknown;
  },
): Pick<
  TimelineEventRecord,
  "keyEvent" | "highlightReasons" | "risk" | "starred" | "note"
> {
  const reasons = new Set<string>();
  let risk: TimelineRiskLevel = source === "marker" ? "ok" : "info";

  const haystack = [
    seed.title,
    seed.summary,
    seed.argsSummary ?? "",
    seed.returnSummary ?? "",
    seed.detail ?? "",
    seed.tags.join(" "),
    renderSearchableRaw(seed.raw),
  ]
    .join(" ")
    .toLowerCase();

  if (source === "marker") {
    reasons.add("manual-marker");
  }

  if (
    includesAny(haystack, [
      "cipher.init",
      "cipher.dofinal",
      "cipher.update",
      "cccrypt",
      "pbkdf",
      "keygenerator",
      "keypairgenerator",
      "cryptor",
    ])
  ) {
    reasons.add("cipher-operation");
    risk = maxRisk(risk, "medium");
  }

  if (
    includesAny(haystack, [
      "keystore",
      "keychain",
      "secretkeyspec",
      "keygenparameterspec",
      "privatekey",
      "publickey",
      "x509",
      "iv",
      "salt",
      "keyalgo",
      "keyalgorithm",
    ])
  ) {
    reasons.add("key-material");
    risk = maxRisk(risk, "high");
  }

  if (
    includesAny(haystack, [
      "sharedpreferences",
      "sharedpref",
      "getsharedpreferences",
      "userdefaults",
      "putstring",
      "getstring",
      "getall",
      "setobject:",
      "objectforkey",
      "nsuserdefaults",
    ])
  ) {
    reasons.add("app-storage");
    risk = maxRisk(risk, "medium");
  }

  if (
    includesAny(haystack, [
      "token",
      "bearer",
      "authorization",
      "jwt",
      "refresh_token",
      "access_token",
      "session",
      "cookie",
      "password",
      "secret",
      "apikey",
      "api-key",
      "auth",
    ])
  ) {
    reasons.add("credential-artifact");
    risk = maxRisk(risk, "high");
  }

  if (source === "network") {
    reasons.add("network-request");
    risk = maxRisk(risk, "medium");
  }

  if (
    source === "network" &&
    includesAny(haystack, ["login", "oauth", "refresh", "wallet", "pay", "transfer"])
  ) {
    reasons.add("sensitive-url");
    risk = maxRisk(risk, "high");
  }

  if (source === "network" && includesAny(haystack, ["websocket", "ws send", "ws receive"])) {
    reasons.add("websocket-traffic");
    risk = maxRisk(risk, "medium");
  }

  if (
    includesAny(haystack, [
      "error",
      "exception",
      "crash",
      "abort",
      "sigabrt",
      "sigsegv",
      "ssl",
      "pinning",
    ])
  ) {
    reasons.add("error-signal");
    risk = maxRisk(risk, "medium");
  }

  return {
    keyEvent: reasons.size > 0,
    highlightReasons: [...reasons],
    risk,
    starred: false,
    note: "",
  };
}

function renderSearchableRaw(raw: unknown) {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw ?? "");
  }
}

function normalizeEvent(event: PersistedTimelineEvent): TimelineEventRecord {
  const derived = collectDerivedMetadata(event.source, {
    direction: event.direction,
    title: event.title,
    summary: event.summary,
    tags: event.tags ?? [],
    argsSummary: event.argsSummary,
    returnSummary: event.returnSummary,
    detail: event.detail,
    raw: event.raw,
  });

  return {
    ...event,
    tags: event.tags ?? [],
    keyEvent: event.keyEvent ?? derived.keyEvent,
    highlightReasons:
      event.highlightReasons && event.highlightReasons.length > 0
        ? event.highlightReasons
        : derived.highlightReasons,
    risk: event.risk ?? derived.risk,
    starred: event.starred ?? false,
    note: event.note ?? "",
  };
}

function finalizeEvent(
  event: TimelineEventDraft,
): Omit<TimelineEventRecord, "id"> {
  return normalizeEvent({ ...event, id: "draft" });
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function truncateText(value: string | undefined, max = 240): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function sanitizeForStorage(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";

  if (typeof value === "string") {
    return value.length > 800 ? `${value.slice(0, 800)}...` : value;
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeForStorage(item, depth + 1));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(
      0,
      20,
    )) {
      result[key] = sanitizeForStorage(item, depth + 1);
    }
    return result;
  }

  return String(value);
}

function parseUrlPath(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname}`;
  } catch {
    return raw;
  }
}

function createHookEvent(message: BaseHookMessage): Omit<TimelineEventRecord, "id"> {
  const payload = extractHookPayloads(message);
  return finalizeEvent({
    at: Date.now(),
    source: "hook",
    callId: payload.callId,
    direction: payload.direction,
    title: message.symbol || message.category || "hook",
    summary: truncateText(message.line || message.category || "hook event"),
    tags: [message.category, message.dir].filter(Boolean),
    argsSummary: payload.argsSummary,
    returnSummary: payload.returnSummary,
    detail: message.line,
    raw: sanitizeForStorage({
      symbol: message.symbol,
      category: message.category,
      dir: message.dir,
      line: message.line,
      extra: message.extra,
      backtrace: message.backtrace,
    }),
  });
}

function createCryptoEvent(
  message: BaseHookMessage,
): Omit<TimelineEventRecord, "id"> {
  const extra = (message.extra ?? {}) as Record<string, unknown>;
  const algo = typeof extra.algo === "string" ? extra.algo : undefined;
  const op = typeof extra.op === "string" ? extra.op : undefined;
  const payload = extractHookPayloads(message);

  return finalizeEvent({
    at: Date.now(),
    source: "crypto",
    callId: payload.callId,
    direction: payload.direction,
    title: message.symbol || "crypto",
    summary: truncateText(message.line || algo || op || "crypto event"),
    tags: [message.dir, algo, op].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
    argsSummary: payload.argsSummary,
    returnSummary: payload.returnSummary,
    detail: message.line,
    raw: sanitizeForStorage({
      symbol: message.symbol,
      dir: message.dir,
      line: message.line,
      extra: message.extra,
      backtrace: message.backtrace,
    }),
  });
}

function createSyslogEvent(text: string): Omit<TimelineEventRecord, "id"> {
  return finalizeEvent({
    at: Date.now(),
    source: "syslog",
    title: "syslog",
    summary: truncateText(text, 220),
    tags: [],
    detail: text,
    raw: sanitizeForStorage(text),
  });
}

function createAgentEvent(
  level: string,
  text: string,
): Omit<TimelineEventRecord, "id"> {
  return finalizeEvent({
    at: Date.now(),
    source: "agent",
    title: level.toUpperCase(),
    summary: truncateText(text, 220),
    tags: [level].filter(Boolean),
    detail: text,
    raw: sanitizeForStorage({ level, text }),
  });
}

function createNetworkEvent(event: NSURLEvent): Omit<TimelineEventRecord, "id"> {
  switch (event.event) {
    case "requestWillBeSent":
      return finalizeEvent({
        at: event.timestamp,
        source: "network",
        title: `${event.request.method} ${parseUrlPath(event.request.url)}`,
        summary: truncateText(event.request.url, 240),
        tags: [event.request.method, "request", event.requestId],
        detail: event.request.body || event.request.url,
        raw: sanitizeForStorage(event),
      });
    case "responseReceived":
      return finalizeEvent({
        at: event.timestamp,
        source: "network",
        title: `HTTP ${event.response.statusCode ?? "-"}`,
        summary: truncateText(
          `${parseUrlPath(event.response.url)} ${event.response.mimeType ?? ""}`,
          240,
        ),
        tags: ["response", event.requestId].filter(Boolean),
        detail: JSON.stringify(
          sanitizeForStorage(event.response),
          null,
          2,
        ),
        raw: sanitizeForStorage(event),
      });
    case "loadingFailed":
      return finalizeEvent({
        at: event.timestamp,
        source: "network",
        title: "request failed",
        summary: truncateText(event.error, 220),
        tags: ["error", event.requestId],
        detail: event.error,
        raw: sanitizeForStorage(event),
      });
    case "loadingFinished":
      return finalizeEvent({
        at: event.timestamp,
        source: "network",
        title: "request finished",
        summary: event.hasBody ? "response body captured" : "request completed",
        tags: ["finished", event.requestId],
        raw: sanitizeForStorage(event),
      });
    case "mechanism":
      return finalizeEvent({
        at: event.timestamp,
        source: "network",
        title: "transport",
        summary: truncateText(event.mechanism, 220),
        tags: [event.requestId],
        detail: event.mechanism,
        raw: sanitizeForStorage(event),
      });
    case "dataReceived":
      return finalizeEvent({
        at: event.timestamp,
        source: "network",
        title: "data received",
        summary: `${event.dataLength} bytes`,
        tags: [event.requestId],
        raw: sanitizeForStorage(event),
      });
    case "webSocketSend":
    case "webSocketReceive":
      return finalizeEvent({
        at: event.timestamp,
        source: "network",
        title: event.event === "webSocketSend" ? "ws send" : "ws receive",
        summary: truncateText(
          event.message ||
            event.error ||
            `${event.dataLength ?? 0} bytes (${event.messageType})`,
          220,
        ),
        tags: ["websocket", event.messageType, event.requestId],
        detail: event.message || event.error,
        raw: sanitizeForStorage(event),
      });
  }
}

function createMarkerEvent(text: string): Omit<TimelineEventRecord, "id"> {
  return finalizeEvent({
    at: Date.now(),
    source: "marker",
    title: "marker",
    summary: truncateText(text, 220),
    tags: ["manual"],
    detail: text,
    raw: sanitizeForStorage(text),
  });
}

function createSessionRecord(name: string): TimelineSessionRecord {
  const now = Date.now();
  return {
    id: createId(),
    name,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    stoppedAt: null,
    events: [],
  };
}

function loadState(storageKey: string | null): TimelineState {
  if (!storageKey) return defaultState;

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaultState;
    const parsed = JSON.parse(raw) as TimelineState;
    if (!parsed || !Array.isArray(parsed.sessions)) return defaultState;
    return {
      sessions: parsed.sessions.map((session) => ({
        ...session,
        events: Array.isArray(session.events)
          ? session.events.map((event) =>
              normalizeEvent(event as TimelineEventRecord),
            )
          : [],
      })),
      activeSessionId: parsed.activeSessionId ?? null,
      isRecording: parsed.isRecording === true,
    };
  } catch {
    return defaultState;
  }
}

export function TimelineSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { platform, device, identifier, socket, status } = useSession();
  const storageKey = useMemo(() => {
    if (!platform || !device || !identifier) return null;
    return `${STORAGE_PREFIX}:${platform}:${device}:${identifier}`;
  }, [platform, device, identifier]);
  const [state, setState] = useState<TimelineState>(() => loadState(storageKey));

  useEffect(() => {
    setState(loadState(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    localStorage.setItem(storageKey, JSON.stringify(state));
  }, [state, storageKey]);

  const appendEvent = useCallback(
    (payload: Omit<TimelineEventRecord, "id">) => {
      setState((prev) => {
        if (!prev.isRecording || !prev.activeSessionId) return prev;
        const index = prev.sessions.findIndex(
          (session) => session.id === prev.activeSessionId,
        );
        if (index === -1) return prev;

        const nextEvent: TimelineEventRecord = {
          ...payload,
          id: createId(),
        };
        const sessions = [...prev.sessions];
        const session = sessions[index];
        sessions[index] = {
          ...session,
          updatedAt: Date.now(),
          events: [...session.events, nextEvent].slice(-MAX_EVENTS_PER_SESSION),
        };
        return { ...prev, sessions };
      });
    },
    [],
  );

  useEffect(() => {
    if (status !== Status.Ready || !socket) return;

    const onHook = (message: BaseHookMessage) => appendEvent(createHookEvent(message));
    const onCrypto = (message: BaseHookMessage) =>
      appendEvent(createCryptoEvent(message));
    const onSyslog = (text: string) => appendEvent(createSyslogEvent(text));
    const onLog = (level: string, text: string) =>
      appendEvent(createAgentEvent(level, text));
    const onNsurl = (event: NSURLEvent) => appendEvent(createNetworkEvent(event));

    socket.on("hook", onHook);
    socket.on("crypto", onCrypto);
    socket.on("syslog", onSyslog);
    socket.on("log", onLog);
    socket.on("nsurl", onNsurl);

    return () => {
      socket.off("hook", onHook);
      socket.off("crypto", onCrypto);
      socket.off("syslog", onSyslog);
      socket.off("log", onLog);
      socket.off("nsurl", onNsurl);
    };
  }, [appendEvent, socket, status]);

  const createSession = useCallback((name?: string) => {
    const id = createId();

    setState((prev) => {
      const sessionCount = prev.sessions.length + 1;
      const now = Date.now();
      const session: TimelineSessionRecord = {
        id,
        name: name?.trim() || `Session ${sessionCount}`,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        stoppedAt: null,
        events: [],
      };

      return {
        ...prev,
        activeSessionId: id,
        sessions: [...prev.sessions, session].slice(-MAX_SESSIONS),
      };
    });

    return id;
  }, []);

  const selectSession = useCallback((id: string) => {
    setState((prev) => ({ ...prev, activeSessionId: id }));
  }, []);

  const renameSession = useCallback((id: string, name: string) => {
    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((session) =>
        session.id === id
          ? {
              ...session,
              name: name.trim() || session.name,
              updatedAt: Date.now(),
            }
          : session,
      ),
    }));
  }, []);

  const deleteSession = useCallback((id: string) => {
    setState((prev) => {
      const sessions = prev.sessions.filter((session) => session.id !== id);
      const activeSessionId =
        prev.activeSessionId === id ? (sessions.at(-1)?.id ?? null) : prev.activeSessionId;
      const isRecording = activeSessionId ? prev.isRecording : false;
      return { sessions, activeSessionId, isRecording };
    });
  }, []);

  const clearSessionEvents = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((session) =>
        session.id === id
          ? {
              ...session,
              events: [],
              updatedAt: Date.now(),
            }
          : session,
      ),
    }));
  }, []);

  const startRecording = useCallback(() => {
    setState((prev) => {
      const now = Date.now();
      let activeSessionId = prev.activeSessionId;
      let sessions = prev.sessions;

      if (!activeSessionId) {
        const session = createSessionRecord(`Session ${prev.sessions.length + 1}`);
        activeSessionId = session.id;
        sessions = [...prev.sessions, session].slice(-MAX_SESSIONS);
      }

      sessions = sessions.map((session) =>
        session.id === activeSessionId
          ? {
              ...session,
              startedAt: session.startedAt ?? now,
              stoppedAt: null,
              updatedAt: now,
            }
          : session,
      );

      return {
        ...prev,
        activeSessionId,
        sessions,
        isRecording: true,
      };
    });
  }, []);

  const stopRecording = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isRecording: false,
      sessions: prev.sessions.map((session) =>
        session.id === prev.activeSessionId
          ? {
              ...session,
              stoppedAt: Date.now(),
              updatedAt: Date.now(),
            }
          : session,
      ),
    }));
  }, []);

  const addMarker = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      appendEvent(createMarkerEvent(trimmed));
    },
    [appendEvent],
  );

  const updateEvent = useCallback(
    (
      eventId: string,
      patch: Partial<Pick<TimelineEventRecord, "starred" | "note" | "risk">>,
    ) => {
      setState((prev) => ({
        ...prev,
        sessions: prev.sessions.map((session) =>
          session.id !== prev.activeSessionId
            ? session
            : {
                ...session,
                updatedAt: Date.now(),
                events: session.events.map((event) =>
                  event.id === eventId ? { ...event, ...patch } : event,
                ),
              },
        ),
      }));
    },
    [],
  );

  const activeSession = useMemo(
    () =>
      state.sessions.find((session) => session.id === state.activeSessionId) ?? null,
    [state.activeSessionId, state.sessions],
  );

  const value = useMemo<TimelineSessionContextType>(
    () => ({
      sessions: state.sessions,
      activeSession,
      activeSessionId: state.activeSessionId,
      isRecording: state.isRecording,
      createSession,
      selectSession,
      renameSession,
      deleteSession,
      clearSessionEvents,
      startRecording,
      stopRecording,
      addMarker,
      updateEvent,
    }),
    [
      activeSession,
      createSession,
      state.activeSessionId,
      state.isRecording,
      state.sessions,
      selectSession,
      renameSession,
      deleteSession,
      clearSessionEvents,
      startRecording,
      stopRecording,
      addMarker,
      updateEvent,
    ],
  );

  return (
    <TimelineSessionContext.Provider value={value}>
      {children}
    </TimelineSessionContext.Provider>
  );
}

export function useTimelineSession() {
  const context = useContext(TimelineSessionContext);
  if (!context) {
    throw new Error("useTimelineSession must be used within TimelineSessionProvider");
  }
  return context;
}
