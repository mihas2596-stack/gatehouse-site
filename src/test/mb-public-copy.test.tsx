import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Quote from "@/pages/Quote";
import Terms from "@/pages/Terms";
import Services from "@/pages/Services";
import WhatsIncluded from "@/pages/WhatsIncluded";
import SaveCard from "@/pages/SaveCard";
import ThankYou from "@/pages/ThankYou";
import { FAQS } from "@/config/faqs";
import { CHECKLIST } from "@/config/checklist";
import * as calculator from "@/config/calculator";
import { FULL_BATH_CHOICES, priceBreakdown } from "@/config/calculator";
import { buildWorkRooms } from "../../api/_work_scope";

// Pinned past the global test-price window so regular-price assertions
// stay deterministic (same pin as quote-steps.test.tsx).
vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-21T00:00:00Z"));
vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/measurement", () => ({ campaignAttribution: () => ({}), trackFunnel: () => true }));

beforeEach(() => {
  try {
    sessionStorage.removeItem("gh_quote_draft_v1");
    sessionStorage.removeItem("gh_test_pricing");
  } catch { /* private mode */ }
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const openQuote = () => render(<MemoryRouter><Quote /></MemoryRouter>);
const goToStep2 = () => {
  openQuote();
  fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
  expect(screen.getByRole("heading", { name: "Your visit" })).toBeInTheDocument();
};

describe("MB-25 — social meta promises no fixed recurring slot", () => {
  it("og/twitter descriptions drop 'Same day, same time'", () => {
    const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
    expect(html).not.toContain("Same day, same time");
    expect(html).toContain("Every-other-week house cleaning in Sugar Hill");
  });
});

describe("MB-26 — Terms §7 points damage claims at §10.2 (48h)", () => {
  it("§7 names the 48-hour damage-claims window", () => {
    render(<MemoryRouter><Terms /></MemoryRouter>);
    // "Report Property Damage" appears in §7 and §10.2; the 48h
    // window wording lives in §7.
    expect(screen.getAllByText(/Report Property Damage/).length).toBe(2);
    expect(screen.getAllByText(/within 48 hours of service completion/).length).toBe(2);
  });
});

describe("MB-28 — State accepts 'Georgia' and normalizes to GA", () => {
  it("typing Georgia stores GA and passes validation", () => {
    goToStep2();
    const state = screen.getByLabelText("State *") as HTMLInputElement;
    fireEvent.change(state, { target: { value: "Georgia" } });
    expect(state).toHaveValue("GA");
    fireEvent.change(state, { target: { value: "georgia" } });
    expect(state).toHaveValue("GA");
  });

  it("a full step-2 fill with 'Georgia' reaches review with no state error", () => {
    goToStep2();
    for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["City *", "Sugar Hill"], ["State *", "Georgia"], ["Preferred date *", "2099-12-01"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("radio", { name: /I’ll be home/ }));
    fireEvent.click(screen.getByLabelText(/I agree to photos of the cleaned rooms/));
    fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
    expect(screen.getByRole("heading", { name: "Your request" })).toBeInTheDocument();
    expect(screen.queryByText(/We currently serve Georgia only/)).not.toBeInTheDocument();
  });
});

describe("LB-21 — Terms §5.3 late fee is gone, numbering kept", () => {
  it("§5.3 says no late fees apply and 1.5% appears nowhere", () => {
    render(<MemoryRouter><Terms /></MemoryRouter>);
    expect(screen.getByText("No late fees apply.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("1.5%");
    expect(screen.getByText("5.3 Late Payment.")).toBeInTheDocument();
    // Neighbouring sections keep their numbers (no renumbering).
    expect(screen.getByText("5.4 Chargebacks.")).toBeInTheDocument();
  });
});

describe("LB-22 — out-of-area ZIP wins over large-home custom quote", () => {
  it("a 6-bedroom home outside the area sees the out-of-area message, not 'Email us for a price'", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "90210" } });
    expect(screen.getAllByText(/We don't serve this ZIP yet/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Email us for a price")).not.toBeInTheDocument();
  });
});

describe("LB-23 — 6 full bathrooms is selectable and reaches the custom quote", () => {
  it("FULL_BATH_CHOICES includes 6 and 6 baths in-area shows the custom quote", () => {
    expect(FULL_BATH_CHOICES).toContain(6);
    openQuote();
    fireEvent.change(screen.getByLabelText("Full bathrooms"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    expect(screen.getByText("Email us for a price")).toBeInTheDocument();
    expect(screen.getByText(/get a custom quote/)).toBeInTheDocument();
  });
});

describe("LB-24 — half-bath price note on step 1", () => {
  it("states under the half-bath selector that half baths don't change the price", () => {
    openQuote();
    expect(screen.getByText("Half bathrooms don't change your price.")).toBeInTheDocument();
  });
});

describe("LB-28 — add-on prices carry the $ sign", () => {
  it("Services comparison shows +$35 / +$45 / +$8, never bare numbers", () => {
    render(<MemoryRouter><Services /></MemoryRouter>);
    // Table rows + mobile cards render the same comparison data.
    expect(screen.getAllByText("Add-on +$35 per visit")).toHaveLength(4);
    expect(screen.getAllByText("Add-on +$45 per visit")).toHaveLength(2);
    expect(screen.getAllByText("Add-on +$8 per window")).toHaveLength(6);
    expect(document.body.textContent).not.toMatch(/Add-on \+35 per visit/);
    expect(document.body.textContent).not.toMatch(/Add-on \+8 per window/);
  });

  it("WhatsIncluded add-ons show +$35 / +$45 / +$8", () => {
    render(<MemoryRouter><WhatsIncluded /></MemoryRouter>);
    expect(screen.getAllByText("+$35 per visit")).toHaveLength(2); // oven + fridge
    expect(screen.getByText("+$45 per visit")).toBeInTheDocument();
    expect(screen.getByText("+$8 per window")).toBeInTheDocument();
  });
});

describe("LB-29 — /save-card formats the visit price to two decimals", () => {
  it("a server '1.5' renders as $1.50, never $1.5", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, booking: { first: "1.5", service: "Standard", date: "2026-11-15" } }),
    }));
    render(<MemoryRouter initialEntries={["/save-card?bt=v2.test-token"]}><SaveCard /></MemoryRouter>);
    // $1.50 now renders twice: the booking summary and the payment
    // summary's pinned visit price (spec 2.1) — both two decimals.
    expect((await screen.findAllByText("$1.50")).length).toBe(2);
    expect(screen.queryByText("$1.5")).not.toBeInTheDocument();
  });
});

describe("LB-31 — copy: custom quote, arrange entry, no doubled 'again'", () => {
  it("ThankYou no longer doubles 'again'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: true, booking: null }) }));
    render(
      <MemoryRouter initialEntries={[{ pathname: "/thank-you", state: { submitted: true, kind: "booking", bt: "v2.test-token" } }]}>
        <ThankYou />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Check again before entering your card\./)).toBeInTheDocument();
    expect(screen.queryByText(/entering your card again/)).not.toBeInTheDocument();
  });
});

describe("LB-33 — dead pricing branches are gone", () => {
  it("firstVisitPrice no longer exists; priceBreakdown is always standard-first", () => {
    expect("firstVisitPrice" in calculator).toBe(false);
    const b = priceBreakdown({ bedrooms: 3, fullBaths: 2, frequency: "every2weeks", addons: { insideOven: true } });
    expect(b!.first_service).toBe("standard");
    expect(b!.first_total).toBe(224);
  });

  it("ThankYou still honors the SERVER first_service, not a dead plan flag", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, booking: { first: "21.9", first_service: "deep", service: "Standard Cleaning", date: "2026-11-08", has_card: "1", card_confirmed: "1" } }),
    }));
    render(
      <MemoryRouter initialEntries={[{ pathname: "/thank-you", state: { submitted: true, kind: "booking", bt: "v2.test-token", plan: { service: "Standard Cleaning", first: 21.9, recurring: null } } }]}>
        <ThankYou />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Request received/)).toBeInTheDocument();
    expect(screen.getByText(/First visit: Deep clean/)).toBeInTheDocument();
  });
});

describe("LB-34 — visit-duration FAQ no longer states an unmeasured 2–4 hours", () => {
  it("the duration answer contains no hour claim", () => {
    const duration = FAQS.find((f) => f.q === "How long does a visit take?");
    expect(duration?.a).not.toContain("2–4 hours");
    expect(duration?.a).toContain("arrival window");
  });
});

describe("LB-35 — public checklist matches buildWorkRooms room names", () => {
  it("rooms are Kitchen, Bathroom, Half bathroom, Bedroom, Living room, Additional agreed work", () => {
    expect(CHECKLIST.map((r) => r.room)).toEqual([
      "Kitchen", "Bathroom", "Half bathroom", "Bedroom", "Living room", "Additional agreed work",
    ]);
    const half = CHECKLIST.find((r) => r.room === "Half bathroom")!;
    expect(half.tasks.join(" ")).not.toMatch(/Tub|Shower/);
    const kitchen = CHECKLIST.find((r) => r.room === "Kitchen")!;
    expect(kitchen.tasks.some((t) => t.startsWith("Inside oven cleaned"))).toBe(true);
    expect(kitchen.tasks.some((t) => t.startsWith("Inside fridge cleaned"))).toBe(true);
    expect(kitchen.tasks.some((t) => t.startsWith("Inside cabinets cleaned"))).toBe(true);
  });

  it("every public room name is a real buildWorkRooms name (or its singular base)", () => {
    const built = buildWorkRooms({
      bedrooms: "2", fullBaths: "2", halfBaths: "1", deep: true,
      addons: { interiorWindows: 2, pets: true },
    }).map((r) => r.name);
    for (const { room } of CHECKLIST) {
      expect(built.includes(room) || built.includes(`${room} 1`)).toBe(true);
    }
  });
});

describe("LB-36 — Services comparison is open by default", () => {
  it("the details element carries the open attribute, so table and mobile cards render at once", () => {
    render(<MemoryRouter><Services /></MemoryRouter>);
    const details = document.querySelector("details");
    expect(details?.hasAttribute("open")).toBe(true);
    expect(screen.getAllByText("Inside oven")).toHaveLength(4); // table row + one per mobile card
  });
});

describe("LB-37 — extras toggle has visible Show/Hide text", () => {
  it("reads 'Show extras' closed and 'Hide extras' open", () => {
    openQuote();
    const toggle = screen.getByRole("button", { name: /Show extras/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /Hide extras/ })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("LB-38 — dead .quote-price-bar CSS is gone; mobile padding only with the sticky bar", () => {
  it("index.css has no quote-price-bar rule and scopes main padding to the mounted bar", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    expect(css).not.toContain("quote-price-bar");
    expect(css).toContain('body:has(nav[aria-label="Quick action"]) main');
  });
});

describe("ChatGPT round 3 lows — ZIP example and spaces; date field labelled", () => {
  it("a partial ZIP hint shows an example (30518, a real service ZIP)", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "305" } });
    expect(screen.getByText(/Enter a 5-digit ZIP code, e\.g\. 30518\./)).toBeInTheDocument();
  });

  it("spaces in the ZIP are stripped, so '305 18' becomes 30518", () => {
    openQuote();
    const zip = screen.getByLabelText("ZIP code (service area check)") as HTMLInputElement;
    fireEvent.change(zip, { target: { value: "305 18" } });
    expect(zip).toHaveValue("30518");
    expect(screen.getByText(/We clean homes in 30518/)).toBeInTheDocument();
  });

  it("the date field is a labelled native date input with a min — not an unlabelled picker", () => {
    goToStep2();
    const date = screen.getByLabelText("Preferred date *") as HTMLInputElement;
    expect(date.getAttribute("type")).toBe("date");
    expect(date.getAttribute("min")).toBeTruthy();
  });
});
