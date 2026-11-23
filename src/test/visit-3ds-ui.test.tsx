import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import Visit from "@/pages/Visit";

vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/lib/imageConvert", () => ({ convertToJpeg: async () => new Blob(["fixture"], { type: "image/jpeg" }) }));

// DA-03: 3DS on /visit, mirroring src/test/report-3ds-ui.test.tsx.
// The saved card needs cardholder authentication. The server answers
// approve with 402 payment_requires_action + client_secret +
// publishable_key; the page must complete the challenge with Stripe.js
// (handleCardAction) and then re-approve once — the same intent, no
// second charge. Before the fix /visit had no Stripe.js at all, so
// Approve dead-ended on a generic error.
const { handleCardActionMock, confirmCardPaymentMock, loadStripeMock } = vi.hoisted(() => ({
  confirmCardPaymentMock: vi.fn(async () => ({})),
  handleCardActionMock: vi.fn(async (_secret: string) => ({
    error: undefined,
    paymentIntent: { id: "pi_test_1", status: "succeeded" },
  })),
  loadStripeMock: vi.fn(async (_key: string) => ({
    confirmCardPayment: (...args: unknown[]) =>
      (confirmCardPaymentMock as (...a: unknown[]) => unknown)(...args),
    handleCardAction: (...args: unknown[]) =>
      (handleCardActionMock as (...a: unknown[]) => unknown)(...args),
  })),
}));
vi.mock("@stripe/stripe-js", () => ({ loadStripe: loadStripeMock }));

const VISIT = {
  ok: true,
  state: "report_sent",
  has_card: true,
  card_confirmed: true,
  card_brand: "visa",
  card_last4: "4242",
  booking: { service: "Standard", confirmed_date: "2026-11-10", window: "morning", first: "$1.50" },
  confirm_by: "tomorrow",
  entry_available: false,
};

const REPORT = {
  ok: true,
  state: "awaiting",
  amount: "$1.50",
  publication_id: "pub-1",
  deadline: "2026-11-16T10:00:00.000Z",
  photo_items: [{ url: "https://img.example/k.jpg", room: "Kitchen", kind: "after" }],
  checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wiped", done: true }] }] },
  issue_reason: null,
  issue_source: null,
  issue_room: null,
  issue_decision: null,
  resolution: null,
};

let approveCalls: number;
let publishableKey: string;
let methodId: string | undefined;

beforeEach(() => {
  approveCalls = 0;
  methodId = undefined;
  confirmCardPaymentMock.mockClear();
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
            confirmation_method_id: methodId,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...REPORT, state: "paid" }),
      };
    }
    if (String(url).startsWith("/api/visit?")) {
      return { ok: true, json: async () => VISIT };
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = () => render(<HelmetProvider><MemoryRouter initialEntries={["/visit?bt=test-booking"]}><Visit /></MemoryRouter></HelmetProvider>);

describe("DA-03: 3DS on /visit — Approve with a card that needs authentication", () => {
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

  it("authenticates a declined off-session card on the original intent", async () => {
    methodId = "pm_saved";
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Approve & pay $1.50" }));
    expect(await screen.findByText(/Paid — thank you/)).toBeInTheDocument();
    expect(confirmCardPaymentMock).toHaveBeenCalledWith("pi_test_1_secret_abc", { payment_method: "pm_saved" });
    expect(handleCardActionMock).not.toHaveBeenCalled();
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
