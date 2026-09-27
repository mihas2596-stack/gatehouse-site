import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

/**
 * Visual regression: no large empty whitespace gap between the hero section
 * and the first content section on /about and /contact. A missing photo or
 * unrendered placeholder used to leave ~120px+ of dead space under the hero;
 * this test pins the gap below a sane threshold and saves a top-of-page
 * screenshot as evidence on failure.
 */

const MAX_GAP_PX = 80;
const OUT_DIR = path.join(process.cwd(), "test-results", "hero-gap");

async function measureGapBelowHero(page: Page): Promise<{ gap: number; heroBottom: number; nextTop: number }> {
  return await page.evaluate(() => {
    // Hero = the <section> that contains the page's <h1>. Layout wrappers
    // (header, sticky CTA, etc.) may also render <section> elements, so we
    // can't blindly take document.querySelector("section").
    const h1 = document.querySelector("h1");
    if (!h1) throw new Error("Page has no <h1> — cannot locate hero");
    const hero = h1.closest("section");
    if (!hero) throw new Error("<h1> is not inside a <section>");

    // Next = first <section> that starts after the hero ends in document order.
    const allSections = Array.from(document.querySelectorAll("section"));
    const heroIdx = allSections.indexOf(hero);
    const next = allSections.slice(heroIdx + 1).find((s) => {
      const r = s.getBoundingClientRect();
      return r.height > 0 && r.top >= hero.getBoundingClientRect().bottom - 1;
    });
    if (!next) throw new Error("No section found below the hero");

    const heroRect = hero.getBoundingClientRect();
    const nextRect = next.getBoundingClientRect();

    // Find the first visible content inside the next section so we measure
    // the actual whitespace a user sees, not just padding to padding.
    const candidates = Array.from(
      next.querySelectorAll<HTMLElement>("h1, h2, h3, p, img, a, button, form, div"),
    );
    let firstContentTop = nextRect.top;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.height < 4 || r.width < 4) continue;
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      if (r.top >= nextRect.top - 1) {
        firstContentTop = r.top;
        break;
      }
    }

    return {
      gap: Math.max(0, firstContentTop - heroRect.bottom),
      heroBottom: heroRect.bottom,
      nextTop: firstContentTop,
    };
  });
}

for (const route of ["/about", "/contact"]) {
  test(`no large whitespace gap under hero on ${route}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(route, { waitUntil: "domcontentloaded" });
    // Let layout settle (fonts, async hydration).
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(300);

    const { gap, heroBottom, nextTop } = await measureGapBelowHero(page);

    if (gap > MAX_GAP_PX) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const file = path.join(OUT_DIR, `${route.replace(/\W/g, "_")}-top.png`);
      await page.screenshot({
        path: file,
        clip: { x: 0, y: 0, width: 1280, height: Math.min(900, nextTop + 80) },
      });
      console.log(`Saved evidence screenshot: ${file}`);
    }

    expect(
      gap,
      `Gap between hero bottom (y=${heroBottom.toFixed(0)}) and first content of next section ` +
        `(y=${nextTop.toFixed(0)}) on ${route} is ${gap.toFixed(0)}px — exceeds ${MAX_GAP_PX}px threshold.`,
    ).toBeLessThanOrEqual(MAX_GAP_PX);
  });
}