// Owner view API — read-only lists over the visit database.
//   GET /api/owner?view=list              → latest visits + photo counts
//   GET /api/owner?view=detail&visit_id=  → one visit: photos (signed URLs),
//                                           checklist, event history
// Auth: ADMIN_TOKEN (Bearer), same as booking-action. All WRITE actions
// stay in booking-action (confirm, set_cleaner, cleaner_link,
// return_report, send_report, charge) — this endpoint never mutates.

import { dbConfigured, dbSelect, storageSignDownload } from "./_db.js";
import { isOwnerAuth } from "./_owner_auth.js";

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
};
type Res = {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

const ALLOWED_ORIGINS = [
  "https://gatehousehomecleaning.com",
  "https://www.gatehousehomecleaning.com",
  "http://localhost:8080",
];

type VisitRow = Record<string, unknown> & { id: string };


// Annotate a visit row for the owner UI: never leak the token hash, and
// compute the cleaner-link state the panel displays (issued/active,
// expiry, whether the cleaner has opened it).
function annotateVisit(
  v: VisitRow,
  openedAt: string | null,
): Record<string, unknown> {
  // Strip the token hash AND the v2 issuance metadata: the panel only
  // needs to know whether the link is reusable, never the internals.
  const { cleaner_token_hash, cleaner_link_version, cleaner_link_issuance, ...rest } = v as Record<string, unknown> & {
    cleaner_token_hash?: unknown;
    cleaner_link_version?: unknown;
    cleaner_link_issuance?: unknown;
  };
  const expires = typeof v["cleaner_token_expires"] === "string" ? (v["cleaner_token_expires"] as string) : null;
  const active = Boolean(cleaner_token_hash) && (!expires || Date.parse(expires) > Date.now());
  return {
    ...rest,
    cleaner_link_issued: Boolean(cleaner_token_hash),
    cleaner_link_active: active,
    cleaner_link_expires: expires,
    cleaner_link_opened_at: openedAt,
    // Reusable = v2 deterministic link: the owner can re-fetch the exact
    // same URL after a refresh. Legacy random links are not reusable —
    // the panel offers an explicit upgrade instead of silently replacing.
    cleaner_link_reusable: Boolean(cleaner_token_hash) && cleaner_link_version === "v2" && typeof cleaner_link_issuance === "string" && cleaner_link_issuance.length > 0,
  };
}

// Payment failures are journaled by api/report.ts as payment_failed
// events (the visit row itself carries no payment-failed flag), so the
// list derives the Needs-attention signal from the journal, the same
// way it derives the cleaner-link opened state.
async function hasPaymentFailed(visitId: string): Promise<boolean> {
  const rows = await dbSelect<{ id: number }>(
    "gh_events",
    `visit_id=eq.${visitId}&event=eq.payment_failed&limit=1`,
  );
  return rows.length > 0;
}

export default async function handler(req: Req, res: Res) {
  const requestId = Math.random().toString(36).slice(2);
  const json = (status: number, body: Record<string, unknown>) =>
    res.status(status).json({ requestId, ...body });
  const origin = req.headers["origin"];
  if (origin && (typeof origin !== "string" || !ALLOWED_ORIGINS.includes(origin))) {
    return json(403, { ok: false, error: "origin_not_allowed" });
  }
  if (req.method !== "GET") return json(405, { ok: false, error: "method_not_allowed" });
  const ADMIN_TOKEN = process.env["ADMIN_TOKEN"];
  if (!ADMIN_TOKEN) return json(500, { ok: false, error: "server_error" });
  const authRaw = req.headers["authorization"];
  const auth = Array.isArray(authRaw) ? authRaw[0] : authRaw ?? "";
  if (!isOwnerAuth(auth, ADMIN_TOKEN, Math.floor(Date.now() / 1000))) return json(401, { ok: false, error: "unauthorized" });
  if (!dbConfigured()) return json(501, { ok: false, error: "db_not_configured" });

  try {
    const viewName = typeof req.query?.["view"] === "string" ? (req.query["view"] as string) : "list";
    if (viewName === "detail") {
      const visitId = typeof req.query?.["visit_id"] === "string" ? (req.query["visit_id"] as string) : "";
      if (!/^[0-9a-f-]{36}$/i.test(visitId)) return json(400, { ok: false, error: "invalid_visit" });
      const visits = await dbSelect<VisitRow>("gh_visits", `id=eq.${visitId}&limit=1`);
      const visit = visits[0];
      if (!visit) return json(404, { ok: false, error: "visit_not_found" });
      const paymentFailed = await hasPaymentFailed(visitId);
      const photos = await dbSelect<{ id: string; room: string; kind: string; note: string | null; storage_path: string; created_at: string }>(
        "gh_photos",
        `visit_id=eq.${visitId}&order=created_at.asc&limit=200`,
      );
      const photosWithUrls = await Promise.all(
        photos.map(async (ph) => ({
          id: ph.id,
          room: ph.room,
          kind: ph.kind,
          note: ph.note,
          created_at: ph.created_at,
          url: await storageSignDownload(ph.storage_path, 3600),
        })),
      );
      const events = await dbSelect(
        "gh_events",
        `visit_id=eq.${visitId}&order=created_at.desc&limit=100`,
      );
      const openedEv = (events as { event: string; created_at: string }[])
        .filter((e) => e.event === "cleaner_link_opened")
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
      const visitConfirmed = (events as { event: string }[])
        .some((e) => e.event === "visit_confirmed");
      // Confirmation-email status after the latest confirmation: the
      // owner panel shows it next to the Schedule block, with a resend
      // action when delivery failed. Event names only — no addresses.
      const confirmEmailEvents = (events as { event: string; created_at: string }[])
        .filter((e) => e.event === "confirmation_email_sent" || e.event === "confirmation_email_failed")
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return json(200, {
        ok: true,
        visit: {
          ...annotateVisit(visit, openedEv?.created_at ?? null),
          payment_failed: paymentFailed,
          visit_confirmed: visitConfirmed,
          confirmation_email: confirmEmailEvents[0]?.event === "confirmation_email_sent"
            ? "sent"
            : confirmEmailEvents[0]?.event === "confirmation_email_failed"
              ? "failed"
              : null,
        },
        photos: photosWithUrls,
        events,
      });
    }

    // list
    const visits = await dbSelect<VisitRow>(
      "gh_visits",
      "order=created_at.desc&limit=100",
    );
    const ids = visits.map((v) => v.id);
    const counts = new Map<string, number>();
    if (ids.length > 0) {
      const photos = await dbSelect<{ visit_id: string }>(
        "gh_photos",
        `visit_id=in.(${ids.join(",")})&limit=2000`,
      );
      for (const ph of photos) counts.set(ph.visit_id, (counts.get(ph.visit_id) ?? 0) + 1);
    }
    const opened = new Map<string, string>();
    if (ids.length > 0) {
      const opens = await dbSelect<{ visit_id: string; created_at: string }>(
        "gh_events",
        `visit_id=in.(${ids.join(",")})&event=eq.cleaner_link_opened&order=created_at.desc&limit=500`,
      );
      for (const o of opens) {
        if (!opened.has(o.visit_id)) opened.set(o.visit_id, o.created_at);
      }
    }
    const failed = new Set<string>();
    if (ids.length > 0) {
      const fails = await dbSelect<{ visit_id: string }>(
        "gh_events",
        `visit_id=in.(${ids.join(",")})&event=eq.payment_failed&limit=500`,
      );
      for (const f of fails) failed.add(f.visit_id);
    }
    // Confirmed visits (batched, like opened/failed): the "Needs review"
    // signal is a submitted report WITHOUT a confirmation event — row
    // status alone cannot tell, because submit overwrites it.
    const confirmed = new Set<string>();
    if (ids.length > 0) {
      const confs = await dbSelect<{ visit_id: string }>(
        "gh_events",
        `visit_id=in.(${ids.join(",")})&event=eq.visit_confirmed&limit=500`,
      );
      for (const c of confs) confirmed.add(c.visit_id);
    }
    return json(200, {
      ok: true,
      visits: visits.map((v) => ({
        ...annotateVisit(v, opened.get(v.id) ?? null),
        photo_count: counts.get(v.id) ?? 0,
        payment_failed: failed.has(v.id),
        visit_confirmed: confirmed.has(v.id),
      })),
    });
  } catch (err) {
    console.error(JSON.stringify({ requestId, step: "owner", error: err instanceof Error ? err.message : String(err) }));
    return json(500, { ok: false, error: "server_error" });
  }
}
