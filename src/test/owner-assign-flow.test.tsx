// Task 7 (live run 13.11, commit 1bcf4a8b): three small findings in the
// owner panel around assigning a cleaner.
// 1. The assign dropdown is empty on first open ("No cleaners in the
//    directory yet") even though the roster has an active cleaner — it
//    only populates after the Cleaners directory section is expanded.
//    Root cause: the dropdown shows the empty state while the roster
//    fetch is still in flight (roster.length === 0 before rosterLoaded).
// 2. After "Assign & confirm visit" the card stays stale ("Visit:
//    Requested", "Cleaner: not assigned") until a manual Refresh.
//    Root cause: runAction re-opened the visit from the PRE-action list
//    snapshot via a fire-and-forget list reload, so the card flashed
//    (and on a slow connection stuck on) the stale object.
// 3. "Approve request" stays visible after the visit is confirmed.
//    Root cause: the button's condition lacked the !visit_confirmed
//    guard that nextActionFor already has.
// The fetch mock below is STATEFUL: assign_confirm mutates the server
// visit, so list/detail afterwards return the confirmed visit — the
// way the real server behaves. The delays are deliberate: list 10ms,
// detail 300ms, roster configurable — they reproduce the live
// interleaving where the list lands before the detail fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import Owner from "@/pages/Owner";

const DANIELLE = { id: "roster-danielle", name: "Danielle Littles", phone: "7705550100", photo: "", active: true };

const requestedVisit = {
  id: "visit-req", booking_id: "booking-req",
  client_name: "Test Client", client_email: "test@example.com", client_phone: "+17705550100",
  service: "Standard", window: "morning", address: "123 Test Street",
  status: "requested", report_status: "", cleaner_name: null, cleaner_id: null,
  cleaner_profile: null,
  issue_open: false, issue_ever: false, report_bounced: false, is_test: false,
  visit_confirmed: false, request_approved: false,
  entry_agreed: false, entry_method: null, entry_detail: null, entry_notes: null,
  checklist: { rooms: [] },
  cleaner_link_issued: false, cleaner_link_active: false, cleaner_link_reusable: false,
  cleaner_link_expires: null,
  amount_cents: 149, visit_date: "2026-11-20",
};

// Mutable server state: the mock answers list/detail from this object,
// and assign_confirm mutates it the way the real server does (status
// confirmed, cleaner set, visit_confirmed true).
let serverVisit: Record<string, unknown>;
let rosterCalls: number;
let rosterDelayMs = 0;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setup(visit: Record<string, unknown> = requestedVisit, rosterDelay = 0) {
  sessionStorage.clear(); localStorage.clear();
  window.history.replaceState({}, "", "/owner");
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  serverVisit = { ...visit };
  rosterCalls = 0;
  rosterDelayMs = rosterDelay;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url), "https://example.com");
    if (u.pathname === "/api/owner-auth") return { ok: true, json: async () => ({ ok: true, session: "test-owner-session" }) };
    if (u.pathname === "/api/booking-action" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      if (body["action"] === "assign_confirm") {
        serverVisit = {
          ...serverVisit,
          status: "confirmed", visit_confirmed: true,
          cleaner_name: "Danielle Littles", cleaner_id: "roster-danielle",
          cleaner_profile: { phone: "7705550100", photo: "" },
          visit_date: String(body["confirmed_date"] ?? "2026-11-20"),
          window: String(body["confirmed_window"] ?? "morning"),
        };
        return { ok: true, json: async () => ({ ok: true, email_sent: true, url: "https://example.com/cleaner?ct=test" }) };
      }
      if (body["action"] === "status") {
        return { ok: true, json: async () => ({ ok: true, state: "no_card", no_stripe_customer: true }) };
      }
      return { ok: true, json: async () => ({ ok: true, email_sent: true }) };
    }
    if (u.pathname === "/api/owner") {
      const view = u.searchParams.get("view");
      if (view === "list") { await delay(10); return { ok: true, json: async () => ({ ok: true, visits: [serverVisit] }) }; }
      if (view === "roster") {
        rosterCalls++;
        await delay(rosterDelayMs);
        return { ok: true, json: async () => ({ ok: true, cleaners: [DANIELLE] }) };
      }
      await delay(300);
      return { ok: true, json: async () => ({ ok: true, visit: serverVisit, photos: [], events: [] }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  sessionStorage.setItem("gh_owner_session", "test-owner-session");
  render(<HelmetProvider><Owner /></HelmetProvider>);
}

async function openDetail() {
  fireEvent.click(await screen.findByRole("button", { name: /All visits/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Test Client/ }));
  await screen.findByRole("heading", { name: "Test Client" });
}

async function assignDanielle() {
  const select = screen.getByLabelText("Cleaner") as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "roster-danielle" } });
  fireEvent.click(screen.getByRole("button", { name: "Assign & confirm visit" }));
}

beforeEach(() => { /* per-test setup() */ });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("owner assign flow (task 7 findings)", () => {
  it("finding 1: the assign dropdown lists the roster cleaner on first open, without expanding the directory", async () => {
    setup();
    await openDetail();
    const select = screen.getByLabelText("Cleaner") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent ?? "");
    expect(options.some((t) => t.includes("Danielle Littles"))).toBe(true);
    expect(screen.queryByText(/No cleaners in the directory yet/)).not.toBeInTheDocument();
  });

  it("finding 1: while the roster is still loading the dropdown says so — never the false empty state", async () => {
    // The roster delay must comfortably outlast openDetail() even
    // under parallel load (the detail fetch alone is 300ms); 5s
    // keeps the loading state observable when the assertion runs.
    setup(requestedVisit, 5000);
    await openDetail();
    // The roster fetch is in flight: the panel must not claim there
    // are no cleaners yet — neither in the dropdown nor in the
    // directory section.
    expect(screen.getAllByText("Loading cleaners…").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/No cleaners in the directory yet/)).not.toBeInTheDocument();
    // Once it lands, the cleaner is there — no directory expand needed.
    const select = screen.getByLabelText("Cleaner") as HTMLSelectElement;
    await vi.waitFor(() => {
      expect(Array.from(select.options).some((o) => (o.textContent ?? "").includes("Danielle Littles"))).toBe(true);
    }, { timeout: 10000 });
  }, 20000);

  it("finding 1: the roster is loaded on mount, before any card opens", async () => {
    setup();
    await screen.findByRole("button", { name: /All visits/ });
    expect(rosterCalls).toBeGreaterThanOrEqual(1);
  });

  it("finding 2: the card refreshes itself after Assign & confirm visit, no manual Refresh", async () => {
    setup();
    await openDetail();
    await assignDanielle();
    // The card must show the confirmed state on its own.
    expect(await screen.findByText("Confirmed", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getAllByText(/Danielle Littles/).length).toBeGreaterThanOrEqual(1);
  });

  it("finding 2: the card shows the confirmed state as soon as the list reload lands, even while the detail fetch is still pending", async () => {
    setup();
    await openDetail();
    await assignDanielle();
    // List reload takes ~10ms, the detail fetch ~300ms. At ~100ms the
    // old code still showed the stale list object ("Requested") because
    // it re-opened from the pre-action snapshot; the fix re-opens from
    // the fresh list, so "Confirmed" is already there.
    await delay(100);
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Requested")).not.toBeInTheDocument();
  });

  it("finding 3: Approve request is hidden once the visit is confirmed", async () => {
    setup();
    await openDetail();
    // Before confirming, the button is there (the request genuinely
    // needs approval).
    expect(screen.getByRole("button", { name: "Approve request" })).toBeInTheDocument();
    await assignDanielle();
    await screen.findByText("Confirmed", {}, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: "Approve request" })).not.toBeInTheDocument();
  });

  it("finding 3: Approve request is hidden when the visit is confirmed even if the row status still reads requested", async () => {
    // The stale window: confirmation landed (visit_confirmed) but the
    // row status has not caught up yet. The button must not offer an
    // action that no longer applies.
    setup({ ...requestedVisit, visit_confirmed: true });
    await openDetail();
    expect(screen.queryByRole("button", { name: "Approve request" })).not.toBeInTheDocument();
    expect(screen.queryByText(/the date is not confirmed yet/)).not.toBeInTheDocument();
  });
});
