// Shared Stripe PaymentIntent reconciliation (GPT-17 P04/P05/P11).
//
// Charge paths must reconcile with Stripe BEFORE creating a new intent:
// a previous success may exist even when our row/metadata disagree
// (crash between PI success and the state write, a moved report version,
// a retry after a lost idempotency key). Creating blindly is how one
// visit gets two successful charges.
//
// Notes:
// - Search is booking-scoped (metadata gh_booking_id) and never trusts
//   shared customer metadata: one customer carries many bookings.
// - Cancellation-fee intents (gh_kind=cancellation_fee) are a different
//   obligation and are never adopted as the cleaning payment.
// - Stripe search is eventually consistent: adoption is a safety net,
//   not the primary guard. Row paid checks, the payment_pending flip
//   and the journal-version idempotency key remain the first line.

const STRIPE_API = "https://api.stripe.com/v1";

export type FoundIntent = {
  id: string;
  status: string;
  amount: number;
  metadata: Record<string, string>;
  created: number;
};

async function searchIntents(secretKey: string, bookingId: string): Promise<FoundIntent[]> {
  const q = `metadata['gh_booking_id']:'${bookingId.replace(/'/g, "")}'`;
  const res = await fetch(
    `${STRIPE_API}/payment_intents/search?${new URLSearchParams({ query: q, limit: "20" })}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) return [];
  let j: { data?: FoundIntent[] } = {};
  try {
    j = (await res.json()) as { data?: FoundIntent[] };
  } catch {
    return [];
  }
  return Array.isArray(j.data) ? j.data : [];
}

// A succeeded cleaning intent for this booking and amount, if one exists.
export async function findSucceededCleaningIntent(
  secretKey: string,
  bookingId: string,
  amountCents: number,
): Promise<string | null> {
  const list = await searchIntents(secretKey, bookingId);
  const hit = list
    .filter(
      (p) =>
        p.status === "succeeded" &&
        p.metadata?.["gh_kind"] !== "cancellation_fee" &&
        p.amount === amountCents,
    )
    .sort((a, b) => b.created - a.created)[0];
  return hit ? hit.id : null;
}

const LIVE_STATUSES = [
  "requires_payment_method",
  "requires_action",
  "requires_confirmation",
  "processing",
];

// A live (not yet terminal) cleaning intent for this booking + report
// version, if one exists — the retry-after-decline case (P05).
export async function findLiveIntent(
  secretKey: string,
  bookingId: string,
  version: number,
): Promise<FoundIntent | null> {
  const list = await searchIntents(secretKey, bookingId);
  const hit = list
    .filter(
      (p) =>
        LIVE_STATUSES.includes(p.status) &&
        p.metadata?.["gh_report_version"] === String(version) &&
        p.metadata?.["gh_kind"] !== "cancellation_fee",
    )
    .sort((a, b) => b.created - a.created)[0];
  return hit ?? null;
}

// Confirm an existing intent with a (possibly new) payment method.
export async function confirmIntent(
  secretKey: string,
  piId: string,
  paymentMethod: string,
  idemKey: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${STRIPE_API}/payment_intents/${piId}/confirm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idemKey,
    },
    body: new URLSearchParams({ payment_method: paymentMethod }),
    signal: AbortSignal.timeout(15000),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, data };
}
