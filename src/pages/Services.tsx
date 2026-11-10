import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Sparkles, Home, CalendarClock } from "lucide-react";
import SEO from "@/components/SEO";
import { type ServiceKey } from "@/config/pricing";
import { PRICES, ADDONS , fmtPrice, globalTestCutActive, scaleTestPrice} from "@/config/calculator";
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
  desc: "Regular upkeep, arranged with you every other week. We confirm each visit’s date, arrival window and cleaner.",
  includes: [
    "Each visit arranged and confirmed with you",
    "All rooms dusted & vacuumed",
    "Bathrooms cleaned & polished",
    "Kitchen counters & appliances wiped",
    "Floors mopped throughout",
    "Trash removed & bins lined",
  ],
};

const alsoAvailable: ServiceCard[] = [
  {
    icon: Sparkles, title: "Deep clean", link: "/quote?service=deep", serviceKey: "deep",
    desc: "A detailed reset for a lived-in home — the full standard checklist, plus inside the oven, fridge and cabinets. Choose it when your home needs more than regular upkeep, or as your first visit after 3 months without a professional clean.",
    includes: ["All standard-clean checklist items", "Inside oven, fridge and cabinets", "Detailed dusting and scrubbing in kitchens and bathrooms"],
  },
  {
    icon: Sparkles,
    title: "One-time clean",
    link: "/quote?service=standard&frequency=onetime",
    serviceKey: "standard",
    desc: "A single thorough refresh that dusts, vacuums, mops, and cleans bathrooms and kitchens throughout your home.",
    includes: ["All rooms dusted & vacuumed", "Bathrooms cleaned & polished", "Kitchen counters & appliances wiped", "Floors mopped throughout", "Trash removed & bins lined"],
  },
  {
    icon: Home,
    title: "Move‑in / Move‑out",
    link: "/quote?service=moveinout",
    serviceKey: "moveinout",
    desc: "A thorough clean for an empty home — every cabinet, drawer and appliance cleaned inside and out, so the home is ready to move into or hand over.",
    includes: ["Complete deep clean of all rooms", "Inside every cabinet & drawer", "Every appliance cleaned inside and out", "Interior windows available as an add-on"],
  },
];

const Services = () => {
  // Owner test sessions (a verified tp1 token on the quote page sets this
  // flag for the tab) scale these cells to match the quote — so one
  // regime never shows two different prices for the same add-on.
  // Synchronous at render, NOT useEffect: the prerendered HTML must show
  // the same prices as the live page. A client-only flag starts false
  // during prerender, so the served page showed real prices while the
  // live page showed test prices (audit B1). sessionStorage is absent
  // during prerender — the try/catch falls back to the global window.
  const testPricing = (() => {
    try { return sessionStorage.getItem("gh_test_pricing") === "1" || globalTestCutActive(); } catch { return globalTestCutActive(); }
  })();
  const disp = (n: number): number => (testPricing ? scaleTestPrice(n) : n);
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
            House Cleaning for <span className="text-gradient-gold">North Atlanta Homes</span>
          </h1>
        </div>
      </section>

      {testPricing && (
        <div className="container">
          <p className="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 text-center">
            Test booking: prices on this page are reduced for a payment test.
          </p>
        </div>
      )}

      <section className="py-8">
        <div className="container max-w-5xl grid grid-cols-1 md:grid-cols-2 gap-5">
          {[alsoAvailable[1], mainService, alsoAvailable[0], alsoAvailable[2]].map((service, index) => (
            <article key={service.title} className="rounded-2xl border border-border bg-card p-6 shadow-warm flex flex-col">
              <h2 className="font-heading text-2xl font-bold mb-3">{service.title}</h2>
              <p className="mb-4">{service.desc}</p>
              <p className="font-semibold mb-4">From {fmtPrice(disp([PRICES.standardOnetime.S, PRICES.recurring.S, PRICES.deep.S, PRICES.moveinout.S][index]))} per visit — your exact price depends on bedrooms and bathrooms.</p>
              <Button asChild variant="hero" size="lg" className="mt-auto"><Link to={service.link} data-main-cta>See your price</Link></Button>
              <details className="mt-4"><summary className="min-h-[44px] cursor-pointer text-primary underline">What this covers</summary><ul className="mt-2 space-y-2 list-disc pl-5">{service.includes.map((item) => <li key={item}>{item}</li>)}</ul></details>
            </article>
          ))}
        </div>
      </section>

      <div className="container max-w-3xl">
        <p className="text-center text-muted-foreground">
          Prices above are for a Small home — up to 2 bedrooms and up to 2 full bathrooms. Your price is set by the
          larger of your two counts: up to 2 is Small, 3 is Medium, 4–5 is Large. Homes with 6 or more bedrooms or
          full bathrooms — <a href="mailto:hello@gatehousehomecleaning.com" className="text-primary underline">email us</a> for a custom quote.
        </p>
      </div>

      {/* Comparison — factual differences only, prices from the same config
          the quote form and the server charge by. One data source renders
          the desktop table and the mobile cards, so they can never drift. */}
      <section className="pt-8 pb-4 md:py-8 bg-background"><details className="container max-w-4xl"><summary className="min-h-[48px] cursor-pointer text-lg font-semibold text-primary underline">Compare services and add-ons</summary>
        <div className="container max-w-4xl">
          <h2 className="font-heading text-2xl font-bold mb-3 text-center">Standard, deep or move-out — what&apos;s actually different</h2>
          <p className="text-center text-muted-foreground mb-8">
            All three follow the same published room-by-room checklist. The difference is the interiors — and whether the home is lived-in or empty: a deep clean resets a lived-in home, a move-in/out clean prepares an empty one.
          </p>
          <div className="hidden md:block overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="bg-card">
                  <th className="p-4 font-semibold"></th>
                  <th className="p-4 font-heading font-bold">Standard</th>
                  <th className="p-4 font-heading font-bold">Deep clean</th>
                  <th className="p-4 font-heading font-bold">Move‑in / Move‑out</th>
                </tr>
              </thead>
              <tbody className="[&_td]:p-4 [&_th]:p-4 [&_tr]:border-t [&_tr]:border-border align-top">
                {comparisonRows(disp).map((row) => (
                  <tr key={row.label}>
                    <th className="font-semibold">{row.label}</th>
                    <td>{row.standard}</td>
                    <td>{row.deep}</td>
                    <td>{row.move}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="md:hidden space-y-4">
            {comparisonCards(disp).map((card) => (
              <div key={card.title} className="rounded-xl border border-border bg-card p-4">
                <h3 className="font-heading font-bold mb-3">{card.title}</h3>
                <dl className="space-y-2 text-sm">
                  {card.rows.map((r) => (
                    <div key={r.label} className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">{r.label}</dt>
                      <dd className="font-semibold text-right">{r.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
            Haven&apos;t had a professional clean in the last 3 months? Your first visit is a deep clean — that rule is
            explained on the quote page before you send anything, and after that first visit standard rates apply.
            Deep and move-in/out prices already include the oven, fridge and cabinet interiors — they are never charged twice.
          </p>
        </div>
      </details>
      </section>

    </div>
  );
};

type ComparisonRow = { label: string; standard: React.ReactNode; deep: React.ReactNode; move: React.ReactNode };

const comparisonRows = (disp: (n: number) => number): ComparisonRow[] => [
  { label: "Best for", standard: "Regular upkeep of a lived-in home", deep: "A reset — or no professional clean in the last 3 months", move: "An empty home, moving in or out" },
  { label: "Home state", standard: "Lived-in home", deep: "Lived-in home", move: "Empty home — nothing left inside" },
  { label: "Room-by-room checklist", standard: "Included", deep: "Included", move: "Included" },
  { label: "Inside oven", standard: <>Add-on +${disp(ADDONS.insideOven.price)} per visit</>, deep: "Included", move: "Included" },
  { label: "Inside fridge", standard: <>Add-on +${disp(ADDONS.insideFridge.price)} per visit</>, deep: "Included", move: "Included" },
  { label: "Inside cabinets & drawers", standard: <>Add-on +${disp(ADDONS.insideCabinets.price)} per visit</>, deep: "Included", move: "Included — every cabinet & drawer" },
  { label: "Interior windows", standard: <>Add-on +${disp(ADDONS.interiorWindow.price)} per window</>, deep: <>Add-on +${disp(ADDONS.interiorWindow.price)} per window</>, move: <>Add-on +${disp(ADDONS.interiorWindow.price)} per window</> },
  {
    label: "Price — small / medium / large",
    standard: <>{fmtPrice(disp(PRICES.standardOnetime.S))} / {fmtPrice(disp(PRICES.standardOnetime.M))} / {fmtPrice(disp(PRICES.standardOnetime.L))} one-time<br />{fmtPrice(disp(PRICES.recurring.S))} / {fmtPrice(disp(PRICES.recurring.M))} / {fmtPrice(disp(PRICES.recurring.L))} every other week</>,
    deep: <>{fmtPrice(disp(PRICES.deep.S))} / {fmtPrice(disp(PRICES.deep.M))} / {fmtPrice(disp(PRICES.deep.L))} per visit</>,
    move: <>{fmtPrice(disp(PRICES.moveinout.S))} / {fmtPrice(disp(PRICES.moveinout.M))} / {fmtPrice(disp(PRICES.moveinout.L))} per visit</>,
  },
];

const comparisonCards = (disp: (n: number) => number) => {
  const rows = comparisonRows(disp);
  const titles = ["Standard", "Deep clean", "Move‑in / Move‑out"] as const;
  const keys = ["standard", "deep", "move"] as const;
  return titles.map((title, i) => ({
    title,
    rows: rows.map((r) => ({ label: r.label, value: r[keys[i]] })),
  }));
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
          <Link to={s.link} data-main-cta>See your price</Link>
        </Button>
      </div>
      <div className="flex-1 w-full">
        <div className="bg-background rounded-xl px-6 py-4">
          <ul className="space-y-1.5 mb-4">
            {s.includes.slice(0, 3).map((item) => (
              <li key={`preview-${item}`} className="flex items-start gap-2 text-base text-foreground">
                <Sparkles className="w-3.5 h-3.5 text-golden mt-0.5 flex-shrink-0" />
                {item}
              </li>
            ))}
          </ul>
          {s.includes.length > 3 && (
            <Accordion type="single" collapsible>
              <AccordionItem value="included" className="border-b-0">
                <AccordionTrigger className="font-heading text-lg font-semibold hover:no-underline pt-0 min-h-[44px]">
                  {s.includes.length - 3} more included
                </AccordionTrigger>
                <AccordionContent>
                  <ul className="space-y-2 pt-2">
                    {s.includes.slice(3).map((item) => (
                      <li key={item} className="flex items-start gap-2 text-base text-foreground">
                        <Sparkles className="w-4 h-4 text-golden mt-0.5 flex-shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}
        </div>
      </div>
    </div>
  );
};

export default Services;
