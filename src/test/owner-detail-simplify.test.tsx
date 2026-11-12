import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import Owner from "@/pages/Owner";

// Fixtures for the simplified owner detail: one visit per state.
// Requested: no cleaner, entry set but not agreed, cancellable.
// Report-sent: cleaner assigned, report sent, cancel must be hidden.
// Confirmed: cleaner assigned, entry unset, warning belongs in the summary.
const requested = {
  id: "visit-req", booking_id: "booking-req", client_name: "Dana Requested",
  client_email: "dana@example.com", client_phone: "+17705550134", service: "Standard",
  visit_date: "2027-01-15", window: "morning", address: "1 Test Street", amount_cents: 150,
  status: "requested", report_status: "", cleaner_name: null,
  issue_open: false, issue_ever: false, report_bounced: false, is_test: false,
  visit_confirmed: false, entry_agreed: false, entry_method: "arrange_before",
  entry_detail: "lockbox", entry_notes: "Gate code 1234; park in the driveway",
  checklist: { rooms: [] },
  cleaner_link_issued: false, cleaner_link_active: false, cleaner_link_reusable: false,
};
const sent = {
  id: "visit-sent", booking_id: "booking-sent", client_name: "Evan Sent",
  client_email: "evan@example.com", client_phone: "+17705550135", service: "Standard",
  visit_date: "2027-01-10", window: "morning", address: "2 Test Street", amount_cents: 150,
  status: "report_sent", report_status: "sent", report_sent_at: "2026-11-10T12:00:00Z",
  cleaner_name: "Test Cleaner",
  issue_open: false, issue_ever: false, report_bounced: false, is_test: false,
  visit_confirmed: true, entry_agreed: true, checklist: { rooms: [] },
  cleaner_link_issued: true, cleaner_link_active: true, cleaner_link_reusable: true,
  cleaner_link_expires: "2099-01-01T00:00:00Z",
};
const confirmed = {
  id: "visit-conf", booking_id: "booking-conf", client_name: "Fay Confirmed",
  client_email: "fay@example.com", client_phone: "+17705550136", service: "Standard",
  visit_date: "2027-01-20", window: "morning", address: "3 Test Street", amount_cents: 150,
  status: "confirmed", report_status: "", cleaner_name: "Test Cleaner",
  issue_open: false, issue_ever: false, report_bounced: false, is_test: false,
  visit_confirmed: true, entry_agreed: false, entry_method: null, entry_detail: null,
  entry_notes: null, checklist: { rooms: [] },
  cleaner_link_issued: true, cleaner_link_active: true, cleaner_link_reusable: true,
  cleaner_link_expires: "2099-01-01T00:00:00Z",
};
const visits = [requested, sent, confirmed];

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  window.history.replaceState({}, "", "/owner");
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(String(url), "https://example.com");
    let body: unknown = { ok: true, state: "card_ready" };
    if (u.pathname === "/api/owner-auth") body = { ok: true, session: "test-owner-session" };
    if (u.pathname === "/api/owner") {
      body = u.searchParams.get("view") === "list" ? { ok: true, visits }
        : u.searchParams.get("view") === "roster" ? { ok: true, cleaners: [] }
          : { ok: true, visit: visits.find((v) => v.id === u.searchParams.get("visit_id")), photos: [], events: [] };
    }
    return { ok: true, json: async () => body };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const openVisit = async (name: string) => {
  sessionStorage.setItem("gh_owner_session", "test-owner-session");
  render(<HelmetProvider><Owner /></HelmetProvider>);
  fireEvent.click(await screen.findByRole("button", { name: /All visits/ }));
  fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
  await screen.findByRole("heading", { name });
};

// The control must live inside the card-level "More actions" disclosure
// (the Payment section has its own "More actions" below it).
const expectInCardMoreActions = (el: HTMLElement) => {
  const details = el.closest("details");
  expect(details).not.toBeNull();
  expect(details!.querySelector("summary")?.textContent).toBe("More actions");
};

describe("owner detail simplification", () => {
  it("leads with Approve request and tucks Copy / Cancel / Delete / issue into More actions (requested)", async () => {
    await openVisit("Dana Requested");
    // Approve is the primary action and is not inside a disclosure.
    const approve = screen.getByRole("button", { name: "Approve request" });
    expect(approve.closest("details")).toBeNull();
    // The rarely-used controls live in the card-level More actions.
    expectInCardMoreActions(screen.getByText("Copy client link (visit + payment)"));
    expectInCardMoreActions(screen.getByText("Cancel visit"));
    expectInCardMoreActions(screen.getByText("Delete visit"));
    expectInCardMoreActions(screen.getByLabelText("Issue reported by email"));
    // The client-link caption is gone.
    expect(screen.queryByText(/Never send this to the cleaner/)).not.toBeInTheDocument();
  });

  it("hides the Cleaner section and carries entry info in the summary (requested)", async () => {
    await openVisit("Dana Requested");
    expect(document.getElementById("block-cleaner")).toBeNull();
    expect(screen.queryByText("Go to Schedule")).not.toBeInTheDocument();
    expect(document.getElementById("block-entry")).toBeNull();
    const summary = document.getElementById("block-summary")!;
    expect(within(summary).getByText(/Arrange entry before the visit \(Lockbox\)/)).toBeInTheDocument();
    expect(within(summary).getByText(/Parking\/building notes: Gate code 1234; park in the driveway/)).toBeInTheDocument();
  });

  it("shows the phone as compact inline links (requested)", async () => {
    await openVisit("Dana Requested");
    expect(screen.queryByRole("link", { name: "Call client" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Text client" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy number" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "(770) 555-0134" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Call" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Text" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    // The mailto link and "Update client phone" stay.
    expect(screen.getByRole("link", { name: "dana@example.com" })).toBeInTheDocument();
    expect(screen.getByText("Update client phone")).toBeInTheDocument();
  });

  it("hides Cancel when the server would refuse it (report already sent)", async () => {
    await openVisit("Evan Sent");
    expect(screen.queryByText("Cancel visit")).not.toBeInTheDocument();
    // Delete and Copy are still there, inside More actions.
    expectInCardMoreActions(screen.getByText("Delete visit"));
    expectInCardMoreActions(screen.getByText("Copy client link (visit + payment)"));
    // The Cleaner section is present for an assigned visit.
    expect(document.getElementById("block-cleaner")).not.toBeNull();
    expect(document.getElementById("block-entry")).toBeNull();
  });

  it("shows Cancel and the entry warning in the summary for a confirmed visit", async () => {
    await openVisit("Fay Confirmed");
    expectInCardMoreActions(screen.getByText("Cancel visit"));
    expect(document.getElementById("block-entry")).toBeNull();
    const summary = document.getElementById("block-summary")!;
    expect(within(summary).getByText(/do not send the cleaner to an unsettled entry/)).toBeInTheDocument();
    expect(within(summary).getByText(/Entry: Not arranged yet/)).toBeInTheDocument();
    expect(document.getElementById("block-cleaner")).not.toBeNull();
  });
});
