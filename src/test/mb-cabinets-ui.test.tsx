// MB-04/05/16/27/29/30/31/32/33, LB-19/20/41, live-run #5/#6/#7/#8,
// K1-UI — cabinets UI + city pages, maximal audit + live run 2026-11-14.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Owner from "@/pages/Owner";
import Visit from "@/pages/Visit";
import Report from "@/pages/Report";
import Cleaner from "@/pages/Cleaner";
import CityPage from "@/pages/CityPage";
import Areas from "@/pages/Areas";
import Index from "@/pages/Index";
import { CITIES } from "@/config/cities";

vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/lib/imageConvert", () => ({ convertToJpeg: async () => new Blob(["jpeg-bytes"], { type: "image/jpeg" }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

const LONG_URL = `https://www.gatehousehomecleaning.com/cleaner?ct=${"a".repeat(120)}`;
const DANIELLE = { id: "roster-danielle", name: "Danielle Littles", phone: "7705550100", photo: "", active: true };

const ownerVisit = (over: Record<string, unknown> = {}) => ({
  id: "visit-1", booking_id: "booking-1",
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
  amount_cents: 149, visit_date: "2026-11-25", can_charge: true,
  ...over,
});
const smithVisit = () => ownerVisit({
  id: "visit-2", booking_id: "booking-2", client_name: "Smith Family",
  client_email: "smith@example.com", visit_date: "2026-11-20",
  cleaner_name: null, cleaner_id: null, cleaner_profile: null,
  cleaner_link_issued: false, cleaner_link_active: false, cleaner_link_reusable: false,
});

let listPages: { visits: unknown[]; next_offset: number | null }[];
let listFail: boolean;
let fetchLog: string[];
let statusReply: Record<string, unknown>;
let writeText: ReturnType<typeof vi.fn>;
let openSpy: ReturnType<typeof vi.fn>;

const installOwnerFetch = () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    fetchLog.push(String(url));
    const u = new URL(String(url), "https://example.com");
    if (u.pathname === "/api/owner-auth") return { ok: true, json: async () => ({ ok: true, session: "test-owner-session" }) };
    if (u.pathname === "/api/booking-action" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      if (body["action"] === "get_cleaner_link") return { ok: true, json: async () => ({ ok: true, url: LONG_URL }) };
      if (body["action"] === "status") return { ok: true, json: async () => statusReply };
      if (body["action"] === "charge") return { ok: true, json: async () => ({ ok: false, error: "payment_requires_action" }) };
      return { ok: true, json: async () => ({ ok: true, email_sent: true }) };
    }
    if (u.pathname === "/api/owner") {
      const view = u.searchParams.get("view");
      if (view === "list") {
        if (listFail) return { ok: true, json: async () => ({ ok: false, error: "db_error" }) };
        const offset = Number(u.searchParams.get("offset") ?? "0");
        const page = listPages[offset] ?? { visits: [], next_offset: null };
        return { ok: true, json: async () => ({ ok: true, visits: page.visits, next_offset: page.next_offset }) };
      }
      if (view === "roster") return { ok: true, json: async () => ({ ok: true, cleaners: [DANIELLE] }) };
      return { ok: true, json: async () => ({ ok: true, visit: ownerVisit(), photos: [], events: [] }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
};

const openOwner = () => {
  sessionStorage.setItem("gh_owner_session", "test-owner-session");
  window.history.replaceState({}, "", "/owner");
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  render(<HelmetProvider><Owner /></HelmetProvider>);
};

const openCard = async (name = /Test MaxHigh/) => {
  fireEvent.click(await screen.findByRole("button", { name: /All visits/ }));
  fireEvent.click(await screen.findByRole("button", { name }));
  await screen.findByRole("heading", { name: "Test MaxHigh" });
};

const listCalls = () => fetchLog.filter((u) => u.includes("/api/owner?view=list")).length;

describe("MB-04: owner polling while a visit card is open", () => {
  beforeEach(() => {
    listPages = [{ visits: [ownerVisit()], next_offset: null }];
    listFail = false;
    fetchLog = [];
    statusReply = { ok: true, state: "card_ready", no_stripe_customer: false, payment_method: "saved", card_brand: "mastercard", card_last4: "9321" };
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    openSpy = vi.fn();
    window.open = openSpy as unknown as typeof window.open;
    installOwnerFetch();
  });

  it("refetches the list and the open card every 45s without a tab switch", async () => {
    // The interval itself is 45s — too long to wait for, so capture
    // the callback the page registered and invoke it once.
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    openOwner();
    await openCard();
    const poll = setIntervalSpy.mock.calls.find((c) => c[1] === 45_000);
    expect(poll).toBeDefined();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const before = listCalls();
    const detailBefore = fetchLog.filter((u) => u.includes("view=detail")).length;
    (poll![0] as () => void)();
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    expect(fetchLog.filter((u) => u.includes("view=detail")).length).toBeGreaterThan(detailBefore);
  });

  it("MB-27: a search finds an older visit across filters, auto-loading pages", async () => {
    listPages = [
      { visits: [ownerVisit()], next_offset: 1 },
      { visits: [smithVisit()], next_offset: null },
    ];
    openOwner();
    // Default filter is "Needs attention" — Smith is a plain upcoming
    // visit, so it is invisible there until the search overrides it.
    fireEvent.change(await screen.findByLabelText("Search visits"), { target: { value: "Smith" } });
    expect(await screen.findByRole("button", { name: /Smith Family/ }, { timeout: 5000 })).toBeInTheDocument();
    expect(listCalls()).toBeGreaterThanOrEqual(2);
  });

  it("MB-27: an empty search says so plainly, naming the query", async () => {
    listPages = [
      { visits: [ownerVisit()], next_offset: 1 },
      { visits: [smithVisit()], next_offset: null },
    ];
    openOwner();
    fireEvent.change(await screen.findByLabelText("Search visits"), { target: { value: "Nobody" } });
    expect(await screen.findByText("No visits match “Nobody”.", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("MB-27/LB-19: a failed list reload keeps the loaded visits", async () => {
    openOwner();
    fireEvent.click(await screen.findByRole("button", { name: /All visits/ }));
    await screen.findByRole("button", { name: /Test MaxHigh/ });
    listFail = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Couldn't load visits.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Test MaxHigh/ })).toBeInTheDocument();
  });

  it("LB-20: a 3DS charge failure reads as plain language, never the raw code", async () => {
    openOwner();
    await openCard();
    // The Charge button lives in the Payment block's own "More
    // actions" details (the card has a second one above it).
    const chargeBtn = screen.getByRole("button", { name: "Charge $1.49" });
    chargeBtn.closest("details")!.setAttribute("open", "");
    fireEvent.click(chargeBtn);
    fireEvent.click(await screen.findByRole("button", { name: "Charge now" }));
    expect(await screen.findByText(/only the client can finish this on their report page/)).toBeInTheDocument();
    expect(screen.queryByText(/payment_requires_action/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Server errors are shown as-is/)).not.toBeInTheDocument();
  });

  it("live-run #5: Copy cleaner link only copies — no new tab, confirmation shown", async () => {
    openOwner();
    await openCard();
    fireEvent.click(screen.getByRole("button", { name: "Copy cleaner link (job + photos)" }));
    expect(await screen.findByText("Cleaner link copied.")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(LONG_URL);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("live-run #7: the card brand renders capitalised (Mastercard, not mastercard)", async () => {
    openOwner();
    await openCard();
    expect((await screen.findAllByText("Card: Mastercard •••• 9321")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/mastercard ••••/)).not.toBeInTheDocument();
  });

  it("LB-41: list badges are at least 12px (text-xs, not 10/11px)", async () => {
    try { localStorage.setItem("gh_hide_test", "0"); } catch { /* ignore */ }
    listPages = [{ visits: [ownerVisit({ is_test: true })], next_offset: null }];
    openOwner();
    fireEvent.click(await screen.findByRole("button", { name: /All visits/ }));
    const badge = await screen.findByText("TEST");
    expect(badge.className).toContain("text-xs");
    expect(badge.className).not.toContain("text-[10px]");
    expect(badge.className).not.toContain("text-[11px]");
  });

  it("empty state: 'No visits yet' offers a Create a visit button", async () => {
    listPages = [{ visits: [], next_offset: null }];
    openOwner();
    fireEvent.click(await screen.findByRole("button", { name: /All visits/ }));
    expect(await screen.findByText("No visits in the database yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a visit" })).toHaveAttribute("href", "/quote");
  });
});

// ---------------------------------------------------------------------------
// Cleaner: MB-05 revision plumbing, MB-32 stale handling, MB-30 delete
// confirm, MB-31 Refresh.
// ---------------------------------------------------------------------------
const cleanerView = (over: Record<string, unknown> = {}) => ({
  ok: true, confirmed: true, editable: true, report_status: "draft", owner_note: null,
  visit: { service: "Standard", date: "2026-11-10", window: "morning", address: "1 Test Street", client_first_name: "Casey", no_photo_zones: null },
  checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Counters wiped", done: false }] }] },
  checklist_revision: "rev-1",
  photos: [
    { id: "photo-0", room: "Kitchen", kind: "before", url: "/fixture.jpg", note: null, created_at: "2026-11-03" },
    { id: "photo-1", room: "Kitchen", kind: "after", url: "/fixture.jpg", note: null, created_at: "2026-11-03" },
  ],
  ...over,
});

describe("MB-05/MB-32: cleaner checklist revision + stale conflicts", () => {
  let posts: Record<string, unknown>[];
  let reads: number;
  let saveBehaviour: "stale" | "ok";
  let submitBehaviour: "stale" | "ok";

  beforeEach(() => {
    posts = []; reads = 0; saveBehaviour = "stale"; submitBehaviour = "stale";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/cleaner?") && !init?.method) {
        reads++;
        return { ok: true, json: async () => cleanerView() };
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      posts.push(body);
      if (body["action"] === "checklist") {
        if (saveBehaviour === "stale") return { ok: false, status: 409, json: async () => ({ ok: false, error: "checklist_stale", checklist_revision: "rev-2" }) };
        return { ok: true, json: async () => ({ ok: true, checklist_revision: "rev-2" }) };
      }
      if (body["action"] === "submit") {
        if (submitBehaviour === "stale") return { ok: false, status: 409, json: async () => ({ ok: false, error: "checklist_stale", checklist_revision: "rev-2" }) };
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (body["action"] === "photo_delete") return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ ok: true }) };
    }));
  });

  const openCleaner = () => render(
    <HelmetProvider><MemoryRouter initialEntries={["/cleaner?ct=test-cleaner-token"]}><Cleaner /></MemoryRouter></HelmetProvider>,
  );

  it("autosave sends the loaded revision; a 409 shows reload — never a retry loop", async () => {
    openCleaner();
    const checkbox = await screen.findByRole("checkbox", { name: "Counters wiped" });
    fireEvent.click(checkbox);
    expect(await screen.findByText(/This checklist changed in another tab/)).toBeInTheDocument();
    const save = posts.find((p) => p["action"] === "checklist");
    expect(save?.["checklist_revision"]).toBe("rev-1");
    // Stale offers a reload, not the generic "Not saved — Retry".
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload to see the latest version/ })).toBeInTheDocument();
  });

  it("a stale submit names the conflict and offers the reload, not a re-send", async () => {
    saveBehaviour = "ok";
    openCleaner();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Counters wiped" }));
    await screen.findByText("All changes saved.");
    fireEvent.click(screen.getByRole("button", { name: "Finish & send report" }));
    expect(await screen.findByText(/This checklist changed in another tab/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload the latest checklist" })).toBeInTheDocument();
    const submit = posts.find((p) => p["action"] === "submit");
    // The submit echoed the revision the save had just returned.
    expect(submit?.["checklist_revision"]).toBe("rev-2");
  });

  it("MB-30: deleting a photo asks first — one tap never deletes", async () => {
    openCleaner();
    await screen.findByRole("checkbox", { name: "Counters wiped" });
    const trash = screen.getAllByRole("button", { name: "Remove photo" });
    expect(trash.length).toBeGreaterThan(0);
    fireEvent.click(trash[0]);
    expect(await screen.findByText("Remove this photo?")).toBeInTheDocument();
    expect(posts.filter((p) => p["action"] === "photo_delete")).toHaveLength(0);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Keep photo" }));
    expect(screen.queryByText("Remove this photo?")).not.toBeInTheDocument();
    expect(posts.filter((p) => p["action"] === "photo_delete")).toHaveLength(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove photo" })[0]);
    await screen.findByText("Remove this photo?");
    const dialog2 = document.querySelector('[role="alertdialog"]')!;
    fireEvent.click(within(dialog2 as HTMLElement).getByRole("button", { name: "Remove photo" }));
    await waitFor(() => expect(posts.filter((p) => p["action"] === "photo_delete")).toHaveLength(1));
    expect(posts.find((p) => p["action"] === "photo_delete")?.["photo_id"]).toBe("photo-0");
  });

  it("MB-31: a Refresh button reuses load()", async () => {
    openCleaner();
    await screen.findByRole("checkbox", { name: "Counters wiped" });
    expect(reads).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(reads).toBe(2));
  });
});

// ---------------------------------------------------------------------------
// Visit + Report: MB-16 reload, MB-29 dates, MB-31 Refresh, MB-33 photo
// hint, K1-UI honest deadline.
// ---------------------------------------------------------------------------
const VISIT_BASE = {
  ok: true,
  state: "report_sent",
  has_card: true,
  card_confirmed: true,
  card_brand: "visa",
  card_last4: "4242",
  booking: { service: "Standard", confirmed_date: "2026-11-10", window: "morning", first: "$1.50" },
  confirm_by: "tomorrow",
  entry_available: false,
};
const REPORT_BASE = {
  ok: true,
  state: "awaiting",
  amount: "$1.50",
  publication_id: "pub-1",
  deadline: "2026-11-16T10:00:00.000Z",
  photo_items: [{ url: "https://img.example/k.jpg", room: "Kitchen", kind: "after" }],
  checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wiped", done: true }] }] },
};

describe("MB-16: /visit keeps a good report when a refetch fails", () => {
  let reportGets: number;
  let reportFailFrom: number;

  beforeEach(() => {
    reportGets = 0;
    reportFailFrom = Number.POSITIVE_INFINITY;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/report?")) {
        reportGets++;
        if (reportGets >= reportFailFrom) throw new Error("down");
        return { ok: true, json: async () => ({ ...REPORT_BASE, photo_items: [{ url: null, room: "Kitchen", kind: "after" }] }) };
      }
      if (String(url).startsWith("/api/visit?")) return { ok: true, json: async () => VISIT_BASE };
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  const openVisit = () => render(
    <HelmetProvider><MemoryRouter initialEntries={["/visit?bt=test-booking"]}><Visit /></MemoryRouter></HelmetProvider>,
  );

  it("a failed tile retry keeps the loaded report (no not_ready wipe)", async () => {
    reportFailFrom = 2;
    openVisit();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Couldn't refresh your report — showing the last loaded version/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve & pay $1.50" })).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load your report/)).not.toBeInTheDocument();
  });

  it("a first-load failure shows a retry instead of 'will appear after cleaning'", async () => {
    reportFailFrom = 1;
    openVisit();
    expect(await screen.findByText(/couldn't load your report/)).toBeInTheDocument();
    // Now the network recovers: the retry loads the real report.
    reportFailFrom = Number.POSITIVE_INFINITY;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Approve & pay $1.50" })).toBeInTheDocument();
  });
});

describe("MB-29 + K1-UI + MB-31: /visit dates, deadline wording, Refresh", () => {
  let visitPosts: Record<string, unknown>[];
  let visitGets: number;
  // Most tests need date_declined (alt dates + propose box); the K1
  // test needs a report state, since the report section — and its
  // deadline line — only renders then.
  let visitState = "date_declined";

  beforeEach(() => {
    visitPosts = [];
    visitGets = 0;
    visitState = "date_declined";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/report?")) return { ok: true, json: async () => REPORT_BASE };
      if (url === "/api/report" && init?.method === "POST") return { ok: true, json: async () => ({ ...REPORT_BASE, state: "issue_open" }) };
      if (String(url).startsWith("/api/visit?")) {
        visitGets++;
        return {
          ok: true,
          json: async () => ({
            ...VISIT_BASE,
            state: visitState,
            alt_dates: ["2026-11-20", "2026-11-21"],
            proposed_date: "2026-11-22",
            proposed_pending: true,
            booking: { service: "Standard", confirmed_date: "2026-11-18", window: "morning", first: "$1.50" },
          }),
        };
      }
      if (url === "/api/visit" && init?.method === "POST") {
        visitPosts.push(JSON.parse(String(init.body)));
        return { ok: true, json: async () => ({ ...VISIT_BASE, state: "date_declined" }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  const openVisit = () => render(
    <HelmetProvider><MemoryRouter initialEntries={["/visit?bt=test-booking"]}><Visit /></MemoryRouter></HelmetProvider>,
  );

  it("alt dates and the proposed date render as US dates, never raw ISO", async () => {
    openVisit();
    expect(await screen.findByRole("button", { name: "Nov 20, 2026" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nov 21, 2026" })).toBeInTheDocument();
    expect(screen.queryByText("2026-11-20")).not.toBeInTheDocument();
    expect(screen.getByText(/You asked for/).textContent).toContain("Nov 22, 2026");
    expect(screen.getByText(/You asked for/).textContent).toContain("Nov 18, 2026");
    expect(screen.queryByText("2026-11-22")).not.toBeInTheDocument();
  });

  it("the propose-date field has min=today and a past date errors without a POST", async () => {
    openVisit();
    const input = await screen.findByLabelText("Propose a new date") as HTMLInputElement;
    const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    expect(input.getAttribute("min")).toBe(todayET);
    fireEvent.change(input, { target: { value: "2020-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Request this date" }));
    expect(await screen.findByText("Please choose a future date — that date has already passed.")).toBeInTheDocument();
    expect(visitPosts).toHaveLength(0);
  });

  it("K1-UI: the deadline line says the charge has no exact minute", async () => {
    visitState = "report_sent";
    openVisit();
    expect(await screen.findByText(/not at this exact minute/)).toBeInTheDocument();
  });

  it("MB-31: a Refresh button reuses load()", async () => {
    openVisit();
    await screen.findByRole("button", { name: "Nov 20, 2026" });
    expect(visitGets).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(visitGets).toBe(2));
  });
});

describe("MB-31/MB-33/K1-UI: /report Refresh, photo hint, deadline wording", () => {
  let reportGets: number;

  beforeEach(() => {
    reportGets = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/report?")) {
        reportGets++;
        return { ok: true, json: async () => REPORT_BASE };
      }
      if (url === "/api/report" && init?.method === "POST") return { ok: true, json: async () => ({ ...REPORT_BASE, state: "issue_open" }) };
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  const openReport = () => render(
    <HelmetProvider><MemoryRouter initialEntries={["/report?bt=test-booking"]}><Report /></MemoryRouter></HelmetProvider>,
  );

  it("shows a Refresh button that refetches, and the honest deadline line", async () => {
    openReport();
    expect(await screen.findByText(/not at this exact minute/)).toBeInTheDocument();
    expect(reportGets).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(reportGets).toBe(2));
  });

  it("the issue form says photos are compressed (up to 15 MB), not dropped at 1 MB", async () => {
    openReport();
    fireEvent.click(await screen.findByRole("button", { name: "Report an issue" }));
    expect(await screen.findByText(/compressed on your phone before sending \(up to 15 MB each\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Photos up to 1 MB each/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// City pages + Areas + Index: MB-15 (From price, fuller copy, unique
// titles/descriptions, dead sections gone), live-run #3/#4/#8.
// ---------------------------------------------------------------------------
describe("MB-15/B8/LB-32: city pages — unique copy, From price, no dead sections", () => {
  it("titles and descriptions are unique per city, one accent everywhere", () => {
    expect(CITIES).toHaveLength(7);
    expect(new Set(CITIES.map((c) => c.title)).size).toBe(7);
    expect(new Set(CITIES.map((c) => c.description)).size).toBe(7);
    for (const c of CITIES) {
      expect(c.description).toContain("One-time and every-other-week");
      expect(c.title).toContain(c.name);
      // LB-32: only the rendered "Homes in …" section survives.
      expect(c.sections.map((s) => s.heading)).toEqual([`Homes in ${c.name}`]);
      // (b) 2–3 sentences about the city and its home types.
      const sentences = c.sections[0].text.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      expect(sentences.length).toBeLessThanOrEqual(3);
    }
  });

  it("Sugar Hill shows 'From $1.29' while test prices run (and the test banner)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-14T12:00:00Z"));
    render(
      <MemoryRouter initialEntries={["/areas/sugar-hill"]}>
        <HelmetProvider>
          <Routes><Route path="/areas/:city" element={<CityPage />} /></Routes>
        </HelmetProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/from \$1\.29 per visit for a small home/)).toBeInTheDocument();
    expect(screen.getByText(/Test booking: prices on this page are reduced for a payment test/)).toBeInTheDocument();
    expect(screen.getByText(/Sugar Hill sits at the northern edge of Gwinnett County/)).toBeInTheDocument();
    expect(screen.getByText(/two stories, several bedrooms and bathrooms/)).toBeInTheDocument();
  });

  it("Sugar Hill shows 'From $129' once the test window is over", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-21T00:00:00Z"));
    render(
      <MemoryRouter initialEntries={["/areas/sugar-hill"]}>
        <HelmetProvider>
          <Routes><Route path="/areas/:city" element={<CityPage />} /></Routes>
        </HelmetProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/from \$129 per visit for a small home/)).toBeInTheDocument();
    expect(screen.queryByText(/Test booking: prices on this page/)).not.toBeInTheDocument();
  });

  it("live-run #4: the /areas H1 keeps '7 North Atlanta Suburbs' on its own line", () => {
    render(<MemoryRouter><Areas /></MemoryRouter>);
    expect(screen.getByText("7 North Atlanta Suburbs").className).toContain("block");
  });

  it("live-run #8: How it works names the 24-hour auto-charge next to the pay step", () => {
    render(<HelmetProvider><MemoryRouter><Index /></MemoryRouter></HelmetProvider>);
    expect(screen.getByText(/Approve to pay — or your card is charged automatically 24 hours after the report is sent/)).toBeInTheDocument();
  });
});
