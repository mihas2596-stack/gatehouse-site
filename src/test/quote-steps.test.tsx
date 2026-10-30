import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Quote from "@/pages/Quote";

vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-02T00:00:00Z"));
vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(cleanup);

const openQuote = () => render(<MemoryRouter><Quote /></MemoryRouter>);

// Step-2 fields for the new flow: city/state, an entry choice and the
// photo consent now live on step 2 and gate the move to step 3.
const fillStep2 = () => {
  for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["City *", "Sugar Hill"], ["State *", "GA"], ["Preferred date *", "2099-12-01"]]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole("radio", { name: /be home to let the cleaner in/ }));
  fireEvent.click(screen.getByLabelText(/I consent to photos inside my home/));
};

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
    fillStep2();
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByRole("heading", { name: "Review & save card" })).toBeInTheDocument();
    // The sentence is split: the lead is semibold, the rest regular.
    expect(screen.getByText("Nothing is charged today.")).toBeInTheDocument();
    expect(screen.getByText(/Your card is charged when you approve your cleaning report, or automatically 24 hours after we send it if you haven’t reported an issue\./)).toBeInTheDocument();
    // The resend/version/cleaner clause was removed from the client view.
    expect(screen.queryByText(/does not change if we resend a message, publish a new report version, or change the date or cleaner/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Entry instructions/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Gate code, where the key is/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to save card — $0 today" })).toBeInTheDocument();
  });

  it("add extras are grouped, priced, and none are pre-selected", () => {
    openQuote();
    expect(screen.getByText("Add extras (optional)")).toBeInTheDocument();
    // Extras start collapsed; expand them before touching the controls.
    fireEvent.click(screen.getByRole("button", { name: "Add extras (optional)" }));
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

  it("step 3 Price row shows real recurring values, never a literal fmt$ placeholder", () => {
    const goToStep3 = (history: "Yes" | "No", oven: boolean) => {
      openQuote();
      fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
      fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${history}$`) }));
      if (oven) {
        // Extras start collapsed.
        fireEvent.click(screen.getByRole("button", { name: "Add extras (optional)" }));
        fireEvent.click(screen.getByLabelText(/Inside oven/));
        // Addon price on step 1 is a single $ sign, not "+$$35".
        expect(document.body.textContent).toContain("+$35");
        expect(document.body.textContent).not.toContain("+$$35");
      }
      fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
      fillStep2();
      fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
      expect(screen.getByRole("heading", { name: "Review & save card" })).toBeInTheDocument();
    };
    // Defaults (3-bed M, cleaned recently, every other week): first
    // == recurring, so the first recurring branch renders.
    goToStep3("Yes", false);
    expect(screen.getByText("$189 per visit, every other week")).toBeInTheDocument();
    expect(screen.queryByText(/fmt\$/)).not.toBeInTheDocument();
    cleanup();
    // Same home + oven: both totals move by the $35 addon, still equal.
    goToStep3("Yes", true);
    expect(screen.getByText("$224 per visit, every other week")).toBeInTheDocument();
    expect(screen.queryByText(/fmt\$/)).not.toBeInTheDocument();
    cleanup();
    // Not cleaned recently: first visit is a deep clean, then the
    // recurring price — the second recurring branch renders. The
    // line is split across JSX fragments, so assert on page text.
    goToStep3("No", false);
    expect(document.body.textContent).toContain("First visit $329 (deep clean) , then $189 every other week");
    expect(screen.queryByText(/fmt\$/)).not.toBeInTheDocument();
  });

  it("planning lives on step 2, not step 1, and step changes land focus on the new heading", () => {
    openQuote();
    expect(screen.queryByText("Planning your visit")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Approximate home size — if you know it")).not.toBeInTheDocument();
    expect(screen.getByText(/Fixed when you send your request\. Nothing is charged today\./)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByRole("heading", { name: "Your visit" })).toBeInTheDocument();
    // jsdom has no real scrolling, so focus on the new heading is
    // the testable half of the scroll fix (the effect scrolls the
    // heading into view, then focuses it).
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Your visit" }));
    expect(screen.getByText("Planning your visit")).toBeInTheDocument();
    expect(screen.getByLabelText("Approximate home size — if you know it")).toBeInTheDocument();
    expect(screen.getByText("Any extra areas to clean?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to price" }));
    expect(screen.getByRole("heading", { name: "Your home & price" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Your home & price" }));
    expect(screen.queryByText("Planning your visit")).not.toBeInTheDocument();
  });

  it("step 3 payment block answers why the card, without the wall of text", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    fillStep2();
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByRole("heading", { name: "Review & save card" })).toBeInTheDocument();
    expect(screen.getByText(/Why your card now\?/)).toBeInTheDocument();
    expect(screen.getByText(/Safe with Stripe\./)).toBeInTheDocument();
    expect(screen.getByText(/You stay in control\./)).toBeInTheDocument();
    expect(screen.getByText(/Saving a card doesn’t confirm your date/)).toBeInTheDocument();
    expect(screen.queryByText(/A report email that bounces blocks/)).not.toBeInTheDocument();
    expect(screen.queryByText(/After your visit we send a status update/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Saving a card is not a confirmed date/)).not.toBeInTheDocument();
    expect(screen.queryByText(/We confirm your date within one business day/)).not.toBeInTheDocument();
  });

  it("a large home is honestly marked as a manual quote, not a fixed price", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "6" } });
    expect(screen.getByText(/Email us for a price/)).toBeInTheDocument();
    expect(screen.getByText(/Homes with 6\+ bedrooms or 6\+ full bathrooms get an individual quote/)).toBeInTheDocument();
  });

  it("step 2 asks how to arrange entry, with no preselection and no codes", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByText("How would you like to arrange entry? *")).toBeInTheDocument();
    expect(screen.getByText("You’re welcome to be home for your cleaning. Choose what works best for you.")).toBeInTheDocument();
    for (const name of [/be home to let the cleaner in/, /Someone else will let/, /arrange entry before/, /decide later/]) {
      expect((screen.getByRole("radio", { name }) as HTMLInputElement).checked).toBe(false);
    }
    expect(screen.queryByText("Door code / smart lock")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /arrange entry before/ }));
    expect(screen.getByText("Door code / smart lock")).toBeInTheDocument();
    expect(screen.getByText("Lockbox")).toBeInTheDocument();
    expect(screen.getByText("No entry codes are needed now. You can add private entry details after your visit is confirmed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /be home to let the cleaner in/ }));
    expect(screen.queryByText("Door code / smart lock")).not.toBeInTheDocument();
  });

  it("review is blocked without an entry choice", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["City *", "Sugar Hill"], ["State *", "GA"], ["Preferred date *", "2099-12-01"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByLabelText(/I consent to photos inside my home/));
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByText("Choose how to arrange entry.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your visit" })).toBeInTheDocument();
  });

  it("step 3 shows one summary with requested date, entry, and Due today $0", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    fillStep2();
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByRole("heading", { name: "Your request" })).toBeInTheDocument();
    expect(document.body.textContent).toContain("December 1, 2099");
    expect(screen.getByText("Due today")).toBeInTheDocument();
    expect(screen.getByText("$0")).toBeInTheDocument();
    expect(screen.getByText(/be home to let the cleaner in/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit details" })).toBeInTheDocument();
    expect(screen.getByText("View all details")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to save card — $0 today" })).toBeInTheDocument();
  });

  it("city is required on step 2", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["State *", "GA"], ["Preferred date *", "2099-12-01"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("radio", { name: /be home to let the cleaner in/ }));
    fireEvent.click(screen.getByLabelText(/I consent to photos inside my home/));
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByText("Enter your city.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your visit" })).toBeInTheDocument();
  });
});
