// @vitest-environment node
// M7: a report photo whose signed URL cannot be minted must NOT be
// silently dropped — it stays in photo_items as unavailable (url null)
// with photos_partial=true, so the client sees 7/8 WITH the
// explanation instead of 7/8 with no word at all.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import reportHandler from "../../api/report";
import { signBooking } from "../../api/create-checkout-session";

const BID = "bid-m7-1";
const EMAIL = "client@example.com";
const ROW_ID = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

let photos: Row[];
let failSignFor: string | null;

function res() {
  return {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(), end: vi.fn(),
  };
}

const customer = {
  id: "cus_m7_1", email: EMAIL, name: "Casey Client",
  metadata: {
    gh_booking_id: BID, gh_state: "card_ready", gh_payment_method: "pm_m7_1",
    gh_first_price_cents: "18900",
  },
};

const visitRow = (): Row => ({
  id: ROW_ID, booking_id: BID, status: "report_sent", amount_cents: 18900,
  report_sent_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
  report_status: "sent", report_bounced: false, issue_open: false, issue_ever: false,
  visit_date: "2026-11-10", window: "midday", cleaner_name: "Ana Torres",
  client_email: EMAIL, client_name: "Casey Client",
});

const photoRows = (): Row[] => [
  { id: "ph0", visit_id: ROW_ID, room: "Kitchen", kind: "before", storage_path: "r/kitchen-before.jpg", note: null },
  { id: "ph1", visit_id: ROW_ID, room: "Kitchen", kind: "after", storage_path: "r/kitchen-after.jpg", note: null },
  { id: "ph2", visit_id: ROW_ID, room: "Bathrooms", kind: "after", storage_path: "r/bath-after.jpg", note: null },
];

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  photos = photoRows();
  failSignFor = "r/bath-after.jpg";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) return okRes({ data: [customer] });
      const custM = u.pathname.match(/^\/v1\/customers\/(cus_[A-Za-z0-9_]+)$/);
      if (custM) return okRes({ ...customer });
      return okRes({ data: [] });
    }
    if (u.hostname.includes("supabase")) {
      // Storage signing: one object fails (expired / deleted / 500).
      if (u.pathname.includes("/object/sign/")) {
        if (failSignFor && u.pathname.includes(failSignFor)) {
          return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" };
        }
        return okRes({ signedURL: `/signed${u.pathname.split("/object/sign/")[1]}` });
      }
      const table = u.pathname.split("/").pop() ?? "";
      if ((init?.method ?? "GET").toUpperCase() === "GET") {
        if (table === "gh_visits") return okRes([visitRow()]);
        if (table === "gh_events") return okRes([]);
        if (table === "gh_photos") return okRes(photos);
        return okRes([]);
      }
      return okRes([]);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const getReport = async () => {
  const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
  const r = res();
  await (reportHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { method: "GET", headers: {}, query: { bt } }, r as never,
  );
  return r;
};

describe("M7 report photo signing failure", () => {
  it("keeps the failed photo as unavailable instead of dropping it, and flags partial load", async () => {
    const r = await getReport();
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("awaiting");
    const items = r.body["photo_items"] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    // The two signed photos are intact.
    expect(items[0]["url"]).toContain("kitchen-before");
    expect(items[1]["url"]).toContain("kitchen-after");
    // The failed one is present, marked, with no URL — not dropped.
    expect(items[2]["room"]).toBe("Bathrooms");
    expect(items[2]["kind"]).toBe("after");
    expect(items[2]["url"]).toBeNull();
    expect(items[2]["unavailable"]).toBe(true);
    // The legacy photos[] list only carries viewable URLs.
    expect(r.body["photos"]).toHaveLength(2);
    // Partial-load flag + count for the honest client note.
    expect(r.body["photos_partial"]).toBe(true);
    expect(r.body["photos_unavailable"]).toBe(1);
  });

  it("healthy signing: no partial flag, all photos viewable", async () => {
    failSignFor = null;
    const r = await getReport();
    expect(r.code).toBe(200);
    const items = r.body["photo_items"] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items.every((p) => typeof p["url"] === "string" && !p["unavailable"])).toBe(true);
    expect(r.body["photos"]).toHaveLength(3);
    expect(r.body["photos_partial"]).toBe(false);
    expect(r.body["photos_unavailable"]).toBe(0);
  });
});
