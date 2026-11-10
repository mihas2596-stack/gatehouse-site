// TASK 1 (fix6): the client report page renders the owner's decision
// states from the spec — reviewing, payment requested, re-clean, waived.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Report from "@/pages/Report";

vi.mock("@/components/SEO", () => ({ default: () => null }));

let current: Record<string, unknown>;

const base = (): Record<string, unknown> => ({
  ok: true,
  state: "issue_open",
  amount: "$149",
  amount_cents: 14900,
  publication_id: "pub-1",
  report_sent_at: "2026-11-08T10:00:00.000Z",
  deadline: "2026-11-09T10:00:00.000Z",
  charge_timer_blocked: true,
  charge_timer_block_reason: "issue_open",
  issue_reason: "Streaks on the floor",
  issue_source: "client",
  issue_room: "Kitchen",
  issue_decision: null,
  photo_items: [{ url: "https://img.example/k.jpg", room: "Kitchen", kind: "after" }],
  checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wiped", done: true }] }] },
});

beforeEach(() => {
  current = base();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).startsWith("/api/report?")) {
      return { ok: true, json: async () => current };
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = () => render(<MemoryRouter initialEntries={["/report?bt=test-booking"]}><Report /></MemoryRouter>);

describe("report page issue states", () => {
  it("no decision yet: reviewing copy, spec text, Add more details", async () => {
    open();
    expect(await screen.findByRole("heading", { name: "We're reviewing your concern" })).toBeInTheDocument();
    expect(screen.getByText(/Your payment is paused\. We'll review what happened and reply within one business day\. We aim to provide a decision within 72 hours\./)).toBeInTheDocument();
    expect(screen.getByText(/Nothing will be charged unless you approve the report\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add more details" })).toBeInTheDocument();
    // The existing resolve-and-pay path stays available.
    expect(screen.getByRole("button", { name: "Resolve issue & pay $149" })).toBeInTheDocument();
    expect(screen.getByText(/You told us/)).toBeInTheDocument();
    expect(screen.getByText(/“Streaks on the floor”/)).toBeInTheDocument();
  });

  it("payment requested: update copy, the owner's response, Approve & Pay", async () => {
    current = {
      ...base(),
      issue_decision: { decision: "payment_requested", resolution: "The original amount stays due.", decided_at: "2026-11-09T10:00:00.000Z" },
    };
    open();
    expect(await screen.findByRole("heading", { name: "An update on your cleaning" })).toBeInTheDocument();
    expect(screen.getByText(/We've reviewed your concern\. Please review our response and approve the report when you're ready to pay\./)).toBeInTheDocument();
    expect(screen.getByText(/Our response:/)).toBeInTheDocument();
    expect(screen.getByText(/“The original amount stays due.”/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve & Pay $149" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "My issue isn't resolved" })).toBeInTheDocument();
  });

  it("re-clean arranged: re-clean copy, no payment-request wording", async () => {
    current = {
      ...base(),
      issue_decision: { decision: "reclean", resolution: "We'll come back Tuesday to re-clean the kitchen.", decided_at: "2026-11-09T10:00:00.000Z" },
    };
    open();
    expect(await screen.findByRole("heading", { name: "We're arranging your re-clean" })).toBeInTheDocument();
    expect(screen.getByText(/We'll send you an updated report after the re-clean\./)).toBeInTheDocument();
    expect(screen.getByText(/Our response:/)).toBeInTheDocument();
    expect(screen.getByText(/“We'll come back Tuesday to re-clean the kitchen.”/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve & Pay $149" })).not.toBeInTheDocument();
  });

  it("waived: no charge, no Approve button", async () => {
    current = {
      ...base(),
      state: "waived",
      issue_decision: { decision: "waived", resolution: "We've waived the charge for this visit — nothing will be charged.", decided_at: "2026-11-09T10:00:00.000Z" },
    };
    open();
    expect(await screen.findByRole("heading", { name: "No charge for this visit" })).toBeInTheDocument();
    expect(screen.getByText(/closed this visit without charging your card/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pay/ })).not.toBeInTheDocument();
  });
});
