// @vitest-environment node
// H5: re-clean without entry — after a report is sent the cleaner has
// no lock code (deleteAccess removes the access row). Entry must
// reopen for a scheduled re-clean: the client re-saves it on /visit
// (bound to the re-clean cleaner/date) and the cleaner sees it again
// — but only a FRESH row (saved after the re-clean was arranged).
// A leftover row from the original visit never re-exposes the old
// secret, and a re-clean report already submitted closes entry again.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import visitHandler from "../../api/visit";
import { signBooking } from "../../api/create-checkout-session";
import { cleanerEntryView, encryptEntrySecret } from "../../api/_visit_access";

const BID = "bid-h5";
const VISIT_ID = "77777777-8888-9999-0000-111111111111";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };
type Acc = Record<string, unknown>;

const ARRANGED_AT = "2026-11-18T15:00:00.000Z";
const SECRET = "test-lockbox-4321";

describe("H5: cleanerEntryView reopens entry for a scheduled re-clean", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", "adm-" + "secret");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const accessRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "acc-1",
    visit_id: VISIT_ID,
    booking_id: BID,
    entry_method: "arrange",
    entry_note: "Lockbox by the door",
    entry_secret: encryptEntrySecret(SECRET),
    assigned_cleaner_id: "cleaner-reclean",
    expires_at: "2026-11-27T12:00:00.000Z",
    created_at: "2026-11-17T10:00:00.000Z",
    updated_at: "2026-11-18T17:00:00.000Z",
    ...over,
  });
  const sentVisit = {
    status: "confirmed", report_status: "sent", cleaner_id: "cleaner-original",
    reclean: { status: "scheduled", cleanerId: "cleaner-reclean", arrangedAt: ARRANGED_AT },
  };
  const revokeEvents = [
    { event: "report_submitted", created_at: "2026-11-18T12:00:00.000Z" },
  ];

  it("shows the fresh re-clean entry to the re-clean cleaner (secret included)", () => {
    const out = cleanerEntryView(accessRow() as never, sentVisit, true, revokeEvents);
    expect(out).not.toBeNull();
    expect(out?.secret).toBe(SECRET);
    expect(out?.method).toBe("arrange");
  });

  it("hides a stale row saved before the re-clean was arranged", () => {
    const out = cleanerEntryView(
      accessRow({ updated_at: "2026-11-18T10:00:00.000Z", created_at: "2026-11-17T10:00:00.000Z" }) as never,
      sentVisit, true, revokeEvents,
    );
    expect(out).toBeNull();
  });

  it("hides the entry once the re-clean report is submitted", () => {
    const out = cleanerEntryView(accessRow() as never, sentVisit, true, [
      { event: "report_submitted", created_at: "2026-11-18T12:00:00.000Z" },
      { event: "report_submitted", created_at: "2026-11-18T18:00:00.000Z" },
    ]);
    expect(out).toBeNull();
  });

  it("hides the entry from the ORIGINAL cleaner when the re-clean has a different one", () => {
    const out = cleanerEntryView(
      accessRow({ assigned_cleaner_id: "cleaner-original" }) as never,
      sentVisit, true, revokeEvents,
    );
    expect(out).toBeNull();
  });

  it("still hides entry for a sent report with no re-clean scheduled", () => {
    const out = cleanerEntryView(accessRow() as never, {
      status: "confirmed", report_status: "sent", cleaner_id: "cleaner-original", reclean: null,
    }, true, revokeEvents);
    expect(out).toBeNull();
  });
});

describe("H5: the client re-saves entry on /visit for a scheduled re-clean", () => {
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

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T00:00:00Z"));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
    vi.stubEnv("ADMIN_TOKEN", "adm-" + "secret");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows = [{
      id: VISIT_ID, booking_id: BID, visit_no: 1, status: "confirmed",
      report_status: "sent", report_sent_at: "2026-11-18T12:00:00.000Z", report_bounced: false,
      visit_date: "2027-01-15", window: "midday", service: "Standard cleaning",
      client_name: "Casey Client", client_email: "client@example.com",
      amount_cents: 14900, cleaner_name: "Taylor Allen", cleaner_id: "cleaner-original",
      cleaner_profile: null, access_notes: null, no_photo_zones: null,
      reclean_status: "scheduled", reclean_date: "2026-11-25", reclean_cleaner_id: "cleaner-reclean",
      reclean_cleaner_name: "Rita Reclean",
    }];
    events = [
      ev("visit_created", {}, "2026-10-20T10:00:00.000Z"),
      ev("visit_confirmed", { date: "2027-01-15", window: "midday" }, "2026-10-23T10:00:00.000Z"),
      ev("report_sent", { version: 1, email_sent: true }, "2026-11-18T12:00:00.000Z"),
      ev("issue_opened", { reason: "Missed a spot" }, "2026-11-18T14:00:00.000Z"),
      ev("issue_decision", { decision: "reclean", resolution: "We will re-clean.", decided_at: ARRANGED_AT }, ARRANGED_AT),
      ev("issue_resolved", { reclean_date: "2026-11-25" }, "2026-11-18T15:00:00.000Z"),
    ];
    accessRows = [];
    storeMeta = { gh_booking_id: BID, gh_state: "report_sent", gh_first_price_cents: "14900" };
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
          const row = { id: `acc-${accessRows.length + 1}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...body };
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
          accessRows = accessRows.filter((r) => qVid !== `eq.${r["visit_id"]}`);
          return okRes([]);
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

  it("entry is available again on /visit while the re-clean is scheduled", async () => {
    const r = res();
    await visitHandler({ method: "GET", headers: {}, query: { bt: bt() } } as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["entry_available"]).toBe(true);
  });

  it("entry stays closed on /visit once the re-clean report is submitted", async () => {
    events.push(ev("report_submitted", {}, "2026-11-18T18:00:00.000Z"));
    const r = res();
    await visitHandler({ method: "GET", headers: {}, query: { bt: bt() } } as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["entry_available"]).toBe(false);
  });

  it("save_entry for the re-clean binds to the re-clean cleaner and date", async () => {
    const r = res();
    await visitHandler({
      method: "POST", headers: {},
      body: { bt: bt(), action: "save_entry", method: "arrange", note: "Lockbox by the door", secret: "4321", secret_action: "replace" },
    } as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["entry_saved"]).toBe(true);
    expect(accessRows).toHaveLength(1);
    expect(accessRows[0]["assigned_cleaner_id"]).toBe("cleaner-reclean");
    // Expires with the re-clean date (2026-11-25 + 2 days), not the original visit.
    expect(String(accessRows[0]["expires_at"] ?? "")).toContain("2026-11-27");
    expect(accessRows[0]["entry_secret"]).toBeTruthy();
  });
});
