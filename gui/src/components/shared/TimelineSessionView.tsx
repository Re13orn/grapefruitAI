import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertTriangle,
  Download,
  Play,
  Plus,
  Search,
  Square,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  type TimelineEventRecord,
  type TimelineRiskLevel,
  type TimelineSource,
  useTimelineSession,
} from "@/context/TimelineSessionContext";

const ALL_SOURCES = "all";
const ALL_RISKS = "all";

function formatDateTime(ts: number | null) {
  if (!ts) return "--";
  return new Date(ts).toLocaleString();
}

function downloadText(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function renderRaw(raw: unknown) {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getHookRaw(event: TimelineEventRecord | null | undefined) {
  return asRecord(event?.raw);
}

function getHookExtra(event: TimelineEventRecord | null | undefined) {
  const raw = getHookRaw(event);
  return asRecord(raw?.extra);
}

function getHookCategory(event: TimelineEventRecord | null | undefined) {
  const raw = getHookRaw(event);
  return typeof raw?.category === "string" ? raw.category : undefined;
}

function formatScalar(value: unknown): string {
  if (typeof value === "undefined") return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function findPairedEvent(
  events: TimelineEventRecord[],
  event: TimelineEventRecord | null | undefined,
) {
  if (!event?.callId || !event.direction) return null;
  return (
    events.find(
      (candidate) =>
        candidate.id !== event.id &&
        candidate.source === event.source &&
        candidate.callId === event.callId &&
        candidate.direction !== event.direction,
    ) ?? null
  );
}

function resolveCallView(
  events: TimelineEventRecord[],
  event: TimelineEventRecord | null | undefined,
) {
  if (!event) {
    return {
      entry: null,
      leave: null,
      paired: null,
      argsSummary: undefined,
      returnSummary: undefined,
    };
  }

  const paired = findPairedEvent(events, event);
  const entry = event.direction === "leave" ? paired ?? null : event;
  const leave = event.direction === "leave" ? event : paired;

  return {
    entry,
    leave,
    paired,
    argsSummary: entry?.argsSummary ?? event.argsSummary,
    returnSummary: leave?.returnSummary ?? event.returnSummary,
  };
}

function renderMarkdown(session: {
  name: string;
  createdAt: number;
  startedAt: number | null;
  stoppedAt: number | null;
  events: TimelineEventRecord[];
}) {
  const lines = [
    `# ${session.name}`,
    "",
    `- Created: ${formatDateTime(session.createdAt)}`,
    `- Started: ${formatDateTime(session.startedAt)}`,
    `- Stopped: ${formatDateTime(session.stoppedAt)}`,
    `- Events: ${session.events.length}`,
    "",
    "## Timeline",
    "",
  ];

  for (const event of session.events) {
    const resolved = resolveCallView(session.events, event);
    lines.push(
      `### ${new Date(event.at).toLocaleTimeString()} [${event.source}] ${event.title}`,
    );
    lines.push("");
    lines.push(`- Risk: ${event.risk}`);
    lines.push(`- Key Event: ${event.keyEvent ? "yes" : "no"}`);
    lines.push(`- Starred: ${event.starred ? "yes" : "no"}`);
    if (event.direction) lines.push(`- Direction: ${event.direction}`);
    if (event.callId) lines.push(`- Call ID: ${event.callId}`);
    if (event.summary) lines.push(event.summary);
    if (resolved.argsSummary) {
      lines.push("");
      lines.push("Arguments:");
      lines.push("```text");
      lines.push(resolved.argsSummary);
      lines.push("```");
    }
    if (resolved.returnSummary) {
      lines.push("");
      lines.push("Return:");
      lines.push("```text");
      lines.push(resolved.returnSummary);
      lines.push("```");
    }
    if (event.tags.length > 0) {
      lines.push("");
      lines.push(`Tags: ${event.tags.join(", ")}`);
    }
    if (event.highlightReasons.length > 0) {
      lines.push("");
      lines.push(`Reasons: ${event.highlightReasons.join(", ")}`);
    }
    if (event.note) {
      lines.push("");
      lines.push("Note:");
      lines.push(event.note);
    }
    if (event.detail) {
      lines.push("");
      lines.push("```text");
      lines.push(event.detail);
      lines.push("```");
    }
    lines.push("");
  }

  return lines.join("\n");
}

function sourceBadgeVariant(source: TimelineSource) {
  switch (source) {
    case "marker":
      return "default";
    case "network":
      return "secondary";
    default:
      return "outline";
  }
}

function riskBadgeClass(risk: TimelineRiskLevel) {
  switch (risk) {
    case "high":
      return "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-200";
    case "medium":
      return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-200";
    case "info":
      return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-200";
    case "ok":
      return "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200";
  }
}

function reasonLabel(t: (key: string) => string, reason: string) {
  const key = `timeline_reason_${reason}`;
  const value = t(key);
  return value === key ? reason : value;
}

function DetailField({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  if (
    typeof value === "undefined" ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return null;
  }

  const text = formatScalar(value);
  const multiline = text.includes("\n") || text.length > 120;

  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {multiline ? (
        <Textarea value={text} readOnly className="min-h-20 text-xs font-mono" />
      ) : (
        <div className="rounded-md border bg-muted/20 px-2.5 py-2 text-xs break-all">
          {text}
        </div>
      )}
    </div>
  );
}

function StructuredHookCard({
  t,
  label,
  fields,
}: {
  t: (key: string) => string;
  label: string;
  fields: Array<{ label: string; value: unknown }>;
}) {
  const visibleFields = fields.filter(
    ({ value }) =>
      !(
        typeof value === "undefined" ||
        value === null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      ),
  );

  if (visibleFields.length === 0) return null;

  return (
    <div>
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        {t("timeline_structured_payload")} · {label}
      </div>
      <div className="space-y-3 rounded-lg border bg-muted/10 p-3">
        {visibleFields.map((field) => (
          <DetailField key={`${label}:${field.label}`} label={field.label} value={field.value} />
        ))}
      </div>
    </div>
  );
}

export function TimelineSessionView() {
  const { t } = useTranslation();
  const {
    sessions,
    activeSession,
    activeSessionId,
    isRecording,
    createSession,
    selectSession,
    renameSession,
    deleteSession,
    clearSessionEvents,
    startRecording,
    stopRecording,
    addMarker,
    updateEvent,
  } = useTimelineSession();

  const [markerText, setMarkerText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>(ALL_SOURCES);
  const [riskFilter, setRiskFilter] = useState<string>(ALL_RISKS);
  const [starredOnly, setStarredOnly] = useState(false);
  const [keyOnly, setKeyOnly] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const filteredEvents = useMemo(() => {
    if (!activeSession) return [];
    const query = searchQuery.trim().toLowerCase();
    return activeSession.events.filter((event) => {
      if (sourceFilter !== ALL_SOURCES && event.source !== sourceFilter) {
        return false;
      }
      if (riskFilter !== ALL_RISKS && event.risk !== riskFilter) {
        return false;
      }
      if (starredOnly && !event.starred) {
        return false;
      }
      if (keyOnly && !event.keyEvent) {
        return false;
      }
      if (!query) return true;
      return (
        event.title.toLowerCase().includes(query) ||
        event.summary.toLowerCase().includes(query) ||
        (event.callId?.toLowerCase().includes(query) ?? false) ||
        event.tags.some((tag) => tag.toLowerCase().includes(query)) ||
        (event.detail?.toLowerCase().includes(query) ?? false) ||
        event.highlightReasons.some((reason) => reason.toLowerCase().includes(query)) ||
        event.note.toLowerCase().includes(query)
      );
    });
  }, [activeSession, keyOnly, riskFilter, searchQuery, sourceFilter, starredOnly]);

  const selectedEvent = useMemo(
    () =>
      filteredEvents.find((event) => event.id === selectedEventId) ??
      filteredEvents.at(-1) ??
      null,
    [filteredEvents, selectedEventId],
  );

  const selectedCall = useMemo(
    () => resolveCallView(activeSession?.events ?? [], selectedEvent),
    [activeSession?.events, selectedEvent],
  );

  const selectedCategory = getHookCategory(selectedEvent);
  const selectedEntryExtra = getHookExtra(selectedCall.entry);
  const selectedLeaveExtra = getHookExtra(selectedCall.leave);
  const selectedMergedExtra = useMemo(
    () => ({
      ...(selectedEntryExtra ?? {}),
      ...(selectedLeaveExtra ?? {}),
    }),
    [selectedEntryExtra, selectedLeaveExtra],
  );

  useEffect(() => {
    if (!selectedEvent) {
      setSelectedEventId(null);
      return;
    }
    if (selectedEvent.id !== selectedEventId) {
      setSelectedEventId(selectedEvent.id);
    }
  }, [selectedEvent, selectedEventId]);

  const handleCreateSession = () => {
    const id = createSession();
    selectSession(id);
  };

  const handleExportJson = () => {
    if (!activeSession) return;
    downloadText(
      JSON.stringify(activeSession, null, 2),
      `${activeSession.name.replace(/\s+/g, "-").toLowerCase() || "timeline-session"}.json`,
      "application/json;charset=utf-8",
    );
    toast.success(t("timeline_exported_json"));
  };

  const handleExportMarkdown = () => {
    if (!activeSession) return;
    downloadText(
      renderMarkdown(activeSession),
      `${activeSession.name.replace(/\s+/g, "-").toLowerCase() || "timeline-session"}.md`,
      "text/markdown;charset=utf-8",
    );
    toast.success(t("timeline_exported_markdown"));
  };

  const handleAddMarker = () => {
    const text = markerText.trim();
    if (!text) return;
    addMarker(text);
    setMarkerText("");
    toast.success(t("timeline_marker_added"));
  };

  const sourceOptions: Array<{ value: string; label: string }> = [
    { value: ALL_SOURCES, label: t("timeline_filter_all") },
    { value: "hook", label: t("timeline_filter_hook") },
    { value: "crypto", label: t("timeline_filter_crypto") },
    { value: "network", label: t("timeline_filter_network") },
    { value: "syslog", label: t("timeline_filter_syslog") },
    { value: "agent", label: t("timeline_filter_agent") },
    { value: "marker", label: t("timeline_filter_marker") },
  ];
  const riskOptions: Array<{ value: string; label: string }> = [
    { value: ALL_RISKS, label: t("timeline_filter_risk_all") },
    { value: "high", label: t("severity_high") },
    { value: "medium", label: t("severity_medium") },
    { value: "info", label: t("severity_info") },
    { value: "ok", label: t("severity_ok") },
  ];

  return (
    <div className="h-full flex flex-col">
      <div className="border-b bg-muted/20 px-3 py-2 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {sessions.length > 0 ? (
            <Select
              value={activeSessionId ?? sessions[0]!.id}
              onValueChange={(value) => value && selectSession(value)}
            >
              <SelectTrigger className="w-64 h-8 text-xs">
                <SelectValue placeholder={t("timeline_select_session")} />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((session) => (
                  <SelectItem key={session.id} value={session.id}>
                    {session.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="h-8 min-w-40 rounded-md border px-2.5 text-xs text-muted-foreground flex items-center">
              {t("timeline_select_session")}
            </div>
          )}
          <Button variant="outline" size="sm" className="h-8" onClick={handleCreateSession}>
            <Plus className="h-3.5 w-3.5" />
            {t("timeline_new_session")}
          </Button>
          <Button
            variant={isRecording ? "destructive" : "default"}
            size="sm"
            className="h-8"
            onClick={isRecording ? stopRecording : startRecording}
          >
            {isRecording ? (
              <Square className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {isRecording ? t("timeline_stop") : t("timeline_start")}
          </Button>
          <Badge variant={isRecording ? "default" : "secondary"} className="text-[10px]">
            {isRecording ? t("timeline_recording") : t("timeline_idle")}
          </Badge>
          {activeSession && (
            <>
              <Button variant="outline" size="sm" className="h-8" onClick={handleExportJson}>
                <Download className="h-3.5 w-3.5" />
                JSON
              </Button>
              <Button variant="outline" size="sm" className="h-8" onClick={handleExportMarkdown}>
                <Download className="h-3.5 w-3.5" />
                Markdown
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-red-500 hover:text-red-600"
                onClick={() => deleteSession(activeSession.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("timeline_delete_session")}
              </Button>
            </>
          )}
        </div>

        {activeSession && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={activeSession.name}
                onChange={(event) =>
                  renameSession(activeSession.id, event.target.value)
                }
                placeholder={t("timeline_session_name")}
                className="h-8 max-w-sm text-xs"
              />
              <span className="text-xs text-muted-foreground">
                {t("timeline_events_count", {
                  count: activeSession.events.length,
                })}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("timeline_started_at")}: {formatDateTime(activeSession.startedAt)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("timeline_updated_at")}: {formatDateTime(activeSession.updatedAt)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => clearSessionEvents(activeSession.id)}
              >
                {t("timeline_clear_events")}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={markerText}
                onChange={(event) => setMarkerText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleAddMarker();
                  }
                }}
                placeholder={t("timeline_marker_placeholder")}
                className="h-8 min-w-64 flex-1 text-xs"
                disabled={!isRecording}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={handleAddMarker}
                disabled={!isRecording || markerText.trim().length === 0}
              >
                {t("timeline_add_marker")}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-56">
                <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t("timeline_search_placeholder")}
                  className="h-8 pl-7 pr-7 text-xs"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setSearchQuery("")}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value || ALL_SOURCES)}>
                <SelectTrigger className="w-40 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sourceOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={riskFilter} onValueChange={(value) => setRiskFilter(value || ALL_RISKS)}>
                <SelectTrigger className="w-36 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {riskOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant={keyOnly ? "secondary" : "ghost"}
                size="sm"
                className="h-8"
                onClick={() => setKeyOnly((current) => !current)}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("timeline_filter_key_only")}
              </Button>
              <Button
                variant={starredOnly ? "secondary" : "ghost"}
                size="sm"
                className="h-8"
                onClick={() => setStarredOnly((current) => !current)}
              >
                <Star className={`h-3.5 w-3.5 ${starredOnly ? "fill-current" : ""}`} />
                {t("timeline_filter_starred")}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t("timeline_filtered_count", {
                  count: filteredEvents.length,
                  total: activeSession.events.length,
                })}
              </span>
            </div>
          </>
        )}
      </div>

      {!activeSession ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md text-center space-y-3">
            <div className="text-base font-medium">{t("timeline_empty_title")}</div>
            <div className="text-sm text-muted-foreground">
              {t("timeline_empty_description")}
            </div>
            <Button onClick={handleCreateSession}>
              <Plus className="h-4 w-4" />
              {t("timeline_create_first_session")}
            </Button>
          </div>
        </div>
      ) : (
        <ResizablePanelGroup orientation="horizontal" className="flex-1">
          <ResizablePanel defaultSize="58%" minSize="35%">
            <ScrollArea className="h-full">
              <div className="divide-y">
                {filteredEvents.length === 0 ? (
                  <div className="p-6 text-sm text-muted-foreground">
                    {t("timeline_no_events")}
                  </div>
                ) : (
                  filteredEvents.map((event) => (
                    (() => {
                      const pairedEvent = activeSession
                        ? findPairedEvent(activeSession.events, event)
                        : null;
                      return (
                        <button
                          key={event.id}
                          type="button"
                          className={`w-full text-left px-3 py-2 hover:bg-muted/30 transition border-l-2 ${
                            event.keyEvent ? "border-l-amber-500" : "border-l-transparent"
                          } ${
                            selectedEvent?.id === event.id ? "bg-accent" : ""
                          }`}
                          onClick={() => setSelectedEventId(event.id)}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-mono text-muted-foreground w-32 shrink-0">
                              {formatDateTime(event.at)}
                            </span>
                            <Badge
                              variant={sourceBadgeVariant(event.source)}
                              className="text-[10px] shrink-0"
                            >
                              {t(`timeline_source_${event.source}`)}
                            </Badge>
                            {event.direction && (
                              <Badge variant="outline" className="text-[10px] shrink-0">
                                {event.direction}
                              </Badge>
                            )}
                            <Badge className={`text-[10px] shrink-0 border ${riskBadgeClass(event.risk)}`}>
                              {t(`severity_${event.risk}`)}
                            </Badge>
                            {event.keyEvent && (
                              <Badge variant="secondary" className="text-[10px] shrink-0">
                                {t("timeline_key_event")}
                              </Badge>
                            )}
                            {pairedEvent && (
                              <Badge variant="outline" className="text-[10px] shrink-0">
                                {t("timeline_paired_call")}
                              </Badge>
                            )}
                            {event.starred && (
                              <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />
                            )}
                            <span className="text-sm font-medium truncate">{event.title}</span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground line-clamp-2">
                            {event.summary || t("timeline_no_summary")}
                          </div>
                          {event.note && (
                            <div className="mt-1 text-xs text-foreground/80 line-clamp-1">
                              {event.note}
                            </div>
                          )}
                          {event.tags.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {event.tags.map((tag) => (
                                <Badge key={`${event.id}:${tag}`} variant="outline" className="text-[10px]">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </button>
                      );
                    })()
                  ))
                )}
              </div>
            </ScrollArea>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="42%" minSize="25%">
            <ScrollArea className="h-full">
              {selectedEvent ? (
                <div className="p-4 space-y-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={sourceBadgeVariant(selectedEvent.source)}>
                        {t(`timeline_source_${selectedEvent.source}`)}
                      </Badge>
                      {selectedEvent.direction && (
                        <Badge variant="outline">{selectedEvent.direction}</Badge>
                      )}
                      <Badge className={`border ${riskBadgeClass(selectedEvent.risk)}`}>
                        {t(`severity_${selectedEvent.risk}`)}
                      </Badge>
                      {selectedEvent.keyEvent && (
                        <Badge variant="secondary">{t("timeline_key_event")}</Badge>
                      )}
                      {selectedCall.paired && (
                        <Badge variant="outline">{t("timeline_paired_call")}</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(selectedEvent.at)}
                      </span>
                    </div>
                    <div className="text-base font-semibold break-all">
                      {selectedEvent.title}
                    </div>
                    <div className="text-sm text-muted-foreground whitespace-pre-wrap break-all">
                      {selectedEvent.summary || t("timeline_no_summary")}
                    </div>
                  </div>

                  {selectedEvent.callId && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-muted-foreground">
                        {t("timeline_call_id")}
                      </div>
                      <div className="rounded-md border bg-muted/20 px-2.5 py-2 text-xs font-mono break-all">
                        {selectedEvent.callId}
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant={selectedEvent.starred ? "secondary" : "outline"}
                      size="sm"
                      onClick={() =>
                        updateEvent(selectedEvent.id, {
                          starred: !selectedEvent.starred,
                        })
                      }
                    >
                      <Star
                        className={`h-3.5 w-3.5 ${
                          selectedEvent.starred ? "fill-current" : ""
                        }`}
                      />
                      {selectedEvent.starred
                        ? t("timeline_unstar_event")
                        : t("timeline_star_event")}
                    </Button>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {t("timeline_risk_level")}
                      </span>
                      <Select
                        value={selectedEvent.risk}
                        onValueChange={(value) =>
                          updateEvent(selectedEvent.id, {
                            risk: value as TimelineRiskLevel,
                          })
                        }
                      >
                        <SelectTrigger className="w-32 h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {riskOptions
                            .filter((option) => option.value !== ALL_RISKS)
                            .map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {selectedEvent.highlightReasons.length > 0 && (
                    <div>
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        {t("timeline_highlight_reason")}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {selectedEvent.highlightReasons.map((reason) => (
                          <Badge key={`reason:${selectedEvent.id}:${reason}`} variant="secondary">
                            {reasonLabel(t, reason)}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedCategory === "sharedpref" && (
                    <StructuredHookCard
                      t={t}
                      label="SharedPreferences"
                      fields={[
                        { label: t("timeline_field_operation"), value: selectedMergedExtra.op },
                        { label: t("timeline_field_method"), value: selectedMergedExtra.method },
                        { label: t("timeline_field_name"), value: selectedMergedExtra.name },
                        { label: t("timeline_field_mode"), value: selectedMergedExtra.mode },
                        { label: t("timeline_field_key"), value: selectedMergedExtra.key },
                        { label: t("timeline_field_value_type"), value: selectedMergedExtra.valueType },
                        { label: t("timeline_field_value"), value: selectedMergedExtra.value },
                        { label: t("timeline_field_result"), value: selectedMergedExtra.result },
                        { label: t("timeline_field_sync"), value: selectedMergedExtra.sync },
                      ]}
                    />
                  )}

                  {selectedCategory === "intent" && (
                    <StructuredHookCard
                      t={t}
                      label="Intent"
                      fields={[
                        { label: t("timeline_field_operation"), value: selectedMergedExtra.op },
                        { label: t("timeline_field_caller"), value: selectedMergedExtra.caller },
                        { label: t("timeline_field_action"), value: selectedMergedExtra.action },
                        { label: t("timeline_field_component"), value: selectedMergedExtra.component },
                        { label: t("timeline_field_data"), value: selectedMergedExtra.data },
                        { label: t("timeline_field_type"), value: selectedMergedExtra.type },
                        { label: t("timeline_field_request_code"), value: selectedMergedExtra.requestCode },
                        { label: t("timeline_field_flags"), value: selectedMergedExtra.flags },
                        { label: t("timeline_field_categories"), value: selectedMergedExtra.categories },
                        { label: t("timeline_field_extras"), value: selectedMergedExtra.extras },
                      ]}
                    />
                  )}

                  {selectedCategory === "objc" && (
                    <StructuredHookCard
                      t={t}
                      label="Objective-C"
                      fields={[
                        { label: t("timeline_field_class"), value: selectedMergedExtra.cls },
                        { label: t("timeline_field_selector"), value: selectedMergedExtra.sel },
                        { label: t("timeline_field_args"), value: selectedEntryExtra?.args },
                        { label: t("timeline_field_return"), value: selectedLeaveExtra?.ret },
                      ]}
                    />
                  )}

                  {selectedCategory === "native" && (
                    <StructuredHookCard
                      t={t}
                      label="Native"
                      fields={[
                        { label: t("timeline_field_module"), value: selectedMergedExtra.module },
                        { label: t("timeline_field_symbol"), value: selectedMergedExtra.name },
                        { label: t("timeline_field_signature"), value: selectedMergedExtra.signature },
                        { label: t("timeline_field_args"), value: selectedEntryExtra?.args },
                        { label: t("timeline_field_return"), value: selectedLeaveExtra?.ret },
                      ]}
                    />
                  )}

                  {selectedCall.argsSummary && (
                    <div>
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        {t("timeline_event_args")}
                      </div>
                      <Textarea
                        value={selectedCall.argsSummary}
                        readOnly
                        className="min-h-24 text-xs font-mono"
                      />
                    </div>
                  )}

                  {selectedCall.returnSummary && (
                    <div>
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        {t("timeline_event_return")}
                      </div>
                      <Textarea
                        value={selectedCall.returnSummary}
                        readOnly
                        className="min-h-24 text-xs font-mono"
                      />
                    </div>
                  )}

                  {selectedEvent.tags.length > 0 && (
                    <div>
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        {t("timeline_tags")}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {selectedEvent.tags.map((tag) => (
                          <Badge key={`detail:${selectedEvent.id}:${tag}`} variant="outline">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      {t("timeline_event_note")}
                    </div>
                    <Textarea
                      value={selectedEvent.note}
                      onChange={(event) =>
                        updateEvent(selectedEvent.id, { note: event.target.value })
                      }
                      placeholder={t("timeline_note_placeholder")}
                      className="min-h-24 text-xs"
                    />
                  </div>

                  {selectedEvent.detail && (
                    <div>
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        {t("timeline_event_detail")}
                      </div>
                      <Textarea
                        value={selectedEvent.detail}
                        readOnly
                        className="min-h-32 text-xs font-mono"
                      />
                    </div>
                  )}

                  <div>
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      {t("timeline_event_raw")}
                    </div>
                    <Textarea
                      value={renderRaw(selectedEvent.raw)}
                      readOnly
                      className="min-h-48 text-xs font-mono"
                    />
                  </div>
                </div>
              ) : (
                <div className="p-6 text-sm text-muted-foreground">
                  {t("timeline_detail_empty")}
                </div>
              )}
            </ScrollArea>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
