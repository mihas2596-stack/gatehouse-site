// Origin checks shared by the API routes.
// Production origins live in each route's ALLOWED_ORIGINS. Vercel preview
// deployments of this project (branch URLs and per-deploy URLs) all live
// under https://gatehouse-site-*.vercel.app — only this project's own
// previews can carry that prefix (Vercel derives it from the project
// name), and previews are team-only behind Vercel Authentication, so
// accepting them does not open the API to arbitrary sites.
export function isPreviewOrigin(origin: unknown): boolean {
  if (typeof origin !== "string") return false;
  return /^https:\/\/gatehouse-site-[A-Za-z0-9-]+\.vercel\.app$/.test(origin);
}

export function isAllowedOrigin(origin: unknown, allowed: readonly string[]): boolean {
  if (typeof origin === "string" && allowed.includes(origin)) return true;
  return isPreviewOrigin(origin);
}

// Canonical production origin. Cabinet links, email links and Stripe
// return URLs default to it whenever the request carries no usable
// origin (cron, webhook, SMS) — so production behavior never changes.
export const PRODUCTION_ORIGIN = "https://www.gatehousehomecleaning.com";

/**
 * Base URL for links issued from a request: the request's own origin
 * when it is allowed (a production origin or a Vercel preview of this
 * project), the production origin otherwise. On production the request
 * origin IS the production origin, so issued URLs are byte-identical
 * to before; on a preview deployment the links stay on the preview
 * host instead of pointing at production, where the test visit does
 * not exist (N-01/N-05). Never returns an unvalidated origin.
 */
export function siteBaseFromOrigin(origin: unknown, allowed: readonly string[]): string {
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (typeof o === "string" && isAllowedOrigin(o, allowed)) return o;
  return PRODUCTION_ORIGIN;
}
