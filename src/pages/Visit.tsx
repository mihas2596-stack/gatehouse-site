import { trackFunnel } from "@/lib/measurement";
import { formatArrivalWindow } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, CalendarClock, AlertTriangle, Loader2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";
import JourneySteps from "@/components/JourneySteps";
import { ReportContent, ZoomablePhoto } from "@/components/ReportContent";
import { fmtDateUS } from "@/lib/formatDate";
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
  | "date_passed"
  | "cancelled";

type VisitData = {
  notification_email_sent?: boolean;
  ok: boolean;
  state: VisitStateName;
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
  // B6: the requested/confirmed date is already past — nothing is booked
  // for that day, and the client must pick a new date or cancel.
  date_passed: "That date has passed — pick a new one",
  cancelled: "Cancelled",
};

type ReportPhoto = { url: string; room?: string; note?: string; kind?: string };
type ReportChecklist = { rooms: Array<{ name: string; items: Array<{ label: string; done: boolean }>; skip_reason?: string }>; problem_note?: string };
type ReportData = {
  ok: boolean;
  state: string;
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
  // an operator note — never render it as "You told us".
  issue_source?: string;
  issue_room?: string;
  no_photo_zones?: string[];
  error?: string;
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
function ReportSection({ bt, visitState, cleanerName, visitDate, visitWindow, cardLabel, onChanged }: { bt: string; visitState: string; cleanerName?: string | null; visitDate?: string | null; visitWindow?: string | null; cardLabel?: string | null; onChanged: () => void }) {
  const [rep, setRep] = useState<ReportData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // S13: Approve refused with card_confirmation_required — several
  // cards on file, none confirmed for this booking. The link below
  // leads to the existing confirm_card flow (/save-card).
  const [needsCardChoice, setNeedsCardChoice] = useState(false);
  const [issueText, setIssueText] = useState("");
  const [issueRoom, setIssueRoom] = useState("");
  const [showIssue, setShowIssue] = useState(false);

  useEffect(() => {
    fetch(`/api/report?bt=${encodeURIComponent(bt)}`)
      .then((r) => r.json())
      .then((j) => setRep(j as ReportData))
      .catch(() => setRep({ ok: false, state: "not_ready" }));
  }, [bt]);

  const act = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setErr("");
    setNeedsCardChoice(false);
    try {
      const r = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bt,
          ...payload,
          // RA08: pay only for the publication this tab actually
          // showed; a stale tab gets report_changed, not a charge.
          ...(payload.action === "approve" ? { seen_publication_id: rep?.publication_id ?? undefined } : {}),
        }),
      });
      const j = (await r.json()) as ReportData & { ok: boolean };
      if (j && j.state && j.state !== "invalid_link") {
        setRep(j);
        onChanged();
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
        ) : (
          <p className="text-sm text-foreground">Your photos and checklist will appear here after your cleaning.</p>
        )}
      </div>
    );
  }
  // H1: an unknown charge outcome is actionable — the client must be
  // able to retry (the retry re-checks the payment status first).
  const canAct = rep.state === "awaiting" || rep.state === "payment_issue" || rep.state === "payment_unknown";
  const cardActionable = visitState === "report_sent" || visitState === "issue_open" || visitState === "payment_issue" || visitState === "payment_unknown";
  // H17: "before" photos may be absent (e.g. QA-era reports) — say so
  // instead of letting the client compare a "before" that isn't there.
  const hasAfterPhotos = (rep.photo_items ?? []).some((p) => p.kind === "after");
  const hasBeforePhotos = (rep.photo_items ?? []).some((p) => p.kind === "before");
  return (
    <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
      <h2 className="font-heading text-lg font-bold mb-2">Cleaning report</h2>
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
              <dd className="font-semibold text-right">{cleanerName}</dd>
            </div>
          )}
          {cardLabel && (
            <div className="flex justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">{visitState === "paid" ? "Card charged" : "Card we'll charge"}</dt>
              <dd className="font-semibold text-right">
                {cardLabel}
                {cardActionable && (
                  <> · <Link to={`/save-card?bt=${encodeURIComponent(bt)}&mode=change`} className="underline">Change card</Link></>
                )}
              </dd>
            </div>
          )}
        </dl>
      </div>
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
                <Button variant="hero" disabled={busy} onClick={() => void act({ action: "approve" })}>
                  {busy ? "Processing payment…" : rep.amount ? `Try charging ${rep.amount} again` : "Try the charge again"}
                </Button>
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
                <Button variant="hero" disabled={busy} onClick={() => void act({ action: "approve" })}>
                  {busy ? "Checking payment…" : rep.amount ? `Try charging ${rep.amount} again` : "Try the charge again"}
                </Button>
                <Button variant="outline" asChild>
                  <Link to={`/save-card?bt=${encodeURIComponent(bt)}&mode=change`}>Change card</Link>
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {rep.state === "issue_open" && (
        <p className="mb-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm">
          Issue reported — automatic payment is blocked for this visit.
          {rep.issue_reason ? (
            // C10: only the client's own words render as "You told us";
            // an operator note renders under a neutral label.
            rep.issue_source === "client" ? (
              <> You told us: “{rep.issue_reason}”.</>
            ) : (
              <> Our note: “{rep.issue_reason}”.</>
            )
          ) : null}
        </p>
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
      <ReportContent
        photoItems={rep.photo_items ?? []}
        checklist={rep.checklist}
        excludedRooms={rep.no_photo_zones ?? []}
        renderPhoto={(p) => (
          <ZoomablePhoto src={p.url} alt={`${p.room ?? "Your home"} — ${p.kind === "before" ? "before" : "after"} cleaning`}>
            <figure>
              <img src={p.url} alt={`${p.room ?? "Your home"} — ${p.kind === "before" ? "before" : "after"} cleaning`} className="w-full rounded-lg object-cover aspect-[4/3]" loading="lazy" />
              <figcaption className="mt-1 text-xs text-muted-foreground">
                {p.kind === "before" ? "Before" : "After"}{p.note ? ` — ${p.note}` : ""}
              </figcaption>
            </figure>
          </ZoomablePhoto>
        )}
      />
      {hasAfterPhotos && !hasBeforePhotos && (
        <p className="mb-3 text-sm text-muted-foreground">After photos only — no before photos were taken for this visit.</p>
      )}
      {rep.state === "awaiting" && rep.charge_timer_block_reason === "issue_ever" && (
        <p className="mb-3 text-sm">Automatic payment is disabled for this visit because an issue was reported.</p>
      )}
      {rep.deadline && rep.state === "awaiting" && !rep.charge_timer_blocked && (
        <p className="mb-3 text-sm">
          Review by <strong>{fmtDeadline(rep.deadline)}</strong> (Atlanta time) — after that your saved card
          is charged automatically unless you report an issue.
        </p>
      )}
      {err && <p className="mb-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{err}</p>}
      {needsCardChoice && (
        <p className="mb-3 text-sm">
          <Link to={`/save-card?bt=${encodeURIComponent(bt)}`} className="underline font-semibold">Choose a card for this visit</Link>
        </p>
      )}
      {canAct && rep.state === "awaiting" && (
        <div className="flex flex-wrap gap-2">
          <Button variant="hero" disabled={busy} onClick={() => void act({ action: "approve" })}>
            {busy ? "Processing payment…" : rep.amount ? `Approve & pay ${rep.amount}` : "Approve & pay"}
          </Button>
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
          <label htmlFor="v-issue" className="block text-sm font-medium mb-1.5">What&apos;s wrong?</label>
          <textarea
            id="v-issue"
            value={issueText}
            onChange={(e) => setIssueText(e.target.value)}
            rows={3}
            maxLength={500}
            className="w-full rounded-xl border border-border bg-background p-3 text-sm mb-2"
            placeholder="Tell us what needs a second look…"
          />
          <label htmlFor="v-issue-room" className="block text-sm font-medium mb-1.5">Room (optional)</label>
          <input
            id="v-issue-room"
            value={issueRoom}
            onChange={(e) => setIssueRoom(e.target.value)}
            maxLength={60}
            className="w-full rounded-xl border border-border bg-background p-3 text-sm mb-3"
            placeholder="e.g. Kitchen"
          />
          <Button variant="hero" disabled={busy || !issueText.trim()} onClick={() => void act({ action: "issue", reason: issueText.trim(), room: issueRoom.trim() })}>
            {busy ? "Sending…" : "Send issue — block auto-charge"}
          </Button>
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        Prefer the standalone page? <Link to={`/report?bt=${encodeURIComponent(bt)}`} className="underline">Open the full report page</Link>.
      </p>
    </div>
  );
}

const Visit = () => {
  const measuredStates = useRef(new Set<string>());
  const [searchParams] = useSearchParams();
  const bt = searchParams.get("bt") ?? "";

  const [data, setData] = useState<VisitData | null>(null);
  const [loading, setLoading] = useState(true);
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
  const manageable =
    data && ["awaiting_confirmation", "confirmed", "date_declined"].includes(data.state);
  // B6: a passed date is reschedulable/cancellable like a pending one —
  // but entry and no-photo zones only apply to a live visit.
  const canReschedule =
    data && ["awaiting_confirmation", "confirmed", "date_declined", "date_passed"].includes(data.state);
  const cardChoiceNeeded = Boolean(data?.has_card && !data.card_confirmed
    && (data.state === "awaiting_confirmation" || data.state === "confirmed"));
  // H15: step 2 ("Cleaning") is the visit day itself — a confirmed
  // visit whose date is today (Atlanta time) is being cleaned today.
  // Any other confirmed visit stays on step 1.
  const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
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
  if (b.confirmed_date) rows.push(["Visit date (confirmed)", fmtDateUS(b.confirmed_date)]);
  else if (b.requested_date) rows.push([data?.state === "date_passed" ? "Requested date (already passed)" : "Requested date — not confirmed yet", fmtDateUS(b.requested_date)]);
  if (b.window) rows.push(["Arrival window (Atlanta time)", formatArrivalWindow(b.window)]);
  if (b.first) rows.push(["First visit", b.first]);
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
                  ["card_needed", "card_failed", "awaiting_confirmation", "date_passed"].includes(data.state) ? 0
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
                Your card is saved and nothing is charged. Your requested date is{" "}
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
                    We may check a couple of scope details with you before confirming. Your agreed
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

            {(data.state === "report_sent" || data.state === "issue_open" || data.state === "approved" || data.state === "paid" || data.state === "payment_issue" || data.state === "payment_unknown") && (
              <section id="report" className="scroll-mt-28">
                <ReportSection bt={bt} visitState={data.state} cleanerName={data.cleaner?.name ?? null} visitDate={b.confirmed_date || b.requested_date} visitWindow={b.window} cardLabel={cardLabel} onChanged={() => void load()} />
              </section>
            )}


            {rows.length > 0 && !["report_sent", "issue_open", "approved", "paid", "payment_issue", "payment_unknown"].includes(data.state) && (
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
                <span className="w-16 h-16 rounded-full bg-sage flex items-center justify-center shrink-0">
                  <User className="w-8 h-8 text-sage-foreground" aria-hidden="true" />
                </span>
                <div className="text-left">
                  <p className="text-sm uppercase tracking-wide text-muted-foreground">Your cleaner</p>
                  <p className="font-heading text-xl font-bold">{data.cleaner.name}</p>
                  {data.cleaner.phone && (
                    <p className="text-sm">
                      <a className="underline" href={`tel:${data.cleaner.phone.replace(/\D/g, "")}`}>{data.cleaner.phone}</a>
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

            {(data.state !== "report_sent" && data.state !== "issue_open" && data.state !== "approved" && data.state !== "paid" && data.state !== "payment_issue" && data.state !== "payment_unknown") && (
              <section id="report" className="scroll-mt-28 rounded-xl border border-border bg-card p-4 mb-6 text-left">
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

            {data.state === "confirmed" && data.entry_available && (
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
                  <p className="text-sm text-foreground mb-3">Your booking entry choice: {entrySummaryLabel(data.entry_choice.method as EntryMethodChoice, data.entry_choice.detail as EntryDetailChoice | null)}. You can change it below.</p>
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
            {manageable && data.state !== "confirmed" && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-3">Entry</h2>
                <p className="text-sm text-foreground">You will arrange entry here after your visit is confirmed and your cleaner is assigned. Nothing secret is needed before then.</p>
                {data.entry_choice?.method === "decide_later" && (
                  <p className="mt-2 text-sm text-foreground">You chose to decide later — We will email you to help arrange entry before your visit.</p>
                )}
              </div>
            )}
            {manageable && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-3">
                  <CalendarClock className="inline w-5 h-5 mr-1 -mt-1" aria-hidden="true" />
                  Rooms not to photograph
                </h2>
                <label htmlFor="v-zones" className="block text-sm font-medium mb-1.5">
                  Rooms NOT to photograph (optional)
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

                        {data.state === "date_declined" && data.alt_dates && data.alt_dates.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-3">Dates that work for us</h2>
                <div className="flex flex-wrap gap-2">
                  {data.alt_dates.map((d) => (
                    <Button key={d} variant="hero" disabled={busy} onClick={() => void post({ action: "accept_alt_date", date: d })}>
                      {d}
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
                    onChange={(e) => setProposed(e.target.value)}
                    className="rounded-xl border border-border bg-background p-3 text-sm"
                    aria-label="Propose a new date"
                  />
                  <Button variant="outline" disabled={busy || !proposed} onClick={() => void post({ action: "propose_date", date: proposed })}>
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
                    You asked for <strong>{data.proposed_date}</strong> — we&apos;re checking it.
                    {b.confirmed_date ? <> Your confirmed date {b.confirmed_date} stays until the new one is confirmed.</> : " Your request stays as it is until the new date is confirmed."}
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
                        <span><strong>Cancel this visit and ask Gatehouse to stop repeat visits.</strong></span>
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

            <p className="text-sm text-muted-foreground text-center">
              Questions about your visit? Email{" "}
              <a href="mailto:hello@gatehousehomecleaning.com" className="underline">hello@gatehousehomecleaning.com</a>{" "}
              — we reply within one business day.
            </p>
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
