// C13 (09.11.2026): Stripe customer / card selection, shared by every
// endpoint that resolves a customer or a card for a booking.
//
// The old code took list[0] from a Stripe search/list with no check:
// several Stripe customers can share one email, and the payment-method
// list order is Stripe's, not ours. Two rules now hold everywhere:
//   1. A customer counts only on an EXACT email match (case-insensitive).
//      Among exact matches, the one currently bound to the booking
//      (metadata gh_booking_id) wins. A visit row's stripe_customer_id,
//      where present, is resolved directly and its email verified
//      (resolveCustomerByRowId) — that is the strongest binding.
//   2. A card counts only as the booking's own card_confirmed event
//      (the client's explicit choice for THIS booking, same as
//      chargeVisit), else the cached gh_payment_method when it is
//      still on the customer's list, else a lone card. Several cards
//      with no booking signal is AMBIGUOUS — never a silent list[0]:
//      the caller must ask the client to confirm a card
//      (card_confirmation_required) instead of charging an arbitrary
//      one.
//
// G3Z: rule 1 was still arbitrary when several exact matches shared
// one email and none was booking-bound — exact[0] (Stripe's order)
// won silently. The pick is now deterministic: the customer already
// linked to the booking (row stripe_customer_id, passed as
// linkedCustomerId) wins, then the booking-bound one, then a lone
// exact match. Several unbound exact matches are AMBIGUOUS and
// resolve to null — the caller fails closed instead of charging a
// stranger's customer. The payment-method tiebreak lives in
// pickCustomerByPaymentMethods below: among unbound exact matches,
// the one holding one of the booking's payment methods wins.
//
// NOTE: stripe_customer_id on gh_visits is populated by the
// cleaner_link create-visit path AND at card-save time
// (create-checkout-session pins it, populate-only, when the
// Checkout session is issued for a verified booking token), so
// the row binding fires for every booking with a saved card.

export type StripeCustomerLite = {
  id: string;
  metadata?: Record<string, string>;
  email?: string;
  name?: string;
};

/** Exact-email pick from a Stripe search result. Null when no record
 * carries exactly this email — a near match is not a match. G3Z:
 * also null when SEVERAL exact matches share the email and none is
 * linked/bound to the booking — picking one would be arbitrary and
 * could charge a stranger's customer. Callers fail closed on null
 * (booking_not_found) instead of guessing. */
export function pickCustomerByEmail(
  list: StripeCustomerLite[],
  email: string,
  bookingId?: string | null,
  opts: { linkedCustomerId?: string | null } = {},
): StripeCustomerLite | null {
  const wanted = (email ?? "").trim().toLowerCase();
  if (!wanted) return null;
  const exact = list.filter(
    (c) => typeof c.email === "string" && c.email.trim().toLowerCase() === wanted,
  );
  if (exact.length === 0) return null;
  // 1. The customer already linked to the booking (the visit row's
  // stripe_customer_id, or the journal's binding) wins outright.
  const linked = typeof opts.linkedCustomerId === "string" && opts.linkedCustomerId
    ? exact.find((c) => c.id === opts.linkedCustomerId)
    : undefined;
  if (linked) return linked;
  // 2. The customer whose metadata names this booking wins.
  if (bookingId) {
    const bound = exact.find((c) => c.metadata?.["gh_booking_id"] === bookingId);
    if (bound) return bound;
  }
  // 3. A lone exact match is unambiguous.
  if (exact.length === 1) return exact[0];
  // 4. Several unbound exact matches: ambiguous, never list[0].
  // The caller may resolve the tie with pickCustomerByPaymentMethods
  // (the candidate holding one of the booking's payment methods).
  return null;
}

/**
 * Payment-method tiebreak for the ambiguous case above: among the
 * exact-email matches, prefer the customer holding one of the
 * booking's payment methods (the booking's card_confirmed payment
 * method ids). Exactly one owner wins; zero or several owners is
 * still ambiguous and returns null. A failed per-customer lookup
 * counts as "no methods seen" for that candidate, never as a match.
 */
export async function pickCustomerByPaymentMethods(
  list: StripeCustomerLite[],
  email: string,
  bookingId: string | null | undefined,
  bookingPaymentMethodIds: string[],
  listPaymentMethods: (customerId: string) => Promise<string[]>,
): Promise<StripeCustomerLite | null> {
  const direct = pickCustomerByEmail(list, email, bookingId);
  if (direct) return direct;
  const wanted = (email ?? "").trim().toLowerCase();
  const exact = list.filter(
    (c) => typeof c.email === "string" && c.email.trim().toLowerCase() === wanted,
  );
  if (exact.length <= 1 || bookingPaymentMethodIds.length === 0) return null;
  const wantedPms = new Set(bookingPaymentMethodIds);
  const owners: StripeCustomerLite[] = [];
  for (const candidate of exact) {
    let pms: string[];
    try {
      pms = await listPaymentMethods(candidate.id);
    } catch {
      continue;
    }
    if (pms.some((pm) => wantedPms.has(pm))) owners.push(candidate);
  }
  return owners.length === 1 ? owners[0] : null;
}

// G3Z: the dedup markers that must survive a customer rebind. The
// rebind in create-checkout-session clears the previous booking's
// lifecycle keys from shared customer metadata — and gh_last_payment
// (the cleaning-payment dedup marker) was on that list, so a
// redelivered payment_intent.succeeded could no longer be recognised
// as already recorded from metadata alone. The durable dedup is the
// DB row/journal (the webhook now consults it first), but a rebind
// must still CARRY these markers into the new binding instead of
// clearing them: pass carryDedupMarkers(currentMetadata) into the
// rebind's metadata patch. The rebind call site lives in
// api/create-checkout-session.ts (outside this module).
export const DEDUP_METADATA_KEYS = ["gh_last_payment", "gh_fee_last_payment"] as const;

/** Metadata patch entries that re-assert the live dedup markers. */
export function carryDedupMarkers(
  currentMeta: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of DEDUP_METADATA_KEYS) {
    const value = currentMeta?.[key];
    if (value) out[`metadata[${key}]`] = value;
  }
  return out;
}

export type CardPick =
  | { status: "ok"; pm: string }
  | { status: "ambiguous" }
  | { status: "none" };

/**
 * Card choice for one booking. confirmedPmId is the payment_method_id
 * of the booking's latest card_confirmed journal event (the client's
 * explicit choice for THIS booking); cachedPmId is the shared
 * customer's gh_payment_method. A confirmed card that is no longer
 * attached to the customer does NOT win — it is gone, and the choice
 * falls through to the remaining signals instead of backfilling a
 * dead id. (The list fetch is capped at 10: a confirmed card outside
 * the first 10 is missed, and the caller then asks the client.)
 */
export function pickCard(
  cards: Array<{ id: string }>,
  opts: { confirmedPmId?: string | null; cachedPmId?: string | null } = {},
): CardPick {
  const ids = new Set(cards.map((c) => c.id));
  const confirmed = typeof opts.confirmedPmId === "string" && opts.confirmedPmId.startsWith("pm_")
    ? opts.confirmedPmId
    : null;
  if (confirmed && ids.has(confirmed)) return { status: "ok", pm: confirmed };
  const cached = typeof opts.cachedPmId === "string" && opts.cachedPmId.startsWith("pm_")
    ? opts.cachedPmId
    : null;
  if (cached && ids.has(cached)) return { status: "ok", pm: cached };
  if (cards.length === 0) return { status: "none" };
  if (cards.length === 1) return { status: "ok", pm: cards[0].id };
  return { status: "ambiguous" };
}

/** The booking's latest card_confirmed payment_method_id, if any. */
export function confirmedPaymentMethodId(
  events: Array<{ event: string; detail: Record<string, unknown> | null; created_at?: string }>,
): string | null {
  const ev = events.find((e) => e.event === "card_confirmed");
  const pm = ev?.detail?.["payment_method_id"];
  return typeof pm === "string" && pm.startsWith("pm_") ? pm : null;
}

export type CustomerFetch = (id: string) => Promise<{
  ok: boolean;
  data: Record<string, unknown>;
}>;

/**
 * Resolve the customer the visit row pins via stripe_customer_id,
 * verifying the record's email against the booking's expected email.
 * Null on any mismatch, missing record, or failed fetch — the caller
 * then falls back to the email search (which itself verifies the
 * email), never to an unverified id.
 */
export async function resolveCustomerByRowId(
  fetchCustomer: CustomerFetch,
  stripeCustomerId: string | null | undefined,
  expectedEmail: string | null | undefined,
): Promise<StripeCustomerLite | null> {
  if (!stripeCustomerId || typeof stripeCustomerId !== "string") return null;
  let res: { ok: boolean; data: Record<string, unknown> };
  try {
    res = await fetchCustomer(stripeCustomerId);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = res.data ?? {};
  const id = typeof data["id"] === "string" ? (data["id"] as string) : "";
  if (!id) return null;
  const email = typeof data["email"] === "string" ? (data["email"] as string) : "";
  const wanted = (expectedEmail ?? "").trim().toLowerCase();
  if (wanted && email && email.trim().toLowerCase() !== wanted) return null;
  return {
    id,
    email,
    name: typeof data["name"] === "string" ? (data["name"] as string) : "",
    metadata: (data["metadata"] as Record<string, string> | undefined) ?? {},
  };
}
