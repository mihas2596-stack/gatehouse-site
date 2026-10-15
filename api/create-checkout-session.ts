import { z } from "zod";

// Vercel serverless function — creates a Stripe Checkout Session in `setup`
// mode so the client can save a card ($0 today, no charge). The saved card is
// attached to the Stripe Customer and used later for off-session charges
// after the client approves the photo report ("approve, then pay").
//
// Env required: STRIPE_SECRET_KEY (live secret key, set in Vercel dashboard)

const STRIPE_API = "https://api.stripe.com/v1";

const ALLOWED_ORIGINS = [
  "https://gatehousehomecleaning.com",
  "https://www.gatehousehomecleaning.com",
  "http://localhost:8080",
];

// Minimal structural types so the function compiles without @vercel/node.
type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};
type Res = {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

const SessionRequestSchema = z.object({
  request_id: z.string().uuid().optional(),
  website: z.string().max(300).optional(),
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().min(1).max(255),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const corsHeaders = (origin: string | string[] | undefined): Record<string, string> => {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    headers["Access-Control-Allow-Origin"] = o;
  }
  return headers;
};

const siteBase = (origin: string | string[] | undefined): string => {
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (o && ALLOWED_ORIGINS.includes(o)) return o;
  return "https://www.gatehousehomecleaning.com";
};

type StripeError = { error?: { message?: string; type?: string; code?: string } };

async function stripePost(
  secretKey: string,
  path: string,
  params: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const body = new URLSearchParams(params);
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
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

const stripeErrMsg = (data: Record<string, unknown>): string => {
  const err = (data as StripeError).error;
  return err?.message ? `${err.type ?? "api_error"}: ${err.message}` : "unknown stripe error";
};

export default async function handler(req: Req, res: Res) {
  const origin = req.headers["origin"];
  if (origin && (typeof origin !== "string" || !ALLOWED_ORIGINS.includes(origin))) {
    res.status(403).json({ ok: false, error: "origin_not_allowed" });
    return;
  }
  const headers = corsHeaders(origin);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const requestId = Math.random().toString(36).slice(2);
  const json = (status: number, body: Record<string, unknown>) =>
    res.status(status).json({ requestId, ...body });
  const log = (step: string, info?: unknown) =>
    console.log(JSON.stringify({ requestId, step, info }));
  const logErr = (step: string, err: unknown) =>
    console.error(
      JSON.stringify({ requestId, step, error: err instanceof Error ? err.message : String(err) }),
    );

  try {
    const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
    if (!STRIPE_SECRET_KEY) {
      logErr("config", "STRIPE_SECRET_KEY is not configured");
      return json(500, { ok: false, error: "server_error" });
    }

    const body: unknown = req.body ?? null;
    if (!body || typeof body !== "object") {
      return json(400, { ok: false, errors: { form: "The request could not be read. Please try again." } });
    }
    if ((body as { website?: string }).website) {
      return json(400, { ok: false, error: "invalid_request" });
    }

    const parsed = SessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) {
        errors[k] = (v && v[0]) || "This field is not valid.";
      }
      return json(400, { ok: false, errors });
    }
    const email = parsed.data.email.trim();
    if (!EMAIL_RE.test(email)) {
      return json(400, { ok: false, errors: { email: "Enter a valid email, like name@example.com." } });
    }
    const name = parsed.data.name.trim();
    log("validate", "ok");

    // Step: reuse an existing customer when the email is already known,
    // so repeat visits don't create duplicates.
    let customerId: string | null = null;
    try {
      const found = await stripeGet(
        STRIPE_SECRET_KEY,
        `/customers/search?query=${encodeURIComponent(`email:'${email}'`)}&limit=1`,
      );
      if (!found.ok) {
        logErr("customer_search", `stripe ${found.status}: ${stripeErrMsg(found.data)}`);
        return json(500, { ok: false, error: "server_error" });
      }
      const list = (found.data["data"] as Array<{ id?: string }> | undefined) ?? [];
      if (list.length > 0 && typeof list[0]?.id === "string") {
        customerId = list[0].id as string;
        log("customer_search", "reused");
      }
    } catch (err) {
      logErr("customer_search", err);
      return json(500, { ok: false, error: "server_error" });
    }

    if (!customerId) {
      try {
        const created = await stripePost(STRIPE_SECRET_KEY, "/customers", {
          email,
          name,
          "metadata[source]": "gatehouse_save_card",
        });
        if (!created.ok || typeof created.data["id"] !== "string") {
          logErr("customer_create", `stripe ${created.status}: ${stripeErrMsg(created.data)}`);
          return json(500, { ok: false, error: "server_error" });
        }
        customerId = created.data["id"] as string;
        log("customer_create", "ok");
      } catch (err) {
        logErr("customer_create", err);
        return json(500, { ok: false, error: "server_error" });
      }
    }

    // Step: Checkout Session in setup mode — $0 today, card saved on the
    // customer for future off-session charges after photo-report approval.
    const base = siteBase(origin);
    try {
      const session = await stripePost(STRIPE_SECRET_KEY, "/checkout/sessions", {
        mode: "setup",
        customer: customerId,
        success_url: `${base}/save-card?saved=1`,
        cancel_url: `${base}/save-card?canceled=1`,
        "metadata[source]": "gatehouse_save_card",
      });
      if (!session.ok || typeof session.data["url"] !== "string") {
        logErr("checkout_session", `stripe ${session.status}: ${stripeErrMsg(session.data)}`);
        return json(500, { ok: false, error: "server_error" });
      }
      log("checkout_session", "ok");
      return json(200, { ok: true, url: session.data["url"] as string });
    } catch (err) {
      logErr("checkout_session", err);
      return json(500, { ok: false, error: "server_error" });
    }
  } catch (error: unknown) {
    console.error(JSON.stringify({ requestId, step: "unexpected", error: error instanceof Error ? error.message : String(error) }));
    return res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
