// Top-5 fixes (ideas 1, 2, 3): /visit renders the waived state, the
// owner's issue decision (with the re-clean date), and the shared issue
// form (photo + real rooms + expired-window errors).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Visit from "@/pages/Visit";

vi.mock("@/components/SEO", () => ({ default: () => null }));

let visitState: string;
let reportState: string;
let issueDecision: Record<string, unknown> | null;
let resolution: Record<string, unknown> | null;
let reportError: string | null;
let posts: Record<string, unknown>[];

const baseVisit = () => ({
  ok: true,
  state: visitState,
  has_card: true,
  card_confirmed: true,
  card_brand: "visa",
  card_last4: "4242",
  booking: { service: "Standard", confirmed_date: "2026-11-15", window: "morning", first: "$1.50" },
  confirm_by: "tomorrow",
  entry_available: false,
});

const baseReport = () => ({
  ok: true,
  state: reportState,
  amount: "$1.50",
  publication_id: "pub-1",
  deadline: "2026-11-16T10:00:00.000Z",
  photo_items: [
    { url: "https://img.example/k.jpg", room: "Kitchen", kind: "after" },
    { url: "https://img.example/b.jpg", room: "Bathrooms", kind: "after" },
  ],
  checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wiped", done: true }] }] },
  issue_reason: "Streaks on the floor",
  issue_source: "client",
  issue_room: "Kitchen",
  issue_decision: issueDecision,
  resolution,
});

beforeEach(() => {
  visitState = "report_sent";
  reportState = "awaiting";
  issueDecision = null;
  resolution = null;
  reportError = null;
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/report?")) {
      return { ok: true, json: async () => baseReport() };
    }
    if (url === "/api/report" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (reportError) {
        return { ok: false, status: 409, json: async () => ({ ok: true, error: reportError }) };
      }
      return { ok: true, json: async () => ({ ...baseReport(), state: "issue_open" }) };
    }
    if (!String(url).startsWith("/api/visit?")) throw new Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => baseVisit() };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = () => render(<MemoryRouter initialEntries={["/visit?bt=test-booking"]}><Visit /></MemoryRouter>);

describe("waived on /visit (idea 1)", () => {
  it("shows 'No charge for this visit' and hides the card line", async () => {
    visitState = "waived";
    reportState = "waived";
    issueDecision = { decision: "waived", resolution: "We've waived the charge for this visit — nothing will be charged.", decided_at: "2026-11-09T10:00:00.000Z" };
    open();
    expect(await screen.findByRole("heading", { name: "No charge for this visit" })).toBeInTheDocument();
    expect(await screen.findByText(/closed this visit without charging your card/)).toBeInTheDocument();
    expect(screen.getByText(/Our response:/)).toBeInTheDocument();
    expect(screen.queryByText(/Card we'll charge/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Change card" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pay/ })).not.toBeInTheDocument();
  });
});

describe("owner's issue decision on /visit (idea 2)", () => {
  it("payment requested: decision text and Approve & Pay", async () => {
    visitState = "issue_open";
    reportState = "issue_open";
    issueDecision = { decision: "payment_requested", resolution: "The original amount stays due.", decided_at: "2026-11-09T10:00:00.000Z" };
    open();
    expect(await screen.findByText(/We've reviewed your concern\. Please review our response and approve the report when you're ready to pay\./)).toBeInTheDocument();
    expect(screen.getByText(/Our response:/)).toBeInTheDocument();
    expect(screen.getByText(/“The original amount stays due.”/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve & Pay $1.50" })).toBeInTheDocument();
  });

  it("re-clean arranged: decision text, re-clean date, Resolve issue & pay", async () => {
    visitState = "issue_open";
    reportState = "issue_open";
    issueDecision = { decision: "reclean", resolution: "We'll come back to re-clean the kitchen.", decided_at: "2026-11-09T10:00:00.000Z" };
    resolution = { resolved_at: "2026-11-09T10:00:00.000Z", reclean_date: "2026-11-18" };
    open();
    expect(await screen.findByText(/We'll send you an updated report after the re-clean\./)).toBeInTheDocument();
    expect(screen.getByText(/Re-clean agreed for/)).toBeInTheDocument();
    expect(screen.getByText("Nov 18, 2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve issue & pay $1.50" })).toBeInTheDocument();
  });

  it("no decision yet: the plain 'Issue reported' banner, no decision copy", async () => {
    visitState = "issue_open";
    reportState = "issue_open";
    open();
    expect(await screen.findByText(/Issue reported — automatic payment is blocked for this visit\./)).toBeInTheDocument();
    expect(screen.queryByText(/We've reviewed your concern/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve & Pay/ })).not.toBeInTheDocument();
  });
});

describe("shared issue form on /visit (idea 3)", () => {
  it("offers a photo upload and a room dropdown from the report's real rooms", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Report an issue" }));
    expect(await screen.findByLabelText("Which room?")).toBeInTheDocument();
    const select = screen.getByLabelText("Which room?") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toEqual(["Choose a room…", "Kitchen", "Bathrooms", "Other / not listed"]);
    // No hardcoded room names that don't match the report.
    expect(options).not.toContain("Bathroom");
    expect(options).not.toContain("Bedroom");
    expect(options).not.toContain("Living areas");
    expect(screen.getByLabelText(/Add a photo/)).toBeInTheDocument();
    expect(screen.getByText(/Photos up to 1 MB each/)).toBeInTheDocument();
  });

  it("an oversized photo is dropped with a note, the message still goes through", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Report an issue" }));
    const input = await screen.findByLabelText(/Add a photo/) as HTMLInputElement;
    const big = new File(["x".repeat(1_000_001)], "big.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText(/That photo is large, so we'll send your message without it\./)).toBeInTheDocument();
  });

  it("an expired issue window shows the email message, not a generic error", async () => {
    reportError = "issue_window_expired";
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Report an issue" }));
    fireEvent.change(await screen.findByLabelText("What isn't right?"), { target: { value: "The floor is still dirty." } });
    fireEvent.click(screen.getByRole("button", { name: "Send issue — block auto-charge" }));
    await waitFor(() => expect(screen.getByText(/The 24-hour window for reporting an issue on this report has passed/)).toBeInTheDocument());
    expect(screen.getByText(/email us at hello@gatehousehomecleaning.com/)).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0]["action"]).toBe("issue");
  });
});
