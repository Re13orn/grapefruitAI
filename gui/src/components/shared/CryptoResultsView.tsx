import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  Trash2,
  Search,
  X,
  Copy,
  Check,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useSession, Status, Platform } from "@/context/SessionContext";
import { useFruityQuery, useDroidQuery } from "@/lib/queries";
import { useLogStream } from "@/hooks/useLogStream";
import { toTime } from "@/lib/format";

import type { BaseMessage as BaseHookMessage } from "@agent/common/hooks/context";

interface CryptoEntry {
  id: number;
  timestamp: Date;
  message: BaseHookMessage;
  data?: ArrayBuffer;
}

interface CryptoExtra {
  callId?: string;
  op?: string;
  algo?: string;
  detailType?: string;
  len?: number;
}

type CryptoExtraRecord = Record<string, unknown> & CryptoExtra;

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function formatHexDump(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.slice(offset, offset + 16);
    const addr = offset.toString(16).padStart(8, "0");
    const hexParts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      if (i < chunk.length) {
        const h = chunk[i].toString(16).padStart(2, "0");
        const h2 =
          i + 1 < chunk.length
            ? chunk[i + 1].toString(16).padStart(2, "0")
            : "  ";
        hexParts.push(h + h2);
      } else {
        hexParts.push("    ");
      }
    }
    const ascii = Array.from(chunk)
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
      .join("")
      .padEnd(16);
    lines.push(`${addr}: ${hexParts.join(" ")}  ${ascii}`);
  }
  return lines.join("\n");
}

function getExtra(message: BaseHookMessage): CryptoExtraRecord {
  const extra = message.extra as CryptoExtraRecord | undefined;
  return extra ?? {};
}

function getCallId(message: BaseHookMessage): string | null {
  const callId = getExtra(message).callId;
  if (typeof callId === "string" && callId.length > 0) return callId;
  return null;
}

function getUtf8Preview(buffer: ArrayBuffer): string | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  let printable = 0;
  for (const ch of normalized) {
    const code = ch.charCodeAt(0);
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0x7e)
    ) {
      printable += 1;
    }
  }

  if (printable / normalized.length < 0.85) return null;
  return normalized.length > 400 ? `${normalized.slice(0, 400)}...` : normalized;
}

function isSameCallAnchor(a: CryptoEntry, b: CryptoEntry): boolean {
  const aCallId = getCallId(a.message);
  const bCallId = getCallId(b.message);
  if (aCallId && bCallId) return aCallId === bCallId;

  if (a.message.category !== b.message.category) return false;
  if (a.message.symbol !== b.message.symbol) return false;

  const aExtra = getExtra(a.message);
  const bExtra = getExtra(b.message);

  const comparableKeys = ["algo", "op", "transformation"] as const;
  for (const key of comparableKeys) {
    const av = aExtra[key];
    const bv = bExtra[key];
    if (typeof av === "string" && typeof bv === "string" && av !== bv) {
      return false;
    }
  }

  const distanceMs = Math.abs(a.timestamp.getTime() - b.timestamp.getTime());
  return distanceMs <= 10_000;
}

function findRelatedEntry(
  entries: CryptoEntry[],
  index: number,
  direction: "enter" | "leave",
): CryptoEntry | null {
  const source = entries[index];
  if (!source) return null;

  const maxDistance = 60;
  for (let offset = 1; offset <= maxDistance; offset += 1) {
    const prev = entries[index - offset];
    if (prev && prev.message.dir === direction && isSameCallAnchor(source, prev)) {
      return prev;
    }

    const next = entries[index + offset];
    if (next && next.message.dir === direction && isSameCallAnchor(source, next)) {
      return next;
    }
  }

  return null;
}

const FRUITY_CRYPTO_GROUPS = ["cccrypt", "x509", "hash", "hmac"] as const;
const DROID_CRYPTO_GROUPS = ["cipher", "pbkdf", "keygen"] as const;

interface CryptoRowProps {
  entries: CryptoEntry[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

function CryptoRow(
  props: {
    index: number;
  } & CryptoRowProps,
) {
  const { index, entries, selectedId, onSelect } = props;
  const entry = entries[index];

  if (!entry) return null;

  const { message, timestamp, data } = entry;
  const isSelected = selectedId === entry.id;
  const extra = getExtra(message);

  return (
    <div
      className={`flex items-center px-3 py-1 border-b border-border/50 hover:bg-muted/30 text-xs gap-2 cursor-pointer ${isSelected ? "bg-accent" : ""}`}
      onClick={() => onSelect(entry.id)}
    >
      <span className="text-muted-foreground font-mono w-24 shrink-0">
        {toTime(timestamp)}
      </span>
      <Badge
        variant={message.dir === "enter" ? "default" : "secondary"}
        className="h-5 px-1.5 text-[10px] shrink-0"
      >
        <ChevronRight
          className={`h-3 w-3 ${message.dir === "leave" ? "rotate-180" : ""}`}
        />
      </Badge>
      <span
        className="font-mono text-primary truncate w-40 shrink-0"
        title={message.symbol}
      >
        {message.symbol}
      </span>
      {extra?.op && (
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] shrink-0">
          {extra.op}
        </Badge>
      )}
      {extra?.algo && (
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] shrink-0">
          {extra.algo}
        </Badge>
      )}
      {extra?.detailType && (
        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] shrink-0">
          {extra.detailType}
          {extra.len !== undefined && ` ${extra.len}B`}
        </Badge>
      )}
      <span
        className="font-mono text-muted-foreground truncate flex-1 min-w-0"
        title={message.line || ""}
      >
        {message.line || ""}
      </span>
      {data && (
        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] shrink-0">
          {data.byteLength}B
        </Badge>
      )}
    </div>
  );
}

const CRYPTO_DETAIL_TAB_STATE = "CRYPTO_DETAIL_TAB_STATE";

function formatExtraValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (value === null) return "null";
  if (typeof value === "undefined") return "undefined";
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function formatExtraEntries(extra: CryptoExtraRecord): Array<[string, string]> {
  const hidden = new Set(["detailType", "len", "callId"]);
  return Object.entries(extra)
    .filter(([key]) => !hidden.has(key))
    .sort(([ak], [bk]) => ak.localeCompare(bk))
    .map(([key, value]) => [key, formatExtraValue(value)]);
}

function ExtraMetaList({
  entries,
  emptyLabel,
}: {
  entries: Array<[string, string]>;
  emptyLabel: string;
}) {
  if (entries.length === 0) {
    return <div className="text-xs text-muted-foreground">{emptyLabel}</div>;
  }

  return (
    <div className="space-y-1">
      {entries.map(([k, v]) => (
        <div key={`${k}:${v}`} className="rounded border bg-muted/30 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {k}
          </div>
          <div className="text-xs font-mono break-all">{v}</div>
        </div>
      ))}
    </div>
  );
}

interface DetailPanelProps {
  entry: CryptoEntry;
  relatedEnter: CryptoEntry | null;
  relatedLeave: CryptoEntry | null;
  onSelectEntry: (id: number) => void;
}

function DetailPanel({
  entry,
  relatedEnter,
  relatedLeave,
  onSelectEntry,
}: DetailPanelProps) {
  const { t } = useTranslation();
  const { message, data, timestamp } = entry;
  const extra = getExtra(message);
  const callId = typeof extra.callId === "string" ? extra.callId : null;
  const detailMetaEntries = formatExtraEntries(extra);

  const hasData = !!data;
  const hasBt = !!message.backtrace?.length;
  const utf8Preview = hasData ? getUtf8Preview(data) : null;
  const hasUtf8Preview = !!utf8Preview;
  const hasArgs = !!relatedEnter;
  const hasReturn = !!relatedLeave;
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = useCallback(async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1200);
    } catch (error) {
      console.error("Failed to copy text:", error);
    }
  }, []);

  const savedTab = localStorage.getItem(CRYPTO_DETAIL_TAB_STATE);
  const availableTabs = useMemo(
    () => [
      "detail",
      ...(hasArgs ? ["args"] : []),
      ...(hasReturn ? ["return"] : []),
      ...(hasData ? ["hexdump"] : []),
      ...(hasUtf8Preview ? ["preview"] : []),
      ...(hasBt ? ["backtrace"] : []),
    ],
    [hasArgs, hasReturn, hasData, hasUtf8Preview, hasBt],
  );
  const defaultTab =
    savedTab && availableTabs.includes(savedTab)
      ? savedTab
      : hasData
        ? "hexdump"
        : hasBt
          ? "backtrace"
          : "detail";
  const [activeTab, setActiveTab] = useState(defaultTab);

  const argsMetaEntries = relatedEnter
    ? formatExtraEntries(getExtra(relatedEnter.message))
    : [];
  const returnMetaEntries = relatedLeave
    ? formatExtraEntries(getExtra(relatedLeave.message))
    : [];
  const argsPreview = relatedEnter?.data ? getUtf8Preview(relatedEnter.data) : null;
  const returnPreview = relatedLeave?.data
    ? getUtf8Preview(relatedLeave.data)
    : null;

  useEffect(() => {
    setActiveTab((current) =>
      availableTabs.includes(current) ? current : defaultTab,
    );
  }, [availableTabs, defaultTab]);

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => {
        setActiveTab(v);
        localStorage.setItem(CRYPTO_DETAIL_TAB_STATE, v);
      }}
      className="h-full flex flex-col"
    >
      <TabsList variant="line" className="mx-2 mt-2 shrink-0">
        <TabsTrigger value="detail">{t("crypto_detail_tab")}</TabsTrigger>
        {hasArgs && (
          <TabsTrigger value="args">{t("crypto_args_tab")}</TabsTrigger>
        )}
        {hasReturn && (
          <TabsTrigger value="return">{t("crypto_return_tab")}</TabsTrigger>
        )}
        {hasData && (
          <TabsTrigger value="hexdump">{t("crypto_hexdump_tab")}</TabsTrigger>
        )}
        {hasUtf8Preview && <TabsTrigger value="preview">UTF-8</TabsTrigger>}
        {hasBt && (
          <TabsTrigger value="backtrace">
            {t("crypto_backtrace_tab")}
          </TabsTrigger>
        )}
      </TabsList>

      <TabsContent value="detail" className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="p-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[10px]">
                {toTime(timestamp)}
              </Badge>
              <Badge
                variant={message.dir === "enter" ? "default" : "secondary"}
                className="text-[10px]"
              >
                {message.dir}
              </Badge>
              {extra.op && (
                <Badge variant="outline" className="text-[10px]">
                  {extra.op}
                </Badge>
              )}
              {extra.algo && (
                <Badge variant="outline" className="text-[10px]">
                  {extra.algo}
                </Badge>
              )}
              {callId && (
                <Badge variant="outline" className="text-[10px] font-mono">
                  {t("crypto_call_id")}: {callId}
                </Badge>
              )}
              {hasData && (
                <Badge variant="secondary" className="text-[10px]">
                  {data.byteLength}B
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {relatedEnter && relatedEnter.id !== entry.id && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[10px]"
                  onClick={() => onSelectEntry(relatedEnter.id)}
                >
                  {t("crypto_jump_to_args")}
                </Button>
              )}
              {relatedLeave && relatedLeave.id !== entry.id && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[10px]"
                  onClick={() => onSelectEntry(relatedLeave.id)}
                >
                  {t("crypto_jump_to_return")}
                </Button>
              )}
            </div>
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-1 flex items-center justify-between">
                Symbol
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() => copyToClipboard("symbol", message.symbol)}
                >
                  {copiedKey === "symbol" ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
              </div>
              <pre className="text-xs font-mono break-all">
                {message.symbol}
              </pre>
            </div>
            {message.line && (
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1 flex items-center justify-between">
                  Detail
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[10px]"
                    onClick={() => copyToClipboard("detail", message.line!)}
                  >
                    {copiedKey === "detail" ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </Button>
                </div>
                <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded select-all">
                  {message.line}
                </pre>
              </div>
            )}
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-1 flex items-center justify-between">
                Extra
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() =>
                    copyToClipboard("extra", JSON.stringify(extra, null, 2))
                  }
                >
                  {copiedKey === "extra" ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
              </div>
              <ExtraMetaList
                entries={detailMetaEntries}
                emptyLabel={t("crypto_meta_empty")}
              />
            </div>
          </div>
        </ScrollArea>
      </TabsContent>

      {hasArgs && relatedEnter && (
        <TabsContent value="args" className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="p-3 space-y-3">
              <div className="text-xs text-muted-foreground">
                {toTime(relatedEnter.timestamp)}
              </div>
              {relatedEnter.message.line && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">
                    {t("crypto_args_line")}
                  </div>
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded select-all">
                    {relatedEnter.message.line}
                  </pre>
                </div>
              )}
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1">
                  {t("crypto_args_meta")}
                </div>
                <ExtraMetaList
                  entries={argsMetaEntries}
                  emptyLabel={t("crypto_meta_empty")}
                />
              </div>
              {relatedEnter.data ? (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">
                    {t("crypto_args_payload")} ({relatedEnter.data.byteLength}B)
                  </div>
                  <pre className="font-mono text-[11px] leading-5 select-all">
                    {formatHexDump(relatedEnter.data)}
                  </pre>
                  {argsPreview && (
                    <div className="mt-2 space-y-1">
                      <div className="text-xs font-semibold text-muted-foreground">
                        {t("crypto_utf8_preview")}
                      </div>
                      <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded select-all">
                        {argsPreview}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  {t("crypto_args_payload_empty")}
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      )}

      {hasReturn && relatedLeave && (
        <TabsContent value="return" className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="p-3 space-y-3">
              <div className="text-xs text-muted-foreground">
                {toTime(relatedLeave.timestamp)}
              </div>
              {relatedLeave.message.line && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">
                    {t("crypto_return_line")}
                  </div>
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded select-all">
                    {relatedLeave.message.line}
                  </pre>
                </div>
              )}
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1">
                  {t("crypto_return_meta")}
                </div>
                <ExtraMetaList
                  entries={returnMetaEntries}
                  emptyLabel={t("crypto_meta_empty")}
                />
              </div>
              {relatedLeave.data ? (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">
                    {t("crypto_return_payload")} ({relatedLeave.data.byteLength}B)
                  </div>
                  <pre className="font-mono text-[11px] leading-5 select-all">
                    {formatHexDump(relatedLeave.data)}
                  </pre>
                  {returnPreview && (
                    <div className="mt-2 space-y-1">
                      <div className="text-xs font-semibold text-muted-foreground">
                        {t("crypto_utf8_preview")}
                      </div>
                      <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded select-all">
                        {returnPreview}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  {t("crypto_return_payload_empty")}
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      )}

      {hasData && (
        <TabsContent value="hexdump" className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="p-3">
              <div className="text-xs text-muted-foreground mb-2 flex items-center justify-between">
                <span>{data.byteLength} bytes</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() => copyToClipboard("hexdump", formatHexDump(data))}
                >
                  {copiedKey === "hexdump" ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
              </div>
              <pre className="font-mono text-[11px] leading-5 select-all">
                {formatHexDump(data)}
              </pre>
            </div>
          </ScrollArea>
        </TabsContent>
      )}

      {hasUtf8Preview && (
        <TabsContent value="preview" className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="p-3 space-y-2">
              <div className="text-xs text-muted-foreground">
                UTF-8 Preview
              </div>
              <pre className="font-mono text-xs whitespace-pre-wrap break-all bg-muted p-2 rounded select-all">
                {utf8Preview}
              </pre>
            </div>
          </ScrollArea>
        </TabsContent>
      )}

      {hasBt && (
        <TabsContent value="backtrace" className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="p-2 font-mono text-xs space-y-1">
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() =>
                    copyToClipboard("backtrace", message.backtrace!.join("\n"))
                  }
                >
                  {copiedKey === "backtrace" ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
              </div>
              {message.backtrace!.map((frame, index) => (
                <div
                  key={index}
                  className="p-1.5 rounded hover:bg-muted/50 break-all"
                >
                  <span className="text-muted-foreground mr-2">#{index}</span>
                  {frame}
                </div>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>
      )}
    </Tabs>
  );
}

const mapHistory = (record: Record<string, unknown>, id: number): CryptoEntry => ({
  id,
  timestamp: new Date(record.timestamp as string),
  message: {
    subject: "crypto",
    category: "crypto",
    symbol: record.symbol as string,
    dir: record.direction as "enter" | "leave",
    line: (record.line as string) ?? undefined,
    extra: record.extra as Record<string, unknown> | undefined,
    backtrace: record.backtrace as string[] | undefined,
  },
  data: record.data ? base64ToArrayBuffer(record.data as string) : undefined,
});

const mapSocket = (id: number, ...args: unknown[]): CryptoEntry => ({
  id,
  timestamp: new Date(),
  message: args[0] as BaseHookMessage,
  data: args[1] as ArrayBuffer | undefined,
});

export function CryptoResultsView() {
  const { t } = useTranslation();
  const { fruity, droid, status, device, identifier, platform } = useSession();
  const isDroid = platform === Platform.Droid;
  const cryptoGroups = isDroid ? DROID_CRYPTO_GROUPS : FRUITY_CRYPTO_GROUPS;

  const listRef = useRef<HTMLDivElement | null>(null);

  const {
    entries,
    selectedId,
    setSelectedId,
    clear,
  } = useLogStream<CryptoEntry>({
    event: "crypto",
    path: "history/crypto",
    key: "logs",
    fromRecord: mapHistory,
    fromEvent: mapSocket,
    max: 10000,
  });

  const handleSelect = useCallback((id: number) => {
    setSelectedId((current) => (current === id ? null : id));
  }, [setSelectedId]);

  const [searchQuery, setSearchQuery] = useState("");
  const [directionFilter, setDirectionFilter] = useState<
    "all" | "enter" | "leave"
  >("all");
  const [withPayloadOnly, setWithPayloadOnly] = useState(false);

  // Crypto sub-group toggle state
  const [cryptoStatus, setCryptoStatus] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  // Fetch crypto sub-group status (platform-aware)
  const { data: fruityInitStatus } = useFruityQuery<Record<string, boolean>>(
    ["cryptoStatus", device ?? "", identifier ?? ""],
    (api) => api.crypto.status(),
    { enabled: !isDroid },
  );
  const { data: droidInitStatus } = useDroidQuery<Record<string, boolean>>(
    ["cryptoStatus", device ?? "", identifier ?? ""],
    (api) => api.crypto.status(),
    { enabled: isDroid },
  );

  const initialStatus = isDroid ? droidInitStatus : fruityInitStatus;

  useEffect(() => {
    if (initialStatus) {
      setCryptoStatus(initialStatus);
    }
  }, [initialStatus]);

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return entries.filter((entry) => {
      if (directionFilter !== "all" && entry.message.dir !== directionFilter) {
        return false;
      }
      if (withPayloadOnly && !entry.data) {
        return false;
      }
      if (!query) return true;

      const extra = getExtra(entry.message);
      const haystack = [
        entry.message.symbol,
        entry.message.line ?? "",
        extra.op ?? "",
        extra.algo ?? "",
        extra.detailType ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [entries, searchQuery, directionFilter, withPayloadOnly]);

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  );

  const relatedPair = useMemo(() => {
    if (!selectedEntry || selectedId === null) {
      return { enter: null as CryptoEntry | null, leave: null as CryptoEntry | null };
    }
    const index = entries.findIndex((entry) => entry.id === selectedId);
    if (index === -1) {
      return { enter: null as CryptoEntry | null, leave: null as CryptoEntry | null };
    }

    const enter =
      selectedEntry.message.dir === "enter"
        ? selectedEntry
        : findRelatedEntry(entries, index, "enter");
    const leave =
      selectedEntry.message.dir === "leave"
        ? selectedEntry
        : findRelatedEntry(entries, index, "leave");

    return { enter, leave };
  }, [entries, selectedEntry, selectedId]);

  useEffect(() => {
    if (selectedId !== null && !entries.some((entry) => entry.id === selectedId)) {
      setSelectedId(null);
    }
  }, [entries, selectedId, setSelectedId]);

  const handleToggle = async (groupId: string, enabled: boolean) => {
    const api = isDroid ? droid : fruity;
    if (!api) return;

    setLoading((prev) => ({ ...prev, [groupId]: true }));

    try {
      if (enabled) {
        await api.crypto.start(groupId);
      } else {
        await api.crypto.stop(groupId);
      }
      setCryptoStatus((prev) => ({ ...prev, [groupId]: enabled }));
    } catch (error) {
      console.error(
        `Failed to ${enabled ? "start" : "stop"} crypto group ${groupId}:`,
        error,
      );
    } finally {
      setLoading((prev) => ({ ...prev, [groupId]: false }));
    }
  };

  // Auto-scroll when new entries arrive
  useEffect(() => {
    if (listRef.current && filteredEntries.length > 0) {
      requestAnimationFrame(() => {
        if (!listRef.current) return;
        listRef.current.scrollTop = listRef.current.scrollHeight;
      });
    }
  }, [filteredEntries.length]);

  const isDisabled = status !== Status.Ready;
  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    directionFilter !== "all" ||
    withPayloadOnly;

  return (
    <div className="h-full flex flex-col">
      {/* Header with toggles and filters */}
      <div className="px-3 py-2 border-b bg-muted/30 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-4 flex-wrap">
            {cryptoGroups.map((group) => (
              <div key={group} className="flex items-center gap-1.5">
                <Switch
                  id={`crypto-${group}`}
                  checked={cryptoStatus[group] || false}
                  onCheckedChange={(checked) => handleToggle(group, checked)}
                  disabled={isDisabled || loading[group]}
                  className="scale-75"
                />
                <Label
                  htmlFor={`crypto-${group}`}
                  className={`text-xs cursor-pointer ${loading[group] ? "animate-pulse" : ""}`}
                >
                  {group}
                </Label>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground">
              {filteredEntries.length.toLocaleString()}
              {filteredEntries.length !== entries.length
                ? ` / ${entries.length.toLocaleString()}`
                : ""}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={clear}
              className="h-7 px-2"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative w-56">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("crypto_search_placeholder")}
              className="h-7 pl-7 pr-7 text-xs"
            />
            {searchQuery && (
              <button
                type="button"
                className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                onClick={() => setSearchQuery("")}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant={directionFilter === "all" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setDirectionFilter("all")}
            >
              {t("crypto_filter_all")}
            </Button>
            <Button
              variant={directionFilter === "enter" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setDirectionFilter("enter")}
            >
              {t("crypto_filter_enter")}
            </Button>
            <Button
              variant={directionFilter === "leave" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setDirectionFilter("leave")}
            >
              {t("crypto_filter_leave")}
            </Button>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={withPayloadOnly}
              onCheckedChange={setWithPayloadOnly}
              className="scale-75"
            />
            <span>{t("crypto_payload_only")}</span>
          </label>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setSearchQuery("");
                setDirectionFilter("all");
                setWithPayloadOnly(false);
              }}
            >
              {t("crypto_clear_filters")}
            </Button>
          )}
        </div>
      </div>

      {/* Two-column content */}
      <ResizablePanelGroup
        orientation="horizontal"
        className="flex-1 min-h-0"
        autoSaveId="crypto-results-split"
      >
        {/* Left: entry list */}
        <ResizablePanel
          defaultSize={selectedEntry ? "60%" : "100%"}
          minSize="30%"
        >
          <div className="h-full">
            {filteredEntries.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                {entries.length === 0
                  ? t("crypto_no_results")
                  : t("crypto_no_results_filtered")}
              </div>
            ) : (
              <div ref={listRef} className="h-full overflow-auto">
                {filteredEntries.map((entry, index) => (
                  <CryptoRow
                    key={entry.id}
                    index={index}
                    entries={filteredEntries}
                    selectedId={selectedId}
                    onSelect={handleSelect}
                  />
                ))}
              </div>
            )}
          </div>
        </ResizablePanel>

        {/* Right: detail panel (only when selected) */}
        {selectedEntry && (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize="40%" minSize="20%">
              <DetailPanel
                key={selectedEntry.id}
                entry={selectedEntry}
                relatedEnter={relatedPair.enter}
                relatedLeave={relatedPair.leave}
                onSelectEntry={setSelectedId}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
