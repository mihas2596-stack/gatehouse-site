import { useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import SEO from "@/components/SEO";
import { Button } from "@/components/ui/button";
import ReportShowcase from "@/components/ReportShowcase";
import heroImage from "@/assets/hero-real-bedroom.webp";

import { CITIES } from "@/config/cities";

const cities = CITIES.map((c) => c.name);

const howItWorks = [
  {
    n: "01",
    title: "See your price",
    text: "Tell us about your home and choose a cleaning.",
  },
  {
    n: "02",
    title: "Request your visit",
    text: "We’ll email you to confirm your date, arrival window and who’s coming.",
  },
  {
    n: "03",
    title: "Review your clean",
    text: "Get a private photo report and checklist after the visit.",
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
  // From the hero CTA: open the sample report and scroll to it, so a
  // visitor sees what they get right after the first "See My Price".
  const openSample = () => {
    setSampleOpen(true);
    document.getElementById("sample-report")?.scrollIntoView?.({ behavior: "smooth" });
  };
  return (
  <div className="bg-background">
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
          <div className="text-center md:text-left">
            <p className="mb-4 text-base font-semibold tracking-wide text-primary">HOUSE CLEANING IN NORTH ATLANTA</p>
            <h1 className="hero-h1 font-heading text-[34px] font-extrabold leading-[1.18] text-sage-foreground md:text-[44px] lg:text-[60px]">
              A cleaner home.<br />More time for you.
            </h1>
            <p className="mt-5 max-w-lg mx-auto md:mx-0 text-lg leading-relaxed text-foreground">
              One-time, recurring, and deep cleaning. Get a private photo report after your visit.
            </p>
            <Button asChild variant="hero" size="lg" className="mt-6 rounded-full px-8">
              <Link to="/quote" data-main-cta>See My Price</Link>
            </Button>
            <p className="mt-3 text-base text-muted-foreground">No email or card needed to see your price.</p>
            <p className="mt-1">
              <button
                type="button"
                onClick={openSample}
                className="inline-flex min-h-[44px] items-center font-semibold text-primary underline"
              >
                See a sample photo report
              </button>
            </p>
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
    <section className="border-b border-border/60 bg-[hsl(var(--surface-alt))] py-10 sm:py-12 lg:py-14" aria-labelledby="how-it-works">
      <div className="container">
        <div className="mx-auto max-w-3xl">
          <h2 id="how-it-works" className="mb-7 font-heading text-[1.875rem] font-bold leading-tight text-sage-foreground sm:mb-9 sm:text-[2.125rem] lg:text-[2.25rem]">How it works</h2>
          <ol className="flex flex-col gap-5 sm:gap-7">
            {howItWorks.map(({ n, title, text }) => (
              <li key={n} className="flex items-start gap-4">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary font-heading text-base font-bold text-primary-foreground"
                  aria-hidden="true"
                >
                  {n}
                </span>
                <div className="min-w-0">
                  <p className="font-heading text-[1.375rem] font-bold leading-tight text-sage-foreground lg:text-[1.5rem]">{title}</p>
                  <p className="mt-1.5 max-w-[60ch] text-[1.125rem] leading-relaxed text-foreground sm:text-[1.1875rem] lg:text-[1.25rem]">{text}</p>
                </div>
              </li>
            ))}
          </ol>
          <div id="sample-report" className="mt-6 scroll-mt-24">
            <Button
              ref={sampleToggleRef}
              variant="outline"
              size="sm"
              className="min-h-[48px] rounded-full px-5 text-[1.125rem]"
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
                <Button variant="outline" size="sm" className="min-h-[48px] rounded-full px-5 text-[1.125rem]" onClick={closeSample}>
                  Close sample report
                </Button>
              </div>
            </div>
          )}
          {/* 3. WHEN YOU PAY — always visible, no manual-only implication. */}
          <section id="when-you-pay" aria-labelledby="when-you-pay-heading" className="mt-9 scroll-mt-24 rounded-2xl border border-border bg-card p-5 sm:mt-10 sm:p-8">
            <h3 id="when-you-pay-heading" className="font-heading !text-[1.625rem] font-bold leading-tight text-sage-foreground sm:!text-[1.875rem] lg:!text-[2rem]">When you pay</h3>
            <p className="mt-3 text-[1.25rem] leading-relaxed text-sage-foreground sm:text-[1.375rem]"><strong>Save your card at booking — you pay $0 today.</strong></p>
            <p className="mt-3 max-w-[60ch] text-[1.125rem] leading-relaxed text-foreground sm:text-[1.1875rem] lg:text-[1.25rem]">
              See your photo report before payment. Approve to pay, or report an issue.{" "}
              <br />
              If no issue is reported, your card is charged automatically 24 hours after the report is sent.
            </p>
          </section>
        </div>
      </div>
    </section>

    <section className={sectionClass} aria-label="What we clean">
      <div className="container mx-auto max-w-2xl text-center">
        <p>We clean your kitchen, bathrooms, bedrooms, and living areas.</p>
        <Link to="/whats-included" className="inline-flex min-h-[44px] items-center font-semibold text-primary underline">
          View the room-by-room checklist
        </Link>
      </div>
    </section>

    <section id="areas" className={`${sectionClass} scroll-mt-16 bg-background md:scroll-mt-24`}>
      <div className="container max-w-4xl text-center">
        <h2 className="font-heading text-2xl font-bold text-sage-foreground md:text-heading-secondary">Areas we serve</h2>
        <p className="mt-3">{cities.join(", ")}.</p>
        <Link to="/areas" className="inline-flex min-h-[44px] items-center font-semibold text-primary underline">
          Check our service area
        </Link>
      </div>
    </section>

    <section className="pt-8 pb-4 md:py-12">
      <div className="container text-center">
        <Button asChild variant="hero" size="lg" className="rounded-full px-8">
          <Link to="/quote" data-main-cta>See My Price</Link>
        </Button>
        <p className="mt-3"><Link to="/faq" className="inline-flex min-h-[44px] items-center font-semibold text-primary underline">Read the FAQ</Link></p>
      </div>
    </section>
  </div>
  );
};

export default Index;
