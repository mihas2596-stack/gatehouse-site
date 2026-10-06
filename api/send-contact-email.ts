import { z } from "zod";
import { SERVICE_ZIPS, earliestServiceDate, validServiceDate } from "../src/config/service-area";

// Vercel serverless function — replaces the Lovable Cloud edge function
// "send-contact-email". Sends via Resend's public API directly; no Lovable
// connector gateway, no Supabase.
//
// Env required: RESEND_API_KEY

const RESEND_API = "https://api.resend.com/emails";
const OWNER_EMAIL = "nikolajmihasenok@gmail.com";
const FROM_OWNER = "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>";
const FROM_AUTO = "Nick at Gatehouse Home Cleaning <info@gatehousehomecleaning.com>";
const REPLY_TO_AUTO = "hello@gatehousehomecleaning.com";

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

const ContactSchema = z.object({
  request_id: z.string().uuid().optional(),
  website: z.string().max(300).optional(),
  name: z.string().trim().min(1).max(255),
  phone: z.string().max(50).optional().or(z.literal("")),
  email: z.string().trim().max(255).optional().or(z.literal("")),
  service: z.string().max(255).optional().or(z.literal("")),
  date: z.string().max(50).optional().or(z.literal("")),
  time: z.string().max(50).optional().or(z.literal("")),
  message: z.string().max(5000).optional().or(z.literal("")),
  founding: z.boolean().optional(),
  bedrooms: z.string().max(20).optional().or(z.literal("")),
  bathrooms: z.string().max(20).optional().or(z.literal("")),
  zip: z.string().max(20).optional().or(z.literal("")),
  address: z.string().max(200).optional().or(z.literal("")),
  price: z.string().max(20).optional().or(z.literal("")),
  attribution: z.object({
    utm_source: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/).optional(),
    utm_medium: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/).optional(),
    utm_campaign: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/).optional(),
    utm_content: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/).optional(),
  }).optional(),
  source: z.enum(["quote", "contact"]).default("contact"),
  terms_consent: z.boolean().optional(),
  photo_consent: z.boolean().optional(),
  sms_consent: z.boolean().optional(),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Booking-specific checks (quote form). Plain-English, field-keyed messages.
const bookingErrors = (d: z.infer<typeof ContactSchema>): Record<string, string> => {
  const errors: Record<string, string> = {};
  if (!d.email || !EMAIL_RE.test(d.email.trim())) errors.email = "Enter a valid email, like name@example.com.";
  let digits = (d.phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) errors.phone = "Enter a 10-digit US phone number.";
  if (!SERVICE_ZIPS.has((d.zip || "").trim())) errors.zip = "Enter a ZIP in our North Atlanta service area.";
  if (!d.address || d.address.trim().length < 5) errors.address = "Enter your street address.";
  if (!d.date || !validServiceDate(d.date) || d.date < earliestServiceDate()) errors.date = "Choose a valid preferred date at least 3 days ahead.";
  if (d.terms_consent !== true) errors.terms_consent = "Please agree to the Terms of Service and Privacy Policy.";
  if (d.photo_consent !== true) errors.photo_consent = "Please agree to the photo report.";
  return errors;
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const firstNameOf = (raw: unknown): string => {
  if (!raw) return "there";
  const s = String(raw).trim();
  if (s.length < 2) return "there";
  if (s.includes("@")) return "there";
  const first = s.split(/\s+/)[0];
  if (first.length < 2) return "there";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
};

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

async function sendEmail(apiKey: string, payload: Record<string, unknown>, idempotencyKey?: string) {
  const response = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  let data: { name?: string; message?: string } = {};
  try {
    data = await response.json();
  } catch {
    /* ignore */
  }
  return { ok: response.ok, status: response.status, data };
}

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
    const RESEND_API_KEY = process.env["RESEND_API_KEY"];
    if (!RESEND_API_KEY) {
      logErr("config", "RESEND_API_KEY is not configured");
      return json(500, { ok: false, error: "server_error" });
    }

    // Step: parse (Vercel pre-parses JSON bodies when content-type is application/json)
    const body: unknown = req.body ?? null;
    if (!body || typeof body !== "object") {
      logErr("parse", "empty or non-object body");
      return json(400, { ok: false, errors: { form: "The request could not be read. Please try again." } });
    }
    log("parse", "ok");

    // Step: validate
    const parsed = ContactSchema.safeParse(body);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) {
        errors[k] = (v && v[0]) || "This field is not valid.";
      }
      log("validate", { fields: Object.keys(errors) });
      return json(400, { ok: false, errors });
    }
    {
      const errors: Record<string, string> =
        parsed.data.source === "quote"
          ? bookingErrors(parsed.data)
          : {
              ...(!parsed.data.email || !EMAIL_RE.test(parsed.data.email) ? { email: "Enter a valid email, like name@example.com." } : {}),
              ...(!parsed.data.message?.trim() ? { message: "Enter your question." } : {}),
            };
      if (Object.keys(errors).length) {
        log("validate", { fields: Object.keys(errors) });
        return json(400, { ok: false, errors });
      }
    }
    if (parsed.data.website) return json(400, { ok: false, error: "invalid_request" });
    log("validate", "ok");

    const {
      name,
      phone,
      email,
      service,
      date,
      time,
      message,
      founding,
      bedrooms,
      bathrooms,
      zip,
      address,
      price,
    } = parsed.data;

    const isQuote = parsed.data.source === "quote";
    const row = (label: string, value: string) =>
      `<tr><td style="padding: 8px 0; font-weight: bold; color: #555;">${label}:</td><td style="padding: 8px 0;">${value}</td></tr>`;

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background:${founding ? "#FFF4E5" : "#F4F4F4"};border-left:6px solid ${founding ? "#D4855A" : "#999"};padding:14px 18px;margin-bottom:18px;border-radius:6px;font-size:16px;font-weight:bold;color:${founding ? "#8B4513" : "#444"};">
          ${isQuote ? (founding ? "FOUNDING CLIENT REQUEST — Verify offer eligibility before confirming" : "CLEANING REQUEST — Verify estimate before confirming") : "GENERAL INQUIRY"}
        </div>
        <h2 style="color: #8B5E3C; border-bottom: 2px solid #D4A853; padding-bottom: 10px;">
          ${isQuote ? "New Cleaning Request" : "New General Inquiry"} from ${escapeHtml(name)}
        </h2>
        <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
          <tr><td style="padding: 8px 0; font-weight: bold; color: #555;">Name:</td><td style="padding: 8px 0;">${escapeHtml(name)}</td></tr>
          ${phone ? row("Phone", escapeHtml(phone)) : ""}
          ${email ? row("Email", escapeHtml(email)) : ""}
          ${service ? row("Service Type", escapeHtml(service)) : ""}
          ${zip ? row("ZIP", escapeHtml(zip)) : ""}
          ${address ? row("Street address", escapeHtml(address)) : ""}
          ${bedrooms ? row("Bedrooms", escapeHtml(bedrooms)) : ""}
          ${bathrooms ? row("Bathrooms", escapeHtml(bathrooms)) : ""}
          ${price ? row("Client-side estimate — verify", `$${escapeHtml(price)}`) : ""}
          ${date ? row("Preferred Date", escapeHtml(date)) : ""}
          ${time ? row("Preferred Time", escapeHtml(time)) : ""}
          ${message ? row("Notes from client", escapeHtml(message).replace(/\n/g, "<br>")) : ""}
${isQuote ? row("First-clean discount requested", founding ? "YES" : "NO") : ""}
          ${Object.entries(parsed.data.attribution || {}).map(([key, value]) => value ? row(key, escapeHtml(value)) : "").join("")}
        </table>
        <p style="margin-top: 24px; font-size: 12px; color: #999;">Sent from Gatehouse Home Cleaning website contact form</p>
      </div>
    `;

    // Step: owner notification (no database table exists; the owner email is the record)
    try {
      const sent = await sendEmail(RESEND_API_KEY, {
        from: FROM_OWNER,
        to: [OWNER_EMAIL],
        reply_to: email || undefined,
        subject: `${isQuote ? "New quote request" : "New general inquiry"} — ${name}${zip ? `, ${zip}` : ""}`,
        html: htmlContent,
      }, parsed.data.request_id ? `owner/${parsed.data.request_id}` : undefined);
      if (!sent.ok) {
        logErr("owner_notification", `provider ${sent.status}: ${sent.data?.name ?? ""} ${sent.data?.message ?? ""}`);
        return json(500, { ok: false, error: "server_error" });
      }
      log("owner_notification", "sent");
    } catch (err) {
      logErr("owner_notification", err);
      return json(500, { ok: false, error: "server_error" });
    }

    // Step: client autoresponse (errors surface intentionally)
    const emailValid = !!email && EMAIL_RE.test(email);
    let customerEmailSent = false;
    if (emailValid) {
      try {
        const firstName = firstNameOf(name);

        // Parse "Professionally cleaned in last 3 months: Yes/No" from the message summary.
        const cleanedMatch = /Professionally cleaned in last 3 months:\s*(Yes|No)/i.exec(message || "");
        const cleanedRecently = cleanedMatch ? cleanedMatch[1].toLowerCase() === "yes" : true;

        // Home details and service label for the customer.
        const baths = bathrooms ? String(bathrooms).replace(/\.0$/, "") : "";
        const homeDetails = `${bedrooms || "?"} bed / ${baths || "?"} bath`;
        const firstVisitDeep = service === "Standard" && !cleanedRecently;
        const serviceLabel = firstVisitDeep ? "First visit: Deep clean" : (service || "Standard");
        const deepPara = firstVisitDeep
          ? `\nBecause the home hasn't been professionally cleaned in the last 3 months, the first visit is a deep clean. Regular visits after that cost less.\n`
          : "";
        const priceDisplay = price ? `$${price}` : "—";

        const textBody = isQuote ? `Hi ${firstName},

Thanks for reaching out. Here's what you sent:

${homeDetails} · ZIP ${zip || ""}

Service: ${serviceLabel}

Your estimate: ${priceDisplay} per visit.
${deepPara}
What happens next:

I'll confirm your estimate, date and arrival window by the end of the next business day. Your request is not a confirmed booking yet. No payment is taken by this form.

How payment works:

After the clean, you get a photo report of every room. We charge your card only after you approve it. No response within 24 hours = approved.

If something on our checklist gets missed, we come back within 72 hours and fix it at no charge.

Nick

Gatehouse Home Cleaning

hello@gatehousehomecleaning.com` : `Hi ${firstName},

Thanks for your question. I received your message and will reply within one business day. This is a general inquiry, not a booking request.

Nick
Gatehouse Home Cleaning
hello@gatehousehomecleaning.com`;

        const auto = await sendEmail(RESEND_API_KEY, {
          from: FROM_AUTO,
          to: [email],
          reply_to: REPLY_TO_AUTO,
          subject: isQuote ? "Got your cleaning request — next steps" : "Got your question — I’ll reply within one business day",
          text: textBody,
        }, parsed.data.request_id ? `customer/${parsed.data.request_id}` : undefined);
        if (auto.ok) {
          customerEmailSent = true;
          log("customer_confirmation", "sent");
        } else {
          logErr("customer_confirmation", `provider ${auto.status}: ${auto.data.name ?? ""} ${auto.data.message ?? ""}`);
        }
      } catch (err) {
        logErr("customer_confirmation", err);
      }
    } else {
      log("customer_confirmation", "skipped_no_email");
    }

    return json(200, { ok: true, success: true, customerEmailSent });
  } catch (error: unknown) {
    logErr("unexpected", error);
    return json(500, { ok: false, error: "server_error" });
  }
}
