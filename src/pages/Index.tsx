import { CheckCircle2, MapPin, Tag, Wallet, CalendarX, ShieldCheck } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import SEO from "@/components/SEO";
import { Button } from "@/components/ui/button";
import IncludedRooms from "@/components/IncludedRooms";
import heroImage from "@/assets/expect-living-fireplace.webp";
import coversImage from "@/assets/expect-kitchen-white.webp";
import founderAsset from "@/assets/nik-founder.jpeg.asset.json";
import { OFFER_TEXT } from "@/config/offer";
import { PRICES, TIERS, FOUNDING_FIRST_CLEAN } from "@/config/calculator";

const heroTrust = [
  { Icon: Tag, label: "See your exact price" },
  { Icon: ShieldCheck, label: "Same day, same time, every other week" },
];

// Every-other-week prices come from the same tier table the /quote page uses.
const biweeklyRows = TIERS.map(({ key, rooms }) => ({
  label: rooms,
  price: PRICES.recurring[key],
}));

const steps = [
  ["1", "Get your price", "tell us your ZIP, home size and service."],
  ["2", "Pick your day", "choose a weekday and arrival window. It stays the same every other week."],
  ["3", "We clean", "your cleaner arrives with everything needed."],
];

const trustBadges = [
  { Icon: Tag, label: "See your price online", text: "Your price is based on the home details you enter. No in-home estimate." },
  { Icon: CalendarX, label: "Free cancellation", text: "Reschedule or cancel free up to 48 hours before your visit. Later cancellations: $25. If we can't get in at the scheduled time, the full visit price is charged." },
  { Icon: Wallet, label: "Approve, then pay", text: "You see the photo report before we charge your card. No response within 24 hours = approved." },
];

const included = [
  { room: "Kitchen", tasks: ["Counters and backsplash wiped", "Sink and fixtures cleaned", "Appliance exteriors wiped", "Floors vacuumed and mopped"] },
  { room: "Bathrooms", tasks: ["Toilets, tubs and showers cleaned", "Counters and sinks sanitized", "Mirrors polished", "Floors vacuumed and mopped"] },
  { room: "Bedrooms", tasks: ["Furniture and surfaces dusted", "Beds neatly made", "Floors vacuumed", "Trash removed"] },
  { room: "Living areas", tasks: ["Furniture and surfaces dusted", "Floors vacuumed and mopped", "Mirrors cleaned", "Trash removed"] },
];

const pricingPoints = [
  "Every-other-week visits cost less than one-time cleans: the house never builds up weeks of grime, so each visit takes less time.",
  "Everything included in a standard clean is listed on this site, room by room. Anything not on that list is an optional add-on.",
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
        "@type": "LocalBusiness",
        "@id": "https://gatehousehomecleaning.com/#business",
        name: "Gatehouse Home Cleaning",
        url: "https://gatehousehomecleaning.com/",
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
    <section className="hero-section border-b border-border/60 bg-background pt-[88px] pb-10 md:max-h-[80vh] md:pt-24 md:pb-12">
      <div className="container">
        <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-8 md:grid-cols-2 md:gap-10">
          <figure className="order-2 md:order-2">
            <img
              src={heroImage}
              alt="Illustrative photo of a living room"
              loading="eager"
              className="h-44 w-full rounded-xl object-cover shadow-warm sm:h-56 md:h-[320px] lg:h-[360px]"
            />
            <figcaption className="mt-2 text-center text-xs text-muted-foreground md:text-left">Illustrative photo.</figcaption>
          </figure>
          <div className="order-1 animate-fade-up text-center md:order-1 md:text-left">
            <h1 className="hero-h1 font-heading text-[34px] font-extrabold leading-[1.18] text-sage-foreground md:text-[44px] lg:text-[50px]">
              House Cleaning Every Other Week — Same Day, Same Time
            </h1>
            <p className="mt-4 text-base font-medium leading-relaxed text-foreground md:text-lg">
              Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell.
            </p>
            <p className="mt-2 text-base font-semibold text-sage-foreground md:text-lg">
              No promo codes. No membership fee. No long-term commitment.
            </p>
            <Button asChild variant="hero" size="lg" className="mt-6 rounded-full px-8">
              <Link to="/quote">See My Exact Price</Link>
            </Button>
            <p className="mt-3 text-sm font-medium text-muted-foreground">
              You approve the clean before we charge your card.
            </p>
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

    <div className="border-b border-border/60 bg-background py-4">
      <div className="container flex items-center justify-center gap-3">
        <img src={founderAsset.url} alt="Nick, owner of Gatehouse Home Cleaning" className="h-11 w-11 shrink-0 rounded-full object-cover" />
        <div className="text-sm text-foreground">
          <p className="font-semibold">You can reach a real person</p>
          <p>Nick, owner — <a className="text-primary underline" href="mailto:hello@gatehousehomecleaning.com">hello@gatehousehomecleaning.com</a></p>
        </div>
      </div>
    </div>

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

    {/* 3. WHAT A STANDARD CLEAN COVERS */}
    <section className={`${sectionClass} bg-background`}>
      <div className="container">
        <h2 className="mb-7 text-center font-heading text-2xl font-bold text-sage-foreground md:text-heading-primary">What a standard clean covers</h2>
        <div className="mx-auto grid max-w-6xl grid-cols-1 items-start gap-8 lg:grid-cols-[1fr_320px]">
          <div>
            {/* Columns on tablet+, accordion on phones — rendered once */}
            <IncludedRooms rooms={included} />
            <p className="mt-6 text-left text-base font-medium leading-relaxed text-foreground">
              Anything not on this list is an optional add-on. Add-on prices are listed on the What's Included page.
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
    <section className={sectionClass} style={{ background: "hsl(var(--surface-alt))" }}>
      <div className="container">
        <div className="mx-auto max-w-3xl">
          <div className="text-center">
            <h2 className="font-heading text-2xl font-bold text-sage-foreground md:text-heading-primary">How our pricing works</h2>
            <p className="eyebrow mt-3 text-primary">Published, not hidden behind a phone call.</p>
          </div>
          <p className="mt-4 text-left text-base leading-relaxed text-foreground md:mt-5 md:text-lg">
            Your price depends on home size, bedrooms, full and half bathrooms, the type of clean, how often we visit, whether a professional cleaned the home in the last 3 months, and any add-ons you pick.
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
                    <td className="py-2 text-sm text-foreground">${price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-sm text-foreground">Most homes get an exact price online. Larger homes — <a href="mailto:hello@gatehousehomecleaning.com" className="text-primary underline">email us</a> for a custom quote.</p>
          </div>
        </div>
      </div>
    </section>

    {/* 5. THREE SIMPLE STEPS */}
    <section className={`${sectionClass} bg-background`}>
      <div className="container">
        <div className="mx-auto mb-6 max-w-2xl text-center">
          <p className="eyebrow mb-2 text-muted-foreground">How It Works</p>
          <h2 className="font-heading text-2xl font-bold text-sage-foreground md:text-heading-secondary">Three simple steps</h2>
        </div>
        <ol className="mx-auto grid max-w-5xl grid-cols-1 gap-3 md:grid-cols-3 md:gap-5">
          {steps.map(([number, title, text]) => (
            <li key={number} className="clarity-card flex h-full flex-col gap-3 rounded-lg bg-card p-5 shadow-warm">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary font-heading font-bold text-primary-foreground" aria-hidden="true">{number}</span>
                <p className="pt-1 text-base leading-relaxed text-foreground">
                  <strong className="font-semibold text-sage-foreground">{title}</strong> — {text}
                </p>
              </div>
              {number === "3" && (
                <figure className="mt-1 flex items-start gap-3 border-t border-border/60 pt-3">
                  <img
                    src={founderAsset.url}
                    alt="Nick, owner of Gatehouse Home Cleaning"
                    loading="lazy"
                    className="h-12 w-12 shrink-0 rounded-full object-cover"
                  />
                  <figcaption className="text-sm leading-relaxed text-muted-foreground">
                    “I run Gatehouse myself, and my brother handles everything on the ground here in North Atlanta.” — Nick, owner
                  </figcaption>
                </figure>
              )}
            </li>
          ))}
        </ol>
        <p className="mx-auto mt-5 max-w-5xl text-left text-sm leading-relaxed text-foreground md:text-center md:text-base">
          You can send a booking request any time. We confirm your booking within one business day and give you a one-hour arrival window.
        </p>
      </div>
    </section>

    {/* 6. FOUNDING CLIENTS */}
    <section className={sectionClass} style={{ background: "hsl(var(--surface-alt))" }}>
      <div className="container max-w-3xl text-center">
        <p className="eyebrow mb-2 text-primary">First 10 Homes</p>
        <h2 className="font-heading text-2xl font-bold text-sage-foreground md:text-heading-primary">Become a founding client</h2>
        <p className="mt-4 text-left text-base leading-relaxed text-foreground md:text-lg">
          {OFFER_TEXT}
        </p>
        <p className="mt-3 text-base font-semibold text-sage-foreground">Founding first-clean price: ${FOUNDING_FIRST_CLEAN.S} / ${FOUNDING_FIRST_CLEAN.M} / ${FOUNDING_FIRST_CLEAN.L} for small / medium / large homes.</p>
        <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Limited to the first 10 households in our service area. The founding price applies to the first booking. Founding rate is held for six months from the first clean.
        </p>
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
              className="inline-flex items-center gap-1.5 rounded-full bg-peach/40 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-peach/70"
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
