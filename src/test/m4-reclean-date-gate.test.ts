// @vitest-environment node
// M4: the report-submit date gate uses the RE-CLEAN date when one is
// arranged — including a re-clean that lives only in the journal
// (issue_decision / issue_resolved events), for rows arranged before
// the reclean_* migration. A report must not be submittable before
// the re-clean date, even though the original visit date is long
// past. DA-01: the arrange path logs the date on the issue_decision
// event and writes no issue_resolved — the gate must read it there.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installEnv, scopeChecklist, makePhotos } from "./m-cleaner-harness";

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// A future re-clean date: 2099-01-15 is safely in the future whatever
// "today" the test runs on; a past one is 2026-11-10.
const FUTURE_RECLEAN = "2099-01-15";
const PAST_RECLEAN = "2026-11-10";

function journalRecleanEvents(recleanDate: string, decision = "reclean") {
  return [
    { visit_id: "33333333-4444-5555-6666-777777777777", event: "visit_confirmed", detail: { date: "2026-11-10", window: "midday" }, created_at: "2026-11-10T10:00:00.000Z" },
    { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_opened", actor: "client", detail: { reason: "Streaks" }, created_at: "2026-11-11T10:00:00.000Z" },
    { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_decision", actor: "owner", detail: { decision, resolution: "Re-clean it." }, created_at: "2026-11-11T12:00:00.000Z" },
    { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_resolved", actor: "owner", detail: { reclean_date: recleanDate }, created_at: "2026-11-11T12:00:01.000Z" },
  ];
}

// DA-01: the real arrange path — the date lives ONLY on the
// issue_decision event, no issue_resolved is written at all.
function journalDecisionOnly(recleanDate: string) {
  return [
    { visit_id: "33333333-4444-5555-6666-777777777777", event: "visit_confirmed", detail: { date: "2026-11-10", window: "midday" }, created_at: "2026-11-10T10:00:00.000Z" },
    { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_opened", actor: "client", detail: { reason: "Streaks" }, created_at: "2026-11-11T10:00:00.000Z" },
    { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_decision", actor: "owner", detail: { decision: "reclean", resolution: "Re-clean it.", reclean_date: recleanDate }, created_at: "2026-11-11T12:00:00.000Z" },
  ];
}

// DA-01: both events exist with different dates — the newer
// agreement wins, whichever event carries it.
function journalBothDates(decisionDate: string, decisionAt: string, resolvedDate: string, resolvedAt: string) {
  return [
    { visit_id: "33333333-4444-5555-6666-777777777777", event: "visit_confirmed", detail: { date: "2026-11-10", window: "midday" }, created_at: "2026-11-10T10:00:00.000Z" },
    { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_opened", actor: "client", detail: { reason: "Streaks" }, created_at: "2026-11-11T10:00:00.000Z" },
    { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_decision", actor: "owner", detail: { decision: "reclean", resolution: "Re-clean it.", reclean_date: decisionDate }, created_at: decisionAt },
    { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_resolved", actor: "owner", detail: { reclean_date: resolvedDate }, created_at: resolvedAt },
  ];
}

describe("M4 re-clean date gate on submit", () => {
  it("row re-clean in the future blocks submit (pre-existing behaviour)", async () => {
    const env = installEnv({
      photos: makePhotos(),
      row: { reclean_status: "scheduled", reclean_date: FUTURE_RECLEAN },
    });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["visit_date"]).toBe(FUTURE_RECLEAN);
    expect(r.body["reclean"]).toBe(true);
  });

  it("journal-only re-clean in the future blocks submit (M4 fix)", async () => {
    // No reclean_* columns on the row at all — the arrangement lives
    // only in the issue_decision / issue_resolved journal events.
    const env = installEnv({
      photos: makePhotos(),
      events: journalRecleanEvents(FUTURE_RECLEAN),
    });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["visit_date"]).toBe(FUTURE_RECLEAN);
    expect(r.body["reclean"]).toBe(true);
  });

  it("journal re-clean in the past does not block submit", async () => {
    const env = installEnv({
      photos: makePhotos(),
      events: journalRecleanEvents(PAST_RECLEAN),
    });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(200);
    expect(r.body["published"]).toBe(true);
  });

  it("a journal reclean_date under a non-reclean decision does not gate", async () => {
    const env = installEnv({
      photos: makePhotos(),
      events: journalRecleanEvents(FUTURE_RECLEAN, "payment_requested"),
    });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    // The original visit date (2026-11-10) is past, so the gate passes
    // and the submit publishes.
    expect(r.code).toBe(200);
    expect(r.body["published"]).toBe(true);
  });

  it("no re-clean anywhere: the original visit date still gates", async () => {
    // G3: the gate reads the confirmed date from the journal when set,
    // so the fixture's confirmation must agree with the row — a
    // confirmed 2026-11-10 against a 2099 row would be a reschedule
    // the row never recorded, not a future visit.
    const env = installEnv({
      photos: makePhotos(),
      row: { visit_date: "2099-01-15" },
      events: [
        { visit_id: "33333333-4444-5555-6666-777777777777", event: "visit_confirmed", detail: { date: "2099-01-15", window: "midday" }, created_at: "2026-11-10T10:00:00.000Z" },
      ],
    });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["visit_date"]).toBe("2099-01-15");
    expect(r.body["reclean"]).toBeUndefined();
  });

  it("DA-01: decision-only re-clean in the future blocks submit (the real arrange path writes no issue_resolved)", async () => {
    const env = installEnv({
      photos: makePhotos(),
      events: journalDecisionOnly(FUTURE_RECLEAN),
    });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["visit_date"]).toBe(FUTURE_RECLEAN);
    expect(r.body["reclean"]).toBe(true);
  });

  it("DA-01: a newer decision date wins over an older resolved date", async () => {
    const env = installEnv({
      photos: makePhotos(),
      events: journalBothDates(FUTURE_RECLEAN, "2026-11-11T12:00:00.000Z", PAST_RECLEAN, "2026-11-11T11:00:00.000Z"),
    });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["visit_date"]).toBe(FUTURE_RECLEAN);
    expect(r.body["reclean"]).toBe(true);
  });

  it("DA-01: a newer resolved date wins over an older decision date (later legacy resolve re-agrees the date)", async () => {
    const env = installEnv({
      photos: makePhotos(),
      events: journalBothDates(PAST_RECLEAN, "2026-11-11T11:00:00.000Z", FUTURE_RECLEAN, "2026-11-11T12:00:00.000Z"),
    });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["visit_date"]).toBe(FUTURE_RECLEAN);
    expect(r.body["reclean"]).toBe(true);
  });

  it("DA-01: a dateless newer decision means no date is agreed (stale resolved date does not resurrect)", async () => {
    const env = installEnv({
      photos: makePhotos(),
      events: [
        { visit_id: "33333333-4444-5555-6666-777777777777", event: "visit_confirmed", detail: { date: "2026-11-10", window: "midday" }, created_at: "2026-11-10T10:00:00.000Z" },
        { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_opened", actor: "client", detail: { reason: "Streaks" }, created_at: "2026-11-11T10:00:00.000Z" },
        { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_resolved", actor: "owner", detail: { reclean_date: FUTURE_RECLEAN }, created_at: "2026-11-11T11:00:00.000Z" },
        { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_decision", actor: "owner", detail: { decision: "reclean", resolution: "Re-clean it." }, created_at: "2026-11-11T12:00:00.000Z" },
      ],
    });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(200);
    expect(r.body["published"]).toBe(true);
  });

  it("DA-01: a later non-reclean decision cancels an earlier re-clean", async () => {
    const env = installEnv({
      photos: makePhotos(),
      events: [
        { visit_id: "33333333-4444-5555-6666-777777777777", event: "visit_confirmed", detail: { date: "2026-11-10", window: "midday" }, created_at: "2026-11-10T10:00:00.000Z" },
        { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_opened", actor: "client", detail: { reason: "Streaks" }, created_at: "2026-11-11T10:00:00.000Z" },
        { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_decision", actor: "owner", detail: { decision: "reclean", resolution: "Re-clean it.", reclean_date: FUTURE_RECLEAN }, created_at: "2026-11-11T12:00:00.000Z" },
        { visit_id: "33333333-4444-5555-6666-777777777777", event: "issue_decision", actor: "owner", detail: { decision: "waived", resolution: "Waived." }, created_at: "2026-11-11T13:00:00.000Z" },
      ],
    });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(200);
    expect(r.body["published"]).toBe(true);
  });
});
