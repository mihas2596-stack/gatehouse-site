// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendReceiptEmailOnce } from "../../api/booking-action";

// RA18: the cleaning receipt is claimed on the row BEFORE sending.
// Two concurrent sends must yield one Resend message; a stale lease
// is stolen; a DB error fails closed; a retry after an ambiguous
// Resend outcome replays the original message via the stable
// idempotency key instead of delivering a second receipt.

const BID = "bid-ra18-1";
const ROW_ID = "77777777-7777-4777-8777-777777777777";
const CUST_ID = "cus_ra18_1";

type Row = Record<string, unknown>;

let rows: Row[];
let resendPosts: { key: string | null; id: string }[];
let resendByKey: Map<string, string>;
let deliveredCount: number;
let resendSeq: number;
let blockResend: Promise<void> | null;
let resendReached: boolean;
let failClaimPatch: boolean;
let failFinalWrite: boolean;

function res(code: number, body: unknown) {
  return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
}

function parseForm(body: unknown): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  if (body && typeof body === "object") return new URLSearchParams(body as Record<string, string>);
  return new URLSearchParams();
}

function matchRow(r: Row, u: URL): boolean {
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (v.startsWith("eq.")) {
      if (String(r[k] ?? "") !== decodeURIComponent(v.slice(3))) return false;
    } else if (v === "is.null") {
      if (r[k] !== null && r[k] !== undefined) return false;
    }
  }
  return true;
}

async function fetchMock(url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) {
  const u = new URL(String(url));
  const method = (init?.method ?? "GET").toUpperCase();
  const host = u.hostname;

  if (host === "api.stripe.com") {
    const custM = u.pathname.match(/^\/v1\/customers\/([^/]+)$/);
    if (custM) {
      if (method === "GET") {
        return res(200, { id: CUST_ID, email: "client@example.com", name: "Casey Client", metadata: {} });
      }
      return res(200, { id: CUST_ID });
    }
    return res(404, { error: { message: "stripe route not stubbed" } });
  }

  if (host === "api.resend.com") {
    if (blockResend) {
      resendReached = true;
      await blockResend;
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers["Idempotency-Key"] ?? headers["idempotency-key"] ?? null;
    if (key && resendByKey.has(key)) {
      // Idempotent replay: the original message, no new delivery.
      const id = resendByKey.get(key)!;
      resendPosts.push({ key, id });
      return res(200, { id });
    }
    resendSeq += 1;
    const id = `email_${resendSeq}`;
    if (key) resendByKey.set(key, id);
    deliveredCount += 1;
    resendPosts.push({ key, id });
    return res(200, { id });
  }

  if (host.includes("supabase")) {
    const table = u.pathname.split("/").pop() ?? "";
    if (method === "GET" && table === "gh_visits") {
      const out = rows.filter((r) => matchRow(r, u));
      const limit = u.searchParams.get("limit");
      return res(200, limit ? out.slice(0, parseInt(limit, 10)) : out);
    }
    if (method === "PATCH" && table === "gh_visits") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const isClaim = typeof body.receipt_email_id === "string" && body.receipt_email_id.startsWith("claim:");
      if (failClaimPatch && isClaim) return res(500, { error: { message: "db down" } });
      if (failFinalWrite && !isClaim && body.receipt_email_id) return res(500, { error: { message: "db down" } });
      const matched = rows.filter((r) => matchRow(r, u));
      for (const target of matched) Object.assign(target, body);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const prefer = headers["Prefer"] ?? headers["prefer"] ?? "";
      return res(200, prefer.includes("return=representation") ? matched : {});
    }
  }
  return res(404, { error: { message: "route not stubbed" } });
}

const META = { gh_report_amount_cents: "20000", gh_first_price_cents: "20000" };

async function waitFor(flag: () => boolean, label: string) {
  for (let i = 0; i < 200 && !flag(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(flag()).toBe(true);
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [{ id: ROW_ID, booking_id: BID, visit_no: 1, receipt_email_id: null }];
  resendPosts = []; resendByKey = new Map(); deliveredCount = 0; resendSeq = 0;
  blockResend = null; resendReached = false;
  failClaimPatch = false; failFinalWrite = false;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("RA18 receipt claim", () => {
  it("two concurrent sends deliver exactly one receipt", async () => {
    let release!: () => void;
    blockResend = new Promise<void>((r) => { release = r; });
    const firstP = sendReceiptEmailOnce("sk_test_x", CUST_ID, { ...META }, BID);
    await waitFor(() => resendReached, "winner parked at Resend");
    // The winner holds the lease; the loser must not send. Nothing
    // is delivered yet — the winner is still parked inside Resend.
    const loser = await sendReceiptEmailOnce("sk_test_x", CUST_ID, { ...META }, BID);
    expect(loser).toBe(false);
    expect(deliveredCount).toBe(0);
    release();
    const winner = await firstP;
    expect(winner).toBe(true);
    expect(deliveredCount).toBe(1);
    expect(rows[0]["receipt_email_id"]).toBe("email_1");
    // A later call sees the real id and sends nothing more.
    const later = await sendReceiptEmailOnce("sk_test_x", CUST_ID, { ...META }, BID);
    expect(later).toBe(true);
    expect(deliveredCount).toBe(1);
    expect(resendPosts[0].key).toBe(`gh-receipt-${BID}`);
  });

  it("a stale lease is stolen and the send completes", async () => {
    rows[0]["receipt_email_id"] = `claim:${Date.now() - 10 * 60 * 1000}`;
    const ok = await sendReceiptEmailOnce("sk_test_x", CUST_ID, { ...META }, BID);
    expect(ok).toBe(true);
    expect(deliveredCount).toBe(1);
    expect(rows[0]["receipt_email_id"]).toBe("email_1");
  });

  it("a claim DB error fails closed: no send, marker untouched", async () => {
    failClaimPatch = true;
    const ok = await sendReceiptEmailOnce("sk_test_x", CUST_ID, { ...META }, BID);
    expect(ok).toBe(false);
    expect(deliveredCount).toBe(0);
    expect(rows[0]["receipt_email_id"]).toBeNull();
  });

  it("ambiguous outcome replays the original message, no second delivery", async () => {
    // First send: Resend delivers, but the final row write fails, so
    // the lease stays on the row.
    failFinalWrite = true;
    const first = await sendReceiptEmailOnce("sk_test_x", CUST_ID, { ...META }, BID);
    expect(first).toBe(true);
    expect(deliveredCount).toBe(1);
    expect(String(rows[0]["receipt_email_id"]).startsWith("claim:")).toBe(true);
    // Ten minutes later the lease is stale; the retry steals it and
    // re-sends with the same idempotency key — Resend replays the
    // original message instead of delivering a second receipt.
    failFinalWrite = false;
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 10 * 60 * 1000);
    const retry = await sendReceiptEmailOnce("sk_test_x", CUST_ID, { ...META }, BID);
    expect(retry).toBe(true);
    expect(deliveredCount).toBe(1);
    expect(rows[0]["receipt_email_id"]).toBe("email_1");
  });
});
