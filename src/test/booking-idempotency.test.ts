// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import handler, { bidFromRequestId } from "../../api/send-contact-email";

const origin = "https://www.gatehousehomecleaning.com";
function response() {
  const res = { code: 0, body: {} as Record<string, unknown>, status(code: number) { this.code = code; return this; }, json(body: Record<string, unknown>) { this.body = body; }, setHeader: vi.fn(), end: vi.fn() };
  return res;
}

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "test-resend-key");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_for_signing_only");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "test-id" }) }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("bidFromRequestId", () => {
  it("is deterministic and UUID-shaped", () => {
    const a = bidFromRequestId("req-123");
    const b = bidFromRequestId("req-123");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("differs for different request ids", () => {
    expect(bidFromRequestId("req-1")).not.toBe(bidFromRequestId("req-2"));
  });
});

const bookingBody = {
  request_id: "11111111-2222-4333-8444-555555555555",
  website: "",
  name: "Retry Test",
  phone: "4045550100",
  email: "client@example.com",
  service: "Standard",
  date: "2099-12-01",
  time: "",
  message: "Under 2,500 sq ft · 3 BR · 2 full BA · ZIP 30024 · Professionally cleaned in last 3 months: Yes",
  founding: false,
  bedrooms: "3",
  bathrooms: "2",
  zip: "30024",
  address: "1 Example Street",
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

describe("booking submit idempotency", () => {
  it("a retried submission with the same request_id reproduces the same booking_id", async () => {
    const r1 = response();
    await handler({ method: "POST", headers: { origin }, body: bookingBody }, r1);
    expect(r1.code).toBe(200);
    const r2 = response();
    await handler({ method: "POST", headers: { origin }, body: bookingBody }, r2);
    expect(r2.code).toBe(200);
    expect(r1.body.booking_id).toBeTruthy();
    expect(r2.body.booking_id).toBe(r1.body.booking_id);
    expect(r1.body.booking_id).toBe(bidFromRequestId(bookingBody.request_id));
  });

  it("a different request_id produces a different booking_id", async () => {
    const r1 = response();
    await handler({ method: "POST", headers: { origin }, body: { ...bookingBody, request_id: "99999999-8888-4777-8666-555555555555" } }, r1);
    expect(r1.code).toBe(200);
    expect(r1.body.booking_id).not.toBe(bidFromRequestId(bookingBody.request_id));
  });
});
