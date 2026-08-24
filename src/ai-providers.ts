import type { AppSettings } from "./types";

export const AI_PROVIDERS = [
  { id: "anthropic", label: "Anthropic API" },
  { id: "claude_cli", label: "Claude CLI" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "kilo_cli", label: "Kilo CLI" },
  { id: "opencode_cli", label: "OpenCode CLI" },
] as const;

export type AiProviderId = (typeof AI_PROVIDERS)[number]["id"];

export const AI_PROVIDER_MODEL_HINT: Record<AiProviderId, string> = {
  anthropic: "haiku, sonnet, opus",
  claude_cli: "haiku, sonnet, opus",
  openrouter: "openrouter/free",
  kilo_cli: "kilo/...",
  opencode_cli: "ollama/qwen2.5-coder",
};

export const AI_PROVIDER_PRESET_MODELS: Record<
  AiProviderId,
  { id: string; label: string }[]
> = {
  anthropic: [
    { id: "haiku", label: "Haiku" },
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
  ],
  claude_cli: [
    { id: "haiku", label: "Haiku" },
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
  ],
  openrouter: [{ id: "openrouter/free", label: "OpenRouter free" }],
  kilo_cli: [],
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
  const keep =
    presets.some((model) => model.id === current) ||
    (next === "opencode_cli" &&
      (current.length === 0 || current.toLowerCase().startsWith("ollama/")));
  return {
    aiProvider: next,
    aiModel: keep ? settings.aiModel : (presets[0]?.id ?? ""),
  };
}
