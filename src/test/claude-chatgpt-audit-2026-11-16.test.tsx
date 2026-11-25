import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import Quote from "@/pages/Quote";
import Index from "@/pages/Index";
import Services from "@/pages/Services";
import Header from "@/components/Header";
import About from "@/pages/About";
import Areas from "@/pages/Areas";
import WhatsIncluded from "@/pages/WhatsIncluded";
import Footer from "@/components/Footer";
import { testCapApplied } from "@/config/calculator";
import { resolveLinkToken } from "@/lib/tokenStrip";

vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/assets/nik-founder.jpeg", () => ({ default: "nik-founder.jpg" }));
vi.mock("@/assets/hero-real-bedroom.webp", () => ({ default: "hero-bedroom.jpg" }));

const nowSpy = vi.spyOn(Date, "now");
const setNow = (iso: string) => nowSpy.mockReturnValue(Date.parse(iso));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  document.head.querySelectorAll('meta[name="robots"], meta[property="og:image"]').forEach((el) => el.remove());
});

const openQuote = () => render(<MemoryRouter><Quote /></MemoryRouter>);

const fillStep2 = () => {
  for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["City *", "Sugar Hill"], ["State *", "GA"], ["Preferred date *", "2099-12-01"]]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole("radio", { name: /I’ll be home/ }));
  fireEvent.click(screen.getByLabelText(/I agree to photos of the cleaned rooms/));
};

const expandAddons = () => {
  fireEvent.click(screen.getByRole("button", { name: /Add extras \(optional\)/ }));
};

describe("testCapApplied", () => {
  it("is false when the scaled price stays at or under the $1.50 cap", () => {
    expect(testCapApplied(129)).toBe(false);
    expect(testCapApplied(149)).toBe(false);
    expect(testCapApplied(150)).toBe(false);
  });
  it("is true when the scaled price sits above the cap", () => {
    expect(testCapApplied(151)).toBe(true);
    expect(testCapApplied(189)).toBe(true);
    expect(testCapApplied(224)).toBe(true);
  });
});

describe("quote: test-price cap notice (ChatGPT #1)", () => {
  beforeEach(() => setNow("2026-11-16T12:00:00Z"));

  it("shows the cap notice on step 1 when the cap actually lowers the total", () => {
    openQuote();
    // Defaults are 3br/2ba recurring: $189 -> $1.89, capped to $1.50.
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    expect(screen.getByText("First visit (Standard): $1.50")).toBeInTheDocument();
    expect(screen.getByText("Test price cap applied. Selected extras are included in the total shown.")).toBeInTheDocument();
  });

  it("shows no cap notice when nothing is capped, and shows it once an add-on pushes the total over the cap", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Full bathrooms"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("radio", { name: "One-time" }));
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    // $149 -> $1.49: under the cap, so no notice.
    expect(screen.getByText("One-time cleaning: $1.49")).toBeInTheDocument();
    expect(screen.queryByText(/Test price cap applied/)).not.toBeInTheDocument();
    expandAddons();
    fireEvent.click(screen.getByLabelText(/Inside oven/));
    // $149 + $35 = $184 -> $1.84, capped to $1.50: the add-on line still
    // shows +$0.35, and the notice explains why the total stays $1.50.
    expect(screen.getByText("One-time cleaning: $1.50")).toBeInTheDocument();
    expect(screen.getByText("Test price cap applied. Selected extras are included in the total shown.")).toBeInTheDocument();
  });

  it("shows the cap notice on steps 2 and 3 too", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    fillStep2();
    expect(screen.getByText("Test price cap applied. Selected extras are included in the total shown.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByRole("heading", { name: "Your request" })).toBeInTheDocument();
    expect(screen.getByText("Test price cap applied. Selected extras are included in the total shown.")).toBeInTheDocument();
  });

  it("shows no cap notice on step 1 before a ZIP is entered or for an out-of-area ZIP (audit 17.11)", () => {
    openQuote();
    // Defaults are 3br/2ba recurring: the cap WOULD lower the total —
    // but no price is shown yet, so the notice must not appear either.
    expect(screen.getByText("Enter your ZIP code to see your price.")).toBeInTheDocument();
    expect(screen.queryByText(/Test price cap applied/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "99999" } });
    expect(screen.getAllByText(/We don't serve this ZIP yet/)).toHaveLength(2);
    expect(screen.queryByText(/Test price cap applied/)).not.toBeInTheDocument();
  });
});

describe("quote: cap notice stays off on ordinary prices", () => {
  beforeEach(() => setNow("2026-11-26T00:00:00Z"));

  it("adds the add-on at its real price and shows no cap notice", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    expect(screen.getByText("First visit (Standard): $189")).toBeInTheDocument();
    expandAddons();
    fireEvent.click(screen.getByLabelText(/Inside oven/));
    expect(screen.getByText("First visit (Standard): $224")).toBeInTheDocument();
    expect(screen.queryByText(/Test price cap applied/)).not.toBeInTheDocument();
  });
});

describe("quote: price summary under the ZIP (ChatGPT #3)", () => {
  beforeEach(() => setNow("2026-11-16T12:00:00Z"));

  it("shows the per-visit total and $0 due today right under the ZIP", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    expect(screen.getByText("$1.50 per visit, every other week · $0 due today")).toBeInTheDocument();
  });

  it("shows the one-time total for a one-time clean, and updates when rooms change", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Full bathrooms"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("radio", { name: "One-time" }));
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    expect(screen.getByText("One-time: $1.49 · $0 due today")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "2" } });
    expect(screen.getByText("One-time: $1.49 · $0 due today")).toBeInTheDocument();
  });

  it("shows no summary for an unsupported ZIP, and the custom-quote hint for a 6-bedroom home", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "99999" } });
    expect(screen.queryByText(/per visit, every other week · \$0 due today/)).not.toBeInTheDocument();
    expect(screen.queryByText(/one-time · \$0 due today/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "6" } });
    expect(screen.getByText(/Custom quote for larger homes/)).toBeInTheDocument();
    expect(screen.queryByText(/per visit, every other week · \$0 due today/)).not.toBeInTheDocument();
  });
});

describe("quote step 3: repeated $0 paragraph removed (ChatGPT #5)", () => {
  beforeEach(() => setNow("2026-11-26T00:00:00Z"));

  it("keeps When you pay, the consent and the submit button, but not the repeated $0 box", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    fillStep2();
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByText(/When you pay/i)).toBeInTheDocument();
    expect(screen.getByText("next scheduled billing time")).toBeInTheDocument();
    expect(screen.getByText("Cancel free at least 48 hours before your visit. Later cancellations cost $25.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to Stripe — $0 today" })).toBeInTheDocument();
    expect(screen.queryByText("We’ll send a private photo report after your cleaning. You can approve it to pay. If you haven’t approved or reported an issue, we’ll charge your card automatically 24 hours after we send the report.")).not.toBeInTheDocument();
    expect(screen.queryByText("$0 charged today.")).not.toBeInTheDocument();
  });
});

describe("minimal header: Help button (ChatGPT #2)", () => {
  const openHeader = () => render(<MemoryRouter initialEntries={["/quote"]}><Header /></MemoryRouter>);

  it("shows a Help button that opens Call and Email links, and closes on Escape with focus back on the button", () => {
    openHeader();
    const help = screen.getByRole("button", { name: "Help" });
    expect(help).toHaveAttribute("aria-expanded", "false");
    expect(help.className).toContain("min-h-[44px]");
    expect(document.querySelector("#header-help-panel")).toBeNull();
    fireEvent.click(help);
    expect(help).toHaveAttribute("aria-expanded", "true");
    const panel = document.querySelector("#header-help-panel");
    expect(panel).not.toBeNull();
    const tel = panel?.querySelector('a[href="tel:+17705258599"]');
    const mail = panel?.querySelector('a[href="mailto:hello@gatehousehomecleaning.com"]');
    expect(tel).not.toBeNull();
    expect(tel?.textContent).toContain("Call (770) 525-8599");
    expect(mail).not.toBeNull();
    expect(mail?.textContent).toContain("hello@gatehousehomecleaning.com");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector("#header-help-panel")).toBeNull();
    expect(document.activeElement).toBe(help);
  });

  it("toggles the panel closed on a second click", () => {
    openHeader();
    const help = screen.getByRole("button", { name: "Help" });
    fireEvent.click(help);
    expect(document.querySelector("#header-help-panel")).not.toBeNull();
    fireEvent.click(help);
    expect(document.querySelector("#header-help-panel")).toBeNull();
  });
});

describe("hero CTAs (ChatGPT #4) and About contact targets (ChatGPT #6)", () => {
  it("Areas has a Check my ZIP & price button to /quote and the reworded line", () => {
    render(<MemoryRouter><Areas /></MemoryRouter>);
    const cta = screen.getByRole("link", { name: "Check my ZIP & price" });
    expect(cta).toHaveAttribute("href", "/quote");
    expect(screen.getByText("Seven North Atlanta suburbs, cleaned every other week.")).toBeInTheDocument();
    expect(screen.queryByText("Seven North Atlanta suburbs, one simple routine.")).not.toBeInTheDocument();
  });

  it("WhatsIncluded and About each have a See My Price button in the hero", () => {
    const { unmount } = render(<MemoryRouter><WhatsIncluded /></MemoryRouter>);
    const wiCtas = screen.getAllByRole("link", { name: "See My Price" });
    expect(wiCtas.length).toBeGreaterThanOrEqual(1);
    expect(wiCtas[0]).toHaveAttribute("href", "/quote");
    unmount();
    render(<MemoryRouter><About /></MemoryRouter>);
    const aboutCtas = screen.getAllByRole("link", { name: "See My Price" });
    expect(aboutCtas.length).toBeGreaterThanOrEqual(1);
    expect(aboutCtas[0]).toHaveAttribute("href", "/quote");
  });

  it("About email and phone links are at least 44px tall with a gap", () => {
    render(<MemoryRouter><About /></MemoryRouter>);
    const email = screen.getByRole("link", { name: "hello@gatehousehomecleaning.com" });
    const phone = screen.getByRole("link", { name: /Call Gatehouse Home Cleaning/ });
    expect(email.className).toContain("min-h-[44px]");
    expect(phone.className).toContain("min-h-[44px]");
    expect(email.closest("p")?.className).toContain("gap-y-2");
  });
});

describe("tokenStrip (Claude M2)", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("resolves the token from the URL, strips it, keeps it in sessionStorage, and preserves other params", () => {
    window.history.pushState({}, "", "/visit?bt=tok123&foo=bar");
    expect(resolveLinkToken("bt", "gh_visit_bt")).toBe("tok123");
    expect(window.location.search).toBe("?foo=bar");
    expect(sessionStorage.getItem("gh_visit_bt")).toBe("tok123");
    // Second call: no token in the URL, reads it back from the session.
    expect(resolveLinkToken("bt", "gh_visit_bt")).toBe("tok123");
    expect(window.location.search).toBe("?foo=bar");
  });

  it("preserves the cleaner preview flag and returns empty when no token exists", () => {
    window.history.pushState({}, "", "/cleaner?ct=ct9&pv=1");
    expect(resolveLinkToken("ct", "gh_cleaner_ct")).toBe("ct9");
    expect(window.location.search).toBe("?pv=1");
    expect(resolveLinkToken("bt", "gh_visit_bt")).toBe("");
  });
});

describe("Footer: one component everywhere (Claude M4)", () => {
  it("says About Gatehouse, never About Nick", () => {
    render(<MemoryRouter><Footer /></MemoryRouter>);
    expect(screen.getByText("About Gatehouse")).toBeInTheDocument();
    expect(screen.queryByText("About Nick")).not.toBeInTheDocument();
  });
});

describe("V1: When you pay has three labelled lines (visual report)", () => {
  beforeEach(() => setNow("2026-11-26T00:00:00Z"));

  it("labels At booking / After cleaning / If something was missed, with the verified 24-hour wording", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    fillStep2();
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByText("At booking")).toBeInTheDocument();
    expect(screen.getByText("After cleaning")).toBeInTheDocument();
    expect(screen.getByText("If something was missed")).toBeInTheDocument();
    expect(screen.getByText("next scheduled billing time")).toBeInTheDocument();
    expect(screen.getByText(/within those 24 hours to stop automatic payment/)).toBeInTheDocument();
  });
});

describe("V2: rooms to skip, entry codes, date is a request (visual report)", () => {
  beforeEach(() => setNow("2026-11-26T00:00:00Z"));

  it("shows the photo-report intro, the skip-rooms line in photo privacy, the no-codes line, and the date-request line by the price", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    // Mobile copy (25.11.2026): the intro is one plain sentence; the
    // skip-rooms sentence lives in the "Photo privacy & rooms to skip"
    // details below the checkbox.
    expect(screen.getByText("After cleaning, we send you photos of the cleaned rooms. Only you can see them.")).toBeInTheDocument();
    expect(screen.getByText(/On your visit page, you can mark rooms to skip in photos\./)).toBeInTheDocument();
    expect(screen.getByText(/No keys or entry codes needed now/)).toBeInTheDocument();
    expect(screen.getByText(/Your date is a request/)).toBeInTheDocument();
    expect(screen.getByText(/confirm your date, arrival window, and who.s coming/)).toBeInTheDocument();
  });
});

describe("V3: hero sample link and demo actions (visual report)", () => {
  const openHome = () => render(<MemoryRouter><HelmetProvider><Index /></HelmetProvider></MemoryRouter>);

  it("hero has a text link to the sample section; the sample starts closed", () => {
    openHome();
    const link = screen.getByRole("link", { name: "See a sample photo report" });
    expect(link).toHaveAttribute("href", "#sample-report");
    expect(screen.getByRole("button", { name: "View sample report" })).toBeInTheDocument();
    expect(screen.queryByText("SAMPLE — DEMO ONLY")).not.toBeInTheDocument();
  });

  it("the first sample card shows both demo actions without expanding all rooms, marked as demo", () => {
    openHome();
    fireEvent.click(screen.getByRole("button", { name: "View sample report" }));
    expect(screen.getByText("SAMPLE — DEMO ONLY")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve \(demo\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Report an issue \(demo\)/ })).toBeInTheDocument();
    // The expander is still there for the other rooms.
    expect(screen.getByRole("button", { name: /Show all rooms/ })).toBeInTheDocument();
    // Demo actions send nothing: approving shows the demo-only state.
    fireEvent.click(screen.getByRole("button", { name: /Approve \(demo\)/ }));
    expect(screen.getByText("Demo only — no payment was taken.")).toBeInTheDocument();
  });
});

describe("V4: test prices are badged on Services while test mode is active (visual report)", () => {
  it("shows a Test price badge on every service card in test mode", () => {
    setNow("2026-11-16T12:00:00Z");
    render(<MemoryRouter><Services /></MemoryRouter>);
    expect(screen.getAllByText("Test price")).toHaveLength(4);
    expect(screen.getByText(/From \$1\.29 per visit/)).toBeInTheDocument();
  });

  it("shows no badge on ordinary prices", () => {
    setNow("2026-11-26T00:00:00Z");
    render(<MemoryRouter><Services /></MemoryRouter>);
    expect(screen.queryByText("Test price")).not.toBeInTheDocument();
    expect(screen.getByText(/From \$129 per visit/)).toBeInTheDocument();
  });
});

describe("V5: frequency is explicit and Services preselection flows into the total (visual report)", () => {
  beforeEach(() => setNow("2026-11-26T00:00:00Z"));

  it("marks the selected frequency with a check and explains recurring confirmation", () => {
    openQuote();
    const recurring = screen.getByRole("radio", { name: "Every other week" });
    const onetime = screen.getByRole("radio", { name: "One-time" });
    expect(recurring).toHaveAttribute("aria-checked", "true");
    expect(recurring.querySelector("svg")).not.toBeNull();
    expect(onetime).toHaveAttribute("aria-checked", "false");
    expect(onetime.querySelector("svg")).toBeNull();
    expect(screen.getByText(/We confirm each visit.s date, arrival window and cleaner/)).toBeInTheDocument();
    fireEvent.click(onetime);
    expect(screen.getByRole("radio", { name: "One-time" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText(/We confirm each visit.s date, arrival window and cleaner/)).not.toBeInTheDocument();
  });

  it("a Deep clean from Services shows the deep total under the ZIP", () => {
    render(<MemoryRouter initialEntries={["/quote?service=deep"]}><Quote /></MemoryRouter>);
    expect(screen.getByRole("radio", { name: /Deep/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    expect(screen.getByText("$329 one-time · $0 due today")).toBeInTheDocument();
  });

  it("a one-time clean from Services shows the one-time total under the ZIP", () => {
    render(<MemoryRouter initialEntries={["/quote?service=standard&frequency=onetime"]}><Quote /></MemoryRouter>);
    expect(screen.getByRole("radio", { name: "One-time" })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    expect(screen.getByText("One-time: $219 · $0 due today")).toBeInTheDocument();
  });

  it("a recurring clean from Services shows the per-visit total with its frequency", () => {
    render(<MemoryRouter initialEntries={["/quote?service=recurring"]}><Quote /></MemoryRouter>);
    expect(screen.getByRole("radio", { name: "Every other week" })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    expect(screen.getByText("$189 per visit, every other week · $0 due today")).toBeInTheDocument();
  });
});

describe("sticky-button correction: in-content hero CTAs only at md and up (visual report)", () => {
  it("Areas, WhatsIncluded and About hero CTAs are hidden below md, where the sticky pill serves", () => {
    const { unmount } = render(<MemoryRouter><Areas /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Check my ZIP & price" }).closest("div")?.className).toContain("hidden md:block");
    unmount();
    const second = render(<MemoryRouter><WhatsIncluded /></MemoryRouter>);
    expect(screen.getAllByRole("link", { name: "See My Price" })[0].closest("div")?.className).toContain("hidden md:block");
    second.unmount();
    render(<MemoryRouter><About /></MemoryRouter>);
    expect(screen.getAllByRole("link", { name: "See My Price" })[0].closest("div")?.className).toContain("hidden md:block");
  });
});

describe("secondary pages: WhatsIncluded intro + add-ons note, About coordination (visual report)", () => {
  it("WhatsIncluded shows a short intro on mobile and the full intro on desktop, with the deep/move-in-out note on add-ons", () => {
    render(<MemoryRouter><WhatsIncluded /></MemoryRouter>);
    const shortIntro = screen.getByText("Everything below is included in a standard visit. Add-ons are listed separately.");
    expect(shortIntro.className).toContain("md:hidden");
    const fullIntro = screen.getByText(/Everything in the room lists below is included in a standard visit/);
    expect(fullIntro.className).toContain("hidden");
    expect(fullIntro.className).toContain("md:block");
    expect(screen.getByText(/Oven, fridge and cabinet interiors are already included in deep and move-in\/out cleans/)).toBeInTheDocument();
    expect(screen.getAllByText("Available as add-ons").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("heading", { name: "Not included" })).toBeInTheDocument();
  });

  it("About puts the coordination promise next to the portrait, above Why Every Other Week", () => {
    render(<MemoryRouter><About /></MemoryRouter>);
    expect(screen.getByText(/I coordinate your visit/)).toBeInTheDocument();
    expect(document.body.innerHTML.indexOf("I coordinate your visit")).toBeLessThan(
      document.body.innerHTML.indexOf("Why Every Other Week")
    );
  });
});
