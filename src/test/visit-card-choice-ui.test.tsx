import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Visit from "@/pages/Visit";

vi.mock("@/components/SEO", () => ({ default: () => null }));
let confirmed: boolean;
let hasCard: boolean;
let choices: number;

beforeEach(() => {
  confirmed = false; hasCard = true; choices = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/card-status" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(body.action).toBe("confirm_card");
      confirmed = true; choices++;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (!String(url).startsWith("/api/visit?")) throw new Error("Unexpected request");
    return { ok: true, json: async () => ({
      ok: true, state: hasCard ? "awaiting_confirmation" : "card_needed",
      has_card: hasCard, card_confirmed: confirmed, card_brand: "visa", card_last4: "4242",
      booking: { service: "Standard", requested_date: "2027-01-15", first: "$1.50" },
      confirm_by: "tomorrow", entry_available: false,
    }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = () => render(<MemoryRouter initialEntries={["/visit?bt=test-booking"]}><Visit /></MemoryRouter>);

describe("a card from another booking still needs this customer's explicit choice", () => {
  it("does not say 'Next step is ours' before the card is confirmed for this request", async () => {
    open();
    expect(await screen.findByRole("heading", { name: "Request received — confirm your card" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this card for this booking" })).toBeInTheDocument();
    expect(screen.queryByText("Next step is ours.")).not.toBeInTheDocument();
    expect(choices).toBe(0);
  });

  it("shows the owner as the next actor only after the customer explicitly selects the card", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Use this card for this booking" }));
    expect(await screen.findByText("Next step is ours.")).toBeInTheDocument();
    expect(choices).toBe(1);
    expect(screen.queryByRole("button", { name: "Use this card for this booking" })).not.toBeInTheDocument();
  });

  it("keeps the save-card action when there is no saved card", async () => {
    hasCard = false;
    open();
    expect(await screen.findByRole("heading", { name: "Request received — one step left" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Save card — $0 today" })).toBeInTheDocument();
    expect(screen.queryByText("Next step is ours.")).not.toBeInTheDocument();
  });
});
