import type { AppSettings } from "./types";

export const AI_PROVIDERS = [
  { id: "codex_cli", label: "Codex CLI" },
  { id: "cursor_cli", label: "Cursor CLI" },
  { id: "opencode_cli", label: "OpenCode CLI" },
] as const;

export type AiProviderId = (typeof AI_PROVIDERS)[number]["id"];

export const AI_PROVIDER_MODEL_HINT: Record<AiProviderId, string> = {
  codex_cli: "gpt-5.3-codex (blank = CLI default)",
  cursor_cli: "auto, gpt-5.3-codex, …",
  opencode_cli: "ollama/qwen2.5-coder",
};

export const AI_PROVIDER_PRESET_MODELS: Record<
  AiProviderId,
  { id: string; label: string }[]
> = {
  codex_cli: [
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  ],
  cursor_cli: [{ id: "auto", label: "Auto" }],
  opencode_cli: [],
};

export function isAiProviderId(value: string): value is AiProviderId {
  return AI_PROVIDERS.some((provider) => provider.id === value);
}

export function modelHintFor(provider: AppSettings["aiProvider"]): string {
  return isAiProviderId(provider)
    ? AI_PROVIDER_MODEL_HINT[provider]
    : "model name";
}

export function settingsAfterProviderChange(
  settings: AppSettings,
  next: AiProviderId,
): Pick<AppSettings, "aiProvider" | "aiModel"> {
  const presets = AI_PROVIDER_PRESET_MODELS[next];
  const current = settings.aiModel.trim();
  const isOllama = current.toLowerCase().startsWith("ollama/");
  const keep =
    presets.some((model) => model.id === current) ||
    (next === "opencode_cli" && (current.length === 0 || isOllama)) ||
    (next === "cursor_cli" && current.length > 0 && !isOllama) ||
    (next === "codex_cli" && current.length > 0 && !isOllama);
  return {
    aiProvider: next,
    aiModel: keep ? settings.aiModel : (presets[0]?.id ?? ""),
  };
}
