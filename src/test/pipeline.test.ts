import { describe, it, expect } from "vitest";
import { newCleanerToken, hashToken, tokenHashEquals } from "../../api/_db";
import { sanitizeChecklist, missingRooms } from "../../api/cleaner";

describe("cleaner link tokens", () => {
  it("are long, random and unique", () => {
    const a = newCleanerToken();
    const b = newCleanerToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });
  it("hash is deterministic and never equals the token", () => {
    const t = newCleanerToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
    expect(tokenHashEquals(hashToken(t), hashToken(t))).toBe(true);
    expect(tokenHashEquals(hashToken(t), hashToken("other"))).toBe(false);
  });
});

describe("checklist sanitizing (server never trusts the cleaner payload)", () => {
  it("accepts a well-formed checklist and trims oversized fields", () => {
    const out = sanitizeChecklist({
      rooms: [{ name: "Kitchen", items: [{ label: "Counters", done: true }], skip_reason: "  " }],
      problem_note: "x".repeat(5000),
    });
    expect(out).not.toBeNull();
    expect(out!.rooms[0].items[0].done).toBe(true);
    expect(out!.rooms[0].skip_reason).toBeUndefined(); // blank reason dropped
    expect(out!.problem_note!.length).toBe(1000);
  });
  it("rejects malformed payloads", () => {
    expect(sanitizeChecklist(null)).toBeNull();
    expect(sanitizeChecklist({ rooms: "nope" })).toBeNull();
    expect(sanitizeChecklist({ rooms: [{ name: "K", items: [{ done: true }] }] })).toBeNull();
  });
  it("forces done to a strict boolean", () => {
    const out = sanitizeChecklist({ rooms: [{ name: "K", items: [{ label: "a", done: "yes" }] }] });
    expect(out!.rooms[0].items[0].done).toBe(false);
  });
});

describe("submit gate: every room needs an after-photo or a skip reason", () => {
  const checklist = {
    rooms: [
      { name: "Kitchen", items: [] },
      { name: "Bathroom", items: [], skip_reason: "Not part of this visit" },
      { name: "Bedroom", items: [] },
    ],
  };
  it("blocks rooms with neither photo nor reason", () => {
    expect(missingRooms(checklist, [{ room: "Kitchen", kind: "after" }])).toEqual(["Bedroom"]);
  });
  it("a before-photo alone does not satisfy a room", () => {
    expect(missingRooms(checklist, [{ room: "Kitchen", kind: "before" }])).toEqual(["Kitchen", "Bedroom"]);
  });
  it("passes when all rooms are covered", () => {
    expect(
      missingRooms(checklist, [
        { room: "Kitchen", kind: "after" },
        { room: "Bedroom", kind: "after" },
      ]),
    ).toEqual([]);
  });
});
