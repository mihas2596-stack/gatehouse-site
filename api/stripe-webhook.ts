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
//    payment state for the booking
//
// State lives in Stripe Customer metadata (no database in this project).
// Event handling is idempotent: repeated deliveries of the same event id
// are ignored (best-effort in-memory set; Stripe may redeliver).
//
// The endpoint must be registered in Stripe Dashboard:
//   Developers → Webhooks → Add endpoint →
//   https://www.gatehousehomecleaning.com/api/stripe-webhook
// and STRIPE_WEBHOOK_SECRET must be set in Vercel env vars.

import { createHmac, timingSafeEqual } from "crypto";
import { sendReceiptEmailOnce, sendFeeReceiptEmailOnce } from "./booking-action.js";
import { dbConfigured, dbSelect, dbSelectStrict, dbUpdate, dbUpdateCount, logEvent, logEventStrict } from "./_db.js";

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
  if (seenEvents.has(eventId)) {
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
            await stripePost(STRIPE_SECRET_KEY, `/customers/${customerId}`, {
              "metadata[gh_state]": "card_ready",
              "metadata[gh_payment_method]": pm,
              ...(bookingId ? { "metadata[gh_booking_id]": bookingId } : {}),
            });
            log("card_ready", { customer: customerId, booking: bookingId });
          } else {
            logErr("setup_intent", `not succeeded: ${String(si.data["status"])}`);
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
        let cleanRow: { id: string; status: string | null; payment_intent_id: string | null; amount_cents: number | null } | null = null;
        if (dbConfigured()) {
          const vrows = await dbSelectStrict<{ id: string; status: string | null; payment_intent_id: string | null; amount_cents: number | null }>(
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
        // Guard against out-of-order events: never regress a "paid" booking
        // back to an earlier state. Read current state first.
        const cur = await stripeGet(STRIPE_SECRET_KEY, `/customers/${encodeURIComponent(customerId)}`);
        const curMeta = (cur.ok ? (cur.data["metadata"] as Record<string, string> | undefined) : undefined) ?? {};
        const curState = curMeta["gh_state"] ?? "";
        const newState = eventType === "payment_intent.succeeded" ? "paid" : "payment_failed";
        if (!cleanVerified) {
          // Ack without writing: a retry would mismatch identically.
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
        if (cleanVerified && !cleanMirrorFailed && dbConfigured()) {
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
                const journaled = await logEventStrict(vrow.id, bookingId, "system", "payment_failed", {
                  via: "stripe_webhook", payment_intent_id: piId,
                });
                if (!journaled) cleanMirrorFailed = true;
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
        if (cleanVerified && newState === "paid") {
          // Receipt email (idempotent — the helper no-ops when the
          // receipt marker is already stored). A failure here never
          // fails the webhook: the cron retries the EMAIL later. The
          // amount comes from the visit's pinned amount, not metadata.
          try {
            await sendReceiptEmailOnce(STRIPE_SECRET_KEY, customerId, {
              ...curMeta,
              ...(cleanRow?.amount_cents != null
                ? { gh_report_amount_cents: String(cleanRow.amount_cents) } : {}),
            }, bookingId);
          } catch { /* best-effort */ }
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

  // Mark as processed only after success. In-memory Set is a best-effort
  // guard for duplicate deliveries within one serverless instance; Stripe's
  // own retry + idempotent state writes are the real safety net.
  seenEvents.add(eventId);
  if (seenEvents.size > 2000) seenEvents.clear();

  res.status(200).json({ ok: true });
}
