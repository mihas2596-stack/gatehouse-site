import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import SEO from "@/components/SEO";

// Separate file: the audit test file mocks SEO to null, so the real
// component's meta output is verified here instead.
// Note: react-helmet-async writes to <head> asynchronously (via
// requestAnimationFrame), so the assertions wait for the tags to land.
afterEach(cleanup);

describe("SEO robots + og:image (Claude M2 / 3a)", () => {
  it("emits noindex, nofollow and the www og:image for cabinet pages", async () => {
    render(
      <HelmetProvider>
        <SEO title="Your visit" description="Visit" url="https://gatehousehomecleaning.com/visit" noindex />
      </HelmetProvider>
    );
    await waitFor(() => {
      expect(document.querySelector('meta[name="robots"]')).not.toBeNull();
    });
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
    expect(document.querySelector('meta[property="og:image"]')?.getAttribute("content")).toBe("https://www.gatehousehomecleaning.com/og-image.png");
  });

  it("keeps index, follow for public pages", async () => {
    render(
      <HelmetProvider>
        <SEO title="Home" description="Home" url="https://gatehousehomecleaning.com/" />
      </HelmetProvider>
    );
    await waitFor(() => {
      expect(document.querySelector('meta[name="robots"]')).not.toBeNull();
    });
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("index, follow");
  });
});
