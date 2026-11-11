import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import Index from "@/pages/Index";
import Visit from "@/pages/Visit";

// Pinned past the global test-price window so price rendering stays
// deterministic (same pin as the fix7/fix8 suites).
vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-14T00:00:00Z"));
vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/measurement", () => ({ campaignAttribution: () => ({}), trackFunnel: () => true }));

const CANONICAL =
  "See your photo report before payment. Approve to pay, or report an issue. If no issue is reported, your card is charged automatically 24 hours after the report is sent.";

describe("fix10 — ChatGPT spec, item 1: canonical payment sentence", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("home 'When you pay' is two short paragraphs, not the old definition list", () => {
    render(<MemoryRouter><HelmetProvider><Index /></HelmetProvider></MemoryRouter>);

    // Structure kept: heading + anchor id.
    expect(screen.getByRole("heading", { name: "When you pay" })).toBeInTheDocument();
    expect(document.getElementById("when-you-pay")).not.toBeNull();
    expect(screen.queryByText("What if something was missed?")).not.toBeInTheDocument();

    // The two canonical paragraphs, verbatim.
    expect(screen.getByText("Save your card at booking — you pay $0 today.")).toBeInTheDocument();
    expect(screen.getByText(CANONICAL)).toBeInTheDocument();

    // The old definition-list wordings are gone.
    expect(screen.queryByText("At booking")).not.toBeInTheDocument();
    expect(screen.queryByText("After your clean")).not.toBeInTheDocument();
    expect(screen.queryByText("After 24 hours")).not.toBeInTheDocument();
  });
});

describe("fix10 — ChatGPT spec, item 2: 'Price confirmed for this visit'", () => {
  let reportAmount: string | null;
  beforeEach(() => {
    reportAmount = "$1.50";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/report?")) {
        return { ok: true, json: async () => ({
          ok: true, state: "awaiting", amount: reportAmount,
          photo_items: [], checklist: null,
        }) };
      }
      if (!String(url).startsWith("/api/visit?")) throw new Error("Unexpected request");
      return { ok: true, json: async () => ({
        ok: true, state: "report_sent",
        has_card: true, card_confirmed: true, card_brand: "visa", card_last4: "4242",
        booking: { service: "Standard", requested_date: "2027-01-15", first: "$1.50" },
        confirm_by: "tomorrow", entry_available: false,
      }) };
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const open = () => render(<MemoryRouter initialEntries={["/visit?bt=test-booking"]}><Visit /></MemoryRouter>);

  it("shows the note under the report summary when the pinned amount exists", async () => {
    open();
    expect(await screen.findByRole("heading", { name: "Cleaning report" })).toBeInTheDocument();
    expect(screen.getByText("This visit")).toBeInTheDocument();
    expect(screen.getByText("$1.50")).toBeInTheDocument();
    expect(screen.getByText("Price confirmed for this visit.")).toBeInTheDocument();
  });

  it("shows no note when there is no pinned amount", async () => {
    reportAmount = null;
    open();
    expect(await screen.findByRole("heading", { name: "Cleaning report" })).toBeInTheDocument();
    expect(screen.queryByText("This visit")).not.toBeInTheDocument();
    expect(screen.queryByText("Price confirmed for this visit.")).not.toBeInTheDocument();
  });
});
