import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Helmet } from "react-helmet-async";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background">
      <Helmet>
        <title>Page Not Found | Gatehouse</title>
        <meta name="robots" content="noindex" />
        <meta name="prerender-status-code" content="404" />
      </Helmet>
      <div className="container max-w-xl text-center">
        <h1 className="mb-4 font-heading text-4xl font-bold text-sage-foreground">404 — Page not found</h1>
        <p className="mb-6 text-lg text-muted-foreground">
          That page doesn't exist. Try the homepage or see your price.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link to="/" className="text-primary underline">Back to home</Link>
          <Link to="/quote" className="text-primary underline">See my price</Link>
        </div>
        <p className="mt-6 text-base text-muted-foreground">
          Popular pages:{" "}
          <Link to="/services" className="text-primary underline">Services</Link>{" · "}
          <Link to="/whats-included" className="text-primary underline">What&rsquo;s Included</Link>{" · "}
          <Link to="/areas" className="text-primary underline">Areas</Link>{" · "}
          <Link to="/faq" className="text-primary underline">FAQ</Link>{" · "}
          <Link to="/contact" className="text-primary underline">Contact</Link>
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          We clean homes in Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell.
        </p>
      </div>
    </div>
  );
};

export default NotFound;
