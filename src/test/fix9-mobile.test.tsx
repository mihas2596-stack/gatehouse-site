import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import MobileStickyCTA from "@/components/MobileStickyCTA";
import Layout from "@/components/Layout";
import ReportShowcase from "@/components/ReportShowcase";
import Services from "@/pages/Services";

// Pinned past the global test-price window so price rendering stays
// deterministic (same pin as the fix7/fix8 suites).
vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-14T00:00:00Z"));
vi.mock("@/components/SEO", () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const pill = () => screen.queryByRole("link", { name: "Plan My Cleaning" });

describe("fix9 — mobile walkthrough fixes", () => {
  it("sticky pill stays on focus of button/summary, hides on focus of a real field", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <div>
          <button type="button">Tap me</button>
          <details>
            <summary>FAQ question</summary>
            <p>Answer</p>
          </details>
          <label>
            Your name
            <input type="text" />
          </label>
          <MobileStickyCTA />
        </div>
      </MemoryRouter>,
    );

    expect(pill()).toBeInTheDocument();

    // A tap on a button or an accordion summary is not typing: the pill
    // must stay (before fix9 it vanished and never came back).
    fireEvent.focusIn(screen.getByRole("button", { name: "Tap me" }));
    expect(pill()).toBeInTheDocument();
    fireEvent.focusIn(screen.getByText("FAQ question"));
    expect(pill()).toBeInTheDocument();

    // A real keyboard field hides the pill while the keyboard is up…
    fireEvent.focusIn(screen.getByLabelText("Your name"));
    expect(pill()).not.toBeInTheDocument();

    // …and it comes back when the field loses focus.
    fireEvent.focusOut(screen.getByLabelText("Your name"));
    expect(pill()).toBeInTheDocument();
  });

  it("sticky-pill spacer lives inside the footer, not after it", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<div>home</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const footer = screen.getByRole("contentinfo");
    const spacer = footer.querySelector("div.h-20");
    expect(spacer).not.toBeNull();
    expect(spacer).toHaveAttribute("aria-hidden", "true");
    // The old dead band: a spacer as a direct child of the page shell,
    // after the footer, on the page background.
    expect(document.querySelector("div.min-h-screen > div.h-20")).toBeNull();
  });

  it("sample-report badge is short and keeps the demo meaning", () => {
    render(<ReportShowcase />);
    expect(screen.getByText("SAMPLE — DEMO ONLY")).toBeInTheDocument();
    expect(screen.queryByText(/not a real report/i)).not.toBeInTheDocument();
  });

  it("services compare section keeps desktop padding, trims mobile bottom padding", () => {
    render(
      <MemoryRouter>
        <Services />
      </MemoryRouter>,
    );
    const section = screen.getByText("Compare services and add-ons").closest("section");
    expect(section).not.toBeNull();
    expect(section!.classList.contains("pt-8")).toBe(true);
    expect(section!.classList.contains("pb-4")).toBe(true);
    expect(section!.classList.contains("md:py-8")).toBe(true);
    expect(section!.classList.contains("py-8")).toBe(false);
  });
});
