import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Quote from "@/pages/Quote";

// The owner-ordered global price-cut window is time-based; pin it OFF here
// so these price assertions stay deterministic. Token test mode has its
// own cases below.
vi.mock("@/config/calculator", async (importActual) => {
  const actual = await importActual<typeof import("@/config/calculator")>();
  return { ...actual, priceCutActive: () => false };
});
vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(cleanup);

const openQuote = () => render(<MemoryRouter><Quote /></MemoryRouter>);

describe("booking price confirmation", () => {
  it("requires cleaning history for standard cleans but not deep cleans", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30518" } });
    expect(screen.getByRole("button", { name: "Answer the cleaning-history question above" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /Deep Detailed/ }));
    expect(screen.getByRole("button", { name: "Review my details" })).toBeEnabled();
    expect(screen.queryByText(/Has a professional cleaner/)).not.toBeInTheDocument();
  });

  it("shows the deep first visit in the result and mobile price bar", () => {
    openQuote();
    fireEvent.click(screen.getByRole("radio", { name: /^No$/ }));
    // Unified breakdown: one first-visit total, explicitly labeled as a deep clean.
    expect(screen.getByText("First visit: $329", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("— deep clean")).toBeInTheDocument();
    expect(screen.getByText("$329 first visit (deep clean)", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Then $189 per visit, every other week")).toBeInTheDocument();
  });

  it("shows one unified regular total for the confirmed scenario", () => {
    // 3bd/2ba, Standard, every other week, cleaned=Yes, oven +$35:
    // first visit $224 (189 + 35), then $224 per visit. The Founding
    // Clients program is closed — no founding checkbox exists anymore.
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    expect(screen.queryByLabelText(/claiming a founding spot/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Inside oven/));
    expect(screen.getByText("First visit: $224", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("First visit: $224 · then $224 per visit, every other week")).toBeInTheDocument();
    // No founding language anywhere on the page.
    expect(screen.queryByText(/founding/i)).not.toBeInTheDocument();
  });

  it("shows reduced prices in owner test mode (tp token in the URL)", () => {
    render(
      <MemoryRouter initialEntries={["/quote?tp=tp1.9999999999.token"]}>
        <Quote />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    expect(screen.getByText(/Test mode: prices on this page are reduced to 1\/100/)).toBeInTheDocument();
    // Regular $189 recurring M at 1/100, no add-ons.
    expect(screen.getByText("First visit: $1.89", { exact: false })).toBeInTheDocument();
  });

  it("requires another review when the calculator changes after confirmation", () => {
    Element.prototype.scrollIntoView = vi.fn();
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30518" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["Preferred date *", "2099-12-01"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(document.getElementById("b-terms")!);
    fireEvent.click(document.getElementById("b-photo")!);
    fireEvent.click(screen.getByRole("button", { name: "Review my details" }));
    expect(screen.getByRole("button", { name: /Send request — \$0 today/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "4" } });
    expect(screen.queryByRole("button", { name: /Send request — \$0 today/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review my details" })).toBeEnabled();
  });
});
