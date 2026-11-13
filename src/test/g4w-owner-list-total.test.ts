// @vitest-environment node
// G4 L5: the owner list returns an explicit total + page size, so the
// panel can show "Showing N of M" and no visit is silently hidden
// past the page. When the count itself is unreadable the list still
// loads with total null — a failed count never fails the list.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/owner";

const VISIT_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const BID = "bid-g4w-owner-total";
const ADMIN = "test-admin-token-123";

type Row = Record<string, unknown>;
type Ev = { visit_id: string; event: string; detail: Record<string, unknown> | null; created_at: string };

let rows: Row[];
let events: Ev[];
let countMode: "ok" | "unreadable";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

function makeRow(overrides: Row = {}): Row {
  return {
    id: VISIT_ID, booking_id: BID, status: "report_sent", amount_cents: 20000,
    client_email: "client@example.com", report_sent_at: hoursAgo(30),
    report_bounced: false, report_status: "sent", issue_open: false, issue_ever: false,
    cleaner_name: null, cleaner_link_issuance: "newiss", cleaner_token_hash: "hash",
    cleaner_token_expires: new Date(Date.now() + 86400000).toISOString(),
    cleaner_link_version: "v2", visit_date: "2026-11-10", window: "midday",
    service: "Standard", client_name: "Casey Client", address: "1 Test Way",
    checklist: null, created_at: hoursAgo(50),
    ...overrides,
  };
}

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

beforeEach(() => {
  vi.stubEnv("ADMIN_TOKEN", ADMIN);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [makeRow()];
  events = [];
  countMode = "ok";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(String(url));
    const okRes = (data: unknown, headers?: Record<string, string>) => ({
      ok: true, status: 200,
      json: async () => data, text: async () => JSON.stringify(data),
      headers: { get: (name: string) => (headers?.[name.toLowerCase()] ?? null) },
    });
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      // The count probe: select=id&limit=0 with Prefer count=exact.
      if (u.searchParams.get("select") === "id" && u.searchParams.get("limit") === "0") {
        if (countMode === "unreadable") return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
        return okRes([], { "content-range": "*/250" });
      }
      const qId = u.searchParams.get("id");
      if (qId && qId.startsWith("eq.")) {
        return okRes(rows.filter((r) => r["id"] === decodeURIComponent(qId.slice(3))));
      }
      return okRes(rows);
    }
    if (u.pathname.includes("/rest/v1/gh_photos")) return okRes([]);
    if (u.pathname.includes("/rest/v1/gh_events")) {
      const qVisit = u.searchParams.get("visit_id");
      const qEv = u.searchParams.get("event");
      let out = [...events];
      if (qVisit && qVisit.startsWith("eq.")) out = out.filter((e) => e.visit_id === decodeURIComponent(qVisit.slice(3)));
      if (qVisit && qVisit.startsWith("in.(")) {
        const ids = qVisit.slice(4, -1).split(",");
        out = out.filter((e) => ids.includes(e.visit_id));
      }
      if (qEv && qEv.startsWith("eq.")) out = out.filter((e) => e.event === decodeURIComponent(qEv.slice(3)));
      out = out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return okRes(out);
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const list = async () => {
  const r = res();
  await handler(
    { method: "GET", headers: { authorization: "Bearer " + ADMIN }, query: { view: "list" } },
    r as never,
  );
  return r;
};

describe("L5 owner list total", () => {
  it("the list carries the total and the page size", async () => {
    const r = await list();
    expect(r.code).toBe(200);
    expect(r.body["total"]).toBe(250);
    expect(r.body["page_size"]).toBe(100);
    expect(r.body["next_offset"]).toBeNull();
    expect((r.body["visits"] as Row[])).toHaveLength(1);
  });

  it("an unreadable count degrades to total null — the list still loads", async () => {
    countMode = "unreadable";
    const r = await list();
    expect(r.code).toBe(200);
    expect(r.body["total"]).toBeNull();
    expect(r.body["page_size"]).toBe(100);
    expect((r.body["visits"] as Row[])).toHaveLength(1);
  });
});
