import { test, expect } from "@playwright/test";

/**
 * Visual regression: the homepage hero image must never be covered by a
 * dark overlay. We sample the right-half region of the hero section across
 * mobile / tablet / desktop and assert average pixel brightness stays above
 * a threshold (i.e. the underlying photo is visible, not blacked out).
 *
 * Brightness is measured as the mean of the R/G/B channels (0-255) over the
 * sampled region. A pure black overlay would read ~0; the hero photo (warm,
 * sunlit interior) averages well above 120 even with a partial scrim.
 */

type Viewport = { name: string; width: number; height: number; minBrightness: number };

const VIEWPORTS: Viewport[] = [
  { name: "mobile",  width: 390,  height: 844,  minBrightness: 110 },
  { name: "tablet",  width: 820,  height: 1180, minBrightness: 110 },
  { name: "desktop", width: 1280, height: 900,  minBrightness: 110 },
];

async function averageBrightness(pngBuffer: Buffer): Promise<number> {
  // Tiny inline PNG decoder via the browser canvas would be heavy; instead,
  // delegate to a hidden page using createImageBitmap. Playwright doesn't
  // ship a pixel decoder, so we run this in a fresh page context.
  return await decodeBrightness(pngBuffer);
}

// Inline pure-JS PNG decode using pngjs would add a dep. We instead use the
// canvas API inside a throwaway page context the caller passes in.
let decodeBrightness: (buf: Buffer) => Promise<number>;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent("<canvas id='c'></canvas>");
  decodeBrightness = async (buf: Buffer) => {
    const b64 = buf.toString("base64");
    return await page.evaluate(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let sum = 0;
      const pixels = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      }
      return sum / pixels;
    }, `data:image/png;base64,${b64}`);
  };
});

for (const vp of VIEWPORTS) {
  test(`hero photo is visible (not dark-overlayed) on ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/", { waitUntil: "networkidle" });

    // Two copies of the hero image are mounted (mobile + desktop layouts),
    // toggled by CSS. Grab whichever one is actually rendered.
    const heroImg = page
      .locator('img[alt*="Atlanta family"]')
      .locator("visible=true")
      .first();
    await heroImg.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const imgs = Array.from(
        document.querySelectorAll<HTMLImageElement>('img[alt*="Atlanta family"]'),
      );
      return imgs.some((el) => el.complete && el.naturalWidth > 0 && el.offsetWidth > 0);
    });

    // Bounding box of the actually-rendered hero photo (mobile uses a split
    // layout where the image lives in a 40vh band; desktop/tablet stretch it
    // behind the section). Either way, sample the right ~40% of that box.
    const box = await heroImg.boundingBox();
    expect(box, "hero image should be in DOM").not.toBeNull();
    const { x, y, width, height } = box!;

    const sampleX = Math.round(x + width * 0.6);
    const sampleY = Math.round(y + height * 0.2);
    const sampleW = Math.max(20, Math.round(width * 0.35));
    const sampleH = Math.max(20, Math.round(height * 0.6));

    const shot = await page.screenshot({
      clip: { x: sampleX, y: sampleY, width: sampleW, height: sampleH },
    });

    const brightness = await averageBrightness(shot);
    // Helpful failure context if this ever regresses.
    expect(
      brightness,
      `hero right-side region averaged brightness ${brightness.toFixed(1)} on ${vp.name} ` +
        `(threshold ${vp.minBrightness}). A value near 0 means a dark overlay is covering the photo.`,
    ).toBeGreaterThan(vp.minBrightness);
  });
}