// C14 (09.11.2026): persistent webhook dedup, shared by the Stripe
// and Resend webhook receivers.
//
// One row per (source, event_id) in gh_webhook_events, written only
// AFTER successful processing — so a delivery the handler failed
// (5xx) is still retried by the provider instead of being swallowed
// as a duplicate. A row is the cross-instance proof; an in-memory Set
// is kept only as a same-process fallback when the DB is not
// configured (or the table is not migrated yet) — it never clears
// itself, and the DB remains the authority whenever it answers.
//
// Callers: check webhookEventSeen() after signature verification and
// before any state write; call recordWebhookEvent() on the success
// path only (200), never on a 4xx/5xx return.

import { dbConfigured, dbInsert, dbSelect } from "./_db.js";

export type WebhookSource = "stripe" | "resend";

// Same-process fallback only (DB unconfigured / table missing).
const seenFallback = new Set<string>();

const keyOf = (source: WebhookSource, eventId: string): string => `${source}:${eventId}`;

/** True when this event id was already processed (persistently, or in this process). */
export async function webhookEventSeen(source: WebhookSource, eventId: string): Promise<boolean> {
  if (!eventId) return false;
  if (seenFallback.has(keyOf(source, eventId))) return true;
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
  seenFallback.add(keyOf(source, eventId));
  if (!dbConfigured()) return false;
  const inserted = await dbInsert<{ event_id: string }>("gh_webhook_events", {
    source,
    event_id: eventId,
    event_type: eventType ?? null,
  });
  return inserted !== null;
}
