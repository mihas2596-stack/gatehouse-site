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
 * carries exactly this email — a near match is not a match. */
export function pickCustomerByEmail(
  list: StripeCustomerLite[],
  email: string,
  bookingId?: string | null,
): StripeCustomerLite | null {
  const wanted = (email ?? "").trim().toLowerCase();
  if (!wanted) return null;
  const exact = list.filter(
    (c) => typeof c.email === "string" && c.email.trim().toLowerCase() === wanted,
  );
  if (exact.length === 0) return null;
  if (bookingId) {
    const bound = exact.find((c) => c.metadata?.["gh_booking_id"] === bookingId);
    if (bound) return bound;
  }
  return exact[0];
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
