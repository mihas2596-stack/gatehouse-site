import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Sparkles, Home, CalendarClock } from "lucide-react";
import SEO from "@/components/SEO";
import { type ServiceKey } from "@/config/pricing";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

type ServiceCard = {
  icon: typeof Sparkles;
  title: string;
  link: string;
  serviceKey?: ServiceKey;
  desc: string;
  includes: string[];
};

const mainService: ServiceCard = {
  icon: CalendarClock,
  title: "Every Other Week",
  link: "/quote?service=recurring",
  serviceKey: "recurring",
  desc: "Your home cleaned on the same weekday and arrival window, every other week. The house never builds up weeks of grime, so each visit takes less time.",
  includes: [
    "Same day and arrival window every other week",
    "All rooms dusted & vacuumed",
    "Bathrooms sanitized & polished",
    "Kitchen counters & appliances wiped",
    "Floors mopped throughout",
    "Trash removed & bins lined",
  ],
};

const alsoAvailable: ServiceCard[] = [
  {
    icon: Sparkles, title: "Deep clean", link: "/quote?service=deep", serviceKey: "deep",
    desc: "A more detailed reset, including appliance and cabinet interiors. Recommended when your home needs more than regular upkeep.",
    includes: ["All standard-clean checklist items", "Detailed cleaning for a fresh start", "Inside oven, fridge and cabinets", "See the full checklist before requesting a visit"],
  },
  {
    icon: Sparkles,
    title: "One-time clean",
    link: "/quote?service=standard&frequency=onetime",
    serviceKey: "standard",
    desc: "A single thorough refresh that dusts, vacuums, mops, and sanitizes bathrooms and kitchens throughout your home.",
    includes: ["All rooms dusted & vacuumed", "Bathrooms sanitized & polished", "Kitchen counters & appliances wiped", "Floors mopped throughout", "Trash removed & bins lined"],
  },
  {
    icon: Home,
    title: "Move-in / Move-out",
    link: "/quote?service=moveinout",
    serviceKey: "moveinout",
    desc: "A thorough clean for an empty home, including appliance interiors and cabinets.",
    includes: ["Complete deep clean of all rooms", "Inside all cabinets & drawers", "All appliances cleaned inside/out", "Interior windows available as an add-on"],
  },
];

const Services = () => {
  return (
    <div className="page-shell">
      <SEO
        title="House Cleaning Services | Gatehouse Home Cleaning"
        description="Every-other-week house cleaning, plus one-time, deep and move-in or move-out cleans in North Atlanta. Prices online."
        url="https://gatehousehomecleaning.com/services"
      />
      {/* Hero */}
      <section className="py-10 md:py-12 bg-warm-gradient">
        <div className="container text-center max-w-3xl">
          <p className="font-script text-xl text-golden mb-2">Our Services</p>
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
            Every-Other-Week House Cleaning for <span className="text-gradient-gold">North Atlanta Homes</span>
          </h1>
        </div>
      </section>

      {/* Main service */}
      <section className="py-10 md:py-12">
        <div className="container">
          <ServiceCardBlock service={mainService} headingLevel="h2" />

          <div className="mt-12">
            <h2 className="font-heading text-2xl font-bold mb-6 text-center">Also available</h2>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {alsoAvailable.map((s) => (
                <ServiceCardBlock key={s.title} service={s} headingLevel="h3" compact />
              ))}
            </div>
          </div>
        </div>
      </section>

    </div>
  );
};

const ServiceCardBlock = ({
  service: s,
  headingLevel,
  compact = false,
}: {
  service: ServiceCard;
  headingLevel: "h2" | "h3";
  compact?: boolean;
}) => {
  const Heading = headingLevel;
  return (
    <div className={`flex flex-col ${compact ? "" : "lg:flex-row"} gap-8 items-start bg-card rounded-2xl p-6 md:p-10 shadow-warm`}>
      <div className="flex-1">
        <div className="w-14 h-14 rounded-xl bg-peach/50 flex items-center justify-center mb-5">
          <s.icon className="w-7 h-7 text-primary" />
        </div>
        <Heading className={`font-heading font-bold mb-2 ${compact ? "text-xl md:text-2xl" : "text-2xl md:text-3xl"}`}>{s.title}</Heading>
        <p className="text-foreground leading-relaxed mb-6">{s.desc}</p>
        <Button variant="hero" size="lg" asChild>
          <Link to={s.link}>See your price</Link>
        </Button>
      </div>
      <div className="flex-1 w-full">
        <div className="bg-background rounded-xl px-6 py-4">
          <ul className="space-y-1.5 mb-4">
            {s.includes.slice(0, 3).map((item) => (
              <li key={`preview-${item}`} className="flex items-start gap-2 text-sm text-foreground">
                <Sparkles className="w-3.5 h-3.5 text-golden mt-0.5 flex-shrink-0" />
                {item}
              </li>
            ))}
          </ul>
          <Accordion type="single" collapsible>
            <AccordionItem value="included" className="border-b-0">
              <AccordionTrigger className="font-heading text-lg font-semibold hover:no-underline pt-0">
                What's included
              </AccordionTrigger>
              <AccordionContent>
                <ul className="space-y-2 pt-2">
                  {s.includes.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-sm text-foreground">
                      <Sparkles className="w-4 h-4 text-golden mt-0.5 flex-shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </div>
    </div>
  );
};

export default Services;
