import { Link, Navigate, useParams } from "react-router-dom";
import { MapPin } from "lucide-react";
import SEO from "@/components/SEO";
import { Button } from "@/components/ui/button";
import { CITIES, CITY_BY_SLUG } from "@/config/cities";
import { PRICES, fmtPrice, globalTestCutActive, scaleTestPrice } from "@/config/calculator";

const CityPage = () => {
  const { city: slug } = useParams();
  const city = slug ? CITY_BY_SLUG[slug] : undefined;

  if (!city) return <Navigate to="/areas" replace />;

  // MB-15(a): the "From" price, from the same calculator as
  // /services — the lowest every-other-week visit (a small home: up
  // to 2 bedrooms and 2 full bathrooms). Test prices apply here
  // exactly as on /services (same global window + tab flag), so one
  // regime never shows two different prices. Synchronous at render,
  // NOT useEffect: the prerendered HTML must show the same prices as
  // the live page (see Services.tsx).
  const testPricing = (() => {
    try { return sessionStorage.getItem("gh_test_pricing") === "1" || globalTestCutActive(); } catch { return globalTestCutActive(); }
  })();
  const disp = (n: number): number => (testPricing ? scaleTestPrice(n) : n);

  return (
    <div className="page-shell">
      <SEO
        title={city.title}
        description={city.description}
        url={`https://gatehousehomecleaning.com/areas/${city.slug}`}
      />

      <section className="bg-warm-gradient py-12 md:py-16">
        <div className="container max-w-3xl text-center">
          <p className="font-script text-xl text-golden mb-2">Service area</p>
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-3">
            House Cleaning in {city.name}, GA
          </h1>
          <p className="text-foreground text-lg">{city.description}</p>
          <Button asChild variant="hero" size="lg" className="mt-6 rounded-full px-8">
            <Link to={`/quote?city=${encodeURIComponent(city.name)}`} data-main-cta>See My Price</Link>
          </Button>
        </div>
      </section>

      {testPricing && (
        <div className="container">
          <p className="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 text-center">
            Test booking: prices on this page are reduced for a payment test.
          </p>
        </div>
      )}

      <section className="py-12 md:py-16">
        <div className="container max-w-3xl">
          <div className="rounded-2xl bg-card p-6 shadow-warm mb-10">
            <h2 className="mb-4 font-heading text-xl font-bold text-sage-foreground">Visit at a glance</h2>
            <ul className="space-y-2 text-base leading-relaxed text-foreground">
              <li><strong>What&apos;s covered:</strong> the published room-by-room checklist — <Link to="/whats-included" className="text-primary underline">see what&apos;s included</Link>.</li>
              <li><strong>Price:</strong> from {fmtPrice(disp(PRICES.recurring.S))} per visit for a small home — <Link to="/quote" className="text-primary underline">see your price</Link>.</li>
              <li><strong>First visit:</strong> choose Standard for regular upkeep or Deep for a more detailed clean.</li>
              <li><strong>Payment:</strong> nothing at booking; charged when you approve the photo report, or at the next scheduled billing time after your 24-hour review window if you haven&apos;t reported an issue.</li>
              <li><strong>Schedule:</strong> each visit is arranged and confirmed with you; cancel free up to 48 hours before a visit; rescheduling is always free.</li>
            </ul>
          </div>

          <div className="space-y-10">
            {city.sections.filter((section) => section.heading === `Homes in ${city.name}`).map((section) => (
              <section key={section.heading}>
                <h2 className="font-heading text-2xl font-bold mb-3">{section.heading}</h2>
                <p className="text-base leading-relaxed text-foreground md:text-lg">
                  {section.text}
                  {section.link ? (
                    <> <Link to={section.link.href} className="text-primary underline">{section.link.label}</Link></>
                  ) : null}
                </p>
              </section>
            ))}
          </div>

          <div className="mt-10 rounded-2xl bg-card p-6 shadow-warm">
            <h2 className="mb-4 font-heading text-xl font-bold text-sage-foreground">Other cities we serve</h2>
            <div className="flex flex-wrap gap-2">
              {CITIES.filter((c) => c.slug !== city.slug).map((c) => (
                <Link
                  key={c.slug}
                  to={`/areas/${c.slug}`}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-peach/40 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-peach/70"
                >
                  <MapPin className="h-3.5 w-3.5 text-primary" aria-hidden="true" /> {c.name}
                </Link>
              ))}
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              <Link to="/areas" className="text-primary underline">See the full service area</Link>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};

export default CityPage;
