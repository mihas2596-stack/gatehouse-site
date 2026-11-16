// ChatGPT cabinets audit (16.11.2026): the confirmed UI fixes —
// client dispute status first, lightbox navigation, owner Waive
// gate + confirms, report/attachment labels, loading state,
// manage-photos mode, cleaner room jumps.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import Visit from "@/pages/Visit";
import Owner from "@/pages/Owner";
import Cleaner from "@/pages/Cleaner";

vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/lib/imageConvert", () => ({ convertToJpeg: vi.fn(async () => new Blob(["jpeg-bytes"], { type: "image/jpeg" })) }));

// ---- /visit: dispute status block + lightbox -----------------------

let visitState: string;
let reportState: string;
let issueDecision: Record<string, unknown> | null;
let issuePhotoCount: number | null;

const visitBase = () => ({
  ok: true,
  state: visitState,
  has_card: true,
  card_confirmed: true,
  card_brand: "visa",
  card_last4: "4242",
  booking: { service: "Standard", confirmed_date: "2026-11-10", window: "morning", first: "$1.50" },
  confirm_by: "tomorrow",
  entry_available: false,
});

const reportBase = () => ({
  ok: true,
  state: reportState,
  amount: "$1.50",
  publication_id: "pub-1",
  deadline: "2026-11-16T10:00:00.000Z",
  photo_items: [
    { url: "https://img.example/k-before.jpg", thumb_url: "https://img.example/k-before-thumb.jpg", room: "Kitchen", kind: "before" },
    { url: "https://img.example/k-after-1.jpg", thumb_url: "https://img.example/k-after-1-thumb.jpg", room: "Kitchen", kind: "after" },
    { url: "https://img.example/k-after-2.jpg", thumb_url: "https://img.example/k-after-2-thumb.jpg", room: "Kitchen", kind: "after" },
  ],
  checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wiped", done: true }] }] },
  issue_reason: "Streaks on the floor",
  issue_source: "client",
  issue_room: "Kitchen",
  issue_photo_count: issuePhotoCount,
  issue_decision: issueDecision,
  resolution: null,
});

const openVisit = () => render(<MemoryRouter initialEntries={["/visit?bt=test-booking"]}><Visit /></MemoryRouter>);

describe("client dispute status (cabinets audit fix 1)", () => {
  beforeEach(() => {
    visitState = "issue_open";
    reportState = "issue_open";
    issueDecision = null;
    issuePhotoCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/report?")) return { ok: true, json: async () => reportBase() };
      if (!String(url).startsWith("/api/visit?")) throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => visitBase() };
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("shows the paused-payment block first, with room, words, attachments and reply time", async () => {
    openVisit();
    expect(await screen.findByText("Issue received. Automatic payment is paused for this visit.")).toBeInTheDocument();
    expect(screen.getByText("Room: Kitchen")).toBeInTheDocument();
    // The client's words appear once, in the top block — not repeated
    // in the amber status line below the card details.
    expect(screen.getAllByText(/You told us:/)).toHaveLength(1);
    expect(screen.getByText("No photos attached to your message.")).toBeInTheDocument();
    expect(screen.getByText(/We'll confirm by email and reply within one business day\./)).toBeInTheDocument();
    expect(screen.getByText(/hello@gatehousehomecleaning\.com/)).toBeInTheDocument();
    // The card is on file while the dispute is open — never "to be
    // charged" — and Change card is a 44px tap target.
    expect(screen.getByText("Card on file")).toBeInTheDocument();
    expect(screen.queryByText(/Card we'll charge/)).not.toBeInTheDocument();
    const changeCard = screen.getByRole("link", { name: "Change card" });
    expect(changeCard.className).toContain("min-h-[44px]");
  });

  it("counts attached complaint photos when there are any", async () => {
    issuePhotoCount = 2;
    openVisit();
    expect(await screen.findByText("2 photos attached to your message.")).toBeInTheDocument();
    expect(screen.queryByText(/No photos attached/)).not.toBeInTheDocument();
  });

  it("lightbox navigates with Previous/Next, counts frames, and numbers identical stages", async () => {
    openVisit();
    await screen.findByText("Issue received. Automatic payment is paused for this visit.");
    // The grid loads the small variant.
    const thumb = screen.getByAltText("Kitchen — before cleaning");
    expect(thumb.getAttribute("src")).toBe("https://img.example/k-before-thumb.jpg");
    // Two after photos in one room get frame numbers.
    expect(screen.getByText("After · 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("After · 2 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enlarge photo: Kitchen — before cleaning" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Photo 1 of 3");
    expect(dialog.textContent).toContain("Kitchen — before cleaning");
    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    expect(dialog.textContent).toContain("Photo 2 of 3");
    expect(dialog.textContent).toContain("Kitchen — after cleaning");
    fireEvent.click(screen.getByRole("button", { name: "Previous photo" }));
    expect(dialog.textContent).toContain("Photo 1 of 3");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

// ---- /owner: Waive gate, labels, loading, manage photos -----------

const ownerVisits = [
  {
    id: "visit-issue", booking_id: "booking-issue", client_name: "Casey Client",
    client_email: "client@example.com", service: "Standard", visit_date: "2027-01-15",
    window: "morning", address: "1 Test Street", amount_cents: 14900,
    status: "report_sent", report_status: "sent", cleaner_name: "Test Cleaner",
    cleaner_profile: { phone: "+1 770 555 0100" },
    issue_open: true, issue_ever: true, report_bounced: false, is_test: false,
    visit_confirmed: true, entry_agreed: true, checklist: { rooms: [] },
    cleaner_link_issued: true, cleaner_link_active: true, cleaner_link_reusable: true,
    cleaner_link_expires: "2099-01-01T00:00:00Z",
    photo_count: 4, issue_photo_count: 0, report_email: "sent",
    issue_opened_at: "2026-11-08T11:00:00.000Z",
    issue_reason: "Streaks on the floor",
    issue_room: "Kitchen",
    issue_decision: { decision: "payment_requested", resolution: "The original amount stays due.", decided_at: "2026-11-09T10:00:00.000Z" },
  },
];

const ownerDetailEvents = [
  { id: 1, actor: "client", event: "issue_opened", detail: { reason: "Streaks on the floor", room: "Kitchen" }, created_at: "2026-11-08T11:00:00.000Z" },
  { id: 2, actor: "owner", event: "issue_decision", detail: { decision: "payment_requested", resolution: "The original amount stays due.", decided_at: "2026-11-09T10:00:00.000Z" }, created_at: "2026-11-09T10:00:00.000Z" },
];

const ownerDetailPhotos = [
  { id: "ph-1", room: "Kitchen", kind: "before", note: null, url: "https://img.example/o-before.jpg", thumb_url: "https://img.example/o-before-thumb.jpg" },
  { id: "ph-2", room: "Kitchen", kind: "after", note: null, url: "https://img.example/o-after.jpg", thumb_url: "https://img.example/o-after-thumb.jpg" },
  { id: "ph-3", room: "Kitchen", kind: "client", note: null, url: "https://img.example/o-client.jpg", thumb_url: "https://img.example/o-client-thumb.jpg" },
];

let ownerActionCalls: Record<string, unknown>[];

const ownerFetchMock = (hangList = false) => vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
  const u = new URL(String(url), "https://example.com");
  if (u.pathname === "/api/owner-auth") return { ok: true, json: async () => ({ ok: true, session: "test-owner-session" }) };
  if (u.pathname === "/api/owner") {
    if (u.searchParams.get("view") === "list") {
      if (hangList) return new Promise(() => {});
      return { ok: true, json: async () => ({ ok: true, visits: ownerVisits }) };
    }
    if (u.searchParams.get("view") === "roster") return { ok: true, json: async () => ({ ok: true, cleaners: [] }) };
    return { ok: true, json: async () => ({ ok: true, visit: ownerVisits[0], photos: ownerDetailPhotos, events: ownerDetailEvents }) };
  }
  if (u.pathname === "/api/booking-action") {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    ownerActionCalls.push(parsed);
    return { ok: true, json: async () => ({ ok: true, ...(parsed["action"] === "issue_waive_charge" ? { decision: "waived", email_sent: true } : {}) }) };
  }
  return { ok: true, json: async () => ({ ok: true, state: "card_ready" }) };
});

const openOwner = async () => {
  const rendered = render(<HelmetProvider><Owner /></HelmetProvider>);
  await screen.findByRole("button", { name: "All visits (1)" });
  fireEvent.click(screen.getByRole("button", { name: "All visits (1)" }));
  fireEvent.click(screen.getAllByRole("button", { name: /Casey Client/ })[0]);
  await screen.findByText("Your decision for the client *");
  return rendered;
};

describe("owner dispute decisions (cabinets audit B1)", () => {
  beforeEach(() => {
    sessionStorage.clear(); localStorage.clear();
    sessionStorage.setItem("gh_owner_session", "test-owner-session");
    window.history.replaceState({}, "", "/owner");
    window.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    ownerActionCalls = [];
    vi.stubGlobal("fetch", ownerFetchMock());
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("Waive is disabled while the response is empty, like the other two decisions", async () => {
    await openOwner();
    const waive = screen.getByRole("button", { name: "Waive charge" });
    expect(waive).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request payment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Arrange re-clean" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Your decision for the client *"), { target: { value: "We've waived the charge for this visit." } });
    expect(waive).not.toBeDisabled();
  });

  it("Waive asks for confirmation with the amount and consequences; backing out runs nothing", async () => {
    await openOwner();
    fireEvent.change(screen.getByLabelText("Your decision for the client *"), { target: { value: "We've waived the charge for this visit." } });
    fireEvent.click(screen.getByRole("button", { name: "Waive charge" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Waive the $149 charge for this visit?");
    expect(dialog.textContent).toContain("The client pays nothing");
    expect(dialog.textContent).toContain("can never be charged");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(ownerActionCalls.some((c) => c["action"] === "issue_waive_charge")).toBe(false);
    // Confirming runs the waive with the response text.
    fireEvent.click(screen.getByRole("button", { name: "Waive charge" }));
    const dialog2 = await screen.findByRole("alertdialog");
    expect(dialog2.textContent).toContain("Waive the $149 charge");
    fireEvent.click(within(dialog2).getByRole("button", { name: "Waive charge" }));
    await screen.findByText("Waive charge: done.");
    const call = ownerActionCalls.find((c) => c["action"] === "issue_waive_charge");
    expect(call).toMatchObject({ booking_id: "booking-issue", resolution: "We've waived the charge for this visit." });
  });

  it("Arrange re-clean asks for confirmation before running", async () => {
    await openOwner();
    fireEvent.change(screen.getByLabelText("Your decision for the client *"), { target: { value: "We'll come back Tuesday to re-clean the kitchen." } });
    fireEvent.click(screen.getByRole("button", { name: "Arrange re-clean" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Arrange a re-clean");
    expect(dialog.textContent).toContain("Nothing is charged now");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(ownerActionCalls.some((c) => c["action"] === "issue_arrange_reclean")).toBe(false);
  });

  it("labels report photos vs complaint attachments, hides the stale readiness block, and dedups the sent line", async () => {
    await openOwner();
    // Detail counts come from the loaded photos: 2 report + 1 client.
    expect(screen.getByText(/Cleaning report: 2 photos/)).toBeInTheDocument();
    expect(screen.getByText(/Issue attachments: 1 photo/)).toBeInTheDocument();
    // The list labels the same split: 4 report photos, no attachments.
    expect(screen.getByText(/Cleaning report: 4 photos/)).toBeInTheDocument();
    expect(screen.getByText(/Issue attachments: none/)).toBeInTheDocument();
    // A submitted report is not "Ready for the visit" any more.
    expect(screen.queryByText("Ready for the visit")).not.toBeInTheDocument();
    // "Report sent to the client" is the section heading only — the
    // sent block below it carries just the email status.
    expect(screen.getByText("Email: sent.")).toBeInTheDocument();
    expect(screen.queryByText(/Report sent to the client · Email/)).not.toBeInTheDocument();
    // The summary line no longer repeats "Issue open" — the red issue
    // block below it is the single indicator.
    const summary = screen.getByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").startsWith("Visit:"));
    expect(summary.textContent).not.toContain("Issue open");
  });

  it("photo viewing is separate from deletion until Manage photos is on", async () => {
    await openOwner();
    expect(screen.queryByRole("button", { name: /Delete photo/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage photos" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage photos" }));
    const deletes = screen.getAllByRole("button", { name: /Delete photo/ });
    expect(deletes).toHaveLength(3);
    for (const d of deletes) expect(d.className).toContain("min-h-[44px]");
    fireEvent.click(screen.getByRole("button", { name: "Done managing photos" }));
    expect(screen.queryByRole("button", { name: /Delete photo/ })).not.toBeInTheDocument();
  });

  it("Call cleaner is a 44px button when the number is on file", async () => {
    await openOwner();
    const callCleaner = screen.getByRole("link", { name: "Call cleaner Test Cleaner" });
    expect(callCleaner.getAttribute("href")).toBe("tel:17705550100");
    expect(callCleaner.className).toContain("min-h-[44px]");
  });
});

describe("owner list loading (cabinets audit fix 6)", () => {
  beforeEach(() => {
    sessionStorage.clear(); localStorage.clear();
    sessionStorage.setItem("gh_owner_session", "test-owner-session");
    window.history.replaceState({}, "", "/owner");
    window.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    ownerActionCalls = [];
    vi.stubGlobal("fetch", ownerFetchMock(true));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("shows 'Loading visits…' and holds the filters until the first page arrives", async () => {
    render(<HelmetProvider><Owner /></HelmetProvider>);
    expect(await screen.findByText("Loading visits…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /All visits/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Needs attention/ })).not.toBeInTheDocument();
  });
});

// ---- /cleaner: room jumps + stale arrival window -------------------

let cleanerView: Record<string, unknown>;

const cleanerBase = () => ({
  ok: true, confirmed: true, editable: true, report_status: "draft", owner_note: null,
  visit: { service: "Standard", date: "2026-11-10", window: "morning", address: "1 Test Street", client_first_name: "Casey", no_photo_zones: "Bedrooms" },
  checklist: { rooms: [
    { name: "Kitchen", items: [{ label: "Counters wiped", done: true }] },
    { name: "Bedrooms", items: [{ label: "Bed made", done: true }], skip_reason: "Client requested no photos" },
  ] },
  photos: [
    { id: "photo-0", room: "Kitchen", kind: "before", url: "/fixture.jpg", thumb_url: "/fixture-thumb.jpg", note: null, created_at: "2026-11-03" },
    { id: "photo-1", room: "Kitchen", kind: "after", url: "/fixture.jpg", thumb_url: "/fixture-thumb.jpg", note: null, created_at: "2026-11-03" },
  ],
});

const openCleaner = () => render(<HelmetProvider><MemoryRouter initialEntries={["/cleaner?ct=test-cleaner-token"]}><Cleaner /></MemoryRouter></HelmetProvider>);

describe("cleaner published report (cabinets audit fix 5)", () => {
  beforeEach(() => {
    cleanerView = cleanerBase();
    window.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/cleaner?") && !init?.method) {
        return { ok: true, json: async () => cleanerView };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("room jumps sit above the published galleries and scroll to the room", async () => {
    cleanerView = { ...cleanerBase(), editable: false, report_status: "sent" };
    openCleaner();
    expect(await screen.findByText("Report published — the client can open it from their link.")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Jump to a room's photos" });
    expect(nav.textContent).toContain("Kitchen");
    expect(nav.textContent).toContain("Bedrooms");
    const jump = screen.getByRole("button", { name: "Bedrooms" });
    expect(jump.className).toContain("min-h-[44px]");
    fireEvent.click(jump);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // The grid loads the small variant.
    const thumb = screen.getByAltText("Kitchen before");
    expect(thumb.getAttribute("src")).toBe("/fixture-thumb.jpg");
    expect(thumb.getAttribute("loading")).toBe("lazy");
  });

  it("a flexible window with a submitted report shows the date alone", async () => {
    cleanerView = {
      ...cleanerBase(),
      editable: false, report_status: "sent",
      visit: { ...(cleanerBase().visit as Record<string, unknown>), window: "flexible" },
    };
    openCleaner();
    expect(await screen.findByText("Report published — the client can open it from their link.")).toBeInTheDocument();
    expect(screen.queryByText(/Arrival window to be agreed/)).not.toBeInTheDocument();
    expect(screen.getByText("Tuesday, November 10")).toBeInTheDocument();
  });

  it("a flexible window before submission still says it is to be agreed", async () => {
    cleanerView = {
      ...cleanerBase(),
      visit: { ...(cleanerBase().visit as Record<string, unknown>), window: "flexible" },
    };
    openCleaner();
    await screen.findByRole("checkbox", { name: "Counters wiped" });
    expect(screen.getByText(/Arrival window to be agreed/)).toBeInTheDocument();
  });

  it("Call / Text Gatehouse and Refresh are 44px tap zones", async () => {
    openCleaner();
    await screen.findByRole("checkbox", { name: "Counters wiped" });
    const call = screen.getByRole("link", { name: "Call Gatehouse (owner Nick)" });
    expect(call.className).toContain("min-h-[44px]");
    const text = screen.getByRole("link", { name: "Text Gatehouse" });
    expect(text.className).toContain("min-h-[44px]");
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh.className).toContain("min-h-[44px]");
  });
});
