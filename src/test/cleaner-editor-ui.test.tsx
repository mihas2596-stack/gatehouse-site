import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import Cleaner from "@/pages/Cleaner";

vi.mock("@/lib/imageConvert", () => ({ convertToJpeg: async () => new Blob(["fixture"], { type: "image/jpeg" }) }));
const view = () => ({
  ok: true, confirmed: true, editable: true, report_status: "draft", owner_note: null,
  visit: { service: "Standard", date: "2027-01-15", window: "morning", address: "1 Test Street", client_first_name: "Casey", no_photo_zones: "Bedrooms" },
  checklist: { rooms: [
    { name: "Kitchen", items: [{ label: "Counters wiped", done: false }] },
    { name: "Bedrooms", items: [{ label: "Bed made", done: false }], skip_reason: "Client requested no photos" },
  ] },
  photos: [{ id: "photo-1", room: "Kitchen", kind: "after", url: "/fixture.jpg", note: null, created_at: "2026-11-03" }],
});
let posts: Record<string, unknown>[];
let holdSave: ((ok: boolean) => void) | null;
let reads: number;
let delaySaves: boolean;

beforeEach(() => {
  posts = []; holdSave = null; reads = 0; delaySaves = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/cleaner?") && !init?.method) {
      reads++;
      // Deliberately old server snapshot after a photo upload.
      return { ok: true, json: async () => view() };
    }
    if (String(url) === "https://upload.example.com/fixture") return { ok: true };
    const body = JSON.parse(String(init?.body ?? "{}")); posts.push(body);
    if (body.action === "checklist" && delaySaves) {
      const ok = await new Promise<boolean>((resolve) => { holdSave = resolve; });
      return { ok, json: async () => ({ ok }) };
    }
    return { ok: true, json: async () => ({ ok: true, upload_url: "https://upload.example.com/fixture", storage_path: "visits/test/kitchen/fixture.jpg" }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const open = () => render(<StrictMode><HelmetProvider><MemoryRouter initialEntries={["/cleaner?ct=test-cleaner-token"]}><Cleaner /></MemoryRouter></HelmetProvider></StrictMode>);

describe("cleaner editor with delayed network responses", () => {
  it("offers no photo controls in a restricted room and explains the alternative", async () => {
    const { container } = open();
    await screen.findByRole("checkbox", { name: "Counters wiped" });
    const room = [...container.querySelectorAll("details")].find((e) => e.querySelector("summary")?.textContent?.startsWith("Bedrooms"))!;
    expect(room.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(room.textContent).toContain("do-not-photograph list");
  });

  it("photo refresh does not replace unsaved checklist edits with an older snapshot", async () => {
    const { container } = open();
    const checkbox = await screen.findByRole("checkbox", { name: "Counters wiped" });
    fireEvent.click(checkbox);
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    const oldReads = reads;
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["photo"], "test.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(reads).toBeGreaterThan(oldReads));
    expect(checkbox).toBeChecked();
  });

  it("Finish waits for the queued save instead of publishing before it completes", async () => {
    delaySaves = true;
    open();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Counters wiped" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish & send report" }));
    await waitFor(() => expect(holdSave).not.toBeNull());
    expect(posts.filter((p) => p.action === "submit")).toHaveLength(0);
    holdSave!(true);
    await waitFor(() => expect(posts.filter((p) => p.action === "submit")).toHaveLength(1));
    const submitted = posts.find((p) => p.action === "submit") as { checklist: ReturnType<typeof view>["checklist"] };
    expect(submitted.checklist.rooms[0].items[0].done).toBe(true);
  });
});
