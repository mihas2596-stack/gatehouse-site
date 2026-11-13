// @vitest-environment node
// H5 (owner path): when the client cannot re-save entry themselves,
// the owner sets the re-clean entry code (received by phone/text) as
// an encrypted secret. Only for a scheduled re-clean; the secret is
// never logged, never mirrored to Stripe metadata, never returned.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";
import { decryptEntrySecret } from "../../api/_visit_access";

const TOKEN = "adm-" + "secret";
const VISIT_ID = "88888888-9999-0000-1111-222222222222";
const BID = "bid-h5-owner";
const ARRANGED_AT = "2026-11-18T15:00:00.000Z";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };
type Acc = Record<string, unknown>;

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

const CUSTOMER = {
  id: "cus_test_h5",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "report_sent" },
};

describe("H5: owner sets the re-clean entry code (encrypted)", () => {
  let rows: Row[];
  let events: Ev[];
  let accessRows: Acc[];
  let stripeBodies: string[];

  const ev = (event: string, detail: Record<string, unknown> | null, created_at: string): Ev =>
    ({ event, detail, created_at });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T00:00:00Z"));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows = [{
      id: VISIT_ID,
      booking_id: BID,
      visit_no: 1,
      status: "confirmed",
      report_status: "sent",
      report_sent_at: "2026-11-18T12:00:00.000Z",
      visit_date: "2027-01-15",
      window: "midday",
      cleaner_name: "Taylor Allen",
      cleaner_id: "cleaner-original",
      amount_cents: 14900,
      client_email: "client@example.com",
      client_name: "Casey Client",
      reclean_status: "scheduled",
      reclean_date: "2026-11-25",
      reclean_cleaner_id: "cleaner-reclean",
      reclean_cleaner_name: "Rita Reclean",
    }];
    events = [
      ev("visit_confirmed", { date: "2027-01-15", window: "midday" }, "2026-11-17T10:00:00.000Z"),
      ev("report_sent", { version: 1, email_sent: true }, "2026-11-18T12:00:00.000Z"),
      ev("issue_opened", { reason: "Missed a spot" }, "2026-11-18T14:00:00.000Z"),
      ev("issue_decision", { decision: "reclean", resolution: "We will re-clean.", decided_at: ARRANGED_AT }, ARRANGED_AT),
      ev("issue_resolved", { reclean_date: "2026-11-25" }, "2026-11-18T15:00:00.000Z"),
    ];
    accessRows = [];
    stripeBodies = [];
    const supRes = (data: unknown, ok = true, status = 200) => ({
      ok, status,
      json: async () => data,
      text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("api.stripe.com")) {
        if (init?.body) stripeBodies.push(String(init.body));
        if (u.includes("/customers/search")) return supRes({ data: [{ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } }] });
        if (u.includes(`/customers/${CUSTOMER.id}`) && method === "GET") return supRes({ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } });
        return supRes({ id: CUSTOMER.id });
      }
      if (u.includes("api.resend.com")) return supRes({ id: "email-1" });
      if (u.includes("/rest/v1/gh_visit_access")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Acc;
          const row = { id: `acc-${accessRows.length + 1}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...body };
          accessRows.push(row);
          return supRes([row]);
        }
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Acc;
          const qId = new URL(u).searchParams.get("id");
          const matched: Acc[] = [];
          for (const r of accessRows) if (qId === `eq.${r["id"]}`) { Object.assign(r, patch); matched.push(r); }
          return supRes(matched);
        }
        if (method === "DELETE") {
          const qVid = new URL(u).searchParams.get("visit_id");
          accessRows = accessRows.filter((r) => qVid !== `eq.${r["visit_id"]}`);
          return supRes([]);
        }
        const qVid = new URL(u).searchParams.get("visit_id");
        let out = [...accessRows];
        if (qVid && qVid.startsWith("eq.")) out = out.filter((r) => r["visit_id"] === decodeURIComponent(qVid.slice(3)));
        return supRes(out.slice(0, 1));
      }
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          for (const r of rows) Object.assign(r, patch);
          return supRes(rows);
        }
        return supRes(rows.slice(0, 1));
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          events.push({ event: String(body["event"] ?? ""), detail: (body["detail"] as Record<string, unknown> | null) ?? null, created_at: new Date().toISOString() });
          return supRes([{ id: events.length }]);
        }
        return supRes([...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 60));
      }
      return supRes({}, false, 404);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const call = async (body: Record<string, unknown>) => {
    const r = res();
    await bookingAction(
      { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body } as never,
      r as never,
    );
    return r;
  };

  it("stores the code encrypted, bound to the re-clean cleaner and date", async () => {
    const r = await call({ action: "set_access_secret", booking_id: BID, secret: "9876", note: "Lockbox by the door" });
    expect(r.body["ok"]).toBe(true);
    expect(r.body["entry_saved"]).toBe(true);
    expect(accessRows).toHaveLength(1);
    expect(accessRows[0]["assigned_cleaner_id"]).toBe("cleaner-reclean");
    expect(String(accessRows[0]["expires_at"] ?? "")).toContain("2026-11-27");
    expect(decryptEntrySecret(String(accessRows[0]["entry_secret"] ?? ""))).toBe("9876");
    // The secret never appears in a response, a Stripe call, or a journal event.
    expect(JSON.stringify(r.body)).not.toContain("9876");
    expect(stripeBodies.join(" ")).not.toContain("9876");
    expect(JSON.stringify(events.map((e) => e.detail))).not.toContain("9876");
    expect(events.some((e) => e.event === "entry_secret_set")).toBe(true);
  });

  it("refuses when no re-clean is scheduled", async () => {
    rows[0]["reclean_status"] = null;
    events = events.filter((e) => e.event !== "issue_decision" && e.event !== "issue_resolved");
    const r = await call({ action: "set_access_secret", booking_id: BID, secret: "9876" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("no_reclean_scheduled");
    expect(accessRows).toHaveLength(0);
  });

  it("requires a secret", async () => {
    const r = await call({ action: "set_access_secret", booking_id: BID, secret: "   " });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("secret_required");
    expect(accessRows).toHaveLength(0);
  });
});
