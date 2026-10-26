// Shared payment-basis rule (G3): a charge is legitimate only on a saved
// basis — the CLIENT's own approval of the report, or the agreed 24h
// timer rule (report sent 24h+ ago, no issue ever). An operator approval
// is NOT a basis: it never manufactures client consent.
//
// Inputs are booking-scoped (the visit row + the per-booking journal),
// never shared customer metadata: one Stripe customer carries every
// booking of an email, so its metadata may describe another booking.
// Row flags are OR-ed with journal-derived state (fail-closed): the row
// is synced on every issue transition, the journal is the audit trail.

export type BasisEvent = {
  event: string;
  detail: Record<string, unknown> | null;
  created_at: string;
};

export type PaymentBasis = "client_approved" | "timer_rule" | null;

export function clientApprovedEvent(events: BasisEvent[]): BasisEvent | null {
  const approved =
    events.find(
      (e) =>
        e.event === "report_approved" &&
        (e.detail?.["via"] as string | undefined) !== "operator_approve",
    ) ?? null;
  if (!approved) return null;
  // P01: an approval authorizes the publication that was current when it
  // was given. A later republication supersedes it — the client must
  // approve the NEW report (or the timer rule must apply to it) before
  // anyone charges. Old approval events carry no version, so the binding
  // is by time: any report_sent strictly after the approval voids it.
  // (A payment_failed retry passes because no republication happened
  // between the approval and the retry.)
  const superseded = events.some(
    (e) => e.event === "report_sent" && e.created_at > approved.created_at,
  );
  return superseded ? null : approved;
}

export function issueStateFrom(
  events: BasisEvent[],
  issueOpenRow?: boolean | null,
  issueEverRow?: boolean | null,
): { open: boolean; ever: boolean } {
  let openedAt = "";
  let resolvedAt = "";
  for (const e of events) {
    if (e.event === "issue_opened" && e.created_at > openedAt) openedAt = e.created_at;
    if (e.event === "issue_resolved" && e.created_at > resolvedAt) resolvedAt = e.created_at;
  }
  const open =
    issueOpenRow === true ||
    Boolean(openedAt && (!resolvedAt || resolvedAt < openedAt));
  const ever = issueEverRow === true || Boolean(openedAt);
  return { open, ever };
}

export type TimerBlockReason = "issue_open" | "bounced" | "issue_ever" | null;

// Shared timer-eligibility display predicate (U02): the client pages and
// the cron must agree. A resolved dispute still blocks the timer forever
// (issue_ever), as does a bounced report — the countdown must never run
// for a visit the timer can never charge.
export function timerBlockReason(input: {
  open: boolean;
  ever: boolean;
  bounced: boolean;
}): TimerBlockReason {
  if (input.open) return "issue_open";
  if (input.bounced) return "bounced";
  if (input.ever) return "issue_ever";
  return null;
}

export function paymentBasis(
  input: {
    reportSentAt: string | null;
    events: BasisEvent[];
    issueOpenRow?: boolean | null;
    issueEverRow?: boolean | null;
    // P02: a bounced (undelivered) report blocks the TIMER basis. An
    // explicit client approval is a separate basis and is unaffected:
    // a client who received the report another way can still approve.
    bounced?: boolean | null;
  },
  nowMs: number,
): PaymentBasis {
  const sentMs = Date.parse(input.reportSentAt ?? "");
  const sentEv = input.events.find((e) => e.event === "report_sent");
  const sent = Number.isFinite(sentMs)
    ? sentMs
    : sentEv
      ? Date.parse(sentEv.created_at)
      : NaN;
  if (!Number.isFinite(sent)) return null;
  if (clientApprovedEvent(input.events)) return "client_approved";
  const { open, ever } = issueStateFrom(
    input.events,
    input.issueOpenRow,
    input.issueEverRow,
  );
  if (input.bounced) return null;
  if (!open && !ever && nowMs - sent >= 24 * 3600 * 1000) return "timer_rule";
  return null;
}
