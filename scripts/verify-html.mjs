import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
const paths = [...readFileSync('dist/sitemap.xml', 'utf8').matchAll(/<loc>(.*?)<\/loc>/g)].map(m => new URL(m[1]).pathname).concat('/thank-you');
for (const path of paths) {
  const d = new JSDOM(readFileSync(`dist${path === '/' ? '' : path}/index.html`, 'utf8')).window.document;
  const canonical = d.querySelectorAll('link[rel=canonical]');
  if (d.querySelectorAll('title').length !== 1 || canonical.length !== 1 || canonical[0].href !== `https://www.gatehousehomecleaning.com${path}` || d.querySelectorAll('h1').length !== 1) throw Error(`Metadata mismatch: ${path}`);
  if (!d.querySelector('#root')?.textContent.trim()) throw Error(`Empty crawler content: ${path}`);
  for (const img of d.querySelectorAll('img[src^="/assets/"]')) if (!existsSync(`dist${img.getAttribute('src')}`)) throw Error(`Missing image: ${img.src}`);
  for (const schema of d.querySelectorAll('script[type="application/ld+json"]')) JSON.parse(schema.textContent);
  if (path === '/thank-you' && !d.querySelector('meta[name=robots]')?.content.includes('noindex')) throw Error('Receipt must not be indexed');
}
console.log(`${paths.length} pages: metadata, textual content, assets, structured data and noindex verified.`);
