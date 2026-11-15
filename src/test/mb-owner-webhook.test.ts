// @vitest-environment node
// Maximal audit 14.11.2026 — owner / webhook / basis batch:
//   MB-06 (DA-15) — secondary DB reads in owner.ts fail silent: detail
//     photos/events and every list aux counter now use strict reads and
//     answer 502 instead of an empty list / missing badges.
//   MB-19 — list aux reads are paged (500/page, 10000-row safety cap)
//     with a signals_truncated flag instead of one capped page.
//   LB-02 (DA-18) — paymentBasis checks an open issue (journal or row
//     flags) BEFORE returning client_approved; terminal statuses
//     (refunded/cancelled) still come first.
//   LB-03 (DA-19) — a dispute that arrived before payment_intent.
//     succeeded now opens the issue once the succeeded mirror marks
//     the visit paid.
//   LB-12 (N-2) — the fee mirror refuses (no write) when there is no
//     visit_cancelled record to verify the amount against.
//   LB-14 (N-4) — setup_intent.succeeded / checkout.session.completed
//     no longer stamp gh_state=card_ready over report_sent / approved /
//     payment_pending.
//   LB-08 (DA-22) — the webhook-dedup in-memory fallback is bounded
//     (2000 entries, 24h TTL, oldest-first eviction).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { paymentBasis } from "../../api/_payment_basis";
import ownerHandler from "../../api/owner";
import stripeHandler from "../../api/stripe-webhook";
import { webhookEventSeen, recordWebhookEvent } from "../../api/_webhook_dedup";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const hoursAhead = (h: number) => new Date(Date.now() + h * 3600 * 1000).toISOString();

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

function okRes(data: unknown, headers?: Record<string, string>) {
  return {
    ok: true, status: 200,
    json: async () => data, text: async () => JSON.stringify(data),
    headers: { get: (name: string) => (headers?.[name.toLowerCase()] ?? null) },
  };
}

function errRes(status = 500) {
  return {
    ok: false, status,
    json: async () => ({}), text: async () => "{}",
    headers: { get: () => null },
  };
}

// ---------------------------------------------------------------- LB-02

describe("LB-02: an open issue blocks the client_approved basis", () => {
  const SENT_AT = "2026-11-01T10:00:00.000Z";
  const NOW = Date.parse("2026-11-04T11:00:00.000Z"); // 73h after the report
  const sent = { event: "report_sent", detail: { email_sent: true, version: 1 }, created_at: SENT_AT };
  const approved = { event: "report_approved", detail: {}, created_at: "2026-11-01T12:00:00.000Z" };

  it("an open issue known only from the row flags (Stripe dispute) voids a stale approval", () => {
    expect(paymentBasis(
      { reportSentAt: SENT_AT, events: [sent, approved], issueOpenRow: true, issueEverRow: true, bounced: false },
      NOW,
    )).toBeNull();
  });

  it("an open issue_opened event blocks the approval", () => {
    const events = [
      sent, approved,
      { event: "issue_opened", detail: { reason: "Streaks" }, created_at: "2026-11-01T13:00:00.000Z" },
    ];
    expect(paymentBasis(
      { reportSentAt: SENT_AT, events, issueOpenRow: true, issueEverRow: true, bounced: false },
      NOW,
    )).toBeNull();
  });

  it("a resolved issue plus a fresh approval after the resolution is still a basis", () => {
    const events = [
      sent,
      { event: "issue_opened", detail: { reason: "Streaks" }, created_at: "2026-11-01T11:00:00.000Z" },
      { event: "issue_resolved", detail: { via: "owner_request_payment" }, created_at: "2026-11-01T12:00:00.000Z" },
      { event: "report_approved", detail: {}, created_at: "2026-11-01T13:00:00.000Z" },
    ];
    expect(paymentBasis(
      { reportSentAt: SENT_AT, events, issueOpenRow: false, issueEverRow: true, bounced: false },
      NOW,
    )).toBe("client_approved");
  });

  it("terminal statuses still come first: cancelled / refunded have no basis even with an approval", () => {
    for (const status of ["cancelled", "refunded"]) {
      expect(paymentBasis(
        { reportSentAt: SENT_AT, events: [sent, approved], issueOpenRow: false, issueEverRow: false, bounced: false, status },
        NOW,
      )).toBeNull();
    }
  });

  it("control: approval with no issue is still a basis, and the timer still works without one", () => {
    expect(paymentBasis(
      { reportSentAt: SENT_AT, events: [sent, approved], issueOpenRow: false, issueEverRow: false, bounced: false },
      NOW,
    )).toBe("client_approved");
    expect(paymentBasis(
      { reportSentAt: SENT_AT, events: [sent], issueOpenRow: false, issueEverRow: false, bounced: false },
      NOW,
    )).toBe("timer_rule");
  });
});

// ------------------------------------------------------- MB-06 / MB-19 / LB-02 owner

const OWNER_ADMIN = "test-admin-token-mb";
const OWNER_BID = "bid-mb-owner";

type OwnerRow = Record<string, unknown>;
type OwnerEv = { visit_id: string; event: string; detail: Record<string, unknown> | null; created_at: string };

let ownerRows: OwnerRow[];
let ownerEvents: OwnerEv[];
let ownerPhotos: Array<{ visit_id: string }>;
let ownerAccess: Array<{ visit_id: string; entry_method: string | null }>;
let ownerFail: { photos: boolean; events: boolean };

function ownerRow(id: string, createdAt: string, overrides: OwnerRow = {}): OwnerRow {
  return {
    id, booking_id: `${OWNER_BID}-${id.slice(0, 8)}`, status: "report_sent", amount_cents: 20000,
    client_email: "client@example.com", report_sent_at: hoursAgo(30),
    report_bounced: false, report_status: "sent", issue_open: false, issue_ever: false,
    cleaner_name: null, cleaner_link_issuance: "iss", cleaner_token_hash: "hash",
    cleaner_token_expires: hoursAhead(24), cleaner_link_version: "v2",
    visit_date: "2026-11-10", window: "midday", created_at: createdAt,
    ...overrides,
  };
}

function installOwnerFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(String(url));
    const applyOffsetLimit = <T>(list: T[]): T[] => {
      const offset = parseInt(u.searchParams.get("offset") ?? "0", 10) || 0;
      const limitRaw = u.searchParams.get("limit");
      const out = list.slice(offset);
      return limitRaw ? out.slice(0, parseInt(limitRaw, 10)) : out;
    };
    if (u.pathname.includes("/storage/v1/object/sign/")) {
      return okRes({ signedURL: "https://test.supabase.co/signed/photo.jpg" });
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      if (u.searchParams.get("select") === "id" && u.searchParams.get("limit") === "0") {
        return okRes([], { "content-range": `*/${ownerRows.length}` });
      }
      const qId = u.searchParams.get("id");
      if (qId && qId.startsWith("eq.")) {
        return okRes(ownerRows.filter((r) => String(r["id"]) === decodeURIComponent(qId.slice(3))));
      }
      const sorted = [...ownerRows].sort((a, b) => String(b["created_at"]).localeCompare(String(a["created_at"])));
      return okRes(applyOffsetLimit(sorted));
    }
    if (u.pathname.includes("/rest/v1/gh_photos")) {
      if (ownerFail.photos) return errRes(500);
      let out = [...ownerPhotos];
      const qVisit = u.searchParams.get("visit_id");
      if (qVisit && qVisit.startsWith("eq.")) out = out.filter((p) => p.visit_id === decodeURIComponent(qVisit.slice(3)));
      if (qVisit && qVisit.startsWith("in.(")) {
        const ids = qVisit.slice(4, -1).split(",");
        out = out.filter((p) => ids.includes(p.visit_id));
      }
      return okRes(applyOffsetLimit(out));
    }
    if (u.pathname.includes("/rest/v1/gh_events")) {
      if (ownerFail.events) return errRes(500);
      let out = [...ownerEvents];
      const qVisit = u.searchParams.get("visit_id");
      if (qVisit && qVisit.startsWith("eq.")) out = out.filter((e) => e.visit_id === decodeURIComponent(qVisit.slice(3)));
      if (qVisit && qVisit.startsWith("in.(")) {
        const ids = qVisit.slice(4, -1).split(",");
        out = out.filter((e) => ids.includes(e.visit_id));
      }
      const qEv = u.searchParams.get("event");
      if (qEv && qEv.startsWith("eq.")) out = out.filter((e) => e.event === decodeURIComponent(qEv.slice(3)));
      const order = u.searchParams.get("order") ?? "";
      if (order.includes("created_at.desc")) out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      if (order.includes("created_at.asc")) out.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return okRes(applyOffsetLimit(out));
    }
    if (u.pathname.includes("/rest/v1/gh_visit_access")) {
      let out = [...ownerAccess];
      const qVisit = u.searchParams.get("visit_id");
      if (qVisit && qVisit.startsWith("eq.")) out = out.filter((a) => a.visit_id === decodeURIComponent(qVisit.slice(3)));
      if (qVisit && qVisit.startsWith("in.(")) {
        const ids = qVisit.slice(4, -1).split(",");
        out = out.filter((a) => ids.includes(a.visit_id));
      }
      return okRes(applyOffsetLimit(out));
    }
    return errRes(404);
  }));
}

describe("MB-06 / MB-19: owner list and detail", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", OWNER_ADMIN);
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    ownerRows = [ownerRow("11111111-2222-3333-4444-555555555555", hoursAgo(50))];
    ownerEvents = [];
    ownerPhotos = [];
    ownerAccess = [];
    ownerFail = { photos: false, events: false };
    installOwnerFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const list = async () => {
    const r = res();
    await ownerHandler(
      { method: "GET", headers: { authorization: "Bearer " + OWNER_ADMIN }, query: { view: "list" } },
      r as never,
    );
    return r;
  };
  const detail = async (visitId: string) => {
    const r = res();
    await ownerHandler(
      { method: "GET", headers: { authorization: "Bearer " + OWNER_ADMIN }, query: { view: "detail", visit_id: visitId } },
      r as never,
    );
    return r;
  };

  it("MB-06: a failed aux read fails the list with 502 instead of silent badges", async () => {
    ownerFail.events = true;
    const r = await list();
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_error");
  });

  it("MB-06: a failed photo read fails the detail with 502 instead of an empty report", async () => {
    ownerFail.photos = true;
    const r = await detail(ownerRows[0]["id"] as string);
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_error");
  });

  it("MB-06: a failed journal read fails the detail with 502 instead of a history-less visit", async () => {
    ownerFail.events = true;
    const r = await detail(ownerRows[0]["id"] as string);
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_error");
  });

  it("MB-06 control: a healthy list loads with signals_truncated false", async () => {
    const r = await list();
    expect(r.code).toBe(200);
    expect(r.body["signals_truncated"]).toBe(false);
    expect((r.body["visits"] as OwnerRow[])).toHaveLength(1);
  });

  it("MB-19: a payment_failed past the old 500-row cap still lights the oldest visit's badge", async () => {
    const vOld = "aaaaaaaa-0000-4000-8000-000000000001";
    const vMid = "aaaaaaaa-0000-4000-8000-000000000002";
    const vNew = "aaaaaaaa-0000-4000-8000-000000000003";
    ownerRows = [
      ownerRow(vOld, hoursAgo(90)),
      ownerRow(vMid, hoursAgo(50)),
      ownerRow(vNew, hoursAgo(10)),
    ];
    // 550 newer payment_failed events on the other two visits, then
    // the oldest visit's own failure — row 551 in created_at.desc
    // order, invisible to a single capped 500-row page.
    ownerEvents = [];
    for (let i = 0; i < 550; i++) {
      ownerEvents.push({
        visit_id: i % 2 === 0 ? vMid : vNew, event: "payment_failed",
        detail: { reason: "declined" }, created_at: new Date(Date.now() - i * 60 * 1000).toISOString(),
      });
    }
    ownerEvents.push({
      visit_id: vOld, event: "payment_failed",
      detail: { reason: "declined" }, created_at: hoursAgo(80),
    });
    const r = await list();
    expect(r.code).toBe(200);
    expect(r.body["signals_truncated"]).toBe(false);
    const visits = r.body["visits"] as OwnerRow[];
    const old = visits.find((v) => v["id"] === vOld);
    expect(old).toBeDefined();
    expect(old?.["payment_failed"]).toBe(true);
  });

  it("LB-02 (owner): can_charge is false while a dispute is open on the row flags", async () => {
    const vid = ownerRows[0]["id"] as string;
    ownerRows[0] = ownerRow(vid, hoursAgo(50), {
      report_sent_at: hoursAgo(5), issue_open: true, issue_ever: true,
    });
    ownerEvents = [
      { visit_id: vid, event: "report_sent", detail: { email_sent: true, version: 1 }, created_at: hoursAgo(5) },
      { visit_id: vid, event: "report_approved", detail: {}, created_at: hoursAgo(1) },
    ];
    const r = await detail(vid);
    expect(r.code).toBe(200);
    expect((r.body["visit"] as OwnerRow)["can_charge"]).toBe(false);
  });

  it("LB-02 (owner) control: can_charge is true with a client approval and no open issue", async () => {
    const vid = ownerRows[0]["id"] as string;
    ownerRows[0] = ownerRow(vid, hoursAgo(50), { report_sent_at: hoursAgo(5) });
    ownerEvents = [
      { visit_id: vid, event: "report_sent", detail: { email_sent: true, version: 1 }, created_at: hoursAgo(5) },
      { visit_id: vid, event: "report_approved", detail: {}, created_at: hoursAgo(1) },
    ];
    const r = await detail(vid);
    expect(r.code).toBe(200);
    expect((r.body["visit"] as OwnerRow)["can_charge"]).toBe(true);
  });
});

// ------------------------------------------------------- LB-03 / LB-12 / LB-14 webhook

const WH_BID = "bid-mb-webhook";
const WH_VISIT = "88888888-9999-4000-8000-aaaaaaaaaaaa";
const WHSEC = "whsec_test_mb";

let whMeta: Record<string, string>;
let whRow: Record<string, unknown>;
let whEvents: Array<{ event: string; detail: Record<string, unknown> | null; visit_id?: string | null; booking_id?: string | null; created_at?: string }>;
let whDedup: Array<Record<string, unknown>>;
let whResend: string[];
let whStripePosts: Array<{ path: string; params: Record<string, string> }>;

function whSignedReq(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex");
  return {
    method: "POST",
    headers: { "stripe-signature": `t=${t},v1=${v1}` },
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); },
  };
}

function filterRows(list: Record<string, unknown>[], u: URL): Record<string, unknown>[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "offset" || k === "select") continue;
    if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === decodeURIComponent(v.slice(3)));
    else if (v.startsWith("neq.")) out = out.filter((r) => String(r[k] ?? "") !== decodeURIComponent(v.slice(4)));
  }
  const order = u.searchParams.get("order");
  if (order) {
    const [field, dir] = order.split(".");
    out.sort((a, b) => {
      const c = String(a[field] ?? "").localeCompare(String(b[field] ?? ""));
      return dir === "desc" ? -c : c;
    });
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

function installWebhookFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.hostname === "api.resend.com") {
      whResend.push(String(init?.body ?? ""));
      return okRes({ id: "email-mb-1" });
    }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.includes("/setup_intents/")) {
        return okRes({ id: "si_mb", status: "succeeded", payment_method: "pm_mb14" });
      }
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (custM) {
        if (init?.body) {
          const params = new URLSearchParams(String(init.body));
          const rec: Record<string, string> = {};
          for (const [k, v] of params.entries()) {
            rec[k] = v;
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) whMeta[m[1]] = v;
          }
          whStripePosts.push({ path: u.pathname, params: rec });
          return okRes({ id: custM[1] });
        }
        return okRes({ id: custM[1], email: "client@example.com", name: "Casey Client", metadata: whMeta });
      }
      return okRes({ id: "cus_mb" });
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const matched = filterRows([whRow], u);
        for (const r of matched) Object.assign(r, patch);
        return okRes(matched);
      }
      return okRes(filterRows([whRow], u));
    }
    if (u.pathname.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { event?: string; detail?: Record<string, unknown> | null; visit_id?: string | null; booking_id?: string | null };
        whEvents.push({ event: body.event ?? "", detail: body.detail ?? null, visit_id: body.visit_id ?? null, booking_id: body.booking_id ?? null, created_at: new Date().toISOString() });
        return okRes([{ ...body, id: whEvents.length }]);
      }
      return okRes(filterRows(whEvents as unknown as Record<string, unknown>[], u));
    }
    if (u.pathname.includes("/rest/v1/gh_webhook_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        whDedup.push(body);
        return okRes([{ ...body, id: whDedup.length }]);
      }
      return okRes(filterRows(whDedup, u));
    }
    return errRes(404);
  }));
}

describe("LB-03 / LB-12 / LB-14: stripe webhook", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    whMeta = {
      gh_booking_id: WH_BID, gh_state: "report_sent",
      gh_report_amount_cents: "20000", gh_first_price_cents: "20000",
      gh_payment_method: "pm_1",
    };
    whRow = {
      id: WH_VISIT, booking_id: WH_BID, visit_no: 1, status: "report_sent",
      payment_intent_id: null, receipt_email_id: null,
      amount_cents: 20000, visit_date: "2026-11-10",
      issue_open: false, issue_ever: false,
      report_sent_at: hoursAgo(30), report_bounced: false,
      charge_waived: false, stripe_customer_id: "cus_mb",
      fee_status: null, fee_intent_id: null,
    };
    whEvents = [
      { event: "report_sent", detail: { email_sent: true, version: 1 }, visit_id: WH_VISIT, booking_id: WH_BID, created_at: hoursAgo(30) },
      { event: "report_approved", detail: {}, visit_id: WH_VISIT, booking_id: WH_BID, created_at: hoursAgo(1) },
    ];
    whDedup = [];
    whResend = [];
    whStripePosts = [];
    installWebhookFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const call = async (event: Record<string, unknown>) => {
    const r = res();
    await stripeHandler(whSignedReq(event) as never, r as never);
    return r;
  };

  it("LB-03: a dispute before succeeded opens the issue once the payment is marked paid", async () => {
    whRow["payment_intent_id"] = "pi_lb03";
    whRow["status"] = "payment_pending";
    const dispute = {
      id: "evt_lb03_dispute", type: "charge.dispute.created",
      data: { object: { id: "dp_lb03", payment_intent: "pi_lb03", amount: 20000, reason: "fraudulent" } },
    };
    const r1 = await call(dispute);
    expect(r1.code).toBe(200);
    expect(whEvents.filter((e) => e.event === "payment_disputed")).toHaveLength(1);
    // Not paid yet: the dispute branch alone must not flag the issue.
    expect(whRow["issue_open"]).toBe(false);
    expect(whRow["issue_ever"]).toBe(false);
    const succeeded = {
      id: "evt_lb03_paid", type: "payment_intent.succeeded",
      data: { object: { id: "pi_lb03", customer: "cus_mb", amount: 20000, metadata: { gh_booking_id: WH_BID } } },
    };
    const r2 = await call(succeeded);
    expect(r2.code).toBe(200);
    expect(whRow["status"]).toBe("paid");
    expect(whRow["payment_intent_id"]).toBe("pi_lb03");
    expect(whRow["issue_open"]).toBe(true);
    expect(whRow["issue_ever"]).toBe(true);
  });

  it("LB-03 control: succeeded with no earlier dispute marks paid without opening an issue", async () => {
    const succeeded = {
      id: "evt_lb03_ctrl", type: "payment_intent.succeeded",
      data: { object: { id: "pi_lb03c", customer: "cus_mb", amount: 20000, metadata: { gh_booking_id: WH_BID } } },
    };
    const r = await call(succeeded);
    expect(r.code).toBe(200);
    expect(whRow["status"]).toBe("paid");
    expect(whRow["issue_open"]).toBe(false);
    expect(whRow["issue_ever"]).toBe(false);
  });

  it("LB-12: a fee intent with no visit_cancelled record is refused, not mirrored", async () => {
    whRow["status"] = "cancelled";
    const fee = {
      id: "evt_lb12_norecord", type: "payment_intent.succeeded",
      data: { object: { id: "pi_fee_norec", customer: "cus_mb", amount: 2500, metadata: { gh_booking_id: WH_BID, gh_kind: "cancellation_fee" } } },
    };
    const r = await call(fee);
    expect(r.code).toBe(200);
    expect(whMeta["gh_fee_charged"]).toBeUndefined();
    expect(whMeta["gh_fee_last_payment"]).toBeUndefined();
    expect(whRow["fee_status"]).toBeNull();
    expect(whEvents.filter((e) => e.event === "cancellation_fee_paid")).toHaveLength(0);
  });

  it("LB-12 control: a fee intent matching the visit_cancelled record is still mirrored", async () => {
    whRow["status"] = "cancelled";
    whEvents.push({
      event: "visit_cancelled", detail: { fee_cents: 2500 }, visit_id: WH_VISIT, booking_id: WH_BID, created_at: hoursAgo(2),
    });
    const fee = {
      id: "evt_lb12_ok", type: "payment_intent.succeeded",
      data: { object: { id: "pi_fee_ok", customer: "cus_mb", amount: 2500, metadata: { gh_booking_id: WH_BID, gh_kind: "cancellation_fee" } } },
    };
    const r = await call(fee);
    expect(r.code).toBe(200);
    expect(whMeta["gh_fee_charged"]).toBe("1");
    expect(whMeta["gh_fee_last_payment"]).toBe("pi_fee_ok");
    expect(whRow["fee_status"]).toBe("fee_paid");
    expect(whEvents.filter((e) => e.event === "cancellation_fee_paid")).toHaveLength(1);
  });

  it("LB-14: setup_intent.succeeded does not stamp card_ready over report_sent", async () => {
    const si = {
      id: "evt_lb14_si", type: "setup_intent.succeeded",
      data: { object: { id: "si_mb", customer: "cus_mb", payment_method: "pm_mb14", metadata: { gh_booking_id: WH_BID } } },
    };
    const r = await call(si);
    expect(r.code).toBe(200);
    expect(whMeta["gh_state"]).toBe("report_sent");
    expect(whMeta["gh_payment_method"]).toBe("pm_mb14");
    const stateWrites = whStripePosts.filter((p) => p.params["metadata[gh_state]"] === "card_ready");
    expect(stateWrites).toHaveLength(0);
  });

  it("LB-14: checkout.session.completed does not stamp card_ready over report_sent", async () => {
    const co = {
      id: "evt_lb14_co", type: "checkout.session.completed",
      data: { object: { mode: "setup", customer: "cus_mb", setup_intent: "si_mb", client_reference_id: WH_BID, metadata: { source: "gatehouse_save_card", gh_booking_id: WH_BID } } },
    };
    const r = await call(co);
    expect(r.code).toBe(200);
    expect(whMeta["gh_state"]).toBe("report_sent");
    expect(whMeta["gh_payment_method"]).toBe("pm_mb14");
    const stateWrites = whStripePosts.filter((p) => p.params["metadata[gh_state]"] === "card_ready");
    expect(stateWrites).toHaveLength(0);
  });

  it("LB-14 control: card_ready is still stamped when no payment is in flight", async () => {
    whMeta["gh_state"] = "awaiting_card";
    const si = {
      id: "evt_lb14_ctrl", type: "setup_intent.succeeded",
      data: { object: { id: "si_mb", customer: "cus_mb", payment_method: "pm_mb14", metadata: { gh_booking_id: WH_BID } } },
    };
    const r = await call(si);
    expect(r.code).toBe(200);
    expect(whMeta["gh_state"]).toBe("card_ready");
    expect(whMeta["gh_payment_method"]).toBe("pm_mb14");
  });
});

// ---------------------------------------------------------------- LB-08

describe("LB-08: the dedup fallback is bounded", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("records and reports an event while the DB is not configured", async () => {
    expect(await webhookEventSeen("stripe", "lb08-basic-missing")).toBe(false);
    await recordWebhookEvent("stripe", "lb08-basic-1", "payment_intent.succeeded");
    expect(await webhookEventSeen("stripe", "lb08-basic-1")).toBe(true);
    expect(await webhookEventSeen("stripe", "lb08-basic-other")).toBe(false);
  });

  it("evicts the oldest entries past 2000", async () => {
    // The fallback is module-global: earlier tests in this file (and
    // the webhook deliveries above) already hold entries, so the
    // exact boundary depends on them. Assert the invariant instead:
    // a marker recorded before 2001 fresh inserts is evicted, while
    // the newest insert survives.
    await recordWebhookEvent("stripe", "lb08-cap-marker", "payment_intent.succeeded");
    expect(await webhookEventSeen("stripe", "lb08-cap-marker")).toBe(true);
    for (let i = 0; i < 2001; i++) {
      await recordWebhookEvent("stripe", `lb08-cap-${i}`, "payment_intent.succeeded");
    }
    expect(await webhookEventSeen("stripe", "lb08-cap-marker")).toBe(false);
    expect(await webhookEventSeen("stripe", "lb08-cap-2000")).toBe(true);
    expect(await webhookEventSeen("stripe", "lb08-cap-1999")).toBe(true);
  });

  it("entries expire after 24h", async () => {
    await recordWebhookEvent("stripe", "lb08-ttl-1", "payment_intent.succeeded");
    expect(await webhookEventSeen("stripe", "lb08-ttl-1")).toBe(true);
    try {
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 25 * 3600 * 1000);
      expect(await webhookEventSeen("stripe", "lb08-ttl-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
