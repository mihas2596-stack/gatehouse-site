import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    await screen.findByRole("heading", { name: "Booking confirmed" });
    expect(screen.queryByRole("button", { name: /Add.*card|Change.*card|different card/i })).not.toBeNull();
  });
  it("a failed status request is an unknown state, rather than a claim that another card entry is needed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<MemoryRouter initialEntries={[{ pathname: "/thank-you", state: { submitted: true, kind: "booking", bt: "audit-token" } }]}><ThankYou /></MemoryRouter>);
    await screen.findByRole("heading", { name: /verify your card status/ });
    expect(screen.queryByRole("button", { name: /Check again|Retry status/i })).not.toBeNull();
  });
});
