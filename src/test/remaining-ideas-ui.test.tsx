// Remaining audit ideas (6, 9, 10, 11, 12, 13, 14, 16, 17): UI-level
// checks for the client and cleaner cabinets.
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import Visit from "@/pages/Visit";
import Report from "@/pages/Report";
import Cleaner from "@/pages/Cleaner";
import Owner from "@/pages/Owner";

vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/lib/imageConvert", () => ({ convertToJpeg: async () => new Blob(["fixture"], { type: "image/jpeg" }) }));

// ---- /visit + /report fixtures ----
let visitState: string;
let visitCleaner: { name: string; photo: string; phone?: string } | null;
let visitEntryAvailable: boolean;
let reportFixture: Record<string, unknown>;
let visitPosts: Record<string, unknown>[];

const baseVisit = () => ({
  ok: true,
  state: visitState,
  has_card: true,
  card_confirmed: true,
  card_brand: "visa",
  card_last4: "4242",
  booking: { service: "Standard", confirmed_date: "2026-11-15", window: "morning", first: "$1.50" },
  confirm_by: "tomorrow",
  entry_available: visitEntryAvailable,
  cleaner: visitCleaner,
});

const baseReportFixture = (): Record<string, unknown> => ({
  ok: true,
  state: "awaiting",
  amount: "$1.50",
  publication_id: "pub-1",
  deadline: "2026-11-16T10:00:00.000Z",
  photo_items: [
    { url: "https://img.example/k.jpg", room: "Kitchen", kind: "after" },
    { url: "https://img.example/b.jpg", room: "Bathrooms", kind: "after" },
  ],
  checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wiped", done: true }] }] },
  booking: { service: "Standard", date: "2026-11-15", first: "$1.50" },
});

// ---- /cleaner fixtures ----
type PhotoFixture = { id: string; room: string; kind: string; url: string; note: null; created_at: string };
const photo = (id: string, room: string, kind: string): PhotoFixture =>
  ({ id, room, kind, url: "/fixture.jpg", note: null, created_at: "2026-11-03" });
type RoomFixture = { name: string; items: { label: string; done: boolean }[]; skip_reason?: string };
const makeCleanerView = (overrides: {
  report_status?: string; report_held?: boolean; rooms?: RoomFixture[]; photos?: PhotoFixture[];
} = {}) => ({
  ok: true, confirmed: true, editable: true,
  report_status: overrides.report_status ?? "draft",
  report_held: overrides.report_held ?? false,
  owner_note: null,
  visit: { service: "Standard", date: "2026-11-10", window: "morning", address: "1 Test Street", client_first_name: "Casey", no_photo_zones: null },
  checklist: { rooms: overrides.rooms ?? [{ name: "Kitchen", items: [{ label: "Counters wiped", done: false }] }] },
  photos: overrides.photos ?? [],
});
let cleanerFixture: ReturnType<typeof makeCleanerView>;
let cleanerPosts: Record<string, unknown>[];
let fetchCalls: string[];

beforeEach(() => {
  visitState = "confirmed";
  visitCleaner = null;
  visitEntryAvailable = false;
  reportFixture = baseReportFixture();
  visitPosts = [];
  cleanerFixture = makeCleanerView();
  cleanerPosts = [];
  fetchCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push(String(url));
    if (String(url).startsWith("/api/visit?")) return { ok: true, json: async () => baseVisit() };
    if (String(url) === "/api/visit" && init?.method === "POST") {
      visitPosts.push(JSON.parse(String(init.body))); return { ok: true, json: async () => baseVisit() };
    }
    if (String(url).startsWith("/api/report?")) return { ok: true, json: async () => reportFixture };
    if (String(url) === "/api/report" && init?.method === "POST") {
      visitPosts.push(JSON.parse(String(init.body))); return { ok: true, json: async () => reportFixture };
    }
    if (String(url).startsWith("/api/cleaner?") && !init?.method) return { ok: true, json: async () => cleanerFixture };
    if (String(url) === "/api/cleaner" && init?.method === "POST") {
      cleanerPosts.push(JSON.parse(String(init?.body ?? "{}")));
      return { ok: true, json: async () => ({ ok: true, upload_url: "https://upload.example.com/fixture", storage_path: "visits/test/kitchen/fixture.jpg" }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const openVisit = () => render(<MemoryRouter initialEntries={["/visit?bt=test-booking"]}><Visit /></MemoryRouter>);
const openReport = () => render(<MemoryRouter initialEntries={["/report?bt=test-booking"]}><Report /></MemoryRouter>);
const openCleaner = () => render(<StrictMode><HelmetProvider><MemoryRouter initialEntries={["/cleaner?ct=test-cleaner-token"]}><Cleaner /></MemoryRouter></HelmetProvider></StrictMode>);

describe("remaining ideas: /visit", () => {
  it("idea 10: the pinned price is labelled 'This visit', not 'First visit'", async () => {
    visitState = "confirmed";
    visitEntryAvailable = true;
    openVisit();
    await screen.findByText("Your cleaning is confirmed");
    expect(screen.getByText("This visit")).toBeInTheDocument();
    expect(screen.queryByText("First visit")).not.toBeInTheDocument();
  });

  it("idea 16: a paid visit marks every journey step done, none current", async () => {
    visitState = "paid";
    reportFixture = { ...baseReportFixture(), state: "paid" };
    openVisit();
    const strip = await screen.findByRole("list", { name: "Your booking journey" });
    const steps = strip.querySelectorAll("span");
    expect(steps.length).toBeGreaterThan(0);
    for (const s of Array.from(steps)) {
      expect(s.className).not.toContain("underline");
    }
    expect(screen.getByText("Review & payment")).toBeInTheDocument();
  });

  it("idea 9: a confirmed visit with no cleaner yet shows the entry stub", async () => {
    visitState = "confirmed";
    visitCleaner = null;
    visitEntryAvailable = false;
    openVisit();
    await screen.findByText("Your cleaning is confirmed");
    expect(screen.getByText(/You'll arrange entry here once your cleaner is assigned/)).toBeInTheDocument();
    expect(screen.queryByText("How would you like to arrange entry?")).not.toBeInTheDocument();
  });

  it("idea 11: the cleaner's photo is shown when available", async () => {
    visitState = "confirmed";
    visitCleaner = { name: "Ana Torres", photo: "https://img.example/ana.jpg", phone: "7705550100" };
    const { container } = openVisit();
    await screen.findByText("Ana Torres");
    const img = container.querySelector('img[src="https://img.example/ana.jpg"]');
    expect(img).not.toBeNull();
  });

  it("idea 11: no photo falls back to the generic icon (no img)", async () => {
    visitState = "confirmed";
    visitCleaner = { name: "Ana Torres", photo: "", phone: "7705550100" };
    const { container } = openVisit();
    await screen.findByText("Ana Torres");
    expect(container.querySelector('img[src=""]')).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("remaining ideas: /report", () => {
  it("idea 17: the summary names the cleaner who did the visit", async () => {
    reportFixture = { ...baseReportFixture(), cleaner_name: "Ana Torres" };
    openReport();
    await screen.findByText("Cleaned by");
    expect(screen.getByText("Ana Torres")).toBeInTheDocument();
  });

  it("idea 17: no cleaner name, no 'Cleaned by' row", async () => {
    reportFixture = { ...baseReportFixture(), cleaner_name: null };
    openReport();
    await screen.findByText("This visit");
    expect(screen.queryByText("Cleaned by")).not.toBeInTheDocument();
  });
});

describe("remaining ideas: /cleaner", () => {
  it("idea 14: a permanent office contact line is in 'Before you go'", async () => {
    openCleaner();
    expect(await screen.findByText(/Need help\?/)).toBeInTheDocument();
    // The line is permanent: it is there even when the conditional
    // "Entry not arranged yet" banner also shows the number.
    expect(screen.getAllByText("(770) 525-8599").length).toBeGreaterThanOrEqual(1);
  });

  it("idea 13: Finish is disabled until every room is ready", async () => {
    cleanerFixture = makeCleanerView();
    openCleaner();
    const finish = await screen.findByRole("button", { name: "Finish & send report" });
    expect(finish).toBeDisabled();
  });

  it("idea 13: Finish is enabled once every room has before + after photos", async () => {
    cleanerFixture = makeCleanerView({
      photos: [photo("b1", "Kitchen", "before"), photo("a1", "Kitchen", "after")],
    });
    openCleaner();
    const finish = await screen.findByRole("button", { name: "Finish & send report" });
    await waitFor(() => expect(finish).toBeEnabled());
  });

  it("idea 6: a held report tells the cleaner it waits for owner review", async () => {
    cleanerFixture = makeCleanerView({ report_status: "submitted", report_held: true });
    openCleaner();
    expect(await screen.findByText(/waiting for the owner to review the client's issue/)).toBeInTheDocument();
    expect(screen.queryByText("Report received — the owner will share it with the client.")).not.toBeInTheDocument();
  });

  it("idea 6: a normal submission keeps the usual 'Report received' copy", async () => {
    cleanerFixture = makeCleanerView({ report_status: "submitted", report_held: false });
    openCleaner();
    expect(await screen.findByText("Report received — the owner will share it with the client.")).toBeInTheDocument();
  });

  it("idea 12: returning to the tab refetches, and the page shows when it was updated", async () => {
    cleanerFixture = makeCleanerView();
    openCleaner();
    await screen.findByText("Your cleaning job");
    await waitFor(() => expect(fetchCalls.filter((u) => u.startsWith("/api/cleaner?")).length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText(/Updated .* Atlanta time/)).toBeInTheDocument();
    const before = fetchCalls.filter((u) => u.startsWith("/api/cleaner?")).length;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetchCalls.filter((u) => u.startsWith("/api/cleaner?")).length).toBe(before + 1));
  });
});

describe("remaining ideas: /owner", () => {
  const confirmedVisit = {
    id: "visit-conf", booking_id: "booking-conf", client_name: "Fay Confirmed",
    client_email: "fay@example.com", client_phone: "+17705550136", service: "Standard",
    visit_date: "2027-01-20", window: "morning", address: "3 Test Street", amount_cents: 150,
    status: "confirmed", report_status: "", cleaner_name: "Test Cleaner",
    cleaner_profile: { phone: "+17705550199", photo: null },
    issue_open: false, issue_ever: false, report_bounced: false, is_test: false,
    visit_confirmed: true, entry_agreed: false, entry_method: null, entry_detail: null,
    entry_notes: null, checklist: { rooms: [] },
    cleaner_link_issued: true, cleaner_link_active: true, cleaner_link_reusable: true,
    cleaner_link_expires: "2099-01-01T00:00:00Z",
  };

  it("idea 15: after an owner cancel, the owner is prompted to tell the cleaner", async () => {
    sessionStorage.clear(); localStorage.clear();
    window.history.replaceState({}, "", "/owner");
    window.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    window.confirm = vi.fn(() => true);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url), "https://example.com");
      if (u.pathname === "/api/owner-auth") return { ok: true, json: async () => ({ ok: true, session: "test-owner-session" }) };
      if (u.pathname === "/api/booking-action" && init?.method === "POST") {
        return { ok: true, json: async () => ({ ok: true, email_sent: true }) };
      }
      if (u.pathname === "/api/owner") {
        const body = u.searchParams.get("view") === "list" ? { ok: true, visits: [confirmedVisit] }
          : u.searchParams.get("view") === "roster" ? { ok: true, cleaners: [] }
            : { ok: true, visit: confirmedVisit, photos: [], events: [] };
        return { ok: true, json: async () => body };
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    sessionStorage.setItem("gh_owner_session", "test-owner-session");
    render(<HelmetProvider><Owner /></HelmetProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /All visits/ }));
    fireEvent.click(screen.getByRole("button", { name: /Fay Confirmed/ }));
    await screen.findByRole("heading", { name: "Fay Confirmed" });
    fireEvent.click(screen.getByText("Cancel visit"));
    expect(await screen.findByText("Tell the cleaner")).toBeInTheDocument();
    expect(screen.getByText(/has been cancelled — no need to travel/)).toBeInTheDocument();
    // Scope to the prompt: the Cleaner section below has its own
    // WhatsApp/SMS buttons for the job link.
    const prompt = screen.getByText("Tell the cleaner").parentElement!;
    expect(within(prompt).getByRole("button", { name: "WhatsApp" })).toBeInTheDocument();
    expect(within(prompt).getByRole("button", { name: "SMS" })).toBeInTheDocument();
  });
});
