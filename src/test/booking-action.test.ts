// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import handler from "../../api/booking-action";
import { verifyBooking } from "../../api/create-checkout-session";

// The confirm action: the owner confirms the visit date with the client.
// It must set the orthogonal gh_booking_confirmed flag (never touching the
// gh_state charge machine), email the client once, and treat a repeat with
// the same date/window as a no-op (no second email). A changed date re-emails.

const BID = "bid-test-123";
const CUSTOMER = {
  id: "cus_test_1",
  email: "client@example.com",
  name: "Casey Client",
  metadata: {
    gh_booking_id: BID,
    gh_state: "card_ready",
    gh_first_price_cents: "18900",
  },
};

function response() {
  const res = {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  return res;
}

let metaWrites: URLSearchParams[];
let resendCalls: unknown[];
let currentMeta: Record<string, string>;

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  metaWrites = [];
  resendCalls = [];
  currentMeta = { ...CUSTOMER.metadata };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.includes("/customers/search")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: CUSTOMER.id, metadata: currentMeta }] }) };
    }
    if (u.includes("api.resend.com")) {
      resendCalls.push(init?.body);
      return { ok: true, status: 200, json: async () => ({ id: "email-1" }) };
    }
    if (u.endsWith(`/customers/${CUSTOMER.id}`) && init?.body) {
      const params = new URLSearchParams(String(init.body));
      metaWrites.push(params);
      for (const [k, v] of params.entries()) {
        const m = /^metadata\[gh_(.+)\]$/.exec(k);
        if (m) currentMeta[`gh_${m[1]}`] = v;
      }
      return { ok: true, status: 200, json: async () => ({ id: CUSTOMER.id }) };
    }
    if (u.endsWith(`/customers/${CUSTOMER.id}`)) {
      return { ok: true, status: 200, json: async () => ({ ...CUSTOMER, metadata: currentMeta }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const confirmReq = (date: string, win: string) => ({
  method: "POST",
  headers: { authorization: "Bearer adm-secret" },
  body: { action: "confirm", booking_id: BID, confirmed_date: date, confirmed_window: win },
});

describe("booking-action confirm", () => {
  it("sets the confirmed flag and emails the client", async () => {
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(confirmReq("2026-11-07", "Midday (11 AM – 2 PM)") as any, res as any);
    expect(res.code).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["booking_confirmed"]).toBe(true);
    expect(res.body["email_sent"]).toBe(true);
    const written = metaWrites.map((p) => p.toString()).join("&");
    expect(written).toContain("metadata%5Bgh_booking_confirmed%5D=1");
    expect(written).toContain("metadata%5Bgh_confirmed_date%5D=2026-11-07");
    expect(resendCalls).toHaveLength(1);
    const emailBody = JSON.parse(String(resendCalls[0])) as { subject: string; text: string; to: string[] };
    expect(emailBody.to).toEqual(["client@example.com"]);
    expect(emailBody.subject).toContain("Booking confirmed");
    expect(emailBody.text).toContain("Agreed price: $189 for the first visit.");
  });

  it("does not re-email on an identical repeat, but does on a date change", async () => {
    const res1 = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(confirmReq("2026-11-07", "Midday") as any, res1 as any);
    expect(resendCalls).toHaveLength(1);
    const res2 = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(confirmReq("2026-11-07", "Midday") as any, res2 as any);
    expect(res2.body["already_confirmed"]).toBe(true);
    expect(resendCalls).toHaveLength(1);
    const res3 = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(confirmReq("2026-11-08", "Midday") as any, res3 as any);
    expect(res3.body["already_confirmed"]).toBe(false);
    expect(resendCalls).toHaveLength(2);
  });

  it("requires a date and the admin token", async () => {
    const resNoDate = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ method: "POST", headers: { authorization: "Bearer adm-secret" }, body: { action: "confirm", booking_id: BID } } as any, resNoDate as any);
    expect(resNoDate.code).toBe(400);
    const resNoAuth = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ method: "POST", headers: {}, body: { action: "confirm", booking_id: BID, confirmed_date: "2026-11-07" } } as any, resNoAuth as any);
    expect(resNoAuth.code).toBe(401);
  });
});

describe("booking-action client_link", () => {
  it("mints a visit link for the booking's client", async () => {
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ method: "POST", headers: { authorization: "Bearer adm-secret" }, body: { action: "client_link", booking_id: BID } } as any, res as any);
    expect(res.body["ok"]).toBe(true);
    const url = res.body["url"] as string;
    expect(url.startsWith("https://www.gatehousehomecleaning.com/visit?bt=")).toBe(true);
    const bt = decodeURIComponent(url.split("bt=")[1]);
    const v = verifyBooking("sk_test_x", bt);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.bid).toBe(BID);
      expect(v.payload.email).toBe(CUSTOMER.email);
    }
  });
});
