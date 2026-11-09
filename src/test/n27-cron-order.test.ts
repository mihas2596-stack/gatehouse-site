// @vitest-environment node
// N27: the cron must not let due charges starve behind an arbitrary
// Stripe-search order or a capped DB pass. Candidates run oldest
// report first, the Stripe search is paged, and the DB pass walks
// report_sent_at-ascending pages instead of stopping at the first 50.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import autoChargeHandler, { sortCandidatesOldestFirst } from "../../api/auto-charge";

const CRON = "cron-secret";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

describe("sortCandidatesOldestFirst", () => {
  it("orders by report_sent_at ascending, undated last", () => {
    const t40 = hoursAgo(40);
    const t30 = hoursAgo(30);
    const t25 = hoursAgo(25);
    const mk = (sent: string | undefined) => ({
      id: "cus", email: "c@example.com", metadata: { gh_booking_id: "b", ...(sent ? { gh_report_sent_at: sent } : {}) },
    });
    const out = sortCandidatesOldestFirst([
      mk(t25), mk(undefined), mk(t40), mk(t30),
    ]);
    expect(out.map((c) => c.metadata["gh_report_sent_at"] ?? "none")).toEqual([
      t40, t30, t25, "none",
    ]);
  });
});

describe("DB pass pagination", () => {
  let offsets: number[];
  let searchPages: string[];

  function res() {
    return {
      code: 0, body: {} as Record<string, unknown>,
      status(code: number) { this.code = code; return this; },
      json(body: Record<string, unknown>) { this.body = body; },
      setHeader: vi.fn(), end: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    offsets = [];
    searchPages = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(String(url));
      const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
      if (u.hostname === "api.stripe.com") {
        if (u.pathname.endsWith("/customers/search")) {
          // Only state searches count — findCustomerByEmail lookups
          // (email:'…') also hit this endpoint.
          if ((u.searchParams.get("query") ?? "").includes("gh_state")) {
            searchPages.push(u.searchParams.get("page") ?? "(first)");
          }
          return okRes({ data: [] });
        }
        return okRes({ data: [] });
      }
      if (u.hostname.includes("supabase")) {
        // 120 sent reports; the mock honours offset/limit like PostgREST.
        if (u.searchParams.get("report_status") === "eq.sent") {
          const offset = parseInt(u.searchParams.get("offset") ?? "0", 10);
          const limit = parseInt(u.searchParams.get("limit") ?? "50", 10);
          offsets.push(offset);
          const rows = Array.from({ length: 120 }, (_, i) => ({
            id: `row-${i}`, booking_id: `bid-${i}`, status: "report_sent",
            amount_cents: 14900, client_email: `client-${i}@example.com`,
            report_sent_at: hoursAgo(30 + i), report_bounced: false, report_status: "sent",
          }));
          return okRes(rows.slice(offset, offset + limit));
        }
        return okRes([]);
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("walks every DB page oldest-first instead of stopping at 50", async () => {
    const r = res();
    await autoChargeHandler({ method: "GET", headers: { authorization: `Bearer ${CRON}` } }, r as never);
    expect(r.code).toBe(200);
    // 120 rows at 50/page: offsets 0, 50, 100 (the last page is short).
    expect(offsets).toEqual([0, 50, 100]);
    // Three single-page state searches ran (report_sent for the main
    // pass, paid for the receipt-retry and retention passes) and each
    // found nothing — no list fallback, no next_page walk.
    expect(searchPages).toEqual(["(first)", "(first)", "(first)"]);
  });
});
