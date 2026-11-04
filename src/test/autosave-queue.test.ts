// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutosaveQueue } from "@/lib/autosaveQueue";

afterEach(() => vi.useRealTimers());

describe("cleaner checklist autosave", () => {
  it("serializes delayed writes, coalesces edits and only marks the latest revision saved", async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const pending: Array<{ value: number; resolve: (ok: boolean) => void }> = [];
    let persisted = 0;
    const write = vi.fn((value: number) => new Promise<boolean>((resolve) => {
      pending.push({ value, resolve: (ok) => { if (ok) persisted = value; resolve(ok); } });
    }));
    const saver = createAutosaveQueue(write, (state) => states.push(state));
    saver.schedule(1);
    expect(states.at(-1)).toBe("saving");
    vi.advanceTimersByTime(600);
    saver.schedule(2);
    saver.schedule(3);
    vi.advanceTimersByTime(600);
    expect(write).toHaveBeenCalledTimes(1);
    const flushed = saver.flush();
    pending[0].resolve(true);
    await Promise.resolve();
    expect(pending.map((p) => p.value)).toEqual([1, 3]);
    expect(states.at(-1)).toBe("saving");
    pending[1].resolve(true);
    expect(await flushed).toBe(true);
    expect(persisted).toBe(3);
    expect(saver.isDirty()).toBe(false);
    expect(states.at(-1)).toBe("saved");
  });

  it("Finish flushes the debounce immediately and waits for the save", async () => {
    vi.useFakeTimers();
    let finish!: (ok: boolean) => void;
    const write = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const saver = createAutosaveQueue(write, vi.fn());
    saver.schedule({ done: true });
    let finished = false;
    const flush = saver.flush().then((ok) => { finished = true; return ok; });
    expect(write).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    finish(true);
    expect(await flush).toBe(true);
    vi.advanceTimersByTime(600);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps failed edits dirty and retries the latest value", async () => {
    const states: string[] = [];
    const write = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const saver = createAutosaveQueue<number>(write, (state) => states.push(state));
    saver.schedule(7);
    expect(await saver.flush()).toBe(false);
    expect(saver.isDirty()).toBe(true);
    expect(states.at(-1)).toBe("failed");
    expect(await saver.flush()).toBe(true);
    expect(saver.isDirty()).toBe(false);
    expect(write.mock.calls.map((args) => args[0])).toEqual([7, 7]);
  });

  it("does not save a pending timer or update UI after the editor is disposed", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(true);
    const state = vi.fn();
    const saver = createAutosaveQueue<number>(write, state);
    saver.schedule(1);
    saver.dispose();
    vi.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled();
    expect(await saver.flush()).toBe(false);
    expect(state).toHaveBeenCalledTimes(1);
  });
});
