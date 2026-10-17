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
  seenEvents.add(eventId);
  if (seenEvents.size > 2000) seenEvents.clear();

  const obj = event.data?.object ?? {};
  log("event", { type: eventType, id: eventId });

  try {
    if (eventType === "checkout.session.completed" && obj["mode"] === "setup") {
      const customerId = typeof obj["customer"] === "string" ? obj["customer"] : null;
      const setupIntentRaw = obj["setup_intent"];
      const setupIntentId =
        typeof setupIntentRaw === "string" ? setupIntentRaw : (setupIntentRaw as { id?: string } | undefined)?.id;
      const bookingId =
        (obj["client_reference_id"] as string | undefined) ??
        ((obj["metadata"] as Record<string, string> | undefined)?.["gh_booking_id"] ?? null);
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
      if (customerId && bookingId) {
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customerId}`, {
          "metadata[gh_state]": eventType === "payment_intent.succeeded" ? "paid" : "payment_failed",
          "metadata[gh_last_payment]": (obj["id"] as string | undefined) ?? "",
        });
        log("payment", { state: eventType, booking: bookingId });
      }
    } else {
      log("ignored", eventType);
    }
  } catch (err) {
    logErr("handler", err);
    // Return 500 so Stripe retries the delivery.
    res.status(500).json({ ok: false, error: "server_error" });
    return;
  }

  res.status(200).json({ ok: true });
}
