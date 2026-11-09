// @vitest-environment node
// C9: the status action returns the card brand/last4, not just
// payment_method: saved|none. A live Stripe card wins; for a paid
// booking whose card is gone (detached after payment) the card that
// paid is recovered from this booking's card_confirmed journal event,
// and payment_method stays "saved" instead of lying "none".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/booking-action";

const BID = "bid-c9-status-card";
const VISIT_ID = "c9c9c9c9-6666-7777-8888-999999999999";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let row: Row;
let events: Ev[];
let storeMeta: Record<string, string>;
let liveCards: { id: string; card?: { brand: string; last4: string } }[];

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

const call = async () => {
  const r = res();
  await handler(
    { method: "POST", headers: { authorization: "Bearer adm-secret" }, body: { action: "status", booking_id: BID } },
    r as never,
  );
  return r;
};

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  row = {
    id: VISIT_ID, booking_id: BID, status: "report_sent", amount_cents: 20000,
    cleaner_name: null, client_email: "client@example.com",
    report_sent_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
    report_bounced: false, report_status: "sent", visit_date: "2027-01-15", window: "midday",
  };
  events = [];
  storeMeta = {
    gh_booking_id: BID, gh_state: "report_sent",
    gh_report_amount_cents: "20000", gh_first_price_cents: "20000",
  };
  liveCards = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        return okRes({ data: [{ id: "cus_c9", email: "client@example.com", name: "Casey Client", metadata: storeMeta }] });
      }
      const pmSingle = /^\/v1\/payment_methods\/(pm_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (pmSingle) {
        const found = liveCards.find((c) => c.id === pmSingle[1]);
        if (!found) return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
        return okRes({ id: found.id, card: found.card ?? null });
      }
      if (u.pathname.includes("/payment_methods")) return okRes({ data: liveCards });
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (custM) {
        if (init?.body) {
          const params = new URLSearchParams(String(init.body));
          for (const [k, v] of params.entries()) {
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) storeMeta[m[1]] = v;
          }
          return okRes({ id: "cus_c9" });
        }
        return okRes({ id: "cus_c9", email: "client@example.com", name: "Casey Client", metadata: storeMeta });
      }
      return okRes({ id: "cus_c9" });
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) return okRes([row]);
    if (u.pathname.includes("/rest/v1/gh_events")) {
      const out = [...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return okRes(out);
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("C9 status returns card brand/last4", () => {
  it("live card: brand/last4 from Stripe, card_on_file true", async () => {
    storeMeta = { ...storeMeta, gh_payment_method: "pm_live_1" };
    liveCards = [{ id: "pm_live_1", card: { brand: "Mastercard", last4: "9321" } }];
    const r = await call();
    expect(r.code).toBe(200);
    expect(r.body["payment_method"]).toBe("saved");
    expect(r.body["card_brand"]).toBe("Mastercard");
    expect(r.body["card_last4"]).toBe("9321");
    expect(r.body["card_on_file"]).toBe(true);
  });

  it("paid booking, card detached after payment: journal card_confirmed supplies brand/last4, payment_method stays saved", async () => {
    row = { ...row, status: "paid" };
    storeMeta = { ...storeMeta, gh_state: "paid" };
    liveCards = [];
    events = [{
      event: "card_confirmed",
      detail: { payment_method_id: "pm_old_1", brand: "Visa", last4: "4242" },
      created_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString(),
    }];
    const r = await call();
    expect(r.code).toBe(200);
    expect(r.body["payment_method"]).toBe("saved");
    expect(r.body["card_brand"]).toBe("Visa");
    expect(r.body["card_last4"]).toBe("4242");
    expect(r.body["card_on_file"]).toBe(false);
    expect(r.body["card_used_for_booking"]).toBe(true);
  });

  it("unpaid booking, no card anywhere: none, empty brand/last4", async () => {
    const r = await call();
    expect(r.code).toBe(200);
    expect(r.body["payment_method"]).toBe("none");
    expect(r.body["card_brand"]).toBe("");
    expect(r.body["card_last4"]).toBe("");
    expect(r.body["card_on_file"]).toBe(false);
    expect(r.body["card_used_for_booking"]).toBe(false);
  });
});
