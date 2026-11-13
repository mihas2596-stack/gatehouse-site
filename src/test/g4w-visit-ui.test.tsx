// M7 follow-up + Extension #12 + Extension #2/#10 (UI):
// - /visit renders a null-url photo as an honest placeholder with the
//   same wording as /report (never a broken <img src="null">), and
//   "Try again" re-fetches the report;
// - the issue buttons say "pause payment", not "block auto-charge";
// - the cleaner error page renders the full warning icon (page-shell
//   clearance, no cropping under the fixed header).
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import Visit from "@/pages/Visit";
import Report from "@/pages/Report";
import Cleaner from "@/pages/Cleaner";

vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/lib/imageConvert", () => ({ convertToJpeg: async () => new Blob(["fixture"], { type: "image/jpeg" }) }));

// ---------- /visit ----------

let reportGets: number;

const visitJson = {
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

const reportJson = {
  ok: true,
  state: "awaiting",
  amount: "$1.50",
  publication_id: "pub-1",
  deadline: "2026-11-16T10:00:00.000Z",
  photo_items: [
    { url: null, room: "Kitchen", kind: "before", unavailable: true },
    { url: "https://img.example/k-after.jpg", room: "Kitchen", kind: "after" },
  ],
  checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wiped", done: true }] }] },
  issue_reason: null,
  issue_source: null,
  issue_room: null,
  issue_decision: null,
  resolution: null,
};

describe("M7: unavailable photo on /visit", () => {
  beforeEach(() => {
    reportGets = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/report?")) {
        reportGets++;
        return { ok: true, json: async () => reportJson };
      }
      if (String(url) === "/api/report" && init?.method === "POST") {
        return { ok: true, json: async () => ({ ...reportJson, state: "issue_open" }) };
      }
      if (String(url).startsWith("/api/visit?")) {
        return { ok: true, json: async () => visitJson };
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const open = () => render(<MemoryRouter initialEntries={["/visit?bt=test-booking"]}><Visit /></MemoryRouter>);

  it("a null-url photo shows the honest placeholder, never a broken image", async () => {
    const { container } = open();
    expect(await screen.findByText(/This photo couldn't be loaded\./)).toBeInTheDocument();
    expect(screen.getByText(/The rest of the report is complete/)).toBeInTheDocument();
    // The good photo renders exactly one <img>; nothing renders with
    // a literal "null" src.
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("src")).toBe("https://img.example/k-after.jpg");
    expect(container.querySelector('img[src="null"]')).toBeNull();
  });

  it("Try again re-fetches the report", async () => {
    open();
    await screen.findByText(/This photo couldn't be loaded\./);
    expect(reportGets).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(reportGets).toBe(2));
  });

  it("the issue button says pause payment, not block auto-charge", async () => {
    open();
    await screen.findByText(/This photo couldn't be loaded\./);
    fireEvent.click(await screen.findByRole("button", { name: "Report an issue" }));
    expect(await screen.findByRole("button", { name: "Send issue — pause payment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /block auto-charge/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/block auto-charge/)).not.toBeInTheDocument();
  });
});

// ---------- /report ----------

describe("Extension #12: plain language on /report", () => {
  let current: Record<string, unknown>;
  beforeEach(() => {
    current = {
      ok: true,
      state: "awaiting",
      amount: "$149",
      amount_cents: 14900,
      publication_id: "pub-1",
      report_sent_at: "2026-11-08T10:00:00.000Z",
      deadline: "2026-11-09T10:00:00.000Z",
      photo_items: [{ url: "https://img.example/k.jpg", room: "Kitchen", kind: "after" }],
      checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Wiped", done: true }] }] },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/report?")) return { ok: true, json: async () => current };
      throw new Error(`Unexpected request: ${url}`);
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("the issue button says pause payment, not block auto-charge", async () => {
    render(<MemoryRouter initialEntries={["/report?bt=test-booking"]}><Report /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Report an issue" }));
    expect(await screen.findByRole("button", { name: "Send — pause payment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /block auto-charge/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/block auto-charge/)).not.toBeInTheDocument();
  });
});

// ---------- /cleaner error page ----------

describe("Extension #2/#10: cleaner error page warning icon", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/cleaner?")) {
        return { ok: true, json: async () => ({ ok: false, error: "invalid_link" }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("the full warning icon renders with page-shell clearance", async () => {
    const { container } = render(
      <StrictMode><HelmetProvider><MemoryRouter initialEntries={["/cleaner?ct=test-cleaner-token"]}><Cleaner /></MemoryRouter></HelmetProvider></StrictMode>,
    );
    expect(await screen.findByRole("heading", { name: "This link doesn't work" })).toBeInTheDocument();
    const icon = container.querySelector("svg.lucide-triangle-alert");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("class") ?? "").toContain("shrink-0");
    // The error container clears the fixed header, so the icon is
    // not covered: same clearance as the working view.
    const shell = container.querySelector(".page-shell");
    expect(shell).not.toBeNull();
    expect(shell?.contains(icon)).toBe(true);
  });
});
