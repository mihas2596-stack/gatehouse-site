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
