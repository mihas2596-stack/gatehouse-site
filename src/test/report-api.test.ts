// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import adminHandler from "../../api/booking-action";
import reportHandler from "../../api/report";
import { signBooking } from "../../api/create-checkout-session";

// The photo-report portal round trip:
//   operator send_report (booking-action, ADMIN_TOKEN)
//     → photo URLs chunked into Stripe metadata + report email with link
//   client GET /api/report?bt= → photos + 24h deadline
//   client POST approve / issue → state machine moves, charge gates hold.

const BID = "bid-report-1";
const CUSTOMER = {
  id: "cus_report_1",
  email: "client@example.com",
  name: "Casey Client",
  metadata: {
    gh_booking_id: BID,
    gh_state: "card_ready",
    gh_payment_method: "pm_test_1",
    gh_first_price_cents: "18900",
  },
};

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

let currentMeta: Record<string, string>;
let resendCalls: unknown[];
let piCalls: Array<{ body: URLSearchParams; idem: string | undefined }>;
let bt: string;

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  currentMeta = { ...CUSTOMER.metadata };
  resendCalls = [];
  piCalls = [];
  bt = signBooking("link-secret", {
    bid: BID, email: CUSTOMER.email, name: CUSTOMER.name,
  }).token;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.includes("/customers/search")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: CUSTOMER.id, metadata: currentMeta }] }) };
    }
    if (u.includes("/payment_intents/search")) {
      // Stripe search returns { data: [...] } — an empty list here
      // means no prior intent for this booking, not a succeeded one.
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (u.includes("/payment_intents")) {
      piCalls.push({ body: new URLSearchParams(String(init?.body)), idem: undefined });
      return { ok: true, status: 200, json: async () => ({ id: "pi_test_1", status: "succeeded" }) };
    }
    if (u.includes("/payment_methods")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "pm_test_1" }] }) };
    }
    if (u.includes("api.resend.com")) {
      resendCalls.push(init?.body);
      return { ok: true, status: 200, json: async () => ({ id: "email-1" }) };
    }
    if (u.endsWith(`/customers/${CUSTOMER.id}`) && init?.body) {
      const params = new URLSearchParams(String(init.body));
      for (const [k, v] of params.entries()) {
        const m = /^metadata\[(.+)\]$/.exec(k);
        if (m) currentMeta[m[1]] = v;
      }
      return { ok: true, status: 200, json: async () => ({ id: CUSTOMER.id }) };
    }
    if (u.endsWith(`/customers/${CUSTOMER.id}`)) {
      return { ok: true, status: 200, json: async () => ({ ...CUSTOMER, metadata: currentMeta }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const ADMIN = ["adm", "secret"].join("-");
const adminReq = (body: Record<string, unknown>) => ({
  method: "POST",
  headers: { authorization: `Bearer ${ADMIN}` },
  body,
});
const getReq = (token: string) => ({ method: "GET", headers: {}, query: { bt: token } });
const postReq = (body: Record<string, unknown>) => ({ method: "POST", headers: {}, body });

const PHOTOS = [
  "https://cdn.example.com/report/kitchen.jpg",
  "https://cdn.example.com/report/bath.jpg",
  "https://cdn.example.com/report/living.jpg",
];

async function sendReport(photos: string[] = PHOTOS) {
  const res = response();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await adminHandler(adminReq({ action: "send_report", booking_id: BID, photos }) as any, res as any);
  return res;
}

describe("report portal", () => {
  it("rejects a garbage token and reports not_ready before any report", async () => {
    const bad = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq("v2.garbage") as any, bad as any);
    expect(bad.body["state"]).toBe("invalid_link");

    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, res as any);
    expect(res.code).toBe(200);
    expect(res.body["state"]).toBe("not_ready");
    expect(res.body["photos"]).toEqual([]);
    const booking = res.body["booking"] as Record<string, string>;
    expect(booking.first).toBe("$189");
  });

  it("blocks client approve/issue before the report is sent", async () => {
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve" }) as any, res as any);
    expect(res.code).toBe(409);
    expect(res.body["error"]).toBe("report_not_sent");
  });

  it("send_report stores photos, starts the clock and emails the portal link", async () => {
    const res = await sendReport();
    expect(res.code).toBe(200);
    expect(res.body["state"]).toBe("report_sent");
    expect(res.body["report_version"]).toBe(1);
    expect(res.body["email_sent"]).toBe(true);
    expect(currentMeta["gh_state"]).toBe("report_sent");
    expect(currentMeta["gh_report_sent_at"]).toBeTruthy();
    expect(resendCalls).toHaveLength(1);
    const email = JSON.parse(String(resendCalls[0])) as { subject: string; text: string; to: string[] };
    expect(email.to).toEqual(["client@example.com"]);
    expect(email.subject).toContain("report is ready");
    expect(email.text).toContain("/visit?bt=v2.");
    expect(email.text).toContain("#report");
    expect(email.text).toContain("$189");

    const view = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, view as any);
    expect(view.body["state"]).toBe("awaiting");
    expect(view.body["photos"]).toEqual(PHOTOS);
    const sentMs = Date.parse(String(view.body["report_sent_at"]));
    const deadlineMs = Date.parse(String(view.body["deadline"]));
    expect(Math.abs(deadlineMs - (sentMs + 24 * 3600 * 1000))).toBeLessThan(2000);
  });

  it("send_report is a no-op for the same photos within 10 minutes, a new version after", async () => {
    await sendReport();
    const again = await sendReport();
    expect(again.body["already_sent"]).toBe(true);
    expect(resendCalls).toHaveLength(1);
    expect(currentMeta["gh_report_version"]).toBe("1");
    const updated = await sendReport(["https://cdn.example.com/report/new.jpg"]);
    expect(updated.body["report_version"]).toBe(2);
    expect(resendCalls).toHaveLength(2);
  });

  it("rejects non-https photos", async () => {
    const res = await sendReport(["http://insecure.example.com/x.jpg"]);
    expect(res.code).toBe(400);
    expect(res.body["error"]).toBe("invalid_photo_url");
    expect(currentMeta["gh_state"]).toBe("card_ready");
  });

  it("client issue pauses the charge; approve from issue_open clears it; both idempotent", async () => {
    await sendReport();
    const issue = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "issue", reason: "Missed the oven" }) as any, issue as any);
    expect(issue.code).toBe(200);
    expect(issue.body["state"]).toBe("issue_open");
    expect(currentMeta["gh_issue_open"]).toBe("1");
    expect(currentMeta["gh_issue_reason"]).toBe("Missed the oven");

    const issueAgain = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "issue", reason: "other" }) as any, issueAgain as any);
    expect(issueAgain.body["already"]).toBe(true);
    expect(currentMeta["gh_issue_reason"]).toBe("Missed the oven");

    // Terms 5.2: approving charges the pinned amount immediately.
    const approve = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve" }) as any, approve as any);
    expect(approve.body["state"]).toBe("paid");
    expect(currentMeta["gh_state"]).toBe("paid");
    expect(currentMeta["gh_issue_open"]).toBe("");
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].body.get("amount")).toBe("18900");

    const approveAgain = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve" }) as any, approveAgain as any);
    expect(approveAgain.code).toBe(409);
    expect(approveAgain.body["error"]).toBe("already_paid");
    expect(piCalls).toHaveLength(1);
  });

  it("operator approve is closed: it is not client payment approval (G3)", async () => {
    await sendReport();
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "approve", booking_id: BID }) as any, res as any);
    expect(res.code).toBe(409);
    expect(res.body["error"]).toBe("operator_approve_disabled");
  });

  it("a paid visit records a post-payment issue (no auto-reversal) and still refuses new reports", async () => {
    await sendReport();
    currentMeta["gh_state"] = "paid";
    const issue = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "issue", reason: "found a streak", room: "Kitchen" }) as any, issue as any);
    expect(issue.code).toBe(200);
    expect(issue.body["postpay"]).toBe(true);
    expect(currentMeta["gh_postpay_issue"]).toBe("1");
    expect(currentMeta["gh_state"]).toBe("paid"); // payment state untouched
    expect(currentMeta["gh_issue_open"]).not.toBe("1"); // nothing "paused" — already paid
    const again = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "issue", reason: "second" }) as any, again as any);
    expect(again.body["already"]).toBe(true);
    const approveLate = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve" }) as any, approveLate as any);
    expect(approveLate.code).toBe(409);
    const resend = await sendReport();
    expect(resend.code).toBe(409);
    expect(resend.body["error"]).toBe("already_paid");
  });
});
