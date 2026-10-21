// /api/auto-charge — the server-side 24h timer for "Approve, then pay".
//
// Invoked by Vercel Cron (see vercel.json) or manually by the operator.
// Auth: Authorization: Bearer <redacted> (Vercel Cron sends this
// automatically when the CRON_SECRET env var exists) or the ADMIN_TOKEN.
//
// A booking is charged by the timer ONLY when ALL of these hold:
//   - gh_state == "report_sent" (a report was sent and not yet answered)
//   - the report was sent at least 24 hours ago (gh_report_sent_at)
//   - no issue is open AND no issue was EVER reported for this booking
//     (gh_issue_ever: after any complaint the auto-charge never resumes
//     on its own — resolution is communicated to the client and the
//     charge then goes through the operator approve/charge path)
//   - the report email was not confirmed bounced (gh_report_bounced:
//     per the Terms, the 24h window does not start until the report
//     reaches the client another way)
//   - a saved payment method exists
// The amount is the one pinned to this report by send_report
// (gh_report_amount_cents; fallback: the first-visit price). The
// PaymentIntent uses the SAME idempotency key as the manual charge
// (charge_<bid>_v<report_version>), and the state is claimed to
// payment_pending with a fresh re-read first — a timer run, an operator
// charge and a repeated webhook cannot produce two payments for one visit.

import { timingSafeEqual } from "crypto";

const STRIPE_API = "https://api.stripe.com/v1";
const MAX_PER_RUN = 25;

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

type Cust = { id: string; metadata: Record<string, string> };

async function stripeGet(
  secretKey: string,
  path: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
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
  return { ok: response.ok, status: response.status, data };
}

async function stripePost(
  secretKey: string,
  path: string,
  params: Record<string, string>,
  idempotencyKey?: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return { ok: response.ok, status: response.status, data };
}

export type DueCharge = {
  customerId: string;
  bookingId: string;
  amountCents: number;
  reportVersion: number;
  paymentMethod: string;
};

// Pure selection: which of these customers are due an automatic charge
// right now. Exported for tests; the handler re-runs it on a fresh
// re-read of each customer immediately before charging.
export function selectDue(customers: Cust[], nowMs: number): DueCharge[] {
  const out: DueCharge[] = [];
  for (const c of customers) {
    const m = c.metadata;
    if ((m["gh_state"] ?? "") !== "report_sent") continue;
    if (m["gh_issue_open"] === "1" || m["gh_issue_ever"] === "1") continue;
    if (m["gh_report_bounced"] === "1") continue;
    const sentMs = Date.parse(m["gh_report_sent_at"] ?? "");
    if (!Number.isFinite(sentMs)) continue;
    if (sentMs + 24 * 3600 * 1000 > nowMs) continue;
    const paymentMethod = m["gh_payment_method"] ?? "";
    if (!paymentMethod) continue;
    const rawAmount = m["gh_report_amount_cents"] ? m["gh_report_amount_cents"] : m["gh_first_price_cents"];
    const amount = parseInt(rawAmount ?? "", 10);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const bookingId = m["gh_booking_id"] ?? "";
    if (!bookingId) continue;
    out.push({
      customerId: c.id,
      bookingId,
      amountCents: amount,
      reportVersion: parseInt(m["gh_report_version"] ?? "1", 10) || 1,
      paymentMethod,
    });
  }
  return out;
}

async function findReportSentCustomers(secretKey: string): Promise<Cust[]> {
  const query = `metadata['gh_state']:'report_sent'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query, limit: "100" })}`);
  if (res.ok) {
    const list = (res.data["data"] as Array<{ id: string; metadata?: Record<string, string> }> | undefined) ?? [];
    return list.map((c) => ({ id: c.id, metadata: c.metadata ?? {} }));
  }
  const listRes = await stripeGet(secretKey, `/customers?${new URLSearchParams({ limit: "100" })}`);
  if (!listRes.ok) return [];
  const list = (listRes.data["data"] as Array<{ id: string; metadata?: Record<string, string> }> | undefined) ?? [];
  return list
    .map((c) => ({ id: c.id, metadata: c.metadata ?? {} }))
    .filter((c) => c.metadata["gh_state"] === "report_sent");
}

function authed(req: Req): boolean {
  const secret = process.env["CRON_SECRET"] || process.env["ADMIN_TOKEN"] || "";
  if (!secret) return false;
  const raw = req.headers["authorization"];
  const auth = Array.isArray(raw) ? raw[0] : raw ?? "";
  const a = Buffer.from(auth, "utf8");
  const b = Buffer.from(`Bearer ${secret}`, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req: Req, res: Res) {
  const requestId = Math.random().toString(36).slice(2);
  const log = (step: string, info?: unknown) =>
    console.log(JSON.stringify({ requestId, step, info }));
  const logErr = (step: string, err: unknown) =>
    console.error(
      JSON.stringify({ requestId, step, error: err instanceof Error ? err.message : String(err) }),
    );

  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }
  const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
  if (!STRIPE_SECRET_KEY) {
    logErr("config", "STRIPE_SECRET_KEY missing");
    res.status(500).json({ requestId, ok: false, error: "server_error" });
    return;
  }
  if (!process.env["CRON_SECRET"] && !process.env["ADMIN_TOKEN"]) {
    logErr("config", "no CRON_SECRET / ADMIN_TOKEN configured — refusing to run");
    res.status(500).json({ requestId, ok: false, error: "server_error" });
    return;
  }
  if (!authed(req)) {
    res.status(401).json({ requestId, ok: false, error: "unauthorized" });
    return;
  }

  try {
    const now = Date.now();
    const candidates = await findReportSentCustomers(STRIPE_SECRET_KEY);
    const due = selectDue(candidates, now).slice(0, MAX_PER_RUN);
    let charged = 0;
    let failed = 0;
    let skipped = 0;

    for (const item of due) {
      try {
        // Fresh re-read: a client issue (or an operator charge) landing
        // since the search must win over this timer run.
        const freshRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${item.customerId}`);
        const freshMeta = (freshRes.data["metadata"] as Record<string, string> | undefined) ?? {};
        const still = selectDue([{ id: item.customerId, metadata: freshMeta }], Date.now());
        if (still.length === 0) {
          skipped++;
          log("skip_fresh_recheck", { booking: item.bookingId });
          continue;
        }
        await stripePost(STRIPE_SECRET_KEY, `/customers/${item.customerId}`, {
          "metadata[gh_state]": "payment_pending",
          "metadata[gh_charge_source]": "timer_24h",
        });
        const pi = await stripePost(
          STRIPE_SECRET_KEY,
          "/payment_intents",
          {
            amount: String(item.amountCents),
            currency: "usd",
            customer: item.customerId,
            payment_method: item.paymentMethod,
            off_session: "true",
            confirm: "true",
            description: `Gatehouse cleaning — booking ${item.bookingId}`,
            "metadata[gh_booking_id]": item.bookingId,
            "metadata[gh_report_version]": String(item.reportVersion),
          },
          `charge_${item.bookingId}_v${item.reportVersion}`,
        );
        if (pi.ok && pi.data["status"] === "succeeded") {
          await stripePost(STRIPE_SECRET_KEY, `/customers/${item.customerId}`, {
            "metadata[gh_state]": "paid",
            "metadata[gh_last_payment]": String(pi.data["id"] ?? ""),
          });
          charged++;
          log("charged", { booking: item.bookingId, amount: item.amountCents });
        } else {
          const errMsg =
            ((pi.data["error"] as { message?: string } | undefined)?.message ??
              `payment ${String(pi.data["status"] ?? "failed")}`);
          await stripePost(STRIPE_SECRET_KEY, `/customers/${item.customerId}`, {
            "metadata[gh_state]": "payment_failed",
          });
          failed++;
          logErr("charge_failed", `${item.bookingId}: ${errMsg}`);
        }
      } catch (err) {
        failed++;
        logErr("charge_exception", `${item.bookingId}: ${err instanceof Error ? err.message : String(err)}`);
        // Leave the booking visible as payment_failed rather than silently
        // re-arming the timer: the idempotency key above means a manual
        // operator retry resolves to the same PaymentIntent.
        try {
          await stripePost(STRIPE_SECRET_KEY, `/customers/${item.customerId}`, {
            "metadata[gh_state]": "payment_failed",
          });
        } catch {
          /* ignore */
        }
      }
    }

    log("run_complete", { checked: candidates.length, due: due.length, charged, skipped, failed });
    res.status(200).json({
      requestId, ok: true,
      checked: candidates.length, due: due.length, charged, skipped, failed,
    });
  } catch (error: unknown) {
    logErr("unexpected", error);
    res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
