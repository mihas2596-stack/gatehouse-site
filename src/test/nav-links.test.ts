import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

function extractTos(src: string): string[] {
  const tos = new Set<string>();
  // Match to="..." and to: "..."
  const re = /\bto\s*[:=]\s*["'`](\/[^"'`]*)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) tos.add(m[1]);
  return [...tos];
}

function extractRoutes(src: string): string[] {
  const routes = new Set<string>(["/"]);
  const re = /<Route\s+[^>]*path=["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) routes.add(m[1]);
  return [...routes];
}

function matchesRoute(to: string, routes: string[]): boolean {
  const path = to.split(/[?#]/)[0];
  if (routes.includes(path)) return true;
  // Match dynamic segments like /foo/:id
  return routes.some((r) => {
    if (!r.includes(":")) return false;
    const pattern = "^" + r.replace(/:[^/]+/g, "[^/]+") + "$";
    return new RegExp(pattern).test(path);
  });
}

describe("nav link audit", () => {
  const routes = extractRoutes(read("src/App.tsx"));

  it("App.tsx exposes routes", () => {
    expect(routes.length).toBeGreaterThan(3);
  });

  for (const file of ["src/components/Header.tsx", "src/components/Footer.tsx"]) {
    it(`${file} has no links to missing routes`, () => {
      const tos = extractTos(read(file));
      const missing = tos.filter((t) => !matchesRoute(t, routes));
      expect(missing, `Broken links in ${file}: ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("does not reference legacy /founding-clients path", () => {
    for (const file of ["src/components/Header.tsx", "src/components/Footer.tsx"]) {
      expect(read(file)).not.toMatch(/\/founding-clients\b/);
    }
  });
});