// Group 1(c) — live run-through on 6f346a37: the cleaner-link field in
// /owner visually truncated the long token, and copying the truncated
// value made /cleaner answer "This link doesn't work". The field now
// shows the full URL wrapped, and a Copy button copies the complete
// token — never the visible text.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import Owner from "@/pages/Owner";

const LONG_URL = `https://www.gatehousehomecleaning.com/cleaner?ct=${"a".repeat(120)}`;
const DANIELLE = { id: "roster-danielle", name: "Danielle Littles", phone: "7705550100", photo: "", active: true };
const ownerVisit = {
  id: "visit-maxhigh", booking_id: "booking-maxhigh",
  client_name: "Test MaxHigh", client_email: "test@example.com", client_phone: "+17705550100",
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

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("group 1(c): cleaner link is shown whole and copied whole", () => {
  it("shows the full URL wrapped and the Copy button copies the complete token", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url), "https://example.com");
      if (u.pathname === "/api/owner-auth") return { ok: true, json: async () => ({ ok: true, session: "test-owner-session" }) };
      if (u.pathname === "/api/booking-action" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        if (body["action"] === "get_cleaner_link") return { ok: true, json: async () => ({ ok: true, url: LONG_URL }) };
        if (body["action"] === "status") return { ok: true, json: async () => ({ ok: true, state: "no_card", no_stripe_customer: true }) };
        return { ok: true, json: async () => ({ ok: true, email_sent: true }) };
      }
      if (u.pathname === "/api/owner") {
        const view = u.searchParams.get("view");
        if (view === "list") { await delay(10); return { ok: true, json: async () => ({ ok: true, visits: [ownerVisit] }) }; }
        if (view === "roster") return { ok: true, json: async () => ({ ok: true, cleaners: [DANIELLE] }) };
        await delay(300);
        return { ok: true, json: async () => ({ ok: true, visit: ownerVisit, photos: [], events: [] }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    sessionStorage.setItem("gh_owner_session", "test-owner-session");
    window.history.replaceState({}, "", "/owner");
    window.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    render(<HelmetProvider><Owner /></HelmetProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /All visits/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Test MaxHigh/ }));
    await screen.findByRole("heading", { name: "Test MaxHigh" });
    fireEvent.click(screen.getByRole("button", { name: "View link & message" }));
    // The whole token is on the page (wrapped), not in a truncating input.
    expect(await screen.findByText(LONG_URL)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Cleaner link \(select and copy/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByText("Link copied.")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(LONG_URL);
    cleanup();
  });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
