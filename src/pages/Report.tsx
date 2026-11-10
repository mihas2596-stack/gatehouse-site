import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, Camera, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";
import { ReportContent, ZoomablePhoto } from "@/components/ReportContent";
import { fmtDateUS } from "@/lib/formatDate";

type ReportStateName =
  | "invalid_link"
  | "transient_error"
  | "not_ready"
  | "awaiting"
  | "approved"
  | "issue_open"
  | "paid"
  | "payment_issue"
  | "payment_unknown"
  | "waived";

type PhotoItem = { url: string; room?: string; note?: string; kind?: string };

type ReportData = {
  ok: boolean;
  state: ReportStateName;
  booking?: { first?: string; service?: string; date?: string };
  photos?: string[];
  photo_items?: PhotoItem[];
  amount?: string | null;
  amount_cents?: number | null;
  report_sent_at?: string | null;
  publication_id?: string | null;
  deadline?: string | null;
  delivery_failed?: boolean;
  charge_timer_blocked?: boolean;
  charge_timer_block_reason?: string | null;
  issue_reason?: string;
  // C10: "client" = the client's own words; "operator" (or missing) =
  // an operator note — operator notes are NEVER shown to the client:
  // only the client's own words render (as "You told us").
  issue_source?: string;
  issue_room?: string;
  no_photo_zones?: string[];
  receipt_sent?: boolean;
  checklist?: {
    rooms: Array<{ name: string; items: Array<{ label: string; done: boolean }>; skip_reason?: string }>;
    problem_note?: string;
  } | null;
  postpay_issue?: boolean;
  resolution?: { resolved_at: string; reclean_date: string } | null;
  // TASK 1 (fix6): the owner's latest decision on the issue —
  // payment_requested / reclean / waived, with its text. The open-
  // issue view renders its state from this.
  issue_decision?: { decision: string; resolution: string; decided_at: string } | null;
  error?: string;
  // Follow-up on an already-open issue: the server records it and
  // returns already=true; followup_recorded confirms it was saved.
  already?: boolean;
  followup_recorded?: boolean;
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

// The "Report an issue" form, shared by the awaiting view (first issue)
// and the open-issue view (follow-up on an already-open issue). Defined
// at module level so typing never remounts it and loses focus. The two
// uses differ only in the submit label and the helper text.
type IssueFormProps = {
  rooms: string[];
  room: string;
  onRoom: (v: string) => void;
  text: string;
  onText: (v: string) => void;
  photoNote: string;
  onPhotoPick: (file: File | null) => void;
  busy: boolean;
  submitLabel: string;
  helper: string;
  onSubmit: () => void;
  onCancel: () => void;
};

function IssueForm({ rooms, room, onRoom, text, onText, photoNote, onPhotoPick, busy, submitLabel, helper, onSubmit, onCancel }: IssueFormProps) {
  return (
    <div className="text-left">
      <label htmlFor="issue-room" className="block font-semibold mb-2">
        Which room?
      </label>
      <select
        id="issue-room"
        value={room}
        onChange={(e) => onRoom(e.target.value)}
        className="w-full rounded-xl border border-border bg-card p-3 text-sm mb-3"
      >
        <option value="">Choose a room…</option>
        {rooms.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
        <option value="Kitchen">Kitchen</option>
        <option value="Bathroom">Bathroom</option>
        <option value="Bedroom">Bedroom</option>
        <option value="Living areas">Living areas</option>
        <option value="Other">Other / not listed</option>
      </select>
      <label htmlFor="issue-text" className="block font-semibold mb-2">
        What isn&apos;t right?
      </label>
      <textarea
        id="issue-text"
        value={text}
        onChange={(e) => onText(e.target.value)}
        rows={4}
        maxLength={500}
        placeholder="Tell us what we missed — the automatic charge is blocked for this visit."
        className="w-full rounded-xl border border-border bg-card p-3 text-sm mb-3"
      />
      <label htmlFor="issue-photo" className="block font-semibold mb-2">
        Add a photo <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <input
        id="issue-photo"
        type="file"
        accept="image/*"
        onChange={(e) => onPhotoPick(e.target.files?.[0] ?? null)}
        className="w-full text-sm mb-1"
      />
      <p className="text-xs text-muted-foreground mb-2">
        Photos up to 1 MB each. If your photo is larger, take a screenshot of it first.
      </p>
      {photoNote && (
        <p className="text-xs text-muted-foreground mb-2">{photoNote}</p>
      )}
      <p className="text-xs text-muted-foreground mb-3">
        {helper}
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <Button variant="hero" size="lg" disabled={busy || !text.trim()} onClick={onSubmit}>
          {busy ? "Sending…" : submitLabel}
        </Button>
        <Button variant="outline" size="lg" disabled={busy} onClick={onCancel}>
          Back
        </Button>
      </div>
    </div>
  );
}

const Report = () => {
  const [searchParams] = useSearchParams();
  const bt = searchParams.get("bt") ?? "";

  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  // S13: Approve refused with card_confirmation_required — several
  // cards on file, none confirmed for this booking. The link below
  // leads to the existing confirm_card flow (/save-card).
  const [needsCardChoice, setNeedsCardChoice] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [paidIssueOpen, setPaidIssueOpen] = useState(false);
  // Follow-up on an already-open issue (issue_open state): same form,
  // separate toggle — the original issue stays open either way.
  const [followupOpen, setFollowupOpen] = useState(false);
  const [followupMsg, setFollowupMsg] = useState("");
  const [issueText, setIssueText] = useState("");
  const [issueRoom, setIssueRoom] = useState("");
  const [failedPhotos, setFailedPhotos] = useState<Set<string>>(new Set());
  const [issuePhoto, setIssuePhoto] = useState("");
  const [issuePhotoNote, setIssuePhotoNote] = useState("");

  // G6: a failed refetch must not wipe a loaded report, and a network
  // failure must never be labeled an invalid link.
  const dataRef = useRef<ReportData | null>(null);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const load = useCallback(async () => {
    if (!bt) {
      setData({ ok: false, state: "invalid_link" });
      setLoading(false);
      return;
    }
    // A refetch never flashes the loading screen over loaded content.
    if (!dataRef.current) setLoading(true);
    try {
      const r = await fetch(`/api/report?bt=${encodeURIComponent(bt)}`);
      let j: ReportData;
      try {
        j = (await r.json()) as ReportData;
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
      }
    } catch {
      const prev = dataRef.current;
      if (prev && prev.state !== "invalid_link" && prev.state !== "transient_error") {
        setActionError("Couldn't refresh your report — showing the last loaded version. Try again in a moment.");
      } else {
        setData({ ok: false, state: "transient_error" });
      }
    }
    setLoading(false);
  }, [bt]);

  useEffect(() => {
    void load();
  }, [load]);

  const onPhotoPick = (file: File | null) => {
    setIssuePhoto("");
    setIssuePhotoNote("");
    if (!file) return;
    if (file.size > 1_000_000) {
      // Too large to attach — the message itself still goes through.
      setIssuePhotoNote("That photo is large, so we'll send your message without it.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setIssuePhoto(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => setIssuePhotoNote("We couldn't attach that photo — your message will still be sent.");
    reader.readAsDataURL(file);
  };

  const act = async (action: "approve" | "issue") => {
    setBusy(true);
    setActionError("");
    setNeedsCardChoice(false);
    try {
      const r = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bt, action,
          // RA08: pay only for the publication this tab actually
          // showed. The server rejects a stale tab with report_changed
          // instead of charging for a newer report.
          seen_publication_id: action === "approve" ? (data?.publication_id ?? undefined) : undefined,
          reason: action === "issue" ? issueText : undefined,
          room: action === "issue" ? issueRoom : undefined,
          photo: action === "issue" && issuePhoto ? issuePhoto : undefined,
        }),
      });
      const j = (await r.json()) as ReportData;
      // S13: several cards on file, none confirmed for this booking —
      // the server refuses to guess. Lead to the existing confirm_card
      // flow instead of leaving a dead Approve button; no charge made.
      if (j && j.error === "card_confirmation_required") {
        if (j.state && j.state !== "invalid_link") setData(j);
        setNeedsCardChoice(true);
        setActionError("We found more than one card on file and can't tell which one is for this visit — no charge was made. Please choose which card to use for this booking.");
      // N26: the expired-window 409s carry no `state` (no view spread),
      // so they must be handled before the state gate below — otherwise
      // the client only gets the generic error. The form stays open so
      // the client can copy their text into the email.
      } else if (j && j.error === "issue_window_expired") {
        setActionError("The 24-hour window for reporting an issue on this report has passed — please email us at hello@gatehousehomecleaning.com and we'll look into it.");
      } else if (j && j.error === "claim_window_expired") {
        setActionError("The window for reporting an issue after this visit has passed — please email us at hello@gatehousehomecleaning.com and we'll look into it.");
      } else if (j && j.state && j.state !== "invalid_link") {
        setData(j);
        if (j.already === true && j.followup_recorded === true) {
          // A follow-up on an already-open issue was recorded by the
          // server (journal + owner email) — confirm it and clear the
          // fields instead of silently closing the form.
          setFollowupMsg("Thanks — we've added this to your open issue and emailed the team. We'll reply within one business day.");
          setFollowupOpen(false);
          setIssueText("");
          setIssueRoom("");
          setIssuePhoto("");
          setIssuePhotoNote("");
        } else if (j.already === true) {
          // Already open but the follow-up was NOT recorded — keep the
          // form open and say so honestly instead of pretending it went
          // through.
          setActionError("We couldn't save your note — please email hello@gatehousehomecleaning.com and we'll add it to your issue.");
        } else {
          setIssueOpen(false);
          setFollowupOpen(false);
          setIssueText("");
          setIssueRoom("");
          setIssuePhoto("");
          setIssuePhotoNote("");
        }
        if (j.error === "report_changed") {
          setActionError("This report was updated since you opened it — please review the latest version before approving. No charge was made.");
        }
        if (j.error === "payment_processing") {
          setActionError("Processing payment — a charge for this visit is already in progress. Please wait a moment and refresh; you won't be charged twice.");
        }
        // H1: the charge outcome is unknown — the payment may or may
        // not have gone through. Never show this as approved; the
        // retry re-checks the payment status first.
        if (j.error === "payment_unknown" || j.error === "payment_unconfirmed") {
          setActionError("We couldn't confirm whether your payment went through — please try again. You won't be charged twice; we'll check the payment status first.");
        }
        // TASK 1 (fix6): the visit was waived — closed without a
        // charge. The page now shows the waived state; say so plainly
        // instead of leaving the generic error.
        if (j.error === "charge_waived") {
          setActionError("This visit was closed without a charge — nothing will be charged for it.");
        }
      } else {
        setActionError("Something went wrong — please try again, or email hello@gatehousehomecleaning.com.");
      }
    } catch {
      setActionError("Something went wrong — please try again, or email hello@gatehousehomecleaning.com.");
    }
    setBusy(false);
  };

  const booking = data?.booking ?? {};
  const summaryRows: Array<[string, string]> = [];
  if (booking.service) summaryRows.push(["Service", booking.service]);
  if (booking.date) summaryRows.push(["Visit date", fmtDateUS(booking.date)]);
  if (data?.amount) summaryRows.push(["This visit", data.amount]);
  else if (booking.first) summaryRows.push(["First visit", booking.first]);

  // A sent report with no photos and no checklist is not ready to approve.
  const reportEmpty =
    (data?.photo_items?.length ?? 0) === 0 &&
    (data?.photos?.length ?? 0) === 0 &&
    (data?.checklist?.rooms?.length ?? 0) === 0;
  // H17: "before" photos may be absent (e.g. QA-era reports) — say so
  // instead of letting the client compare a "before" that isn't there.
  const hasAfterPhotos = (data?.photo_items ?? []).some((p) => p.kind === "after");
  const hasBeforePhotos = (data?.photo_items ?? []).some((p) => p.kind === "before");

  const summary = summaryRows.length > 0 && (
    <div className="rounded-xl border border-border bg-card p-4 text-left mb-6">
      <dl className="space-y-1.5">
        {summaryRows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 text-sm">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );

  // The photo report itself (photos + checklist + photo note), shared by
  // the awaiting view and the open-issue view: a client with an open
  // issue must still be able to see what was cleaned.
  const reportPhotos = (
    <>
      {data?.photo_items && data.photo_items.length > 0 ? (
        <div className="mb-6">
          <ReportContent
            photoItems={data.photo_items}
            checklist={data.checklist}
            excludedRooms={data.no_photo_zones ?? []}
            renderPhoto={(p) => (
              <figure>
                {failedPhotos.has(p.url) ? (
                  <div className="w-full h-40 md:h-52 rounded-xl border border-border bg-muted flex flex-col items-center justify-center gap-2 px-3 text-center">
                    <p className="text-xs text-muted-foreground">
                      This photo couldn&apos;t load. Check your connection, or email
                      hello@gatehousehomecleaning.com and we&apos;ll resend it.
                    </p>
                    <button
                      type="button"
                      className="text-xs underline"
                      onClick={() => void load()}
                    >
                      Try again
                    </button>
                  </div>
                ) : (
                  <ZoomablePhoto src={p.url} alt={`${p.room ?? "Your home"} — ${p.kind === "before" ? "before" : "after"} cleaning photo`}>
                    <img
                      src={p.url}
                      alt={`${p.room ?? "Your home"} — ${p.kind === "before" ? "before" : "after"} cleaning photo`}
                      loading="lazy"
                      onError={() => setFailedPhotos((prev) => new Set(prev).add(p.url))}
                      className="w-full h-40 md:h-52 object-cover rounded-xl border border-border"
                    />
                  </ZoomablePhoto>
                )}
                <figcaption className="text-xs text-muted-foreground mt-1">
                  <span className="font-semibold text-foreground">{p.kind === "before" ? "Before" : "After"}</span>
                  {p.note ? <> — {p.note}</> : null}
                </figcaption>
              </figure>
            )}
          />
        </div>
      ) : data?.photos && data.photos.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 mb-6">
          {data.photos.map((src, i) => (
            <ZoomablePhoto key={i} src={src} alt={`Cleaning photo ${i + 1}`}>
              <img
                src={src}
                alt={`Cleaning photo ${i + 1}`}
                loading="lazy"
                className="w-full h-40 md:h-52 object-cover rounded-xl border border-border"
              />
            </ZoomablePhoto>
          ))}
        </div>
      ) : (
        <p className="text-foreground mb-6 text-center">
          The photos for this visit are attached to the email we sent you.
        </p>
      )}
      {hasAfterPhotos && !hasBeforePhotos && (
        <p className="text-sm text-muted-foreground mb-6 text-left">After photos only — no before photos were taken for this visit.</p>
      )}
      <p className="text-xs text-muted-foreground mb-6 text-left">
        About these photos: they exist only for your private report. We photograph rooms, not
        people — faces, documents and screens are avoided. Only you and the Gatehouse team can
        open this page. Photos are kept for 90 days, then deleted, and never published without
        your separate written permission.
      </p>
    </>
  );

  // Rooms that appear in the report, for the issue-form room picker.
  const reportRooms = Array.from(new Set((data?.photo_items ?? []).map((p) => p.room).filter(Boolean) as string[]));

  return (
    <div className="page-shell min-h-[80vh] bg-background">
      <SEO
        url="https://www.gatehousehomecleaning.com/report"
        title="Your Cleaning Report | Gatehouse Home Cleaning"
        description="See the photo report of your cleaning. Your card is charged when you approve the report, or automatically 24 hours after the report is sent if you haven't reported an issue."
        noindex
      />
      <div className="container max-w-2xl py-12 pb-24 md:pb-12">
        {loading && (
          <div className="text-center">
            <Loader2 className="w-16 h-16 text-sage-foreground mx-auto mb-6 animate-spin" aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Loading your report…</h1>
          </div>
        )}

        {!loading && data?.state === "invalid_link" && (
          <div className="text-center">
            <AlertTriangle className="w-16 h-16 text-destructive mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">This link isn&apos;t valid</h1>
            <p className="text-lg text-foreground mb-6">
              The report link may have expired or been copied incompletely. Email{" "}
              <a href="mailto:hello@gatehousehomecleaning.com" className="underline">hello@gatehousehomecleaning.com</a>{" "}
              and we&apos;ll send you a fresh one.
            </p>
          </div>
        )}

        {!loading && data?.state === "transient_error" && (
          <div className="text-center">
            <AlertTriangle className="w-16 h-16 text-destructive mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Couldn&apos;t load your report</h1>
            <p className="text-lg text-foreground mb-6">
              Something went wrong on our side or with your connection. Your link is fine — please try again.
            </p>
            <Button variant="hero" size="lg" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}

        {!loading && data?.state === "not_ready" && (
          <div className="text-center">
            <Camera className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
              {data.delivery_failed ? "Your report email didn't arrive" : "Your report isn't ready yet"}
            </h1>
            {data.delivery_failed ? (
              <p className="text-lg text-foreground mb-6">
                We tried to email your photo report, but it couldn&apos;t be delivered — so the
                24-hour window has <strong>not</strong> started and no charge will happen until the
                report reaches you. Email{" "}
                <a href="mailto:hello@gatehousehomecleaning.com" className="underline">hello@gatehousehomecleaning.com</a>{" "}
                and we&apos;ll resend it another way.
              </p>
            ) : (
              <p className="text-lg text-foreground mb-6">
                Your photo report appears here after your cleaning. We&apos;ll email you when it&apos;s
                ready — this same link will then show your photos.
              </p>
            )}
            {summary}
          </div>
        )}

        {!loading && data?.state === "awaiting" && (
          <div>
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4 text-center">Your cleaning report</h1>
            <p className="text-lg text-foreground mb-6 text-center">
              Here&apos;s your home after the visit — check every room.
            </p>
            {summary}
            {reportPhotos}

{!reportEmpty && (<>
            {actionError && (
              <p className="text-sm text-destructive mb-4 text-center" role="alert">{actionError}</p>
            )}
            {needsCardChoice && (
              <p className="text-sm mb-4 text-center">
                <Link to={`/save-card?bt=${encodeURIComponent(bt)}`} className="underline font-semibold">Choose a card for this visit</Link>
              </p>
            )}
            {!issueOpen ? (
              <>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button variant="hero" size="lg" disabled={busy} onClick={() => void act("approve")}>
                  {busy ? "Processing payment…" : data.amount ? `Approve & pay ${data.amount}` : "Approve report"}
                </Button>
                <Button variant="outline" size="lg" disabled={busy} onClick={() => setIssueOpen(true)}>
                  Report an issue
                </Button>
              </div>
              <p className="mt-3 text-sm text-muted-foreground text-center">Approving charges your saved card.</p>
              </>
            ) : (
              <IssueForm
                rooms={reportRooms}
                room={issueRoom}
                onRoom={setIssueRoom}
                text={issueText}
                onText={setIssueText}
                photoNote={issuePhotoNote}
                onPhotoPick={onPhotoPick}
                busy={busy}
                submitLabel="Send — block auto-charge"
                helper="Sending this blocks the automatic charge for this visit. We&apos;ll confirm by email and reply within one business day."
                onSubmit={() => void act("issue")}
                onCancel={() => setIssueOpen(false)}
              />
            )}
            <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
              <p className="text-sm text-foreground">
                If everything looks good, approve above
                {data.amount ? <> — your card is then charged {data.amount}</> : null}.
                If something isn&apos;t right, report an issue and the automatic charge is blocked for this visit — it never runs on its own afterwards.
                {data.deadline && !data.charge_timer_blocked ? (
                  <> Review by <strong>{fmtDeadline(data.deadline)}</strong> (Atlanta time) — after that
                  your saved card is charged automatically unless you report an issue.</>
                ) : null}
                {data.charge_timer_block_reason === "issue_ever" ? (
                  <> Automatic payment is disabled for this visit because an issue was reported.</>
                ) : null}
              </p>
            </div>
</>)}
{reportEmpty && (
              <p className="text-foreground mb-6 text-center">This report isn&apos;t ready yet — it has no photos or checklist. Email <a href="mailto:hello@gatehousehomecleaning.com" className="underline">hello@gatehousehomecleaning.com</a> and we&apos;ll check it.</p>
            )}
          </div>
        )}

        {!loading && data?.state === "approved" && (
          <div className="text-center">
            <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Approved — thank you</h1>
            <p className="text-lg text-foreground mb-6">
              Your approval is recorded and your payment is being completed
              {data.amount ? <> — {data.amount} for this visit</> : booking.first ? <> — {booking.first} for this visit</> : null}.
              The receipt comes by email.
            </p>
            {data.resolution && (
              <p className="text-base text-foreground mb-6">
                Your earlier issue was marked resolved
                {data.resolution.reclean_date ? <> — re-clean agreed for <strong>{data.resolution.reclean_date}</strong></> : ""}.
                If anything is still off, email hello@gatehousehomecleaning.com.
              </p>
            )}
            <Button variant="hero" size="lg" asChild>
              <Link to="/">Back to Home</Link>
            </Button>
          </div>
        )}

        {!loading && data?.state === "issue_open" && (
          <div>
            <div className="text-center">
              <AlertTriangle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
              <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
                {data.issue_decision?.decision === "payment_requested"
                  ? "An update on your cleaning"
                  : data.issue_decision?.decision === "reclean"
                    ? "We're arranging your re-clean"
                    : "We're reviewing your concern"}
              </h1>
              <p className="text-lg text-foreground mb-6">
                {data.issue_decision?.decision === "payment_requested" ? (
                  <>We&apos;ve reviewed your concern. Please review our response and approve the report when you&apos;re ready to pay.</>
                ) : data.issue_decision?.decision === "reclean" ? (
                  <>We&apos;ve reviewed your concern. We&apos;ll send you an updated report after the re-clean. Nothing will be charged unless you approve the report.</>
                ) : (
                  <>Your payment is paused. We&apos;ll review what happened and reply within one business day. We aim to provide a decision within 72 hours. Nothing will be charged unless you approve the report.</>
                )}
                {data.issue_decision?.resolution ? (
                  <> Our response: “{data.issue_decision.resolution}”</>
                ) : null}
                {data.issue_room ? <> You flagged: <strong>{data.issue_room}</strong>.</> : null}
                {data.issue_reason && data.issue_source === "client" ? (
                  <> You told us: “{data.issue_reason}”</>
                ) : null}
              </p>
              {summary}
              {actionError && (
                <p className="text-sm text-destructive mb-4" role="alert">{actionError}</p>
              )}
              {needsCardChoice && (
                <p className="text-sm mb-4 text-center">
                  <Link to={`/save-card?bt=${encodeURIComponent(bt)}`} className="underline font-semibold">Choose a card for this visit</Link>
                </p>
              )}
              <p className="text-base text-foreground mb-6">
                {data.issue_decision?.decision === "payment_requested"
                  ? "Nothing will be charged until you approve — the automatic charge stays blocked for this visit."
                  : "Nothing will be charged while your issue is open — the automatic charge is blocked for this visit and will never run on its own. When you're satisfied, tap below to approve the report — that charges your saved card right away."}
              </p>
              <Button variant="hero" size="lg" disabled={busy} onClick={() => void act("approve")}>
                {busy ? "Processing payment…" : data.issue_decision?.decision === "payment_requested" && data.amount ? `Approve & Pay ${data.amount}` : data.amount ? `Resolve issue & pay ${data.amount}` : "Everything is fine now — approve"}
              </Button>
              <p className="mt-3 text-sm text-muted-foreground text-center">Approving charges your saved card — only your explicit approval charges it now.</p>
            </div>
            <div className="mt-8 text-center">
              {followupMsg && (
                <p className="text-sm text-foreground mb-4" role="status">{followupMsg}</p>
              )}
              {!followupOpen ? (
                <Button variant="outline" size="lg" disabled={busy} onClick={() => setFollowupOpen(true)}>
                  {data.issue_decision?.decision === "payment_requested" ? "My issue isn't resolved" : "Add more details"}
                </Button>
              ) : (
                <IssueForm
                  rooms={reportRooms}
                  room={issueRoom}
                  onRoom={setIssueRoom}
                  text={issueText}
                  onText={setIssueText}
                  photoNote={issuePhotoNote}
                  onPhotoPick={onPhotoPick}
                  busy={busy}
                  submitLabel="Send"
                  helper="This adds to your open issue — the charge stays blocked, and we'll reply within one business day."
                  onSubmit={() => void act("issue")}
                  onCancel={() => setFollowupOpen(false)}
                />
              )}
            </div>
            <div className="mt-10">
              <h2 className="font-heading text-2xl font-bold mb-4 text-center">Your report</h2>
              {reportPhotos}
            </div>
          </div>
        )}

        {!loading && data?.state === "waived" && (
          <div>
            <div className="text-center">
              <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
              <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">No charge for this visit</h1>
              <p className="text-lg text-foreground mb-6">
                We&apos;ve reviewed your concern and closed this visit without charging your card. Nothing will be charged for this visit.
                {data.issue_decision?.resolution ? (
                  <> Our response: “{data.issue_decision.resolution}”</>
                ) : null}
              </p>
              {summary}
              {actionError && (
                <p className="text-sm text-destructive mb-4" role="alert">{actionError}</p>
              )}
            </div>
            <div className="mt-10">
              <h2 className="font-heading text-2xl font-bold mb-4 text-center">Your report</h2>
              {reportPhotos}
            </div>
          </div>
        )}

        {!loading && data?.state === "payment_issue" && (
          <div className="text-center">
            <AlertTriangle className="w-16 h-16 text-destructive mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Your payment didn&apos;t go through</h1>
            <p className="text-lg text-foreground mb-6">
              Your bank declined the charge for this visit, or asks for an extra confirmation.
              Your cleaning is done — only the payment is outstanding. Update or confirm your
              card and we&apos;ll complete it.
            </p>
            {summary}
            {actionError && (
              <p className="text-sm text-destructive mb-4 text-center" role="alert">{actionError}</p>
            )}
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button variant="hero" size="lg" disabled={busy} onClick={() => void act("approve")}>
                {busy ? "Processing payment…" : data.amount ? `Try charging ${data.amount} again` : "Try the charge again"}
              </Button>
              <Button variant="outline" size="lg" asChild>
                <Link to={`/save-card?bt=${encodeURIComponent(bt)}`}>Update or confirm your card</Link>
              </Button>
            </div>
            <p className="mt-3 text-sm text-muted-foreground text-center">Approving charges your saved card.</p>
          </div>
        )}

        {!loading && data?.state === "payment_unknown" && (
          <div className="text-center">
            <AlertTriangle className="w-16 h-16 text-destructive mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">We couldn&apos;t confirm your payment</h1>
            <p className="text-lg text-foreground mb-6">
              Your payment may or may not have gone through — we don&apos;t know yet, so we&apos;re not showing
              this as paid or approved. Nothing has been confirmed either way.
            </p>
            {summary}
            {actionError && (
              <p className="text-sm text-destructive mb-4" role="alert">{actionError}</p>
            )}
            {needsCardChoice && (
              <p className="text-sm mb-4 text-center">
                <Link to={`/save-card?bt=${encodeURIComponent(bt)}`} className="underline font-semibold">Choose a card for this visit</Link>
              </p>
            )}
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button variant="hero" size="lg" disabled={busy} onClick={() => void act("approve")}>
                {busy ? "Checking payment…" : data.amount ? `Try charging ${data.amount} again` : "Try again"}
              </Button>
            </div>
            <p className="mt-3 text-sm text-muted-foreground text-center">
              Trying again first checks the payment status — you won&apos;t be charged twice. If this keeps
              happening, email hello@gatehousehomecleaning.com.
            </p>
          </div>
        )}

        {!loading && data?.state === "paid" && (
          <div className="text-center">
            <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Paid — thank you</h1>
            <p className="text-lg text-foreground mb-6">
              {data.receipt_sent
                ? "This visit is paid. Your receipt was emailed to you."
                : "This visit is paid. Your receipt is on its way to your email."}
            </p>
            {summary}
            {(data.photo_items && data.photo_items.length > 0) || (data.checklist && data.checklist.rooms.length > 0) ? (
              <div className="mb-6 text-left">
                <ReportContent
                  photoItems={data.photo_items ?? []}
                  checklist={data.checklist}
                  excludedRooms={data.no_photo_zones ?? []}
                  renderPhoto={(p) => (
                    <figure>
                      <ZoomablePhoto src={p.url} alt={`${p.room ?? "Your home"} — ${p.kind === "before" ? "before" : "after"} cleaning photo`}>
                        <img
                          src={p.url}
                          alt={`${p.room ?? "Your home"} — ${p.kind === "before" ? "before" : "after"} cleaning photo`}
                          loading="lazy"
                          className="w-full h-40 md:h-52 object-cover rounded-xl border border-border"
                        />
                      </ZoomablePhoto>
                      <figcaption className="text-xs text-muted-foreground mt-1">
                        <span className="font-semibold text-foreground">{p.kind === "before" ? "Before" : "After"}</span>
                        {p.note ? <> — {p.note}</> : null}
                      </figcaption>
                    </figure>
                  )}
                />
              </div>
            ) : null}
            {hasAfterPhotos && !hasBeforePhotos && (
              <p className="text-sm text-muted-foreground mb-6 text-left">After photos only — no before photos were taken for this visit.</p>
            )}
            {data.postpay_issue ? (
              <p className="text-base text-foreground mb-6">
                Your issue has been received. We&apos;ll review it and reply by email
                within one business day.
              </p>
            ) : !paidIssueOpen ? (
              <>
                <button
                  type="button"
                  className="text-sm underline text-muted-foreground"
                  onClick={() => setPaidIssueOpen(true)}
                >
                  Something wasn&apos;t right? Report an issue with this visit
                </button>
                <p className="mt-2 text-sm text-muted-foreground">
                  After payment, reporting an issue starts a review — we&apos;ll email you what happens next.
                </p>
              </>
            ) : (
              <div className="text-left max-w-md mx-auto">
                <p className="text-sm text-muted-foreground mb-3">
                  Your visit is already paid, so nothing is paused or reversed
                  automatically. Tell us what wasn&apos;t right — we&apos;ll review
                  it and reply by email within one business day.
                </p>
                <label htmlFor="paid-issue-room" className="block font-semibold mb-2">Which room?</label>
                <select
                  id="paid-issue-room"
                  className="w-full border border-border rounded-lg px-3 py-2 mb-3 bg-background"
                  value={issueRoom}
                  onChange={(e) => setIssueRoom(e.target.value)}
                >
                  <option value="">Choose a room…</option>
                  {Array.from(new Set((data.photo_items ?? []).map((p) => p.room).filter(Boolean))).map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                  <option value="Something else">Something else</option>
                </select>
                <label htmlFor="paid-issue-text" className="block font-semibold mb-2">What happened?</label>
                <textarea
                  id="paid-issue-text"
                  className="w-full border border-border rounded-lg px-3 py-2 mb-3 bg-background"
                  rows={3}
                  value={issueText}
                  onChange={(e) => setIssueText(e.target.value)}
                  placeholder="Tell us what wasn't right"
                />
                <label htmlFor="paid-issue-photo" className="block font-semibold mb-2">
                  Add a photo <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <input
                  id="paid-issue-photo"
                  type="file"
                  accept="image/*"
                  onChange={(e) => onPhotoPick(e.target.files?.[0] ?? null)}
                  className="w-full text-sm mb-1"
                />
                <p className="text-xs text-muted-foreground mb-2">
                  Photos up to 1 MB each. If your photo is larger, take a screenshot of it first.
                </p>
                {issuePhotoNote && (
                  <p className="text-xs text-muted-foreground mb-2">{issuePhotoNote}</p>
                )}
                {actionError && (
                  <p className="text-sm text-destructive mb-3" role="alert">{actionError}</p>
                )}
                <div className="flex gap-3">
                  <Button variant="hero" disabled={busy || !issueText.trim()} onClick={() => void act("issue")}>
                    {busy ? "Sending…" : "Send"}
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => setPaidIssueOpen(false)}>
                    Back
                  </Button>
                </div>
              </div>
            )}
            <div className="mt-6">
              <Button variant="hero" size="lg" asChild>
                <Link to="/">Back to Home</Link>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Report;
