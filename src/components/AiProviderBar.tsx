import React, { useCallback, useEffect, useMemo, useState } from "react";
import { listAiModels } from "../commands";
import {
  AI_PROVIDER_PRESET_MODELS,
  AI_PROVIDERS,
  isAiProviderId,
  modelHintFor,
  settingsAfterProviderChange,
} from "../ai-providers";
import type { AiModelChoice, AppSettings } from "../types";
import { useAppState } from "../store";

export function AiProviderBar() {
  const { state, dispatch } = useAppState();
  const settings = state.settings;
  const provider = settings.aiProvider;
  const [liveModels, setLiveModels] = useState<AiModelChoice[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (provider !== "opencode_cli" && provider !== "cursor_cli") {
      setLiveModels([]);
      setWarning(
        provider === "codex_cli"
          ? "Set a Codex model in Settings, or leave blank for the CLI default."
          : null,
      );
      return;
    }
    setLoading(true);
    try {
      const list = await listAiModels(settings);
      setLiveModels(list.models);
      setWarning(list.warning ?? null);
    } catch (err) {
      setLiveModels([]);
      setWarning(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [
    provider,
    settings.aiOpencodeCliPath,
    settings.aiOpencodeUserProfile,
    settings.aiOllamaBaseUrl,
    settings.aiCursorCliPath,
    settings.aiCursorUserProfile,
    settings.disableAi,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const models = useMemo(() => {
    const presets = isAiProviderId(provider)
      ? AI_PROVIDER_PRESET_MODELS[provider]
      : [];
    const merged = [
      ...presets.map((model) => ({
        id: model.id,
        label: model.label,
        source: "preset",
      })),
      ...liveModels,
    ];
    if (
      settings.aiModel.trim() &&
      !merged.some((model) => model.id === settings.aiModel.trim())
    ) {
      merged.unshift({
        id: settings.aiModel.trim(),
        label: settings.aiModel.trim(),
        source: "current",
      });
    }
    return merged;
  }, [liveModels, provider, settings.aiModel]);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    dispatch({
      type: "SET_SETTINGS",
      settings: { ...settings, [key]: value },
    });
  };

  return (
    <div className="flex flex-col gap-1" data-testid="assistant-ai-provider-bar">
      <div className="flex flex-wrap gap-2">
        <label className="flex min-w-[140px] flex-1 flex-col gap-0.5">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Provider
          </span>
          <select
            data-testid="assistant-ai-provider"
            value={provider}
            onChange={(e) => {
              const next = e.target.value;
              if (!isAiProviderId(next)) return;
              const patch = settingsAfterProviderChange(settings, next);
              dispatch({
                type: "SET_SETTINGS",
                settings: { ...settings, ...patch },
              });
            }}
            className="rounded px-2 py-1 text-sm"
            style={{
              backgroundColor: "var(--bg-input)",
              border: "1px solid var(--border-primary)",
              color: "var(--text-primary)",
            }}
          >
            {AI_PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[180px] flex-[2] flex-col gap-0.5">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Model
          </span>
          <input
            data-testid="assistant-ai-model"
            list="assistant-ai-model-list"
            value={settings.aiModel}
            onChange={(e) => update("aiModel", e.target.value)}
            placeholder={modelHintFor(provider)}
            className="rounded px-2 py-1 text-sm"
            style={{
              backgroundColor: "var(--bg-input)",
              border: "1px solid var(--border-primary)",
              color: "var(--text-primary)",
            }}
          />
          <datalist id="assistant-ai-model-list">
            {models.map((model) => (
              <option key={`${model.source}:${model.id}`} value={model.id}>
                {model.label}
              </option>
            ))}
          </datalist>
        </label>
        {(provider === "opencode_cli" || provider === "cursor_cli") && (
          <button
            type="button"
            className="bottom-pane-action self-end"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? "Listing..." : "Refresh models"}
          </button>
        )}
      </div>
      {warning && (
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          {warning}
        </div>
      )}
    </div>
  );
}
