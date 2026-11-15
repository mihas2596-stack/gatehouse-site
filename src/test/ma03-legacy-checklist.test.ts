// MA-03 / DA-17 (high): a pre-checklist visit row stores a null (or
// empty) checklist. Submit used to dereference it at
// checklist.submitted_at -> 500 server_error before the CAS, while
// GET showed 0 rooms and the UI vacuously treated that as "all ready"
// with Finish enabled. The fix seeds the standard scope from
// buildWorkRooms (the same call booking-action uses for new rows) and
// makes an empty checklist never "ready" in the UI.
import { StrictMode, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import Cleaner from "@/pages/Cleaner";
import { effectiveChecklist } from "../../api/cleaner";
import { buildWorkRooms } from "../../api/_work_scope";
import { installEnv, makePhotos, scopeChecklist, VISIT_ID } from "./m-cleaner-harness";

vi.mock("@/lib/imageConvert", () => ({ convertToJpeg: async () => new Blob(["fixture"], { type: "image/jpeg" }) }));

// jsdom's AbortSignal has no .timeout(), but api/_db.ts passes
// `signal: AbortSignal.timeout(15000)` on every REST call — without
// this, every DB call throws and the handler answers 502. The
// node-env harness tests never hit this; this file also renders the
// UI, so it runs in jsdom and restores Node's behaviour here only.
if (typeof (AbortSignal as unknown as { timeout?: unknown }).timeout !== "function") {
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
}

// The standard scope buildWorkRooms seeds when no dimensions are
// stored (the same call booking-action makes for new rows).
const SEEDED_NAMES = buildWorkRooms({ deep: false }).map((r) => r.name);

function seededPhotos() {
  const photos: Array<Record<string, unknown>> = [];
  for (const room of SEEDED_NAMES) {
    for (const kind of ["before", "after"]) {
      photos.push({
        id: `${room}-${kind}`,
        room,
        kind,
        storage_path: `visits/${VISIT_ID}/${room}/${kind}.jpg`,
        note: null,
        created_at: "2026-11-13T10:00:00.000Z",
      });
    }
  }
  return photos;
}

function seededChecklist() {
  return { rooms: buildWorkRooms({ deep: false }) };
}

describe("MA-03 effectiveChecklist (server seed)", () => {
  it("seeds the standard scope when the stored checklist is null", () => {
    const out = effectiveChecklist({ checklist: null, service: "Standard cleaning" });
    expect(out.rooms.map((r) => r.name)).toEqual(SEEDED_NAMES);
    expect(SEEDED_NAMES).toEqual(["Kitchen", "Bathrooms", "Bedrooms", "Living room"]);
  });

  it("seeds the standard scope when the stored checklist has no rooms", () => {
    const out = effectiveChecklist({ checklist: { rooms: [] }, service: "Standard cleaning" });
    expect(out.rooms.map((r) => r.name)).toEqual(SEEDED_NAMES);
  });

  it("returns the stored checklist unchanged when it has rooms", () => {
    const stored = scopeChecklist();
    expect(effectiveChecklist({ checklist: stored, service: "Standard cleaning" })).toBe(stored);
  });

  it("a deep service seeds the deep tasks", () => {
    const out = effectiveChecklist({ checklist: null, service: "Deep cleaning" });
    const kitchen = out.rooms.find((r) => r.name === "Kitchen");
    expect(kitchen?.items.map((i) => i.label)).toContain("Inside oven cleaned");
  });
});

describe("MA-03 legacy row without a checklist (handler)", () => {
  beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("GET returns the seeded checklist, not { rooms: [] }", async () => {
    const env = installEnv({ row: { checklist: null } });
    const r = await env.get();
    expect(r.code).toBe(200);
    const checklist = r.body["checklist"] as { rooms: Array<{ name: string }> };
    expect(checklist.rooms.map((room) => room.name)).toEqual(SEEDED_NAMES);
  });

  it("GET seeds when the stored checklist is an empty room list", async () => {
    const env = installEnv({ row: { checklist: { rooms: [] } } });
    const r = await env.get();
    expect(r.code).toBe(200);
    const checklist = r.body["checklist"] as { rooms: Array<{ name: string }> };
    expect(checklist.rooms.map((room) => room.name)).toEqual(SEEDED_NAMES);
  });

  it("submit with no body checklist and no photos is 400 rooms_incomplete, never 500", async () => {
    const env = installEnv({ row: { checklist: null } });
    const r = await env.call({ action: "submit" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("rooms_incomplete");
    expect(r.body["missing"]).toEqual(SEEDED_NAMES);
  });

  it("submit with an explicit empty checklist is 400 rooms_incomplete, never 500", async () => {
    const env = installEnv({ row: { checklist: null } });
    const r = await env.call({ action: "submit", checklist: { rooms: [] } });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("rooms_incomplete");
    expect(r.body["missing"]).toEqual(SEEDED_NAMES);
  });

  it("submit with no body checklist but photos for every seeded room publishes and heals the row", async () => {
    const env = installEnv({ row: { checklist: null }, photos: seededPhotos() });
    const r = await env.call({ action: "submit" });
    expect(r.code).toBe(200);
    expect(r.body["published"]).toBe(true);
    const stored = env.rows[0]["checklist"] as { rooms: Array<{ name: string }>; submitted_at?: string };
    expect(stored.rooms.map((room) => room.name)).toEqual(SEEDED_NAMES);
    expect(typeof stored.submitted_at).toBe("string");
    // The CAS wrote report_status "submitted"; auto-publish then moved
    // it to "sent" — the journal keeps the submission itself.
    expect(env.rows[0]["report_status"]).toBe("sent");
    expect(env.events.some((e) => e.event === "report_submitted")).toBe(true);
  });

  it("submit with the GET-seeded checklist (the UI flow) publishes", async () => {
    const env = installEnv({ row: { checklist: null }, photos: seededPhotos() });
    const got = await env.get();
    expect(got.code).toBe(200);
    const r = await env.call({ action: "submit", checklist: (got.body["checklist"] as unknown) });
    expect(r.code).toBe(200);
    expect(r.body["published"]).toBe(true);
  });

  it("a checklist save with the seeded rooms heals the row", async () => {
    const env = installEnv({ row: { checklist: null } });
    const r = await env.call({ action: "checklist", checklist: seededChecklist() });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    const stored = env.rows[0]["checklist"] as { rooms: Array<{ name: string }> };
    expect(stored.rooms.map((room) => room.name)).toEqual(SEEDED_NAMES);
  });

  it("photo_sign accepts a seeded room on a legacy row; an invented room is still rejected", async () => {
    const env = installEnv({ row: { checklist: null } });
    // Storage is unmocked in this harness, so a room that passes
    // validation reaches the sign call and fails there (502) — the
    // assertion that matters is that it is NOT invalid_room.
    const seeded = await env.call({ action: "photo_sign", room: "Kitchen", kind: "before" });
    expect(seeded.body["error"]).not.toBe("invalid_room");
    const invented = await env.call({ action: "photo_sign", room: "Secret attic", kind: "before" });
    expect(invented.code).toBe(400);
    expect(invented.body["error"]).toBe("invalid_room");
  });

  it("photo_register accepts a seeded room on a legacy row; an invented room is still rejected", async () => {
    const env = installEnv({ row: { checklist: null } });
    const path = `visits/${VISIT_ID}/kitchen/20261113-abc1234.jpg`;
    // As with photo_sign, unmocked Storage fails the byte check
    // (invalid_photo_file) — after the room passed validation.
    const seeded = await env.call({ action: "photo_register", room: "Kitchen", kind: "before", storage_path: path });
    expect(seeded.body["error"]).not.toBe("invalid_room");
    const invented = await env.call({ action: "photo_register", room: "Secret attic", kind: "before", storage_path: path });
    expect(invented.code).toBe(400);
    expect(invented.body["error"]).toBe("invalid_room");
  });

  it("regression: a normal row with a stored checklist still submits as before", async () => {
    const env = installEnv({ photos: makePhotos() });
    const r = await env.call({ action: "submit", checklist: scopeChecklist() });
    expect(r.code).toBe(200);
    expect(r.body["published"]).toBe(true);
  });
});

describe("MA-03 empty checklist never enables Finish (UI)", () => {
  const emptyView = () => ({
    ok: true, confirmed: true, editable: true, report_status: "draft", owner_note: null,
    visit: { service: "Standard", date: "2026-11-10", window: "morning", address: "1 Test Street", client_first_name: "Casey", no_photo_zones: null },
    checklist: { rooms: [] },
    photos: [],
  });
  let posts: Record<string, unknown>[];

  beforeEach(() => {
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/cleaner?") && !init?.method) {
        return { ok: true, json: async () => emptyView() };
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      posts.push(body);
      return { ok: true, json: async () => ({ ok: true }) };
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const open = () =>
    render(
      createElement(StrictMode, null,
        createElement(HelmetProvider, null,
          createElement(MemoryRouter, { initialEntries: ["/cleaner?ct=test-cleaner-token"] },
            createElement(Cleaner),
          ),
        ),
      ),
    );

  it("a GET with { rooms: [] } blocks Finish and explains the state instead of showing an empty screen", async () => {
    open();
    const finish = await screen.findByRole("button", { name: "Finish & send report" });
    expect(finish).toBeDisabled();
    expect(screen.getByText(/No rooms listed for this visit yet/)).toBeInTheDocument();
    expect(screen.queryByText("Everything is ready — Finish will send the report.")).not.toBeInTheDocument();
    expect(screen.queryByText("Rooms ready: 0 of 0")).not.toBeInTheDocument();
    fireEvent.click(finish);
    expect(posts.filter((p) => p.action === "submit")).toHaveLength(0);
  });
});
