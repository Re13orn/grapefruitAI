import {
  useEffect,
  useRef,
  useState,
  useMemo,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  Layers,
  Database,
  Trash2,
  Clipboard,
  Fingerprint,
  Smartphone,
  FolderOpen,
  Copy,
  Check,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useLogStream } from "@/hooks/useLogStream";
import { toTime } from "@/lib/format";

import type { BaseMessage as BaseHookMessage } from "@agent/common/hooks/context";

interface HookEntry {
  id: number;
  timestamp: Date;
  message: BaseHookMessage;
}

function CategoryIcon({ category }: { category: string }) {
  switch (category) {
    case "sql":
      return <Database className="h-3.5 w-3.5" />;
    case "pasteboard":
      return <Clipboard className="h-3.5 w-3.5" />;
    case "biometric":
      return <Fingerprint className="h-3.5 w-3.5" />;
    case "deviceid":
      return <Smartphone className="h-3.5 w-3.5" />;
    case "fileops":
      return <FolderOpen className="h-3.5 w-3.5" />;
    default:
      return <Layers className="h-3.5 w-3.5" />;
  }
}

function formatSummary(message: BaseHookMessage): string {
  return message.line || "";
}

function SummaryPopover({ summary }: { summary: string }) {
  const [copied, setCopied] = useState(false);

  if (!summary) {
    return <span className="text-muted-foreground/30">--</span>;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Failed to copy:", e);
    }
  };

  return (
    <button
      type="button"
      className="flex items-center gap-1 min-w-0 flex-1 text-left"
      onClick={handleCopy}
      title={summary}
    >
      <span className="font-mono text-muted-foreground truncate flex-1 min-w-0 hover:text-foreground">
        {summary}
      </span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function StackTracePopover({
  bt,
}: {
  bt?: string[];
}) {
  const { t } = useTranslation();

  if (!bt || bt.length === 0) {
    return <span className="text-muted-foreground/30 text-xs px-2">--</span>;
  }

  const content = bt.join("\n");

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-6 px-1.5"
      title={content}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(content);
        } catch (e) {
          console.error("Failed to copy stack trace:", e);
        }
      }}
    >
      <Layers className="h-3 w-3" />
      <span className="sr-only">{t("hook_stack_trace")}</span>
    </Button>
  );
}

interface HookRowProps {
  entries: HookEntry[];
}

function HookRow(
  props: {
    index: number;
  } & HookRowProps,
) {
  const { index, entries } = props;
  const entry = entries[index];

  if (!entry) return null;

  const { message, timestamp } = entry;

  return (
    <div
      className="flex items-center px-3 py-1 border-b border-border/50 hover:bg-muted/30 text-xs gap-2"
    >
      <span className="text-muted-foreground font-mono w-24 shrink-0">
        {toTime(timestamp)}
      </span>
      <Badge
        variant="outline"
        className="flex items-center gap-1 h-5 px-1.5 shrink-0"
      >
        <CategoryIcon category={message.category} />
        <span className="text-[10px]">{message.category}</span>
      </Badge>
      <Badge
        variant={message.dir === "enter" ? "default" : "secondary"}
        className="h-5 px-1.5 text-[10px] shrink-0"
      >
        <ChevronRight
          className={`h-3 w-3 ${message.dir === "leave" ? "rotate-180" : ""}`}
        />
      </Badge>
      <span
        className="font-mono text-primary truncate w-48 shrink-0"
        title={message.symbol}
      >
        {message.symbol}
      </span>
      <SummaryPopover summary={formatSummary(message)} />
      <div className="shrink-0">
        <StackTracePopover bt={message.backtrace} />
      </div>
    </div>
  );
}

const mapHistory = (record: Record<string, unknown>, id: number): HookEntry | null => {
  if (record.category === "crypto") return null;
  return {
    id,
    timestamp: new Date(record.timestamp as string),
    message: {
      subject: "hook",
      category: record.category as string,
      symbol: record.symbol as string,
      dir: record.direction as "enter" | "leave",
      line: (record.line as string) ?? undefined,
      extra: record.extra as Record<string, unknown> | undefined,
    },
  };
};

const mapSocket = (id: number, ...args: unknown[]): HookEntry | null => {
  const message = args[0] as BaseHookMessage;
  if (message.category === "crypto") return null;
  return { id, timestamp: new Date(), message };
};

export function HookResultsView() {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);

  const {
    entries,
    clear,
  } = useLogStream<HookEntry>({
    event: "hook",
    path: "hooks",
    key: "hooks",
    fromRecord: mapHistory as (record: Record<string, unknown>, id: number) => HookEntry,
    fromEvent: mapSocket,
    max: 10000,
  });

  // Filter out null entries from mapHistory (crypto category)
  const filteredEntries = useMemo(
    () => entries.filter((e): e is HookEntry => e !== null),
    [entries],
  );

  // Auto-scroll when new entries arrive
  useEffect(() => {
    if (listRef.current && filteredEntries.length > 0) {
      requestAnimationFrame(() => {
        if (!listRef.current) return;
        listRef.current.scrollTop = listRef.current.scrollHeight;
      });
    }
  }, [filteredEntries.length]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            {filteredEntries.length.toLocaleString()} {t("hook_results").toLowerCase()}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={clear}
          className="h-7 px-2"
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {filteredEntries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {t("hook_no_results")}
          </div>
        ) : (
          <div ref={listRef} className="h-full overflow-auto">
            {filteredEntries.map((_, index) => (
              <HookRow
                key={filteredEntries[index]!.id}
                index={index}
                entries={filteredEntries}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
