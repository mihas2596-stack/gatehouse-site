import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SaveCard from "@/pages/SaveCard";
import ThankYou from "@/pages/ThankYou";

vi.mock("@/components/SEO", () => ({ default: () => null }));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
const card = { first: "184", service: "Standard", date: "2026-11-16", has_card: "1", card_brand: "visa", card_last4: "4242" };

describe("additional audit acceptance criteria — intended behavior", () => {
  it("a returning customer's unconfirmed card is a choice on /save-card", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: true, booking: card }) }));
    render(<MemoryRouter initialEntries={["/save-card?bt=audit-token"]}><SaveCard /></MemoryRouter>);
    await screen.findByRole("heading", { name: /Choose a card for this visit/ });
    // 16.11 item 6: the identified card is named, never confirmed blind.
    expect(screen.queryByRole("button", { name: /Use Visa ending in ••••4242 for this booking/ })).not.toBeNull();
  });
  it("the Change card destination allows a different card for a confirmed visit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: true, booking: { ...card, card_confirmed: "1", booking_confirmed: "1", confirmed_date: "2026-11-16", confirmed_window: "morning" } }) }));
    render(<MemoryRouter initialEntries={["/save-card?bt=audit-token"]}><SaveCard /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Card saved" });
    expect(screen.getByText(/Card: saved ✓ · Visit: confirmed for November 16, 2026/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add.*card|Change.*card|different card/i })).not.toBeNull();
  });
  it.each([
    { path: "/save-card?bt=audit-token&saved=1&session_id=cs_test_audit", Page: SaveCard },
    { path: "/save-card?bt=audit-token", Page: SaveCard },
    { path: "/thank-you?bt=audit-token", Page: ThankYou },
  ])("offers the existing date picker after card save at $path", async ({ path, Page }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({
      ok: true, verified: true, status: "saved", booking: { ...card, card_confirmed: "1", visit_state: "date_declined" },
    }) }));
    render(<MemoryRouter initialEntries={[path]}><Page /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Your requested date isn't available" })).toBeVisible();
    expect(screen.getByText("Card saved. $0 charged today.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Choose a new date" })).toHaveAttribute("href", "/visit?bt=audit-token#choose-date");
    expect(screen.queryByText(/No action needed|awaiting confirmation/i)).not.toBeInTheDocument();
  });
  it("a standalone card save does not claim that a cleaning date is awaiting confirmation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: true, verified: true, status: "saved", booking: null }) }));
    render(<MemoryRouter initialEntries={["/save-card?saved=1&session_id=cs_test_audit"]}><SaveCard /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Card saved" });
    expect(screen.queryByText(/Your date is awaiting confirmation/)).toBeNull();
    expect(screen.getByRole("link", { name: "See price & request a cleaning" }).getAttribute("href")).toBe("/quote");
  });
  it("lets a customer retry card entry after Stripe reports a failed setup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: true, verified: false, status: "failed", booking: null }) }));
    render(<MemoryRouter initialEntries={["/save-card?saved=1&session_id=cs_test_audit"]}><SaveCard /></MemoryRouter>);
    const retry = await screen.findByRole("button", { name: "Try card entry again" });
    expect(screen.getByText(/Saving a card is free/)).toBeVisible();
    fireEvent.click(retry);
    expect(screen.getByRole("button", { name: "Add card" })).toBeInTheDocument();
  });
  it("a failed status request is an unknown state, rather than a claim that another card entry is needed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<MemoryRouter initialEntries={[{ pathname: "/thank-you", state: { submitted: true, kind: "booking", bt: "audit-token" } }]}><ThankYou /></MemoryRouter>);
    await screen.findByRole("heading", { name: /verify your card status/ });
    expect(screen.queryByRole("button", { name: /Check again|Retry status/i })).not.toBeNull();
  });
});

describe("visit cancelled during card setup", () => {
  const cancelledResponse = {
    ok: false,
    status: 409,
    json: async () => ({
      ok: false, error: "visit_cancelled", status: "failed",
      booking: { ...card, visit_state: "requested" },
    }),
  };

  it("shows the cancellation if the visit was cancelled during the Stripe return", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(cancelledResponse));
    render(<MemoryRouter initialEntries={["/save-card?bt=audit-token&saved=1&session_id=cs_test_audit"]}><SaveCard /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "This visit is cancelled" })).toBeVisible();
    expect(screen.getByRole("link", { name: "View my visit" })).toHaveAttribute("href", "/visit?bt=audit-token");
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
  });

  it.each([
    { path: "/save-card", Page: SaveCard, booking: card, button: "Use Visa ending in ••••4242 for this booking" },
    { path: "/thank-you", Page: ThankYou, booking: card, button: "Use this card for this booking" },
    { path: "/save-card", Page: SaveCard, booking: { first: "184" }, button: "Add card" },
    { path: "/thank-you", Page: ThankYou, booking: { first: "184" }, button: "Continue to Stripe — $0 today" },
  ])("shows the cancellation when $button is clicked at $path", async ({ path, Page, booking, button }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, booking }) })
      .mockResolvedValueOnce(cancelledResponse);
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter initialEntries={[path + "?bt=audit-token"]}><Page /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: button }));
    expect(await screen.findByRole("heading", { name: "This visit is cancelled" })).toBeVisible();
    expect(screen.getByRole("link", { name: "View my visit" })).toHaveAttribute("href", "/visit?bt=audit-token");
    expect(screen.queryByRole("button", { name: button })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
