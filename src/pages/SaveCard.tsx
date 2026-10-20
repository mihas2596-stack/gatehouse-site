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

  return (
    <div className="page-shell min-h-[80vh] bg-background">
      <SEO
        url="https://www.gatehousehomecleaning.com/save-card"
        title="Save Your Card — $0 Today | Gatehouse Home Cleaning"
        description="Save your card to secure your booking. No charge today — we charge only after you approve your photo report."
        noindex
      />
      <div className="container max-w-xl py-12 text-center">
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
              Your card is on file — confirmed with Stripe. Nothing was charged today — we charge it
              only after you approve your photo report.
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
              Still stuck? Email <a href="mailto:hello@gatehousehomecleaning.com" className="underline">hello@gatehousehomecleaning.com</a> — Nick will help.
            </p>
          </>
        )}
        {verify.kind === "none" && (
          <>
            <CreditCard className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
              Save your card — $0 today
            </h1>
            <p className="text-lg text-foreground mb-6">
              Your card secures your booking. Your card is charged when you approve the report,
              or automatically 24 hours after we send it if you haven't reported an issue.
            </p>
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
                {submitStatus === "sending" ? "Opening secure card entry…" : "Continue to secure card entry"}
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
