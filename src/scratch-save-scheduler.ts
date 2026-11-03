import { diskWriteTabChanges } from "./scratch-utils";

export interface ScratchSaveTask {
  path: string;
  content: string;
  encoding: string;
  getLiveContent: () => string | undefined;
  onSaved: (changes: NonNullable<ReturnType<typeof diskWriteTabChanges>>) => void;
  save: (path: string, content: string, encoding: string) => Promise<unknown>;
}

/** Serializes debounced scratch writes and invalidates discarded tabs. */
export class ScratchSaveScheduler {
  private timers = new Map<string, number>();
  private writes = new Map<string, Promise<void>>();
  private generations = new Map<string, number>();

  schedule(tabId: string, task: ScratchSaveTask, delayMs = 1200) {
    const existing = this.timers.get(tabId);
    if (existing) window.clearTimeout(existing);

    const generation = this.generations.get(tabId) ?? 0;
    const timer = window.setTimeout(() => {
      this.timers.delete(tabId);
      this.enqueue(tabId, generation, task);
    }, delayMs);
    this.timers.set(tabId, timer);
  }

  async discard(tabId: string) {
    const timer = this.timers.get(tabId);
    if (timer) window.clearTimeout(timer);
    this.timers.delete(tabId);
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
    await this.writes.get(tabId);
  }

  cancelUnlisted(activeIds: Set<string>) {
    for (const [id, timer] of this.timers) {
      if (activeIds.has(id)) continue;
      window.clearTimeout(timer);
      this.timers.delete(id);
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    }
  }

  private enqueue(tabId: string, generation: number, task: ScratchSaveTask) {
    if ((this.generations.get(tabId) ?? 0) !== generation) return;
    const previous = this.writes.get(tabId);
    const write = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if ((this.generations.get(tabId) ?? 0) !== generation) return;
        try {
          await task.save(task.path, task.content, task.encoding);
        } catch {
          return;
        }
        if ((this.generations.get(tabId) ?? 0) !== generation) return;
        const changes = diskWriteTabChanges(
          task.path,
          task.content,
          task.getLiveContent(),
        );
        if (changes) task.onSaved(changes);
      });
    this.writes.set(tabId, write);
    void write.then(() => {
      if (this.writes.get(tabId) === write) this.writes.delete(tabId);
    });
  }
}
