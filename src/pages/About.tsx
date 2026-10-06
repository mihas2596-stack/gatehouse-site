import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Heart, BadgeCheck, Shield } from "lucide-react";
import SEO from "@/components/SEO";
import { Check } from "lucide-react";
import nikFounder from "@/assets/nik-founder.jpeg";

const MANIFESTO_ROWS: { good: string }[] = [
  { good: "Most homes get a price online; larger homes can email us for a custom quote" },
  { good: "Your price on screen before you book" },
];


const About = () => {
  return (
    <div className="page-shell">
      <SEO
        title="About Gatehouse Home Cleaning"
        description="Meet Nick, owner of Gatehouse Home Cleaning. Residential cleaning in North Atlanta, with a clear checklist and photo report before payment."
        url="https://gatehousehomecleaning.com/about"
      />
      {/* HERO */}
      <section className="pt-12 pb-8 bg-warm-gradient">
        <div className="container text-center max-w-3xl">
          <p className="font-script text-xl text-golden mb-2">Our Story</p>
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
            Meet Nick, <span className="text-gradient-gold">Your Point of Contact</span>
          </h1>
          <p className="text-lg text-foreground/80 max-w-2xl mx-auto">
            I manage Gatehouse and coordinate your visit with independent cleaning professionals in North Atlanta. You can reach me directly with questions about your request.
          </p>
        </div>
      </section>

      {/* OWNER INTRO */}
      <section className="pt-6 pb-16">
        <div className="container">
          <div className="grid md:grid-cols-2 gap-8 items-center">
            <div className="aspect-[4/5] overflow-hidden rounded-2xl max-w-sm w-full max-h-[360px] md:max-h-none mx-auto md:mx-0">
              <img
                src={nikFounder}
                alt="Nick, founder of Gatehouse Home Cleaning"
                className="w-full h-full object-cover object-top"
              />
            </div>
            <p className="md:hidden text-center text-sm text-muted-foreground mt-2">Nick — Founder</p>
            <div>
              <h2 className="font-heading text-2xl md:text-[34px] font-bold mb-6">
                Why Every Other Week
              </h2>
              <div className="space-y-4 text-foreground/80 leading-relaxed">
                <p>
                  A home cleaned every other week never builds up weeks of grime, so each visit is shorter and costs less than a one-time clean.
                </p>
              </div>
            </div>
          </div>

          {/* VALUE CARDS */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-16">
            {[
              { icon: Heart, title: "First Clean Rule", desc: "If a professional cleaned your home in the last 3 months, your first visit is a standard clean. If not, your first visit is a deep clean. The calculator shows both prices before you book." },
              { icon: BadgeCheck, title: "Published Pricing", desc: "See your price online. No in-home estimate." },
              { icon: Shield, title: "Same Day, Same Time", desc: "Your visit is set to the same weekday and arrival window, every other week." },
            ].map((v) => (
              <div key={v.title} className="text-center p-8 bg-card rounded-2xl shadow-warm">
                <div className="w-14 h-14 rounded-xl bg-peach/50 flex items-center justify-center mx-auto mb-5">
                  <v.icon className="w-7 h-7 text-primary" />
                </div>
                <h3 className="font-heading text-xl font-semibold mb-2">{v.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{v.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* MANIFESTO */}
      <section className="py-16 bg-warm-gradient">
        <div className="container max-w-5xl">
          <div className="text-center mb-10 max-w-2xl mx-auto">
            <p className="font-script text-xl text-golden mb-2">How We're Different</p>
            <h2 className="font-heading text-2xl md:text-[34px] font-bold mb-4">
              Know What to Expect Before Your Visit
            </h2>
            <p className="text-foreground/80 leading-relaxed">
              We'd rather show you exactly who we are. Cancellation and lockout rules are listed in our FAQ and Terms.
            </p>
            <p className="text-foreground/80 leading-relaxed mt-3">
              Photos on this site are illustrative. Real client photos will be added after our first visits.
            </p>
          </div>

          <h3 className="font-heading text-lg font-semibold text-primary mb-4">Gatehouse Home Cleaning</h3>

          <div className="space-y-4">
            {MANIFESTO_ROWS.map((row, i) => (
              <div
                key={i}
                className="flex items-start gap-3 text-foreground font-medium bg-card rounded-xl p-5 shadow-warm md:py-4 md:px-5 md:border-l-4 md:border-primary"
              >
                <Check className="w-5 h-5 shrink-0 mt-0.5 text-primary" aria-hidden="true" />
                <span className="leading-relaxed">{row.good}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ link */}
      <section className="py-10">
        <div className="container text-center max-w-2xl">
          <p className="text-foreground/80 text-base">
            Have questions? <Link to="/faq" className="text-primary font-semibold underline hover:no-underline">See our FAQ</Link>.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 bg-peach-gradient">
        <div className="container text-center max-w-2xl">
          <h2 className="font-heading text-3xl font-bold mb-4">Want to Be Part of Our Story?</h2>
          <p className="text-foreground/80 text-lg mb-8">
            We're choosing our first 10 founding clients now. Claim a founding spot.
          </p>
          <Button variant="hero" size="xl" asChild>
            <Link to="/quote?founding=true">Claim a founding spot</Link>
          </Button>
        </div>
      </section>
    </div>
  );
};

export default About;
