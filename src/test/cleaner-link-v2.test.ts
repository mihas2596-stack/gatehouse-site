// @vitest-environment node
// Cleaner access links v2: deterministic HMAC tokens the owner can
// re-fetch after a refresh, with legacy random tokens kept working.
// Covers the mandatory list: same link on re-fetch, distinct tokens per
// visit/issuance, forged rejection, owner-only fetch, read without state
// change, replace/change revocation, expiry, legacy compatibility,
// legacy never auto-replaced on read, preview vs real open, API errors,
// profile save/no-carryover, and last-wins on competing issuances.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import {
  mintCleanerLinkV2,
  verifyCleanerLinkV2,
  parseCleanerLinkV2,
  cleanerLinkUrl,
  cleanerLinkExpiry,
  cleanerLinkSecretCandidates,
  cleanerLinkPrimarySecret,
} from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";
import bookingAction from "../../api/booking-action";
import cleanerHandler from "../../api/cleaner";

const SECRET = "test-cleaner-secret-123";
const OTHER_SECRET = "different-secret-456";
const VISIT_ID = "11111111-2222-3333-4444-555555555555";
const VISIT_ID_2 = "99999999-8888-7777-6666-555555555555";
const BID = "bid-cleaner-v2";

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

describe("v2 token scheme (pure)", () => {
  it("mints and verifies a round-trip token", () => {
    const token = mintCleanerLinkV2(SECRET, VISIT_ID, "aabbccddeeff00112233445566778899");
    expect(token.startsWith("ct2.")).toBe(true);
    expect(verifyCleanerLinkV2(SECRET, token)).toEqual({
      visitId: VISIT_ID,
      issuanceId: "aabbccddeeff00112233445566778899",
    });
    expect(parseCleanerLinkV2(token)?.visitId).toBe(VISIT_ID);
  });

  it("different visits and issuances give different tokens", () => {
    const a = mintCleanerLinkV2(SECRET, VISIT_ID, "aabbccddeeff00112233445566778899");
    const b = mintCleanerLinkV2(SECRET, VISIT_ID_2, "aabbccddeeff00112233445566778899");
    const c = mintCleanerLinkV2(SECRET, VISIT_ID, "00112233445566778899aabbccddeeff");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("secret candidates: env first, derived ADMIN_TOKEN fallback, empty when neither", () => {
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
    const derived = createHash("sha256").update("gatehouse-cleaner-link:adm-secret").digest("hex");
    expect(cleanerLinkSecretCandidates()).toEqual([SECRET, derived]);
    expect(cleanerLinkPrimarySecret()).toBe(SECRET);
    vi.stubEnv("CLEANER_LINK_SECRET", "");
    expect(cleanerLinkSecretCandidates()).toEqual([derived]);
    expect(cleanerLinkPrimarySecret()).toBe(derived);
    vi.stubEnv("ADMIN_TOKEN", "");
    expect(cleanerLinkSecretCandidates()).toEqual([]);
    expect(cleanerLinkPrimarySecret()).toBe("");
    vi.unstubAllEnvs();
  });

  it("env-minted tokens do not verify under the derived fallback", () => {
    const derived = createHash("sha256").update("gatehouse-cleaner-link:adm-secret").digest("hex");
    const token = mintCleanerLinkV2(SECRET, VISIT_ID, "aabbccddeeff00112233445566778899");
    expect(verifyCleanerLinkV2(SECRET, token)).not.toBeNull();
    expect(verifyCleanerLinkV2(derived, token)).toBeNull();
  });

  it("rejects forged, wrong-secret, and malformed tokens", () => {
    const good = mintCleanerLinkV2(SECRET, VISIT_ID, "aabbccddeeff00112233445566778899");
    const parts = good.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3].slice(0, -1)}${parts[3].endsWith("A") ? "B" : "A"}`;
    expect(verifyCleanerLinkV2(SECRET, tampered)).toBeNull();
    expect(verifyCleanerLinkV2(OTHER_SECRET, good)).toBeNull();
    expect(verifyCleanerLinkV2("", good)).toBeNull();
    expect(verifyCleanerLinkV2(SECRET, "ct2.only.two")).toBeNull();
    expect(verifyCleanerLinkV2(SECRET, "random-legacy-token")).toBeNull();
    expect(verifyCleanerLinkV2(SECRET, `ct2.${parts[1]}.${parts[2]}.short`)).toBeNull();
  });

  it("expiry is the later of 14 days from now or visit date + 2 days", () => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    const near = cleanerLinkExpiry("2026-10-30", now);
    expect(near).toBe(new Date(now + 14 * 24 * 3600 * 1000).toISOString());
    const far = cleanerLinkExpiry("2026-12-20", now);
    expect(far).toBe(new Date(Date.parse("2026-12-20T23:59:59Z") + 2 * 24 * 3600 * 1000).toISOString());
    expect(cleanerLinkExpiry(null, now)).toBe(new Date(now + 14 * 24 * 3600 * 1000).toISOString());
    expect(cleanerLinkExpiry("not-a-date", now)).toBe(new Date(now + 14 * 24 * 3600 * 1000).toISOString());
  });

  it("builds the cleaner cabinet URL", () => {
    expect(cleanerLinkUrl("ct2.abc")).toBe("https://www.gatehousehomecleaning.com/cleaner?ct=ct2.abc");
  });
});

// ---------- booking-action handler tests (fetch stub) ----------

type Row = Record<string, unknown>;

function makeVisitRow(overrides: Row = {}): Row {
  return {
    id: VISIT_ID,
    booking_id: BID,
    visit_no: 1,
    status: "requested",
    report_status: "none",
    visit_date: "2026-11-08",
    window: "midday",
    cleaner_name: null,
    cleaner_token_hash: null,
    cleaner_token_expires: null,
    cleaner_link_version: null,
    cleaner_link_issuance: null,
    cleaner_profile: null,
    checklist: { rooms: [] },
    ...overrides,
  };
}

const CUSTOMER = {
  id: "cus_test_v2",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "card_ready" },
};

describe("booking-action cleaner links", () => {
  let rows: Row[];
  let events: { visit_id: string | null; event: string }[];
  let v2ColumnsMissing: boolean;
  let roster: Row[];

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
          return supRes({ data: [{ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } }] });
        }
        if (u.includes("/payment_methods")) return supRes({ data: [] });
        if (u.includes(`/customers/${CUSTOMER.id}`) && method === "GET") {
          return supRes({ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } });
        }
        return supRes({ id: CUSTOMER.id });
      }
      if (u.includes("api.resend.com")) return supRes({ id: "email-1" });
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          if (v2ColumnsMissing && ("cleaner_link_version" in patch || "cleaner_profile" in patch)) {
            return supRes({ message: "column does not exist" }, false, 400);
          }
          const m = /id=eq\.([^&]+)/.exec(u) ?? /booking_id=eq\.([^&]+)/.exec(u);
          const key = m ? decodeURIComponent(m[1]) : "";
          for (const r of rows) {
            if (r["id"] === key || r["booking_id"] === key) Object.assign(r, patch);
          }
          return supRes(null);
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          const created = { ...makeVisitRow(), ...body, id: body["id"] ?? VISIT_ID };
          rows.push(created);
          return supRes([created]);
        }
        // GET: filter by the eq params present in the query string
        // (parsed properly: "id=eq." is a substring of "booking_id=eq.").
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
      if (u.includes("/rest/v1/gh_cleaners")) {
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const id = qs.get("id");
        const out = id && id.startsWith("eq.")
          ? roster.filter((r) => r["id"] === decodeURIComponent(id.slice(3)))
          : [...roster];
        return supRes(out.slice(0, 1));
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { visit_id?: string | null; event?: string };
          events.push({ visit_id: body.visit_id ?? null, event: body.event ?? "" });
          return supRes([{ id: events.length }]);
        }
        return supRes([]);
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

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows = [makeVisitRow()];
    events = [];
    v2ColumnsMissing = false;
    roster = [
      { id: "roster-ana-1", name: "Ana", phone: "+1 404 555 0100", photo_url: "https://example.com/ana1.jpg", active: true },
      { id: "roster-ana-2", name: "Ana", phone: "+1 404 555 0200", photo_url: "https://example.com/ana2.jpg", active: true },
    ];
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const issueV2 = async () => {
    const r = await call({ action: "cleaner_link", booking_id: BID });
    expect(r.body["ok"]).toBe(true);
    expect(r.body["reusable"]).toBe(true);
    return r.body["url"] as string;
  };

  it("re-fetch returns the same link and changes no state", async () => {
    const url = await issueV2();
    const before = JSON.stringify(rows[0]);
    const eventsBefore = events.length;
    const r1 = await call({ action: "get_cleaner_link", booking_id: BID });
    const r2 = await call({ action: "get_cleaner_link", booking_id: BID });
    expect(r1.body["ok"]).toBe(true);
    expect(r1.body["url"]).toBe(url);
    expect(r2.body["url"]).toBe(url);
    expect(JSON.stringify(rows[0])).toBe(before);
    expect(events.length).toBe(eventsBefore);
    // no-store response header on the re-fetch
    expect(r1.headers["Cache-Control"]).toBe("no-store");
  });

  it("re-fetch is owner-only", async () => {
    await issueV2();
    const r = await call({ action: "get_cleaner_link", booking_id: BID }, "Bearer wrong");
    expect(r.code).toBe(401);
  });

  it("legacy links are not reusable and are never rotated on read", async () => {
    rows[0]["cleaner_token_hash"] = hashToken("legacy-random-token-1234567890");
    rows[0]["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
    rows[0]["cleaner_link_version"] = null;
    rows[0]["cleaner_link_issuance"] = null;
    const before = JSON.stringify(rows[0]);
    const r = await call({ action: "get_cleaner_link", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("link_not_reusable");
    expect(JSON.stringify(rows[0])).toBe(before);
  });

  it("expired v2 links stay expired on read", async () => {
    const url = await issueV2();
    rows[0]["cleaner_token_expires"] = new Date(Date.now() - 1000).toISOString();
    const r1 = await call({ action: "get_cleaner_link", booking_id: BID });
    expect(r1.code).toBe(410);
    expect(r1.body["error"]).toBe("link_expired");
    const r2 = await call({ action: "get_cleaner_link", booking_id: BID });
    expect(r2.code).toBe(410);
    expect(r2.body["url"]).toBeUndefined();
    expect(url).toContain("ct2.");
  });

  it("hash mismatch is reported as not reusable, not a server error", async () => {
    await issueV2();
    rows[0]["cleaner_token_hash"] = "deadbeef";
    const r = await call({ action: "get_cleaner_link", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("link_not_reusable");
  });

  it("derived fallback issues and re-fetches without the env secret", async () => {
    vi.stubEnv("CLEANER_LINK_SECRET", "");
    const url = await issueV2();
    expect(url).toContain("ct2.");
    const r = await call({ action: "get_cleaner_link", booking_id: BID });
    expect(r.body["ok"]).toBe(true);
    expect(r.body["url"]).toBe(url);
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("links minted under the fallback survive adding the env secret", async () => {
    vi.stubEnv("CLEANER_LINK_SECRET", "");
    const url = await issueV2();
    vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
    const r = await call({ action: "get_cleaner_link", booking_id: BID });
    expect(r.body["ok"]).toBe(true);
    expect(r.body["url"]).toBe(url);
  });

  it("replace revokes the old link; competing issuances are last-wins", async () => {
    const first = await issueV2();
    const firstIssuance = rows[0]["cleaner_link_issuance"];
    const second = await issueV2();
    expect(second).not.toBe(first);
    expect(rows[0]["cleaner_link_issuance"]).not.toBe(firstIssuance);
    // Old token no longer matches the stored hash/issuance.
    const oldToken = first.split("ct=")[1];
    expect(hashToken(oldToken)).not.toBe(rows[0]["cleaner_token_hash"]);
    const r = await call({ action: "get_cleaner_link", booking_id: BID });
    expect(r.body["url"]).toBe(second);
  });

  it("missing env secret issues v2 via the derived fallback, not legacy", async () => {
    vi.stubEnv("CLEANER_LINK_SECRET", "");
    const r = await call({ action: "cleaner_link", booking_id: BID });
    expect(r.body["ok"]).toBe(true);
    expect(r.body["reusable"]).toBe(true);
    expect(String(r.body["url"])).toContain("ct2.");
    expect(rows[0]["cleaner_link_version"]).toBe("v2");
    const fetch = await call({ action: "get_cleaner_link", booking_id: BID });
    expect(fetch.body["ok"]).toBe(true);
    expect(fetch.body["url"]).toBe(r.body["url"]);
  });

  it("creates the visit when none exists, then issues v2", async () => {
    rows = [];
    const r = await call({ action: "cleaner_link", booking_id: BID });
    expect(r.body["ok"]).toBe(true);
    expect(r.body["reusable"]).toBe(true);
    expect(rows.length).toBe(1);
    expect(rows[0]["cleaner_link_version"]).toBe("v2");
  });

  it("set_cleaner saves phone/photo, issues v2, and resets profile on change", async () => {
    const r1 = await call({
      action: "set_cleaner", booking_id: BID,
      cleaner_name: "Ana", cleaner_phone: "+1 404 555 0100", cleaner_photo: "https://example.com/ana.jpg",
    });
    expect(r1.body["ok"]).toBe(true);
    expect(r1.body["reusable"]).toBe(true);
    expect(rows[0]["cleaner_name"]).toBe("Ana");
    expect(rows[0]["cleaner_profile"]).toEqual({ phone: "+1 404 555 0100", photo: "https://example.com/ana.jpg" });
    expect(rows[0]["cleaner_link_version"]).toBe("v2");
    const firstIssuance = rows[0]["cleaner_link_issuance"];

    // Same person, phone edit only: link kept (issuance unchanged).
    const r2 = await call({
      action: "set_cleaner", booking_id: BID,
      cleaner_name: "Ana", cleaner_phone: "+1 404 555 0199", cleaner_photo: "https://example.com/ana.jpg",
    });
    expect(r2.body["ok"]).toBe(true);
    expect(rows[0]["cleaner_link_issuance"]).toBe(firstIssuance);
    expect((rows[0]["cleaner_profile"] as Row)["phone"]).toBe("+1 404 555 0199");

    // A different person by free text is refused: assignments go through
    // the roster (cleaner_id), so an unlisted name can never take a visit.
    const r3 = await call({ action: "set_cleaner", booking_id: BID, cleaner_name: "Bea" });
    expect(r3.code).toBe(400);
    expect(r3.body["error"]).toBe("cleaner_id_required");
    expect(rows[0]["cleaner_name"]).toBe("Ana");
    expect(rows[0]["cleaner_link_issuance"]).toBe(firstIssuance);
  });

  it("set_cleaner validates phone and photo", async () => {
    const badPhone = await call({ action: "set_cleaner", booking_id: BID, cleaner_name: "Ana", cleaner_phone: "call me!!!" });
    expect(badPhone.code).toBe(400);
    expect(badPhone.body["error"]).toBe("invalid_phone");
    const badPhoto = await call({ action: "set_cleaner", booking_id: BID, cleaner_name: "Ana", cleaner_photo: "http://example.com/a.jpg" });
    expect(badPhoto.code).toBe(400);
    expect(badPhoto.body["error"]).toBe("invalid_photo_url");
  });

  it("tolerates a missing profile/v2 migration: name saves, link stays legacy", async () => {
    v2ColumnsMissing = true;
    const r = await call({
      action: "set_cleaner", booking_id: BID,
      cleaner_name: "Ana", cleaner_phone: "+1 404 555 0100",
    });
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["cleaner_name"]).toBe("Ana");
    expect(r.body["cleaner_profile_saved"]).toBe(false);
    expect(r.body["reusable"]).toBe(false);
  });

  it("G4: same name, different roster ID still rotates the link (set_cleaner)", async () => {
    const r1 = await call({ action: "set_cleaner", booking_id: BID, cleaner_id: "roster-ana-1" });
    expect(r1.body["ok"]).toBe(true);
    expect(rows[0]["cleaner_id"]).toBe("roster-ana-1");
    const firstIssuance = rows[0]["cleaner_link_issuance"];
    expect(firstIssuance).toBeTruthy();

    // Same ID again: link kept.
    const rSame = await call({ action: "set_cleaner", booking_id: BID, cleaner_id: "roster-ana-1" });
    expect(rSame.body["ok"]).toBe(true);
    expect(rows[0]["cleaner_link_issuance"]).toBe(firstIssuance);

    // Same NAME, different ID: a different person — the old link must
    // die and the profile must come from the new roster row.
    const eventsBefore = events.length;
    const r2 = await call({ action: "set_cleaner", booking_id: BID, cleaner_id: "roster-ana-2" });
    expect(r2.body["ok"]).toBe(true);
    expect(rows[0]["cleaner_id"]).toBe("roster-ana-2");
    expect(rows[0]["cleaner_link_issuance"]).not.toBe(firstIssuance);
    expect((rows[0]["cleaner_profile"] as Row)["phone"]).toBe("+1 404 555 0200");
    expect(events.slice(eventsBefore).map((e) => e.event)).toContain("cleaner_link_rotated");
  });

  // NOTE: the assign_confirm half of G4 lives in g4-assign-confirm.test.ts:
  // booking-action rate-limits 30 calls/min per module instance, and
  // this file's earlier tests already spend that budget.
});

// ---------- cleaner.ts handler tests (open tracking) ----------

describe("cleaner cabinet v2 verification", () => {
  let visit: Row;
  let openedEvents: number;
  let priorOpens: { created_at: string; detail: Record<string, unknown> | null }[];
  let openedDetails: (Record<string, unknown> | null)[];

  const installCleanerFetch = () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
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
        const id = eq("id");
        const hash = eq("cleaner_token_hash");
        if (id && visit["id"] === id) return supRes([visit]);
        if (hash && visit["cleaner_token_hash"] === hash) return supRes([visit]);
        return supRes([]);
      }
      if (u.includes("/rest/v1/gh_photos")) return supRes([]);
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { event?: string; detail?: Record<string, unknown> | null };
          if (body.event === "cleaner_link_opened") {
            openedEvents += 1;
            openedDetails.push(body.detail ?? null);
          }
          return supRes([{ id: 1 }]);
        }
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const issEq = qs.get("detail->>issuance");
        const iss = issEq && issEq.startsWith("eq.") ? decodeURIComponent(issEq.slice(3)) : null;
        const out = iss ? priorOpens.filter((o) => o.detail?.["issuance"] === iss) : priorOpens;
        return supRes(out);
      }
      return supRes({}, false, 404);
    }));
  };

  const get = async (query: Record<string, string>) => {
    const r = res();
    await cleanerHandler({ method: "GET", headers: {}, query, body: {} } as never, r as never);
    return r;
  };

  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    openedEvents = 0;
    priorOpens = [];
    openedDetails = [];
    visit = makeVisitRow({
      client_name: "Casey Client",
      service: "Standard",
      address: "1 Test Way",
      access_notes: "Gate code 1234",
    });
    installCleanerFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const issueV2ForVisit = (issuance: string, expires?: string) => {
    const token = mintCleanerLinkV2(SECRET, VISIT_ID, issuance);
    visit["cleaner_token_hash"] = hashToken(token);
    visit["cleaner_token_expires"] = expires ?? new Date(Date.now() + 86400000).toISOString();
    visit["cleaner_link_version"] = "v2";
    visit["cleaner_link_issuance"] = issuance;
    return token;
  };

  it("opens a valid v2 link and records the opening", async () => {
    const token = issueV2ForVisit("aabbccddeeff00112233445566778899");
    const r = await get({ ct: token });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(openedEvents).toBe(1);
  });

  it("preview (pv=1) does not count as an opening", async () => {
    const token = issueV2ForVisit("aabbccddeeff00112233445566778899");
    const r = await get({ ct: token, pv: "1" });
    expect(r.code).toBe(200);
    expect(openedEvents).toBe(0);
  });

  it("C2: a cancelled visit reports cancelled and is not editable", async () => {
    // report_status "none" alone would look editable; the cancelled row
    // status must win, matching the POST gate (409 visit_not_confirmed).
    visit["status"] = "cancelled";
    visit["report_status"] = "none";
    const token = issueV2ForVisit("aabbccddeeff00112233445566778899");
    const r = await get({ ct: token });
    expect(r.code).toBe(200);
    expect(r.body["cancelled"]).toBe(true);
    expect(r.body["editable"]).toBe(false);
  });

  it("rejects a forged v2 token and a replaced (old-issuance) token", async () => {
    const token = issueV2ForVisit("aabbccddeeff00112233445566778899");
    const parts = token.split(".");
    const forged = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3].slice(0, -1)}${parts[3].endsWith("A") ? "B" : "A"}`;
    expect((await get({ ct: forged })).code).toBe(404);
    // Replace: row now carries a new issuance; the old token is dead.
    issueV2ForVisit("00112233445566778899aabbccddeeff");
    expect((await get({ ct: token })).code).toBe(404);
    expect(openedEvents).toBe(0);
  });

  it("legacy tokens still open", async () => {
    const legacy = "legacy-random-token-1234567890abcdef";
    visit["cleaner_token_hash"] = hashToken(legacy);
    visit["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
    visit["cleaner_link_version"] = null;
    visit["cleaner_link_issuance"] = null;
    const r = await get({ ct: legacy });
    expect(r.code).toBe(200);
    expect(openedEvents).toBe(1);
  });

  it("expired v2 links return 410 and record no opening", async () => {
    const token = issueV2ForVisit("aabbccddeeff00112233445566778899", new Date(Date.now() - 1000).toISOString());
    const r = await get({ ct: token });
    expect(r.code).toBe(410);
    expect(openedEvents).toBe(0);
  });

  it("v2 links fail closed without any server secret", async () => {
    const token = issueV2ForVisit("aabbccddeeff00112233445566778899");
    vi.stubEnv("CLEANER_LINK_SECRET", "");
    vi.stubEnv("ADMIN_TOKEN", "");
    const r = await get({ ct: token });
    expect(r.code).toBe(404);
    expect(openedEvents).toBe(0);
  });

  it("O5: a new issuance logs its own opening despite a recent old-issuance open", async () => {
    const oldIss = "aabbccddeeff00112233445566778899";
    const newIss = "00112233445566778899aabbccddeeff";
    priorOpens = [{ created_at: new Date(Date.now() - 3600 * 1000).toISOString(), detail: { issuance: oldIss } }];
    const token = issueV2ForVisit(newIss);
    const r = await get({ ct: token });
    expect(r.code).toBe(200);
    expect(openedEvents).toBe(1);
    expect(openedDetails[0]?.["issuance"]).toBe(newIss);
  });

  it("O5: the same issuance within 6h does not double-log", async () => {
    const iss = "aabbccddeeff00112233445566778899";
    priorOpens = [{ created_at: new Date(Date.now() - 3600 * 1000).toISOString(), detail: { issuance: iss } }];
    const token = issueV2ForVisit(iss);
    const r = await get({ ct: token });
    expect(r.code).toBe(200);
    expect(openedEvents).toBe(0);
  });

  it("O5: the same issuance after 6h logs again", async () => {
    const iss = "aabbccddeeff00112233445566778899";
    priorOpens = [{ created_at: new Date(Date.now() - 7 * 3600 * 1000).toISOString(), detail: { issuance: iss } }];
    const token = issueV2ForVisit(iss);
    const r = await get({ ct: token });
    expect(r.code).toBe(200);
    expect(openedEvents).toBe(1);
  });

  it("fallback-minted links open after the env secret is added", async () => {
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    const derived = createHash("sha256").update("gatehouse-cleaner-link:adm-secret").digest("hex");
    const token = mintCleanerLinkV2(derived, VISIT_ID, "aabbccddeeff00112233445566778899");
    visit["cleaner_token_hash"] = hashToken(token);
    visit["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
    visit["cleaner_link_version"] = "v2";
    visit["cleaner_link_issuance"] = "aabbccddeeff00112233445566778899";
    // Env secret present, derived fallback still tried second.
    vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
    const r = await get({ ct: token });
    expect(r.code).toBe(200);
    expect(openedEvents).toBe(1);
  });
});
