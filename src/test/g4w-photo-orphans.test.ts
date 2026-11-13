// @vitest-environment node
// M5 (orphan photos) + L3 (atomic photo_register, room validation):
// - photo_sign caps unregistered uploads per visit (Storage list minus
//   registered rows), failing open when Storage cannot be listed;
// - photo_register validates the room against the work scope, claims
//   the row atomically (upsert on storage_path), and retries a failed
//   registration with backoff instead of stranding the bytes;
// - the periodic cleanup deletes old unregistered objects only for
//   clean visits (never disputed, never unreadable), and never
//   touches registered or young objects.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  countUnregisteredObjects,
  selectOrphanPhotos,
  cleanupOrphanPhotos,
  storageListObjects,
  ORPHAN_MIN_AGE_MS,
} from "../../api/storage-cleanup";
import storageCleanupHandler from "../../api/storage-cleanup";
import cleanerHandler from "../../api/cleaner";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";

const SECRET = "test-cleaner-secret-123";
const VISIT_ID = "33333333-4444-5555-6666-777777777777";
const BID = "bid-g4w-photo";
const ISSUANCE = "aabbccddeeff00112233445566778899";
const SCOPE_ROOMS = ["Kitchen", "Bathroom", "Bedroom", "Living room"];

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

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

describe("M5 pure helpers", () => {
  it("countUnregisteredObjects counts listed paths with no registered row", () => {
    const listed = [
      { path: "visits/v/kitchen/a.jpg", updatedAt: hoursAgo(30) },
      { path: "visits/v/kitchen/b.jpg", updatedAt: hoursAgo(30) },
      { path: "visits/v/bathroom/c.jpg", updatedAt: hoursAgo(30) },
    ];
    expect(countUnregisteredObjects(listed, ["visits/v/kitchen/a.jpg"])).toBe(2);
    expect(countUnregisteredObjects(listed, listed.map((o) => o.path))).toBe(0);
  });

  it("selectOrphanPhotos keeps only old, unregistered objects", () => {
    const listed = [
      { path: "visits/v/kitchen/old.jpg", updatedAt: hoursAgo(30) },
      { path: "visits/v/kitchen/young.jpg", updatedAt: hoursAgo(1) },
      { path: "visits/v/kitchen/registered.jpg", updatedAt: hoursAgo(30) },
      { path: "visits/v/kitchen/nodate.jpg", updatedAt: null },
    ];
    const out = selectOrphanPhotos(listed, ["visits/v/kitchen/registered.jpg"], Date.now());
    expect(out.map((o) => o.path)).toEqual(["visits/v/kitchen/old.jpg"]);
  });

  it("an object exactly at the 24h line counts as abandoned", () => {
    const now = Date.now();
    const listed = [{ path: "visits/v/kitchen/edge.jpg", updatedAt: new Date(now - ORPHAN_MIN_AGE_MS).toISOString() }];
    expect(selectOrphanPhotos(listed, [], now).length).toBe(1);
  });
});

// ---------- cleaner-handler stub (photo_sign / photo_register) ----------

type PhotoRow = { id: string; room: string; kind: string; storage_path: string; note: string | null; created_at: string };
type ListEntry = { name: string; id?: string | null; updated_at?: string | null; metadata?: { size: number } | null };

function scopeChecklist() {
  return { rooms: SCOPE_ROOMS.map((name) => ({ name, items: [{ label: "Cleaned as agreed", done: false }] })) };
}

function makeCleanerEnv(opts: {
  photos?: PhotoRow[];
  listEntries?: Record<string, ListEntry[]>;
  listFails?: boolean;
  upsert?: "ok" | "no-constraint" | "fail-once";
  insertFails?: number;
  plantWinnerOnFirstInsert?: boolean;
} = {}) {
  const photos: PhotoRow[] = opts.photos ?? [];
  const listEntries = opts.listEntries ?? {};
  let upsertCalls = 0;
  let insertCalls = 0;
  let photoSeq = 0;
  const row: Record<string, unknown> = {
    id: VISIT_ID, booking_id: BID, visit_no: 1, status: "confirmed", report_status: "draft",
    visit_date: "2026-11-10", window: "midday", address: "1 Test St", service: "Standard cleaning",
    client_name: "Casey Client", client_email: "client@example.com",
    cleaner_token_hash: null, cleaner_token_expires: null, cleaner_link_version: null, cleaner_link_issuance: null,
    checklist: scopeChecklist(), issue_open: false, issue_ever: false, amount_cents: 149,
    no_photo_zones: null, updated_at: "2026-11-13T10:00:00.000Z",
  };
  const events: Array<Record<string, unknown>> = [
    { visit_id: VISIT_ID, event: "visit_confirmed", detail: { date: "2026-11-10", window: "midday" }, created_at: "2026-11-10T10:00:00.000Z" },
  ];
  const supRes = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    headers: { get: () => null },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: unknown }) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    // Storage: signed upload, list, HEAD info, delete.
    if (u.includes("/storage/v1/object/upload/sign/")) return supRes({ url: "/object/upload/sign/x" });
    if (u.includes("/storage/v1/object/list/")) {
      if (opts.listFails) return supRes({ message: "boom" }, 500);
      const body = JSON.parse(String(init?.body ?? "{}")) as { prefix?: string };
      return supRes(listEntries[body.prefix ?? ""] ?? []);
    }
    if (u.includes("/storage/v1/object/report-photos/")) {
      if (method === "HEAD") {
        return {
          ok: true, status: 200,
          headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? "1234" : name.toLowerCase() === "content-type" ? "image/jpeg" : null) },
          json: async () => ({}), text: async () => "",
        };
      }
      if (method === "DELETE") return supRes({});
    }
    if (u.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        Object.assign(row, patch);
        return supRes([row]);
      }
      return supRes([row]);
    }
    if (u.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        events.push(body);
        return supRes([body], 201);
      }
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const ev = qs.get("event") ?? "";
      let out = [...events];
      if (ev.startsWith("eq.")) out = out.filter((e) => e["event"] === decodeURIComponent(ev.slice(3)));
      if (ev.startsWith("in.(")) {
        const names = ev.slice(4, -1).split(",");
        out = out.filter((e) => names.includes(String(e["event"])));
      }
      return supRes(out);
    }
    if (u.includes("/rest/v1/gh_photos")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as PhotoRow;
        const isUpsert = u.includes("on_conflict=");
        if (isUpsert) {
          upsertCalls++;
          if (opts.upsert === "no-constraint") return supRes({ message: "no unique constraint" }, 400);
          if (opts.upsert === "fail-once" && upsertCalls === 1) return supRes({ message: "db down" }, 500);
          const existing = photos.find((p) => p.storage_path === body.storage_path);
          if (existing) return supRes([existing], 201);
          const created = { ...body, id: `photo-${++photoSeq}`, created_at: new Date().toISOString() };
          photos.push(created);
          return supRes([created], 201);
        }
        insertCalls++;
        if (insertCalls <= (opts.insertFails ?? 0)) {
          if (opts.plantWinnerOnFirstInsert && insertCalls === 1) {
            photos.push({ id: "photo-winner", room: body.room, kind: body.kind, storage_path: body.storage_path, note: body.note ?? null, created_at: new Date().toISOString() });
          }
          return supRes({ message: "db down" }, 500);
        }
        const created = { ...body, id: `photo-${++photoSeq}`, created_at: new Date().toISOString() };
        photos.push(created);
        return supRes([created], 201);
      }
      return supRes(photos);
    }
    if (u.startsWith("https://api.stripe.com")) return supRes({ id: "cus_test", metadata: {} });
    if (u === "https://api.resend.com/emails") return supRes({ id: "re_test" });
    return supRes(null, 404);
  }));
  const token = mintCleanerLinkV2(SECRET, VISIT_ID, ISSUANCE);
  row["cleaner_token_hash"] = hashToken(token);
  row["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
  row["cleaner_link_version"] = "v2";
  row["cleaner_link_issuance"] = ISSUANCE;
  return {
    photos,
    call: async (body: Record<string, unknown>) => {
      const r = res();
      await cleanerHandler({ method: "POST", body: { ct: token, ...body } } as never, r as never);
      return r;
    },
  };
}

function installCleanerEnv() {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("BOOKING_LINK_SECRET", SECRET);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

beforeEach(() => { installCleanerEnv(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("M5 photo_sign cap", () => {
  const tenOrphans: Record<string, ListEntry[]> = {
    [`visits/${VISIT_ID}/`]: [{ name: "kitchen", id: null }, { name: "bathroom", id: null }],
    [`visits/${VISIT_ID}/kitchen/`]: Array.from({ length: 6 }, (_, i) => ({ name: `k${i}.jpg`, id: `f-k${i}`, updated_at: hoursAgo(30), metadata: { size: 100 } })),
    [`visits/${VISIT_ID}/bathroom/`]: Array.from({ length: 4 }, (_, i) => ({ name: `b${i}.jpg`, id: `f-b${i}`, updated_at: hoursAgo(30), metadata: { size: 100 } })),
  };
  it("10 unregistered uploads refuse the next sign", async () => {
    const env = makeCleanerEnv({ listEntries: tenOrphans });
    const r = await env.call({ action: "photo_sign", room: "Kitchen", kind: "before" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("too_many_unregistered_photos");
  });
  it("9 unregistered uploads still sign", async () => {
    const entries = { ...tenOrphans, [`visits/${VISIT_ID}/bathroom/`]: tenOrphans[`visits/${VISIT_ID}/bathroom/`].slice(0, 3) };
    const env = makeCleanerEnv({ listEntries: entries });
    const r = await env.call({ action: "photo_sign", room: "Kitchen", kind: "before" });
    expect(r.code).toBe(200);
    expect(r.body["upload_url"]).toBeTruthy();
  });
  it("a listing failure fails open — the cleaner is not blocked", async () => {
    const env = makeCleanerEnv({ listEntries: tenOrphans, listFails: true });
    const r = await env.call({ action: "photo_sign", room: "Kitchen", kind: "before" });
    expect(r.code).toBe(200);
  });
  it("registered uploads do not count toward the cap", async () => {
    const registered: PhotoRow[] = tenOrphans[`visits/${VISIT_ID}/kitchen/`].map((f, i) => ({
      id: `reg-${i}`, room: "Kitchen", kind: "before",
      storage_path: `visits/${VISIT_ID}/kitchen/${f.name}`, note: null, created_at: hoursAgo(30),
    }));
    const env = makeCleanerEnv({ photos: registered, listEntries: tenOrphans });
    const r = await env.call({ action: "photo_sign", room: "Kitchen", kind: "before" });
    expect(r.code).toBe(200);
  });
});

describe("L3 photo_register room validation + atomic claim", () => {
  const path = `visits/${VISIT_ID}/kitchen/20261113-abc1234.jpg`;
  it("an invented room never registers", async () => {
    const env = makeCleanerEnv();
    const r = await env.call({ action: "photo_register", room: "Secret attic", kind: "before", storage_path: path });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_room");
    expect(env.photos).toHaveLength(0);
  });
  it("a scope room registers and returns its photo id", async () => {
    const env = makeCleanerEnv();
    const r = await env.call({ action: "photo_register", room: "Kitchen", kind: "before", storage_path: path });
    expect(r.code).toBe(200);
    expect(r.body["photo_id"]).toBeTruthy();
    expect(env.photos).toHaveLength(1);
  });
  it("re-registering the same upload returns already:true, one row", async () => {
    const env = makeCleanerEnv();
    const first = await env.call({ action: "photo_register", room: "Kitchen", kind: "before", storage_path: path });
    expect(first.code).toBe(200);
    const second = await env.call({ action: "photo_register", room: "Kitchen", kind: "before", storage_path: path });
    expect(second.code).toBe(200);
    expect(second.body["already"]).toBe(true);
    expect(env.photos).toHaveLength(1);
  });
  it("a transient DB failure is retried and still registers (M5a)", async () => {
    const env = makeCleanerEnv({ upsert: "fail-once" });
    const r = await env.call({ action: "photo_register", room: "Kitchen", kind: "before", storage_path: path });
    expect(r.code).toBe(200);
    expect(r.body["photo_id"]).toBeTruthy();
    expect(env.photos).toHaveLength(1);
  });
  it("without the unique index the plain-insert fallback still registers", async () => {
    const env = makeCleanerEnv({ upsert: "no-constraint" });
    const r = await env.call({ action: "photo_register", room: "Kitchen", kind: "before", storage_path: path });
    expect(r.code).toBe(200);
    expect(r.body["photo_id"]).toBeTruthy();
    expect(env.photos).toHaveLength(1);
  });
  it("a row that lands mid-retry returns already:true instead of a second row", async () => {
    const env = makeCleanerEnv({ upsert: "no-constraint", insertFails: 1, plantWinnerOnFirstInsert: true });
    const r = await env.call({ action: "photo_register", room: "Kitchen", kind: "before", storage_path: path });
    expect(r.code).toBe(200);
    expect(r.body["already"]).toBe(true);
    expect(env.photos).toHaveLength(1);
  });
});

// ---------- periodic cleanup ----------

describe("M5c cleanupOrphanPhotos", () => {
  const OTHER_VISIT = "44444444-5555-6666-7777-888888888888";
  const DISPUTED_VISIT = "55555555-6666-7777-8888-999999999999";
  function installCleanupMock(opts: {
    registered?: string[];
    visits?: Record<string, { issue_open: boolean; issue_ever: boolean } | null>;
  } = {}) {
    const deleted: string[] = [];
    const journal: Array<Record<string, unknown>> = [];
    const files: Record<string, ListEntry[]> = {
      "visits/": [
        { name: VISIT_ID, id: null },
        { name: OTHER_VISIT, id: null },
        { name: DISPUTED_VISIT, id: null },
      ],
      [`visits/${VISIT_ID}/`]: [{ name: "kitchen", id: null }],
      [`visits/${VISIT_ID}/kitchen/`]: [
        { name: "old.jpg", id: "o1", updated_at: hoursAgo(30), metadata: { size: 100 } },
        { name: "young.jpg", id: "o2", updated_at: hoursAgo(1), metadata: { size: 100 } },
        { name: "kept.jpg", id: "o3", updated_at: hoursAgo(30), metadata: { size: 100 } },
      ],
      [`visits/${OTHER_VISIT}/`]: [{ name: "kitchen", id: null }],
      [`visits/${OTHER_VISIT}/kitchen/`]: [
        { name: "ghost.jpg", id: "o4", updated_at: hoursAgo(30), metadata: { size: 100 } },
      ],
      [`visits/${DISPUTED_VISIT}/`]: [{ name: "kitchen", id: null }],
      [`visits/${DISPUTED_VISIT}/kitchen/`]: [
        { name: "evidence.jpg", id: "o5", updated_at: hoursAgo(30), metadata: { size: 100 } },
      ],
    };
    const registered = new Set(opts.registered ?? [`visits/${VISIT_ID}/kitchen/kept.jpg`]);
    const visits = opts.visits ?? {
      [VISIT_ID]: { issue_open: false, issue_ever: false },
      [OTHER_VISIT]: null,
      [DISPUTED_VISIT]: { issue_open: true, issue_ever: true },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      const okRes = (data: unknown, status = 200) => ({
        ok: status >= 200 && status < 300, status,
        json: async () => data, text: async () => JSON.stringify(data),
        headers: { get: () => null },
      });
      if (u.includes("/storage/v1/object/list/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { prefix?: string };
        return okRes(files[body.prefix ?? ""] ?? []);
      }
      if (u.includes("/storage/v1/object/report-photos") && method === "DELETE") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { prefixes?: string[] };
        for (const p of body.prefixes ?? []) deleted.push(p);
        return okRes({});
      }
      if (u.includes("/rest/v1/gh_photos")) {
        if (u.includes("select=storage_path")) {
          return okRes([...registered].map((storage_path) => ({ storage_path })));
        }
        const m = /storage_path=eq\.([^&]+)/.exec(u);
        if (m) return okRes(registered.has(decodeURIComponent(m[1])) ? [{ id: "x" }] : []);
        return okRes([]);
      }
      if (u.includes("/rest/v1/gh_visits")) {
        const m = /id=eq\.([^&]+)/.exec(u);
        const v = m ? visits[decodeURIComponent(m[1])] : undefined;
        return okRes(v ? [{ id: decodeURIComponent(m![1]), ...v }] : []);
      }
      if (u.includes("/rest/v1/gh_events") && method === "POST") {
        journal.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return okRes([{ id: journal.length }], 201);
      }
      return okRes(null, 404);
    }));
    return { deleted, journal };
  }

  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("ADMIN_TOKEN", "test-admin-token-123");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("deletes only the old unregistered object of a clean visit", async () => {
    const { deleted, journal } = installCleanupMock();
    const result = await cleanupOrphanPhotos();
    expect(deleted).toEqual([`visits/${VISIT_ID}/kitchen/old.jpg`]);
    expect(result.deleted).toBe(1);
    // Three old unregistered candidates were examined (old, ghost,
    // evidence); only the clean visit's object was deleted.
    expect(result.checked).toBe(3);
    expect(result.skipped).toBe(2);
    expect(journal.some((e) => e["event"] === "orphan_photo_deleted")).toBe(true);
  });

  it("keeps disputed evidence, young objects, registered rows and ghost visits", async () => {
    const { deleted } = installCleanupMock();
    await cleanupOrphanPhotos();
    expect(deleted).not.toContain(`visits/${DISPUTED_VISIT}/kitchen/evidence.jpg`);
    expect(deleted).not.toContain(`visits/${VISIT_ID}/kitchen/young.jpg`);
    expect(deleted).not.toContain(`visits/${VISIT_ID}/kitchen/kept.jpg`);
    expect(deleted).not.toContain(`visits/${OTHER_VISIT}/kitchen/ghost.jpg`);
  });

  it("the admin handler refuses without auth and runs with it", async () => {
    installCleanupMock();
    const unauth = res();
    await storageCleanupHandler(
      { method: "POST", headers: { authorization: "Bearer wrong" } } as never, unauth as never,
    );
    expect(unauth.code).toBe(401);
    const authed = res();
    await storageCleanupHandler(
      { method: "POST", headers: { authorization: "Bearer " + "test-admin-token-123" } } as never, authed as never,
    );
    expect(authed.code).toBe(200);
    expect(authed.body["deleted"]).toBe(1);
  });
});
