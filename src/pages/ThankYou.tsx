import { Link, useLocation } from "react-router-dom";
import { CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";

type SubmissionState = {
  submitted?: boolean;
  kind?: "booking" | "contact";
  customerEmailSent?: boolean;
  bt?: string;
  recap?: { price?: string; date?: string; window?: string; status?: string; response?: string };
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
  return (
    <div className="page-shell min-h-[80vh] flex items-center justify-center bg-background">
      <SEO url="https://www.gatehousehomecleaning.com/thank-you" title="Request Status | Gatehouse Home Cleaning" description="Next steps after contacting Gatehouse Home Cleaning." noindex />
      <div className="container text-center max-w-xl py-12">
        {received && <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />}
        <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
          {received ? isBooking ? "Request received" : "Message received" : "Ready to get in touch?"}
        </h1>
        <p className="text-lg text-foreground mb-6">
          {received ? isBooking ? "Your booking is requested, and still needs confirmation. Nick will email you within one business day to confirm availability and next steps." : "Thanks for your question. Nick will reply by email within one business day." : "Use our quote or contact form to send a request. This page alone does not create a booking."}
        </p>
        {received && submission.customerEmailSent === false && <p className="text-sm text-muted-foreground mb-6">Your request reached us safely — no need to send it again. The automatic confirmation email didn't go through (check your spam folder just in case); Nick will still confirm everything by email within one business day.</p>}
        {received && isBooking && submission.recap && (
          <div className="mb-8 rounded-xl border border-border bg-card p-6 text-left">
            <h2 className="mb-3 font-heading text-xl font-bold">Your request</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
              {submission.recap.price && (<><dt className="font-semibold">Price</dt><dd>{submission.recap.price}</dd></>)}
              {submission.recap.date && (<><dt className="font-semibold">Preferred date</dt><dd>{submission.recap.date} · {submission.recap.window}</dd></>)}
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
          </div>
        )}
        {received && isBooking && (
          <div className="mb-8 rounded-xl bg-card p-6 text-left">
            <h2 className="mb-3 font-heading text-xl font-bold">What happens next</h2>
            <ol className="list-decimal pl-5 space-y-3 text-base leading-relaxed">
              <li>We confirm your date, arrival window and service details by email.</li>
              <li>Your cleaner completes the agreed checklist.</li>
              <li>You receive a photo report after the visit. Your card is charged when you approve it, or automatically 24 hours after we send it if you haven't reported an issue.</li>
              <li>If you selected every-other-week cleaning, we confirm the repeat schedule with you.</li>
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
        )}
        {received && isBooking && (
          <div className="mb-8 rounded-xl border border-sage/40 bg-sage/10 p-6 text-left">
            <h2 className="mb-2 font-heading text-xl font-bold">Secure your booking — $0 today</h2>
            <p className="mb-4 text-base leading-relaxed">
              Save your card now ($0 today) so we can charge it after your visit — when you approve the photo report.
              Nothing is charged today.
            </p>
            <Button variant="hero" size="lg" asChild>
              <Link to={saveCardHref}>Save my card</Link>
            </Button>
          </div>
        )}
        <Button variant="hero" size="lg" asChild><Link to={received ? "/" : "/quote"}>{received ? "Back to Home" : "See My Price"}</Link></Button>
      </div>
    </div>
  );
};
export default ThankYou;
