// @vitest-environment node
// C5 + B4: owner_cancel and the row-based resolve of status /
// client_link for a booking with no Stripe customer at all (Kate
// 86548240: the live status/client_link calls returned
// booking_not_found although /api/owner sees the row).
//
// owner_cancel reuses the client's own 48h / $25 rule
// (cancelFeeCents from api/visit.ts): free more than 48h before the
// visit, $25 inside 48h, free for a past date. A sent report refuses
// the cancel, like the client cancel refuses report_sent.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";

const BID = "kate-86548240";
const VISIT_ID = "99999999-4444-5555-6666-777777777777";

type Row = Record<string, unknown>;
type Ev = { visit_id: string | null; booking_id?: string; event: string; detail?: Record<string, unknown>; created_at?: string };

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

// YYYY-MM-DD `days` from today, in the local calendar.
const datePlus = (days: number): string => {
  const d = new Date(Date.now() + days * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};

describe("C5 owner_cancel + B4 row-based resolve (Kate, no Stripe customer)", () => {
  let rows: Row[];
  let events: Ev[];
  let resendBodies: { to: string[]; subject: string; text: string }[];

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
        // Kate has no Stripe customer: search and list both come back empty.
        return supRes({ data: [] });
      }
      if (u.includes("api.resend.com")) {
        try {
          const b = JSON.parse(String(init?.body ?? "{}")) as { to?: string[]; subject?: string; text?: string };
          resendBodies.push({ to: b.to ?? [], subject: b.subject ?? "", text: b.text ?? "" });
        } catch { /* ignore */ }
        return supRes({ id: "email-1" });
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
          const body = JSON.parse(String(init?.body ?? "{}")) as { visit_id?: string | null; booking_id?: string; event?: string; detail?: Record<string, unknown> };
          events.push({ visit_id: body.visit_id ?? null, booking_id: body.booking_id, event: body.event ?? "", detail: body.detail, created_at: new Date().toISOString() });
          return supRes([{ id: events.length }]);
        }
        let out = [...events];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const eq = (k: string) => {
          const v = qs.get(k);
          return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
        };
        const bid = eq("booking_id");
        const ev = eq("event");
        if (bid) out = out.filter((e) => e.booking_id === bid);
        if (ev) out = out.filter((e) => e.event === ev);
        return supRes(out);
      }
      if (u.includes("/rest/v1/gh_visit_access")) {
        return supRes([]);
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

  const kateRow = (over: Row = {}): Row => ({
    id: VISIT_ID,
    booking_id: BID,
    visit_no: 1,
    status: "requested",
    report_status: "none",
    visit_date: datePlus(5),
    window: "morning",
    service: "Standard cleaning",
    client_name: "Kate",
    client_email: "kate@example.com",
    amount_cents: 149,
    cleaner_name: null,
    issue_open: false,
    issue_ever: false,
    report_sent_at: null,
    report_bounced: false,
    ...over,
  });

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-" + "secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows = [kateRow()];
    events = [];
    resendBodies = [];
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("status resolves from the visit row when there is no Stripe customer", async () => {
    const r = await call({ action: "status", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["no_stripe_customer"]).toBe(true);
    expect(r.body["payment_method"]).toBe("none");
    expect(r.body["state"]).toBe("requested");
  });

  it("client_link mints from the row email/name when there is no Stripe customer", async () => {
    const r = await call({ action: "client_link", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["no_stripe_customer"]).toBe(true);
    expect(String(r.body["url"] ?? "")).toMatch(/^https:\/\/www\.gatehousehomecleaning\.com\/visit\?bt=/);
    expect(events.some((e) => e.event === "client_link_issued")).toBe(true);
  });

  it("status still 404s when there is no row at all", async () => {
    rows = [];
    const r = await call({ action: "status", booking_id: BID });
    expect(r.code).toBe(404);
    expect(r.body["error"]).toBe("booking_not_found");
  });

  it("owner_cancel succeeds with no fee more than 48h out, and emails the client", async () => {
    const r = await call({ action: "owner_cancel", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["fee_cents"]).toBe(0);
    expect(r.body["email_sent"]).toBe(true);
    expect(rows[0]["status"]).toBe("cancelled");
    const ev = events.find((e) => e.event === "visit_cancelled");
    expect(ev).toBeDefined();
    expect(ev?.detail?.["fee_cents"]).toBe(0);
    expect(ev?.detail?.["scope"]).toBe("once");
    expect(resendBodies).toHaveLength(1);
    expect(resendBodies[0].to).toEqual(["kate@example.com"]);
    expect(resendBodies[0].subject).toContain("cancelled");
    expect(resendBodies[0].text).toContain("No fee");
  });

  it("owner_cancel charges the $25 late fee inside 48h", async () => {
    rows = [kateRow({ visit_date: datePlus(1) })];
    const r = await call({ action: "owner_cancel", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["fee_cents"]).toBe(2500);
    expect(rows[0]["status"]).toBe("cancelled");
    expect(events.find((e) => e.event === "visit_cancelled")?.detail?.["fee_cents"]).toBe(2500);
    expect(resendBodies[0].text).toContain("$25 late-cancellation fee");
  });

  it("owner_cancel is free for a past visit date", async () => {
    rows = [kateRow({ visit_date: datePlus(-3) })];
    const r = await call({ action: "owner_cancel", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["fee_cents"]).toBe(0);
  });

  it("owner_cancel refuses a booking whose report was already sent", async () => {
    rows = [kateRow({ status: "report_sent", report_status: "sent", report_sent_at: "2026-11-08T10:00:00.000Z" })];
    const r = await call({ action: "owner_cancel", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_already_sent");
    expect(rows[0]["status"]).toBe("report_sent");
    expect(events.some((e) => e.event === "visit_cancelled")).toBe(false);
    expect(resendBodies).toHaveLength(0);
  });

  it("owner_cancel refuses an already-cancelled booking", async () => {
    rows = [kateRow({ status: "cancelled" })];
    const r = await call({ action: "owner_cancel", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("already_cancelled");
  });

  it("owner_cancel refuses a paid booking", async () => {
    rows = [kateRow({ status: "paid" })];
    const r = await call({ action: "owner_cancel", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("already_paid");
  });

  it("owner_cancel 404s for an unknown booking", async () => {
    const r = await call({ action: "owner_cancel", booking_id: "no-such-booking" });
    expect(r.code).toBe(404);
    expect(r.body["error"]).toBe("booking_not_found");
  });
});
