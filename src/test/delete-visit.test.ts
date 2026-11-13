// @vitest-environment node
// delete_visit (12.11.2026): the owner deletes a visit permanently from
// the owner cabinet. The action is DB-only — it runs before the
// Stripe-customer lookup and never calls Stripe (payments, customers
// and payouts stay exactly as they are). It removes, for one booking:
//   - every gh_visits row for the booking (the cleaner link dies with
//     the row: it is derived from the row's token/issuance columns),
//   - all gh_events rows for the booking,
//   - gh_photos rows + the private-bucket objects under
//     visits/<visitId>/...,
//   - the gh_visit_access row (entry arrangement, secret included).
// Idempotent: deleting an already-deleted visit succeeds with
// deleted: false, already_deleted: true.
//
// Task 4 (12.11.2026): the visit history is protected — a PAID or
// REFUNDED visit, or one with an open or EVER-filed issue, is never
// deleted. delete_visit answers 409 visit_protected and deletes
// NOTHING (row, journal, photos and access all stay). Only a
// requested/confirmed visit with no payment and no complaint may
// still be deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";

const VISIT_ID = "33333333-4444-5555-6666-777777777777";
const BID = "bid-delete-1";
const PHOTO_PATH = `visits/${VISIT_ID}/kitchen/20261112-abc1234.jpg`;

type Row = Record<string, unknown>;

let visits: Row[];
let events: Row[];
let photos: Row[];
let access: Row[];
let storageRemoved: string[];
let stripeCalls: string[];

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

function makeVisit(overrides: Row = {}): Row {
  return {
    id: VISIT_ID,
    booking_id: BID,
    visit_no: 1,
    status: "requested",
    report_status: "none",
    visit_date: "2026-11-16",
    window: "morning",
    client_name: "Test Client",
    client_email: "client@example.com",
    cleaner_name: null,
    cleaner_token_hash: "deadbeef",
    cleaner_link_version: "v2",
    cleaner_link_issuance: "aabbccddeeff00112233445566778899",
    ...overrides,
  };
}

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
      stripeCalls.push(u);
      return supRes({ data: [] });
    }
    if (u.includes("api.resend.com")) return supRes({ id: "email-1" });
    // Storage object delete: POST/DELETE /storage/v1/object/report-photos
    // with { prefixes: [path] }.
    if (u.includes("/storage/v1/object/report-photos")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prefixes?: string[] };
      for (const p of body.prefixes ?? []) storageRemoved.push(p);
      return supRes({});
    }
    const table = (name: string, rows: Row[]) => {
      if (!u.includes(`/rest/v1/${name}`)) return null;
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const eq = (k: string) => {
        const v = qs.get(k);
        return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
      };
      const bid = eq("booking_id");
      const vid = eq("visit_id");
      const id = eq("id");
      const match = (r: Row) =>
        (bid === null || r["booking_id"] === bid) &&
        (vid === null || r["visit_id"] === vid) &&
        (id === null || r["id"] === id);
      if (method === "DELETE") {
        const gone = rows.filter(match);
        for (const r of gone) rows.splice(rows.indexOf(r), 1);
        return supRes(gone);
      }
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Row;
        const created = { ...body, id: body["id"] ?? `new-${rows.length}` };
        rows.push(created);
        return supRes([created]);
      }
      return supRes(rows.filter(match));
    };
    return (
      table("gh_visits", visits) ??
      table("gh_events", events) ??
      table("gh_photos", photos) ??
      table("gh_visit_access", access) ??
      supRes([])
    );
  }));
}

const callOwner = async (body: Record<string, unknown>, auth = true) => {
  const r = res();
  await bookingAction(
    { method: "POST", headers: auth ? { authorization: "Bearer " + "adm-" + "secret" } : {}, body } as never,
    r as never,
  );
  return r;
};

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  visits = [makeVisit()];
  events = [
    { id: "e1", visit_id: VISIT_ID, booking_id: BID, event: "visit_created" },
    { id: "e2", visit_id: VISIT_ID, booking_id: BID, event: "issue_opened" },
  ];
  photos = [{ id: "p1", visit_id: VISIT_ID, storage_path: PHOTO_PATH, room: "Kitchen", kind: "after" }];
  access = [{ id: "a1", visit_id: VISIT_ID, booking_id: BID, entry_method: "arrange", entry_secret: "v1.abc.def" }];
  storageRemoved = [];
  stripeCalls = [];
  installFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("booking-action delete_visit", () => {
  it("deletes the visit row, journal, photos (+bucket objects) and entry arrangement, without touching Stripe", async () => {
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["booking_id"]).toBe(BID);
    expect(r.body["deleted"]).toBe(true);
    expect(r.body["visit_ids"]).toEqual([VISIT_ID]);
    expect(r.body["photos_removed"]).toBe(1);
    expect(r.body["photos_storage_failed"]).toBe(0);
    expect(r.body["events_deleted"]).toBe(2);
    expect(visits).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(photos).toHaveLength(0);
    expect(access).toHaveLength(0);
    expect(storageRemoved).toEqual([PHOTO_PATH]);
    expect(stripeCalls).toHaveLength(0);
  });

  it("deletes a visit with no photos, events or entry row", async () => {
    events = [];
    photos = [];
    access = [];
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["deleted"]).toBe(true);
    expect(r.body["photos_removed"]).toBe(0);
    expect(r.body["events_deleted"]).toBe(0);
    expect(visits).toHaveLength(0);
    expect(stripeCalls).toHaveLength(0);
  });

  it("is idempotent: a second delete of the same booking succeeds with deleted: false", async () => {
    const first = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(first.code).toBe(200);
    expect(first.body["deleted"]).toBe(true);
    const second = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(second.code).toBe(200);
    expect(second.body["ok"]).toBe(true);
    expect(second.body["deleted"]).toBe(false);
    expect(second.body["already_deleted"]).toBe(true);
    expect(stripeCalls).toHaveLength(0);
  });

  it("deleting a never-existing booking is also a no-op success", async () => {
    const r = await callOwner({ action: "delete_visit", booking_id: "bid-never-existed" });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["deleted"]).toBe(false);
    expect(r.body["already_deleted"]).toBe(true);
    expect(visits).toHaveLength(1);
  });

  it("requires owner auth: no token → 401 and nothing is deleted", async () => {
    const r = await callOwner({ action: "delete_visit", booking_id: BID }, false);
    expect(r.code).toBe(401);
    expect(r.body["ok"]).toBe(false);
    expect(visits).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(photos).toHaveLength(1);
    expect(stripeCalls).toHaveLength(0);
  });

  it("refuses a paid visit (409 visit_protected) and deletes NOTHING — row, journal, photos and entry all stay", async () => {
    visits = [makeVisit({ status: "paid" })];
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["ok"]).toBe(false);
    expect(r.body["error"]).toBe("visit_protected");
    expect(r.body["reason"]).toBe("paid");
    expect(r.body["visit_id"]).toBe(VISIT_ID);
    expect(visits).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(photos).toHaveLength(1);
    expect(access).toHaveLength(1);
    expect(storageRemoved).toHaveLength(0);
    expect(stripeCalls).toHaveLength(0);
  });

  it("refuses a refunded visit (409 visit_protected) and deletes nothing", async () => {
    visits = [makeVisit({ status: "refunded" })];
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_protected");
    expect(r.body["reason"]).toBe("refunded");
    expect(visits).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(photos).toHaveLength(1);
    expect(storageRemoved).toHaveLength(0);
  });

  it("refuses a visit with an open issue (409 visit_protected) and deletes nothing", async () => {
    visits = [makeVisit({ status: "report_submitted", issue_open: true })];
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_protected");
    expect(r.body["reason"]).toBe("issue_open");
    expect(visits).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(photos).toHaveLength(1);
    expect(storageRemoved).toHaveLength(0);
  });

  it("refuses a visit with a past (resolved) issue (409 visit_protected) and deletes nothing", async () => {
    visits = [makeVisit({ status: "report_submitted", issue_open: false, issue_ever: true })];
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_protected");
    expect(r.body["reason"]).toBe("issue_ever");
    expect(visits).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(photos).toHaveLength(1);
    expect(storageRemoved).toHaveLength(0);
  });

  it("still deletes a requested visit with no payment and no complaint", async () => {
    visits = [makeVisit({ status: "requested", issue_open: false, issue_ever: false })];
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["deleted"]).toBe(true);
    expect(visits).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(photos).toHaveLength(0);
    expect(access).toHaveLength(0);
  });
});
