import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import Owner from "@/pages/Owner";

const visits = ["Casey Alpha", "Casey Beta"].map((name, i) => ({
  id: `visit-${i}`, booking_id: `booking-${i}`, client_name: name,
  client_email: "client@example.com", service: "Standard", visit_date: "2027-01-15",
  window: "morning", address: "1 Test Street", amount_cents: 150,
  status: "report_sent", report_status: "sent", cleaner_name: "Test Cleaner",
  issue_open: false, issue_ever: false, report_bounced: false, is_test: false,
  visit_confirmed: true, entry_agreed: true, checklist: { rooms: [] },
}));

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
const open = () => render(<HelmetProvider><Owner /></HelmetProvider>);

describe("owner login and visit switching", () => {
  it("opens the visit list after an emailed login without a reload or hook-order crash", async () => {
    window.history.replaceState({}, "", "/owner?ol=test-login-link");
    open();
    expect(await screen.findByRole("heading", { name: "Visits" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(sessionStorage.getItem("gh_owner_session")).toBe("test-owner-session");
    fireEvent.click(await screen.findByRole("button", { name: "All visits (2)" }));
    expect(await screen.findByRole("button", { name: /Casey Alpha/ })).toBeInTheDocument();
  });

  it("does not carry an unsent complaint reason into another customer's visit", async () => {
    sessionStorage.setItem("gh_owner_session", "test-owner-session");
    open();
    fireEvent.click(await screen.findByRole("button", { name: "All visits (2)" }));
    fireEvent.click(await screen.findByRole("button", { name: /Casey Alpha/ }));
    fireEvent.change(await screen.findByLabelText("Issue reported by email"), { target: { value: "Alpha's complaint" } });
    fireEvent.click(screen.getByRole("button", { name: "← Back to visits" }));
    fireEvent.click(screen.getByRole("button", { name: /Casey Beta/ }));
    expect(await screen.findByLabelText("Issue reported by email")).toHaveValue("");
  });

  it("ignores an old visit response after the owner has selected another customer", async () => {
    sessionStorage.setItem("gh_owner_session", "test-owner-session");
    const fetcher = vi.mocked(fetch);
    const normal = fetcher.getMockImplementation()!;
    let resolveAlpha!: (response: Response) => void;
    fetcher.mockImplementation((url, init) => String(url).includes("visit_id=visit-0")
      ? new Promise<Response>((resolve) => { resolveAlpha = resolve; })
      : normal(url, init));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "All visits (2)" }));
    fireEvent.click(screen.getByRole("button", { name: /Casey Alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: /Casey Beta/ }));
    expect(await screen.findByRole("heading", { name: "Casey Beta" })).toBeInTheDocument();
    await act(async () => resolveAlpha({ ok: true, json: async () => ({ ok: true, visit: visits[0], photos: [], events: [] }) } as Response));
    expect(screen.getByRole("heading", { name: "Casey Beta" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Casey Alpha" })).not.toBeInTheDocument();
  });
});
