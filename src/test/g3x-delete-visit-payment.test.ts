// @vitest-environment node
// G3X (top-5 round): delete_visit must refuse any visit with a payment.
//
// The old guard only knew paid/refunded rows and issue history. A visit
// with a charge in flight (payment_pending), a fee that was paid, is in
// flight, or even has a recorded intent, or a payment the journal
// recorded while the row never flipped, could still be deleted — erasing
// the exact record a chargeback or duplicate-charge claim needs. Only
// unpaid, uncharged visits may be deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";

const VISIT_ID = "33333333-4444-5555-6666-777777777777";
const BID = "bid-g3x-delete";
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
    issue_open: false,
    issue_ever: false,
    fee_status: null,
    fee_intent_id: null,
    fee_amount_cents: null,
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
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  visits = [makeVisit()];
  events = [{ id: "e1", visit_id: VISIT_ID, booking_id: BID, event: "visit_created" }];
  photos = [{ id: "p1", visit_id: VISIT_ID, storage_path: PHOTO_PATH, room: "Kitchen", kind: "after" }];
  access = [{ id: "a1", visit_id: VISIT_ID, booking_id: BID, entry_method: "arrange", entry_secret: "v1.abc.def" }];
  storageRemoved = [];
  stripeCalls = [];
  installFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("G3X delete_visit refuses any visit with a payment", () => {
  const assertNothingDeleted = (eventCount = 1) => {
    expect(visits).toHaveLength(1);
    expect(events).toHaveLength(eventCount);
    expect(photos).toHaveLength(1);
    expect(access).toHaveLength(1);
    expect(storageRemoved).toHaveLength(0);
    expect(stripeCalls).toHaveLength(0);
  };

  it("refuses a visit with a charge in flight (payment_pending)", async () => {
    visits = [makeVisit({ status: "payment_pending" })];
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_protected");
    expect(r.body["reason"]).toBe("payment_pending");
    assertNothingDeleted();
  });

  it("refuses a visit whose fee was paid (fee_paid)", async () => {
    visits = [makeVisit({ status: "cancelled", fee_status: "fee_paid", fee_intent_id: "pi_fee", fee_amount_cents: 2500 })];
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_protected");
    expect(r.body["reason"]).toBe("fee_paid");
    assertNothingDeleted();
  });

  it("refuses a visit whose fee is in flight (fee_pending)", async () => {
    visits = [makeVisit({ status: "cancelled", fee_status: "fee_pending", fee_intent_id: "pi_fee", fee_amount_cents: 2500 })];
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_protected");
    expect(r.body["reason"]).toBe("fee_pending");
    assertNothingDeleted();
  });

  it("refuses a visit with a recorded fee intent even after a failed attempt", async () => {
    visits = [makeVisit({ status: "cancelled", fee_status: "fee_failed", fee_intent_id: "pi_fee", fee_amount_cents: 2500 })];
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_protected");
    expect(r.body["reason"]).toBe("fee_intent");
    assertNothingDeleted();
  });

  it("refuses a visit whose journal records a cleaning payment while the row never flipped", async () => {
    visits = [makeVisit({ status: "report_sent" })];
    events = [
      { id: "e1", visit_id: VISIT_ID, booking_id: BID, event: "visit_created" },
      { id: "e2", visit_id: VISIT_ID, booking_id: BID, event: "payment_succeeded", detail: { payment_intent: "pi_clean" } },
    ];
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_protected");
    expect(r.body["reason"]).toBe("payment_record");
    expect(visits).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(photos).toHaveLength(1);
    expect(storageRemoved).toHaveLength(0);
  });

  it("refuses a visit whose journal records a fee payment", async () => {
    visits = [makeVisit({ status: "cancelled" })];
    events = [
      { id: "e1", visit_id: VISIT_ID, booking_id: BID, event: "visit_created" },
      { id: "e2", visit_id: VISIT_ID, booking_id: BID, event: "fee_charged", detail: { fee_cents: 2500 } },
    ];
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_protected");
    expect(r.body["reason"]).toBe("payment_record");
    expect(visits).toHaveLength(1);
  });

  it("still deletes an unpaid, uncharged visit with no payment record", async () => {
    const r = await callOwner({ action: "delete_visit", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["deleted"]).toBe(true);
    expect(visits).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(photos).toHaveLength(0);
    expect(access).toHaveLength(0);
    expect(storageRemoved).toEqual([PHOTO_PATH]);
  });
});
