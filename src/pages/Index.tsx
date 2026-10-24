import { CheckCircle2, MapPin, Tag, Wallet, CalendarX, ShieldCheck, Calculator, CreditCard, Camera } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import SEO from "@/components/SEO";
import { Button } from "@/components/ui/button";
import IncludedRooms from "@/components/IncludedRooms";
import ReportShowcase from "@/components/ReportShowcase";
import heroImage from "@/assets/expect-living-fireplace.webp";
import coversImage from "@/assets/expect-kitchen-white.webp";
import { PRICES, TIERS , fmtPrice, globalTestCutActive, scaleTestPrice} from "@/config/calculator";

const heroTrust = [
  { Icon: Tag, label: "See your price" },
  { Icon: ShieldCheck, label: "Same day, same time, every other week" },
];

// Every-other-week prices come from the same tier table the /quote page uses.
// During the owner-ordered 48h global test window (2026-10-24) these scale
// like every other price on the site; evaluated at page load in the browser.
const disp = (n: number): number => (globalTestCutActive() ? scaleTestPrice(n) : n);
const biweeklyRows = TIERS.map(({ key, rooms }) => ({
  label: rooms,
  price: disp(PRICES.recurring[key]),
}));

const howItWorks = [
  {
    n: "1",
    Icon: Calculator,
    title: "See your price",
    text: `Answer a few questions about your home. Your price appears instantly — ${fmtPrice(disp(PRICES.recurring.S))}, ${fmtPrice(disp(PRICES.recurring.M))} or ${fmtPrice(disp(PRICES.recurring.L))}. No phone call needed.`,
    highlight: false,
  },
  {
    n: "2",
    Icon: CreditCard,
    title: "Book and save your card",
    text: "Pick your preferred day and save your card — $0 is charged today. We confirm your date by email.",
    highlight: false,
  },
  {
    n: "3",
    Icon: Camera,
    title: "We clean, you get the photos",
    text: "After the visit, you receive a photo report of every room. Your card is charged when you approve it, or automatically 24 hours after we send it if you haven't reported an issue.",
    highlight: false,
  },
  {
    n: "4",
    Icon: CheckCircle2,
    title: "Review, approve, pay",
    text: "Tap Approve when you're happy with the clean. Do nothing and your card is charged automatically 24 hours after we send the report. Flag an issue and the charge stays paused while we review it with you.",
    highlight: true,
  },
];

// Payment story for ad traffic: $0 to book, approve first, charged after approval.
// Card capture is live via Stripe Checkout (setup mode) — see SaveCard flow.
const paymentSteps = [
  ["1", "Request", "see your price and send your request. $0 charged today."],
  ["2", "Confirmed visit", "we confirm your date, arrival window and cleaner by email."],
  ["3", "Cleaning", "your cleaner works from the room-by-room checklist."],
  ["4", "Photo report", "you get before-and-after photos of every room."],
  ["5", "Review & payment", "approve the report to pay, or the charge runs automatically 24 hours after the report is sent if you haven't reported an issue."],
];

const trustBadges = [
  { Icon: Tag, label: "See your price online", text: "Your price is based on the home details you enter. No in-home estimate." },
  { Icon: CalendarX, label: "Free cancellation", text: "Free up to 48 hours before your visit. $25 inside 48 hours; full price if we can't get in. Full rules in Terms." },
  { Icon: Wallet, label: "Approve, then pay", text: "You approve the photo report, then we charge your card. No issue reported? Automatic charge 24 hours after the report is sent. Full rules in Terms." },
];

const included = [
  { room: "Kitchen", tasks: ["Counters and backsplash wiped", "Sink and fixtures cleaned", "Appliance exteriors wiped", "Floors vacuumed and mopped"] },
  { room: "Bathrooms", tasks: ["Toilets, tubs and showers cleaned", "Counters and sinks sanitized", "Mirrors polished", "Floors vacuumed and mopped"] },
  { room: "Bedrooms", tasks: ["Furniture and surfaces dusted", "Beds neatly made", "Floors vacuumed", "Trash removed"] },
  { room: "Living areas", tasks: ["Furniture and surfaces dusted", "Floors vacuumed and mopped", "Mirrors cleaned", "Trash removed"] },
];

const pricingPoints = [
  "Every-other-week visits cost less than one-time cleans: the house never builds up weeks of grime, so each visit takes less time.",
  "Everything included in a standard clean is listed on this site, room by room. Anything beyond the checklist is one of five optional add-ons with a fixed price.",
  "If a professional cleaned your home in the last 3 months, your first visit is a standard clean. If not, your first visit is a deep clean. The calculator shows both prices before you book.",
];

import { CITIES } from "@/config/cities";

const cities = CITIES.map((c) => c.name);

const sectionClass = "border-b border-border/60 py-8 md:py-10";

const Index = () => (
  <div className="bg-background pb-12 md:pb-0">
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

    {/* 1. HERO */}
    <section className="hero-section border-b border-border/60 bg-background pt-[88px] pb-12 md:pt-28 md:pb-16">
      <div className="container">
        <div className="grid grid-cols-1 items-center gap-8 md:grid-cols-2 md:gap-12 lg:gap-16">
          <figure className="order-2 md:order-2">
            <img
              src={heroImage}
              alt="Living room in a freshly cleaned home (stock photo)"
              loading="eager"
              className="h-52 w-full rounded-xl object-cover shadow-warm sm:h-64 md:h-[380px] lg:h-[440px]"
            />
          </figure>
          <div className="order-1 animate-fade-up text-center md:order-1 md:text-left">
            <h1 className="hero-h1 font-heading text-[34px] font-extrabold leading-[1.18] text-sage-foreground md:text-[46px] lg:text-[56px]">
              A Clean Home, Every Other Week
            </h1>
            <p className="mt-4 text-base font-medium leading-relaxed text-foreground md:text-lg">
              Less cleaning on your to-do list. Serving Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell.
            </p>
            <p className="mt-2 text-base font-semibold text-sage-foreground md:text-lg">
              A fixed weekday and arrival window. No membership fee or long-term commitment.
            </p>
            <p className="mt-2 text-base text-foreground md:text-lg">
              One-time and deep cleaning also available.
            </p>
            <Button asChild variant="hero" size="lg" className="mt-6 rounded-full px-8">
              <Link to="/quote">See My Price</Link>
            </Button>
            {/* Photo-report line lives in the "How payment works" section + trust badge below — no duplicate here. */}
            <ul className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-2 md:justify-start">
              {heroTrust.map(({ Icon, label }) => (
                <li key={label} className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <span>{label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>

    {/* 2. THREE BADGES */}
    {/* INSURANCE CLAIM REMOVED — restore only after GL policy is active */}
    <section className={sectionClass} style={{ background: "hsl(var(--surface-alt))" }} aria-label="Why choose Gatehouse">
      <div className="container">
        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-5 md:grid-cols-3 md:gap-8">
          {trustBadges.map(({ Icon, label, text }) => (
            <div key={label} className="flex items-start gap-3 text-left md:flex-col md:items-center md:text-center">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 md:h-12 md:w-12" aria-hidden="true">
                <Icon className="h-5 w-5 text-primary md:h-6 md:w-6" />
              </span>
              <div>
                <h2 className="font-heading text-lg font-semibold text-sage-foreground">{label}</h2>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{text}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>

    {/* 2b. REPORT SHOWCASE — approve, then pay, made tangible */}
    <ReportShowcase />

    {/* 2c. HOW PAYMENT WORKS — card-on-file story for ad traffic */}
    <section className={sectionClass} style={{ background: "hsl(var(--surface-alt))" }} aria-label="How payment works">
      <div className="container">
        <div className="mx-auto mb-6 max-w-2xl text-center">
          <p className="eyebrow mb-2 text-primary">Payment</p>
          <h2 className="font-heading text-2xl font-bold text-sage-foreground md:text-heading-secondary">How payment works</h2>
          <p className="mt-3 text-base leading-relaxed text-foreground md:text-lg">
            No prepayment. Review your room-by-room report: approve to pay, or report an issue within 24 hours. If no issue is reported, your card is charged automatically after 24 hours.
          </p>
        </div>
        <ol className="mx-auto grid max-w-5xl grid-cols-1 gap-3 md:grid-cols-3 md:gap-5">
          {paymentSteps.map(([number, title, text]) => (
            <li key={number} className="clarity-card flex h-full flex-col gap-3 rounded-lg bg-card p-5 shadow-warm">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary font-heading font-bold text-primary-foreground" aria-hidden="true">{number}</span>
                <p className="pt-1 text-base leading-relaxed text-foreground">
                  <strong className="font-semibold text-sage-foreground">{title}</strong> — {text}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mx-auto mt-5 max-w-2xl text-center text-sm leading-relaxed text-muted-foreground">
          When you pay, your card is processed securely through Stripe. We never see or store your card number.
        </p>
      </div>
    </section>

    {/* 3. WHAT A STANDARD CLEAN COVERS */}
    <section className={`${sectionClass} bg-background`}>
      <div className="container">
        <h2 className="mb-7 text-center font-heading text-2xl font-bold text-sage-foreground md:text-heading-primary">What a standard clean covers</h2>
        <div className="mx-auto grid max-w-6xl grid-cols-1 items-start gap-8 lg:grid-cols-[1fr_320px]">
          <div>
            {/* Columns on tablet+, accordion on phones — rendered once */}
            <IncludedRooms rooms={included} />
            <p className="mt-6 text-left text-base font-medium leading-relaxed text-foreground">
              This is the standard checklist for every visit. Optional extras — inside oven or fridge, inside cabinets, interior windows, extra pet-hair work — are priced on the What&apos;s Included page.
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

    {/* 3b. SOMETHING MISSED? */}
    <section className={`${sectionClass} bg-background`} aria-label="Something missed">
      <div className="container max-w-3xl text-center">
        <p className="eyebrow mb-2 text-primary">After your visit</p>
        <h2 className="font-heading text-2xl font-bold text-sage-foreground md:text-heading-secondary">
          Something missed?
        </h2>
        <p className="mt-4 text-base leading-relaxed text-foreground md:text-lg">
          Missed something on the checklist? We fix it free within 72 hours. Email a photo to{" "}
          <a href="mailto:hello@gatehousehomecleaning.com" className="font-semibold text-primary underline">hello@gatehousehomecleaning.com</a>{" "}
          within 24 hours after your photo report is sent.
        </p>
      </div>
    </section>


    {/* 4. HOW OUR PRICING WORKS */}
    <section id="pricing" className={sectionClass} style={{ background: "hsl(var(--surface-alt))" }}>
      <div className="container">
        <div className="mx-auto max-w-3xl">
          <div className="text-center">
            <h2 className="font-heading text-2xl font-bold text-sage-foreground md:text-heading-primary">How our pricing works</h2>
            <p className="eyebrow mt-3 text-primary">Published, not hidden behind a phone call.</p>
          </div>
          <p className="mt-4 text-left text-base leading-relaxed text-foreground md:mt-5 md:text-lg">
            Your price is based on bedrooms, full bathrooms, the type of clean, how often we visit, your cleaning history and add-ons. We collect square footage and half bathrooms to plan the visit; they do not change the calculator price.
          </p>
          <ul className="mt-5 space-y-3 text-left md:mt-6 md:space-y-4">
            {pricingPoints.map((point) => (
              <li key={point} className="flex items-start gap-3">
                <CheckCircle2 className="mt-1 h-[22px] w-[22px] shrink-0 text-sage-foreground" strokeWidth={2} aria-hidden="true" />
                <span className="text-sm leading-relaxed text-foreground md:text-base">{point}</span>
              </li>
            ))}
          </ul>

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
            <p className="mt-3 text-sm text-foreground">Most homes can see an estimate online. Larger homes — <a href="mailto:hello@gatehousehomecleaning.com" className="text-primary underline">email us</a> for a custom quote.</p>
          </div>
        </div>
      </div>
    </section>

    {/* 5. HOW IT WORKS — FOUR STEPS */}
    <section className={`${sectionClass} bg-background`}>
      <div className="container">
        <div className="mx-auto mb-8 max-w-2xl text-center">
          <p className="eyebrow mb-2 text-muted-foreground">How It Works</p>
          <h2 className="font-heading text-2xl font-bold text-sage-foreground md:text-heading-secondary">Four steps, zero surprises</h2>
          <p className="mt-3 text-base leading-relaxed text-foreground md:text-lg">
            Exactly what happens from your first click to the charge on your card.
          </p>
        </div>
        <ol className="mx-auto grid max-w-6xl grid-cols-1 gap-4 md:grid-cols-4 md:gap-5">
          {howItWorks.map(({ n, Icon, title, text, highlight }) => (
            <li
              key={n}
              className={`flex h-full flex-col rounded-xl p-5 shadow-warm ${
                highlight ? "border-2 border-golden bg-golden/10" : "border border-border bg-card"
              }`}
            >
              <div className="mb-3 flex items-center gap-3">
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-heading text-lg font-bold ${
                    highlight ? "bg-golden text-white" : "bg-primary text-primary-foreground"
                  }`}
                  aria-hidden="true"
                >
                  {n}
                </span>
                <Icon className={`h-6 w-6 ${highlight ? "text-golden" : "text-sage-foreground"}`} aria-hidden="true" />
              </div>
              <p className="font-heading text-lg font-bold text-sage-foreground">{title}</p>
              <p className="mt-1 text-sm leading-relaxed text-foreground md:text-base">{text}</p>
            </li>
          ))}
        </ol>
        <div className="mt-7 text-center">
          <Button asChild variant="hero" size="lg" className="rounded-full px-8">
            <Link to="/quote">See My Price</Link>
          </Button>
        </div>
      </div>
    </section>

    {/* 7. COMMUNITIES */}
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

    {/* 8. FAQ */}
    <section id="faq" className={`${sectionClass} scroll-mt-16 md:scroll-mt-24`} style={{ background: "hsl(var(--surface-alt))" }}>
      <div className="container max-w-3xl text-center">
        <p className="eyebrow mb-2 text-sage-foreground">Questions Answered</p>
        <h2 className="font-heading text-2xl font-bold text-sage-foreground md:text-heading-secondary">Frequently Asked Questions</h2>
        <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-foreground">
          Payment, access, pets, pausing and cancelling — every answer is on one page.
        </p>
        <Button asChild variant="outline" size="lg" className="mt-6 rounded-full">
          <Link to="/faq">Read the FAQ</Link>
        </Button>
      </div>
    </section>
  </div>
);

export default Index;
