// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import visitHandler from "../../api/visit";
import { signBooking } from "../../api/create-checkout-session";

// RA16: accept_alt_date must write the row FIRST and fail closed.
// A failed row write used to return 200 after meta + event were
// already written, so the client saw a confirmed date the cleaner
// and owner views never received. Order is asserted on the wire:
// row PATCH, then journal POST, then customer meta POST.

const BID = "bid-ra16-1";
const EMAIL = "client@example.com";
const ROW_ID = "66666666-6666-4666-8666-666666666666";

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;

let rows: Row[];
let evts: Evt[];
let custMeta: Record<string, string>;
let resendCount: number;
let callOrder: string[];
let failRowPatch: boolean;
let failMetaPost: boolean;

function res(code: number, body: unknown) {
  return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
}

function parseForm(body: unknown): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  if (body && typeof body === "object") return new URLSearchParams(body as Record<string, string>);
  return new URLSearchParams();
}

async function fetchMock(url: string, init?: { method?: string; body?: unknown }) {
  const u = new URL(String(url));
  const method = (init?.method ?? "GET").toUpperCase();
  const host = u.hostname;

  if (host === "api.stripe.com") {
    if (u.pathname.includes("/customers/search")) {
      return res(200, { data: [{ id: "cus_ra16_1", email: EMAIL, name: "Casey Client", metadata: { ...custMeta } }] });
    }
    const custM = u.pathname.match(/^\/v1\/customers\/([^/]+)(\/payment_methods)?$/);
    if (custM) {
      if (custM[2]) return res(200, { data: [{ id: "pm_ra16_1", type: "card" }] });
      if (method === "GET") return res(200, { id: "cus_ra16_1", email: EMAIL, name: "Casey Client", metadata: { ...custMeta } });
      const params = parseForm(init?.body);
      if (failMetaPost && params.get("metadata[gh_confirmed_date]")) {
        return res(500, { error: { message: "stripe down" } });
      }
      callOrder.push("meta-post");
      for (const [k, v] of params.entries()) {
        const mm = k.match(/^metadata\[(.+)\]$/);
        if (mm) custMeta[mm[1]] = v;
      }
      return res(200, { id: "cus_ra16_1", metadata: { ...custMeta } });
    }
    return res(404, { error: { message: "stripe route not stubbed" } });
  }

  if (host === "api.resend.com") {
    resendCount += 1;
    return res(200, { id: `email_${resendCount}` });
  }

  if (host.includes("supabase")) {
    const table = u.pathname.split("/").pop() ?? "";
    if (method === "GET") {
      if (table === "gh_visits") {
        const bid = u.searchParams.get("booking_id");
        const out = rows.filter((r) => (bid?.startsWith("eq.") ? r["booking_id"] === bid.slice(3) : true));
        return res(200, out);
      }
      if (table === "gh_events") {
        const vid = u.searchParams.get("visit_id");
        const out = evts.filter((e) => (vid?.startsWith("eq.") ? e["visit_id"] === vid.slice(3) : true));
        return res(200, out);
      }
      return res(200, []);
    }
    if (method === "POST" && table === "gh_events") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      callOrder.push(`event-post:${String(body.event ?? "")}`);
      evts.push({ ...body, created_at: new Date().toISOString() });
      return res(201, [{ id: evts.length }]);
    }
    if (method === "PATCH" && table === "gh_visits") {
      if (failRowPatch) return res(500, { error: { message: "db down" } });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      callOrder.push("row-patch");
      for (const r of rows) Object.assign(r, body);
      return res(200, rows);
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

function declinedWorld() {
  rows = [{
    id: ROW_ID, booking_id: BID, client_email: EMAIL, client_name: "Casey Client",
    status: "confirmed", report_status: "none", amount_cents: 20000,
    visit_date: "2027-02-05", window: "morning",
    issue_open: false, issue_ever: false, report_bounced: false, report_sent_at: null,
  }];
  evts = [{
    visit_id: ROW_ID, booking_id: BID, event: "date_proposed",
    detail: { alt_dates: "2027-02-10,2027-02-11" },
    created_at: new Date(Date.now() - 60000).toISOString(),
  }];
  custMeta = {
    gh_booking_id: BID, gh_state: "card_ready", gh_payment_method: "pm_ra16_1",
    gh_first_price_cents: "20000",
  };
}

function bt() {
  return signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
}

async function accept(date: string) {
  const r = response();
  await visitHandler({ method: "POST", headers: {}, body: { bt: bt(), action: "accept_alt_date", date } }, r as never);
  return r;
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = []; evts = []; custMeta = {}; resendCount = 0; callOrder = [];
  failRowPatch = false; failMetaPost = false;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("RA16 accept_alt_date writes the row first", () => {
  it("row PATCH 500: 502, no meta change, no event, no notification", async () => {
    declinedWorld();
    failRowPatch = true;
    const r = await accept("2027-02-10");
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_error");
    expect(custMeta["gh_state"]).toBe("card_ready");
    expect(custMeta["gh_confirmed_date"]).toBeUndefined();
    expect(evts.filter((e) => e.event === "visit_confirmed")).toHaveLength(0);
    expect(resendCount).toBe(0);
    expect(rows[0]["visit_date"]).toBe("2027-02-05");
  });

  it("success writes row, then event, then meta, in that order", async () => {
    declinedWorld();
    const r = await accept("2027-02-10");
    expect(r.code).toBe(200);
    expect(rows[0]["visit_date"]).toBe("2027-02-10");
    expect(evts.filter((e) => e.event === "visit_confirmed")).toHaveLength(1);
    expect(custMeta["gh_confirmed_date"]).toBe("2027-02-10");
    expect(custMeta["gh_state"]).toBe("card_ready");
    expect(callOrder).toEqual(["row-patch", "event-post:visit_confirmed", "meta-post"]);
  });

  it("meta POST 500: 502, and the retry succeeds (state still declined)", async () => {
    declinedWorld();
    failMetaPost = true;
    const failed = await accept("2027-02-10");
    expect(failed.code).toBe(502);
    expect(failed.body["error"]).toBe("stripe_error");
    // The row already carries the new date, but nothing told the
    // client it succeeded: meta still offers the alternatives, so
    // the same accept retries cleanly.
    expect(rows[0]["visit_date"]).toBe("2027-02-10");
    expect(custMeta["gh_state"]).toBe("card_ready");
    expect(custMeta["gh_confirmed_date"]).toBeUndefined();
    failMetaPost = false;
    callOrder = [];
    const retry = await accept("2027-02-10");
    expect(retry.code).toBe(200);
    expect(custMeta["gh_confirmed_date"]).toBe("2027-02-10");
    // Replay heals only the shared metadata: no second journal
    // event, no second row write, one owner notification total.
    expect(evts.filter((e) => e.event === "visit_confirmed")).toHaveLength(1);
    expect(callOrder).toEqual(["meta-post"]);
    expect(resendCount).toBe(1);
  });
});
