// Shared origin checks and deployment addresses for server-generated links.
export const PRODUCTION_SITE_ORIGIN = "https://www.gatehousehomecleaning.com";

export function isPreviewOrigin(origin: unknown): boolean {
  if (typeof origin !== "string") return false;
  return /^https:\/\/gatehouse-site-[A-Za-z0-9-]+\.vercel\.app$/.test(origin);
}

export function configuredPreviewOrigins(): string[] {
  return [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]
    .map((host) => `https://${host ?? ""}`)
    .filter(isPreviewOrigin);
}

export function gatehouseSiteOrigin(): string {
  if (process.env.VERCEL_ENV !== "preview") return PRODUCTION_SITE_ORIGIN;
  const origins = configuredPreviewOrigins();
  // Email links should use the stable branch address when it is available.
  const origin = origins[origins.length - 1];
  if (!origin) throw new Error("preview_site_origin_unavailable");
  return origin;
}

export function isAllowedOrigin(origin: unknown, allowed: readonly string[]): boolean {
  if (typeof origin === "string" && allowed.includes(origin)) return true;
  return isPreviewOrigin(origin);
}
