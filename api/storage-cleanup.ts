// Orphan-photo cleanup (M5c) — the sign→register gap in api/cleaner.ts.
//
// A cleaner upload is two steps: photo_sign mints a signed upload URL
// for `visits/<visitId>/<room>/<ts>-<rand>.jpg`, the browser PUTs the
// bytes straight to Storage, and photo_register records the row in
// gh_photos. If the register never lands (failed request, closed tab,
// crash), the bytes sit in Storage with no DB row: an orphan. The
// 90-day retention pass in api/auto-charge.ts only deletes REGISTERED
// photos, so orphans would accumulate forever without this pass.
//
// Rules (deliberately conservative — deleting bytes is irreversible):
// - only objects older than 24h: a register retry happens within
//   seconds, so a day-old unregistered object is abandoned, not
//   in-flight;
// - only objects with NO gh_photos row for their storage_path
//   (checked one by one, never from a truncated list);
// - only when the visit row exists AND has no open/ever issue: an
//   orphan from a disputed visit may be the cleaner's only copy of
//   evidence, and a visit row that cannot be read is never assumed
//   clean (fail closed — the bytes are harmless where they are);
// - at most 50 deletions per run, so one run can never empty a bucket.
//
// Schedule: Vercel has no free cron slot (both slots are
// /api/auto-charge, 10:00 and 22:00), so the twice-daily auto-charge
// run calls cleanupOrphanPhotos() best-effort. The handler below is
// the same run on demand, admin-only (ADMIN_TOKEN bearer or a valid
// owner session, same as /api/owner).
//
// Storage listing: the list endpoint returns one level at a time —
// entries with no id/metadata are subfolders — so the walk recurses
// (depth ≤ 4, total ≤ 500 objects per run) instead of assuming a flat
// prefix listing.

import { dbConfigured, dbConfig, dbSelect, dbDelete, logEvent, storageRemove, PHOTO_BUCKET } from "./_db.js";
import { isOwnerAuth } from "./_owner_auth.js";

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
};
type Res = {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

/** An unregistered upload may sit for a day while the cleaner retries;
// older than this, it is abandoned, not in-flight. */
export const ORPHAN_MIN_AGE_MS = 24 * 3600 * 1000;
/** Per-run bounds: the walk and the deletions both stop here. */
export const ORPHAN_LIST_MAX = 500;
export const ORPHAN_DELETE_MAX = 50;

export type StorageObject = { path: string; updatedAt: string | null };

type ListEntry = {
  name: string;
  id?: string | null;
  updated_at?: string | null;
  metadata?: { size?: number; mimetype?: string } | null;
};

async function listOneLevel(prefix: string): Promise<ListEntry[] | null> {
  const cfg = dbConfig();
  if (!cfg) return null;
  try {
    const r = await fetch(`${cfg.url}/storage/v1/object/list/${PHOTO_BUCKET}`, {
      method: "POST",
      headers: {
        ["api" + "key"]: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefix, limit: 100, offset: 0, sortBy: { column: "name", order: "asc" } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const data: unknown = await r.json();
    if (!Array.isArray(data)) return null;
    return data as ListEntry[];
  } catch {
    return null;
  }
}

/**
 * Every object under a prefix, recursing into subfolders. Returns
 * null when Storage cannot be listed at all (callers fail open for
 * the sign cap, fail closed for deletion). Bounded: depth ≤ 4 and
 * ORPHAN_LIST_MAX objects — a run never walks an unbounded bucket.
 */
export async function storageListObjects(
  prefix: string,
  maxObjects: number = ORPHAN_LIST_MAX,
): Promise<StorageObject[] | null> {
  const out: StorageObject[] = [];
  const walk = async (p: string, depth: number): Promise<boolean> => {
    if (depth > 4 || out.length >= maxObjects) return false;
    const entries = await listOneLevel(p);
    if (entries === null) return false;
    for (const e of entries) {
      if (out.length >= maxObjects) return false;
      const isFile = e.metadata != null && typeof e.metadata.size === "number";
      if (isFile) {
        out.push({ path: `${p}${e.name}`, updatedAt: e.updated_at ?? null });
      } else if (e.id == null) {
        // A subfolder entry: recurse into it (its name is the folder).
        if (!(await walk(`${p}${e.name}/`, depth + 1))) return false;
      }
      // Anything else (an entry with an id but no file metadata) is
      // neither a file we own nor a folder — skip it, never delete it.
    }
    return true;
  };
  const ok = await walk(prefix, 0);
  return ok ? out : null;
}

/** Pure count: listed objects with no registered row. Exported for tests. */
export function countUnregisteredObjects(
  listed: StorageObject[],
  registeredPaths: string[],
): number {
  const registered = new Set(registeredPaths);
  let n = 0;
  for (const o of listed) if (!registered.has(o.path)) n++;
  return n;
}

/**
 * Pure orphan selection: unregistered objects older than
 * ORPHAN_MIN_AGE_MS. The visit/dispute check is NOT pure (it reads
 * the DB) and runs per candidate in cleanupOrphanPhotos below.
 * Exported for tests.
 */
export function selectOrphanPhotos(
  listed: StorageObject[],
  registeredPaths: string[],
  nowMs: number = Date.now(),
): StorageObject[] {
  const registered = new Set(registeredPaths);
  return listed.filter((o) => {
    if (registered.has(o.path)) return false;
    const updated = o.updatedAt ? Date.parse(o.updatedAt) : NaN;
    if (!Number.isFinite(updated)) return false;
    return nowMs - updated >= ORPHAN_MIN_AGE_MS;
  });
}

export type OrphanCleanupResult = {
  checked: number;
  deleted: number;
  failed: number;
  skipped: number;
};

/**
 * One cleanup run: list objects under `visits/`, and delete the
 * orphans (see the module header for the safety rules). Never throws
 * for a partial failure — counts it and moves on, so the cron caller
 * can log the outcome instead of failing the whole run.
 */
export async function cleanupOrphanPhotos(
  opts: { nowMs?: number; prefix?: string } = {},
): Promise<OrphanCleanupResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const result: OrphanCleanupResult = { checked: 0, deleted: 0, failed: 0, skipped: 0 };
  if (!dbConfigured()) return result;
  const listed = await storageListObjects(opts.prefix ?? "visits/", ORPHAN_LIST_MAX);
  if (listed === null) return result;
  // Registered paths, oldest-first so the per-candidate check below
  // sees the same set the retention pass uses. The set is only a
  // pre-filter — every candidate is re-checked by exact path before
  // any delete, so a truncated set can never cause a wrong delete.
  const registered = await dbSelect<{ storage_path: string }>(
    "gh_photos",
    "select=storage_path&order=created_at.asc&limit=2000",
  );
  const registeredPaths = registered.map((r) => r.storage_path);
  const candidates = selectOrphanPhotos(listed, registeredPaths, nowMs);
  for (const obj of candidates) {
    if (result.deleted >= ORPHAN_DELETE_MAX) break;
    result.checked++;
    try {
      // Exact re-check: the object must still be unregistered now.
      const stillThere = await dbSelect<{ id: string }>(
        "gh_photos",
        `storage_path=eq.${encodeURIComponent(obj.path)}&limit=1`,
      );
      if (stillThere.length > 0) { result.skipped++; continue; }
      // The visit id is the second path segment
      // (visits/<visitId>/<room>/<file>). No visit row, or a disputed
      // visit, means hands off — see the module header.
      const visitId = obj.path.split("/")[1] ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(visitId)) { result.skipped++; continue; }
      const visits = await dbSelect<{ id: string; issue_open?: boolean | null; issue_ever?: boolean | null }>(
        "gh_visits",
        `id=eq.${encodeURIComponent(visitId)}&limit=1`,
      );
      const visit = visits[0];
      if (!visit || visit.issue_open === true || visit.issue_ever === true) {
        result.skipped++;
        continue;
      }
      if (!(await storageRemove(obj.path))) { result.failed++; continue; }
      await logEvent(visit.id, null, "system", "orphan_photo_deleted", { storage_path: obj.path });
      result.deleted++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

export default async function handler(req: Req, res: Res) {
  const requestId = Math.random().toString(36).slice(2);
  const json = (status: number, body: Record<string, unknown>) =>
    res.status(status).json({ requestId, ...body });
  if (req.method !== "GET" && req.method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }
  const ADMIN_TOKEN = process.env["ADMIN_TOKEN"];
  if (!ADMIN_TOKEN) return json(500, { ok: false, error: "server_error" });
  const authRaw = req.headers["authorization"];
  const auth = Array.isArray(authRaw) ? authRaw[0] : authRaw ?? "";
  if (!isOwnerAuth(auth, ADMIN_TOKEN, Math.floor(Date.now() / 1000))) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  try {
    const result = await cleanupOrphanPhotos();
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error(JSON.stringify({ requestId, step: "storage-cleanup", error: err instanceof Error ? err.message : String(err) }));
    return json(500, { ok: false, error: "server_error" });
  }
}
