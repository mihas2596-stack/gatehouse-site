import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ThankYou from "@/pages/ThankYou";

vi.mock("@/components/SEO", () => ({ default: () => null }));
afterEach(cleanup);

const bookingState = {
  submitted: true,
  kind: "booking" as const,
  customerEmailSent: true,
  bt: "v2.test-token",
  recap: { email: "client@example.com", date: "2026-11-08", window: "9:00 AM - 12:00 PM" },
  plan: { service: "Standard Cleaning", first: 21.9, recurring: null, firstIsDeep: false },
};

function renderWith(cardStatus: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => cardStatus }));
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/thank-you", state: bookingState }]}>
      <ThankYou />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("/thank-you card states", () => {
  it("state A: card not saved yet — one last step, $0 today", async () => {
    renderWith({ ok: true, booking: { first: "21.9", service: "Standard Cleaning", date: "2026-11-08" } });
    expect(await screen.findByText("One last step: save your card")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save card — $0 today" })).toBeInTheDocument();
    expect(screen.getByText("$21.90")).toBeInTheDocument();
    expect(screen.getByText("Awaiting confirmation")).toBeInTheDocument();
  });

  it("state C: card saved — all set, no action needed, View my visit", async () => {
    renderWith({ ok: true, booking: { first: "21.9", service: "Standard Cleaning", date: "2026-11-08", has_card: "1" } });
    expect(await screen.findByText(/You're all set — your request is received/)).toBeInTheDocument();
    expect(screen.getByText(/Card saved · \$0 charged today/)).toBeInTheDocument();
    expect(screen.getByText(/No further action is needed right now/)).toBeInTheDocument();
    expect(screen.getByText("client@example.com")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View my visit" })).toBeInTheDocument();
    expect(screen.getByText(/Your card is charged when you approve the report, or automatically 24 hours after we send it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save card/ })).not.toBeInTheDocument();
  });

  it("state D: card failed — wasn't saved, retry offered, no confirmation claim", async () => {
    renderWith({ ok: true, booking: { first: "21.9", card_state: "card_failed" } });
    expect(await screen.findByText("Your card wasn't saved")).toBeInTheDocument();
    expect(screen.getByText(/your visit isn't confirmed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try saving your card again" })).toBeInTheDocument();
  });
});

describe("/thank-you revisit without router state", () => {
  it("state A still shows the server price, service and date chip", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, booking: { first: "21.9", service: "Standard Cleaning", date: "2026-11-08" } }),
    }));
    render(
      <MemoryRouter initialEntries={[{ pathname: "/thank-you", state: { submitted: true, kind: "booking", bt: "v2.test-token", customerEmailSent: true } }]}>
        <ThankYou />
      </MemoryRouter>,
    );
    expect(await screen.findByText("One last step: save your card")).toBeInTheDocument();
    expect(screen.getByText("$21.90")).toBeInTheDocument();
    expect(screen.getByText("Standard Cleaning")).toBeInTheDocument();
    expect(screen.getByText("Awaiting confirmation")).toBeInTheDocument();
  });
});
