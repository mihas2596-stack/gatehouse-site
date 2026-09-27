import { Link, useLocation } from "react-router-dom";
import { Mail } from "lucide-react";

const MobileStickyCTA = () => {
  const { pathname } = useLocation();
  const quoteOnly = pathname.startsWith("/quote");

  return (
    <nav
      aria-label="Quick actions"
      className="mobile-quick-actions md:hidden fixed bottom-0 left-0 right-0 z-50 flex items-stretch gap-px min-h-[56px] border-t border-border bg-primary text-primary-foreground shadow-[0_-6px_18px_rgba(0,0,0,0.18)]"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <a
        href="mailto:hello@gatehousehomecleaning.com"
        className={`${quoteOnly ? "flex-1" : "w-1/2"} min-h-[44px] flex items-center justify-center gap-2 bg-primary/90 text-primary-foreground text-sm font-bold no-underline`}
      >
        <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
        Email
      </a>
      {!quoteOnly && (
        <Link
          to="/quote"
          className="w-1/2 min-h-[44px] flex items-center justify-center gap-2 text-sm font-bold text-primary-foreground no-underline"
        >
          Exact Price
        </Link>
      )}
    </nav>
  );
};

export default MobileStickyCTA;
