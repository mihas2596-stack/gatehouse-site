import { test, expect, type BrowserContext } from "@playwright/test";
import ownerAuth from "../api/owner-auth";
import { ownerPanelUrl } from "../api/_owner_email";
import { isOwnerAuth, mintOwnerSessionToken } from "../api/_owner_auth";

const secret = "fixture-owner-secret";
const now = () => Math.floor(Date.now() / 1000);
const first = {
  id: "8d443b5a-d715-48f6-9ecc-38866c73efed", booking_id: "fixture-booking-1",
  client_name: "Taylor Sample", client_email: "taylor@example.test", client_phone: "4045550100",
  visit_date: "2099-12-01", service: "Standard cleaning", window: "morning",
  address: "123 Sample Road", amount_cents: 149, status: "requested", report_status: "none",
  visit_confirmed: false, issue_open: false, issue_ever: false, report_bounced: false,
  is_test: true, cleaner_name: null, checklist: { rooms: [] },
};
const other = {
  ...first, id: "1580347c-4b6c-48d5-a6a2-a41ce2b4be53", booking_id: "fixture-booking-2",
  client_name: "Morgan Example", is_test: false, status: "paid", report_status: "sent",
};
const records = [first, other];

function requestPath(id: string) {
  const url = new URL(ownerPanelUrl(id));
  return url.pathname + url.search;
}

// Run the real email-link handler in the test process; only delivery and persistence are fixtures.
// The URL is taken from the actual login email body and opened in a separate browser context.
async function login(body: Record<string, unknown>, mailStatus: number) {
  const originalFetch = globalThis.fetch;
  const owned = ["ADMIN_TOKEN", "RESEND_API_KEY", "SUPABASE_URL"] as const;
  const previous = owned.map(key => process.env[key]);
  let sentLink = "";
  let payload: unknown;
  let code = 0;
  try {
    process.env.ADMIN_TOKEN = secret;
    process.env.RESEND_API_KEY = "offline-email-fixture";
    delete process.env.SUPABASE_URL;
    globalThis.fetch = async (url, init) => {
      if (url !== "https://api.resend.com/emails") throw new Error("Unexpected mail fixture request");
      if (mailStatus !== 200) return Response.json({}, { status: mailStatus });
      sentLink = JSON.parse(String(init?.body)).text.match(/https:\/\/[^\s]+/)[0];
      return Response.json({ id: "fixture-email" });
    };
    const res = {
      status(n: number) { code = n; return this; },
      json(value: unknown) { payload = value; },
      setHeader() {}, end() {},
    };
    await ownerAuth({ method: "POST", headers: {}, body }, res);
    return { payload, code, sentLink };
  } finally {
    globalThis.fetch = originalFetch;
    owned.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
}

async function attachFixtures(context: BrowserContext, list = records, mailStatus = 200) {
  const seen = { loginUrl: "", detailReads: 0 };
  await context.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/owner-auth") {
      const result = await login(request.postDataJSON(), mailStatus);
      if (result.sentLink) seen.loginUrl = result.sentLink;
      return route.fulfill({ status: result.code, json: result.payload });
    }
    if (!isOwnerAuth(request.headers().authorization ?? "", secret, now())) {
      return route.fulfill({ status: 401, json: { ok: false, error: "unauthorized" } });
    }
    if (url.pathname === "/api/booking-action" && request.postDataJSON()?.action === "status") {
      return route.fulfill({ json: { ok: true, state: "requested", payment_method: "none" } });
    }
    if (url.pathname !== "/api/owner") return route.fulfill({ status: 404, json: { ok: false } });
    const view = url.searchParams.get("view");
    if (view === "list") return route.fulfill({ json: { ok: true, visits: list, next_offset: null } });
    if (view === "roster") return route.fulfill({ json: { ok: true, cleaners: [] } });
    seen.detailReads++;
    const visit = records.find(v => v.id === url.searchParams.get("visit_id"));
    return route.fulfill(visit
      ? { json: { ok: true, visit, photos: [], events: [] } }
      : { status: 404, json: { ok: false, error: "visit_not_found" } });
  });
  return seen;
}

test("mobile owner opens the linked record after email sign-in in a fresh browser context", async ({ browser, baseURL }) => {
  const initial = await browser.newContext({ baseURL, viewport: { width: 320, height: 740 } });
  const signedIn = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    const initialSeen = await attachFixtures(initial);
    // The linked row is both marked test and outside the loaded list page.
    await attachFixtures(signedIn, [other]);
    await signedIn.addInitScript(() => localStorage.setItem("gh_hide_test", "1"));
    const tab = await initial.newPage();
    await tab.goto(requestPath(first.id));
    await tab.getByRole("button", { name: "Send login link to my email" }).click();
    await expect.poll(() => initialSeen.loginUrl).not.toBe("");
    expect(initialSeen.detailReads).toBe(0);
    const url = new URL(initialSeen.loginUrl);
    const mailTab = await signedIn.newPage();
    await mailTab.goto(url.pathname + url.search + url.hash);
    await expect(mailTab.getByRole("heading", { name: first.client_name })).toBeVisible();
    expect(new URL(mailTab.url()).hash).toBe("");
    expect(new URL(mailTab.url()).searchParams.get("visit")).toBe(first.id);
    await mailTab.reload();
    await expect(mailTab.getByRole("heading", { name: first.client_name })).toBeVisible();
    await mailTab.getByRole("button", { name: "← Back to visits" }).click();
    await expect(mailTab.getByRole("button", { name: /Morgan Example/ })).toBeVisible();
    expect(new URL(mailTab.url()).searchParams.has("visit")).toBe(false);
  } finally {
    await initial.close();
    await signedIn.close();
  }
});

test("mobile owner opens the same request with an admin token when email fails", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    const seen = await attachFixtures(context, [other], 401);
    const tab = await context.newPage();
    await tab.goto(requestPath(first.id));
    await tab.getByRole("button", { name: "Send login link to my email" }).click();
    await expect(tab.getByRole("alert")).toContainText("We couldn’t send the sign-in link");
    expect(seen.detailReads).toBe(0);
    await tab.getByLabel("Admin token").fill(secret);
    await tab.getByRole("button", { name: "Open with admin token" }).click();
    await expect(tab.getByRole("heading", { name: first.client_name })).toBeVisible();
    expect(new URL(tab.url()).searchParams.get("visit")).toBe(first.id);
    expect(seen.detailReads).toBe(1);
  } finally {
    await context.close();
  }
});

test("fresh owner list shows all visits and explains explicitly filtered empty results", async ({ context, page }) => {
  await attachFixtures(context);
  await context.addInitScript(session => localStorage.setItem("gh_owner_session", session), mintOwnerSessionToken(secret, now()));
  await page.goto("/owner");
  await expect(page.getByRole("button", { name: /Taylor Sample/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Morgan Example/ })).toBeVisible();
  await page.getByLabel("Hide test bookings").check();
  await page.getByRole("button", { name: /Cancelled \(0\)/ }).click();
  await expect(page.getByText("No cancelled visits.")).toBeVisible();
  await page.getByRole("button", { name: "Show all visits (2)" }).click();
  await expect(page.getByRole("button", { name: /Taylor Sample/ })).toBeVisible();
  await expect(page.getByLabel("Hide test bookings")).not.toBeChecked();
});

test("a stale email link explains a missing visit and offers the actual list", async ({ context, page }) => {
  await attachFixtures(context);
  await context.addInitScript(session => localStorage.setItem("gh_owner_session", session), mintOwnerSessionToken(secret, now()));
  await page.goto(requestPath("ea215a2b-11fb-4bd6-b552-83766c03b90f"));
  await expect(page.getByRole("alert")).toContainText("This request could not be found");
  await page.getByRole("button", { name: "Back to all visits" }).click();
  await expect(page.getByRole("button", { name: /Morgan Example/ })).toBeVisible();
});
