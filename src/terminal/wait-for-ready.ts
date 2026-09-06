import type { TerminalSessionHandle } from "../components/TerminalSession";

export async function waitForTerminalReady(
  getHandle: () => TerminalSessionHandle | null,
): Promise<TerminalSessionHandle> {
  const deadline = Date.now() + 30_000;
  let restarted = false;
  while (Date.now() < deadline) {
    const handle = getHandle();
    if (handle?.isReady()) return handle;
    if (handle && !handle.isStarting() && !restarted) {
      handle.restart();
      restarted = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Integrated terminal did not become ready.");
}
