// @vitest-environment node
// send-contact: rooms are generated from THIS booking (bedrooms,
// bathrooms, half baths, extra zones) and the quote-time entry choice is
// stored on the visit row — never as a secret.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/send-contact-email";

vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-30T00:00:00Z"));

type Row = Record<string, unknown>;
let inserts: Row[];
let resendCalls: unknown[];

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

const base = (over: Record<string, unknown> = {}) => ({
  request_id: "123e4567-e89b-42d3-a456-426614174000",
  name: "Test Person",
  email: "test@example.com",
  phone: "7705550100",
  service: "Standard cleaning",
  date: "2027-01-15",
  time: "midday",
  message: "3 bed · 2 full bath · 1 half bath",
  extra_zones: "Home office",
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
  entry_notes: "Park in driveway",
  ...over,
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  inserts = [];
  resendCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") {
      resendCalls.push(JSON.parse(String(init?.body ?? "{}")));
      return okRes({ id: "email-1" });
    }
    if (u.hostname === "test.supabase.co") {
      if (u.pathname.includes("/rest/v1/gh_visits")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          inserts.push(body);
          return okRes([{ id: "visit-1" }]);
        }
        return okRes([]);
      }
      if (u.pathname.includes("/rest/v1/gh_events") && method === "POST") return okRes([{ id: 1 }]);
      return okRes([]);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const call = async (body: Record<string, unknown>) => {
  const r = res();
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { method: "POST", headers: { origin: "https://www.gatehousehomecleaning.com" }, body }, r as never,
  );
  return r;
};

const roomNames = () =>
  ((inserts[0]?.["checklist"] as { rooms?: { name: string }[] } | undefined)?.rooms ?? []).map((rm) => rm.name);

describe("send-contact rooms and entry", () => {
  it("generates one room per bedroom/bathroom plus extra zones, and stores the entry choice", async () => {
    const r = await call(base());
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(roomNames()).toEqual([
      "Kitchen",
      "Bathroom 1", "Bathroom 2",
      "Bedroom 1", "Bedroom 2", "Bedroom 3",
      "Half bathroom",
      "Living room",
      "Home office",
    ]);
    expect(inserts[0]["entry_method"]).toBe("arrange_before");
    expect(inserts[0]["entry_detail"]).toBe("lockbox");
    expect(inserts[0]["entry_notes"]).toBe("Park in driveway");
    // The entry choice reaches the owner email with its detail label.
    expect(JSON.stringify(resendCalls)).toContain("I'll arrange entry before the visit (Lockbox)");
  });

  it("splits extra zones instead of minting one-letter rooms, and falls back without counts", async () => {
    const r = await call(base({
      bedrooms: "", bathrooms: "", full_baths: "", half_baths: "",
      extra_zones: "Home office, Garage",
      entry_method: "home", entry_detail: undefined, entry_notes: "",
    }));
    expect(r.code).toBe(200);
    expect(roomNames()).toEqual(["Kitchen", "Bathrooms", "Bedrooms", "Living room", "Home office", "Garage"]);
    expect(roomNames().every((n) => n.length > 1)).toBe(true);
    expect(inserts[0]["entry_method"]).toBe("home");
    // A detail without arrange_before is dropped, not stored stale.
    expect(inserts[0]["entry_detail"]).toBe(null);
  });

  it("a single bedroom/bathroom stays singular", async () => {
    const r = await call(base({
      bedrooms: "1", bathrooms: "1", full_baths: "1", half_baths: "0",
      extra_zones: "", entry_method: "decide_later",
    }));
    expect(r.code).toBe(200);
    expect(roomNames()).toEqual(["Kitchen", "Bathroom", "Bedroom", "Living room"]);
    expect(inserts[0]["entry_method"]).toBe("decide_later");
  });
});
