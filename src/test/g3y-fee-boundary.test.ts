// @vitest-environment node
// G3y round: the $25 late-cancellation fee boundary and the fail-open
// dates underneath it.
//
// - G3: the 48h boundary is exactly 48h before the arrival-window
//   START (free at exactly 48h, $25 inside), with no +/-5h drift
//   from timezone/window handling — including across the spring
//   DST jump, where a fixed EST offset would shift the threshold.
// - G4 L9: an unparseable visit date must never yield a free
//   cancellation (fail closed -> fee-due).
// - G3: isFutureVisitDate must not read an impossible calendar date
//   ("2026-13-40") as future.
import { describe, it, expect } from "vitest";
import { visitMomentMs, cancelFeeCents } from "../../api/visit";
import { isFutureVisitDate } from "../../api/_visit_date";

// Winter (EST, UTC-5): 2027-01-15 7 AM ET = 12:00Z, 2 PM ET = 19:00Z.
const VISIT = "2027-01-15";
const ready = (date: string, window = "morning") => ({
  gh_state: "card_ready",
  gh_confirmed_date: date,
  gh_confirmed_window: window,
});

describe("G3: 48h fee boundary is exact at the window start", () => {
  it("exactly 48h before the window start is free; one minute inside costs $25", () => {
    expect(cancelFeeCents(ready(VISIT, "morning"), "", Date.parse("2027-01-13T12:00:00Z"))).toBe(0);
    expect(cancelFeeCents(ready(VISIT, "morning"), "", Date.parse("2027-01-13T12:01:00Z"))).toBe(2500);
    expect(cancelFeeCents(ready(VISIT, "afternoon"), "", Date.parse("2027-01-13T19:00:00Z"))).toBe(0);
    expect(cancelFeeCents(ready(VISIT, "afternoon"), "", Date.parse("2027-01-13T19:01:00Z"))).toBe(2500);
  });

  it("no +/-5h drift across the spring DST jump (visit 2026-03-08, morning)", () => {
    // 2026-03-08 is the spring-forward day: 7 AM is EDT (UTC-4),
    // i.e. 11:00Z — a fixed -05:00 offset would read 12:00Z and move
    // the 48h threshold by an hour.
    expect(visitMomentMs({}, "2026-03-08", "morning")).toBe(Date.parse("2026-03-08T11:00:00Z"));
    expect(cancelFeeCents(ready("2026-03-08", "morning"), "", Date.parse("2026-03-06T11:00:00Z"))).toBe(0);
    expect(cancelFeeCents(ready("2026-03-08", "morning"), "", Date.parse("2026-03-06T11:01:00Z"))).toBe(2500);
  });

  it("no +/-5h drift across the autumn DST jump (visit 2026-11-01, morning)", () => {
    // 2026-11-01 is the fall-back day: 7 AM is EST (UTC-5) again,
    // i.e. 12:00Z.
    expect(visitMomentMs({}, "2026-11-01", "morning")).toBe(Date.parse("2026-11-01T12:00:00Z"));
    expect(cancelFeeCents(ready("2026-11-01", "morning"), "", Date.parse("2026-10-30T12:00:00Z"))).toBe(0);
    expect(cancelFeeCents(ready("2026-11-01", "morning"), "", Date.parse("2026-10-30T12:01:00Z"))).toBe(2500);
  });
});

describe("G4 L9: cancelFeeCents fails closed on a bad date", () => {
  it("an impossible calendar date is fee-due, never free", () => {
    const now = Date.parse("2027-01-13T12:00:00Z");
    expect(visitMomentMs({}, "2026-13-40")).toBeNaN();
    expect(visitMomentMs({}, "2026-02-30")).toBeNaN();
    expect(cancelFeeCents({ gh_state: "card_ready", gh_confirmed_date: "2026-13-40" }, "", now)).toBe(2500);
    expect(cancelFeeCents({ gh_state: "card_ready", gh_confirmed_date: "2026-02-30" }, "", now)).toBe(2500);
    expect(cancelFeeCents({ gh_state: "card_ready" }, "2026-13-40", now)).toBe(2500);
  });

  it("a missing date is fee-due, never free", () => {
    expect(cancelFeeCents({ gh_state: "card_ready" }, "", Date.now())).toBe(2500);
    expect(cancelFeeCents({ gh_state: "card_ready" }, "not-a-date", Date.now())).toBe(2500);
  });

  it("terminal states still cancel free even with a bad date", () => {
    const now = Date.now();
    expect(cancelFeeCents({ gh_state: "cancelled", gh_confirmed_date: "2026-13-40" }, "", now)).toBe(0);
    expect(cancelFeeCents({ gh_state: "paid", gh_confirmed_date: "2026-13-40" }, "", now)).toBe(0);
  });

  it("a genuinely past date is still free (B6, unchanged)", () => {
    expect(cancelFeeCents({ gh_state: "card_ready" }, "2020-01-15", Date.now())).toBe(0);
  });
});

describe("G3: isFutureVisitDate fails closed on a bad date", () => {
  it("an impossible calendar date is never 'future', even though it sorts after today", () => {
    // "2026-13-40" > any real 2026 date as a string — the old
    // regex-only check read it as future.
    expect(isFutureVisitDate("2026-13-40")).toBe(false);
    expect(isFutureVisitDate("2026-02-30")).toBe(false);
    expect(isFutureVisitDate("2026-13-40", Date.parse("2026-01-01T00:00:00Z"))).toBe(false);
  });

  it("valid dates still read correctly", () => {
    expect(isFutureVisitDate("2999-01-15")).toBe(true);
    expect(isFutureVisitDate("2020-01-15")).toBe(false);
    expect(isFutureVisitDate("")).toBe(false);
    expect(isFutureVisitDate(null)).toBe(false);
    expect(isFutureVisitDate(undefined)).toBe(false);
    expect(isFutureVisitDate("15.11.2026")).toBe(false);
  });
});
