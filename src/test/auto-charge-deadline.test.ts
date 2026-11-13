// @vitest-environment node
// Extension bug #1: the auto-charge deadline shown to the client
// (\"Review by ...\") and the owner (\"Auto-charge at ...\") was
// report_sent_at + 24h even when the report went out BEFORE the visit
// date — the charge gate opens only at midnight NY on the visit date,
// so the client was told they would be charged days before the visit.
// The displayed deadline is max(visit-date start NY, sent + 24h).
import { describe, it, expect } from "vitest";
import { visitDateStartNYMs, autoChargeDeadlineMs } from "../../api/_visit_date";

const HOUR = 3600 * 1000;

// Format a UTC ms timestamp in America/New_York, for assertions.
function nyParts(ms: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")), minute: Number(get("minute")) };
}

describe("visitDateStartNYMs", () => {
  it("is midnight NY on the visit date (EST, winter)", () => {
    // 2026-11-15 is EST (UTC-5): midnight NY = 05:00 UTC.
    const ms = visitDateStartNYMs("2026-11-15");
    expect(ms).toBe(Date.UTC(2026, 10, 15, 5, 0, 0));
    const p = nyParts(ms);
    expect(p.date).toBe("2026-11-15");
    expect(p.hour).toBe(0);
    expect(p.minute).toBe(0);
  });

  it("is midnight NY on the visit date (EDT, summer)", () => {
    // 2026-07-15 is EDT (UTC-4): midnight NY = 04:00 UTC.
    const ms = visitDateStartNYMs("2026-07-15");
    expect(ms).toBe(Date.UTC(2026, 6, 15, 4, 0, 0));
    const p = nyParts(ms);
    expect(p.date).toBe("2026-07-15");
    expect(p.hour).toBe(0);
    expect(p.minute).toBe(0);
  });

  it("returns NaN for a malformed or absent date", () => {
    expect(visitDateStartNYMs("")).toBeNaN();
    expect(visitDateStartNYMs(null)).toBeNaN();
    expect(visitDateStartNYMs(undefined)).toBeNaN();
    expect(visitDateStartNYMs("15.11.2026")).toBeNaN();
    expect(visitDateStartNYMs("2026-13-40")).toBeNaN();
  });
});

describe("autoChargeDeadlineMs", () => {
  it("report sent before the visit date -> deadline is the visit date, not sent + 24h", () => {
    // \"проверка 12\": report sent 2026-11-12 08:21 ET, visit 2026-11-15.
    // sent + 24h = 2026-11-13 08:21 ET (WRONG, before the visit);
    // the deadline must be the visit date start (2026-11-15 00:00 ET).
    const sentAt = new Date("2026-11-12T13:21:45Z").toISOString(); // 08:21 EST
    const deadline = autoChargeDeadlineMs(sentAt, "2026-11-15");
    expect(deadline).not.toBeNull();
    expect(deadline).toBe(Date.UTC(2026, 10, 15, 5, 0, 0)); // 2026-11-15 00:00 EST
    const p = nyParts(deadline as number);
    expect(p.date).toBe("2026-11-15");
    expect(p.hour).toBe(0);
  });

  it("report sent after the visit date -> deadline is sent + 24h", () => {
    const sentAt = new Date("2026-11-16T13:21:45Z").toISOString(); // 08:21 EST, day after the visit
    const deadline = autoChargeDeadlineMs(sentAt, "2026-11-15");
    expect(deadline).not.toBeNull();
    expect(deadline).toBe(Date.parse(sentAt) + 24 * HOUR);
  });

  it("report sent on the visit date, 24h not yet up -> deadline is sent + 24h", () => {
    const sentAt = new Date("2026-11-15T13:00:00Z").toISOString(); // 08:00 EST on the visit date
    const deadline = autoChargeDeadlineMs(sentAt, "2026-11-15");
    expect(deadline).not.toBeNull();
    expect(deadline).toBe(Date.parse(sentAt) + 24 * HOUR);
  });

  it("absent visit date falls back to sent + 24h (never blocks)", () => {
    const sentAt = new Date("2026-11-12T13:21:45Z").toISOString();
    expect(autoChargeDeadlineMs(sentAt, "")).toBe(Date.parse(sentAt) + 24 * HOUR);
    expect(autoChargeDeadlineMs(sentAt, null)).toBe(Date.parse(sentAt) + 24 * HOUR);
    expect(autoChargeDeadlineMs(sentAt, undefined)).toBe(Date.parse(sentAt) + 24 * HOUR);
  });

  it("absent or unparseable sent time returns null", () => {
    expect(autoChargeDeadlineMs(null, "2026-11-15")).toBeNull();
    expect(autoChargeDeadlineMs("", "2026-11-15")).toBeNull();
    expect(autoChargeDeadlineMs("not-a-date", "2026-11-15")).toBeNull();
  });
});
