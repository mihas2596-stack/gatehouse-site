// @vitest-environment node
// C12 (09.11.2026): cleaner links.
// (a) revoke_cleaner_link clears the stored token/issuance without
// issuing a new link (revoke != rotation): the old token stops
// resolving, get_cleaner_link reports link_not_reusable, and a later
// cleaner_link (rotation) issues a fresh link.
// (b) a paid or cancelled visit resolves to a summary only on GET —
// no address, no entry, no phone, no photos — and every POST action
// is refused with visit_closed. The client's own /report link is a
// different endpoint and is untouched by this change.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";
import bookingAction from "../../api/booking-action";
import cleanerHandler from "../../api/cleaner";

const SECRET = "test-cleaner-secret-123";
const VISIT_ID = "22222222-3333-4444-5555-666666666666";
const BID = "bid-c12";
const ISSUANCE = "aabbccddeeff00112233445566778899";

type Row = Record<string, unknown>;

let rows: Row[];
let events: Array<{ visit_id: string | null; event: string; detail?: Record<string, unknown> }>;
let noCustomer = false;

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

function makeRow(overrides: Row = {}): Row {
  return {
    id: VISIT_ID,
    booking_id: BID,
    visit_no: 1,
    status: "confirmed",
    report_status: "none",
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

const CUSTOMER = {
  id: "cus_c12",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "card_ready" },
};

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
      if (u.includes("/customers/search")) {
        return supRes({ data: noCustomer ? [] : [{ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } }] });
      }
      if (u.includes(`/customers/${CUSTOMER.id}`) && method === "GET") {
        return supRes({ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } });
      }
      return supRes({ id: CUSTOMER.id });
    }
    if (u.includes("api.resend.com")) return supRes({ id: "email-1" });
    if (u.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
        const m = /id=eq\.([^&]+)/.exec(u);
        const key = m ? decodeURIComponent(m[1]) : "";
        const matched = rows.filter((r) => r["id"] === key);
        for (const r of matched) Object.assign(r, patch);
        return supRes(matched);
      }
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Row;
        const created = { ...makeRow(), ...body, id: body["id"] ?? VISIT_ID };
        rows.push(created);
        return supRes([created]);
      }
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const eq = (k: string) => {
        const v = qs.get(k);
        return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
      };
      let out = [...rows];
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
        const body = JSON.parse(String(init?.body ?? "{}")) as { visit_id?: string | null; event?: string; detail?: Record<string, unknown> };
        events.push({ visit_id: body.visit_id ?? null, event: body.event ?? "", detail: body.detail });
        return supRes([{ id: events.length }]);
      }
      return supRes([]);
    }
    // gh_photos, gh_visit_access, storage: empty.
    return supRes([]);
  }));
}

const callOwner = async (body: Record<string, unknown>) => {
  const r = res();
  await bookingAction(
    { method: "POST", headers: { authorization: "Bearer adm-secret" }, body } as never,
    r as never,
  );
  return r;
};

const callCleanerGet = async (ct: string) => {
  const r = res();
  await cleanerHandler({ method: "GET", query: { ct } } as never, r as never);
  return r;
};

const callCleanerPost = async (body: Record<string, unknown>) => {
  const r = res();
  await cleanerHandler({ method: "POST", body } as never, r as never);
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
  rows = [makeRow()];
  events = [];
  noCustomer = false;
  installFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("C12 cleaner link revoke + closed-visit restriction", () => {
  it("revoke clears the link without rotating: old token stops resolving", async () => {
    const issued = await callOwner({ action: "cleaner_link", booking_id: BID });
    expect(issued.body["ok"]).toBe(true);
    const token = String(issued.body["url"]).split("ct=")[1];
    expect(token.startsWith("ct2.")).toBe(true);

    const revoked = await callOwner({ action: "revoke_cleaner_link", booking_id: BID });
    expect(revoked.code).toBe(200);
    expect(revoked.body["ok"]).toBe(true);
    expect(revoked.body["revoked"]).toBe(true);
    expect(rows[0]["cleaner_token_hash"]).toBeNull();
    expect(rows[0]["cleaner_link_issuance"]).toBeNull();
    expect(rows[0]["cleaner_link_version"]).toBeNull();
    expect(events.some((e) => e.event === "cleaner_link_revoked")).toBe(true);

    // The old token no longer resolves.
    const get = await callCleanerGet(token);
    expect(get.body["ok"]).toBe(false);
    expect(get.body["error"]).toBe("invalid_link");
    // And the owner panel cannot re-fetch a link: nothing to fetch.
    const refetch = await callOwner({ action: "get_cleaner_link", booking_id: BID });
    expect(refetch.code).toBe(409);
    expect(refetch.body["error"]).toBe("link_not_reusable");
  });

  it("revoke is idempotent, and rotation after revoke issues a fresh link", async () => {
    const first = await callOwner({ action: "revoke_cleaner_link", booking_id: BID });
    expect(first.code).toBe(200);
    expect(first.body["revoked"]).toBe(false);
    const second = await callOwner({ action: "revoke_cleaner_link", booking_id: BID });
    expect(second.code).toBe(200);
    expect(second.body["revoked"]).toBe(false);
    // Rotation is a different action: it mints a NEW link afterwards.
    const rotated = await callOwner({ action: "cleaner_link", booking_id: BID });
    expect(rotated.body["ok"]).toBe(true);
    expect(String(rotated.body["url"])).toContain("ct2.");
    expect(rows[0]["cleaner_link_version"]).toBe("v2");
  });

  it("revoke works without a Stripe customer (DB-only, like owner_cancel)", async () => {
    // Issue the link, then make Stripe return no customer at all: the
    // shared preamble would 404 every customer-backed action, but
    // revoke runs before the lookup, so it still succeeds.
    await callOwner({ action: "cleaner_link", booking_id: BID });
    expect(rows[0]["cleaner_token_hash"]).not.toBeNull();
    noCustomer = true;
    const revoked = await callOwner({ action: "revoke_cleaner_link", booking_id: BID });
    expect(revoked.code).toBe(200);
    expect(revoked.body["revoked"]).toBe(true);
  });

  it("GET on a paid visit returns a summary without the address", async () => {
    const token = mintCleanerLinkV2(SECRET, VISIT_ID, ISSUANCE);
    rows[0] = makeRow({
      status: "paid",
      report_status: "sent",
      cleaner_token_hash: hashToken(token),
      cleaner_token_expires: new Date(Date.now() + 86400000).toISOString(),
      cleaner_link_version: "v2",
      cleaner_link_issuance: ISSUANCE,
    });
    const r = await callCleanerGet(token);
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["restricted"]).toBe(true);
    expect(r.body["editable"]).toBe(false);
    const visit = r.body["visit"] as Record<string, unknown>;
    expect(visit["service"]).toBe("Standard cleaning");
    expect(visit["address"]).toBeNull();
    expect(visit["entry"]).toBeNull();
    expect(visit["client_phone"]).toBeNull();
    expect(r.body["photos"]).toEqual([]);
    expect((r.body["checklist"] as { rooms: unknown[] }).rooms).toEqual([]);
    // But the visit itself is still identifiable (service/date/window).
    expect(visit["date"]).toBe("2026-11-12");
    expect(visit["window"]).toBe("midday");
  });

  it("GET on a cancelled visit is restricted too, and POST is refused with visit_closed", async () => {
    const token = mintCleanerLinkV2(SECRET, VISIT_ID, ISSUANCE);
    rows[0] = makeRow({
      status: "cancelled",
      report_status: "none",
      cleaner_token_hash: hashToken(token),
      cleaner_token_expires: new Date(Date.now() + 86400000).toISOString(),
      cleaner_link_version: "v2",
      cleaner_link_issuance: ISSUANCE,
    });
    const get = await callCleanerGet(token);
    expect(get.code).toBe(200);
    expect(get.body["restricted"]).toBe(true);
    expect((get.body["visit"] as Record<string, unknown>)["address"]).toBeNull();
    expect(get.body["cancelled"]).toBe(true);

    const post = await callCleanerPost({
      ct: token, action: "checklist",
      checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Counters cleaned", done: true }] }] },
    });
    expect(post.code).toBe(409);
    expect(post.body["error"]).toBe("visit_closed");
  });

  it("POST on a paid visit is refused with visit_closed", async () => {
    const token = mintCleanerLinkV2(SECRET, VISIT_ID, ISSUANCE);
    rows[0] = makeRow({
      status: "paid",
      report_status: "sent",
      cleaner_token_hash: hashToken(token),
      cleaner_token_expires: new Date(Date.now() + 86400000).toISOString(),
      cleaner_link_version: "v2",
      cleaner_link_issuance: ISSUANCE,
    });
    const post = await callCleanerPost({ ct: token, action: "submit" });
    expect(post.code).toBe(409);
    expect(post.body["error"]).toBe("visit_closed");
  });

  it("a live (confirmed, unsubmitted) visit is NOT restricted", async () => {
    const token = mintCleanerLinkV2(SECRET, VISIT_ID, ISSUANCE);
    rows[0] = makeRow({
      status: "confirmed",
      report_status: "draft",
      cleaner_token_hash: hashToken(token),
      cleaner_token_expires: new Date(Date.now() + 86400000).toISOString(),
      cleaner_link_version: "v2",
      cleaner_link_issuance: ISSUANCE,
    });
    const r = await callCleanerGet(token);
    expect(r.code).toBe(200);
    expect(r.body["restricted"]).toBeUndefined();
    expect((r.body["visit"] as Record<string, unknown>)["address"]).toBe("123 Secret St, Sugar Hill, GA");
  });
});
