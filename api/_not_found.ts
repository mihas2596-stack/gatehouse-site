// The terminal rewrite target for unknown paths (N2), formerly its own
// file api/not-found.ts.
//
// Vercel evaluates routing as: redirects -> filesystem (static files and
// functions) -> rewrites -> 404. The old catch-all rewrite `/(.*) -> /`
// served the SPA shell for every unknown URL, so crawlers and `curl -I`
// saw HTTP 200 for pages that do not exist. vercel.json now rewrites
// only the known client-only routes (/visit, /report, /cleaner, /owner,
// /save-card, /areas/:city) to `/`, and everything else falls through
// to this handler, which answers a real 404 with the same branded
// message the SPA NotFound page shows (links home and to /quote, no
// JavaScript, no external assets, noindex). In-app navigation to an
// unknown path still renders the SPA NotFound component — this handler
// only answers direct loads / refreshes / crawlers.
//
// Merge note (09.11.2026): this used to be api/not-found.ts, its own
// serverless function. The Vercel Hobby plan allows only 12 functions
// per deployment; the extra file pushed the count to 13 and every
// deploy of 857ae50 failed. The handler moved here (underscore files
// are helpers, not functions) and api/owner-auth.ts — the established
// merge host, see its header — answers it for the catch-all rewrite
// (`/api/owner-auth?notfound=1`) before any origin/auth check.
// Behavior is unchanged.
//
// Header/footer note (09.11.2026): the page carries the site header and
// footer as static inline HTML (same logo, nav, phone and footer links
// as src/components/Header.tsx and src/components/Footer.tsx), so a
// visitor landing on a bad URL still sees the site chrome. Still no
// JavaScript and no external assets.
type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};
type Res = {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

const YEAR = new Date().getFullYear();

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page Not Found | Gatehouse</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#faf7f2;color:#2d2a26;margin:0;display:flex;flex-direction:column;min-height:100vh}
a{color:#3d6b4f}
header{background:#faf7f2;border-bottom:1px solid rgba(0,0,0,.06)}
.header-inner{max-width:72rem;margin:0 auto;padding:.75rem 1rem;display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.5rem}
.logo{color:#6b3a1f;text-decoration:none;line-height:1.1}
.logo b{display:block;font-size:1.25rem}
.logo span{font-size:.6rem;font-weight:600;letter-spacing:.18em;text-transform:uppercase}
header nav{display:flex;flex-wrap:wrap;gap:.25rem 1rem}
header nav a{color:#2d2a26;text-decoration:none;font-size:.95rem;font-weight:600}
header nav a:hover{color:#3d6b4f}
.cta{margin-left:auto;background:#9d5830;color:#fff;text-decoration:none;font-weight:600;font-size:.95rem;padding:.5rem 1rem;border-radius:.5rem;white-space:nowrap}
main{flex:1;display:flex;align-items:center;justify-content:center;text-align:center}
.main-inner{max-width:34rem;padding:2rem}
h1{font-size:2rem;margin:0 0 1rem}
main p{font-size:1.125rem;color:#6b6560;margin:0 0 1.5rem}
main p a{margin:0 .75rem}
main p.popular{font-size:1rem}
main p.areas{font-size:.95rem;margin-bottom:0}
footer{background:#f2c7a1;color:#3d2b1f}
.footer-inner{max-width:72rem;margin:0 auto;padding:2rem 1rem}
.footer-top{display:flex;flex-wrap:wrap;gap:1rem 3rem;justify-content:space-between}
.footer-brand b{color:#6b3a1f;font-size:1.5rem;display:block;line-height:1.1}
.footer-brand span{font-size:.65rem;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:#6b3a1f}
.footer-contact{font-size:.95rem;line-height:1.8}
.footer-contact a{color:#3d2b1f}
.footer-bottom{border-top:1px solid rgba(61,43,31,.2);margin-top:1.5rem;padding-top:1rem;display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;justify-content:space-between;font-size:.875rem}
.footer-bottom nav{display:flex;flex-wrap:wrap;gap:.25rem 1rem}
.footer-bottom nav a{color:#3d2b1f;text-decoration:none}
</style>
</head>
<body>
<header>
<div class="header-inner">
<a class="logo" href="/" aria-label="Gatehouse Home Cleaning — home"><b>Gatehouse Home Cleaning</b><span>North Atlanta, GA</span></a>
<nav aria-label="Main navigation">
<a href="/services">Services</a>
<a href="/whats-included">What&rsquo;s Included</a>
<a href="/areas">Areas</a>
<a href="/faq">FAQ</a>
</nav>
<a class="cta" href="/quote">See My Price</a>
</div>
</header>
<main>
<div class="main-inner">
<h1>404 — Page not found</h1>
<p>That page doesn&rsquo;t exist. Try the homepage or see your price.</p>
<p><a href="/">Back to home</a><a href="/quote">See my price</a></p>
<p class="popular">Popular pages: <a href="/services">Services</a> &middot; <a href="/whats-included">What&rsquo;s Included</a> &middot; <a href="/areas">Areas</a> &middot; <a href="/faq">FAQ</a> &middot; <a href="/contact">Contact</a></p>
<p class="areas">We clean homes in Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell.</p>
</div>
</main>
<footer>
<div class="footer-inner">
<div class="footer-top">
<div class="footer-brand">
<b>Gatehouse Home Cleaning</b>
<span>North Atlanta, GA</span>
<p>House cleaning with a clear price and a private photo report. One-time and every-other-week visits, confirmed with you.</p>
</div>
<div class="footer-contact">
<a href="mailto:hello@gatehousehomecleaning.com">hello@gatehousehomecleaning.com</a><br>
<a href="tel:+17705258599">(770) 525-8599</a><br>
Sugar Hill &middot; Suwanee &middot; Buford &middot; Duluth &middot; Johns Creek &middot; Alpharetta &middot; Roswell
</div>
</div>
<div class="footer-bottom">
<p>&copy; ${YEAR} Gatehouse Home Cleaning. All rights reserved.</p>
<nav aria-label="Footer navigation">
<a href="/about">About Gatehouse</a>
<a href="/contact">Contact</a>
<a href="/whats-included">What&rsquo;s Included</a>
<a href="/faq">FAQ</a>
<a href="/privacy">Privacy Policy</a>
<a href="/terms">Terms of Service</a>
</nav>
</div>
</div>
</footer>
</body>
</html>
`;

export async function notFoundHandler(req: Req, res: Res) {
  res.status(404);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // HEAD (curl -I) gets headers only; a body would be dropped anyway.
  if (req.method === "HEAD") return res.end();
  return res.end(HTML);
}
