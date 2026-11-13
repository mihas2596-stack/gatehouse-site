// B3 (extension audit): the owner "Cancel visit" button used native
// window.confirm, which blocks the tab in the user's real Chrome —
// the extension reproduced the hang 2/2 and had to abandon the tab.
// Cancel now asks in an in-page AlertDialog: the fee ($0 or $25) is
// shown before confirming, the tab never blocks, and Back runs nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import Owner from "@/pages/Owner";

const tomorrowStr = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

const baseVisit = {
  client_name: "Fay Confirmed", client_email: "fay@example.com", client_phone: "+17705550136",
  service: "Standard", window: "morning", address: "3 Test Street",
  status: "confirmed", report_status: "", cleaner_name: "Test Cleaner",
  cleaner_profile: { phone: "+17705550199", photo: null },
  issue_open: false, issue_ever: false, report_bounced: false, is_test: false,
  visit_confirmed: true, entry_agreed: false, entry_method: null, entry_detail: null,
  entry_notes: null, checklist: { rooms: [] },
  cleaner_link_issued: true, cleaner_link_active: true, cleaner_link_reusable: true,
  cleaner_link_expires: "2099-01-01T00:00:00Z",
};

const farVisit = { ...baseVisit, id: "visit-far", booking_id: "booking-far", amount_cents: 150, visit_date: "2027-01-20" };
// Tomorrow 07:00 ET is always 7–31h away, so inside the 48h fee window.
const nearVisit = { ...baseVisit, id: "visit-near", booking_id: "booking-near", amount_cents: 129, visit_date: tomorrowStr };

const visits = [farVisit, nearVisit];

let actionCalls: Record<string, unknown>[];
let confirmSpy: ReturnType<typeof vi.spyOn>;

function setup(visitList: typeof visits) {
  sessionStorage.clear(); localStorage.clear();
  window.history.replaceState({}, "", "/owner");
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  confirmSpy = vi.spyOn(window, "confirm");
  actionCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url), "https://example.com");
    if (u.pathname === "/api/owner-auth") return { ok: true, json: async () => ({ ok: true, session: "test-owner-session" }) };
    if (u.pathname === "/api/booking-action" && init?.method === "POST") {
      actionCalls.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
      return { ok: true, json: async () => ({ ok: true, email_sent: true, fee_cents: 0 }) };
    }
    if (u.pathname === "/api/owner") {
      const body = u.searchParams.get("view") === "list" ? { ok: true, visits: visitList }
        : u.searchParams.get("view") === "roster" ? { ok: true, cleaners: [] }
        : { ok: true, visit: visitList.find((v) => v.id === u.searchParams.get("visit_id")), photos: [], events: [] };
      return { ok: true, json: async () => body };
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  sessionStorage.setItem("gh_owner_session", "test-owner-session");
  render(<HelmetProvider><Owner /></HelmetProvider>);
}

async function openDetail(name: RegExp) {
  fireEvent.click(await screen.findByRole("button", { name: /All visits/ }));
  fireEvent.click(screen.getByRole("button", { name }));
  await screen.findByRole("heading", { name });
}

beforeEach(() => { /* per-test setup() */ });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("owner cancel visit dialog", () => {
  it("opens an in-page dialog showing no fee, and confirming cancels the visit", async () => {
    setup([farVisit]);
    await openDetail(/Fay Confirmed/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel visit" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Cancel visit" })).toBeInTheDocument();
    expect(within(dialog).getByText(/No fee — the visit is more than 48 hours away/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel visit" }));
    expect(await screen.findByText(/Visit cancelled\. No fee\./)).toBeInTheDocument();
    expect(await screen.findByText("Tell the cleaner")).toBeInTheDocument();
    // The panel also refreshes status on open; the cancel itself must
    // fire exactly once with this booking.
    expect(actionCalls.filter((c) => c["action"] === "owner_cancel")).toEqual([{ action: "owner_cancel", booking_id: "booking-far" }]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("Back in the dialog runs nothing and never touches window.confirm", async () => {
    setup([farVisit]);
    await openDetail(/Fay Confirmed/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel visit" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(actionCalls.some((c) => c["action"] === "owner_cancel")).toBe(false);
    expect(screen.queryByText(/Visit cancelled/)).not.toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("shows the $25 late fee inside 48 hours before confirming", async () => {
    setup([nearVisit]);
    await openDetail(/Fay Confirmed/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel visit" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/\$25 late-cancellation fee/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel visit" }));
    expect(await screen.findByText(/Visit cancelled/)).toBeInTheDocument();
    expect(actionCalls.filter((c) => c["action"] === "owner_cancel")).toEqual([{ action: "owner_cancel", booking_id: "booking-near" }]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
