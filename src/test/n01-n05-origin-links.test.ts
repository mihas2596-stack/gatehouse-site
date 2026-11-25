// @vitest-environment node
// N-01 / N-05: cabinet links (bt/ct) and the Stripe return URLs are built
// from the request's own origin instead of a hardcoded production domain.
// Production behavior is unchanged (the request origin IS production
// there); a Vercel preview of this project keeps its links on the preview
// host, where the test visit actually lives. An unvalidated origin must
// never leak into an issued URL.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isAllowedOrigin,
  isPreviewOrigin,
  PRODUCTION_ORIGIN,
  siteBaseFromOrigin,
} from "../../api/_origin";
import { clientVisitLink } from "../../api/_booking_links";
import { cleanerLinkUrl, CLEANER_LINK_URL_BASE } from "../../api/_cleaner_link";
import { ownerPanelUrl, ownerRequestEmailBody } from "../../api/_owner_email";
import checkoutHandler, { signBooking } from "../../api/create-checkout-session";
import bookingActionHandler from "../../api/booking-action";

const PROD = "https://www.gatehousehomecleaning.com";
const PROD_BARE = "https://gatehousehomecleaning.com";
const PREVIEW_BRANCH = "https://gatehouse-site-git-review-gateh-188812-mihas2596-6172s-projects.vercel.app";
const PREVIEW_DEPLOY = "https://gatehouse-site-kn4f6jcud-mihas2596-6172s-projects.vercel.app";
const LOCAL = "http://localhost:8080";

const ALLOWED = [PROD_BARE, PROD, LOCAL];

describe("siteBaseFromOrigin", () => {
  it("returns the production origin itself on production requests", () => {
    expect(siteBaseFromOrigin(PROD, ALLOWED)).toBe(PROD);
    expect(siteBaseFromOrigin(PROD_BARE, ALLOWED)).toBe(PROD_BARE);
    expect(siteBaseFromOrigin(LOCAL, ALLOWED)).toBe(LOCAL);
  });

  it("returns a Vercel preview origin of this project unchanged", () => {
    expect(siteBaseFromOrigin(PREVIEW_BRANCH, ALLOWED)).toBe(PREVIEW_BRANCH);
    expect(siteBaseFromOrigin(PREVIEW_DEPLOY, ALLOWED)).toBe(PREVIEW_DEPLOY);
  });

  it("falls back to production for anything unvalidated", () => {
    expect(siteBaseFromOrigin("https://evil.example.com", ALLOWED)).toBe(PRODUCTION_ORIGIN);
    // Same project-name prefix on a foreign host is not a preview.
    expect(siteBaseFromOrigin("https://gatehouse-site-x.example.com", ALLOWED)).toBe(PRODUCTION_ORIGIN);
    // Production host over plain http is not an allowed origin.
    expect(siteBaseFromOrigin("http://gatehousehomecleaning.com", ALLOWED)).toBe(PRODUCTION_ORIGIN);
    expect(siteBaseFromOrigin(undefined, ALLOWED)).toBe(PRODUCTION_ORIGIN);
    expect(siteBaseFromOrigin(null, ALLOWED)).toBe(PRODUCTION_ORIGIN);
    expect(siteBaseFromOrigin(42, ALLOWED)).toBe(PRODUCTION_ORIGIN);
  });

  it("accepts an array origin (first value wins)", () => {
    expect(siteBaseFromOrigin([PREVIEW_BRANCH, PROD], ALLOWED)).toBe(PREVIEW_BRANCH);
    expect(siteBaseFromOrigin(["https://evil.example.com"], ALLOWED)).toBe(PRODUCTION_ORIGIN);
  });

  it("agrees with isAllowedOrigin / isPreviewOrigin", () => {
    expect(isPreviewOrigin(PREVIEW_BRANCH)).toBe(true);
    expect(isPreviewOrigin(PROD)).toBe(false);
    expect(isAllowedOrigin(PREVIEW_DEPLOY, ALLOWED)).toBe(true);
    expect(isAllowedOrigin("https://evil.example.com", ALLOWED)).toBe(false);
  });
});

describe("cabinet link builders", () => {
  const KEY = "test-stripe-key";
  const BOOKING = { bid: "bid-n01-n05", email: "client@example.com", name: "Casey Client" };

  it("clientVisitLink defaults to production and honors an explicit base", () => {
    expect(clientVisitLink(KEY, BOOKING)).toMatch(/^https:\/\/www\.gatehousehomecleaning\.com\/visit\?bt=v2\./);
    expect(clientVisitLink(KEY, BOOKING, "", PREVIEW_BRANCH)).toMatch(
      new RegExp(`^${PREVIEW_BRANCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/visit\\?bt=v2\\.`),
    );
    expect(clientVisitLink(KEY, BOOKING, "#report", PREVIEW_BRANCH)).toContain("#report");
  });

  it("cleanerLinkUrl defaults to production and honors an explicit base", () => {
    expect(cleanerLinkUrl("ct2.abc")).toBe(`${CLEANER_LINK_URL_BASE}?ct=ct2.abc`);
    expect(cleanerLinkUrl("ct2.abc", PREVIEW_BRANCH)).toBe(`${PREVIEW_BRANCH}/cleaner?ct=ct2.abc`);
  });

  it("ownerPanelUrl defaults to production, keeps the visit id, honors a base", () => {
    const visitId = "11111111-2222-3333-4444-555555555555";
    expect(ownerPanelUrl(visitId)).toBe(`${PROD}/owner?visit=${visitId}`);
    expect(ownerPanelUrl(visitId, PREVIEW_BRANCH)).toBe(`${PREVIEW_BRANCH}/owner?visit=${visitId}`);
    expect(ownerPanelUrl(null)).toBe(`${PROD}/owner`);
    // A malformed visit id never lands in the URL.
    expect(ownerPanelUrl("not-a-uuid")).toBe(`${PROD}/owner`);
  });

  it("ownerRequestEmailBody links the panel on the given base", () => {
    const notice = {
      visitId: "11111111-2222-3333-4444-555555555555",
      name: "Casey Client",
      email: "client@example.com",
      service: "Standard",
      date: "2026-11-26",
      amountCents: 149,
      bookingId: "bid-n01-n05",
      isTest: true,
    };
    expect(ownerRequestEmailBody(notice).text).toContain(`${PROD}/owner?visit=${notice.visitId}`);
    expect(ownerRequestEmailBody(notice, PREVIEW_BRANCH).text).toContain(
      `${PREVIEW_BRANCH}/owner?visit=${notice.visitId}`,
    );
  });
});

// --- create-checkout-session (N-01): success_url / cancel_url ----------

const LINK_SECRET = "test-link-secret-n01";
const BID = "bid-n01-checkout";

let sessionBody: URLSearchParams | null;

function checkoutRes() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

describe("create-checkout-session return URLs (N-01)", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("BOOKING_LINK_SECRET", LINK_SECRET);
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    sessionBody = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = new URL(String(url));
      const ok = (data: unknown) => ({
        ok: true, status: 200,
        json: async () => data, text: async () => JSON.stringify(data),
      });
      if (u.hostname.includes("supabase")) return ok([]);
      if (u.hostname === "api.stripe.com") {
        if (u.pathname === "/v1/customers" && (init?.method ?? "GET") === "GET") return ok({ data: [] });
        if (u.pathname === "/v1/customers" && (init?.method ?? "GET") === "POST") return ok({ id: "cus_new" });
        if (u.pathname === "/v1/checkout/sessions") {
          sessionBody = new URLSearchParams(String(init?.body ?? ""));
          return ok({ id: "cs_test_x", url: "https://checkout.stripe.com/pay/cs_test_x" });
        }
        if (u.pathname.startsWith("/v1/customers/")) return ok({ id: "cus_new" });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const token = () => signBooking(LINK_SECRET, {
    bid: BID, email: "client@example.com", name: "Casey Client",
  }).token;

  it("builds success_url/cancel_url on the preview host for a preview request", async () => {
    const res = checkoutRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await checkoutHandler({ method: "POST", headers: { origin: PREVIEW_BRANCH }, body: { bt: token() } } as any, res as any);
    expect(res.code).toBe(200);
    expect(sessionBody).not.toBeNull();
    expect(sessionBody?.get("success_url")).toMatch(new RegExp(`^${PREVIEW_BRANCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/save-card\\?saved=1`));
    expect(sessionBody?.get("cancel_url")).toBeDefined();
    expect(sessionBody?.get("cancel_url")).toMatch(new RegExp(`^${PREVIEW_BRANCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/save-card\\?canceled=1`));
  });

  it("builds success_url/cancel_url on production for a production request", async () => {
    const res = checkoutRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await checkoutHandler({ method: "POST", headers: { origin: PROD }, body: { bt: token() } } as any, res as any);
    expect(res.code).toBe(200);
    expect(sessionBody?.get("success_url")).toMatch(/^https:\/\/www\.gatehousehomecleaning\.com\/save-card\?saved=1/);
    expect(sessionBody?.get("cancel_url")).toMatch(/^https:\/\/www\.gatehousehomecleaning\.com\/save-card\?canceled=1/);
  });

  it("defaults to production with no origin header", async () => {
    const res = checkoutRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await checkoutHandler({ method: "POST", headers: {}, body: { bt: token() } } as any, res as any);
    expect(res.code).toBe(200);
    expect(sessionBody?.get("success_url")).toMatch(/^https:\/\/www\.gatehousehomecleaning\.com\/save-card\?saved=1/);
  });
});

// --- booking-action (N-05): client_link / preview_link / confirm email --

const CUSTOMER = {
  id: "cus_test_1",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "card_ready", gh_first_price_cents: "18900" },
};

function bookingRes() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

describe("booking-action cabinet links (N-05)", () => {
  let resendCalls: unknown[];
  let currentMeta: Record<string, string>;

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    resendCalls = [];
    currentMeta = { ...CUSTOMER.metadata };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown }) => {
      const u = String(url);
      if (u.includes("/customers/search")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ ...CUSTOMER, metadata: currentMeta }] }) };
      }
      if (u.includes("api.resend.com")) {
        resendCalls.push(init?.body);
        return { ok: true, status: 200, json: async () => ({ id: "email-1" }) };
      }
      if (u.endsWith(`/customers/${CUSTOMER.id}`) && init?.body) {
        return { ok: true, status: 200, json: async () => ({ id: CUSTOMER.id }) };
      }
      if (u.endsWith(`/customers/${CUSTOMER.id}`)) {
        return { ok: true, status: 200, json: async () => ({ ...CUSTOMER, metadata: currentMeta }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const call = (body: Record<string, unknown>, origin?: string) => {
    const res = bookingRes();
    const req = {
      method: "POST",
      headers: { authorization: "Bearer " + "adm-" + "secret", ...(origin ? { origin } : {}) },
      body,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return bookingActionHandler(req as any, res as any).then(() => res);
  };

  it("client_link returns the visit URL on the preview host", async () => {
    const res = await call({ action: "client_link", booking_id: BID }, PREVIEW_BRANCH);
    expect(res.code).toBe(200);
    expect(typeof res.body["url"]).toBe("string");
    expect(res.body["url"] as string).toMatch(
      new RegExp(`^${PREVIEW_BRANCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/visit\\?bt=`),
    );
  });

  it("client_link returns the production visit URL for a production request", async () => {
    const res = await call({ action: "client_link", booking_id: BID }, PROD);
    expect(res.code).toBe(200);
    expect(res.body["url"] as string).toMatch(/^https:\/\/www\.gatehousehomecleaning\.com\/visit\?bt=/);
  });

  it("preview_link returns report/visit URLs on the preview host", async () => {
    const res = await call({ action: "preview_link", booking_id: BID }, PREVIEW_DEPLOY);
    expect(res.code).toBe(200);
    expect(res.body["report_url"] as string).toMatch(
      new RegExp(`^${PREVIEW_DEPLOY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/report\\?bt=`),
    );
    expect(res.body["visit_url"] as string).toMatch(
      new RegExp(`^${PREVIEW_DEPLOY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/visit\\?bt=`),
    );
  });
});
