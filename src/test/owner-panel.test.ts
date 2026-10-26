// @vitest-environment node
// O3/O4/O5 (owner panel, server side):
// - payment_failed is current only until a later success or payment;
// - can_charge follows the same payment-basis rule the charge action
//   enforces, so the panel never offers a retry the server refuses;
// - cleaner_link_opened_at binds to the row's current link issuance,
//   not to the whole visit history.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/owner";

const VISIT_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const BID = "bid-owner-panel";

type Row = Record<string, unknown>;
type Ev = { visit_id: string; event: string; detail: Record<string, unknown> | null; created_at: string };

let rows: Row[];
let events: Ev[];

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const ev = (event: string, detail: Record<string, unknown> | null, created_at: string, visitId: string = VISIT_ID): Ev =>
  ({ visit_id: visitId, event, detail, created_at });

function makeRow(overrides: Row = {}): Row {
  return {
    id: VISIT_ID, booking_id: BID, status: "report_sent", amount_cents: 20000,
    client_email: "client@example.com", report_sent_at: hoursAgo(30),
    report_bounced: false, report_status: "sent", issue_open: false, issue_ever: false,
    cleaner_name: null, cleaner_link_issuance: "newiss", cleaner_token_hash: "hash",
    cleaner_token_expires: new Date(Date.now() + 86400000).toISOString(),
    cleaner_link_version: "v2", visit_date: "2027-01-15", window: "midday",
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
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [makeRow()];
  events = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(String(url));
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.pathname.includes("/storage/v1/object/sign/")) return okRes({ signedURL: "https://test.supabase.co/signed/x.jpg" });
    if (u.pathname.includes("/rest/v1/gh_visits")) {
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
      if (qVisit && qVisit.startsWith("eq.")) {
        out = out.filter((e) => e.visit_id === decodeURIComponent(qVisit.slice(3)));
      }
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

const detail = async () => {
  const r = res();
  await handler(
    { method: "GET", headers: { authorization: "Bearer adm-secret" }, query: { view: "detail", visit_id: VISIT_ID } },
    r as never,
  );
  return r;
};
const list = async () => {
  const r = res();
  await handler(
    { method: "GET", headers: { authorization: "Bearer adm-secret" }, query: { view: "list" } },
    r as never,
  );
  return r;
};

describe("O3: payment_failed is current, not historical", () => {
  it("a lone failure lights up", async () => {
    events = [ev("payment_failed", {}, hoursAgo(1))];
    const r = await detail();
    expect((r.body["visit"] as Row)["payment_failed"]).toBe(true);
  });
  it("a later success clears it", async () => {
    events = [ev("payment_failed", {}, hoursAgo(2)), ev("payment_succeeded", {}, hoursAgo(1))];
    const r = await detail();
    expect((r.body["visit"] as Row)["payment_failed"]).toBe(false);
  });
  it("a paid row clears it", async () => {
    rows = [makeRow({ status: "paid" })];
    events = [ev("payment_failed", {}, hoursAgo(1))];
    const r = await detail();
    expect((r.body["visit"] as Row)["payment_failed"]).toBe(false);
  });
  it("list: failed-then-succeeded is clear, failed-only is not", async () => {
    const v2id = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
    rows = [rows[0], makeRow({ id: v2id, booking_id: "bid-other" })];
    events = [
      ev("payment_failed", {}, hoursAgo(2)),
      ev("payment_succeeded", {}, hoursAgo(1)),
      ev("payment_failed", {}, hoursAgo(1), v2id),
    ];
    const r = await list();
    const visits = r.body["visits"] as Row[];
    expect(visits).toHaveLength(2);
    const byId = new Map(visits.map((v) => [v["id"], v]));
    expect(byId.get(VISIT_ID)?.["payment_failed"]).toBe(false);
    expect(byId.get(v2id)?.["payment_failed"]).toBe(true);
  });
});

describe("O5: opened binds to the current issuance", () => {
  it("an old-issuance open does not count for a new link", async () => {
    events = [ev("cleaner_link_opened", { issuance: "oldiss" }, hoursAgo(1))];
    const r = await detail();
    expect((r.body["visit"] as Row)["cleaner_link_opened_at"]).toBeNull();
  });
  it("a current-issuance open counts", async () => {
    const t = hoursAgo(1);
    events = [
      ev("cleaner_link_opened", { issuance: "oldiss" }, hoursAgo(3)),
      ev("cleaner_link_opened", { issuance: "newiss" }, t),
    ];
    const r = await detail();
    expect((r.body["visit"] as Row)["cleaner_link_opened_at"]).toBe(t);
  });
});

describe("O4: can_charge follows the payment basis", () => {
  it("client approval is a basis", async () => {
    rows = [makeRow({ report_sent_at: hoursAgo(5) })];
    events = [ev("report_approved", {}, hoursAgo(1))];
    const r = await detail();
    expect((r.body["visit"] as Row)["can_charge"]).toBe(true);
  });
  it("no basis under 24h without approval", async () => {
    rows = [makeRow({ report_sent_at: hoursAgo(5) })];
    events = [];
    const r = await detail();
    expect((r.body["visit"] as Row)["can_charge"]).toBe(false);
  });
  it("timer rule after 24h with no issue is a basis", async () => {
    events = [];
    const r = await detail();
    expect((r.body["visit"] as Row)["can_charge"]).toBe(true);
  });
});
