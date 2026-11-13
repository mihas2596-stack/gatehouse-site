// @vitest-environment node
// M6: the auto-charge reminder is re-sent on re-publish. Publishing
// (re-)arms the reminders: the Stripe customer flags the auto-charge
// passes read (gh_reminded_at / gh_reminder_for and
// gh_early_reminded_at / gh_early_reminder_for) are cleared, and a
// reminders_rearmed journal event records the re-arm, so the client
// gets a fresh reminder before any charge on the new publication.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installEnv, scopeChecklist, makePhotos } from "./m-cleaner-harness";

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("M6 reminder re-arm on publish", () => {
  it("re-publish clears the reminder flags and journals the re-arm", async () => {
    const env = installEnv({
      photos: makePhotos(),
      // The old publication's reminders already went out.
      customerMeta: {
        gh_reminded_at: "2026-11-12T10:00:00.000Z",
        gh_reminder_for: "bid-m-top5",
        gh_early_reminded_at: "2026-11-12T06:00:00.000Z",
        gh_early_reminder_for: "bid-m-top5",
      },
      events: [
        { visit_id: "33333333-4444-5555-6666-777777777777", event: "visit_confirmed", detail: { date: "2026-11-10", window: "midday" }, created_at: "2026-11-10T10:00:00.000Z" },
        { visit_id: "33333333-4444-5555-6666-777777777777", event: "reminder_sent", detail: {}, created_at: "2026-11-12T10:00:00.000Z" },
        { visit_id: "33333333-4444-5555-6666-777777777777", event: "early_reminder_sent", detail: {}, created_at: "2026-11-12T06:00:00.000Z" },
      ],
    });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(200);
    expect(r.body["published"]).toBe(true);

    // The reminder flags the auto-charge passes read are cleared on
    // the Stripe customer, so the new publication gets fresh 4h/20h
    // reminders instead of the old ones silencing them.
    const cleared = env.stripePosts.some(
      (p) =>
        p["metadata[gh_reminded_at]"] === "" &&
        p["metadata[gh_reminder_for]"] === "" &&
        p["metadata[gh_early_reminded_at]"] === "" &&
        p["metadata[gh_early_reminder_for]"] === "",
    );
    expect(cleared).toBe(true);
    expect(env.customerMeta["gh_reminded_at"]).toBe("");
    expect(env.customerMeta["gh_early_reminded_at"]).toBe("");

    // The re-arm is journaled, and the report_sent event carries it.
    const rearmed = env.events.find((e) => e.event === "reminders_rearmed");
    expect(rearmed).toBeDefined();
    expect(rearmed?.detail?.["version"]).toBe(1);
    const sent = env.events.find((e) => e.event === "report_sent");
    expect(sent?.detail?.["reminders_rearmed"]).toBe(true);
  });

  it("a first publish also clears the (empty) flags without failing", async () => {
    const env = installEnv({ photos: makePhotos() });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(200);
    expect(r.body["published"]).toBe(true);
    expect(env.events.some((e) => e.event === "reminders_rearmed")).toBe(true);
  });
});
