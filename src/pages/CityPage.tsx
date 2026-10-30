import { Link, Navigate, useParams } from "react-router-dom";
import { MapPin } from "lucide-react";
import SEO from "@/components/SEO";
import { Button } from "@/components/ui/button";
import { CITIES, CITY_BY_SLUG } from "@/config/cities";

const CityPage = () => {
  const { city: slug } = useParams();
  const city = slug ? CITY_BY_SLUG[slug] : undefined;

  if (!city) return <Navigate to="/areas" replace />;

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
            <Link to="/quote" data-main-cta>See My Price</Link>
          </Button>
        </div>
      </section>

      <section className="py-12 md:py-16">
        <div className="container max-w-3xl">
          <div className="rounded-2xl bg-card p-6 shadow-warm mb-10">
            <h2 className="mb-4 font-heading text-xl font-bold text-sage-foreground">Visit at a glance</h2>
            <ul className="space-y-2 text-base leading-relaxed text-foreground">
              <li><strong>What&apos;s covered:</strong> the published room-by-room checklist — <Link to="/whats-included" className="text-primary underline">see what&apos;s included</Link>.</li>
              <li><strong>Price:</strong> published by bedrooms and full bathrooms — <Link to="/quote" className="text-primary underline">see your price</Link>.</li>
              <li><strong>Payment:</strong> nothing at booking; charged when you approve the photo report, or automatically 24 hours after we send it if you haven&apos;t reported an issue.</li>
              <li><strong>Schedule:</strong> the same weekday and arrival window every other week; cancel or reschedule free up to 48 hours before a visit.</li>
            </ul>
          </div>

          <div className="space-y-10">
            {city.sections.map((section) => (
              <section key={section.heading}>
                <h2 className="font-heading text-2xl font-bold mb-3">{section.heading}</h2>
                <p className="text-base leading-relaxed text-foreground md:text-lg">
                  {section.text}
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
