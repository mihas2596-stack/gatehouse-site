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
  visit: { service: "Standard", date: "2026-11-10", window: "morning", address: "1 Test Street", client_first_name: "Casey", no_photo_zones: overrides.no_photo_zones ?? null },
  checklist: { rooms: overrides.rooms ?? [{ name: "Kitchen", items: [{ label: "Counters wiped", done: false }] }] },
  photos: overrides.photos ?? [],
});

let fixture = makeView();
let posts: Record<string, unknown>[];
// Once true, the refetch GET fails — simulates a flaky connection after
// an upload, so a test can prove the photo still shows optimistically.
let refetchShouldFail = false;

beforeEach(() => {
  posts = [];
  fixture = makeView();
  refetchShouldFail = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/cleaner?") && !init?.method) {
      if (refetchShouldFail) return { ok: true, json: async () => ({ ok: false, error: "load_failed" }) };
      return { ok: true, json: async () => fixture };
    }
    if (String(url) === "https://upload.example.com/fixture") return { ok: true };
    const body = JSON.parse(String(init?.body ?? "{}")); posts.push(body);
    if (body.action === "photo_register") { refetchShouldFail = true; return { ok: true, json: async () => ({ ok: true, photo_id: "photo-new" }) }; }
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

  it("a room with only an after photo is not ready and Finish is disabled naming the before photo", async () => {
    fixture = makeView({ photos: [photo("photo-1", "Kitchen", "after")] });
    open();
    const checkbox = await screen.findByRole("checkbox", { name: "Counters wiped" });
    expect(checkbox).toBeDisabled();
    expect(screen.getAllByText("Rooms ready: 0 of 1")).toHaveLength(2);
    expect(screen.getByText("Still need a before photo (or a reason): Kitchen")).toBeInTheDocument();
    // Idea 13: Finish is disabled while rooms are not ready, so the
    // submit error is never reached by tapping it.
    expect(screen.getByRole("button", { name: "Finish & send report" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Finish & send report" }));
    expect(posts.filter((p) => p.action === "submit")).toHaveLength(0);
  });

  it("a room with only a before photo unlocks the checklist but Finish is still disabled", async () => {
    fixture = makeView({ photos: [photo("photo-0", "Kitchen", "before")] });
    open();
    const checkbox = await screen.findByRole("checkbox", { name: "Counters wiped" });
    expect(checkbox).toBeEnabled();
    expect(screen.getAllByText("Rooms ready: 0 of 1")).toHaveLength(2);
    expect(screen.getByText("Still need an after photo (or a reason): Kitchen")).toBeInTheDocument();
    // Idea 13: Finish stays disabled until the after photo exists.
    expect(screen.getByRole("button", { name: "Finish & send report" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Finish & send report" }));
    expect(posts.filter((p) => p.action === "submit")).toHaveLength(0);
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

  it("an uploaded before photo shows immediately and unlocks the checklist even when the refetch fails", async () => {
    // jsdom has no createObjectURL; stub it so the optimistic path runs.
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:test-kitchen-before", configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, configurable: true });
    try {
      const { container } = open();
      const checkbox = await screen.findByRole("checkbox", { name: "Counters wiped" });
      expect(checkbox).toBeDisabled();
      // Upload via the "Take BEFORE photo" (camera) input.
      const input = container.querySelector('input[capture="environment"]') as HTMLInputElement;
      expect(input).not.toBeNull();
      const file = new File(["fixture"], "photo.jpg", { type: "image/jpeg" });
      fireEvent.change(input, { target: { files: [file] } });
      // The register succeeded but the refetch fails (refetchShouldFail
      // is set by the register mock) — the photo must still show, from
      // the optimistic entry, and the checklist must unlock.
      await waitFor(() => expect(screen.getByAltText("Kitchen before")).toBeInTheDocument());
      expect(checkbox).toBeEnabled();
      // The room badge moved on from "Take before photo" to the after
      // step — the before step reads as done from the optimistic photo.
      expect(screen.getByText("Add after photo")).toBeInTheDocument();
      expect(screen.queryByText("Take before photo")).not.toBeInTheDocument();
      expect(posts.filter((p) => p.action === "photo_register")).toHaveLength(1);
      // No duplicate-guard error for the photo that just saved.
      expect(screen.queryByText(/same photo you already added/)).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(URL, "createObjectURL", { value: origCreate, configurable: true });
      Object.defineProperty(URL, "revokeObjectURL", { value: origRevoke, configurable: true });
    }
  });
});
