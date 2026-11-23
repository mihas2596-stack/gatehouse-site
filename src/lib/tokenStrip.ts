/**
 * Resolve a one-time cabinet link token (?bt= for visit/report/save-card,
 * ?ct= for cleaner) and strip it from the address bar before any
 * analytics sees it.
 *
 * Why: the Google tag (GTM) loads on every page, including the cabinets,
 * and a token left in the URL is sent to analytics with the page view.
 * Referrer-Policy: no-referrer (vercel.json) stops it leaking to other
 * sites, but it does not stop same-site scripts reading location.href.
 *
 * The token is kept in sessionStorage under the given key, so a refresh
 * in the same tab still works; a fresh tab uses the emailed link. Other
 * query params are preserved (e.g. the cleaner preview flag ?pv=1).
 *
 * `search` is the router's query string (from useSearchParams). Under
 * BrowserRouter it equals window.location.search; under MemoryRouter
 * (tests) it is the only source of the token, because window.location
 * never changes there. The strip always targets the real address bar,
 * and is a no-op when the real URL carries no such param.
 *
 * Idempotent and safe under StrictMode double-invocation: a second call
 * reads the token back from sessionStorage and strips nothing.
 */
export function resolveLinkToken(param: "bt" | "ct", storageKey: string, search?: string): string {
  const fromUrl = new URLSearchParams(search ?? (typeof window === "undefined" ? "" : window.location.search)).get(param);
  try {
    if (fromUrl) {
      sessionStorage.setItem(storageKey, fromUrl);
      const real = new URLSearchParams(window.location.search);
      if (real.get(param)) {
        real.delete(param);
        const rest = real.toString();
        window.history.replaceState(window.history.state, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
      }
      return fromUrl;
    }
    return sessionStorage.getItem(storageKey) ?? "";
  } catch {
    // Keep the emailed link usable when an embedded browser blocks storage.
    return fromUrl ?? "";
  }
}
