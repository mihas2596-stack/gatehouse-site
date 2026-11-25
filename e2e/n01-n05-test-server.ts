// Test-only server for the N-01/N-05 Playwright scenario. Serves the
// production build (dist/) and mounts the REAL api handlers, with Stripe /
// Supabase / Resend calls stubbed in-process (no real Stripe, no network).
// NOT part of the shipped site: it exists only so Playwright can verify
// that issued links and Stripe return URLs are built on the request's
// host. Run with: npx vite-node e2e/n01-n05-test-server.ts [port]
// (default 8091). Env it sets is test-only.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env["STRIPE_SECRET_KEY"] = "sk_test_x";
process.env["BOOKING_LINK_SECRET"] = "test-link-secret-n01";
process.env["ADMIN_TOKEN"] = "test-admin-token";
process.env["RESEND_API_KEY"] = "re_test";
process.env["SUPABASE_URL"] = "https://test.supabase.co";
process.env["SUPABASE_SERVICE_ROLE_KEY"] = "service-key";

const root = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(root, "..", "dist");

const captured: {
  successUrl: string | null;
  cancelUrl: string | null;
  lastBookingActionUrl: string | null;
} = { successUrl: null, cancelUrl: null, lastBookingActionUrl: null };

// Stub outbound calls before the handlers are imported.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { method?: string; body?: unknown }) => {
  const u = new URL(String(url));
  const ok = (data: unknown) => ({
    ok: true, status: 200,
    json: async () => data, text: async () => JSON.stringify(data),
  });
  if (u.hostname.includes("supabase")) return ok([]);
  if (u.hostname === "api.stripe.com") {
    if (u.pathname === "/v1/customers/search") {
      return ok({ data: [{ id: "cus_test_1", email: "client@example.com", name: "Casey Client", metadata: { gh_booking_id: "bid-n01-n05" } }] });
    }
    if (u.pathname === "/v1/customers" && (init?.method ?? "GET") === "GET") {
      return ok({ data: [{ id: "cus_test_1", email: "client@example.com", name: "Casey Client", metadata: { gh_booking_id: "bid-n01-n05" } }] });
    }
    if (u.pathname === "/v1/customers" && (init?.method ?? "GET") === "POST") return ok({ id: "cus_new" });
    if (u.pathname === "/v1/checkout/sessions") {
      const params = new URLSearchParams(String(init?.body ?? ""));
      captured.successUrl = params.get("success_url");
      captured.cancelUrl = params.get("cancel_url");
      return ok({ id: "cs_test_x", url: "https://checkout.stripe.com/pay/cs_test_x" });
    }
    if (u.pathname.startsWith("/v1/customers/")) {
      return ok({ id: "cus_test_1", email: "client@example.com", name: "Casey Client", metadata: { gh_booking_id: "bid-n01-n05" } });
    }
  }
  if (u.hostname === "api.resend.com") return ok({ id: "email-1" });
  return realFetch(url, init as never);
}) as typeof fetch;

const checkout = (await import("../api/create-checkout-session.js")).default;
const { signBooking } = await import("../api/create-checkout-session.js");
const bookingAction = (await import("../api/booking-action.js")).default;

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".json": "application/json", ".webp": "image/webp", ".xml": "application/xml",
};

type HandlerRes = {
  code: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): HandlerRes;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

function makeRes(): HandlerRes {
  const res: HandlerRes = {
    code: 200, body: undefined, headers: {},
    status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end() {},
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/__n01n05/captured") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(captured));
      return;
    }
    if (url.pathname === "/__n01n05/mint-bt") {
      const { token } = signBooking("test-link-secret-n01", {
        bid: "bid-n01-n05", email: "client@example.com", name: "Casey Client",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ bt: token }));
      return;
    }
    if (url.pathname === "/api/create-checkout-session" || url.pathname === "/api/booking-action") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (raw) { try { body = JSON.parse(raw); } catch { body = null; } }
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { query[k] = v; });
      const handlerReq = { method: req.method, headers, body, query };
      const handlerRes = makeRes();
      if (url.pathname === "/api/create-checkout-session") {
        await checkout(handlerReq as never, handlerRes as never);
      } else {
        await bookingAction(handlerReq as never, handlerRes as never);
        const b = handlerRes.body as Record<string, unknown> | undefined;
        if (b && typeof b["url"] === "string") captured.lastBookingActionUrl = b["url"] as string;
      }
      const payload = handlerRes.body === undefined ? "" : JSON.stringify(handlerRes.body);
      res.writeHead(handlerRes.code, { "Content-Type": "application/json", ...handlerRes.headers });
      res.end(payload);
      return;
    }
    // Static production build. Unknown extensionless paths fall back to
    // index.html, like `vite preview` (client-side routing). Prerendered
    // pages live in directories (dist/quote/index.html).
    let filePath = path.join(distDir, decodeURIComponent(url.pathname));
    if (url.pathname === "/") filePath = path.join(distDir, "index.html");
    if ((!existsSync(filePath) || !filePath.startsWith(distDir)) && !path.extname(url.pathname)) {
      filePath = path.join(distDir, "index.html");
    }
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!existsSync(filePath) || !filePath.startsWith(distDir)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: String(err) }));
  }
});

const port = Number(process.argv[2] ?? 8080);
server.listen(port, "127.0.0.1", () => {
  console.log(`n01-n05 test server ready on http://localhost:${port}`);
});
