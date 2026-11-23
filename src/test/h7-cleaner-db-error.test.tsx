// H7 (cleaner page): a DB outage must not tell the cleaner their
// link is bad. A db_unavailable load failure shows "We couldn't load
// this visit" with a retry — never "This link doesn't work".
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import Cleaner from "@/pages/Cleaner";

vi.mock("@/lib/imageConvert", () => ({ convertToJpeg: async () => new Blob(["fixture"], { type: "image/jpeg" }) }));

let loadError: string;

beforeEach(() => {
  loadError = "db_unavailable";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).startsWith("/api/cleaner?")) {
      return { ok: false, json: async () => ({ ok: false, error: loadError }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const open = () => render(
  <StrictMode><HelmetProvider><MemoryRouter initialEntries={["/cleaner?ct=test-cleaner-token-1234567890"]}><Cleaner /></MemoryRouter></HelmetProvider></StrictMode>,
);

describe("cleaner page DB-error state", () => {
  it("shows a retryable 'couldn't load' message for db_unavailable, not 'link doesn't work'", async () => {
    open();
    expect(await screen.findByRole("heading", { name: "We couldn't load this visit" })).toBeInTheDocument();
    expect(screen.getByText(/Something went wrong on our side — your link is fine/)).toBeInTheDocument();
    expect(screen.queryByText(/This link doesn't work/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("offers retry after starting offline and opens the same assignment after reconnect", async () => {
    let offline = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(String(url)).toContain("ct=test-cleaner-token-1234567890");
      if (offline) throw new Error("Disconnected");
      return { ok: true, json: async () => ({
        ok: true, visit: { date: "2026-01-01", service: "Standard cleaning", client_first_name: "Casey" },
        checklist: { rooms: [] }, photos: [], report_status: "draft", editable: true, confirmed: true,
      }) };
    }));
    open();
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByText("This link doesn't work")).not.toBeInTheDocument();
    offline = false;
    fireEvent.click(retry);
    expect(await screen.findByRole("heading", { name: "Your cleaning job" })).toBeInTheDocument();
  });

  it("still shows 'This link doesn't work' for a genuinely invalid link", async () => {
    loadError = "invalid_link";
    open();
    expect(await screen.findByRole("heading", { name: "This link doesn't work" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});
