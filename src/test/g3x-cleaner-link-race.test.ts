// @vitest-environment node
// L2 residual (cleaner_link): two concurrent cleaner_link calls for a
// Stripe-only booking (no visit row yet) must not leave two visit_no-1
// rows. The post-insert re-check detects the earlier row, deletes ours
// and issues the link on the earlier row instead.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";

const SECRET = "test-cleaner-secret-123";
const BID = "bid-cleaner-link-race";

type Row = Record<string, unknown>;

let rows: Row[];
let events: Array<{ visit_id: string | null; event: string }>;
let visitGets: number;

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

const CUSTOMER = {
  id: "cus_race",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "card_ready", gh_service: "Standard cleaning", gh_first_price_cents: "14900" },
};

// The concurrent call's row: inserted "first" (earlier created_at) but
// invisible to our opening latestVisit check — that is the race.
const earlierRow = (): Row => ({
  id: "row-earlier",
  booking_id: BID,
  visit_no: 1,
  status: "scheduled",
  visit_date: null,
  created_at: "2026-11-13T10:00:00Z",
});

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const supRes = (data: unknown, ok = true, status = 200) => ({
      ok, status,
      json: async () => data,
      text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    });
    if (u.includes("api.stripe.com")) {
      if (u.includes("/customers/search")) return supRes({ data: [{ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } }] });
      if (u.includes(`/customers/${CUSTOMER.id}`)) return supRes({ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } });
      return supRes({ id: CUSTOMER.id });
    }
    if (u.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
        const m = /id=eq\.([^&]+)/.exec(u);
        const key = m ? decodeURIComponent(m[1]) : "";
        const matched = rows.filter((r) => r["id"] === key);
        for (const r of matched) Object.assign(r, patch);
        return supRes(matched);
      }
      if (method === "DELETE") {
        const m = /id=eq\.([^&]+)/.exec(u);
        const key = m ? decodeURIComponent(m[1]) : "";
        rows = rows.filter((r) => r["id"] !== key);
        return supRes([]);
      }
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Row;
        const created = { ...body, id: "row-mine", created_at: "2026-11-13T10:00:01Z" };
        rows.push(created);
        return supRes([created]);
      }
      // GET: the FIRST check races ahead of the concurrent insert and
      // sees nothing; later reads see the rows.
      visitGets++;
      if (visitGets === 1) return supRes([]);
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const eq = (k: string) => {
        const v = qs.get(k);
        return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
      };
      let out = [...rows];
      const bid = eq("booking_id");
      if (bid) out = out.filter((r) => r["booking_id"] === bid);
      const order = qs.get("order") ?? "";
      if (order.startsWith("created_at.asc")) {
        out.sort((a, b) => String(a["created_at"] ?? "").localeCompare(String(b["created_at"] ?? "")));
      }
      const limit = Number(qs.get("limit") ?? "1");
      return supRes(out.slice(0, Number.isFinite(limit) ? limit : 1));
    }
    if (u.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { visit_id?: string | null; event?: string };
        events.push({ visit_id: body.visit_id ?? null, event: body.event ?? "" });
        return supRes([{ id: events.length }]);
      }
      return supRes([]);
    }
    return supRes([]);
  }));
}

const callOwner = async (body: Record<string, unknown>) => {
  const r = res();
  await bookingAction(
    { method: "POST", headers: { authorization: "Bearer " + "adm-" + "secret" }, body } as never,
    r as never,
  );
  return r;
};

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [earlierRow()];
  events = [];
  visitGets = 0;
  installFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("L2: cleaner_link race-close", () => {
  it("drops our insert and issues the link on the earlier row", async () => {
    const r = await callOwner({ action: "cleaner_link", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(typeof r.body["url"]).toBe("string");
    expect(rows).toHaveLength(1);
    expect(rows[0]["id"]).toBe("row-earlier");
    expect(rows[0]["cleaner_link_version"]).toBe("v2");
    expect(events.some((e) => e.event === "cleaner_link_issued")).toBe(true);
  });

  it("keeps our insert when there is no race (re-check finds one row)", async () => {
    rows = [];
    const r = await callOwner({ action: "cleaner_link", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]["id"]).toBe("row-mine");
    expect(rows[0]["cleaner_link_version"]).toBe("v2");
  });
});
