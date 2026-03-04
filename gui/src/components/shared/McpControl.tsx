import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Copy, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";

interface MCPStatus {
  enabled: boolean;
  showTargetedCapabilities: boolean;
  endpoint: string;
  token: string;
  tokenEnvVar: string;
  toolCount: number;
  protocolVersion: string;
  serverName: string;
  codexAddCommand: string;
  claudeConfigSnippet: {
    mcpServers: Record<string, unknown>;
  };
  antigravityConfigSnippet: {
    mcpServers: Record<string, unknown>;
  };
  configSnippet: {
    mcpServers: Record<string, unknown>;
  };
}

async function fetchMCPStatus(): Promise<MCPStatus> {
  const res = await fetch("/api/mcp/status");
  if (!res.ok) throw new Error("failed to fetch MCP status");
  return await res.json();
}

export function McpControl() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["mcp-status"],
    queryFn: fetchMCPStatus,
  });

  const setEnabled = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch("/api/mcp/status", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("failed to set MCP status");
      return (await res.json()) as MCPStatus;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["mcp-status"], next);
      toast.success(
        next.enabled ? t("mcp_enabled_toast") : t("mcp_disabled_toast"),
      );
    },
    onError: () => {
      toast.error(t("mcp_update_failed"));
    },
  });

  const rotateToken = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/mcp/token/rotate", { method: "POST" });
      if (!res.ok) throw new Error("failed to rotate MCP token");
      return (await res.json()) as MCPStatus;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["mcp-status"], next);
      toast.success(t("mcp_token_rotated"));
    },
    onError: () => {
      toast.error(t("mcp_rotate_failed"));
    },
  });

  const setShowTargetedCapabilities = useMutation({
    mutationFn: async (showTargetedCapabilities: boolean) => {
      if (!data) {
        throw new Error("MCP status is not ready");
      }
      const res = await fetch("/api/mcp/status", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: data.enabled,
          showTargetedCapabilities,
        }),
      });
      if (!res.ok) throw new Error("failed to set targeted capability visibility");
      return (await res.json()) as MCPStatus;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["mcp-status"], next);
      toast.success(t("mcp_targeted_visibility_updated"));
    },
    onError: () => {
      toast.error(t("mcp_update_failed"));
    },
  });

  const configText = useMemo(() => {
    if (!data) return "";
    return JSON.stringify(data.configSnippet, null, 2);
  }, [data]);

  const codexSetupText = useMemo(() => {
    if (!data) return "";
    return `export ${data.tokenEnvVar}=${data.token}\n${data.codexAddCommand}`;
  }, [data]);

  const claudeSetupText = useMemo(() => {
    if (!data) return "";
    return JSON.stringify(data.claudeConfigSnippet, null, 2);
  }, [data]);

  const antigravitySetupText = useMemo(() => {
    if (!data) return "";
    return JSON.stringify(data.antigravityConfigSnippet, null, 2);
  }, [data]);

  const copyText = async (text: string, okMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(okMessage);
    } catch {
      toast.error(t("mcp_copy_failed"));
    }
  };

  const busy =
    isLoading ||
    setEnabled.isPending ||
    rotateToken.isPending ||
    setShowTargetedCapabilities.isPending;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant={data?.enabled ? "default" : "outline"}
            size="icon"
            aria-label={t("mcp_control")}
            title={t("mcp_control")}
          />
        }
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="w-[24rem] space-y-3">
        <PopoverHeader>
          <PopoverTitle>{t("mcp_control")}</PopoverTitle>
          <div className="text-xs text-muted-foreground">
            {t("mcp_control_desc")}
          </div>
        </PopoverHeader>

        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div>
            <div className="text-sm font-medium">{t("mcp_enabled_label")}</div>
            <div className="text-xs text-muted-foreground">
              {t("mcp_tool_count", { count: data?.toolCount ?? 0 })}
            </div>
          </div>
          <Switch
            checked={data?.enabled ?? false}
            disabled={busy || !data}
            onCheckedChange={(checked) => setEnabled.mutate(checked)}
          />
        </div>

        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div>
            <div className="text-sm font-medium">
              {t("mcp_show_targeted_capabilities")}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("mcp_show_targeted_capabilities_desc")}
            </div>
          </div>
          <Switch
            checked={data?.showTargetedCapabilities ?? false}
            disabled={busy || !data}
            onCheckedChange={(checked) =>
              setShowTargetedCapabilities.mutate(checked)
            }
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">{t("mcp_endpoint")}</Label>
          <div className="flex items-center gap-1">
            <Input
              value={data?.endpoint ?? ""}
              readOnly
              className="h-8 text-xs font-mono"
            />
            <Button
              size="icon-sm"
              variant="outline"
              disabled={!data}
              onClick={() =>
                data && copyText(data.endpoint, t("mcp_endpoint_copied"))
              }
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">{t("mcp_token")}</Label>
          <div className="flex items-center gap-1">
            <Input
              value={data?.token ?? ""}
              readOnly
              className="h-8 text-xs font-mono"
            />
            <Button
              size="icon-sm"
              variant="outline"
              disabled={!data}
              onClick={() => data && copyText(data.token, t("mcp_token_copied"))}
            >
              <KeyRound className="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              disabled={busy}
              onClick={() => rotateToken.mutate()}
            >
              <RefreshCw className={`h-4 w-4 ${rotateToken.isPending ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">{t("mcp_config_snippet")}</Label>
          <textarea
            value={configText}
            readOnly
            className="min-h-28 w-full rounded-md border bg-muted/20 p-2 text-xs font-mono"
          />
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="outline"
              disabled={!data}
              onClick={() =>
                data &&
                copyText(configText, t("mcp_config_copied"))
              }
            >
              <Copy className="h-3.5 w-3.5" />
              {t("mcp_copy_config")}
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">{t("mcp_codex_setup")}</Label>
          <textarea
            value={codexSetupText}
            readOnly
            className="min-h-20 w-full rounded-md border bg-muted/20 p-2 text-xs font-mono"
          />
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="outline"
              disabled={!data}
              onClick={() =>
                data &&
                copyText(codexSetupText, t("mcp_codex_setup_copied"))
              }
            >
              <Copy className="h-3.5 w-3.5" />
              {t("mcp_copy_codex_setup")}
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">{t("mcp_claude_setup")}</Label>
          <textarea
            value={claudeSetupText}
            readOnly
            className="min-h-20 w-full rounded-md border bg-muted/20 p-2 text-xs font-mono"
          />
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="outline"
              disabled={!data}
              onClick={() =>
                data &&
                copyText(claudeSetupText, t("mcp_claude_setup_copied"))
              }
            >
              <Copy className="h-3.5 w-3.5" />
              {t("mcp_copy_claude_setup")}
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">{t("mcp_antigravity_setup")}</Label>
          <textarea
            value={antigravitySetupText}
            readOnly
            className="min-h-20 w-full rounded-md border bg-muted/20 p-2 text-xs font-mono"
          />
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="outline"
              disabled={!data}
              onClick={() =>
                data &&
                copyText(
                  antigravitySetupText,
                  t("mcp_antigravity_setup_copied"),
                )
              }
            >
              <Copy className="h-3.5 w-3.5" />
              {t("mcp_copy_antigravity_setup")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
