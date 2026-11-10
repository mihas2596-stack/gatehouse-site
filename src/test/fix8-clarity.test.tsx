import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import Quote from "@/pages/Quote";
import Index from "@/pages/Index";
import Services from "@/pages/Services";
import About from "@/pages/About";
import Areas from "@/pages/Areas";
import FAQ from "@/pages/FAQ";
import CityPage from "@/pages/CityPage";
import { TIERS, TIER_ROOM_LABEL } from "@/config/calculator";
import { FAQS } from "@/config/faqs";
import { CITIES } from "@/config/cities";

// Pinned past the global test-price window so regular-price assertions
// stay deterministic.
vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-14T00:00:00Z"));
vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/measurement", () => ({ campaignAttribution: () => ({}), trackFunnel: () => true }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderPage = (ui: React.ReactElement) =>
  render(<MemoryRouter><HelmetProvider>{ui}</HelmetProvider></MemoryRouter>);

const openQuote = () => render(<MemoryRouter><Quote /></MemoryRouter>);

const fillStep2 = () => {
  for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["City *", "Sugar Hill"], ["State *", "GA"], ["Preferred date *", "2099-12-01"]]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole("radio", { name: /I’ll be home/ }));
  fireEvent.click(screen.getByLabelText(/I agree to photos of the cleaned rooms/));
};

const goToStep2 = () => {
  openQuote();
  fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
  fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
  expect(screen.getByRole("heading", { name: "Your visit" })).toBeInTheDocument();
};

/** Client-facing copy must not use the jargon words. */
const assertNoJargon = () => {
  const text = document.body.textContent ?? "";
  expect(text).not.toMatch(/calculator/i);
  expect(text).not.toMatch(/sanitiz/i);
  expect(text).not.toMatch(/\bscope\b/i);
  expect(text).not.toContain("Fixed when you send");
};

describe("fix8 — clarity: tier wording", () => {
  it("tier strings use one rule, and 6+ homes are a custom quote, not Large", () => {
    expect(TIERS).toEqual([
      { key: "S", label: "Small home", rooms: "Up to 2 bedrooms and up to 2 full bathrooms" },
      { key: "M", label: "Medium home", rooms: "3 bedrooms or 3 full bathrooms" },
      { key: "L", label: "Large home", rooms: "4–5 bedrooms or 4–5 full bathrooms" },
    ]);
    expect(TIER_ROOM_LABEL.L).toBe("4–5 bed or 4–5 bath");
  });

  it("homepage pricing table shows the tier strings and the single rule", () => {
    renderPage(<Index />);
    expect(screen.getByText("Up to 2 bedrooms and up to 2 full bathrooms")).toBeInTheDocument();
    expect(screen.getByText("3 bedrooms or 3 full bathrooms")).toBeInTheDocument();
    expect(screen.getByText("4–5 bedrooms or 4–5 full bathrooms")).toBeInTheDocument();
    expect(screen.getByText(/Your price is set by the larger of your two counts: up to 2 is Small, 3 is Medium, 4–5 is Large\./)).toBeInTheDocument();
    expect(screen.getByText(/Most homes get their price online before booking\./)).toBeInTheDocument();
  });

  it("services page states the same tier rule", () => {
    renderPage(<Services />);
    expect(screen.getByText(/Your price is set by the larger of your two counts: up to 2 is Small, 3 is Medium, 4–5 is Large\./)).toBeInTheDocument();
  });
});

describe("fix8 — clarity: no jargon in client-facing copy", () => {
  it("homepage, services, about, areas, faq and city pages have no calculator/sanitize/scope wording", () => {
    renderPage(<Index />);
    assertNoJargon();
    cleanup();
    renderPage(<Services />);
    assertNoJargon();
    cleanup();
    renderPage(<About />);
    assertNoJargon();
    cleanup();
    renderPage(<Areas />);
    assertNoJargon();
    cleanup();
    renderPage(<FAQ />);
    assertNoJargon();
    cleanup();
    render(
      <MemoryRouter initialEntries={["/areas/duluth"]}>
        <HelmetProvider>
          <Routes><Route path="/areas/:city" element={<CityPage />} /></Routes>
        </HelmetProvider>
      </MemoryRouter>
    );
    assertNoJargon();
  });

  it("FAQ and city copy data contain no calculator/sanitize/scope wording", () => {
    for (const data of [JSON.stringify(FAQS), JSON.stringify(CITIES)]) {
      expect(data).not.toMatch(/calculator/i);
      expect(data).not.toMatch(/sanitiz/i);
      expect(data).not.toMatch(/\bscope\b/i);
    }
  });

  it("quote step 1 has no jargon, including the unanswered-history price box", () => {
    openQuote();
    assertNoJargon();
    expect(screen.getByText(/we'll confirm the details with you before your visit\./)).toBeInTheDocument();
    expect(screen.getByText(/Your price is locked in when you send your request\. Nothing is charged today\./)).toBeInTheDocument();
  });

  it("quote step 2 planning note has no scope wording", () => {
    goToStep2();
    assertNoJargon();
    expect(screen.getByText(/We'll confirm the details with you before confirming your visit\./)).toBeInTheDocument();
  });
});

describe("fix8 — clarity: step-1 validation is never silent", () => {
  it("Continue with the cleaning-history question unanswered shows a red error and focuses the question", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Please answer this — it sets your first-visit price.");
    expect(screen.queryByRole("heading", { name: "Your visit" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /^Yes$/ }));
    // Answering clears the error and lets the client through.
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByRole("heading", { name: "Your visit" })).toBeInTheDocument();
  });

  it("Continue with an empty ZIP shows a red error under the ZIP field", () => {
    openQuote();
    // Deep clean has no cleaning-history question, so the ZIP error is the one that fires.
    fireEvent.click(screen.getByRole("radio", { name: /^Deep/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your ZIP code to see your price.");
    expect(screen.queryByRole("heading", { name: "Your visit" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText("ZIP code (service area check)"));
  });

  it("Continue with a partial ZIP shows a red error under the ZIP field", () => {
    openQuote();
    fireEvent.click(screen.getByRole("radio", { name: /^Deep/ }));
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a 5-digit ZIP code.");
    expect(screen.queryByRole("heading", { name: "Your visit" })).not.toBeInTheDocument();
  });
});

describe("fix8 — clarity: half bathrooms", () => {
  it("step 2 and step 3 never show '0 half bath', but show a real count", () => {
    goToStep2();
    // The summary line omits half baths at 0 (the select's own
    // "0 half bathrooms" option is not a summary line).
    expect(screen.getByText(/3 bed, 2 full bath · ZIP 30024/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/0 half bath · ZIP/);
    fireEvent.change(screen.getByLabelText("Half bathrooms"), { target: { value: "2" } });
    expect(screen.getByText(/3 bed, 2 full bath, 2 half bath · ZIP 30024/)).toBeInTheDocument();
    fillStep2();
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByRole("heading", { name: "Save your card securely" })).toBeInTheDocument();
    expect(screen.getByText(/3 bed, 2 full bath, 2 half bath · ZIP 30024/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/0 half bath · ZIP/);
  });
});
