import { Link, useLocation } from "react-router-dom";
import { CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";

type SubmissionState = { submitted?: boolean; kind?: "booking" | "contact"; customerEmailSent?: boolean };

const ThankYou = () => {
  const { state } = useLocation();
  const submission = (state ?? {}) as SubmissionState;
  const received = submission.submitted === true;
  const isBooking = submission.kind === "booking";
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
        {received && submission.customerEmailSent === false && <p className="text-sm text-muted-foreground mb-6">Your request reached us, but the automatic confirmation email could not be sent. You do not need to submit it again.</p>}
        {received && isBooking && (
          <div className="mb-8 rounded-xl bg-card p-6 text-left">
            <h2 className="mb-3 font-heading text-xl font-bold">What happens next</h2>
            <ol className="list-decimal pl-5 space-y-3 text-base leading-relaxed">
              <li>We confirm your date, arrival window and service details by email.</li>
              <li>Your cleaner completes the agreed checklist.</li>
              <li>You receive a photo report before payment. No response within 24 hours counts as approval.</li>
              <li>If you selected every-other-week cleaning, we confirm the repeat schedule with you.</li>
            </ol>
          </div>
        )}
        <Button variant="hero" size="lg" asChild><Link to={received ? "/" : "/quote"}>{received ? "Back to Home" : "See My Price"}</Link></Button>
      </div>
    </div>
  );
};
export default ThankYou;
