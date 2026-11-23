// Stripe Customers can share an email. Card operations require a booking-specific binding.

export type StripeCustomerLite = {
  id: string;
  metadata?: Record<string, string>;
  email?: string;
  name?: string;
};

/** Accept a stored customer ID or the customer carrying this booking in Stripe. */
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
  if (!exact.length || bookingPaymentMethodIds.length === 0) return null;
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
  if (id !== stripeCustomerId) return null;
  const email = typeof data["email"] === "string" ? (data["email"] as string) : "";
  const wanted = (expectedEmail ?? "").trim().toLowerCase();
  if (wanted && email.trim().toLowerCase() !== wanted) return null;
  return {
    id,
    email,
    name: typeof data["name"] === "string" ? (data["name"] as string) : "",
    metadata: (data["metadata"] as Record<string, string> | undefined) ?? {},
  };
}
