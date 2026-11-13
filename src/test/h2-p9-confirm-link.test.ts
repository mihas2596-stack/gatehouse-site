// @vitest-environment node
// H2: a cleaner link minted from the OLD visit date dies before a
// rescheduled visit. assign_confirm must mint from the NEW date, the
// same cleaner must get a rotation when the date moves, and confirm
// must reissue the link on a date change.
// P9: re-confirming a visit whose report is already sent orphans the
// report forever (chargeVisit blocks with report_not_current).
// confirm/assign_confirm must 409 when report_status=sent and the
// visit is already confirmed; an exact repeat stays a no-op and the
// unconfirmed repair path still works.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";
import { cleanerLinkExpiry, mintCleanerLinkV2, newIssuanceId, cleanerLinkPrimarySecret } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";

const TOKEN = "adm-" + "secret";
const LINK_SECRET = "test-cleaner-secret-123";
const VISIT_ID = "11111111-2222-3333-4444-555555555555";
const BID = "bid-h2-p9";

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
  id: "cus_test_h2",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "card_ready" },
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

describe("H2 + P9: cleaner link follows the rescheduled date; sent reports cannot be re-confirmed", () => {
  let rows: Row[];
  let events: Ev[];
  let roster: Row[];

  const ev = (event: string, detail: Record<string, unknown> | null, created_at: string): Ev =>
    ({ event, detail, created_at });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T00:00:00Z"));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("CLEANER_LINK_SECRET", LINK_SECRET);
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const issuance = newIssuanceId();
    const token = mintCleanerLinkV2(cleanerLinkPrimarySecret(), VISIT_ID, issuance);
    rows = [{
      id: VISIT_ID,
      booking_id: BID,
      visit_no: 1,
      status: "confirmed",
      report_status: "none",
      report_sent_at: null,
      visit_date: "2027-01-15",
      window: "midday",
      cleaner_name: "Ana",
      cleaner_id: "roster-ana-1",
      cleaner_token_hash: hashToken(token),
      cleaner_token_expires: cleanerLinkExpiry("2027-01-15"),
      cleaner_link_version: "v2",
      cleaner_link_issuance: issuance,
      cleaner_profile: null,
      checklist: { rooms: [] },
      amount_cents: 14900,
      client_email: "client@example.com",
      client_name: "Casey Client",
    }];
    events = [
      ev("visit_confirmed", { date: "2027-01-15", window: "midday" }, "2026-11-18T10:00:00.000Z"),
    ];
    roster = [
      { id: "roster-ana-1", name: "Ana", phone: "+1 404 555 0100", photo_url: "https://example.com/ana1.jpg", active: true },
      { id: "roster-ana-2", name: "Ana", phone: "+1 404 555 0200", photo_url: "https://example.com/ana2.jpg", active: true },
    ];
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
        if (u.includes("/payment_methods")) return supRes({ data: [] });
        if (u.includes(`/customers/${CUSTOMER.id}`) && method === "GET") return supRes({ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } });
        return supRes({ id: CUSTOMER.id });
      }
      if (u.includes("api.resend.com")) return supRes({ id: "email-1" });
      if (u.includes("/rest/v1/gh_cleaners")) {
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const id = qs.get("id");
        const out = id && id.startsWith("eq.")
          ? roster.filter((r) => r["id"] === decodeURIComponent(id.slice(3)))
          : [...roster];
        return supRes(out.slice(0, 1));
      }
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

  it("H2: a new cleaner gets a link minted from the NEW date, not the old row snapshot", async () => {
    const r = await call({
      action: "assign_confirm", booking_id: BID, cleaner_id: "roster-ana-2",
      confirmed_date: "2027-02-10", confirmed_window: "midday",
    });
    expect(r.body["ok"]).toBe(true);
    // The old link expired 2027-01-17 (old date + 2d); the new link
    // must cover the new date (2027-02-12), not the old one.
    expect(rows[0]["cleaner_token_expires"]).toBe(cleanerLinkExpiry("2027-02-10"));
    expect(rows[0]["visit_date"]).toBe("2027-02-10");
    expect(events.some((e) => e.event === "cleaner_link_rotated")).toBe(true);
  });

  it("H2: the same cleaner keeps a still-valid link, but gets a rotation when the date moves past it", async () => {
    const r = await call({
      action: "assign_confirm", booking_id: BID, cleaner_id: "roster-ana-1",
      confirmed_date: "2027-02-10", confirmed_window: "midday",
    });
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["cleaner_token_expires"]).toBe(cleanerLinkExpiry("2027-02-10"));
    expect(events.some((e) => e.event === "cleaner_link_rotated")).toBe(true);
  });

  it("H2: confirm reissues the link when the date moves past its expiry", async () => {
    const r = await call({
      action: "confirm", booking_id: BID,
      confirmed_date: "2027-02-10", confirmed_window: "midday",
    });
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["visit_date"]).toBe("2027-02-10");
    expect(rows[0]["cleaner_token_expires"]).toBe(cleanerLinkExpiry("2027-02-10"));
    expect(events.some((e) => e.event === "cleaner_link_rotated")).toBe(true);
  });

  it("H2: confirm leaves a still-valid link untouched when the date stays inside it", async () => {
    const before = rows[0]["cleaner_token_expires"];
    // Same date, different window: the link still covers the visit
    // (date + 2d = 2027-01-17 = the current expiry), so no rotation.
    const r = await call({
      action: "confirm", booking_id: BID,
      confirmed_date: "2027-01-15", confirmed_window: "morning",
    });
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["cleaner_token_expires"]).toBe(before);
    expect(events.some((e) => e.event === "cleaner_link_rotated")).toBe(false);
  });

  it("P9: confirm to a new date is refused when the report is already sent", async () => {
    rows[0]["report_status"] = "sent";
    rows[0]["report_sent_at"] = "2026-11-18T12:00:00.000Z";
    const r = await call({
      action: "confirm", booking_id: BID,
      confirmed_date: "2027-02-10", confirmed_window: "midday",
    });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_already_sent");
    expect(rows[0]["visit_date"]).toBe("2027-01-15");
  });

  it("P9: assign_confirm to a new date is refused when the report is already sent", async () => {
    rows[0]["report_status"] = "sent";
    rows[0]["report_sent_at"] = "2026-11-18T12:00:00.000Z";
    const r = await call({
      action: "assign_confirm", booking_id: BID, cleaner_id: "roster-ana-1",
      confirmed_date: "2027-02-10", confirmed_window: "midday",
    });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_already_sent");
    expect(rows[0]["visit_date"]).toBe("2027-01-15");
  });

  it("P9: an exact repeat confirmation is still a no-op when the report is sent", async () => {
    rows[0]["report_status"] = "sent";
    rows[0]["report_sent_at"] = "2026-11-18T12:00:00.000Z";
    const r = await call({
      action: "confirm", booking_id: BID,
      confirmed_date: "2027-01-15", confirmed_window: "midday",
    });
    expect(r.body["ok"]).toBe(true);
    expect(r.body["already_confirmed"]).toBe(true);
  });

  it("P9: the unconfirmed repair path still works when the report was sent without confirmation", async () => {
    rows[0]["status"] = "requested";
    rows[0]["report_status"] = "sent";
    rows[0]["report_sent_at"] = "2026-11-18T12:00:00.000Z";
    events = events.filter((e) => e.event !== "visit_confirmed");
    const r = await call({
      action: "confirm", booking_id: BID, repair: true,
      confirmed_date: "2027-01-15", confirmed_window: "midday",
    });
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["status"]).toBe("confirmed");
  });
});
