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

import { isFutureVisitDate } from "./_visit_date.js";

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
  if (superseded) return null;
  // RA09: a dispute opened AFTER the approval voids it for any payment
  // not yet made. The client approved one state of the visit; a later
  // complaint means that consent no longer covers the charge — only a
  // NEW explicit approval of the current report (which is newer than
  // the dispute) re-arms payment. Approving WHILE a dispute is open
  // (the "Resolve issue & pay" flow) is newer than the dispute and
  // stays valid.
  const voidedByDispute = events.some(
    (e) => e.event === "issue_opened" && e.created_at > approved.created_at,
  );
  return voidedByDispute ? null : approved;
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

export type IssueDecisionValue = "payment_requested" | "reclean" | "waived";

export type IssueDecision = {
  decision: IssueDecisionValue;
  resolution: string;
  decided_at: string;
};

// TASK 1 (fix6): the owner's latest decision on an open issue, read
// from the journal (`issue_decision` events). The latest event wins:
// a newer decision supersedes an older one, and a waived visit stays
// waived — no later decision event can revive the charge.
export function latestIssueDecision(events: BasisEvent[]): IssueDecision | null {
  let best: BasisEvent | null = null;
  for (const e of events) {
    if (e.event !== "issue_decision") continue;
    if (!best || e.created_at >= best.created_at) best = e;
  }
  if (!best) return null;
  const d = best.detail?.["decision"];
  if (d !== "payment_requested" && d !== "reclean" && d !== "waived") return null;
  return {
    decision: d,
    resolution: typeof best.detail?.["resolution"] === "string" ? (best.detail["resolution"] as string) : "",
    decided_at: best.created_at,
  };
}

// Waive stickiness (fix round 2): unlike latestIssueDecision — which
// returns only the NEWEST decision (for display and dedup) — this
// answers "was this visit EVER waived?" A waive is terminal, so ANY
// waive decision in the journal waives the visit forever, whatever
// later decisions say. The old code asked only the latest decision,
// so waive -> new complaint -> request_payment -> approve -> resolve
// revived the charge on a visit the owner had closed without payment.
export function everWaivedDecision(events: BasisEvent[]): boolean {
  return events.some(
    (e) => e.event === "issue_decision" && e.detail?.["decision"] === "waived",
  );
}

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
    // Payment-date gate (B): the visit's effective date (confirmed
    // date when set, else the scheduled date). A future date is never
    // a charge basis — neither an approval nor the timer may pay for
    // a visit that has not happened yet. Absent = no gate (legacy
    // callers that do not know the date).
    visitDate?: string | null;
    // Waive durability (fix round 2): the durable `charge_waived`
    // column on gh_visits (migration 20261112_charge_waived). The
    // journal is capped at 60 events, so a waive can fall out of the
    // window on a busy visit; the column is the same fact in durable
    // form. Absent (column not yet migrated) = fall back to the
    // journal alone.
    chargeWaivedRow?: boolean | null;
    // Fix round 2: a refunded visit has NO basis — the payment was
    // returned, so neither a fresh approval nor the timer may charge
    // it again. Absent = no check (legacy callers that do not know
    // the visit status).
    status?: string | null;
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
  // Payment-date gate (B), checked before either basis: an approval
  // given for a future visit is not yet a basis, and the timer never
  // runs for a visit that has not happened.
  if (isFutureVisitDate(input.visitDate ?? null, nowMs)) return null;
  // Waive stickiness (fix round 2): a waived visit has NO basis on
  // any path — neither a fresh approval nor the timer may pay for a
  // visit the owner closed without payment, whatever happened after
  // the waive (new complaint, request for payment, resolve).
  if (everWaivedDecision(input.events) || input.chargeWaivedRow === true) return null;
  // Fix round 2: a refunded visit has NO basis — the payment was
  // returned, so neither a fresh approval nor the timer may charge it
  // again (re-charging a refunded visit is a new charge, not a retry).
  if (input.status === "refunded") return null;
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
