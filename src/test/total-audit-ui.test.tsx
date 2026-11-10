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
    expect(screen.queryByRole("button", { name: /Use this card for this booking/i })).not.toBeNull();
  });
  it("the Change card destination allows a different card for a confirmed visit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: true, booking: { ...card, card_confirmed: "1", booking_confirmed: "1", confirmed_date: "2026-11-16", confirmed_window: "morning" } }) }));
    render(<MemoryRouter initialEntries={["/save-card?bt=audit-token"]}><SaveCard /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Card saved — $0 charged today" });
    expect(screen.getByText(/Card: saved ✓ · Visit: confirmed for November 16, 2026/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add.*card|Change.*card|different card/i })).not.toBeNull();
  });
  it("a standalone card save does not claim that a cleaning date is awaiting confirmation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: true, verified: true, status: "saved", booking: null }) }));
    render(<MemoryRouter initialEntries={["/save-card?saved=1&session_id=cs_test_audit"]}><SaveCard /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Card saved — $0 charged today" });
    expect(screen.queryByText(/Your date is awaiting confirmation/)).toBeNull();
    expect(screen.getByRole("link", { name: "See price & request a cleaning" }).getAttribute("href")).toBe("/quote");
  });
  it("lets a customer retry card entry after Stripe reports a failed setup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: true, verified: false, status: "failed", booking: null }) }));
    render(<MemoryRouter initialEntries={["/save-card?saved=1&session_id=cs_test_audit"]}><SaveCard /></MemoryRouter>);
    const retry = await screen.findByRole("button", { name: "Try card entry again" });
    fireEvent.click(retry);
    expect(screen.getByRole("button", { name: "Add card — $0 today" })).toBeInTheDocument();
  });
  it("a failed status request is an unknown state, rather than a claim that another card entry is needed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<MemoryRouter initialEntries={[{ pathname: "/thank-you", state: { submitted: true, kind: "booking", bt: "audit-token" } }]}><ThankYou /></MemoryRouter>);
    await screen.findByRole("heading", { name: /verify your card status/ });
    expect(screen.queryByRole("button", { name: /Check again|Retry status/i })).not.toBeNull();
  });
});
