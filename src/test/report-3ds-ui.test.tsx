import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Report from "@/pages/Report";

vi.mock("@/components/SEO", () => ({ default: () => null }));

// 3DS (H1): the saved card needs cardholder authentication. The server
// answers approve with 402 payment_requires_action + client_secret +
// publishable_key; the page must complete the challenge with Stripe.js
// (handleCardAction) and then re-approve once — the same intent, no
// second charge.
const { handleCardActionMock, loadStripeMock } = vi.hoisted(() => ({
  handleCardActionMock: vi.fn(async (_secret: string) => ({
    error: undefined,
    paymentIntent: { id: "pi_test_1", status: "succeeded" },
  })),
  loadStripeMock: vi.fn(async (_key: string) => ({
    handleCardAction: (...args: unknown[]) =>
      (handleCardActionMock as (...a: unknown[]) => unknown)(...args),
  })),
}));
vi.mock("@stripe/stripe-js", () => ({ loadStripe: loadStripeMock }));

const REPORT = {
  ok: true,
  state: "awaiting",
  amount: "$1.50",
  publication_id: "pub-1",
  photo_items: [{ url: "https://img.example/k.jpg", room: "Kitchen", kind: "after" }],
  checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wiped", done: true }] }] },
};

let approveCalls: number;
let publishableKey: string;

beforeEach(() => {
  approveCalls = 0;
  publishableKey = "pk_test_3ds";
  handleCardActionMock.mockClear();
  loadStripeMock.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/report?")) {
      return { ok: true, json: async () => REPORT };
    }
    if (url === "/api/report" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(body.action).toBe("approve");
      expect(body.seen_publication_id).toBe("pub-1");
      approveCalls++;
      if (approveCalls === 1) {
        return {
          ok: false,
          status: 402,
          json: async () => ({
            ...REPORT,
            error: "payment_requires_action",
            client_secret: "pi_test_1_secret_abc",
            payment_intent: "pi_test_1",
            publishable_key: publishableKey,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...REPORT, state: "paid" }),
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = () => render(<MemoryRouter initialEntries={["/report?bt=test-booking"]}><Report /></MemoryRouter>);

describe("3DS: Approve with a card that needs authentication", () => {
  it("completes the challenge with Stripe.js and re-approves once — one intent, paid", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Approve & pay $1.50" }));
    // The challenge ran with the secret the server returned, and the
    // page re-approved once afterwards instead of leaving a dead button.
    expect(await screen.findByText(/Paid — thank you/)).toBeInTheDocument();
    expect(loadStripeMock).toHaveBeenCalledWith("pk_test_3ds");
    expect(handleCardActionMock).toHaveBeenCalledWith("pi_test_1_secret_abc");
    expect(handleCardActionMock).toHaveBeenCalledTimes(1);
    expect(approveCalls).toBe(2);
  });

  it("without a publishable key it never calls Stripe and says to email us — no charge, no loop", async () => {
    publishableKey = "";
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Approve & pay $1.50" }));
    expect(await screen.findByText(/extra verification/)).toBeInTheDocument();
    expect(screen.getByText(/hello@gatehousehomecleaning.com/)).toBeInTheDocument();
    expect(loadStripeMock).not.toHaveBeenCalled();
    expect(handleCardActionMock).not.toHaveBeenCalled();
    expect(approveCalls).toBe(1);
  });

  it("when the cardholder fails or cancels the challenge it shows the error and does not re-approve", async () => {
    handleCardActionMock.mockResolvedValueOnce({
      error: { message: "Authentication failed — the bank declined the verification." },
      paymentIntent: undefined,
    });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Approve & pay $1.50" }));
    expect(await screen.findByText(/Authentication failed/)).toBeInTheDocument();
    expect(handleCardActionMock).toHaveBeenCalledWith("pi_test_1_secret_abc");
    expect(approveCalls).toBe(1);
  });
});
