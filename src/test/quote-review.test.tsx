import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Quote from "@/pages/Quote";

// Owner order 2026-10-24 runs a GLOBAL test-price window (until
// 2026-11-06T10:33Z after the extensions of 2026-10-26, 2026-10-28, 2026-10-31 and 2026-11-03). Pin the clock
// past the window so these regular-price assertions stay deterministic;
// token test mode has its own cases below.
vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-14T00:00:00Z"));
vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(cleanup);

const openQuote = () => render(<MemoryRouter><Quote /></MemoryRouter>);

describe("booking price confirmation", () => {
  it("restores the calculator after reload without restoring visit details", () => {
    const first = openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    fireEvent.change(screen.getByLabelText("Your name *"), { target: { value: "Example Customer" } });
    first.unmount();

    openQuote();
    expect(screen.getByLabelText("ZIP code (service area check)")).toHaveValue("30024");
    expect(screen.getByLabelText("Bedrooms")).toHaveValue("4");
    expect(screen.getByText("First visit (Standard): $239")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByLabelText("Your name *")).toHaveValue("");
  });

  it("uses the selected service instead of cleaning history", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30518" } });
    expect(screen.getByText("First visit (Standard): $189")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /^One-time$/ }));
    expect(screen.getByText("One-time cleaning: $219")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /^Deep A detailed/ }));
    expect(screen.getByText("One-time cleaning: $329")).toBeInTheDocument();
    expect(screen.queryByText(/Future visits/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByRole("heading", { name: "Your visit" })).toBeInTheDocument();
  });

  it("shows one unified regular total for the confirmed scenario", () => {
    // 3bd/2ba, Standard, every other week, oven +$35:
    // first visit $224 (189 + 35), then $224 per visit. The Founding
    // Clients program is closed — no founding checkbox exists anymore.
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    expect(screen.queryByLabelText(/claiming a founding spot/)).not.toBeInTheDocument();
    // Extras start collapsed.
    fireEvent.click(screen.getByRole("button", { name: /Add extras \(optional\) — None selected/ }));
    fireEvent.click(screen.getByLabelText(/Inside oven/));
    expect(screen.getByText("First visit (Standard): $224")).toBeInTheDocument();
    expect(screen.getByText("Future visits (Standard): $224 every other week")).toBeInTheDocument();
    // No founding language anywhere on the page.
    expect(screen.queryByText(/founding/i)).not.toBeInTheDocument();
  });

  it("shows reduced prices in owner test mode (verified tp token)", async () => {
    // The quote page only scales prices after the server verifies the
    // token — mock that check as verified.
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ ok: true }) })));
    render(
      <MemoryRouter initialEntries={["/quote?tp=tp1.9999999999.token"]}>
        <Quote />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    await waitFor(() => {
      expect(screen.getByText(/Test booking: prices on this page are reduced for a payment test/)).toBeInTheDocument();
    });
    // Regular $189 recurring M at 1/100 = $1.89, capped at the $1.50 test ceiling.
    expect(screen.getByText("First visit (Standard): $1.50")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("requires another review when the calculator changes after confirmation", () => {
    Element.prototype.scrollIntoView = vi.fn();
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30518" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["City *", "Sugar Hill"], ["State *", "GA"], ["Preferred date *", "2099-12-01"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("radio", { name: /I’ll be home/ }));
    fireEvent.click(document.getElementById("b-photo")!);
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    fireEvent.click(document.getElementById("b-terms")!);
    expect(screen.getByRole("button", { name: "Continue to Stripe — $0 today" })).toBeInTheDocument();
    // Editing the price leaves step 3: the save button is gone until the
    // request is reviewed again, with answers preserved.
    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to price" }));
    expect(screen.queryByRole("button", { name: "Continue to Stripe — $0 today" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByLabelText("Your name *")).toHaveValue("Test Person");
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByRole("button", { name: "Continue to Stripe — $0 today" })).toBeInTheDocument();
  });
});
