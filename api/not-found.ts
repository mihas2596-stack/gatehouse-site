// /api/not-found — the terminal rewrite target for unknown paths (N2).
//
// Vercel evaluates routing as: redirects -> filesystem (static files and
// functions) -> rewrites -> 404. The old catch-all rewrite `/(.*) -> /`
// served the SPA shell for every unknown URL, so crawlers and `curl -I`
// saw HTTP 200 for pages that do not exist. vercel.json now rewrites
// only the known client-only routes (/visit, /report, /cleaner, /owner,
// /save-card, /areas/:city) to `/`, and everything else falls through
// to this function, which answers a real 404 with the same branded
// message the SPA NotFound page shows (links home and to /quote, no
// JavaScript, no external assets, noindex). In-app navigation to an
// unknown path still renders the SPA NotFound component — this function
// only answers direct loads / refreshes / crawlers.
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

export default async function handler(req: Req, res: Res) {
  res.status(404);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // HEAD (curl -I) gets headers only; a body would be dropped anyway.
  if (req.method === "HEAD") return res.end();
  return res.end(HTML);
}
