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

describe("minimal flow", () => {
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

  describe("roster", () => {
    it("roster actions are owner-only", async () => {
      const r = await call({ action: "roster_add", cleaner_name: "X" }, "Bearer wrong-token");
      expect(r.code).toBe(401);
    });

    it("roster_add validates name, phone, and photo", async () => {
      expect((await call({ action: "roster_add", cleaner_name: "  " })).body["error"]).toBe("cleaner_name_required");
      expect((await call({ action: "roster_add", cleaner_name: "X", cleaner_phone: "abc" })).body["error"]).toBe("invalid_phone");
      expect((await call({ action: "roster_add", cleaner_name: "X", cleaner_photo: "http://x/y.jpg" })).body["error"]).toBe("invalid_photo_url");
      const ok = await call({ action: "roster_add", cleaner_name: "Dana", cleaner_phone: "7705550100" });
      expect(ok.body["ok"]).toBe(true);
      expect(cleaners.length).toBe(1);
    });

    it("roster_update toggles active and rejects unknown ids", async () => {
      const id = await addCleaner();
      expect((await call({ action: "roster_update", cleaner_id: "nope", active: false })).code).toBe(404);
      const off = await call({ action: "roster_update", cleaner_id: id, active: false });
      expect(off.body["ok"]).toBe(true);
      expect(cleaners[0]["active"]).toBe(false);
    });

    it("roster_import skips the header, imports valid rows, and reports bad lines", async () => {
      const csv = "name,phone,photo,active\nDana,7705550100,https://example.com/d.jpg,yes\nBad,not-a-phone,,yes\n,7705550101,,yes";
      const r = await call({ action: "roster_import", csv });
      expect(r.body["ok"]).toBe(true);
      expect(r.body["imported"]).toBe(1);
      expect((r.body["errors"] as { line: number; error: string }[]).map((e) => e.error)).toEqual(["invalid_phone", "missing_name"]);
      expect(cleaners.length).toBe(1);
    });
  });

  describe("approve_request", () => {
    it("is owner-only and idempotent", async () => {
      expect((await call({ action: "approve_request", booking_id: BID }, "Bearer wrong-token")).code).toBe(401);
      const first = await call({ action: "approve_request", booking_id: BID });
      expect(first.body["ok"]).toBe(true);
      expect(first.body["already"]).toBe(false);
      const second = await call({ action: "approve_request", booking_id: BID });
      expect(second.body["already"]).toBe(true);
      expect(events.filter((e) => e.event === "request_approved").length).toBe(1);
      // Approval alone changes nothing about confirmation or assignment.
      expect(rows[0]["status"]).toBe("requested");
      expect(rows[0]["cleaner_name"]).toBeNull();
    });

    it("refuses cancelled visits", async () => {
      rows[0]["status"] = "cancelled";
      const r = await call({ action: "approve_request", booking_id: BID });
      expect(r.code).toBe(409);
      expect(r.body["error"]).toBe("invalid_transition");
    });
  });

  describe("assign_confirm", () => {
    it("requires a roster id, an existing active cleaner", async () => {
      expect((await call({ action: "assign_confirm", booking_id: BID, confirmed_date: "2026-11-22", confirmed_window: "morning" })).body["error"]).toBe("cleaner_id_required");
      expect((await call({ action: "assign_confirm", booking_id: BID, cleaner_id: "nope", confirmed_date: "2026-11-22", confirmed_window: "morning" })).code).toBe(404);
      const id = await addCleaner();
      await call({ action: "roster_update", cleaner_id: id, active: false });
      const r = await call({ action: "assign_confirm", booking_id: BID, cleaner_id: id, confirmed_date: "2026-11-22", confirmed_window: "morning" });
      expect(r.code).toBe(409);
      expect(r.body["error"]).toBe("cleaner_inactive");
    });

    it("assigns from the roster and confirms in one save, with one email", async () => {
      const id = await addCleaner();
      const r = await call({
        action: "assign_confirm", booking_id: BID, cleaner_id: id,
        confirmed_date: "2026-11-22", confirmed_window: "morning",
      });
      expect(r.body["ok"]).toBe(true);
      expect(r.body["email_sent"]).toBe(true);
      expect(r.body["url"]).toMatch(/^https:\/\//);
      expect(rows[0]["status"]).toBe("confirmed");
      expect(rows[0]["cleaner_id"]).toBe(id);
      expect(rows[0]["cleaner_name"]).toBe("Test Cleaner");
      expect(rows[0]["cleaner_profile"]).toEqual({ phone: "7705550199", photo: "https://example.com/cleaner.jpg" });
      expect(events.some((e) => e.event === "visit_confirmed")).toBe(true);
      expect(events.some((e) => e.event === "cleaner_assigned")).toBe(true);
      expect(resendBodies.some((b) => b.subject.includes("Your cleaning is confirmed"))).toBe(true);
    });

    it("repeating the same assignment sends no duplicate email and keeps the link", async () => {
      const id = await addCleaner();
      const first = await call({
        action: "assign_confirm", booking_id: BID, cleaner_id: id,
        confirmed_date: "2026-11-22", confirmed_window: "morning",
      });
      expect(first.body["ok"]).toBe(true);
      const second = await call({
        action: "assign_confirm", booking_id: BID, cleaner_id: id,
        confirmed_date: "2026-11-22", confirmed_window: "morning",
      });
      expect(second.body["already_confirmed"]).toBe(true);
      expect(second.body["email_sent"]).toBe(false);
      expect(events.filter((e) => e.event === "visit_confirmed").length).toBe(1);
    });

    it("a submitted report without confirmation needs repair, which keeps the report", async () => {
      const id = await addCleaner();
      rows[0]["report_status"] = "submitted";
      rows[0]["status"] = "report_submitted";
      const blocked = await call({
        action: "assign_confirm", booking_id: BID, cleaner_id: id,
        confirmed_date: "2026-11-22", confirmed_window: "morning",
      });
      expect(blocked.code).toBe(409);
      expect(blocked.body["error"]).toBe("needs_review");
      const repaired = await call({
        action: "assign_confirm", booking_id: BID, cleaner_id: id,
        confirmed_date: "2026-11-22", confirmed_window: "morning", repair: true,
      });
      expect(repaired.body["ok"]).toBe(true);
      expect(rows[0]["report_status"]).toBe("submitted");
    });
  });

  describe("set_cleaner with a roster id", () => {
    it("resolves the snapshot from the roster and refuses new free-text names", async () => {
      const id = await addCleaner();
      const r = await call({ action: "set_cleaner", booking_id: BID, cleaner_id: id });
      expect(r.body["ok"]).toBe(true);
      expect(rows[0]["cleaner_id"]).toBe(id);
      expect(rows[0]["cleaner_name"]).toBe("Test Cleaner");
      expect(rows[0]["cleaner_profile"]).toEqual({ phone: "7705550199", photo: "https://example.com/cleaner.jpg" });
      const free = await call({ action: "set_cleaner", booking_id: BID, cleaner_name: "Someone Else" });
      expect(free.code).toBe(400);
      expect(free.body["error"]).toBe("cleaner_id_required");
      const same = await call({ action: "set_cleaner", booking_id: BID, cleaner_name: "Test Cleaner", cleaner_phone: "7705550200" });
      expect(same.body["ok"]).toBe(true);
      expect((rows[0]["cleaner_profile"] as Row)["phone"]).toBe("7705550200");
    });
  });

  describe("cleaner finish auto-publishes", () => {
    it("publishes the report to the client at once, with the report email", async () => {
      confirmRow();
      completePhotos();
      const r = await clean({ ct: CLEANER_TOKEN, action: "submit", checklist });
      expect(r.body["ok"]).toBe(true);
      expect(r.body["published"]).toBe(true);
      expect(r.body["email_sent"]).toBe(true);
      expect(rows[0]["report_status"]).toBe("sent");
      expect(rows[0]["status"]).toBe("report_sent");
      expect(stripeMeta["gh_state"]).toBe("report_sent");
      expect(stripeMeta["gh_report_amount_cents"]).toBe("14900");
      expect(stripeMeta["gh_report_sent_at"]).toBeTruthy();
      const sent = events.find((e) => e.event === "report_sent");
      expect(sent).toBeTruthy();
      expect(sent?.detail?.["auto"]).toBe(true);
      expect(sent?.detail?.["email_sent"]).toBe(true);
      expect(resendBodies.some((b) => b.to.includes("client@example.com") && b.subject === "Your cleaning report is ready")).toBe(true);
    });

    it("an open issue holds the report for owner review instead of publishing", async () => {
      confirmRow();
      completePhotos();
      rows[0]["issue_open"] = true;
      const r = await clean({ ct: CLEANER_TOKEN, action: "submit", checklist });
      expect(r.body["ok"]).toBe(true);
      expect(r.body["published"]).toBe(false);
      expect(r.body["held"]).toBe(true);
      expect(rows[0]["report_status"]).toBe("submitted");
      expect(events.some((e) => e.event === "report_sent")).toBe(false);
      expect(resendBodies.some((b) => b.to.includes("nikolajmihasenok@gmail.com") && b.subject.includes("ready for review"))).toBe(true);
    });

    it("a failed report email publishes but blocks the clock (bounced)", async () => {
      confirmRow();
      completePhotos();
      resendOk = false;
      const r = await clean({ ct: CLEANER_TOKEN, action: "submit", checklist });
      expect(r.body["ok"]).toBe(true);
      expect(r.body["published"]).toBe(true);
      expect(r.body["email_sent"]).toBe(false);
      expect(rows[0]["report_status"]).toBe("sent");
      expect(rows[0]["report_bounced"]).toBe(true);
      expect(stripeMeta["gh_report_bounced"]).toBe("1");
    });

    it("a second submit after publishing is locked, not a duplicate publish", async () => {
      confirmRow();
      completePhotos();
      const first = await clean({ ct: CLEANER_TOKEN, action: "submit", checklist });
      expect(first.body["published"]).toBe(true);
      const second = await clean({ ct: CLEANER_TOKEN, action: "submit", checklist });
      expect(second.code).toBe(409);
      expect(second.body["error"]).toBe("report_locked");
      expect(events.filter((e) => e.event === "report_sent").length).toBe(1);
    });
  });

  describe("rowCleanerPhone", () => {
    it("reads the work phone from the per-visit profile, object or JSON", () => {
      expect(rowCleanerPhone({ cleaner_profile: { phone: "7705550199" } } as never)).toBe("7705550199");
      expect(rowCleanerPhone({ cleaner_profile: JSON.stringify({ phone: "7705550199" }) } as never)).toBe("7705550199");
      expect(rowCleanerPhone({ cleaner_profile: null } as never)).toBe("");
      expect(rowCleanerPhone(null)).toBe("");
    });
  });
});
