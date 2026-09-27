import { useEffect } from "react";
import { Link } from "react-router-dom";
import { CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";

const ThankYou = () => {
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("gh_lead_pending");
      if (raw) {
        sessionStorage.removeItem("gh_lead_pending");
        let eventID: string | undefined;
        try { eventID = JSON.parse(raw)?.eventID; } catch { /* ignore */ }
        if (eventID && typeof (window as any).fbq === "function") {
          (window as any).fbq("track", "Lead", {}, { eventID });
        }
      }
    } catch {
      // sessionStorage unavailable — ignore
    }
  }, []);
  return (
    <div className="pt-24 min-h-screen flex items-center justify-center bg-background">
      <SEO
        title="Thank You | Gatehouse Home Cleaning"
        description="Your booking request has been received. We'll contact you within one business day to confirm your appointment."
      />
      <div className="container text-center max-w-xl py-16">
        <CheckCircle className="w-20 h-20 text-green-600 mx-auto mb-6" strokeWidth={1.5} />
        <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
          Thank You!
        </h1>
        <p className="text-xl text-muted-foreground font-medium mb-2">
          We received your booking request.
        </p>
        <p className="text-muted-foreground mb-10">
          We'll text you within one business day to confirm your appointment.
        </p>
        <div className="mx-auto mb-10 max-w-md rounded-2xl bg-card p-6 text-left shadow-warm">
          <h2 className="mb-4 font-heading text-xl font-bold text-sage-foreground">What happens next</h2>
          <ol className="space-y-3 text-sm leading-relaxed text-foreground md:text-base">
            <li>1. Nick texts you within one business day to confirm your day and arrival window.</li>
            <li>2. Your first visit happens on that day.</li>
            <li>3. You pay after the clean.</li>
            <li>4. The same day and arrival window repeat every other week.</li>
          </ol>
        </div>

        <Button variant="hero" size="lg" asChild>
          <Link to="/">Back to Home</Link>
        </Button>
      </div>
    </div>
  );
};

export default ThankYou;
