import { expect, test } from "@playwright/test";

for (const width of [320, 390, 768, 1440]) {
  test(`public routes fit a ${width}px viewport`, async ({ browser }) => {
    for (const path of ["/", "/services", "/whats-included", "/faq", "/areas", "/quote", "/terms", "/privacy", "/thank-you", "/save-card", "/about", "/contact", "/missing-page"]) {
      // Fresh context per route: reusing one renderer across 13 full
      // navigations OOM-crashes Chromium in memory-constrained sandboxes.
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(width + 1);
      await context.close();
    }
  });
}

test("mobile quote is submitted once, survives reload and follows setup to verified confirmation", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const city = "Sugar Hill";
  const token = "fixture-visit";
  let submitted = 0;
  let checkout = 0;
  let quoted = "";
  await page.route("**/api/send-contact-email", async route => {
    submitted++;
    const order = route.request().postDataJSON();
    expect(order).toMatchObject({ zip: "30518", city, half_baths: "1", entry_method: "home", terms_consent: true, photo_consent: true });
    quoted = order.price;
    await route.fulfill({ json: { ok: true, bt: token, server_first: quoted, server_recurring: order.recurring } });
  });
  await page.route("**/api/card-status?**", async route => {
    const saved = new URL(route.request().url()).searchParams.has("session_id");
    await route.fulfill({ json: { ok: true, status: saved ? "saved" : "ready", verified: saved,
      booking: { first: quoted, service: "Standard Cleaning", date: "2099-12-01", has_card: saved ? "1" : "0", card_confirmed: saved ? "1" : "0" } } });
  });
  await page.route("**/api/create-checkout-session", async route => {
    checkout++;
    expect(route.request().postDataJSON()).toEqual({ bt: token });
    await route.fulfill({ json: { ok: true, url: baseURL + "/save-card?bt=" + token + "&saved=1&session_id=fixture" } });
  });
  await page.goto("/");
  await page.locator("[data-main-cta]").first().click();
  await page.getByLabel(/ZIP code/).fill("90210");
  await expect(page.locator("#zip-msg").getByText(/We don't serve this ZIP yet/)).toBeVisible();
  await page.getByLabel(/ZIP code/).fill("30518");
  await page.getByLabel("Half bathrooms").selectOption("1");
  await page.getByRole("button", { name: "Continue to visit details" }).click();
  await page.getByLabel("Your name *").fill("Example Client");
  await page.reload();
  await expect(page.getByLabel("Your name *")).toHaveValue("Example Client");
  for (const [label, value] of [["Email *", "client@example.com"], ["Phone *", "7705550100"], ["Street address *", "123 Example St"], ["City *", city], ["Preferred date *", "2099-12-01"]]) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByRole("radio", { name: /I’ll be home/ }).check();
  await page.getByLabel(/I agree to photos/).check();
  await page.getByRole("button", { name: "Review my request" }).click();
  await page.getByLabel(/I agree to the Terms/).check();
  await page.getByRole("button", { name: /Continue to Stripe/ }).click();
  await expect(page.getByRole("heading", { name: /One last step/ })).toBeVisible();
  await page.getByRole("button", { name: /Continue to Stripe/ }).click();
  await expect(page.getByText("Card saved. $0 charged today.")).toBeVisible();
  await expect(page.getByRole("link", { name: "View my visit" })).toHaveAttribute("href", /visit\?bt=fixture-visit/);
  expect(submitted).toBe(1);
  expect(checkout).toBe(1);
});
