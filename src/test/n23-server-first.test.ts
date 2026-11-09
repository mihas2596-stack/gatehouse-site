// @vitest-environment node
// N23: a silently replaced browser price is now visible — the quote
// response carries the server-verified totals (server_first /
// server_recurring), so the client learns the corrected price before
// the card step instead of from the email. C20 rides along: routine
// request emails must not carry a one-click owner login link, even
// when ADMIN_TOKEN is configured.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/send-contact-email";

vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-30T00:00:00Z"));

const origin = "https://www.gatehousehomecleaning.com";
function response() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

const base = (over: Record<string, unknown> = {}) => ({
  request_id: "123e4567-e89b-42d3-a456-426614174000",
  name: "Test Person",
  email: "test@example.com",
  phone: "7705550100",
  service: "Standard cleaning",
  date: "2027-01-15",
  time: "midday",
  message: "3 bed · 2 full bath · 1 half bath",
  bedrooms: "3",
  bathrooms: "2.5",
  full_baths: "2",
  half_baths: "1",
  zip: "30024",
  address: "123 Test St, Sugar Hill, GA 30024",
  price: "189",
  frequency: "every2weeks",
  service_key: "standard",
  cleaned_recently: true,
  addons: { insideOven: false, insideFridge: false, insideCabinets: false, interiorWindows: 0, pets: false },
  source: "quote",
  terms_consent: true,
  photo_consent: true,
  sms_consent: false,
  entry_method: "arrange_before",
  entry_detail: "lockbox",
  ...over,
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "test-id" }) }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("N23 server price in the quote response", () => {
  it("returns server_first/server_recurring when the browser price is replaced", async () => {
    const res = response();
    // Browser shows the real $189; the test window prices it at $1.50.
    await handler({ method: "POST", headers: { origin }, body: base({ price: "189" }) }, res);
    expect(res.code).toBe(200);
    expect(res.body["server_first"]).toBe("1.5");
    expect(res.body["server_recurring"]).toBe("1.5");
    expect(res.body["bt"]).toBeTruthy();
    const calls = vi.mocked(fetch).mock.calls;
    const owner = JSON.parse(String(calls[0][1]?.body));
    expect(owner.html).toContain("Server-verified estimate");
    expect(owner.html).toContain("$1.5");
    // C20: no one-click owner login in the routine request email.
    expect(owner.html).not.toContain("owner?ol=");
    expect(owner.html).not.toContain("Open owner panel");
    expect(JSON.stringify(calls)).not.toContain("owner?ol=");
  });

  it("returns the server totals even when the browser price already matches", async () => {
    const res = response();
    await handler({ method: "POST", headers: { origin }, body: base({ price: "1.5" }) }, res);
    expect(res.code).toBe(200);
    expect(res.body["server_first"]).toBe("1.5");
    const calls = vi.mocked(fetch).mock.calls;
    const owner = JSON.parse(String(calls[0][1]?.body));
    expect(owner.html).not.toContain("Browser showed (replaced)");
  });

  it("a general inquiry carries no server price and no login link", async () => {
    const res = response();
    await handler({ method: "POST", headers: { origin }, body: { name: "Nick", email: "client@example.com", message: "Hi", source: "contact" } }, res);
    expect(res.code).toBe(200);
    expect(res.body["server_first"]).toBeUndefined();
    const owner = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(owner.html).not.toContain("owner?ol=");
  });
});
