// @vitest-environment node
import { describe, it, expect } from "vitest";

// Auto-charge timing bound (ChatGPT task 2): the client is promised
// "24 hours", but the charge is driven by a cron that runs twice a day
// (vercel.json: 0 10 and 0 22 UTC = 13:00 and 01:00 Minsk) plus the
// reminder-before-charge guard (api/auto-charge.ts: a report is never
// charged in the run that first sent its 20h reminder, nor one that
// was never reminded). This test models exactly that schedule + guard
// and bounds the worst-case delay from report-sent to charge.
//
// The model:
//   - cron runs at 10:00 and 22:00 UTC daily (12h apart);
//   - the 20h reminder goes out at the first run >= sent + 20h;
//   - the charge runs at the first run >= sent + 24h that is NOT the
//     reminder run (same-run reminder defers the charge one full cycle).
//
// Worst case (verified by scan below): the 24h mark falls just under
// 8h before a cron run, so the 20h reminder lands in that same run and
// the charge waits for the next run 12h later — just under 20h after
// the 24h mark, i.e. just under 44h after the report was sent.
// ChatGPT's "almost 44 hours" is CORRECT. Without the same-run guard
// the bound would be 36h (24h + one 12h cron wait).

const HOUR = 3600 * 1000;

function nextCronRun(tMs: number): number {
  const d = new Date(tMs);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const run1 = dayStart + 10 * HOUR;
  const run2 = dayStart + 22 * HOUR;
  if (tMs <= run1) return run1;
  if (tMs <= run2) return run2;
  return dayStart + 24 * HOUR + 10 * HOUR;
}

function chargeTime(sentMs: number, withGuard: boolean): number {
  const remindRun = nextCronRun(sentMs + 20 * HOUR);
  let chargeRun = nextCronRun(sentMs + 24 * HOUR);
  if (withGuard && chargeRun === remindRun) chargeRun = nextCronRun(chargeRun + 1);
  return chargeRun;
}

function worstCase(withGuard: boolean): { maxTotalH: number; maxAfter24H: number; worstSent: Date } {
  let maxTotal = 0;
  let maxAfter24 = 0;
  let worstSent = 0;
  const start = Date.UTC(2026, 10, 12, 0, 0, 0);
  for (let m = 0; m < 24 * 60; m += 5) {
    const sent = start + m * 60 * 1000;
    const charged = chargeTime(sent, withGuard);
    const total = charged - sent;
    const after24 = charged - (sent + 24 * HOUR);
    if (total > maxTotal) {
      maxTotal = total;
      maxAfter24 = after24;
      worstSent = sent;
    }
  }
  return { maxTotalH: maxTotal / HOUR, maxAfter24H: maxAfter24 / HOUR, worstSent: new Date(worstSent) };
}

describe("auto-charge timing bound", () => {
  it("the worst case from report-sent to charge is just under 44h (ChatGPT's claim is correct)", () => {
    const w = worstCase(true);
    expect(w.maxTotalH).toBeLessThan(44);
    expect(w.maxTotalH).toBeGreaterThan(43.5);
    // The extra wait after the 24h mark is just under 20h, not 12h.
    expect(w.maxAfter24H).toBeLessThan(20);
    expect(w.maxAfter24H).toBeGreaterThan(19);
  });

  it("without the same-run reminder guard the bound would be 36h — the guard adds up to ~8h", () => {
    const guarded = worstCase(true);
    const unguarded = worstCase(false);
    expect(unguarded.maxTotalH).toBeLessThanOrEqual(36);
    expect(unguarded.maxTotalH).toBeGreaterThan(35.5);
    expect(guarded.maxTotalH - unguarded.maxTotalH).toBeGreaterThan(7);
    expect(guarded.maxTotalH - unguarded.maxTotalH).toBeLessThan(8.5);
  });

  it("concrete worst case: report sent 05:01 Minsk charges 01:00 two days later (~44h)", () => {
    // 05:01 Minsk = 02:01 UTC. The 20h reminder and the 24h mark both
    // fall in the same cron interval, so the 13:00 Minsk run reminds
    // but cannot charge; the charge waits for 01:00 Minsk two days on.
    const sent = Date.UTC(2026, 10, 12, 2, 1, 0);
    const charged = chargeTime(sent, true);
    const totalH = (charged - sent) / HOUR;
    expect(totalH).toBeGreaterThan(43.9);
    expect(totalH).toBeLessThan(44);
    expect(new Date(charged).toISOString()).toBe("2026-11-13T22:00:00.000Z"); // 01:00 Minsk 14.11
  });
});
