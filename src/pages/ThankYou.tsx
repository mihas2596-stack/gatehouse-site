import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { CheckCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import ChooseNewVisitDate from "@/components/ChooseNewVisitDate";
import SEO from "@/components/SEO";
import { formatDateLong } from "@/lib/utils";
import { resolveLinkToken } from "@/lib/tokenStrip";
import { trackFunnel } from "@/lib/measurement";

type Plan = {
  service?: string;
  first?: number | null;
  recurring?: number | null;
};

type SubmissionState = {
  submitted?: boolean;
  kind?: "booking" | "contact" | "duplicate" | "custom";
  customerEmailSent?: boolean;
  bt?: string;
  recap?: { price?: string; email?: string; date?: string; window?: string; entry?: string; status?: string; response?: string };
  plan?: Plan;
  // N23: the server recalculated the total after the quote tab priced
  // it — the summary below already shows the server totals.
  serverPriceChanged?: boolean;
};

type SavedCardOption = { id: string; brand: string; last4: string; exp_month?: number; exp_year?: number };
type CardStatusBooking = {
  first?: string;
  recurring?: string;
  service?: string;
  first_service?: string;
  date?: string;
  has_card?: string;
  card_state?: string;
  card_confirmed?: string;
  card_brand?: string;
  card_last4?: string;
  booking_confirmed?: string;
  confirmed_date?: string;
  confirmed_window?: string;
  confirm_by?: string;
  visit_state?: string;
  cards?: SavedCardOption[];
};

// Card states, always driven by the server (card-status reconciles with
// Stripe itself). A URL parameter or a return from Stripe is never proof.
type CardState =
  | { kind: "checking"; slow: boolean }
  | { kind: "needed" }
  | { kind: "unknown" }
  | { kind: "cancelled" }
  | { kind: "failed" }
  | { kind: "saved"; booking: CardStatusBooking | null }
  | { kind: "choice"; booking: CardStatusBooking | null }
  | { kind: "confirmed"; booking: CardStatusBooking | null };

const fmtMoney = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
const parseMoney = (v?: string): number | null => {
  if (!v) return null;
  const n = parseFloat(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const ThankYou = () => {
  const { state } = useLocation();
  const [searchParams] = useSearchParams();
  const submission = (state ?? {}) as SubmissionState;

  // The booking token comes from the submit navigation, an explicit ?bt=
  // link, or this tab's session (so a refresh or a reopened tab still
  // shows the true status instead of a generic page). A token from the
  // URL is stripped from the address bar so it never reaches analytics
  // (see tokenStrip.ts).
  const [bt] = useState<string>(() => {
    if (submission.kind && submission.kind !== "booking") return "";
    if (submission.bt) return submission.bt;
    return resolveLinkToken("bt", "gh_last_bt", searchParams.toString());
  });
  useEffect(() => {
    if (submission.bt) {
      try {
        sessionStorage.setItem("gh_last_bt", submission.bt);
      } catch {
        /* private mode */
      }
    }
  }, [submission.bt]);

  const received = submission.submitted === true || bt !== "";
  const isBooking = submission.kind === "booking" || (submission.kind === undefined && bt !== "");
  const plan = submission.plan ?? {};
  const recap = submission.recap ?? {};

  const [card, setCard] = useState<CardState>({ kind: "checking", slow: false });
  // The server booking summary from the latest card-status response —
  // kept for EVERY state, so a revisit (no router state) still shows the
  // real service, price and requested date in states A and D too.
  const [statusBooking, setStatusBooking] = useState<CardStatusBooking | null>(null);
  // O-008: one fresh UUID per page mount, sent as request_id so a repeat
  // save-card attempt gets a fresh Stripe Checkout Session instead of
  // replaying the (possibly expired) one for this booking. Retries of
  // this same attempt reuse it, so Stripe replays the same session.
  const [setupAttempt] = useState(() => globalThis.crypto?.randomUUID?.());
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(false);
  const slowTimer = useRef<number | null>(null);

  const checkCard = useCallback(() => {
    if (!bt) {
      setCard({ kind: "needed" });
      return;
    }
    setCard({ kind: "checking", slow: false });
    if (slowTimer.current) window.clearTimeout(slowTimer.current);
    slowTimer.current = window.setTimeout(() => {
      setCard((c) => (c.kind === "checking" ? { kind: "checking", slow: true } : c));
    }, 8000);
    fetch(`/api/card-status?bt=${encodeURIComponent(bt)}`)
      .then((r) => r.json())
      .then((data: { booking?: CardStatusBooking | null }) => {
        if (slowTimer.current) window.clearTimeout(slowTimer.current);
        const b = data.booking ?? null;
        setStatusBooking(b);
        if (!b) { setCard({ kind: "unknown" }); }
        else if (b.visit_state === "cancelled") { setCard({ kind: "cancelled" }); }
        else if (b?.has_card === "1" && b?.booking_confirmed === "1") {
          setCard({ kind: "confirmed", booking: b });
        } else if (b?.has_card === "1" && b?.card_confirmed === "1") {
          setCard({ kind: "saved", booking: b });
        } else if (b?.has_card === "1") {
          // §3: a card on file is NOT a confirmation for this booking —
          // the client must explicitly choose it (or a different card).
          setCard({ kind: "choice", booking: b });
        } else if (b?.card_state === "card_failed") {
          setCard({ kind: "failed" });
        } else {
          setCard({ kind: "needed" });
        }
      })
      .catch(() => {
        if (slowTimer.current) window.clearTimeout(slowTimer.current);
        setCard({ kind: "unknown" });
      });
  }, [bt]);

  useEffect(() => {
    if (!isBooking) return;
    checkCard();
    return () => {
      if (slowTimer.current) window.clearTimeout(slowTimer.current);
    };
  }, [checkCard, isBooking]);

  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState(false);
  const [confirmUnavailable, setConfirmUnavailable] = useState(false);
  const [selectedCard, setSelectedCard] = useState("");
  const confirmCard = async () => {
    if (!bt || confirming) return;
    setConfirming(true);
    setConfirmError(false);
    setConfirmUnavailable(false);
    try {
      const res = await fetch("/api/card-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bt, action: "confirm_card", ...(selectedCard ? { payment_method_id: selectedCard } : {}) }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setCard((c) => (c.kind === "choice" ? { kind: "saved", booking: c.booking } : c));
        // P1-1: the same gh_card_saved event SaveCard fires on an
        // explicit confirm — once per booking (the bt token is hashed
        // inside trackFunnel, never stored or sent).
        trackFunnel("gh_card_saved", { form_type: "quote" }, bt);
      } else if (data.error === "card_unavailable") {
        // The chosen card disappeared between the list and the
        // confirm: re-read the list and say so.
        setConfirmUnavailable(true);
        setSelectedCard("");
        checkCard();
      } else {
        setConfirmError(true);
      }
    } catch {
      setConfirmError(true);
    } finally {
      setConfirming(false);
    }
  };

  const startCard = async () => {
    if (!bt || starting) return;
    setStarting(true);
    setStartError(false);
    try {
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bt, ...(setupAttempt ? { request_id: setupAttempt } : {}) }),
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

  if (submission.kind === "duplicate" || submission.kind === "custom") {
    const duplicate = submission.kind === "duplicate";
    return (
      <div className="page-shell readable-flow min-h-[80vh] bg-background">
        <SEO url="https://www.gatehousehomecleaning.com/thank-you" title="Request Status | Gatehouse Home Cleaning" description="Next steps for your cleaning request." noindex />
        <div className="container max-w-xl py-12 text-center">
          <h1 className="mb-4 font-heading text-3xl font-bold">{duplicate ? "We already have your request" : "Custom quote requested"}</h1>
          <p className="mb-4 text-lg">{duplicate
            ? "We haven’t booked a second visit."
            : "We’ll email you your price before you choose a card or confirm a visit. Nothing is charged today."}</p>
          {duplicate && submission.customerEmailSent !== false && <p className="mb-4">If you received a confirmation email, open its private link for your next step.</p>}
          <p>{submission.customerEmailSent === false ? "Your request was saved, but the confirmation email could not be sent. For help with your request, " : "Need help finding your request? "}
            <a className="text-primary underline" href="mailto:hello@gatehousehomecleaning.com">Email Gatehouse</a>.
          </p>
        </div>
      </div>
    );
  }

  if (!received || !isBooking) {
    return (
      <div className="page-shell readable-flow min-h-[80vh] bg-background">
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
          {received && submission.customerEmailSent === false && <p role="status" className="mb-6">Your message reached us. The automatic email confirmation could not be sent. There is no need to send your message again.</p>}
          <Button variant="hero" size="lg" asChild><Link to={received ? "/" : "/quote"}>{received ? "Back to Home" : "See My Price"}</Link></Button>
        </div>
      </div>
    );
  }

  // Summary values: the fresh submission wins; a revisit falls back to the
  // server-verified booking summary from card-status.
  const cardBooking = card.kind === "saved" || card.kind === "confirmed" || card.kind === "choice" ? card.booking : null;
  const summaryBooking = statusBooking ?? cardBooking;
  const first = typeof plan.first === "number" ? plan.first : parseMoney(summaryBooking?.first ?? recapPriceFirst(recap.price));
  const recurring = typeof plan.recurring === "number" ? plan.recurring : parseMoney(summaryBooking?.recurring);
  const serviceLabel = plan.service ?? summaryBooking?.service ?? "Cleaning";
  const requestedDate = recap.date ?? summaryBooking?.date ?? "";
  const confirmedDate = card.kind === "confirmed" ? card.booking?.confirmed_date ?? "" : "";
  const confirmedWindow = card.kind === "confirmed" ? card.booking?.confirmed_window ?? "" : "";

  const summaryCard = (
    <div className="mb-8 rounded-xl border border-border bg-card p-6 text-left">
      {submission.serverPriceChanged && (
        <p role="status" className="mb-4 rounded-lg bg-peach/50 p-4 text-base leading-relaxed">
          <strong>Updated price:</strong> the total shown when you booked was recalculated on our
          server from your home details — the amounts below are the verified ones, and the same
          amounts will be charged after your cleaning. Nothing is charged today.
        </p>
      )}
      <dl className="space-y-3 text-base">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <dt className="font-semibold">Service</dt>
          <dd>
            {serviceLabel}
            {summaryBooking?.first_service === "deep" ? " · First visit: Deep clean" : ""}
          </dd>
        </div>
        {first !== null && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <dt className="font-semibold">First visit</dt>
            <dd><strong>{fmtMoney(first)}</strong></dd>
          </div>
        )}
        {recurring !== null && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <dt className="font-semibold">Then</dt>
            <dd>
              <strong>{fmtMoney(recurring)}</strong> per visit, every other week
            </dd>
          </div>
        )}
        {confirmedDate ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <dt className="font-semibold">Confirmed visit</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span>
                {formatDateLong(confirmedDate)}
                {confirmedWindow ? <> · {confirmedWindow}</> : null}
              </span>
              <span className="rounded-full bg-sage/40 px-2.5 py-0.5 text-xs font-semibold">Confirmed</span>
            </dd>
          </div>
        ) : requestedDate ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <dt className="font-semibold">Requested date</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span>
                {formatDateLong(requestedDate)}

              </span>
              <span className="rounded-full bg-peach/50 px-2.5 py-0.5 text-xs font-semibold">Awaiting confirmation</span>
            </dd>
          </div>
        ) : null}
        {!confirmedDate && recap.window && <div><dt className="font-semibold">Requested arrival window</dt><dd className="mt-1">{recap.window}</dd></div>}
        {recap.entry && <div><dt className="font-semibold">Home access</dt><dd className="mt-1">{recap.entry}</dd></div>}
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 border-t border-border pt-3">
          <dt className="font-semibold">Due today</dt>
          <dd><strong>$0</strong></dd>
        </div>
      </dl>
    </div>
  );

  const emailNotice = submission.customerEmailSent === false && (
    <p className="text-sm text-muted-foreground mb-6">
      Your request reached us safely — no need to send it again. The automatic confirmation email
      didn&apos;t go through (check your spam folder just in case); we&apos;ll still confirm
      everything by email within one business day.
    </p>
  );

  const shell = (children: React.ReactNode) => (
    <div className="page-shell readable-flow min-h-[80vh] bg-background">
      <SEO url="https://www.gatehousehomecleaning.com/thank-you" title="Request Status | Gatehouse Home Cleaning" description="Next steps after contacting Gatehouse Home Cleaning." noindex />
      <div className="container max-w-2xl py-8 pb-24 md:pb-12">{children}</div>
    </div>
  );

  if (card.kind === "cancelled" || card.kind === "unknown") {
    return shell(<div className="text-center">
      <h1 className="font-heading text-3xl font-bold mb-4">{card.kind === "cancelled" ? "This visit is cancelled" : "We couldn’t verify your card status"}</h1>
      <p className="mb-6 text-lg">{card.kind === "cancelled" ? "No further card step is needed for this visit." : "Your request is saved. Check again before entering your card."}</p>
      {card.kind === "unknown" && <Button variant="hero" size="lg" onClick={checkCard}>Check again</Button>}
      <p className="mt-6"><Link reloadDocument className="underline" to={`/visit?bt=${encodeURIComponent(bt)}`}>View my visit</Link></p>
    </div>);
  }

  // State B — checking with Stripe.
  if (card.kind === "checking") {
    return shell(
      <div className="text-center">
        <Loader2 className="w-16 h-16 text-sage-foreground mx-auto mb-6 animate-spin" strokeWidth={1.5} aria-hidden="true" />
        <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Checking your card…</h1>
        <p className="text-lg text-foreground mb-6">
          We&apos;re confirming with Stripe whether your card was saved. This usually takes a few seconds.
        </p>
        {card.slow && (
          <>
            <p className="text-base text-muted-foreground mb-6">
              Still checking — your request is saved either way. You can keep waiting, check again, or
              email us at{" "}
              <a href="mailto:hello@gatehousehomecleaning.com" className="font-semibold text-primary underline">
                hello@gatehousehomecleaning.com
              </a>
              .
            </p>
            <Button variant="hero" size="lg" onClick={checkCard}>
              Check again
            </Button>
          </>
        )}
      </div>,
    );
  }

  // State C — card saved (visit not yet confirmed, or confirmed).
  if (card.kind === "saved" || card.kind === "confirmed") {
    if (card.booking?.visit_state === "date_declined") {
      return shell(<ChooseNewVisitDate bookingToken={bt} />);
    }
    return shell(
      <>
        <div className="text-center">
          <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">{card.kind === "confirmed" ? "Your visit is confirmed" : "Request received"}</h1>
          {emailNotice}
          <p className="text-lg text-foreground mb-2">
            <strong>Card saved. $0 charged today.</strong>
          </p>
          <p className="text-lg text-foreground mb-6">
            {card.kind === "confirmed" ? (
              <>
                Your visit is confirmed
                {confirmedDate ? <> for <strong>{formatDateLong(confirmedDate)}</strong></> : null}
                {confirmedWindow ? <> · {confirmedWindow}</> : null}.
              </>
            ) : (
              <>Your date is awaiting confirmation. We&apos;ll email your date, cleaner and arrival window by {card.booking?.confirm_by ? <strong>{card.booking.confirm_by}</strong> : "email within one business day"}.</>
            )}
          </p>
          {recap.email && (
            <p className="text-base text-muted-foreground mb-6">
              Confirmation goes to <strong>{recap.email}</strong>
            </p>
          )}
        </div>

        <Button variant="hero" size="xl" className="w-full mb-6" asChild>
          <Link reloadDocument to={`/visit?bt=${encodeURIComponent(bt)}`}>View my visit</Link>
        </Button>
        {summaryCard}
        <div className="mb-6 rounded-xl bg-sage/15 p-5 text-left">
          <h2 className="font-heading text-xl font-bold">What happens next</h2>
          <p className="mt-2 text-lg">{card.kind === "confirmed" ? "Your cleaner arrives during the confirmed window. After cleaning, we email your photo report." : "We check availability and email your confirmation. You can follow the status on your visit page."}</p>
        </div>
        <p className="mb-6 text-base leading-relaxed">Nothing is charged today. After the clean, approve your photo report to pay — if you haven&rsquo;t approved or reported an issue, we&rsquo;ll charge your card at the next scheduled billing time after your 24-hour review window.</p>
      </>,
    );
  }

  // State C2 — a card is on file, but NOT yet confirmed for THIS booking.
  if (card.kind === "choice") {
    // Item 6: never render "Card" without digits — an unidentified
    // saved card is a choice list (or the safe "add a card" fallback).
    const brand = card.booking?.card_brand ? card.booking.card_brand.replace(/\b\w/g, (c) => c.toUpperCase()) : "";
    const last4 = card.booking?.card_last4 ?? "";
    const cardIdentified = Boolean(brand && last4);
    const cardOptions = card.booking?.cards ?? [];
    return shell(
      <>
        <div className="text-center">
          <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Use your card on file?</h1>
          {emailNotice}
        </div>
        {summaryCard}
        <p className="mb-6 text-base leading-relaxed">
          {cardIdentified ? (
            <>We found a card on file for your email — <strong>{brand} ending in ••••{last4}</strong>. A card saved earlier is never used for a new booking without your say-so. Choose it for this booking, or add a different card. Nothing is charged today either way.</>
          ) : cardOptions.length > 0 ? (
            <>We found several cards on file for your email. Choose one for this booking — a card saved earlier is never used for a new booking without your say-so. Nothing is charged today either way.</>
          ) : (
            <>We couldn&rsquo;t identify a saved card for this visit. Add a card to continue.</>
          )}
        </p>
        {confirmError && (
          <p className="mb-4 rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
            We couldn't confirm that card. Please try again, or add a different card.
          </p>
        )}
        {confirmUnavailable && (
          <p className="mb-4 rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
            This card is no longer available. Choose another card or add a new one.
          </p>
        )}
        {!cardIdentified && cardOptions.length > 0 && (
          <div className="mb-3 text-left" role="radiogroup" aria-label="Choose a card for this booking">
            {cardOptions.map((c) => {
              const label = `${c.brand ? c.brand.replace(/\b\w/g, (ch) => ch.toUpperCase()) : "Card"} ending in ••••${c.last4}`;
              return (
                <label key={c.id} className="mb-2 flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border border-border bg-card p-3">
                  <input type="radio" name="saved-card" value={c.id} checked={selectedCard === c.id} onChange={() => setSelectedCard(c.id)} className="h-5 w-5 accent-primary" />
                  <span className="text-base font-semibold">{label}</span>
                  {typeof c.exp_month === "number" && typeof c.exp_year === "number" && (
                    <span className="text-sm text-muted-foreground">Expires {String(c.exp_month).padStart(2, "0")}/{c.exp_year}</span>
                  )}
                </label>
              );
            })}
          </div>
        )}
        {startError && (
          <p className="mb-4 rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
            Something went wrong opening the secure card page. Your request is saved — please try again.
          </p>
        )}
        {(cardIdentified || cardOptions.length > 0) && (
          <Button variant="hero" size="xl" className="w-full mb-3" onClick={confirmCard} disabled={confirming || !bt || (!cardIdentified && !selectedCard)}>
            {confirming ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
                Confirming…
              </>
            ) : cardIdentified ? (
              "Use this card for this booking"
            ) : (
              "Use selected card"
            )}
          </Button>
        )}
        <Button variant="outline" size="xl" className="w-full" onClick={startCard} disabled={starting || !bt}>
          {starting ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
              Opening Stripe…
            </>
          ) : (
            "Add a different card"
          )}
        </Button>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Questions? Email <a href="mailto:hello@gatehousehomecleaning.com" className="font-semibold text-primary underline">hello@gatehousehomecleaning.com</a>.
        </p>
      </>,
    );
  }

  // States A (not saved yet) and D (save failed / was cancelled).
  const failed = card.kind === "failed";
  return shell(
    <>
      <div className="text-center">
        <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
        <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
          {failed ? "Your card wasn't saved" : "One last step: save your card"}
        </h1>
        {emailNotice}
      </div>

      {summaryCard}

      {failed ? (
        <p className="mb-8 text-base leading-relaxed">
          Nothing was charged, and your visit isn&apos;t confirmed. Your request is still saved —
          save your card through Stripe to continue. Gatehouse never sees your full card number.
        </p>
      ) : (
        <p className="mb-8 text-base leading-relaxed">
          Saving your card costs $0 today and doesn&apos;t book anything by itself. We confirm your
          date by email within one business day after you add it. For cleaning, payment is taken
          when you approve the photo report, or at the next scheduled billing time after your 24-hour review window if you
          haven&apos;t reported an issue.
        </p>
      )}

      {startError && (
        <p className="mb-4 rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
          Something went wrong opening the secure card page. Your request is saved — please try
          again, or use the save-card link in your email.
        </p>
      )}
      <Button variant="hero" size="xl" className="w-full" onClick={startCard} disabled={starting || !bt}>
        {starting ? (
          <>
            <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
            Opening Stripe…
          </>
        ) : failed ? (
          "Try saving your card again"
        ) : (
          "Continue to Stripe — $0 today"
        )}
      </Button>
      <p className="mt-3 text-center text-sm text-muted-foreground">
        You&apos;ll enter your card securely on Stripe. No Link account is required.
      </p>

      <p className="mt-8 text-sm leading-relaxed text-muted-foreground">
        Free cancellation until 48 hours before your visit; after that a $25 fee applies.
        See our{" "}
        <Link to="/terms" className="font-semibold text-primary underline">Terms</Link>.
        Need to change something before then? Email{" "}
        <a href="mailto:hello@gatehousehomecleaning.com" className="font-semibold text-primary underline">
          hello@gatehousehomecleaning.com
        </a>
        .
      </p>
    </>,
  );
};

function recapPriceFirst(price?: string): string | undefined {
  if (!price) return undefined;
  const m = /\$([0-9]+(?:\.[0-9]+)?)/.exec(price);
  return m ? m[1] : undefined;
}

export default ThankYou;
