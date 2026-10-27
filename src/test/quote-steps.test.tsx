import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Quote from "@/pages/Quote";

vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-30T00:00:00Z"));
vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(cleanup);

const openQuote = () => render(<MemoryRouter><Quote /></MemoryRouter>);

describe("quote steps", () => {
  it("shows only the active step, keeps answers on back, and uses the exact step buttons", () => {
    openQuote();
    expect(screen.getByRole("heading", { name: "Your home & price" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Your name *")).not.toBeInTheDocument();
    expect(screen.queryByText("Request this booking")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Entry instructions/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByRole("heading", { name: "Your visit" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Bedrooms")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Your name *"), { target: { value: "Test Person" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to price" }));
    expect(screen.getByRole("heading", { name: "Your home & price" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByLabelText("Your name *")).toHaveValue("Test Person");
  });

  it("step 3 shows the exact payment text, the fixed-price rule and no entry secrets field", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["Preferred date *", "2099-12-01"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByRole("heading", { name: "Review & save card" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is charged today\. Your card is charged when you approve your cleaning report, or automatically 24 hours after we send it if you haven’t reported an issue\./)).toBeInTheDocument();
    expect(screen.getByText(/does not change if we resend a message, publish a new report version, or change the date or cleaner/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Entry instructions/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Gate code, where the key is/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save card — $0 today" })).toBeInTheDocument();
  });

  it("add extras are grouped, priced, and none are pre-selected", () => {
    openQuote();
    expect(screen.getByText("Add extras (optional)")).toBeInTheDocument();
    expect((screen.getByLabelText(/Inside oven/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Inside fridge/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Inside cabinets/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Pets/) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    expect(screen.getByText("First visit: $189", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Inside oven/));
    expect(screen.getByText("First visit: $224", { exact: false })).toBeInTheDocument();
  });

  it("a large home is honestly marked as a manual quote, not a fixed price", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "6" } });
    expect(screen.getByText(/Email us for a price/)).toBeInTheDocument();
    expect(screen.getByText(/Homes with 6\+ bedrooms or 6\+ full bathrooms get an individual quote/)).toBeInTheDocument();
  });
});
