import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import Owner from "@/pages/Owner";

// C8 (audit 09.11.2026): entry data was never saved for test-era
// bookings, so entry_agreed=false is the default for all 41 rows —
// including paid ones. The "do not send the cleaner" warning must
// only fire for a confirmed, upcoming, real visit: never for a test
// booking, a visit that already happened (report sent), or a date in
// the past.
const WARNING = /do not send the cleaner to an unsettled entry/;

type Variant = {
  visit_date: string;
  is_test: boolean;
  report_status: string;
  entry_agreed: boolean;
};

const baseVisit = (over: Partial<Variant> & { client_name: string }) => ({
  id: "visit-0",
  booking_id: "booking-0",
  client_name: over.client_name,
  client_email: "client@example.com",
  service: "Standard",
  visit_date: over.visit_date,
  window: "morning",
  address: "1 Test Street",
  amount_cents: 150,
  status: "confirmed",
  report_status: over.report_status,
  cleaner_name: "Test Cleaner",
  issue_open: false,
  issue_ever: false,
  report_bounced: false,
  is_test: over.is_test,
  visit_confirmed: true,
  entry_agreed: over.entry_agreed,
  checklist: { rooms: [] },
  cleaner_link_issued: true,
  cleaner_link_active: true,
  cleaner_link_reusable: true,
  cleaner_link_expires: "2099-01-01T00:00:00Z",
});

let visit: ReturnType<typeof baseVisit>;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState({}, "", "/owner");
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  sessionStorage.setItem("gh_owner_session", "test-owner-session");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(String(url), "https://example.com");
    let body: unknown = { ok: true, state: "card_ready" };
    if (u.pathname === "/api/owner-auth") body = { ok: true, session: "test-owner-session" };
    if (u.pathname === "/api/owner") {
      body = u.searchParams.get("view") === "list" ? { ok: true, visits: [visit] }
        : u.searchParams.get("view") === "roster" ? { ok: true, cleaners: [] }
        : { ok: true, visit, photos: [], events: [] };
    }
    return { ok: true, json: async () => body };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const openDetail = async (opts: { showTest?: boolean } = {}) => {
  render(<HelmetProvider><Owner /></HelmetProvider>);
  // Test bookings are hidden by default — reveal them first when the
  // variant under test is one.
  if (opts.showTest) fireEvent.click(await screen.findByLabelText("Hide test bookings"));
  fireEvent.click(await screen.findByRole("button", { name: "All visits (1)" }));
  fireEvent.click(screen.getByRole("button", { name: /Casey/ }));
  expect(await screen.findByRole("heading", { name: "Casey Test" })).toBeInTheDocument();
};

describe("C8: the entry warning fires only for a confirmed upcoming real visit", () => {
  it("warns for a confirmed upcoming visit with no entry agreed", async () => {
    visit = baseVisit({ client_name: "Casey Test", visit_date: "2027-01-15", is_test: false, report_status: "", entry_agreed: false });
    await openDetail();
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it("stays silent for a confirmed visit whose date already passed", async () => {
    visit = baseVisit({ client_name: "Casey Test", visit_date: "2026-01-15", is_test: false, report_status: "", entry_agreed: false });
    await openDetail();
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it("stays silent for a test booking even when upcoming", async () => {
    visit = baseVisit({ client_name: "Casey Test", visit_date: "2027-01-15", is_test: true, report_status: "", entry_agreed: false });
    await openDetail({ showTest: true });
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it("stays silent once the report is sent — the visit already happened", async () => {
    visit = baseVisit({ client_name: "Casey Test", visit_date: "2027-01-15", is_test: false, report_status: "sent", entry_agreed: false });
    await openDetail();
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it("stays silent when entry is agreed", async () => {
    visit = baseVisit({ client_name: "Casey Test", visit_date: "2027-01-15", is_test: false, report_status: "", entry_agreed: true });
    await openDetail();
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });
});
