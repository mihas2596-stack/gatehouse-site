import { trackFunnel } from "@/lib/measurement";
import { formatArrivalWindow } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, CalendarClock, AlertTriangle, Loader2, RefreshCw, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";
import JourneySteps from "@/components/JourneySteps";
import { ReportContent, ZoomablePhoto } from "@/components/ReportContent";
import { IssueForm } from "@/components/IssueForm";
import { convertToJpeg } from "@/lib/imageConvert";
import { fmtDateUS } from "@/lib/formatDate";
import { resolveLinkToken } from "@/lib/tokenStrip";
import { toVisitMethod, entrySummaryLabel, entryChoiceSettled, type EntryMethodChoice, type EntryDetailChoice } from "@/config/entry";

type VisitStateName =
  | "invalid_link"
  | "transient_error"
  | "card_needed"
  | "card_failed"
  | "awaiting_confirmation"
  | "confirmed"
  | "date_declined"
  | "report_sent"
  | "issue_open"
  | "approved"
  | "paid"
  | "payment_issue"
  | "payment_unknown"
  | "waived"
  | "refunded"
  | "date_passed"
  | "cancelled";

type VisitData = {
  notification_email_sent?: boolean;
  ok: boolean;
  state: VisitStateName;
  // P0-4: a preview token (minted by the owner's preview link) is
  // read-only — the page shows a banner and hides every action button.
  preview?: boolean;
  booking?: {
    service?: string;
    first_service?: string;
    requested_date?: string;
    confirmed_date?: string;
    window?: string;
    first?: string;
    recurring?: string | null;
  };
  cleaner?: { name: string; photo: string; phone?: string } | null;
  // The rooms this visit covers — the same list the cleaner checklist
  // and the owner report show (from the stored work scope).
  rooms?: string[];
  alt_dates?: string[];
  proposed_date?: string;
  proposed_pending?: boolean;
  charge_timer_blocked?: boolean;
  charge_timer_block_reason?: string | null;
  cancel_fee_cents?: number;
  cancel_fee?: string;
  cancelled_scope?: string;
  access_notes?: string;
  entry?: { available: boolean; method: string | null; note: string; has_secret: boolean; expires_at: string | null } | null;
  entry_available?: boolean;
  entry_choice?: { method: EntryMethodChoice | null; detail: EntryDetailChoice | null; notes: string | null } | null;
  no_photo_zones?: string;
  has_card?: boolean;
  card_brand?: string;
  card_last4?: string;
  card_confirmed?: boolean;
  report_preparing?: boolean;
  scope_review_needed?: boolean;
  confirm_by?: string;
  error?: string;
};

// JourneySteps has 5 steps (0–4): a current past the last index marks
// every step done, none current — used for a paid visit, whose journey
// is finished.
const STEPS_DONE = 5;

const STATE_HEADLINE: Record<string, string> = {
  card_needed: "Request received — one step left",
  card_failed: "Your card couldn't be saved",
  awaiting_confirmation: "Request received — awaiting confirmation",
  confirmed: "Your cleaning is confirmed",
  date_declined: "That date doesn't work — pick another",
  report_sent: "Your visit is done — report sent",
  issue_open: "We're sorting out your issue",
  approved: "Visit approved",
  paid: "Paid — all done",
  payment_issue: "Your payment needs attention",
  // H1: an unknown charge outcome is never "Visit approved" — the
  // payment may or may not have gone through.
  payment_unknown: "We couldn't confirm your payment",
  // A waived visit is closed without a charge — never show it as
  // "approved" or as a pending charge.
  waived: "No charge for this visit",
  // B6: the requested/confirmed date is already past — nothing is booked
  // for that day, and the client must pick a new date or cancel.
  date_passed: "That date has passed — pick a new one",
  cancelled: "Cancelled",
};

type ReportPhoto = { url: string | null; thumb_url?: string | null; room?: string; note?: string; kind?: string; unavailable?: boolean };
type ReportChecklist = { rooms: Array<{ name: string; items: Array<{ label: string; done: boolean }>; skip_reason?: string }>; problem_note?: string };
type ReportData = {
  ok: boolean;
  state: string;
  // P0-4: a preview token (minted by the owner's preview link) is
  // read-only — the page shows a banner and hides every action button.
  preview?: boolean;
  photo_items?: ReportPhoto[];
  checklist?: ReportChecklist | null;
  amount?: string | null;
  deadline?: string | null;
  publication_id?: string | null;
  delivery_failed?: boolean;
  charge_timer_blocked?: boolean;
  charge_timer_block_reason?: string | null;
  receipt_sent?: boolean;
  issue_reason?: string;
  // C10: "client" = the client's own words; "operator" (or missing) =
  // an operator note — operator notes are NEVER shown to the client:
  // only the client's own words render (as "You told us").
  issue_source?: string;
  issue_room?: string;
  // Cabinets audit (fix 1): photos the client attached to the
  // complaint. Null = unknown — the page shows no attachment line
  // rather than a possibly-wrong "none".
  issue_photo_count?: number | null;
  // The owner's latest decision on the issue (payment_requested /
  // reclean / waived, with its text) and the resolution record
  // (resolved_at + reclean_date) — same payload as /report.
  issue_decision?: { decision: string; resolution: string; decided_at: string } | null;
  resolution?: { resolved_at: string; reclean_date: string } | null;
  // Task 4: the live re-clean (date + cleaner) — visible while the
  // issue is still open, not only after it is resolved.
  reclean_date?: string;
  reclean_cleaner_name?: string;
  no_photo_zones?: string[];
  error?: string;
  // 3DS (DA-03, mirrored from /report): when the saved card needs
  // cardholder authentication the server answers approve with 402
  // payment_requires_action and these fields — the PaymentIntent's
  // client_secret and the account's publishable key — so the client
  // can complete the challenge with Stripe.js and then re-approve.
  // Absent on every other response.
  client_secret?: string;
  confirmation_method_id?: string;
  publishable_key?: string;
  payment_intent?: string;
};

const fmtDeadline = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
};

// §11: the report lives INSIDE the client cabinet — same booking, same
// page, anchored at #report (the report email links straight here).
function ReportSection({ bt, visitState, cleanerName, cleanerPhoto, visitDate, visitWindow, cardLabel, onChanged }: { bt: string; visitState: string; cleanerName?: string | null; cleanerPhoto?: string | null; visitDate?: string | null; visitWindow?: string | null; cardLabel?: string | null; onChanged: () => void }) {
  const [rep, setRep] = useState<ReportData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // MB-16: whether the report fetch itself failed before any good
  // report loaded — the not_ready branch then offers a retry instead
  // of the (false) "will appear after your cleaning" text.
  const [loadFailed, setLoadFailed] = useState(false);
  const repRef = useRef<ReportData | null>(null);
  useEffect(() => { repRef.current = rep; }, [rep]);
  // S13: Approve refused with card_confirmation_required — several
  // cards on file, none confirmed for this booking. The link below
  // leads to the existing confirm_card flow (/save-card).
  const [needsCardChoice, setNeedsCardChoice] = useState(false);
  const [issueText, setIssueText] = useState("");
  const [issueRoom, setIssueRoom] = useState("");
  const [showIssue, setShowIssue] = useState(false);
  const [issuePhoto, setIssuePhoto] = useState("");
  const [issuePhotoNote, setIssuePhotoNote] = useState("");

  // Photo for the issue form: compress on the phone (same convertToJpeg
  // as the cleaner) instead of dropping anything over 1 MB — the
  // server accepts up to 15 MB, and a phone photo is almost always
  // over 1 MB (MB-33). When compression itself fails, a small photo
  // still goes through as-is; a large one gets an honest note and the
  // message itself still goes through.
  const onPhotoPick = async (file: File | null) => {
    setIssuePhoto("");
    setIssuePhotoNote("");
    if (!file) return;
    const readAsDataUrl = (blob: Blob | File) => {
      const reader = new FileReader();
      reader.onload = () => setIssuePhoto(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => setIssuePhotoNote("We couldn't attach that photo — your message will still be sent.");
      reader.readAsDataURL(blob);
    };
    try {
      const blob = await convertToJpeg(file);
      if (blob.size > 15_000_000) {
        setIssuePhotoNote("That photo is too large to send — please pick a smaller one.");
        return;
      }
      readAsDataUrl(blob);
    } catch (err) {
      if (file.size <= 1_000_000) {
        readAsDataUrl(file);
      } else {
        setIssuePhotoNote(err instanceof Error ? err.message : "That photo is large, so we'll send your message without it.");
      }
    }
  };

  // M7: the report fetch, refetchable — an unavailable photo tile
  // offers "Try again" (same as /report) instead of a dead end.
  // MB-16 (mirroring /report G6): a failed refetch never wipes a
  // loaded report — the last good version stays, with a note; only a
  // fetch that fails before anything loaded shows not_ready, and then
  // with a retry button.
  const reload = useCallback(() => {
    fetch(`/api/report?bt=${encodeURIComponent(bt)}`)
      .then(async (r) => {
        const j = (await r.json()) as ReportData;
        if (!r.ok || j.ok === false) throw new Error("bad");
        setRep(j);
        setLoadFailed(false);
      })
      .catch(() => {
        if (repRef.current) {
          setErr("Couldn't refresh your report — showing the last loaded version. Try again in a moment.");
        } else {
          setRep({ ok: false, state: "not_ready" });
          setLoadFailed(true);
        }
      });
  }, [bt]);

  useEffect(() => {
    reload();
  }, [reload]);

  // 3DS (DA-03, mirrored from /report): complete the cardholder
  // authentication for a PaymentIntent the server already confirmed
  // and left in requires_action. Returns true when the challenge
  // finished without error; the caller then re-approves once so the
  // server reconciles the (now succeeded) intent and marks the visit
  // paid. Returns false (and sets the message) when the challenge
  // cannot start or the cardholder fails or cancels it — no charge is
  // made and nothing retries on its own. Stripe.js is loaded lazily,
  // only when a 3DS challenge is actually needed.
  const complete3DS = async (clientSecret: string, publishableKey: string, methodId?: string): Promise<boolean> => {
    if (!publishableKey) {
      setErr("Your card needs extra verification to complete this payment, and we couldn't start it — please email hello@gatehousehomecleaning.com and we'll help you pay. No charge was made.");
      return false;
    }
    let stripe: Awaited<ReturnType<typeof import("@stripe/stripe-js").loadStripe>>;
    try {
      const { loadStripe } = await import("@stripe/stripe-js");
      stripe = await loadStripe(publishableKey);
    } catch {
      setErr("We couldn't load the card verification — please try again, or email hello@gatehousehomecleaning.com and we'll help you pay. No charge was made.");
      return false;
    }
    if (!stripe) {
      setErr("We couldn't load the card verification — please try again, or email hello@gatehousehomecleaning.com and we'll help you pay. No charge was made.");
      return false;
    }
    const { error } = methodId
      ? await stripe.confirmCardPayment(clientSecret, { payment_method: methodId })
      : await stripe.handleCardAction(clientSecret);
    if (error) {
      setErr(error.message || "The card verification didn't complete — please try again, or email hello@gatehousehomecleaning.com and we'll help you pay. No charge was made.");
      return false;
    }
    return true;
  };

  const act = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setErr("");
    setNeedsCardChoice(false);
    try {
      const postReport = async (): Promise<ReportData & { ok: boolean }> => {
        const r = await fetch("/api/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bt,
            ...payload,
            // RA08: pay only for the publication this tab actually
            // showed; a stale tab gets report_changed, not a charge.
            ...(payload.action === "approve" ? { seen_publication_id: rep?.publication_id ?? undefined } : {}),
            // The issue photo travels with the complaint (Terms §7).
            ...(payload.action === "issue" && issuePhoto ? { photo: issuePhoto } : {}),
          }),
        });
        return (await r.json()) as ReportData & { ok: boolean };
      };
      let j = await postReport();
      // 3DS (DA-03, mirrored from /report): the saved card needs the
      // cardholder's authentication. Complete the challenge in this
      // browser, then approve once more so the server reconciles the
      // same intent — the create key is bound to booking + version +
      // card, so the re-approve cannot mint a second charge. Done at
      // most once per tap: if the re-approve still needs action, the
      // message below (not a loop) tells the client to try again or
      // email us.
      if (payload.action === "approve" && j && j.error === "payment_requires_action" && j.client_secret) {
        const done = await complete3DS(j.client_secret, j.publishable_key ?? "", j.confirmation_method_id);
        if (!done) {
          setBusy(false);
          return;
        }
        j = await postReport();
      }
      // N26 (mirrored from /report): the expired-window 409s carry no
      // `state`, so they must be handled before the state gate below —
      // otherwise the client only gets the generic error. The form
      // stays open so the client can copy their text into the email.
      if (j && j.error === "issue_window_expired") {
        setErr("The 24-hour window for reporting an issue on this report has passed — please email us at hello@gatehousehomecleaning.com and we'll look into it.");
      } else if (j && j.error === "claim_window_expired") {
        setErr("The window for reporting an issue after this visit has passed — please email us at hello@gatehousehomecleaning.com and we'll look into it.");
      } else if (j && j.state && j.state !== "invalid_link") {
        setRep(j);
        onChanged();
        // A sent issue clears the form (including the photo).
        if (payload.action === "issue") {
          setShowIssue(false);
          setIssueText("");
          setIssueRoom("");
          setIssuePhoto("");
          setIssuePhotoNote("");
          // Finding 6 (25.11.2026): the confirmation banner must show
          // the real number of attached photos, not a possibly stale
          // count from the submit response — re-read the report so the
          // "N photo(s) attached" line comes from a fresh GET. A
          // failed refetch keeps the submitted response (MB-16).
          reload();
        }
        // S13: several cards on file, none confirmed for this booking —
        // the server refuses to guess. Lead to the existing confirm_card
        // flow instead of leaving a dead Approve button; no charge made.
        if (j.error === "card_confirmation_required") {
          setNeedsCardChoice(true);
          setErr("We found more than one card on file and can't tell which one is for this visit — no charge was made. Please choose which card to use for this booking.");
        }
        if (j.error === "report_changed") {
          setErr("This report was updated since you opened it — please review the latest version before approving. No charge was made.");
        }
        if (j.error === "payment_processing") {
          setErr("Processing payment — a charge for this visit is already in progress. Please wait a moment and refresh; you won't be charged twice.");
        }
        // 3DS (DA-03): the challenge did not finish the payment —
        // either the first answer carried no client_secret, or the
        // re-approve after the challenge still needs action. Say so
        // plainly and do not loop: the client tries again or emails
        // us. No charge was made.
        if (j.error === "payment_requires_action") {
          setErr("Your card needs extra verification to complete this payment — please try again, or email hello@gatehousehomecleaning.com and we'll help you pay. No charge was made.");
        }
        // H1: the charge outcome is unknown — the payment may or may
        // not have gone through. Never show this as approved; the
        // retry re-checks the payment status first.
        if (j.error === "payment_unknown" || j.error === "payment_unconfirmed") {
          setErr("We couldn't confirm whether your payment went through — please try again. You won't be charged twice; we'll check the payment status first.");
        }
      } else {
        setErr("Something went wrong — please try again, or email hello@gatehousehomecleaning.com.");
      }
    } catch {
      setErr("Something went wrong — please try again, or email hello@gatehousehomecleaning.com.");
    }
    setBusy(false);
  };

  if (!rep) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
        <p className="text-sm text-muted-foreground">Loading your report…</p>
      </div>
    );
  }
  if (rep.state === "not_ready" || !rep.ok) {
    // V3: same conditions as /report — a bounced report means the
    // 24-hour window has not started; say so instead of the generic
    // "will appear" note.
    return (
      <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
        <h2 className="font-heading text-lg font-bold mb-2">Cleaning report</h2>
        {rep.delivery_failed ? (
          <p className="text-sm text-foreground">
            We tried to email your photo report, but it couldn&apos;t be delivered — so the
            24-hour window has <strong>not</strong> started and no charge will happen until the
            report reaches you. Email hello@gatehousehomecleaning.com and we&apos;ll resend it
            another way.
          </p>
        ) : loadFailed ? (
          <>
            <p className="text-sm text-foreground mb-3">
              We couldn&apos;t load your report — check your connection and try again. Your link is fine.
            </p>
            <Button variant="outline" onClick={() => reload()}>
              Try again
            </Button>
          </>
        ) : (
          <p className="text-sm text-foreground">Your photos and checklist will appear here after your cleaning.</p>
        )}
      </div>
    );
  }
  // H1: an unknown charge outcome is actionable — the client must be
  // able to retry (the retry re-checks the payment status first).
  // P0-4: preview mode is read-only — the server refuses every action
  // for preview tokens; the buttons hide here too.
  const isPreview = rep?.preview === true;
  const canAct = !isPreview && (rep.state === "awaiting" || rep.state === "payment_issue" || rep.state === "payment_unknown");
  // B (payment-date gate): the visit has not happened yet — a report
  // that exists for a future date cannot be approved or paid. "Today"
  // is the Atlanta calendar date (America/New_York), compared as
  // YYYY-MM-DD strings, mirroring the server gate in api/report.ts.
  // The server enforces the same gate, so this is display, not security.
  const isFutureVisit = (() => {
    const d = visitDate;
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return d > today;
  })();
  const cardActionable = !isPreview && (visitState === "report_sent" || visitState === "issue_open" || visitState === "payment_issue" || visitState === "payment_unknown");
  // A waived visit is closed without a charge: no card line, no
  // "Change card", no Approve — the banner below says so plainly.
  const isWaived = rep.state === "waived";
  // Rooms that appear in the report, for the issue-form room picker —
  // only real rooms, plus "Other / not listed" (shared IssueForm).
  const reportRooms = Array.from(new Set((rep.photo_items ?? []).map((p) => p.room).filter(Boolean) as string[]));
  // H17: "before" photos may be absent (e.g. QA-era reports) — say so
  // instead of letting the client compare a "before" that isn't there.
  const hasAfterPhotos = (rep.photo_items ?? []).some((p) => p.kind === "after");
  const hasBeforePhotos = (rep.photo_items ?? []).some((p) => p.kind === "before");
  return (
    <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
      <h2 className="font-heading text-lg font-bold mb-2">Cleaning report</h2>
      {isPreview && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4" role="status">
          <p className="font-semibold">Preview — actions are disabled</p>
          <p className="text-sm text-muted-foreground">This is how the client page looks. Nothing you do here changes the visit: Approve, Report an issue and card actions are turned off in preview.</p>
        </div>
      )}
      {/* Cabinets audit (fix 1): the dispute status comes FIRST, above
          the card details — the client must see at a glance that the
          payment is paused, what they reported, and when we reply,
          before any "Card we'll charge" line. */}
      {rep.state === "issue_open" && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4" role="status">
          <p className="font-semibold mb-1">Issue received. Automatic payment is paused for this visit.</p>
          {rep.issue_room && <p className="text-sm">Room: {rep.issue_room}</p>}
          {rep.issue_reason && rep.issue_source === "client" && (
            <p className="text-sm">You told us: “{rep.issue_reason}”.</p>
          )}
          {typeof rep.issue_photo_count === "number" && (
            <p className="text-sm">
              {rep.issue_photo_count === 0
                ? "No photos attached to your message."
                : rep.issue_photo_count === 1
                  ? "1 photo attached to your message."
                  : `${rep.issue_photo_count} photos attached to your message.`}
            </p>
          )}
          <p className="text-sm mt-1">We&apos;ll confirm by email and reply within one business day.</p>
          <p className="text-sm">Questions? Email <a className="underline" href="mailto:hello@gatehousehomecleaning.com">hello@gatehousehomecleaning.com</a> or call <a className="underline" href="tel:+17705258599">(770) 525-8599</a>.</p>
        </div>
      )}
      <div className="rounded-xl border border-border bg-background p-4 mb-4">
        <dl className="space-y-1.5">
          {visitDate && (
            <div className="flex justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">Visit date</dt>
              <dd className="font-semibold text-right">{fmtDateUS(visitDate)}</dd>
            </div>
          )}
          {visitWindow && (
            <div className="flex justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">Arrival window (Atlanta time)</dt>
              <dd className="font-semibold text-right">{formatArrivalWindow(visitWindow)}</dd>
            </div>
          )}
          {rep.amount && (
            <div className="flex justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">This visit</dt>
              <dd className="font-semibold text-right">{rep.amount}</dd>
            </div>
          )}
          {cleanerName && (
            <div className="flex justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">Cleaned by</dt>
              {/* A5: the cleaner's photo next to the name — a generic
                  User icon when the roster has no photo (Danielle
                  Littles has none stored), so the client always sees
                  who cleaned, with or without a picture. */}
              <dd className="font-semibold text-right flex items-center gap-2">
                {cleanerPhoto ? (
                  <img src={cleanerPhoto} alt="" className="w-6 h-6 rounded-full object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                ) : (
                  <span className="w-6 h-6 rounded-full bg-muted flex items-center justify-center" aria-hidden="true"><User className="w-4 h-4 text-muted-foreground" /></span>
                )}
                {cleanerName}
              </dd>
            </div>
          )}
          {cardLabel && !isWaived && (
            <div className="flex justify-between gap-4 text-sm">
              {/* Cabinets audit (fix 1): while a dispute is open the
                  card is on file, not "to be charged" — the top block
                  already says the payment is paused. */}
              <dt className="text-muted-foreground">{visitState === "paid" ? "Card charged" : visitState === "issue_open" ? "Card on file" : "Card we'll charge"}</dt>
              <dd className="font-semibold text-right">
                {cardLabel}
                {cardActionable && (
                  <> · <Link to={`/save-card?bt=${encodeURIComponent(bt)}&mode=change`} className="underline inline-flex min-h-[44px] items-center">Change card</Link></>
                )}
              </dd>
            </div>
          )}
        </dl>
      </div>
      {rep.amount && (
        <p className="text-sm text-muted-foreground">Price confirmed for this visit.</p>
      )}
      {canAct && rep.state !== "awaiting" && (
        <div className="mb-4 rounded-xl border border-primary/40 bg-primary/5 p-4">
          {rep.state === "payment_issue" ? (
            <>
              <p className="font-semibold mb-1">Your payment didn&apos;t go through.</p>
              <p className="text-sm mb-3">
                Your bank declined the charge{rep.amount ? ` of ${rep.amount}` : ""}, or asks for an extra confirmation.
                Your cleaning is done — only the payment is outstanding. Try the same card again, or change it.
              </p>
              <div className="flex flex-wrap gap-2">
                {/* B: no retry charge for a future visit. */}
                {!isFutureVisit && (
                <Button variant="hero" disabled={busy} onClick={() => void act({ action: "approve" })}>
                  {busy ? "Processing payment…" : rep.amount ? `Try charging ${rep.amount} again` : "Try the charge again"}
                </Button>
                )}
                <Button variant="outline" asChild>
                  <Link to={`/save-card?bt=${encodeURIComponent(bt)}&mode=change`}>Change card</Link>
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setShowIssue((v) => !v)}>
                  Report an issue
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="font-semibold mb-1">We couldn&apos;t confirm your payment.</p>
              <p className="text-sm mb-3">
                Your payment may or may not have gone through — we don&apos;t know yet, so we&apos;re not showing
                this as paid or approved. Trying again first checks the payment status; you won&apos;t be charged twice.
              </p>
              <div className="flex flex-wrap gap-2">
                {/* B: no retry charge for a future visit. */}
                {!isFutureVisit && (
                <Button variant="hero" disabled={busy} onClick={() => void act({ action: "approve" })}>
                  {busy ? "Checking payment…" : rep.amount ? `Try charging ${rep.amount} again` : "Try the charge again"}
                </Button>
                )}
                <Button variant="outline" asChild>
                  <Link to={`/save-card?bt=${encodeURIComponent(bt)}&mode=change`}>Change card</Link>
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {isWaived && (
        <p className="mb-3 rounded-lg bg-sage/20 border border-sage/40 p-3 text-sm font-semibold">
          No charge for this visit — we&apos;ve reviewed your concern and closed this visit without charging your card. Nothing will be charged for this visit.
          {rep.issue_decision?.resolution ? (
            <> Our response: “{rep.issue_decision.resolution}”</>
          ) : null}
        </p>
      )}
      {rep.state === "issue_open" && !rep.issue_decision && (
        <p className="mb-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm">
          Automatic payment is paused for this visit — the details of your issue are shown above.
        </p>
      )}
      {rep.state === "issue_open" && rep.issue_decision && (
        <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm">
          {rep.issue_decision.decision === "payment_requested" ? (
            <p className="font-semibold mb-1">We&apos;ve reviewed your concern. Please review our response and approve the report when you&apos;re ready to pay.</p>
          ) : rep.issue_decision.decision === "reclean" ? (
            <p className="font-semibold mb-1">We&apos;ve reviewed your concern. We&apos;ll send you an updated report after the re-clean. Nothing will be charged unless you approve the report.</p>
          ) : (
            <p className="font-semibold mb-1">We&apos;ve reviewed your concern.</p>
          )}
          {rep.issue_decision.resolution ? (
            <p className="mb-1">Our response: “{rep.issue_decision.resolution}”</p>
          ) : null}
          {rep.issue_decision.decision === "reclean" && (rep.reclean_date || rep.resolution?.reclean_date) ? (
            <p className="mb-2">Re-clean agreed for <strong>{fmtDateUS(rep.reclean_date || rep.resolution?.reclean_date || "")}</strong>{rep.reclean_cleaner_name ? <> — {rep.reclean_cleaner_name}</> : null}.</p>
          ) : null}
          <p className="mb-3">Nothing will be charged until you approve — the automatic charge stays blocked for this visit.</p>
          {/* B: no Approve for a future visit (see the note above). */}
          {!isFutureVisit && (
          <Button variant="hero" disabled={busy} onClick={() => void act({ action: "approve" })}>
            {busy ? "Processing payment…" : rep.issue_decision.decision === "payment_requested" && rep.amount ? `Approve & Pay ${rep.amount}` : rep.amount ? `Resolve issue & pay ${rep.amount}` : "Everything is fine now — approve"}
          </Button>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Approving charges your saved card — only your explicit approval charges it now.</p>
        </div>
      )}
      {rep.state === "approved" && (
        <p className="mb-3 rounded-lg bg-sage/20 border border-sage/40 p-3 text-sm font-semibold">
          Approved — your payment is being completed{rep.amount ? ` — ${rep.amount} for this visit` : ""}. The receipt comes by email.
        </p>
      )}
      {rep.state === "paid" && (
        <p className="mb-3 rounded-lg bg-sage/20 border border-sage/40 p-3 text-sm font-semibold">
          Paid — thank you. {rep.receipt_sent ? "A receipt was emailed to you." : "Your receipt is on its way to your email."}
        </p>
      )}
      {rep.state === "refunded" && (
        <p className="mb-3 rounded-lg bg-muted border border-border p-3 text-sm font-semibold">
          Refunded — no charge stands for this visit. If you have any questions, reply to your receipt email or contact us.
        </p>
      )}
      <ReportContent
        photoItems={rep.photo_items ?? []}
        checklist={rep.checklist}
        excludedRooms={rep.no_photo_zones ?? []}
        renderPhoto={(p, _i, ctx) =>
          // M7: a null-url photo (the server could not sign it) renders
          // an honest placeholder — same wording as /report — instead
          // of a broken <img src="null">. The tile keeps its place in
          // the report, so the client sees what is missing, not a gap.
          !p.url ? (
            <div className="w-full rounded-lg border border-border bg-muted flex flex-col items-center justify-center gap-2 px-3 py-6 text-center">
              <p className="text-xs text-muted-foreground">
                This photo couldn&apos;t be loaded. The rest of the report is complete — email
                hello@gatehousehomecleaning.com and we&apos;ll resend it.
              </p>
              <button
                type="button"
                className="text-xs underline"
                onClick={() => reload()}
              >
                Try again
              </button>
            </div>
          ) : (
          <ZoomablePhoto
            src={p.url}
            alt={`${p.room ?? "Your home"} — ${p.kind === "before" ? "before" : "after"} cleaning`}
            photos={ctx.photos}
            index={ctx.index}
          >
            <figure>
              {/* Cabinets audit (fix 6): the grid loads the small
                  variant; the full size is requested only for zoom. */}
              <img src={p.thumb_url ?? p.url} alt={`${p.room ?? "Your home"} — ${p.kind === "before" ? "before" : "after"} cleaning`} className="w-full rounded-lg object-cover aspect-[4/3]" loading="lazy" onError={(e) => { if (p.thumb_url && e.currentTarget.src !== p.url) e.currentTarget.src = p.url; }} />
              <figcaption className="mt-1 text-xs text-muted-foreground">
                {ctx.frameLabel}{p.note ? ` — ${p.note}` : ""}
              </figcaption>
            </figure>
          </ZoomablePhoto>
          )
        }
      />
      {hasAfterPhotos && !hasBeforePhotos && (
        <p className="mb-3 text-sm text-muted-foreground">After photos only — no before photos were taken for this visit.</p>
      )}
      {rep.state === "awaiting" && rep.charge_timer_block_reason === "issue_ever" && (
        <p className="mb-3 text-sm">Automatic payment is paused for this visit because an issue was reported.</p>
      )}
      {rep.deadline && rep.state === "awaiting" && !rep.charge_timer_blocked && (
        <p className="mb-3 text-sm">
          Review by <strong>{fmtDeadline(rep.deadline)}</strong> (Atlanta time) — after that your saved card
          is charged automatically unless you report an issue. The charge runs after this deadline, at the
          next scheduled billing time — not at this exact minute.
        </p>
      )}
      {err && <p className="mb-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{err}</p>}
      {needsCardChoice && (
        <p className="mb-3 text-sm">
          <Link to={`/save-card?bt=${encodeURIComponent(bt)}`} className="underline font-semibold">Choose a card for this visit</Link>
        </p>
      )}
      {/* B: the visit has not happened yet — a report that exists for a
          future date cannot be approved or paid. The server rejects an
          early Approve; this explains why the button is gone. */}
      {isFutureVisit && canAct && (
        <p className="mb-3 rounded-lg border border-border bg-muted p-3 text-sm font-medium" role="status">
          This visit is on {visitDate ? fmtDateUS(visitDate) : "a future date"} — you can approve the report after the visit.
        </p>
      )}
      {canAct && rep.state === "awaiting" && (
        <div className="flex flex-wrap gap-2">
          {/* B: the Approve button is gone for a future visit (see the
              note above); "Report an issue" stays — the client can
              still flag a problem with the report. */}
          {!isFutureVisit && (
          <Button variant="hero" disabled={busy} onClick={() => void act({ action: "approve" })}>
            {busy ? "Processing payment…" : rep.amount ? `Approve & pay ${rep.amount}` : "Approve & pay"}
          </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => setShowIssue((v) => !v)}>
            Report an issue
          </Button>
        </div>
      )}
      {canAct && rep.state === "awaiting" && (
        <p className="mt-2 text-sm text-muted-foreground">Approving charges your saved card.</p>
      )}
      {canAct && rep.state === "awaiting" && (
        <p className="mt-2 text-sm text-muted-foreground">Not happy? Report an issue — the automatic charge is blocked until you approve again.</p>
      )}
      {canAct && showIssue && (
        <div className="mt-4">
          <IssueForm
            rooms={reportRooms}
            room={issueRoom}
            onRoom={setIssueRoom}
            text={issueText}
            onText={setIssueText}
            photoNote={issuePhotoNote}
            onPhotoPick={onPhotoPick}
            busy={busy}
            submitLabel="Send issue — pause payment"
            helper="Sending this pauses the automatic charge for this visit. We'll confirm by email and reply within one business day."
            onSubmit={() => void act({ action: "issue", reason: issueText.trim(), room: issueRoom.trim() })}
            onCancel={() => setShowIssue(false)}
          />
        </div>
      )}
      {/* C: the "Prefer the standalone page?" line is gone — the report
          already lives on this page; the standalone /report link is one
          tap away in the header-free cabinet, not a footer line. */}
    </div>
  );
}

const Visit = () => {
  const measuredStates = useRef(new Set<string>());
  const [searchParams] = useSearchParams();
  // One-time link token: resolved from the URL once, then stripped from
  // the address bar so it never reaches analytics (see tokenStrip.ts).
  const [bt] = useState<string>(() => resolveLinkToken("bt", "gh_visit_bt", searchParams.toString()));

  const [data, setData] = useState<VisitData | null>(null);
  const [loading, setLoading] = useState(true);
  const focusReport = useCallback((element: HTMLElement | null) => {
    if (element && window.location.hash === "#report") {
      element.scrollIntoView({ block: "start" });
    }
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // G6: a failed refetch must not wipe a loaded visit, and a network
  // failure must never be labeled an invalid link.
  const dataRef = useRef<VisitData | null>(null);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  const [proposed, setProposed] = useState("");
  const [cancelScope, setCancelScope] = useState<"once" | "stop">("once");
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [zones, setZones] = useState("");
  const [accessSaved, setAccessSaved] = useState(false);
  const [entryMethod, setEntryMethod] = useState<string | null>(null);
  const [entryNote, setEntryNote] = useState("");
  const [entrySecret, setEntrySecret] = useState("");
  const [entrySaved, setEntrySaved] = useState(false);

  const load = useCallback(async () => {
    if (!bt) {
      setData({ ok: false, state: "invalid_link" });
      setLoading(false);
      return;
    }
    // G6: loading, transient error, and invalid link are three distinct
    // states. A bad HTTP status or an unparsable body is a transient
    // failure (with Retry), never an "invalid link"; a failed refetch
    // keeps the last loaded visit and only notes the refresh failure.
    // A refetch never flashes the loading screen over loaded content.
    if (!dataRef.current) setLoading(true);
    try {
      const r = await fetch(`/api/visit?bt=${encodeURIComponent(bt)}`);
      let j: VisitData;
      try {
        j = (await r.json()) as VisitData;
      } catch {
        throw new Error("unparsable");
      }
      if (!r.ok || j.ok === false) {
        if (j.state === "invalid_link") {
          setData({ ok: false, state: "invalid_link" });
        } else {
          throw new Error("transient");
        }
      } else {
        setData(j);
        setZones(j.no_photo_zones ?? "");
        // Pre-fill from the booking choice when no visit-form choice
        // was saved yet (the quote-time method survives to /visit).
        setEntryMethod(j.entry?.method ?? toVisitMethod(j.entry_choice?.method ?? null));
        setEntryNote(j.entry?.note ?? j.entry_choice?.notes ?? "");
        setEntrySecret("");
        setEntrySaved(false);
      }
    } catch {
      const prev = dataRef.current;
      if (prev && prev.state !== "invalid_link" && prev.state !== "transient_error") {
        setError("Couldn't refresh your visit — showing the last loaded version. Try again in a moment.");
      } else {
        setData({ ok: false, state: "transient_error" });
      }
    }
    setLoading(false);
  }, [bt]);

  useEffect(() => {
    void load();
  }, [load]);

  // An already-open client page must pick up the owner's confirmation
  // without a manual reload: refetch when the tab becomes visible again.
  // No polling, no extra infrastructure — one fetch on return.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  // V7: returns whether the write actually landed, so callers never
  // show a success note after a failed save.
  const post = async (payload: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/visit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bt, ...payload }),
      });
      const j = (await r.json()) as VisitData & { ok: boolean; error?: string };
      if (j && j.state && j.state !== "invalid_link") {
        setData(j);
        setConfirmingCancel(false);
        return true;
      }
      setError("Something went wrong — please try again, or email hello@gatehousehomecleaning.com.");
      return false;
    } catch {
      setError("Something went wrong — please try again, or email hello@gatehousehomecleaning.com.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const [confirmingCard, setConfirmingCard] = useState(false);
  const confirmCard = async () => {
    if (!bt || confirmingCard) return;
    setConfirmingCard(true);
    setError("");
    try {
      const r = await fetch("/api/card-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bt, action: "confirm_card" }),
      });
      const j = (await r.json()) as { ok?: boolean };
      if (r.ok && j.ok) {
        await load();
      } else {
        setError("We couldn't confirm that card. Please try again, or add a different card.");
      }
    } catch {
      setError("We couldn't confirm that card. Please try again, or add a different card.");
    }
    setConfirmingCard(false);
  };

  useEffect(() => {
    if (!data || measuredStates.current.has(data.state)) return;
    const event = ({ confirmed: "gh_visit_confirmed_view", report_sent: "gh_report_view", paid: "gh_payment_success_view", issue_open: "gh_issue_status_view" } as const)[data.state as "confirmed" | "report_sent" | "paid" | "issue_open"];
    if (event && trackFunnel(event)) measuredStates.current.add(data.state);
  }, [data?.state]);

  const b = data?.booking ?? {};
  const fee = data?.cancel_fee_cents ?? 0;
  // P0-4: preview mode is read-only — the server refuses every action
  // for preview tokens; the action sections hide here too.
  const isPreview = data?.preview === true;
  const manageable =
    !isPreview && data && ["awaiting_confirmation", "confirmed", "date_declined"].includes(data.state);
  // B6: a passed date is reschedulable/cancellable like a pending one —
  // but entry and no-photo zones only apply to a live visit.
  const canReschedule =
    !isPreview && data && ["awaiting_confirmation", "confirmed", "date_declined", "date_passed"].includes(data.state);
  const cardChoiceNeeded = !isPreview && Boolean(data?.has_card && !data.card_confirmed
    && (data.state === "awaiting_confirmation" || data.state === "confirmed"));
  // H15: step 2 ("Cleaning") is the visit day itself — a confirmed
  // visit whose date is today (Atlanta time) is being cleaned today.
  // Any other confirmed visit stays on step 1.
  const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  // MB-29: a past date can never be confirmed (the server refuses it
  // later) — say so now instead of a generic error after the round trip.
  const requestProposedDate = () => {
    if (proposed && proposed < todayET) {
      setError("Please choose a future date — that date has already passed.");
      return;
    }
    void post({ action: "propose_date", date: proposed });
  };
  const isCleaningDay = data?.state === "confirmed" && b.confirmed_date === todayET;
  // H16: after a detach, has_card is false but the card_confirmed
  // journal event (and its last4) survives. The paid receipt line
  // ("Card charged") is a historical fact and still shows; a future
  // charge ("Card we'll charge") needs a card actually on file.
  const cardBrandLabel = data?.card_brand ? data.card_brand.replace(/\b\w/g, (c) => c.toUpperCase()) : "Card";
  const cardLabel = data?.card_last4 && (data?.state === "paid" ? data.card_confirmed : data.has_card)
    ? `${cardBrandLabel} ••••${data.card_last4}`
    : null;

  const rows: Array<[string, string]> = [];
  if (b.service) rows.push(["Service", b.service + (b.first_service === "deep" ? " · First visit: Deep clean" : "")]);
  // The rooms this visit covers — the same list the cleaner checklist
  // and the owner report show. A visit booked before the work scope
  // was stored has none, so the row is omitted.
  if (data?.rooms?.length) rows.push(["Rooms we'll clean", data.rooms.join(", ")]);
  if (b.confirmed_date) rows.push(["Visit date (confirmed)", fmtDateUS(b.confirmed_date)]);
  else if (b.requested_date) rows.push([data?.state === "date_passed" ? "Requested date (already passed)" : "Requested date — not confirmed yet", fmtDateUS(b.requested_date)]);
  if (b.window) rows.push(["Arrival window (Atlanta time)", formatArrivalWindow(b.window)]);
  if (b.first) rows.push(["This visit", b.first]);
  if (b.recurring) rows.push(["Then, per visit", b.recurring]);
  // Payment-method status without full details: brand + last 4 only,
  // shown once the card is confirmed for this booking. report_sent has
  // its own "Card we'll charge" line below, so it is excluded here to
  // avoid showing the card twice. A detached card is not "on file"
  // even though the card_confirmed journal event survives the detach
  // — has_card is the live gate for this prospective claim.
  if (data?.has_card && data.card_confirmed && data.card_last4 && data.state !== "cancelled" && data.state !== "report_sent") {
    rows.push(["Payment method", `${data.card_brand ? data.card_brand.replace(/\b\w/g, (c) => c.toUpperCase()) : "Card"} on file ••••${data.card_last4}`]);
  }

  return (
    <div className="page-shell min-h-[80vh] bg-background">
      <SEO
        url="https://www.gatehousehomecleaning.com/visit"
        title="Manage Your Visit | Gatehouse Home Cleaning"
        description="See your visit status, your cleaner, and manage your date — reschedule or cancel without refilling any forms."
        noindex
      />
      <div className="container max-w-2xl py-12 pb-24 md:pb-12">
        {/* MB-31: a small Refresh, reusing load() — the client waits on
            the owner's confirmation and should not have to reload the
            page (or leave the tab) to see it. */}
        {!loading && data && data.state !== "invalid_link" && data.state !== "transient_error" && (
          <div className="flex justify-end mb-2">
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="w-4 h-4 mr-1" /> Refresh
            </Button>
          </div>
        )}
        {!loading && data?.preview === true && (
          <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-left" role="status">
            <p className="font-semibold">Preview — actions are disabled</p>
            <p className="text-sm text-muted-foreground">This is how the client page looks. Nothing you do here changes the visit: date changes, entry details, cancel and card actions are turned off in preview.</p>
          </div>
        )}
        {loading && (
          <div className="text-center">
            <Loader2 className="w-16 h-16 text-sage-foreground mx-auto mb-6 animate-spin" aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Loading your visit…</h1>
          </div>
        )}

        {!loading && data?.state === "invalid_link" && (
          <div className="text-center">
            <AlertTriangle className="w-16 h-16 text-destructive mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">This link isn&apos;t valid</h1>
            <p className="text-lg text-foreground mb-6">
              The link may have expired or been copied incompletely. Email{" "}
              <a href="mailto:hello@gatehousehomecleaning.com" className="underline">hello@gatehousehomecleaning.com</a>{" "}
              and we&apos;ll send you a fresh one.
            </p>
          </div>
        )}

        {data?.notification_email_sent === false && <p role="status" className="rounded-xl border border-border bg-card p-4 mb-6">Your change is saved, but its email confirmation could not be sent. Your current status is shown here — you do not need to repeat the change.</p>}
        {!loading && data?.state === "transient_error" && (
          <div className="text-center">
            <AlertTriangle className="w-16 h-16 text-destructive mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Couldn&apos;t load your visit</h1>
            <p className="text-lg text-foreground mb-6">
              Something went wrong on our side or with your connection. Your link is fine — please try again.
            </p>
            <Button variant="hero" size="lg" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}

        {!loading && data && data.state !== "invalid_link" && data.state !== "transient_error" && (
          <div>
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4 text-center">
              {cardChoiceNeeded && data.state === "awaiting_confirmation"
                ? "Request received — confirm your card"
                : STATE_HEADLINE[data.state] ?? "Your visit"}
            </h1>
            {cardChoiceNeeded && (
              <div className="rounded-xl border border-amber-500/60 bg-amber-50 p-4 mb-6 text-left">
                <p className="font-semibold mb-1">Use your card on file for this booking?</p>
                <p className="text-sm text-foreground mb-3">
                  We found a card on file for your email
                  {data.card_last4 ? <> — <strong>{data.card_brand ? data.card_brand.replace(/\b\w/g, (c) => c.toUpperCase()) : "Card"} ending in ••••{data.card_last4}</strong></> : null}.
                  A card saved earlier is never used for a new booking without your say-so. Nothing is charged today.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="hero" disabled={confirmingCard || busy} onClick={() => void confirmCard()}>
                    {confirmingCard ? "Confirming…" : "Use this card for this booking"}
                  </Button>
                  <Button variant="outline" asChild>
                    <Link to={`/save-card?bt=${encodeURIComponent(bt)}&mode=change`}>Add a different card</Link>
                  </Button>
                </div>
                {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
              </div>
            )}
            {data.state !== "cancelled" && (
              <JourneySteps
                current={
                  // A paid visit is finished — every step is done, none is
                  // current. (current past the last index marks all done.)
                  data.state === "paid" ? STEPS_DONE
                  : ["card_needed", "card_failed", "awaiting_confirmation", "date_passed"].includes(data.state) ? 0
                  : data.state === "confirmed" && isCleaningDay ? 2
                  : ["confirmed", "date_declined"].includes(data.state) ? 1
                  : data.report_preparing ? 3
                  : 4
                }
              />
            )}

            {data.state === "card_needed" && (
              <p className="text-lg text-foreground mb-6 text-center">
                We have your request. Nothing is booked or charged yet — the next step is saving
                your card ($0 today). We confirm your date after that, within one business day.
              </p>
            )}
            {data.state === "date_passed" && (
              <p className="text-lg text-foreground mb-6 text-center">
                The date for this visit has already passed, so nothing is booked for that day and
                no card is needed. Pick a new date below, or cancel this visit — it&apos;s free.
                If you have any questions, email us and we&apos;ll reply within one business day.
              </p>
            )}
            {data.state === "awaiting_confirmation" && !cardChoiceNeeded && (
              <p className="text-lg text-foreground mb-6 text-center">
                Your requested date is{" "}
                <strong>not confirmed yet</strong> — we check it and reply within one business day.
                If it doesn&apos;t work, we&apos;ll offer alternatives here — no forms to refill.
              </p>
            )}
            {data.state === "card_failed" && (
              <p className="text-lg text-foreground mb-6 text-center">
                The card couldn&apos;t be saved, so nothing is booked yet. You can try again — your
                request details are kept.
              </p>
            )}
            {data.state === "date_declined" && (
              <p className="text-lg text-foreground mb-6 text-center">
                The date you picked doesn&apos;t work on our side. Pick one of the alternatives, or
                suggest your own — your request and your saved card stay exactly as they are, and
                nothing is charged.
              </p>
            )}
            {data.state === "payment_unknown" && (
              <p className="text-lg text-foreground mb-6 text-center">
                We couldn&apos;t confirm whether your payment went through — your visit isn&apos;t
                shown as approved or paid. Try again in the report section below: checking first
                makes sure you won&apos;t be charged twice.
              </p>
            )}
            {data.state === "cancelled" && (
              <p className="text-lg text-foreground mb-6 text-center">
                {data.cancelled_scope === "stop"
                  ? "This visit is cancelled. Your request to stop repeat visits is recorded. Gatehouse will confirm changes to any other separately confirmed visits."
                  : "This visit is cancelled. Any other confirmed visits are unchanged."}{" "}
                Your saved card stays on file for future bookings — email us any time to have it removed.
              </p>
            )}
            {data.state === "awaiting_confirmation" && !cardChoiceNeeded && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <p className="text-foreground font-semibold mb-1">Next step is ours.</p>
                <p className="text-sm text-muted-foreground">
                  Your card is saved — $0 charged today.
                  {data.confirm_by ? <> We&apos;ll confirm your cleaner and arrival window by <strong>{data.confirm_by}</strong>.</> : " We'll confirm your cleaner and arrival window by email within one business day."}
                </p>
                {data.scope_review_needed && (
                  <p className="text-sm text-muted-foreground mt-2">
                    We may check a couple of details with you before confirming. Your agreed
                    price won&apos;t change unless you agree to a change.
                  </p>
                )}
              </div>
            )}
            {data.report_preparing && data.state !== "report_sent" && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <p className="text-foreground font-semibold mb-1">Your cleaning is complete.</p>
                <p className="text-sm text-muted-foreground">
                  We&apos;re preparing your photo report. Your review period has not started —
                  it begins only when the report reaches you.
                </p>
              </div>
            )}
            {(data.state === "card_needed" || data.state === "card_failed") && (
              <div className="text-center mb-8">
                <Button variant="hero" size="lg" asChild>
                  <Link to={`/save-card?bt=${encodeURIComponent(bt)}&mode=change`}>Save card — $0 today</Link>
                </Button>
              </div>
            )}

            {(data.state === "report_sent" || data.state === "issue_open" || data.state === "approved" || data.state === "paid" || data.state === "payment_issue" || data.state === "payment_unknown" || data.state === "waived" || data.state === "refunded") && (
              <section ref={focusReport} id="report" className="scroll-mt-28">
                <ReportSection bt={bt} visitState={data.state} cleanerName={data.cleaner?.name ?? null} cleanerPhoto={data.cleaner?.photo ?? null} visitDate={b.confirmed_date || b.requested_date} visitWindow={b.window} cardLabel={cardLabel} onChanged={() => void load()} />
              </section>
            )}


            {rows.length > 0 && !["report_sent", "issue_open", "approved", "paid", "payment_issue", "payment_unknown", "waived", "refunded"].includes(data.state) && (
              <div className="rounded-xl border border-border bg-card p-4 text-left mb-6">
                <dl className="space-y-1.5">
                  {rows.map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-4 text-sm">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-semibold text-right">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}


            {data.cleaner && (data.state === "confirmed" || data.state === "awaiting_confirmation") && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 flex items-center gap-4">
                <span className="relative w-16 h-16 rounded-full bg-sage flex items-center justify-center shrink-0 overflow-hidden">
                  <User className="w-8 h-8 text-sage-foreground" aria-hidden="true" />
                  {data.cleaner.photo && (
                    <img src={data.cleaner.photo} alt="" className="absolute inset-0 w-16 h-16 rounded-full object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                  )}
                </span>
                <div className="text-left">
                  <p className="text-sm uppercase tracking-wide text-muted-foreground">Your cleaner</p>
                  <p className="font-heading text-xl font-bold">{data.cleaner.name}</p>
                  {data.cleaner.phone && (
                    <p className="text-sm">
                      <a className="underline" href={`tel:${data.cleaner.phone.replace(/\D/g, "")}`}>Call cleaner {data.cleaner.name}</a> · {data.cleaner.phone}
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">
                    An independent cleaning professional matched to your home by Gatehouse. If your
                    cleaner ever changes, we tell you before the visit — never a surprise stranger.
                  </p>
                </div>
              </div>
            )}

            {!data.cleaner && data.state === "confirmed" && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-2">Your cleaner</h2>
                <p className="text-sm text-foreground">Your cleaner hasn&apos;t been assigned yet — we&apos;ll email you when they&apos;re confirmed, before your visit.</p>
              </div>
            )}

            {(data.state !== "report_sent" && data.state !== "issue_open" && data.state !== "approved" && data.state !== "paid" && data.state !== "payment_issue" && data.state !== "payment_unknown" && data.state !== "waived" && data.state !== "refunded") && (
              <section ref={focusReport} id="report" className="scroll-mt-28 rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-2">Cleaning report</h2>
                <p className="text-sm text-foreground">Your photos and checklist will appear here after your cleaning.</p>
              </section>
            )}

            {(data.state === "confirmed" || data.state === "awaiting_confirmation") && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-2">Before your visit</h2>
                <ul className="list-disc pl-5 space-y-1 text-sm text-foreground">
                  <li>Tidy surfaces so the visit goes to cleaning, not sorting.</li>
                  <li>Secure pets, or tell us below where they&apos;ll be.</li>
                  <li>Entry: your booking choice is shown below — you can change it here and add private entry details after confirmation.</li>
                  <li>You&apos;re welcome to meet your cleaner on your first visit. If someone will be there to let them in, no entry codes are needed.</li>
                  <li>If anything about the arrival changes, we email you the same day.</li>
                </ul>
                <p className="text-sm text-muted-foreground mt-3">
                  If entry fails, we re-check your instructions, contact you and wait before marking the visit missed.
                  You can meet your cleaner in person — no code needed.
                </p>
              </div>
            )}

            {!isPreview && data.state === "confirmed" && data.entry_available && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-3">
                  How would you like to arrange entry?
                </h2>
                {!entryChoiceSettled(data.entry_choice?.method as EntryMethodChoice | null) && !data.entry?.method && (
                  <p className="mb-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm" role="status">
                    Entry not settled yet — We will email you to help arrange entry before your visit. You can also choose an option below.
                  </p>
                )}
                <p className="text-sm text-muted-foreground mb-3">
                  You&apos;re welcome to meet your cleaner on your first visit. If someone will be there to let them in, no entry codes are needed.
                </p>
                {data.entry_choice?.method && (
                  <p className="text-sm text-foreground mb-3">{`Your booking entry choice: ${entrySummaryLabel(data.entry_choice.method as EntryMethodChoice, data.entry_choice.detail as EntryDetailChoice | null).replace(/\.$/, "")}. You can change it below.`}</p>
                )}
                <div role="radiogroup" aria-label="How would you like to arrange entry?" className="space-y-2 mb-4">
                  {[
                    { key: "home", label: "I’ll be home to let the cleaner in." },
                    { key: "someone", label: "Someone else will meet the cleaner." },
                    { key: "arrange", label: "I’ll arrange entry before the visit." },
                  ].map((o) => (
                    <label key={o.key} className="flex min-h-[44px] items-center gap-2 text-sm">
                      <input type="radio" name="entry-method" value={o.key} checked={entryMethod === o.key} onChange={() => { setEntryMethod(o.key); setEntrySaved(false); }} className="h-5 w-5" />
                      {o.label}
                    </label>
                  ))}
                </div>
                {(entryMethod === "home" || entryMethod === "someone") && (
                  <p className="text-sm text-foreground mb-3">No codes or keys are needed for this choice. An optional note about intercom or parking is welcome below.</p>
                )}
                {entryMethod && (
                  <>
                    <label htmlFor="v-entry-note" className="block text-sm font-medium mb-1.5">Note about intercom or parking (optional)</label>
                    <input
                      id="v-entry-note" value={entryNote} onChange={(e) => setEntryNote(e.target.value)} maxLength={500}
                      className="w-full rounded-xl border border-border bg-background p-3 text-sm mb-3"
                      placeholder="e.g. Intercom at the front gate, park in the driveway"
                    />
                    <p className="text-sm text-muted-foreground mb-3">Notes are not encrypted — never put codes in the note. Codes go in Entry details below, which are encrypted.</p>
                  </>
                )}
                {entryMethod === "arrange" && (
                  <>
                    <label htmlFor="v-entry-secret" className="block text-sm font-medium mb-1.5">Entry details (optional — you can add these later)</label>
                    <input
                      id="v-entry-secret" value={entrySecret} onChange={(e) => setEntrySecret(e.target.value)} maxLength={1000}
                      className="w-full rounded-xl border border-border bg-background p-3 text-sm mb-3"
                      placeholder="e.g. Temporary guest code, lockbox location"
                    />
                    <p className="text-sm text-muted-foreground mb-3">If your lock supports a temporary guest code, use that. Never share your main alarm code.</p>
                  </>
                )}
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="hero" disabled={busy || !entryMethod}
                    onClick={() => {
                      setEntrySaved(false);
                      void post({ action: "save_entry", method: entryMethod, note: entryNote, secret: entryMethod === "arrange" ? entrySecret : "", secret_action: entryMethod === "arrange" ? (entrySecret ? "replace" : "keep") : undefined }).then((ok) => { setEntrySaved(ok); if (ok) setEntrySecret(""); });
                    }}
                  >
                    {entryMethod === "arrange" ? "Add entry details" : "Save entry choice"}
                  </Button>
                  {entryMethod === "arrange" && (
                    <Button
                      variant="outline" disabled={busy}
                      onClick={() => {
                        setEntrySaved(false);
                        void post({ action: "save_entry", method: "arrange", note: entryNote, secret: "", secret_action: "keep" }).then((ok) => { setEntrySaved(ok); setEntrySecret(""); });
                      }}
                    >
                      Add later
                    </Button>
                  )}
                  {data.entry?.method && (
                    <Button
                      variant="outline" disabled={busy}
                      onClick={() => {
                        setEntrySaved(false);
                        void post({ action: "delete_entry" }).then((ok) => { if (ok) { setEntryMethod(null); setEntryNote(""); setEntrySecret(""); setEntrySaved(true); } });
                      }}
                    >
                      Remove entry arrangement
                    </Button>
                  )}
                  <Button
                    variant="outline" disabled={busy}
                    onClick={() => {
                      setEntrySaved(false);
                      void post({ action: "set_entry_choice", method: "decide_later" }).then((ok) => { if (ok) { setEntryMethod(null); setEntryNote(""); setEntrySecret(""); setEntrySaved(true); } });
                    }}
                  >
                    I’ll decide later — please contact me
                  </Button>
                </div>
                {entrySaved && <p className="mt-3 text-sm text-sage-foreground" role="status">Saved.</p>}
                {data.entry?.has_secret && <p className="mt-3 text-sm text-foreground">Entry details are saved for this visit.</p>}
                <p className="mt-3 text-sm text-muted-foreground">
                  Entry details are encrypted and shown only to your assigned cleaner for this visit. Access ends when the visit is finished or cancelled, and entry details are deleted after the visit (visit date + 2 days at the latest). If your cleaner changes, the previous cleaner loses access and you will be asked to add details again. Removing the arrangement deletes it; editing only the note never deletes saved entry details.
                </p>
              </div>
            )}
            {manageable && (data.state !== "confirmed" || !data.entry_available) && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-3">Entry</h2>
                {data.state === "confirmed" ? (
                  <p className="text-sm text-foreground">You&apos;ll arrange entry here once your cleaner is assigned. Nothing secret is needed before then.</p>
                ) : (
                  <p className="text-sm text-foreground">You will arrange entry here after your visit is confirmed and your cleaner is assigned. Nothing secret is needed before then.</p>
                )}
                {data.entry_choice?.method === "decide_later" && (
                  <p className="mt-2 text-sm text-foreground">You chose to decide later — We will email you to help arrange entry before your visit.</p>
                )}
              </div>
            )}
            {manageable && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-3">
                  <CalendarClock className="inline w-5 h-5 mr-1 -mt-1" aria-hidden="true" />
                  Rooms you&apos;d rather we skip in photos
                </h2>
                <label htmlFor="v-zones" className="block text-sm font-medium mb-1.5">
                  Rooms you&apos;d rather we skip in photos (optional) — e.g. kids&apos; bedrooms.
                </label>
                <input
                  id="v-zones"
                  value={zones}
                  onChange={(e) => setZones(e.target.value)}
                  maxLength={200}
                  className="w-full rounded-xl border border-border bg-background p-3 text-sm mb-3"
                  placeholder="e.g. Home office, nursery"
                />
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setAccessSaved(false);
                    void post({ action: "update_access", no_photo_zones: zones }).then((ok) => setAccessSaved(ok));
                  }}
                >
                  Save
                </Button>
                {accessSaved && <span className="ml-3 text-sm text-sage-foreground">Saved.</span>}
              </div>
            )}

                        {!isPreview && data.state === "date_declined" && data.alt_dates && data.alt_dates.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-3">Dates that work for us</h2>
                <div className="flex flex-wrap gap-2">
                  {data.alt_dates.map((d) => (
                    <Button key={d} variant="hero" disabled={busy} onClick={() => void post({ action: "accept_alt_date", date: d })}>
                      {fmtDateUS(d)}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {canReschedule && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-3">Need a different date?</h2>
                <div className="flex flex-col sm:flex-row gap-3">
                  <input
                    type="date"
                    value={proposed}
                    min={todayET}
                    onChange={(e) => setProposed(e.target.value)}
                    className="rounded-xl border border-border bg-background p-3 text-sm"
                    aria-label="Propose a new date"
                  />
                  <Button variant="outline" disabled={busy || !proposed} onClick={() => requestProposedDate()}>
                    Request this date
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  {data.state === "date_passed"
                    ? "Your old date has already passed — pick any future date and we'll confirm it within one business day."
                    : "We confirm or offer the closest alternative within one business day. Your old date stays until the new one is confirmed."}
                </p>
                {data.proposed_pending && data.proposed_date && (
                  <p className="text-sm mt-3" role="status">
                    You asked for <strong>{fmtDateUS(data.proposed_date)}</strong> — we&apos;re checking it.
                    {b.confirmed_date ? <> Your confirmed date {fmtDateUS(b.confirmed_date)} stays until the new one is confirmed.</> : " Your request stays as it is until the new date is confirmed."}
                  </p>
                )}
              </div>
            )}

            {canReschedule && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-3">Cancel</h2>
                {!confirmingCancel ? (
                  <Button variant="outline" disabled={busy} onClick={() => setConfirmingCancel(true)}>
                    Cancel options…
                  </Button>
                ) : (
                  <div>
                    <div className="space-y-2 mb-3 text-sm">
                      <label className="flex gap-2 items-start">
                        <input type="radio" name="scope" checked={cancelScope === "once"} onChange={() => setCancelScope("once")} className="mt-1" />
                        <span><strong>Cancel this visit only.</strong> Any other confirmed visits stay unchanged.</span>
                      </label>
                      <label className="flex gap-2 items-start">
                        <input type="radio" name="scope" checked={cancelScope === "stop"} onChange={() => setCancelScope("stop")} className="mt-1" />
                        <span><strong>Cancel this visit and stop all future visits.</strong></span>
                      </label>
                    </div>
                    <p className="text-sm mb-3">
                      {data.state === "date_passed" ? (
                        <>Cancelling is <strong>free</strong> — this date has already passed, so there is no visit to miss.</>
                      ) : fee > 0 ? (
                        <>Cancelling now is inside 48 hours before the visit, so the <strong>$25 late-cancellation fee</strong> from our Terms applies.</>
                      ) : (
                        <>Cancelling now is <strong>free</strong> — more than 48 hours before the visit.</>
                      )}
                    </p>
                    <div className="flex flex-col sm:flex-row gap-3">
                      <Button variant="hero" disabled={busy} onClick={() => void post({ action: "cancel", scope: cancelScope })}>
                        {busy ? "Working…" : fee > 0 ? "Yes, cancel — $25 fee applies" : "Yes, cancel — no fee"}
                      </Button>
                      <Button variant="outline" disabled={busy} onClick={() => setConfirmingCancel(false)}>
                        Keep my visit
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {error && <p className="text-sm text-destructive mb-4 text-center" role="alert">{error}</p>}

            {/* C: the "Questions about your visit? Email hello@…" line
                is gone — the same address already sits in the page
                footer, so it duplicated it. */}
            {data.state === "confirmed" && (
              <p className="text-center mt-4">
                <CheckCircle className="inline w-4 h-4 text-sage-foreground mr-1" aria-hidden="true" />
                <span className="text-sm">You&apos;re all set. See you soon.</span>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Visit;
