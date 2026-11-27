import { expect, test, type Page } from "@playwright/test";

const checklist = { rooms: [{ name: "Kitchen", items: [{ label: "Counters wiped", done: false }] }] };
const booking = { first: "Casey", service: "Standard cleaning", confirmed_date: "2026-01-05", window: "morning" };
const report = {
  ok: true, state: "awaiting", booking, amount: "$149.00", amount_cents: 14900,
  publication_id: "test-publication", checklist, photo_items: [],
};
const cleaner = {
  ok: true, confirmed: true, editable: true, report_status: "draft",
  checklist_revision: "2026-01-05T10:01:00Z", checklist, photos: [],
  visit: {
    service: "Standard cleaning", date: "2026-01-05", window: "morning",
    address: "123 Sample Street, Sugar Hill", entry_choice: { method: "home", detail: null, notes: "Ring the bell." },
    client_first_name: "Casey", no_photo_zones: null,
  },
};
const fixturePhotos = ["before", "after"].map((kind) => ({
  id: kind, room: "Kitchen", kind, note: null, url: null, created_at: "2026-01-05",
}));

test.beforeEach(async ({ context }) => {
  await context.route(/^https?:\/\//, async (route) => {
    if (["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)) await route.fallback();
    else await route.abort();
  });
});

async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  );
}

for (const width of [320, 390, 412, 768, 1440]) {
  test(`cabinet views fit ${width}px; the emailed report opens in view`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route("**/api/cleaner?*", (route) => route.fulfill({ json: cleaner }));
    await page.route("**/api/visit?*", (route) => route.fulfill({ json: { ok: true, state: "report_sent", booking } }));
    await page.route("**/api/report?*", (route) => route.fulfill({ json: report }));
    await page.goto("/owner");
    await expect(page.getByRole("heading", { name: "Owner view" })).toBeVisible();
    await fits(page);
    await page.goto("/cleaner?ct=fixture-token");
    await expect(page.getByRole("heading", { name: "Your cleaning job" })).toBeVisible();
    await expect(page.getByText(/123 Sample Street, Sugar Hill/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Complete 1 more room/i }).last()).toBeDisabled();
    await fits(page);
    await page.goto("/visit?bt=fixture-token#report");
    await expect(page.getByRole("heading", { name: "Cleaning report" })).toBeVisible();
    await expect(page).toHaveURL(/\/visit#report$/);
    await expect(page.locator("#report h2").first()).toBeInViewport();
    await fits(page);
    await page.goto("/report?bt=fixture-token");
    await expect(page.getByRole("heading", { name: "Your cleaning report" })).toBeVisible();
    await page.getByRole("button", { name: "Report an issue", exact: true }).click();
    await expect(page.getByLabel("Which room?")).toBeVisible();
    await fits(page);
  });
}

test("a disconnected cleaner can retry the same link, and an expired link stays closed", async ({ page }) => {
  let response: "offline" | "ready" | "expired" = "offline";
  await page.route("**/api/cleaner?*", (route) => response === "offline"
    ? route.abort("internetdisconnected")
    : route.fulfill({ json: response === "ready" ? cleaner : { ok: false, error: "link_expired" } }));
  await page.goto("/cleaner?ct=fixture-token");
  await expect(page.getByRole("heading", { name: "We couldn't load this visit" })).toBeVisible();
  response = "ready";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Your cleaning job" })).toBeVisible();
  response = "expired";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});

test("an interrupted photo upload retries the selected file; Finish publishes only after confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const photos = fixturePhotos.slice(0, 1);
  let locked = false;
  let putAttempts = 0;
  let submitAttempts = 0;
  let putSize = 0;
  await page.route("**/api/cleaner?*", (route) => route.fulfill({ json: {
    ...cleaner, editable: !locked, report_status: locked ? "sent" : "draft", photos,
  } }));
  await page.route("**/mock-photo-upload", async (route) => {
    putAttempts++;
    putSize = route.request().postDataBuffer()?.length ?? 0;
    if (putAttempts === 1) return route.abort("connectionreset");
    return route.fulfill({ status: 200 });
  });
  await page.route("**/api/cleaner", async (route) => {
    const { action } = route.request().postDataJSON();
    if (action === "photo_sign") return route.fulfill({ json: { ok: true, storage_path: "mock-photo", upload_url: "/mock-photo-upload" } });
    if (action === "photo_register") {
      photos.push(fixturePhotos[1]);
      return route.fulfill({ json: { ok: true, photo_id: fixturePhotos[1].id } });
    }
    if (action === "submit") {
      submitAttempts++;
      if (submitAttempts === 1) return route.abort("connectionreset");
      locked = true;
      return route.fulfill({ json: { ok: true, published: true } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/cleaner?ct=fixture-token");
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 4000; canvas.height = 3000;
    canvas.getContext("2d")!.fillRect(0, 0, 4000, 3000);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByLabel("Gallery (after)").setInputFiles({ name: "room.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  const finish = page.getByRole("button", { name: "Finish & send report" });
  await expect(finish).toBeEnabled();
  expect(putAttempts).toBe(2);
  expect(putSize).toBeGreaterThan(0);
  await finish.click();
  await expect(page.getByText(/we don't know whether the report was sent/i)).toBeVisible();
  await expect(page.getByText(/Report published/)).toHaveCount(0);
  await finish.dblclick();
  await expect(page.getByText(/Report published/)).toBeVisible();
  expect(submitAttempts).toBe(2);
  await page.reload();
  await expect(page.getByText(/Report published/)).toBeVisible();
});
