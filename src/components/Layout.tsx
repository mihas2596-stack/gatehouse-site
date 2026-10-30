import { Outlet, useLocation } from "react-router-dom";
import Header from "./Header";
import Footer from "./Footer";
import MobileStickyCTA, { isMarketingRoute } from "./MobileStickyCTA";

const Layout = () => {
  const { pathname } = useLocation();
  return (
    <div className="min-h-screen flex flex-col">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Header />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <Outlet />
      </main>
      <Footer />
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
