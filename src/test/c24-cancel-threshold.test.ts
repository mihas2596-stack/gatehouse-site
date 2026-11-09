// @vitest-environment node
// C24 (audit 09.11.2026): the 48h late-cancellation threshold runs to the
// START of the arrival window, not to midday on the visit day. Terms §6
// gives free cancellation "up to 48 hours before your visit" — the visit
// starts when the window opens (morning 7 AM, midday 11 AM, afternoon
// 2 PM Atlanta time). A client cancelling on the morning two days before
// a morning visit is already inside 48h of the visit, even though midday
// that day is still more than 48h away.
import { describe, it, expect } from "vitest";
import { visitMomentMs, cancelFeeCents, visitWindowStartHour } from "../../api/visit";

// Winter (EST, UTC-5): 2027-01-15 7 AM ET = 12:00Z, 11 AM ET = 16:00Z,
// 2 PM ET = 19:00Z, midday = 17:00Z.
const VISIT = "2027-01-15";
const ready = (date: string, window = "") => ({
  gh_state: "card_ready",
  gh_confirmed_date: date,
  ...(window ? { gh_confirmed_window: window } : {}),
});

describe("C24: visitMomentMs uses the arrival-window start", () => {
  it("morning window starts at 7 AM Atlanta time", () => {
    expect(visitMomentMs({}, VISIT, "morning")).toBe(Date.parse("2027-01-15T12:00:00Z"));
    // Summer (EDT, UTC-4): 7 AM ET = 11:00Z.
    expect(visitMomentMs({}, "2026-07-15", "morning")).toBe(Date.parse("2026-07-15T11:00:00Z"));
  });

  it("midday and afternoon windows start at 11 AM and 2 PM", () => {
    expect(visitMomentMs({}, VISIT, "midday")).toBe(Date.parse("2027-01-15T16:00:00Z"));
    expect(visitMomentMs({}, VISIT, "afternoon")).toBe(Date.parse("2027-01-15T19:00:00Z"));
  });

  it("the confirmed window in metadata is used when no override is passed", () => {
    expect(visitMomentMs({ gh_confirmed_date: VISIT, gh_confirmed_window: "morning" }, "2026-07-15"))
      .toBe(Date.parse("2027-01-15T12:00:00Z"));
  });

  it("an unknown or flexible window keeps the old midday reading", () => {
    expect(visitMomentMs({}, VISIT)).toBe(Date.parse("2027-01-15T17:00:00Z"));
    expect(visitMomentMs({}, VISIT, "flexible")).toBe(Date.parse("2027-01-15T17:00:00Z"));
    expect(visitWindowStartHour("flexible")).toBe(12);
    expect(visitWindowStartHour(undefined)).toBe(12);
  });
});

describe("C24: cancelFeeCents and the 48h threshold", () => {
  it("morning two days before a morning visit: $25 (was free at midday)", () => {
    // 2027-01-13 7:30 AM ET — the morning two days before the visit.
    // 47.5h before the 7 AM window start, 52.5h before midday.
    const now = Date.parse("2027-01-13T12:30:00Z");
    expect(cancelFeeCents(ready(VISIT, "morning"), "", now)).toBe(2500);
    expect(cancelFeeCents({ gh_state: "card_ready" }, VISIT, now, "morning")).toBe(2500);
  });

  it("exactly 48h before the window start is still free", () => {
    const now = Date.parse("2027-01-13T12:00:00Z");
    expect(cancelFeeCents(ready(VISIT, "morning"), "", now)).toBe(0);
  });

  it("one minute inside 48h before the window start costs $25", () => {
    const now = Date.parse("2027-01-13T12:01:00Z");
    expect(cancelFeeCents(ready(VISIT, "morning"), "", now)).toBe(2500);
  });

  it("midday and afternoon visits use their own window starts", () => {
    // 47.5h before the 11 AM / 2 PM starts, but 52.5h before midday.
    expect(cancelFeeCents(ready(VISIT, "midday"), "", Date.parse("2027-01-13T16:30:00Z"))).toBe(2500);
    expect(cancelFeeCents(ready(VISIT, "afternoon"), "", Date.parse("2027-01-13T19:30:00Z"))).toBe(2500);
    // Exactly 48h before the 11 AM start is free.
    expect(cancelFeeCents(ready(VISIT, "midday"), "", Date.parse("2027-01-13T16:00:00Z"))).toBe(0);
  });

  it("a flexible window still uses midday (no window start to measure from)", () => {
    // 52.5h before midday on the visit day: free, as before.
    expect(cancelFeeCents(ready(VISIT, "flexible"), "", Date.parse("2027-01-13T12:30:00Z"))).toBe(0);
  });
});
