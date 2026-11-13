// @vitest-environment node
// G3X (top-5 round): owner send_report — M3 issue TOCTOU + M6 reminder re-arm.
//
// M3: the cleaner submit path claims issue_open=false in its publish CAS
// and the owner send_report path must do the same: a publish racing an
// open issue must fail / hold, not send. Two layers: (a) the pre-check
// reads the ROW's issue_open as well as the shared metadata (metadata
// can lag, or describe another booking of the same email); (b) the CAS
// itself carries issue_open=neq.true, so an issue that opens between
// the read and the claim still loses. A send with resolve_issue is
// exempt — its success path closes the issue after the email is proven
// sent.
//
// M6: a (re-)publication re-arms the auto-charge reminders, mirroring
// api/cleaner.ts publishReportToClient: the four Stripe reminder flags
// are cleared and a reminders_rearmed journal event is recorded, so the
// new publication gets fresh 4h/20h reminders.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";

const BID = "bid-g3x-send-report";
const VISIT_ID = "88888888-4444-5555-6666-777777777777";
const OLD_SENT_AT = "2026-11-08T10:00:00.000Z";

type Row = Record<string, unknown>;
type Ev = { visit_id: string | null; event: string; detail?: Record<string, unknown>; created_at?: string };

function res() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end: vi.fn(),
  };
}

describe("G3X send_report M3/M6", () => {
  let rows: Row[];
  let events: Ev[];
  let photos: Row[];
  let stripeMeta: Record<string, string>;
  let resendBodies: { to: string[]; subject: string }[];
  // When set, the mock flips the row's issue_open to true just before
  // evaluating a publish CAS — the DB-side model of an issue opening
  // concurrently with this send (after the handler's read).
  let flipIssueOnCas: boolean;

  const supRes = (data: unknown, ok = true, status = 200) => ({
    ok, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });

  const installFetch = () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.includes("api.stripe.com")) {
        if (u.includes("/customers/search")) {
          return supRes({ data: [{ id: "cus_test_g3x", email: "client@example.com", name: "Casey Client", metadata: { ...stripeMeta } }] });
        }
        if (u.includes("/payment_methods")) return supRes({ data: [] });
        if (u.includes("/customers/cus_test_g3x")) {
          if (method === "POST") {
            const params = new URLSearchParams(String(init?.body ?? ""));
            for (const [k, v] of params) {
              const m = /^metadata\[(.+)\]$/.exec(k);
              if (m) stripeMeta[m[1]] = v;
            }
            return supRes({ id: "cus_test_g3x" });
          }
          return supRes({ id: "cus_test_g3x", email: "client@example.com", name: "Casey Client", metadata: { ...stripeMeta } });
        }
        return supRes({ id: "cus_test_g3x" });
      }
      if (u.includes("api.resend.com")) {
        try {
          const b = JSON.parse(String(init?.body ?? "{}")) as { to?: string[]; subject?: string };
          resendBodies.push({ to: b.to ?? [], subject: b.subject ?? "" });
        } catch { /* ignore */ }
        return supRes({ id: "email-1" });
      }
      if (u.includes("/storage/v1/object/sign/")) {
        const tail = u.split("/object/sign/")[1] ?? "x.jpg";
        return supRes({ signedURL: `/object/sign/${tail}?token=test-token` });
      }
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          // Race model: an issue opened after the handler's read, just
          // before the CAS is evaluated.
          if (flipIssueOnCas && patch["report_status"] === "sent") {
            for (const r of rows) r["issue_open"] = true;
          }
          const qs = new URLSearchParams(u.split("?")[1] ?? "");
          const matched = rows.filter((r) => {
            for (const [k, v] of qs.entries()) {
              if (k === "order" || k === "limit" || k === "select") continue;
              if (v.startsWith("eq.")) {
                if (String(r[k] ?? "") !== decodeURIComponent(v.slice(3))) return false;
              } else if (v.startsWith("neq.")) {
                if (String(r[k] ?? "") === decodeURIComponent(v.slice(4))) return false;
              } else if (v.startsWith("is.")) {
                if (v.slice(3) === "null" && r[k] !== null && r[k] !== undefined) return false;
              }
            }
            return true;
          });
          for (const r of matched) Object.assign(r, patch);
          return supRes(matched);
        }
        let out = [...rows];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const eq = (k: string) => {
          const v = qs.get(k);
          return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
        };
        const bid = eq("booking_id");
        const id = eq("id");
        if (bid) out = out.filter((r) => r["booking_id"] === bid);
        if (id) out = out.filter((r) => r["id"] === id);
        const limit = qs.get("limit");
        if (limit) out = out.slice(0, parseInt(limit, 10));
        return supRes(out);
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { visit_id?: string | null; event?: string; detail?: Record<string, unknown> };
          events.push({ visit_id: body.visit_id ?? null, event: body.event ?? "", detail: body.detail });
          return supRes([{ id: events.length }]);
        }
        let out = [...events];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const eq = (k: string) => {
          const v = qs.get(k);
          return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
        };
        const vid = eq("visit_id");
        const bid = eq("booking_id");
        const ev = eq("event");
        if (vid) out = out.filter((e) => e.visit_id === vid);
        if (bid) out = out.filter((e) => (e as unknown as Record<string, unknown>)["booking_id"] === bid);
        if (ev) out = out.filter((e) => e.event === ev);
        return supRes(out);
      }
      if (u.includes("/rest/v1/gh_photos")) {
        let out = [...photos];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const vid = qs.get("visit_id");
        if (vid && vid.startsWith("eq.")) out = out.filter((p) => p["visit_id"] === decodeURIComponent(vid.slice(3)));
        return supRes(out);
      }
      return supRes({}, false, 404);
    }));
  };

  const call = async (body: Record<string, unknown>) => {
    const r = res();
    await bookingAction(
      { method: "POST", headers: { authorization: "Bearer " + "adm-" + "secret" }, body } as never,
      r as never,
    );
    return r;
  };

  const baseRow = (overrides: Row = {}): Row => ({
    id: VISIT_ID,
    booking_id: BID,
    visit_no: 1,
    status: "report_submitted",
    report_status: "submitted",
    visit_date: "2026-11-10",
    window: "morning",
    service: "Standard cleaning",
    client_name: "Casey Client",
    client_email: "client@example.com",
    amount_cents: 14900,
    cleaner_name: "Ana",
    cleaner_id: "roster-ana",
    issue_open: false,
    issue_ever: false,
    report_sent_at: null,
    report_bounced: false,
    report_email_id: null,
    checklist: { rooms: [] },
    ...overrides,
  });

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows = [baseRow()];
    events = [
      { visit_id: VISIT_ID, event: "visit_confirmed", detail: { date: "2026-11-10", window: "morning" }, created_at: "2026-11-10T10:00:00.000Z" },
    ];
    photos = [
      { id: "p1", visit_id: VISIT_ID, room: "Kitchen", kind: "after", storage_path: "visits/x/kitchen/a.jpg" },
      { id: "p2", visit_id: VISIT_ID, room: "Bathrooms", kind: "after", storage_path: "visits/x/bath/a.jpg" },
    ];
    stripeMeta = {
      gh_booking_id: BID,
      gh_state: "report_submitted",
      gh_first_price_cents: "14900",
      gh_recurring_price_cents: "12900",
      gh_report_version: "0",
      gh_rp_hash: "deadbeef",
      gh_rp_source: "db",
    };
    resendBodies = [];
    flipIssueOnCas = false;
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("M3: a row-level open issue blocks the publish even when shared metadata lags (no email, no publish)", async () => {
    rows = [baseRow({ issue_open: true, issue_ever: true })];
    // Metadata says nothing — the stale-mirror case.
    const r = await call({ action: "send_report", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("issue_open");
    expect(resendBodies).toHaveLength(0);
    expect(rows[0]["report_status"]).toBe("submitted");
    expect(rows[0]["issue_open"]).toBe(true);
  });

  it("M3: an issue that opens between the read and the claim loses the CAS — 409, nothing sent", async () => {
    flipIssueOnCas = true;
    const r = await call({ action: "send_report", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("issue_open");
    expect(resendBodies).toHaveLength(0);
    expect(rows[0]["report_status"]).toBe("submitted");
    expect(rows[0]["issue_open"]).toBe(true);
    expect(events.some((e) => e.event === "report_sent")).toBe(false);
  });

  it("M3: a send with resolve_issue still publishes and closes the issue", async () => {
    rows = [baseRow({ issue_open: true, issue_ever: true })];
    stripeMeta = { ...stripeMeta, gh_state: "issue_open", gh_issue_open: "1", gh_issue_reason: "Streaks" };
    const r = await call({ action: "send_report", booking_id: BID, resolve_issue: true });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["email_sent"]).toBe(true);
    expect(resendBodies).toHaveLength(1);
    expect(rows[0]["issue_open"]).toBe(false);
    expect(events.some((e) => e.event === "issue_resolved")).toBe(true);
  });

  it("M6: a re-send clears the old reminder flags and journals the re-arm", async () => {
    rows = [baseRow({
      status: "report_sent", report_status: "sent",
      report_sent_at: OLD_SENT_AT, report_bounced: true,
    })];
    stripeMeta = {
      ...stripeMeta,
      gh_state: "report_sent",
      gh_report_sent_at: OLD_SENT_AT,
      gh_report_version: "1",
      gh_report_bounced: "1",
      gh_reminded_at: "2026-11-12T10:00:00.000Z",
      gh_reminder_for: BID,
      gh_early_reminded_at: "2026-11-12T06:00:00.000Z",
      gh_early_reminder_for: BID,
    };
    const r = await call({ action: "send_report", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["email_sent"]).toBe(true);
    expect(stripeMeta["gh_reminded_at"]).toBe("");
    expect(stripeMeta["gh_reminder_for"]).toBe("");
    expect(stripeMeta["gh_early_reminded_at"]).toBe("");
    expect(stripeMeta["gh_early_reminder_for"]).toBe("");
    const rearmed = events.find((e) => e.event === "reminders_rearmed");
    expect(rearmed).toBeDefined();
    expect(rearmed?.detail?.["version"]).toBe(2);
    const sent = events.find((e) => e.event === "report_sent");
    expect(sent?.detail?.["reminders_rearmed"]).toBe(true);
  });

  it("M6: a first publish also re-arms (flags cleared, event journaled)", async () => {
    stripeMeta = {
      ...stripeMeta,
      gh_reminded_at: "2026-11-12T10:00:00.000Z",
      gh_reminder_for: BID,
      gh_early_reminded_at: "2026-11-12T06:00:00.000Z",
      gh_early_reminder_for: BID,
    };
    const r = await call({ action: "send_report", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(stripeMeta["gh_reminded_at"]).toBe("");
    expect(stripeMeta["gh_early_reminded_at"]).toBe("");
    expect(events.some((e) => e.event === "reminders_rearmed")).toBe(true);
  });
});
