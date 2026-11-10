// @vitest-environment node
// TASK 1 (fix6): the owner's issue decisions via /api/booking-action and
// the client's view via /api/report.
//   - Request payment notifies the client and never charges the card.
//   - Same decision + same text twice = one email, one journal event.
//   - Re-notify is throttled to once per 24h per decision.
//   - Arrange re-clean keeps the issue open and the timer blocked.
//   - Waive closes the visit without payment; a later charge is refused
//     (409 charge_waived) and a later client Approve is refused too.
//   - The "Issue received" email uses the spec subject and text.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";
import reportHandler from "../../api/report";
import { signBooking } from "../../api/create-checkout-session";

const BID = "bid-issue-actions";
const VISIT_ID = "77777777-4444-5555-6666-777777777777";
const SENT_AT = "2026-11-08T10:00:00.000Z";

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

describe("issue decision actions", () => {
  let rows: Row[];
  let events: Ev[];
  let photos: Row[];
  let stripeMeta: Record<string, string>;
  let resendCalls: { to: string[]; subject: string; text: string }[];
  let piCreates: number;
  let bt: string;

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
        if (u.includes("/payment_intents") && method === "POST") {
          piCreates++;
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

  const seed = (opts?: { issueOpen?: boolean; decision?: { decision: string; resolution: string } | null }) => {
    const issueOpen = opts?.issueOpen ?? true;
    rows = [{
      id: VISIT_ID,
      booking_id: BID,
      visit_no: 1,
      status: "report_sent",
      report_status: "sent",
      visit_date: "2026-11-22",
      window: "morning",
      service: "Standard cleaning",
      client_name: "Casey Client",
      client_email: "client@example.com",
      amount_cents: 14900,
      cleaner_name: null,
      cleaner_id: null,
      issue_open: issueOpen,
      issue_ever: true,
      report_sent_at: SENT_AT,
      report_bounced: false,
      report_email_id: null,
      checklist: { rooms: [] },
    }];
    events = [
      { visit_id: VISIT_ID, booking_id: BID, event: "report_sent", detail: { email_sent: true, version: 1 }, created_at: SENT_AT },
      { visit_id: VISIT_ID, booking_id: BID, event: "issue_opened", detail: { reason: "Streaks on the floor", room: "Kitchen" }, created_at: "2026-11-08T11:00:00.000Z" },
    ];
    if (opts?.decision) {
      events.push({ visit_id: VISIT_ID, booking_id: BID, event: "issue_decision", detail: { decision: opts.decision.decision, resolution: opts.decision.resolution, decided_at: "2026-11-09T10:00:00.000Z" }, created_at: "2026-11-09T10:00:00.000Z" });
    }
    photos = [];
    stripeMeta = {
      gh_booking_id: BID,
      gh_state: "issue_open",
      gh_payment_method: "pm_test_1",
      gh_first_price_cents: "14900",
      gh_recurring_price_cents: "12900",
      gh_issue_open: "1",
      gh_issue_reason: "Streaks on the floor",
      gh_report_sent_at: SENT_AT,
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
    bt = signBooking("link-secret", { bid: BID, email: "client@example.com", name: "Casey Client" }).token;
    seed();
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("request payment notifies the client, keeps the issue open, and never charges", async () => {
    const r = await callAction({ action: "issue_request_payment", booking_id: BID, resolution: "The original amount stays due — the kitchen was cleaned twice." });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["decision"]).toBe("payment_requested");
    expect(r.body["email_sent"]).toBe(true);
    expect(piCreates).toBe(0);
    expect(rows[0]["issue_open"]).toBe(true);
    expect(rows[0]["status"]).toBe("report_sent");
    const decision = events.find((e) => e.event === "issue_decision");
    expect(decision).toBeDefined();
    expect(decision?.["detail"]).toMatchObject({ decision: "payment_requested" });
    const clientMail = resendCalls.find((c) => c.to.includes("client@example.com"));
    expect(clientMail?.subject).toBe("Update on your cleaning concern");
    expect(clientMail?.text).toContain("Our response: The original amount stays due");
    expect(clientMail?.text).toContain("Amount due: $149");
    expect(clientMail?.text).toContain("/report?bt=");
  });

  it("repeating the same decision sends no second email and logs no second event", async () => {
    const first = await callAction({ action: "issue_request_payment", booking_id: BID, resolution: "Pay the original amount, please." });
    expect(first.code).toBe(200);
    const callsAfterFirst = resendCalls.length;
    const decisionsAfterFirst = events.filter((e) => e.event === "issue_decision").length;
    const second = await callAction({ action: "issue_request_payment", booking_id: BID, resolution: "Pay the original amount, please." });
    expect(second.code).toBe(200);
    expect(second.body["already"]).toBe(true);
    expect(resendCalls.length).toBe(callsAfterFirst);
    expect(events.filter((e) => e.event === "issue_decision").length).toBe(decisionsAfterFirst);
    expect(piCreates).toBe(0);
  });

  it("a different resolution is a new decision with a new email", async () => {
    await callAction({ action: "issue_request_payment", booking_id: BID, resolution: "First version." });
    const r = await callAction({ action: "issue_request_payment", booking_id: BID, resolution: "Second version." });
    expect(r.code).toBe(200);
    expect(r.body["already"]).toBeUndefined();
    expect(events.filter((e) => e.event === "issue_decision").length).toBe(2);
  });

  it("request payment without a resolution is refused", async () => {
    const r = await callAction({ action: "issue_request_payment", booking_id: BID });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("resolution_required");
    expect(events.some((e) => e.event === "issue_decision")).toBe(false);
  });

  it("a decision with no open issue is refused", async () => {
    seed({ issueOpen: false });
    // The journal is the authority: a resolved issue (issue_opened
    // followed by issue_resolved) is closed even though the row flag
    // alone would also say so.
    events.push({ visit_id: VISIT_ID, booking_id: BID, event: "issue_resolved", detail: { via: "owner_resolve" }, created_at: "2026-11-08T12:00:00.000Z" });
    const r = await callAction({ action: "issue_request_payment", booking_id: BID, resolution: "Pay us." });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("nothing_to_resolve");
  });

  it("re-notify re-sends once, then refuses a second send within 24h", async () => {
    seed({ decision: { decision: "payment_requested", resolution: "Pay the original amount, please." } });
    const first = await callAction({ action: "issue_renotify", booking_id: BID });
    expect(first.code).toBe(200);
    expect(first.body["email_sent"]).toBe(true);
    const callsAfterFirst = resendCalls.length;
    const second = await callAction({ action: "issue_renotify", booking_id: BID });
    expect(second.code).toBe(200);
    expect(second.body["already"]).toBe(true);
    expect(resendCalls.length).toBe(callsAfterFirst);
    expect(piCreates).toBe(0);
  });

  it("re-notify without a decision is refused", async () => {
    const r = await callAction({ action: "issue_renotify", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("nothing_to_renotify");
  });

  it("arrange re-clean keeps the issue open and the timer blocked", async () => {
    const r = await callAction({ action: "issue_arrange_reclean", booking_id: BID, resolution: "We'll come back Tuesday to re-clean the kitchen." });
    expect(r.code).toBe(200);
    expect(r.body["decision"]).toBe("reclean");
    expect(rows[0]["issue_open"]).toBe(true);
    expect(rows[0]["issue_ever"]).toBe(true);
    expect(piCreates).toBe(0);
    const clientMail = resendCalls.find((c) => c.to.includes("client@example.com"));
    expect(clientMail?.subject).toBe("Update on your cleaning concern");
    expect(clientMail?.text).toContain("We'll send you an updated report after the re-clean.");
  });

  it("waive closes the visit without payment; a later charge and a later Approve are refused", async () => {
    const r = await callAction({ action: "issue_waive_charge", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["decision"]).toBe("waived");
    expect(r.body["email_sent"]).toBe(true);
    expect(rows[0]["issue_open"]).toBe(false);
    expect(rows[0]["issue_ever"]).toBe(true);
    expect(rows[0]["status"]).toBe("report_sent");
    const resolved = events.find((e) => e.event === "issue_resolved");
    expect(resolved?.["detail"]).toMatchObject({ via: "owner_waive_charge" });
    expect(piCreates).toBe(0);

    // The owner charge path refuses a waived visit.
    const charge = await callAction({ action: "charge", booking_id: BID, amount_cents: 14900 });
    expect(charge.code).toBe(409);
    expect(charge.body["error"]).toBe("charge_waived");
    expect(piCreates).toBe(0);

    // The client Approve path refuses it too, and the view is "waived".
    const view = await callReport("GET", {});
    expect(view.code).toBe(200);
    expect(view.body["state"]).toBe("waived");
    const approve = await callReport("POST", { action: "approve", seen_publication_id: SENT_AT });
    expect(approve.code).toBe(409);
    expect(approve.body["error"]).toBe("charge_waived");
    expect(piCreates).toBe(0);
  });

  it("repeating a waive on an already-waived visit is a no-op", async () => {
    await callAction({ action: "issue_waive_charge", booking_id: BID });
    const callsAfterFirst = resendCalls.length;
    const r = await callAction({ action: "issue_waive_charge", booking_id: BID });
    expect(r.code).toBe(200);
    expect(r.body["already"]).toBe(true);
    expect(resendCalls.length).toBe(callsAfterFirst);
    expect(piCreates).toBe(0);
  });

  it("report view shows the latest decision for an open issue", async () => {
    seed({ decision: { decision: "payment_requested", resolution: "The original amount stays due." } });
    const view = await callReport("GET", {});
    expect(view.code).toBe(200);
    expect(view.body["state"]).toBe("issue_open");
    expect(view.body["issue_decision"]).toMatchObject({
      decision: "payment_requested",
      resolution: "The original amount stays due.",
    });
  });

  it("the Issue received email uses the spec subject and text", async () => {
    // Fresh report, no issue yet: the client reports within 24h.
    rows[0]["report_sent_at"] = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    events = [
      { visit_id: VISIT_ID, booking_id: BID, event: "report_sent", detail: { email_sent: true, version: 1 }, created_at: String(rows[0]["report_sent_at"]) },
    ];
    rows[0]["issue_open"] = false;
    rows[0]["issue_ever"] = false;
    const r = await callReport("POST", { action: "issue", reason: "Streaks on the floor", room: "Kitchen" });
    expect(r.code).toBe(200);
    expect(rows[0]["issue_open"]).toBe(true);
    expect(rows[0]["issue_ever"]).toBe(true);
    const clientMail = resendCalls.find((c) => c.to.includes("client@example.com"));
    expect(clientMail?.subject).toBe("We received your cleaning concern");
    expect(clientMail?.text).toContain("We've received your message and paused payment for this visit.");
    expect(clientMail?.text).toContain("We aim to provide a decision within 72 hours.");
    expect(clientMail?.text).toContain("Your card won't be charged unless you approve the report.");
  });
});
