/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderBar } from "../components/AiProviderBar";
import { listAiModels } from "../commands";
import type { Action, AppState } from "../store";
import {
  DEFAULT_SETTINGS,
  type AiModelList,
  type AppSettings,
} from "../types";

let currentState: AppState;
const testDispatch = vi.fn((action: Action) => {
  if (action.type === "SET_SETTINGS") {
    currentState = { ...currentState, settings: action.settings };
  }
});

vi.mock("../store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store")>();
  return {
    ...actual,
    useAppState: () => ({ state: currentState, dispatch: testDispatch }),
  };
});
vi.mock("../commands", () => ({ listAiModels: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function settings(provider: AppSettings["aiProvider"]): AppSettings {
  return { ...DEFAULT_SETTINGS, aiProvider: provider, aiModel: "" };
}

let root: Root;
let container: HTMLDivElement;

async function renderBar() {
  await act(async () => root.render(<AiProviderBar />));
}

async function changeProvider(provider: AppSettings["aiProvider"]) {
  const select = container.querySelector<HTMLSelectElement>(
    "[data-testid=assistant-ai-provider]",
  );
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setValue?.call(select, provider);
    select?.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await renderBar();
}

function modelIds(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLOptionElement>(
      "[data-testid=assistant-ai-model-list] option, datalist option",
    ),
  ).map((option) => option.value);
}

beforeEach(async () => {
  currentState = { settings: settings("opencode_cli") } as AppState;
  testDispatch.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("AI model-list request lifetime", () => {
  it("ignores a prior provider's success after the new provider succeeds", async () => {
    const a = deferred<AiModelList>();
    const b = deferred<AiModelList>();
    vi.mocked(listAiModels).mockImplementation((current) =>
      current.aiProvider === "opencode_cli" ? a.promise : b.promise,
    );
    await renderBar();
    await changeProvider("cursor_cli");

    await act(async () => {
      b.resolve({
        models: [{ id: "model-b", label: "Model B", source: "live" }],
        warning: "warning-b",
      });
      await b.promise;
    });
    await act(async () => {
      a.resolve({
        models: [{ id: "model-a", label: "Model A", source: "live" }],
        warning: "stale-warning-a",
      });
      await a.promise;
      await Promise.resolve();
    });

    expect(modelIds()).toContain("model-b");
    expect(modelIds()).not.toContain("model-a");
    expect(container.textContent).toContain("warning-b");
    expect(container.textContent).not.toContain("stale-warning-a");
  });

  it("does not let a prior provider's finally clear the current loading state", async () => {
    const a = deferred<AiModelList>();
    const b = deferred<AiModelList>();
    vi.mocked(listAiModels).mockImplementation((current) =>
      current.aiProvider === "opencode_cli" ? a.promise : b.promise,
    );
    await renderBar();
    await changeProvider("cursor_cli");

    await act(async () => {
      a.resolve({ models: [] });
      await a.promise;
      await Promise.resolve();
    });
    const labelWhileBPending = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("models") || button.textContent?.includes("Listing"))
      ?.textContent;
    await act(async () => {
      b.resolve({ models: [] });
      await b.promise;
    });

    expect(labelWhileBPending).toBe("Listing...");
  });

  it("ignores a rejected list request after switching to a non-listing provider", async () => {
    const a = deferred<AiModelList>();
    vi.mocked(listAiModels).mockReturnValue(a.promise);
    await renderBar();
    await changeProvider("codex_cli");

    await act(async () => {
      a.reject(new Error("stale provider failure"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("stale provider failure");
    expect(container.textContent).toContain("Set a Codex model in Settings");
  });
});
