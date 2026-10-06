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
    a: "We serve seven cities: Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell. Enter your ZIP in the calculator to check.",
  },
  {
    q: "Is there a travel fee for homes farther out?",
    a: "No. The price is the same anywhere in our seven cities.",
  },
  {
    q: "Do you serve gated communities and HOA neighborhoods?",
    a: "Yes. Share the gate code or guest-list name when you book.",
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
    a: "We serve seven North Atlanta cities: Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell. We don't currently serve intown Atlanta (Midtown, Buckhead, Decatur, etc.). Enter your ZIP in the calculator to check.",
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
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {neighborhoods.map((n) => (
                <li key={`area-${n.name}`}>
                  <a
                    className="flex min-h-[44px] items-center gap-2 rounded-lg bg-peach/30 px-3 text-sm font-semibold text-foreground underline"
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${n.name}, GA`)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {n.name}, GA
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="py-16">
        <div className="container">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {neighborhoods.map((n) => (
              <Link
                key={n.name}
                to={`/areas/${n.name.toLowerCase().replace(/\s+/g, "-")}`}
                className="block bg-card rounded-2xl p-6 shadow-warm hover:shadow-warm-lg transition-all hover:-translate-y-1 group"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-lg bg-peach/50 flex items-center justify-center group-hover:bg-peach transition-colors">
                    <MapPin className="w-5 h-5 text-primary" />
                  </div>
                  <h3 className="font-heading text-lg font-semibold">{n.name}</h3>
                </div>
                <p className="text-muted-foreground text-sm leading-relaxed">{n.desc}</p>
                <span className="mt-3 inline-block text-sm font-semibold text-primary">House cleaning in {n.name} →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="py-16 bg-peach-gradient">
        <div className="container text-center max-w-2xl">
          <h2 className="font-heading text-3xl font-bold mb-4">Don't See Your Neighborhood?</h2>
          <p className="text-muted-foreground text-lg mb-8">
            We serve seven cities: Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell. Enter your ZIP in the calculator to check.
          </p>
          <Button variant="hero" size="xl" asChild>
            <Link to="/quote">Check Availability</Link>
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
