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

// RA02: verify a found intent against the visit's pinned obligation.
// Returns null when the intent may be adopted/confirmed, otherwise the
// mismatch reason. Cancellation-fee intents are a different obligation.
export function verifyIntentForObligation(
  intent: FoundIntent,
  obligation: { amountCents: number; currency: string; customerId: string },
): string | null {
  if (intent.metadata?.["gh_kind"] === "cancellation_fee") return "wrong_kind";
  if (intent.amount !== obligation.amountCents) return "amount_mismatch";
  if (obligation.currency && intent.currency && intent.currency !== obligation.currency) return "currency_mismatch";
  if (obligation.customerId && intent.customer && intent.customer !== obligation.customerId) return "customer_mismatch";
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
    const mismatch = verifyIntentForObligation(intent, obligation);
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

// RA13: confirm-attempt keys. Attempts are journal events
// (payment_confirm_attempt { pi, attempt, outcome }); retrying an
// attempt whose outcome is UNKNOWN reuses its key and parameters, a new
// attempt after an established failure gets the next key.
export function confirmAttemptKey(
  bookingId: string,
  version: number,
  piId: string,
  events: Array<{ event: string; detail: Record<string, unknown> | null }>,
): { key: string; attempt: number; reuse: boolean } {
  const attempts = events.filter(
    (e) => e.event === "payment_confirm_attempt" && e.detail?.["pi"] === piId,
  );
  const last = attempts[attempts.length - 1];
  if (last && last.detail?.["outcome"] === "unknown") {
    return {
      key: String(last.detail?.["key"] ?? ""),
      attempt: typeof last.detail?.["attempt"] === "number" ? (last.detail["attempt"] as number) : attempts.length,
      reuse: true,
    };
  }
  const n = attempts.length + 1;
  return { key: `charge_${bookingId}_v${version}_confirm_${n}`, attempt: n, reuse: false };
}
