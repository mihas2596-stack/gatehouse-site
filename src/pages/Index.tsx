import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import SEO from "@/components/SEO";
import { Button } from "@/components/ui/button";
import IncludedRooms from "@/components/IncludedRooms";
import ReportShowcase from "@/components/ReportShowcase";
import heroImage from "@/assets/hero-real-bedroom.webp";
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
    n: "01",
    title: "See your price",
    text: "Tell us about your home to see your price online.",
  },
  {
    n: "02",
    title: "Request your visit",
    text: "We’ll email you to confirm your date, arrival window, and cleaner.",
  },
  {
    n: "03",
    title: "Review your clean",
    text: "Get your photos and checklist. Approve to pay, or report an issue.",
  },
];

const included = [
  { room: "Kitchen", tasks: ["Counters and backsplash wiped", "Sink and fixtures cleaned", "Appliance exteriors wiped", "Floors vacuumed and mopped"] },
  { room: "Bathrooms", tasks: ["Toilets, tubs and showers cleaned", "Counters and sinks sanitized", "Mirrors polished", "Floors vacuumed and mopped"] },
  { room: "Bedrooms", tasks: ["Furniture and surfaces dusted", "Beds neatly made", "Floors vacuumed or mopped", "Trash removed"] },
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
    a: "Nothing is charged today. After the visit you get a photo report: approve it to pay, or your card is charged automatically 24 hours after we send it if you haven't reported an issue. Reporting an issue blocks the automatic charge for that visit. It never resumes on its own — you approve again to pay.",
  },
  {
    q: "Do I need to be home?",
    a: "No. When you book, you choose: meet the cleaner yourself, have someone else meet them, arrange access separately, or decide later. Entry codes and key details are never asked for in open notes — you add them privately on your confirmed visit page.",
  },
  {
    q: "How do I cancel?",
    a: "Free up to 48 hours before your visit; $25 inside 48 hours. If the cleaner cannot enter at the scheduled time, the full visit price applies. See our access policy in the Terms. There's no long-term commitment: pause or stop the schedule any time.",
  },
];

const sectionClass = "border-b border-border/60 py-8 md:py-10";

const Index = () => {
  const [sampleOpen, setSampleOpen] = useState(false);
  const sampleToggleRef = useRef<HTMLButtonElement>(null);
  // Tell the floating action to stand down while the sample is open:
  // its checklist otherwise scrolls underneath the pill.
  useEffect(() => {
    document.body.dataset.sampleOpen = sampleOpen ? "true" : "false";
    return () => { delete document.body.dataset.sampleOpen; };
  }, [sampleOpen]);
  const closeSample = () => {
    setSampleOpen(false);
    sampleToggleRef.current?.focus();
  };
  return (
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
      title="House Cleaning in North Atlanta | Gatehouse"
      description="One-time, recurring and deep house cleaning in Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell. See your price online."
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
      <div className="container max-w-[1320px]">
        <div className="grid grid-cols-1 items-center gap-8 md:grid-cols-[0.9fr_1.1fr] md:gap-10 lg:gap-14">
          <div className="animate-fade-up text-center md:text-left">
            <p className="mb-4 text-base font-semibold tracking-wide text-primary">HOUSE CLEANING IN NORTH ATLANTA</p>
            <h1 className="hero-h1 font-heading text-[34px] font-extrabold leading-[1.18] text-sage-foreground md:text-[44px] lg:text-[60px]">
              A cleaner home.<br />More time for you.
            </h1>
            <p className="mt-5 max-w-lg mx-auto md:mx-0 text-lg leading-relaxed text-foreground">
              One-time, recurring, and deep cleaning for your home. See your price online. Review your photo report after the clean.
            </p>
            <Button asChild variant="hero" size="lg" className="mt-6 rounded-full px-8">
              <Link to="/quote" data-main-cta>See My Price</Link>
            </Button>
            <p className="mt-3 text-base text-muted-foreground">No contact details or card needed to see your price.</p>
          </div>
          <figure>
            <img
              src={heroImage}
              alt="Freshly cleaned bedroom — real photo from a Gatehouse clean"
              loading="eager"
              className="aspect-[16/10] w-full rounded-2xl object-cover object-[center_35%] shadow-warm"
            />
          </figure>
        </div>
      </div>
    </section>

    {/* 2. HOW IT WORKS — three numbered steps, sample on demand, pay memo. */}
    <section className={sectionClass} style={{ background: "hsl(var(--surface-alt))" }}>
      <div className="container">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-6 text-center font-heading text-2xl font-bold text-sage-foreground md:text-heading-secondary">How it works</h2>
          <ol className="space-y-5">
            {howItWorks.map(({ n, title, text }) => (
              <li key={n} className="flex items-start gap-4">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary font-heading text-base font-bold text-primary-foreground"
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
          <div className="mt-6">
            <Button
              ref={sampleToggleRef}
              variant="outline"
              size="sm"
              className="min-h-[44px] rounded-full"
              aria-expanded={sampleOpen}
              aria-controls="home-sample-report"
              onClick={() => setSampleOpen((v) => !v)}
            >
              {sampleOpen ? "Hide sample report" : "View sample report"}
            </Button>
          </div>
          {sampleOpen && (
            <div id="home-sample-report" className="mt-6">
              <ReportShowcase />
              <div className="mt-4 text-center">
                <Button variant="outline" size="sm" className="min-h-[44px] rounded-full" onClick={closeSample}>
                  Close sample report
                </Button>
              </div>
            </div>
          )}
          {/* 3. WHEN YOU PAY — always visible, no manual-only implication. */}
          <div className="mt-8 border-t border-border pt-6">
            <h3 className="font-heading text-lg font-bold text-sage-foreground">When you pay</h3>
            <dl className="mt-3 space-y-4">
              <div>
                <dt className="font-semibold text-sage-foreground">At booking</dt>
                <dd className="mt-0.5 text-base leading-relaxed text-foreground">Save your card. You pay $0.</dd>
              </div>
              <div>
                <dt className="font-semibold text-sage-foreground">After your clean</dt>
                <dd className="mt-0.5 text-base leading-relaxed text-foreground">Review your photo report. Approve it to pay.</dd>
              </div>
              <div>
                <dt className="font-semibold text-sage-foreground">After 24 hours</dt>
                <dd className="mt-0.5 text-base leading-relaxed text-foreground">If you haven’t approved or reported an issue, we charge your card automatically 24 hours after we send the report.</dd>
              </div>
            </dl>
            <details className="mt-5 rounded-lg border border-border bg-card px-4 py-3">
              <summary className="cursor-pointer text-base font-semibold text-sage-foreground">What if something was missed?</summary>
              <p className="mt-2 text-base leading-relaxed text-foreground">
                Email a photo to{" "}
                <a href="mailto:hello@gatehousehomecleaning.com" className="font-semibold text-primary underline break-all">hello@gatehousehomecleaning.com</a>{" "}
                within 24 hours after your photo report is sent. Reporting an issue within that window blocks the automatic charge for this visit. We fix it free within 72 hours after you report it. After the fix, you approve the report again to pay — the automatic charge never resumes on its own.
              </p>
            </details>
          </div>
        </div>
      </div>
    </section>

    {/* 4. WHAT'S INCLUDED — price guide, then a compact pointer on phones. */}
    <section className={`${sectionClass} bg-background`}>
      <div className="container">
        <p className="mx-auto max-w-2xl text-center text-base leading-relaxed text-foreground">
          Every-other-week visits from {fmtPrice(disp(PRICES.recurring.S))} per visit. Your exact price depends on your home.
        </p>
        <h2 className="mb-3 mt-6 text-center font-heading text-2xl font-bold text-sage-foreground md:text-heading-primary">What&apos;s included in each visit</h2>
        <div className="mx-auto max-w-2xl text-center sm:hidden">
          <p className="text-base leading-relaxed text-foreground">We clean your kitchen, bathrooms, bedrooms, and living areas.</p>
          <Link to="/whats-included" className="mt-3 inline-flex min-h-[44px] items-center font-semibold text-primary underline">
            View the room-by-room checklist →
          </Link>
        </div>
        <div className="hidden sm:block">
          <div className="mx-auto grid max-w-6xl grid-cols-1 items-start gap-8 lg:grid-cols-[1fr_320px]">
            <div>
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
      </div>
    </section>

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
};

export default Index;
