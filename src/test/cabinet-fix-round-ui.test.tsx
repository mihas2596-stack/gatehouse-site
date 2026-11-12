// Cabinet fix round (12.11.2026): UI tests for the run-through defects
// and the payment-date gate.
// A3: owner refetches on tab return (visibilitychange, no polling).
// A4: cleaner header shows the full client name, not just the first word.
// A5: cleaner photo on /visit and /report — photo when stored, generic
//     User icon when the roster has none (Danielle Littles has none).
// B:  future visit -> plain message, Approve/Finish hidden or disabled.
// C:  minimal header (no nav, no "See My Price") on /visit and /report.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import Cleaner from "@/pages/Cleaner";
import Visit from "@/pages/Visit";
import Report from "@/pages/Report";
import Owner from "@/pages/Owner";
import Header from "@/components/Header";

vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/lib/imageConvert", () => ({ convertToJpeg: async () => new Blob(["fixture"], { type: "image/jpeg" }) }));

// "Today" in Atlanta time; future/past dates stay stable whenever the
// suite runs.
function atlantaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const TODAY = atlantaToday();
const FUTURE = shiftDate(TODAY, 30);
const PAST = shiftDate(TODAY, -30);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ---------- A4 + B: cleaner cabinet ----------

function cleanerFixture(overrides: Record<string, unknown> = {}) {
  const { visit: visitOverrides, ...rest } = overrides;
  return {
    ok: true, confirmed: true, editable: true, report_status: "draft", owner_note: null,
    visit: {
      service: "Standard", date: PAST, window: "morning", address: "1 Test Street",
      client_name: "прогон топ-5 12 ноября", client_first_name: "прогон",
      no_photo_zones: null, ...(visitOverrides as Record<string, unknown> ?? {}),
    },
    checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Counters wiped", done: false }] }] },
    photos: [],
    ...rest,
  };
}
let cleanerData: ReturnType<typeof cleanerFixture>;
const openCleaner = () => render(
  <HelmetProvider><MemoryRouter initialEntries={["/cleaner?ct=test-cleaner-token"]}><Cleaner /></MemoryRouter></HelmetProvider>,
);

describe("cleaner cabinet: full client name and future-visit gate", () => {
  beforeEach(() => {
    cleanerData = cleanerFixture();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/cleaner?") && !init?.method) {
        return { ok: true, json: async () => cleanerData };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }));
  });

  it("A4: the header shows the full client name, not just the first word", async () => {
    openCleaner();
    await screen.findByText(/Standard · for прогон топ-5 12 ноября/);
    expect(screen.queryByText("Standard · for прогон")).not.toBeInTheDocument();
  });

  it("A4: without a full name it falls back to the first name", async () => {
    cleanerData = cleanerFixture({ visit: { client_name: null } });
    openCleaner();
    await screen.findByText(/Standard · for прогон/);
  });

  it("B: a future visit shows the message and keeps Finish disabled", async () => {
    cleanerData = cleanerFixture({ visit: { date: FUTURE } });
    openCleaner();
    await screen.findByText(/This visit is on .* — you can send the report after the visit\./);
    const finish = await screen.findByRole("button", { name: /Finish & send report/ });
    expect(finish).toBeDisabled();
  });

  it("B: on the visit date Finish is not blocked by the date gate", async () => {
    cleanerData = cleanerFixture({ visit: { date: TODAY } });
    openCleaner();
    await screen.findByText(/Your cleaning job/);
    expect(screen.queryByText(/you can send the report after the visit/)).not.toBeInTheDocument();
    // Finish is still disabled by the photo rule (no photos yet), not
    // by the date gate — the date message is what must be absent.
    const finish = await screen.findByRole("button", { name: /Finish & send report/ });
    expect(finish).toBeDisabled();
  });
});

// ---------- A5 + B: client /visit ----------

let visitData: Record<string, unknown>;
let visitReport: Record<string, unknown>;
const openVisit = () => render(
  <MemoryRouter initialEntries={["/visit?bt=test-booking"]}><Visit /></MemoryRouter>,
);

describe("client /visit: cleaner photo and future-visit gate", () => {
  beforeEach(() => {
    visitData = {
      ok: true, state: "report_sent", has_card: true, card_confirmed: true,
      card_brand: "visa", card_last4: "4242",
      cleaner: { name: "Danielle Littles", photo: "", phone: null },
      booking: { service: "Standard", confirmed_date: PAST, window: "morning", first: "$1.50" },
      confirm_by: "tomorrow", entry_available: false,
    };
    visitReport = {
      ok: true, state: "awaiting", amount: "$1.50", publication_id: "pub-1",
      deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      photo_items: [{ url: "https://img.example/k.jpg", room: "Kitchen", kind: "after" }],
      checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wiped", done: true }] }] },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/report?")) return { ok: true, json: async () => visitReport };
      if (String(url).startsWith("/api/report") && init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
      if (String(url).startsWith("/api/visit?")) return { ok: true, json: async () => visitData };
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  it("A5: no stored photo -> the generic User icon renders next to the name", async () => {
    openVisit();
    await screen.findByText("Danielle Littles");
    const cleanedBy = screen.getByText("Cleaned by").closest("div");
    expect(cleanedBy).not.toBeNull();
    // The fallback is a rounded-full span holding a User svg (lucide
    // renders an <svg>); no <img> may appear for the cleaner.
    expect(cleanedBy!.querySelector("svg")).not.toBeNull();
    expect(cleanedBy!.querySelector("img")).toBeNull();
  });

  it("A5: a stored photo renders as an image next to the name", async () => {
    (visitData.cleaner as Record<string, unknown>).photo = "https://img.example/danielle.jpg";
    openVisit();
    await screen.findByText("Danielle Littles");
    const cleanedBy = screen.getByText("Cleaned by").closest("div");
    const img = cleanedBy!.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://img.example/danielle.jpg");
  });

  it("B: a future visit shows the message and hides Approve", async () => {
    (visitData.booking as Record<string, unknown>).confirmed_date = FUTURE;
    openVisit();
    await screen.findByText(/This visit is on .* — you can approve the report after the visit\./);
    expect(screen.queryByRole("button", { name: /Approve & pay/ })).not.toBeInTheDocument();
    // Reporting an issue stays available.
    expect(screen.getByRole("button", { name: "Report an issue" })).toBeInTheDocument();
  });

  it("B: on the visit date Approve is shown", async () => {
    (visitData.booking as Record<string, unknown>).confirmed_date = TODAY;
    openVisit();
    await screen.findByRole("button", { name: /Approve & pay \$1\.50/ });
    expect(screen.queryByText(/you can approve the report after the visit/)).not.toBeInTheDocument();
  });
});

// ---------- A5 + B: client /report ----------

let reportData: Record<string, unknown>;
const openReport = () => render(
  <MemoryRouter initialEntries={["/report?bt=test-booking"]}><Report /></MemoryRouter>,
);

describe("client /report: cleaner photo and future-visit gate", () => {
  beforeEach(() => {
    reportData = {
      ok: true, state: "awaiting", amount: "$1.50", amount_cents: 150,
      publication_id: "pub-1",
      report_sent_at: new Date(Date.now() - 3600 * 1000).toISOString(),
      deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      cleaner_name: "Danielle Littles", cleaner_photo: "",
      booking: { service: "Standard", date: PAST },
      photo_items: [{ url: "https://img.example/k.jpg", room: "Kitchen", kind: "after" }],
      checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wiped", done: true }] }] },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/report?")) return { ok: true, json: async () => reportData };
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  it("A5: no stored photo -> the generic User icon renders next to the name", async () => {
    openReport();
    await screen.findByText("Danielle Littles");
    const cleanedBy = screen.getByText("Cleaned by").closest("div");
    expect(cleanedBy).not.toBeNull();
    expect(cleanedBy!.querySelector("svg")).not.toBeNull();
    expect(cleanedBy!.querySelector("img")).toBeNull();
  });

  it("A5: a stored photo renders as an image next to the name", async () => {
    reportData.cleaner_photo = "https://img.example/danielle.jpg";
    openReport();
    await screen.findByText("Danielle Littles");
    const cleanedBy = screen.getByText("Cleaned by").closest("div");
    const img = cleanedBy!.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://img.example/danielle.jpg");
  });

  it("B: a future visit shows the message and hides Approve", async () => {
    (reportData.booking as Record<string, unknown>).date = FUTURE;
    openReport();
    await screen.findByText(/This visit is on .* — you can approve the report after the visit\./);
    expect(screen.queryByRole("button", { name: /Approve & pay/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Report an issue" })).toBeInTheDocument();
  });

  it("B: on the visit date Approve is shown", async () => {
    (reportData.booking as Record<string, unknown>).date = TODAY;
    openReport();
    await screen.findByRole("button", { name: /Approve & pay \$1\.50/ });
    expect(screen.queryByText(/you can approve the report after the visit/)).not.toBeInTheDocument();
  });

  it("C: after payment the issue link is a small quiet link and there is no Back to Home", async () => {
    reportData.state = "paid";
    reportData.receipt_sent = true;
    openReport();
    await screen.findByText("Paid — thank you");
    const link = screen.getByRole("button", { name: /Something wasn't right\? Report an issue with this visit/ });
    expect(link.className).toContain("text-xs");
    expect(screen.queryByRole("link", { name: "Back to Home" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to Home" })).not.toBeInTheDocument();
  });
});

// ---------- C: minimal header on cabinet pages ----------

describe("cabinet header: minimal on /visit and /report", () => {
  const openHeader = (path: string) => render(
    <MemoryRouter initialEntries={[path]}><Header /></MemoryRouter>,
  );
  it("/visit has no nav and no See My Price", () => {
    openHeader("/visit?bt=test-booking");
    expect(screen.queryByRole("link", { name: "See My Price" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
  it("/report has no nav and no See My Price", () => {
    openHeader("/report?bt=test-booking");
    expect(screen.queryByRole("link", { name: "See My Price" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
  it("/cleaner stays minimal, /owner keeps the full header", () => {
    openHeader("/cleaner?ct=test-cleaner-token");
    expect(screen.queryByRole("link", { name: "See My Price" })).not.toBeInTheDocument();
    cleanup();
    openHeader("/owner");
    expect(screen.getByRole("link", { name: "See My Price" })).toBeInTheDocument();
  });
});

// ---------- A3: owner refetches on tab return ----------

describe("owner cabinet: auto-refresh on tab return", () => {
  const visits = [{
    id: "visit-1", booking_id: "booking-1", client_name: "Dana",
    client_email: "dana@example.com", client_phone: "+17705550134", service: "Standard",
    visit_date: PAST, window: "morning", address: "1 Test Street", amount_cents: 150,
    status: "confirmed", report_status: "", cleaner_name: "Test Cleaner",
    issue_open: false, issue_ever: false, report_bounced: false, is_test: false,
    visit_confirmed: true, entry_agreed: true, checklist: { rooms: [] },
    cleaner_link_issued: false, cleaner_link_active: false, cleaner_link_reusable: false,
  }];
  let listCalls: number;

  beforeEach(() => {
    sessionStorage.clear(); localStorage.clear();
    sessionStorage.setItem("gh_owner_session", "test-owner-session");
    listCalls = 0;
    window.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(String(url), "https://example.com");
      let body: unknown = { ok: true, state: "card_ready" };
      if (u.pathname === "/api/owner") {
        if (u.searchParams.get("view") === "list") { listCalls++; body = { ok: true, visits }; }
        else if (u.searchParams.get("view") === "roster") body = { ok: true, cleaners: [] };
        else body = { ok: true, visit: visits[0], photos: [], events: [] };
      }
      return { ok: true, json: async () => body };
    }));
  });

  it("returning to the tab re-reads the visit list (no manual Refresh needed)", async () => {
    render(<HelmetProvider><Owner /></HelmetProvider>);
    await screen.findByText("Dana");
    const callsAfterLoad = listCalls;
    expect(callsAfterLoad).toBeGreaterThanOrEqual(1);
    // Simulate the owner returning to the tab.
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(listCalls).toBeGreaterThan(callsAfterLoad));
  });
});
