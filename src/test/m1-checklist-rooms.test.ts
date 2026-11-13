// @vitest-environment node
// M1: the server validates checklist room names against the visit's
// stored work-scope rooms on save AND on submit. A cleaner cannot
// fake a checklist (one room with a skip reason) and submit an empty
// report — the room-name set must match the booking scope exactly.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installEnv, scopeChecklist, SCOPE_ROOMS, makePhotos } from "./m-cleaner-harness";
import { checklistRoomMismatch } from "../../api/cleaner";

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("M1 checklistRoomMismatch (pure)", () => {
  it("accepts the exact scope set in any order, with changed items", () => {
    const incoming = scopeChecklist();
    incoming.rooms.reverse();
    incoming.rooms[0].items = [{ label: "Different label", done: true }];
    expect(checklistRoomMismatch(scopeChecklist(), incoming)).toEqual({ missing: [], unknown: [] });
  });

  it("rejects a one-room fake with a skip reason", () => {
    const fake = { rooms: [{ name: "Kitchen", items: [{ label: "x", done: false }], skip_reason: "Client declined" }] };
    const m = checklistRoomMismatch(scopeChecklist(), fake);
    expect(m.missing).toEqual(["Bathroom", "Bedroom", "Living room"]);
    expect(m.unknown).toEqual([]);
  });

  it("rejects invented rooms and reports them by name", () => {
    const incoming = scopeChecklist();
    incoming.rooms.push({ name: "Attic", items: [{ label: "x", done: false }] });
    expect(checklistRoomMismatch(scopeChecklist(), incoming).unknown).toEqual(["Attic"]);
  });

  it("fails open when the stored scope is empty (legacy row)", () => {
    expect(checklistRoomMismatch({ rooms: [] }, scopeChecklist())).toEqual({ missing: [], unknown: [] });
    expect(checklistRoomMismatch(null, scopeChecklist())).toEqual({ missing: [], unknown: [] });
  });
});

describe("M1 checklist save + submit (handler)", () => {
  it("rejects a one-room fake checklist on save", async () => {
    const env = installEnv();
    const fake = { rooms: [{ name: "Kitchen", items: [{ label: "x", done: false }], skip_reason: "No photos, trust me" }] };
    const r = await env.call({ action: "checklist", checklist: fake });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("checklist_rooms_mismatch");
    expect(r.body["missing"]).toEqual(["Bathroom", "Bedroom", "Living room"]);
    // The stored scope is untouched by the rejected save.
    expect((env.rows[0]["checklist"] as { rooms: Array<{ name: string }> }).rooms.map((x) => x.name)).toEqual(SCOPE_ROOMS);
  });

  it("rejects an invented room on save", async () => {
    const env = installEnv();
    const incoming = scopeChecklist();
    incoming.rooms.push({ name: "Attic", items: [{ label: "x", done: false }] });
    const r = await env.call({ action: "checklist", checklist: incoming });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("checklist_rooms_mismatch");
    expect(r.body["unknown"]).toEqual(["Attic"]);
  });

  it("accepts a save with the exact scope set", async () => {
    const env = installEnv();
    const incoming = scopeChecklist();
    incoming.rooms[0].items[0].done = true;
    const r = await env.call({ action: "checklist", checklist: incoming });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
  });

  it("rejects a fake checklist on submit, before any photo check", async () => {
    const env = installEnv({ photos: makePhotos() });
    const fake = { rooms: [{ name: "Kitchen", items: [{ label: "x", done: false }], skip_reason: "No photos, trust me" }] };
    const r = await env.call({ action: "submit", checklist: fake });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("checklist_rooms_mismatch");
  });

  it("a submit with the exact scope passes the room check (reaches photo/publish flow)", async () => {
    const env = installEnv({ photos: makePhotos() });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    // Full submit publishes (200 published:true) — the room check did
    // not block it; anything else would be a photo/publish failure.
    expect(r.code).toBe(200);
    expect(r.body["published"]).toBe(true);
  });
});
