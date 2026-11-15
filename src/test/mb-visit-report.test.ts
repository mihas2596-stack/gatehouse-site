// @vitest-environment node
// MB-07 / MB-13 / MB-14 / MB-15 / LB-17 / LB-06 / MB-21 / MB-06
// (maximal audit 14.11.2026) — client cabinets + money (server).
//
// MB-07 (DA-16): a dispute resolved for a resolve-and-pay must reopen
// when the charge then ends blocked/unknown — not only on a terminal
// failure — and the approve response must be rebuilt from fresh
// row/journal, not the pre-charge snapshot.
// MB-13 (DA-40): a pre-payment complaint is timely under EITHER Terms
// window (§7 24h after the report, §10.2 48h damage) — the button
// cannot tell a missed-item report from a damage claim.
// MB-14 (DA-44): propose_date validates the calendar date, requires a
// future date, and checks the Stripe write.
// MB-15 (DA-45): update_access checks the saveAccessNote result.
// LB-17 (DA-46): a failed entry revoke on cancel surfaces a warning.
// LB-06 (DA-20): card lists reuse the paginated listCustomerCards.
// MB-21/LB-18: the 60-photo cap filters kind != client in the query.
// MB-06 (DA-15): a failed photo read flags photos_degraded instead of
// a silent 200 with an empty report.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import visitHandler from "../../api/visit";
import reportHandler from "../../api/report";
import { reopenIssueAfterUnsettledCharge } from "../../api/_payment_obligation";
import { signBooking } from "../../api/create-checkout-session";

const BID = "bid-mb-visit-report";
const VISIT_ID = "22222222-3333-4444-5555-666666666666";
const LINK_SECRET = "test-link-secret-mb";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string; actor?: string; booking_id?: string };

let row: Row;
let events: Ev[];
let photos: Row[];
let accessRows: Row[];
let storeMeta: Record<string, string>;
let stripePostFail: boolean;
let failPhotosRead: boolean;
let failAccessInsert: boolean;
let failAccessDelete: boolean;
let patchVisitsFail: boolean;
let cardList: Array<{ id: string; card: { brand: string; last4: string } }>;
let cardPaginate: boolean;
let sbUrls: string[];

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const daysAgoDate = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString().slice(0, 10);
const futureDate = (d: number) => new Date(Date.now() + d * 24 * 3600 * 1000).toISOString().slice(0, 10);
const todayNY = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

function matchCond(r: Row, field: string, op: string, val: string): boolean {
  const v = r[field];
  const dec = decodeURIComponent(val);
  if (op === "eq") return String(v ?? "") === dec;
  if (op === "neq") return String(v ?? "") !== dec;
  if (op === "is") return dec === "null" ? v === null || v === undefined : v !== null && v !== undefined;
  return true;
}
function applyDbFilters(list: Row[], u: URL): Row[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    const dot = v.indexOf(".");
    if (dot <= 0) continue;
    out = out.filter((r) => matchCond(r, k, v.slice(0, dot), v.slice(dot + 1)));
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

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

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", LINK_SECRET);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  row = {};
  events = [];
  photos = [];
  accessRows = [];
  storeMeta = {};
  stripePostFail = false;
  failPhotosRead = false;
  failAccessInsert = false;
  failAccessDelete = false;
  patchVisitsFail = false;
  cardList = [];
  cardPaginate = false;
  sbUrls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    sbUrls.push(String(url));
    const sbRes = (data: unknown, ok = true, status = 200) => ({
      ok, status,
      json: async () => data, text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    });
    if (u.hostname.includes("supabase")) {
      sbUrls.push(String(url));
      if (u.pathname.includes("/storage/v1/object/sign/")) {
        return sbRes({ signedURL: `/signed/${Date.now()}.jpg?token=x` });
      }
      const table = u.pathname.split("/").pop() ?? "";
      if (method === "GET") {
        if (table === "gh_photos" && failPhotosRead) {
          return { ok: false, status: 500, json: async () => ({ message: "db down" }), text: async () => "{}" };
        }
        let list: Row[] = table === "gh_visits" ? [row] : table === "gh_events" ? events : table === "gh_photos" ? photos : accessRows;
        let out = applyDbFilters(list, u);
        if (table === "gh_events" && u.searchParams.get("order")?.includes("created_at.desc")) {
          out = [...out].sort((a, b) => String(b["created_at"] ?? "").localeCompare(String(a["created_at"] ?? "")));
        }
        return sbRes(out);
      }
      if (method === "POST") {
        if (table === "gh_visit_access" && failAccessInsert) {
          return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" };
        }
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const inserted = { ...body, id: `row-${Date.now()}-${Math.random()}`, created_at: new Date().toISOString() };
        const list: Row[] = table === "gh_visits" ? [row] : table === "gh_events" ? events : table === "gh_photos" ? photos : accessRows;
        list.push(inserted);
        return sbRes([inserted]);
      }
      if (method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const list: Row[] = table === "gh_visits" ? [row] : table === "gh_events" ? events : table === "gh_photos" ? photos : accessRows;
        if (table === "gh_visits" && patchVisitsFail) return sbRes([]);
        const matched = applyDbFilters(list, u);
        for (const target of matched) Object.assign(target, body);
        return sbRes(matched);
      }
      if (method === "DELETE") {
        if (table === "gh_visit_access" && failAccessDelete) {
          return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" };
        }
        const list: Row[] = table === "gh_visits" ? [row] : table === "gh_events" ? events : table === "gh_photos" ? photos : accessRows;
        const matched = applyDbFilters(list, u);
        for (const d of matched) { const i = list.indexOf(d); if (i >= 0) list.splice(i, 1); }
        return sbRes(matched);
      }
      return sbRes([]);
    }
    if (u.hostname === "api.resend.com") return sbRes({ id: "email-1" });
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.includes("/customers/search")) {
        return sbRes({ data: [{ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: { ...storeMeta } }] });
      }
      if (u.pathname.endsWith("/payment_methods")) {
        if (cardPaginate) {
          const after = u.searchParams.get("starting_after");
          if (!after) {
            return sbRes({ data: cardList.slice(0, 10), has_more: cardList.length > 10 });
          }
          const idx = cardList.findIndex((c) => c.id === after);
          return sbRes({ data: cardList.slice(idx + 1), has_more: false });
        }
        return sbRes({ data: cardList, has_more: false });
      }
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (custM) {
        if (method === "POST") {
          if (stripePostFail) {
            return { ok: false, status: 500, json: async () => ({ error: { message: "stripe down" } }), text: async () => "{}" };
          }
          const params = new URLSearchParams(String(init?.body ?? ""));
          for (const [k, v] of params) {
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) storeMeta[m[1]] = v;
          }
        }
        return sbRes({ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: { ...storeMeta } });
      }
      return sbRes({ id: "cus_v" });
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const bt = () => signBooking(LINK_SECRET, {
  bid: BID, email: "client@example.com", name: "Casey Client",
}).token;
const visitPost = (body: Record<string, unknown>) => ({
  method: "POST", headers: {}, body: { bt: bt(), ...body },
});
const reportPost = (body: Record<string, unknown>) => ({
  method: "POST", headers: {}, body: { bt: bt(), ...body },
});
const reportGet = () => ({ method: "GET", headers: {}, query: { bt: bt() } });
const visitGet = () => ({ method: "GET", headers: {}, query: { bt: bt() } });

// Confirmed visit, cleaner assigned, no report yet — the state the
// visit-cabinet actions (propose_date, update_access, cancel) need.
function setupConfirmedVisit() {
  const visitDate = futureDate(10);
  row = {
    id: VISIT_ID, booking_id: BID, status: "confirmed", amount_cents: 18900,
    cleaner_name: "Ana", client_email: "client@example.com",
    report_sent_at: null, report_bounced: false, report_status: "none",
    visit_date: visitDate, window: "morning", issue_open: false, issue_ever: false,
    no_photo_zones: null,
  };
  events = [
    { event: "visit_created", detail: {}, created_at: hoursAgo(50), booking_id: BID },
    { event: "visit_confirmed", detail: { date: visitDate, window: "morning" }, created_at: hoursAgo(49), booking_id: BID },
  ];
  storeMeta = {
    gh_booking_id: BID, gh_state: "confirmed",
    gh_confirmed_date: visitDate, gh_confirmed_window: "morning",
    gh_payment_method: "pm_test_1", gh_first_price_cents: "18900",
  };
}

// Report sent, visit in the past, issue open — the approve path.
function setupReportSentWithOpenIssue(opts?: { amountCents?: number | null }) {
  const sentAt = hoursAgo(2);
  row = {
    id: VISIT_ID, booking_id: BID, status: "report_sent", amount_cents: opts?.amountCents === undefined ? 14900 : opts.amountCents,
    cleaner_name: "Ana", client_email: "client@example.com",
    report_sent_at: sentAt, report_bounced: false, report_status: "sent",
    visit_date: daysAgoDate(1), window: "morning", issue_open: true, issue_ever: true,
    no_photo_zones: null,
  };
  events = [
    { event: "visit_created", detail: {}, created_at: hoursAgo(50), booking_id: BID },
    { event: "issue_opened", detail: { reason: "Missed the kitchen", room: "Kitchen" }, created_at: hoursAgo(4), booking_id: BID, actor: "client" },
    { event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt, booking_id: BID },
  ];
  storeMeta = {
    gh_booking_id: BID, gh_state: "report_sent",
    gh_payment_method: "pm_test_1", gh_first_price_cents: "14900",
    gh_report_sent_at: sentAt,
  };
  return sentAt;
}

describe("MB-07: reopenIssueAfterUnsettledCharge", () => {
  const resolvedIssueEvents = (): Ev[] => [
    { event: "issue_opened", detail: { reason: "Missed a room" }, created_at: hoursAgo(4), booking_id: BID },
    { event: "issue_resolved", detail: { via: "client_resolve_and_pay" }, created_at: hoursAgo(1), booking_id: BID },
    { event: "report_sent", detail: { version: 1, email_sent: true }, created_at: hoursAgo(5), booking_id: BID },
  ];
  const setupReopenRow = () => {
    row = {
      id: VISIT_ID, booking_id: BID, status: "report_sent", amount_cents: 14900,
      report_sent_at: hoursAgo(5), report_status: "sent",
      visit_date: daysAgoDate(1), issue_open: false, issue_ever: true,
    };
    events = resolvedIssueEvents();
  };

  it("blocked outcome reopens a resolved dispute", async () => {
    setupReopenRow();
    await reopenIssueAfterUnsettledCharge(BID, "client_approve", { outcome: "blocked", error: "payment_basis_missing" });
    expect(row["issue_open"]).toBe(true);
    const reopened = events.find((e) => e.event === "issue_opened" && e.detail?.["reason"] === "charge_unsettled_after_resolve");
    expect(reopened).toBeTruthy();
    expect(reopened?.detail?.["outcome"]).toBe("blocked");
  });

  it("unknown outcome reopens too (the money question is for reconciliation, the dispute must be visible)", async () => {
    setupReopenRow();
    await reopenIssueAfterUnsettledCharge(BID, "owner_charge", { outcome: "unknown", error: "payment_unknown" });
    expect(row["issue_open"]).toBe(true);
    expect(events.some((e) => e.event === "issue_opened" && e.detail?.["reason"] === "charge_unsettled_after_resolve")).toBe(true);
  });

  it("a live 3DS challenge (payment_requires_action) does NOT reopen — the client completes it and re-approves", async () => {
    setupReopenRow();
    await reopenIssueAfterUnsettledCharge(BID, "client_approve", { outcome: "failed", error: "payment_requires_action", detail: "requires_action" });
    expect(row["issue_open"]).toBe(false);
    expect(events.filter((e) => e.event === "issue_opened")).toHaveLength(1);
  });

  it("a processing intent does NOT reopen — the money may still land", async () => {
    setupReopenRow();
    await reopenIssueAfterUnsettledCharge(BID, "client_approve", { outcome: "processing", payment_intent: "pi_live" });
    expect(row["issue_open"]).toBe(false);
  });

  it("a paid visit does NOT reopen", async () => {
    setupReopenRow();
    row["status"] = "paid";
    await reopenIssueAfterUnsettledCharge(BID, "client_approve", { outcome: "blocked", error: "already_paid" });
    expect(row["issue_open"]).toBe(false);
  });

  it("a waived visit does NOT reopen — the waive is terminal", async () => {
    setupReopenRow();
    events = [
      ...resolvedIssueEvents(),
      { event: "issue_decision", detail: { decision: "waived" }, created_at: hoursAgo(0.5), booking_id: BID },
    ];
    await reopenIssueAfterUnsettledCharge(BID, "owner_charge", { outcome: "blocked", error: "charge_waived" });
    expect(row["issue_open"]).toBe(false);
  });

  it("an already-open issue is a no-op (no duplicate journal event)", async () => {
    setupReopenRow();
    row["issue_open"] = true;
    await reopenIssueAfterUnsettledCharge(BID, "client_approve", { outcome: "blocked", error: "payment_basis_missing" });
    expect(events.filter((e) => e.event === "issue_opened")).toHaveLength(1);
  });

  it("a visit that was never disputed has nothing to reopen", async () => {
    setupReopenRow();
    events = [{ event: "report_sent", detail: { version: 1, email_sent: true }, created_at: hoursAgo(5), booking_id: BID }];
    row["issue_ever"] = false;
    await reopenIssueAfterUnsettledCharge(BID, "client_approve", { outcome: "blocked", error: "payment_basis_missing" });
    expect(row["issue_open"]).toBe(false);
    expect(events.filter((e) => e.event === "issue_opened")).toHaveLength(0);
  });
});

describe("MB-07: approve with a blocked charge reopens the issue and shows it", () => {
  it("blocked charge (no pinned amount) → 409 quote_missing, state issue_open, row flag back on", async () => {
    const sentAt = setupReportSentWithOpenIssue({ amountCents: null });
    const r = res();
    await reportHandler(reportPost({ action: "approve", seen_publication_id: sentAt }) as never, r as never);
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("quote_missing");
    // The rebuilt view must show the reopened issue — not the stale
    // pre-charge snapshot (which briefly showed payment_issue).
    expect(r.body["state"]).toBe("issue_open");
    expect(row["issue_open"]).toBe(true);
    const reopened = events.find((e) => e.event === "issue_opened" && e.detail?.["reason"] === "charge_unsettled_after_resolve");
    expect(reopened).toBeTruthy();
    expect(reopened?.detail?.["via"]).toBe("client_approve");
  });
});

describe("MB-13: pre-payment issue window (Terms §7 24h / §10.2 48h damage)", () => {
  const setupIssueVisit = (sentHoursAgo: number, visitDaysAgo: number) => {
    const sentAt = hoursAgo(sentHoursAgo);
    row = {
      id: VISIT_ID, booking_id: BID, status: "report_sent", amount_cents: 14900,
      cleaner_name: "Ana", client_email: "client@example.com",
      report_sent_at: sentAt, report_bounced: false, report_status: "sent",
      visit_date: daysAgoDate(visitDaysAgo), window: "morning", issue_open: false, issue_ever: false,
      no_photo_zones: null,
    };
    events = [
      { event: "visit_created", detail: {}, created_at: hoursAgo(60), booking_id: BID },
      { event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt, booking_id: BID },
    ];
    storeMeta = {
      gh_booking_id: BID, gh_state: "report_sent",
      gh_payment_method: "pm_test_1", gh_first_price_cents: "14900",
      gh_report_sent_at: sentAt,
    };
  };

  it("30h after the report, damage window still open → accepted and journaled as a damage-window claim", async () => {
    setupIssueVisit(30, 1);
    const r = res();
    await reportHandler(reportPost({ action: "issue", reason: "Scratched the table", room: "Kitchen" }) as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("issue_open");
    const opened = events.find((e) => e.event === "issue_opened");
    expect(opened?.detail?.["window"]).toBe("damage");
    expect(row["issue_open"]).toBe(true);
  });

  it("10h after the report → accepted under the 24h report window", async () => {
    setupIssueVisit(10, 1);
    const r = res();
    await reportHandler(reportPost({ action: "issue", reason: "Missed the kitchen", room: "Kitchen" }) as never, r as never);
    expect(r.code).toBe(200);
    const opened = events.find((e) => e.event === "issue_opened");
    expect(opened?.detail?.["window"]).toBe("report");
  });

  it("both windows expired → 409 with both window ends, nothing recorded", async () => {
    setupIssueVisit(50, 3);
    const r = res();
    await reportHandler(reportPost({ action: "issue", reason: "Late complaint", room: "Kitchen" }) as never, r as never);
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("issue_window_expired");
    expect(typeof r.body["report_window_ends"]).toBe("string");
    expect(typeof r.body["damage_window_ends"]).toBe("string");
    expect(events.some((e) => e.event === "issue_opened")).toBe(false);
    expect(row["issue_open"]).toBe(false);
  });
});

describe("MB-06 / MB-21: report photo read", () => {
  const setupReportPhotos = () => {
    const sentAt = hoursAgo(2);
    row = {
      id: VISIT_ID, booking_id: BID, status: "report_sent", amount_cents: 14900,
      cleaner_name: "Ana", client_email: "client@example.com",
      report_sent_at: sentAt, report_bounced: false, report_status: "sent",
      visit_date: daysAgoDate(1), window: "morning", issue_open: false, issue_ever: false,
    };
    events = [
      { event: "visit_created", detail: {}, created_at: hoursAgo(50), booking_id: BID },
      { event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt, booking_id: BID },
    ];
    storeMeta = {
      gh_booking_id: BID, gh_state: "report_sent",
      gh_payment_method: "pm_test_1", gh_first_price_cents: "14900",
      gh_report_sent_at: sentAt,
    };
  };

  it("failed photo read → photos_degraded flag, not a silent empty report", async () => {
    setupReportPhotos();
    photos = [{ visit_id: VISIT_ID, room: "Kitchen", storage_path: "visits/x/1.jpg", kind: "before", note: null }];
    failPhotosRead = true;
    const r = res();
    await reportHandler(reportGet() as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["photos_degraded"]).toBe(true);
    expect(r.body["photos"]).toEqual([]);
  });

  it("60 client photos do not eat the 60-photo cap — kind is filtered in the query", async () => {
    setupReportPhotos();
    photos = Array.from({ length: 60 }, (_, i) => ({
      visit_id: VISIT_ID, room: "Client photo", storage_path: `visits/x/client-${i}.jpg`, kind: "client", note: null,
    }));
    photos.push({ visit_id: VISIT_ID, room: "Kitchen", storage_path: "visits/x/before.jpg", kind: "before", note: null });
    const r = res();
    await reportHandler(reportGet() as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["photos_degraded"]).toBe(false);
    const items = r.body["photo_items"] as Array<{ kind?: string; room?: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("before");
    expect(items[0]?.room).toBe("Kitchen");
    const photoQuery = sbUrls.find((u) => u.includes("/rest/v1/gh_photos"));
    expect(photoQuery).toContain("kind=neq.client");
  });
});

describe("MB-14: propose_date", () => {
  it("impossible calendar date → 400 bad_date", async () => {
    setupConfirmedVisit();
    const r = res();
    await visitHandler(visitPost({ action: "propose_date", date: "2026-02-30" }) as never, r as never);
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("bad_date");
    expect(events.some((e) => e.event === "date_proposed")).toBe(false);
  });

  it("month 13 → 400 bad_date", async () => {
    setupConfirmedVisit();
    const r = res();
    await visitHandler(visitPost({ action: "propose_date", date: "2026-13-40" }) as never, r as never);
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("bad_date");
  });

  it("past date → 400 date_in_past", async () => {
    setupConfirmedVisit();
    const r = res();
    await visitHandler(visitPost({ action: "propose_date", date: daysAgoDate(1) }) as never, r as never);
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("date_in_past");
  });

  it("today → 400 date_in_past (a proposal must be a future date)", async () => {
    setupConfirmedVisit();
    const r = res();
    await visitHandler(visitPost({ action: "propose_date", date: todayNY() }) as never, r as never);
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("date_in_past");
  });

  it("future date but the Stripe write fails → 502, nothing proposed", async () => {
    setupConfirmedVisit();
    stripePostFail = true;
    const r = res();
    await visitHandler(visitPost({ action: "propose_date", date: futureDate(5) }) as never, r as never);
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("stripe_error");
    expect(storeMeta["gh_proposed_date"]).toBeUndefined();
    expect(events.some((e) => e.event === "date_proposed")).toBe(false);
  });

  it("future date happy path → 200 with the proposal stored", async () => {
    setupConfirmedVisit();
    const date = futureDate(5);
    const r = res();
    await visitHandler(visitPost({ action: "propose_date", date }) as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["proposed_date"]).toBe(date);
    expect(storeMeta["gh_proposed_date"]).toBe(date);
    expect(events.some((e) => e.event === "date_proposed" && e.detail?.["date"] === date)).toBe(true);
  });
});

describe("MB-15: update_access checks the note save", () => {
  it("failed note save → 502 db_error (zones were already written to Stripe — partial, visible failure)", async () => {
    setupConfirmedVisit();
    failAccessInsert = true;
    const r = res();
    await visitHandler(visitPost({ action: "update_access", notes: "Lockbox 1234", no_photo_zones: "Office" }) as never, r as never);
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_error");
    expect(accessRows).toHaveLength(0);
    expect(storeMeta["gh_no_photo_zones"]).toBe("Office");
  });
});

describe("LB-17: cancel surfaces a failed entry revoke", () => {
  it("deleteAccess fails → 200 with entry_revoke_failed and a journal event", async () => {
    setupConfirmedVisit();
    accessRows = [{ id: "acc-1", visit_id: VISIT_ID, entry_method: "arrange", entry_note: "", entry_secret: "x" }];
    failAccessDelete = true;
    const r = res();
    await visitHandler(visitPost({ action: "cancel", scope: "once" }) as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["entry_revoke_failed"]).toBe(true);
    expect(row["status"]).toBe("cancelled");
    expect(events.some((e) => e.event === "entry_revoke_failed")).toBe(true);
  });

  it("revoke succeeds → 200 with no warning flag", async () => {
    setupConfirmedVisit();
    accessRows = [{ id: "acc-1", visit_id: VISIT_ID, entry_method: "arrange", entry_note: "", entry_secret: "x" }];
    const r = res();
    await visitHandler(visitPost({ action: "cancel", scope: "once" }) as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["entry_revoke_failed"]).toBeUndefined();
    expect(accessRows).toHaveLength(0);
    expect(events.some((e) => e.event === "entry_revoked")).toBe(true);
  });
});

describe("LB-06: card lists use the paginated listCustomerCards", () => {
  it("detached booking card + exactly one other card → no other card's brand/last4 shown", async () => {
    setupConfirmedVisit();
    storeMeta["gh_payment_method"] = "pm_detached";
    cardList = [{ id: "pm_other", card: { brand: "visa", last4: "4242" } }];
    const r = res();
    await visitHandler(visitGet() as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["card_brand"]).toBe("");
    expect(r.body["card_last4"]).toBe("");
  });

  it("booking card is 11th of 12 → found past the old 10-card page", async () => {
    setupConfirmedVisit();
    storeMeta["gh_payment_method"] = "pm_011";
    cardList = Array.from({ length: 12 }, (_, i) => ({
      id: `pm_${String(i + 1).padStart(3, "0")}`,
      card: { brand: i === 10 ? "mastercard" : "visa", last4: i === 10 ? "5555" : "4242" },
    }));
    cardPaginate = true;
    const r = res();
    await visitHandler(visitGet() as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["card_brand"]).toBe("mastercard");
    expect(r.body["card_last4"]).toBe("5555");
    expect(sbUrls.some((u) => u.includes("/payment_methods") && u.includes("starting_after="))).toBe(true);
  });
});
