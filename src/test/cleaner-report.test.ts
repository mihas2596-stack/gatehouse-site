// @vitest-environment node
// Cleaner report rules: a room is complete only with an AFTER photo or a
// documented exception (skip reason). A before photo alone never completes
// a room, and the checklist the cleaner sends is sanitized server-side.
import { describe, it, expect } from "vitest";
import { missingRooms, sanitizeChecklist } from "../../api/cleaner";

const checklist = {
  rooms: [
    { name: "Kitchen", items: [{ label: "Counters wiped", done: true }] },
    { name: "Bathrooms", items: [{ label: "Mirror cleaned", done: false }] },
    { name: "Bedrooms", items: [{ label: "Bed made", done: true }], skip_reason: "Client declined photos" },
  ],
};

describe("missingRooms", () => {
  it("requires an after photo — a before photo alone does not complete a room", () => {
    const missing = missingRooms(checklist, [
      { room: "Kitchen", kind: "before" },
      { room: "Bathrooms", kind: "after" },
    ]);
    expect(missing).toEqual(["Kitchen"]);
  });

  it("accepts a documented exception instead of a photo", () => {
    const missing = missingRooms(checklist, [
      { room: "Kitchen", kind: "after" },
      { room: "Bathrooms", kind: "after" },
    ]);
    expect(missing).toEqual([]);
  });

  it("blocks every room with neither photo nor reason", () => {
    expect(missingRooms(checklist, [])).toEqual(["Kitchen", "Bathrooms"]);
  });
});

describe("sanitizeChecklist", () => {
  it("keeps skip reasons and the problem note, trims oversized fields", () => {
    const out = sanitizeChecklist({
      rooms: [{ name: "Kitchen", items: [{ label: "x".repeat(200), done: true }], skip_reason: "  Locked  " }],
      problem_note: "Found damage",
    });
    expect(out).not.toBeNull();
    expect(out!.rooms[0].items[0].label.length).toBe(120);
    expect(out!.rooms[0].skip_reason).toBe("  Locked  "); // stored as typed; only emptiness is checked trimmed
    expect(out!.problem_note).toBe("Found damage");
  });

  it("rejects malformed payloads", () => {
    expect(sanitizeChecklist(null)).toBeNull();
    expect(sanitizeChecklist({ rooms: [] })).toBeNull();
    expect(sanitizeChecklist({ rooms: [{ name: "Kitchen", items: "nope" }] })).toBeNull();
  });
});
