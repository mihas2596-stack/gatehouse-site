import { MapPin } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import SEO from "@/components/SEO";
import { Button } from "@/components/ui/button";
import IncludedRooms from "@/components/IncludedRooms";
import ReportShowcase from "@/components/ReportShowcase";
import heroImage from "@/assets/expect-living-fireplace.webp";
import coversImage from "@/assets/expect-kitchen-white.webp";
import { PRICES, TIERS , fmtPrice, globalTestCutActive, scaleTestPrice} from "@/config/calculator";

import { CITIES } from "@/config/cities";

const cities = CITIES.map((c) => c.name);

// Every-other-week prices come from the same tier table the /quote page uses.
// During the owner-ordered global test window these scale like every other
// price on the site; evaluated at page load in the browser.
const disp = (n: number): number => (globalTestCutActive() ? scaleTestPrice(n) : n);
const biweeklyRows = TIERS.map(({ key, rooms }) => ({
  label: rooms,
  price: disp(PRICES.recurring[key]),
}));

const howItWorks = [
  {
    n: "1",
    title: "See your price",
    text: "Answer a few questions about your home. Your price appears instantly — no phone call needed.",
  },
  {
    n: "2",
    title: "We confirm and clean",
    text: "We confirm your date, arrival window and cleaner by email. A request is not a confirmed visit until we confirm it.",
  },
  {
    n: "3",
    title: "Review your report",
    text: "After the visit, you get photos and the checklist, room by room.",
  },
];

const included = [
  { room: "Kitchen", tasks: ["Counters and backsplash wiped", "Sink and fixtures cleaned", "Appliance exteriors wiped", "Floors vacuumed and mopped"] },
  { room: "Bathrooms", tasks: ["Toilets, tubs and showers cleaned", "Counters and sinks sanitized", "Mirrors polished", "Floors vacuumed and mopped"] },
  { room: "Bedrooms", tasks: ["Furniture and surfaces dusted", "Beds neatly made", "Floors vacuumed", "Trash removed"] },
  { room: "Living areas", tasks: ["Furniture and surfaces dusted", "Floors vacuumed and mopped", "Mirrors cleaned", "Trash removed"] },
];

// Short answers for the home page; the full FAQ page has the complete list.
const homeFaqs = [
  {
    q: "What's included in a standard clean?",
    a: "Every room on the checklist — kitchen, bathrooms, bedrooms and living areas, dusted, wiped, vacuumed and mopped. Extras like inside the oven or fridge, inside cabinets, interior windows and pet hair cost extra and are priced on the What's Included page.",
  },
  {
    q: "How do I pay?",
    a: "Nothing is charged today. After the visit you get a photo report: approve it to pay, or your card is charged automatically 24 hours after we send it if you haven't reported an issue. Reporting an issue blocks the automatic charge for that visit.",
  },
  {
    q: "Do I need to be home?",
    a: "No. When you book, you choose: meet the cleaner yourself, have someone else meet them, arrange access separately, or decide later. Entry codes and key details are never asked for in open notes — you add them privately on your confirmed visit page.",
  },
  {
    q: "How do I cancel?",
    a: "Free up to 48 hours before your visit; $25 inside 48 hours. If we can't get in, the full visit price applies — see Terms. There's no long-term commitment: pause or stop the schedule any time.",
  },
];

const sectionClass = "border-b border-border/60 py-8 md:py-10";

const Index = () => (
  <div className="bg-background">
    {/* While the owner-ordered global test window is active, the
        homepage prices below are scaled — say so, like /quote does.
        Self-expires with the window; no deploy needed to remove it. */}
    {globalTestCutActive() && (
      <p className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-center text-sm">
        Test pricing is active. The prices shown are reduced for payment testing.
      </p>
    )}
    <SEO
      title="Every-Other-Week House Cleaning in North Atlanta | Gatehouse"
      description="Every-other-week cleaning in Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell. See your price online."
      url="https://gatehousehomecleaning.com/"
    />
    <Helmet>
      <script type="application/ld+json">{JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": "https://www.gatehousehomecleaning.com/#business",
        name: "Gatehouse Home Cleaning",
        url: "https://www.gatehousehomecleaning.com/",
        image: "https://gatehousehomecleaning.com/og-image.png",
        email: "hello@gatehousehomecleaning.com",
        areaServed: cities.map((name) => ({
          "@type": "City",
          name,
          containedInPlace: { "@type": "State", name: "Georgia" },
        })),
      })}</script>
    </Helmet>

    {/* 1. HERO — one headline, one sentence, one action. */}
    <section className="hero-section border-b border-border/60 bg-background pt-10 pb-12 md:pt-14 md:pb-16">
      <div className="container">
        <div className="grid grid-cols-1 items-center gap-8 md:grid-cols-2 md:gap-12 lg:gap-16">
          <div className="animate-fade-up text-center md:text-left">
            <h1 className="hero-h1 font-heading text-[34px] font-extrabold leading-[1.18] text-sage-foreground md:text-[46px] lg:text-[56px]">
              A clean home, every other week.
            </h1>
            <p className="mt-4 text-base font-medium leading-relaxed text-foreground md:text-lg">
              House cleaning in North Atlanta. One-time and deep cleaning also available.
            </p>
            <Button asChild variant="hero" size="lg" className="mt-6 rounded-full px-8">
              <Link to="/quote" data-main-cta>See My Price</Link>
            </Button>
          </div>
          <figure>
            <img
              src={heroImage}
              alt="Living room in a freshly cleaned home (stock photo)"
              loading="eager"
              className="h-52 w-full rounded-xl object-cover shadow-warm sm:h-64 md:h-[380px] lg:h-[440px]"
            />
          </figure>
        </div>
      </div>
    </section>

    {/* 2. WHAT A STANDARD CLEAN COVERS */}
    <section className={`${sectionClass} bg-background`}>
      <div className="container">
        <h2 className="mb-3 text-center font-heading text-2xl font-bold text-sage-foreground md:text-heading-primary">What a standard clean covers</h2>
        <p className="mx-auto mb-7 max-w-2xl text-center text-base leading-relaxed text-foreground">
          Every visit covers these rooms, top to bottom. Tap a room to see its checklist.
        </p>
        <div className="mx-auto grid max-w-6xl grid-cols-1 items-start gap-8 lg:grid-cols-[1fr_320px]">
          <div>
            {/* Columns on tablet+, accordion on phones — rendered once */}
            <IncludedRooms rooms={included} />
            <p className="mt-6 text-left text-base leading-relaxed text-foreground">
              Optional extras — inside the oven or fridge, inside cabinets, interior windows, extra pet-hair work — are priced on the What&apos;s Included page.
            </p>
            <Button asChild variant="outline" size="lg" className="mt-5 rounded-full">
              <Link to="/whats-included">See the full checklist</Link>
            </Button>
          </div>
          <figure className="hidden lg:block">
            <img
              src={coversImage}
              alt="Illustrative photo of a kitchen"
              loading="lazy"
              className="h-full max-h-[420px] w-full rounded-xl object-cover shadow-warm"
            />
            <figcaption className="mt-2 text-xs text-muted-foreground">Illustrative photo.</figcaption>
          </figure>
        </div>
      </div>
    </section>

    {/* 3. HOW IT WORKS — three steps, one payment block. */}
    <section className={`${sectionClass} bg-background`}>
      <div className="container">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-7 text-center font-heading text-2xl font-bold text-sage-foreground md:text-heading-secondary">How it works</h2>
          <ol className="space-y-6">
            {howItWorks.map(({ n, title, text }) => (
              <li key={n} className="flex items-start gap-4">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary font-heading text-lg font-bold text-primary-foreground"
                  aria-hidden="true"
                >
                  {n}
                </span>
                <div>
                  <p className="font-heading text-lg font-bold text-sage-foreground">{title}</p>
                  <p className="mt-1 text-base leading-relaxed text-foreground">{text}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-8 rounded-xl border-2 border-primary/40 bg-primary/5 p-5">
            <h3 className="font-heading text-lg font-bold text-sage-foreground">How payment works</h3>
            <p className="mt-2 text-base leading-relaxed text-foreground">
              <strong>Nothing is charged today.</strong> Your card is charged when you approve the report, or automatically 24 hours after we send it if you haven&apos;t reported an issue.
            </p>
            <p className="mt-2 text-base leading-relaxed text-foreground">
              Report an issue and the automatic charge is blocked for this visit — it never runs on its own afterwards. You approve again to pay once we&apos;ve fixed it.
            </p>
            <p className="mt-2 text-base leading-relaxed text-foreground">
              Your card is processed by Stripe. We never see or store your full card number.
            </p>
            <p className="mt-3 border-t border-primary/20 pt-3 text-base leading-relaxed text-foreground">
              Something missed? We fix it free within 72 hours — email a photo to{" "}
              <a href="mailto:hello@gatehousehomecleaning.com" className="font-semibold text-primary underline break-all">hello@gatehousehomecleaning.com</a>{" "}
              within 24 hours after your photo report is sent.
            </p>
          </div>
        </div>
      </div>
    </section>

    {/* 4. SAMPLE REPORT */}
    <ReportShowcase />

    {/* 5. HOW OUR PRICING WORKS */}
    <section id="pricing" className={sectionClass} style={{ background: "hsl(var(--surface-alt))" }}>
      <div className="container">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-center font-heading text-2xl font-bold text-sage-foreground md:text-heading-primary">How our pricing works</h2>
          <p className="mt-4 text-left text-base leading-relaxed text-foreground md:text-lg">
            Your price is based on bedrooms, full bathrooms, the type of clean, how often we visit, your cleaning history and add-ons. Square footage and half bathrooms help us plan the visit; they do not change the calculator price.
          </p>
          <div className="mt-7 rounded-lg border border-border bg-card p-5 shadow-warm">
            <table className="w-full border-collapse text-left">
              <caption className="mb-3 text-left font-heading text-lg font-semibold text-sage-foreground">
                Price per visit, every other week
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="pb-2 pr-3 text-sm font-semibold text-sage-foreground">Home size</th>
                  <th scope="col" className="pb-2 text-sm font-semibold text-sage-foreground">Price per visit</th>
                </tr>
              </thead>
              <tbody>
                {biweeklyRows.map(({ label, price }) => (
                  <tr key={label} className="border-b border-border/60 last:border-0">
                    <th scope="row" className="py-2 pr-3 text-sm font-medium text-foreground">{label}</th>
                    <td className="py-2 text-sm text-foreground">{fmtPrice(price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-sm text-foreground">If a professional cleaned your home in the last 3 months, your first visit is a standard clean. If not, your first visit is a deep clean. Most homes can see an estimate online. Larger homes — <a href="mailto:hello@gatehousehomecleaning.com" className="text-primary underline">email us</a> for a custom quote.</p>
          </div>
        </div>
      </div>
    </section>

    {/* 6. COMMUNITIES */}
    <section id="areas" className={`${sectionClass} scroll-mt-16 bg-background md:scroll-mt-24`}>
      <div className="container max-w-4xl text-center">
        <h2 className="font-heading text-2xl font-bold text-sage-foreground md:text-heading-secondary">Communities served</h2>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {CITIES.map(({ slug, name: city }) => (
            <Link
              key={slug}
              to={`/areas/${slug}`}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-peach/40 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-peach/70"
            >
              <MapPin className="h-3.5 w-3.5 text-primary" aria-hidden="true" /> {city}
            </Link>
          ))}
        </div>
      </div>
    </section>

    {/* 7. SHORT FAQ — answers collapsed, full page linked. */}
    <section id="faq" className={`${sectionClass} scroll-mt-16 md:scroll-mt-24`} style={{ background: "hsl(var(--surface-alt))" }}>
      <div className="container max-w-3xl">
        <h2 className="mb-6 text-center font-heading text-2xl font-bold text-sage-foreground md:text-heading-secondary">Frequently asked questions</h2>
        <div className="space-y-3">
          {homeFaqs.map(({ q, a }) => (
            <details key={q} className="rounded-lg border border-border bg-card px-4 py-3">
              <summary className="cursor-pointer text-base font-semibold text-sage-foreground">{q}</summary>
              <p className="mt-2 text-base leading-relaxed text-foreground">{a}</p>
            </details>
          ))}
        </div>
        <div className="mt-6 text-center">
          <Button asChild variant="outline" size="lg" className="rounded-full">
            <Link to="/faq">Read the full FAQ</Link>
          </Button>
        </div>
      </div>
    </section>

    {/* 8. FINAL ACTION — the footer below carries contacts and links. */}
    <section className="py-10 md:py-12">
      <div className="container text-center">
        <Button asChild variant="hero" size="lg" className="rounded-full px-8">
          <Link to="/quote" data-main-cta>See My Price</Link>
        </Button>
      </div>
    </section>
  </div>
);

export default Index;
