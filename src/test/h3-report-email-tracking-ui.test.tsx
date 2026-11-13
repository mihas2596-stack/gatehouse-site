// H3 (owner panel): the report email went out but saving its
// delivery record failed — a recoverable state, not a failure. The
// panel must say the email was sent and a retry only completes the
// record (no second email), never "Publish & notify customer:
// report_email_tracking_failed".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import Owner from "@/pages/Owner";

const visit = {
  id: "visit-h3", booking_id: "booking-h3", client_name: "Casey Client",
  client_email: "client@example.com", service: "Standard", visit_date: "2027-01-15",
  window: "morning", address: "1 Test Street", amount_cents: 14900,
  status: "confirmed", report_status: "submitted", cleaner_name: "Test Cleaner",
  issue_open: false, issue_ever: false, report_bounced: false, is_test: false,
  visit_confirmed: true, entry_agreed: true, checklist: { rooms: [] },
  cleaner_link_issued: true, cleaner_link_active: true, cleaner_link_reusable: true,
  cleaner_link_expires: "2099-01-01T00:00:00Z",
  photo_count: 4,
};

let sendReportResponse: Record<string, unknown>;

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  sessionStorage.setItem("gh_owner_session", "test-owner-session");
  window.history.replaceState({}, "", "/owner");
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  sendReportResponse = { ok: false, email_sent: true, error: "report_email_tracking_failed" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url), "https://example.com");
    let body: unknown = { ok: true, state: "card_ready" };
    if (u.pathname === "/api/owner-auth") body = { ok: true, session: "test-owner-session" };
    if (u.pathname === "/api/owner") {
      body = u.searchParams.get("view") === "list" ? { ok: true, visits: [visit] }
        : u.searchParams.get("view") === "roster" ? { ok: true, cleaners: [] }
          : { ok: true, visit, photos: [], events: [] };
    }
    if (u.pathname === "/api/booking-action") {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      body = parsed["action"] === "send_report" ? sendReportResponse : { ok: true };
    }
    return { ok: true, json: async () => body };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const open = () => render(<HelmetProvider><Owner /></HelmetProvider>);

describe("H3: send_report tracking failure is shown as recoverable, not failed", () => {
  it("says the email was sent and a retry only completes the record", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "All visits (1)" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Casey Client/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Publish & notify customer" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/the email was sent, but saving its delivery record failed/i);
    });
    expect(screen.getByRole("status")).toHaveTextContent(/no second email will go out/i);
    expect(screen.getByRole("status")).not.toHaveTextContent(/report_email_tracking_failed/);
  });

  it("a plain failure without email_sent still shows the error", async () => {
    sendReportResponse = { ok: false, error: "report_email_failed" };
    open();
    fireEvent.click(await screen.findByRole("button", { name: "All visits (1)" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Casey Client/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Publish & notify customer" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/report_email_failed/);
    });
  });
});
