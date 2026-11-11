import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";
import nikFounder from "@/assets/nik-founder.jpeg";

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
            Meet Nick, <span className="text-gradient-gold">Owner of Gatehouse</span>
          </h1>
          <p className="text-lg text-foreground/80 max-w-2xl mx-auto">
            I manage Gatehouse and coordinate your visit with independent cleaning professionals in North Atlanta. You can reach me directly with questions about your request.
          </p>
          <p className="text-base text-foreground/80 max-w-2xl mx-auto mt-4">
            <a href="mailto:hello@gatehousehomecleaning.com" className="font-semibold text-primary underline">hello@gatehousehomecleaning.com</a>
            {" · "}
            <a href="tel:+17705258599" className="font-semibold text-primary underline">(770) 525-8599</a>
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
            <p className="md:hidden text-center text-sm text-muted-foreground mt-2">Nick — Owner</p>
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
              Clear price online before you book, a photo report after every clean, and every date confirmed with you. Cancellation rules are listed in our FAQ and Terms.
            </p>
            <p className="text-foreground/80 leading-relaxed mt-3">
              The bedroom photo shown on our homepage is from a Gatehouse clean. Other illustrative images are labeled. Your private report photos are never published without separate permission.
            </p>
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
          <h2 className="font-heading text-3xl font-bold mb-4">Ready to start?</h2>
          <p className="text-foreground/80 text-lg mb-8">
            See your price online and request your first visit.
          </p>
          <Button variant="hero" size="xl" asChild>
            <Link to="/quote" data-main-cta>See My Price</Link>
          </Button>
        </div>
      </section>
    </div>
  );
};

export default About;
