// @vitest-environment node
// Maximal-audit fixes, "data + photos + cron" package (14.11.2026):
// MB-03 hydrate payment_failed after approval; MB-06 strict secondary
// reads in the cleaner view; MB-08 photo_delete kind guard + no
// client photos in the cleaner view; MB-09 checklist label validation;
// MB-22 orphan-walk cap counts only unregistered objects; MB-23 no
// phantom room for an explicit "0"; LB-06 paged card list in the
// cron; LB-10 receipt backfill nulls first; LB-15 magic-byte sniff
// on register; LB-16 client-issue objects out of the cleaner cap;
// LB-43 photo policy in one module; LB-44 retention pagination;
// LB-45 retention DB-delete retry + loud log; LB-46 sign cap
// fail-closed on a truncated listing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildWorkRooms } from "../../api/_work_scope";
import { hydratedGhState } from "../../api/auto-charge";
import {
  photoMagicMatches,
  findUnknownChecklistLabels,
} from "../../api/cleaner";
import {
  PHOTO_RETENTION_DAYS,
  PHOTO_RETENTION_MS,
  ORPHAN_MIN_AGE_MS,
  CLEANER_PHOTO_URL_TTL_SECONDS,
  CLIENT_PHOTO_URL_TTL_SECONDS,
  isCleanerPhotoKind,
  isClientPhotoKind,
} from "../../api/_photo_policy";
import {
  storageListObjects,
  cleanupOrphanPhotos,
} from "../../api/_storage-cleanup";
import cleanerHandler from "../../api/cleaner";
import autoChargeHandler from "../../api/auto-charge";
import { installEnv, VISIT_ID } from "./m-cleaner-harness";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------- MB-03: a failed charge newer than the approval wins ----------

describe("MB-03 hydratedGhState", () => {
  const base = {
    rowStatus: "report_sent",
    cancelled: false,
    issueOpen: false,
    approvedAt: "2026-11-13T10:00:00.000Z",
    failedAt: null as string | null,
    reportSentAt: "2026-11-12T10:00:00.000Z",
    fallbackState: "",
  };
  it("a payment_failed newer than the approval keeps payment_failed", () => {
    expect(hydratedGhState({ ...base, failedAt: "2026-11-13T11:00:00.000Z" })).toBe("payment_failed");
  });
  it("a payment_unknown newer than the approval keeps payment_failed", () => {
    expect(hydratedGhState({ ...base, failedAt: "2026-11-13T10:00:00.001Z" })).toBe("payment_failed");
  });
  it("a failure older than the approval still maps to approved", () => {
    expect(hydratedGhState({ ...base, failedAt: "2026-11-13T09:59:59.000Z" })).toBe("approved");
  });
  it("an approval with no failure maps to approved", () => {
    expect(hydratedGhState(base)).toBe("approved");
  });
  it("no approval + a failure keeps the old report_sent mapping", () => {
    expect(hydratedGhState({ ...base, approvedAt: null, failedAt: "2026-11-13T11:00:00.000Z" })).toBe("report_sent");
  });
  it("terminal states still win over approval + failure", () => {
    expect(hydratedGhState({ ...base, rowStatus: "paid", failedAt: "2026-11-13T11:00:00.000Z" })).toBe("paid");
    expect(hydratedGhState({ ...base, rowStatus: "refunded", failedAt: "2026-11-13T11:00:00.000Z" })).toBe("refunded");
    expect(hydratedGhState({ ...base, cancelled: true, failedAt: "2026-11-13T11:00:00.000Z" })).toBe("cancelled");
    expect(hydratedGhState({ ...base, issueOpen: true, failedAt: "2026-11-13T11:00:00.000Z" })).toBe("issue_open");
  });
  it("no approval, no report: the previous state survives", () => {
    expect(hydratedGhState({ ...base, approvedAt: null, reportSentAt: null, fallbackState: "card_ready" })).toBe("card_ready");
  });
});

// ---------- LB-15: magic bytes must match the claimed type ----------

describe("LB-15 photoMagicMatches", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  const heic = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  const heifMif1 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31]);
  it("accepts each allowed type's own leading bytes", () => {
    expect(photoMagicMatches("image/jpeg", jpeg)).toBe(true);
    expect(photoMagicMatches("image/png", png)).toBe(true);
    expect(photoMagicMatches("image/webp", webp)).toBe(true);
    expect(photoMagicMatches("image/heic", heic)).toBe(true);
    expect(photoMagicMatches("image/heif", heifMif1)).toBe(true);
  });
  it("rejects bytes of another type under a claimed type", () => {
    expect(photoMagicMatches("image/jpeg", png)).toBe(false);
    expect(photoMagicMatches("image/png", jpeg)).toBe(false);
    expect(photoMagicMatches("image/jpeg", heic)).toBe(false);
    expect(photoMagicMatches("image/webp", png)).toBe(false);
  });
  it("rejects truncated heads and unknown types", () => {
    expect(photoMagicMatches("image/jpeg", new Uint8Array([0xff, 0xd8]))).toBe(false);
    expect(photoMagicMatches("image/png", new Uint8Array([]))).toBe(false);
    expect(photoMagicMatches("image/gif", new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe(false);
    expect(photoMagicMatches("image/heic", new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))).toBe(false);
  });
});

// ---------- MB-09: labels must come from the visit's task list ----------

describe("MB-09 findUnknownChecklistLabels", () => {
  const scope = {
    rooms: [
      { name: "Kitchen", items: [{ label: "Sink scrubbed", done: false }, { label: "Floor mopped", done: false }] },
      { name: "Bathroom", items: [{ label: "Mirror cleaned", done: false }, { label: "Floor mopped", done: false }] },
    ],
  };
  const check = (rooms: Array<{ name: string; items: Array<{ label: string; done: boolean }> }>) => ({ rooms });
  it("passes labels exactly as issued for the room", () => {
    expect(findUnknownChecklistLabels(scope, check([
      { name: "Kitchen", items: [{ label: "Sink scrubbed", done: true }] },
      { name: "Bathroom", items: [{ label: "Mirror cleaned", done: false }] },
    ]))).toEqual([]);
  });
  it("flags a renamed or added label", () => {
    expect(findUnknownChecklistLabels(scope, check([
      { name: "Kitchen", items: [{ label: "Polished the chandelier", done: true }] },
    ]))).toEqual(["Polished the chandelier"]);
  });
  it("is per-room: a kitchen label does not belong in a bathroom", () => {
    expect(findUnknownChecklistLabels(scope, check([
      { name: "Bathroom", items: [{ label: "Sink scrubbed", done: true }] },
    ]))).toEqual(["Sink scrubbed"]);
  });
  it("skips rooms absent from the scope — the M1 room check owns those", () => {
    expect(findUnknownChecklistLabels(scope, check([
      { name: "Secret attic", items: [{ label: "Anything at all", done: true }] },
    ]))).toEqual([]);
  });
  it("an empty scope fails open, like M1", () => {
    expect(findUnknownChecklistLabels(null, check([
      { name: "Kitchen", items: [{ label: "Anything at all", done: true }] },
    ]))).toEqual([]);
  });
});

// ---------- MB-23: an explicit "0" is zero rooms, never a phantom ----------

describe("MB-23 buildWorkRooms with explicit zero counts", () => {
  it('fullBaths "0" builds no bathroom (powder-room-only home)', () => {
    const rooms = buildWorkRooms({ bedrooms: "2", fullBaths: "0", halfBaths: "1", deep: false });
    expect(rooms.map((r) => r.name)).toEqual(["Kitchen", "Bedroom 1", "Bedroom 2", "Half bathroom", "Living room"]);
  });
  it('bedrooms "0" builds no bedroom', () => {
    const rooms = buildWorkRooms({ bedrooms: "0", fullBaths: "1", deep: false });
    expect(rooms.map((r) => r.name)).toEqual(["Kitchen", "Bathroom", "Living room"]);
  });
  it("valid inputs are unchanged (names included)", () => {
    expect(buildWorkRooms({ bedrooms: "1", fullBaths: "1", deep: false }).map((r) => r.name))
      .toEqual(["Kitchen", "Bathroom", "Bedroom", "Living room"]);
    expect(buildWorkRooms({ bedrooms: "3", fullBaths: "2", halfBaths: "2", deep: false }).map((r) => r.name))
      .toEqual(["Kitchen", "Bathroom 1", "Bathroom 2", "Bedroom 1", "Bedroom 2", "Bedroom 3", "Half bathroom 1", "Half bathroom 2", "Living room"]);
    // Missing counts still default to one room with the collective name.
    expect(buildWorkRooms({ deep: false }).map((r) => r.name))
      .toEqual(["Kitchen", "Bathrooms", "Bedrooms", "Living room"]);
  });
});

// ---------- LB-43: the photo policy lives in one module ----------

describe("LB-43 photo policy constants", () => {
  it("retention is 90 days, orphan age 24h, TTLs 24h (cleaner) / 24h (client)", () => {
    expect(PHOTO_RETENTION_DAYS).toBe(90);
    expect(PHOTO_RETENTION_MS).toBe(90 * 24 * 3600 * 1000);
    expect(ORPHAN_MIN_AGE_MS).toBe(24 * 3600 * 1000);
    expect(CLEANER_PHOTO_URL_TTL_SECONDS).toBe(24 * 3600);
    expect(CLIENT_PHOTO_URL_TTL_SECONDS).toBe(24 * 3600);
    expect(isCleanerPhotoKind("before")).toBe(true);
    expect(isCleanerPhotoKind("after")).toBe(true);
    expect(isCleanerPhotoKind("client")).toBe(false);
    expect(isClientPhotoKind("client")).toBe(true);
    expect(isClientPhotoKind("before")).toBe(false);
  });
});

// ---------- MB-22: the orphan-walk cap counts only unregistered objects ----------

describe("MB-22 orphan walk", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  type ListEntry = { name: string; id?: string | null; updated_at?: string | null; metadata?: { size: number } | null };
  const file = (name: string): ListEntry => ({ name, id: `f-${name}`, updated_at: hoursAgo(30), metadata: { size: 100 } });
  const folder = (name: string): ListEntry => ({ name, id: null });

  function installListMock(files: Record<string, ListEntry[]>) {
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
        const u = String(url);
        const okRes = (data: unknown, status = 200) => ({
          ok: status >= 200 && status < 300, status,
          json: async () => data, text: async () => JSON.stringify(data),
          headers: { get: () => null },
        });
        if (u.includes("/storage/v1/object/list/")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { prefix?: string; limit?: number; offset?: number };
          const all = [...(files[body.prefix ?? ""] ?? [])].sort((a, b) => a.name.localeCompare(b.name));
          return okRes(all.slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 100)));
        }
        return okRes(null, 404);
      }),
    );
  }

  it("registered objects no longer eat the walk budget (predicate)", async () => {
    const files: Record<string, ListEntry[]> = {
      "visits/": [folder("v-early"), folder("v-late")],
      "visits/v-early/": [folder("kitchen")],
      "visits/v-early/kitchen/": [file("a.jpg"), file("b.jpg"), file("c.jpg")],
      "visits/v-late/": [folder("kitchen")],
      "visits/v-late/kitchen/": [file("d.jpg"), file("e.jpg")],
    };
    installListMock(files);
    const registered = new Set([
      "visits/v-early/kitchen/a.jpg",
      "visits/v-early/kitchen/b.jpg",
      "visits/v-early/kitchen/c.jpg",
    ]);
    // Without the predicate, a 3-object cap stops after the three
    // registered files and the late visit is never listed.
    const plain = await storageListObjects("visits/", 3);
    expect(plain).not.toBeNull();
    expect(plain!.objects).toHaveLength(3);
    expect(plain!.truncated).toBe(true);
    // With it, the registered files do not count: all 5 are listed.
    const withPredicate = await storageListObjects("visits/", 3, {
      isRegistered: (path) => registered.has(path),
    });
    expect(withPredicate).not.toBeNull();
    expect(withPredicate!.objects).toHaveLength(5);
    expect(withPredicate!.truncated).toBe(false);
  });

  it("cleanup finds the orphan behind 500 registered photos (DA-05 paging kept)", async () => {
    const EARLY = "11111111-2222-3333-4444-555555555555";
    const LATE = "22222222-3333-4444-5555-666666666666";
    const earlyPaths = Array.from({ length: 500 }, (_, i) => `visits/${EARLY}/kitchen/f${String(i).padStart(3, "0")}.jpg`);
    const orphanPath = `visits/${LATE}/kitchen/orphan.jpg`;
    const files: Record<string, ListEntry[]> = {
      "visits/": [folder(EARLY), folder(LATE)],
      [`visits/${EARLY}/`]: [folder("kitchen")],
      [`visits/${EARLY}/kitchen/`]: earlyPaths.map((p) => file(p.split("/").pop()!)),
      [`visits/${LATE}/`]: [folder("kitchen")],
      [`visits/${LATE}/kitchen/`]: [file("orphan.jpg")],
    };
    const deleted: string[] = [];
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
        const u = String(url);
        const method = (init?.method ?? "GET").toUpperCase();
        const okRes = (data: unknown, status = 200) => ({
          ok: status >= 200 && status < 300, status,
          json: async () => data, text: async () => JSON.stringify(data),
          headers: { get: () => null },
        });
        if (u.includes("/storage/v1/object/list/")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { prefix?: string; limit?: number; offset?: number };
          const all = [...(files[body.prefix ?? ""] ?? [])].sort((a, b) => a.name.localeCompare(b.name));
          return okRes(all.slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 100)));
        }
        if (u.includes("/storage/v1/object/report-photos") && method === "DELETE") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { prefixes?: string[] };
          for (const p of body.prefixes ?? []) deleted.push(p);
          return okRes({});
        }
        if (u.includes("/rest/v1/gh_photos")) {
          if (u.includes("select=storage_path")) {
            return okRes(earlyPaths.map((storage_path) => ({ storage_path })));
          }
          const m = /storage_path=eq\.([^&]+)/.exec(u);
          if (m) return okRes(earlyPaths.includes(decodeURIComponent(m[1])) ? [{ id: "x" }] : []);
          return okRes([]);
        }
        if (u.includes("/rest/v1/gh_visits")) {
          const m = /id=eq\.([^&]+)/.exec(u);
          const id = m ? decodeURIComponent(m[1]) : "";
          return okRes(id === EARLY || id === LATE ? [{ id, issue_open: false, issue_ever: false }] : []);
        }
        if (u.includes("/rest/v1/gh_events") && method === "POST") return okRes([{ id: 1 }], 201);
        return okRes(null, 404);
      }),
    );
    const result = await cleanupOrphanPhotos();
    expect(result.deleted).toBe(1);
    expect(deleted).toEqual([orphanPath]);
    expect(result.truncated).toBe(false);
  });
});

// ---------- MB-09: cleaner handler validates checklist labels ----------

describe("MB-09 cleaner handler label validation", () => {
  const SCOPE_ROOMS = ["Kitchen", "Bathroom", "Bedroom", "Living room"];
  const allRooms = (label: (room: string) => string) => ({
    rooms: SCOPE_ROOMS.map((name) => ({ name, items: [{ label: label(name), done: false }] })),
  });
  it("save on a legacy row with no stored checklist fails open for labels (like M1)", async () => {
    const env = installEnv({ row: { checklist: null } });
    const r = await env.call({
      action: "checklist",
      checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wipe counters", done: true }] }] },
    });
    expect(r.code).toBe(200);
  });
  it("save with a renamed label is 400 invalid_checklist", async () => {
    const env = installEnv();
    const r = await env.call({
      action: "checklist",
      checklist: allRooms((room) => (room === "Kitchen" ? "Polished the chandelier" : "Cleaned as agreed")),
    });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_checklist");
    expect(r.body["unknown_labels"]).toEqual(["Polished the chandelier"]);
  });
  it("save with the issued labels succeeds", async () => {
    const env = installEnv();
    const r = await env.call({ action: "checklist", checklist: allRooms(() => "Cleaned as agreed") });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
  });
  it("submit with a renamed label is 400, not a silent fallback", async () => {
    const env = installEnv();
    const r = await env.call({
      action: "submit",
      checklist: allRooms((room) => (room === "Bathroom" ? "Invented task" : "Cleaned as agreed")),
    });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_checklist");
  });
  it("submit with a malformed posted checklist (rooms present) is 400", async () => {
    const env = installEnv();
    const r = await env.call({ action: "submit", checklist: { rooms: [{ name: "Kitchen", items: "nope" }] } });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_checklist");
  });
  it("submit with an explicit empty checklist seeds the scope (MA-03 kept)", async () => {
    const env = installEnv();
    const r = await env.call({ action: "submit", checklist: { rooms: [] } });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("rooms_incomplete");
  });
  it("submit with no checklist seeds the scope (MA-03 kept) and reports incomplete rooms", async () => {
    const env = installEnv();
    const r = await env.call({ action: "submit" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("rooms_incomplete");
  });
});

// ---------- MB-08: the cleaner view never signs client photos ----------

describe("MB-08 cleaner view hides client photos", () => {
  it("a kind:client photo is not signed or listed", async () => {
    const env = installEnv({
      photos: [
        { id: "ph-before", room: "Kitchen", kind: "before", storage_path: `visits/${VISIT_ID}/kitchen/before.jpg`, note: null, created_at: "2026-11-13T10:00:00.000Z" },
        { id: "ph-client", room: "Kitchen", kind: "client", storage_path: `visits/${VISIT_ID}/client-issue/123.jpg`, note: null, created_at: "2026-11-13T10:00:00.000Z" },
      ],
    });
    const r = await env.get();
    expect(r.code).toBe(200);
    const photos = r.body["photos"] as Array<{ id: string; kind: string }>;
    expect(photos.map((p) => p.id)).toEqual(["ph-before"]);
    expect(photos.some((p) => p.kind === "client")).toBe(false);
  });
});

// ---------- custom cleaner mock: DB/storage failures + photo flows ----------

const C_SECRET = "test-cleaner-secret-123";
const C_VISIT_ID = "33333333-4444-5555-6666-777777777777";
const C_BID = "bid-mb-data";
const C_ISSUANCE = "aabbccddeeff00112233445566778899";
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

type CPhoto = { id: string; room: string; kind: string; storage_path: string; note: string | null; created_at: string };
type CListEntry = { name: string; id?: string | null; updated_at?: string | null; metadata?: { size: number } | null };

function makeCleanerEnv2(opts: {
  photos?: CPhoto[];
  listEntries?: Record<string, CListEntry[]>;
  listFails?: boolean;
  photosFail?: boolean;
  headContentType?: string;
  headFails?: boolean;
  signBytes?: Uint8Array | null;
  deletePhotoFails?: boolean;
  deleteStorageFails?: boolean;
  eventsFail?: string[];
} = {}) {
  const photos: CPhoto[] = opts.photos ?? [];
  const listEntries = opts.listEntries ?? {};
  const storageDeleted: string[] = [];
  const events: Array<Record<string, unknown>> = [
    { visit_id: C_VISIT_ID, event: "visit_confirmed", detail: { date: "2026-11-10", window: "midday" }, created_at: "2026-11-10T10:00:00.000Z" },
  ];
  const row: Record<string, unknown> = {
    id: C_VISIT_ID, booking_id: C_BID, visit_no: 1, status: "confirmed", report_status: "draft",
    visit_date: "2026-11-10", window: "midday", address: "1 Test St", service: "Standard cleaning",
    client_name: "Casey Client", client_email: "client@example.com",
    cleaner_token_hash: null, cleaner_token_expires: null, cleaner_link_version: null, cleaner_link_issuance: null,
    checklist: { rooms: ["Kitchen", "Bathroom", "Bedroom", "Living room"].map((name) => ({ name, items: [{ label: "Cleaned as agreed", done: false }] })) },
    issue_open: false, issue_ever: false, amount_cents: 149, no_photo_zones: null,
    updated_at: "2026-11-13T10:00:00.000Z",
  };
  const okRes = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => data, text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.includes("/storage/v1/object/upload/sign/")) return okRes({ url: "/object/upload/sign/x" });
      // The signed-URL GET must be checked before the sign POST
      // branch below: the GET url also contains "/object/sign/".
      if (u.includes("/object/sign/test-url")) {
        const bytes = opts.signBytes ?? JPEG_BYTES;
        return {
          ok: true, status: 200,
          json: async () => ({}), text: async () => "",
          headers: { get: () => null },
          arrayBuffer: async () => Uint8Array.from(bytes as Uint8Array).buffer,
        };
      }
      if (u.includes("/storage/v1/object/sign/")) {
        if (method === "POST") {
          if (opts.signBytes === null) return okRes({ message: "no" }, 404);
          return okRes({ signedURL: "/object/sign/test-url" });
        }
        return okRes(null, 404);
      }
      if (u.includes("/storage/v1/object/list/")) {
        if (opts.listFails) return okRes({ message: "boom" }, 500);
        const body = JSON.parse(String(init?.body ?? "{}")) as { prefix?: string; limit?: number; offset?: number };
        const all = [...(listEntries[body.prefix ?? ""] ?? [])].sort((a, b) => a.name.localeCompare(b.name));
        return okRes(all.slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 100)));
      }
      if (u.includes("/storage/v1/object/report-photos")) {
        if (method === "HEAD") {
          if (opts.headFails) return { ok: false, status: 500, json: async () => ({}), text: async () => "", headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
          const ct = opts.headContentType ?? "image/jpeg";
          return {
            ok: true, status: 200, json: async () => ({}), text: async () => "",
            headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? "1234" : name.toLowerCase() === "content-type" ? ct : null) },
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        if (method === "DELETE") {
          if (opts.deleteStorageFails) return okRes({ message: "down" }, 500);
          const body = JSON.parse(String(init?.body ?? "{}")) as { prefixes?: string[] };
          for (const p of body.prefixes ?? []) storageDeleted.push(p);
          return okRes({});
        }
      }
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          Object.assign(row, JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return okRes([row]);
        }
        return okRes([row]);
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          events.push({ ...body, created_at: new Date().toISOString() });
          return okRes([body], 201);
        }
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const ev = qs.get("event") ?? "";
        if (ev.startsWith("eq.") && (opts.eventsFail ?? []).includes(decodeURIComponent(ev.slice(3)))) {
          return okRes({ message: "db down" }, 500);
        }
        let out = [...events];
        if (ev.startsWith("eq.")) out = out.filter((e) => e["event"] === decodeURIComponent(ev.slice(3)));
        if (ev.startsWith("in.(")) {
          const names = ev.slice(4, -1).split(",");
          out = out.filter((e) => names.includes(String(e["event"])));
        }
        out.sort((a, b) => String(b["created_at"] ?? "").localeCompare(String(a["created_at"] ?? "")));
        const limit = Number(qs.get("limit") ?? "0");
        return okRes(limit > 0 ? out.slice(0, limit) : out);
      }
      if (u.includes("/rest/v1/gh_photos")) {
        if (method === "DELETE") {
          if (opts.deletePhotoFails) return okRes({ message: "db down" }, 500);
          const m = /id=eq\.([^&]+)/.exec(u);
          const id = m ? decodeURIComponent(m[1]) : "";
          const idx = photos.findIndex((p) => p.id === id);
          const removed = idx >= 0 ? photos.splice(idx, 1) : [];
          return okRes(removed);
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as CPhoto;
          const existing = photos.find((p) => p.storage_path === body.storage_path);
          if (existing) return okRes([existing], 201);
          const created = { ...body, id: `photo-${photos.length + 1}`, created_at: new Date().toISOString() };
          photos.push(created);
          return okRes([created], 201);
        }
        if (opts.photosFail) return okRes({ message: "db down" }, 500);
        return okRes(photos);
      }
      if (u.includes("/rest/v1/gh_visit_access")) return okRes([]);
      if (u.startsWith("https://api.stripe.com")) return okRes({ id: "cus_test", metadata: {} });
      if (u === "https://api.resend.com/emails") return okRes({ id: "re_test" });
      return okRes(null, 404);
    }),
  );
  const token = mintCleanerLinkV2(C_SECRET, C_VISIT_ID, C_ISSUANCE);
  row["cleaner_token_hash"] = hashToken(token);
  row["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
  row["cleaner_link_version"] = "v2";
  row["cleaner_link_issuance"] = C_ISSUANCE;
  const res = () => ({
    code: 0, body: {} as Record<string, unknown>, headers: {} as Record<string, string>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end: vi.fn(),
  });
  return {
    photos, events, row, storageDeleted,
    call: async (body: Record<string, unknown>) => {
      const r = res();
      await cleanerHandler({ method: "POST", body: { ct: token, ...body } } as never, r as never);
      return r;
    },
    get: async () => {
      const r = res();
      await cleanerHandler({ method: "GET", query: { ct: token } } as never, r as never);
      return r;
    },
  };
}

function installCleanerEnv2() {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("CLEANER_LINK_SECRET", C_SECRET);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("BOOKING_LINK_SECRET", C_SECRET);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("MB-06 cleaner view degradation flag + strict journal", () => {
  beforeEach(() => { installCleanerEnv2(); });
  it("a failed photo read marks the view degraded instead of silently empty", async () => {
    const env = makeCleanerEnv2({ photosFail: true });
    const r = await env.get();
    expect(r.code).toBe(200);
    expect(r.body["degraded"]).toBe(true);
    expect(r.body["photos"]).toEqual([]);
  });
  it("a healthy view carries no degraded flag", async () => {
    const env = makeCleanerEnv2();
    const r = await env.get();
    expect(r.code).toBe(200);
    expect(r.body["degraded"]).toBeUndefined();
  });
  it("an unreadable re-clean journal fails the submit closed (502)", async () => {
    const env = makeCleanerEnv2({ eventsFail: ["issue_decision"] });
    const r = await env.call({ action: "submit" });
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_unavailable");
  });
});

describe("LB-15 photo_register magic-byte sniff", () => {
  beforeEach(() => { installCleanerEnv2(); });
  const path = `visits/${C_VISIT_ID}/kitchen/20261114-abc1234.jpg`;
  it("JPEG bytes under a JPEG content-type register", async () => {
    const env = makeCleanerEnv2();
    const r = await env.call({ action: "photo_register", room: "Kitchen", kind: "before", storage_path: path });
    expect(r.code).toBe(200);
    expect(r.body["photo_id"]).toBeTruthy();
    expect(env.photos).toHaveLength(1);
  });
  it("PNG bytes under a JPEG content-type are rejected and removed", async () => {
    const env = makeCleanerEnv2({ signBytes: PNG_BYTES });
    const r = await env.call({ action: "photo_register", room: "Kitchen", kind: "before", storage_path: path });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_photo_file");
    expect(env.photos).toHaveLength(0);
    expect(env.storageDeleted).toEqual([path]);
  });
  it("an unreadable sniff fails open to the HEAD check (no regression)", async () => {
    const env = makeCleanerEnv2({ signBytes: null });
    const r = await env.call({ action: "photo_register", room: "Kitchen", kind: "before", storage_path: path });
    expect(r.code).toBe(200);
    expect(r.body["photo_id"]).toBeTruthy();
  });
});

describe("LB-16/LB-46 photo_sign cap", () => {
  beforeEach(() => { installCleanerEnv2(); });
  const folder = (name: string): CListEntry => ({ name, id: null });
  const file = (name: string): CListEntry => ({ name, id: `f-${name}`, updated_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString(), metadata: { size: 100 } });
  it("unregistered client-issue objects do not count toward the cleaner cap", async () => {
    const entries: Record<string, CListEntry[]> = {
      [`visits/${C_VISIT_ID}/`]: [folder("client-issue"), folder("kitchen")],
      [`visits/${C_VISIT_ID}/kitchen/`]: Array.from({ length: 7 }, (_, i) => file(`k${i}.jpg`)),
      [`visits/${C_VISIT_ID}/client-issue/`]: Array.from({ length: 3 }, (_, i) => file(`c${i}.jpg`)),
    };
    const env = makeCleanerEnv2({ listEntries: entries });
    const r = await env.call({ action: "photo_sign", room: "Kitchen", kind: "before" });
    expect(r.code).toBe(200);
    expect(r.body["upload_url"]).toBeTruthy();
  });
  it("10 unregistered cleaner uploads still refuse the next sign", async () => {
    const entries: Record<string, CListEntry[]> = {
      [`visits/${C_VISIT_ID}/`]: [folder("kitchen")],
      [`visits/${C_VISIT_ID}/kitchen/`]: Array.from({ length: 10 }, (_, i) => file(`k${i}.jpg`)),
    };
    const env = makeCleanerEnv2({ listEntries: entries });
    const r = await env.call({ action: "photo_sign", room: "Kitchen", kind: "before" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("too_many_unregistered_photos");
  });
  it("a truncated listing fails the sign closed instead of undercounting", async () => {
    const entries: Record<string, CListEntry[]> = {
      [`visits/${C_VISIT_ID}/`]: [folder("kitchen")],
      [`visits/${C_VISIT_ID}/kitchen/`]: Array.from({ length: 501 }, (_, i) => file(`k${String(i).padStart(3, "0")}.jpg`)),
    };
    const env = makeCleanerEnv2({ listEntries: entries });
    const r = await env.call({ action: "photo_sign", room: "Kitchen", kind: "before" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("too_many_unregistered_photos");
  });
});

describe("MB-08 photo_delete kind guard + checked results", () => {
  beforeEach(() => { installCleanerEnv2(); });
  const clientPhoto: CPhoto = { id: "ph-client", room: "Kitchen", kind: "client", storage_path: `visits/${C_VISIT_ID}/client-issue/123.jpg`, note: null, created_at: "2026-11-13T10:00:00.000Z" };
  const beforePhoto: CPhoto = { id: "ph-before", room: "Kitchen", kind: "before", storage_path: `visits/${C_VISIT_ID}/kitchen/before.jpg`, note: null, created_at: "2026-11-13T10:00:00.000Z" };
  it("a client photo cannot be deleted (403), row and bytes intact", async () => {
    const env = makeCleanerEnv2({ photos: [clientPhoto, beforePhoto] });
    const r = await env.call({ action: "photo_delete", photo_id: "ph-client" });
    expect(r.code).toBe(403);
    expect(r.body["error"]).toBe("photo_not_allowed");
    expect(env.photos).toHaveLength(2);
    expect(env.storageDeleted).toEqual([]);
  });
  it("a cleaner photo deletes and logs only on success", async () => {
    const env = makeCleanerEnv2({ photos: [clientPhoto, beforePhoto] });
    const r = await env.call({ action: "photo_delete", photo_id: "ph-before" });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(env.photos.map((p) => p.id)).toEqual(["ph-client"]);
    expect(env.storageDeleted).toEqual([beforePhoto.storage_path]);
    expect(env.events.some((e) => e["event"] === "photo_deleted")).toBe(true);
  });
  it("a failed row delete is a 502 and touches no bytes", async () => {
    const env = makeCleanerEnv2({ photos: [beforePhoto], deletePhotoFails: true });
    const r = await env.call({ action: "photo_delete", photo_id: "ph-before" });
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_error");
    expect(env.storageDeleted).toEqual([]);
    expect(env.photos).toHaveLength(1);
  });
  it("a failed storage remove is a 502", async () => {
    const env = makeCleanerEnv2({ photos: [beforePhoto], deleteStorageFails: true });
    const r = await env.call({ action: "photo_delete", photo_id: "ph-before" });
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("storage_error");
  });
});

// ---------- auto-charge handler mock: retention / receipts / card list ----------

const CRON = "cron-secret";
type ACRow = Record<string, unknown>;

function acMatchCond(row: ACRow, field: string, op: string, val: string): boolean {
  const v = row[field];
  const dec = decodeURIComponent(val);
  if (op === "eq") return String(v ?? "") === dec;
  if (op === "neq") return String(v ?? "") !== dec;
  if (op === "is") return dec === "null" ? v === null || v === undefined : v !== null && v !== undefined;
  if (op === "lt") return String(v ?? "") < dec;
  if (op === "lte") return String(v ?? "") <= dec;
  if (op === "gt") return String(v ?? "") > dec;
  if (op === "gte") return String(v ?? "") >= dec;
  if (op === "like") {
    const re = new RegExp(`^${dec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`);
    return re.test(String(v ?? ""));
  }
  return false;
}

function installAutoChargeMock(opts: {
  customers?: Array<{ id: string; email: string; name: string; metadata: Record<string, string> }>;
  cards?: string[];
  visitRows?: ACRow[];
  photoRows?: ACRow[];
  failDbDeleteIds?: Set<string>;
} = {}) {
  const customers = opts.customers ?? [];
  const cards = opts.cards ?? [];
  const visitRows: ACRow[] = opts.visitRows ?? [];
  const photoRows: ACRow[] = opts.photoRows ?? [];
  const failDbDeleteIds = opts.failDbDeleteIds ?? new Set<string>();
  const storageDeleted: string[] = [];
  const resendTo: string[] = [];
  const pmCalls: string[] = [];
  let resendSeq = 0;

  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", ["adm", "secret"].join("-"));
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const okRes = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => data, text: async () => JSON.stringify(data),
    headers: { get: () => null },
  });

  const applyVisitFilters = (u: URL): ACRow[] => {
    let out = [...visitRows];
    for (const [k, v] of u.searchParams.entries()) {
      if (k === "order" || k === "limit" || k === "select" || k === "offset") continue;
      if (k === "or") {
        const inner = v.replace(/^\(|\)$/g, "");
        out = out.filter((r) => inner.split(",").some((c) => {
          const d1 = c.indexOf(".");
          const rest = c.slice(d1 + 1);
          const d2 = rest.indexOf(".");
          return d1 > 0 && d2 > 0 ? acMatchCond(r, c.slice(0, d1), rest.slice(0, d2), rest.slice(d2 + 1)) : false;
        }));
        continue;
      }
      if (k.includes(".")) continue; // embedded gh_visits.* filters: fixtures are eligible
      const dot = v.indexOf(".");
      if (dot <= 0) continue;
      out = out.filter((r) => acMatchCond(r, k, v.slice(0, dot), v.slice(dot + 1)));
    }
    const order = u.searchParams.get("order") ?? "";
    const [field, dir, nulls] = order.split(".");
    if (field) {
      out.sort((a, b) => {
        const av = a[field];
        const bv = b[field];
        const aNull = av === null || av === undefined;
        const bNull = bv === null || bv === undefined;
        if (aNull && bNull) return 0;
        if (aNull) return nulls === "nullsfirst" ? -1 : 1;
        if (bNull) return nulls === "nullsfirst" ? 1 : -1;
        const cmp = String(av).localeCompare(String(bv));
        return dir === "desc" ? -cmp : cmp;
      });
    }
    const limit = u.searchParams.get("limit");
    if (limit) out = out.slice(0, parseInt(limit, 10));
    return out;
  };

  const applyPhotoFilters = (u: URL): ACRow[] => {
    let out = [...photoRows];
    for (const [k, v] of u.searchParams.entries()) {
      if (k === "order" || k === "limit" || k === "select" || k === "offset") continue;
      if (k.includes(".")) continue; // embedded gh_visits.* filters: fixtures are eligible
      const dot = v.indexOf(".");
      if (dot <= 0) continue;
      out = out.filter((r) => acMatchCond(r, k, v.slice(0, dot), v.slice(dot + 1)));
    }
    const order = u.searchParams.get("order") ?? "";
    const [field, dir] = order.split(".");
    if (field === "created_at") {
      out.sort((a, b) => {
        const cmp = String(a["created_at"] ?? "").localeCompare(String(b["created_at"] ?? ""));
        return dir === "desc" ? -cmp : cmp;
      });
    }
    const limit = u.searchParams.get("limit");
    if (limit) out = out.slice(0, parseInt(limit, 10));
    return out;
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
      const u = new URL(String(url));
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.hostname === "api.resend.com") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        resendTo.push(String((body.to as string[] | undefined)?.[0] ?? ""));
        resendSeq += 1;
        return okRes({ id: `email_ac_${resendSeq}` });
      }
      if (u.hostname === "api.stripe.com") {
        if (u.pathname.includes("/customers/search")) {
          const query = u.searchParams.get("query") ?? "";
          const stateM = query.match(/metadata\['gh_state'\]:'([^']+)'/);
          const emailM = query.match(/email:'([^']+)'/);
          let found = [...customers];
          if (stateM) found = found.filter((c) => c.metadata["gh_state"] === stateM[1]);
          if (emailM) {
            const byEmail = visitRows.findIndex((r) => r["client_email"] === emailM[1]);
            if (byEmail >= 0) {
              return okRes({ data: [{ id: `cus_lb10_${byEmail}`, email: emailM[1], name: "Casey Client", metadata: {} }] });
            }
            found = found.filter((c) => c.email === emailM[1]);
          }
          return okRes({ data: found.map((c) => ({ ...c, metadata: { ...c.metadata } })) });
        }
        const pmM = u.pathname.match(/^\/v1\/customers\/([^/]+)\/payment_methods$/);
        if (pmM) {
          pmCalls.push(u.search);
          const startingAfter = u.searchParams.get("starting_after") ?? "";
          const start = startingAfter ? cards.indexOf(startingAfter) + 1 : 0;
          const page = cards.slice(start, start + 10);
          return okRes({ data: page.map((id) => ({ id })), has_more: start + 10 < cards.length });
        }
        const custM = u.pathname.match(/^\/v1\/customers\/([^/]+)$/);
        if (custM) {
          const id = custM[1];
          let cust = customers.find((c) => c.id === id);
          if (!cust && id.startsWith("cus_lb10_")) {
            const idx = parseInt(id.slice("cus_lb10_".length), 10);
            const row = visitRows[idx];
            if (row) cust = { id, email: String(row["client_email"]), name: "Casey Client", metadata: {} };
          }
          if (!cust) return okRes({ error: { message: "not found" } }, 404);
          if (method === "POST") {
            const params = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
            for (const [k, v] of params.entries()) {
              const mm = k.match(/^metadata\[(.+)\]$/);
              if (mm) cust.metadata[mm[1]] = v;
            }
          }
          return okRes({ ...cust, metadata: { ...cust.metadata } });
        }
        return okRes({ error: { message: "stripe route not stubbed" } }, 404);
      }
      if (u.hostname.includes("supabase")) {
        if (u.pathname.includes("/storage/v1/object/list/")) return okRes([]);
        if (u.pathname.includes("/storage/v1/object/") && method === "DELETE") {
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
          for (const p of (body.prefixes ?? [])) storageDeleted.push(p);
          return okRes({});
        }
        const table = u.pathname.split("/").pop() ?? "";
        if (table === "gh_visits") {
          if (method === "GET") return okRes(applyVisitFilters(u));
          if (method === "PATCH") {
            const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
            const matched = applyVisitFilters(u);
            for (const t of matched) Object.assign(t, body);
            const prefer = (init?.headers ?? {})["Prefer"] ?? (init?.headers ?? {})["prefer"] ?? "";
            return okRes(String(prefer).includes("return=representation") ? matched : {});
          }
          return okRes([]);
        }
        if (table === "gh_photos") {
          if (method === "GET") {
            if (u.searchParams.get("select")?.startsWith("storage_path")) {
              return okRes(photoRows.map((r) => ({ storage_path: r["storage_path"] })));
            }
            return okRes(applyPhotoFilters(u));
          }
          if (method === "DELETE") {
            const m = /id=eq\.([^&]+)/.exec(u.search);
            const id = m ? decodeURIComponent(m[1]) : "";
            if (failDbDeleteIds.has(id)) return okRes({ message: "db down" }, 500);
            const idx = photoRows.findIndex((r) => r["id"] === id);
            const removed = idx >= 0 ? photoRows.splice(idx, 1) : [];
            return okRes(removed);
          }
          return okRes([]);
        }
        if (table === "gh_events") {
          if (method === "POST") return okRes([{ id: 1 }]);
          return okRes([]);
        }
        if (table === "gh_visit_access") return okRes([]);
        return okRes([]);
      }
      return okRes(null, 404);
    }),
  );

  const runCron = async () => {
    const r = {
      code: 0, body: {} as Record<string, unknown>,
      status(code: number) { this.code = code; return this; },
      json(body: Record<string, unknown>) { this.body = body; },
      setHeader: vi.fn(), end: vi.fn(),
    };
    await (autoChargeHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: "GET", headers: { authorization: `Bearer ${CRON}` } }, r as never,
    );
    return r;
  };
  return { storageDeleted, resendTo, pmCalls, runCron };
}

describe("LB-44/LB-45 retention pass", () => {
  const oldPhoto = (i: number): ACRow => ({
    id: `ph-${i}`,
    visit_id: `v-${i}`,
    storage_path: `visits/v-${i}/kitchen/a.jpg`,
    created_at: new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString(),
    gh_visits: { booking_id: `bid-${i}`, report_sent_at: "2026-08-01T00:00:00.000Z", issue_open: false, issue_ever: false, status: "paid" },
  });
  it("LB-44: 250 old paid photos are all deleted, not just the first 200", async () => {
    const mock = installAutoChargeMock({ photoRows: Array.from({ length: 250 }, (_, i) => oldPhoto(i)) });
    const r = await mock.runCron();
    expect(r.code).toBe(200);
    expect(r.body["photo_retention_deleted"]).toBe(250);
    expect(r.body["photo_retention_failed"]).toBe(0);
    expect(mock.storageDeleted).toHaveLength(250);
  });
  it("LB-45: a failed DB delete retries, then fails loudly with the storage path", async () => {
    const mock = installAutoChargeMock({
      photoRows: [oldPhoto(0), oldPhoto(1), oldPhoto(2)],
      failDbDeleteIds: new Set(["ph-1"]),
    });
    const r = await mock.runCron();
    expect(r.code).toBe(200);
    expect(r.body["photo_retention_deleted"]).toBe(2);
    expect(r.body["photo_retention_failed"]).toBe(1);
    expect(mock.storageDeleted).toContain("visits/v-1/kitchen/a.jpg");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("visits/v-1/kitchen/a.jpg"));
  });
});

describe("LB-10 receipt backfill serves null paid_at first", () => {
  it("a null-paid_at row gets its receipt ahead of dated rows", async () => {
    const rows: ACRow[] = [
      { id: "row-null", booking_id: "bid-lb10-null", visit_no: 1, client_email: "client-lb10-null@example.com", client_name: "Casey Client", amount_cents: 18900, status: "paid", paid_at: null, receipt_email_id: null, report_status: "paid", visit_date: "2026-10-01" },
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `row-${i}`, booking_id: `bid-lb10-${i}`, visit_no: 1,
        client_email: `client-lb10-${i}@example.com`, client_name: "Casey Client",
        amount_cents: 18900, status: "paid",
        paid_at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
        receipt_email_id: null, report_status: "paid", visit_date: "2026-10-01",
      })),
    ];
    const mock = installAutoChargeMock({ visitRows: rows });
    const r = await mock.runCron();
    expect(r.code).toBe(200);
    expect(r.body["receipts"]).toBe(50);
    expect(mock.resendTo).toContain("client-lb10-null@example.com");
    expect(mock.resendTo).toContain("client-lb10-0@example.com");
    expect(mock.resendTo).toContain("client-lb10-48@example.com");
    expect(mock.resendTo).not.toContain("client-lb10-49@example.com");
    expect(mock.resendTo).not.toContain("client-lb10-59@example.com");
  });
});

describe("LB-06 cron card list is paged", () => {
  it("reconcile lists payment methods with limit=100 across pages", async () => {
    const sentAt = new Date(Date.now() - 3600 * 1000).toISOString();
    const mock = installAutoChargeMock({
      customers: [{
        id: "cus_lb06", email: "c@example.com", name: "Casey Client",
        metadata: {
          gh_state: "report_sent", gh_booking_id: "bid-lb06",
          gh_report_sent_at: sentAt, gh_report_amount_cents: "149", gh_first_price_cents: "149",
        },
      }],
      cards: Array.from({ length: 11 }, (_, i) => `pm_${String(i + 1).padStart(2, "0")}`),
    });
    const r = await mock.runCron();
    expect(r.code).toBe(200);
    // The paged lister fetches limit=100 pages (not the old single
    // page of 10): page 1 returns 10 cards + has_more, page 2 the
    // 11th via starting_after.
    expect(mock.pmCalls.length).toBe(2);
    expect(mock.pmCalls[0]).toContain("limit=100");
    expect(mock.pmCalls[1]).toContain("starting_after=pm_10");
  });
});
