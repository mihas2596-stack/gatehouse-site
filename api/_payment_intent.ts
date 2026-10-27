// Shared Stripe PaymentIntent reconciliation (GPT-17 P04/P05/P11, RA02/RA03/RA13).
//
// Charge paths must reconcile with Stripe BEFORE creating a new intent:
// a previous success may exist even when our row/metadata disagree
// (crash between PI success and the state write, a moved report version,
// a retry after a lost idempotency key). Creating blindly is how one
// visit gets two successful charges.
//
// RA rules enforced here:
// - RA03: a search error, timeout or malformed reply is NOT "no
//   payments". Search returns a discriminated result; callers fail
//   closed on { status: "error" } instead of creating blindly. Search is
//   paginated (Stripe search pages), so a payment beyond the first
//   page is still found.
// - RA02: a found intent is verified against the obligation before it
//   is adopted or confirmed: amount, currency, customer and kind must
//   match. A $300 intent is never confirmed for a $200 pinned visit,
//   and a cancellation-fee intent is never a cleaning payment.
// - RA13: confirm attempts are durable and numbered. Retrying the SAME
//   attempt (unknown outcome) reuses its key and parameters; a new
//   attempt after an established failure gets a new key.
// - The obligation is per VISIT, not per publication: a republication
//   does not create a new payment obligation. Intent matching is by
//   booking + pinned amount + currency + customer + kind; the report
//   version binds the client's CONSENT (which publication they
//   approved), not the money.

import { createHash } from "crypto";

const STRIPE_API = "https://api.stripe.com/v1";

export type FoundIntent = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  customer: string | null;
  metadata: Record<string, string>;
  created: number;
};

export type SearchResult =
  | { status: "ok"; intents: FoundIntent[] }
  | { status: "error"; error: string };

function normalizeIntent(raw: Record<string, unknown>): FoundIntent {
  const meta = (raw["metadata"] as Record<string, string> | undefined) ?? {};
  return {
    id: typeof raw["id"] === "string" ? (raw["id"] as string) : "",
    status: typeof raw["status"] === "string" ? (raw["status"] as string) : "",
    amount: typeof raw["amount"] === "number" ? (raw["amount"] as number) : 0,
    currency: typeof raw["currency"] === "string" ? (raw["currency"] as string) : "",
    customer: typeof raw["customer"] === "string" ? (raw["customer"] as string) : null,
    metadata: meta,
    created: typeof raw["created"] === "number" ? (raw["created"] as number) : 0,
  };
}

export async function searchIntents(
  secretKey: string,
  bookingId: string,
): Promise<SearchResult> {
  const q = `metadata['gh_booking_id']:'${bookingId.replace(/'/g, "")}'`;
  const out: FoundIntent[] = [];
  let page: string | undefined;
  for (let hops = 0; hops < 5; hops++) {
    const params: Record<string, string> = { query: q, limit: "20" };
    if (page) params["page"] = page;
    let res: Response;
    try {
      res = await fetch(
        `${STRIPE_API}/payment_intents/search?${new URLSearchParams(params)}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${secretKey}` },
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      return { status: "error", error: "search_timeout" };
    }
    if (!res.ok) return { status: "error", error: `search_${res.status}` };
    let j: { data?: unknown[]; next_page?: string };
    try {
      j = (await res.json()) as { data?: unknown[]; next_page?: string };
    } catch {
      return { status: "error", error: "search_bad_json" };
    }
    if (!Array.isArray(j.data)) return { status: "error", error: "search_bad_shape" };
    for (const raw of j.data) {
      if (raw && typeof raw === "object") out.push(normalizeIntent(raw as Record<string, unknown>));
    }
    if (typeof j.next_page === "string" && j.next_page) {
      page = j.next_page;
    } else {
      break;
    }
  }
  return { status: "ok", intents: out };
}

// Direct retrieval of a KNOWN intent id (RA03): when our row or journal
// already names a PaymentIntent, its state is read straight from Stripe
// instead of trusting search indexing. A failed direct read is an
// UNKNOWN outcome, never "no payment".
export async function getIntent(
  secretKey: string,
  piId: string,
): Promise<{ status: "ok"; intent: FoundIntent } | { status: "error"; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${STRIPE_API}/payment_intents/${encodeURIComponent(piId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { status: "error", error: "get_timeout" };
  }
  if (!res.ok) return { status: "error", error: `get_${res.status}` };
  try {
    const j = (await res.json()) as Record<string, unknown>;
    return { status: "ok", intent: normalizeIntent(j) };
  } catch {
    return { status: "error", error: "get_bad_json" };
  }
}

// RA02 (hardened, N08): verify a found intent against the visit's
// pinned obligation. Returns null when the intent may be adopted or
// confirmed, otherwise the mismatch reason. Empty fields are NOT a
// match — an intent with no currency, no customer, or no booking
// binding cannot prove it belongs to this obligation, so it is a
// mismatch (fail closed), never a silent pass. Cancellation-fee
// intents are a different obligation.
export function verifyIntentForObligation(
  intent: FoundIntent,
  obligation: { amountCents: number; currency: string; customerId: string; bookingId?: string },
): string | null {
  if (intent.metadata?.["gh_kind"] === "cancellation_fee") return "wrong_kind";
  if (intent.amount !== obligation.amountCents) return "amount_mismatch";
  if (!intent.currency || (obligation.currency && intent.currency !== obligation.currency)) {
    return "currency_mismatch";
  }
  if (!intent.customer || (obligation.customerId && intent.customer !== obligation.customerId)) {
    return "customer_mismatch";
  }
  if (obligation.bookingId) {
    const bound = intent.metadata?.["gh_booking_id"];
    if (!bound || bound !== obligation.bookingId) return "booking_mismatch";
  }
  return null;
}

const LIVE_STATUSES = [
  "requires_payment_method",
  "requires_action",
  "requires_confirmation",
  "processing",
];

export type ReconciledIntent =
  | { state: "succeeded"; intent: FoundIntent }
  | { state: "live"; intent: FoundIntent }
  | { state: "failed"; intent: FoundIntent }
  | { state: "none" }
  | { state: "unknown"; error: string }
  | { state: "mismatch"; intent: FoundIntent; reason: string };

// Reconcile known intent ids first (direct reads), then search as a
// fallback. Any failed read/search is "unknown" — the caller must NOT
// create a new intent while the outcome is unknown.
export async function reconcileIntent(
  secretKey: string,
  bookingId: string,
  knownIds: string[],
  obligation: { amountCents: number; currency: string; customerId: string },
): Promise<ReconciledIntent> {
  let newestLive: FoundIntent | null = null;
  let newestFailed: FoundIntent | null = null;
  const consider = (intent: FoundIntent): ReconciledIntent | null => {
    // A cancellation-fee intent is a DIFFERENT obligation: it never
    // stands in for the cleaning payment, and it never blocks creating
    // one. It is skipped here, not treated as a mismatch.
    if (intent.metadata?.["gh_kind"] === "cancellation_fee") return null;
    // Binding to THIS booking is part of verification (N08): an intent
    // for another booking, even with the right amount, is a mismatch.
    const mismatch = verifyIntentForObligation(intent, { ...obligation, bookingId });
    if (mismatch) return { state: "mismatch", intent, reason: mismatch };
    if (intent.status === "succeeded") return { state: "succeeded", intent };
    if (LIVE_STATUSES.includes(intent.status)) {
      if (!newestLive || intent.created >= newestLive.created) newestLive = intent;
      return null;
    }
    if (intent.status === "canceled") {
      if (!newestFailed || intent.created >= newestFailed.created) newestFailed = intent;
    }
    return null;
  };
  for (const id of knownIds) {
    const got = await getIntent(secretKey, id);
    if (got.status === "error") return { state: "unknown", error: got.error };
    const hit = consider(got.intent);
    if (hit) return hit;
  }
  const searched = await searchIntents(secretKey, bookingId);
  if (searched.status === "error") return { state: "unknown", error: searched.error };
  for (const intent of searched.intents) {
    const hit = consider(intent);
    if (hit) return hit;
  }
  if (newestLive) return { state: "live", intent: newestLive };
  if (newestFailed) return { state: "failed", intent: newestFailed };
  return { state: "none" };
}

// Backwards-compatible helpers for existing callers/tests.
export async function findSucceededCleaningIntent(
  secretKey: string,
  bookingId: string,
  amountCents: number,
): Promise<string | null> {
  const r = await reconcileIntent(secretKey, bookingId, [], {
    amountCents, currency: "usd", customerId: "",
  });
  return r.state === "succeeded" ? r.intent.id : null;
}

export async function findLiveIntent(
  secretKey: string,
  bookingId: string,
  _version: number | string,
): Promise<FoundIntent | null> {
  const searched = await searchIntents(secretKey, bookingId);
  if (searched.status === "error") return null;
  const hit = searched.intents
    .filter(
      (p) =>
        LIVE_STATUSES.includes(p.status) &&
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

// RA13 (rewritten, N06): confirm-attempt keys are bound to the
// payment method, not to a position in the journal and not to the
// report version — the obligation is per visit, and a republication
// must not change the identity of the payment attempt.
//
// Key = charge_<booking>_confirm_<pi>_<method-hash>:
//   - same card + same intent → the SAME key forever, so retrying an
//     unknown outcome replays Stripe's original result instead of
//     minting a second confirm;
//   - a new card → a different key, so a card change is a real new
//     attempt (the old bug reused the previous key with the NEW card's
//     parameters, which Stripe rejects or, in mocks, silently applies);
//   - the key never depends on how many attempt events survive in the
//     newest-60 journal window, so numbering can never reset and
//     collide after the window rolls.
// The attempt NUMBER is informational only (max number seen for this
// intent, order-independent — production journals are newest-first,
// so "last element" used to mean the OLDEST attempt). Selection uses
// (created_at, attempt) maxima, never array position. Callers must
// log the attempt's parameters BEFORE calling Stripe
// (payment_confirm_started) and its outcome after, so an unknown
// outcome is recoverable from the journal.
export function confirmAttemptKey(
  bookingId: string,
  piId: string,
  paymentMethod: string,
  events: Array<{
    event: string;
    detail: Record<string, unknown> | null;
    created_at?: string;
  }>,
): { key: string; attempt: number; reuse: boolean } {
  const methodHash = createHash("sha256").update(paymentMethod).digest("hex").slice(0, 12);
  const key = `charge_${bookingId}_confirm_${piId}_${methodHash}`;
  const attempts = events.filter(
    (e) => e.event === "payment_confirm_attempt" && e.detail?.["pi"] === piId,
  );
  const numOf = (e: (typeof attempts)[number]): number =>
    typeof e.detail?.["attempt"] === "number" ? (e.detail["attempt"] as number) : 0;
  const maxAttempt = attempts.reduce((m, e) => Math.max(m, numOf(e)), 0);
  // Latest attempt FOR THIS METHOD, order-independent: newest
  // created_at wins, ties broken by attempt number.
  const forMethod = attempts.filter((e) => e.detail?.["payment_method"] === paymentMethod);
  forMethod.sort((a, b) => {
    const ta = a.created_at ?? "";
    const tb = b.created_at ?? "";
    if (ta !== tb) return tb < ta ? -1 : 1;
    return numOf(b) - numOf(a);
  });
  const latest = forMethod[0];
  if (latest && latest.detail?.["outcome"] === "unknown") {
    return { key, attempt: numOf(latest) || maxAttempt || 1, reuse: true };
  }
  return { key, attempt: maxAttempt + 1, reuse: false };
}
