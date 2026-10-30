import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { MapPin } from "lucide-react";
import SEO from "@/components/SEO";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const neighborhoods = [
  { name: "Sugar Hill", desc: "Sugar Hill — every-other-week cleaning on a fixed day and time." },
  { name: "Suwanee", desc: "Suwanee — every-other-week cleaning on a fixed day and time." },
  { name: "Buford", desc: "Buford — every-other-week cleaning on a fixed day and time." },
  { name: "Duluth", desc: "Duluth — every-other-week cleaning on a fixed day and time." },
  { name: "Johns Creek", desc: "Johns Creek — every-other-week cleaning on a fixed day and time." },
  { name: "Alpharetta", desc: "Alpharetta — every-other-week cleaning on a fixed day and time." },
  { name: "Roswell", desc: "Roswell — every-other-week cleaning on a fixed day and time." },
];

const faqs = [
  {
    q: "Which neighborhoods do you serve?",
    a: "We serve seven North Atlanta cities — see the list above. Enter your ZIP in the calculator to check.",
  },
  {
    q: "Is there a travel fee for homes farther out?",
    a: "No. The price is the same anywhere in our seven cities.",
  },
  {
    q: "Do you serve gated communities and HOA neighborhoods?",
    a: "Yes. You add gate details privately on your confirmed visit page — never in open booking notes.",
  },
  {
    q: "Can you clean apartments and townhomes, not just single-family houses?",
    a: "Absolutely. We clean apartments, condos, townhomes, and single-family houses. Pricing is based on bedrooms and bathrooms — the building type doesn't change the rate.",
  },
  {
    q: "How far in advance do I need to book in my area?",
    a: "Book at least 3 days ahead. Your day and arrival window then stay the same every other week.",
  },
  {
    q: "Do you cover Atlanta proper or only the northern suburbs?",
    a: "We serve the seven North Atlanta cities listed above. We don't currently serve intown Atlanta (Midtown, Buckhead, Decatur, etc.). Enter your ZIP in the calculator to check.",
  },
  {
    q: "What if I'm just outside your service area?",
    a: "Enter your ZIP in the calculator. If it's outside the seven cities, we can't take the booking right now.",
  },
];

const Areas = () => {
  return (
    <div className="page-shell">
      <SEO
        title="Service Area: 7 North Atlanta Cities | Gatehouse"
        description="We clean homes in Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell, Georgia. See your price online."
        url="https://gatehousehomecleaning.com/areas"
      />
      <section
        className="relative py-16 overflow-hidden"
        style={{
          background:
            "linear-gradient(135deg, hsl(36 50% 96%) 0%, hsl(28 55% 88%) 55%, hsl(18 55% 72%) 100%)",
        }}
      >
        <div className="container relative text-center max-w-3xl">
          <p className="font-script text-xl text-[#9C5630] mb-2">Where We Serve</p>
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4 text-foreground">
            House Cleaning in <span className="text-gradient-gold">7 North Atlanta Suburbs</span>
          </h1>
          <p className="text-foreground text-lg">
            Seven North Atlanta suburbs, one fixed schedule.
          </p>
        </div>
      </section>

      <section className="py-10">
        <div className="container">
          <div className="mx-auto max-w-4xl rounded-2xl border border-border bg-card p-6 shadow-warm md:p-8">
            <h2 className="mb-4 font-heading text-2xl font-bold text-sage-foreground">Cities we clean</h2>
            <ul className="space-y-3">
              {neighborhoods.map((n) => (
                <li key={`area-${n.name}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-peach/30 px-4 py-3">
                  <span className="flex items-center gap-2 text-base font-semibold text-foreground">
                    <MapPin className="w-5 h-5 text-primary" aria-hidden="true" /> {n.name}, GA
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/areas/${n.name.toLowerCase().replace(/\s+/g, "-")}`}
                      className="inline-flex min-h-[44px] items-center rounded-full bg-card px-4 text-sm font-semibold text-primary underline"
                    >
                      City page
                    </Link>
                    <a
                      className="inline-flex min-h-[44px] items-center rounded-full bg-card px-4 text-sm font-semibold text-primary underline"
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${n.name}, GA`)}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${n.name} on Google Maps`}
                    >
                      Map
                    </a>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-sm text-muted-foreground">
              Every city gets the same every-other-week cleaning on a fixed day and time, at the published price.
            </p>
          </div>
        </div>
      </section>

      <section className="py-16 bg-peach-gradient">
        <div className="container text-center max-w-2xl">
          <h2 className="font-heading text-3xl font-bold mb-4">Don't See Your Neighborhood?</h2>
          <p className="text-muted-foreground text-lg mb-8">
            We serve seven cities across North Atlanta (see the list above). Enter your ZIP in the calculator to check whether your home is covered.
          </p>
          <Button variant="hero" size="xl" asChild>
            <Link to="/quote" data-main-cta>Check Availability</Link>
          </Button>
        </div>
      </section>

      <section className="py-16">
        <div className="container max-w-3xl">
          <div className="text-center mb-10">
            <p className="font-script text-xl text-[#9C5630] mb-2">Coverage Questions</p>
            <h2 className="font-heading text-2xl md:text-[34px] font-bold text-foreground">
              Frequently Asked Questions
            </h2>
            <p className="text-muted-foreground mt-3">
              Everything North Atlanta homeowners ask about our service area.
            </p>
          </div>
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((faq, i) => (
              <AccordionItem
                key={i}
                value={`item-${i}`}
                className="bg-card rounded-2xl shadow-warm mb-3 px-5 border-0"
              >
                <AccordionTrigger className="text-left font-heading text-base md:text-lg font-semibold hover:no-underline py-5">
                  {faq.q}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground text-base leading-relaxed pb-5">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>
    </div>
  );
};

export default Areas;
