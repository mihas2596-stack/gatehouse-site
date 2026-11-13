// @vitest-environment node
// M10: the receipt-retry pass fetched an arbitrary 50 paid visits
// (status=eq.paid, no order, no receipt filter), so a visit missing
// its receipt could starve forever behind already-receipted ones.
// Now the DB filters to visits actually missing a receipt (no id, or
// a stale "claim:" placeholder) and orders oldest-paid first.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import autoChargeHandler from "../../api/auto-charge";

const CRON = ["cron", "secret"].join("-");

type Row = Record<string, unknown>;

let rows: Row[];
let resendTo: string[];
let receiptQueries: string[];

function res() {
  return {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(), end: vi.fn(),
  };
}

function paidRow(i: number, paidAt: string, receipt: string | null): Row {
  return {
    id: `row-m10-${i}`, booking_id: `bid-m10-${i}`, visit_no: 1,
    client_email: `client-${i}@example.com`, client_name: "Casey Client",
    amount_cents: 18900, status: "paid", paid_at: paidAt,
    receipt_email_id: receipt, report_status: "paid", visit_date: "2026-10-01",
  };
}

function matchCond(row: Row, field: string, op: string, val: string): boolean {
  const v = row[field];
  const dec = decodeURIComponent(val);
  if (op === "eq") return String(v ?? "") === dec;
  if (op === "neq") return v !== null && v !== undefined && String(v) !== dec;
  if (op === "is") return dec === "null" ? v === null || v === undefined : v !== null && v !== undefined;
  if (op === "lt") return String(v ?? "") < dec;
  if (op === "lte") return String(v ?? "") <= dec;
  if (op === "gt") return String(v ?? "") > dec;
  if (op === "gte") return String(v ?? "") >= dec;
  if (op === "like") {
    const re = new RegExp(`^${dec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`);
    return re.test(String(v ?? ""));
  }
  if (op === "in") return dec.replace(/^\(|\)$/g, "").split(",").includes(String(v ?? ""));
  return false;
}

function applyFilters(list: Row[], u: URL): Row[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select" || k === "offset") continue;
    if (k === "or") {
      const inner = v.replace(/^\(|\)$/g, "");
      out = out.filter((r) => inner.split(",").some((c) => {
        const d1 = c.indexOf(".");
        const rest = c.slice(d1 + 1);
        const d2 = rest.indexOf(".");
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
    out.sort((a, b) => {
      const cmp = String(a[field] ?? "").localeCompare(String(b[field] ?? ""));
      return dir === "desc" ? -cmp : cmp;
    });
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", ["adm", "secret"].join("-"));
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [];
  resendTo = [];
  receiptQueries = [];
  let resendSeq = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown; method?: string; headers?: Record<string, string> }) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      resendTo.push(String((body.to as string[] | undefined)?.[0] ?? ""));
      resendSeq += 1;
      return okRes({ id: `email_m10_${resendSeq}` });
    }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        const query = u.searchParams.get("query") ?? "";
        const emailM = /email:'([^']+)'/.exec(query);
        if (emailM) {
          const i = rows.findIndex((r) => r["client_email"] === emailM[1]);
          if (i < 0) return okRes({ data: [] });
          return okRes({ data: [{ id: `cus_m10_${i}`, email: emailM[1], name: "Casey Client", metadata: {} }] });
        }
        return okRes({ data: [] });
      }
      const custM = u.pathname.match(/^\/v1\/customers\/(cus_m10_(\d+))$/);
      if (custM) {
        const found = rows[parseInt(custM[2], 10)];
        if (!found) return { ok: false, status: 404, json: async () => ({}) };
        return okRes({ id: custM[1], email: String(found["client_email"]), name: "Casey Client", metadata: {} });
      }
      return okRes({ data: [] });
    }
    if (u.hostname.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      if (table === "gh_visits") {
        if (method === "GET") {
          if (u.searchParams.get("status") === "eq.paid") receiptQueries.push(u.search);
          return okRes(applyFilters(rows, u));
        }
        if (method === "PATCH") {
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
          const matched = applyFilters(rows, u);
          for (const t of matched) Object.assign(t, body);
          const prefer = (init?.headers ?? {})["Prefer"] ?? (init?.headers ?? {})["prefer"] ?? "";
          return okRes(String(prefer).includes("return=representation") ? matched : {});
        }
        return okRes([]);
      }
      if (table === "gh_events") {
        if (method === "POST") return okRes([{ id: 1 }]);
        return okRes([]);
      }
      if (table === "gh_visit_access") return okRes([]);
      return okRes([]);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const run = async () => {
  const r = res();
  await (autoChargeHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { method: "GET", headers: { authorization: `Bearer ${CRON}` } }, r as never,
  );
  return r;
};

describe("M10 receipt-retry pass filters + orders", () => {
  it("sends only to visits missing a receipt — older already-receipted rows do not starve them", async () => {
    // The already-receipted rows are OLDER than the missing ones: the
    // old arbitrary-50 fetch would have served them first and the
    // missing receipts would never be reached.
    rows = [
      paidRow(0, "2026-09-28T10:00:00.000Z", "email_old_0"),
      paidRow(1, "2026-09-29T10:00:00.000Z", "email_old_1"),
      paidRow(2, "2026-10-01T10:00:00.000Z", null),
      paidRow(3, "2026-10-02T10:00:00.000Z", null),
      paidRow(4, "2026-10-03T10:00:00.000Z", null),
      // Stale claim (>5 min old): the send never landed, so it retries.
      paidRow(5, "2026-10-04T10:00:00.000Z", `claim:${Date.now() - 10 * 60 * 1000}`),
    ];
    const r = await run();
    expect(r.code).toBe(200);
    expect(r.body["receipts"]).toBe(4);
    expect(resendTo.sort()).toEqual([
      "client-2@example.com",
      "client-3@example.com",
      "client-4@example.com",
      "client-5@example.com",
    ]);
    // The query itself carries the filter + oldest-first order.
    expect(receiptQueries).toHaveLength(1);
    expect(receiptQueries[0]).toContain("receipt_email_id.is.null");
    expect(receiptQueries[0]).toContain("order=paid_at.asc");
  });

  it("55 missing receipts: oldest 50 are served, the 5 newest wait for the next run", async () => {
    rows = Array.from({ length: 55 }, (_, i) =>
      paidRow(i, new Date(Date.UTC(2026, 9, 1 + i)).toISOString(), null),
    );
    const r = await run();
    expect(r.code).toBe(200);
    expect(r.body["receipts"]).toBe(50);
    expect(resendTo).toHaveLength(50);
    // Oldest-first: bids 0..49 got receipts, the 5 newest did not.
    expect(resendTo).toContain("client-0@example.com");
    expect(resendTo).toContain("client-49@example.com");
    expect(resendTo).not.toContain("client-50@example.com");
    expect(resendTo).not.toContain("client-54@example.com");
  });
});
