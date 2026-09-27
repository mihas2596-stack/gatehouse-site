# Roadmap

## Done
- Single policy wording (cancellation, payment, service concerns, damage, plan frequency, optional SMS consent) across homepage, /quote, /terms.

## Open
- Every-other-week positioning rewrite (uploaded brief):
  - Homepage hero H1/subline/no-promo line, CTA text "See My Exact Price", CTA subline, 3 badges
  - Pricing section: no-mandatory-deep-clean copy; replace "Starting prices" table with every-other-week price table by size band (from pricing config)
  - How it works step 2 copy
  - Services page: H1, card order, remove Office & Commercial, remove all prices, card buttons
  - About: H1 "Two Brothers, One Fixed Schedule"; remove "sanctuary", "It's Caring", "based in Suwanee and Sugar Hill"
  - City list + order everywhere (Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta); /areas hero + FAQ; delete corridor/lake/expanding phrases

## Open — /quote calculator rebuild
- Field order: sq ft band -> bedrooms -> full baths -> half baths -> cleaned-in-last-3-months radio -> frequency -> ZIP -> extras
- Sq ft bands affect price; half baths 0/1/2; frequency = every other week (default) / one-time only
- Service types: Regular clean (default), Move-in / Move-out (remove Recurring card)
- Result: one price if recently cleaned; else "First visit: $X" + "Then $Y every other week"
- Price shows before ZIP; ZIP only validates service area
- Result copy fixed-price sentence; remove ~3 hours / $45hr / "Estimated price"
- Delete FIRST CLEAN OFFER box + checkbox; founding price as one result line, no strikethrough
- H1 "See Your Exact Price", subline "No email needed to see your price."
- Add-ons with fixed prices in config: inside oven, inside fridge, interior windows (per window), pets
- Homepage/services tables read the same config

## New brief (2026-09-16)
- [ ] /whats-included page: H1 "What's Included in Every Visit", room-by-room checklist (kitchen, bathrooms, bedrooms, living areas), add-ons from config, "Not included" list. Link from header, footer, homepage section (button "See the full checklist").
- [ ] After booking submit: "What happens next" 4-step block.
- [ ] /faq page: move all FAQs there, add 5 new questions; link in header + footer; About links "See our FAQ".

## Technical SEO brief (2026-09-16)
- [ ] One canonical per route (remove static "/" canonical from index.html)
- [ ] Prerender all routes to static HTML at build
- [ ] Unique title/description per route (list in brief)
- [ ] og/twitter per route; no "guarantee", no 3-city lists
- [ ] /sitemap.xml + robots.txt reference
- [ ] Real 404 page with 404 status
- [ ] Homepage JSON-LD HouseCleaningService, 6 City areaServed, no address/rating/review
- [ ] Homepage: room checklist H3s rendered once
- [ ] City pages /areas/{sugar-hill,suwanee,buford,duluth,johns-creek,alpharetta}, unique H1/title/desc, 150+ words

## SEO pass (done)
- Static canonical removed from index.html; per-route canonical/title/description/og/twitter via SEO component (added to Quote, Privacy; NotFound noindex)
- sitemap.xml generated + referenced in robots.txt
- Homepage JSON-LD -> HouseCleaningService, 6 City areaServed, no address/rating/review
- Room checklist headings rendered once (IncludedRooms component)
- City pages /areas/{6 slugs} with unique H1/title/description/150+ words; linked from homepage chips and /areas cards

## Not done
- Build-time prerendering + real HTTP 404 status: not available on this hosting/SPA setup without a new dependency

## Pending (Sep 17)
- [ ] Rebuild /quote pricing logic to fixed tier prices (S/M/L) per uploaded brief — awaiting answers on tiers, frequency, founding rate, add-on charging.
- [x] /quote booking form: required Terms+Privacy consent checkbox, required photo-report consent, new SMS opt-in text, submit disabled until valid, save consents + texts + timestamp, min date today+3, blur validation, autocomplete attrs, mobile sticky price bar.
- [x] /contact form: same validation messages, required + autocomplete attributes.
- [ ] "Approve, then pay" rewrite: home cards + Something missed, /quote line, FAQ answers (+ new lockout question), city pages, /terms and /privacy texts.
- [x] Technical: header burger below 1440px; per-route titles/descriptions/canonicals; home LocalBusiness JSON-LD; 404 noindex; a11y (aria-expanded/controls, aria-hidden icon, footer logo contrast); /areas map showing all 6 cities.

## Current request (Sep 27)
- [ ] Add Roswell to service-area pages, links, sitemap, footer, and quote ZIP eligibility.
- [ ] Update homepage approval/owner/founding copy and remove duplicate quote action.
- [ ] Show base recurring price before cleaner-history answer; add address, accessible date, consent, and review step.
- [ ] Verify mobile booking flow and layout.
