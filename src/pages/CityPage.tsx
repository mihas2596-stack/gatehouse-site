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
            <Link to="/quote">See My Price</Link>
          </Button>
        </div>
      </section>

      <section className="py-12 md:py-16">
        <div className="container max-w-3xl">
          <div className="space-y-5">
            {city.paragraphs.map((text) => (
              <p key={text.slice(0, 40)} className="text-base leading-relaxed text-foreground md:text-lg">
                {text}
              </p>
            ))}
          </div>

          <div className="mt-10 rounded-2xl bg-card p-6 shadow-warm">
            <h2 className="mb-4 font-heading text-xl font-bold text-sage-foreground">Other cities we serve</h2>
            <div className="flex flex-wrap gap-2">
              {CITIES.filter((c) => c.slug !== city.slug).map((c) => (
                <Link
                  key={c.slug}
                  to={`/areas/${c.slug}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-peach/40 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-peach/70"
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
