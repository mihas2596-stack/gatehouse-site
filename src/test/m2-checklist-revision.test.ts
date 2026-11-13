// @vitest-environment node
// M2: checklist autosave is optimistic-concurrency guarded by the
// row's updated_at, exposed as checklist_revision. A save that
// carries a stale revision gets 409 checklist_stale; a save with no
// revision (old clients) still works; two saves that both loaded the
// same revision cannot both win.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installEnv, scopeChecklist } from "./m-cleaner-harness";
import { checklistRevisionStale } from "../../api/cleaner";

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("M2 checklistRevisionStale (pure)", () => {
  it("same instant is fresh, a different instant is stale", () => {
    expect(checklistRevisionStale("2026-11-13T10:00:00.000Z", "2026-11-13T10:00:00.000Z")).toBe(false);
    expect(checklistRevisionStale("2026-11-13T10:00:01.000Z", "2026-11-13T10:00:00.000Z")).toBe(true);
  });

  it("fails open with no revision or an unparseable value", () => {
    expect(checklistRevisionStale("2026-11-13T10:00:00.000Z", undefined)).toBe(false);
    expect(checklistRevisionStale("2026-11-13T10:00:00.000Z", "")).toBe(false);
    expect(checklistRevisionStale("2026-11-13T10:00:00.000Z", "not-a-date")).toBe(false);
    expect(checklistRevisionStale(undefined, "2026-11-13T10:00:00.000Z")).toBe(false);
  });
});

describe("M2 checklist save (handler)", () => {
  it("GET exposes the revision the next save must echo", async () => {
    const env = installEnv();
    const r = await env.get();
    expect(r.code).toBe(200);
    expect(r.body["checklist_revision"]).toBe("2026-11-13T10:00:00.000Z");
  });

  it("a save with the current revision succeeds and returns a new revision", async () => {
    const env = installEnv();
    const r = await env.call({
      action: "checklist",
      checklist: scopeChecklist(),
      checklist_revision: "2026-11-13T10:00:00.000Z",
    });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(typeof r.body["checklist_revision"]).toBe("string");
    expect(r.body["checklist_revision"]).not.toBe("2026-11-13T10:00:00.000Z");
  });

  it("a save with a stale revision gets 409 checklist_stale", async () => {
    const env = installEnv();
    // Another writer moved the row first.
    await env.call({ action: "checklist", checklist: scopeChecklist() });
    const stale = "2026-11-13T10:00:00.000Z";
    const r = await env.call({ action: "checklist", checklist: scopeChecklist(), checklist_revision: stale });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("checklist_stale");
    expect(typeof r.body["checklist_revision"]).toBe("string");
  });

  it("two saves with the same revision: the first wins, the second gets 409", async () => {
    const env = installEnv();
    const rev = "2026-11-13T10:00:00.000Z";
    const first = await env.call({ action: "checklist", checklist: scopeChecklist(), checklist_revision: rev });
    expect(first.code).toBe(200);
    const second = await env.call({ action: "checklist", checklist: scopeChecklist(), checklist_revision: rev });
    expect(second.code).toBe(409);
    expect(second.body["error"]).toBe("checklist_stale");
  });

  it("a save with no revision still works (old clients)", async () => {
    const env = installEnv();
    const r = await env.call({ action: "checklist", checklist: scopeChecklist() });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
  });

  it("a submit with a stale revision gets 409 instead of publishing", async () => {
    const env = installEnv();
    await env.call({ action: "checklist", checklist: scopeChecklist() });
    const r = await env.call({
      action: "submit",
      checklist: scopeChecklist(),
      checklist_revision: "2026-11-13T10:00:00.000Z",
    });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("checklist_stale");
  });
});
