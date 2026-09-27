import { test, expect } from "@playwright/test";

/**
 * Visual regression: the /areas page must render a real Google Maps embed,
 * not a blank white iframe. We screenshot the iframe element and assert
 * pixel variance is high enough that the frame contains actual map content
 * (roads, labels, land/water colors) rather than a uniform white box.
 */

async function imageStats(
  page: import("@playwright/test").Page,
  pngBuffer: Buffer,
): Promise<{ mean: number; stddev: number }> {
  const b64 = pngBuffer.toString("base64");
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
    const pixels = data.length / 4;
    let sum = 0;
    const lums: number[] = new Array(pixels);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
      lums[p] = l;
      sum += l;
    }
    const mean = sum / pixels;
    let varSum = 0;
    for (let p = 0; p < pixels; p++) varSum += (lums[p] - mean) ** 2;
    return { mean, stddev: Math.sqrt(varSum / pixels) };
  }, `data:image/png;base64,${b64}`);
}

test("Areas map iframe loads and is not a blank white rectangle", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/areas", { waitUntil: "domcontentloaded" });

  const iframe = page.locator('iframe[title*="Map of North Atlanta"]');
  await expect(iframe).toBeVisible();

  // Confirm the iframe actually navigated to a Google Maps URL.
  const src = await iframe.getAttribute("src");
  expect(src, "iframe should point at Google Maps").toMatch(/maps\.google\.com|google\.com\/maps/);

  // Give the embed time to load tiles (it's a third-party request).
  await page.waitForTimeout(4000);

  // The iframe element itself should have non-zero size.
  const box = await iframe.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(200);
  expect(box!.height).toBeGreaterThan(200);

  const shot = await iframe.screenshot();
  const { mean, stddev } = await imageStats(page, shot);

  // A blank white iframe would read mean≈255, stddev≈0. A real Google Map
  // (land/water/roads/labels) reads mean roughly 200–240 with stddev > 20.
  expect(
    stddev,
    `iframe screenshot stddev=${stddev.toFixed(1)} mean=${mean.toFixed(1)} — ` +
      `near-zero stddev means the map rendered as a uniform (likely blank) rectangle.`,
  ).toBeGreaterThan(15);
  expect(
    mean,
    `iframe mean brightness ${mean.toFixed(1)} — pure white (≈255) indicates a blank embed.`,
  ).toBeLessThan(250);
});