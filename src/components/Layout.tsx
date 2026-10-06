import { Outlet } from "react-router-dom";
import Header from "./Header";
import Footer from "./Footer";
import MobileStickyCTA from "./MobileStickyCTA";

const Layout = () => {
  return (
    <div className="min-h-screen flex flex-col">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Header />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <Outlet />
      </main>
      <Footer />
      <div aria-hidden="true" className="md:hidden h-14" style={{ paddingBottom: "env(safe-area-inset-bottom)" }} />
      <MobileStickyCTA />
    </div>
  );
};

export default Layout;
