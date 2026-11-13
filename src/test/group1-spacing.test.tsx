// Group 1(b) — live run-through on 6f346a37 reported glued strings on
// many pages ("2bed,1full bath", "Visit confirmed:yes",
// "Nov 25, 20267–11 AM ET", "Rooms ready:0of6", "Standard· forTest
// MaxHigh", "This visit is onWednesday…", "Your booking entry
// choice:I'll be home.."). The joined lines are now composed as single
// strings so no space can be lost between JSX nodes, the step-3
// "Home" line pluralises ("1 full bathroom", "2 bedrooms"), and the
// entry-choice line no longer doubles the period from the label.
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import Cleaner from "@/pages/Cleaner";
import Owner from "@/pages/Owner";
import Visit from "@/pages/Visit";
import Quote from "@/pages/Quote";

vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/imageConvert", () => ({ convertToJpeg: async () => new Blob(["fixture"], { type: "image/jpeg" }) }));
vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T00:00:00Z"));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Cleaner fixture: the Test MaxHigh visit (25.11, morning, Standard) ---
const SIX_ROOMS = ["Kitchen", "Bathroom", "Bedroom 1", "Bedroom 2", "Half bathroom", "Living room"];
const cleanerView = {
  ok: true, confirmed: true, editable: true, report_status: "draft", owner_note: null,
  visit: {
    service: "Standard", date: "2026-11-25", window: "morning", address: "1 Test Street",
    client_first_name: "Test MaxHigh", client_name: "Test MaxHigh", no_photo_zones: null,
    entry: { method: "home", note: "", secret: null },
  },
  checklist: { rooms: SIX_ROOMS.map((name) => ({ name, items: [{ label: "Done task", done: false }] })) },
  photos: [],
};

describe("group 1(b): cleaner page joins", () => {
  it("shows date + window, service + client, future-visit note and rooms-ready with spaces", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/cleaner?")) return { ok: true, json: async () => cleanerView };
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { container } = render(
      <StrictMode><HelmetProvider><MemoryRouter initialEntries={["/cleaner?ct=test-cleaner-token"]}><Cleaner /></MemoryRouter></HelmetProvider></StrictMode>,
    );
    expect(await screen.findByText("Wednesday, November 25 · 7–11 AM ET")).toBeInTheDocument();
    expect(screen.getByText("Standard · for Test MaxHigh")).toBeInTheDocument();
    expect(screen.getByText("This visit is on Wednesday, November 25 — you can send the report after the visit.")).toBeInTheDocument();
    // "Entry:" lives in a <span>, so match the <p> by its full text.
    expect(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "Entry: Client will be home to let you in.")).toBeInTheDocument();
    expect(screen.getAllByText("Rooms ready: 0 of 6")).toHaveLength(2);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/November 25·7/);
    expect(text).not.toMatch(/Standard·/);
    expect(text).not.toMatch(/onWednesday/);
    expect(text).not.toMatch(/Rooms ready:0of6/);
  });
});

// --- Owner fixture: the same confirmed visit, entry "home" ---
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
  cleaner_link_issued: false, cleaner_link_active: false, cleaner_link_reusable: false,
  cleaner_link_expires: null,
  amount_cents: 149, visit_date: "2026-11-25",
};

describe("group 1(b): owner page joins", () => {
  it("shows date + window + price and the readiness lines with spaces", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url), "https://example.com");
      if (u.pathname === "/api/owner-auth") return { ok: true, json: async () => ({ ok: true, session: "test-owner-session" }) };
      if (u.pathname === "/api/booking-action" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
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
    // List row: date, window and price in one spaced line.
    expect(await screen.findByText("Nov 25, 2026 7–11 AM ET · $1.49")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Test MaxHigh/ }));
    await screen.findByRole("heading", { name: "Test MaxHigh" });
    expect(screen.getByText("Visit confirmed: yes")).toBeInTheDocument();
    expect(screen.getByText("Entry: Client will be home to let the cleaner in")).toBeInTheDocument();
    expect(screen.queryByText(/Visit confirmed:yes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Entry:Client/)).not.toBeInTheDocument();
    expect(screen.queryByText(/20267–11/)).not.toBeInTheDocument();
  });
});

// --- Visit fixture: confirmed, entry available, entry choice "home" ---
const visitRooms = ["Kitchen", "Bathroom", "Bedroom 1", "Bedroom 2", "Half bathroom", "Living room"];

describe("group 1(b): visit page joins + rooms", () => {
  it("shows the rooms and the entry choice with one period, not two", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/visit?")) {
        return {
          ok: true,
          json: async () => ({
            ok: true, state: "confirmed", has_card: true, card_confirmed: true,
            card_brand: "visa", card_last4: "9321",
            booking: { service: "Standard", confirmed_date: "2026-11-25", window: "morning", first: "$1.49" },
            rooms: visitRooms, entry_available: true,
            entry_choice: { method: "home", detail: null, notes: null },
            confirm_by: "",
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<MemoryRouter initialEntries={["/visit?bt=test-booking"]}><Visit /></MemoryRouter>);
    expect(await screen.findByText("Rooms we'll clean")).toBeInTheDocument();
    expect(screen.getByText("Kitchen, Bathroom, Bedroom 1, Bedroom 2, Half bathroom, Living room")).toBeInTheDocument();
    expect(screen.getByText("Your booking entry choice: I’ll be home. You can change it below.")).toBeInTheDocument();
    expect(screen.queryByText(/home\.\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/choice:I’ll/)).not.toBeInTheDocument();
  });
});

// --- Quote: step-2 summary and step-3 review lines ---
const fillStep2 = () => {
  for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["City *", "Sugar Hill"], ["State *", "GA"], ["Preferred date *", "2099-12-01"]]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole("radio", { name: /I’ll be home/ }));
  fireEvent.click(screen.getByLabelText(/I agree to photos of the cleaned rooms/));
};

describe("group 1(b): quote summary lines", () => {
  it("step 2 and step 3 join bedrooms/bathrooms with spaces and pluralise", () => {
    render(<MemoryRouter><Quote /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Full bathrooms"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Half bathrooms"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByText("2 beds, 1 full bath, 1 half bath · ZIP 30024")).toBeInTheDocument();
    fillStep2();
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByText("2 bedrooms · 1 full bathroom · 1 half bathroom")).toBeInTheDocument();
    expect(screen.queryByText(/1 full bathrooms/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2bed/)).not.toBeInTheDocument();
  });

  it("singular home line reads '1 bedroom · 1 full bathroom'", () => {
    render(<MemoryRouter><Quote /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Full bathrooms"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByText("1 bed, 1 full bath · ZIP 30024")).toBeInTheDocument();
    fillStep2();
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByText("1 bedroom · 1 full bathroom")).toBeInTheDocument();
  });
});
