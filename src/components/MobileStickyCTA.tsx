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
 * action ([data-main-cta]) is on screen, hides while the menu is open,
 * while a form field is focused (onscreen keyboard), and while the home
 * sample report is open (its checklist would scroll underneath the pill),
 * and never renders on funnel/account pages. Help stays available through
 * the menu and footer.
 */
const MobileStickyCTA = () => {
  const { pathname } = useLocation();
  const [ctaVisible, setCtaVisible] = useState(false);
  const [fieldFocused, setFieldFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sampleOpen, setSampleOpen] = useState(false);

  useEffect(() => {
    if (!isMarketingRoute(pathname)) return;
    const targets = Array.from(document.querySelectorAll("[data-main-cta]"));
    if (targets.length === 0) {
      setCtaVisible(false);
      return;
    }
    const visible = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => { entries.forEach((e) => e.isIntersecting ? visible.add(e.target) : visible.delete(e.target)); setCtaVisible(visible.size > 0); },
      { rootMargin: "0px 0px -10% 0px" },
    );
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, [pathname]);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      // Only real keyboard fields hide the pill. Buttons, links and
      // <summary> are taps, not typing: hiding the pill on them (e.g.
      // opening an FAQ accordion) left it gone until the next tap
      // elsewhere, which looked like it had vanished for good.
      setFieldFocused(!!t?.closest("input, textarea, select, [contenteditable=\"true\"]"));
    };
    const onFocusOut = () => setFieldFocused(false);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    const syncMenu = () => {
      setMenuOpen(document.body.dataset.menuOpen === "true");
      setSampleOpen(document.body.dataset.sampleOpen === "true");
    };
    syncMenu();
    const mo = new MutationObserver(syncMenu);
    mo.observe(document.body, { attributes: true, attributeFilter: ["data-menu-open", "data-sample-open"] });
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      mo.disconnect();
    };
  }, []);

  if (!isMarketingRoute(pathname) || pathname === "/contact") return null;
  if (ctaVisible || fieldFocused || menuOpen || sampleOpen) return null;

  return (
    <nav
      aria-label="Quick action"
      className="md:hidden fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background px-4 py-3"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <Link
        to="/quote"
        className="flex min-h-[48px] items-center justify-center rounded-full bg-primary px-6 text-base font-bold text-primary-foreground shadow-lg no-underline"
      >
        See My Price
      </Link>
    </nav>
  );
};

export default MobileStickyCTA;
