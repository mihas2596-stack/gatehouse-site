import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, Camera, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";

type ReportStateName =
  | "invalid_link"
  | "not_ready"
  | "awaiting"
  | "approved"
  | "issue_open"
  | "paid"
  | "payment_issue";

type ReportData = {
  ok: boolean;
  state: ReportStateName;
  booking?: { first?: string; service?: string; date?: string };
  photos?: string[];
  report_sent_at?: string | null;
  deadline?: string | null;
  delivery_failed?: boolean;
  issue_reason?: string;
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
  const [issueText, setIssueText] = useState("");

  const load = useCallback(async () => {
    if (!bt) {
      setData({ ok: false, state: "invalid_link" });
      setLoading(false);
      return;
    }
    try {
      const r = await fetch(`/api/report?bt=${encodeURIComponent(bt)}`);
      const j = (await r.json()) as ReportData;
      setData(j);
    } catch {
      setData({ ok: false, state: "invalid_link" });
    }
    setLoading(false);
  }, [bt]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: "approve" | "issue") => {
    setBusy(true);
    setActionError("");
    try {
      const r = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bt, action, reason: action === "issue" ? issueText : undefined }),
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
  if (booking.first) summaryRows.push(["First visit", booking.first]);

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
        description="See the photo report of your cleaning and approve it — your card is charged only after you approve, or automatically 24 hours after the report is sent if you haven't reported an issue."
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
            {data.photos && data.photos.length > 0 ? (
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
            <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
              <p className="text-sm text-foreground">
                If everything looks good, approve below
                {booking.first ? <> — your card is then charged {booking.first}</> : null}.
                If something isn&apos;t right, report an issue and the charge stays paused while we
                make it right.
                {data.deadline ? (
                  <> If we don&apos;t hear from you by <strong>{fmtDeadline(data.deadline)}</strong>,
                  the charge happens automatically, as agreed in the Terms.</>
                ) : null}
              </p>
            </div>
            {actionError && (
              <p className="text-sm text-destructive mb-4 text-center" role="alert">{actionError}</p>
            )}
            {!issueOpen ? (
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button variant="hero" size="lg" disabled={busy} onClick={() => void act("approve")}>
                  {busy ? "Working…" : "Approve report"}
                </Button>
                <Button variant="outline" size="lg" disabled={busy} onClick={() => setIssueOpen(true)}>
                  Report an issue
                </Button>
              </div>
            ) : (
              <div className="text-left">
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
              Your approval is recorded.
              {booking.first ? <> Your card will be charged {booking.first} for this visit.</> : null}{" "}
              The receipt comes by email.
            </p>
            <Button variant="hero" size="lg" asChild>
              <Link to="/">Back to Home</Link>
            </Button>
          </div>
        )}

        {!loading && data?.state === "issue_open" && (
          <div className="text-center">
            <AlertTriangle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Issue reported — charge paused</h1>
            <p className="text-lg text-foreground mb-6">
              We&apos;ve paused the charge for this visit. We&apos;ll review what you flagged and email
              you — if we missed something, we come back and fix it free.
            </p>
            {actionError && (
              <p className="text-sm text-destructive mb-4" role="alert">{actionError}</p>
            )}
            <Button variant="outline" size="lg" disabled={busy} onClick={() => void act("approve")}>
              {busy ? "Working…" : "Everything is fine now — approve"}
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
            <Button variant="hero" size="lg" asChild>
              <Link to={`/save-card?bt=${encodeURIComponent(bt)}`}>Update or confirm your card</Link>
            </Button>
          </div>
        )}

        {!loading && data?.state === "paid" && (
          <div className="text-center">
            <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Paid — thank you</h1>
            <p className="text-lg text-foreground mb-6">
              This visit is paid. Your receipt was emailed to you.
            </p>
            <Button variant="hero" size="lg" asChild>
              <Link to="/">Back to Home</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Report;
