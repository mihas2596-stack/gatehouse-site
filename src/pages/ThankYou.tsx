import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { CheckCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";
import { formatDateLong } from "@/lib/utils";

type Plan = {
  service?: string;
  first?: number | null;
  recurring?: number | null;
  firstIsDeep?: boolean;
  founding?: boolean;
  afterFoundingRecurring?: number | null;
};

type SubmissionState = {
  submitted?: boolean;
  kind?: "booking" | "contact";
  customerEmailSent?: boolean;
  bt?: string;
  recap?: { price?: string; email?: string; date?: string; window?: string; status?: string; response?: string };
  plan?: Plan;
};

type CardState =
  | { kind: "checking" }
  | { kind: "needed" }
  | { kind: "saved" }
  | { kind: "confirmed"; date?: string; window?: string };

const ThankYou = () => {
  const { state } = useLocation();
  const submission = (state ?? {}) as SubmissionState;
  const received = submission.submitted === true;
  const isBooking = submission.kind === "booking";
  const bt = submission.bt ?? "";
  const plan = submission.plan ?? {};
  const recap = submission.recap ?? {};

  const [card, setCard] = useState<CardState>({ kind: bt ? "checking" : "needed" });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(false);

  // The merged finish step still never guesses card state: if the booking
  // already has a verified card (returning client, second tab), this page
  // shows the saved state instead of a second add-card button.
  useEffect(() => {
    if (!bt) return;
    let cancelled = false;
    fetch(`/api/card-status?bt=${encodeURIComponent(bt)}`)
      .then((r) => r.json())
      .then((data: { booking?: { has_card?: string; booking_confirmed?: string; confirmed_date?: string; confirmed_window?: string } | null }) => {
        if (cancelled) return;
        const b = data.booking;
        if (b?.has_card === "1" && b?.booking_confirmed === "1") {
          setCard({ kind: "confirmed", date: b.confirmed_date, window: b.confirmed_window });
        } else if (b?.has_card === "1") {
          setCard({ kind: "saved" });
        } else {
          setCard({ kind: "needed" });
        }
      })
      .catch(() => {
        if (!cancelled) setCard({ kind: "needed" });
      });
    return () => {
      cancelled = true;
    };
  }, [bt]);

  const startCard = async () => {
    if (!bt || starting) return;
    setStarting(true);
    setStartError(false);
    try {
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bt }),
      });
      const data = (await res.json()) as { ok?: boolean; url?: string };
      if (res.ok && data.ok && typeof data.url === "string") {
        window.location.href = data.url;
        return;
      }
      setStartError(true);
      setStarting(false);
    } catch {
      setStartError(true);
      setStarting(false);
    }
  };

  if (!received || !isBooking) {
    return (
      <div className="page-shell min-h-[80vh] flex items-center justify-center bg-background">
        <SEO url="https://www.gatehousehomecleaning.com/thank-you" title="Request Status | Gatehouse Home Cleaning" description="Next steps after contacting Gatehouse Home Cleaning." noindex />
        <div className="container text-center max-w-xl py-12 pb-24 md:pb-12">
          {received && <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />}
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
            {received ? "Message received" : "Ready to get in touch?"}
          </h1>
          <p className="text-lg text-foreground mb-6">
            {received
              ? "Thanks for your question. We reply by email within one business day."
              : "Use our quote or contact form to send a request. This page alone does not create a booking."}
          </p>
          <Button variant="hero" size="lg" asChild><Link to={received ? "/" : "/quote"}>{received ? "Back to Home" : "See My Price"}</Link></Button>
        </div>
      </div>
    );
  }

  if (card.kind === "saved" || card.kind === "confirmed") {
    return (
      <div className="page-shell min-h-[80vh] flex items-center justify-center bg-background">
        <SEO url="https://www.gatehousehomecleaning.com/thank-you" title="Request Status | Gatehouse Home Cleaning" description="Next steps after contacting Gatehouse Home Cleaning." noindex />
        <div className="container max-w-xl py-12 pb-24 text-center md:pb-12">
          <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Card saved. Your request is complete.</h1>
          <p className="text-lg text-foreground mb-6">
            {card.kind === "confirmed" ? (
              <>
                Your visit is confirmed
                {card.date ? <> for <strong>{formatDateLong(card.date)}</strong></> : null}
                {card.window ? <> · {card.window}</> : null}. Your card is charged when you approve
                your photo report, or 24 hours after we send it if you haven&apos;t reported an issue.
              </>
            ) : (
              <>We&apos;ll confirm availability for your requested date by email within one business day.</>
            )}
          </p>
          <Button variant="hero" size="lg" asChild>
            <Link to="/">Back to Home</Link>
          </Button>
        </div>
      </div>
    );
  }

  // Booking received: ONE finish step. Summary + one explanation + one
  // button that opens Stripe directly — no second save-card screen.
  const first = typeof plan.first === "number" ? plan.first : null;
  const recurring = typeof plan.recurring === "number" ? plan.recurring : null;
  return (
    <div className="page-shell min-h-[80vh] flex items-center justify-center bg-background">
      <SEO url="https://www.gatehousehomecleaning.com/thank-you" title="Finish Your Request | Gatehouse Home Cleaning" description="Add your card to finish your cleaning request. $0 charged today." noindex />
      <div className="container max-w-xl py-12 pb-24 md:pb-12">
        <div className="text-center">
          <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Finish your cleaning request</h1>
          {submission.customerEmailSent === false && (
            <p className="text-sm text-muted-foreground mb-6">
              Your request reached us safely — no need to send it again. The automatic confirmation email
              didn&apos;t go through (check your spam folder just in case); we&apos;ll still confirm
              everything by email within one business day.
            </p>
          )}
        </div>

        <div className="mb-8 rounded-xl border border-border bg-card p-6 text-left">
          <dl className="space-y-3 text-base">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4">
              <dt className="font-semibold">Service</dt>
              <dd>
                {plan.service ?? "Cleaning"}
                {plan.firstIsDeep ? " · first visit is a deep clean" : ""}
              </dd>
            </div>
            {first !== null && (
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <dt className="font-semibold">First visit</dt>
                <dd><strong>${first}</strong></dd>
              </div>
            )}
            {recurring !== null && (
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <dt className="font-semibold">Then</dt>
                <dd>
                  <strong>${recurring}</strong> per visit, every other week
                </dd>
              </div>
            )}
            {plan.founding && (
              <p className="text-sm text-muted-foreground">
                {recurring !== null
                  ? `Founding Clients price for your first 6 months${plan.afterFoundingRecurring ? ` — then $${plan.afterFoundingRecurring} per visit` : ""}.`
                  : "Founding Clients price — 30% off this visit."}
              </p>
            )}
            {recap.date && (
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <dt className="font-semibold">Requested date</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <span>
                    {formatDateLong(recap.date)}
                    {recap.window ? <> · {recap.window}</> : null}
                  </span>
                  <span className="rounded-full bg-peach/50 px-2.5 py-0.5 text-xs font-semibold">Awaiting confirmation</span>
                </dd>
              </div>
            )}
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 border-t border-border pt-3">
              <dt className="font-semibold">Due today</dt>
              <dd><strong>$0</strong></dd>
            </div>
          </dl>
        </div>

        <p className="mb-4 text-base leading-relaxed">
          After your cleaning, we&apos;ll email your photo report. We charge the agreed visit price
          {first !== null ? <> — <strong>${first}</strong> for your first visit</> : null} when you
          approve it, or 24 hours after we send it if you haven&apos;t reported an issue. Reporting
          an issue within that window pauses the charge until it&apos;s resolved.
        </p>
        <p className="mb-8 text-base leading-relaxed">
          Your card is only for paying after the cleaning. We confirm your date by email within one
          business day after you add it.
        </p>

        {startError && (
          <p className="mb-4 rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
            Something went wrong opening the secure card page. Your request is saved — please try
            again, or use the save-card link in your email.
          </p>
        )}
        <Button
          variant="hero"
          size="xl"
          className="w-full"
          onClick={startCard}
          disabled={starting || card.kind === "checking" || !bt}
        >
          {starting || card.kind === "checking" ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
              {card.kind === "checking" ? "Checking your request…" : "Opening Stripe…"}
            </>
          ) : (
            "Add card — $0 today"
          )}
        </Button>
        <p className="mt-3 text-center text-sm text-muted-foreground">
          You&apos;ll enter your card securely on Stripe. No Link account is required.
        </p>

        <p className="mt-8 text-sm leading-relaxed text-muted-foreground">
          Free cancellation until 48 hours before your visit; after that a $25 fee applies. If we
          arrive and can&apos;t get in — and can&apos;t reach you — the visit is charged in full.
          See our{" "}
          <Link to="/terms" className="font-semibold text-primary underline">Terms</Link>.
          Need to change something before then? Email{" "}
          <a href="mailto:hello@gatehousehomecleaning.com" className="font-semibold text-primary underline">
            hello@gatehousehomecleaning.com
          </a>
          .
        </p>
      </div>
    </div>
  );
};
export default ThankYou;
