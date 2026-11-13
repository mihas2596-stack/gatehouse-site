// Cleaner cabinet API — one token-scoped visit per link.
//   GET  /api/cleaner?ct=...            → visit view (scope, checklist, photos)
//   POST /api/cleaner {ct, action}     → checklist | photo_sign | photo_register
//                                         | photo_delete | submit
//
// Legacy tokens are random (32 bytes); v2 tokens are deterministic HMAC
// derivations (see api/_cleaner_link.ts). Either way only the SHA-256 hash
// is stored on the visit row, with an expiry. A link opens exactly one visit: the cleaner
// cannot see other bookings, prices beyond the visit scope, or any payment
// data. Photos live in a private Supabase bucket; the page receives
// short-lived signed URLs, and uploads go straight to Storage with a
// signed upload URL (bytes never pass through this function).

import { reportReplyAddress } from "./_report_reply.js";
import { ownerNotificationEmail } from "./_owner_email.js";
import {
  dbConfigured,
  dbSelect,
  dbSelectStrict,
  dbInsert,
  dbUpdate,
  dbUpdateCount,
  dbDelete,
  logEvent,
  storageSignUpload,
  storageSignDownload,
  storageRemove,
  storageObjectInfo,
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  hashToken,
  tokenHashEquals,
} from "./_db.js";
import { cleanerLinkSecretCandidates, verifyCleanerLinkV2 } from "./_cleaner_link.js";
import { photoBlocked } from "./_photo_policy.js";
import { reportEmail } from "./_email_copy.js";
import { cleanerEntryView, deleteAccess, loadAccess } from "./_visit_access.js";
import { createHash, createCipheriv, randomBytes } from "node:crypto";

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};
type Res = {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

type ChecklistItem = { label: string; done: boolean };
type ChecklistRoom = { name: string; items: ChecklistItem[]; skip_reason?: string };
type Checklist = { rooms: ChecklistRoom[]; problem_note?: string; submitted_at?: string };

type VisitRow = {
  id: string;
  booking_id: string;
  client_name: string | null;
  service: string | null;
  visit_date: string | null;
  window: string | null;
  address: string | null;
  access_notes: string | null;
  no_photo_zones: string | null;
  checklist: Checklist;
  report_status: string;
  report_bounced?: boolean | null;
  issue_open?: boolean | null;
  issue_ever?: boolean | null;
  amount_cents?: number | null;
  client_email?: string | null;
  entry_method?: string | null; entry_detail?: string | null; entry_notes?: string | null;
  cleaner_id?: string | null;
  cleaner_token_hash: string | null;
  cleaner_token_expires: string | null;
  cleaner_link_version?: string | null;
  cleaner_link_issuance?: string | null;
  status: string;
  // Re-clean (task 4, 12.11.2026): the `reclean_*` columns
  // (migration 20261112_reclean_fields). Absent (not yet migrated) =
  // undefined at runtime, which reads as "no re-clean arranged" and
  // the journal (issue_resolved / issue_decision) is the fallback.
  reclean_date?: string | null;
  reclean_cleaner_id?: string | null;
  reclean_cleaner_name?: string | null;
  reclean_status?: string | null;
};

type PhotoRow = {
  id: string;
  room: string;
  storage_path: string;
  kind: string;
  note: string | null;
  created_at: string;
};

const FROM_EMAIL = "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>";
const EDITABLE = new Set(["none", "draft", "returned"]);

const roomSlug = (room: string): string =>
  room.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "room";

export function sanitizeChecklist(raw: unknown): Checklist | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { rooms?: unknown; problem_note?: unknown };
  if (!Array.isArray(c.rooms) || c.rooms.length === 0 || c.rooms.length > 20) return null;
  const rooms: ChecklistRoom[] = [];
  for (const r of c.rooms as Array<Record<string, unknown>>) {
    // B7: a one-letter "room" is never a real room — it is a split-string
    // corruption ("Home off…" → "H","o","m","e",…) that blocks the cleaner
    // from ever submitting the report (every room needs an after photo
    // or a skip reason). Reject the whole payload, like any malformed one.
    if (!r || typeof r.name !== "string" || r.name.trim().length < 2 || !Array.isArray(r.items) || r.items.length > 40) return null;
    const items: ChecklistItem[] = [];
    for (const it of r.items as Array<Record<string, unknown>>) {
      if (!it || typeof it.label !== "string") return null;
      items.push({ label: it.label.slice(0, 120), done: it.done === true });
    }
    const room: ChecklistRoom = { name: r.name.trim().slice(0, 60), items };
    if (typeof r.skip_reason === "string" && r.skip_reason.trim()) {
      room.skip_reason = r.skip_reason.slice(0, 200);
    }
    rooms.push(room);
  }
  const out: Checklist = { rooms };
  if (typeof c.problem_note === "string") out.problem_note = c.problem_note.slice(0, 1000);
  if (JSON.stringify(out).length > 64_000) return null;
  return out;
}

async function resolveVisit(
  token: string,
): Promise<{ visit: VisitRow; restricted?: boolean } | { error: string; status: number }> {
  if (!dbConfigured()) return { error: "db_not_configured", status: 501 };
  if (!token || token.length < 20 || token.length > 200) {
    return { error: "invalid_link", status: 200 };
  }
  // v2 deterministic tokens: strict verification — structure, HMAC under
  // the server secret, issuance recorded on the row, and the stored hash
  // of the finished token. A v2 token never falls through to the legacy
  // hash lookup, and a missing secret fails closed (legacy links still
  // work below).
  if (token.startsWith("ct2.")) {
    // Try every candidate secret (env first, derived fallback) so links
    // minted before the env secret was added keep opening afterwards.
    let verified: ReturnType<typeof verifyCleanerLinkV2> = null;
    for (const secret of cleanerLinkSecretCandidates()) {
      verified = verifyCleanerLinkV2(secret, token);
      if (verified) break;
    }
    if (!verified) return { error: "invalid_link", status: 200 };
    // H7: a DB read error is a 502, never "invalid link" — a dead
    // database must not tell the cleaner their link is bad.
    const v2Rows = await dbSelectStrict<VisitRow>(
      "gh_visits",
      `id=eq.${verified.visitId}&limit=1`,
    );
    if (!v2Rows.ok) return { error: "db_unavailable", status: 502 };
    const visit = v2Rows.rows[0];
    if (!visit) return { error: "invalid_link", status: 200 };
    if (
      visit.cleaner_link_version !== "v2" ||
      visit.cleaner_link_issuance !== verified.issuanceId ||
      !visit.cleaner_token_hash ||
      !tokenHashEquals(hashToken(token), visit.cleaner_token_hash)
    ) {
      return { error: "invalid_link", status: 200 };
    }
    if (visit.cleaner_token_expires && Date.parse(visit.cleaner_token_expires) < Date.now()) {
      return { error: "link_expired", status: 410 };
    }
    // C12: a paid or cancelled visit no longer needs a working
    // cleaner link — but the link lives until expiry, so a leaked or
    // forwarded token would still show the client's address. The
    // token still resolves (the owner preview and the cleaner's own
    // history keep working), but the view is a summary only: no
    // address, no entry, no phone, no photos (see view()).
    return { visit, restricted: visit.status === "paid" || visit.status === "cancelled" || visit.status === "refunded" };
  }
  // H7: a DB read error is a 502, never "invalid link" — a dead
  // database must not tell the cleaner their link is bad.
  const legacyRows = await dbSelectStrict<VisitRow>(
    "gh_visits",
    `cleaner_token_hash=eq.${hashToken(token)}&limit=1`,
  );
  if (!legacyRows.ok) return { error: "db_unavailable", status: 502 };
  const visit = legacyRows.rows[0];
  if (!visit) return { error: "invalid_link", status: 200 };
  if (visit.cleaner_token_expires && Date.parse(visit.cleaner_token_expires) < Date.now()) {
    return { error: "link_expired", status: 410 };
  }
  return { visit, restricted: visit.status === "paid" || visit.status === "cancelled" || visit.status === "refunded" };
}

/** Rooms that still block submission: a room needs a before photo AND an after
 * photo, unless it has a skip reason or is on the client's do-not-photograph
 * list. Mirrors the cleaner UI's per-room step rule. */
export function missingRooms(
  checklist: Checklist,
  photos: { room: string; kind: string }[],
  noPhotoZones: string | null = null,
): string[] {
  const missing: string[] = [];
  for (const room of checklist.rooms ?? []) {
    if (room.skip_reason || photoBlocked(noPhotoZones, room.name)) continue;
    const hasBefore = photos.some((ph) => ph.room === room.name && ph.kind === "before");
    const hasAfter = photos.some((ph) => ph.room === room.name && ph.kind === "after");
    if (!hasBefore || !hasAfter) missing.push(room.name);
  }
  return missing;
}

async function photosOf(visitId: string): Promise<PhotoRow[]> {
  return dbSelect<PhotoRow>(
    "gh_photos",
    `visit_id=eq.${visitId}&order=created_at.asc&limit=200`,
  );
}

/** A visit counts as confirmed only when the owner confirmed it: the
 * visit_confirmed journal event is the proof. Row status alone cannot
 * prove it — submit overwrites status to report_submitted, so a
 * submitted row may or may not have been confirmed first. */
async function visitConfirmed(visitId: string): Promise<boolean> {
  const rows = await dbSelect<{ id: number }>(
    "gh_events",
    `visit_id=eq.${visitId}&event=eq.visit_confirmed&limit=1`,
  );
  return rows.length > 0;
}

// Payment-date gate (B): a visit may be reported on or after its date,
// never before. "Today" is the Atlanta calendar date (America/New_York),
// compared as YYYY-MM-DD strings — the same pattern as
// earliestServiceDate / todayInNewYork in api/visit.ts. A future
// visit_date means the cleaning has not happened yet, so no report and
// no payment may exist for it.
function todayInNewYork(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(nowMs));
}

export function isFutureVisitDate(visitDate: string | null | undefined, nowMs = Date.now()): boolean {
  if (typeof visitDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) return false;
  return visitDate > todayInNewYork(nowMs);
}

async function view(visit: VisitRow, restricted = false) {
  const firstName = (visit.client_name ?? "").trim().split(/\s+/)[0] ?? "";
  if (restricted) {
    // C12: paid/cancelled visit — summary only. No address, no entry,
    // no phone, no client notes, no photos, no checklist: a forwarded
    // link must not hand a stranger the client's home details after
    // the job is done. The client report itself is untouched — it
    // lives behind the client's own /report link, not this one.
    return {
      ok: true,
      restricted: true,
      confirmed: await visitConfirmed(visit.id),
      visit: {
        service: visit.service,
        date: visit.visit_date,
        window: visit.window,
        address: null,
        access_notes: null,
        entry_choice: { method: null, detail: null, notes: null },
        entry: null,
        client_notes: null,
        no_photo_zones: null,
        client_name: visit.client_name,
        client_first_name: firstName,
        client_phone: null,
      },
      checklist: { rooms: [] },
      photos: [],
      report_status: visit.report_status,
      report_bounced: visit.report_bounced ?? false,
      cancelled: visit.status === "cancelled",
      editable: false,
      owner_note: null,
    };
  }
  const { loadClientPhone } = await import("./_client_contact.js");
  const photos = await photosOf(visit.id);
  const withUrls = await Promise.all(
    photos.map(async (p) => ({
      id: p.id,
      room: p.room,
      kind: p.kind,
      note: p.note,
      created_at: p.created_at,
      url: await storageSignDownload(p.storage_path, 3600),
    })),
  );
  const events = await dbSelect<{ detail: { note?: string } | null }>(
    "gh_events",
    `visit_id=eq.${visit.id}&event=eq.report_returned&order=created_at.desc&limit=1`,
  );
  // The owner's latest issue decision (a re-clean) and the client's
  // original complaint — the cleaner needs both to target a re-clean.
  // The re-clean date lives on the issue_resolved event; the decision
  // event carries the decision + resolution text.
  const decisionEvents = await dbSelect<{ detail: { decision?: string; resolution?: string } | null; created_at: string }>(
    "gh_events",
    `visit_id=eq.${visit.id}&event=eq.issue_decision&order=created_at.desc&limit=1`,
  );
  const resolvedEvents = await dbSelect<{ detail: { reclean_date?: string } | null; created_at: string }>(
    "gh_events",
    `visit_id=eq.${visit.id}&event=eq.issue_resolved&order=created_at.desc&limit=1`,
  );
  const issueEvents = await dbSelect<{ actor?: string | null; detail: { reason?: string; room?: string; via?: string } | null }>(
    "gh_events",
    `visit_id=eq.${visit.id}&event=eq.issue_opened&order=created_at.desc&limit=1`,
  );
  const recleanDecision = decisionEvents[0]?.detail?.decision === "reclean" ? decisionEvents[0] : null;
  // Task 4 (12.11.2026): the re-clean lives on the row now (its own
  // date, cleaner, status) — the journal is only the fallback until
  // migration 20261112_reclean_fields is applied. A row re-clean
  // shows even when the decision event rotated out of the journal.
  const journalRecleanDate = typeof resolvedEvents[0]?.detail?.reclean_date === "string" ? (resolvedEvents[0].detail.reclean_date as string) : "";
  const recleanDate = typeof visit.reclean_date === "string" && visit.reclean_date ? visit.reclean_date : journalRecleanDate;
  const recleanStatus = typeof visit.reclean_status === "string" && visit.reclean_status
    ? visit.reclean_status
    : recleanDecision
      ? "scheduled"
      : "";
  const recleanCleanerName = typeof visit.reclean_cleaner_name === "string" && visit.reclean_cleaner_name
    ? visit.reclean_cleaner_name
    : (visit as unknown as { cleaner_name?: string | null }).cleaner_name ?? "";
  // H5: the re-clean arrangement time — the freshness anchor for
  // entry: only an access row saved AFTER this moment may be shown
  // to the re-clean cleaner. A re-clean report submitted after the
  // arrangement closes entry again (the N09 gate handles that).
  // Fallback anchor: the original report publication. Entry was
  // closed between the send and the arrangement, so any save after
  // the send is necessarily for the re-clean.
  const recleanArrangedAt = recleanDecision
    ? (decisionEvents[0]?.created_at ?? null)
    : journalRecleanDate
      ? (resolvedEvents[0]?.created_at ?? null)
      : null;
  const recleanForEntry = recleanStatus === "scheduled" || recleanDecision
    ? {
        status: recleanStatus || "scheduled",
        cleanerId: typeof visit.reclean_cleaner_id === "string" && visit.reclean_cleaner_id
          ? visit.reclean_cleaner_id
          : ((visit as unknown as { cleaner_id?: string | null }).cleaner_id ?? null),
        arrangedAt: recleanArrangedAt
          ?? (typeof (visit as unknown as { report_sent_at?: string | null }).report_sent_at === "string"
            ? (visit as unknown as { report_sent_at?: string | null }).report_sent_at
            : null),
      }
    : null;
  const issueEv = issueEvents[0] ?? null;
  // C10 (mirrored from /report): only a client-filed issue (actor
  // "client", not via the report-email auto-issue) is the client's own
  // words; anything else is an operator note.
  const clientIssue = issueEv?.detail?.reason
    ? {
        reason: issueEv.detail.reason,
        room: typeof issueEv.detail.room === "string" ? issueEv.detail.room : "",
        source: issueEv.actor === "client" && issueEv.detail?.via !== "report_email" ? "client" : "operator",
      }
    : null;
  // The customer's general comments (booking form "Notes") — kept separate
  // from access instructions so the two never merge into one dump again.
  const noteEvents = await dbSelect<{ detail: { text?: string } | null }>(
    "gh_events",
    `visit_id=eq.${visit.id}&event=eq.client_note&order=created_at.desc&limit=1`,
  );
  // N09: journal gate for entry visibility — a cancel or Finish
  // recorded after the access row was saved revokes it even if the
  // cleanup delete itself failed.
  const revokeEvents = await dbSelect<{ event: string; created_at: string }>(
    "gh_events",
    `visit_id=eq.${visit.id}&event=in.(visit_cancelled,report_submitted)&order=created_at.desc&limit=20`,
  );
  return {
    ok: true,
    confirmed: await visitConfirmed(visit.id),
    visit: {
      service: visit.service,
      date: visit.visit_date,
      window: visit.window,
      address: visit.address,
      access_notes: null,
      entry_choice: {
        method: visit.entry_method ?? null,
        detail: visit.entry_detail ?? null,
        notes: visit.entry_notes ?? null,
      },
      entry: cleanerEntryView(await loadAccess(visit.id), {
        status: visit.status, report_status: visit.report_status,
        cleaner_id: (visit as unknown as { cleaner_id?: string | null }).cleaner_id ?? null,
        reclean: recleanForEntry,
      }, await visitConfirmed(visit.id), revokeEvents),
      client_notes: noteEvents[0]?.detail?.text ?? null,
      no_photo_zones: visit.no_photo_zones,
      // A4: the full client name — the header must show the whole name,
      // not just the first word (client_first_name truncates it).
      client_name: visit.client_name,
      client_first_name: firstName,
      // The existing signed cleaner-link gate scopes this contact to one job.
      client_phone: visit.status !== "cancelled" && visit.status !== "paid"
        && visit.report_status !== "sent" && visit.report_status !== "submitted"
        && await visitConfirmed(visit.id) ? await loadClientPhone(visit.id) : null,
    },
    checklist: visit.checklist ?? { rooms: [] },
    photos: withUrls,
    report_status: visit.report_status,
    // A "sent" row whose client email bounced must not render as
    // "published" to the cleaner: the client never got the report.
    report_bounced: visit.report_bounced ?? false,
    // A submitted report held for owner review (an open issue) must
    // not look like a normal submission: the cleaner would think the
    // job is done while the report may still come back.
    report_held: visit.report_status === "submitted" && visit.issue_open === true,
    // C2: a client-cancelled visit must not look editable. The POST gate
    // already rejects it (409 visit_not_confirmed); the GET now uses the
    // same rule so the form and the server can never disagree.
    cancelled: visit.status === "cancelled",
    editable: EDITABLE.has(visit.report_status) && visit.status !== "cancelled",
    owner_note: events[0]?.detail?.note ?? null,
    // A re-clean the owner agreed (date + the decision text), and the
    // client's original complaint — the cleaner needs both to target
    // the re-clean. Null when no re-clean was agreed / no issue filed.
    // The row is the authority; the journal decision is the fallback
    // for rows arranged before the reclean columns existed.
    reclean: recleanDecision || recleanDate
      ? {
          date: recleanDate,
          note: typeof recleanDecision?.detail?.resolution === "string" ? recleanDecision.detail.resolution : "",
          cleaner_name: recleanCleanerName,
          status: recleanStatus,
        }
      : null,
    client_issue: clientIssue,
  };
}

const STRIPE_API = "https://api.stripe.com/v1";

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
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
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

async function findCustomerByBooking(
  secretKey: string,
  bookingId: string,
): Promise<{ id: string } | null> {
  const q = `metadata['gh_booking_id']:'${bookingId}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query: q, limit: "1" })}`);
  if (res.ok && Array.isArray(res.data["data"]) && res.data["data"].length > 0) {
    const c = res.data["data"][0] as { id?: string };
    if (c.id) return { id: c.id };
  }
  const listRes = await stripeGet(secretKey, `/customers?${new URLSearchParams({ limit: "100" })}`);
  if (listRes.ok && Array.isArray(listRes.data["data"])) {
    for (const c of listRes.data["data"] as Array<{ id?: string; metadata?: Record<string, string> }>) {
      if (c.id && c.metadata?.["gh_booking_id"] === bookingId) return { id: c.id };
    }
  }
  return null;
}

// v2 booking-link minting (same scheme as booking-action /
// send-contact-email): the report email links the client to
// /visit?bt=...#report.
type BookingPayload = { bid: string; email: string; name: string; ts: number };

function encryptBookingPayload(secret: string, payload: BookingPayload): string {
  const key = createHash("sha256").update(`gatehouse-booking-link:${secret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2.${Buffer.concat([iv, tag, ct]).toString("base64url")}`;
}


/** Publish a finished report straight to the client: the row moves to
 * report_sent, the 24h Terms clock starts from the publish time, and
 * the client gets the "Your cleaning report is ready" email — the same
 * email the owner's manual publish used to send. A failed email does
 * NOT start the clock: the report is marked bounced, auto-charge skips
 * it, and the owner re-sends from the panel. Returns ok:false when the
 * publish itself cannot happen (no customer, no pinned amount, an open
 * issue) — the caller then falls back to the owner review queue.
 * When the email DID go out but only the tracking write failed, the
 * failure carries email_sent: true: the client already has the report
 * link, and the owner's re-send reconciles the delivery record
 * (booking-action's N07 repair) instead of sending a duplicate. */
async function publishReportToClient(
  visit: VisitRow,
  photos: PhotoRow[],
): Promise<{ status: "published"; email_sent: boolean; version: number; sent_at: string } | { status: "already_published" } | { status: "failed"; error: string; email_sent?: boolean }> {
  const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
  if (!STRIPE_SECRET_KEY) return { status: "failed", error: "stripe_not_configured" };
  const customer = await findCustomerByBooking(STRIPE_SECRET_KEY, visit.booking_id);
  if (!customer) return { status: "failed", error: "customer_not_found" };
  const custRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${customer.id}`);
  const meta = (custRes.data["metadata"] ?? {}) as Record<string, string>;
  if (meta["gh_issue_open"] === "1") return { status: "failed", error: "issue_open" };
  const custEmail = typeof custRes.data["email"] === "string" ? (custRes.data["email"] as string) : "";
  const custName = typeof custRes.data["name"] === "string" ? (custRes.data["name"] as string) : "";
  const amountCents = visit.amount_cents ?? parseInt(meta["gh_first_price_cents"] ?? "", 10);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return { status: "failed", error: "quote_missing" };
  const version = (parseInt(meta["gh_report_version"] ?? "0", 10) || 0) + 1;
  const sentAt = new Date().toISOString();
  // RA14: claim the publication BEFORE any email or metadata write.
  // The submit CAS above moved this row to submitted; only the
  // submitted→sent transition publishes. If the owner already
  // published from the review queue (or the visit was cancelled),
  // this claim loses and nothing is sent twice. The claim sets
  // report_bounced pessimistically: if the email step then fails,
  // the clock stays blocked instead of running on an undelivered
  // report; the success write below clears it.
  const claimed = await dbUpdateCount(
    "gh_visits",
    `id=eq.${visit.id}&report_status=eq.submitted&status=eq.report_submitted`,
    {
      report_status: "sent",
      report_sent_at: sentAt,
      report_email_id: null,
      report_bounced: true,
      status: "report_sent",
    },
  );
  if (claimed === 0) {
    const fresh = await dbSelect<{ status: string | null }>(
      "gh_visits",
      `id=eq.${visit.id}`,
    );
    if (fresh[0]?.status === "cancelled") return { status: "failed", error: "visit_cancelled" };
    return { status: "already_published" };
  }
  if (claimed < 0) return { status: "failed", error: "db_error" };
  const photoHash = createHash("sha256").update(photos.map((p) => p.storage_path).join("|")).digest("hex").slice(0, 16);
  const params: Record<string, string> = {
    "metadata[gh_state]": "report_sent",
    "metadata[gh_issue_open]": "",
    "metadata[gh_issue_reason]": "",
    "metadata[gh_report_sent_at]": sentAt,
    "metadata[gh_report_version]": String(version),
    "metadata[gh_report_amount_cents]": String(amountCents),
    "metadata[gh_report_bounced]": "",
    "metadata[gh_rp_hash]": photoHash,
    "metadata[gh_rp_source]": "db",
  };
  for (let i = 0; i < 4; i++) params[`metadata[gh_rp_${i}]`] = "";
  await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, params);
  let emailSent = false;
  let reportEmailId = "";
  const RESEND_API_KEY = process.env["RESEND_API_KEY"];
  if (RESEND_API_KEY && custEmail) {
    const firstName = custName.trim().split(/\s+/)[0] || "there";
    const token = encryptBookingPayload(process.env["BOOKING_LINK_SECRET"] || STRIPE_SECRET_KEY, {
      bid: visit.booking_id,
      email: custEmail,
      name: custName,
      ts: Math.floor(Date.now() / 1000),
    });
    const link = `https://www.gatehousehomecleaning.com/visit?bt=${token}#report`;
    const deadline = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(Date.parse(sentAt) + 24 * 3600 * 1000));
    const renderedReportEmail = reportEmail({
      firstName, link,
      amount: `$${(amountCents / 100).toFixed(2).replace(/\.00$/, "")}`,
      deadline, autoChargeBlocked: visit.issue_ever === true || visit.issue_open === true ||
        meta["gh_issue_ever"] === "1" || (await dbSelect<{ id: number }>("gh_events", `visit_id=eq.${visit.id}&event=eq.issue_opened&limit=1`)).length > 0,
    });
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
          to: [custEmail],
          reply_to: reportReplyAddress(visit.id) ?? "hello@gatehousehomecleaning.com",
          tags: [{ name: "gh_report", value: "1" }],
          subject: "Your cleaning report is ready",
          text: renderedReportEmail.text,
          html: renderedReportEmail.html,
        }),
        signal: AbortSignal.timeout(15000),
      });
      emailSent = resp.ok;
      if (resp.ok) {
        try {
          const j = (await resp.json()) as { id?: string };
          if (typeof j.id === "string" && j.id) {
            reportEmailId = j.id;
            await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
              "metadata[gh_report_email_id]": j.id,
            });
          }
        } catch {
          /* best-effort */
        }
      }
    } catch {
      emailSent = false;
    }
  }
  if (!emailSent) {
    // The client cannot see the report, so the 24h clock must NOT run.
    await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
      "metadata[gh_report_bounced]": "1",
    });
  }
  if (emailSent) {
    // Resend accepted the email (resp.ok) but its message id could
    // not be captured — there is nothing to reconcile a retry by, so
    // this is a distinct error, not the tracking failure below. The
    // email went out (email_sent: true); the timer stays blocked
    // until the owner re-sends, which may duplicate it — the owner
    // is told so, instead of a silent duplicate or a silent block.
    if (!reportEmailId) return { status: "failed", error: "report_email_id_missing", email_sent: true };
    const tracked = await dbUpdateCount("gh_visits",
      `id=eq.${visit.id}&report_sent_at=eq.${encodeURIComponent(sentAt)}&report_status=eq.sent`,
      { report_email_id: reportEmailId, report_bounced: false });
    if (tracked !== 1) return { status: "failed", error: "report_email_tracking_failed", email_sent: true };
  }
  await logEvent(visit.id, visit.booking_id, "cleaner", "report_sent", {
    version, email_sent: emailSent, photos: photos.length, auto: true,
  });
  return { status: "published", email_sent: emailSent, version, sent_at: sentAt };
}

async function sendOwnerEmail(subject: string, text: string): Promise<boolean> {
  const key = process.env["RESEND_API_KEY"];
  if (!key) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [ownerNotificationEmail()], subject, text }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export default async function handler(req: Req, res: Res) {
  const requestId = Math.random().toString(36).slice(2);
  const json = (status: number, body: Record<string, unknown>) =>
    res.status(status).json({ requestId, ...body });
  try {
    if (req.method === "GET") {
      const ct = typeof req.query?.["ct"] === "string" ? (req.query["ct"] as string) : "";
      const resolved = await resolveVisit(ct);
      if ("error" in resolved) return json(resolved.status, { ok: false, error: resolved.error });
      // Link-open tracking for the owner panel ("did the cleaner open
      // it?"). O5: throttled to one event per 6 hours per LINK ISSUANCE,
      // and the event carries the issuance — a new link does not inherit
      // the old link's open, and an open is never called acceptance of
      // the work. The owner's own preview carries pv=1 and never counts.
      // Legacy links carry no issuance and keep the per-visit throttle.
      if (req.query?.["pv"] !== "1") {
        try {
          const issuance = resolved.visit.cleaner_link_issuance ?? null;
          const issuanceFilter = issuance
            ? `&detail->>issuance=eq.${encodeURIComponent(issuance)}`
            : "";
          const prior = await dbSelect<{ created_at: string }>(
            "gh_events",
            `visit_id=eq.${resolved.visit.id}&event=eq.cleaner_link_opened${issuanceFilter}&order=created_at.desc&limit=1`,
          );
          const last = prior[0] ? Date.parse(prior[0].created_at) : 0;
          if (!last || Date.now() - last > 6 * 3600 * 1000) {
            await logEvent(resolved.visit.id, resolved.visit.booking_id, "cleaner", "cleaner_link_opened", issuance ? { issuance } : {});
          }
        } catch { /* tracking is best-effort */ }
      }
      return json(200, await view(resolved.visit, resolved.restricted ?? false));
    }
    if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const ct = typeof body["ct"] === "string" ? (body["ct"] as string) : "";
    const action = typeof body["action"] === "string" ? (body["action"] as string) : "";
    const resolved = await resolveVisit(ct);
    if ("error" in resolved) return json(resolved.status, { ok: false, error: resolved.error });
    const visit = resolved.visit;

    // C12: a paid or cancelled visit is closed for cleaner work —
    // the link resolves only to a summary on GET, and every POST
    // action is refused here (the gate below would let a paid visit
    // through whenever its report is still in an editable state).
    if (resolved.restricted) {
      return json(409, { ok: false, error: "visit_closed" });
    }

    // Pipeline gate: no ordinary work on an unconfirmed or cancelled
    // booking. Starting work (checklist/photos) and finishing it (submit)
    // both require the owner's confirmation first — otherwise the client
    // page ends up showing "awaiting confirmation" and "cleaning
    // complete" at the same time. Cancelled bookings never reach here
    // with a live link, but the status check keeps the gate explicit.
    if (visit.status === "cancelled" || !(await visitConfirmed(visit.id))) {
      return json(409, { ok: false, error: "visit_not_confirmed" });
    }

    if (!EDITABLE.has(visit.report_status) && action !== "submit") {
      return json(409, { ok: false, error: "report_locked", report_status: visit.report_status });
    }

    if (action === "checklist") {
      const checklist = sanitizeChecklist(body["checklist"]);
      if (!checklist) return json(400, { ok: false, error: "invalid_checklist" });
      // Keep the server-stamped submission time out of cleaner control.
      if (visit.checklist?.submitted_at) checklist.submitted_at = visit.checklist.submitted_at;
      const changed = await dbUpdateCount("gh_visits", `id=eq.${visit.id}&report_status=in.(none,draft,returned)`, {
        checklist,
        report_status: visit.report_status === "none" ? "draft" : visit.report_status,
      });
      if (changed < 0) return json(502, { ok: false, error: "db_error" });
      if (changed === 0) return json(409, { ok: false, error: "report_locked" });
      return json(200, { ok: true });
    }

    if (action === "photo_sign") {
      const room = typeof body["room"] === "string" ? (body["room"] as string).slice(0, 60) : "";
      const kind = body["kind"] === "before" ? "before" : "after";
      const rooms = (visit.checklist?.rooms ?? []).map((r) => r.name);
      if (!room || (!rooms.includes(room) && room !== "Other areas")) {
        return json(400, { ok: false, error: "invalid_room" });
      }
      if (photoBlocked(visit.no_photo_zones, room)) return json(403, { ok: false, error: "photo_not_allowed" });
      const objectPath = `visits/${visit.id}/${roomSlug(room)}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}.jpg`;
      const signed = await storageSignUpload(objectPath);
      if (!signed) return json(502, { ok: false, error: "storage_error" });
      return json(200, { ok: true, upload_url: signed.signedUrl, storage_path: objectPath, kind });
    }

    if (action === "photo_register") {
      const room = typeof body["room"] === "string" ? (body["room"] as string).slice(0, 60) : "";
      const kind = body["kind"] === "before" ? "before" : "after";
      const storagePath = typeof body["storage_path"] === "string" ? (body["storage_path"] as string) : "";
      if (!room || !storagePath.startsWith(`visits/${visit.id}/`)) {
        return json(400, { ok: false, error: "invalid_photo" });
      }
      if (photoBlocked(visit.no_photo_zones, room)) return json(403, { ok: false, error: "photo_not_allowed" });
      // Server-side validation of the uploaded bytes (type + size): the
      // client uploads straight to Storage, so this is the first point
      // the server sees the file. Anything else is removed again.
      const info = await storageObjectInfo(storagePath);
      if (!info) return json(502, { ok: false, error: "storage_error" });
      if (!ALLOWED_PHOTO_TYPES.includes(info.contentType) || info.size <= 0 || info.size > MAX_PHOTO_BYTES) {
        await storageRemove(storagePath);
        return json(400, { ok: false, error: "invalid_photo_file" });
      }
      const existing = await photosOf(visit.id);
      if (existing.some((p) => p.storage_path === storagePath)) {
        return json(200, { ok: true, already: true });
      }
      if (existing.length >= 60) return json(400, { ok: false, error: "too_many_photos" });
      const note = typeof body["note"] === "string" ? (body["note"] as string).slice(0, 300) : null;
      const row = await dbInsert<PhotoRow>("gh_photos", {
        visit_id: visit.id,
        room,
        storage_path: storagePath,
        kind,
        note,
      });
      if (!row) return json(502, { ok: false, error: "db_error" });
      return json(200, { ok: true, photo_id: row.id });
    }

    if (action === "photo_delete") {
      const photoId = typeof body["photo_id"] === "string" ? (body["photo_id"] as string) : "";
      const photos = await photosOf(visit.id);
      const target = photos.find((p) => p.id === photoId);
      if (!target) return json(404, { ok: false, error: "photo_not_found" });
      await dbDelete("gh_photos", `id=eq.${target.id}&visit_id=eq.${visit.id}`);
      await storageRemove(target.storage_path);
      return json(200, { ok: true });
    }

    if (action === "submit") {
      if (visit.report_status === "submitted") {
        return json(200, { ok: true, already: true });
      }
      // Payment-date gate (B): the visit has not happened yet — no
      // report may be submitted for a future date. The cleaner can
      // send the report on or after the visit date, never before.
      // Task 4: when a re-clean is scheduled, the gate is the
      // RE-CLEAN date, not the original visit date — the original
      // date is already past, so gating on it would let the cleaner
      // submit days before the re-clean happens.
      const recleanScheduled =
        visit.reclean_status === "scheduled" &&
        typeof visit.reclean_date === "string" &&
        !!visit.reclean_date;
      const gateDate = recleanScheduled ? (visit.reclean_date as string) : visit.visit_date;
      if (isFutureVisitDate(gateDate)) {
        return json(400, { ok: false, error: "report_too_early", visit_date: gateDate, ...(recleanScheduled ? { reclean: true } : {}) });
      }
      if (!EDITABLE.has(visit.report_status)) {
        return json(409, { ok: false, error: "report_locked", report_status: visit.report_status });
      }
      const checklist = sanitizeChecklist(body["checklist"]) ?? visit.checklist;
      const photos = await photosOf(visit.id);
      const missing = missingRooms(checklist, photos, visit.no_photo_zones);
      if (missing.length > 0) {
        return json(400, { ok: false, error: "rooms_incomplete", missing });
      }
      checklist.submitted_at = new Date().toISOString();
      // R01: the submitted-transition is a compare-and-swap on the
      // expected pre-states. Two concurrent Finish clicks both pass
      // the read check above; only the CAS winner publishes — the
      // loser returns the existing result instead of a second
      // publication and a second client email.
      const changed = await dbUpdateCount(
        "gh_visits",
        `id=eq.${visit.id}&report_status=in.(none,draft,returned)`,
        {
          checklist,
          report_status: "submitted",
          status: "report_submitted",
        },
      );
      if (changed === 0) return json(200, { ok: true, already: true });
      if (changed < 0) return json(502, { ok: false, error: "db_error" });
      // Task 4: a submitted re-clean report moves the re-clean to
      // "submitted" (best-effort, separate from the CAS above — the
      // column does not exist until migration 20261112_reclean_fields,
      // and a failed write must never fail the submission itself).
      if (recleanScheduled) {
        await dbUpdate("gh_visits", `id=eq.${visit.id}`, { reclean_status: "submitted" });
      }
      await logEvent(visit.id, visit.booking_id, "cleaner", "report_submitted", {
        photos: photos.length,
        problem_note: checklist.problem_note ?? null,
      });
      // Finish closes entry access: the finished cleaner no longer sees
      // the client's entry details, even if the report is held. A
      // failed delete is journaled (the submitted report_status and
      // the journal gate above still block the view).
      const accessDeleted = await deleteAccess(visit.id);
      await logEvent(visit.id, visit.booking_id, "system", accessDeleted ? "entry_revoked" : "entry_revoke_failed");
      // Auto-publish: the finished report goes straight to the client —
      // no mandatory owner step between the cleaner's finish and the
      // client's report. Exceptions stay with the owner: an open issue
      // holds the report in the review queue, and a failed publish falls
      // back to the same queue instead of starting an invisible clock.
      const held = visit.issue_open === true;
      if (held) {
        const emailed = await sendOwnerEmail(
          `Report ready for review — ${visit.client_name ?? "client"}, ${visit.visit_date ?? ""}`,
          `The cleaner submitted the photo report, but it is HELD for review: an issue is open on this visit.\n\nClient: ${visit.client_name ?? ""}\nDate: ${visit.visit_date ?? ""}\nPhotos: ${photos.length}\nCleaner note: ${checklist.problem_note ?? "—"}\n\nOpen the owner view to resolve the issue and send the report.`,
        );
        if (!emailed) {
          await logEvent(visit.id, visit.booking_id, "system", "owner_email_failed", {
            what: "report_submitted",
          });
        }
        return json(200, { ok: true, published: false, held: true });
      }
      const published = await publishReportToClient(visit, photos);
      if (published.status === "already_published") {
        // RA14: the owner published from the review queue while this
        // Finish was in flight. One publication exists — this call
        // sends nothing more, and the cleaner sees the shared result.
        return json(200, { ok: true, already: true, published: false });
      }
      if (published.status === "failed" && published.error === "visit_cancelled") {
        return json(409, { ok: false, error: "visit_not_confirmed" });
      }
      if (published.status === "failed") {
        await logEvent(visit.id, visit.booking_id, "system", "report_publish_failed", {
          error: published.error,
        });
        // A tracking-only failure means the client may already have
        // the report email: say so in the owner email, so the owner
        // re-sends to reconcile (no duplicate) instead of assuming
        // the client never got it.
        const emailMayHaveGoneOut = published.email_sent === true;
        const emailed = await sendOwnerEmail(
          `Report ready for review — ${visit.client_name ?? "client"}, ${visit.visit_date ?? ""}`,
          `The cleaner submitted the photo report, but automatic publishing failed (${published.error}). The report is waiting in the owner review queue — publish it from the owner panel.${emailMayHaveGoneOut ? " The report email may already have reached the client — re-sending from the panel reconciles the delivery record without sending a duplicate." : ""}\n\nClient: ${visit.client_name ?? ""}\nDate: ${visit.visit_date ?? ""}\nPhotos: ${photos.length}\nCleaner note: ${checklist.problem_note ?? "—"}`,
        );
        if (!emailed) {
          await logEvent(visit.id, visit.booking_id, "system", "owner_email_failed", {
            what: "report_submitted",
          });
        }
        return json(200, { ok: true, published: false, publish_error: published.error, email_sent: emailMayHaveGoneOut });
      }
      const emailed = await sendOwnerEmail(
        `Report published to client — ${visit.client_name ?? "client"}, ${visit.visit_date ?? ""}`,
        `The cleaner finished the visit and the photo report went straight to the client — no action needed.\n\nClient: ${visit.client_name ?? ""}\nDate: ${visit.visit_date ?? ""}\nPhotos: ${photos.length}\nCleaner note: ${checklist.problem_note ?? "—"}\nReport email to the client: ${published.email_sent ? "sent" : "FAILED — the 24h clock is blocked; re-send it from the owner panel."}\n\nOpen the owner view to see the report and its notification status.`,
      );
      if (!emailed) {
        await logEvent(visit.id, visit.booking_id, "system", "owner_email_failed", {
          what: "report_published",
        });
      }
      return json(200, { ok: true, published: true, email_sent: published.email_sent });
    }

    return json(400, { ok: false, error: "invalid_action" });
  } catch (err) {
    console.error(JSON.stringify({ requestId, step: "cleaner", error: err instanceof Error ? err.message : String(err) }));
    return json(500, { ok: false, error: "server_error" });
  }
}
