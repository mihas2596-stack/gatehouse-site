// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import visitHandler, { deriveVisitState, cancelFeeCents } from "../../api/visit";
import reportHandler from "../../api/report";
import adminHandler from "../../api/booking-action";
import autoChargeHandler from "../../api/auto-charge";
import { signBooking } from "../../api/create-checkout-session";

// Client-path v2:
//  - /api/visit: plain-language states, alt-date flow, cancel with the
//    server-computed Terms fee, access notes.
//  - report issues carry a room + an optional photo (photo/email
//    failure never blocks the paused charge);
//  - the timer reminds once before the deadline and deletes report
//    photo links after 90 days (the promised retention);
//  - operator: decline_date / set_cleaner / charge_fee / delete_card.

const ADMIN = ["adm", "secret"].join("-");
const CRON = ["cron", "secret"].join("-");

type StoreCust = { id: string; email: string; name: string; metadata: Record<string, string> };
let store: StoreCust[];
let dbRows: Record<string, unknown>[];
let dbEvents: Record<string, unknown>[];
let piCalls: Array<{ body: URLSearchParams }>;
function matchCond(row: Record<string, unknown>, field: string, op: string, val: string): boolean {
  const v = row[field]; const dec = decodeURIComponent(val);
  if (op === "eq") return String(v ?? "") === dec;
  if (op === "neq") return v !== null && v !== undefined && String(v) !== dec;
  if (op === "is") return dec === "null" ? v === null || v === undefined : v !== null && v !== undefined;
  if (op === "lt") return String(v ?? "") < dec; if (op === "lte") return String(v ?? "") <= dec;
  if (op === "gt") return String(v ?? "") > dec; if (op === "gte") return String(v ?? "") >= dec;
  if (op === "in") return dec.replace(/^\(|\)$/g, "").split(",").includes(String(v ?? ""));
  return false;
}
function applyDbFilters(list: Record<string, unknown>[], u: URL): Record<string, unknown>[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (k === "or") {
      const inner = v.replace(/^\(|\)$/g, "");
      out = out.filter((r) => inner.split(",").some((c) => {
        const d1 = c.indexOf("."); const rest = c.slice(d1 + 1); const d2 = rest.indexOf(".");
        return d1 > 0 && d2 > 0 ? matchCond(r, c.slice(0, d1), rest.slice(0, d2), rest.slice(d2 + 1)) : false;
      }));
      continue;
    }
    const dot = v.indexOf("."); if (dot <= 0) continue;
    out = out.filter((r) => matchCond(r, k, v.slice(0, dot), v.slice(dot + 1)));
  }
  const order = u.searchParams.get("order");
  if (order) { const [field, dir] = order.split("."); out.sort((a, b) => { const cmp = String(a[field] ?? "").localeCompare(String(b[field] ?? "")); return dir === "desc" ? -cmp : cmp; }); }
  const limit = u.searchParams.get("limit"); if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}
let resendCalls: Array<Record<string, unknown>>;
let detachCalls: string[];

const future = (days: number) =>
  new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);

function cust(id: string, bid: string, over: Record<string, string> = {}): StoreCust {
  return {
    id, email: "client@example.com", name: "Casey Client",
    metadata: {
      gh_booking_id: bid,
      gh_state: "card_ready",
      gh_payment_method: "pm_test_1",
      gh_first_price_cents: "18900",
      gh_recurring_price_cents: "18900",
      ...over,
    },
  };
}

function response() {
  const res = {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  return res;
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", ADMIN);
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  store = [cust("cus_v", "bid-v", { gh_confirmed_date: future(10) })];
  dbRows = []; dbEvents = [];
  piCalls = [];
  resendCalls = [];
  detachCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown; headers?: Record<string, string>; method?: string }) => {
    const u = new URL(String(url));
    if (u.hostname.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      const method = (init?.method ?? "GET").toUpperCase();
      const list = table === "gh_visits" ? dbRows : table === "gh_events" ? dbEvents : [];
      const sbRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
      if (method === "GET") return sbRes(applyDbFilters(list, u));
      if (method === "POST") { const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; const inserted = { ...body, created_at: new Date().toISOString() }; list.push(inserted); return sbRes([inserted]); }
      if (method === "PATCH") { const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; const matched = applyDbFilters(list, u); for (const target of matched) Object.assign(target, body); return sbRes(matched); }
      if (method === "DELETE") { const matched = applyDbFilters(list, u); for (const d of matched) { const i = list.indexOf(d); if (i >= 0) list.splice(i, 1); } return sbRes(matched); }
      return sbRes([]);
    }
    if (u.pathname.endsWith("/payment_intents/search")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (u.hostname === "api.resend.com") {
      resendCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => ({ id: "email-uuid-9" }) };
    }
    if (u.pathname.endsWith("/customers/search")) {
      const query = u.searchParams.get("query") ?? "";
      let found = store;
      const bidM = /gh_booking_id\]':'([^']+)'/.exec(query);
      const stateM = /gh_state\]':'([^']+)'/.exec(query);
      if (bidM) found = store.filter((c) => c.metadata["gh_booking_id"] === bidM[1]);
      if (stateM) found = store.filter((c) => c.metadata["gh_state"] === stateM[1]);
      return {
        ok: true, status: 200,
        json: async () => ({ data: found.map((c) => ({ id: c.id, email: c.email, name: c.name, metadata: c.metadata })) }),
      };
    }
    if (u.pathname.endsWith("/payment_intents")) {
      piCalls.push({ body: new URLSearchParams(String(init?.body)) });
      return { ok: true, status: 200, json: async () => ({ id: "pi_fee", status: "succeeded" }) };
    }
    const detachM = /\/payment_methods\/([A-Za-z0-9_]+)\/detach$/.exec(u.pathname);
    if (detachM) {
      detachCalls.push(detachM[1]);
      return { ok: true, status: 200, json: async () => ({ id: detachM[1] }) };
    }
    const custMatch = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
    if (custMatch) {
      const found = store.find((c) => c.id === custMatch[1]);
      if (!found) return { ok: false, status: 404, json: async () => ({}) };
      if (init?.body) {
        const params = new URLSearchParams(String(init.body));
        for (const [k, v] of params.entries()) {
          const m = /^metadata\[(.+)\]$/.exec(k);
          if (m) found.metadata[m[1]] = v;
        }
        return { ok: true, status: 200, json: async () => ({ id: found.id }) };
      }
      return { ok: true, status: 200, json: async () => ({ ...found }) };
    }
    if (u.pathname.endsWith("/customers")) {
      return {
        ok: true, status: 200,
        json: async () => ({ data: store.map((c) => ({ id: c.id, email: c.email, name: c.name, metadata: c.metadata })) }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const btFor = (bid: string, date?: string) =>
  signBooking("link-secret", { bid, email: "client@example.com", name: "Casey Client", ...(date ? { date } : {}) }).token;
const get = (bt: string) => ({ method: "GET", headers: {}, query: { bt } });
const post = (bt: string, body: Record<string, unknown>) => ({ method: "POST", headers: {}, body: { bt, ...body } });
const cronReq = () => ({ method: "GET", headers: { authorization: `Bearer ${CRON}` } });
const adminReq = (body: Record<string, unknown>) => ({ method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body });

describe("visit state + fee math", () => {
  it("derives plain states and the 48h fee rule", () => {
    expect(deriveVisitState({ gh_state: "card_ready" })).toBe("awaiting_confirmation");
    expect(deriveVisitState({ gh_state: "card_ready", gh_confirmed_date: future(3) })).toBe("confirmed");
    expect(deriveVisitState({ gh_state: "date_declined" })).toBe("date_declined");
    expect(deriveVisitState({ gh_state: "cancelled" })).toBe("cancelled");
    const now = Date.now();
    expect(cancelFeeCents({ gh_state: "card_ready", gh_confirmed_date: future(10) }, "", now)).toBe(0);
    expect(cancelFeeCents({ gh_state: "card_ready", gh_confirmed_date: future(1) }, "", now)).toBe(2500);
    expect(cancelFeeCents({ gh_state: "cancelled", gh_confirmed_date: future(1) }, "", now)).toBe(0);
  });

  it("B6: a past visit date is its own state — never a card prompt", () => {
    expect(deriveVisitState({ gh_state: "card_ready" }, "2020-01-15")).toBe("date_passed");
    expect(deriveVisitState({ gh_state: "card_ready", gh_confirmed_date: "2020-01-15" })).toBe("date_passed");
    expect(deriveVisitState({ gh_state: "card_ready" }, future(3))).toBe("awaiting_confirmation");
    expect(deriveVisitState({ gh_state: "card_ready", gh_confirmed_date: future(3) })).toBe("confirmed");
    // A past date never overrides a terminal or reported state.
    expect(deriveVisitState({ gh_state: "cancelled" }, "2020-01-15")).toBe("cancelled");
    expect(deriveVisitState({ gh_state: "paid" }, "2020-01-15")).toBe("paid");
    expect(deriveVisitState({ gh_state: "card_ready", gh_report_sent_at: "2020-01-20T16:31:00Z" }, "2020-01-15")).toBe("report_sent");
    expect(deriveVisitState({ gh_state: "date_declined" }, "2020-01-15")).toBe("date_declined");
    // Cancelling a visit whose date already passed is free.
    expect(cancelFeeCents({ gh_state: "card_ready" }, "2020-01-15", Date.now())).toBe(0);
  });

  it("waived: a waived visit is its own state — never approved or report_sent", () => {
    // The waive mirror writes gh_state "approved" into shared metadata;
    // the journal flag is the authority and must win over it.
    expect(deriveVisitState({ gh_state: "approved", gh_report_sent_at: "2026-11-08T10:00:00.000Z", gh_charge_waived: "1" })).toBe("waived");
    expect(deriveVisitState({ gh_state: "card_ready", gh_report_sent_at: "2026-11-08T10:00:00.000Z", gh_charge_waived: "1" })).toBe("waived");
    // Without the flag nothing changes.
    expect(deriveVisitState({ gh_state: "card_ready", gh_report_sent_at: "2026-11-08T10:00:00.000Z" })).toBe("report_sent");
    // Terminal states still win over waived.
    expect(deriveVisitState({ gh_state: "paid", gh_charge_waived: "1" })).toBe("paid");
    expect(deriveVisitState({ gh_state: "cancelled", gh_charge_waived: "1" })).toBe("cancelled");
  });
});

describe("/api/visit", () => {
  it("shows a confirmed visit with a zero cancel fee 10 days out", async () => {
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await visitHandler(get(btFor("bid-v", future(10))) as any, res as any);
    expect(res.body["state"]).toBe("confirmed");
    expect(res.body["cancel_fee_cents"]).toBe(0);
  });

  it("B6: a past requested date returns date_passed with no confirm-by promise and no fee", async () => {
    delete store[0].metadata["gh_confirmed_date"];
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await visitHandler(get(btFor("bid-v", "2020-01-15")) as any, res as any);
    expect(res.body["state"]).toBe("date_passed");
    expect(res.body["booking"]["requested_date"]).toBe("2020-01-15");
    expect(res.body["confirm_by"]).toBe("");
    expect(res.body["cancel_fee_cents"]).toBe(0);
  });

  it("B6: a passed date can still be rescheduled and cancelled for free", async () => {
    delete store[0].metadata["gh_confirmed_date"];
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await visitHandler(post(btFor("bid-v", "2020-01-15"), { action: "propose_date", date: future(5) }) as any, res as any);
    expect(res.code).toBe(200);
    expect(res.body["proposed_date"]).toBe(future(5));
  });

  it("cancel inside 48h records the $25 fee and the scope", async () => {
    store[0].metadata["gh_confirmed_date"] = future(1);
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await visitHandler(post(btFor("bid-v", future(1)), { action: "cancel", scope: "stop" }) as any, res as any);
    expect(res.body["state"]).toBe("cancelled");
    expect(res.body["fee_cents"]).toBe(2500);
    expect(store[0].metadata["gh_cancel_fee_cents"]).toBe("2500");
    expect(store[0].metadata["gh_cancel_scope"]).toBe("stop");
    // client gets the cancellation email
    expect(resendCalls.some((c) => String(c["subject"]).includes("cancelled"))).toBe(true);
  });

  it("S13/N24: cancel inside 48h with no card on file does not promise a saved-card charge", async () => {
    store[0].metadata["gh_confirmed_date"] = future(1);
    delete store[0].metadata["gh_payment_method"];
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await visitHandler(post(btFor("bid-v", future(1)), { action: "cancel", scope: "once" }) as any, res as any);
    expect(res.body["state"]).toBe("cancelled");
    expect(res.body["fee_cents"]).toBe(2500);
    // charge_fee would 409 no_payment_method here — the email must
    // say so honestly instead of promising "your saved card".
    const mail = resendCalls.find((c) => String(c["subject"]).includes("cancelled"));
    expect(mail).toBeDefined();
    const text = String(mail?.["text"] ?? "");
    expect(text).toContain("no card on file for this booking");
    expect(text).toContain("it is recorded and due");
    expect(text).not.toContain("your saved card");
  });

  it("S13/N24: cancel inside 48h with a card keeps the saved-card wording", async () => {
    store[0].metadata["gh_confirmed_date"] = future(1);
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await visitHandler(post(btFor("bid-v", future(1)), { action: "cancel", scope: "once" }) as any, res as any);
    expect(res.body["fee_cents"]).toBe(2500);
    const mail = resendCalls.find((c) => String(c["subject"]).includes("cancelled"));
    expect(mail).toBeDefined();
    const text = String(mail?.["text"] ?? "");
    expect(text).toContain("we will apply it to your saved card ourselves");
    expect(text).toContain("Your saved card stays on file");
  });

  it("accepts only an offered alternative date", async () => {
    store[0].metadata["gh_state"] = "date_declined";
    store[0].metadata["gh_alt_dates"] = `${future(5)},${future(7)}`;
    delete store[0].metadata["gh_confirmed_date"];
    const bad = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await visitHandler(post(btFor("bid-v"), { action: "accept_alt_date", date: future(6) }) as any, bad as any);
    expect(bad.code).toBe(409);
    const ok = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await visitHandler(post(btFor("bid-v"), { action: "accept_alt_date", date: future(5) }) as any, ok as any);
    expect(ok.body["state"]).toBe("confirmed");
    expect(store[0].metadata["gh_confirmed_date"]).toBe(future(5));
  });

  it("stores no-photo zones, but never entry notes in Stripe metadata", async () => {
    // Spec A §6: legacy update_access notes are re-routed to
    // gh_visit_access; Stripe metadata must never carry them again.
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await visitHandler(post(btFor("bid-v"), { action: "update_access", notes: "Lockbox 1234", no_photo_zones: "Office" }) as any, res as any);
    expect(res.code).toBe(200);
    expect(store[0].metadata["gh_access_notes"]).toBeUndefined();
    expect(store[0].metadata["gh_no_photo_zones"]).toBe("Office");
  });
});

describe("report issue with room + photo", () => {
  it("records the room, emails the owner with the photo, keeps the charge paused", async () => {
    store[0].metadata = {
      ...store[0].metadata,
      gh_state: "report_sent",
      gh_report_sent_at: new Date().toISOString(),
      gh_report_amount_cents: "18900",
      gh_rp_0: JSON.stringify([{ url: "https://img.example/k.jpg", room: "Kitchen" }]),
    };
    const res = response();
    await reportHandler(post(btFor("bid-v"), {
      action: "issue", room: "Kitchen", reason: "Streaks on the mirror",
      photo: "data:image/jpeg;base64,QUJD",
    }) as never, res as never);
    expect(res.body["state"]).toBe("issue_open");
    expect(res.body["issue_room"]).toBe("Kitchen");
    expect(store[0].metadata["gh_issue_room"]).toBe("Kitchen");
    const ownerMail = resendCalls.find((c) => (c["to"] as string[]).includes("nikolajmihasenok@gmail.com"));
    expect(ownerMail).toBeTruthy();
    expect(ownerMail?.["attachments"]).toBeTruthy();
    const clientMail = resendCalls.find((c) => (c["to"] as string[]).includes("client@example.com"));
    expect(String(clientMail?.["text"])).toContain("paused payment for this visit");
    // view carries grouped photo items with rooms
    const view = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(get(btFor("bid-v")) as any, view as any);
    const items = view.body["photo_items"] as Array<{ room?: string }>;
    expect(items[0].room).toBe("Kitchen");
    expect(view.body["amount"]).toBe("$189");
  });
});

describe("timer: reminder + retention", () => {
  it("reminds once at 20h and deletes photo links after 90 days", async () => {
    store = [
      cust("cus_r", "bid-r", {
        gh_state: "report_sent",
        gh_report_sent_at: new Date(Date.now() - 21 * 3600 * 1000).toISOString(),
        gh_report_amount_cents: "18900",
      }),
      cust("cus_p", "bid-p", {
        gh_state: "paid",
        gh_report_sent_at: new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString(),
        gh_rp_0: JSON.stringify(["https://img.example/old.jpg"]),
      }),
    ];
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await autoChargeHandler(cronReq() as any, res as any);
    expect(res.body["reminded"]).toBe(1);
    expect(res.body["cleaned"]).toBe(1);
    expect(store[1].metadata["gh_rp_0"]).toBe("");
    expect(resendCalls.some((c) => String(c["subject"]).includes("Reminder"))).toBe(true);
    const res2 = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await autoChargeHandler(cronReq() as any, res2 as any);
    expect(res2.body["reminded"]).toBe(0);
  });
});

describe("operator: decline_date / set_cleaner / charge_fee / delete_card", () => {
  it("decline_date stores alternatives; set_cleaner stores the card data", async () => {
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "decline_date", booking_id: "bid-v", alt_dates: [future(4), future(6)] }) as any, res as any);
    expect(res.body["ok"]).toBe(true);
    expect(store[0].metadata["gh_state"]).toBe("date_declined");
    expect(store[0].metadata["gh_alt_dates"]).toBe(`${future(4)},${future(6)}`);
    const res2 = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "set_cleaner", booking_id: "bid-v", cleaner_name: "Ana", cleaner_photo: "https://img.example/ana.jpg" }) as any, res2 as any);
    expect(res2.body["ok"]).toBe(true);
    expect(store[0].metadata["gh_cleaner_name"]).toBe("Ana");
    const bad = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "set_cleaner", booking_id: "bid-v", cleaner_name: "Ana", cleaner_photo: "http://insecure.example/x.jpg" }) as any, bad as any);
    expect(bad.code).toBe(400);
  });

  it("charge_fee collects exactly the recorded fee, once", async () => {
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
    store[0].metadata["gh_state"] = "cancelled";
    store[0].metadata["gh_cancel_fee_cents"] = "2500";
    // New fee obligation: amount comes only from the visit_cancelled
    // journal event, state/intent live on the row — metadata alone
    // is no longer a fee record (no_fee_record without a row).
    dbRows = [{
      id: "row-fee-1", booking_id: "bid-v", visit_no: 1, status: "cancelled",
      report_status: "none", amount_cents: 18900, client_email: "client@example.com",
      fee_status: null, fee_intent_id: null, fee_amount_cents: null,
    }];
    dbEvents = [
      // Task 1: the fee charges THIS booking's confirmed card
      // (card_confirmed event), never the shared gh_payment_method.
      { visit_id: "row-fee-1", booking_id: "bid-v", event: "card_confirmed", detail: { payment_method_id: "pm_test_1", brand: "visa", last4: "4242" }, created_at: new Date(Date.now() - 3600 * 1000).toISOString() },
      { visit_id: "row-fee-1", booking_id: "bid-v", event: "visit_cancelled", detail: { scope: "stop", fee_cents: 2500 }, created_at: new Date().toISOString() },
    ];
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "charge_fee", booking_id: "bid-v" }) as any, res as any);
    expect(res.body["ok"]).toBe(true);
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].body.get("amount")).toBe("2500");
    const again = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "charge_fee", booking_id: "bid-v" }) as any, again as any);
    expect(again.body["already"]).toBe(true);
    expect(piCalls).toHaveLength(1);
    expect(dbRows[0]["fee_status"]).toBe("fee_paid");
    expect(dbRows[0]["fee_intent_id"]).toBe("pi_fee");
    // The fee intent is never written into the cleaning payment marker.
    expect(store[0].metadata["gh_last_payment"]).toBeUndefined();
  });

  it("delete_card detaches the payment method at Stripe", async () => {
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "delete_card", booking_id: "bid-v" }) as any, res as any);
    expect(res.body["ok"]).toBe(true);
    expect(detachCalls).toEqual(["pm_test_1"]);
    expect(store[0].metadata["gh_payment_method"]).toBe("");
  });
});
