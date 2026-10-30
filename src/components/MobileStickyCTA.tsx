import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

/** Marketing pages only — funnel and account pages get no "See Price" bar:
    their main action must match the task at hand. */
export const isMarketingRoute = (pathname: string): boolean =>
  pathname === "/" ||
  ["/services", "/whats-included", "/faq", "/areas", "/about", "/contact"].some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

/**
 * One compact floating action. It shows only while no in-content main
 * action ([data-main-cta]) is on screen, hides while the menu is open and
 * while a form field is focused (onscreen keyboard), and never renders on
 * funnel/account pages. Help stays available through the menu and footer.
 */
const MobileStickyCTA = () => {
  const { pathname } = useLocation();
  const [ctaVisible, setCtaVisible] = useState(false);
  const [fieldFocused, setFieldFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!isMarketingRoute(pathname)) return;
    const targets = Array.from(document.querySelectorAll("[data-main-cta]"));
    if (targets.length === 0) {
      setCtaVisible(false);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => setCtaVisible(entries.some((e) => e.isIntersecting)),
      { rootMargin: "0px 0px -10% 0px" },
    );
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, [pathname]);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      setFieldFocused(!!t?.closest("input, textarea, select"));
    };
    const onFocusOut = () => setFieldFocused(false);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    const syncMenu = () => setMenuOpen(document.body.dataset.menuOpen === "true");
    syncMenu();
    const mo = new MutationObserver(syncMenu);
    mo.observe(document.body, { attributes: true, attributeFilter: ["data-menu-open"] });
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      mo.disconnect();
    };
  }, []);

  if (!isMarketingRoute(pathname)) return null;
  if (ctaVisible || fieldFocused || menuOpen) return null;

  return (
    <nav
      aria-label="Quick action"
      className="md:hidden fixed bottom-4 left-1/2 -translate-x-1/2 z-50"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <Link
        to="/quote"
        className="flex min-h-[48px] items-center rounded-full bg-primary px-6 text-base font-bold text-primary-foreground shadow-lg no-underline"
      >
        See My Price
      </Link>
    </nav>
  );
};

export default MobileStickyCTA;
