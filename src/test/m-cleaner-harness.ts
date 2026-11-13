// @vitest-environment node
// Shared fetch-mock harness for the M1/M2/M3/M4/M6 cleaner tests.
// Simulates Supabase REST (gh_visits / gh_events / gh_photos /
// gh_visit_access) with real filter semantics for the predicates the
// cleaner handler uses (eq / in.(...) / neq.true), plus Stripe
// customer search/get/post and Resend. NOT a test file itself.
import { vi } from "vitest";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";
import cleanerHandler from "../../api/cleaner";

export const SECRET = "test-cleaner-secret-123";
export const VISIT_ID = "33333333-4444-5555-6666-777777777777";
export const BID = "bid-m-top5";
export const ISSUANCE = "aabbccddeeff00112233445566778899";

export type Row = Record<string, unknown>;
export type Evt = {
  visit_id: string | null;
  event: string;
  actor?: string;
  detail?: Record<string, unknown>;
  created_at: string;
};

export const SCOPE_ROOMS = ["Kitchen", "Bathroom", "Bedroom", "Living room"];

export function scopeChecklist() {
  return {
    rooms: SCOPE_ROOMS.map((name) => ({
      name,
      items: [{ label: "Cleaned as agreed", done: false }],
    })),
  };
}

export function makeRow(overrides: Row = {}): Row {
  return {
    id: VISIT_ID,
    booking_id: BID,
    visit_no: 1,
    status: "confirmed",
    report_status: "draft",
    visit_date: "2026-11-10",
    window: "midday",
    address: "123 Secret St, Sugar Hill, GA",
    service: "Standard cleaning",
    client_name: "Casey Client",
    client_email: "client@example.com",
    cleaner_name: "Ana",
    cleaner_token_hash: null,
    cleaner_token_expires: null,
    cleaner_link_version: null,
    cleaner_link_issuance: null,
    checklist: scopeChecklist(),
    issue_open: false,
    issue_ever: false,
    amount_cents: 149,
    updated_at: "2026-11-13T10:00:00.000Z",
    ...overrides,
  };
}

export function makePhotos() {
  const photos: Row[] = [];
  for (const room of SCOPE_ROOMS) {
    for (const kind of ["before", "after"]) {
      photos.push({
        id: `${room}-${kind}`,
        room,
        kind,
        storage_path: `visits/${VISIT_ID}/${room}/${kind}.jpg`,
        note: null,
        created_at: "2026-11-13T10:00:00.000Z",
      });
    }
  }
  return photos;
}

export type Env = {
  rows: Row[];
  events: Evt[];
  photos: Row[];
  stripePosts: Array<Record<string, string>>;
  resendCalls: Array<{ subject: string; to: unknown }>;
  customerMeta: Record<string, string>;
  onStripeSearch: (() => void) | null;
  token: string;
  call: (body: Record<string, unknown>) => Promise<{ code: number; body: Record<string, unknown> }>;
  get: () => Promise<{ code: number; body: Record<string, unknown> }>;
};

function res() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      this.body = body;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end: vi.fn(),
  };
}

export function createEnv(opts: {
  row?: Row;
  events?: Evt[];
  photos?: Row[];
  customerMeta?: Record<string, string>;
} = {}): Env {
  const rows = [makeRow(opts.row)];
  const events: Evt[] = opts.events ?? [
    {
      visit_id: VISIT_ID,
      event: "visit_confirmed",
      detail: { date: "2026-11-10", window: "midday" },
      created_at: "2026-11-10T10:00:00.000Z",
    },
  ];
  const photos = opts.photos ?? [];
  const stripePosts: Array<Record<string, string>> = [];
  const resendCalls: Array<{ subject: string; to: unknown }> = [];
  const customerMeta: Record<string, string> = {
    gh_first_price_cents: "149",
    gh_report_version: "0",
    ...(opts.customerMeta ?? {}),
  };
  const env: Env = {
    rows,
    events,
    photos,
    stripePosts,
    resendCalls,
    customerMeta,
    onStripeSearch: null,
    token: "",
    call: async () => ({ code: 0, body: {} }),
    get: async () => ({ code: 0, body: {} }),
  };

  let patchCount = 0;
  const supRes = (data: unknown, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });

  // PostgREST filter evaluation for the predicates cleaner.ts uses.
  const matchFilter = (row: Row, qs: URLSearchParams): boolean => {
    for (const [k, v] of qs.entries()) {
      if (k === "limit" || k === "offset" || k === "order" || k === "select") continue;
      const val = row[k];
      if (v.startsWith("eq.")) {
        if (String(val ?? "") !== decodeURIComponent(v.slice(3))) return false;
      } else if (v.startsWith("neq.")) {
        if (String(val ?? "") === decodeURIComponent(v.slice(4))) return false;
      } else if (v.startsWith("in.(") && v.endsWith(")")) {
        const opts = v.slice(4, -1).split(",");
        if (!opts.includes(String(val ?? ""))) return false;
      } else if (v === "is.false") {
        if (val !== false) return false;
      } else if (v === "is.true") {
        if (val !== true) return false;
      } else if (v === "not.is.true") {
        if (val === true) return false;
      }
    }
    return true;
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();

      // --- Stripe ---
      if (u.startsWith("https://api.stripe.com/v1/customers/search")) {
        if (env.onStripeSearch) env.onStripeSearch();
        return supRes({ data: [{ id: "cus_test", email: "client@example.com", name: "Casey Client", metadata: { ...customerMeta } }] });
      }
      if (u.startsWith("https://api.stripe.com/v1/customers/cus_test")) {
        if (method === "POST") {
          const params = new URLSearchParams(String(init?.body ?? ""));
          const patch: Record<string, string> = {};
          for (const [k, v] of params.entries()) {
            patch[k] = v;
            const m = k.match(/^metadata\[(.+)\]$/);
            if (m) customerMeta[m[1]] = v;
          }
          stripePosts.push(patch);
          return supRes({ id: "cus_test" });
        }
        return supRes({ id: "cus_test", email: "client@example.com", name: "Casey Client", metadata: { ...customerMeta } });
      }

      // --- Resend ---
      if (u === "https://api.resend.com/emails" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { subject?: string; to?: unknown };
        resendCalls.push({ subject: body.subject ?? "", to: body.to });
        return supRes({ id: "re_test123" });
      }

      // --- Supabase REST ---
      if (u.includes("/rest/v1/gh_visits")) {
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          const matched = rows.filter((r) => matchFilter(r, qs));
          for (const r of matched) {
            Object.assign(r, patch);
            patchCount++;
            // A fresh updated_at per write, strictly later than the
            // previous one, so revision changes are observable.
            r["updated_at"] = new Date(Date.now() + patchCount * 1000).toISOString();
          }
          return supRes(matched);
        }
        const out = rows.filter((r) => matchFilter(r, qs));
        const limit = Number(qs.get("limit") ?? "0");
        return supRes(limit > 0 ? out.slice(0, limit) : out);
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Evt;
          events.push({ ...body, created_at: new Date().toISOString() });
          return supRes([{ id: events.length }]);
        }
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        let out = [...events];
        const ev = qs.get("event");
        if (ev && ev.startsWith("eq.")) out = out.filter((e) => e.event === decodeURIComponent(ev.slice(3)));
        if (ev && ev.startsWith("in.(")) {
          const names = ev.slice(4, -1).split(",").map((s) => s.trim());
          out = out.filter((e) => names.includes(e.event));
        }
        out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        const limit = Number(qs.get("limit") ?? "0");
        return supRes(limit > 0 ? out.slice(0, limit) : out);
      }
      if (u.includes("/rest/v1/gh_photos")) {
        return supRes(photos);
      }
      // gh_visit_access, storage, anything else: empty.
      return supRes([]);
    }),
  );

  const token = mintCleanerLinkV2(SECRET, VISIT_ID, ISSUANCE);
  rows[0]["cleaner_token_hash"] = hashToken(token);
  rows[0]["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
  rows[0]["cleaner_link_version"] = "v2";
  rows[0]["cleaner_link_issuance"] = ISSUANCE;
  env.token = token;

  env.call = async (body: Record<string, unknown>) => {
    const r = res();
    await cleanerHandler({ method: "POST", body: { ct: token, ...body } } as never, r as never);
    return r;
  };
  env.get = async () => {
    const r = res();
    await cleanerHandler({ method: "GET", query: { ct: token } } as never, r as never);
    return r;
  };
  return env;
}

export function installEnv(opts: Parameters<typeof createEnv>[0] = {}): Env {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("BOOKING_LINK_SECRET", SECRET);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return createEnv(opts);
}
