// C14 (09.11.2026): persistent webhook dedup, shared by the Stripe
// and Resend webhook receivers.
//
// One row per (source, event_id) in gh_webhook_events, written only
// AFTER successful processing — so a delivery the handler failed
// (5xx) is still retried by the provider instead of being swallowed
// as a duplicate. A row is the cross-instance proof; an in-memory Set
// is kept only as a same-process fallback when the DB is not
// configured (or the table is not migrated yet) — it is bounded (2000
// entries, 24h TTL, oldest-first eviction), and the DB remains the
// authority whenever it answers.
//
// Callers: check webhookEventSeen() after signature verification and
// before any state write; call recordWebhookEvent() on the success
// path only (200), never on a 4xx/5xx return.

import { dbConfigured, dbInsert, dbSelect } from "./_db.js";

export type WebhookSource = "stripe" | "resend";

// Same-process fallback only (DB unconfigured / table missing).
// LB-08 (DA-22): BOUNDED, like createWebhookSeenSet in
// stripe-webhook.ts (same 2000-entry / 24h limits) — the old plain
// Set never cleared itself. Kept local: stripe-webhook.ts imports
// this module, so importing the factory from there would be circular.
// Eviction is safe: the persistent gh_webhook_events row is the
// cross-instance authority, and this set is only a same-process
// fallback when the DB does not answer.
const FALLBACK_MAX = 2000;
const FALLBACK_TTL_MS = 24 * 3600 * 1000;
const seenFallback = new Map<string, number>();

function fallbackHas(key: string): boolean {
  const at = seenFallback.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > FALLBACK_TTL_MS) {
    seenFallback.delete(key);
    return false;
  }
  return true;
}

function fallbackAdd(key: string): void {
  // Re-insert to refresh recency; Map iterates in insertion order,
  // so the oldest entry is always first.
  if (seenFallback.has(key)) seenFallback.delete(key);
  seenFallback.set(key, Date.now());
  while (seenFallback.size > FALLBACK_MAX) {
    const oldest = seenFallback.keys().next().value;
    if (oldest === undefined) break;
    seenFallback.delete(oldest);
  }
}

const keyOf = (source: WebhookSource, eventId: string): string => `${source}:${eventId}`;

/** True when this event id was already processed (persistently, or in this process). */
export async function webhookEventSeen(source: WebhookSource, eventId: string): Promise<boolean> {
  if (!eventId) return false;
  if (fallbackHas(keyOf(source, eventId))) return true;
  if (!dbConfigured()) return false;
  const rows = await dbSelect<{ event_id: string }>(
    "gh_webhook_events",
    `source=eq.${encodeURIComponent(source)}&event_id=eq.${encodeURIComponent(eventId)}&limit=1`,
  );
  return rows.length > 0;
}

/**
 * Record a successfully processed event. Returns false when the row
 * could not be written (DB unconfigured, table not migrated yet, or
 * a write error) — the caller keeps processing; the in-memory
 * fallback still dedupes within this process.
 */
export async function recordWebhookEvent(
  source: WebhookSource,
  eventId: string,
  eventType?: string,
): Promise<boolean> {
  if (!eventId) return false;
  fallbackAdd(keyOf(source, eventId));
  if (!dbConfigured()) return false;
  const inserted = await dbInsert<{ event_id: string }>("gh_webhook_events", {
    source,
    event_id: eventId,
    event_type: eventType ?? null,
  });
  return inserted !== null;
}
