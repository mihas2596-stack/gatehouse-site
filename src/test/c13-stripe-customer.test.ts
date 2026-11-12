// @vitest-environment node
// C13 (09.11.2026): Stripe customer/card selection.
// - pickCustomerByEmail: exact email match only; booking-bound wins.
// - pickCard: card_confirmed wins, else cached-when-attached, else a
//   lone card; several cards with no booking signal is ambiguous.
// - report Approve with several cards and no card_confirmed event is
//   refused with card_confirmation_required and creates no intent;
//   a card_confirmed event (or a cached card) picks that card.
// - a customer search that returns a different email resolves to no
//   customer at all — the approve then 404s instead of charging a
//   stranger's card.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import reportHandler from "../../api/report";
import { signBooking } from "../../api/create-checkout-session";
import {
  pickCustomerByEmail,
  pickCard,
  confirmedPaymentMethodId,
  resolveCustomerByRowId,
} from "../../api/_stripe_customer";

const BID = "bid-c13";
const EMAIL = "client@example.com";
const ROW_ID = "99999999-8888-4777-6666-555555555555";

describe("pickCustomerByEmail (pure)", () => {
  const a = { id: "cus_a", email: EMAIL, metadata: { gh_booking_id: "bid-other" } };
  const b = { id: "cus_b", email: EMAIL, metadata: { gh_booking_id: BID } };
  const c = { id: "cus_c", email: "other@example.com", metadata: { gh_booking_id: BID } };

  it("prefers the customer bound to the booking among exact matches", () => {
    expect(pickCustomerByEmail([a, b], EMAIL, BID)).toBe(b);
    expect(pickCustomerByEmail([b, a], EMAIL, BID)).toBe(b);
  });

  it("returns the exact match when no booking binding exists", () => {
    expect(pickCustomerByEmail([a], EMAIL, BID)).toBe(a);
    expect(pickCustomerByEmail([a], EMAIL)).toBe(a);
  });

  it("is case-insensitive and rejects near matches", () => {
    expect(pickCustomerByEmail([a], "Client@Example.com", BID)).toBe(a);
    expect(pickCustomerByEmail([c], EMAIL, BID)).toBeNull();
    expect(pickCustomerByEmail([{ id: "cus_x", email: "client@example.com.evil.com", metadata: {} }], EMAIL, BID)).toBeNull();
    expect(pickCustomerByEmail([], EMAIL, BID)).toBeNull();
  });
});

describe("pickCard (pure)", () => {
  const cards = [{ id: "pm_1" }, { id: "pm_2" }];

  it("the booking's card_confirmed event wins", () => {
    expect(pickCard(cards, { confirmedPmId: "pm_2" })).toEqual({ status: "ok", pm: "pm_2" });
    expect(pickCard(cards, { confirmedPmId: "pm_2", cachedPmId: "pm_1" })).toEqual({ status: "ok", pm: "pm_2" });
  });

  it("a confirmed card that is no longer attached does not win", () => {
    expect(pickCard(cards, { confirmedPmId: "pm_gone" })).toEqual({ status: "ambiguous" });
    expect(pickCard([{ id: "pm_1" }], { confirmedPmId: "pm_gone" })).toEqual({ status: "ok", pm: "pm_1" });
  });

  it("the cached card wins when still attached, else a lone card", () => {
    expect(pickCard(cards, { cachedPmId: "pm_1" })).toEqual({ status: "ok", pm: "pm_1" });
    expect(pickCard([{ id: "pm_9" }], { cachedPmId: "pm_1" })).toEqual({ status: "ok", pm: "pm_9" });
  });

  it("several cards with no signal is ambiguous, none is none", () => {
    expect(pickCard(cards, {})).toEqual({ status: "ambiguous" });
    expect(pickCard([], {})).toEqual({ status: "none" });
  });

  it("confirmedPaymentMethodId reads the latest card_confirmed event", () => {
    const evs = [
      { event: "card_confirmed", detail: { payment_method_id: "pm_old" }, created_at: "2026-01-01" },
      { event: "report_sent", detail: {}, created_at: "2026-01-02" },
    ];
    expect(confirmedPaymentMethodId(evs)).toBe("pm_old");
    expect(confirmedPaymentMethodId([])).toBeNull();
    expect(confirmedPaymentMethodId([{ event: "card_confirmed", detail: { payment_method_id: "not-a-pm" }, created_at: "x" }])).toBeNull();
  });
});

describe("resolveCustomerByRowId (pure)", () => {
  const fetchOk = async (id: string) => ({
    ok: true,
    data: { id, email: EMAIL, name: "Casey", metadata: { gh_booking_id: BID } },
  });

  it("resolves the pinned customer when the email matches", async () => {
    const c = await resolveCustomerByRowId(fetchOk, "cus_row", EMAIL);
    expect(c?.id).toBe("cus_row");
  });

  it("refuses on email mismatch, missing record, or failed fetch", async () => {
    expect(await resolveCustomerByRowId(fetchOk, "cus_row", "other@example.com")).toBeNull();
    expect(await resolveCustomerByRowId(async () => ({ ok: false, data: {} }), "cus_row", EMAIL)).toBeNull();
    expect(await resolveCustomerByRowId(fetchOk, null, EMAIL)).toBeNull();
    expect(await resolveCustomerByRowId(async () => { throw new Error("boom"); }, "cus_row", EMAIL)).toBeNull();
  });
});

// ---------- report Approve handler tests ----------

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;
type Cust = { id: string; email: string; name: string; metadata: Record<string, string> };

let rows: Row[];
let evts: Evt[];
let customers: Cust[];
let searchResults: Cust[];
let cards: Array<{ id: string; card?: { brand: string; last4: string } }>;
let piCalls: Array<{ pm: string; id: string }>;

function res(code: number, body: unknown) {
  return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
}

function applyFilters<T extends Record<string, unknown>>(list: T[], u: URL): T[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === decodeURIComponent(v.slice(3)));
    if (v.startsWith("neq.")) out = out.filter((r) => r[k] !== null && r[k] !== undefined && String(r[k]) !== decodeURIComponent(v.slice(4)));
    if (v.startsWith("in.(") && v.endsWith(")")) {
      const set = new Set(v.slice(4, -1).split(","));
      out = out.filter((r) => set.has(String(r[k] ?? "")));
    }
  }
  if (u.searchParams.get("order")?.startsWith("created_at.desc")) {
    out.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

function parseForm(body: unknown): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  if (body && typeof body === "object") return new URLSearchParams(body as Record<string, string>);
  return new URLSearchParams();
}

async function fetchMock(url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) {
  const u = new URL(String(url));
  const method = (init?.method ?? "GET").toUpperCase();
  const host = u.hostname;

  if (host === "api.stripe.com") {
    if (u.pathname.includes("/customers/search")) {
      const q = u.searchParams.get("query") ?? "";
      // Booking binding (metadata) resolves only from `customers`;
      // the email search uses `searchResults` (configurable per test).
      if (q.includes("gh_booking_id")) {
        const bidM = q.match(/gh_booking_id'\]:'([^']+)'/);
        const found = customers.filter((c) => (bidM ? c.metadata["gh_booking_id"] === bidM[1] : true));
        return res(200, { data: found.map((c) => ({ ...c, metadata: c.metadata })) });
      }
      return res(200, { data: searchResults.map((c) => ({ ...c, metadata: c.metadata })) });
    }
    const custM = u.pathname.match(/^\/v1\/customers\/([^/]+)(\/payment_methods)?$/);
    if (custM) {
      const cust = customers.find((c) => c.id === custM[1]) ?? searchResults.find((c) => c.id === custM[1]);
      if (!cust) return res(404, { error: { message: "not found" } });
      if (custM[2]) return res(200, { data: cards });
      if (method === "GET") return res(200, { ...cust, metadata: cust.metadata });
      const params = parseForm(init?.body);
      for (const [k, v] of params.entries()) {
        const mm = k.match(/^metadata\[(.+)\]$/);
        if (mm) cust.metadata[mm[1]] = v;
      }
      return res(200, { ...cust, metadata: cust.metadata });
    }
    if (u.pathname === "/v1/payment_intents/search" && method === "GET") {
      return res(200, { data: [] });
    }
    if (u.pathname === "/v1/payment_intents" && method === "POST") {
      const params = parseForm(init?.body);
      const pm = params.get("payment_method") ?? "";
      const id = `pi_c13_${piCalls.length + 1}`;
      piCalls.push({ pm, id });
      return res(200, { id, status: "succeeded" });
    }
    return res(404, { error: { message: "stripe route not stubbed" } });
  }

  if (host === "api.resend.com") {
    return res(200, { id: "email_1" });
  }

  if (host.includes("supabase")) {
    const table = u.pathname.split("/").pop() ?? "";
    if (method === "GET") {
      if (table === "gh_visits") return res(200, applyFilters(rows, u));
      if (table === "gh_events") return res(200, applyFilters(evts, u));
      if (table === "gh_photos") return res(200, []);
      return res(200, []);
    }
    if (method === "POST") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (table === "gh_events") {
        const inserted = { ...body, created_at: new Date().toISOString() };
        evts.push(inserted);
        return res(201, [inserted]);
      }
      return res(201, [body]);
    }
    if (method === "PATCH") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const matched = applyFilters(rows, u);
      for (const target of matched) Object.assign(target, body);
      return res(200, matched);
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

async function call(handler: (req: unknown, res: unknown) => Promise<void> | void, req: Record<string, unknown>) {
  const r = response();
  await handler(req, r as never);
  return r;
}

function sentWorld(opts: { confirmedPm?: string | null; cachedPm?: string } = {}) {
  const sentAt = new Date(Date.now() - 3600 * 1000).toISOString();
  rows = [{
    id: ROW_ID, booking_id: BID, client_email: EMAIL, client_name: "Casey Client",
    status: "report_sent", report_status: "sent", amount_cents: 20000,
    visit_date: "2026-11-10", window: "midday",
    issue_open: false, issue_ever: false, report_bounced: false,
    report_sent_at: sentAt, receipt_email_id: null,
  }];
  customers = [{
    id: "cus_c13", email: EMAIL, name: "Casey Client",
    metadata: {
      gh_booking_id: BID, gh_state: "report_sent",
      gh_payment_method: opts.cachedPm ?? "",
      gh_first_price_cents: "20000", gh_report_sent_at: sentAt,
      gh_report_version: "1", gh_report_amount_cents: "20000",
    },
  }];
  searchResults = [...customers];
  evts = [
    { visit_id: ROW_ID, booking_id: BID, event: "report_sent", detail: { version: 1 }, created_at: sentAt },
  ];
  if (opts.confirmedPm) {
    evts.push({
      visit_id: ROW_ID, booking_id: BID, event: "card_confirmed",
      detail: { payment_method_id: opts.confirmedPm, brand: "visa", last4: "4242" },
      created_at: new Date(Date.now() - 1000).toISOString(),
    });
  }
  return sentAt;
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = []; evts = []; customers = []; searchResults = [];
  cards = [
    { id: "pm_card_1", card: { brand: "visa", last4: "1111" } },
    { id: "pm_card_2", card: { brand: "mastercard", last4: "2222" } },
  ];
  piCalls = [];
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("C13 report Approve card/customer selection", () => {
  it("several cards, none confirmed: approve is refused, no intent created", async () => {
    const sentAt = sentWorld();
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    const approve = await call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "approve", seen_publication_id: sentAt },
    });
    expect(approve.code).toBe(409);
    expect(approve.body["error"]).toBe("card_confirmation_required");
    expect(piCalls).toHaveLength(0);
    expect(rows[0]["status"]).toBe("report_sent");
    expect(customers[0].metadata["gh_payment_method"]).toBe("");
  });

  it("a card_confirmed event picks that card", async () => {
    const sentAt = sentWorld({ confirmedPm: "pm_card_2" });
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    const approve = await call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "approve", seen_publication_id: sentAt },
    });
    expect(approve.code).toBe(200);
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].pm).toBe("pm_card_2");
    expect(rows[0]["status"]).toBe("paid");
  });

  it("a cached card on file picks that card when nothing is confirmed", async () => {
    const sentAt = sentWorld({ cachedPm: "pm_card_1" });
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    const approve = await call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "approve", seen_publication_id: sentAt },
    });
    expect(approve.code).toBe(200);
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].pm).toBe("pm_card_1");
    expect(rows[0]["status"]).toBe("paid");
  });

  it("a single card on file charges it (no ambiguity)", async () => {
    cards = [{ id: "pm_only", card: { brand: "visa", last4: "9999" } }];
    const sentAt = sentWorld();
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    const approve = await call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "approve", seen_publication_id: sentAt },
    });
    expect(approve.code).toBe(200);
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].pm).toBe("pm_only");
  });

  it("email search returning a different email resolves to no customer", async () => {
    const sentAt = sentWorld();
    // No metadata binding: the booking search finds nothing, and the
    // email search returns a stranger's record.
    customers = [];
    searchResults = [{
      id: "cus_stranger", email: "stranger@example.com", name: "Stranger",
      metadata: { gh_booking_id: "bid-someone-else", gh_state: "report_sent" },
    }];
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    const approve = await call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "approve", seen_publication_id: sentAt },
    });
    expect(approve.code).toBe(404);
    expect(approve.body["error"]).toBe("booking_not_found");
    expect(piCalls).toHaveLength(0);
  });
});
