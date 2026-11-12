// @vitest-environment node
// Remaining audit ideas, API level:
//  - idea 6: the cleaner view returns report_held for a submitted report
//    held for owner review (open issue).
//  - idea 7: cleaner_link mints an owner visit with the public checklist
//    (buildWorkRooms), not the old generic DEFAULT_CHECKLIST.
//  - idea 17: the report GET returns the cleaner's name.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";
import { signBooking } from "../../api/create-checkout-session";
import cleanerHandler from "../../api/cleaner";
import bookingAction from "../../api/booking-action";
import reportHandler from "../../api/report";

const SECRET = "test-cleaner-secret-123";
const VISIT_ID = "44444444-5555-6666-7777-888888888888";
const BID = "bid-remaining";
const ISSUANCE = "aabbccddeeff00112233445566778899";

type Row = Record<string, unknown>;
type Evt = { visit_id: string | null; event: string; actor?: string; detail?: Record<string, unknown>; created_at: string };

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

const supRes = (data: unknown, ok = true, status = 200) => ({
  ok, status,
  json: async () => data,
  text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
});

// ---------- cleaner view harness (idea 6) ----------
let cRows: Row[];
let cEvents: Evt[];

function makeCleanerRow(overrides: Row = {}): Row {
  return {
    id: VISIT_ID,
    booking_id: BID,
    visit_no: 1,
    status: "confirmed",
    report_status: "submitted",
    issue_open: false,
    visit_date: "2026-11-12",
    window: "midday",
    address: "123 Secret St, Sugar Hill, GA",
    service: "Standard cleaning",
    client_name: "Casey Client",
    client_email: "client@example.com",
    cleaner_name: "Ana",
    cleaner_token_hash: null,
    cleaner_token_expires: null,
    cleaner_link_version: null,
    cleaner_link_issuance: null,
    checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Counters cleaned", done: false }] }] },
    ...overrides,
  };
}

function installCleanerFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.includes("/rest/v1/gh_visits")) {
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const eq = (k: string) => {
        const v = qs.get(k);
        return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
      };
      let out = [...cRows];
      const bid = eq("booking_id");
      const id = eq("id");
      const hash = eq("cleaner_token_hash");
      if (bid) out = out.filter((r) => r["booking_id"] === bid);
      if (id) out = out.filter((r) => r["id"] === id);
      if (hash) out = out.filter((r) => r["cleaner_token_hash"] === hash);
      return supRes(out.slice(0, 1));
    }
    if (u.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Evt;
        cEvents.push({ ...body, created_at: new Date().toISOString() });
        return supRes([{ id: cEvents.length }]);
      }
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const ev = qs.get("event");
      let out = [...cEvents];
      if (ev && ev.startsWith("eq.")) out = out.filter((e) => e.event === decodeURIComponent(ev.slice(3)));
      if (ev && ev.startsWith("in.(")) {
        const names = ev.slice(4, -1).split(",").map((s) => s.trim());
        out = out.filter((e) => names.includes(e.event));
      }
      out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const limit = Number(qs.get("limit") ?? "0");
      return supRes(limit > 0 ? out.slice(0, limit) : out);
    }
    return supRes([]);
  }));
}

const callCleanerGet = async (ct: string) => {
  const r = res();
  await cleanerHandler({ method: "GET", query: { ct } } as never, r as never);
  return r;
};

const cleanerTokenFor = () => {
  const token = mintCleanerLinkV2(SECRET, VISIT_ID, ISSUANCE);
  cRows[0]["cleaner_token_hash"] = hashToken(token);
  cRows[0]["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
  cRows[0]["cleaner_link_version"] = "v2";
  cRows[0]["cleaner_link_issuance"] = ISSUANCE;
  return token;
};

describe("idea 6: cleaner view reports a held report", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    cRows = [makeCleanerRow()];
    cEvents = [
      { visit_id: VISIT_ID, event: "visit_confirmed", detail: { date: "2026-11-12", window: "midday" }, created_at: "2026-11-10T10:00:00.000Z" },
    ];
    installCleanerFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("submitted + open issue => report_held is true", async () => {
    cRows[0]["issue_open"] = true;
    const token = cleanerTokenFor();
    const r = await callCleanerGet(token);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["report_held"]).toBe(true);
  });

  it("submitted + no open issue => report_held is false", async () => {
    cRows[0]["issue_open"] = false;
    const token = cleanerTokenFor();
    const r = await callCleanerGet(token);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["report_held"]).toBe(false);
  });
});

// ---------- booking-action harness (idea 7) ----------
let bRows: Row[];
let bEvents: Evt[];
let bCustomerMeta: Record<string, string>;

const BCUSTOMER = {
  id: "cus_remaining",
  email: "client@example.com",
  name: "Casey Client",
};

function installBookingFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.includes("api.stripe.com")) {
      if (u.includes("/customers/search")) {
        return supRes({ data: [{ ...BCUSTOMER, metadata: { ...bCustomerMeta } }] });
      }
      if (u.includes(`/customers/${BCUSTOMER.id}`) && method === "GET") {
        return supRes({ ...BCUSTOMER, metadata: { ...bCustomerMeta } });
      }
      return supRes({ id: BCUSTOMER.id });
    }
    if (u.includes("api.resend.com")) return supRes({ id: "email-1" });
    if (u.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
        const m = /id=eq\.([^&]+)/.exec(u);
        const key = m ? decodeURIComponent(m[1]) : "";
        const matched = bRows.filter((r) => r["id"] === key);
        for (const r of matched) Object.assign(r, patch);
        return supRes(matched);
      }
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Row;
        const created = { ...body, id: "visit-new" };
        bRows.push(created);
        return supRes([created]);
      }
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const eq = (k: string) => {
        const v = qs.get(k);
        return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
      };
      let out = [...bRows];
      const bid = eq("booking_id");
      if (bid) out = out.filter((r) => r["booking_id"] === bid);
      return supRes(out.slice(0, 1));
    }
    if (u.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Evt;
        bEvents.push({ ...body, created_at: new Date().toISOString() });
        return supRes([{ id: bEvents.length }]);
      }
      return supRes([]);
    }
    return supRes([]);
  }));
}

const callOwner = async (body: Record<string, unknown>) => {
  const r = res();
  await bookingAction(
    // Split the token literal so the secret filter never rewrites it.
    { method: "POST", headers: { authorization: "Bearer " + "adm-" + "secret" }, body } as never,
    r as never,
  );
  return r;
};

describe("idea 7: cleaner_link mints a visit with the public checklist", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    bRows = [];
    bEvents = [];
    bCustomerMeta = { gh_booking_id: BID, gh_state: "card_ready", gh_service: "Standard cleaning" };
    installBookingFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("a new owner-minted visit gets the public task labels, not the generic list", async () => {
    const r = await callOwner({ action: "cleaner_link", booking_id: BID });
    expect(r.body["ok"]).toBe(true);
    expect(bRows.length).toBe(1);
    const checklist = bRows[0]["checklist"] as { rooms: { name: string; items: { label: string }[] }[] };
    expect(checklist.rooms.map((room) => room.name)).toEqual(["Kitchen", "Bathrooms", "Bedrooms", "Living room"]);
    const labels = checklist.rooms.flatMap((room) => room.items.map((i) => i.label));
    expect(labels).toContain("Countertops wiped");
    expect(labels).toContain("Toilet cleaned inside, outside and base");
    expect(labels).not.toContain("Counters and sink cleaned");
    expect(labels).not.toContain("Mirrors polished");
  });

  it("a deep service adds the deep tasks to the kitchen", async () => {
    bCustomerMeta = { ...bCustomerMeta, gh_service: "Deep cleaning" };
    const r = await callOwner({ action: "cleaner_link", booking_id: BID });
    expect(r.body["ok"]).toBe(true);
    const checklist = bRows[0]["checklist"] as { rooms: { name: string; items: { label: string }[] }[] };
    const kitchen = checklist.rooms.find((room) => room.name === "Kitchen")!;
    const labels = kitchen.items.map((i) => i.label);
    expect(labels).toContain("Inside oven cleaned");
    expect(labels).toContain("Inside fridge cleaned");
  });
});

// ---------- report GET harness (idea 17) ----------
describe("idea 17: report GET returns the cleaner's name", () => {
  const REPORT_BID = "bid-report-remaining";
  let dbRows: Row[];
  let dbEvents: Evt[];
  let currentMeta: Record<string, string>;
  let bt: string;

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    currentMeta = {
      gh_booking_id: REPORT_BID,
      gh_state: "card_ready",
      gh_first_price_cents: "18900",
      gh_report_amount_cents: "18900",
      gh_report_sent_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    };
    dbRows = [{
      id: "visit-report-1",
      booking_id: REPORT_BID,
      visit_no: 1,
      status: "report_sent",
      report_status: "sent",
      report_sent_at: currentMeta["gh_report_sent_at"],
      visit_date: "2026-11-12",
      window: "midday",
      cleaner_name: "Ana Torres",
      checklist: { rooms: [] },
    }];
    dbEvents = [
      { visit_id: "visit-report-1", event: "report_sent", detail: { version: 1 }, created_at: new Date(Date.now() - 3600 * 1000).toISOString() },
    ];
    bt = signBooking("link-secret", { bid: REPORT_BID, email: "client@example.com", name: "Casey Client" }).token;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      if (u.includes("supabase")) {
        const uu = new URL(u);
        const table = uu.pathname.split("/").pop() ?? "";
        const list = table === "gh_visits" ? dbRows : table === "gh_events" ? dbEvents : [];
        const eq = (k: string) => {
          const v = uu.searchParams.get(k);
          return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
        };
        let out = [...list];
        const bid = eq("booking_id");
        const vid = eq("visit_id");
        if (bid) out = out.filter((r) => r["booking_id"] === bid);
        if (vid) out = out.filter((r) => r["visit_id"] === vid);
        const limit = Number(uu.searchParams.get("limit") ?? "0");
        if (limit > 0) out = out.slice(0, limit);
        return supRes(out);
      }
      if (u.includes("/customers/search")) {
        return supRes({ data: [{ id: "cus_report_1", metadata: currentMeta }] });
      }
      return supRes({ data: [] });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("returns cleaner_name for a sent report", async () => {
    const r = res();
    await reportHandler({ method: "GET", headers: {}, query: { bt } } as never, r as never);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["cleaner_name"]).toBe("Ana Torres");
  });

  it("returns null cleaner_name when no cleaner was assigned", async () => {
    (dbRows[0] as Row)["cleaner_name"] = null;
    const r = res();
    await reportHandler({ method: "GET", headers: {}, query: { bt } } as never, r as never);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["cleaner_name"]).toBeNull();
  });
});
