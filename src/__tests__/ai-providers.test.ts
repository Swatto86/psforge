import { describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  isAiProviderId,
  modelHintFor,
  settingsAfterProviderChange,
} from "../ai-providers";
import { DEFAULT_SETTINGS } from "../types";

describe("AI providers", () => {
  it("includes Anthropic and OpenCode as first-class choices", () => {
    const ids = AI_PROVIDERS.map((provider) => provider.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("opencode_cli");
    expect(isAiProviderId("opencode_cli")).toBe(true);
    expect(isAiProviderId("unknown")).toBe(false);
    expect(modelHintFor("opencode_cli")).toContain("ollama/");
  });

  it("clears a cloud model when switching to OpenCode on the AI tab", () => {
    const fromAnthropic = settingsAfterProviderChange(
      { ...DEFAULT_SETTINGS, aiProvider: "anthropic", aiModel: "sonnet" },
      "opencode_cli",
    );
    expect(fromAnthropic.aiProvider).toBe("opencode_cli");
    expect(fromAnthropic.aiModel).toBe("");

    const keepOllama = settingsAfterProviderChange(
      {
        ...DEFAULT_SETTINGS,
        aiProvider: "opencode_cli",
        aiModel: "ollama/huihui_ai/qwen3.8-abliterated:latest",
      },
      "opencode_cli",
    );
    expect(keepOllama.aiModel).toBe(
      "ollama/huihui_ai/qwen3.8-abliterated:latest",
    );

    const toAnthropic = settingsAfterProviderChange(
      {
        ...DEFAULT_SETTINGS,
        aiProvider: "opencode_cli",
        aiModel: "ollama/qwen2.5-coder",
      },
      "anthropic",
    );
    expect(toAnthropic.aiProvider).toBe("anthropic");
    expect(toAnthropic.aiModel).toBe("haiku");
  });
});
