export type AutosaveState = "idle" | "saving" | "saved" | "failed";

/** One writer per open editor. Older writes can never land after newer ones. */
export function createAutosaveQueue<T>(
  write: (value: T) => Promise<boolean>,
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
        if (!await write(value)) {
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
