import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ShieldCheck, BadgePercent, Mail } from "lucide-react";
import SEO from "@/components/SEO";
import { OFFER_SHORT, OFFER_TEXT } from "@/config/offer";
import { FOUNDING_FIRST_CLEAN } from "@/config/calculator";

const Reviews = () => {
  return (
    <div className="page-shell">
      <SEO
        title="Founding Clients | Gatehouse Home Cleaning"
        description="The first 10 households in our seven-city area book at a founding price and keep it for six months."
        url="https://gatehousehomecleaning.com/founding"
      />
      <section className="py-16 bg-warm-gradient">
        <div className="container text-center max-w-3xl">
          <p className="font-script text-xl text-golden mb-2">Founding Clients</p>
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
            Be One of Our First <span className="text-gradient-gold">North Atlanta Clients</span>
          </h1>
        </div>
      </section>

      <section className="py-16">
        <div className="container max-w-3xl">
          <div className="bg-card rounded-2xl p-8 md:p-10 shadow-warm space-y-5 text-foreground/85 leading-relaxed text-lg">
            <p>
              Gatehouse Home Cleaning is a new cleaning service in North Atlanta. We're building our reputation
              one home at a time — and we're inviting our first clients to join as Founding Clients.
            </p>
            <p>{OFFER_TEXT}</p>
            <p className="font-semibold">Founding first-clean price: ${FOUNDING_FIRST_CLEAN.S} / ${FOUNDING_FIRST_CLEAN.M} / ${FOUNDING_FIRST_CLEAN.L} for small / medium / large homes.</p>
            <div>
              <p className="font-heading font-semibold text-foreground mb-3">As a Founding Client you get:</p>
              <ul className="space-y-3">
                <li className="flex items-start gap-3">
                  <BadgePercent className="w-6 h-6 text-golden shrink-0 mt-0.5" />
                  <span>Founding rate — {OFFER_SHORT}</span>
                </li>
                <li className="flex items-start gap-3">
                  <ShieldCheck className="w-6 h-6 text-golden shrink-0 mt-0.5" />
                  <span>Your founding rate is held for six months from your first clean</span>
                </li>
              </ul>
            </div>
            <p>
              No reviews yet. We'll publish real ones after our first clients' visits.
            </p>
          </div>
        </div>
      </section>

      <section className="py-16 bg-peach-gradient">
        <div className="container text-center max-w-2xl">
          <h2 className="font-heading text-3xl font-bold mb-4">Ready to Join as a Founding Client?</h2>
          <p className="text-muted-foreground text-lg mb-8">
            See your price online. New clients welcome.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button variant="hero" size="xl" asChild>
              <Link to="/quote?founding=true">Claim a founding spot</Link>
            </Button>
            <Button variant="outline" size="xl" asChild>
              <a href="mailto:hello@gatehousehomecleaning.com" className="flex items-center gap-2">
                <Mail className="w-5 h-5" />
                Email Us
              </a>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Reviews;
