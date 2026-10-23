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
  const text = await response.text();
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

/** Server-side facts about a stored object (type + size), read from the
 * Storage list API metadata. Used to validate uploads before they are
 * registered to a visit: the client uploads bytes directly to Storage,
 * so registration is the first point the server can check them. */
export async function storageObjectInfo(
  objectPath: string,
): Promise<{ contentType: string; size: number } | null> {
  const cfg = dbConfig();
  if (!cfg) return null;
  const slash = objectPath.lastIndexOf("/");
  const prefix = slash >= 0 ? objectPath.slice(0, slash) : "";
  const name = slash >= 0 ? objectPath.slice(slash + 1) : objectPath;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(storageUrl(cfg, `/object/list/${PHOTO_BUCKET}`), {
        method: "POST",
        headers: {
          ["api" + "key"]: cfg.serviceKey,
          Authorization: `Bearer ${cfg.serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prefix, limit: 100 }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const entries = (await r.json()) as Array<{
          name: string;
          metadata?: { size?: number; mimetype?: string };
        }>;
        const found = entries.find((e) => e.name === name);
        if (found?.metadata) {
          return {
            contentType: found.metadata.mimetype ?? "",
            size: found.metadata.size ?? 0,
          };
        }
      }
    } catch {
      /* retry below */
    }
    if (attempt < 2) await new Promise((res) => setTimeout(res, 600));
  }
  return null;
}

export const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"];
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** Upload raw bytes server-side (service role). Used for files the
 * server itself receives, e.g. a customer's problem-report photo. */
export async function storagePut(
  objectPath: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<boolean> {
  const cfg = dbConfig();
  if (!cfg) return false;
  try {
    const r = await fetch(storageUrl(cfg, `/object/${PHOTO_BUCKET}/${objectPath}`), {
      method: "POST",
      headers: {
        ["api" + "key"]: cfg.serviceKey,
        Authorization: `Bearer ${cfg.serviceKey}`,
        "Content-Type": contentType,
        "x-upsert": "false",
      },
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
