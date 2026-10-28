// @vitest-environment node
// Spec A §5-6: entry arrangements live in gh_visit_access, never in
// Stripe metadata or the visit row; the client sees only has_secret;
// the cleaner sees a secret only on the current roster assignment.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import visitHandler from "../../api/visit";
import { signBooking } from "../../api/create-checkout-session";
import {
  cleanerEntryView, decryptEntrySecret, encryptEntrySecret, entryExpiresAt,
} from "../../api/_visit_access";

const BID = "bid-entry";
const VISIT_ID = "44444444-5555-6666-7777-888888888888";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };
type Acc = Record<string, unknown>;

let rows: Row[];
let events: Ev[];
let accessRows: Acc[];
let storeMeta: Record<string, string>;

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

const ev = (event: string, detail: Record<string, unknown> | null, created_at: string): Ev =>
  ({ event, detail, created_at });
const created = ev("visit_created", {}, "2026-10-20T10:00:00.000Z");
const confirmed = ev("visit_confirmed", { date: "2027-01-15", window: "midday" }, "2026-10-23T10:00:00.000Z");

function makeRow(overrides: Row = {}): Row {
  return {
    id: VISIT_ID, booking_id: BID, visit_no: 1, status: "confirmed",
    report_status: "none", report_sent_at: null, report_bounced: false,
    visit_date: "2027-01-15", window: "midday", service: "Standard cleaning",
    client_name: "Casey Client", client_email: "client@example.com",
    amount_cents: 14900, cleaner_name: "Taylor Allen", cleaner_id: "cleaner-1",
    cleaner_profile: null, access_notes: null, no_photo_zones: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [makeRow()];
  events = [created, confirmed];
  accessRows = [];
  storeMeta = { gh_booking_id: BID, gh_state: "card_ready", gh_first_price_cents: "14900" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") return okRes({ id: "email-1" });
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        return okRes({ data: [{ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta }] });
      }
      if (u.pathname.endsWith("/payment_methods")) return okRes({ data: [] });
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (custM) {
        if (init?.body) {
          const params = new URLSearchParams(String(init.body));
          for (const [k, v] of params.entries()) {
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) storeMeta[m[1]] = v;
          }
          return okRes({ id: "cus_v" });
        }
        return okRes({ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta });
      }
      return okRes({ id: "cus_v" });
    }
    if (u.pathname.includes("/rest/v1/gh_visit_access")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Acc;
        const row = { id: `acc-${accessRows.length + 1}`, ...body };
        accessRows.push(row);
        return okRes([row]);
      }
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Acc;
        const qId = u.searchParams.get("id");
        const matched: Acc[] = [];
        for (const r of accessRows) if (qId === `eq.${r["id"]}`) { Object.assign(r, patch); matched.push(r); }
        return okRes(matched);
      }
      if (method === "DELETE") {
        const qVid = u.searchParams.get("visit_id");
        const deleted = accessRows.filter((r) => qVid === `eq.${r["visit_id"]}`);
        accessRows = accessRows.filter((r) => qVid !== `eq.${r["visit_id"]}`);
        return okRes(deleted);
      }
      const qVid = u.searchParams.get("visit_id");
      let out = [...accessRows];
      if (qVid && qVid.startsWith("eq.")) out = out.filter((r) => r["visit_id"] === decodeURIComponent(qVid.slice(3)));
      return okRes(out.slice(0, 1));
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
        const matched: Row[] = [];
        for (const r of rows) {
          const qId = u.searchParams.get("id");
          if (qId && qId === `eq.${r["id"]}`) { Object.assign(r, patch); matched.push(r); }
        }
        return okRes(matched);
      }
      return okRes([...rows].slice(0, 1));
    }
    if (u.pathname.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { event?: string; detail?: Record<string, unknown> | null };
        events.push({ event: body.event ?? "", detail: body.detail ?? null, created_at: new Date().toISOString() });
        return okRes([{ id: events.length }]);
      }
      const out = [...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return okRes(out);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const bt = () => signBooking("link-secret", { bid: BID, email: "client@example.com", name: "Casey Client", date: "2027-01-15" }).token;
const call = async (method: "GET" | "POST", body?: Record<string, unknown>) => {
  const r = res();
  await visitHandler(
    method === "GET"
      ? { method, headers: {}, query: { bt: bt() } }
      : { method, headers: {}, body: { bt: bt(), ...body } },
    r as never,
  );
  return r;
};

describe("visit entry API", () => {
  it("GET before confirmation hides the entry block", async () => {
    events = [created];
    const r = await call("GET");
    expect(r.body["entry_available"]).toBe(false);
    expect((r.body["entry"] as Record<string, unknown>)["method"]).toBe(null);
  });

  it("GET after confirmation offers entry, with no secret echoed", async () => {
    const r = await call("GET");
    expect(r.body["entry_available"]).toBe(true);
    expect((r.body["entry"] as Record<string, unknown>)["has_secret"]).toBe(false);
    expect(r.body["entry"]).not.toHaveProperty("secret");
  });

  it("home/someone with a secret is rejected, nothing stored", async () => {
    const r = await call("POST", { action: "save_entry", method: "home", note: "", secret: "1234" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("secret_not_needed");
    expect(accessRows).toHaveLength(0);
  });

  it("arrange with a secret saves encrypted, never in Stripe meta or the row", async () => {
    const r = await call("POST", { action: "save_entry", method: "arrange", note: "Intercom at gate", secret: "guest-7788" });
    expect(r.code).toBe(200);
    expect(r.body["entry_saved"]).toBe(true);
    const entry = r.body["entry"] as Record<string, unknown>;
    expect(entry["method"]).toBe("arrange");
    expect(entry["has_secret"]).toBe(true);
    expect(entry).not.toHaveProperty("secret");
    expect(accessRows).toHaveLength(1);
    expect(String(accessRows[0]["entry_secret"])).not.toContain("guest-7788");
    expect(decryptEntrySecret(String(accessRows[0]["entry_secret"]))).toBe("guest-7788");
    expect(storeMeta["gh_access_notes"]).toBeUndefined();
    expect(rows[0]["access_notes"]).toBe(null);
    expect(events.some((e) => e.event === "entry_saved")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("guest-7788");
  });

  it("arrange without a secret is Add later: method saved, has_secret false", async () => {
    const r = await call("POST", { action: "save_entry", method: "arrange", note: "", secret: "" });
    expect(r.code).toBe(200);
    expect((r.body["entry"] as Record<string, unknown>)["method"]).toBe("arrange");
    expect((r.body["entry"] as Record<string, unknown>)["has_secret"]).toBe(false);
  });

  it("delete_entry clears the arrangement", async () => {
    await call("POST", { action: "save_entry", method: "someone", note: "", secret: "" });
    expect(accessRows).toHaveLength(1);
    const r = await call("POST", { action: "delete_entry" });
    expect(r.code).toBe(200);
    expect(accessRows).toHaveLength(0);
    expect((r.body["entry"] as Record<string, unknown>)["method"]).toBe(null);
  });

  it("save_entry before confirmation is 409", async () => {
    events = [created];
    const r = await call("POST", { action: "save_entry", method: "home", note: "", secret: "" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("entry_not_available");
  });

  it("cancel deletes the entry row", async () => {
    await call("POST", { action: "save_entry", method: "arrange", note: "", secret: "guest-1" });
    expect(accessRows).toHaveLength(1);
    const r = await call("POST", { action: "cancel", scope: "once" });
    expect(r.code).toBe(200);
    expect(accessRows).toHaveLength(0);
  });
});

describe("cleaner entry visibility gates", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "a1", visit_id: VISIT_ID, booking_id: BID, entry_method: "arrange" as const,
    entry_note: "Intercom", entry_secret: encryptEntrySecret("guest-7788"),
    assigned_cleaner_id: "cleaner-1", expires_at: entryExpiresAt("2027-01-15"),
    ...over,
  });
  const visit = { status: "confirmed", report_status: "none", cleaner_id: "cleaner-1" };
  it("matching roster id sees the decrypted secret", () => {
    expect(cleanerEntryView(row(), visit, true)?.secret).toBe("guest-7788");
  });
  it("same name, different cleaner_id sees nothing", () => {
    expect(cleanerEntryView(row(), { ...visit, cleaner_id: "cleaner-2" }, true)).toBe(null);
  });
  it("name-only assignment sees nothing", () => {
    expect(cleanerEntryView(row(), { ...visit, cleaner_id: null }, true)).toBe(null);
  });
  it("cancelled or finished visits see nothing", () => {
    expect(cleanerEntryView(row(), { ...visit, status: "cancelled" }, true)).toBe(null);
    expect(cleanerEntryView(row(), { ...visit, report_status: "sent" }, true)).toBe(null);
  });
  it("unconfirmed visits see nothing", () => {
    expect(cleanerEntryView(row(), visit, false)).toBe(null);
  });
  it("expiry is visit date + 2 days", () => {
    expect(entryExpiresAt("2027-01-15")).toBe("2027-01-17T12:00:00.000Z");
  });
});

describe("visit entry choice (quote-time preference)", () => {
  it("GET returns the booking entry choice", async () => {
    rows[0]["entry_method"] = "arrange_before";
    rows[0]["entry_detail"] = "lockbox";
    rows[0]["entry_notes"] = "Park in driveway";
    const r = await call("GET");
    expect(r.body["entry_choice"]).toEqual({
      method: "arrange_before", detail: "lockbox", notes: "Park in driveway",
    });
  });

  it("save_entry syncs the row method and notes", async () => {
    const r = await call("POST", { action: "save_entry", method: "home", note: "Intercom at gate", secret: "" });
    expect(r.code).toBe(200);
    expect(rows[0]["entry_method"]).toBe("home");
    expect(rows[0]["entry_notes"]).toBe("Intercom at gate");
    expect((r.body["entry_choice"] as Record<string, unknown>)["method"]).toBe("home");
  });

  it("save_entry arrange keeps the quote detail", async () => {
    rows[0]["entry_detail"] = "lockbox";
    const r = await call("POST", { action: "save_entry", method: "arrange", note: "", secret: "", secret_action: "keep" });
    expect(r.code).toBe(200);
    expect(rows[0]["entry_method"]).toBe("arrange_before");
    expect(rows[0]["entry_detail"]).toBe("lockbox");
  });

  it("set_entry_choice decide_later clears the secret and sets the row", async () => {
    await call("POST", { action: "save_entry", method: "arrange", note: "", secret: "guest-1" });
    expect(accessRows).toHaveLength(1);
    const r = await call("POST", { action: "set_entry_choice", method: "decide_later" });
    expect(r.code).toBe(200);
    expect(accessRows).toHaveLength(0);
    expect(rows[0]["entry_method"]).toBe("decide_later");
    expect(rows[0]["entry_detail"]).toBe(null);
    expect(events.some((e) => e.event === "entry_choice_changed")).toBe(true);
  });

  it("set_entry_choice rejects other methods", async () => {
    const r = await call("POST", { action: "set_entry_choice", method: "home" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_entry_choice");
  });

  it("set_entry_choice before confirmation is 409", async () => {
    events = [created];
    const r = await call("POST", { action: "set_entry_choice", method: "decide_later" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("entry_not_available");
  });
});
