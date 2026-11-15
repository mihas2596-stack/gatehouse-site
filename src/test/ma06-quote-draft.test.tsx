import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Quote from "@/pages/Quote";

// MA-06: a draft restores step 3, but the consents are intentionally NOT
// stored in the draft — so a reload on the review step used to strand the
// visitor there with a dead submit (the photo-consent checkbox lives only
// on step 2). The fix clamps a step-3 restore to step 2, and the submit
// handler shows a visible error instead of returning silently when the
// failing field's input is not mounted.

// Pinned past the global test-price window (until 2026-11-18T20:59:59Z,
// extended 2026-11-12 by 5 days) so regular-price assertions stay deterministic.
vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-21T00:00:00Z"));
vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => {
  cleanup();
  sessionStorage.removeItem("gh_quote_draft_v1");
  vi.unstubAllGlobals();
});

const openQuote = () => render(<MemoryRouter><Quote /></MemoryRouter>);

// Step-2 fields for the flow: city/state, an entry choice and the photo
// consent live on step 2 and gate the move to step 3.
const fillStep2 = () => {
  for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["City *", "Sugar Hill"], ["State *", "GA"], ["Preferred date *", "2099-12-01"]]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole("radio", { name: /I’ll be home/ }));
  fireEvent.click(screen.getByLabelText(/I agree to photos of the cleaned rooms/));
};

// A draft as the save effect writes it: step 3 with the whole form, but
// no consents (they are never stored — the visitor re-gives them).
const seedDraft = (step: 2 | 3) => {
  sessionStorage.setItem("gh_quote_draft_v1", JSON.stringify({
    savedAt: Date.now(),
    zip: "30024",
    bedrooms: 3,
    fullBaths: 2,
    halfBaths: 0,
    frequency: "every2weeks",
    service: "standard",
    addons: { insideOven: false, insideFridge: false, insideCabinets: false, interiorWindows: 0, pets: false },
    step,
    contact: { name: "Test Person", email: "test@example.com", phone: "7705550100", address: "123 Test Street", date: "2099-12-01", time: "morning", notes: "", city: "Sugar Hill", state: "GA", apt: "" },
    entry: { method: "home", detail: "", notes: "" },
  }));
};

describe("MA-06 quote draft restore", () => {
  it("a step-3 draft restores to step 2, where the photo consent lives", () => {
    seedDraft(3);
    openQuote();
    // Not the review step: the visitor must re-give consent on step 2.
    expect(screen.getByRole("heading", { name: "Your visit" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Your request" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue to Stripe — $0 today" })).not.toBeInTheDocument();
    // The rest of the form is still restored.
    expect(screen.getByLabelText("Your name *")).toHaveValue("Test Person");
    expect(screen.getByLabelText("Email *")).toHaveValue("test@example.com");
    expect(screen.getByLabelText("Preferred date *")).toHaveValue("2099-12-01");
    expect(screen.getByRole("radio", { name: /I’ll be home/ })).toBeChecked();
    // Consent is NOT restored — the visitor re-gives it here.
    expect(screen.getByLabelText(/I agree to photos of the cleaned rooms/)).not.toBeChecked();
  });

  it("a step-2 draft still restores to step 2", () => {
    seedDraft(2);
    openQuote();
    expect(screen.getByRole("heading", { name: "Your visit" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your name *")).toHaveValue("Test Person");
    expect(screen.getByLabelText(/I agree to photos of the cleaned rooms/)).not.toBeChecked();
  });

  it("a reload on step 3 lands on step 2, and the request still completes after re-giving consent", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const first = openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    fillStep2();
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByRole("heading", { name: "Your request" })).toBeInTheDocument();
    // Simulate a reload (e.g. the tab was backgrounded on a phone):
    // unmount and remount; sessionStorage survives.
    first.unmount();
    openQuote();
    // Lands on step 2, not step 3 — the dead submit is gone.
    expect(screen.getByRole("heading", { name: "Your visit" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your name *")).toHaveValue("Test Person");
    expect(screen.getByLabelText(/I agree to photos of the cleaned rooms/)).not.toBeChecked();
    // Re-give the photo consent where its checkbox lives, review again.
    fireEvent.click(screen.getByLabelText(/I agree to photos of the cleaned rooms/));
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByRole("heading", { name: "Your request" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/I agree to the/));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Stripe — $0 today" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, { body: string }] | undefined;
    expect(firstCall).toBeDefined();
    const body = JSON.parse(firstCall![1].body as string);
    expect(body.photo_consent).toBe(true);
    expect(body.terms_consent).toBe(true);
  });

  it("submitting on step 3 without Terms shows the error inline and sends nothing", () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    fillStep2();
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByRole("heading", { name: "Your request" })).toBeInTheDocument();
    // Terms is the only consent on step 3 and it is unchecked.
    fireEvent.click(screen.getByRole("button", { name: "Continue to Stripe — $0 today" }));
    expect(screen.getByText("Please agree to the Terms of Service and Privacy Policy.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an Enter-submit on step 2 with valid fields but no consents focuses the photo checkbox instead of dying silently", () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    // Valid fields and an entry choice, but neither consent is given.
    for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["City *", "Sugar Hill"], ["State *", "GA"], ["Preferred date *", "2099-12-01"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("radio", { name: /I’ll be home/ }));
    // Pressing Enter in a field submits the form; the Terms checkbox is
    // not mounted on step 2, so the old focus loop returned silently
    // after failing to focus it. Now the loop skips the unmounted ref
    // and focuses the photo checkbox instead.
    fireEvent.submit(document.getElementById("booking-request")!);
    expect(screen.getByText("Please agree to photos for your private report.")).toBeInTheDocument();
    expect(document.activeElement).toBe(document.getElementById("b-photo"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
