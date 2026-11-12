import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import Cleaner from "@/pages/Cleaner";

vi.mock("@/lib/imageConvert", () => ({ convertToJpeg: async () => new Blob(["fixture"], { type: "image/jpeg" }) }));

type PhotoFixture = { id: string; room: string; kind: string; url: string; note: null; created_at: string };
const photo = (id: string, room: string, kind: string): PhotoFixture =>
  ({ id, room, kind, url: "/fixture.jpg", note: null, created_at: "2026-11-03" });

type RoomFixture = { name: string; items: { label: string; done: boolean }[]; skip_reason?: string };
const makeView = (overrides: {
  no_photo_zones?: string | null;
  rooms?: RoomFixture[];
  photos?: PhotoFixture[];
} = {}) => ({
  ok: true, confirmed: true, editable: true, report_status: "draft", owner_note: null,
  visit: { service: "Standard", date: "2027-01-15", window: "morning", address: "1 Test Street", client_first_name: "Casey", no_photo_zones: overrides.no_photo_zones ?? null },
  checklist: { rooms: overrides.rooms ?? [{ name: "Kitchen", items: [{ label: "Counters wiped", done: false }] }] },
  photos: overrides.photos ?? [],
});

let fixture = makeView();
let posts: Record<string, unknown>[];

beforeEach(() => {
  posts = [];
  fixture = makeView();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/cleaner?") && !init?.method) {
      return { ok: true, json: async () => fixture };
    }
    if (String(url) === "https://upload.example.com/fixture") return { ok: true };
    const body = JSON.parse(String(init?.body ?? "{}")); posts.push(body);
    return { ok: true, json: async () => ({ ok: true, upload_url: "https://upload.example.com/fixture", storage_path: "visits/test/kitchen/fixture.jpg" }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const open = () => render(<StrictMode><HelmetProvider><MemoryRouter initialEntries={["/cleaner?ct=test-cleaner-token"]}><Cleaner /></MemoryRouter></HelmetProvider></StrictMode>);

describe("cleaner before-photo flow", () => {
  it("checklist is disabled until a before photo exists, and the before step comes first", async () => {
    const { container } = open();
    const checkbox = await screen.findByRole("checkbox", { name: "Counters wiped" });
    expect(checkbox).toBeDisabled();
    expect(screen.getByText("Take before photo")).toBeInTheDocument();
    expect(screen.getByText("Take a before photo in Step 1 to unlock the checklist.")).toBeInTheDocument();
    expect(screen.getAllByText("Rooms ready: 0 of 1")).toHaveLength(2);
    // DOM order: Step 1 (before) -> Step 2 (tasks) -> Step 3 (after).
    const text = container.textContent ?? "";
    expect(text.indexOf("Take BEFORE photo")).toBeGreaterThan(-1);
    expect(text.indexOf("Take BEFORE photo")).toBeLessThan(text.indexOf("Counters wiped"));
    expect(text.indexOf("Counters wiped")).toBeLessThan(text.indexOf("Take AFTER photo"));
    // The reason field lives in Step 1 and is reachable with no before photo.
    expect(screen.getByLabelText("No photo for this room? Tell us why")).toBeInTheDocument();
    expect(screen.getByText(/No after photo yet/)).toBeInTheDocument();
  });

  it("a room with only an after photo is not ready and submit is blocked naming the before photo", async () => {
    fixture = makeView({ photos: [photo("photo-1", "Kitchen", "after")] });
    open();
    const checkbox = await screen.findByRole("checkbox", { name: "Counters wiped" });
    expect(checkbox).toBeDisabled();
    expect(screen.getAllByText("Rooms ready: 0 of 1")).toHaveLength(2);
    expect(screen.getByText("Still need a before photo (or a reason): Kitchen")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish & send report" }));
    await waitFor(() => expect(screen.getByText(/Some rooms still need a before photo/)).toBeInTheDocument());
    expect(posts.filter((p) => p.action === "submit")).toHaveLength(0);
    expect(screen.getByText("This room still needs a before photo (or a reason).")).toBeInTheDocument();
  });

  it("a room with only a before photo unlocks the checklist but is still not ready", async () => {
    fixture = makeView({ photos: [photo("photo-0", "Kitchen", "before")] });
    open();
    const checkbox = await screen.findByRole("checkbox", { name: "Counters wiped" });
    expect(checkbox).toBeEnabled();
    expect(screen.getAllByText("Rooms ready: 0 of 1")).toHaveLength(2);
    expect(screen.getByText("Still need an after photo (or a reason): Kitchen")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish & send report" }));
    await waitFor(() => expect(screen.getByText(/Some rooms still need an after photo/)).toBeInTheDocument());
    expect(posts.filter((p) => p.action === "submit")).toHaveLength(0);
    expect(screen.getByText("This room still needs an after photo (or a reason).")).toBeInTheDocument();
  });

  it("a set reason unlocks the checklist and satisfies both photo requirements", async () => {
    fixture = makeView({ rooms: [{ name: "Kitchen", items: [{ label: "Counters wiped", done: false }], skip_reason: "Room wasn't part of this visit" }] });
    open();
    const checkbox = await screen.findByRole("checkbox", { name: "Counters wiped" });
    expect(checkbox).toBeEnabled();
    expect(screen.getAllByText("Rooms ready: 1 of 1")).toHaveLength(2);
    expect(screen.getByText("Reason added")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish & send report" }));
    await waitFor(() => expect(posts.filter((p) => p.action === "submit")).toHaveLength(1));
  });

  it("a room on the do-not-photograph list is excused without photos or a reason", async () => {
    fixture = makeView({ no_photo_zones: "Kitchen" });
    const { container } = open();
    const checkbox = await screen.findByRole("checkbox", { name: "Counters wiped" });
    expect(checkbox).toBeEnabled();
    expect(screen.getAllByText("Rooms ready: 1 of 1")).toHaveLength(2);
    const room = [...container.querySelectorAll("details")].find((e) => e.querySelector("summary")?.textContent?.startsWith("Kitchen"))!;
    expect(room.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(room.textContent).toContain("do-not-photograph list");
    fireEvent.click(screen.getByRole("button", { name: "Finish & send report" }));
    await waitFor(() => expect(posts.filter((p) => p.action === "submit")).toHaveLength(1));
  });

  it("a room with both photos is ready and submits", async () => {
    fixture = makeView({ photos: [photo("photo-0", "Kitchen", "before"), photo("photo-1", "Kitchen", "after")] });
    open();
    const checkbox = await screen.findByRole("checkbox", { name: "Counters wiped" });
    expect(checkbox).toBeEnabled();
    expect(screen.getAllByText("Rooms ready: 1 of 1")).toHaveLength(2);
    expect(screen.getByText("Photo ready ✓")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish & send report" }));
    await waitFor(() => expect(posts.filter((p) => p.action === "submit")).toHaveLength(1));
  });
});
