import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, CalendarClock, AlertTriangle, Loader2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";

type VisitStateName =
  | "invalid_link"
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
    requested_date?: string;
    confirmed_date?: string;
    window?: string;
    first?: string;
    recurring?: string | null;
  };
  cleaner?: { name: string; photo: string } | null;
  alt_dates?: string[];
  cancel_fee_cents?: number;
  cancel_fee?: string;
  cancelled_scope?: string;
  access_notes?: string;
  no_photo_zones?: string;
  has_card?: boolean;
  report_preparing?: boolean;
  scope_review_needed?: boolean;
  confirm_by?: string;
  error?: string;
};

const STATE_HEADLINE: Record<string, string> = {
  card_needed: "Request received — one step left",
  card_failed: "Your card couldn't be saved",
  awaiting_confirmation: "Card saved — date not confirmed yet",
  confirmed: "Your visit is confirmed",
  date_declined: "That date doesn't work — pick another",
  report_sent: "Your visit is done — report sent",
  issue_open: "We're sorting out your issue",
  approved: "Visit approved",
  paid: "Paid — all done",
  payment_issue: "Your payment needs attention",
  cancelled: "Cancelled",
};

const Visit = () => {
  const [searchParams] = useSearchParams();
  const bt = searchParams.get("bt") ?? "";

  const [data, setData] = useState<VisitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proposed, setProposed] = useState("");
  const [cancelScope, setCancelScope] = useState<"once" | "stop">("once");
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [notes, setNotes] = useState("");
  const [zones, setZones] = useState("");
  const [accessSaved, setAccessSaved] = useState(false);

  const load = useCallback(async () => {
    if (!bt) {
      setData({ ok: false, state: "invalid_link" });
      setLoading(false);
      return;
    }
    try {
      const r = await fetch(`/api/visit?bt=${encodeURIComponent(bt)}`);
      const j = (await r.json()) as VisitData;
      setData(j);
      setNotes(j.access_notes ?? "");
      setZones(j.no_photo_zones ?? "");
    } catch {
      setData({ ok: false, state: "invalid_link" });
    }
    setLoading(false);
  }, [bt]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (payload: Record<string, unknown>) => {
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
      } else {
        setError("Something went wrong — please try again, or email hello@gatehousehomecleaning.com.");
      }
    } catch {
      setError("Something went wrong — please try again, or email hello@gatehousehomecleaning.com.");
    }
    setBusy(false);
  };

  const b = data?.booking ?? {};
  const fee = data?.cancel_fee_cents ?? 0;
  const manageable =
    data && ["awaiting_confirmation", "confirmed", "date_declined"].includes(data.state);

  const rows: Array<[string, string]> = [];
  if (b.service) rows.push(["Service", b.service]);
  if (b.confirmed_date) rows.push(["Visit date (confirmed)", b.confirmed_date]);
  else if (b.requested_date) rows.push(["Requested date — not confirmed yet", b.requested_date]);
  if (b.window) rows.push(["Arrival window (Atlanta time)", b.window]);
  if (b.first) rows.push(["First visit", b.first]);
  if (b.recurring) rows.push(["Then, per visit", b.recurring]);

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

        {!loading && data && data.state !== "invalid_link" && (
          <div>
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4 text-center">
              {STATE_HEADLINE[data.state] ?? "Your visit"}
            </h1>

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
            {(data.state === "report_sent" || data.state === "issue_open" || data.state === "approved" || data.state === "paid" || data.state === "payment_issue") && (
              <p className="text-lg text-foreground mb-6 text-center">
                Your cleaning is done — everything about payment lives on your report page.{" "}
                <Link to={`/report?bt=${encodeURIComponent(bt)}`} className="underline font-semibold">
                  Open your photo report
                </Link>
              </p>
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

            {(data.state === "card_needed" || data.state === "card_failed") && (
              <div className="text-center mb-8">
                <Button variant="hero" size="lg" asChild>
                  <Link to={`/save-card?bt=${encodeURIComponent(bt)}`}>Save card — $0 today</Link>
                </Button>
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
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Your cleaner</p>
                  <p className="font-heading text-xl font-bold">{data.cleaner.name}</p>
                  <p className="text-sm text-muted-foreground">
                    An independent cleaning professional matched to your home by Gatehouse. If your
                    cleaner ever changes, we tell you before the visit — never a surprise stranger.
                  </p>
                </div>
              </div>
            )}

            {(data.state === "confirmed" || data.state === "awaiting_confirmation") && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-2">Before your visit</h2>
                <ul className="list-disc pl-5 space-y-1 text-sm text-foreground">
                  <li>Tidy surfaces so the visit goes to cleaning, not sorting.</li>
                  <li>Secure pets, or tell us below where they&apos;ll be.</li>
                  <li>Access: add your entry instructions below — they&apos;re visible only to you and the Gatehouse team, never in public links or reports.</li>
                  <li>You don&apos;t need to be home if your access instructions are complete.</li>
                  <li>If anything about the arrival changes, we email you the same day.</li>
                </ul>
                <p className="text-sm text-muted-foreground mt-3">
                  If we can&apos;t get in: we re-check your instructions, try to reach you, and wait
                  before marking the visit missed. A visit we can&apos;t enter is charged as a full
                  visit under our Terms — so clear instructions really help.
                </p>
              </div>
            )}

            {manageable && (
              <div className="rounded-xl border border-border bg-card p-4 mb-6 text-left">
                <h2 className="font-heading text-lg font-bold mb-3">
                  <CalendarClock className="inline w-5 h-5 mr-1 -mt-1" aria-hidden="true" />
                  Access &amp; notes
                </h2>
                <label htmlFor="v-notes" className="block text-sm font-medium mb-1.5">
                  Entry instructions (gate code, lockbox, key…)
                </label>
                <textarea
                  id="v-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  maxLength={300}
                  className="w-full rounded-xl border border-border bg-background p-3 text-sm mb-3"
                  placeholder="e.g. Lockbox by the side door, code in your booking email — or: I'll be home."
                />
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
                    void post({ action: "update_access", notes, no_photo_zones: zones }).then(() => setAccessSaved(true));
                  }}
                >
                  Save instructions
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
