// @vitest-environment node
// Visit confirmation flow: the owner confirms, the client sees Confirmed,
// the cleaner only works on confirmed visits, and a report submitted
// without confirmation is a "Needs review" record — never a client-facing
// "cleaning complete" next to "awaiting confirmation".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hashToken } from "../../api/_db";
import bookingAction from "../../api/booking-action";
import cleanerHandler from "../../api/cleaner";

const BID = "bid-confirm-flow";
const VISIT_ID = "22222222-3333-4444-5555-666666666666";

type Row = Record<string, unknown>;
type Ev = { visit_id: string | null; event: string };

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
  id: "cus_test_confirm",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "card_ready", gh_first_price_cents: "14900" },
};

function makeRow(overrides: Row = {}): Row {
  return {
    id: VISIT_ID,
    booking_id: BID,
    visit_no: 1,
    status: "requested",
    report_status: "none",
    visit_date: "2026-11-20",
    window: "midday",
    service: "Standard cleaning",
    client_name: "Casey Client",
    client_email: "client@example.com",
    amount_cents: 14900,
    cleaner_name: null,
    cleaner_token_hash: null,
    cleaner_token_expires: null,
    cleaner_link_version: null,
    cleaner_link_issuance: null,
    cleaner_profile: null,
    checklist: { rooms: [] },
    ...overrides,
  };
}

describe("visit confirmation flow", () => {
  let rows: Row[];
  let events: Ev[];
  let photos: Row[];
  let resendOk: boolean;

  const supRes = (data: unknown, ok = true, status = 200) => ({
    ok, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });

  const installFetch = () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("api.stripe.com")) {
        if (u.includes("/customers/search")) return supRes({ data: [{ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } }] });
        if (u.includes("/payment_methods")) return supRes({ data: [] });
        if (u.includes(`/customers/${CUSTOMER.id}`)) return supRes({ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } });
        return supRes({ id: CUSTOMER.id });
      }
      if (u.includes("api.resend.com")) return supRes({ id: "email-1" }, resendOk, resendOk ? 200 : 500);
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          const m = /id=eq\.([^&]+)/.exec(u) ?? /booking_id=eq\.([^&]+)/.exec(u);
          const key = m ? decodeURIComponent(m[1]) : "";
          // PostgREST in.(...) filter, used by compare-and-swap updates:
          // only rows in an expected pre-state are actually updated.
          const inM = /report_status=in\.\(([^)]+)\)/.exec(u);
          const allowed = inM ? new Set(decodeURIComponent(inM[1]).split(",")) : null;
          const matched = rows.filter((r) => (r["id"] === key || r["booking_id"] === key) && (!allowed || allowed.has(String(r["report_status"] ?? ""))));
          for (const r of matched) Object.assign(r, patch);
          const prefer = init?.headers?.["Prefer"] ?? init?.headers?.["prefer"] ?? "";
          return supRes(prefer.includes("return=representation") ? matched : null);
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          const created = { ...makeRow(), ...body, id: body["id"] ?? VISIT_ID };
          rows.push(created);
          return supRes([created]);
        }
        let out = [...rows];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const eq = (k: string) => {
          const v = qs.get(k);
          return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
        };
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
          const body = JSON.parse(String(init?.body ?? "{}")) as { visit_id?: string | null; event?: string };
          events.push({ visit_id: body.visit_id ?? null, event: body.event ?? "" });
          return supRes([{ id: events.length }]);
        }
        let out = [...events];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const eq = (k: string) => {
          const v = qs.get(k);
          return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
        };
        const vid = eq("visit_id");
        const ev = eq("event");
        if (vid) out = out.filter((e) => e.visit_id === vid);
        if (ev) out = out.filter((e) => e.event === ev);
        return supRes(out);
      }
      if (u.includes("/rest/v1/gh_photos")) {
        let out = [...photos];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const vid = qs.get("visit_id");
        if (vid && vid.startsWith("eq.")) out = out.filter((p) => p["visit_id"] === decodeURIComponent(vid.slice(3)));
        return supRes(out);
      }
      return supRes({}, false, 404);
    }));
  };

  const call = async (body: Record<string, unknown>, auth = "Bearer adm-secret") => {
    const r = res();
    await bookingAction(
      { method: "POST", headers: { authorization: auth }, body } as never,
      r as never,
    );
    return r;
  };

  const clean = async (method: "GET" | "POST", body: Record<string, unknown> | null, query: Record<string, string> = {}) => {
    const r = res();
    await cleanerHandler(
      { method, headers: {}, query, body } as never,
      r as never,
    );
    return r;
  };

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("CLEANER_LINK_SECRET", "test-cleaner-secret-123");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows = [makeRow()];
    events = [];
    photos = [];
    resendOk = true;
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const confirmVisit = () => call({
    action: "confirm", booking_id: BID,
    confirmed_date: "2026-11-20", confirmed_window: "midday",
  });

  const assignCleaner = async () => {
    rows[0]["cleaner_name"] = "Test Cleaner";
    rows[0]["cleaner_token_hash"] = hashToken("legacy-cleaner-token-1234567890");
    rows[0]["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
  };

  it("confirm is owner-only", async () => {
    await assignCleaner();
    const r = await call({
      action: "confirm", booking_id: BID,
      confirmed_date: "2026-11-20", confirmed_window: "midday",
    }, "Bearer wrong");
    expect(r.code).toBe(401);
    expect(rows[0]["status"]).toBe("requested");
  });

  it("confirm requires an assigned cleaner", async () => {
    const r = await confirmVisit();
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("cleaner_required");
    expect(rows[0]["status"]).toBe("requested");
  });

  it("confirm saves date, window, and cleaner, and logs the event", async () => {
    await assignCleaner();
    const r = await confirmVisit();
    expect(r.body["ok"]).toBe(true);
    expect(r.body["email_sent"]).toBe(true);
    expect(rows[0]["status"]).toBe("confirmed");
    expect(rows[0]["visit_date"]).toBe("2026-11-20");
    expect(rows[0]["window"]).toBe("midday");
    expect(events.some((e) => e.event === "visit_confirmed")).toBe(true);
    expect(events.some((e) => e.event === "confirmation_email_sent")).toBe(true);
  });

  it("re-confirming the same visit sends no duplicate email", async () => {
    await assignCleaner();
    const first = await confirmVisit();
    expect(first.body["email_sent"]).toBe(true);
    const second = await confirmVisit();
    expect(second.body["already_confirmed"]).toBe(true);
    expect(second.body["email_sent"]).toBe(false);
    expect(events.filter((e) => e.event === "visit_confirmed").length).toBe(1);
  });

  it("confirm refuses cancelled visits", async () => {
    await assignCleaner();
    rows[0]["status"] = "cancelled";
    const r = await confirmVisit();
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("invalid_transition");
  });

  it("a report submitted without confirmation needs review, repair confirms it", async () => {
    await assignCleaner();
    rows[0]["report_status"] = "submitted";
    rows[0]["status"] = "report_submitted";
    const blocked = await confirmVisit();
    expect(blocked.code).toBe(409);
    expect(blocked.body["error"]).toBe("needs_review");
    expect(rows[0]["status"]).toBe("report_submitted");
    const repaired = await call({
      action: "confirm", booking_id: BID,
      confirmed_date: "2026-11-20", confirmed_window: "midday", repair: true,
    });
    expect(repaired.body["ok"]).toBe(true);
    expect(rows[0]["status"]).toBe("confirmed");
    // The submitted report is kept in review, not dropped.
    expect(rows[0]["report_status"]).toBe("submitted");
    expect(events.some((e) => e.event === "visit_confirmed")).toBe(true);
  });

  it("email failure keeps the confirmation and resend delivers it", async () => {
    await assignCleaner();
    resendOk = false;
    const r = await confirmVisit();
    expect(r.body["ok"]).toBe(true);
    expect(r.body["email_sent"]).toBe(false);
    expect(rows[0]["status"]).toBe("confirmed");
    expect(events.some((e) => e.event === "confirmation_email_failed")).toBe(true);
    resendOk = true;
    const retry = await call({ action: "resend_confirmation", booking_id: BID });
    expect(retry.body["ok"]).toBe(true);
    expect(retry.body["email_sent"]).toBe(true);
    // Resend never re-creates the confirmation.
    expect(events.filter((e) => e.event === "visit_confirmed").length).toBe(1);
  });

  it("resend refuses an unconfirmed visit", async () => {
    const r = await call({ action: "resend_confirmation", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("not_confirmed");
  });

  it("cleaner submit is blocked on unconfirmed visits", async () => {
    await assignCleaner();
    const r = await clean("POST",
      { ct: "legacy-cleaner-token-1234567890", action: "submit", checklist: { rooms: [] } },
    );
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_not_confirmed");
    expect(rows[0]["report_status"]).toBe("none");
  });

  it("cleaner checklist edits are blocked on unconfirmed visits", async () => {
    await assignCleaner();
    const r = await clean("POST",
      { ct: "legacy-cleaner-token-1234567890", action: "checklist", checklist: { rooms: [] } },
    );
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_not_confirmed");
  });

  it("cleaner submit works after confirmation and reports the visit as confirmed", async () => {
    await assignCleaner();
    await confirmVisit();
    const r = await clean("POST",
      { ct: "legacy-cleaner-token-1234567890", action: "submit", checklist: { rooms: [] } },
    );
    expect(r.body["ok"]).toBe(true);
    // The finish now publishes straight to the client (no owner review).
    expect(r.body["published"]).toBe(true);
    expect(rows[0]["report_status"]).toBe("sent");
    expect(rows[0]["status"]).toBe("report_sent");
    const view = await clean("GET", null, { ct: "legacy-cleaner-token-1234567890", pv: "1" });
    expect(view.body["confirmed"]).toBe(true);
    expect(view.body["report_status"]).toBe("sent");
  });

  it("cleaner view reports unconfirmed visits as unconfirmed", async () => {
    await assignCleaner();
    const view = await clean("GET", null, { ct: "legacy-cleaner-token-1234567890", pv: "1" });
    expect(view.body["confirmed"]).toBe(false);
  });

  it("first publish requires confirmation; empty photos still fail after it", async () => {
    await assignCleaner();
    rows[0]["report_status"] = "submitted";
    rows[0]["status"] = "report_submitted";
    const blocked = await call({ action: "send_report", booking_id: BID });
    expect(blocked.code).toBe(409);
    expect(blocked.body["error"]).toBe("needs_confirmation");
    await call({
      action: "confirm", booking_id: BID,
      confirmed_date: "2026-11-20", confirmed_window: "midday", repair: true,
    });
    const noPhotos = await call({ action: "send_report", booking_id: BID });
    expect(noPhotos.code).toBe(409);
    expect(noPhotos.body["error"]).toBe("report_has_no_photos");
  });
});
