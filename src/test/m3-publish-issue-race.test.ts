// @vitest-environment node
// M3: issue TOCTOU on publish. When the cleaner submits, an issue
// opened concurrently (after the submit's held-check read the row,
// before the publish claim) must make the publish lose: the report
// is held for owner review, no report email goes to the client, and
// no 24h clock starts. The publish claim carries issue_open=false.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installEnv, scopeChecklist, makePhotos } from "./m-cleaner-harness";

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("M3 publish vs concurrent issue", () => {
  it("an issue opened mid-publish holds the report and sends no client email", async () => {
    const env = installEnv({ photos: makePhotos() });
    // Simulate the race: the issue lands after the submit read the
    // row (issue_open=false) and before the publish claim runs — the
    // Stripe customer lookup is the step in between.
    env.onStripeSearch = () => {
      env.rows[0]["issue_open"] = true;
    };
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["published"]).toBe(false);
    expect(r.body["held"]).toBe(true);
    // The client never got the report email; only the owner was told.
    expect(env.resendCalls.some((c) => c.subject === "Your cleaning report is ready")).toBe(false);
    expect(env.resendCalls.some((c) => String(c.subject).startsWith("Report ready for review"))).toBe(true);
    // The row was claimed as submitted, never as sent.
    expect(env.rows[0]["report_status"]).toBe("submitted");
    expect(env.rows[0]["status"]).toBe("report_submitted");
  });

  it("without a concurrent issue the same submit publishes normally", async () => {
    const env = installEnv({ photos: makePhotos() });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(200);
    expect(r.body["published"]).toBe(true);
    expect(env.resendCalls.some((c) => c.subject === "Your cleaning report is ready")).toBe(true);
    expect(env.rows[0]["report_status"]).toBe("sent");
  });

  it("an issue already open at submit time still holds the report", async () => {
    const env = installEnv({ photos: makePhotos(), row: { issue_open: true } });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(200);
    expect(r.body["published"]).toBe(false);
    expect(r.body["held"]).toBe(true);
    expect(env.resendCalls.some((c) => c.subject === "Your cleaning report is ready")).toBe(false);
  });
});
