import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, CreditCard, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";
import { formatDateLong } from "@/lib/utils";

type SubmitStatus = "idle" | "sending" | "error";
type VerifyState =
  | { kind: "none" }
  | { kind: "verifying"; booking: BookingSummary | null }
  | { kind: "saved"; booking: BookingSummary | null }
  | { kind: "pending"; booking: BookingSummary | null }
  | { kind: "failed"; booking: BookingSummary | null }
  | { kind: "unknown"; booking: BookingSummary | null };

type BookingSummary = {
  first?: string;
  recurring?: string;
  service?: string;
  date?: string;
  has_card?: string;
  booking_confirmed?: string;
  confirmed_date?: string;
  confirmed_window?: string;
};

const SaveCard = () => {
  const [searchParams] = useSearchParams();
  const bt = searchParams.get("bt") ?? "";
  const savedParam = searchParams.get("saved") === "1";
  const sessionId = searchParams.get("session_id") ?? "";
  const canceled = searchParams.get("canceled") === "1";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>("idle");
  const [verify, setVerify] = useState<VerifyState>({ kind: "none" });
  const [booking, setBooking] = useState<BookingSummary | null>(null);

  // Verify a returning Stripe session server-side. ?saved=1 alone NEVER
  // means "card saved" — only a verified SetupIntent does.
  useEffect(() => {
    if (!savedParam) return;
    if (!sessionId) {
      // saved=1 without a session id: cannot verify. Do NOT show success.
      setVerify({ kind: "unknown", booking: null });
      return;
    }
    setVerify({ kind: "verifying", booking: null });
    const url =
      `/api/card-status?session_id=${encodeURIComponent(sessionId)}` +
      (bt ? `&bt=${encodeURIComponent(bt)}` : "");
    fetch(url)
      .then((r) => r.json())
      .then((data: { verified?: boolean; status?: string; booking?: BookingSummary | null }) => {
        const b = data.booking ?? null;
        setBooking(b);
        if (data.verified && data.status === "saved") setVerify({ kind: "saved", booking: b });
        else if (data.status === "pending") setVerify({ kind: "pending", booking: b });
        else if (data.status === "failed") setVerify({ kind: "failed", booking: b });
        else setVerify({ kind: "unknown", booking: b });
      })
      .catch(() => setVerify({ kind: "unknown", booking: null }));
  }, [savedParam, sessionId, bt]);

  // When opened with a booking token, we already trust the booking —
  // no need to retype name/email. Show the booking summary instead.
  // (The token itself is verified server-side when creating the session.)
  useEffect(() => {
    if (!bt || savedParam) return;
    fetch(`/api/card-status?bt=${encodeURIComponent(bt)}`)
      .then((r) => r.json())
      .then((data: { booking?: BookingSummary | null }) => {
        if (data.booking) setBooking(data.booking);
      })
      .catch(() => {});
  }, [bt, savedParam]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: Record<string, string> = {};
    if (bt) {
      body.bt = bt;
    } else {
      const errors: Record<string, string> = {};
      if (name.trim().length < 2) errors.name = "Enter your name.";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
        errors.email = "Enter a valid email, like name@example.com.";
      setFieldErrors(errors);
      if (Object.keys(errors).length > 0) return;
      body.name = name.trim();
      body.email = email.trim();
    }

    setSubmitStatus("sending");
    try {
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok?: boolean; url?: string };
      if (res.ok && data.ok && typeof data.url === "string") {
        window.location.href = data.url;
        return;
      }
      setSubmitStatus("error");
    } catch {
      setSubmitStatus("error");
    }
  };

  const bookingSummary = booking && (booking.first || booking.recurring || booking.service || booking.date);
  // Revisit state from the booking token (server-checked against Stripe):
  // a client reopening their link sees the true state, not the save form.
  const hasCard = booking?.has_card === "1";
  const isConfirmed = booking?.booking_confirmed === "1";

  return (
    <div className="page-shell min-h-[80vh] bg-background">
      <SEO
        url="https://www.gatehousehomecleaning.com/save-card"
        title="Save Your Card — $0 Today | Gatehouse Home Cleaning"
        description="Save your card to secure your booking. No charge today — your card is charged when you approve the photo report, or automatically 24 hours after we send it if you haven't reported an issue."
        noindex
      />
      <div className="container max-w-xl py-12 pb-24 text-center md:pb-12">
        {verify.kind === "verifying" && (
          <>
            <Loader2 className="w-16 h-16 text-sage-foreground mx-auto mb-6 animate-spin" aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Checking your card…</h1>
            <p className="text-lg text-foreground mb-6">We're confirming with Stripe that your card was saved.</p>
          </>
        )}
        {verify.kind === "saved" && (
          <>
            <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Card saved. Your request is complete.</h1>
            <p className="text-lg text-foreground mb-6">
              We&apos;ll confirm availability for your requested date by email within one business
              day. Nothing was charged — your card is charged when you approve your photo report,
              or 24 hours after we send it if you haven&apos;t reported an issue.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button variant="hero" size="lg" asChild>
                <Link to={`/visit?bt=${encodeURIComponent(bt)}`}>View my visit</Link>
              </Button>
              <Button variant="outline" size="lg" asChild>
                <Link to="/">Back to Home</Link>
              </Button>
            </div>
          </>
        )}
        {(verify.kind === "pending" || verify.kind === "failed" || verify.kind === "unknown") && (
          <>
            <AlertTriangle className="w-16 h-16 text-destructive mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
              {verify.kind === "pending" ? "Almost there" : verify.kind === "failed" ? "Card not saved" : "Couldn't verify card"}
            </h1>
            <p className="text-lg text-foreground mb-6">
              {verify.kind === "pending"
                ? "Your card entry is still being confirmed with Stripe. Wait a moment, then check again."
                : verify.kind === "failed"
                  ? "The card wasn't saved. Nothing was charged. You can try again with the same or a different card."
                  : "We couldn't verify your card status with Stripe right now — this doesn't mean it failed. Nothing was charged. Check again in a moment, or try a fresh card entry below."}
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center mb-6">
              <Button variant="hero" size="lg" onClick={() => window.location.reload()}>
                Check again
              </Button>
              <Button variant="outline" size="lg" onClick={() => setVerify({ kind: "none" })}>
                Start a fresh card entry
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Still stuck? Email <a href="mailto:hello@gatehousehomecleaning.com" className="underline">hello@gatehousehomecleaning.com</a> — we&apos;ll help you out.
            </p>
          </>
        )}
        {verify.kind === "none" && hasCard && isConfirmed && (
          <>
            <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Booking confirmed</h1>
            <p className="text-lg text-foreground mb-6">
              Your cleaning is confirmed
              {booking?.confirmed_date ? <> for <strong>{booking.confirmed_date}</strong></> : null}
              {booking?.confirmed_window ? <> · {booking.confirmed_window}</> : null}.
              Your card is saved — $0 charged today. Your card is charged when you approve your
              photo report, or automatically 24 hours after we send it if you haven&apos;t reported
              an issue.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button variant="hero" size="lg" asChild>
                <Link to={`/visit?bt=${encodeURIComponent(bt)}`}>View my visit</Link>
              </Button>
              <Button variant="outline" size="lg" asChild>
                <Link to="/">Back to Home</Link>
              </Button>
            </div>
          </>
        )}
        {verify.kind === "none" && hasCard && !isConfirmed && (
          <>
            <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Card saved. Your request is complete.</h1>
            <p className="text-lg text-foreground mb-6">
              Your card is already on file for this booking — no need to save it again. We&apos;ll
              confirm availability for your requested date by email within one business day.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button variant="hero" size="lg" asChild>
                <Link to={`/visit?bt=${encodeURIComponent(bt)}`}>View my visit</Link>
              </Button>
              <Button variant="outline" size="lg" asChild>
                <Link to="/">Back to Home</Link>
              </Button>
            </div>
          </>
        )}
        {verify.kind === "none" && !hasCard && (
          <>
            <CreditCard className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <ol className="mb-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm font-semibold" aria-label="How booking works">
              <li className="rounded-full border border-border bg-card px-3 py-1.5">1 · Your price</li>
              <li aria-hidden="true" className="text-muted-foreground">→</li>
              <li className="rounded-full border border-border bg-card px-3 py-1.5">2 · Your visit</li>
              <li aria-hidden="true" className="text-muted-foreground">→</li>
              <li className="rounded-full bg-primary px-3 py-1.5 text-primary-foreground">3 · Save your card — $0 today</li>
            </ol>
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
              Last step: save your card — $0 today
            </h1>
            <p className="text-lg text-foreground mb-6">
              This finishes your request — nothing is charged today.
              {!isConfirmed && (
                <> The card alone doesn&apos;t confirm your time — we confirm your date and arrival
                window by email within one business day.</>
              )}
            </p>
            {isConfirmed && (
              <p className="mb-6 rounded-lg border border-sage/40 bg-sage/10 p-4 text-base text-foreground">
                Good news — your visit is confirmed
                {booking?.confirmed_date ? <> for <strong>{booking.confirmed_date}</strong></> : null}
                {booking?.confirmed_window ? <> · {booking.confirmed_window}</> : null}.
                Save your card below to complete — $0 today.
              </p>
            )}
            <div className="mb-8 rounded-xl border border-border bg-card p-6 text-left">
              <h2 className="mb-2 font-heading text-lg font-bold">Why save a card now?</h2>
              <p className="text-base leading-relaxed">
                Save your card now so you won&apos;t need to enter it again after your cleaning.
                <strong> $0 charged today.</strong>
              </p>
              <p className="mt-2 text-base leading-relaxed">
                After your cleaning, we&apos;ll email your photo report. We charge the agreed visit
                price when you approve it, or 24 hours after we send it if you haven&apos;t reported
                an issue. Reporting an issue within that window blocks the automatic charge for this visit — it never runs on its own afterwards. You approve again to pay once we&apos;ve fixed it. Your card details are stored securely by Stripe, our payment processor —
                Gatehouse never sees your full card number.
              </p>
              <p className="mt-2 text-base leading-relaxed">
                Questions? Email <a href="mailto:hello@gatehousehomecleaning.com" className="font-semibold text-primary underline">hello@gatehousehomecleaning.com</a>.
              </p>
              <p className="mt-4 text-sm text-muted-foreground">
                Free cancellation until 48 hours before your visit; after that a $25 fee applies.
                If we arrive and can&apos;t get in — and can&apos;t reach you — the visit is charged
                in full. See our{" "}
                <Link to="/terms" className="font-semibold text-primary underline">Terms</Link>.
              </p>
            </div>
            {bookingSummary && (
              <div className="mb-8 rounded-xl border border-sage/40 bg-sage/10 p-6 text-left">
                <h2 className="mb-2 font-heading text-lg font-bold">Your booking</h2>
                <ul className="space-y-1 text-base">
                  {booking!.service && <li>Service: <strong>{booking!.service}</strong></li>}
                  {booking!.date && <li>Preferred date: <strong>{formatDateLong(booking!.date)}</strong></li>}
                  {booking!.first && <li>First visit: <strong>${booking!.first}</strong></li>}
                  {booking!.recurring && <li>Recurring visits: <strong>${booking!.recurring}</strong></li>}
                </ul>
                <p className="mt-4 border-t border-sage/40 pt-4 text-sm leading-relaxed">
                  By continuing, you authorize Gatehouse to charge this card{" "}
                  {booking!.first ? (
                    <>${booking!.first} for the first visit{booking!.recurring ? <> and ${booking!.recurring} per recurring visit</> : null}</>
                  ) : (
                    <>per the prices above</>
                  )}{" "}
                  as described above and in our Terms. $0 is charged today.
                </p>
              </div>
            )}
            {canceled && (
              <p className="mb-6 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
                Card entry was canceled — nothing was saved or charged. You can try again below whenever
                you're ready.
              </p>
            )}
            <form onSubmit={submit} className="text-left space-y-4" noValidate>
              {!bt && (
                <>
                  <div>
                    <label htmlFor="sc-name" className="mb-1 block text-sm font-medium">
                      Full name
                    </label>
                    <input
                      id="sc-name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base"
                      autoComplete="name"
                    />
                    {fieldErrors.name && <p className="mt-1 text-sm text-destructive">{fieldErrors.name}</p>}
                  </div>
                  <div>
                    <label htmlFor="sc-email" className="mb-1 block text-sm font-medium">
                      Email
                    </label>
                    <input
                      id="sc-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base"
                      autoComplete="email"
                    />
                    {fieldErrors.email && <p className="mt-1 text-sm text-destructive">{fieldErrors.email}</p>}
                  </div>
                </>
              )}
              {submitStatus === "error" && (
                <p className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
                  Something went wrong starting the secure card entry. Please try again in a minute.
                </p>
              )}
              <Button type="submit" variant="hero" size="lg" className="w-full" disabled={submitStatus === "sending"}>
                {submitStatus === "sending" ? "Opening Stripe's secure page…" : "Add card — $0 today"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                You'll enter your card securely on Stripe. No Link account is required.
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  );
};

export default SaveCard;
