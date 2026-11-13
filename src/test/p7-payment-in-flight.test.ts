// @vitest-environment node
// P7: waive / return_report during payment_pending does not stop the
// charge — the "No charge will be made" email lies, and a stuck PI is
// later adopted as paid. Both actions must 409 while a charge is in
// flight; the owner retries once the charge settles.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";

const TOKEN = "adm-" + "secret";
const VISIT_ID = "22222222-3333-4444-5555-666666666666";
const BID = "bid-p7";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

function res() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

const CUSTOMER = {
  id: "cus_test_p7",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "report_sent" },
};

function matchRow(row: Row, match: string): boolean {
  const parts = match.split("&").filter(Boolean);
  for (const part of parts) {
    if (part.startsWith("or=(") && part.endsWith(")")) {
      const inner = part.slice(4, -1).split(",");
      const ok = inner.some((c) => {
        const [f, op, ...rest] = c.split(".");
        const v = rest.join(".");
        if (op === "is" && v === "null") return row[f] == null;
        if (op === "eq") return String(row[f] ?? "") === decodeURIComponent(v);
        return false;
      });
      if (!ok) return false;
      continue;
    }
    const [field, op, ...rest] = part.split(".");
    const value = decodeURIComponent(rest.join("."));
    if (field === "order" || field === "limit" || field === "offset") continue;
    if (op === "eq") {
      if (String(row[field] ?? "") !== value) return false;
    } else if (op === "neq") {
      if (String(row[field] ?? "") === value) return false;
    } else if (op === "is" && value === "null") {
      if (row[field] != null) return false;
    }
  }
  return true;
}

describe("P7: waive / return_report refuse while a charge is in flight", () => {
  let rows: Row[];
  let events: Ev[];
  let resendCalls: number;

  const ev = (event: string, detail: Record<string, unknown> | null, created_at: string): Ev =>
    ({ event, detail, created_at });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T00:00:00Z"));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows = [{
      id: VISIT_ID,
      booking_id: BID,
      visit_no: 1,
      status: "payment_pending",
      report_status: "sent",
      report_sent_at: "2026-11-18T12:00:00.000Z",
      visit_date: "2027-01-15",
      window: "midday",
      cleaner_name: "Ana",
      amount_cents: 14900,
      client_email: "client@example.com",
      client_name: "Casey Client",
      issue_open: true,
      issue_ever: true,
    }];
    events = [
      ev("visit_confirmed", { date: "2027-01-15", window: "midday" }, "2026-11-17T10:00:00.000Z"),
      ev("report_sent", { version: 1, email_sent: true }, "2026-11-18T12:00:00.000Z"),
      ev("issue_opened", { reason: "Missed a spot", room: "Kitchen" }, "2026-11-18T14:00:00.000Z"),
    ];
    resendCalls = 0;
    const supRes = (data: unknown, ok = true, status = 200) => ({
      ok, status,
      json: async () => data,
      text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("api.stripe.com")) {
        if (u.includes("/customers/search")) return supRes({ data: [{ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } }] });
        if (u.includes(`/customers/${CUSTOMER.id}`) && method === "GET") return supRes({ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } });
        return supRes({ id: CUSTOMER.id });
      }
      if (u.includes("api.resend.com")) { resendCalls++; return supRes({ id: "email-1" }); }
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          const q = u.split("?")[1] ?? "";
          const changed: Row[] = [];
          for (const r of rows) {
            if (matchRow(r, q)) { Object.assign(r, patch); changed.push(r); }
          }
          return supRes(changed);
        }
        const q = new URLSearchParams(u.split("?")[1] ?? "");
        const bid = q.get("booking_id");
        const id = q.get("id");
        let out = [...rows];
        if (bid?.startsWith("eq.")) out = out.filter((r) => r["booking_id"] === decodeURIComponent(bid.slice(3)));
        if (id?.startsWith("eq.")) out = out.filter((r) => r["id"] === decodeURIComponent(id.slice(3)));
        return supRes(out.slice(0, 1));
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          events.push({ event: String(body["event"] ?? ""), detail: (body["detail"] as Record<string, unknown> | null) ?? null, created_at: new Date().toISOString() });
          return supRes([{ id: events.length }]);
        }
        const q = new URLSearchParams(u.split("?")[1] ?? "");
        const evName = q.get("event");
        let out = [...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        if (evName?.startsWith("eq.")) out = out.filter((e) => e.event === decodeURIComponent(evName.slice(3)));
        return supRes(out.slice(0, 60));
      }
      return supRes({}, false, 404);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const call = async (body: Record<string, unknown>) => {
    const r = res();
    await bookingAction(
      { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body } as never,
      r as never,
    );
    return r;
  };

  it("waive is refused while a charge is in flight — no decision recorded, no email", async () => {
    const r = await call({ action: "issue_waive_charge", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("payment_in_flight");
    expect(events.some((e) => e.event === "issue_decision")).toBe(false);
    expect(events.some((e) => e.event === "issue_resolved")).toBe(false);
    expect(rows[0]["issue_open"]).toBe(true);
    expect(resendCalls).toBe(0);
  });

  it("waive succeeds once the charge has settled (status back to report_sent)", async () => {
    rows[0]["status"] = "report_sent";
    const r = await call({ action: "issue_waive_charge", booking_id: BID });
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["issue_open"]).toBe(false);
    expect(events.some((e) => e.event === "issue_decision" && e.detail?.["decision"] === "waived")).toBe(true);
  });

  it("return_report is refused while a charge is in flight — the report stays sent", async () => {
    const r = await call({ action: "return_report", booking_id: BID, note: "Fix the kitchen" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("payment_in_flight");
    expect(rows[0]["report_status"]).toBe("sent");
    expect(events.some((e) => e.event === "report_returned")).toBe(false);
  });

  it("return_report succeeds once the charge has settled", async () => {
    rows[0]["status"] = "report_sent";
    const r = await call({ action: "return_report", booking_id: BID, note: "Fix the kitchen" });
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["report_status"]).toBe("returned");
  });
});
