import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Pencil, Play, Plus, Save, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSession } from "@/context/SessionContext";
import { useQueryClient } from "@/lib/queries";

interface HookScriptRecord {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  runOnAppLaunch: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ScriptInput {
  name: string;
  content: string;
  enabled: boolean;
  runOnAppLaunch: boolean;
}

interface HookScriptPresetItem {
  scriptId: string;
  enabled: boolean;
  runOnAppLaunch: boolean;
}

interface HookScriptPresetRecord {
  id: string;
  name: string;
  items: HookScriptPresetItem[];
  autoApplyOnAppLaunch: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ScriptPresetInput {
  name: string;
  items: HookScriptPresetItem[];
  autoApplyOnAppLaunch?: boolean;
}

interface ScriptPresetPatch {
  name?: string;
  items?: HookScriptPresetItem[];
  autoApplyOnAppLaunch?: boolean;
}

interface HookScriptTemplateRecord {
  id: string;
  name: string;
  description: string;
  platform: "droid" | "fruity" | "any";
  identifiers: string[];
  content: string;
  enabled: boolean;
  runOnAppLaunch: boolean;
  recommended: boolean;
  imported: boolean;
}

interface HookHistoryRecord {
  id: number;
  timestamp: string;
  category: string;
  symbol: string;
  direction: "enter" | "leave";
  line?: string;
  extra?: Record<string, unknown>;
  createdAt: string;
}

interface HookHistoryResponse {
  hooks: HookHistoryRecord[];
  total: number;
  limit: number;
  offset: number;
}

interface ScriptApplyHitMeta {
  hitCount: number;
  firstHitAt?: string;
  lastHitAt?: string;
}

interface ScriptApplyAckViewItem {
  id: number;
  symbol: string;
  timestamp: string;
  source: "manual" | "startup";
  compileOk: boolean;
  installedHooksSync: number;
  failedMethods: string[];
  hit: ScriptApplyHitMeta;
  error: string;
}

interface MCPStatus {
  enabled: boolean;
  showTargetedCapabilities: boolean;
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `request failed (${response.status})`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export function HookScriptsManager() {
  const { t } = useTranslation();
  const { device, identifier, platform } = useSession();
  const queryClient = useQueryClient();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [runOnAppLaunch, setRunOnAppLaunch] = useState(true);
  const [presetName, setPresetName] = useState("");
  const [importingAll, setImportingAll] = useState(false);

  const scriptsPath = useMemo(() => {
    if (!device || !identifier) return null;
    return `/api/scripts/${encodeURIComponent(device)}/${encodeURIComponent(identifier)}`;
  }, [device, identifier]);

  const { data: mcpStatus } = useQuery<MCPStatus>({
    queryKey: ["mcp-status"],
    queryFn: () => apiRequest<MCPStatus>("/api/mcp/status"),
  });
  const showTargetedCapabilities = mcpStatus?.showTargetedCapabilities === true;

  const scriptsQuery = useMemo(() => {
    if (!platform) return "";
    const params = new URLSearchParams({
      platform,
      includeTargeted: showTargetedCapabilities ? "1" : "0",
    });
    return `?${params.toString()}`;
  }, [platform, showTargetedCapabilities]);

  const baseUrl = useMemo(() => {
    if (!scriptsPath) return null;
    return `${scriptsPath}${scriptsQuery}`;
  }, [scriptsPath, scriptsQuery]);

  const templatesUrl = useMemo(() => {
    if (!platform || !device || !identifier) return null;
    const query = new URLSearchParams({
      device,
      identifier,
      includeTargeted: showTargetedCapabilities ? "1" : "0",
    }).toString();
    return `/api/script-templates/${encodeURIComponent(platform)}?${query}`;
  }, [platform, device, identifier, showTargetedCapabilities]);

  const scriptApplyAckUrl = useMemo(() => {
    if (!device || !identifier) return null;
    const params = new URLSearchParams({
      category: "script.apply.ack",
      limit: "50",
      offset: "0",
    });
    return `/api/hooks/${encodeURIComponent(device)}/${encodeURIComponent(identifier)}?${params.toString()}`;
  }, [device, identifier]);

  const scriptApplyHitUrl = useMemo(() => {
    if (!device || !identifier) return null;
    const params = new URLSearchParams({
      category: "script.apply.hit",
      limit: "200",
      offset: "0",
    });
    return `/api/hooks/${encodeURIComponent(device)}/${encodeURIComponent(identifier)}?${params.toString()}`;
  }, [device, identifier]);

  const buildScriptItemUrl = useCallback(
    (id: string) => {
      if (!scriptsPath) throw new Error("scripts path not ready");
      return `${scriptsPath}/${encodeURIComponent(id)}${scriptsQuery}`;
    },
    [scriptsPath, scriptsQuery],
  );

  const presetsUrl = useMemo(() => {
    if (!device || !identifier) return null;
    return `/api/script-presets/${encodeURIComponent(device)}/${encodeURIComponent(identifier)}`;
  }, [device, identifier]);

  const { data: scripts = [], isLoading, error: scriptsError } = useQuery<
    HookScriptRecord[]
  >({
    queryKey: [
      "hookScripts",
      device,
      identifier,
      platform,
      showTargetedCapabilities,
    ],
    queryFn: () => apiRequest<HookScriptRecord[]>(baseUrl!),
    enabled: !!baseUrl,
  });

  const { data: presets = [], isLoading: isLoadingPresets } = useQuery<
    HookScriptPresetRecord[]
  >({
    queryKey: ["hookScriptPresets", device, identifier],
    queryFn: () => apiRequest<HookScriptPresetRecord[]>(presetsUrl!),
    enabled: !!presetsUrl,
  });

  const {
    data: templates = [],
    isLoading: isLoadingTemplates,
    error: templatesError,
  } = useQuery<HookScriptTemplateRecord[]>({
    queryKey: [
      "hookScriptTemplates",
      platform,
      device,
      identifier,
      showTargetedCapabilities,
    ],
    queryFn: () => apiRequest<HookScriptTemplateRecord[]>(templatesUrl!),
    enabled: !!templatesUrl,
  });

  const { data: scriptApplyAcksData, isLoading: isLoadingScriptApplyAcks } =
    useQuery<HookHistoryResponse>({
      queryKey: ["hookScriptApplyAcks", device, identifier],
      queryFn: () => apiRequest<HookHistoryResponse>(scriptApplyAckUrl!),
      enabled: !!scriptApplyAckUrl,
      refetchInterval: 3000,
    });
  const { data: scriptApplyHitsData } = useQuery<HookHistoryResponse>({
    queryKey: ["hookScriptApplyHits", device, identifier],
    queryFn: () => apiRequest<HookHistoryResponse>(scriptApplyHitUrl!),
    enabled: !!scriptApplyHitUrl,
    refetchInterval: 3000,
  });

  const scriptApplyAcks = useMemo(() => scriptApplyAcksData?.hooks ?? [], [scriptApplyAcksData]);
  const scriptApplyHits = useMemo(() => scriptApplyHitsData?.hooks ?? [], [scriptApplyHitsData]);

  const scriptApplyAckRows = useMemo<ScriptApplyAckViewItem[]>(() => {
    type HitRow = {
      timestamp: string;
      sessionId?: string;
      symbol: string;
      hitCount: number;
      firstHitAt?: string;
      lastHitAt?: string;
    };
    const hits: HitRow[] = scriptApplyHits.map((item) => {
      const extra =
        item.extra && typeof item.extra === "object" ? item.extra : {};
      const hitCount =
        typeof extra.hitCount === "number" && Number.isFinite(extra.hitCount)
          ? Math.max(1, Math.floor(extra.hitCount))
          : 1;
      return {
        timestamp: item.timestamp,
        sessionId:
          typeof extra.sessionId === "string" && extra.sessionId.length > 0
            ? extra.sessionId
            : undefined,
        symbol: item.symbol,
        hitCount,
        firstHitAt:
          typeof extra.firstHitAt === "string" ? extra.firstHitAt : item.timestamp,
        lastHitAt:
          typeof extra.lastHitAt === "string" ? extra.lastHitAt : item.timestamp,
      };
    });

    return scriptApplyAcks.map((ack) => {
      const extra =
        ack.extra && typeof ack.extra === "object" ? ack.extra : {};
      const compileOk = extra.compileOk === true;
      const installedHooksSync =
        typeof extra.installedHooksSync === "number"
          ? Math.max(0, Math.floor(extra.installedHooksSync))
          : typeof extra.hookedMethods === "number"
            ? Math.max(0, Math.floor(extra.hookedMethods))
            : 0;
      const failedMethods = Array.isArray(extra.failedMethods)
        ? extra.failedMethods.filter((item): item is string => typeof item === "string")
        : [];
      const source = extra.source === "startup" ? "startup" : "manual";
      const sessionId =
        typeof extra.sessionId === "string" && extra.sessionId.length > 0
          ? extra.sessionId
          : undefined;

      const candidateHits = hits.filter((item) => {
        if (!item.symbol || item.symbol !== ack.symbol) return false;
        if (item.timestamp < ack.timestamp) return false;
        if (sessionId && item.sessionId && item.sessionId !== sessionId) return false;
        return true;
      });

      let hitCount =
        typeof extra.hitCount === "number" && Number.isFinite(extra.hitCount)
          ? Math.max(0, Math.floor(extra.hitCount))
          : 0;
      let firstHitAt =
        typeof extra.firstHitAt === "string" ? extra.firstHitAt : undefined;
      let lastHitAt =
        typeof extra.lastHitAt === "string" ? extra.lastHitAt : undefined;

      for (const hit of candidateHits) {
        hitCount = Math.max(hitCount, hit.hitCount);
        if (!firstHitAt || (hit.firstHitAt && hit.firstHitAt < firstHitAt)) {
          firstHitAt = hit.firstHitAt;
        }
        if (!lastHitAt || (hit.lastHitAt && hit.lastHitAt > lastHitAt)) {
          lastHitAt = hit.lastHitAt;
        }
      }

      return {
        id: ack.id,
        symbol: ack.symbol,
        timestamp: ack.timestamp,
        source,
        compileOk,
        installedHooksSync,
        failedMethods,
        hit: {
          hitCount,
          firstHitAt,
          lastHitAt,
        },
        error: typeof extra.error === "string" ? extra.error : "",
      };
    });
  }, [scriptApplyAcks, scriptApplyHits]);

  const scriptApplySummary = useMemo(() => {
    let success = 0;
    let failed = 0;
    let withHooks = 0;
    let withoutHooks = 0;
    let withHits = 0;
    let withoutHits = 0;

    for (const item of scriptApplyAckRows) {
      if (item.compileOk) success += 1;
      else failed += 1;
      if (item.installedHooksSync > 0) withHooks += 1;
      else withoutHooks += 1;
      if (item.hit.hitCount > 0) withHits += 1;
      else withoutHits += 1;
    }

    return { success, failed, withHooks, withoutHooks, withHits, withoutHits };
  }, [scriptApplyAckRows]);

  const createMutation = useMutation({
    mutationFn: (input: ScriptInput) =>
      apiRequest<HookScriptRecord>(baseUrl!, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["hookScripts", device, identifier, platform],
      });
      queryClient.invalidateQueries({
        queryKey: ["hookScriptTemplates", platform, device, identifier],
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<ScriptInput> }) =>
      apiRequest<HookScriptRecord>(buildScriptItemUrl(id), {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["hookScripts", device, identifier, platform],
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(buildScriptItemUrl(id), {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["hookScripts", device, identifier, platform],
      });
      queryClient.invalidateQueries({
        queryKey: ["hookScriptTemplates", platform, device, identifier],
      });
      queryClient.invalidateQueries({
        queryKey: ["hookScriptPresets", device, identifier],
      });
    },
  });

  const createPresetMutation = useMutation({
    mutationFn: (input: ScriptPresetInput) =>
      apiRequest<HookScriptPresetRecord>(presetsUrl!, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["hookScriptPresets", device, identifier],
      });
    },
  });

  const updatePresetMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ScriptPresetPatch }) =>
      apiRequest<HookScriptPresetRecord>(
        `${presetsUrl}/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          body: JSON.stringify(patch),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["hookScriptPresets", device, identifier],
      });
    },
  });

  const applyPresetMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ presetId: string; applied: number }>(
        `${presetsUrl}/${encodeURIComponent(id)}/apply`,
        {
          method: "POST",
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["hookScripts", device, identifier, platform],
      });
    },
  });

  const deletePresetMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`${presetsUrl}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["hookScriptPresets", device, identifier],
      });
    },
  });

  const setShowTargetedMutation = useMutation({
    mutationFn: async (value: boolean) => {
      if (!mcpStatus) {
        throw new Error("MCP status is not ready");
      }
      return await apiRequest<MCPStatus>("/api/mcp/status", {
        method: "PUT",
        body: JSON.stringify({
          enabled: mcpStatus.enabled,
          showTargetedCapabilities: value,
        }),
      });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["mcp-status"], next);
      queryClient.invalidateQueries({
        queryKey: ["hookScriptTemplates", platform, device, identifier],
      });
      queryClient.invalidateQueries({
        queryKey: ["hookScripts", device, identifier, platform],
      });
      toast.success(t("hook_targeted_visibility_updated"));
    },
    onError: (error) => {
      console.error("Failed to set targeted capability visibility:", error);
      toast.error(t("hook_targeted_visibility_update_failed"));
    },
  });

  const resetEditor = () => {
    setEditingId(null);
    setName("");
    setContent("");
    setEnabled(true);
    setRunOnAppLaunch(true);
  };

  const startCreate = () => {
    setEditingId("new");
    setName("");
    setContent("");
    setEnabled(true);
    setRunOnAppLaunch(true);
  };

  const startEdit = (item: HookScriptRecord) => {
    setEditingId(item.id);
    setName(item.name);
    setContent(item.content);
    setEnabled(item.enabled);
    setRunOnAppLaunch(item.runOnAppLaunch);
  };

  const handleSave = async () => {
    if (!baseUrl) return;
    const payload: ScriptInput = {
      name: name.trim(),
      content,
      enabled,
      runOnAppLaunch,
    };
    try {
      if (editingId === "new") {
        await createMutation.mutateAsync(payload);
      } else if (editingId) {
        await updateMutation.mutateAsync({ id: editingId, patch: payload });
      }
      resetEditor();
    } catch (error) {
      console.error("Failed to save script:", error);
      toast.error(t("hook_script_save_failed"));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMutation.mutateAsync(id);
      if (editingId === id) {
        resetEditor();
      }
    } catch (error) {
      console.error("Failed to delete script:", error);
      toast.error(t("hook_script_delete_failed"));
    }
  };

  const toggleField = async (
    id: string,
    patch: Partial<Pick<ScriptInput, "enabled" | "runOnAppLaunch">>,
  ) => {
    try {
      await updateMutation.mutateAsync({ id, patch });
    } catch (error) {
      console.error("Failed to update script:", error);
      toast.error(t("hook_script_save_failed"));
    }
  };

  const handleSavePreset = async () => {
    if (!presetsUrl) return;
    const payload: ScriptPresetInput = {
      name: presetName.trim(),
      items: scripts.map((item) => ({
        scriptId: item.id,
        enabled: item.enabled,
        runOnAppLaunch: item.runOnAppLaunch,
      })),
      autoApplyOnAppLaunch: false,
    };
    try {
      await createPresetMutation.mutateAsync(payload);
      setPresetName("");
      toast.success(t("hook_preset_saved"));
    } catch (error) {
      console.error("Failed to save script preset:", error);
      toast.error(t("hook_preset_save_failed"));
    }
  };

  const handleApplyPreset = async (id: string) => {
    try {
      await applyPresetMutation.mutateAsync(id);
      toast.success(t("hook_preset_applied"));
    } catch (error) {
      console.error("Failed to apply script preset:", error);
      toast.error(t("hook_preset_apply_failed"));
    }
  };

  const handleDeletePreset = async (id: string) => {
    try {
      await deletePresetMutation.mutateAsync(id);
    } catch (error) {
      console.error("Failed to delete script preset:", error);
      toast.error(t("hook_preset_delete_failed"));
    }
  };

  const handleTogglePresetAutoApply = async (id: string, enabled: boolean) => {
    try {
      await updatePresetMutation.mutateAsync({
        id,
        patch: { autoApplyOnAppLaunch: enabled },
      });
      toast.success(t("hook_preset_updated"));
    } catch (error) {
      console.error("Failed to update script preset:", error);
      toast.error(t("hook_preset_update_failed"));
    }
  };

  const upsertTemplate = async (
    template: HookScriptTemplateRecord,
    knownScripts: HookScriptRecord[],
  ): Promise<"created" | "updated"> => {
    const existed = knownScripts.find((item) => item.name === template.name);
    if (existed) {
      await updateMutation.mutateAsync({
        id: existed.id,
        patch: {
          name: template.name,
          content: template.content,
          enabled: template.enabled,
          runOnAppLaunch: template.runOnAppLaunch,
        },
      });
      const idx = knownScripts.findIndex((item) => item.id === existed.id);
      if (idx >= 0) {
        knownScripts[idx] = {
          ...knownScripts[idx],
          name: template.name,
          content: template.content,
          enabled: template.enabled,
          runOnAppLaunch: template.runOnAppLaunch,
        };
      }
      return "updated";
    }

    const created = await createMutation.mutateAsync({
      name: template.name,
      content: template.content,
      enabled: template.enabled,
      runOnAppLaunch: template.runOnAppLaunch,
    });
    knownScripts.push(created);
    return "created";
  };

  const handleImportTemplate = async (template: HookScriptTemplateRecord) => {
    try {
      const action = await upsertTemplate(template, [...scripts]);
      if (action === "updated") {
        toast.success(t("hook_builtin_template_synced"));
      } else {
        toast.success(t("hook_builtin_template_imported"));
      }
    } catch (error) {
      console.error("Failed to import builtin template:", error);
      toast.error(t("hook_builtin_template_import_failed"));
    }
  };

  const handleImportAllTemplates = async () => {
    if (templates.length === 0) return;
    setImportingAll(true);
    try {
      const working = [...scripts];
      let created = 0;
      let updated = 0;
      for (const template of templates) {
        const action = await upsertTemplate(template, working);
        if (action === "created") created += 1;
        else updated += 1;
      }
      toast.success(
        t("hook_builtin_template_import_all_done", {
          created,
          updated,
        }),
      );
    } catch (error) {
      console.error("Failed to import all builtin templates:", error);
      toast.error(t("hook_builtin_template_import_all_failed"));
    } finally {
      setImportingAll(false);
    }
  };

  const saving =
    createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;
  const presetSaving =
    createPresetMutation.isPending ||
    updatePresetMutation.isPending ||
    applyPresetMutation.isPending ||
    deletePresetMutation.isPending;
  const capabilitySaving = setShowTargetedMutation.isPending;
  const canSave = name.trim().length > 0 && content.trim().length > 0;
  const canSavePreset = presetName.trim().length > 0 && scripts.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{t("hook_scripts")}</div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={startCreate}
          disabled={saving}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t("hook_script_new")}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{t("hook_scripts_desc")}</p>
      {scriptsError instanceof Error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {scriptsError.message}
        </div>
      ) : null}

      <div className="rounded-md border border-border p-3 space-y-3">
        <div>
          <div className="text-sm font-medium">{t("hook_script_apply_evidence")}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {t("hook_script_apply_evidence_desc")}
          </p>
        </div>

        {isLoadingScriptApplyAcks ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("loading")}...
          </div>
        ) : scriptApplyAckRows.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            {t("hook_script_apply_no_data")}
          </p>
        ) : (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              {t("hook_script_apply_success")}: {scriptApplySummary.success} ·{" "}
              {t("hook_script_apply_failed")}: {scriptApplySummary.failed} ·{" "}
              {t("hook_script_apply_with_hooks")}: {scriptApplySummary.withHooks} ·{" "}
              {t("hook_script_apply_without_hooks")}: {scriptApplySummary.withoutHooks} ·{" "}
              {t("hook_script_apply_with_hits")}: {scriptApplySummary.withHits} ·{" "}
              {t("hook_script_apply_without_hits")}: {scriptApplySummary.withoutHits}
            </div>
            {scriptApplyAckRows.slice(0, 8).map((ack) => {
              return (
                <div
                  key={ack.id}
                  className="rounded-md border border-border p-2 space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium truncate">{ack.symbol}</div>
                    <div className="text-[11px] text-muted-foreground whitespace-nowrap">
                      {new Date(ack.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="rounded border border-border px-1.5 py-0.5">
                      {ack.source === "startup"
                        ? t("hook_script_apply_source_startup")
                        : t("hook_script_apply_source_manual")}
                    </span>
                    <span className="rounded border border-border px-1.5 py-0.5">
                      {t("hook_script_apply_hooks", { count: ack.installedHooksSync })}
                    </span>
                    <span className="rounded border border-border px-1.5 py-0.5">
                      {t("hook_script_apply_hits", { count: ack.hit.hitCount })}
                    </span>
                    <span className="rounded border border-border px-1.5 py-0.5">
                      {t("hook_script_apply_failures", { count: ack.failedMethods.length })}
                    </span>
                    <span
                      className={
                        ack.compileOk
                          ? "inline-flex items-center gap-1 rounded border border-emerald-500/40 px-1.5 py-0.5 text-emerald-500"
                          : "inline-flex items-center gap-1 rounded border border-destructive/40 px-1.5 py-0.5 text-destructive"
                      }
                    >
                      {ack.compileOk ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <XCircle className="h-3 w-3" />
                      )}
                      {ack.compileOk
                        ? t("hook_script_apply_success")
                        : t("hook_script_apply_failed")}
                    </span>
                  </div>
                  {ack.hit.firstHitAt ? (
                    <div className="text-[11px] text-muted-foreground truncate">
                      {t("hook_script_apply_first_hit")}:{" "}
                      {new Date(ack.hit.firstHitAt).toLocaleTimeString()}
                    </div>
                  ) : null}
                  {!ack.compileOk && ack.error ? (
                    <div className="text-[11px] text-destructive truncate">
                      {t("hook_script_apply_error")}: {ack.error}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-md border border-border p-3 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-medium">{t("hook_builtin_templates")}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("hook_builtin_templates_desc")}
            </p>
            <div className="mt-2 flex items-center gap-2 rounded border border-border px-2 py-1.5 w-fit">
              <Switch
                checked={showTargetedCapabilities}
                disabled={capabilitySaving || !mcpStatus}
                onCheckedChange={(checked) =>
                  setShowTargetedMutation.mutate(checked)
                }
              />
              <div className="text-xs text-muted-foreground">
                {t("hook_show_targeted_capabilities")}
              </div>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs shrink-0"
            onClick={handleImportAllTemplates}
            disabled={
              !platform ||
              isLoadingTemplates ||
              templates.length === 0 ||
              saving ||
              capabilitySaving ||
              importingAll
            }
          >
            {importingAll ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : null}
            {t("hook_builtin_template_import_all")}
          </Button>
        </div>
        {!platform ? (
          <p className="text-xs text-muted-foreground italic">
            {t("connect_to_view_app_info")}
          </p>
        ) : isLoadingTemplates ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("loading")}...
          </div>
        ) : templatesError instanceof Error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {templatesError.message}
          </div>
        ) : templates.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            {t("hook_builtin_templates_empty")}
          </p>
        ) : (
          <div className="space-y-2">
            {templates.map((template) => (
              <div
                key={template.id}
                className="rounded-md border border-border p-2 flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {template.name}
                    {template.recommended ? (
                      <span className="ml-2 text-[10px] rounded border border-border px-1.5 py-0.5 text-muted-foreground align-middle">
                        {t("hook_builtin_template_recommended")}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {template.description}
                  </div>
                </div>
                <div className="shrink-0">
                  <Button
                    variant={template.imported ? "secondary" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleImportTemplate(template)}
                    disabled={saving || importingAll}
                  >
                    {template.imported
                      ? t("hook_builtin_template_sync")
                      : t("hook_builtin_template_import")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-md border border-border p-3 space-y-3">
        <div>
          <div className="text-sm font-medium">{t("hook_presets")}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {t("hook_presets_desc")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            placeholder={t("hook_preset_name")}
            className="h-8"
            disabled={presetSaving}
          />
          <Button
            size="sm"
            className="h-8"
            onClick={handleSavePreset}
            disabled={!canSavePreset || presetSaving}
          >
            {createPresetMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <Save className="h-3.5 w-3.5 mr-1" />
            )}
            {t("hook_preset_save_current")}
          </Button>
        </div>

        {isLoadingPresets ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("loading")}...
          </div>
        ) : presets.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            {t("hook_presets_empty")}
          </p>
        ) : (
          <div className="space-y-2">
            {presets.map((preset) => (
              <div
                key={preset.id}
                className="rounded-md border border-border p-2 flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{preset.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {t("hook_preset_items", { count: preset.items.length })}
                  </div>
                  <label className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={preset.autoApplyOnAppLaunch}
                      onCheckedChange={(checked) =>
                        handleTogglePresetAutoApply(preset.id, checked)
                      }
                      disabled={presetSaving}
                    />
                    <span>{t("hook_preset_auto_apply_on_launch")}</span>
                  </label>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleApplyPreset(preset.id)}
                    disabled={presetSaving}
                    title={t("hook_preset_apply")}
                  >
                    {applyPresetMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    ) : (
                      <Play className="h-3.5 w-3.5 mr-1" />
                    )}
                    {t("hook_preset_apply")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-destructive hover:text-destructive"
                    onClick={() => handleDeletePreset(preset.id)}
                    disabled={presetSaving}
                    title={t("delete")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("loading")}...
        </div>
      ) : scripts.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          {t("hook_scripts_empty")}
        </p>
      ) : (
        <div className="space-y-2">
          {scripts.map((item) => {
            const preview =
              item.content.trim().split("\n")[0]?.slice(0, 72) || "(empty)";
            return (
              <div
                key={item.id}
                className="rounded-md border border-border p-2 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{item.name}</div>
                    <div className="text-xs text-muted-foreground font-mono truncate">
                      {preview}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => startEdit(item)}
                      disabled={saving}
                      title={t("edit")}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(item.id)}
                      disabled={saving}
                      title={t("delete")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={item.enabled}
                      onCheckedChange={(checked) =>
                        toggleField(item.id, { enabled: checked })
                      }
                      disabled={saving}
                    />
                    <span>{t("hook_script_enabled")}</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={item.runOnAppLaunch}
                      onCheckedChange={(checked) =>
                        toggleField(item.id, { runOnAppLaunch: checked })
                      }
                      disabled={saving}
                    />
                    <span>{t("hook_script_run_on_launch")}</span>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingId && (
        <div className="rounded-md border border-border p-3 space-y-3">
          <div className="text-sm font-medium">
            {editingId === "new" ? t("hook_script_new") : t("edit")}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("hook_script_name")}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("hook_script_name")}
              className="h-8"
              disabled={saving}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("hook_script_content")}</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-32 font-mono text-xs"
              disabled={saving}
            />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={enabled}
                onCheckedChange={setEnabled}
                disabled={saving}
              />
              <span>{t("hook_script_enabled")}</span>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={runOnAppLaunch}
                onCheckedChange={setRunOnAppLaunch}
                disabled={saving}
              />
              <span>{t("hook_script_run_on_launch")}</span>
            </label>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={resetEditor} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!canSave || saving}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : null}
              {t("save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
