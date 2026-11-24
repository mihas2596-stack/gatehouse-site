import { createHash } from "node:crypto";
import { dbRpc } from "./_db.js";
import { clientVisitLink } from "./_booking_links.js";
import { cleanerLinkSecretCandidates, mintCleanerLinkV2 } from "./_cleaner_link.js";
import { linkMac, message, normalizePhone, same, validSignature, type Payload } from "./_sms.js";

type Req = { method?: string; url?: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type Res = { status(n: number): Res; end(body?: string): void; setHeader(k: string, v: string): void };
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const sidPattern = /^SM[0-9a-f]{32}$/i;
const terminalWithoutLink = new Set(["issue", "paid", "cancelled"]);
function binding(p: Payload) { return p.audience === "cleaner" ? p.hash : p.email; }
function cleanerToken(p: Payload) {
  if (!p.hash || !p.issuance || !(Date.parse(p.expiry) > Date.now())) return null;
  for (const secret of cleanerLinkSecretCandidates()) {
    const token = mintCleanerLinkV2(secret, p.visit, p.issuance);
    if (same(createHash("sha256").update(token).digest("hex"), p.hash)) return token;
  }
  return null;
}
async function finish(job: string, result: string, code: string | null = null, provider_sid: string | null = null) {
  if (!await dbRpc("gh_sms_finish", { job, result, provider_sid, code })) throw new Error("queue_unavailable");
}
async function dispatch(origin: string) {
  const { TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: token, TWILIO_MESSAGING_SERVICE_SID: service,
    SMS_LINK_SECRET: secret, SMS_MODE: mode } = process.env;
  if (mode !== "live" && mode !== "pilot") return;
  if (!account || !token || !service || !secret || !(process.env.BOOKING_LINK_SECRET || process.env.STRIPE_SECRET_KEY)) throw new Error("configuration");
  const auth = "Basic " + Buffer.from(account + ":" + token).toString("base64");
  for (let i = 0; i < 5; i++) {
    const j = await dbRpc<{ id?: string; phone: string }>("gh_sms_claim", {});
    if (!j) throw new Error("queue_unavailable");
    if (!j.id) break;
    if (mode === "pilot" && j.phone !== normalizePhone(process.env.SMS_PILOT_PHONE)) {
      await finish(j.id, "suppressed", "pilot_only"); continue;
    }
    // NANP also includes Canada and the Caribbean. Only send after a US Lookup result.
    let us: boolean;
    try {
      const lookup = await fetch("https://lookups.twilio.com/v2/PhoneNumbers/" + encodeURIComponent(j.phone), {
        headers: { Authorization: auth }, signal: AbortSignal.timeout(4000)
      });
      if (!lookup.ok) { await finish(j.id, lookup.status === 404 ? "failed" : "retry", "lookup_" + lookup.status); continue; }
      const data = await lookup.json();
      us = data.valid === true && data.country_code === "US" && data.phone_number === j.phone;
    } catch { await finish(j.id, "retry", "lookup_unavailable"); continue; }
    if (!us) { await finish(j.id, "suppressed", "not_us"); continue; }
    const p = await dbRpc<Payload>("gh_sms_payload", { job: j.id });
    if (!p) { await finish(j.id, "retry", "database_unavailable"); continue; }
    if (!p.id) { await finish(j.id, "obsolete", "stale"); continue; }
    if (mode === "live" && p.test) { await finish(j.id, "suppressed", "test_visit"); continue; }
    let link = "";
    if (!terminalWithoutLink.has(p.kind)) {
      if (!binding(p) || (p.audience === "cleaner" && !cleanerToken(p))) {
        await finish(j.id, "retry", "link_unavailable"); continue;
      }
      const until = String(Math.floor(Date.now() / 1000) + 86400);
      link = origin + "/api/visit?sms=1&open=" + j.id + "&until=" + until + "&sig=" + linkMac(j.id, until, binding(p), secret);
    }
    let response: Response;
    try {
      response = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + account + "/Messages.json", {
        method: "POST", headers: { Authorization: auth }, body: new URLSearchParams({
          MessagingServiceSid: service, To: p.phone, Body: message(p, link), StatusCallback: origin + "/api/visit?sms=1&status=" + j.id,
        }), signal: AbortSignal.timeout(5000)
      });
    } catch { await finish(j.id, "unknown", "transport"); continue; }
    const data = await response.json().catch(() => ({}));
    if (response.ok && sidPattern.test(data.sid)) { await finish(j.id, "accepted", null, data.sid); continue; }
    const code = typeof data.code === "number" ? String(data.code) : "http_" + response.status;
    if (["21610", "30630"].includes(code)) {
      if (!await dbRpc("gh_sms_keyword", { provider_sid: "reject:" + j.id, number: p.phone, command: "STOP" })) throw new Error("queue_unavailable");
    }
    const result = response.status === 429 ? "retry" : response.ok || response.status >= 500 ? "unknown" : "failed";
    await finish(j.id, result, code);
  }
}
function form(raw: unknown): Record<string, string> | null {
  const entries = typeof raw === "string" ? Array.from(new URLSearchParams(raw)) : raw && typeof raw === "object" ? Object.entries(raw) : [];
  const fields: Record<string, string> = Object.create(null);
  for (const [key, value] of entries) {
    if (typeof value !== "string" || key in fields) return null;
    fields[key] = value;
  }
  return fields;
}
export default async function handler(req: Req, res: Res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const end = (n: number) => res.status(n).end();
  try {
    const origin = process.env.SMS_PUBLIC_ORIGIN || "https://www.gatehousehomecleaning.com";
    const path = req.url ?? "";
    const url = new URL(path, origin);
    if (!origin.startsWith("https://") || url.origin !== origin || url.pathname !== "/api/visit" || url.searchParams.get("sms") !== "1") return end(400);
    const job = url.searchParams.get("open");
    if (req.method === "GET" && job) {
      const until = url.searchParams.get("until") ?? "", sig = url.searchParams.get("sig") ?? "", secret = process.env.SMS_LINK_SECRET;
      if (!secret || !uuid.test(job) || !/^\d{10}$/.test(until) || Number(until) <= Date.now() / 1000) return end(410);
      const p = await dbRpc<Payload>("gh_sms_link", { job });
      if (!p || !binding(p) || !same(linkMac(job, until, binding(p), secret), sig)) return end(410);
      let location: string;
      if (p.audience === "cleaner") {
        const ct = cleanerToken(p); if (!ct) return end(410);
        location = "/cleaner?ct=" + ct;
      } else {
        const key = process.env.BOOKING_LINK_SECRET || process.env.STRIPE_SECRET_KEY;
        if (!key) return end(503);
        const u = new URL(clientVisitLink(key, { bid: p.booking, email: p.email }));
        location = u.pathname + u.search + (["complete", "payment_reminder"].includes(p.kind) ? "#report" : "");
      }
      res.setHeader("Location", location); return end(303);
    }
    if (req.method === "GET" && url.search === "?sms=1") {
      const secret = process.env.SMS_CRON_SECRET || process.env.CRON_SECRET;
      if (!secret || !same(String(req.headers.authorization ?? ""), "Bearer " + secret)) return end(403);
      await dispatch(origin); return end(200);
    }
    if (req.method !== "POST") return end(405);
    const fields = form(req.body);
    if (!String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded") || !fields ||
      !validSignature(origin + path, fields, process.env.TWILIO_AUTH_TOKEN ?? "", String(req.headers["x-twilio-signature"] ?? "")) ||
      fields.AccountSid !== process.env.TWILIO_ACCOUNT_SID || !sidPattern.test(fields.MessageSid ?? "")) return end(403);
    const statusJob = url.searchParams.get("status");
    if (statusJob && uuid.test(statusJob)) {
      if (!["queued", "sending", "sent", "delivered", "undelivered", "failed"].includes(fields.MessageStatus)) return end(204);
      const stored = await dbRpc("gh_sms_delivery", {
        job: statusJob, provider_sid: fields.MessageSid, delivery_status: fields.MessageStatus,
        code: /^\d{1,8}$/.test(fields.ErrorCode ?? "") ? fields.ErrorCode : null
      });
      return end(stored ? 204 : 503);
    }
    if (url.search !== "?sms=1" || fields.To !== process.env.TWILIO_SMS_NUMBER || !process.env.TWILIO_SMS_NUMBER) return end(403);
    const word = (fields.OptOutType || fields.Body || "").trim().toUpperCase();
    const command = ["STOP", "STOPALL", "END", "QUIT", "UNSUBSCRIBE", "CANCEL", "REVOKE", "OPTOUT"].includes(word) ? "STOP" :
      ["START", "UNSTOP"].includes(word) ? "START" : word === "HELP" ? "HELP" : null;
    const number = normalizePhone(fields.From);
    if (command && number) {
      // A delayed START must never lift a more recent STOP. Twilio's message
      // resource provides the provider timestamp; fail closed until verified.
      let eventTime: string | null = null;
      if (command === "START") {
        const credentials = Buffer.from(fields.AccountSid + ":" + process.env.TWILIO_AUTH_TOKEN).toString("base64");
        const received = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + fields.AccountSid + "/Messages/" + fields.MessageSid + ".json", {
          headers: { Authorization: "Basic " + credentials }, signal: AbortSignal.timeout(4000),
        });
        if (!received.ok) return end(503);
        const record = await received.json();
        if (record.direction !== "inbound" || record.from !== number || record.to !== fields.To ||
          record.sid !== fields.MessageSid || !Number.isFinite(Date.parse(record.date_created))) return end(503);
        eventTime = new Date(record.date_created).toISOString();
      }
      const stored = await dbRpc("gh_sms_keyword", { provider_sid: fields.MessageSid, number, command, event_time: eventTime });
      if (!stored) return end(503);
    }
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).end("<Response/>");
  } catch { return end(503); }
}
