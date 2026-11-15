export type AutosaveState = "idle" | "saving" | "saved" | "failed" | "stale";
// A write may return "stale" when the server refuses it with a
// revision conflict (409 checklist_stale): the value on the server is
// newer, so re-sending the same value can never succeed — the UI must
// offer a reload, not a retry loop (MB-32).
export type AutosaveWriteResult = boolean | "stale";

/** One writer per open editor. Older writes can never land after newer ones. */
export function createAutosaveQueue<T>(
  write: (value: T) => Promise<AutosaveWriteResult>,
  onState: (state: AutosaveState) => void,
  delay = 600,
) {
  let revision = 0;
  let savedRevision = 0;
  let latest: T;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<boolean> | null = null;
  const notify = (state: AutosaveState) => { if (active) onState(state); };
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const dirty = () => revision > savedRevision;

  async function drain(): Promise<boolean> {
    while (active && dirty()) {
      const writingRevision = revision;
      const value = latest;
      notify("saving");
      try {
        const result = await write(value);
        if (result === "stale") {
          // A stale write is terminal for this value: the server holds
          // a newer checklist, so retrying the same value loops
          // forever. Report it distinctly and stop draining.
          notify("stale");
          return false;
        }
        if (!result) {
          notify("failed");
          return false;
        }
      } catch {
        notify("failed");
        return false;
      }
      savedRevision = writingRevision;
    }
    if (!active) return false;
    notify("saved");
    return true;
  }

  async function flush(): Promise<boolean> {
    clearTimer();
    if (!active) return false;
    if (running) {
      if (!await running) return false;
      return dirty() ? flush() : true;
    }
    if (!dirty()) return true;
    running = drain().finally(() => { running = null; });
    return running;
  }

  return {
    schedule(value: T) {
      if (!active) return;
      latest = value;
      revision++;
      // Debounced changes are already unsaved; never keep showing "saved".
      notify("saving");
      clearTimer();
      timer = setTimeout(() => { timer = null; void flush(); }, delay);
    },
    flush,
    isDirty: dirty,
    revision: () => revision,
    activate() { active = true; },
    dispose() { active = false; clearTimer(); },
  };
}
