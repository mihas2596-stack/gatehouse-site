// TASK 1 (fix6): the owner panel's open-issues block and decision
// buttons — Request payment / Arrange re-clean / Waive charge /
// Send reminder — with a payment confirmation before Request payment.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import Owner from "@/pages/Owner";

const visits = [
  {
    id: "visit-issue", booking_id: "booking-issue", client_name: "Casey Client",
    client_email: "client@example.com", service: "Standard", visit_date: "2027-01-15",
    window: "morning", address: "1 Test Street", amount_cents: 14900,
    status: "report_sent", report_status: "sent", cleaner_name: "Test Cleaner",
    issue_open: true, issue_ever: true, report_bounced: false, is_test: false,
    visit_confirmed: true, entry_agreed: true, checklist: { rooms: [] },
    cleaner_link_issued: true, cleaner_link_active: true, cleaner_link_reusable: true,
    cleaner_link_expires: "2099-01-01T00:00:00Z",
    photo_count: 4,
    issue_opened_at: "2026-11-08T11:00:00.000Z",
    issue_reason: "Streaks on the floor",
    issue_room: "Kitchen",
    issue_decision: { decision: "payment_requested", resolution: "The original amount stays due.", decided_at: "2026-11-09T10:00:00.000Z" },
  },
  {
    id: "visit-ok", booking_id: "booking-ok", client_name: "Dana Fine",
    client_email: "dana@example.com", service: "Standard", visit_date: "2027-01-16",
    window: "morning", address: "2 Test Street", amount_cents: 18900,
    status: "confirmed", report_status: "", cleaner_name: "Test Cleaner",
    issue_open: false, issue_ever: false, report_bounced: false, is_test: false,
    visit_confirmed: true, entry_agreed: true, checklist: { rooms: [] },
    cleaner_link_issued: true, cleaner_link_active: true, cleaner_link_reusable: true,
    cleaner_link_expires: "2099-01-01T00:00:00Z",
  },
];

const detailEvents = [
  { id: 1, actor: "client", event: "issue_opened", detail: { reason: "Streaks on the floor", room: "Kitchen" }, created_at: "2026-11-08T11:00:00.000Z" },
  { id: 2, actor: "owner", event: "issue_decision", detail: { decision: "payment_requested", resolution: "The original amount stays due.", decided_at: "2026-11-09T10:00:00.000Z" }, created_at: "2026-11-09T10:00:00.000Z" },
];

let actionCalls: Record<string, unknown>[];

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  sessionStorage.setItem("gh_owner_session", "test-owner-session");
  window.history.replaceState({}, "", "/owner");
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  actionCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url), "https://example.com");
    let body: unknown = { ok: true, state: "card_ready" };
    if (u.pathname === "/api/owner-auth") body = { ok: true, session: "test-owner-session" };
    if (u.pathname === "/api/owner") {
      body = u.searchParams.get("view") === "list" ? { ok: true, visits }
        : u.searchParams.get("view") === "roster" ? { ok: true, cleaners: [] }
          : { ok: true, visit: visits.find((v) => v.id === u.searchParams.get("visit_id")), photos: [], events: detailEvents };
    }
    if (u.pathname === "/api/booking-action") {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      actionCalls.push(parsed);
      body = { ok: true, ...(parsed["action"] === "issue_request_payment" ? { decision: "payment_requested", email_sent: true } : {}) };
    }
    return { ok: true, json: async () => body };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const open = () => render(<HelmetProvider><Owner /></HelmetProvider>);

describe("owner open issues", () => {
  it("lists open issues with amount, reason, elapsed time and decision", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "All visits (2)" }));
    expect(await screen.findByRole("heading", { name: "Open issues (1)" })).toBeInTheDocument();
    expect(screen.getByText(/Streaks on the floor/)).toBeInTheDocument();
    expect(screen.getByText(/Payment requested/)).toBeInTheDocument();
    expect(screen.getByText(/4 photos/)).toBeInTheDocument();
    // The clean visit is not in the issues block (it is still in the
    // visits list below it).
    const issuesSection = screen.getByRole("region", { name: "Open issues" });
    expect(within(issuesSection).queryByText("Dana Fine")).not.toBeInTheDocument();
  });

  it("detail shows the three decisions, the latest decision, and a reminder", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "All visits (2)" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Casey Client/ })[0]);
    expect(await screen.findByText("Your decision for the client *")).toBeInTheDocument();
    expect(screen.getByText(/Latest decision:/)).toBeInTheDocument();
    // The resolution text is shown in the issues block, in the detail
    // panel's "Latest decision" line, and in the events timeline.
    expect(screen.getAllByText(/The original amount stays due\./).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: "Request payment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Arrange re-clean" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Waive charge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reminder" })).toBeInTheDocument();
    // The old single "Resolve issue" button is gone.
    expect(screen.queryByRole("button", { name: "Resolve issue" })).not.toBeInTheDocument();
  });

  it("request payment needs a decision text and a confirmation, and never charges directly", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    open();
    fireEvent.click(await screen.findByRole("button", { name: "All visits (2)" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Casey Client/ })[0]);
    const requestBtn = await screen.findByRole("button", { name: "Request payment" });
    expect(requestBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Your decision for the client *"), { target: { value: "The original amount stays due." } });
    expect(requestBtn).not.toBeDisabled();
    fireEvent.click(requestBtn);
    // B3: the native window.confirm is gone — an in-page dialog asks
    // instead, and the action runs only after its confirm button.
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Ask the client to approve and pay/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Request payment" }));
    expect(await screen.findByText("Request payment: done.")).toBeInTheDocument();
    const call = actionCalls.find((c) => c["action"] === "issue_request_payment");
    expect(call).toMatchObject({ booking_id: "booking-issue", resolution: "The original amount stays due." });
    expect(actionCalls.some((c) => c["action"] === "charge")).toBe(false);
  });

  it("dismissing the request-payment dialog runs nothing", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "All visits (2)" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Casey Client/ })[0]);
    fireEvent.change(await screen.findByLabelText("Your decision for the client *"), { target: { value: "The original amount stays due." } });
    fireEvent.click(screen.getByRole("button", { name: "Request payment" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(actionCalls.some((c) => c["action"] === "issue_request_payment")).toBe(false);
  });
});
