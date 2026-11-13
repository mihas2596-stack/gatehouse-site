// @vitest-environment node
// Extension bug #4: the owner notification about a new quote.
// A quote whose client never saves a card used to notify the owner
// never — the creation email was gated on "no visit row", and the
// card-ready email only fires after a card is saved — so the request
// sat in /owner as "Needs attention" while the client waited for a
// confirmation nobody processed ("Test Client", 2026-11-20).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import sendContactEmail from "../../api/send-contact-email";
import bookingAction from "../../api/booking-action";

const ORIGIN = "https://www.gatehousehomecleaning.com";
const OWNER_EMAIL = "nikolajmihasenok@gmail.com";
const OWNER_URL = "https://www.gatehousehomecleaning.com/owner";

type Row = Record<string, unknown>;
type Ev = { visit_id: string | null; booking_id?: string | null; event: string; detail?: Record<string, unknown> };
type ResendCall = { to: string[]; subject: string; html: string; text: string; key: string | null };

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

// A service date 7 days ahead: always valid (earliest is today + 2),
// and never in the past when the suite runs later.
const serviceDate = (): string => {
  const d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};

const quoteBody = (overrides: Record<string, unknown> = {}) => ({
  source: "quote",
  name: "Test Client",
  email: "kolamicola@gmail.com",
  phone: "4045550100",
  zip: "30009",
  address: "123 Test Street",
  city: "Sugar Hill",
  state: "GA",
  date: serviceDate(),
  time: "morning",
  service: "Standard cleaning",
  service_key: "standard",
  frequency: "onetime",
  bedrooms: "1",
  bathrooms: "1",
  terms_consent: true,
  photo_consent: true,
  request_id: "11111111-2222-3333-4444-555555555555",
  ...overrides,
});

describe("owner notification for a new quote", () => {
  let rows: Row[];
  let events: Ev[];
  let resendCalls: ResendCall[];
  let resendQueue: boolean[];

  const supRes = (data: unknown, ok = true, status = 200) => ({
    ok, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });

  const installFetch = () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("api.resend.com")) {
        const b = JSON.parse(String(init?.body ?? "{}")) as { to?: string[]; subject?: string; html?: string; text?: string };
        const headers = init?.headers ?? {};
        resendCalls.push({
          to: b.to ?? [],
          subject: b.subject ?? "",
          html: b.html ?? "",
          text: b.text ?? "",
          key: headers["Idempotency-Key"] ?? headers["idempotency-key"] ?? null,
        });
        const ok = resendQueue.length > 0 ? (resendQueue.shift() as boolean) : true;
        return supRes({ id: `email-${resendCalls.length}` }, ok, ok ? 200 : 500);
      }
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          const created = { ...body, id: body["id"] ?? `visit-${rows.length + 1}`, created_at: new Date().toISOString() };
          rows.push(created);
          return supRes([created]);
        }
        let out = [...rows];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const eq = (k: string) => {
          const v = qs.get(k);
          return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
        };
        const bid = eq("booking_id");
        const id = eq("id");
        const date = eq("visit_date");
        const visitNo = eq("visit_no");
        if (bid) out = out.filter((r) => r["booking_id"] === bid);
        if (id) out = out.filter((r) => r["id"] === id);
        if (date) out = out.filter((r) => r["visit_date"] === date);
        if (visitNo) out = out.filter((r) => String(r["visit_no"]) === visitNo);
        const limit = Number(qs.get("limit") ?? "0") || out.length;
        return supRes(out.slice(0, limit));
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { visit_id?: string | null; booking_id?: string | null; event?: string; detail?: Record<string, unknown> };
          events.push({ visit_id: body.visit_id ?? null, booking_id: body.booking_id ?? null, event: body.event ?? "", detail: body.detail });
          return supRes([{ id: events.length }]);
        }
        let out = [...events];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const eq = (k: string) => {
          const v = qs.get(k);
          return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
        };
        const vid = eq("visit_id");
        const ev = eq("event");
        const bid = eq("booking_id");
        if (vid) out = out.filter((e) => e.visit_id === vid);
        if (ev) out = out.filter((e) => e.event === ev);
        if (bid) out = out.filter((e) => e.booking_id === bid);
        const limit = Number(qs.get("limit") ?? "0") || out.length;
        return supRes(out.slice(0, limit));
      }
      return supRes({}, false, 404);
    }));
  };

  const submitQuote = async (body: Record<string, unknown>) => {
    const r = res();
    await sendContactEmail({ method: "POST", headers: { origin: ORIGIN }, body } as never, r as never);
    return r;
  };

  const callAction = async (body: Record<string, unknown>) => {
    const r = res();
    await bookingAction(
      { method: "POST", headers: { authorization: "Bearer " + "adm-" + "secret" }, body } as never,
      r as never,
    );
    return r;
  };

  const seedRequestedVisit = (overrides: Row = {}) => {
    const row: Row = {
      id: "44444444-5555-6666-7777-888888888888",
      booking_id: "bid-owner-notify",
      visit_no: 1,
      status: "requested",
      report_status: "none",
      visit_date: serviceDate(),
      window: "morning",
      service: "Standard cleaning",
      client_name: "Test Client",
      client_email: "kolamicola@gmail.com",
      address: "123 Test Street, Sugar Hill, GA 30009",
      amount_cents: 149,
      is_test: true,
      ...overrides,
    };
    rows.push(row);
    return row;
  };

  beforeEach(() => {
    rows = [];
    events = [];
    resendCalls = [];
    resendQueue = [];
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends exactly one owner email for a new quote with a DB-backed visit row", async () => {
    const body = quoteBody();
    const r = await submitQuote(body);
    expect(r.code).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.ownerEmailSent).toBe(true);
    expect(r.body.customerEmailSent).toBe(true);
    // The row was created (the old gate skipped the email exactly here).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["status"]).toBe("requested");
    // Exactly one owner email, to the owner's mailbox (not mihas2596).
    const ownerCalls = resendCalls.filter((c) => c.to.includes(OWNER_EMAIL));
    expect(ownerCalls).toHaveLength(1);
    const owner = ownerCalls[0] as ResendCall;
    expect(owner.subject).toContain("New quote request");
    expect(owner.subject).toContain("Test Client");
    expect(owner.html).toContain("123 Test Street");
    expect(owner.html).toContain("Sugar Hill");
    expect(owner.html).toContain("Standard cleaning");
    expect(owner.html).toContain(body["date"] as string);
    expect(owner.html).toContain("Open request");
    expect(owner.html).toContain(OWNER_URL);
    // Journaled once, so /owner and the resend action can see it.
    const notified = events.filter((e) => e.event === "owner_notification");
    expect(notified).toHaveLength(1);
    expect(events.filter((e) => e.event === "owner_notification_failed")).toHaveLength(0);
  });

  it("does not send a second owner email when the same request is retried", async () => {
    const body = quoteBody();
    const first = await submitQuote(body);
    expect(first.code).toBe(200);
    const second = await submitQuote(body);
    expect(second.code).toBe(200);
    expect(second.body.ok).toBe(true);
    // The customer autoresponse goes out again, the owner notice does not.
    const ownerCalls = resendCalls.filter((c) => c.to.includes(OWNER_EMAIL));
    expect(ownerCalls).toHaveLength(1);
    expect(events.filter((e) => e.event === "owner_notification")).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it("a failed owner send still succeeds the booking and journals the failure", async () => {
    // First Resend call (owner) fails, second (customer) succeeds.
    resendQueue = [false, true];
    const r = await submitQuote(quoteBody());
    expect(r.code).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.ownerEmailSent).toBe(false);
    expect(r.body.customerEmailSent).toBe(true);
    expect(rows).toHaveLength(1);
    const failed = events.filter((e) => e.event === "owner_notification_failed");
    expect(failed).toHaveLength(1);
    expect(events.filter((e) => e.event === "owner_notification")).toHaveLength(0);
  });

  it("a failed owner notification can be recovered with the resend action", async () => {
    resendQueue = [false, true];
    const r = await submitQuote(quoteBody());
    expect(r.code).toBe(200);
    expect(events.some((e) => e.event === "owner_notification_failed")).toBe(true);
    const bookingId = r.body.booking_id as string;
    expect(bookingId).toBeTruthy();
    // The retry succeeds and journals the notice once.
    const retry = await callAction({ action: "resend_owner_notification", booking_id: bookingId });
    expect(retry.code).toBe(200);
    expect(retry.body.email_sent).toBe(true);
    const ownerCalls = resendCalls.filter((c) => c.to.includes(OWNER_EMAIL));
    expect(ownerCalls).toHaveLength(2);
    const resent = ownerCalls[1] as ResendCall;
    expect(resent.subject).toContain("Test Client");
    expect(resent.html).toContain("123 Test Street");
    expect(resent.html).toContain("Open request");
    expect(resent.html).toContain(OWNER_URL);
    expect(resent.key).toBe(`owner-resend/${bookingId}`);
    expect(events.filter((e) => e.event === "owner_notification")).toHaveLength(1);
  });

  it("resend_owner_notification sends the notice for a requested visit with no Stripe customer", async () => {
    const row = seedRequestedVisit();
    events.push({ visit_id: row["id"] as string, booking_id: row["booking_id"] as string, event: "client_contact", detail: { phone: "4045550100" } });
    const r = await callAction({ action: "resend_owner_notification", booking_id: row["booking_id"] as string });
    expect(r.code).toBe(200);
    expect(r.body.email_sent).toBe(true);
    expect(resendCalls).toHaveLength(1);
    const sent = resendCalls[0] as ResendCall;
    expect(sent.to).toEqual([OWNER_EMAIL]);
    expect(sent.subject).toContain("New quote request");
    expect(sent.subject).toContain("Test Client");
    expect(sent.html).toContain("123 Test Street, Sugar Hill, GA 30009");
    expect(sent.html).toContain("4045550100");
    expect(sent.html).toContain("Open request");
    expect(sent.html).toContain(OWNER_URL);
    expect(events.filter((e) => e.event === "owner_notification")).toHaveLength(1);
  });

  it("resend_owner_notification does not duplicate an already-sent notice", async () => {
    const row = seedRequestedVisit();
    events.push({ visit_id: row["id"] as string, booking_id: row["booking_id"] as string, event: "owner_notification", detail: { email_id: "email-1" } });
    const r = await callAction({ action: "resend_owner_notification", booking_id: row["booking_id"] as string });
    expect(r.code).toBe(200);
    expect(r.body.email_sent).toBe(false);
    expect(r.body.already).toBe(true);
    expect(resendCalls).toHaveLength(0);
    expect(events.filter((e) => e.event === "owner_notification")).toHaveLength(1);
  });

  it("resend_owner_notification refuses a cancelled visit", async () => {
    const row = seedRequestedVisit({ status: "cancelled" });
    const r = await callAction({ action: "resend_owner_notification", booking_id: row["booking_id"] as string });
    expect(r.code).toBe(409);
    expect(resendCalls).toHaveLength(0);
  });

  it("resend_owner_notification reports an unknown booking as not found", async () => {
    const r = await callAction({ action: "resend_owner_notification", booking_id: "bid-does-not-exist" });
    expect(r.code).toBe(404);
    expect(resendCalls).toHaveLength(0);
  });
});
