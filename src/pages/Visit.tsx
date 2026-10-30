import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, CalendarClock, AlertTriangle, Loader2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";
import JourneySteps from "@/components/JourneySteps";
import { ReportContent } from "@/components/ReportContent";
import { toVisitMethod, entrySummaryLabel, type EntryMethodChoice, type EntryDetailChoice } from "@/config/entry";

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
  | "cancelled";

type VisitData = {
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
  entry_choice?: { method: string | null; detail: string | null; notes: string | null } | null;
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
  issue_room?: string;
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
function ReportSection({ bt, visitState, cleanerName, onChanged }: { bt: string; visitState: string; cleanerName?: string | null; onChanged: () => void }) {
  const [rep, setRep] = useState<ReportData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
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
        if (j.error === "report_changed") {
          setErr("This report was updated since you opened it — please review the latest version before approving. No charge was made.");
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
  const canAct = rep.state === "awaiting" || rep.state === "payment_issue";
  return (
    <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
      <h2 className="font-heading text-lg font-bold mb-2">Cleaning report</h2>
      {cleanerName && <p className="text-sm text-muted-foreground mb-3">Cleaned by {cleanerName}</p>}
      {canAct && (
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
                  {busy ? "Working…" : rep.amount ? `Try charging ${rep.amount} again` : "Try the charge again"}
                </Button>
                <Button variant="outline" asChild>
                  <Link to={`/save-card?bt=${encodeURIComponent(bt)}`}>Change card</Link>
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setShowIssue((v) => !v)}>
                  Report an issue
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="font-semibold mb-1">Your report is ready — approve to pay{rep.amount ? ` ${rep.amount}` : ""}, or report an issue to block the automatic charge.</p>
              {rep.deadline && !rep.charge_timer_blocked && (
                <p className="text-sm mb-3">Review by <strong>{fmtDeadline(rep.deadline)}</strong> (Atlanta time) — after that your saved card is charged automatically unless you report an issue.</p>
              )}
              {rep.charge_timer_block_reason === "issue_ever" && (
                <p className="text-sm mb-3">Automatic payment is disabled for this visit because an issue was reported.</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="hero" disabled={busy} onClick={() => void act({ action: "approve" })}>
                  {busy ? "Working…" : rep.amount ? `Approve & pay ${rep.amount}` : "Approve & pay"}
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setShowIssue((v) => !v)}>
                  Report an issue
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {rep.state === "issue_open" && (
        <p className="mb-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm">
          Issue received — the automatic charge is blocked for this visit.
          {rep.issue_reason ? <> You told us: “{rep.issue_reason}”.</> : null}
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
        renderPhoto={(p) => (
          <figure>
            <img src={p.url} alt={`${p.room ?? "Your home"} — ${p.kind === "before" ? "before" : "after"} cleaning`} className="w-full rounded-lg object-cover aspect-[4/3]" loading="lazy" />
            <figcaption className="mt-1 text-xs text-muted-foreground">
              {p.kind === "before" ? "Before" : "After"}{p.note ? ` — ${p.note}` : ""}
            </figcaption>
          </figure>
        )}
      />
      {rep.deadline && rep.state === "awaiting" && !rep.charge_timer_blocked && (
        <p className="mb-3 text-sm">
          Review by <strong>{fmtDeadline(rep.deadline)}</strong> (Atlanta time) — after that your saved card
          is charged automatically unless you report an issue.
        </p>
      )}
      {err && <p className="mb-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{err}</p>}
      {canAct && rep.state === "awaiting" && (
        <div className="flex flex-wrap gap-2">
          <Button variant="hero" disabled={busy} onClick={() => void act({ action: "approve" })}>
            {busy ? "Working…" : rep.amount ? `Approve & pay ${rep.amount}` : "Approve & pay"}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => setShowIssue((v) => !v)}>
            Report an issue
          </Button>
        </div>
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
            {busy ? "Working…" : "Send issue — block auto-charge"}
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

  const b = data?.booking ?? {};
  const fee = data?.cancel_fee_cents ?? 0;
  const manageable =
    data && ["awaiting_confirmation", "confirmed", "date_declined"].includes(data.state);

  const rows: Array<[string, string]> = [];
  if (b.service) rows.push(["Service", b.service + (b.first_service === "deep" ? " · First visit: Deep clean" : "")]);
  if (b.confirmed_date) rows.push(["Visit date (confirmed)", b.confirmed_date]);
  else if (b.requested_date) rows.push(["Requested date — not confirmed yet", b.requested_date]);
  if (b.window) rows.push(["Arrival window (Atlanta time)", b.window]);
  if (b.first) rows.push(["First visit", b.first]);
  if (b.recurring) rows.push(["Then, per visit", b.recurring]);
  // Payment-method status without full details: brand + last 4 only,
  // shown once the card is confirmed for this booking. report_sent has
  // its own "Card we'll charge" line below, so it is excluded here to
  // avoid showing the card twice.
  if (data?.card_confirmed && data.card_last4 && data.state !== "cancelled" && data.state !== "report_sent") {
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
              {STATE_HEADLINE[data.state] ?? "Your visit"}
            </h1>
            {data.has_card && !data.card_confirmed && (data.state === "awaiting_confirmation" || data.state === "confirmed") && (
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
                    <Link to={`/save-card?bt=${encodeURIComponent(bt)}`}>Add a different card</Link>
                  </Button>
                </div>
                {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
              </div>
            )}
            {data.state !== "cancelled" && (
              <JourneySteps
                current={
                  ["card_needed", "card_failed", "awaiting_confirmation"].includes(data.state) ? 0
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
            {data.state === "awaiting_confirmation" && (
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
            {data.state === "cancelled" && (
              <p className="text-lg text-foreground mb-6 text-center">
                {data.cancelled_scope === "stop"
                  ? "This visit and all future recurring visits are cancelled."
                  : "This visit is cancelled. Your recurring schedule, if you have one, stays in place."}{" "}
                Your saved card stays on file for future bookings — email us any time to have it removed.
              </p>
            )}
            {data.state === "awaiting_confirmation" && (
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
                  <Link to={`/save-card?bt=${encodeURIComponent(bt)}`}>Save card — $0 today</Link>
                </Button>
              </div>
            )}

            {(data.state === "report_sent" || data.state === "issue_open" || data.state === "approved" || data.state === "paid" || data.state === "payment_issue") && (
              <section id="report" className="scroll-mt-28">
                <ReportSection bt={bt} visitState={data.state} cleanerName={data.cleaner?.name ?? null} onChanged={() => void load()} />
              </section>
            )}


            {rows.length > 0 && (
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

            {data.state === "report_sent" && data.has_card && data.card_last4 && (
              <div className="rounded-xl border border-border bg-card p-4 text-left mb-6">
                <p className="text-sm">
                  Card we&apos;ll charge: <strong>{data.card_brand ? data.card_brand.replace(/\b\w/g, (c) => c.toUpperCase()) : "Card"} ••••{data.card_last4}</strong>
                  {" · "}
                  <Link to={`/save-card?bt=${encodeURIComponent(bt)}`} className="underline">Change card</Link>
                </p>
              </div>
            )}

            {data.cleaner && (data.state === "confirmed" || data.state === "awaiting_confirmation") && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 flex items-center gap-4">
                {data.cleaner.photo ? (
                  <img src={data.cleaner.photo} alt={data.cleaner.name} className="w-16 h-16 rounded-full object-cover border border-border" />
                ) : (
                  <span className="w-16 h-16 rounded-full bg-sage flex items-center justify-center shrink-0">
                    <User className="w-8 h-8 text-sage-foreground" aria-hidden="true" />
                  </span>
                )}
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

            {(data.state !== "report_sent" && data.state !== "issue_open" && data.state !== "approved" && data.state !== "paid" && data.state !== "payment_issue") && (
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
                  If we can&apos;t get in: we re-check your instructions, try to reach you, and wait
                  before marking the visit missed. A visit we can&apos;t enter is charged as a full
                  visit under our Terms — so clear instructions really help.
                </p>
              </div>
            )}

            {data.state === "confirmed" && data.entry_available && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-3">
                  How would you like to arrange entry?
                </h2>
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

            {manageable && (
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
                  We confirm or offer the closest alternative within one business day. Your old date
                  stays until the new one is confirmed.
                </p>
                {data.proposed_pending && data.proposed_date && (
                  <p className="text-sm mt-3" role="status">
                    You asked for <strong>{data.proposed_date}</strong> — we&apos;re checking it.
                    {b.confirmed_date ? <> Your confirmed date {b.confirmed_date} stays until the new one is confirmed.</> : " Your request stays as it is until the new date is confirmed."}
                  </p>
                )}
              </div>
            )}

            {manageable && (
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
                        <span><strong>Cancel this visit only.</strong> My recurring schedule stays in place.</span>
                      </label>
                      <label className="flex gap-2 items-start">
                        <input type="radio" name="scope" checked={cancelScope === "stop"} onChange={() => setCancelScope("stop")} className="mt-1" />
                        <span><strong>Cancel this visit and stop my recurring cleanings.</strong></span>
                      </label>
                    </div>
                    <p className="text-sm mb-3">
                      {fee > 0 ? (
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
