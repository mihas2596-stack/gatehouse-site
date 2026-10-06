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
    expect(screen.getByText("First visit: $329 per visit")).toBeInTheDocument();
    expect(screen.getByText("$329 first visit")).toBeInTheDocument();
    expect(screen.getByText("Then $189 every other week")).toBeInTheDocument();
  });

  it("requires another review when the calculator changes after confirmation", () => {
    Element.prototype.scrollIntoView = vi.fn();
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30518" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["Preferred date * (YYYY-MM-DD)", "2099-12-01"]]) {
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
