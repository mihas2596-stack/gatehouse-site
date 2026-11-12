// @vitest-environment node
// Top-5 fixes (ideas 4, 5): the cleaner view returns the agreed re-clean
// (date + decision text) and the client's original complaint (room +
// text + source), so the cleaner can target the re-clean.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";
import cleanerHandler from "../../api/cleaner";

const SECRET = "test-cleaner-secret-123";
const VISIT_ID = "33333333-4444-5555-6666-777777777777";
const BID = "bid-top5";
const ISSUANCE = "aabbccddeeff00112233445566778899";

type Row = Record<string, unknown>;
type Evt = { visit_id: string | null; event: string; actor?: string; detail?: Record<string, unknown>; created_at: string };

let rows: Row[];
let events: Evt[];

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

function makeRow(overrides: Row = {}): Row {
  return {
    id: VISIT_ID,
    booking_id: BID,
    visit_no: 1,
    status: "confirmed",
    report_status: "sent",
    visit_date: "2026-11-12",
    window: "midday",
    address: "123 Secret St, Sugar Hill, GA",
    service: "Standard cleaning",
    client_name: "Casey Client",
    client_email: "client@example.com",
    cleaner_name: "Ana",
    cleaner_token_hash: null,
    cleaner_token_expires: null,
    cleaner_link_version: null,
    cleaner_link_issuance: null,
    checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Counters cleaned", done: false }] }] },
    ...overrides,
  };
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const supRes = (data: unknown, ok = true, status = 200) => ({
      ok, status,
      json: async () => data,
      text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    });
    if (u.includes("/rest/v1/gh_visits")) {
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const eq = (k: string) => {
        const v = qs.get(k);
        return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
      };
      let out = [...rows];
      const bid = eq("booking_id");
      const id = eq("id");
      const hash = eq("cleaner_token_hash");
      if (bid) out = out.filter((r) => r["booking_id"] === bid);
      if (id) out = out.filter((r) => r["id"] === id);
      if (hash) out = out.filter((r) => r["cleaner_token_hash"] === hash);
      return supRes(out.slice(0, 1));
    }
    if (u.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Evt;
        events.push({ ...body, created_at: new Date().toISOString() });
        return supRes([{ id: events.length }]);
      }
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const ev = qs.get("event");
      let out = [...events];
      if (ev && ev.startsWith("eq.")) out = out.filter((e) => e.event === decodeURIComponent(ev.slice(3)));
      if (ev && ev.startsWith("in.(")) {
        const names = ev.slice(4, -1).split(",").map((s) => s.trim());
        out = out.filter((e) => names.includes(e.event));
      }
      out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const limit = Number(qs.get("limit") ?? "0");
      return supRes(limit > 0 ? out.slice(0, limit) : out);
    }
    // gh_photos, gh_visit_access, storage: empty.
    return supRes([]);
  }));
}

const callCleanerGet = async (ct: string) => {
  const r = res();
  await cleanerHandler({ method: "GET", query: { ct } } as never, r as never);
  return r;
};

const tokenFor = () => {
  const token = mintCleanerLinkV2(SECRET, VISIT_ID, ISSUANCE);
  rows[0]["cleaner_token_hash"] = hashToken(token);
  rows[0]["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
  rows[0]["cleaner_link_version"] = "v2";
  rows[0]["cleaner_link_issuance"] = ISSUANCE;
  return token;
};

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [makeRow()];
  events = [
    { visit_id: VISIT_ID, event: "visit_confirmed", detail: { date: "2026-11-12", window: "midday" }, created_at: "2026-11-10T10:00:00.000Z" },
  ];
  installFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("cleaner view: re-clean + client issue", () => {
  it("returns the agreed re-clean date and decision text", async () => {
    events.push(
      { visit_id: VISIT_ID, event: "issue_opened", actor: "client", detail: { reason: "Streaks on the floor", room: "Kitchen" }, created_at: "2026-11-11T10:00:00.000Z" },
      { visit_id: VISIT_ID, event: "issue_decision", actor: "owner", detail: { decision: "reclean", resolution: "We'll come back to re-clean the kitchen.", decided_at: "2026-11-11T12:00:00.000Z" }, created_at: "2026-11-11T12:00:00.000Z" },
      { visit_id: VISIT_ID, event: "issue_resolved", actor: "owner", detail: { reclean_date: "2026-11-18" }, created_at: "2026-11-11T12:00:01.000Z" },
    );
    const token = tokenFor();
    const r = await callCleanerGet(token);
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["reclean"]).toEqual({ date: "2026-11-18", note: "We'll come back to re-clean the kitchen." });
    expect(r.body["client_issue"]).toEqual({ reason: "Streaks on the floor", room: "Kitchen", source: "client" });
  });

  it("returns null re-clean when the decision was payment requested, and the client issue still shows", async () => {
    events.push(
      { visit_id: VISIT_ID, event: "issue_opened", actor: "client", detail: { reason: "Streaks on the floor", room: "Kitchen" }, created_at: "2026-11-11T10:00:00.000Z" },
      { visit_id: VISIT_ID, event: "issue_decision", actor: "owner", detail: { decision: "payment_requested", resolution: "The original amount stays due.", decided_at: "2026-11-11T12:00:00.000Z" }, created_at: "2026-11-11T12:00:00.000Z" },
    );
    const token = tokenFor();
    const r = await callCleanerGet(token);
    expect(r.code).toBe(200);
    expect(r.body["reclean"]).toBeNull();
    expect(r.body["client_issue"]).toEqual({ reason: "Streaks on the floor", room: "Kitchen", source: "client" });
  });

  it("an owner-opened issue is labelled operator, not the client's words", async () => {
    events.push(
      { visit_id: VISIT_ID, event: "issue_opened", actor: "owner", detail: { reason: "Client emailed about streaks", room: "Kitchen" }, created_at: "2026-11-11T10:00:00.000Z" },
    );
    const token = tokenFor();
    const r = await callCleanerGet(token);
    expect(r.code).toBe(200);
    expect(r.body["client_issue"]).toEqual({ reason: "Client emailed about streaks", room: "Kitchen", source: "operator" });
  });

  it("returns nulls when no issue was ever filed", async () => {
    const token = tokenFor();
    const r = await callCleanerGet(token);
    expect(r.code).toBe(200);
    expect(r.body["reclean"]).toBeNull();
    expect(r.body["client_issue"]).toBeNull();
  });
});
