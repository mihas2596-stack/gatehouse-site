// @vitest-environment node
// 16.11.2026 (spec 1.3/1.5/2.2): Request Details, reduced-amount offer,
// partial refund, and the charge block on an active details request.
// Shared harness: in-memory Supabase REST mock + Stripe/Resend mocks,
// modelled on src/test/issue-decision-actions.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";
import reportHandler from "../../api/report";
import { signBooking } from "../../api/create-checkout-session";

const BID = "bid-details-1";
const VISIT_ID = "77777777-4444-5555-6666-777777777777";
const CONSENT_VERSION = "2026-11-16-v1";

type Row = Record<string, unknown>;
type Ev = Record<string, unknown>;

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

function matchCond(row: Record<string, unknown>, field: string, op: string, val: string): boolean {
  const v = row[field];
  const dec = decodeURIComponent(val);
  if (op === "eq") return String(v ?? "") === dec;
  if (op === "neq") return v !== null && v !== undefined && String(v) !== dec;
  if (op === "is") return dec === "null" ? v === null || v === undefined : v !== null && v !== undefined;
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
    const dot = v.indexOf(".");
    if (dot <= 0) continue;
    out = out.filter((r) => matchCond(r, k, v.slice(0, dot), v.slice(dot + 1)));
  }
  const order = u.searchParams.get("order");
  if (order) {
    const [field, dir] = order.split(".");
    out.sort((a, b) => { const cmp = String(a[field] ?? "").localeCompare(String(b[field] ?? "")); return dir === "desc" ? -cmp : cmp; });
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

describe("issue details request (spec 1.3)", () => {
  let rows: Row[];
  let events: Ev[];
  let photos: Row[];
  let stripeMeta: Record<string, string>;
  let resendCalls: { to: string[]; subject: string; text: string }[];
  let piCreates: number;
  let piAmounts: number[];
  let refundCalls: number;
  let bt: string;
  let seedSentAt: string;

  const supRes = (data: unknown, ok = true, status = 200) => ({
    ok, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });

  const installFetch = () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.includes("api.stripe.com")) {
        if (u.includes("/customers/search")) {
          return supRes({ data: [{ id: "cus_test_b8", email: "client@example.com", name: "Casey Client", metadata: { ...stripeMeta } }] });
        }
        if (u.includes("/payment_methods")) return supRes({ data: [] });
        if (u.includes("/payment_intents/search")) return supRes({ data: [] });
        if (u.includes("/refunds") && method === "POST") {
          refundCalls++;
          return supRes({ id: "re_test_1", status: "succeeded" });
        }
        if (u.includes("/payment_intents") && method === "POST") {
          piCreates++;
          const params = new URLSearchParams(String(init?.body ?? ""));
          const amt = parseInt(params.get("amount") ?? "0", 10);
          if (Number.isFinite(amt)) piAmounts.push(amt);
          return supRes({ id: "pi_test_1", status: "succeeded" });
        }
        if (u.includes("/customers/cus_test_b8")) {
          if (method === "POST") {
            const params = new URLSearchParams(String(init?.body ?? ""));
            for (const [k, v] of params) {
              const m = /^metadata\[(.+)\]$/.exec(k);
              if (m) stripeMeta[m[1]] = v;
            }
            return supRes({ id: "cus_test_b8" });
          }
          return supRes({ id: "cus_test_b8", email: "client@example.com", name: "Casey Client", metadata: { ...stripeMeta } });
        }
        return supRes({ id: "cus_test_b8" });
      }
      if (u.includes("api.resend.com")) {
        try {
          const b = JSON.parse(String(init?.body ?? "{}")) as { to?: string[]; subject?: string; text?: string };
          resendCalls.push({ to: b.to ?? [], subject: b.subject ?? "", text: b.text ?? "" });
        } catch { /* ignore */ }
        return supRes({ id: "email-1" });
      }
      if (u.includes("/storage/v1/object/sign/")) {
        const tail = u.split("/object/sign/")[1] ?? "x.jpg";
        return supRes({ signedURL: `/object/sign/${tail}?token=test-token` });
      }
      if (u.includes("/rest/v1/")) {
        const uu = new URL(u);
        const table = uu.pathname.split("/").pop() ?? "";
        const list = table === "gh_visits" ? rows : table === "gh_events" ? events : table === "gh_photos" ? photos : [];
        if (method === "GET") return supRes(applyDbFilters(list, uu));
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          const inserted = { ...body, id: list.length + 1, created_at: new Date().toISOString() };
          list.push(inserted);
          return supRes([inserted]);
        }
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          const matched = applyDbFilters(list, uu);
          for (const target of matched) Object.assign(target, body);
          return supRes(matched);
        }
        return supRes([]);
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
    }));
  };

  const callAction = async (body: Record<string, unknown>) => {
    const r = res();
    await bookingAction(
      { method: "POST", headers: { authorization: "Bearer " + "adm-" + "secret" }, body } as never,
      r as never,
    );
    return r;
  };

  const callReport = async (method: string, bodyOrQuery: Record<string, unknown>) => {
    const r = res();
    if (method === "GET") {
      await reportHandler(
        { method: "GET", headers: {}, query: { bt } } as never,
        r as never,
      );
    } else {
      await reportHandler(
        { method: "POST", headers: {}, body: { bt, ...bodyOrQuery } } as never,
        r as never,
      );
    }
    return r;
  };

  type SeedOpts = {
    consent?: boolean;
    issueOpen?: boolean;
    issueEver?: boolean;
    kind?: "issue" | "damage";
    status?: string;
    paid?: boolean;
    detailsRequested?: boolean;
    detailsDeadlinePast?: boolean;
    approvalAt?: string | null;
    resolved?: boolean;
    decision?: { decision: string; resolution: string } | null;
    rooms?: string[];
    reportSentAt?: string;
    visitDate?: string;
    offer?: number | null;
  };

  const seed = (opts: SeedOpts = {}) => {
    const consent = opts.consent ?? true;
    const issueOpen = opts.issueOpen ?? true;
    const kind = opts.kind ?? "issue";
    const sentAt = opts.reportSentAt ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();
    seedSentAt = sentAt;
    const visitDate = opts.visitDate ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const now = new Date();
    const reqAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const deadline = new Date(now.getTime() + (opts.detailsDeadlinePast ? -60 : 47 * 60) * 60 * 1000).toISOString();
    rows = [{
      id: VISIT_ID,
      booking_id: BID,
      visit_no: 1,
      status: opts.status ?? (opts.paid ? "paid" : "report_sent"),
      report_status: "sent",
      visit_date: visitDate,
      window: "morning",
      service: "Standard cleaning",
      client_name: "Casey Client",
      client_email: "client@example.com",
      amount_cents: 14900,
      cleaner_name: null,
      cleaner_id: null,
      issue_open: issueOpen,
      issue_ever: opts.issueEver ?? issueOpen,
      report_sent_at: sentAt,
      report_bounced: false,
      report_email_id: null,
      checklist: { rooms: [] },
      ...(consent ? { consent_text_version: CONSENT_VERSION, consent_given_at: "2026-11-08T09:00:00.000Z" } : {}),
      ...(kind === "damage" ? { issue_kind: "damage", damage_reported_at: sentAt } : {}),
      ...(opts.detailsRequested ? { details_requested_at: reqAt, details_deadline_at: deadline, details_request_text: "Which room was sticky?" } : {}),
      ...(opts.paid ? { payment_intent_id: "pi_test_1", paid_at: sentAt } : {}),
      ...(opts.offer ? { offer_amount_cents: opts.offer, offer_status: "offered" } : {}),
    }];
    events = [
      { visit_id: VISIT_ID, booking_id: BID, event: "report_sent", detail: { email_sent: true, version: 1 }, created_at: sentAt },
    ];
    if (issueOpen || opts.issueEver) {
      events.push({ visit_id: VISIT_ID, booking_id: BID, event: "issue_opened", detail: { reason: "Streaks on the floor", room: "Kitchen", ...(kind === "damage" ? { kind: "damage" } : {}), ...(opts.rooms ? { rooms: opts.rooms } : {}) }, created_at: "2026-11-08T11:00:00.000Z" });
    }
    if (opts.resolved) {
      events.push({ visit_id: VISIT_ID, booking_id: BID, event: "issue_resolved", detail: { via: "owner_resolve", resolved_at: "2026-11-09T10:00:00.000Z" }, created_at: "2026-11-09T10:00:00.000Z" });
    }
    if (opts.decision) {
      events.push({ visit_id: VISIT_ID, booking_id: BID, event: "issue_decision", detail: { decision: opts.decision.decision, resolution: opts.decision.resolution, decided_at: "2026-11-09T10:00:00.000Z" }, created_at: "2026-11-09T10:00:00.000Z" });
    }
    if (opts.detailsRequested) {
      events.push({ visit_id: VISIT_ID, booking_id: BID, event: "issue_details_requested", detail: { request: "Which room was sticky?", deadline_at: deadline, requested_at: reqAt }, created_at: reqAt });
    }
    if (opts.approvalAt) {
      events.push({ visit_id: VISIT_ID, booking_id: BID, event: "report_approved", detail: {}, created_at: opts.approvalAt });
    }
    if (opts.offer) {
      events.push({ visit_id: VISIT_ID, booking_id: BID, event: "payment_offered", detail: { offer_amount_cents: opts.offer, offer_status: "offered", resolution: "Reduced amount for the missed kitchen." }, created_at: "2026-11-09T11:00:00.000Z" });
    }
    if (opts.paid) {
      events.push({ visit_id: VISIT_ID, booking_id: BID, event: "payment_succeeded", detail: { payment_intent: "pi_test_1", amount_cents: 14900 }, created_at: sentAt });
    }
    photos = [];
    stripeMeta = {
      gh_booking_id: BID,
      gh_state: issueOpen ? "issue_open" : "report_sent",
      gh_payment_method: "pm_test_1",
      gh_first_price_cents: "14900",
      gh_recurring_price_cents: "12900",
      gh_issue_open: issueOpen ? "1" : "0",
      gh_issue_reason: "Streaks on the floor",
      gh_report_sent_at: sentAt,
      gh_report_version: "1",
      gh_rp_source: "db",
    };
  };

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-" + "secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    resendCalls = [];
    piCreates = 0;
    piAmounts = [];
    refundCalls = 0;
    bt = signBooking("link-secret", { bid: BID, email: "client@example.com", name: "Casey Client" }).token;
    seed();
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("happy path: journal first, deadline exactly +48h, letter 2 verbatim, Resend id saved", async () => {
    const before = Date.now();
    const r = await callAction({ action: "issue_request_details", booking_id: BID, details_request: "Which room was sticky, and what exactly did you see?" });
    expect(r.code).toBe(200);
    expect(r.body["decision"]).toBe("details_requested");
    expect(r.body["email_sent"]).toBe(true);
    const deadlineMs = Date.parse(String(r.body["deadline_at"]));
    expect(Math.abs(deadlineMs - (before + 48 * 3600 * 1000))).toBeLessThan(120_000);
    const reqEv = events.find((e) => e.event === "issue_details_requested");
    expect(reqEv?.detail).toMatchObject({ request: "Which room was sticky, and what exactly did you see?", deadline_at: r.body["deadline_at"] });
    expect(rows[0]["details_requested_at"]).toBeTruthy();
    expect(rows[0]["details_deadline_at"]).toBe(r.body["deadline_at"]);
    expect(rows[0]["details_request_text"]).toBe("Which room was sticky, and what exactly did you see?");
    const letter2 = resendCalls.find((c) => c.to.includes("client@example.com"));
    expect(letter2?.subject).toBe("Please add a detail about your cleaning concern");
    expect(letter2?.text).toContain("Could you tell us what you noticed and where? One short sentence is enough. Photos are optional.");
    expect(letter2?.text).toContain("Your payment is on hold until");
    expect(letter2?.text).toContain("ET.");
    expect(letter2?.text).toContain("we’ll charge $149 to your saved card after that deadline.");
    expect(letter2?.text).toContain("Use Add Details or reply to this email.");
    expect(letter2?.text).toContain("If you’re having trouble opening your report, reply here and we’ll help.");
    expect(letter2?.text).toContain("#issue");
    const sentEv = events.find((e) => e.event === "details_request_email_sent");
    expect(sentEv?.detail).toMatchObject({ email_id: "email-1" });
    expect(rows[0]["details_email_id"]).toBe("email-1");
    // The issue stays open and nothing is charged.
    expect(rows[0]["issue_open"]).toBe(true);
    expect(piCreates).toBe(0);
  });

  it("a second request is a 409 and sends no second letter", async () => {
    const first = await callAction({ action: "issue_request_details", booking_id: BID, details_request: "Which room?" });
    expect(first.code).toBe(200);
    const callsAfterFirst = resendCalls.length;
    const second = await callAction({ action: "issue_request_details", booking_id: BID, details_request: "Anything else?" });
    expect(second.code).toBe(409);
    expect(second.body["error"]).toBe("details_already_requested");
    expect(resendCalls.length).toBe(callsAfterFirst);
    expect(events.filter((e) => e.event === "issue_details_requested")).toHaveLength(1);
  });

  it("an old-consent visit gets a 409, never letter 2", async () => {
    seed({ consent: false });
    const r = await callAction({ action: "issue_request_details", booking_id: BID, details_request: "Which room?" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("details_request_requires_new_consent");
    expect(resendCalls).toHaveLength(0);
    expect(events.some((e) => e.event === "issue_details_requested")).toBe(false);
  });

  it("no open issue is a 409 nothing_to_resolve", async () => {
    seed({ issueOpen: false, issueEver: false });
    const r = await callAction({ action: "issue_request_details", booking_id: BID, details_request: "Which room?" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("nothing_to_resolve");
  });

  it("damage never gets a details request", async () => {
    seed({ kind: "damage" });
    const r = await callAction({ action: "issue_request_details", booking_id: BID, details_request: "What broke?" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("details_not_available_for_damage");
  });

  it("an empty request text is a 400", async () => {
    const r = await callAction({ action: "issue_request_details", booking_id: BID, details_request: "   " });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("details_request_required");
  });

  it("Add Details in time: issue_details_provided, deadline cleared, pause kept, no charge", async () => {
    seed({ detailsRequested: true });
    const r = await callReport("POST", { action: "issue", reason: "Kitchen floor, near the sink.", rooms: ["Kitchen"], via_details_request: true });
    expect(r.code).toBe(200);
    expect(r.body["details_provided"]).toBe(true);
    expect(r.body["already"]).toBe(true);
    expect(r.body["followup_recorded"]).toBe(true);
    const provided = events.find((e) => e.event === "issue_details_provided");
    expect(provided).toBeDefined();
    expect(provided?.detail).toMatchObject({ via: "add_details_form" });
    expect(rows[0]["details_deadline_at"]).toBeNull();
    expect(rows[0]["issue_open"]).toBe(true);
    expect(rows[0]["issue_ever"]).toBe(true);
    expect(piCreates).toBe(0);
  });

  it("silence past the deadline never auto-charges: owner charge is refused with details_requested", async () => {
    // Issue resolved by the owner, details requested an hour ago with a
    // deadline already past, and only an OLD approval (voided by the
    // dispute) on record — the block must still bite.
    seed({ issueOpen: false, resolved: true, detailsRequested: true, detailsDeadlinePast: true, approvalAt: "2026-11-08T09:00:00.000Z" });
    const r = await callAction({ action: "charge", booking_id: BID, amount_cents: 14900 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("details_requested");
    expect(piCreates).toBe(0);
  });

  it("a fresh client Approve after the request outranks it and charges the pinned amount", async () => {
    seed({ detailsRequested: true });
    const r = await callReport("POST", { action: "approve", seen_publication_id: seedSentAt });
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("paid");
    expect(piCreates).toBe(1);
    expect(piAmounts).toEqual([14900]);
    expect(events.some((e) => e.event === "issue_resolved")).toBe(true);
    expect(events.some((e) => e.event === "report_approved")).toBe(true);
  });

  it("after a payment decision, the client Approve charges the pinned amount and closes the complaint", async () => {
    seed({ decision: { decision: "payment_requested", resolution: "The original amount stays due." } });
    const before = await callAction({ action: "issue_request_payment", booking_id: BID, resolution: "The original amount stays due." });
    expect(before.code).toBe(200);
    expect(piCreates).toBe(0);
    const r = await callReport("POST", { action: "approve", seen_publication_id: seedSentAt });
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("paid");
    expect(piAmounts).toEqual([14900]);
    expect(events.some((e) => e.event === "issue_resolved")).toBe(true);
  });

  it("a reduced amount without an offer is refused with price_review_required", async () => {
    seed({ issueOpen: false, resolved: true, approvalAt: "2026-11-09T12:00:00.000Z" });
    const r = await callAction({ action: "charge", booking_id: BID, amount_cents: 10000 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("price_review_required");
    expect(piCreates).toBe(0);
  });

  it("with an active offer, Approve charges the offer amount, not the pinned one", async () => {
    seed({ issueOpen: false, resolved: true, approvalAt: "2026-11-09T12:00:00.000Z", offer: 10000 });
    const r = await callReport("POST", { action: "approve", seen_publication_id: seedSentAt });
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("paid");
    expect(piCreates).toBe(1);
    expect(piAmounts).toEqual([10000]);
    expect(events.some((e) => e.event === "offer_accepted")).toBe(true);
  });

  it("offering a reduced amount journals payment_offered and emails the client an Approve button", async () => {
    const r = await callAction({ action: "issue_offer_reduced_amount", booking_id: BID, amount_cents: 10000, resolution: "The kitchen floor was missed; we close the visit at $100." });
    expect(r.code).toBe(200);
    expect(r.body["decision"]).toBe("offered");
    expect(r.body["offer_amount_cents"]).toBe(10000);
    const offered = events.find((e) => e.event === "payment_offered");
    expect(offered?.detail).toMatchObject({ offer_amount_cents: 10000, offer_status: "offered" });
    expect(rows[0]["offer_amount_cents"]).toBe(10000);
    expect(rows[0]["offer_status"]).toBe("offered");
    const mail = resendCalls.find((c) => c.to.includes("client@example.com"));
    expect(mail?.subject).toBe("A reduced amount for your cleaning");
    expect(mail?.text).toContain("$100");
  });

  it("an offer at or above the pinned amount is a 400", async () => {
    const r = await callAction({ action: "issue_offer_reduced_amount", booking_id: BID, amount_cents: 14900, resolution: "Same price." });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_offer_amount");
  });

  it("partial refund: paid only, idempotent per amount, visit stays paid", async () => {
    seed({ paid: true, issueOpen: true });
    const first = await callAction({ action: "issue_partial_refund", booking_id: BID, amount_cents: 5000, reason: "Kitchen floor was missed." });
    expect(first.code).toBe(200);
    expect(refundCalls).toBe(1);
    const refunded = events.find((e) => e.event === "partial_refund");
    expect(refunded?.detail).toMatchObject({ amount_cents: 5000, refund_id: "re_test_1" });
    expect(rows[0]["partial_refund_cents"]).toBe(5000);
    expect(rows[0]["status"]).toBe("paid");
    const again = await callAction({ action: "issue_partial_refund", booking_id: BID, amount_cents: 5000, reason: "Kitchen floor was missed." });
    expect(again.code).toBe(200);
    expect(again.body["already"]).toBe(true);
    expect(refundCalls).toBe(1);
  });

  it("partial refund on an unpaid visit is a 409", async () => {
    const r = await callAction({ action: "issue_partial_refund", booking_id: BID, amount_cents: 5000, reason: "Missed work." });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_not_paid");
    expect(refundCalls).toBe(0);
  });

  it("re-clean more than 72h after the complaint is a 409", async () => {
    const r = await callAction({ action: "issue_arrange_reclean", booking_id: BID, reclean_date: "2026-11-18", resolution: "We'll come back to re-clean the kitchen." });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("reclean_date_too_late");
  });
});
