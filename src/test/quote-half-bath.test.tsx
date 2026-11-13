import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Quote from "@/pages/Quote";
import { buildWorkRooms } from "../../api/_work_scope";
import { calcPrice, priceBreakdown } from "@/config/calculator";

// Owner order 2026-10-24 runs a GLOBAL test-price window (until
// 2026-11-18T20:59:59Z after the extensions). Pin the clock past the
// window so regular-price assertions stay deterministic.
vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T00:00:00Z"));
vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(cleanup);

const openQuote = () => render(<MemoryRouter><Quote /></MemoryRouter>);

const fillStep2 = () => {
  for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["City *", "Sugar Hill"], ["State *", "GA"], ["Preferred date *", "2099-12-01"]]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole("radio", { name: /I’ll be home/ }));
  fireEvent.click(document.getElementById("b-photo")!);
};

describe("half bathrooms", () => {
  it("shows a Half bathrooms selector (0, 1, 2) next to Full bathrooms, default 0", () => {
    sessionStorage.removeItem("gh_quote_draft_v1");
    openQuote();
    const select = screen.getByLabelText("Half bathrooms") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue("0");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["0", "1", "2"]);
    // Same step-1 row as the other home-size selects.
    expect(screen.getByLabelText("Full bathrooms")).toBeInTheDocument();
    expect(screen.getByLabelText("Bedrooms")).toBeInTheDocument();
    sessionStorage.removeItem("gh_quote_draft_v1");
  });

  it("price is identical with 0 vs 2 half-baths (half baths never price)", () => {
    sessionStorage.removeItem("gh_quote_draft_v1");
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    expect(screen.getByText("First visit (Standard): $189")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Half bathrooms"), { target: { value: "1" } });
    expect(screen.getByText("First visit (Standard): $189")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Half bathrooms"), { target: { value: "2" } });
    expect(screen.getByText("First visit (Standard): $189")).toBeInTheDocument();
    // And the step-2 summary names the half baths without repricing.
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByText(/2 half bath/)).toBeInTheDocument();
    expect(screen.getByText(/First visit \$189, then \$189 per visit/)).toBeInTheDocument();
    sessionStorage.removeItem("gh_quote_draft_v1");
  });

  it("price functions take only bedrooms + full baths — no half-bath input exists", () => {
    const addons = { insideOven: false, insideFridge: false, insideCabinets: false, interiorWindows: 0, pets: false };
    const oneTime = calcPrice({ bedrooms: 3, fullBaths: 2, service: "standard", frequency: "onetime", addons, testScale: false });
    const recurring = priceBreakdown({ bedrooms: 3, fullBaths: 2, frequency: "every2weeks", addons, testScale: false });
    expect(oneTime).toBe(219);
    expect(recurring?.first_total).toBe(189);
    // There is no half-bath parameter to pass: the same call is the
    // only call, so no half-bath value can change the result.
  });

  it("draft save/restore keeps the half-bath choice across reload", () => {
    sessionStorage.removeItem("gh_quote_draft_v1");
    const first = openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.change(screen.getByLabelText("Half bathrooms"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    first.unmount();

    openQuote();
    expect(screen.getByRole("heading", { name: "Your visit" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to price" }));
    expect(screen.getByLabelText("Half bathrooms")).toHaveValue("2");
    sessionStorage.removeItem("gh_quote_draft_v1");
  });

  it("submits half_baths to the server alongside full_baths", async () => {
    sessionStorage.removeItem("gh_quote_draft_v1");
    Element.prototype.scrollIntoView = vi.fn();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
      return { ok: true, json: async () => ({ ok: true, customerEmailSent: true, bt: "bt-test" }) };
    }));
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.change(screen.getByLabelText("Half bathrooms"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    fillStep2();
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    // Step 3 names the half baths in the home summary.
    expect(screen.getByText(/2 half bathrooms/)).toBeInTheDocument();
    fireEvent.click(document.getElementById("b-terms")!);
    fireEvent.click(screen.getByRole("button", { name: "Continue to Stripe — $0 today" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/send-contact-email")).toBe(true);
    });
    const sent = calls.find((c) => c.url === "/api/send-contact-email")!.body;
    expect(sent["half_baths"]).toBe("2");
    expect(sent["full_baths"]).toBe("2");
    expect(sent["bathrooms"]).toBe("2");
    expect(String(sent["message"] ?? "")).toContain("2 half BA");
    vi.unstubAllGlobals();
    sessionStorage.removeItem("gh_quote_draft_v1");
  });

  it("two half-baths become two cleaner-checklist rooms (no tub/shower); zero becomes none", () => {
    const two = buildWorkRooms({ bedrooms: "3", fullBaths: "2", halfBaths: "2", deep: false });
    const halfRooms = two.filter((r) => r.name.startsWith("Half bathroom"));
    expect(halfRooms.map((r) => r.name)).toEqual(["Half bathroom 1", "Half bathroom 2"]);
    for (const r of halfRooms) {
      expect(r.items.some((i) => /Tub|Shower/.test(i.label))).toBe(false);
      expect(r.items.some((i) => i.label.includes("Toilet cleaned"))).toBe(true);
    }
    const zero = buildWorkRooms({ bedrooms: "3", fullBaths: "2", halfBaths: "0", deep: false });
    expect(zero.some((r) => r.name.startsWith("Half bathroom"))).toBe(false);
    const unset = buildWorkRooms({ bedrooms: "3", fullBaths: "2", deep: false });
    expect(unset.some((r) => r.name.startsWith("Half bathroom"))).toBe(false);
  });
});
