import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, CreditCard, ShieldCheck, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";

type SubmitStatus = "idle" | "sending" | "error";
type VerifyState =
  | { kind: "none" }
  | { kind: "verifying" }
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
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Card saved</h1>
            <p className="text-lg text-foreground mb-6">
              Your card is on file — confirmed with Stripe. $0 charged today. We&apos;ll email your
              confirmed date and arrival window within one business day. Your card is charged when
              you approve your photo report, or automatically 24 hours after we send it if you
              haven&apos;t reported an issue.
            </p>
            <Button variant="hero" size="lg" asChild>
              <Link to="/">Back to Home</Link>
            </Button>
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
            <Button variant="hero" size="lg" asChild>
              <Link to="/">Back to Home</Link>
            </Button>
          </>
        )}
        {verify.kind === "none" && hasCard && !isConfirmed && (
          <>
            <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Card saved — $0 charged</h1>
            <p className="text-lg text-foreground mb-6">
              Your card is already on file for this booking — no need to save it again. We&apos;ll
              email your confirmed date and arrival window within one business day.
            </p>
            <Button variant="hero" size="lg" asChild>
              <Link to="/">Back to Home</Link>
            </Button>
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
              <li className="rounded-full bg-primary px-3 py-1.5 text-primary-foreground">3 · Secure your card</li>
            </ol>
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
              Last step: save your card — $0 today
            </h1>
            <p className="text-lg text-foreground mb-6">
              This finishes your request — nothing is charged today. We ask for a card now so we
              can charge it after your visit: when you approve the photo report, or automatically
              24 hours after we send it if you haven&apos;t reported an issue.
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
              <h2 className="mb-2 font-heading text-lg font-bold">Why we ask for your card</h2>
              <p className="mb-4 text-base leading-relaxed">
                Two reasons: it holds your cleaner&apos;s time for your date, and it&apos;s how
                &quot;approve, then pay&quot; works — you never pay for a cleaning you haven&apos;t seen.
              </p>
              <ul className="space-y-3 text-base leading-relaxed">
                <li><strong>$0 today — and nothing before the visit.</strong> The card is saved, not charged.</li>
                <li><strong>You pay after you see the work.</strong> The charge happens when you approve the photo report; if you report an issue, it stays paused until the issue is fixed.</li>
                <li><strong>The amount is the price you saw.</strong> No surprises — extra work only ever happens with your approval first.</li>
                <li><strong>Free cancellation up to 48 hours before your visit</strong> — cancel in time and nothing is charged at all.</li>
                <li><strong>We never see your card number.</strong> Stripe processes it securely — the same system behind millions of online stores.</li>
              </ul>
            </div>
            {bookingSummary && (
              <div className="mb-8 rounded-xl border border-sage/40 bg-sage/10 p-6 text-left">
                <h2 className="mb-2 font-heading text-lg font-bold">Your booking</h2>
                <ul className="space-y-1 text-base">
                  {booking!.service && <li>Service: <strong>{booking!.service}</strong></li>}
                  {booking!.date && <li>Preferred date: <strong>{booking!.date}</strong></li>}
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
                  — each charge when you approve that visit's photo report, or automatically 24 hours after we send it if you haven't reported an issue. $0 is charged today.
                </p>
              </div>
            )}
            <div className="mb-8 rounded-xl bg-card p-6 text-left">
              <h2 className="mb-3 font-heading text-lg font-bold">What to do</h2>
              <ol className="mb-5 list-decimal space-y-2 pl-5 text-base leading-relaxed">
                <li>Tap the button below — you&apos;ll go to Stripe&apos;s secure page.</li>
                <li>Enter your card there. It takes about a minute.</li>
                <li>Done — we email your confirmed date and arrival window within one business day.</li>
              </ol>
              <ul className="space-y-3 text-base leading-relaxed">
                <li className="flex gap-3">
                  <ShieldCheck className="w-5 h-5 mt-1 shrink-0 text-sage-foreground" aria-hidden="true" />
                  <span>No charge today — $0 now.</span>
                </li>
                <li className="flex gap-3">
                  <ShieldCheck className="w-5 h-5 mt-1 shrink-0 text-sage-foreground" aria-hidden="true" />
                  <span>Charged on your approval — or 24 hours after the report if you don't flag an issue.</span>
                </li>
                <li className="flex gap-3">
                  <ShieldCheck className="w-5 h-5 mt-1 shrink-0 text-sage-foreground" aria-hidden="true" />
                  <span>Free cancellation up to 48 hours before your visit.</span>
                </li>
                <li className="flex gap-3">
                  <ShieldCheck className="w-5 h-5 mt-1 shrink-0 text-sage-foreground" aria-hidden="true" />
                  <span>
                    Card details are processed securely by Stripe. We never see or store your card number.
                  </span>
                </li>
              </ul>
              <p className="mt-4 text-sm text-muted-foreground">
                Something wrong after a visit?{" "}
                <a
                  href="mailto:hello@gatehousehomecleaning.com?subject=Issue%20with%20my%20cleaning%20visit"
                  className="font-semibold text-primary underline"
                >
                  Report an issue
                </a>{" "}
                within 24 hours of your photo report — the charge stays paused until we fix it.
              </p>
            </div>
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
                {submitStatus === "sending" ? "Opening Stripe's secure page…" : "Save my card — $0 today"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                You'll enter your card on Stripe's secure page. $0 is charged today.
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  );
};

export default SaveCard;
