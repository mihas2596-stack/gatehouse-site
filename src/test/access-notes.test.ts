// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import handler from "../../api/send-contact-email";

const origin = "https://www.gatehousehomecleaning.com";
function response() {
  const res = { code: 0, body: {} as Record<string, unknown>, status(code: number) { this.code = code; return this; }, json(body: Record<string, unknown>) { this.body = body; }, setHeader: vi.fn(), end: vi.fn() };
  return res;
}

type Call = [string, { body?: string } | undefined];
const callsTo = (substr: string): Call[] =>
  vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).includes(substr)) as Call[];

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "test-resend-key");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_for_signing_only");
  vi.stubEnv("SUPABASE_URL", "https://supabase.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
  const resp = (data: unknown) => ({
    ok: true, status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    // GET select finds no existing row (fresh booking); POST upsert returns it.
    if (u.includes("gh_visits")) return resp(init?.method === "POST" ? [{ id: "visit-1" }] : []);
    if (u.includes("gh_events")) return resp([{ id: "ev-1" }]);
    if (u.includes("api.stripe.com")) return resp({});
    return resp({ id: "email-1" });
  }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const quoteBody = {
  request_id: "22222222-3333-4444-8555-666666666666",
  website: "",
  name: "Access Test",
  phone: "4045550100",
  email: "client@example.com",
  service: "Standard",
  date: "2099-12-01",
  time: "midday",
  // The old composed dump: generated summary + consent record. It must
  // never land in the visit's access instructions again.
  message: "Under 2,500 sq ft · 3 BR · 2 full BA · ZIP 30024 · Professionally cleaned in last 3 months: Yes\n\nConsent record\nsms_consent: false",
  entry_instructions: "Gate code 1234, key under the mat",
  notes: "Dog named Rex, friendly",
  scope_review: true,
  scope_reasons: "home size not sure",
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

describe("entry instructions separation", () => {
  it("stores ONLY the customer's entry instructions in access_notes", async () => {
    const res = response();
    await handler({ method: "POST", headers: { origin }, body: quoteBody }, res);
    expect(res.code).toBe(200);
    const upserts = callsTo("gh_visits").filter((c) => c[1]?.body);
    expect(upserts.length).toBeGreaterThan(0);
    const row = JSON.parse(String(upserts[0][1]?.body)) as Record<string, unknown>;
    expect(row.access_notes).toBe("Gate code 1234, key under the mat");
    expect(String(row.access_notes)).not.toContain("Professionally cleaned");
    expect(String(row.access_notes)).not.toContain("Consent record");
  });

  it("journals customer notes and the scope-review flag as separate events", async () => {
    const res = response();
    await handler({ method: "POST", headers: { origin }, body: quoteBody }, res);
    expect(res.code).toBe(200);
    const events = callsTo("gh_events").map((c) => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("client_note");
    expect(kinds).toContain("scope_review");
    const note = events.find((e) => e.event === "client_note");
    expect(JSON.stringify(note?.detail)).toContain("Rex");
    const scope = events.find((e) => e.event === "scope_review");
    expect(JSON.stringify(scope?.detail)).toContain("home size not sure");
  });

  it("customer email uses the button + canonical payment wording, never 'pay after you have seen the report'", async () => {
    const res = response();
    await handler({ method: "POST", headers: { origin }, body: quoteBody }, res);
    expect(res.code).toBe(200);
    const emails = callsTo("api.resend.com").map((c) => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
    const customer = emails.find((e) => String(e.subject).includes("Request received"));
    expect(customer).toBeTruthy();
    expect(String(customer?.html)).toContain("Save your card — $0 today");
    expect(String(customer?.text)).toContain("charged automatically after the stated 24-hour review period");
    expect(String(customer?.text)).not.toContain("once you've seen the photo report");
    expect(String(customer?.text)).toContain("at 6:00 PM ET");
  });
});
