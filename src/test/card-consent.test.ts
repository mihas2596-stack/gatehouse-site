// @vitest-environment node
// 16.11.2026 (spec 2.1): consent at card save — the checkbox text, the
// server gate on confirm_card and create-checkout-session, the journal
// event, and the reply-address gate regression.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import cardStatus from "../../api/card-status";
import checkoutSession, { signBooking } from "../../api/create-checkout-session";
import { CONSENT_TEXT_VERSION as SERVER_VERSION, consentText as serverConsentText } from "../../api/_consent";
import { CONSENT_TEXT_VERSION as CLIENT_VERSION, consentText as clientConsentText } from "../lib/consent";
import { reportReplyAddress } from "../../api/_report_reply";

const BID = "bid-consent-1";
const VISIT_ID = "77777777-4444-5555-6666-777777777777";

type Row = Record<string, unknown>;
type Ev = Record<string, unknown>;

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

function matchCond(row: Record<string, unknown>, field: string, op: string, val: string): boolean {
  const v = row[field];
  const dec = decodeURIComponent(val);
  if (op === "eq") return String(v ?? "") === dec;
  if (op === "neq") return v !== null && v !== undefined && String(v) !== dec;
  if (op === "is") return dec === "null" ? v === null || v === undefined : v !== null && v !== undefined;
  if (op === "in") return dec.replace(/^\(|\)$/g, "").split(",").includes(String(v ?? ""));
  return false;
}
function applyDbFilters(list: Record<string, unknown>[], u: URL): Record<string, unknown>[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    const dot = v.indexOf(".");
    if (dot <= 0) continue;
    out = out.filter((r) => matchCond(r, k, v.slice(0, dot), v.slice(dot + 1)));
  }
  const order = u.searchParams.get("order");
  if (order) {
    const [field, dir] = order.split(".");
    out.sort((a, b) => { const cmp = String(a[field] ?? "").localeCompare(String(b[field] ?? "")); return dir === "desc" ? -cmp : cmp; });
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

describe("card-save consent (spec 2.1)", () => {
  let rows: Row[];
  let events: Ev[];
  let stripePmList: Array<{ id: string; card?: { brand?: string; last4?: string } }>;
  let checkoutBodies: string[];
  let bt: string;

  const supRes = (data: unknown, ok = true, status = 200) => ({
    ok, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });

  const installFetch = () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.includes("api.stripe.com")) {
        if (u.includes("/customers/search")) {
          return supRes({ data: [{ id: "cus_1", email: "client@example.com", name: "Casey Client", metadata: { gh_booking_id: BID, gh_state: "awaiting_card" } }] });
        }
        if (u.includes("/customers?email=")) return supRes({ data: [] });
        if (u.includes("/checkout/sessions/cs_test_123")) {
          return supRes({ id: "cs_test_123", mode: "setup", status: "complete", setup_intent: "si_test", customer: "cus_1", metadata: { gh_booking_id: BID, gh_consent: "true", gh_consent_text_version: SERVER_VERSION } });
        }
        if (u.includes("/setup_intents/si_test")) {
          return supRes({ id: "si_test", status: "succeeded", payment_method: "pm_1" });
        }
        if (u.includes("/checkout/sessions") && method === "POST") {
          checkoutBodies.push(String(init?.body ?? ""));
          return supRes({ id: "cs_test", url: "https://checkout.stripe.com/pay/cs_test" });
        }
        if (u.includes("/customers/cus_1/payment_methods")) return supRes({ data: stripePmList });
        const single = /\/payment_methods\/(pm_[A-Za-z0-9]+)/.exec(u);
        if (single) {
          const found = stripePmList.find((p) => p.id === single[1]);
          if (!found) return supRes({ error: { message: "not found" } }, false, 404);
          return supRes({ id: found.id, customer: "cus_1", card: found.card });
        }
        if (u.includes("/customers") && method === "POST") return supRes({ id: "cus_1" });
        if (u.includes("/customers/cus_1")) return supRes({ id: "cus_1", email: "client@example.com", name: "Casey Client", metadata: { gh_booking_id: BID } });
        return supRes({ id: "cus_1" });
      }
      if (u.includes("api.resend.com")) return supRes({ id: "em_1" });
      if (u.includes("/rest/v1/")) {
        const uu = new URL(u);
        const table = uu.pathname.split("/").pop() ?? "";
        const list = table === "gh_visits" ? rows : table === "gh_events" ? events : [];
        if (method === "GET") return supRes(applyDbFilters(list, uu));
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          const inserted = { ...body, id: list.length + 1, created_at: new Date().toISOString() };
          list.push(inserted);
          return supRes([inserted]);
        }
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          const matched = applyDbFilters(list, uu);
          for (const target of matched) Object.assign(target, body);
          return supRes(matched);
        }
        return supRes([]);
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
    }));
  };

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows = [{
      id: VISIT_ID, booking_id: BID, visit_no: 1, status: "requested",
      report_status: "none", visit_date: "2026-11-10", window: "morning",
      service: "Standard cleaning", client_name: "Casey Client", client_email: "client@example.com",
      amount_cents: 14900, cleaner_name: null, cleaner_id: null,
      issue_open: false, issue_ever: false, report_sent_at: null, report_bounced: false,
    }];
    events = [];
    stripePmList = [{ id: "pm_1", card: { brand: "visa", last4: "4242" } }];
    checkoutBodies = [];
    bt = signBooking("link-secret", { bid: BID, email: "client@example.com", name: "Casey Client", first: "149", service: "Standard cleaning", date: "2026-11-10" }).token;
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const confirmCard = async (body: Record<string, unknown>) => {
    const r = res();
    await cardStatus({ method: "POST", headers: {}, body: { bt, action: "confirm_card", ...body } } as never, r as never);
    return r;
  };

  it("the version constant and the checkbox text are one source on both sides", () => {
    expect(SERVER_VERSION).toBe("2026-11-16-v1");
    expect(CLIENT_VERSION).toBe(SERVER_VERSION);
    const text = "I authorize Gatehouse Home Cleaning to save my card and charge $149 for this visit under the payment schedule shown above.";
    expect(serverConsentText("$149")).toBe(text);
    expect(clientConsentText("$149")).toBe(text);
  });

  it("confirm_card without consent is a 400 consent_required and journals nothing", async () => {
    const r = await confirmCard({ payment_method_id: "pm_1" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("consent_required");
    expect(events).toHaveLength(0);
  });

  it("confirm_card with consent:false or a stale version is a 400", async () => {
    const no = await confirmCard({ consent: false, consent_text_version: SERVER_VERSION, payment_method_id: "pm_1" });
    expect(no.code).toBe(400);
    expect(no.body["error"]).toBe("consent_required");
    const stale = await confirmCard({ consent: true, consent_text_version: "2026-11-01-v1", payment_method_id: "pm_1" });
    expect(stale.code).toBe(400);
    expect(stale.body["error"]).toBe("consent_required");
  });

  it("confirm_card with consent journals card_consent_given and writes the row", async () => {
    const r = await confirmCard({ consent: true, consent_text_version: SERVER_VERSION, payment_method_id: "pm_1" });
    expect(r.code).toBe(200);
    const ev = events.find((e) => e.event === "card_consent_given");
    expect(ev).toBeDefined();
    expect(ev?.detail).toMatchObject({ text_version: SERVER_VERSION, amount_cents: 14900, via: "confirm_card" });
    expect(rows[0]["consent_text_version"]).toBe(SERVER_VERSION);
    expect(rows[0]["consent_given_at"]).toBeTruthy();
  });

  it("create-checkout-session without consent is a 400 and creates no session", async () => {
    const r = res();
    await checkoutSession({ method: "POST", headers: {}, body: { bt } } as never, r as never);
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("consent_required");
    expect(checkoutBodies).toHaveLength(0);
  });

  it("create-checkout-session with consent carries gh_consent in the session metadata", async () => {
    const r = res();
    await checkoutSession({ method: "POST", headers: {}, body: { bt, consent: true, consent_text_version: SERVER_VERSION } } as never, r as never);
    expect(r.code).toBe(200);
    expect(checkoutBodies).toHaveLength(1);
    const params = new URLSearchParams(checkoutBodies[0]);
    expect(params.get("metadata[gh_consent]")).toBe("true");
    expect(params.get("metadata[gh_consent_text_version]")).toBe(SERVER_VERSION);
  });

  it("a returned Checkout session with consent metadata journals it via checkout_session", async () => {
    const r = res();
    await cardStatus({ method: "GET", headers: {}, query: { bt, session_id: "cs_test_123" } } as never, r as never);
    expect(r.code).toBe(200);
    const ev = events.find((e) => e.event === "card_consent_given");
    expect(ev?.detail).toMatchObject({ text_version: SERVER_VERSION, via: "checkout_session" });
    expect(rows[0]["consent_text_version"]).toBe(SERVER_VERSION);
  });

  it("gate regression: reportReplyAddress() without env is undefined (no per-visit reply_to)", () => {
    expect(reportReplyAddress("77777777-4444-5555-6666-777777777777")).toBeUndefined();
  });
});
