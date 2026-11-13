// @vitest-environment node
// G4 L2: the natural-key dedup must close the check-then-act race and
// the window edge — a duplicate that lands between the pre-insert
// check and the insert is caught by the post-insert re-check (the
// loser's row is deleted, the earlier booking is returned), and a
// duplicate buried under a busy same-date page is still found because
// the scan cap is 200, not 50.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { bidFromRequestId } from "../../api/send-contact-email";

const origin = "https://www.gatehousehomecleaning.com";

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;

let rows: Row[];
let evts: Evt[];
let resendCalls: { key: string | null }[];
let sameDateCalls: number;
let raceArmed: boolean;

function res(code: number, body: unknown) {
  return {
    ok: code >= 200 && code < 300,
    status: code,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function applyFilters<T extends Record<string, unknown>>(list: T[], u: URL): T[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === decodeURIComponent(v.slice(3)));
    if (v.startsWith("neq.")) out = out.filter((r) => String(r[k] ?? "") !== decodeURIComponent(v.slice(4)));
  }
  if (u.searchParams.get("order")?.startsWith("created_at.desc")) {
    out.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

async function fetchMock(url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) {
  const u = new URL(String(url));
  const method = (init?.method ?? "GET").toUpperCase();
  const host = u.hostname;

  if (host === "api.stripe.com") return res(200, { data: [] });

  if (host === "api.resend.com") {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    resendCalls.push({ key: headers["Idempotency-Key"] ?? null });
    return res(200, { id: "email_1" });
  }

  if (host.includes("supabase")) {
    const table = u.pathname.split("/").pop() ?? "";
    if (method === "GET") {
      if (table === "gh_visits") {
        // Race simulation: the first same-date scan runs before the
        // competitor's insert is visible, so it sees nothing; the
        // post-insert re-check sees the full table.
        if (raceArmed && u.searchParams.get("visit_date")?.startsWith("eq.")) {
          sameDateCalls++;
          if (sameDateCalls === 1) return res(200, []);
        }
        return res(200, applyFilters(rows, u));
      }
      if (table === "gh_events") return res(200, applyFilters(evts, u));
      return res(200, []);
    }
    if (method === "POST") {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Row) : (init?.body as Row);
      if (table === "gh_visits") {
        const clash = rows.some((r) => r["booking_id"] === body["booking_id"] && r["visit_no"] === body["visit_no"]);
        if (clash) return res(409, { message: "duplicate key value violates unique constraint" });
        const row = { ...body, id: crypto.randomUUID(), created_at: new Date().toISOString() };
        rows.push(row);
        return res(201, [row]);
      }
      if (table === "gh_events") {
        const evt = { ...body, id: evts.length + 1, created_at: new Date().toISOString() };
        evts.push(evt);
        return res(201, [evt]);
      }
      return res(201, [body]);
    }
    if (method === "DELETE") {
      if (table === "gh_visits") {
        const idEq = u.searchParams.get("id");
        if (idEq?.startsWith("eq.")) {
          const id = decodeURIComponent(idEq.slice(3));
          rows = rows.filter((r) => r["id"] !== id);
          return res(200, []);
        }
      }
      return res(200, []);
    }
  }
  return res(404, { error: { message: "route not stubbed" } });
}

function response() {
  const r = {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(), end: vi.fn(),
  };
  return r;
}

const baseBody = {
  website: "",
  name: "Dedup Test",
  phone: "4045550100",
  email: "client@example.com",
  service: "Standard",
  date: "2099-12-01",
  time: "",
  message: "3 BR · 2 full BA · ZIP 30024",
  notes: "Please ring the doorbell",
  founding: false,
  bedrooms: "3",
  bathrooms: "2",
  zip: "30024",
  address: "1 Example Street",
  city: "Alpharetta",
  state: "GA",
  price: "189",
  frequency: "every2weeks",
  service_key: "standard",
  cleaned_recently: true,
  addons: { insideOven: false, insideFridge: false, insideCabinets: false, interiorWindows: 0, pets: false },
  recurring: "189",
  source: "quote",
  terms_consent: true,
  photo_consent: true,
  sms_consent: false,
};

async function submit(body: Record<string, unknown>) {
  const r = response();
  await handler({ method: "POST", headers: { origin }, body }, r);
  return r;
}

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "test-resend-key");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_for_signing_only");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret-for-tests");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [];
  evts = [];
  resendCalls = [];
  sameDateCalls = 0;
  raceArmed = false;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("L2 check-then-act race", () => {
  it("a duplicate that lands between the check and the insert is caught by the re-check", async () => {
    const first = await submit({ ...baseBody, request_id: "11111111-2222-4333-8444-555555555555" });
    expect(first.code).toBe(200);
    expect(rows).toHaveLength(1);
    const keptBid = first.body.booking_id;
    expect(resendCalls).toHaveLength(2);

    // The competitor (first booking) is already on file, but the
    // pre-insert scan runs before it is visible to this call.
    raceArmed = true;
    const second = await submit({ ...baseBody, request_id: "99999999-8888-4777-8666-555555555555" });
    expect(second.code).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.booking_id).toBe(keptBid);
    // The loser's row was deleted; no second email went out.
    expect(rows).toHaveLength(1);
    expect(rows[0]["booking_id"]).toBe(keptBid);
    expect(resendCalls).toHaveLength(2);
    expect(evts.filter((e) => e["event"] === "visit_created")).toHaveLength(1);
  });
});

describe("L2 window edge (busy same-date page)", () => {
  it("a duplicate buried under 60 newer same-date bookings is still found", async () => {
    const first = await submit({ ...baseBody, request_id: "11111111-2222-4333-8444-555555555555" });
    expect(first.code).toBe(200);
    const keptBid = first.body.booking_id;
    const firstCreated = String(rows[0]["created_at"]);

    // 60 newer same-date bookings from other clients — with the old
    // limit=50 + newest-first scan, the true duplicate would fall
    // out of the window and a resubmission would insert a second row.
    for (let i = 0; i < 60; i++) {
      rows.push({
        id: `filler-${i}`, booking_id: `bid-filler-${i}`, visit_no: 1,
        client_name: `Filler ${i}`, client_email: `filler${i}@example.com`,
        visit_date: "2099-12-01", service: "Standard", address: `${i} Other Street`,
        window: null, amount_cents: 18900, status: "requested",
        created_at: new Date(Date.parse(firstCreated) + (i + 1) * 1000).toISOString(),
      });
    }
    expect(rows).toHaveLength(61);

    const second = await submit({ ...baseBody, request_id: "99999999-8888-4777-8666-555555555555" });
    expect(second.code).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.booking_id).toBe(keptBid);
    expect(rows).toHaveLength(61);
    expect(resendCalls).toHaveLength(2);
    expect(bidFromRequestId("99999999-8888-4777-8666-555555555555")).not.toBe(keptBid);
  });
});
