// POST /api/stripe-webhook
//
// Stripe webhook receiver. Verifies the Stripe-Signature header with
// STRIPE_WEBHOOK_SECRET (fail closed: no secret = reject everything).
//
// Handled events:
//  - checkout.session.completed (mode=setup) → mark card saved on the
//    customer (gh_state=card_ready, gh_payment_method=<pm_id>)
//  - setup_intent.succeeded / setup_intent.setup_failed → update card state
//  - payment_intent.succeeded / payment_intent.payment_failed → update
//    payment state for the booking (succeeded verifies the payment
//    basis first — waived / issue / future date never marks paid)
//  - charge.refunded → journal the refund; a full refund moves the
//    visit from Paid to Refunded (fix round 2)
//  - charge.dispute.created → journal the dispute and open an issue on
//    the visit, blocking further auto-charge (fix round 2)
//
// State lives in Stripe Customer metadata (no database in this project).
// Event handling is idempotent: repeated deliveries of the same event id
// are ignored — persistently, via gh_webhook_events (C14), with the
// in-memory set below as a same-instance fast path only. The persistent
// row is written only AFTER successful processing, so a failed delivery
// (5xx) is still retried by Stripe instead of being swallowed.
//
// The endpoint must be registered in Stripe Dashboard:
//   Developers → Webhooks → Add endpoint →
//   https://www.gatehousehomecleaning.com/api/stripe-webhook
// and STRIPE_WEBHOOK_SECRET must be set in Vercel env vars.

import { createHmac, timingSafeEqual } from "crypto";
import { sendReceiptEmailOnce, sendFeeReceiptEmailOnce } from "./booking-action.js";
import { recordCheckoutCardForOwner } from "./card-status.js";
import { dbConfigured, dbSelect, dbSelectStrict, dbUpdate, dbUpdateCount, logEvent, logEventStrict } from "./_db.js";
import { webhookEventSeen, recordWebhookEvent } from "./_webhook_dedup.js";
import { paymentBasis, issueStateFrom, everWaivedDecision } from "./_payment_basis.js";
import { confirmedDateOf, effectiveVisitDate, isFutureVisitDate } from "./_visit_date.js";

const STRIPE_API = "https://api.stripe.com/v1";

// Disable Vercel's body parser: Stripe signs the EXACT raw bytes, so we
// must read the stream ourselves for signature verification.
export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(stream: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  // `req` is an http.IncomingMessage (a readable stream) at runtime.
  const readable = stream as AsyncIterable<Uint8Array>;
  for await (const chunk of readable) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
};
type Res = {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

// Best-effort dedupe of redelivered events (per function instance).
const seenEvents = new Set<string>();

function verifySignature(secret: string, payload: string, header: string): boolean {
  // Stripe-Signature: t=<timestamp>,v1=<hmac>
  const parts = header.split(",").map((p) => p.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const v1 = parts.find((p) => p.startsWith("v1="))?.slice(3);
  if (!t || !v1) return false;
  const age = Math.floor(Date.now() / 1000) - Number(t);
  if (!Number.isFinite(age) || age < 0 || age > 300) return false; // 5-min tolerance
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const a = Buffer.from(v1, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function stripePost(
  secretKey: string,
  path: string,
  params: Record<string, string>,
): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  return { ok: response.ok, status: response.status };
}

async function stripeGet(
  secretKey: string,
  path: string,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15000),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return { ok: response.ok, data };
}

export default async function handler(req: Req, res: Res) {
  const requestId = Math.random().toString(36).slice(2);
  const log = (step: string, info?: unknown) =>
    console.log(JSON.stringify({ requestId, step, info }));
  const logErr = (step: string, err: unknown) =>
    console.error(
      JSON.stringify({ requestId, step, error: err instanceof Error ? err.message : String(err) }),
    );

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
  const WEBHOOK_SECRET = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!STRIPE_SECRET_KEY || !WEBHOOK_SECRET) {
    // Fail closed: without the webhook secret we cannot verify anything.
    logErr("config", "STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET missing");
    res.status(500).json({ ok: false, error: "server_error" });
    return;
  }

  // Read the RAW body: Stripe signs the exact bytes, and Vercel's body
  // parser is disabled for this endpoint (see `config` above).
  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch {
    logErr("body", "cannot read raw body");
    res.status(400).json({ ok: false, error: "invalid_payload" });
    return;
  }
  const sigHeaderRaw = req.headers["stripe-signature"];
  const sigHeader = Array.isArray(sigHeaderRaw) ? sigHeaderRaw[0] : sigHeaderRaw ?? "";
  if (!verifySignature(WEBHOOK_SECRET, rawBody, sigHeader)) {
    logErr("signature", "invalid");
    res.status(400).json({ ok: false, error: "invalid_signature" });
    return;
  }

  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    logErr("parse", "invalid json");
    res.status(400).json({ ok: false, error: "invalid_payload" });
    return;
  }

  const eventId = event.id ?? "";
  const eventType = event.type ?? "";
  // C14: persistent dedup (cross-instance) + the in-memory fast path.
  // A row is recorded only after successful processing (bottom of the
  // handler), so a 5xx delivery is retried, not swallowed.
  if (seenEvents.has(eventId) || (eventId && (await webhookEventSeen("stripe", eventId)))) {
    log("dedupe", "already_processed");
    res.status(200).json({ ok: true, deduped: true });
    return;
  }
  // NOTE: eventId is added to seenEvents only AFTER successful processing
  // (see bottom of handler). Marking it before would wrongly dedupe Stripe
  // retries after a handler failure.

  const obj = event.data?.object ?? {};
  log("event", { type: eventType, id: eventId });

  try {
    if (eventType === "checkout.session.completed" && obj["mode"] === "setup") {
      const sessionMeta = (obj["metadata"] as Record<string, string> | undefined) ?? {};
      // Only our own save-card sessions: ignore any other Checkout session
      // that might target the same customer.
      if (sessionMeta["source"] !== "gatehouse_save_card") {
        log("ignored", "foreign_setup_session");
      } else {
        const customerId = typeof obj["customer"] === "string" ? obj["customer"] : null;
        const setupIntentRaw = obj["setup_intent"];
        const setupIntentId =
          typeof setupIntentRaw === "string" ? setupIntentRaw : (setupIntentRaw as { id?: string } | undefined)?.id;
        const bookingId =
          (obj["client_reference_id"] as string | undefined) ??
          (sessionMeta["gh_booking_id"] ?? null);
        if (customerId && setupIntentId) {
          // Confirm the SetupIntent actually succeeded before marking card_ready.
          const si = await stripeGet(STRIPE_SECRET_KEY, `/setup_intents/${encodeURIComponent(setupIntentId)}`);
          if (si.ok && si.data["status"] === "succeeded") {
            const pm = typeof si.data["payment_method"] === "string" ? (si.data["payment_method"] as string) : "";
            if (bookingId && pm) await recordCheckoutCardForOwner(STRIPE_SECRET_KEY, bookingId, customerId, pm);
            await stripePost(STRIPE_SECRET_KEY, `/customers/${customerId}`, {
              "metadata[gh_state]": "card_ready",
              "metadata[gh_payment_method]": pm,
              ...(bookingId ? { "metadata[gh_booking_id]": bookingId } : {}),
            });
            log("card_ready", { customer: customerId, booking: bookingId });
          } else {
            logErr("setup_intent", `not succeeded: ${String(si.data["status"])}`);
            if (!si.ok) throw new Error("setup_intent_unavailable");
          }
        }
      }
    } else if (eventType === "setup_intent.setup_failed") {
      const customerId = typeof obj["customer"] === "string" ? obj["customer"] : null;
      if (customerId) {
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customerId}`, {
          "metadata[gh_state]": "card_failed",
        });
        log("card_failed", { customer: customerId });
      }
    } else if (eventType === "payment_intent.succeeded" || eventType === "payment_intent.payment_failed") {
      const meta = (obj["metadata"] as Record<string, string> | undefined) ?? {};
      const bookingId = meta["gh_booking_id"];
      const customerId = typeof obj["customer"] === "string" ? obj["customer"] : null;
      const piId = (obj["id"] as string | undefined) ?? "";
      const feeCents = typeof obj["amount"] === "number" ? obj["amount"] : NaN;
      if (customerId && bookingId && meta["gh_kind"] === "cancellation_fee") {
        // RA10: a cancellation fee is a SEPARATE obligation. It never
        // marks the cleaning paid, never touches the visit row's
        // cleaning status, and never triggers the cleaning receipt.
        // Out-of-order and repeat deliveries are deduped on the fee's
        // own marker, not on the cleaning payment pointer.
        // N08: the fee mirror is verified against the cancel record
        // (amount) and the fee row (no conflicting paid fee), and a
        // failed mirror is NOT silently acked — the handler returns
        // 500 below so Stripe retries the delivery.
        let mirrorFailed = false;
        if (eventType === "payment_intent.succeeded") {
          const cur = await stripeGet(STRIPE_SECRET_KEY, `/customers/${encodeURIComponent(customerId)}`);
          const curMeta = (cur.ok ? (cur.data["metadata"] as Record<string, string> | undefined) : undefined) ?? {};
          if (piId && curMeta["gh_fee_last_payment"] === piId) {
            log("fee", { state: "already_recorded", booking: bookingId, pi: piId });
          } else {
            // Verify against the row's fee obligation before any write.
            let feeVerified = true;
            if (dbConfigured()) {
              const vrows = await dbSelectStrict<{ id: string; fee_status: string | null; fee_intent_id: string | null }>(
                "gh_visits",
                `booking_id=eq.${encodeURIComponent(bookingId)}&order=visit_no.desc&limit=1`,
              );
              if (!vrows.ok) {
                mirrorFailed = true;
              } else if (vrows.rows[0]?.fee_status === "fee_paid" && vrows.rows[0]?.fee_intent_id !== piId) {
                feeVerified = false;
                log("fee", { state: "conflict_skip", booking: bookingId, pi: piId });
              }
              if (feeVerified && !mirrorFailed) {
                const cevs = await dbSelect<{ detail: Record<string, unknown> | null }>(
                  "gh_events",
                  `booking_id=eq.${encodeURIComponent(bookingId)}&event=eq.visit_cancelled&limit=1`,
                );
                const recorded = typeof cevs[0]?.detail?.["fee_cents"] === "number"
                  ? (cevs[0].detail["fee_cents"] as number) : NaN;
                if (Number.isFinite(recorded) && recorded !== feeCents) {
                  feeVerified = false;
                  log("fee", { state: "amount_mismatch_skip", booking: bookingId, pi: piId });
                }
              }
            }
            if (!feeVerified) {
              // Not this fee: ack without writing (a retry would
              // mismatch identically), and do not mark it seen as a
              // fee payment anywhere.
            } else if (mirrorFailed) {
              // DB unreadable: fall through to the 500 below.
            } else {
            await stripePost(STRIPE_SECRET_KEY, `/customers/${customerId}`, {
              "metadata[gh_fee_charged]": "1",
              "metadata[gh_fee_last_payment]": piId,
              "metadata[gh_fee_paid_at]": new Date().toISOString(),
            });
            if (dbConfigured()) {
              try {
                const rows = await dbSelect<{ id: string }>(
                  "gh_visits",
                  `booking_id=eq.${encodeURIComponent(bookingId)}&order=visit_no.desc&limit=1`,
                );
                if (rows[0]) {
                  const journaled = await logEventStrict(rows[0].id, bookingId, "system", "cancellation_fee_paid", {
                    payment_intent: piId, amount_cents: feeCents,
                  });
                  const marked = journaled
                    ? await dbUpdateCount("gh_visits", `id=eq.${rows[0].id}`, { fee_status: "fee_paid", fee_intent_id: piId })
                    : -1;
                  if (!journaled || marked < 0) mirrorFailed = true;
                }
              } catch (err) {
                logErr("db_mirror_fee", err);
                mirrorFailed = true;
              }
            }
            try {
              await sendFeeReceiptEmailOnce(STRIPE_SECRET_KEY, customerId, bookingId, piId, feeCents);
            } catch { /* best-effort */ }
            log("fee", { state: eventType, booking: bookingId, amount_cents: feeCents });
          }
          }
        } else {
          if (dbConfigured()) {
            try {
              const rows = await dbSelect<{ id: string }>(
                "gh_visits",
                `booking_id=eq.${encodeURIComponent(bookingId)}&order=visit_no.desc&limit=1`,
              );
              if (rows[0]) {
                await logEvent(rows[0].id, bookingId, "system", "cancellation_fee_failed", {
                  payment_intent: piId, amount_cents: feeCents,
                });
              }
            } catch (err) {
              logErr("db_mirror_fee", err);
            }
          }
          log("fee", { state: eventType, booking: bookingId });
        }
        if (mirrorFailed) {
          res.status(500).json({ ok: false, error: "mirror_failed" });
          return;
        }
      } else if (customerId && bookingId) {
        // N08: verify BEFORE any write. A succeeded event for the
        // wrong amount, the wrong booking, or a fee-shaped intent
        // must never mark a cleaning paid — the old code mirrored
        // any succeeded intent with this booking id in metadata.
        // A failed mirror is NOT silently acked: the handler returns
        // 500 at the bottom so Stripe retries (the meta write is
        // idempotent, so the retry heals the mirror).
        let cleanMirrorFailed = false;
        let cleanVerified = true;
        let cleanRow: {
          id: string; status: string | null; payment_intent_id: string | null; amount_cents: number | null;
          // Basis check (fix round 2): the visit date, issue flags,
          // report state and durable waive flag — a succeeded intent
          // must not mark the visit paid when the payment basis is
          // invalid.
          visit_date: string | null; issue_open: boolean | null; issue_ever: boolean | null;
          report_sent_at: string | null; report_bounced: boolean | null; charge_waived?: boolean | null;
        } | null = null;
        if (dbConfigured()) {
          const vrows = await dbSelectStrict<{
            id: string; status: string | null; payment_intent_id: string | null; amount_cents: number | null;
            visit_date: string | null; issue_open: boolean | null; issue_ever: boolean | null;
            report_sent_at: string | null; report_bounced: boolean | null; charge_waived?: boolean | null;
          }>(
            "gh_visits",
            `booking_id=eq.${encodeURIComponent(bookingId)}&order=visit_no.desc&limit=1`,
          );
          if (!vrows.ok) {
            cleanMirrorFailed = true;
          } else {
            cleanRow = vrows.rows[0] ?? null;
            if (cleanRow && eventType === "payment_intent.succeeded") {
              const pinned = typeof cleanRow.amount_cents === "number" ? cleanRow.amount_cents : NaN;
              if (!Number.isFinite(pinned) || pinned !== feeCents) {
                cleanVerified = false;
                log("payment", { state: "amount_mismatch_skip", booking: bookingId, pi: piId });
              }
              if (cleanRow.status === "paid" && cleanRow.payment_intent_id !== piId) {
                cleanVerified = false;
                log("payment", { state: "conflict_skip", booking: bookingId, pi: piId });
              }
            }
          }
        }
        // Basis check (fix round 2): a succeeded intent must not mark
        // the visit paid when the payment basis is invalid — waived,
        // open/ever issue, or a future visit date. The money already
        // moved in Stripe; the anomaly is journaled below for manual
        // review instead of a paid visit. A retry would fail
        // identically while the basis stays invalid, so the event is
        // acked (200), not retried — the paid state can still be
        // recovered through chargeVisit's reconcile if the basis
        // later becomes valid.
        let basisBlockedReason: string | null = null;
        if (eventType === "payment_intent.succeeded" && cleanRow && cleanVerified && !cleanMirrorFailed) {
          const evRows = await dbSelect<{ event: string; detail: Record<string, unknown> | null; created_at: string }>(
            "gh_events",
            `booking_id=eq.${encodeURIComponent(bookingId)}&order=created_at.desc&limit=60`,
          );
          const effDate = effectiveVisitDate(confirmedDateOf(evRows), cleanRow.visit_date ?? null);
          const basis = paymentBasis(
            {
              reportSentAt: cleanRow.report_sent_at ?? null,
              events: evRows,
              issueOpenRow: cleanRow.issue_open ?? null,
              issueEverRow: cleanRow.issue_ever ?? null,
              bounced: cleanRow.report_bounced ?? null,
              visitDate: effDate,
              chargeWaivedRow: cleanRow.charge_waived ?? null,
              // Fix round 2: a refunded visit has no basis — a new
              // succeeded intent for it must not re-mark it paid.
              status: cleanRow.status ?? null,
            },
            Date.now(),
          );
          if (basis === null) {
            const issue = issueStateFrom(evRows, cleanRow.issue_open ?? null, cleanRow.issue_ever ?? null);
            if (everWaivedDecision(evRows) || cleanRow.charge_waived === true) basisBlockedReason = "charge_waived";
            else if (cleanRow.status === "refunded") basisBlockedReason = "refunded";
            else if (issue.open) basisBlockedReason = "issue_open";
            else if (issue.ever) basisBlockedReason = "issue_ever";
            else if (isFutureVisitDate(effDate, Date.now())) basisBlockedReason = "report_too_early";
            else if (cleanRow.report_bounced === true) basisBlockedReason = "bounced";
            else if (!cleanRow.report_sent_at && !evRows.some((e) => e.event === "report_sent")) basisBlockedReason = "payment_basis_missing";
            else basisBlockedReason = "no_basis";
            log("payment", { state: "basis_invalid_skip", booking: bookingId, pi: piId, reason: basisBlockedReason });
          }
        }
        // Guard against out-of-order events: never regress a "paid" booking
        // back to an earlier state. Read current state first.
        const cur = await stripeGet(STRIPE_SECRET_KEY, `/customers/${encodeURIComponent(customerId)}`);
        const curMeta = (cur.ok ? (cur.data["metadata"] as Record<string, string> | undefined) : undefined) ?? {};
        const curState = curMeta["gh_state"] ?? "";
        const newState = eventType === "payment_intent.succeeded" ? "paid" : "payment_failed";
        if (!cleanVerified) {
          // Ack without writing: a retry would mismatch identically.
        } else if (basisBlockedReason) {
          // Basis invalid (fix round 2): do NOT mark paid — neither
          // the metadata nor the row (the anomaly is journaled below
          // for manual review). The event is acked: a retry would
          // fail identically while the basis stays invalid.
          log("payment", { state: "basis_invalid", booking: bookingId, pi: piId, reason: basisBlockedReason });
        } else if (cleanMirrorFailed) {
          // DB unreadable: fall through to the 500 below.
        } else if (curState === "paid" && newState !== "paid") {
          log("payment", { state: "regression_blocked", booking: bookingId, curState, newState });
        } else if (piId && curMeta["gh_last_payment"] === piId && curState === newState) {
          // Same payment intent already recorded (cross-instance redelivery):
          // the write below would be a no-op, skip it.
          log("payment", { state: "already_recorded", booking: bookingId, pi: piId });
        } else {
          await stripePost(STRIPE_SECRET_KEY, `/customers/${customerId}`, {
            "metadata[gh_state]": newState,
            "metadata[gh_last_payment]": piId,
          });
          log("payment", { state: eventType, booking: bookingId });
        }
        // §13: mirror into the booking's DB row + journal, idempotently.
        // Basis invalid (fix round 2): the money moved in Stripe, but
        // the visit must not be marked paid. Journal the anomaly (with
        // the reason) so the owner sees it in Activity and can review
        // it manually — a refund or a manual paid-mark, not an
        // automatic one. Deduped on the payment intent, like the
        // payment_failed journal below, so a retry never writes it twice.
        if (basisBlockedReason && cleanRow && dbConfigured()) {
          try {
            const prior = await dbSelect<{ detail: Record<string, unknown> | null }>(
              "gh_events",
              `visit_id=eq.${cleanRow.id}&event=eq.payment_succeeded_no_basis&order=created_at.desc&limit=10`,
            );
            const alreadyJournaled = prior.some((e) => {
              const d = e.detail ?? {};
              return d["payment_intent"] === piId || d["payment_intent_id"] === piId;
            });
            if (alreadyJournaled) {
              log("payment", { state: "already_journaled_no_basis", booking: bookingId, pi: piId });
            } else {
              const journaled = await logEventStrict(cleanRow.id, bookingId, "system", "payment_succeeded_no_basis", {
                via: "stripe_webhook", payment_intent: piId, amount_cents: feeCents, reason: basisBlockedReason,
              });
              if (!journaled) cleanMirrorFailed = true;
            }
          } catch (err) {
            logErr("db_mirror", err);
            cleanMirrorFailed = true;
          }
        }
        if (cleanVerified && !cleanMirrorFailed && !basisBlockedReason && dbConfigured()) {
          try {
            const vrow = cleanRow;
            if (vrow) {
              if (newState === "paid" && !(vrow.status === "paid" && vrow.payment_intent_id === piId)) {
                const marked = await dbUpdateCount("gh_visits", `id=eq.${vrow.id}&status=neq.paid`, {
                  status: "paid",
                  paid_at: new Date().toISOString(),
                  payment_intent_id: piId,
                });
                const journaled = marked === 1
                  ? await logEventStrict(vrow.id, bookingId, "system", "payment_succeeded", {
                      via: "stripe_webhook", payment_intent_id: piId,
                    })
                  : false;
                if (marked !== 1 || !journaled) cleanMirrorFailed = true;
              } else if (newState === "payment_failed" && vrow.status !== "paid") {
                // C14: a redelivery of the same event must not write a
                // second payment_failed row. The persistent dedup above
                // is the first guard; this one also covers a duplicate
                // that arrived concurrently with the first delivery
                // (both passed the seen-check before either journaled).
                const prior = await dbSelect<{ detail: Record<string, unknown> | null }>(
                  "gh_events",
                  `visit_id=eq.${vrow.id}&event=eq.payment_failed&order=created_at.desc&limit=10`,
                );
                const alreadyJournaled = prior.some((e) => {
                  const d = e.detail ?? {};
                  return d["payment_intent"] === piId || d["payment_intent_id"] === piId;
                });
                if (alreadyJournaled) {
                  log("payment", { state: "already_journaled", booking: bookingId, pi: piId });
                } else {
                  const journaled = await logEventStrict(vrow.id, bookingId, "system", "payment_failed", {
                    via: "stripe_webhook", payment_intent_id: piId,
                  });
                  if (!journaled) cleanMirrorFailed = true;
                }
              }
            }
          } catch (err) {
            logErr("db_mirror", err);
            cleanMirrorFailed = true;
          }
        }
        if (cleanMirrorFailed) {
          // Stripe retries; the retry re-verifies and heals the mirror
          // (meta write above is idempotent, already_recorded skips it).
          res.status(500).json({ ok: false, error: "mirror_failed" });
          return;
        }
        if (cleanVerified && !basisBlockedReason && newState === "paid") {
          // Receipt email (idempotent — the helper no-ops when the
          // receipt marker is already stored). A failure here never
          // fails the webhook: the cron retries the EMAIL later. The
          // amount comes from the visit's pinned amount, not metadata.
          // No receipt for a basis-blocked payment (fix round 2): the
          // charge should not have happened, and the owner reviews it
          // manually first.
          try {
            await sendReceiptEmailOnce(STRIPE_SECRET_KEY, customerId, {
              ...curMeta,
              ...(cleanRow?.amount_cents != null
                ? { gh_report_amount_cents: String(cleanRow.amount_cents) } : {}),
            }, bookingId);
          } catch { /* best-effort */ }
        }
      }
    } else if (eventType === "charge.refunded" || eventType === "charge.dispute.created") {
      // Fix round 2: refunds and disputes were ignored entirely — a
      // refunded visit stayed Paid forever, and a dispute never
      // blocked anything. Both are recorded in the journal and made
      // visible to the owner; a full refund moves the visit out of
      // Paid, and a dispute opens an issue (blocking auto-charge).
      // No new charges and no refunds are ever issued from the
      // webhook — these handlers only record what Stripe already did.
      const isRefund = eventType === "charge.refunded";
      const piRaw = obj["payment_intent"];
      let piId = typeof piRaw === "string" ? piRaw : (piRaw as { id?: string } | undefined)?.id ?? "";
      if (!piId && !isRefund) {
        // Dispute without a payment_intent: resolve it through the
        // charge it belongs to.
        const chargeId = typeof obj["charge"] === "string" ? (obj["charge"] as string) : "";
        if (chargeId) {
          const ch = await stripeGet(STRIPE_SECRET_KEY, `/charges/${encodeURIComponent(chargeId)}`);
          const chPi = ch.ok ? ch.data["payment_intent"] : undefined;
          if (typeof chPi === "string") piId = chPi;
        }
      }
      if (!piId) {
        log("ignored", { type: eventType, reason: "no_payment_intent" });
      } else if (!dbConfigured()) {
        // No DB: nothing to record the refund/dispute against.
        log("ignored", { type: eventType, reason: "no_db" });
      } else {
        // A fee intent (cancellation fee) lives in fee_intent_id,
        // not payment_intent_id — a refund/dispute on a fee is not
        // a cleaning refund/dispute and is ignored here.
        const vrows = await dbSelectStrict<{ id: string; booking_id: string; status: string | null; payment_intent_id: string | null; stripe_customer_id: string | null }>(
          "gh_visits",
          `payment_intent_id=eq.${encodeURIComponent(piId)}&limit=1`,
        );
        if (!vrows.ok) {
          res.status(500).json({ ok: false, error: "mirror_failed" });
          return;
        }
        const vrow = vrows.rows[0] ?? null;
        if (!vrow) {
          log("ignored", { type: eventType, pi: piId, reason: "no_visit_for_pi" });
        } else {
          const amount = typeof obj["amount"] === "number" ? (obj["amount"] as number) : NaN;
          const disputeId = typeof obj["id"] === "string" ? (obj["id"] as string) : "";
          const chargeId = typeof obj["id"] === "string" ? (obj["id"] as string) : "";
          let mirrorFailed = false;
          if (isRefund) {
            const amountRefunded = typeof obj["amount_refunded"] === "number" ? (obj["amount_refunded"] as number) : NaN;
            const fullyRefunded = obj["refunded"] === true
              || (Number.isFinite(amountRefunded) && Number.isFinite(amount) && amountRefunded >= amount);
            // Dedupe on (charge, cumulative refunded amount): a
            // redelivery repeats the same pair, while a second
            // partial refund raises amount_refunded and is a new
            // record.
            const prior = await dbSelect<{ detail: Record<string, unknown> | null }>(
              "gh_events",
              `visit_id=eq.${vrow.id}&event=eq.payment_refunded&order=created_at.desc&limit=10`,
            );
            const alreadyJournaled = prior.some((e) => {
              const d = e.detail ?? {};
              return d["charge"] === chargeId && d["amount_cents"] === amountRefunded;
            });
            if (alreadyJournaled) {
              log("refund", { state: "already_journaled", pi: piId, charge: chargeId });
            } else {
              const journaled = await logEventStrict(vrow.id, vrow.booking_id, "system", "payment_refunded", {
                charge: chargeId, payment_intent: piId,
                amount_cents: Number.isFinite(amountRefunded) ? amountRefunded : null,
                refunded: fullyRefunded,
              });
              if (!journaled) mirrorFailed = true;
            }
            if (!mirrorFailed && fullyRefunded) {
              // Full refund: the visit is no longer Paid. Only
              // transition from "paid" — a visit that was never
              // marked paid keeps its state (the journal above is
              // the record). 0 is fine (already refunded); -1 is a
              // DB error and retries.
              const moved = await dbUpdateCount(
                "gh_visits",
                `id=eq.${vrow.id}&status=eq.paid`,
                { status: "refunded" },
              );
              if (moved < 0) mirrorFailed = true;
              else if (moved === 1 && vrow.stripe_customer_id) {
                // Best-effort metadata mirror so the client pages
                // stop showing "Paid" (deriveState handles
                // gh_state "refunded"). A failed mirror never fails
                // the refund record itself.
                try {
                  await stripePost(STRIPE_SECRET_KEY, `/customers/${encodeURIComponent(vrow.stripe_customer_id)}`, {
                    "metadata[gh_state]": "refunded",
                  });
                } catch { /* durable state is in the DB */ }
              }
            }
          } else {
            const reason = typeof obj["reason"] === "string" ? (obj["reason"] as string) : "";
            const prior = await dbSelect<{ detail: Record<string, unknown> | null }>(
              "gh_events",
              `visit_id=eq.${vrow.id}&event=eq.payment_disputed&order=created_at.desc&limit=10`,
            );
            const alreadyJournaled = prior.some((e) => {
              const d = e.detail ?? {};
              return d["dispute"] === disputeId;
            });
            if (alreadyJournaled) {
              log("dispute", { state: "already_journaled", pi: piId, dispute: disputeId });
            } else {
              const journaled = await logEventStrict(vrow.id, vrow.booking_id, "system", "payment_disputed", {
                dispute: disputeId, payment_intent: piId,
                amount_cents: Number.isFinite(amount) ? amount : null, reason,
              });
              if (!journaled) mirrorFailed = true;
            }
            if (!mirrorFailed && vrow.status === "paid") {
              // A dispute on a paid visit opens an issue: the owner
              // sees it in the Open issues block, and the issue
              // flags block any further auto-charge for this visit.
              // The money is still held (not refunded yet), so the
              // payment state stays "paid" — only the issue flags move.
              const flagged = await dbUpdateCount(
                "gh_visits",
                `id=eq.${vrow.id}&status=eq.paid`,
                { issue_open: true, issue_ever: true },
              );
              if (flagged < 0) mirrorFailed = true;
            }
          }
          if (mirrorFailed) {
            res.status(500).json({ ok: false, error: "mirror_failed" });
            return;
          }
          log(isRefund ? "refund" : "dispute", { state: eventType, pi: piId });
        }
      }
    } else {
      log("ignored", eventType);
    }
  } catch (err) {
    logErr("handler", err);
    // Return 500 so Stripe retries the delivery. The event is NOT marked as
    // seen, so the retry will be processed (not deduped).
    res.status(500).json({ ok: false, error: "server_error" });
    return;
  }

  // Mark as processed only after success. The persistent row in
  // gh_webhook_events is the cross-instance dedup (C14); the
  // in-memory Set is only a same-instance fast path and is never
  // cleared — the old "clear past 2000" silently re-admitted
  // redeliveries. Stripe's own retry + idempotent state writes are
  // the remaining safety net.
  await recordWebhookEvent("stripe", eventId, eventType);
  seenEvents.add(eventId);

  res.status(200).json({ ok: true });
}
