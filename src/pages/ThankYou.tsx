import { Link, useLocation } from "react-router-dom";
import { CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";

type SubmissionState = {
  submitted?: boolean;
  kind?: "booking" | "contact";
  customerEmailSent?: boolean;
  bt?: string;
  recap?: { price?: string; email?: string; date?: string; window?: string; status?: string; response?: string };
};

const ThankYou = () => {
  const { state } = useLocation();
  const submission = (state ?? {}) as SubmissionState;
  const received = submission.submitted === true;
  const isBooking = submission.kind === "booking";
  // Booking token survives here via navigation state; the booking email also
  // carries a continuation link, so a refresh never strands the client.
  const saveCardHref = submission.bt
    ? `/save-card?bt=${encodeURIComponent(submission.bt)}`
    : "/save-card";

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

  // Booking received: this page is step 3 of the path — the ONE next action
  // is saving the card. It is never called a confirmed booking here: the date
  // is confirmed by Nick personally, and the confirmed state lives on the
  // save-card page once he has confirmed it.
  return (
    <div className="page-shell min-h-[80vh] flex items-center justify-center bg-background">
      <SEO url="https://www.gatehousehomecleaning.com/thank-you" title="Request Status | Gatehouse Home Cleaning" description="Next steps after contacting Gatehouse Home Cleaning." noindex />
      <div className="container max-w-xl py-12 pb-24 md:pb-12">
        <div className="text-center">
          <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
          <ol className="mb-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm font-semibold" aria-label="How booking works">
            <li className="rounded-full border border-border bg-card px-3 py-1.5">1 · Your price</li>
            <li aria-hidden="true" className="text-muted-foreground">→</li>
            <li className="rounded-full border border-border bg-card px-3 py-1.5">2 · Your visit</li>
            <li aria-hidden="true" className="text-muted-foreground">→</li>
            <li className="rounded-full bg-primary px-3 py-1.5 text-primary-foreground">3 · Secure your card</li>
          </ol>
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Request received</h1>
          <p className="text-lg text-foreground mb-6">
            <strong className="font-semibold">One step left: save your card.</strong>{" "}
            $0 charged today — then we confirm your preferred date by email.
          </p>
          {submission.customerEmailSent === false && (
            <p className="text-sm text-muted-foreground mb-6">
              Your request reached us safely — no need to send it again. The automatic confirmation email
              didn&apos;t go through (check your spam folder just in case); we&apos;ll still confirm
              everything by email within one business day.
            </p>
          )}
        </div>

        <div className="mb-8 rounded-xl border border-sage/40 bg-sage/10 p-6 text-left">
          <h2 className="mb-2 font-heading text-xl font-bold">Save your card — $0 today</h2>
          <p className="mb-4 text-base leading-relaxed">
            This step lets us confirm your date. The card is charged only after your visit — when
            you approve the photo report, or automatically 24 hours after we send it if you
            haven&apos;t reported an issue.
          </p>
          <Button variant="hero" size="xl" asChild className="w-full sm:w-auto">
            <Link to={saveCardHref}>Save my card securely</Link>
          </Button>
          <p className="mt-3 text-sm text-muted-foreground">
            Card details are handled by Stripe. Gatehouse does not receive your full card number.
          </p>
        </div>

        {submission.recap && (
          <div className="mb-8 rounded-xl border border-border bg-card p-6 text-left">
            <h2 className="mb-3 font-heading text-xl font-bold">Your request</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
              {submission.recap.price && (<><dt className="font-semibold">Price</dt><dd>{submission.recap.price}</dd></>)}
              {submission.recap.date && (<><dt className="font-semibold">Preferred date</dt><dd>{submission.recap.date} · {submission.recap.window}</dd></>)}
              {submission.recap.email && (<><dt className="font-semibold">Email</dt><dd className="break-all">{submission.recap.email}</dd></>)}
            </dl>
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold text-primary">Request details</summary>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                {submission.recap.status && (<><dt className="font-semibold">Status</dt><dd>{submission.recap.status}</dd></>)}
                {submission.recap.response && (<><dt className="font-semibold">Next</dt><dd>{submission.recap.response}</dd></>)}
              </dl>
              <p className="mt-3 text-sm text-muted-foreground">
                Need to change or cancel? Email{" "}
                <a href="mailto:hello@gatehousehomecleaning.com?subject=Change%20my%20booking%20request" className="font-semibold text-primary underline">
                  hello@gatehousehomecleaning.com
                </a>{" "}
                — free up to 48 hours before your visit.
              </p>
            </details>
          </div>
        )}

        <div className="mb-8 rounded-xl bg-card p-6 text-left">
          <h2 className="mb-3 font-heading text-xl font-bold">What happens next</h2>
          <ol className="list-decimal pl-5 space-y-3 text-base leading-relaxed">
            <li><strong>Save your card</strong> with the button above, if you haven&apos;t yet — we confirm dates once a card is on file. $0 today.</li>
            <li><strong>We confirm your date by email</strong> within one business day — the email includes your arrival window and, for every-other-week cleaning, your repeat schedule.</li>
            <li><strong>We clean and send a photo report</strong> — your cleaner completes the agreed checklist, and you get photos of every room.</li>
            <li><strong>Your card is charged after the visit</strong> — when you approve the report, or automatically 24 hours after we send it if you haven&apos;t reported an issue.</li>
          </ol>
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

        <p className="text-center">
          <Link to="/" className="text-sm font-semibold text-primary underline">Back to home</Link>
        </p>
      </div>
    </div>
  );
};
export default ThankYou;
