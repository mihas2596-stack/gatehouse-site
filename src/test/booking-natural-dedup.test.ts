// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { bidFromRequestId, isNaturalDuplicate, NATURAL_DEDUP_WINDOW_MS } from "../../api/send-contact-email";

// Natural-key dedup (L2): the request_id dedup (bidFromRequestId) only
// covers retries from the SAME tab. A resubmission from a new tab or
// browser carries a fresh request_id, so the server must also dedup by
// natural key (email + date + service + address + window + amount).
// An intentional second visit sends force_new_booking to bypass it.

const origin = "https://www.gatehousehomecleaning.com";

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;

let rows: Row[];
let evts: Evt[];
let resendCalls: { key: string | null }[];

function res(code: number, body: unknown) {
  return {
    ok: code >= 200 && code < 300,
    status: code,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function applyFilters<T extends Record<string, unknown>>(list: T[], u: URL): T[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === decodeURIComponent(v.slice(3)));
    if (v.startsWith("neq.")) out = out.filter((r) => String(r[k] ?? "") !== decodeURIComponent(v.slice(4)));
  }
  if (u.searchParams.get("order")?.startsWith("created_at.desc")) {
    out.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

async function fetchMock(url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) {
  const u = new URL(String(url));
  const method = (init?.method ?? "GET").toUpperCase();
  const host = u.hostname;

  if (host === "api.stripe.com") {
    // No customer on file: cardOnFile stays false.
    return res(200, { data: [] });
  }

  if (host === "api.resend.com") {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    resendCalls.push({ key: headers["Idempotency-Key"] ?? null });
    return res(200, { id: "email_1" });
  }

  if (host.includes("supabase")) {
    const table = u.pathname.split("/").pop() ?? "";
    if (method === "GET") {
      if (table === "gh_visits") return res(200, applyFilters(rows, u));
      if (table === "gh_events") return res(200, applyFilters(evts, u));
      return res(200, []);
    }
    if (method === "POST") {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Row) : (init?.body as Row);
      if (table === "gh_visits") {
        // Enforce the unique (booking_id, visit_no) constraint: a
        // conflicting insert fails so the caller re-reads the winner.
        const clash = rows.some((r) => r["booking_id"] === body["booking_id"] && r["visit_no"] === body["visit_no"]);
        if (clash) return res(409, { message: "duplicate key value violates unique constraint" });
        const row = { ...body, id: crypto.randomUUID(), created_at: new Date().toISOString() };
        rows.push(row);
        return res(201, [row]);
      }
      if (table === "gh_events") {
        const evt = { ...body, id: evts.length + 1, created_at: new Date().toISOString() };
        evts.push(evt);
        return res(201, [evt]);
      }
      return res(201, [body]);
    }
  }
  return res(404, { error: { message: "route not stubbed" } });
}

function response() {
  const r = {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(), end: vi.fn(),
  };
  return r;
}

const baseBody = {
  website: "",
  name: "Dedup Test",
  phone: "4045550100",
  email: "client@example.com",
  service: "Standard",
  date: "2099-12-01",
  time: "",
  message: "3 BR · 2 full BA · ZIP 30024",
  notes: "Please ring the doorbell",
  founding: false,
  bedrooms: "3",
  bathrooms: "2",
  zip: "30024",
  address: "1 Example Street",
  city: "Alpharetta",
  state: "GA",
  price: "189",
  frequency: "every2weeks",
  service_key: "standard",
  cleaned_recently: true,
  addons: { insideOven: false, insideFridge: false, insideCabinets: false, interiorWindows: 0, pets: false },
  recurring: "189",
  source: "quote",
  terms_consent: true,
  photo_consent: true,
  sms_consent: false,
};

async function submit(body: Record<string, unknown>) {
  const r = response();
  await handler({ method: "POST", headers: { origin }, body }, r);
  return r;
}

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "test-resend-key");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_for_signing_only");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret-for-tests");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [];
  evts = [];
  resendCalls = [];
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("isNaturalDuplicate", () => {
  const key = {
    email: "client@example.com", date: "2099-12-01", service: "Standard",
    address: "1 example street", window: "", amountCents: 150,
  };
  const row = {
    id: "row-1", booking_id: "bid-1", client_name: "Dedup Test",
    client_email: "client@example.com", visit_date: "2099-12-01", service: "Standard",
    address: "1 Example Street", window: null, amount_cents: 150,
    status: "requested", created_at: new Date().toISOString(),
  };
  it("matches an identical recent booking (case-insensitive email/address)", () => {
    expect(isNaturalDuplicate(key, row)).toBe(true);
  });
  it("does not match a cancelled visit (re-booking after cancellation is new)", () => {
    expect(isNaturalDuplicate(key, { ...row, status: "cancelled" })).toBe(false);
  });
  it("does not match a different date, service, address, window or amount", () => {
    expect(isNaturalDuplicate(key, { ...row, visit_date: "2099-12-02" })).toBe(false);
    expect(isNaturalDuplicate(key, { ...row, service: "Deep cleaning" })).toBe(false);
    expect(isNaturalDuplicate(key, { ...row, address: "2 Other Street" })).toBe(false);
    expect(isNaturalDuplicate(key, { ...row, window: "morning" })).toBe(false);
    expect(isNaturalDuplicate(key, { ...row, amount_cents: 18900 })).toBe(false);
  });
  it("does not match a booking older than the window", () => {
    const old = new Date(Date.now() - NATURAL_DEDUP_WINDOW_MS - 1000).toISOString();
    expect(isNaturalDuplicate(key, { ...row, created_at: old })).toBe(false);
    const fresh = new Date(Date.now() - NATURAL_DEDUP_WINDOW_MS + 60_000).toISOString();
    expect(isNaturalDuplicate(key, { ...row, created_at: fresh })).toBe(true);
  });
});

describe("booking submit natural-key dedup", () => {
  it("a new-tab resubmission (fresh request_id, identical content) returns the existing booking, no second row, no second email", async () => {
    const first = await submit({ ...baseBody, request_id: "11111111-2222-4333-8444-555555555555" });
    expect(first.code).toBe(200);
    expect(first.body.booking_id).toBe(bidFromRequestId("11111111-2222-4333-8444-555555555555"));
    expect(rows).toHaveLength(1);
    expect(resendCalls).toHaveLength(2); // owner notice + customer confirmation

    // New tab: fresh request_id, byte-identical content.
    const second = await submit({ ...baseBody, request_id: "99999999-8888-4777-8666-555555555555" });
    expect(second.code).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.booking_id).toBe(first.body.booking_id);
    expect(second.body.bt).toBeTruthy();
    expect(second.body.bt).not.toBe(first.body.bt); // fresh token, same booking
    expect(rows).toHaveLength(1);
    expect(resendCalls).toHaveLength(2); // no second email
    expect(evts.filter((e) => e["event"] === "visit_created")).toHaveLength(1);
  });

  it("different content (another date) creates a second booking", async () => {
    const first = await submit({ ...baseBody, request_id: "11111111-2222-4333-8444-555555555555" });
    expect(first.code).toBe(200);
    const second = await submit({ ...baseBody, request_id: "99999999-8888-4777-8666-555555555555", date: "2099-12-02" });
    expect(second.code).toBe(200);
    expect(second.body.duplicate).toBeUndefined();
    expect(second.body.booking_id).not.toBe(first.body.booking_id);
    expect(rows).toHaveLength(2);
  });

  it("force_new_booking creates a second booking for identical content", async () => {
    const first = await submit({ ...baseBody, request_id: "11111111-2222-4333-8444-555555555555" });
    expect(first.code).toBe(200);
    const second = await submit({ ...baseBody, request_id: "99999999-8888-4777-8666-555555555555", force_new_booking: true });
    expect(second.code).toBe(200);
    expect(second.body.duplicate).toBeUndefined();
    expect(second.body.booking_id).not.toBe(first.body.booking_id);
    expect(second.body.booking_id).not.toBe(bidFromRequestId("99999999-8888-4777-8666-555555555555"));
    expect(rows).toHaveLength(2);
  });

  it("an identical booking after a cancellation creates a new booking", async () => {
    const first = await submit({ ...baseBody, request_id: "11111111-2222-4333-8444-555555555555" });
    expect(first.code).toBe(200);
    rows[0]["status"] = "cancelled";
    const second = await submit({ ...baseBody, request_id: "99999999-8888-4777-8666-555555555555" });
    expect(second.code).toBe(200);
    expect(second.body.duplicate).toBeUndefined();
    expect(second.body.booking_id).not.toBe(first.body.booking_id);
    expect(rows).toHaveLength(2);
  });

  it("an identical booking older than the window creates a new booking", async () => {
    const first = await submit({ ...baseBody, request_id: "11111111-2222-4333-8444-555555555555" });
    expect(first.code).toBe(200);
    rows[0]["created_at"] = new Date(Date.now() - NATURAL_DEDUP_WINDOW_MS - 1000).toISOString();
    const second = await submit({ ...baseBody, request_id: "99999999-8888-4777-8666-555555555555" });
    expect(second.code).toBe(200);
    expect(second.body.duplicate).toBeUndefined();
    expect(second.body.booking_id).not.toBe(first.body.booking_id);
    expect(rows).toHaveLength(2);
  });

  it("a same-request_id retry does not duplicate the visit row or the journal note", async () => {
    const first = await submit({ ...baseBody, request_id: "11111111-2222-4333-8444-555555555555" });
    expect(first.code).toBe(200);
    const second = await submit({ ...baseBody, request_id: "11111111-2222-4333-8444-555555555555" });
    expect(second.code).toBe(200);
    expect(second.body.booking_id).toBe(first.body.booking_id);
    expect(rows).toHaveLength(1);
    expect(evts.filter((e) => e["event"] === "client_note")).toHaveLength(1);
    expect(evts.filter((e) => e["event"] === "visit_created")).toHaveLength(1);
  });

  it("a same-request_id retry does not duplicate a scope_review event", async () => {
    const body = { ...baseBody, scope_review: true, scope_reasons: "large home" };
    const first = await submit({ ...body, request_id: "11111111-2222-4333-8444-555555555555" });
    expect(first.code).toBe(200);
    const second = await submit({ ...body, request_id: "11111111-2222-4333-8444-555555555555" });
    expect(second.code).toBe(200);
    expect(evts.filter((e) => e["event"] === "scope_review")).toHaveLength(1);
  });
});
