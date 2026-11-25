// N-01 / N-05 (Playwright): issued cabinet links and Stripe return URLs
// are built on the request's host. Runs against the local production
// build (dist/) served by e2e/n01-n05-test-server.ts, which mounts the
// REAL api handlers with Stripe/Supabase/Resend stubbed in-process — no
// real Stripe, no network. Build first (`npm run build`); the server is
// started by this spec itself.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";

const PORT = 8080;
const BASE = `http://localhost:${PORT}`;
const PREVIEW = "https://gatehouse-site-git-review-gateh-188812-mihas2596-6172s-projects.vercel.app";

let server: ChildProcess | null = null;

async function serverAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/__n01n05/captured`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  // Reuse a server from an earlier run when it is already listening
  // (a previous run's afterAll kill can lag); otherwise start our own.
  if (await serverAlive()) return;
  server = spawn(
    "npx",
    ["vite-node", "e2e/n01-n05-test-server.ts", String(PORT)],
    { cwd: process.cwd(), stdio: "pipe" },
  );
  const started = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 30000);
    server?.stdout?.on("data", (d: Buffer) => {
      if (d.toString().includes("test server ready")) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    server?.on("exit", () => { clearTimeout(timer); resolve(false); });
  });
  expect(started).toBe(true);
});

test.afterAll(() => {
  server?.kill("SIGTERM");
  server = null;
});

async function mintBt(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BASE}/__n01n05/mint-bt`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { bt: string };
  return body.bt;
}

async function captured(request: APIRequestContext) {
  const res = await request.get(`${BASE}/__n01n05/captured`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as { successUrl: string | null; cancelUrl: string | null; lastBookingActionUrl: string | null };
}

test("N-01: Stripe return URLs stay on the request host", async ({ request }) => {
  const bt = await mintBt(request);
  const res = await request.post(`${BASE}/api/create-checkout-session`, {
    headers: { Origin: PREVIEW, "Content-Type": "application/json" },
    data: { bt },
  });
  expect(res.ok()).toBe(true);
  const cap = await captured(request);
  expect(cap.successUrl).toMatch(new RegExp(`^${PREVIEW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/save-card\\?saved=1`));
  expect(cap.cancelUrl).toMatch(new RegExp(`^${PREVIEW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/save-card\\?canceled=1`));
});

test("N-01: production origin still returns production URLs", async ({ request }) => {
  const bt = await mintBt(request);
  const res = await request.post(`${BASE}/api/create-checkout-session`, {
    headers: { Origin: "https://www.gatehousehomecleaning.com", "Content-Type": "application/json" },
    data: { bt },
  });
  expect(res.ok()).toBe(true);
  const cap = await captured(request);
  expect(cap.successUrl).toMatch(/^https:\/\/www\.gatehousehomecleaning\.com\/save-card\?saved=1/);
});

test("N-05: client_link is issued on the request host", async ({ request }) => {
  const res = await request.post(`${BASE}/api/booking-action`, {
    headers: {
      Origin: PREVIEW,
      Authorization: "Bearer test-admin-token",
      "Content-Type": "application/json",
    },
    data: { action: "client_link", booking_id: "bid-n01-n05" },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { url: string };
  expect(body.url).toMatch(new RegExp(`^${PREVIEW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/visit\\?bt=`));
});

test("N-05: the browser's own origin is used for a save-card request", async ({ request, page }) => {
  await page.goto(`${BASE}/save-card`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const bt = await mintBt(request);
  const data = await page.evaluate(async (token) => {
    const r = await fetch("/api/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bt: token }),
    });
    return { status: r.status, body: await r.json() as { ok: boolean } };
  }, bt);
  expect(data.status).toBe(200);
  expect(data.body.ok).toBe(true);
  const cap = await captured(request);
  expect(cap.successUrl).toMatch(new RegExp(`^${BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/save-card\\?saved=1`));
});
