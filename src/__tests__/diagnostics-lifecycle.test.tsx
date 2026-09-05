/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorDiagnostics } from "../use-editor-diagnostics";
import { analyzeScript } from "../commands";
import type { EditorTab, PssaDiagnostic } from "../types";

vi.mock("../commands", () => ({ analyzeScript: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;
const tab: EditorTab = {
  id: "script", title: "test.ps1", filePath: "/test.ps1", content: "bad script",
  savedContent: "", encoding: "utf8", language: "powershell", isDirty: true, tabType: "code",
};
const dispatch = vi.fn();
function Harness({ enabled = true, psPath = "pwsh" }) {
  useEditorDiagnostics({ enabled, selectedPsPath: psPath, activeTab: tab, dispatch });
  return null;
}
let root: Root;
let container: HTMLDivElement;
let finish: (diagnostics: PssaDiagnostic[]) => void;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(analyzeScript).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await act(async () => vi.runOnlyPendingTimers());
  expect(analyzeScript).toHaveBeenCalledOnce();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});
describe("diagnostics lifecycle", () => {
  it("applies a response while the original analysis is still active", async () => {
    await act(async () => finish([]));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "SET_PROBLEMS", tabId: tab.id, diagnostics: [],
    });
  });

  it.each(["disabled", "host removed", "unmounted"])("ignores an in-flight response after %s", async (change) => {
    await act(async () => {
      root.render(change === "unmounted" ? null : <Harness enabled={change !== "disabled"} psPath={change === "host removed" ? "" : "pwsh"} />);
    });
    await act(async () => finish([]));
    expect(dispatch).not.toHaveBeenCalled();
  });
});
