// Top-5 fixes (ideas 4, 5): the cleaner sees the agreed re-clean date
// and the client's complaint alongside the owner's note when a report
// is returned.
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import Cleaner from "@/pages/Cleaner";

vi.mock("@/lib/imageConvert", () => ({ convertToJpeg: async () => new Blob(["fixture"], { type: "image/jpeg" }) }));

type Reclean = { date: string; note: string } | null;
type ClientIssue = { reason: string; room: string; source: string } | null;

const makeView = (overrides: {
  report_status?: string;
  owner_note?: string | null;
  reclean?: Reclean;
  client_issue?: ClientIssue;
} = {}) => ({
  ok: true, confirmed: true, editable: true,
  report_status: overrides.report_status ?? "draft",
  owner_note: overrides.owner_note ?? null,
  reclean: overrides.reclean ?? null,
  client_issue: overrides.client_issue ?? null,
  visit: { service: "Standard", date: "2027-01-15", window: "morning", address: "1 Test Street", client_first_name: "Casey", no_photo_zones: null },
  checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Counters wiped", done: false }] }] },
  photos: [],
});

let fixture: ReturnType<typeof makeView>;

beforeEach(() => {
  fixture = makeView();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/cleaner?") && !init?.method) {
      return { ok: true, json: async () => fixture };
    }
    if (String(url) === "https://upload.example.com/fixture") return { ok: true };
    return { ok: true, json: async () => ({ ok: true, upload_url: "https://upload.example.com/fixture", storage_path: "visits/test/kitchen/fixture.jpg" }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const open = () => render(<StrictMode><HelmetProvider><MemoryRouter initialEntries={["/cleaner?ct=test-cleaner-token"]}><Cleaner /></MemoryRouter></HelmetProvider></StrictMode>);

describe("re-clean banner (idea 4)", () => {
  it("shows the agreed re-clean date and the owner's note", async () => {
    fixture = makeView({ reclean: { date: "2026-11-18", note: "Come back and redo the kitchen floor." } });
    open();
    expect(await screen.findByText(/Re-clean agreed for/)).toBeInTheDocument();
    expect(screen.getByText(/Wednesday, November 18/)).toBeInTheDocument();
    expect(screen.getByText("Come back and redo the kitchen floor.")).toBeInTheDocument();
  });

  it("no banner when no re-clean was agreed", async () => {
    open();
    await screen.findByRole("heading", { name: "Your cleaning job" });
    expect(screen.queryByText(/Re-clean agreed/)).not.toBeInTheDocument();
  });
});

describe("client's issue on a returned report (idea 5)", () => {
  it("shows the client's complaint alongside the owner's note", async () => {
    fixture = makeView({
      report_status: "returned",
      owner_note: "Please fix the kitchen.",
      client_issue: { reason: "Streaks on the floor", room: "Kitchen", source: "client" },
    });
    open();
    expect(await screen.findByText("The owner sent this report back:")).toBeInTheDocument();
    expect(screen.getByText("Please fix the kitchen.")).toBeInTheDocument();
    expect(screen.getByText(/What the client flagged \(Kitchen\):/)).toBeInTheDocument();
    expect(screen.getByText(/“Streaks on the floor”/)).toBeInTheDocument();
  });

  it("an operator-filed issue is not presented as the client's words", async () => {
    fixture = makeView({
      report_status: "returned",
      owner_note: "Please fix the kitchen.",
      client_issue: { reason: "Client emailed about streaks", room: "Kitchen", source: "operator" },
    });
    open();
    expect(await screen.findByText(/Issue reported \(Kitchen\):/)).toBeInTheDocument();
    expect(screen.queryByText(/What the client flagged/)).not.toBeInTheDocument();
  });

  it("the returned banner shows even when the owner left no note, as long as the complaint is there", async () => {
    fixture = makeView({
      report_status: "returned",
      owner_note: null,
      client_issue: { reason: "Streaks on the floor", room: "Kitchen", source: "client" },
    });
    open();
    expect(await screen.findByText("The owner sent this report back:")).toBeInTheDocument();
    expect(screen.getByText(/What the client flagged/)).toBeInTheDocument();
  });

  it("no complaint line when there is no client issue", async () => {
    fixture = makeView({ report_status: "returned", owner_note: "Please fix the kitchen." });
    open();
    expect(await screen.findByText("The owner sent this report back:")).toBeInTheDocument();
    expect(screen.queryByText(/What the client flagged/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Issue reported/)).not.toBeInTheDocument();
  });
});
