// @vitest-environment node
// B8: send_report with resolve_issue must close the issue ONLY after the
// report email is proven sent. If the email fails, the issue stays open
// (issue_open=true), the 24h timer is NOT restarted (report_sent_at
// keeps its old value), and report_bounced is set — with an explicit
// journal event so the owner sees why the issue is still open.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";

const BID = "bid-b8-resolve-issue";
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

describe("B8 send_report with resolve_issue", () => {
  let rows: Row[];
  let events: Ev[];
  let photos: Row[];
  let stripeMeta: Record<string, string>;
  let resendOk: boolean;
  let resendBodies: { to: string[]; subject: string }[];

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
          return supRes({ data: [{ id: "cus_test_b8", email: "client@example.com", name: "Casey Client", metadata: { ...stripeMeta } }] });
        }
        if (u.includes("/payment_methods")) return supRes({ data: [] });
        if (u.includes("/customers/cus_test_b8")) {
          if (method === "POST") {
            const params = new URLSearchParams(String(init?.body ?? ""));
            for (const [k, v] of params) {
              const m = /^metadata\[(.+)\]$/.exec(k);
              if (m) stripeMeta[m[1]] = v;
            }
            return supRes({ id: "cus_test_b8" });
          }
          return supRes({ id: "cus_test_b8", email: "client@example.com", name: "Casey Client", metadata: { ...stripeMeta } });
        }
        return supRes({ id: "cus_test_b8" });
      }
      if (u.includes("api.resend.com")) {
        try {
          const b = JSON.parse(String(init?.body ?? "{}")) as { to?: string[]; subject?: string };
          resendBodies.push({ to: b.to ?? [], subject: b.subject ?? "" });
        } catch { /* ignore */ }
        return supRes({ id: "email-1" }, resendOk, resendOk ? 200 : 500);
      }
      if (u.includes("/storage/v1/object/sign/")) {
        const tail = u.split("/object/sign/")[1] ?? "x.jpg";
        return supRes({ signedURL: `/object/sign/${tail}?token=test-token` });
      }
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          const qs = new URLSearchParams(u.split("?")[1] ?? "");
          const matched = rows.filter((r) => {
            for (const [k, v] of qs.entries()) {
              if (k === "order" || k === "limit" || k === "select") continue;
              if (v.startsWith("eq.")) {
                if (String(r[k] ?? "") !== decodeURIComponent(v.slice(3))) return false;
              } else if (v.startsWith("neq.")) {
                if (String(r[k] ?? "") === decodeURIComponent(v.slice(4))) return false;
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

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-" + "secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Re-send scenario: a previous publication exists (sent at OLD_SENT_AT)
    // and its email bounced, so the 10-minute double-send guard is bypassed
    // and a fresh send is attempted — with an open issue resolved by it.
    rows = [{
      id: VISIT_ID,
      booking_id: BID,
      visit_no: 1,
      status: "report_sent",
      report_status: "sent",
      visit_date: "2026-11-22",
      window: "morning",
      service: "Standard cleaning",
      client_name: "Casey Client",
      client_email: "client@example.com",
      amount_cents: 14900,
      cleaner_name: null,
      cleaner_id: null,
      issue_open: true,
      issue_ever: true,
      report_sent_at: OLD_SENT_AT,
      report_bounced: true,
      report_email_id: null,
      checklist: { rooms: [] },
    }];
    events = [{ visit_id: VISIT_ID, event: "issue_opened", detail: { reason: "Streaks on the floor" }, created_at: "2026-11-08T09:00:00.000Z" }];
    photos = [
      { id: "p1", visit_id: VISIT_ID, room: "Kitchen", kind: "after", storage_path: "visits/x/kitchen/a.jpg" },
      { id: "p2", visit_id: VISIT_ID, room: "Bathrooms", kind: "after", storage_path: "visits/x/bath/a.jpg" },
    ];
    stripeMeta = {
      gh_booking_id: BID,
      gh_state: "issue_open",
      gh_first_price_cents: "14900",
      gh_recurring_price_cents: "12900",
      gh_issue_open: "1",
      gh_issue_reason: "Streaks on the floor",
      gh_report_sent_at: OLD_SENT_AT,
      gh_report_version: "1",
      gh_report_bounced: "1",
      gh_rp_hash: "deadbeef",
      gh_rp_source: "db",
    };
    resendOk = true;
    resendBodies = [];
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("successful send with resolve_issue closes the issue and starts a fresh timer", async () => {
    resendOk = true;
    const r = await call({ action: "send_report", booking_id: BID, resolve_issue: true });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["email_sent"]).toBe(true);
    expect(rows[0]["issue_open"]).toBe(false);
    expect(rows[0]["report_bounced"]).toBe(false);
    expect(rows[0]["report_sent_at"]).not.toBe(OLD_SENT_AT);
    expect(Date.parse(String(rows[0]["report_sent_at"]))).toBeGreaterThan(Date.parse(OLD_SENT_AT));
    expect(stripeMeta["gh_issue_open"]).toBe("");
    expect(stripeMeta["gh_report_bounced"]).toBe("");
    expect(events.some((e) => e.event === "report_sent")).toBe(true);
    const resolved = events.find((e) => e.event === "issue_resolved");
    expect(resolved).toBeDefined();
    expect(resolved?.detail?.["via"]).toBe("report_resend");
    expect(events.some((e) => e.event === "issue_kept_open")).toBe(false);
  });

  it("failed send keeps the issue open, does not restart the timer, and journals it", async () => {
    resendOk = false;
    const r = await call({ action: "send_report", booking_id: BID, resolve_issue: true });
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("report_email_failed");
    // The dispute survives: the client never got the new report.
    expect(rows[0]["issue_open"]).toBe(true);
    // The 24h timer is NOT restarted: the old publication time stands.
    expect(rows[0]["report_sent_at"]).toBe(OLD_SENT_AT);
    expect(rows[0]["report_bounced"]).toBe(true);
    expect(stripeMeta["gh_issue_open"]).toBe("1");
    expect(stripeMeta["gh_report_sent_at"]).toBe(OLD_SENT_AT);
    expect(stripeMeta["gh_report_bounced"]).toBe("1");
    expect(events.some((e) => e.event === "report_delivery_failed")).toBe(true);
    expect(events.some((e) => e.event === "issue_resolved")).toBe(false);
    const kept = events.find((e) => e.event === "issue_kept_open");
    expect(kept).toBeDefined();
    expect(kept?.detail?.["reason"]).toBe("email_not_sent");
  });
});
