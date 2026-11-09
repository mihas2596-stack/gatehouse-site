// @vitest-environment node
// N29: the bounce webhook must match more than the report email.
// Reminders (20h and early 4h), the cleaning receipt and the fee
// receipt each carry their own Resend id — a bounce of any of them is
// journaled instead of vanishing, and a bounced reminder stops
// counting as delivered.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import resendWebhookHandler from "../../api/resend-webhook";

const WHSEC = "whsec_" + Buffer.from("test-webhook-key-0123456789").toString("base64");

type Row = Record<string, unknown>;
let dbRows: Row[];
let dbEvents: Row[];

function res() {
  return {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(), end: vi.fn(),
  };
}

let svixSeq = 0;
function svixReq(raw: string) {
  // C14: the webhook dedupes on the Svix delivery id — every call in
  // this file needs its own id, or the second delivery is swallowed
  // as a duplicate before the handler runs.
  const id = `msg_test_${++svixSeq}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(WHSEC.slice(6), "base64");
  const sig = "v1," + createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  const gen = (async function* () { yield Buffer.from(raw, "utf8"); })();
  return Object.assign(gen, {
    method: "POST",
    headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": sig },
  });
}

function fieldVal(row: Row, field: string): unknown {
  const arrow = field.indexOf("->>");
  if (arrow > 0) {
    const detail = row[field.slice(0, arrow)] as Record<string, unknown> | null | undefined;
    return detail?.[field.slice(arrow + 3)];
  }
  return row[field];
}

function applyFilters(list: Row[], u: URL): Row[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    const dot = v.indexOf(".");
    if (dot <= 0) continue;
    const op = v.slice(0, dot);
    const val = decodeURIComponent(v.slice(dot + 1));
    if (op === "eq") out = out.filter((r) => String(fieldVal(r, k) ?? "") === val);
    if (op === "in") out = out.filter((r) => val.replace(/^\(|\)$/g, "").split(",").includes(String(fieldVal(r, k) ?? "")));
    if (op === "neq") out = out.filter((r) => String(fieldVal(r, k) ?? "") !== val);
  }
  const order = u.searchParams.get("order");
  if (order) {
    const [field, dir] = order.split(".");
    out.sort((a, b) => {
      const c = String(fieldVal(a, field) ?? "").localeCompare(String(fieldVal(b, field) ?? ""));
      return dir === "desc" ? -c : c;
    });
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

beforeEach(() => {
  vi.stubEnv("RESEND_WEBHOOK_SECRET", WHSEC);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  dbRows = [{
    id: "row-due", booking_id: "bid-due", status: "report_sent", report_status: "sent",
    report_email_id: null, receipt_email_id: "receipt-1", report_bounced: false,
  }];
  dbEvents = [
    { visit_id: "row-due", booking_id: "bid-due", event: "reminder_sent", detail: { email_id: "rem-1" }, created_at: "2026-11-08T10:00:00.000Z" },
    { visit_id: "row-due", booking_id: "bid-due", event: "early_reminder_sent", detail: { email_id: "early-1" }, created_at: "2026-11-08T08:00:00.000Z" },
    { visit_id: "row-due", booking_id: "bid-due", event: "cancellation_fee_receipt_sent", detail: { email_id: "fee-1", payment_intent: "pi_fee" }, created_at: "2026-11-08T09:00:00.000Z" },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown; method?: string }) => {
    const u = new URL(String(url));
    const sbRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      const method = (init?.method ?? "GET").toUpperCase();
      const list = table === "gh_visits" ? dbRows : table === "gh_events" ? dbEvents : [];
      if (method === "GET") return sbRes(applyFilters(list, u));
      if (method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const inserted = { ...body, created_at: new Date().toISOString() };
        list.push(inserted);
        return sbRes([inserted]);
      }
      if (method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const matched = applyFilters(list, u);
        for (const t of matched) Object.assign(t, body);
        return sbRes(matched);
      }
      return sbRes([]);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const bounce = (emailId: string) =>
  JSON.stringify({ type: "email.bounced", data: { email_id: emailId } });

describe("N29 non-report bounce matching", () => {
  it("journals a bounced 20h reminder as reminder_bounced", async () => {
    const r = res();
    await resendWebhookHandler(svixReq(bounce("rem-1")) as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["bounced"]).toBe(true);
    expect(r.body["kind"]).toBe("reminder");
    expect(dbEvents).toContainEqual(expect.objectContaining({ visit_id: "row-due", event: "reminder_bounced", detail: { email_id: "rem-1" } }));
  });

  it("journals a bounced early reminder separately", async () => {
    const r = res();
    await resendWebhookHandler(svixReq(bounce("early-1")) as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["kind"]).toBe("early_reminder");
    expect(dbEvents).toContainEqual(expect.objectContaining({ event: "early_reminder_bounced", detail: { email_id: "early-1" } }));
  });

  it("journals a bounced cleaning receipt", async () => {
    const r = res();
    await resendWebhookHandler(svixReq(bounce("receipt-1")) as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["kind"]).toBe("receipt");
    expect(dbEvents).toContainEqual(expect.objectContaining({ event: "receipt_bounced", detail: { email_id: "receipt-1" } }));
  });

  it("journals a bounced fee receipt", async () => {
    const r = res();
    await resendWebhookHandler(svixReq(bounce("fee-1")) as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["kind"]).toBe("fee_receipt");
    expect(dbEvents).toContainEqual(expect.objectContaining({ event: "cancellation_fee_receipt_bounced", detail: { email_id: "fee-1" } }));
  });

  it("a redelivered reminder bounce logs once", async () => {
    const r1 = res();
    await resendWebhookHandler(svixReq(bounce("rem-1")) as never, r1 as never);
    expect(r1.body["already"]).toBeUndefined();
    const r2 = res();
    await resendWebhookHandler(svixReq(bounce("rem-1")) as never, r2 as never);
    expect(r2.body["already"]).toBe(true);
    expect(dbEvents.filter((e) => e.event === "reminder_bounced")).toHaveLength(1);
  });

  it("an unknown id with no report tags is ignored, not retried", async () => {
    const r = res();
    await resendWebhookHandler(svixReq(bounce("no-such-email")) as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["ignored"]).toBe(true);
    expect(dbEvents).toHaveLength(3);
  });
});
