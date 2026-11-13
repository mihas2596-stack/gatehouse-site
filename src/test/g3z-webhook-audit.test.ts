// @vitest-environment node
// G3Z payment-audit fixes in api/stripe-webhook.ts:
//   - setup_intent.succeeded is handled (it used to be ignored: the
//     card stayed "awaiting_card" even though Stripe saved it).
//   - livemode: a test-mode event never moves production state and
//     vice versa (mismatch -> 400, never acted on).
//   - Fail-closed DB: money events return 5xx with no DB, and a
//     succeeded intent for a booking with no visit row is never
//     marked paid (no pinned amount to verify against).
//   - The in-memory webhook dedup set is bounded (TTL + oldest-first
//     eviction) instead of growing forever.
//   - A redelivery after a rebind wiped gh_last_payment still cannot
//     double-journal: the DB row is the durable dedup authority.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import handler, { createWebhookSeenSet } from "../../api/stripe-webhook";

const BID = "bid-g3z-webhook";
const VISIT_ID = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
const WHSEC = "whsec_test_g3z";
const CUSTOMER = "cus_g3z";
const EMAIL = "client@example.com";

type Row = Record<string, unknown>;

let storeMeta: Record<string, string>;
let row: Row;
let events: Array<Record<string, unknown>>;
let dedupRows: Array<Record<string, unknown>>;
let stripePosts: Array<{ path: string; params: Record<string, string> }>;
let resendBodies: string[];
let siStatus: string;
let siPm: string;
let siMeta: Record<string, string>;
let seq: number;

function response() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

function okRes(data: unknown, status = 200) {
  return {
    ok: status < 300, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  };
}

function signedReq(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex");
  return {
    method: "POST",
    headers: { "stripe-signature": `t=${t},v1=${v1}` },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload);
    },
  };
}

function parseForm(body: unknown): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  if (body && typeof body === "object") return new URLSearchParams(body as Record<string, string>);
  return new URLSearchParams();
}

function matchRow(r: Row, u: URL): boolean {
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "offset" || k === "select" || k === "or") continue;
    if (v.startsWith("eq.")) {
      if (String(r[k] ?? "") !== decodeURIComponent(v.slice(3))) return false;
    } else if (v.startsWith("neq.")) {
      if (String(r[k] ?? "") === decodeURIComponent(v.slice(4))) return false;
    } else if (v === "is.null") {
      if (r[k] !== null && r[k] !== undefined) return false;
    } else if (v === "is.not.null") {
      if (r[k] === null || r[k] === undefined) return false;
    }
  }
  return true;
}

function filterRows(list: Row[], u: URL): Row[] {
  let out = list.filter((r) => matchRow(r, u));
  const order = u.searchParams.get("order");
  if (order) {
    const [field, dir] = order.split(".");
    out = [...out].sort((a, b) => {
      const c = String(a[field] ?? "").localeCompare(String(b[field] ?? ""));
      return dir === "desc" ? -c : c;
    });
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const host = u.hostname;

    if (host === "api.stripe.com") {
      const siM = u.pathname.match(/^\/v1\/setup_intents\/([^/]+)$/);
      if (siM && method === "GET") {
        if (siM[1] === "si_1") {
          return okRes({ id: "si_1", status: siStatus, payment_method: siPm, customer: CUSTOMER, metadata: siMeta });
        }
        return okRes({ error: { message: "not found" } }, 404);
      }
      const pmM = u.pathname.match(/^\/v1\/payment_methods\/([^/]+)$/);
      if (pmM && method === "GET") {
        if (pmM[1] === "pm_9") {
          return okRes({ id: "pm_9", customer: CUSTOMER, card: { brand: "visa", last4: "4242" } });
        }
        return okRes({ error: { message: "not found" } }, 404);
      }
      const custM = u.pathname.match(/^\/v1\/customers\/([^/]+)$/);
      if (custM) {
        if (method === "GET") {
          return okRes({ id: CUSTOMER, email: EMAIL, name: "Casey Client", metadata: storeMeta });
        }
        const params = parseForm(init?.body);
        const applied: Record<string, string> = {};
        for (const [k, v] of params.entries()) {
          const mm = k.match(/^metadata\[(.+)\]$/);
          if (mm) {
            if (v === "") delete storeMeta[mm[1]];
            else storeMeta[mm[1]] = v;
            applied[mm[1]] = v;
          }
        }
        stripePosts.push({ path: u.pathname, params: applied });
        return okRes({ id: CUSTOMER, email: EMAIL, metadata: storeMeta });
      }
      return okRes({ error: { message: "stripe route not stubbed" } }, 404);
    }

    if (host === "api.resend.com") {
      resendBodies.push(typeof init?.body === "string" ? init.body : "");
      return okRes({ id: "email_1" });
    }

    if (host.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      const store = table === "gh_visits" ? [row] : table === "gh_events" ? events : dedupRows;
      if (method === "GET") return okRes(filterRows(store as Row[], u));
      if (method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const inserted = { ...body, id: ++seq, created_at: new Date().toISOString() };
        (store as Row[]).push(inserted);
        return okRes([inserted], 201);
      }
      if (method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const matched = (store as Row[]).filter((r) => matchRow(r, u));
        for (const target of matched) Object.assign(target, body);
        return okRes(matched);
      }
    }
    return okRes({ error: { message: "route not stubbed" } }, 404);
  }));
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

function setupIntentEvent(id: string, livemode?: boolean) {
  return {
    id,
    type: "setup_intent.succeeded",
    ...(livemode !== undefined ? { livemode } : {}),
    data: {
      object: {
        id: "si_1",
        customer: CUSTOMER,
        payment_method: "pm_9",
        metadata: siMeta,
      },
    },
  };
}

function succeededEvent(id: string, pi: string, amount: number, livemode?: boolean) {
  return {
    id,
    type: "payment_intent.succeeded",
    ...(livemode !== undefined ? { livemode } : {}),
    data: {
      object: {
        id: pi,
        customer: CUSTOMER,
        amount,
        metadata: { gh_booking_id: BID },
      },
    },
  };
}

function pingEvent(id: string, livemode?: boolean) {
  return {
    id,
    type: "ping",
    ...(livemode !== undefined ? { livemode } : {}),
    data: { object: {} },
  };
}

function requestedRow(): Row {
  return {
    id: VISIT_ID, booking_id: BID, client_email: EMAIL, client_name: "Casey Client",
    status: "requested", report_status: null, amount_cents: 20000, service: "Standard",
    visit_date: "2026-11-20", window: "morning", issue_open: false, issue_ever: false,
    report_bounced: false, report_sent_at: null, stripe_customer_id: null,
    payment_intent_id: null, receipt_email_id: null, visit_no: 1,
  };
}

function sentRow(): Row {
  const sentAt = hoursAgo(25);
  return {
    ...requestedRow(),
    status: "report_sent", report_status: "sent", report_sent_at: sentAt, visit_no: 1,
    // Past visit date: the payment-date gate must not block the basis
    // in these fixtures (the gate itself is covered elsewhere).
    visit_date: "2026-11-10",
  };
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  storeMeta = { gh_booking_id: BID, gh_state: "awaiting_card" };
  row = requestedRow();
  events = [];
  dedupRows = [];
  stripePosts = [];
  resendBodies = [];
  siStatus = "succeeded";
  siPm = "pm_9";
  siMeta = { gh_booking_id: BID };
  seq = 0;
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("setup_intent.succeeded (G3Z)", () => {
  it("marks the card saved like the Checkout path", async () => {
    const r = response();
    await handler(signedReq(setupIntentEvent("evt_g3z_si_1")) as never, r as never);
    expect(r.code).toBe(200);
    expect(storeMeta["gh_state"]).toBe("card_ready");
    expect(storeMeta["gh_payment_method"]).toBe("pm_9");
    expect(storeMeta["gh_booking_id"]).toBe(BID);
    const confirmed = events.filter((e) => e["event"] === "card_confirmed");
    expect(confirmed).toHaveLength(1);
    expect((confirmed[0]["detail"] as Record<string, unknown>)["payment_method_id"]).toBe("pm_9");
  });

  it("resolves the booking from customer metadata when the SI has none", async () => {
    siMeta = {};
    const r = response();
    await handler(signedReq(setupIntentEvent("evt_g3z_si_2")) as never, r as never);
    expect(r.code).toBe(200);
    expect(storeMeta["gh_state"]).toBe("card_ready");
    expect(storeMeta["gh_payment_method"]).toBe("pm_9");
    expect(events.filter((e) => e["event"] === "card_confirmed")).toHaveLength(1);
  });

  it("a redelivery is deduped and writes nothing twice", async () => {
    const r1 = response();
    await handler(signedReq(setupIntentEvent("evt_g3z_si_3")) as never, r1 as never);
    expect(r1.code).toBe(200);
    const postsAfterFirst = stripePosts.length;
    const confirmedAfterFirst = events.filter((e) => e["event"] === "card_confirmed").length;
    const r2 = response();
    await handler(signedReq(setupIntentEvent("evt_g3z_si_3")) as never, r2 as never);
    expect(r2.code).toBe(200);
    expect(r2.body["deduped"]).toBe(true);
    expect(stripePosts.length).toBe(postsAfterFirst);
    expect(events.filter((e) => e["event"] === "card_confirmed").length).toBe(confirmedAfterFirst);
  });

  it("a SetupIntent that did not succeed changes no card state", async () => {
    siStatus = "requires_action";
    const r = response();
    await handler(signedReq(setupIntentEvent("evt_g3z_si_4")) as never, r as never);
    expect(r.code).toBe(200);
    expect(storeMeta["gh_state"]).toBe("awaiting_card");
    expect(storeMeta["gh_payment_method"]).toBeUndefined();
    expect(events.filter((e) => e["event"] === "card_confirmed")).toHaveLength(0);
  });
});

describe("livemode check (G3Z)", () => {
  it("a test-mode event is rejected under a live key and vice versa", async () => {
    const r1 = response();
    await handler(signedReq(pingEvent("evt_g3z_live_1", true)) as never, r1 as never);
    expect(r1.code).toBe(400);
    expect(r1.body["error"]).toBe("livemode_mismatch");
    expect(stripePosts).toHaveLength(0);

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    const r2 = response();
    await handler(signedReq(pingEvent("evt_g3z_live_2", false)) as never, r2 as never);
    expect(r2.code).toBe(400);
    expect(r2.body["error"]).toBe("livemode_mismatch");
    expect(stripePosts).toHaveLength(0);
  });

  it("a matching livemode is processed, and a missing field still processes", async () => {
    const r1 = response();
    await handler(signedReq(pingEvent("evt_g3z_live_3", false)) as never, r1 as never);
    expect(r1.code).toBe(200);
    const r2 = response();
    await handler(signedReq(pingEvent("evt_g3z_live_4")) as never, r2 as never);
    expect(r2.code).toBe(200);
  });
});

describe("fail-closed DB (G3Z)", () => {
  it("a money event with no database configured returns 5xx and writes nothing", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    row = sentRow();
    const r = response();
    await handler(signedReq(succeededEvent("evt_g3z_db_1", "pi_db_1", 20000)) as never, r as never);
    expect(r.code).toBe(500);
    expect(r.body["error"]).toBe("db_unavailable");
    expect(stripePosts).toHaveLength(0);
    expect(storeMeta["gh_state"]).not.toBe("paid");
  });

  it("a succeeded intent for a booking with no visit row is never marked paid", async () => {
    row = {};
    // No row at all: the GET returns an empty list.
    const emptyFetch = vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = new URL(String(url));
      if (u.hostname.includes("supabase") && u.pathname.includes("gh_visits")) {
        return okRes([]);
      }
      // Delegate everything else to the installed mock by re-dispatching:
      // the stub above is replaced, so handle the remaining routes inline.
      if (u.hostname === "api.stripe.com" && u.pathname.includes("/customers/")) {
        if ((init?.method ?? "GET").toUpperCase() === "GET") {
          return okRes({ id: CUSTOMER, email: EMAIL, metadata: storeMeta });
        }
        return okRes({ id: CUSTOMER, metadata: storeMeta });
      }
      if (u.hostname.includes("supabase")) return okRes([]);
      return okRes({ error: { message: "route not stubbed" } }, 404);
    });
    vi.stubGlobal("fetch", emptyFetch);
    const r = response();
    await handler(signedReq(succeededEvent("evt_g3z_db_2", "pi_db_2", 20000)) as never, r as never);
    expect(r.code).toBe(200);
    expect(storeMeta["gh_state"]).not.toBe("paid");
    expect(storeMeta["gh_last_payment"]).toBeUndefined();
    expect(events.filter((e) => e["event"] === "payment_succeeded")).toHaveLength(0);
  });

  it("an amount mismatch never records paid (already-fixed, regression)", async () => {
    row = sentRow();
    events = [
      {
        visit_id: VISIT_ID, booking_id: BID, event: "report_sent",
        detail: { version: 1, email_sent: true }, created_at: hoursAgo(25),
      },
    ];
    const r = response();
    await handler(signedReq(succeededEvent("evt_g3z_db_3", "pi_db_3", 15000)) as never, r as never);
    expect(r.code).toBe(200);
    expect(storeMeta["gh_state"]).not.toBe("paid");
    expect(events.filter((e) => e["event"] === "payment_succeeded")).toHaveLength(0);
  });

  it("a redelivery after a rebind wiped gh_last_payment cannot double-journal", async () => {
    row = { ...sentRow(), status: "paid", payment_intent_id: "pi_db_4" };
    storeMeta = { gh_booking_id: BID, gh_state: "report_sent", gh_last_payment: "" };
    events = [
      {
        visit_id: VISIT_ID, booking_id: BID, event: "report_sent",
        detail: { version: 1, email_sent: true }, created_at: hoursAgo(25),
      },
      {
        visit_id: VISIT_ID, booking_id: BID, event: "payment_succeeded",
        detail: { payment_intent_id: "pi_db_4" }, created_at: hoursAgo(1),
      },
    ];
    const r = response();
    await handler(signedReq(succeededEvent("evt_g3z_db_4", "pi_db_4", 20000)) as never, r as never);
    expect(r.code).toBe(200);
    // No second payment_succeeded journal row for the same intent.
    expect(events.filter((e) => e["event"] === "payment_succeeded")).toHaveLength(1);
    // The metadata mirror is repaired, not duplicated: the wiped
    // marker names this intent again.
    expect(storeMeta["gh_last_payment"]).toBe("pi_db_4");
  });
});

describe("bounded in-memory dedup (G3Z)", () => {
  it("evicts oldest-first past the cap instead of growing forever", () => {
    const seen = createWebhookSeenSet(3, 24 * 3600 * 1000);
    seen.add("evt_a");
    seen.add("evt_b");
    seen.add("evt_c");
    expect(seen.size).toBe(3);
    seen.add("evt_d");
    expect(seen.size).toBe(3);
    expect(seen.has("evt_a")).toBe(false);
    expect(seen.has("evt_b")).toBe(true);
    expect(seen.has("evt_d")).toBe(true);
  });

  it("expired entries are forgotten", () => {
    const seen = createWebhookSeenSet(10, -1);
    seen.add("evt_old");
    expect(seen.has("evt_old")).toBe(false);
  });
});
