import { useState, useEffect, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const navLinks = [
  { label: "Home", to: "/" },
  { label: "Services", to: "/services" },
  { label: "What's Included", to: "/whats-included" },
  { label: "FAQ", to: "/faq" },
  { label: "About Us", to: "/about" },
  { label: "Founding Clients", to: "/founding" },
  { label: "Areas", to: "/areas" },
  { label: "Contact", to: "/contact" },
];

const Header = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setIsOpen(false); toggleRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  const handleLogoClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (location.pathname === "/") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      navigate("/");
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  };

  useEffect(() => {
    let ticking = false;
    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        setScrolled(window.scrollY > 20);
        ticking = false;
      });
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    setIsOpen(false);
  }, [location]);

  // Lets the mobile quick-actions bar hide itself while the menu is open.
  useEffect(() => {
    document.body.dataset.menuOpen = isOpen ? "true" : "false";
    return () => {
      document.body.dataset.menuOpen = "false";
    };
  }, [isOpen]);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-[100] bg-background transition-shadow duration-300 ${
        scrolled ? "py-0 lg:py-1" : "py-0 lg:py-2"
      }`}
      style={{
        backgroundColor: 'hsl(var(--background))',
        backgroundImage: 'none',
        opacity: 1,
        backdropFilter: 'none',
        WebkitBackdropFilter: 'none',
        boxShadow: scrolled
          ? '0 2px 8px rgba(0,0,0,0.12)'
          : '0 1px 0 rgba(0,0,0,0.06)',
      }}
    >
      <div className="container flex items-center justify-between min-h-[56px] md:min-h-[72px]">
        <Link to="/" onClick={handleLogoClick} aria-label="Gatehouse Home Cleaning — home" className="flex min-h-[44px] flex-col items-start justify-center cursor-pointer active:opacity-80 leading-none">
          <span
            className="font-script text-[19px] whitespace-nowrap md:text-4xl lg:text-3xl font-bold leading-tight"
            style={{ color: 'hsl(var(--brand-ink))' }}
          >
            Gatehouse Home Cleaning
          </span>
          <span
            className="hidden md:block font-semibold uppercase"
            style={{ color: 'hsl(var(--brand-ink))', fontSize: '9.5px', letterSpacing: '0.18em', marginTop: '2px' }}
          >
            North Atlanta, GA
          </span>
        </Link>

        <nav aria-label="Main navigation" className="hidden nav:flex items-center gap-1 xl:gap-1">
          {navLinks.filter((link) => ["/services", "/whats-included", "/areas", "/faq"].includes(link.to)).map((link) => (
            <Link
              key={link.to}
              to={link.to}
              aria-current={location.pathname === link.to ? "page" : undefined}
              className={`px-3 py-1.5 rounded-lg text-[15px] font-semibold whitespace-nowrap transition-colors ${
                location.pathname === link.to
                  ? "text-primary bg-peach/40"
                  : "text-foreground hover:text-primary hover:bg-peach/20"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden nav:flex items-center gap-3">
          <Button variant="hero" size="sm" asChild>
            <Link to="/quote">See My Price</Link>
          </Button>
        </div>

        <div className="flex nav:hidden items-center gap-2">
          <button
            ref={toggleRef}
            onClick={() => setIsOpen(!isOpen)}
            className="p-1.5 min-h-[44px] min-w-[44px] flex items-center justify-center"
            style={{ color: '#2E2C29' }}
            aria-label="Toggle menu"
            aria-expanded={isOpen}
            aria-controls="mobile-menu"
          >
            {isOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {isOpen && (
        <div id="mobile-menu" className="nav:hidden bg-background border-t border-border animate-fade-in max-h-[calc(100dvh-72px)] overflow-y-auto">
          <div className="container py-4 flex flex-col gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={`px-4 py-3 rounded-lg text-xl font-semibold transition-colors min-h-[44px] flex items-center ${
                  location.pathname === link.to
                    ? "text-primary bg-peach/40"
                    : "text-foreground hover:text-primary hover:bg-peach/20"
                }`}
              >
                {link.label}
              </Link>
            ))}
            <div className="flex flex-col gap-3 mt-4 pt-4 border-t border-border">
              <Button variant="hero" size="lg" asChild>
                <Link to="/quote">See My Price</Link>
              </Button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};

export default Header;
