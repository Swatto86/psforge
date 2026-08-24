import { describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  isAiProviderId,
  modelHintFor,
  settingsAfterProviderChange,
} from "../ai-providers";
import { DEFAULT_SETTINGS } from "../types";

describe("AI providers", () => {
  it("exposes only Codex, Cursor, and OpenCode CLIs", () => {
    const ids = AI_PROVIDERS.map((provider) => provider.id);
    expect(ids).toEqual(["codex_cli", "cursor_cli", "opencode_cli"]);
    expect(isAiProviderId("opencode_cli")).toBe(true);
    expect(isAiProviderId("anthropic")).toBe(false);
    expect(modelHintFor("opencode_cli")).toContain("opencode/");
    expect(modelHintFor("opencode_cli")).toContain("opencode-go/");
  });

  it("keeps Zen, Go, and Ollama model ids on OpenCode", () => {
    const fromCursor = settingsAfterProviderChange(
      { ...DEFAULT_SETTINGS, aiProvider: "cursor_cli", aiModel: "auto" },
      "opencode_cli",
    );
    expect(fromCursor.aiProvider).toBe("opencode_cli");
    expect(fromCursor.aiModel).toBe("");

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

    const zen = settingsAfterProviderChange(
      {
        ...DEFAULT_SETTINGS,
        aiProvider: "cursor_cli",
        aiModel: "opencode/big-pickle",
      },
      "opencode_cli",
    );
    expect(zen.aiModel).toBe("opencode/big-pickle");

    const go = settingsAfterProviderChange(
      {
        ...DEFAULT_SETTINGS,
        aiProvider: "cursor_cli",
        aiModel: "opencode-go/kimi-k3",
      },
      "opencode_cli",
    );
    expect(go.aiModel).toBe("opencode-go/kimi-k3");

    const toCodex = settingsAfterProviderChange(
      {
        ...DEFAULT_SETTINGS,
        aiProvider: "opencode_cli",
        aiModel: "ollama/qwen2.5-coder",
      },
      "codex_cli",
    );
    expect(toCodex.aiProvider).toBe("codex_cli");
    expect(toCodex.aiModel).toBe("gpt-5.3-codex");
  });
});
