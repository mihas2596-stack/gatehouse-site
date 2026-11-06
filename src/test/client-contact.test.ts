// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bookingAction from "../../api/booking-action";
import cleanerHandler from "../../api/cleaner";
import { hashToken } from "../../api/_db";

const token = "legacy-cleaner-token-for-contact-test";
const visitId = "11111111-2222-4333-8444-555555555555";
let visit: Record<string, unknown>;
let confirmed: boolean;
let failWrite: boolean;
let contacts: Record<string, unknown>[];

function response() {
  return { code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; }, setHeader: vi.fn(), end: vi.fn() };
}
beforeEach(() => {
  vi.stubEnv("ADMIN_TOKEN", "owner-contact-test");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_contact");
  vi.stubEnv("SUPABASE_URL", "https://contact.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  confirmed = true; failWrite = false; contacts = [];
  visit = { id: visitId, booking_id: "contact-booking", status: "confirmed", report_status: "draft",
    client_name: "Casey", checklist: { rooms: [] }, cleaner_token_hash: hashToken(token),
    cleaner_token_expires: "2099-01-01T00:00:00Z" };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const result = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, text: async () => JSON.stringify(data), json: async () => data });
    if (u.pathname.endsWith("gh_visits")) {
      const hash = u.searchParams.get("cleaner_token_hash");
      return result(!hash || hash === `eq.${visit.cleaner_token_hash}` ? [visit] : []);
    }
    if (u.pathname.endsWith("gh_events")) {
      const event = u.searchParams.get("event");
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.event === "client_contact") {
          if (failWrite) return result({}, false);
          contacts.unshift(body);
        }
        return result([{ id: contacts.length + 1 }]);
      }
      if (event === "eq.client_contact") return result(contacts);
      if (event === "eq.visit_confirmed") return result(confirmed ? [{ id: 1 }] : []);
      return result([]);
    }
    return result([]);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const save = async (phone: string, auth = "Bearer owner-contact-test") => {
  const r = response();
  await bookingAction({ method: "POST", headers: { authorization: auth }, body: {
    action: "set_client_phone", booking_id: "contact-booking", client_phone: phone,
  } }, r);
  return r;
};
const view = async (ct = token) => {
  const r = response();
  await cleanerHandler({ method: "GET", headers: {}, query: { ct, pv: "1" } }, r);
  return r;
};

describe("client phone repair and assigned cleaner access", () => {
  it("persists an owner repair and returns it through the valid job link", async () => {
    expect((await save("(770) 555-0100")).code).toBe(200);
    expect(contacts[0]).toMatchObject({ visit_id: visitId, event: "client_contact", detail: { phone: "+17705550100" } });
    expect(((await view()).body.visit as Record<string, unknown>).client_phone).toBe("+17705550100");
  });
  it("rejects unauthenticated changes, invalid phones, and invalid cleaner links", async () => {
    expect((await save("7705550100", "")).code).toBe(401);
    expect((await save("123")).code).toBe(400);
    expect(contacts).toHaveLength(0);
    expect((await view("wrong-token-that-is-long-enough")).code).toBe(404);
  });
  it("does not claim a failed write succeeded", async () => {
    failWrite = true;
    expect((await save("7705550100")).code).toBe(503);
    expect(contacts).toHaveLength(0);
  });
  it("withholds the phone before confirmation and after cancellation or report delivery", async () => {
    await save("7705550100");
    confirmed = false;
    expect(((await view()).body.visit as Record<string, unknown>).client_phone).toBeNull();
    confirmed = true; visit.status = "cancelled";
    expect(((await view()).body.visit as Record<string, unknown>).client_phone).toBeNull();
    visit.status = "confirmed"; visit.report_status = "sent";
    expect(((await view()).body.visit as Record<string, unknown>).client_phone).toBeNull();
  });
});
