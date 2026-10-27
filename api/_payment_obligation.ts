// Shared charge flow (RA01–RA13): ONE implementation for the three
// payment paths — client Approve, owner charge, 24h timer cron.
//
// The obligation is per VISIT (one cleaning payment), never per
// publication and never from shared customer metadata:
//   - amount: the visit row's pinned amount_cents only;
//   - publication: the row's report_sent_at + the journal's latest
//     report_sent version (consent binding, not money);
//   - basis: the client's own fresh approval of the current report, or
//     the 24h timer rule (no issue ever, not bounced, 24h+ elapsed).
//   - claim: an atomic row transition report_sent → payment_pending
//     (CAS on status + report_status + issue_open + publication time)
//     is the boundary an issue/cancel must beat. An issue landing
//     BEFORE the claim blocks the charge; one landing AFTER it leaves
//     the payment to complete but stays open (never silently cleared),
//     and the issue response must say so honestly.
//   - reconciliation runs BEFORE any create: known intent ids are read
//     directly from Stripe, then search (paginated, fail-closed). Any
//     unknown outcome refuses a new charge.
//   - the paid write is verified by changed-row count; an unverified
//     write surfaces as payment_unconfirmed, never as success.

import {
  dbSelectStrict, dbUpdateCount, logEvent,
} from "./_db.js";
import {
  paymentBasis, issueStateFrom, clientApprovedEvent,
} from "./_payment_basis.js";
import {
  reconcileIntent, confirmIntent, confirmAttemptKey,
} from "./_payment_intent.js";

export type ObligationRow = {
  id: string;
  booking_id: string;
  status: string | null;
  report_status: string | null;
  amount_cents: number | null;
  client_email: string | null;
  report_sent_at: string | null;
  issue_open: boolean | null;
  issue_ever: boolean | null;
  report_bounced: boolean | null;
  payment_intent_id: string | null;
};

export type ObligationEvent = {
  event: string;
  detail: Record<string, unknown> | null;
  created_at: string;
};

export type ChargeDeps = {
  setCustomerMeta: (patch: Record<string, string>) => Promise<void>;
  sendReceipt: (amountCents: number) => Promise<boolean>;
  sendPaymentFailedEmail: (visitId: string | null) => Promise<void>;
};

export type ChargeOutcome =
  | { outcome: "paid"; payment_intent: string; adopted: boolean; receipt_sent: boolean }
  | { outcome: "blocked"; error: string; pinned_cents?: number }
  | { outcome: "processing"; payment_intent?: string }
  | { outcome: "failed"; error: string; detail: string; status?: string }
  | { outcome: "unknown"; error: string; payment_intent?: string }
  | { outcome: "mismatch"; error: string; detail: string };

async function loadRow(bookingId: string): Promise<{ ok: boolean; row: ObligationRow | null }> {
  const r = await dbSelectStrict<ObligationRow>(
    "gh_visits",
    `booking_id=eq.${encodeURIComponent(bookingId)}&order=visit_no.desc&limit=1`,
  );
  if (!r.ok) return { ok: false, row: null };
  return { ok: true, row: r.rows[0] ?? null };
}

async function loadEvents(bookingId: string): Promise<{ ok: boolean; events: ObligationEvent[] }> {
  const r = await dbSelectStrict<ObligationEvent>(
    "gh_events",
    `booking_id=eq.${encodeURIComponent(bookingId)}&order=created_at.desc&limit=60`,
  );
  if (!r.ok) return { ok: false, events: [] };
  return { ok: true, events: r.rows };
}

function latestSent(events: ObligationEvent[]): ObligationEvent | null {
  let best: ObligationEvent | null = null;
  for (const e of events) {
    if (e.event !== "report_sent") continue;
    if (!best || e.created_at > best.created_at) best = e;
  }
  return best;
}

// N07: a publication counts as DELIVERED for the timer only when the
// journal proves the report email went out (email_sent === true).
// A report_sent event with email_sent false — or no event at all —
// is an unproven delivery and can never start the 24h clock, even if
// the row already says "sent" (the exact failure the audit
// reproduced: CAS landed, the bounced-flag write failed, the timer
// charged at +25h for a report the client never received).
function latestDeliveredSent(events: ObligationEvent[]): ObligationEvent | null {
  let best: ObligationEvent | null = null;
  for (const e of events) {
    if (e.event !== "report_sent") continue;
    if (e.detail?.["email_sent"] !== true) continue;
    if (!best || e.created_at > best.created_at) best = e;
  }
  return best;
}

function latestReturnedAfterSent(events: ObligationEvent[]): boolean {
  const sent = latestSent(events);
  if (!sent) return false;
  return events.some((e) => e.event === "report_returned" && e.created_at > sent.created_at);
}

function knownIntentIds(row: ObligationRow | null, events: ObligationEvent[]): string[] {
  const ids = new Set<string>();
  if (row?.payment_intent_id?.startsWith("pi_")) ids.add(row.payment_intent_id);
  for (const e of events) {
    const d = e.detail ?? {};
    const v = d["payment_intent"] ?? d["payment_intent_id"] ?? d["pi"];
    if (typeof v === "string" && v.startsWith("pi_")) ids.add(v);
  }
  return [...ids];
}

type StripePost = (
  path: string, params: Record<string, string>, idemKey?: string,
) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>;

async function stripePost(secretKey: string, ...args: Parameters<StripePost>): ReturnType<StripePost> {
  const [path, params, idemKey] = args;
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idemKey ? { "Idempotency-Key": idemKey } : {}),
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, data };
}

export async function chargeVisit(input: {
  secretKey: string;
  bookingId: string;
  customerId: string;
  customerEmail?: string | null;
  paymentMethod: string;
  source: "client_approve" | "owner_charge" | "timer_24h";
  allowedBases: Array<"client_approved" | "timer_rule">;
  requestedAmountCents?: number | null;
  seenPublicationId?: string | null;
  nowMs: number;
  deps: ChargeDeps;
}): Promise<ChargeOutcome> {
  const { secretKey, bookingId, customerId, paymentMethod, source, deps } = input;
  const rowRes = await loadRow(bookingId);
  if (!rowRes.ok) return { outcome: "unknown", error: "db_unreadable" };
  const row = rowRes.row;
  if (!row) return { outcome: "blocked", error: "no_row" };
  const evRes = await loadEvents(bookingId);
  if (!evRes.ok) return { outcome: "unknown", error: "db_unreadable" };
  const events = evRes.events;

  // --- Obligation resolution (row + journal only, RA01/RA05/RA06). ---
  if (row.status === "paid") return { outcome: "blocked", error: "already_paid" };
  if (row.status === "cancelled") return { outcome: "blocked", error: "visit_not_chargeable" };
  const sent = latestSent(events);
  // No publication anywhere (no journal event, row does not say sent):
  // there is nothing payable yet, so the payment basis itself is
  // missing. This outranks the row-status gate: a merely requested or
  // confirmed visit is "no basis", not a stale report.
  if (!sent && row.report_status !== "sent") {
    return { outcome: "blocked", error: "payment_basis_missing" };
  }
  if (row.status !== "report_sent" && row.status !== "payment_pending") {
    return { outcome: "blocked", error: "report_not_current" };
  }
  const version = typeof sent?.detail?.["version"] === "number"
    ? (sent.detail["version"] as number)
    : 1;
  const amountCents = typeof row.amount_cents === "number" && row.amount_cents > 0
    ? row.amount_cents
    : NaN;
  if (!Number.isFinite(amountCents)) return { outcome: "blocked", error: "quote_missing" };
  if (input.requestedAmountCents != null && input.requestedAmountCents !== amountCents) {
    await logEvent(row.id, bookingId, "system", "price_review_flagged", {
      amount_cents: input.requestedAmountCents, pinned_cents: amountCents,
    });
    return { outcome: "blocked", error: "price_review_required", pinned_cents: amountCents };
  }
  // RA08: the client must prove they saw THIS publication. A stale tab
  // (older publication id, or none) never pays for a new report.
  if (input.seenPublicationId !== undefined && input.seenPublicationId !== null) {
    if (!row.report_sent_at || input.seenPublicationId !== row.report_sent_at) {
      return { outcome: "blocked", error: "report_changed" };
    }
  }

  const issue = issueStateFrom(events, row.issue_open ?? null, row.issue_ever ?? null);
  const bounced = row.report_bounced === true;
  const effectiveSentMs = Math.max(
    Date.parse(row.report_sent_at ?? "") || 0,
    sent ? Date.parse(sent.created_at) || 0 : 0,
  );

  // G2: the row's client identity must match the customer being
  // charged. A row bound to a different email never pays — a
  // re-bound shared customer must not redirect one visit's charge
  // onto another client's card. Missing emails cannot be verified
  // and do not block; a positive mismatch does.
  if (
    row.client_email && input.customerEmail &&
    row.client_email.toLowerCase() !== input.customerEmail.toLowerCase()
  ) {
    return { outcome: "blocked", error: "identity_mismatch" };
  }

  // Recovery for a claim left behind by an interrupted attempt (RA12):
  // reconcile the known intent BEFORE refusing on payment_pending.
  if (row.status === "payment_pending") {
    const rec = await reconcileIntent(secretKey, bookingId, knownIntentIds(row, events), {
      amountCents, currency: "usd", customerId,
    });
    if (rec.state === "succeeded") {
      return recordPaid(rec.intent.id, true);
    }
    if (rec.state === "live") {
      if (rec.intent.status === "processing") {
        return { outcome: "processing", payment_intent: rec.intent.id };
      }
      return confirmExisting(rec.intent.id, rec.intent.amount);
    }
    if (rec.state === "mismatch") {
      return { outcome: "mismatch", error: "payment_intent_mismatch", detail: rec.reason };
    }
    if (rec.state === "unknown") {
      return { outcome: "unknown", error: "payment_unknown" };
    }
    // failed / none: release the stale claim and fall through to a
    // fresh claim below.
    const released = await dbUpdateCount(
      "gh_visits",
      `id=eq.${row.id}&status=eq.payment_pending`,
      { status: "report_sent" },
    );
    if (released === 0) {
      const fresh = await loadRow(bookingId);
      if (fresh.ok && fresh.row?.status === "paid") return { outcome: "blocked", error: "already_paid" };
      return { outcome: "processing" };
    }
    if (released < 0) return { outcome: "unknown", error: "db_unreadable" };
    row.status = "report_sent";
  }

  // Hard gates for a fresh charge (RA05): only a CURRENT published
  // report pays — none/draft/submitted/returned never do, even with an
  // old approval or old publication date still in the record. (The
  // no-publication-at-all case was already answered above as
  // payment_basis_missing.)
  if (row.report_status !== "sent" || latestReturnedAfterSent(events)) {
    return { outcome: "blocked", error: "report_not_current" };
  }
  if (issue.open) return { outcome: "blocked", error: "issue_open" };
  const basis = paymentBasis(
    {
      reportSentAt: effectiveSentMs ? new Date(effectiveSentMs).toISOString() : null,
      events, issueOpenRow: row.issue_open ?? null, issueEverRow: row.issue_ever ?? null,
      bounced,
    },
    input.nowMs,
  );
  if (!basis || !input.allowedBases.includes(basis)) {
    return { outcome: "blocked", error: "payment_basis_missing" };
  }
  // N07: the timer basis additionally requires a PROVEN delivery.
  // An explicit client approval is a separate basis (the client
  // demonstrably saw the report) and is unaffected.
  if (source === "timer_24h" && !latestDeliveredSent(events)) {
    return { outcome: "blocked", error: "report_delivery_unconfirmed" };
  }
  // RA06: the timer runs from the CURRENT publication, never an old
  // one. A republication resets the 24h clock even if metadata still
  // shows the old date.
  if (source === "timer_24h" && effectiveSentMs + 24 * 3600 * 1000 > input.nowMs) {
    return { outcome: "blocked", error: "not_due" };
  }

  // --- Atomic claim (RA07): the boundary an issue/cancel must beat. ---
  const claimMatch = [
    `id=eq.${row.id}`,
    `status=eq.report_sent`,
    `report_status=eq.sent`,
    `issue_open=neq.true`,
    // N04: dispute HISTORY is checked inside the atomic timer
    // admission, not only by the earlier read: an issue opened and
    // resolved between the read and the claim must still block the
    // timer forever (issue_ever). Approve paths are unaffected — an
    // explicit new consent after a resolved dispute still pays.
    ...(basis === "timer_rule" ? [`report_bounced=neq.true`, `issue_ever=neq.true`] : []),
    ...(row.report_sent_at
      ? [`report_sent_at=eq.${encodeURIComponent(row.report_sent_at)}`]
      : []),
  ].join("&");
  const claimed = await dbUpdateCount("gh_visits", claimMatch, { status: "payment_pending" });
  if (claimed === 0) {
    const fresh = await loadRow(bookingId);
    const freshRow = fresh.ok ? fresh.row : null;
    const freshEv = fresh.ok ? (await loadEvents(bookingId)).events : events;
    if (freshRow?.status === "paid") return { outcome: "blocked", error: "already_paid" };
    if (freshRow?.status === "cancelled") return { outcome: "blocked", error: "visit_not_chargeable" };
    if (freshRow?.status === "payment_pending") return { outcome: "processing" };
    if (issueStateFrom(freshEv, freshRow?.issue_open ?? null, freshRow?.issue_ever ?? null).open) {
      return { outcome: "blocked", error: "issue_open" };
    }
    // N04: same gate on the lost-claim path — a resolved dispute
    // between the read and the claim blocks the timer, it does not
    // degrade to "processing" (which the caller would retry).
    if (basis === "timer_rule" && issueStateFrom(freshEv, freshRow?.issue_open ?? null, freshRow?.issue_ever ?? null).ever) {
      return { outcome: "blocked", error: "issue_ever" };
    }
    if (freshRow?.report_status !== "sent") return { outcome: "blocked", error: "report_not_current" };
    return { outcome: "processing" };
  }
  if (claimed < 0) return { outcome: "unknown", error: "db_unreadable" };
  await logEvent(row.id, bookingId, "system", "payment_claimed", {
    source, publication: row.report_sent_at, version,
  });

  // --- Reconcile before creating (RA03): adoption first. ---
  const rec = await reconcileIntent(secretKey, bookingId, knownIntentIds(row, events), {
    amountCents, currency: "usd", customerId,
  });
  if (rec.state === "succeeded") return recordPaid(rec.intent.id, true);
  if (rec.state === "mismatch") {
    // Never confirm a wrong-amount/currency/customer/kind intent and
    // never mint a replacement while its outcome is unresolved (RA02).
    await releaseClaim();
    return { outcome: "mismatch", error: "payment_intent_mismatch", detail: rec.reason };
  }
  if (rec.state === "unknown") {
    return { outcome: "unknown", error: "payment_unknown" };
  }
  if (rec.state === "live") {
    if (rec.intent.status === "processing") {
      return { outcome: "processing", payment_intent: rec.intent.id };
    }
    return confirmExisting(rec.intent.id, rec.intent.amount);
  }

  // --- Create (one obligation, one idempotency key). ---
  const idemKey = `charge_${bookingId}_v${version}`;
  let pi: { ok: boolean; status: number; data: Record<string, unknown> };
  try {
    pi = await stripePost(secretKey, "/payment_intents", {
      amount: String(amountCents),
      currency: "usd",
      customer: customerId,
      payment_method: paymentMethod,
      off_session: "true",
      confirm: "true",
      description: `Gatehouse cleaning — booking ${bookingId}`,
      "metadata[gh_booking_id]": bookingId,
      "metadata[gh_report_version]": String(version),
    }, idemKey);
  } catch {
    await logEvent(row.id, bookingId, "system", "payment_create_unknown", { idem_key: idemKey });
    return { outcome: "unknown", error: "payment_unknown" };
  }
  return handlePiResult(pi, null);

  // --- Helpers (closures over the claimed row). ---
  async function releaseClaim(): Promise<void> {
    await dbUpdateCount(
      "gh_visits",
      `id=eq.${row.id}&status=eq.payment_pending`,
      { status: "report_sent" },
    );
  }

  // P11/RA11: the paid write is verified by changed-row count. An
  // unverified write surfaces as payment_unconfirmed — the claim stays
  // for recovery, and the next attempt adopts this intent.
  async function recordPaid(piId: string, adopted: boolean): Promise<ChargeOutcome> {
    let wrote = false;
    for (let attempt = 0; attempt < 2 && !wrote; attempt++) {
      const n = await dbUpdateCount(
        "gh_visits",
        `id=eq.${row.id}&status=eq.payment_pending`,
        { status: "paid", paid_at: new Date().toISOString(), payment_intent_id: piId },
      );
      wrote = n === 1;
      if (n === 0) break;
    }
    if (!wrote) {
      const fresh = await loadRow(bookingId);
      if (fresh.ok && fresh.row?.status === "paid") {
        const receiptSent = await deps.sendReceipt(amountCents);
        return { outcome: "paid", payment_intent: piId, adopted: true, receipt_sent: receiptSent };
      }
      await logEvent(row.id, bookingId, "system", "payment_unconfirmed", {
        payment_intent: piId, source,
      });
      return { outcome: "unknown", error: "payment_unconfirmed", payment_intent: piId };
    }
    await deps.setCustomerMeta({
      gh_state: "paid",
      gh_paid_at: new Date().toISOString(),
      gh_last_payment: piId,
    });
    const receiptSent = await deps.sendReceipt(amountCents);
    await logEvent(row.id, bookingId, "system", "payment_succeeded", {
      payment_intent: piId, via: source, receipt_sent: receiptSent, adopted,
    });
    return { outcome: "paid", payment_intent: piId, adopted, receipt_sent: receiptSent };
  }

  // N02: confirming a LIVE (not yet paid) intent is a NEW money
  // operation, not adoption of an existing success. It must re-pass
  // every live gate on FRESH data: the claim must still be ours, the
  // publication must be unchanged, no issue may be open, no return
  // may have superseded the report, and the payment basis must still
  // hold. A payment_pending row is NOT by itself permission to
  // confirm. Adoption of an already-succeeded intent is a different
  // path (recordPaid via reconcile) and never confirms anything.
  // N06: the attempt's parameters are journaled BEFORE the Stripe
  // call (payment_confirm_started), so an unknown outcome is
  // recoverable; the key is bound to (booking, intent, card).
  async function confirmExisting(piId: string, intentAmountCents?: number): Promise<ChargeOutcome> {
    const revalidation = await (async (): Promise<string | null> => {
      const fr = await loadRow(bookingId);
      if (!fr.ok) return "db_unreadable";
      const frow = fr.row;
      if (!frow) return "no_row";
      if (frow.status === "paid") return "already_paid";
      if (frow.status === "cancelled") return "visit_not_chargeable";
      if (frow.status !== "payment_pending") return "claim_lost";
      if (frow.report_status !== "sent") return "report_not_current";
      if (frow.report_sent_at !== row.report_sent_at) return "report_changed";
      const fev = await loadEvents(bookingId);
      if (!fev.ok) return "db_unreadable";
      const fevents = fev.events;
      if (latestReturnedAfterSent(fevents)) return "report_not_current";
      if (issueStateFrom(fevents, frow.issue_open ?? null, frow.issue_ever ?? null).open) {
        return "issue_open";
      }
      const fbounced = frow.report_bounced === true;
      const fsentMs = Math.max(
        Date.parse(frow.report_sent_at ?? "") || 0,
        (() => {
          const ls = latestSent(fevents);
          return ls ? Date.parse(ls.created_at) || 0 : 0;
        })(),
      );
      const fbasis = paymentBasis(
        {
          reportSentAt: fsentMs ? new Date(fsentMs).toISOString() : null,
          events: fevents, issueOpenRow: frow.issue_open ?? null,
          issueEverRow: frow.issue_ever ?? null, bounced: fbounced,
        },
        Date.now(),
      );
      if (!fbasis || !input.allowedBases.includes(fbasis)) return "payment_basis_missing";
      if (source === "timer_24h" && !latestDeliveredSent(fevents)) {
        return "report_delivery_unconfirmed";
      }
      if (intentAmountCents !== undefined && intentAmountCents !== amountCents) {
        return "payment_intent_mismatch";
      }
      return null;
    })();
    if (revalidation === "already_paid") return { outcome: "blocked", error: "already_paid" };
    if (revalidation === "db_unreadable") {
      // Claim stays: an unreadable DB must not release a live claim
      // to a retry that could double-confirm.
      return { outcome: "unknown", error: "db_unreadable" };
    }
    if (revalidation) {
      await releaseClaim();
      return { outcome: "blocked", error: revalidation };
    }
    const attempt = confirmAttemptKey(bookingId, piId, paymentMethod, events);
    await logEvent(row.id, bookingId, "system", "payment_confirm_started", {
      pi: piId, attempt: attempt.attempt, key: attempt.key, payment_method: paymentMethod,
    });
    let res: { ok: boolean; status: number; data: Record<string, unknown> };
    try {
      res = await confirmIntent(secretKey, piId, paymentMethod, attempt.key);
    } catch {
      await logEvent(row.id, bookingId, "system", "payment_confirm_attempt", {
        pi: piId, attempt: attempt.attempt, key: attempt.key, payment_method: paymentMethod,
        outcome: "unknown",
      });
      return { outcome: "unknown", error: "payment_unknown", payment_intent: piId };
    }
    const status = String(res.data["status"] ?? "");
    const outcome = res.ok && status === "succeeded"
      ? "succeeded"
      : res.ok && status === "requires_action"
        ? "requires_action"
        : res.ok
          ? status || "failed"
          : "failed";
    await logEvent(row.id, bookingId, "system", "payment_confirm_attempt", {
      pi: piId, attempt: attempt.attempt, key: attempt.key, payment_method: paymentMethod,
      outcome,
    });
    return handlePiResult(res, piId);
  }

  async function handlePiResult(
    res: { ok: boolean; status: number; data: Record<string, unknown> },
    existingPiId: string | null,
  ): Promise<ChargeOutcome> {
    const piId = existingPiId ?? String(res.data["id"] ?? "");
    const status = String(res.data["status"] ?? "");
    if (res.ok && status === "succeeded" && piId) {
      return recordPaid(piId, false);
    }
    if (res.ok && status === "requires_action") {
      await releaseClaim();
      return { outcome: "failed", error: "payment_requires_action", detail: "requires_action", status };
    }
    const errMsg =
      ((res.data["error"] as { message?: string } | undefined)?.message ?? `payment ${status || res.status}`);
    await releaseClaim();
    // Mirror the failure into shared metadata: the client view and
    // the cron's selection both read gh_state, so a failed charge
    // must not look "report_sent" (and must not be retried by the
    // next cron run as if nothing happened).
    await deps.setCustomerMeta({ gh_state: "payment_failed" });
    await logEvent(row.id, bookingId, "system", "payment_failed", {
      via: source, status, detail: errMsg.slice(0, 200), payment_intent: piId || undefined,
    });
    await deps.sendPaymentFailedEmail(row.id);
    return { outcome: "failed", error: "payment_failed", detail: errMsg, status };
  }
}
