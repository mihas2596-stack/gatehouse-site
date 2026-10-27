// Per-visit entry arrangements — SEPARATE from general notes and from
// Stripe customer metadata (spec A §6).
//
// Model: one gh_visit_access row per visit (see
// supabase/migrations/20261026_visit_access.sql). The row holds the
// client's chosen method, a non-secret note (intercom/parking) and, for
// the "arrange entry" method only, an entry secret encrypted at rest
// with AES-256-GCM under a server-only key derived from
// VISIT_ACCESS_KEY or ADMIN_TOKEN. Nothing here is ever written to
// Stripe metadata, to gh_events detail, to emails, or to logs: journal
// events record only that an entry was saved/deleted/revoked, never
// its content. The secret is never returned to the client UI — the
// client sees only has_secret — and is returned to the cleaner only
// while the current roster assignment matches, and to the owner only
// in the authenticated owner detail view.
//
// Retention rule (fixed, automatic): the row is deleted when the visit
// is cancelled, when the cleaner finishes (report submitted/sent), and
// when it expires — visit date + 2 days, or 14 days after saving when
// the visit has no date. Expired rows are also removed lazily on read
// and by the auto-charge cron's retention pass. Nothing is kept
// indefinitely for future visits by default.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { dbConfigured, dbSelect, dbInsert, dbUpdate, dbDelete } from "./_db.js";

export type EntryMethod = "home" | "someone" | "arrange";
export const ENTRY_METHODS: EntryMethod[] = ["home", "someone", "arrange"];
export const ENTRY_METHOD_LABEL: Record<EntryMethod, string> = {
  home: "I’ll be home to let the cleaner in.",
  someone: "Someone else will meet the cleaner.",
  arrange: "I’ll arrange entry before the visit.",
};

export type AccessRow = {
  id: string;
  visit_id: string;
  booking_id: string;
  entry_method: EntryMethod | null;
  entry_note: string | null;
  entry_secret: string | null;
  assigned_cleaner_id: string | null;
  expires_at: string | null;
  created_at?: string | null;
};

export type ClientEntryView = {
  available: boolean;
  method: EntryMethod | null;
  note: string;
  has_secret: boolean;
  expires_at: string | null;
};

function accessKey(): Buffer | null {
  const raw = process.env["VISIT_ACCESS_KEY"] ?? process.env["ADMIN_TOKEN"] ?? "";
  if (!raw) return null;
  return createHash("sha256").update(`gatehouse-visit-access:${raw}`).digest();
}

export function encryptEntrySecret(plain: string): string | null {
  const key = accessKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${Buffer.concat([tag, ct]).toString("base64url")}`;
}

export function decryptEntrySecret(stored: string | null): string | null {
  if (!stored) return null;
  const key = accessKey();
  if (!key) return null;
  try {
    const parts = stored.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return null;
    const iv = Buffer.from(parts[1], "base64url");
    const buf = Buffer.from(parts[2], "base64url");
    const tag = buf.subarray(0, 16);
    const ct = buf.subarray(16);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Expiry for a saved entry: visit date + 2 days, else 14 days after saving. */
export function entryExpiresAt(visitDate: string | null, nowMs = Date.now()): string {
  if (visitDate) {
    const d = new Date(`${visitDate}T12:00:00Z`);
    if (!Number.isNaN(d.getTime())) return new Date(d.getTime() + 2 * 24 * 3600 * 1000).toISOString();
  }
  return new Date(nowMs + 14 * 24 * 3600 * 1000).toISOString();
}

export function isAccessExpired(row: AccessRow, nowMs = Date.now()): boolean {
  return Boolean(row.expires_at && Date.parse(row.expires_at) <= nowMs);
}

export async function loadAccess(visitId: string): Promise<AccessRow | null> {
  if (!dbConfigured()) return null;
  const rows = await dbSelect<AccessRow>(
    "gh_visit_access",
    `visit_id=eq.${encodeURIComponent(visitId)}&limit=1`,
  );
  const row = rows[0] ?? null;
  if (row && isAccessExpired(row)) {
    await dbDelete("gh_visit_access", `visit_id=eq.${encodeURIComponent(visitId)}`);
    return null;
  }
  return row;
}

/**
 * Save (or update) the client's entry arrangement. Home/someone never
 * carry a secret: any secret sent with them is rejected by the caller.
 * Returns ok:false with entry_key_missing when a secret cannot be
 * encrypted (no server key) — the method/note are still saved, the
 * secret is not stored in cleartext anywhere.
 */
export async function saveAccess(args: {
  visitId: string;
  bookingId: string;
  method: EntryMethod;
  note: string;
  secret: string;
  cleanerId: string | null;
  visitDate: string | null;
}): Promise<{ ok: boolean; error?: string; row: AccessRow | null }> {
  if (!dbConfigured()) return { ok: false, error: "db_not_configured", row: null };
  let encrypted: string | null = null;
  if (args.secret) {
    encrypted = encryptEntrySecret(args.secret);
    if (!encrypted) {
      // Save method/note, but never the cleartext secret.
      const existing = await loadAccess(args.visitId);
      const patch = {
        entry_method: args.method,
        entry_note: args.note || null,
        assigned_cleaner_id: args.cleanerId,
        expires_at: entryExpiresAt(args.visitDate),
      };
      if (existing) {
        await dbUpdate("gh_visit_access", `id=eq.${existing.id}`, { ...patch, entry_secret: null });
      } else {
        await dbInsert("gh_visit_access", {
          visit_id: args.visitId, booking_id: args.bookingId, ...patch, entry_secret: null,
        });
      }
      return { ok: false, error: "entry_key_missing", row: null };
    }
  }
  const existing = await loadAccess(args.visitId);
  const base = {
    entry_method: args.method,
    entry_note: args.note || null,
    entry_secret: encrypted,
    assigned_cleaner_id: args.cleanerId,
    expires_at: entryExpiresAt(args.visitDate),
  };
  if (existing) {
    const ok = await dbUpdate("gh_visit_access", `id=eq.${existing.id}`, base);
    return { ok, row: ok ? { ...existing, ...base } : null };
  }
  const created = await dbInsert<AccessRow>("gh_visit_access", {
    visit_id: args.visitId, booking_id: args.bookingId, ...base,
  });
  return { ok: created !== null, row: created };
}

/** Update only the non-secret note, preserving method and secret. */
export async function saveAccessNote(
  visitId: string,
  bookingId: string,
  note: string,
): Promise<boolean> {
  if (!dbConfigured()) return false;
  const existing = await loadAccess(visitId);
  if (existing) return dbUpdate("gh_visit_access", `id=eq.${existing.id}`, { entry_note: note || null });
  return (await dbInsert("gh_visit_access", {
    visit_id: visitId, booking_id: bookingId,
    entry_method: null, entry_note: note || null, entry_secret: null,
    assigned_cleaner_id: null, expires_at: entryExpiresAt(null),
  })) !== null;
}

export async function deleteAccess(visitId: string): Promise<void> {
  if (!dbConfigured()) return;
  await dbDelete("gh_visit_access", `visit_id=eq.${encodeURIComponent(visitId)}`);
}

/**
 * Cleaner change revokes the previous cleaner's access: the secret is
 * cleared and the row is re-bound to the new roster cleaner. The chosen
 * method is kept (it is not a secret); the client is prompted to add
 * details for the new cleaner when the method is "arrange".
 */
export async function revokeAccessForCleanerChange(
  visitId: string,
  newCleanerId: string | null,
): Promise<void> {
  if (!dbConfigured()) return;
  const existing = await loadAccess(visitId);
  if (!existing) return;
  if (existing.assigned_cleaner_id === newCleanerId) return;
  await dbUpdate("gh_visit_access", `id=eq.${existing.id}`, {
    entry_secret: null,
    assigned_cleaner_id: newCleanerId,
  });
}

export function clientEntryView(row: AccessRow | null, available: boolean): ClientEntryView {
  if (!available || !row) {
    return { available, method: null, note: "", has_secret: false, expires_at: null };
  }
  return {
    available,
    method: row.entry_method,
    note: row.entry_note ?? "",
    has_secret: Boolean(row.entry_secret),
    expires_at: row.expires_at,
  };
}

/**
 * Cleaner visibility, checked on EVERY cleaner GET: the visit must be
 * confirmed, not cancelled, not finished (report not submitted/sent),
 * not expired, and the visit's current roster cleaner_id must equal
 * the id the client saved the entry under. Same name, different
 * cleaner_id → no secret. A name-only assignment (no roster id) never
 * exposes a secret.
 */
export function cleanerEntryView(
  row: AccessRow | null,
  visit: { status: string; report_status: string; cleaner_id: string | null },
  confirmed: boolean,
): { method: EntryMethod | null; note: string; secret: string | null } | null {
  if (!row || !confirmed) return null;
  if (visit.status === "cancelled") return null;
  if (visit.report_status === "submitted" || visit.report_status === "sent") return null;
  if (isAccessExpired(row)) return null;
  if (!visit.cleaner_id || !row.assigned_cleaner_id || visit.cleaner_id !== row.assigned_cleaner_id) return null;
  return {
    method: row.entry_method,
    note: row.entry_note ?? "",
    secret: decryptEntrySecret(row.entry_secret),
  };
}
