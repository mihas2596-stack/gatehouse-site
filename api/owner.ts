// Owner view API — read-only lists over the visit database.
//   GET /api/owner?view=list              → latest visits + photo counts
//   GET /api/owner?view=detail&visit_id=  → one visit: photos (signed URLs),
//                                           checklist, event history
//   GET /api/owner?view=roster            → the cleaner directory
// Auth: ADMIN_TOKEN (Bearer), same as booking-action. All WRITE actions
// stay in booking-action (confirm, set_cleaner, cleaner_link,
// return_report, send_report, charge) — this endpoint never mutates.

import { dbConfigured, dbSelect, storageSignDownload } from "./_db.js";
import { isOwnerAuth } from "./_owner_auth.js";
import { paymentBasis } from "./_payment_basis.js";
import { confirmedDateOf, effectiveVisitDate, autoChargeDeadlineMs } from "./_visit_date.js";
import { decryptEntrySecret, loadAccess } from "./_visit_access.js";
import { loadClientPhone, normalizeClientPhone } from "./_client_contact.js";

// O3: a payment failure is current only if no later success supersedes
// it and the visit is not paid. Any historical payment_failed event used
// to light up "Payment failed" forever, even after a successful retry.
type JournalEvent = { event: string; detail: Record<string, unknown> | null; created_at: string };
function currentPaymentFailed(events: JournalEvent[], rowStatus: unknown): boolean {
  if (rowStatus === "paid") return false;
  let failedAt = "";
  let succeededAt = "";
  for (const e of events) {
    if (e.event === "payment_failed" && e.created_at > failedAt) failedAt = e.created_at;
    if (e.event === "payment_succeeded" && e.created_at > succeededAt) succeededAt = e.created_at;
  }
  return Boolean(failedAt && (!succeededAt || succeededAt < failedAt));
}

// O5: the opened signal belongs to the CURRENT link issuance, not to the
// whole visit history. A new link does not inherit the old link's open;
// opening is not acceptance of the work. Legacy links carry no issuance,
// so they keep the old latest-open behavior.
function openedAtForIssuance(
  events: { event: string; detail: Record<string, unknown> | null; created_at: string }[],
  issuance: unknown,
): string | null {
  const opens = events
    .filter((e) => e.event === "cleaner_link_opened")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  if (typeof issuance === "string" && issuance.length > 0) {
    return opens.find((e) => e.detail?.["issuance"] === issuance)?.created_at ?? null;
  }
  return opens[0]?.created_at ?? null;
}

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
  // Also strip the legacy plaintext access_notes column: entry
  // details live only in gh_visit_access (the detail view's `entry`
  // object), and the old column must not keep travelling in
  // list/detail payloads as a second, unencrypted channel.
  const { cleaner_token_hash, cleaner_link_version, cleaner_link_issuance, access_notes: _legacyAccessNotes, ...rest } = v as Record<string, unknown> & {
    cleaner_token_hash?: unknown;
    cleaner_link_version?: unknown;
    cleaner_link_issuance?: unknown;
    access_notes?: unknown;
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

// (Removed: hasPaymentFailed treated any historical payment_failed event
// as a current failure. Detail and list now compute it from the journal
// with currentPaymentFailed, which weighs a later payment_succeeded and
// a paid row status. See O3.)

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
    if (viewName === "roster") {
      // The cleaner directory: only owner-selected people, never the
      // raw Indeed applicant pool. No client data lives here.
      const cleaners = await dbSelect(
        "gh_cleaners",
        "order=name.asc&limit=200",
      );
      return json(200, { ok: true, cleaners });
    }
    if (viewName === "detail") {
      const visitId = typeof req.query?.["visit_id"] === "string" ? (req.query["visit_id"] as string) : "";
      if (!/^[0-9a-f-]{36}$/i.test(visitId)) return json(400, { ok: false, error: "invalid_visit" });
      const visits = await dbSelect<VisitRow>("gh_visits", `id=eq.${visitId}&limit=1`);
      const visit = visits[0];
      if (!visit) return json(404, { ok: false, error: "visit_not_found" });
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
      const journalEvents = events as JournalEvent[];
      // O5: opened binds to the row's current issuance, not to history.
      const openedAt = openedAtForIssuance(journalEvents, visit["cleaner_link_issuance"]);
      // O3: current failure only (a later success or a paid row clears it).
      const paymentFailed = currentPaymentFailed(journalEvents, visit["status"]);
      // O4: the Charge button's availability comes from the server's own
      // payment-basis rule — the same rule the charge action enforces —
      // so the panel never offers a retry the server would refuse.
      const canCharge = paymentBasis(
        {
          reportSentAt: typeof visit["report_sent_at"] === "string" ? (visit["report_sent_at"] as string) : null,
          events: journalEvents,
          issueOpenRow: typeof visit["issue_open"] === "boolean" ? (visit["issue_open"] as boolean) : null,
          issueEverRow: typeof visit["issue_ever"] === "boolean" ? (visit["issue_ever"] as boolean) : null,
          // P02: same bounced input as the charge action — the panel
          // must not offer a timer charge the server would refuse.
          bounced: typeof visit["report_bounced"] === "boolean" ? (visit["report_bounced"] as boolean) : null,
          // Payment-date gate (B): the panel must not offer a charge
          // for a visit that has not happened yet.
          visitDate: effectiveVisitDate(confirmedDateOf(journalEvents), typeof visit["visit_date"] === "string" ? (visit["visit_date"] as string) : null),
          // Waive durability (fix round 2): the panel must not offer
          // a charge for a waived visit, even one whose waive fell
          // out of the journal window.
          chargeWaivedRow: typeof visit["charge_waived"] === "boolean" ? (visit["charge_waived"] as boolean) : null,
          // Fix round 2: a refunded visit has no basis — the panel
          // must not offer a charge for a visit whose payment was
          // returned.
          status: typeof visit["status"] === "string" ? (visit["status"] as string) : null,
        },
        Date.now(),
      ) !== null;
      const visitConfirmed = (events as { event: string }[])
        .some((e) => e.event === "visit_confirmed");
      // V2: a pending client proposal (date_proposed without alt_dates,
      // newer than the latest confirmation) is visible in the Schedule
      // block after reload; the confirmed date stays the agreement.
      const byTimeDesc = [...journalEvents].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const latestProposed = byTimeDesc.find((e) => e.event === "date_proposed");
      const latestConfirm = byTimeDesc.find((e) => e.event === "visit_confirmed");
      const proposedPending = Boolean(latestProposed
        && typeof (latestProposed.detail as Record<string, unknown> | null)?.["alt_dates"] !== "string"
        && (!latestConfirm || latestConfirm.created_at < latestProposed.created_at));
      const proposedDate = proposedPending
        ? (typeof (latestProposed?.detail as Record<string, unknown> | null)?.["date"] === "string"
            ? (latestProposed?.detail as Record<string, unknown>)["date"] as string
            : "")
        : "";
      const requestApproved = (events as { event: string }[])
        .some((e) => e.event === "request_approved");
      // Report-email status after the latest publish (manual or
      // automatic): the owner panel shows it next to the Report block,
      // with a re-send action when delivery failed.
      const reportEmailEvents = (events as { event: string; detail: { email_sent?: boolean } | null; created_at: string }[])
        .filter((e) => e.event === "report_sent")
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      // Confirmation-email status after the latest confirmation: the
      // owner panel shows it next to the Schedule block, with a resend
      // action when delivery failed. Event names only — no addresses.
      const confirmEmailEvents = (events as { event: string; created_at: string }[])
        .filter((e) => e.event === "confirmation_email_sent" || e.event === "confirmation_email_failed")
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      // Owner-notification status after the latest request: the owner
      // panel shows it next to the request, with a resend action when
      // delivery failed. Event names only — no addresses.
      const ownerNotifEvents = (events as { event: string; created_at: string }[])
        .filter((e) => e.event === "owner_notification" || e.event === "owner_notification_failed")
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const entryRow = await loadAccess(visitId);
      const entryReminderSent = journalEvents.some((e) => e.event === "entry_reminder_sent");
      return json(200, {
        ok: true,
        visit: {
          ...annotateVisit(visit, openedAt),
          client_phone: await loadClientPhone(visitId),
          entry_choice: {
            method: visit["entry_method"] ?? null,
            detail: visit["entry_detail"] ?? null,
            notes: visit["entry_notes"] ?? null,
          },
          entry_agreed: Boolean(entryRow?.entry_method)
            || visit["entry_method"] === "home"
            || visit["entry_method"] === "other_person",
          entry: entryRow ? {
            method: entryRow.entry_method,
            note: entryRow.entry_note ?? "",
            has_secret: Boolean(entryRow.entry_secret),
            // Owner-only detail view: the operator may need the secret
            // to coordinate when the cleaner cannot see it. Never in
            // the list view, never in emails, never in events.
            secret: decryptEntrySecret(entryRow.entry_secret),
            assigned_cleaner_id: entryRow.assigned_cleaner_id,
            expires_at: entryRow.expires_at,
            reminder_sent: entryReminderSent,
          } : null,
          payment_failed: paymentFailed,
          can_charge: canCharge,
          visit_confirmed: visitConfirmed,
          // A2: the journal card signal (same as the list view) — the
          // detail "Card:" line must read the card state, not the
          // payment lifecycle state.
          card_confirmed: journalEvents.some((e) => e.event === "card_confirmed"),
          proposed_date: proposedDate,
          proposed_pending: proposedPending,
          request_approved: requestApproved,
          report_email: reportEmailEvents.length === 0
            ? null
            : reportEmailEvents[0]?.detail?.email_sent === true
              ? "sent"
              : "failed",
          confirmation_email: confirmEmailEvents[0]?.event === "confirmation_email_sent"
            ? "sent"
            : confirmEmailEvents[0]?.event === "confirmation_email_failed"
              ? "failed"
              : null,
          owner_notification: ownerNotifEvents[0]?.event === "owner_notification"
            ? "sent"
            : ownerNotifEvents[0]?.event === "owner_notification_failed"
              ? "failed"
              : null,
        },
        photos: photosWithUrls,
        events,
      });
    }

    // list
    const offsetRaw = typeof req.query?.offset === "string" ? req.query.offset : "0";
    const offset = /^\d{1,7}$/.test(offsetRaw) ? Number(offsetRaw) : 0;
    const page = await dbSelect<VisitRow>("gh_visits", `order=created_at.desc,id.desc&offset=${offset}&limit=101`);
    const visits = page.slice(0, 100);
    const ids = visits.map((v) => v.id);
    const counts = new Map<string, number>();
    if (ids.length > 0) {
      const photos = await dbSelect<{ visit_id: string }>(
        "gh_photos",
        `visit_id=in.(${ids.join(",")})&limit=2000`,
      );
      for (const ph of photos) counts.set(ph.visit_id, (counts.get(ph.visit_id) ?? 0) + 1);
    }
    // O5 (list): opened binds to each row's current issuance. The query
    // returns desc, so the first matching open per visit is its latest.
    const opened = new Map<string, string>();
    if (ids.length > 0) {
      const opens = await dbSelect<{ visit_id: string; detail: Record<string, unknown> | null; created_at: string }>(
        "gh_events",
        `visit_id=in.(${ids.join(",")})&event=eq.cleaner_link_opened&order=created_at.desc&limit=500`,
      );
      const issuanceByVisit = new Map(visits.map((v) => [v.id, v["cleaner_link_issuance"]]));
      for (const o of opens) {
        if (opened.has(o.visit_id)) continue;
        const issuance = issuanceByVisit.get(o.visit_id);
        if (typeof issuance === "string" && issuance.length > 0 && o.detail?.["issuance"] !== issuance) continue;
        opened.set(o.visit_id, o.created_at);
      }
    }
    // O3 (list): a failure counts only until a later success or payment.
    const failed = new Set<string>();
    if (ids.length > 0) {
      const fails = await dbSelect<{ visit_id: string; created_at: string }>(
        "gh_events",
        `visit_id=in.(${ids.join(",")})&event=eq.payment_failed&order=created_at.desc&limit=500`,
      );
      const successes = await dbSelect<{ visit_id: string; created_at: string }>(
        "gh_events",
        `visit_id=in.(${ids.join(",")})&event=eq.payment_succeeded&order=created_at.desc&limit=500`,
      );
      const succeededAt = new Map<string, string>();
      for (const s of successes) {
        if (!succeededAt.has(s.visit_id)) succeededAt.set(s.visit_id, s.created_at);
      }
      const statusByVisit = new Map(visits.map((v) => [v.id, v["status"]]));
      for (const f of fails) {
        if (failed.has(f.visit_id)) continue;
        const sAt = succeededAt.get(f.visit_id);
        if (statusByVisit.get(f.visit_id) === "paid") continue;
        if (sAt && sAt >= f.created_at) continue;
        failed.add(f.visit_id);
      }
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
    const entryAgreed = new Set<string>();
    if (ids.length > 0) {
      const accs = await dbSelect<{ visit_id: string; entry_method: string | null }>(
        "gh_visit_access",
        `visit_id=in.(${ids.join(",")})&limit=200`,
      );
      for (const a of accs) if (a.entry_method) entryAgreed.add(a.visit_id);
      // A meeting choice needs no secret: the quote-time row method
      // settles access on its own (arrange_before without a saved
      // secret does not — the owner still has to chase the details).
      for (const v of visits) {
        const m = v["entry_method"];
        if (m === "home" || m === "other_person") entryAgreed.add(v.id);
      }
    }
    const approved = new Set<string>();
    if (ids.length > 0) {
      const apprs = await dbSelect<{ visit_id: string }>(
        "gh_events",
        `visit_id=in.(${ids.join(",")})&event=eq.request_approved&limit=500`,
      );
      for (const a of apprs) approved.add(a.visit_id);
    }
    // C3 (list): card signal from the journal, batched like the other
    // row signals — one query, no per-row Stripe call. The charge path
    // itself prefers the latest `card_confirmed` event's payment method,
    // so this is the same fact the server would charge with.
    // LIMIT: `delete_card` detaches at Stripe and clears Stripe metadata
    // without writing a journal event, so a detached card still reads
    // "Card ready" here. Live card state exists only in Stripe customer
    // metadata (`gh_payment_method`), which the list cannot read without
    // one Stripe call per row (N+1). The detail view's live `status`
    // check stays the authority on the card; this badge is the
    // journal's view, not Stripe's.
    const cardConfirmed = new Set<string>();
    if (ids.length > 0) {
      const cards = await dbSelect<{ visit_id: string }>(
        "gh_events",
        `visit_id=in.(${ids.join(",")})&event=eq.card_confirmed&limit=500`,
      );
      for (const c of cards) cardConfirmed.add(c.visit_id);
    }
    // TASK 1 (fix6): open-issue detail for the "Open issues" block —
    // latest issue_opened (opened_at + the client's words) and latest
    // issue_decision per visit, batched like the other row signals.
    // The list filters by the row's issue_open flag; these fields only
    // describe the current issue for those visits.
    const issueOpened = new Map<string, { opened_at: string; reason: string; room: string }>();
    const issueDecisions = new Map<string, { decision: string; resolution: string; decided_at: string }>();
    if (ids.length > 0) {
      const openedEv = await dbSelect<{ visit_id: string; detail: Record<string, unknown> | null; created_at: string }>(
        "gh_events",
        `visit_id=in.(${ids.join(",")})&event=eq.issue_opened&order=created_at.desc&limit=500`,
      );
      for (const o of openedEv) {
        if (issueOpened.has(o.visit_id)) continue;
        issueOpened.set(o.visit_id, {
          opened_at: o.created_at,
          reason: typeof o.detail?.["reason"] === "string" ? (o.detail["reason"] as string) : "",
          room: typeof o.detail?.["room"] === "string" ? (o.detail["room"] as string) : "",
        });
      }
      const decisions = await dbSelect<{ visit_id: string; detail: Record<string, unknown> | null; created_at: string }>(
        "gh_events",
        `visit_id=in.(${ids.join(",")})&event=eq.issue_decision&order=created_at.desc&limit=500`,
      );
      for (const d of decisions) {
        if (issueDecisions.has(d.visit_id)) continue;
        const dec = d.detail?.["decision"];
        if (dec !== "payment_requested" && dec !== "reclean" && dec !== "waived") continue;
        issueDecisions.set(d.visit_id, {
          decision: dec,
          resolution: typeof d.detail?.["resolution"] === "string" ? (d.detail["resolution"] as string) : "",
          decided_at: d.created_at,
        });
      }
    }
    // N9 (list): client phone for search — also a batched journal read
    // (`client_contact` events, latest per visit), same pattern as above.
    const clientPhone = new Map<string, string>();
    if (ids.length > 0) {
      const contacts = await dbSelect<{ visit_id: string; detail: Record<string, unknown> | null; created_at: string }>(
        "gh_events",
        `visit_id=in.(${ids.join(",")})&event=eq.client_contact&order=created_at.desc&limit=500`,
      );
      for (const c of contacts) {
        if (clientPhone.has(c.visit_id)) continue;
        const ph = normalizeClientPhone(c.detail?.["phone"]);
        if (ph) clientPhone.set(c.visit_id, ph);
      }
    }
    return json(200, {
      ok: true,
      next_offset: page.length > 100 ? offset + 100 : null,
      visits: visits.map((v) => {
        // Extension bug #1: the auto-charge deadline is max(visit-date
        // start NY, report_sent_at + 24h) — the same server-side
        // computation as /api/report, so the owner and the client see
        // one deadline. The row's visit_date is the effective date
        // (confirm writes it there); a missing date falls back to
        // sent + 24h inside autoChargeDeadlineMs.
        const deadlineMs = autoChargeDeadlineMs(
          typeof v["report_sent_at"] === "string" ? (v["report_sent_at"] as string) : null,
          typeof v["visit_date"] === "string" ? (v["visit_date"] as string) : null,
        );
        return {
          ...annotateVisit(v, opened.get(v.id) ?? null),
          photo_count: counts.get(v.id) ?? 0,
          payment_failed: failed.has(v.id),
          visit_confirmed: confirmed.has(v.id),
          request_approved: approved.has(v.id),
          entry_agreed: entryAgreed.has(v.id),
          card_confirmed: cardConfirmed.has(v.id),
          client_phone: clientPhone.get(v.id) ?? null,
          issue_opened_at: issueOpened.get(v.id)?.opened_at ?? null,
          issue_reason: issueOpened.get(v.id)?.reason ?? null,
          issue_room: issueOpened.get(v.id)?.room ?? null,
          issue_decision: issueDecisions.get(v.id) ?? null,
          auto_charge_deadline: deadlineMs !== null ? new Date(deadlineMs).toISOString() : null,
        };
      }),
    });
  } catch (err) {
    console.error(JSON.stringify({ requestId, step: "owner", error: err instanceof Error ? err.message : String(err) }));
    return json(500, { ok: false, error: "server_error" });
  }
}
