// @vitest-environment node
// 16.11 (item 15): the journal is append-only and confirm logs a NEW
// visit_confirmed event on every confirmation — including a date change
// (owner Change -> confirm). The submit gate must read the LATEST
// event, not the first: after a move 30.11 -> today the cleaner must
// be able to press Finish TODAY, while a visit confirmed only for a
// future date must still be blocked.
//
// The mock simulates PostgREST ordering: an unordered query returns
// rows in insertion order (oldest first); `order=created_at.desc`
// returns newest first. If the gate query ever loses its ordering,
// the moved-date case returns report_too_early again and this test
// fails.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";
import cleanerHandler from "../../api/cleaner";

const SECRET = "test-cleaner-secret-123";
const VISIT_ID = "11111111-2222-3333-4444-555555555555";
const BID = "bid-submit-reschedule";

vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-16T12:00:00Z"));

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let visit: Row;
let events: Ev[];

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

const supRes = (data: unknown, ok = true, status = 200) => ({
  ok, status,
  json: async () => data,
  text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
});

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("/rest/v1/gh_visits")) {
      if (method === "GET") {
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const id = qs.get("id");
        if (id && id.startsWith("eq.") && visit["id"] === decodeURIComponent(id.slice(3))) return supRes([visit]);
        return supRes([]);
      }
      return supRes(null);
    }
    if (u.includes("/rest/v1/gh_photos")) return supRes([]);
    if (u.includes("/rest/v1/gh_events")) {
      if (method === "POST") return supRes([{ id: 1 }]);
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const evName = qs.get("event");
      let out = [...events];
      if (evName && evName.startsWith("eq.")) out = out.filter((e) => e.event === decodeURIComponent(evName.slice(3)));
      if (evName && evName.startsWith("in.(")) {
        const names = evName.slice(4, -1).split(",");
        out = out.filter((e) => names.includes(e.event));
      }
      // PostgREST without an order returns insertion order; with
      // order=created_at.desc it returns newest first.
      if (qs.get("order") === "created_at.desc") out = out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const limit = qs.get("limit");
      if (limit) out = out.slice(0, Number(limit));
      return supRes(out);
    }
    if (u.includes("/rest/v1/gh_visit_access")) return supRes([]);
    return supRes({}, false, 404);
  }));
}

const post = async (body: Record<string, unknown>) => {
  const r = res();
  await (cleanerHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { method: "POST", headers: {}, query: {}, body } as never, r as never,
  );
  return r;
};

function makeVisit(over: Row = {}): Row {
  return {
    id: VISIT_ID,
    booking_id: BID,
    status: "confirmed",
    report_status: "draft",
    visit_date: "2026-11-30",
    window: "midday",
    client_name: "Casey Client",
    client_email: "client@example.com",
    cleaner_name: "Danielle Littles",
    cleaner_token_hash: null,
    cleaner_token_expires: null,
    cleaner_link_version: "v2",
    cleaner_link_issuance: "aabbccddeeff00112233445566778899",
    checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Counters wiped", done: true }] }] },
    no_photo_zones: null,
    updated_at: null,
    issue_open: false,
    ...over,
  };
}

const confirmedEvent = (date: string, created_at: string): Ev => ({
  event: "visit_confirmed",
  detail: { date },
  created_at,
});

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  visit = makeVisit();
  events = [
    confirmedEvent("2026-11-30", "2026-11-14T10:00:00.000Z"),
    confirmedEvent("2026-11-16", "2026-11-16T09:00:00.000Z"),
  ];
  installFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("submit after a date move", () => {
  it("reads the LATEST visit_confirmed event: Finish works on the moved date", async () => {
    const token = mintCleanerLinkV2(SECRET, VISIT_ID, "aabbccddeeff00112233445566778899");
    visit["cleaner_token_hash"] = hashToken(token);
    visit["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
    const r = await post({ ct: token, action: "submit" });
    // The gate passes (no report_too_early); the submit then stops at
    // the rooms check because no photos were uploaded — that is the
    // expected next error, proving the date gate read 2026-11-16.
    expect(r.body["error"]).not.toBe("report_too_early");
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("rooms_incomplete");
    expect(r.body["missing"]).toEqual(["Kitchen"]);
  });

  it("still blocks a visit confirmed only for a future date", async () => {
    events = [confirmedEvent("2026-11-30", "2026-11-14T10:00:00.000Z")];
    const token = mintCleanerLinkV2(SECRET, VISIT_ID, "aabbccddeeff00112233445566778899");
    visit["cleaner_token_hash"] = hashToken(token);
    visit["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
    const r = await post({ ct: token, action: "submit" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["visit_date"]).toBe("2026-11-30");
  });
});
