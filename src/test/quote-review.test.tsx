import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Quote from "@/pages/Quote";

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

  it("shows one unified founding total for the confirmed scenario", () => {
    // 3bd/2ba, Standard, every other week, cleaned=Yes, founding on, oven +$35:
    // first visit $188 (153 + 35), then $167 (132 + 35), $224 after 6 months.
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    fireEvent.click(screen.getByLabelText(/claiming a founding spot/));
    fireEvent.click(screen.getByLabelText(/Inside oven/));
    expect(screen.getByText("First visit: $188", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Then $167 per visit, every other week")).toBeInTheDocument();
    expect(screen.getByText("After 6 months: $224 per visit.")).toBeInTheDocument();
    // No contradictory numbers: the old $224 headline / $153-off-$254 lines are gone.
    expect(screen.queryByText(/30% off the \$254/)).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: /Send my booking request/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "4" } });
    expect(screen.queryByRole("button", { name: /Send my booking request/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review my details" })).toBeEnabled();
  });
});
