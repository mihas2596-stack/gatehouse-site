import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Report from "@/pages/Report";

vi.mock("@/components/SEO", () => ({ default: () => null }));

// S13 (audit 09.11.2026): Approve refused with 409
// card_confirmation_required — several cards on file, none confirmed
// for this booking — must lead the client to the existing confirm_card
// flow (/save-card) instead of leaving a dead Approve button.
const REPORT = {
  ok: true,
  state: "awaiting",
  amount: "$1.50",
  publication_id: "pub-1",
  photo_items: [{ url: "https://img.example/k.jpg", room: "Kitchen", kind: "after" }],
  checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wiped", done: true }] }] },
};

let approveCalls: number;

beforeEach(() => {
  approveCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/report?")) {
      return { ok: true, json: async () => REPORT };
    }
    if (url === "/api/report" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(body.action).toBe("approve");
      expect(body.seen_publication_id).toBe("pub-1");
      approveCalls++;
      return {
        ok: false,
        status: 409,
        json: async () => ({ ...REPORT, error: "card_confirmation_required" }),
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = () => render(<MemoryRouter initialEntries={["/report?bt=test-booking"]}><Report /></MemoryRouter>);

describe("S13: Approve with an ambiguous card leads to the card-choice flow", () => {
  it("shows the card-choice message and a link to /save-card, with no charge", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Approve & pay $1.50" }));
    expect(await screen.findByText(/We found more than one card on file/)).toBeInTheDocument();
    expect(screen.getByText(/no charge was made/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Choose a card for this visit" });
    expect(link.getAttribute("href")).toBe("/save-card?bt=test-booking");
    expect(approveCalls).toBe(1);
  });
});
