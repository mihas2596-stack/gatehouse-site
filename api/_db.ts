// Supabase (Postgres + Storage) access for the visit pipeline.
// The database is the source of truth for visits, reports, photos and
// events; Stripe stays the payment system and the booking anchor.
// No SDK: plain PostgREST / Storage REST calls, service-role key, server
// side only. When the env vars are absent every helper reports
// "not configured" and callers fall back to the legacy Stripe-metadata
// behavior — the migration bridge, not a parallel mechanism.

type DbConfig = { url: string; key: string };

export function dbConfig(): DbConfig | null {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

export const dbConfigured = (): boolean => dbConfig() !== null;

async function rest(
  cfg: DbConfig,
  path: string,
  init: RequestInit & { prefer?: string } = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const { prefer, ...restInit } = init;
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/rest/v1/${path}`, {
      ...restInit,
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
        ...(restInit.headers ?? {}),
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // Network/DNS/invalid-URL: the DB is unreachable. Degrade to the
    // legacy behavior (callers already treat !ok / empty as "no DB row")
    // instead of crashing the whole function.
    return { ok: false, status: 0, data: null };
  }
  let data: unknown = null;
  let text = "";
  try {
    text = await response.text();
  } catch {
    // A response without a readable body degrades to "no data", like a
    // network failure — it must never throw out of the DB layer.
    return { ok: response.ok, status: response.status, data: null };
  }
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { ok: response.ok, status: response.status, data };
}

export async function dbSelect<T = Record<string, unknown>>(
  table: string,
  query: string,
): Promise<T[]> {
  const cfg = dbConfig();
  if (!cfg) return [];
  const r = await rest(cfg, `${table}?${query}`);
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data as T[];
}

// Strict select: unlike dbSelect, a database error is NOT silently
// returned as "no rows". Money gates must distinguish "no row" (legacy
// path) from "database unreadable" (fail closed, RA04): a 503 on
// gh_visits must never let a charge fall back to shared metadata.
export async function dbSelectStrict<T = Record<string, unknown>>(
  table: string,
  query: string,
): Promise<{ ok: boolean; rows: T[] }> {
  const cfg = dbConfig();
  if (!cfg) return { ok: false, rows: [] };
  const r = await rest(cfg, `${table}?${query}`);
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, rows: [] };
  return { ok: true, rows: r.data as T[] };
}

export async function dbInsert<T = Record<string, unknown>>(
  table: string,
  row: Record<string, unknown>,
): Promise<T | null> {
  const cfg = dbConfig();
  if (!cfg) return null;
  const r = await rest(cfg, table, {
    method: "POST",
    body: JSON.stringify(row),
    prefer: "return=representation",
  });
  if (!r.ok || !Array.isArray(r.data) || !r.data[0]) return null;
  return r.data[0] as T;
}

export async function dbUpdate(
  table: string,
  match: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const cfg = dbConfig();
  if (!cfg) return false;
  const r = await rest(cfg, `${table}?${match}`, {
    method: "PATCH",
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    prefer: "return=minimal",
  });
  return r.ok;
}

/**
 * Conditional update with a row count (compare-and-swap for status
 * transitions, R01). PATCHes only rows matching `match` and returns
 * how many changed: 0 means another request already moved the row out
 * of the expected state, so the caller must return the existing result
 * instead of publishing twice. Returns -1 when the DB is not
 * configured or unreachable — callers must fail closed on -1 (RA15:
 * no email, no event, no state change), never fall through to a
 * non-atomic legacy path.
 */
export async function dbUpdateCount(
  table: string,
  match: string,
  patch: Record<string, unknown>,
): Promise<number> {
  const cfg = dbConfig();
  if (!cfg) return -1;
  const r = await rest(cfg, `${table}?${match}`, {
    method: "PATCH",
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    prefer: "return=representation",
  });
  if (!r.ok || !Array.isArray(r.data)) return -1;
  return r.data.length;
}

/** Upsert on a unique constraint (e.g. booking_id,visit_no). */
export async function dbUpsert<T = Record<string, unknown>>(
  table: string,
  row: Record<string, unknown>,
  onConflict: string,
): Promise<T | null> {
  const cfg = dbConfig();
  if (!cfg) return null;
  const r = await rest(cfg, `${table}?on_conflict=${onConflict}`, {
    method: "POST",
    body: JSON.stringify(row),
    prefer: "resolution=merge-duplicates,return=representation",
  });
  if (!r.ok || !Array.isArray(r.data) || !r.data[0]) return null;
  return r.data[0] as T;
}

export async function dbDelete(table: string, match: string): Promise<boolean> {
  const cfg = dbConfig();
  if (!cfg) return false;
  const r = await rest(cfg, `${table}?${match}`, { method: "DELETE", prefer: "return=minimal" });
  return r.ok;
}

/**
 * Counted delete (N09): unlike dbDelete, a 2xx that matched zero rows
 * is distinguishable from a real deletion, and a DB error is -1.
 * Callers that must PROVE a secret row is gone (delete_entry, revoke)
 * use this, never the ok-only variant: PostgREST returns 2xx for a
 * DELETE that matched nothing, so ok alone cannot prove removal.
 */
export async function dbDeleteCount(table: string, match: string): Promise<number> {
  const cfg = dbConfig();
  if (!cfg) return -1;
  const r = await rest(cfg, `${table}?${match}`, { method: "DELETE", prefer: "return=representation" });
  if (!r.ok || !Array.isArray(r.data)) return -1;
  return r.data.length;
}

export async function logEvent(
  visitId: string | null,
  bookingId: string | null,
  actor: string,
  event: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  if (!dbConfigured()) return;
  await dbInsert("gh_events", {
    visit_id: visitId,
    booking_id: bookingId,
    actor,
    event,
    detail: detail ?? null,
  });
}

/**
 * Verified journal write (N03/N14): authoritative events (issue_opened,
 * visit_confirmed, payment attempts) must be PROVEN stored before the
 * caller reports success. Returns false when the DB is not configured
 * or the insert failed — callers then fail closed or roll back instead
 * of telling the client a fact was recorded.
 */
export async function logEventStrict(
  visitId: string | null,
  bookingId: string | null,
  actor: string,
  event: string,
  detail?: Record<string, unknown>,
): Promise<boolean> {
  if (!dbConfigured()) return false;
  const inserted = await dbInsert("gh_events", {
    visit_id: visitId,
    booking_id: bookingId,
    actor,
    event,
    detail: detail ?? null,
  });
  return inserted !== null;
}

// ---------- Storage (private bucket "report-photos") ----------

export const PHOTO_BUCKET = "report-photos";

function storageUrl(cfg: DbConfig, path: string): string {
  return `${cfg.url}/storage/v1${path}`;
}

/** Signed URL the cleaner uploads one file to (PUT, upsert=false). */
export async function storageSignUpload(
  objectPath: string,
): Promise<{ signedUrl: string } | null> {
  const cfg = dbConfig();
  if (!cfg) return null;
  let r: Response;
  try {
    r = await fetch(
      storageUrl(cfg, `/object/upload/sign/${PHOTO_BUCKET}/${objectPath}`),
      {
        method: "POST",
        headers: {
          apikey: cfg.key,
          Authorization: `Bearer ${cfg.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    return null;
  }
  if (!r.ok) return null;
  // The upload-sign endpoint returns { url: "/object/upload/sign/..." }
  // (verified against @supabase/storage-js createSignedUploadUrl, which
  // reads data.url — NOT signedURL; that field belongs to download-sign).
  const data = (await r.json()) as { url?: string; signedURL?: string };
  const rel = data.url ?? data.signedURL;
  if (!rel) return null;
  return { signedUrl: `${cfg.url}/storage/v1${rel}` };
}

/** Signed read URL for one private object. */
export async function storageSignDownload(
  objectPath: string,
  expiresInSeconds: number,
): Promise<string | null> {
  const cfg = dbConfig();
  if (!cfg) return null;
  let r: Response;
  try {
    r = await fetch(storageUrl(cfg, `/object/sign/${PHOTO_BUCKET}/${objectPath}`), {
      method: "POST",
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const data = (await r.json()) as { signedURL?: string };
  if (!data.signedURL) return null;
  return `${cfg.url}/storage/v1${data.signedURL}`;
}

/** Server-side facts about a stored object (type + size). Used to
 * validate uploads before they are registered to a visit: the client
 * uploads bytes directly to Storage, so registration is the first
 * point the server can check them. Primary probe: an authenticated
 * HEAD on the object endpoint; fallback: headers of a signed download
 * URL. Retried — a just-uploaded object can take a moment to appear. */
export async function storageObjectInfo(
  objectPath: string,
): Promise<{ contentType: string; size: number } | null> {
  const cfg = dbConfig();
  if (!cfg) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(storageUrl(cfg, `/object/${PHOTO_BUCKET}/${objectPath}`), {
        method: "HEAD",
        headers: {
          ["api" + "key"]: cfg.key,
          Authorization: `Bearer ${cfg.key}`,
        },
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const size = parseInt(r.headers.get("content-length") ?? "", 10);
        return {
          contentType: r.headers.get("content-type") ?? "",
          size: Number.isFinite(size) ? size : 0,
        };
      }
    } catch {
      /* fall through to the signed-URL probe */
    }
    try {
      const signed = await storageSignDownload(objectPath, 120);
      if (signed) {
        const r = await fetch(signed, { method: "HEAD", signal: AbortSignal.timeout(15000) });
        if (r.ok) {
          const size = parseInt(r.headers.get("content-length") ?? "", 10);
          return {
            contentType: r.headers.get("content-type") ?? "",
            size: Number.isFinite(size) ? size : 0,
          };
        }
      }
    } catch {
      /* retry below */
    }
    if (attempt < 2) await new Promise((res) => setTimeout(res, 700));
  }
  return null;
}

export const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"];
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** Upload raw bytes server-side (service role). Used for files the
 * server itself receives, e.g. a customer's problem-report photo.
 * Goes through the signed-upload flow — the same path browser uploads
 * use — instead of a direct object POST. */
export async function storagePut(
  objectPath: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<boolean> {
  const signed = await storageSignUpload(objectPath);
  if (!signed) return false;
  try {
    const r = await fetch(signed.signedUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType, "x-upsert": "false" },
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(20000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function storageRemove(objectPath: string): Promise<boolean> {
  const cfg = dbConfig();
  if (!cfg) return false;
  let r: Response;
  try {
    r = await fetch(storageUrl(cfg, `/object/${PHOTO_BUCKET}`), {
      method: "DELETE",
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefixes: [objectPath] }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return false;
  }
  return r.ok;
}

// ---------- Cleaner link tokens ----------

import { createHash, randomBytes, timingSafeEqual } from "crypto";

export function newCleanerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenHashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
