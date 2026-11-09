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

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page Not Found | Gatehouse</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#faf7f2;color:#2d2a26;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center}main{max-width:34rem;padding:2rem}h1{font-size:2rem;margin:0 0 1rem}p{font-size:1.125rem;color:#6b6560;margin:0 0 1.5rem}a{color:#3d6b4f;margin:0 .75rem}</style>
</head>
<body>
<main>
<h1>404 — Page not found</h1>
<p>That page doesn&rsquo;t exist. Try the homepage or see your price.</p>
<p><a href="/">Back to home</a><a href="/quote">See my price</a></p>
</main>
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
