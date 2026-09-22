/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloseScratchDialog } from "../components/CloseScratchDialog";
import { PssaRunGateDialog } from "../components/PssaRunGateDialog";
import { ScratchRecoveryDialog } from "../components/ScratchRecoveryDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../commands", () => ({
  readFileContent: vi.fn(async () => ({ content: "'x'", encoding: "utf8", path: "" })),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

describe("modal dialogs dismiss on Escape", () => {
  it("scratch recovery", async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(
        <ScratchRecoveryDialog
          candidates={[{ tabId: "tab-1", path: "tab-1.ps1" }]}
          onRecover={vi.fn()}
          onDismiss={onDismiss}
        />,
      );
    });
    await pressEscape();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("close untitled script", async () => {
    const onChoice = vi.fn();
    await act(async () => {
      root.render(<CloseScratchDialog tabTitle="Untitled-1" onChoice={onChoice} />);
    });
    await pressEscape();
    expect(onChoice).toHaveBeenCalledWith("cancel");
  });

  it("analyzer run gate", async () => {
    const onCancel = vi.fn();
    const onRunAnyway = vi.fn();
    await act(async () => {
      root.render(
        <PssaRunGateDialog
          errors={[]}
          onRunAnyway={onRunAnyway}
          onCancel={onCancel}
          onViewProblems={vi.fn()}
        />,
      );
    });
    await pressEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onRunAnyway).not.toHaveBeenCalled();
  });
});
