import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import Quote from "@/pages/Quote";
import Index from "@/pages/Index";
import Contact from "@/pages/Contact";
import Services from "@/pages/Services";
import Terms from "@/pages/Terms";
import SaveCard from "@/pages/SaveCard";
import { FAQS } from "@/config/faqs";
import { CITIES } from "@/config/cities";
import { earliestServiceDate } from "@/config/service-area";

// Pinned past the global test-price window so regular-price assertions
// stay deterministic. earliestServiceDate() reads the real clock, so the
// expected earliest-visit date is computed from it, not from Date.now.
vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-14T00:00:00Z"));
vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/measurement", () => ({ campaignAttribution: () => ({}), trackFunnel: () => true }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const openQuote = () => render(<MemoryRouter><Quote /></MemoryRouter>);

const fillStep2 = () => {
  for (const [label, value] of [["Your name *", "Test Person"], ["Email *", "test@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Test Street"], ["City *", "Sugar Hill"], ["State *", "GA"], ["Preferred date *", "2099-12-01"]]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole("radio", { name: /I’ll be home/ }));
  fireEvent.click(screen.getByLabelText(/I agree to photos of the cleaned rooms/));
};

const goToStep3 = () => {
  openQuote();
  fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
  fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
  fillStep2();
  fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
};

describe("fix7 — UX audit fixes", () => {
  it("step 1 shows the earliest visit date next to the price", () => {
    openQuote();
    const iso = earliestServiceDate();
    const expected = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    expect(screen.getByText(`Earliest visit: ${expected}`)).toBeInTheDocument();
  });

  it("step 1: How often is two cards, not a select", () => {
    openQuote();
    expect(screen.queryByRole("combobox", { name: "How often" })).not.toBeInTheDocument();
    const recurring = screen.getByRole("radio", { name: "Every other week" });
    const onetime = screen.getByRole("radio", { name: "One-time" });
    expect(recurring).toHaveAttribute("aria-checked", "true");
    fireEvent.click(onetime);
    expect(onetime).toHaveAttribute("aria-checked", "true");
    expect(recurring).toHaveAttribute("aria-checked", "false");
  });

  it("step 1: Deep card has its own icon tagline and a compare link", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Deep/ }));
    expect(screen.getByText("A detailed first-time clean for homes that haven't been professionally cleaned recently.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Compare with a standard clean" });
    expect(link.getAttribute("href")).toBe("/services");
  });

  it("step 1: extras button shows the selection state with a chevron", () => {
    openQuote();
    const btn = () => screen.getByRole("button", { name: /Add extras \(optional\) —/ });
    expect(btn().textContent).toMatch(/None selected/);
    fireEvent.click(btn());
    expect(btn().textContent).toMatch(/⌃/);
    fireEvent.click(screen.getByLabelText(/Inside oven/));
    expect(btn().textContent).toMatch(/Inside oven/);
    expect(btn().textContent).not.toMatch(/None selected/);
  });

  it("step 2 omits the optional home planning block and SMS opt-in", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.queryByText("More about your home (optional)")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Text me booking updates/ })).not.toBeInTheDocument();
  });

  it("step 2: Notes warns against door codes", () => {
    openQuote();
    fireEvent.change(screen.getByLabelText("ZIP code (service area check)"), { target: { value: "30024" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
    expect(screen.getByText("Please don't put door codes or key details here — you'll add them privately on your confirmed visit page.")).toBeInTheDocument();
  });

  it("step 3: arbitration opt-out note and Stripe button", () => {
    goToStep3();
    expect(screen.getByText("Binding arbitration means disputes are resolved outside court. You can opt out within 30 days — see Terms, Section 16.5.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to Stripe — $0 today" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue to save card/ })).not.toBeInTheDocument();
  });

  it("home page: How it works 02/03, city line, single CTA wording", () => {
    render(<HelmetProvider><MemoryRouter><Index /></MemoryRouter></HelmetProvider>);
    expect(screen.getByText("We’ll email you to confirm your date, arrival window and who’s coming.")).toBeInTheDocument();
    expect(screen.getByText("Get a private photo report and checklist after the visit.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check our service area" })).toBeInTheDocument();
    expect(document.getElementById("when-you-pay")).not.toBeNull();
    const ctas = screen.getAllByRole("link", { name: "See My Price" });
    expect(ctas).toHaveLength(2);
    for (const cta of ctas) expect(cta.getAttribute("href")).toBe("/quote");
    expect(screen.getByText("No email or card needed to see your price.")).toBeInTheDocument();
  });

  it("FAQ data: 2–4 hour estimate and always-free rescheduling", () => {
    const duration = FAQS.find((f) => f.q === "How long does a visit take?");
    expect(duration?.a).toContain("Most standard visits take 2–4 hours, depending on your home's size. A deep or move-in/out clean takes longer.");
    const cancel = FAQS.find((f) => f.q === "How do I pause or cancel?");
    expect(cancel?.a).toContain("Rescheduling is always free.");
    expect(cancel?.a).toContain("later cancellations cost $25");
    const cost = FAQS.find((f) => f.q === "How much does it cost?");
    expect(cost?.a).toContain("Homes with 6+ bedrooms or 6+ full bathrooms");
  });

  it("Terms §6: rescheduling is free at any time, $25 is cancellation only", () => {
    render(<MemoryRouter><Terms /></MemoryRouter>);
    expect(screen.getByText("Rescheduling:")).toBeInTheDocument();
    expect(screen.getByText("free at any time.")).toBeInTheDocument();
    expect(screen.queryByText(/Free cancellation or rescheduling/)).not.toBeInTheDocument();
  });

  it("city pages: payment repeat shortened to one line with a link", () => {
    const duluth = CITIES.find((c) => c.slug === "duluth")!;
    const access = duluth.sections.find((s) => s.heading === "Access and payment")!;
    expect(access.text).toContain("Nothing is charged at booking.");
    expect(access.text).not.toContain("automatically 24 hours");
    expect(access.link).toEqual({ href: "/#when-you-pay", label: "See how payment works" });
    const alpharetta = CITIES.find((c) => c.slug === "alpharetta")!;
    const price = alpharetta.sections.find((s) => s.heading === "Price and booking")!;
    expect(price.text).toContain("Nothing is charged at booking.");
    expect(price.text).not.toContain("automatically 24 hours");
    expect(price.link).toEqual({ href: "/#when-you-pay", label: "See how payment works" });
    const roswell = CITIES.find((c) => c.slug === "roswell")!;
    expect(roswell.sections[0].text).toContain("For homes with 6+ bedrooms or 6+ full bathrooms, email us for a custom quote.");
  });

  it("Services cards explain that the exact price depends on bedrooms and bathrooms", () => {
    render(<MemoryRouter><Services /></MemoryRouter>);
    expect(screen.getAllByText(/your exact price depends on bedrooms and bathrooms\./)).toHaveLength(4);
    expect(screen.getByText("From $149 per visit — your exact price depends on bedrooms and bathrooms.")).toBeInTheDocument();
  });

  it("Contact: no privacy checkbox, one reply-time line, map caption, submit works", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ ok: true, customerEmailSent: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><Contact /></MemoryRouter>);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/By sending this message you agree to our/)).toBeInTheDocument();
    expect(screen.getAllByText(/We reply within one business day\./)).toHaveLength(1);
    expect(screen.getByText("Service area — we come to you; there is no walk-in office.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Your Name *"), { target: { value: "Test Person" } });
    fireEvent.change(screen.getByLabelText("Email Address *"), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText("Your Message *"), { target: { value: "Hello?" } });
    fireEvent.click(screen.getByRole("button", { name: /Send My Question/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    const body = JSON.parse(String(init?.body));
    expect(body.name).toBe("Test Person");
    expect(body.email).toBe("test@example.com");
  });

  it("SaveCard: standalone save shows the unified one-line status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: true, verified: true, status: "saved", booking: null }) }));
    render(<MemoryRouter initialEntries={["/save-card?saved=1&session_id=cs_test_audit"]}><SaveCard /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Card saved — $0 charged today" });
    expect(screen.getByText(/Card: saved ✓ · Visit: not requested yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Your date is awaiting confirmation/)).toBeNull();
  });
});
