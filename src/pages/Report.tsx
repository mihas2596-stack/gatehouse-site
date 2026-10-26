import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, Camera, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";
import { ReportContent } from "@/components/ReportContent";

type ReportStateName =
  | "invalid_link"
  | "transient_error"
  | "not_ready"
  | "awaiting"
  | "approved"
  | "issue_open"
  | "paid"
  | "payment_issue";

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
  deadline?: string | null;
  delivery_failed?: boolean;
  charge_timer_blocked?: boolean;
  charge_timer_block_reason?: string | null;
  issue_reason?: string;
  issue_room?: string;
  receipt_sent?: boolean;
  checklist?: {
    rooms: Array<{ name: string; items: Array<{ label: string; done: boolean }>; skip_reason?: string }>;
    problem_note?: string;
  } | null;
  postpay_issue?: boolean;
  resolution?: { resolved_at: string; reclean_date: string } | null;
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

const Report = () => {
  const [searchParams] = useSearchParams();
  const bt = searchParams.get("bt") ?? "";

  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [issueOpen, setIssueOpen] = useState(false);
  const [paidIssueOpen, setPaidIssueOpen] = useState(false);
  const [issueText, setIssueText] = useState("");
  const [issueRoom, setIssueRoom] = useState("");
  const [zoom, setZoom] = useState<string | null>(null);
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
    try {
      const r = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bt, action,
          reason: action === "issue" ? issueText : undefined,
          room: action === "issue" ? issueRoom : undefined,
          photo: action === "issue" && issuePhoto ? issuePhoto : undefined,
        }),
      });
      const j = (await r.json()) as ReportData;
      if (j && j.state && j.state !== "invalid_link") {
        setData(j);
        setIssueOpen(false);
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
  if (booking.date) summaryRows.push(["Visit date", booking.date]);
  if (data?.amount) summaryRows.push(["This visit", data.amount]);
  else if (booking.first) summaryRows.push(["First visit", booking.first]);

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
            {data.photo_items && data.photo_items.length > 0 ? (
              <div className="mb-6">
                <ReportContent
                  photoItems={data.photo_items}
                  checklist={data.checklist}
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
                        <button type="button" className="block w-full" onClick={() => setZoom(p.url)} aria-label={`Enlarge ${p.room ?? "Your home"} photo`}>
                          <img
                            src={p.url}
                            alt={`${p.room ?? "Your home"} — ${p.kind === "before" ? "before" : "after"} cleaning photo`}
                            loading="lazy"
                            onError={() => setFailedPhotos((prev) => new Set(prev).add(p.url))}
                            className="w-full h-40 md:h-52 object-cover rounded-xl border border-border"
                          />
                        </button>
                      )}
                      <figcaption className="text-xs text-muted-foreground mt-1">
                        <span className="font-semibold text-foreground">{p.kind === "before" ? "Before" : "After"}</span>
                        {p.note ? <> — {p.note}</> : null}
                      </figcaption>
                    </figure>
                  )}
                />
              </div>
            ) : data.photos && data.photos.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 mb-6">
                {data.photos.map((src, i) => (
                  <img
                    key={i}
                    src={src}
                    alt={`Cleaning photo ${i + 1}`}
                    loading="lazy"
                    className="w-full h-40 md:h-52 object-cover rounded-xl border border-border"
                  />
                ))}
              </div>
            ) : (
              <p className="text-foreground mb-6 text-center">
                The photos for this visit are attached to the email we sent you.
              </p>
            )}
            <p className="text-xs text-muted-foreground mb-6 text-left">
              About these photos: they exist only for your private report. We photograph rooms, not
              people — faces, documents and screens are avoided. Only you and the Gatehouse team can
              open this page. Photos are kept for 90 days, then deleted, and never published without
              your separate written permission.
            </p>
            <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
              <p className="text-sm text-foreground">
                If everything looks good, approve below
                {data.amount ? <> — your card is then charged {data.amount}</> : null}.
                If something isn&apos;t right, report an issue and the charge stays paused while we
                make it right.
                {data.deadline && !data.charge_timer_blocked ? (
                  <> Review by <strong>{fmtDeadline(data.deadline)}</strong> (Atlanta time) — after that
                  your saved card is charged automatically unless you report an issue.</>
                ) : null}
                {data.charge_timer_block_reason === "issue_ever" ? (
                  <> Automatic payment is disabled for this visit because an issue was reported.</>
                ) : null}
              </p>
            </div>
            {actionError && (
              <p className="text-sm text-destructive mb-4 text-center" role="alert">{actionError}</p>
            )}
            {!issueOpen ? (
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button variant="hero" size="lg" disabled={busy} onClick={() => void act("approve")}>
                  {busy ? "Working…" : data.amount ? `Approve & pay ${data.amount}` : "Approve report"}
                </Button>
                <Button variant="outline" size="lg" disabled={busy} onClick={() => setIssueOpen(true)}>
                  Report an issue
                </Button>
              </div>
            ) : (
              <div className="text-left">
                <label htmlFor="issue-room" className="block font-semibold mb-2">
                  Which room?
                </label>
                <select
                  id="issue-room"
                  value={issueRoom}
                  onChange={(e) => setIssueRoom(e.target.value)}
                  className="w-full rounded-xl border border-border bg-card p-3 text-sm mb-3"
                >
                  <option value="">Choose a room…</option>
                  {Array.from(new Set((data.photo_items ?? []).map((p) => p.room).filter(Boolean) as string[])).map((r) => (
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
                  value={issueText}
                  onChange={(e) => setIssueText(e.target.value)}
                  rows={4}
                  maxLength={500}
                  placeholder="Tell us what we missed — the charge stays paused while we sort it out."
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
                {issuePhotoNote && (
                  <p className="text-xs text-muted-foreground mb-2">{issuePhotoNote}</p>
                )}
                <p className="text-xs text-muted-foreground mb-3">
                  Sending this pauses your charge. We&apos;ll confirm by email and reply within one
                  business day.
                </p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <Button variant="hero" size="lg" disabled={busy} onClick={() => void act("issue")}>
                    {busy ? "Sending…" : "Send — pause my charge"}
                  </Button>
                  <Button variant="outline" size="lg" disabled={busy} onClick={() => setIssueOpen(false)}>
                    Back
                  </Button>
                </div>
              </div>
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
          <div className="text-center">
            <AlertTriangle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Request received — charge paused</h1>
            <p className="text-lg text-foreground mb-6">
              We&apos;ve paused the charge for this visit. We&apos;ll reply within one business day —
              a confirmation is also in your email.
              {data.issue_room ? <> You flagged: <strong>{data.issue_room}</strong>.</> : null}
              {data.issue_reason ? <> “{data.issue_reason}”</> : null}
            </p>
            {actionError && (
              <p className="text-sm text-destructive mb-4" role="alert">{actionError}</p>
            )}
            <p className="text-base text-foreground mb-6">
              If the fix looks good, resolving the issue approves the report and charges your saved
              card{data.amount ? <> {data.amount}</> : null} right away.
            </p>
            <Button variant="hero" size="lg" disabled={busy} onClick={() => void act("approve")}>
              {busy ? "Working…" : data.amount ? `Resolve issue & pay ${data.amount}` : "Everything is fine now — approve"}
            </Button>
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
                {busy ? "Working…" : data.amount ? `Try charging ${data.amount} again` : "Try the charge again"}
              </Button>
              <Button variant="outline" size="lg" asChild>
                <Link to={`/save-card?bt=${encodeURIComponent(bt)}`}>Update or confirm your card</Link>
              </Button>
            </div>
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
                  renderPhoto={(p) => (
                    <figure>
                      <button type="button" className="block w-full" onClick={() => setZoom(p.url)} aria-label={`Enlarge ${p.room ?? "Your home"} photo`}>
                        <img
                          src={p.url}
                          alt={`${p.room ?? "Your home"} — ${p.kind === "before" ? "before" : "after"} cleaning photo`}
                          loading="lazy"
                          className="w-full h-40 md:h-52 object-cover rounded-xl border border-border"
                        />
                      </button>
                      <figcaption className="text-xs text-muted-foreground mt-1">
                        <span className="font-semibold text-foreground">{p.kind === "before" ? "Before" : "After"}</span>
                        {p.note ? <> — {p.note}</> : null}
                      </figcaption>
                    </figure>
                  )}
                />
              </div>
            ) : null}
            {data.postpay_issue ? (
              <p className="text-base text-foreground mb-6">
                Your issue has been received. We&apos;ll review it and reply by email
                within one business day.
              </p>
            ) : !paidIssueOpen ? (
              <button
                type="button"
                className="text-sm underline text-muted-foreground"
                onClick={() => setPaidIssueOpen(true)}
              >
                Something wasn&apos;t right? Report an issue with this visit
              </button>
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
        {zoom && (
          <div
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
            role="dialog"
            aria-label="Enlarged photo"
            onClick={() => setZoom(null)}
          >
            <img src={zoom} alt="Enlarged cleaning photo" className="max-w-full max-h-full object-contain rounded-lg" />
            <button
              type="button"
              className="absolute top-4 right-4 text-white text-sm bg-white/10 rounded-lg px-3 py-2"
              onClick={() => setZoom(null)}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Report;
