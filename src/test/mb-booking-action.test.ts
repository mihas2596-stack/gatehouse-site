// @vitest-environment node
// MB-booking-action: maximal-audit fixes in api/booking-action.ts
// (MB-10/11/12/17/18/20/21/24, LB-01/05/06/07). Each test drives the
// real handler through a mocked Stripe + Supabase fetch.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/booking-action";
import { isFutureVisitDate } from "../../api/_visit_date";

const BID = "bid-mb-booking-action";
const VISIT_ID = "mb000001-6666-7777-8888-999999999999";
const CUS = "cus_mb1";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const ev = (event: string, detail: Record<string, unknown> | null, created_at: string): Ev =>
  ({ event, detail, created_at });
const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
const tomorrow = fmtDate(new Date(Date.now() + 24 * 3600 * 1000));
const yesterday = fmtDate(new Date(Date.now() - 24 * 3600 * 1000));

let visitRows: Row[];
let events: Ev[];
let storeMeta: Record<string, string>;
let photos: Row[];
let roster: Row[];
let piCalls: number;
let piKeys: string[];
let searchedIntents: Row[];
let piResponse: Record<string, unknown>;
let stripePostOk: boolean;
let patchFailTokenHash: boolean;
let casReturnZero: boolean;
let upsertMode: "ok" | "null";
let visitGets: number;
let freshRow: Row | null;
let freshRowAfterGets: number;

const baseRow = (): Row => ({
  id: VISIT_ID, booking_id: BID, status: "requested", amount_cents: 20000,
  cleaner_name: null, client_email: "client@example.com", client_name: "Casey Client",
  report_sent_at: null, report_bounced: false, report_status: "none",
  visit_date: "2026-11-10", window: "midday", service: "Standard cleaning",
  checklist: { rooms: [
    { name: "Kitchen", items: [] }, { name: "Bathroom", items: [] },
    { name: "Bedroom", items: [] }, { name: "Living room", items: [] },
  ] },
  cleaner_token_expires: null, cleaner_link_version: null,
  cleaner_link_issuance: null, cleaner_token_hash: null,
});

const baseMeta = (): Record<string, string> => ({
  gh_booking_id: BID, gh_state: "card_ready", gh_first_price_cents: "20000",
  gh_report_amount_cents: "20000", gh_payment_method: "pm_1",
  gh_report_version: "1", gh_service: "Standard cleaning",
});

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

const call = async (body: Record<string, unknown>) => {
  const r = res();
  await handler(
    { method: "POST", headers: { authorization: "Bearer " + "adm-" + "secret" }, body: { booking_id: BID, ...body } },
    r as never,
  );
  return r;
};

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: unknown }) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const okRes = (data: unknown, ok = true, status = 200) => ({
      ok, status,
      json: async () => data,
      text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
      headers: { get: (n: string) => {
        if (n.toLowerCase() === "content-type") return "image/jpeg";
        if (n.toLowerCase() === "content-length") return "12345";
        return null;
      } },
    });
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        return okRes({ data: [{ id: CUS, email: "client@example.com", name: "Casey Client", metadata: { ...storeMeta } }] });
      }
      if (u.pathname.includes("/payment_methods") && u.pathname.includes("/customers/")) {
        const params = new URLSearchParams(u.search);
        const after = params.get("starting_after");
        if (after) return okRes({ data: [{ id: "pm_11", card: { brand: "visa", last4: "4242" } }], has_more: false });
        const first = Array.from({ length: 10 }, (_, i) => ({ id: `pm_${i + 1}`, card: { brand: "visa", last4: "0001" } }));
        return okRes({ data: first, has_more: true });
      }
      if (/\/payment_methods\/pm_/.test(u.pathname)) {
        return okRes({ id: "pm_11", card: { brand: "visa", last4: "4242" } });
      }
      if (u.pathname.endsWith("/payment_intents/search")) return okRes({ data: searchedIntents });
      if (u.pathname.endsWith("/payment_intents")) {
        piCalls++;
        const h = (init?.headers ?? {}) as Record<string, string>;
        if (typeof h["Idempotency-Key"] === "string") piKeys.push(h["Idempotency-Key"]);
        return okRes({ ...piResponse });
      }
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (custM) {
        if (init?.body) {
          if (!stripePostOk) return okRes({ error: { message: "boom" } }, false, 500);
          const params = new URLSearchParams(String(init.body));
          for (const [k, v] of params.entries()) {
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) storeMeta[m[1]] = v;
          }
          return okRes({ id: CUS });
        }
        return okRes({ id: CUS, email: "client@example.com", name: "Casey Client", metadata: { ...storeMeta } });
      }
      return okRes({ id: CUS });
    }
    if (u.hostname === "test.supabase.co") {
      if (u.pathname.includes("/storage/v1/object/")) {
        // HEAD probe (storageObjectInfo) and signed-URL endpoints.
        if (u.pathname.includes("/object/upload/sign/")) return okRes({ url: "/object/upload/sign/x" });
        if (u.pathname.includes("/object/sign/")) return okRes({ signedURL: "/signed/x" });
        return okRes({});
      }
      if (u.pathname.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          if (patchFailTokenHash && patch["cleaner_token_hash"]) return okRes({ error: "db down" }, false, 500);
          if (casReturnZero && u.search.includes("report_status=eq")) return okRes([]);
          const m = /id=eq\.([^&]+)/.exec(u.search);
          const key = m ? decodeURIComponent(m[1]) : "";
          const matched = visitRows.filter((r) => r["id"] === key);
          for (const r of matched) Object.assign(r, patch);
          return okRes(matched);
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          const created = { ...body, id: "row-new", created_at: "2026-11-13T10:00:01Z" };
          visitRows.push(created);
          return okRes([created]);
        }
        visitGets++;
        if (freshRow && visitGets >= freshRowAfterGets) return okRes([freshRow]);
        let out = [...visitRows];
        const qs = new URLSearchParams(u.search);
        const bid = qs.get("booking_id");
        if (bid?.startsWith("eq.")) out = out.filter((r) => r["booking_id"] === decodeURIComponent(bid.slice(3)));
        const idEq = qs.get("id");
        if (idEq?.startsWith("eq.")) out = out.filter((r) => r["id"] === decodeURIComponent(idEq.slice(3)));
        const limit = Number(qs.get("limit") ?? "10");
        return okRes(out.slice(0, Number.isFinite(limit) ? limit : 10));
      }
      if (u.pathname.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { event?: string; detail?: Record<string, unknown> | null };
          events.push({ event: body.event ?? "", detail: body.detail ?? null, created_at: new Date().toISOString() });
          return okRes([{ id: events.length }]);
        }
        return okRes([...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));
      }
      if (u.pathname.includes("/rest/v1/gh_cleaners")) {
        return okRes(roster);
      }
      if (u.pathname.includes("/rest/v1/gh_photos")) {
        if (method === "POST") {
          if (u.search.includes("on_conflict=storage_path")) {
            if (upsertMode === "null") return okRes([]);
            const body = JSON.parse(String(init?.body ?? "{}")) as Row;
            const created = { ...body, id: "photo-9" };
            photos.push(created);
            return okRes([created]);
          }
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          const created = { ...body, id: "photo-9" };
          photos.push(created);
          return okRes([created]);
        }
        return okRes([...photos]);
      }
      return okRes([]);
    }
    return okRes({});
  }));
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_123");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  visitRows = [baseRow()];
  events = [ev("visit_created", {}, hoursAgo(50))];
  storeMeta = baseMeta();
  photos = [];
  roster = [{ id: "cl_1", name: "Dana", phone: null, photo_url: null, active: true }];
  piCalls = 0;
  piKeys = [];
  searchedIntents = [];
  piResponse = { id: "pi_1", status: "succeeded" };
  stripePostOk = true;
  patchFailTokenHash = false;
  casReturnZero = false;
  upsertMode = "ok";
  visitGets = 0;
  freshRow = null;
  freshRowAfterGets = Number.POSITIVE_INFINITY;
  installFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("MB-20 / LB-07 — impossible calendar dates", () => {
  it("isFutureVisitDate blocks impossible dates (fail closed), not absent ones", () => {
    expect(isFutureVisitDate("2026-02-30")).toBe(true);
    expect(isFutureVisitDate("2026-13-40")).toBe(true);
    expect(isFutureVisitDate("")).toBe(false);
    expect(isFutureVisitDate(null)).toBe(false);
    expect(isFutureVisitDate("2020-01-01")).toBe(false);
    expect(isFutureVisitDate("2999-01-01")).toBe(true);
  });

  it("confirm rejects 2026-02-30 as invalid_date", async () => {
    visitRows[0]["cleaner_name"] = "Dana";
    storeMeta["gh_cleaner_name"] = "Dana";
    const r = await call({ action: "confirm", confirmed_date: "2026-02-30", confirmed_window: "midday" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_date");
  });

  it("assign_confirm rejects 2026-13-40 as invalid_date", async () => {
    const r = await call({ action: "assign_confirm", cleaner_id: "cl_1", confirmed_date: "2026-13-40", confirmed_window: "midday" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_date");
  });
});

describe("LB-01 — owner-charge reminder guard is publication-scoped", () => {
  const chargeSetup = () => {
    visitRows[0]["status"] = "report_sent";
    visitRows[0]["report_sent_at"] = hoursAgo(30);
    visitRows[0]["report_status"] = "sent";
    storeMeta["gh_state"] = "report_sent";
    storeMeta["gh_report_sent_at"] = hoursAgo(30);
    events = [
      ev("report_sent", { version: 2, email_sent: true }, String(visitRows[0].report_sent_at)),
      ev("report_sent", { version: 1 }, hoursAgo(50)),
      ev("visit_created", {}, hoursAgo(50)),
    ];
  };

  it("a reminder for the OLD publication does not satisfy the guard", async () => {
    chargeSetup();
    events = [ev("reminder_sent", {}, hoursAgo(49)), ...events];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 2 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("needs_reminder_confirm");
    expect(piCalls).toBe(0);
  });

  it("a reminder after the current publication satisfies the guard", async () => {
    chargeSetup();
    events = [ev("reminder_sent", {}, hoursAgo(10)), ...events];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 2 });
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("paid");
    expect(piCalls).toBe(1);
  });

  it("a reminder bounced after the send does not satisfy the guard", async () => {
    chargeSetup();
    events = [ev("reminder_bounced", {}, hoursAgo(5)), ev("reminder_sent", {}, hoursAgo(10)), ...events];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 2 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("needs_reminder_confirm");
    expect(piCalls).toBe(0);
  });
});

describe("MB-10 — owner charge 3DS returns the completion pair", () => {
  it("payment_requires_action carries client_secret + publishable_key", async () => {
    visitRows[0]["status"] = "report_sent";
    visitRows[0]["report_sent_at"] = hoursAgo(30);
    visitRows[0]["report_status"] = "sent";
    storeMeta["gh_state"] = "report_sent";
    storeMeta["gh_report_sent_at"] = hoursAgo(30);
    events = [
      ev("report_approved", { via: "client" }, hoursAgo(29)),
      ev("report_sent", { version: 1 }, hoursAgo(30)),
      ev("visit_created", {}, hoursAgo(50)),
    ];
    piResponse = { id: "pi_1", status: "requires_action", client_secret: "pi_1_secret_abc" };
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(402);
    expect(r.body["error"]).toBe("payment_requires_action");
    expect(r.body["client_secret"]).toBe("pi_1_secret_abc");
    expect(r.body["publishable_key"]).toBe("pk_test_123");
    expect(r.body["payment_intent"]).toBe("pi_1");
  });
});

describe("MB-11 — set_cleaner guards and checked writes", () => {
  it("refuses a paid visit", async () => {
    visitRows[0]["status"] = "paid";
    visitRows[0]["cleaner_name"] = "Dana";
    const r = await call({ action: "set_cleaner", cleaner_name: "Dana" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("invalid_transition");
  });

  it("refuses a cancelled visit", async () => {
    visitRows[0]["status"] = "cancelled";
    visitRows[0]["cleaner_name"] = "Dana";
    const r = await call({ action: "set_cleaner", cleaner_name: "Dana" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("invalid_transition");
  });

  it("a failed Stripe metadata write is a 502, not a 200", async () => {
    visitRows[0]["status"] = "confirmed";
    stripePostOk = false;
    const r = await call({ action: "set_cleaner", cleaner_name: "Dana" });
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("stripe_error");
  });

  it("a failed link issue is a 502, not a 200 with reusable:false and no url", async () => {
    visitRows[0]["status"] = "confirmed";
    patchFailTokenHash = true;
    const r = await call({ action: "set_cleaner", cleaner_name: "Dana" });
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("cleaner_link_failed");
    expect(r.body["url"]).toBeUndefined();
  });
});

describe("MB-12 — failed link rotation is surfaced", () => {
  it("confirm surfaces a failed rotation and journals it", async () => {
    visitRows[0]["status"] = "requested";
    visitRows[0]["cleaner_name"] = "Dana";
    visitRows[0]["cleaner_token_expires"] = new Date(Date.now() - 3600 * 1000).toISOString();
    storeMeta["gh_cleaner_name"] = "Dana";
    patchFailTokenHash = true;
    const r = await call({ action: "confirm", confirmed_date: tomorrow, confirmed_window: "midday" });
    expect(r.code).toBe(200);
    expect(r.body["booking_confirmed"]).toBe(true);
    expect(r.body["cleaner_link_rotation_failed"]).toBe(true);
    expect(events.some((e) => e.event === "cleaner_link_rotation_failed")).toBe(true);
  });

  it("assign_confirm does not show the old expiring link as live", async () => {
    visitRows[0]["status"] = "confirmed";
    visitRows[0]["cleaner_name"] = "Dana";
    visitRows[0]["cleaner_id"] = "cl_1";
    visitRows[0]["visit_date"] = yesterday;
    visitRows[0]["cleaner_token_expires"] = new Date(Date.now() - 3600 * 1000).toISOString();
    events = [ev("visit_confirmed", { date: yesterday, window: "midday" }, hoursAgo(26)), ...events];
    patchFailTokenHash = true;
    const r = await call({ action: "assign_confirm", cleaner_id: "cl_1", confirmed_date: tomorrow, confirmed_window: "midday" });
    expect(r.code).toBe(200);
    expect(r.body["cleaner_link_rotation_failed"]).toBe(true);
    expect(r.body["url"]).toBeUndefined();
  });
});

describe("MB-17 — send_report CAS fallthrough", () => {
  it("a lost claim on a moved row is a 409, not already_sent:true", async () => {
    visitRows[0]["status"] = "confirmed";
    visitRows[0]["report_status"] = "submitted";
    visitRows[0]["visit_date"] = "2026-11-10";
    events = [ev("visit_confirmed", { date: "2026-11-10", window: "midday" }, hoursAgo(50)), ...events];
    photos = [{ id: "ph1", room: "Kitchen", storage_path: `visits/${VISIT_ID}/kitchen/x.jpg`, kind: "before" }];
    casReturnZero = true;
    freshRow = { ...visitRows[0], report_status: "returned", status: "confirmed" };
    freshRowAfterGets = 3;
    const r = await call({ action: "send_report", photos: [{ url: "https://example.com/a.jpg" }] });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_state_changed");
    expect(r.body["report_status"]).toBe("returned");
  });
});

describe("MB-18 / MB-21 — owner photos mirror the cleaner path", () => {
  it("owner_photo_sign rejects an invented room", async () => {
    const r = await call({ action: "owner_photo_sign", room: "Attic" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_room");
  });

  it("owner_photo_sign accepts a scope room", async () => {
    const r = await call({ action: "owner_photo_sign", room: "Kitchen" });
    expect(r.code).toBe(200);
    expect(typeof r.body["upload_url"]).toBe("string");
    expect(String(r.body["storage_path"] ?? "")).toMatch(new RegExp(`^visits/${VISIT_ID}/kitchen/`));
  });

  it("owner_photo_register rejects an invented room", async () => {
    const r = await call({
      action: "owner_photo_register", room: "Attic", kind: "before",
      storage_path: `visits/${VISIT_ID}/attic/x.jpg`,
    });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_room");
  });

  it("owner_photo_register dedups a retry instead of a second row", async () => {
    const path = `visits/${VISIT_ID}/kitchen/x.jpg`;
    photos = [{ id: "ph1", room: "Kitchen", storage_path: path, kind: "before" }];
    const r = await call({ action: "owner_photo_register", room: "Kitchen", kind: "before", storage_path: path });
    expect(r.code).toBe(200);
    expect(r.body["already"]).toBe(true);
    expect(photos).toHaveLength(1);
  });

  it("owner_photo_register upserts and returns the photo id", async () => {
    const r = await call({
      action: "owner_photo_register", room: "Kitchen", kind: "before",
      storage_path: `visits/${VISIT_ID}/kitchen/new.jpg`,
    });
    expect(r.code).toBe(200);
    expect(r.body["photo_id"]).toBe("photo-9");
  });

  it("owner_photo_register without the unique index falls back to insert", async () => {
    upsertMode = "null";
    const r = await call({
      action: "owner_photo_register", room: "Kitchen", kind: "before",
      storage_path: `visits/${VISIT_ID}/kitchen/new.jpg`,
    });
    expect(r.code).toBe(200);
    expect(r.body["photo_id"]).toBe("photo-9");
    expect(photos).toHaveLength(1);
  });

  it("owner_photo_register enforces the cap of 60", async () => {
    photos = Array.from({ length: 60 }, (_, i) => ({
      id: `ph${i}`, room: "Kitchen", storage_path: `visits/${VISIT_ID}/kitchen/${i}.jpg`, kind: "before",
    }));
    const r = await call({
      action: "owner_photo_register", room: "Kitchen", kind: "after",
      storage_path: `visits/${VISIT_ID}/kitchen/61.jpg`,
    });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("too_many_photos");
  });
});

describe("LB-05 — charge_fee allowlist 0/2500", () => {
  it("a journal fee of 9999 is refused, never charged", async () => {
    visitRows[0]["status"] = "cancelled";
    events = [ev("visit_cancelled", { fee_cents: 9999 }, hoursAgo(5)), ...events];
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("fee_basis_mismatch");
    expect(piCalls).toBe(0);
  });

  it("a journal fee of 0 is no_fee_due", async () => {
    visitRows[0]["status"] = "cancelled";
    events = [ev("visit_cancelled", { fee_cents: 0 }, hoursAgo(5)), ...events];
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("no_fee_due");
  });
});

describe("MB-02 — charge_fee idempotency key is bound, search walks all fee intents", () => {
  const feeSetup = () => {
    visitRows[0]["status"] = "cancelled";
    events = [
      ev("visit_cancelled", { fee_cents: 2500 }, hoursAgo(5)),
      ev("card_confirmed", { payment_method_id: "pm_1", brand: "visa", last4: "4242" }, hoursAgo(6)),
      ...events,
    ];
  };
  const feeIntent = (id: string, status: string, created: number): Row => ({
    id, status, created, amount: 2500, currency: "usd", customer: CUS,
    metadata: { gh_kind: "cancellation_fee", gh_booking_id: BID },
  });

  it("a canceled newest intent does not hide an older live one — the live one is adopted, nothing is created", async () => {
    feeSetup();
    searchedIntents = [feeIntent("pi_fee_new", "canceled", 200), feeIntent("pi_fee_old", "succeeded", 100)];
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(200);
    expect(r.body["payment_intent"]).toBe("pi_fee_old");
    expect(r.body["adopted"]).toBe(true);
    expect(piCalls).toBe(0);
    expect(events.some((e) => e.event === "fee_charged" && (e.detail?.["payment_intent"] as string) === "pi_fee_old")).toBe(true);
  });

  it("create binds the key to (booking, amount, card) — a retry replays the same attempt, never a bare fee_<bid>", async () => {
    feeSetup();
    searchedIntents = [];
    piResponse = { id: "pi_fee_new", status: "succeeded" };
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(200);
    expect(piCalls).toBe(1);
    expect(piKeys).toHaveLength(1);
    expect(piKeys[0]).toMatch(/^fee_bid-mb-booking-action_2500_[0-9a-f]{12}$/);
  });

  it("a search with only a canceled intent still creates — with the bound key, not by replaying the dead intent", async () => {
    feeSetup();
    searchedIntents = [feeIntent("pi_fee_dead", "canceled", 200)];
    piResponse = { id: "pi_fee_new", status: "succeeded" };
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(200);
    expect(piCalls).toBe(1);
    expect(piKeys[0]).toMatch(/^fee_bid-mb-booking-action_2500_[0-9a-f]{12}$/);
  });
});

describe("LB-06 — card list is paged, not one page of 10", () => {
  it("status finds the booking card on the second page", async () => {
    storeMeta["gh_payment_method"] = "";
    storeMeta["gh_state"] = "requested";
    events = [
      ev("card_confirmed", { payment_method_id: "pm_11", brand: "visa", last4: "4242" }, hoursAgo(5)),
      ...events,
    ];
    const r = await call({ action: "status" });
    expect(r.code).toBe(200);
    expect(r.body["payment_method"]).toBe("saved");
    expect(r.body["card_on_file"]).toBe(true);
    expect(r.body["card_brand"]).toBe("visa");
    expect(r.body["card_last4"]).toBe("4242");
  });
});

describe("MB-24 — cleaner-link backfill scope is provisional", () => {
  it("a Stripe-only booking gets scope_provisional:true and a journal mark", async () => {
    visitRows = [];
    const r = await call({ action: "cleaner_link" });
    expect(r.code).toBe(200);
    expect(typeof r.body["url"]).toBe("string");
    expect(r.body["scope_provisional"]).toBe(true);
    expect(events.some((e) => e.event === "cleaner_link_scope_provisional")).toBe(true);
  });

  it("an existing row is not marked provisional", async () => {
    const r = await call({ action: "cleaner_link" });
    expect(r.code).toBe(200);
    expect(r.body["scope_provisional"]).toBeUndefined();
  });
});
