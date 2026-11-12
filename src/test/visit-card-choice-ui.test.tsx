import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Visit from "@/pages/Visit";

vi.mock("@/components/SEO", () => ({ default: () => null }));
let confirmed: boolean;
let hasCard: boolean;
let choices: number;
let visitStateOverride: string | null;
let reportStateOverride: string | null;

beforeEach(() => {
  confirmed = false; hasCard = true; choices = 0;
  visitStateOverride = null; reportStateOverride = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/card-status" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(body.action).toBe("confirm_card");
      confirmed = true; choices++;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (String(url).startsWith("/api/report?")) {
      return { ok: true, json: async () => ({
        ok: true, state: reportStateOverride ?? "awaiting", amount: "$1.50",
        photo_items: [], checklist: null,
      }) };
    }
    if (url === "/api/report" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(body.action).toBe("approve");
      return {
        ok: false,
        status: 409,
        json: async () => ({
          ok: true, state: "awaiting", amount: "$1.50",
          photo_items: [], checklist: null, publication_id: "pub-1",
          error: "card_confirmation_required",
        }),
      };
    }
    if (!String(url).startsWith("/api/visit?")) throw new Error("Unexpected request");
    return { ok: true, json: async () => ({
      ok: true, state: visitStateOverride ?? (hasCard ? "awaiting_confirmation" : "card_needed"),
      has_card: hasCard, card_confirmed: confirmed, card_brand: "visa", card_last4: "4242",
      booking: { service: "Standard", requested_date: "2026-11-10", first: "$1.50" },
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

describe("H1 (visit): an unknown payment outcome is never shown as approved", () => {
  it("shows the payment-unknown headline and retry, not 'Visit approved'", async () => {
    visitStateOverride = "payment_unknown";
    reportStateOverride = "payment_unknown";
    open();
    expect(await screen.findByRole("heading", { name: "We couldn't confirm your payment" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Visit approved" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Try charging $1.50 again" })).toBeInTheDocument();
    // Change card is offered both next to the card label and in the
    // retry block.
    expect(screen.getAllByRole("link", { name: "Change card" })).toHaveLength(2);
  });
});

describe("S13 (visit): Approve with an ambiguous card leads to the card-choice flow", () => {
  it("shows the card-choice message and a link to /save-card in the report section", async () => {
    visitStateOverride = "report_sent";
    reportStateOverride = "awaiting";
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Approve & pay $1.50" }));
    expect(await screen.findByText(/We found more than one card on file/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Choose a card for this visit" });
    expect(link.getAttribute("href")).toBe("/save-card?bt=test-booking");
  });
});
