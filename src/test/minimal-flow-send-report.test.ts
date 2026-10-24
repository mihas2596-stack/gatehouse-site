// @vitest-environment node
// Minimal Gatehouse flow: the cleaner directory (roster), Approve request
// as a step distinct from confirmation, Assign & confirm in one action,
// and the cleaner's finish publishing the report straight to the client
// (with an open issue holding it for owner review, and a failed report
// email blocking the 24h clock while staying re-sendable).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { hashToken } from "../../api/_db";
import bookingAction from "../../api/booking-action";
import cleanerHandler from "../../api/cleaner";
import { rowCleanerPhone } from "../../api/visit";

const BID = "bid-minimal-flow";
const VISIT_ID = "33333333-4444-5555-6666-777777777777";
const CLEANER_TOKEN = "legacy-cleaner-token-1234567890";

type Row = Record<string, unknown>;
type Ev = { visit_id: string | null; event: string; detail?: Record<string, unknown> };

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
    status: "requested",
    report_status: "none",
    visit_date: "2026-11-22",
    window: "morning",
    service: "Standard cleaning",
    client_name: "Casey Client",
    client_email: "client@example.com",
    amount_cents: 14900,
    cleaner_name: null,
    cleaner_id: null,
    cleaner_token_hash: null,
    cleaner_token_expires: null,
    cleaner_link_version: null,
    cleaner_link_issuance: null,
    cleaner_profile: null,
    issue_open: false,
    checklist: { rooms: [] },
    ...overrides,
  };
}

describe("minimal flow (part 2)", () => {
  let rows: Row[];
  let events: Ev[];
  let photos: Row[];
  let cleaners: Row[];
  let stripeMeta: Record<string, string>;
  let resendOk: boolean;
  let resendBodies: { to: string[]; subject: string }[];

  const supRes = (data: unknown, ok = true, status = 200) => ({
    ok, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });

  const installFetch = () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("api.stripe.com")) {
        if (u.includes("/customers/search")) {
          return supRes({ data: [{ id: "cus_test_min", email: "client@example.com", name: "Casey Client", metadata: { ...stripeMeta } }] });
        }
        if (u.includes("/payment_methods")) return supRes({ data: [] });
        if (u.includes("/customers/cus_test_min")) {
          if (method === "POST") {
            const params = new URLSearchParams(String(init?.body ?? ""));
            for (const [k, v] of params) {
              const m = /^metadata\[(.+)\]$/.exec(k);
              if (m) stripeMeta[m[1]] = v;
            }
            return supRes({ id: "cus_test_min" });
          }
          return supRes({ id: "cus_test_min", email: "client@example.com", name: "Casey Client", metadata: { ...stripeMeta } });
        }
        return supRes({ id: "cus_test_min" });
      }
      if (u.includes("api.resend.com")) {
        try {
          const b = JSON.parse(String(init?.body ?? "{}")) as { to?: string[]; subject?: string };
          resendBodies.push({ to: b.to ?? [], subject: b.subject ?? "" });
        } catch { /* ignore */ }
        return supRes({ id: "email-1" }, resendOk, resendOk ? 200 : 500);
      }
      if (u.includes("/storage/v1/object/sign/")) {
        const tail = u.split("/object/sign/")[1] ?? "x.jpg";
        return supRes({ signedURL: `/object/sign/${tail}?token=test-token` });
      }
      if (u.includes("/rest/v1/gh_cleaners")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          const created = { ...body, id: `roster-${cleaners.length + 1}` };
          cleaners.push(created);
          return supRes([created]);
        }
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          const m = /id=eq\.([^&]+)/.exec(u);
          const key = m ? decodeURIComponent(m[1]) : "";
          for (const c of cleaners) if (c["id"] === key) Object.assign(c, patch);
          return supRes(null);
        }
        let out = [...cleaners];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const id = qs.get("id");
        if (id && id.startsWith("eq.")) out = out.filter((c) => c["id"] === decodeURIComponent(id.slice(3)));
        return supRes(out);
      }
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          const m = /id=eq\.([^&]+)/.exec(u) ?? /booking_id=eq\.([^&]+)/.exec(u);
          const key = m ? decodeURIComponent(m[1]) : "";
          for (const r of rows) if (r["id"] === key || r["booking_id"] === key) Object.assign(r, patch);
          return supRes(null);
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          const created = { ...makeRow(), ...body, id: body["id"] ?? VISIT_ID };
          rows.push(created);
          return supRes([created]);
        }
        let out = [...rows];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const eq = (k: string) => {
          const v = qs.get(k);
          return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
        };
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
          const body = JSON.parse(String(init?.body ?? "{}")) as { visit_id?: string | null; event?: string; detail?: Record<string, unknown> };
          events.push({ visit_id: body.visit_id ?? null, event: body.event ?? "", detail: body.detail });
          return supRes([{ id: events.length }]);
        }
        let out = [...events];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const eq = (k: string) => {
          const v = qs.get(k);
          return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
        };
        const vid = eq("visit_id");
        const ev = eq("event");
        if (vid) out = out.filter((e) => e.visit_id === vid);
        if (ev) out = out.filter((e) => e.event === ev);
        return supRes(out);
      }
      if (u.includes("/rest/v1/gh_photos")) {
        let out = [...photos];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const vid = qs.get("visit_id");
        if (vid && vid.startsWith("eq.")) out = out.filter((p) => p["visit_id"] === decodeURIComponent(vid.slice(3)));
        return supRes(out);
      }
      return supRes({}, false, 404);
    }));
  };

  const call = async (body: Record<string, unknown>, auth = "Bearer adm-secret") => {
    const r = res();
    await bookingAction(
      { method: "POST", headers: { authorization: auth }, body } as never,
      r as never,
    );
    return r;
  };

  const clean = async (body: Record<string, unknown>) => {
    const r = res();
    await cleanerHandler(
      { method: "POST", headers: {}, body } as never,
      r as never,
    );
    return r;
  };

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("CLEANER_LINK_SECRET", "test-cleaner-secret-123");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows = [makeRow()];
    events = [];
    photos = [];
    cleaners = [];
    stripeMeta = { gh_booking_id: BID, gh_state: "card_ready", gh_first_price_cents: "14900", gh_recurring_price_cents: "12900" };
    resendOk = true;
    resendBodies = [];
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const addCleaner = async (overrides: Row = {}) => {
    const r = await call({
      action: "roster_add",
      cleaner_name: "Test Cleaner",
      cleaner_phone: "7705550199",
      cleaner_photo: "https://example.com/cleaner.jpg",
      ...overrides,
    });
    expect(r.body["ok"]).toBe(true);
    return (r.body["cleaner"] as Row)["id"] as string;
  };

  const confirmRow = () => {
    rows[0]["status"] = "confirmed";
    events.push({ visit_id: VISIT_ID, event: "visit_confirmed" });
    rows[0]["cleaner_token_hash"] = hashToken(CLEANER_TOKEN);
    rows[0]["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
  };

  const completePhotos = () => {
    photos = [
      { id: "p1", visit_id: VISIT_ID, room: "Kitchen", kind: "after", storage_path: "visits/x/kitchen/a.jpg" },
      { id: "p2", visit_id: VISIT_ID, room: "Bathrooms", kind: "after", storage_path: "visits/x/bath/a.jpg" },
    ];
    rows[0]["report_status"] = "draft";
  };

  const checklist = {
    rooms: [
      { name: "Kitchen", items: [{ label: "Wipe counters", done: true }] },
      { name: "Bathrooms", items: [{ label: "Scrub sink", done: true }] },
    ],
  };

  describe("changing the assigned cleaner through the roster", () => {
    it("set_cleaner to another roster cleaner replaces the profile and rotates the link", async () => {
      const a = await addCleaner();
      await call({ action: "set_cleaner", booking_id: BID, cleaner_id: a });
      const firstIssuance = rows[0]["cleaner_link_issuance"];
      const b = await addCleaner({ cleaner_name: "Second Cleaner", cleaner_phone: "7705550200", cleaner_photo: "https://example.com/second.jpg" });
      const r = await call({ action: "set_cleaner", booking_id: BID, cleaner_id: b });
      expect(r.body["ok"]).toBe(true);
      expect(rows[0]["cleaner_id"]).toBe(b);
      expect(rows[0]["cleaner_name"]).toBe("Second Cleaner");
      expect(rows[0]["cleaner_profile"]).toEqual({ phone: "7705550200", photo: "https://example.com/second.jpg" });
      expect(rows[0]["cleaner_link_issuance"]).not.toBe(firstIssuance);
      expect(events.some((e) => e.event === "cleaner_link_rotated")).toBe(true);
    });

    it("assign_confirm to another cleaner re-sends the confirmation and rotates the link", async () => {
      const a = await addCleaner();
      const first = await call({
        action: "assign_confirm", booking_id: BID, cleaner_id: a,
        confirmed_date: "2026-11-22", confirmed_window: "morning",
      });
      expect(first.body["ok"]).toBe(true);
      const firstIssuance = rows[0]["cleaner_link_issuance"];
      const firstEmails = resendBodies.length;
      const b = await addCleaner({ cleaner_name: "Second Cleaner" });
      const second = await call({
        action: "assign_confirm", booking_id: BID, cleaner_id: b,
        confirmed_date: "2026-11-22", confirmed_window: "morning",
      });
      expect(second.body["ok"]).toBe(true);
      expect(second.body["email_sent"]).toBe(true);
      expect(resendBodies.length).toBeGreaterThan(firstEmails);
      expect(rows[0]["cleaner_id"]).toBe(b);
      expect(rows[0]["cleaner_link_issuance"]).not.toBe(firstIssuance);
    });
  });

  describe("send_report re-send after a bounce", () => {
    const setupSent = (bounced: string) => {
      rows[0]["report_status"] = "sent";
      rows[0]["status"] = "report_sent";
      photos = [
        { id: "p1", visit_id: VISIT_ID, room: "Kitchen", kind: "after", storage_path: "visits/x/kitchen/a.jpg" },
        { id: "p2", visit_id: VISIT_ID, room: "Bathrooms", kind: "after", storage_path: "visits/x/bath/a.jpg" },
      ];
      const hashInput = photos.map((ph) => `https://test.supabase.co/storage/v1/object/sign/report-photos/${ph["storage_path"]}`).join("|");
      stripeMeta["gh_state"] = "report_sent";
      stripeMeta["gh_rp_hash"] = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
      stripeMeta["gh_report_sent_at"] = new Date().toISOString();
      stripeMeta["gh_report_version"] = "1";
      stripeMeta["gh_report_bounced"] = bounced;
      stripeMeta["gh_rp_source"] = "db";
    };

    it("the same photo set within 10 minutes is a no-op when the send succeeded", async () => {
      setupSent("");
      const r = await call({ action: "send_report", booking_id: BID });
      expect(r.body["already_sent"]).toBe(true);
      expect(r.body["already_sent"]).toBe(true);
      expect(r.body["email_sent"]).toBe(false);
    });

    it("the same photo set is re-sent when the previous send bounced", async () => {
      setupSent("1");
      const before = resendBodies.length;
      const r = await call({ action: "send_report", booking_id: BID });
      expect(r.body["email_sent"]).toBe(true);
      expect(resendBodies.length).toBeGreaterThan(before);
      expect(stripeMeta["gh_report_version"]).toBe("2");
      expect(stripeMeta["gh_report_bounced"]).toBe("");
    });
  });

});
