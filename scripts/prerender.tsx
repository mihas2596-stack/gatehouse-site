import React from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { Routes, Route } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Layout from "../src/components/Layout";
import Index from "../src/pages/Index";
import Services from "../src/pages/Services";
import Quote from "../src/pages/Quote";
import About from "../src/pages/About";
import Areas from "../src/pages/Areas";
import CityPage from "../src/pages/CityPage";
import Contact from "../src/pages/Contact";
import WhatsIncluded from "../src/pages/WhatsIncluded";
import FAQ from "../src/pages/FAQ";
import Reviews from "../src/pages/Reviews";
import Privacy from "../src/pages/Privacy";
import Terms from "../src/pages/Terms";
import ThankYou from "../src/pages/ThankYou";

// Render actual React pages at build time, so crawlers and AI readers receive
// the same business information without first executing the client bundle.
const routes = [
  ["/", Index], ["/services", Services], ["/quote", Quote], ["/about", About],
  ["/areas", Areas], ["/contact", Contact], ["/whats-included", WhatsIncluded],
  ["/faq", FAQ], ["/founding", Reviews], ["/privacy", Privacy], ["/terms", Terms],
  ["/thank-you", ThankYou],
] as const;
const dist = resolve("dist");
const template = readFileSync(resolve(dist, "index.html"), "utf8");
const sitemap = readFileSync(resolve(dist, "sitemap.xml"), "utf8");
const paths = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => new URL(match[1]).pathname);
paths.push("/thank-you");
HelmetProvider.canUseDOM = false;
for (const path of paths) {
  const context: { helmet?: { title: { toString(): string }; meta: { toString(): string }; link: { toString(): string }; script: { toString(): string } } } = {};
  const content = renderToString(
    <HelmetProvider context={context}>
      <StaticRouter location={path}>
        <Routes><Route element={<Layout />}>
          {routes.map(([route, Page]) => <Route key={route} path={route} element={<Page />} />)}
          <Route path="/areas/:city" element={<CityPage />} />
        </Route></Routes>
      </StaticRouter>
    </HelmetProvider>,
  );
  if (!context.helmet || !content.includes("<h1")) throw new Error(`Cannot render ${path}`);
  const { helmet } = context;
  const head = helmet.title.toString() + helmet.meta.toString() + helmet.link.toString() + helmet.script.toString();
  const html = template
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/<meta\s+(?:name="(?:description|robots|twitter:[^"]+)"|property="og:[^"]+")[^>]*>/g, "")
    .replace(/<link\s+rel="canonical"[^>]*>/g, "")
    .replace("</head>", `${head}</head>`)
    .replace('<div id="root"></div>', `<div id="root">${content}</div>`);
  const folder = path === "/" ? dist : resolve(dist, path.slice(1));
  mkdirSync(folder, { recursive: true });
  writeFileSync(resolve(folder, "index.html"), html);
}
console.log(`Prerendered ${paths.length} pages.`);
