// O-025 (25.11.2026): the cleaner link is bearer and revocable in the
// API (revoke_cleaner_link), but the owner panel had no Revoke button —
// only Copy. A "Revoke link" button now sits next to "Copy cleaner
// link": it asks in the in-page AlertDialog (never window.confirm),
// calls revoke_cleaner_link once, and Back runs nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import Owner from "@/pages/Owner";

const ownerVisit = {
  id: "visit-revoke", booking_id: "booking-revoke",
  client_name: "Rita Revoke", client_email: "rita@example.com", client_phone: "+17705550100",
  service: "Standard", window: "morning", address: "123 Test Street",
  status: "confirmed", report_status: "", cleaner_name: "Danielle Littles", cleaner_id: "roster-danielle",
  cleaner_profile: { phone: "7705550100", photo: "" },
  issue_open: false, issue_ever: false, report_bounced: false, is_test: false,
  visit_confirmed: true, request_approved: true,
  entry_agreed: false, entry_method: "home", entry_detail: null, entry_notes: null,
  checklist: { rooms: [] },
  cleaner_link_issued: true, cleaner_link_active: true, cleaner_link_reusable: true,
  cleaner_link_expires: "2099-01-01T00:00:00Z",
  amount_cents: 149, visit_date: "2026-11-25",
};

let actionCalls: Record<string, unknown>[];
let confirmSpy: ReturnType<typeof vi.spyOn>;

function setup() {
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
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      actionCalls.push(body);
      if (body["action"] === "revoke_cleaner_link") return { ok: true, json: async () => ({ ok: true, revoked: true }) };
      if (body["action"] === "status") return { ok: true, json: async () => ({ ok: true, state: "no_card", no_stripe_customer: true }) };
      return { ok: true, json: async () => ({ ok: true, email_sent: true }) };
    }
    if (u.pathname === "/api/owner") {
      const body = u.searchParams.get("view") === "list" ? { ok: true, visits: [ownerVisit] }
        : u.searchParams.get("view") === "roster" ? { ok: true, cleaners: [] }
        : { ok: true, visit: ownerVisit, photos: [], events: [] };
      return { ok: true, json: async () => body };
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  sessionStorage.setItem("gh_owner_session", "test-owner-session");
  render(<HelmetProvider><Owner /></HelmetProvider>);
}

async function openDetail() {
  fireEvent.click(await screen.findByRole("button", { name: /All visits/ }));
  fireEvent.click(screen.getByRole("button", { name: /Rita Revoke/ }));
  await screen.findByRole("heading", { name: "Rita Revoke" });
}

beforeEach(() => { /* per-test setup() */ });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("O-025: owner revokes the cleaner link", () => {
  it("asks in an in-page dialog, and confirming calls revoke_cleaner_link once", async () => {
    setup();
    await openDetail();
    fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Revoke cleaner link" })).toBeInTheDocument();
    expect(within(dialog).getByText(/disables the cleaner's access link at once/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke link" }));
    expect(await screen.findByText("Revoke cleaner link: done.")).toBeInTheDocument();
    expect(actionCalls.filter((c) => c["action"] === "revoke_cleaner_link"))
      .toEqual([{ action: "revoke_cleaner_link", booking_id: "booking-revoke" }]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("Back in the dialog runs nothing and never touches window.confirm", async () => {
    setup();
    await openDetail();
    fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(actionCalls.filter((c) => c["action"] === "revoke_cleaner_link")).toEqual([]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
