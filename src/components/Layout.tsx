import { Link, Outlet, useLocation } from "react-router-dom";
import Header from "./Header";
import Footer from "./Footer";
import MobileStickyCTA, { isMarketingRoute } from "./MobileStickyCTA";

// Dashboard pages (owner, cleaner, client visit, report) get a compact
// service footer: the big marketing footer and its "See My Price" CTA
// must not compete with working actions on these pages.
const DASHBOARD_PREFIXES = ["/owner", "/cleaner", "/visit", "/report"];

const Layout = () => {
  const { pathname } = useLocation();
  const isDashboard = DASHBOARD_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return (
    <div className="min-h-screen flex flex-col">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Header />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <Outlet />
      </main>
      {isDashboard ? (
        <footer className="border-t border-border py-6">
          <div className="container flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>Gatehouse Home Cleaning — North Atlanta</span>
            <span className="flex flex-wrap items-center gap-4">
              <a href="mailto:hello@gatehousehomecleaning.com" className="underline">hello@gatehousehomecleaning.com</a>
              <a href="tel:+17705258599" className="underline">(770) 525-8599</a>
              <Link to="/privacy" className="underline">Privacy</Link>
              <Link to="/terms" className="underline">Terms</Link>
            </span>
          </div>
        </footer>
      ) : (
        <Footer />
      )}
      {/* Reserve room for the floating action on marketing pages so it
          never covers footer content; funnel pages render no bar. */}
      {isMarketingRoute(pathname) && (
        <div aria-hidden="true" className="md:hidden h-20" style={{ paddingBottom: "env(safe-area-inset-bottom)" }} />
      )}
      <MobileStickyCTA />
    </div>
  );
};

export default Layout;
