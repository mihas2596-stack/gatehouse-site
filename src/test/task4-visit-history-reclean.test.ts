// @vitest-environment node
// Task 4 (12.11.2026, ChatGPT report — "protect the visit history
// and finish re-clean"):
//   (i)   a paid or disputed visit can never be deleted (409
//         visit_protected; row, journal, photos and entry all stay) —
//         covered in delete-visit.test.ts;
//   (ii)  the 90-day photo cleanup never deletes a disputed visit's
//         photos (or its report links);
//   (iii) a re-clean has its own date, cleaner and status on the row;
//         Finish is gated on the RE-CLEAN date, not the original one;
//         reassigning the cleaner revokes the old cleaner's link;
//         the client sees the re-clean date and cleaner while the
//         issue is still open.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";
import cleanerHandler from "../../api/cleaner";
import reportHandler from "../../api/report";
import autoChargeHandler from "../../api/auto-charge";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";
import { signBooking } from "../../api/create-checkout-session";

const SECRET = "test-cleaner-secret-123";
const BID = "bid-task4";
const VISIT_ID = "7a54c000-1111-2222-3333-444444444444";
const ISSUANCE = "aabbccddeeff00112233445566778899";

type Row = Record<string, unknown>;
type Evt = { visit_id: string | null; booking_id: string | null; event: string; actor?: string; detail?: Record<string, unknown> | null; created_at: string };

let rows: Row[];
let events: Evt[];
let photos: Row[];
let roster: Row[];
let storeMeta: Record<string, string>;
let storageRemoved: string[];
let photosDeleted: string[];
let rpCleared: boolean;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();
const daysFromNow = (d: number) => {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};
const ev = (event: string, detail: Record<string, unknown> | null, created_at: string, actor = "owner"): Evt =>
  ({ visit_id: VISIT_ID, booking_id: BID, event, actor, detail, created_at });

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
    report_status: "draft",
    visit_date: daysFromNow(-5),
    window: "midday",
    address: "123 Secret St, Sugar Hill, GA",
    service: "Standard cleaning",
    client_name: "Casey Client",
    client_email: "client@example.com",
    cleaner_name: "Ana",
    cleaner_id: "roster-ana",
    cleaner_token_hash: null,
    cleaner_token_expires: null,
    cleaner_link_version: null,
    cleaner_link_issuance: null,
    cleaner_profile: null,
    checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Counters cleaned", done: true }], skip_reason: "Client declined photos" }] },
    issue_open: true,
    issue_ever: true,
    amount_cents: 14900,
    report_sent_at: hoursAgo(30),
    report_bounced: false,
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
    if (u.includes("api.resend.com")) return supRes({ id: "email-1" });
    if (u.includes("api.stripe.com")) {
      if (u.includes("/customers/search")) {
        return supRes({ data: [{ id: "cus_task4", email: "client@example.com", name: "Casey Client", metadata: { ...storeMeta } }] });
      }
      if (u.includes("/payment_methods")) return supRes({ data: [] });
      if (u.includes("/payment_intents/search")) return supRes({ data: [] });
      if (u.includes("/payment_intents")) return supRes({ id: "pi_1", status: "succeeded" });
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u);
      if (custM) {
        if (method === "POST" || (init?.body && method !== "GET")) {
          const params = new URLSearchParams(String(init.body));
          for (const [k, v] of params.entries()) {
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) {
              storeMeta[m[1]] = v;
              if (m[1].startsWith("gh_rp_") && v === "") rpCleared = true;
            }
          }
          return supRes({ id: "cus_task4" });
        }
        return supRes({ id: "cus_task4", email: "client@example.com", name: "Casey Client", metadata: { ...storeMeta } });
      }
      return supRes({ id: "cus_task4" });
    }
    // Storage: object delete / signed upload / object info.
    if (u.includes("/storage/v1/object/report-photos")) {
      if (method === "DELETE" || method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { prefixes?: string[] };
        for (const p of body.prefixes ?? []) storageRemoved.push(p);
        return supRes({});
      }
      // HEAD / object info: pretend the object exists as a JPEG.
      return supRes({ contentType: "image/jpeg", size: 1234 });
    }
    if (u.includes("/rest/v1/gh_visits")) {
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const eq = (k: string) => {
        const v = qs.get(k);
        return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
      };
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
        const id = eq("id");
        const target = id ? rows.find((r) => r["id"] === id) : rows[0];
        if (!target) return supRes([]);
        Object.assign(target, patch);
        return supRes([target]);
      }
      if (method === "DELETE") {
        const id = eq("id");
        const bid = eq("booking_id");
        const gone = rows.filter((r) => (id ? r["id"] === id : true) && (bid ? r["booking_id"] === bid : true));
        for (const r of gone) rows.splice(rows.indexOf(r), 1);
        return supRes(gone);
      }
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
        events.push({ ...body, visit_id: body.visit_id ?? VISIT_ID, booking_id: body.booking_id ?? BID, created_at: new Date().toISOString() });
        return supRes([{ id: events.length }]);
      }
      if (method === "DELETE") {
        const gone = [...events];
        events = [];
        return supRes(gone);
      }
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const evParam = qs.get("event");
      const bid = qs.get("booking_id");
      const vid = qs.get("visit_id");
      let out = [...events];
      if (bid && bid.startsWith("eq.")) out = out.filter((e) => e.booking_id === decodeURIComponent(bid.slice(3)));
      if (vid && vid.startsWith("eq.")) out = out.filter((e) => e.visit_id === decodeURIComponent(vid.slice(3)));
      if (evParam && evParam.startsWith("eq.")) out = out.filter((e) => e.event === decodeURIComponent(evParam.slice(3)));
      if (evParam && evParam.startsWith("in.(")) {
        const names = evParam.slice(4, -1).split(",").map((s) => s.trim());
        out = out.filter((e) => names.includes(e.event));
      }
      out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const limit = Number(qs.get("limit") ?? "0");
      return supRes(limit > 0 ? out.slice(0, limit) : out);
    }
    if (u.includes("/rest/v1/gh_photos")) {
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      if (method === "DELETE") {
        const id = qs.get("id");
        const gone = photos.filter((p) => (id && id.startsWith("eq.") ? p["id"] === decodeURIComponent(id.slice(3)) : true));
        for (const p of gone) { photos.splice(photos.indexOf(p), 1); photosDeleted.push(String(p["id"])); }
        return supRes(gone);
      }
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Row;
        const created = { ...body, id: body["id"] ?? `photo-${photos.length + 1}` };
        photos.push(created);
        return supRes([created]);
      }
      // GET: the retention pass embeds the visit (issue flags) via
      // gh_visits!inner — attach the matching row as gh_visits.
      const wantsJoin = (u.split("?")[1] ?? "").includes("gh_visits!inner");
      const out = photos.map((p) => {
        if (!wantsJoin) return p;
        const v = rows.find((r) => r["id"] === p["visit_id"]);
        return { ...p, gh_visits: v ? { booking_id: v["booking_id"], report_sent_at: v["report_sent_at"], issue_open: v["issue_open"], issue_ever: v["issue_ever"] } : null };
      });
      return supRes(out);
    }
    if (u.includes("/rest/v1/gh_cleaners")) {
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const id = qs.get("id");
      const out = id && id.startsWith("eq.")
        ? roster.filter((r) => r["id"] === decodeURIComponent(id.slice(3)))
        : [...roster];
      return supRes(out.slice(0, 1));
    }
    if (u.includes("/rest/v1/gh_visit_access")) {
      if (method === "DELETE") return supRes([]);
      return supRes([]);
    }
    return supRes([]);
  }));
}

const callOwner = async (body: Record<string, unknown>) => {
  const r = res();
  await bookingAction(
    { method: "POST", headers: { authorization: "Bearer " + "adm-" + "secret" }, body: { booking_id: BID, ...body } } as never,
    r as never,
  );
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

const callCleaner = async (body: Record<string, unknown>, ct: string) => {
  const r = res();
  // POST reads the token from the BODY (ct), not the query string.
  await cleanerHandler({ method: "POST", query: { ct }, body: { ...body, ct } } as never, r as never);
  return r;
};

const callCleanerGet = async (ct: string) => {
  const r = res();
  await cleanerHandler({ method: "GET", query: { ct } } as never, r as never);
  return r;
};

const callReportGet = async (bt: string) => {
  const r = res();
  await reportHandler({ method: "GET", headers: {}, query: { bt } } as never, r as never);
  return r;
};

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [makeRow()];
  events = [
    ev("visit_created", {}, hoursAgo(100)),
    ev("visit_confirmed", { date: rows[0]["visit_date"], window: "midday" }, hoursAgo(50)),
    ev("issue_opened", { reason: "Streaks on the floor", room: "Kitchen" }, hoursAgo(2), "client"),
  ];
  photos = [];
  roster = [
    { id: "roster-ana", name: "Ana", phone: "+1 404 555 0100", photo_url: "", active: true },
    { id: "roster-beth", name: "Beth", phone: "+1 404 555 0200", photo_url: "", active: true },
  ];
  storeMeta = {
    gh_booking_id: BID, gh_state: "issue_open", gh_issue_open: "1",
    gh_report_amount_cents: "14900", gh_first_price_cents: "14900",
    gh_payment_method: "pm_1", gh_report_version: "1",
    gh_report_sent_at: hoursAgo(30),
  };
  storageRemoved = [];
  photosDeleted = [];
  rpCleared = false;
  installFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("task4: re-clean is stored on the row (own date, cleaner, status)", () => {
  it("resolve with a re-clean date writes reclean_* to the row", async () => {
    const date = daysFromNow(1);
    const r = await callOwner({ action: "resolve", reclean_date: date });
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("approved");
    expect(rows[0]["reclean_date"]).toBe(date);
    expect(rows[0]["reclean_status"]).toBe("scheduled");
    // The re-clean cleaner defaults to the visit's current cleaner.
    expect(rows[0]["reclean_cleaner_id"]).toBe("roster-ana");
    expect(rows[0]["reclean_cleaner_name"]).toBe("Ana");
    expect(rows[0]["issue_open"]).toBe(false);
  });

  it("issue_arrange_reclean with a date writes reclean_* and keeps the issue open", async () => {
    const date = daysFromNow(1);
    const r = await callOwner({ action: "issue_arrange_reclean", resolution: "We'll come back to re-clean the kitchen.", reclean_date: date });
    expect(r.code).toBe(200);
    expect(rows[0]["reclean_date"]).toBe(date);
    expect(rows[0]["reclean_status"]).toBe("scheduled");
    expect(rows[0]["reclean_cleaner_name"]).toBe("Ana");
    // The charge stays blocked while the re-clean is pending.
    expect(rows[0]["issue_open"]).toBe(true);
    const decision = events.find((e) => e.event === "issue_decision");
    expect(decision?.detail?.["decision"]).toBe("reclean");
    expect(decision?.detail?.["reclean_date"]).toBe(date);
  });

  it("issue_arrange_reclean without a date still arranges (no date stored)", async () => {
    const r = await callOwner({ action: "issue_arrange_reclean", resolution: "We'll come back." });
    expect(r.code).toBe(200);
    expect(rows[0]["reclean_date"]).toBeUndefined();
    expect(rows[0]["reclean_status"]).toBeUndefined();
    const decision = events.find((e) => e.event === "issue_decision");
    expect(decision?.detail?.["decision"]).toBe("reclean");
  });

  it("issue_arrange_reclean with an invalid date is 400 and writes nothing", async () => {
    const r = await callOwner({ action: "issue_arrange_reclean", resolution: "We'll come back.", reclean_date: "tomorrow-ish" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_reclean_date");
    expect(rows[0]["reclean_date"]).toBeUndefined();
    expect(rows[0]["reclean_status"]).toBeUndefined();
  });

  it("issue_arrange_reclean with a date past the 72h window is 409 and writes nothing", async () => {
    const r = await callOwner({ action: "issue_arrange_reclean", resolution: "We'll come back.", reclean_date: daysFromNow(4) });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("reclean_date_too_late");
    expect(rows[0]["reclean_date"]).toBeUndefined();
  });

  it("arranging a re-clean with a different cleaner updates reclean_cleaner and rotates the link", async () => {
    const token = tokenFor();
    const oldHash = rows[0]["cleaner_token_hash"];
    const oldIssuance = rows[0]["cleaner_link_issuance"];
    const date = daysFromNow(1);
    const r = await callOwner({ action: "issue_arrange_reclean", resolution: "Beth will re-clean.", reclean_date: date, cleaner_id: "roster-beth" });
    expect(r.code).toBe(200);
    expect(rows[0]["reclean_cleaner_id"]).toBe("roster-beth");
    expect(rows[0]["reclean_cleaner_name"]).toBe("Beth");
    // The old link is dead: a new issuance (and hash) was minted.
    expect(rows[0]["cleaner_link_issuance"]).not.toBe(oldIssuance);
    expect(rows[0]["cleaner_token_hash"]).not.toBe(oldHash);
    // The OLD token no longer resolves (invalid_link is a 200 with
    // ok:false, not a 400 — see resolveCleanerLink).
    const stale = await callCleanerGet(token);
    expect(stale.body["ok"]).toBe(false);
    expect(stale.body["error"]).toBe("invalid_link");
  });

  it("arranging a re-clean with an unknown cleaner is 404 and writes nothing", async () => {
    const r = await callOwner({ action: "issue_arrange_reclean", resolution: "X will re-clean.", reclean_date: daysFromNow(1), cleaner_id: "roster-nope" });
    expect(r.code).toBe(404);
    expect(r.body["error"]).toBe("cleaner_not_found");
    expect(rows[0]["reclean_date"]).toBeUndefined();
  });
});

describe("task4: Finish is gated on the RE-CLEAN date, not the original visit date", () => {
  const todayNY = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  it("submit is blocked before the re-clean date (400 report_too_early, reclean: true)", async () => {
    rows[0]["reclean_date"] = daysFromNow(2);
    rows[0]["reclean_status"] = "scheduled";
    rows[0]["reclean_cleaner_id"] = "roster-ana";
    rows[0]["reclean_cleaner_name"] = "Ana";
    rows[0]["report_status"] = "returned";
    const token = tokenFor();
    const r = await callCleaner({ action: "submit" }, token);
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["visit_date"]).toBe(daysFromNow(2));
    expect(r.body["reclean"]).toBe(true);
    // Nothing was submitted.
    expect(rows[0]["report_status"]).toBe("returned");
    expect(rows[0]["reclean_status"]).toBe("scheduled");
  });

  it("submit on the re-clean date passes and marks the re-clean submitted", async () => {
    rows[0]["reclean_date"] = todayNY();
    rows[0]["reclean_status"] = "scheduled";
    rows[0]["reclean_cleaner_id"] = "roster-ana";
    rows[0]["reclean_cleaner_name"] = "Ana";
    rows[0]["report_status"] = "returned";
    const token = tokenFor();
    const r = await callCleaner({ action: "submit" }, token);
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["report_status"]).toBe("submitted");
    expect(rows[0]["reclean_status"]).toBe("submitted");
  });

  it("without a scheduled re-clean, submit is gated on the original visit date (past = allowed)", async () => {
    // Original visit was 5 days ago; no re-clean arranged.
    rows[0]["report_status"] = "returned";
    const token = tokenFor();
    const r = await callCleaner({ action: "submit" }, token);
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["report_status"]).toBe("submitted");
  });

  it("the cleaner view shows the re-clean from the row (date + cleaner + status)", async () => {
    rows[0]["reclean_date"] = daysFromNow(2);
    rows[0]["reclean_status"] = "scheduled";
    rows[0]["reclean_cleaner_id"] = "roster-beth";
    rows[0]["reclean_cleaner_name"] = "Beth";
    const token = tokenFor();
    const r = await callCleanerGet(token);
    expect(r.code).toBe(200);
    expect(r.body["reclean"]).toEqual({
      date: daysFromNow(2),
      note: "",
      cleaner_name: "Beth",
      status: "scheduled",
    });
  });
});

describe("task4: the 90-day photo cleanup never deletes a disputed visit's evidence", () => {
  const runCron = async () => {
    const r = res();
    await autoChargeHandler({ method: "GET", headers: { authorization: "Bearer cron-secret" } } as never, r as never);
    return r;
  };

  it("a disputed visit's photos survive the 90-day cleanup (row, bucket object and report links all kept)", async () => {
    rows[0]["status"] = "report_sent";
    rows[0]["report_sent_at"] = daysAgo(100);
    rows[0]["issue_open"] = true;
    rows[0]["issue_ever"] = true;
    photos = [{ id: "p-disputed", visit_id: VISIT_ID, storage_path: `visits/${VISIT_ID}/kitchen/old.jpg`, room: "Kitchen", kind: "after" }];
    storeMeta["gh_state"] = "paid";
    storeMeta["gh_issue_open"] = "1";
    storeMeta["gh_issue_ever"] = "1";
    storeMeta["gh_rp_0"] = "https://example.com/report";
    storeMeta["gh_report_sent_at"] = daysAgo(100);
    const r = await runCron();
    expect(r.code).toBe(200);
    expect(photos).toHaveLength(1);
    expect(photosDeleted).toHaveLength(0);
    expect(storageRemoved).toHaveLength(0);
    expect(rpCleared).toBe(false);
  });

  it("a clean visit's photos are deleted after 90 days (row + bucket object + report links)", async () => {
    rows[0]["status"] = "paid";
    rows[0]["report_sent_at"] = daysAgo(100);
    rows[0]["issue_open"] = false;
    rows[0]["issue_ever"] = false;
    photos = [{ id: "p-clean", visit_id: VISIT_ID, storage_path: `visits/${VISIT_ID}/kitchen/old.jpg`, room: "Kitchen", kind: "after" }];
    storeMeta["gh_state"] = "paid";
    storeMeta["gh_issue_open"] = "";
    storeMeta["gh_issue_ever"] = "";
    storeMeta["gh_rp_0"] = "https://example.com/report";
    storeMeta["gh_report_sent_at"] = daysAgo(100);
    const r = await runCron();
    expect(r.code).toBe(200);
    expect(photos).toHaveLength(0);
    expect(photosDeleted).toEqual(["p-clean"]);
    expect(storageRemoved).toContain(`visits/${VISIT_ID}/kitchen/old.jpg`);
    expect(rpCleared).toBe(true);
  });

  it("a recent disputed visit's photos are kept (age alone never deletes)", async () => {
    rows[0]["status"] = "report_sent";
    rows[0]["report_sent_at"] = hoursAgo(30);
    rows[0]["issue_open"] = true;
    rows[0]["issue_ever"] = true;
    photos = [{ id: "p-recent", visit_id: VISIT_ID, storage_path: `visits/${VISIT_ID}/kitchen/recent.jpg`, room: "Kitchen", kind: "after" }];
    const r = await runCron();
    expect(r.code).toBe(200);
    expect(photos).toHaveLength(1);
    expect(photosDeleted).toHaveLength(0);
    expect(storageRemoved).toHaveLength(0);
  });
});

describe("task4: the client sees the re-clean (date + cleaner) while the issue is still open", () => {
  it("the report view returns reclean_date and reclean_cleaner_name from the row", async () => {
    vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
    const date = daysFromNow(2);
    rows[0]["reclean_date"] = date;
    rows[0]["reclean_status"] = "scheduled";
    rows[0]["reclean_cleaner_id"] = "roster-beth";
    rows[0]["reclean_cleaner_name"] = "Beth";
    rows[0]["report_status"] = "sent";
    rows[0]["status"] = "report_sent";
    events.push(
      ev("issue_decision", { decision: "reclean", resolution: "We'll come back to re-clean the kitchen.", reclean_date: date }, hoursAgo(1)),
    );
    const bt = signBooking("link-secret", { bid: BID, email: "client@example.com", name: "Casey Client" }).token;
    const r = await callReportGet(bt);
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("issue_open");
    expect(r.body["reclean_date"]).toBe(date);
    expect(r.body["reclean_cleaner_name"]).toBe("Beth");
    expect((r.body["issue_decision"] as Record<string, unknown>)?.["decision"]).toBe("reclean");
  });

  it("without a re-clean the client fields are empty", async () => {
    vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
    rows[0]["report_status"] = "sent";
    rows[0]["status"] = "report_sent";
    const bt = signBooking("link-secret", { bid: BID, email: "client@example.com", name: "Casey Client" }).token;
    const r = await callReportGet(bt);
    expect(r.code).toBe(200);
    expect(r.body["reclean_date"]).toBe("");
    expect(r.body["reclean_cleaner_name"]).toBe("Ana");
  });
});

describe("task4: reassigning the cleaner updates the re-clean and revokes the old link", () => {
  it("assign_confirm to a new cleaner updates reclean_cleaner and rotates the link", async () => {
    rows[0]["reclean_date"] = daysFromNow(2);
    rows[0]["reclean_status"] = "scheduled";
    rows[0]["reclean_cleaner_id"] = "roster-ana";
    rows[0]["reclean_cleaner_name"] = "Ana";
    rows[0]["status"] = "confirmed";
    const token = tokenFor();
    const oldIssuance = rows[0]["cleaner_link_issuance"];
    const r = await callOwner({
      action: "assign_confirm",
      cleaner_id: "roster-beth",
      // The original visit is in the past (history row); the confirmation
      // is for the scheduled re-clean, which is in the future.
      confirmed_date: daysFromNow(2),
      confirmed_window: "midday",
    });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["cleaner_id"]).toBe("roster-beth");
    expect(rows[0]["cleaner_name"]).toBe("Beth");
    // The re-clean now belongs to the new cleaner.
    expect(rows[0]["reclean_cleaner_id"]).toBe("roster-beth");
    expect(rows[0]["reclean_cleaner_name"]).toBe("Beth");
    expect(rows[0]["reclean_status"]).toBe("scheduled");
    // The old link is dead (invalid_link is a 200 with ok:false).
    expect(rows[0]["cleaner_link_issuance"]).not.toBe(oldIssuance);
    const stale = await callCleanerGet(token);
    expect(stale.body["ok"]).toBe(false);
    expect(stale.body["error"]).toBe("invalid_link");
  });

  it("set_cleaner to a new cleaner updates reclean_cleaner", async () => {
    rows[0]["reclean_date"] = daysFromNow(2);
    rows[0]["reclean_status"] = "scheduled";
    rows[0]["reclean_cleaner_id"] = "roster-ana";
    rows[0]["reclean_cleaner_name"] = "Ana";
    rows[0]["status"] = "confirmed";
    const r = await callOwner({ action: "set_cleaner", cleaner_id: "roster-beth" });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["reclean_cleaner_id"]).toBe("roster-beth");
    expect(rows[0]["reclean_cleaner_name"]).toBe("Beth");
  });
});
