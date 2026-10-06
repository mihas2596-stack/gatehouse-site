# Gatehouse: implementation and release status

Prepared 2026-10-04 against public main ee7a53e. **Not published.**

## Implemented

- Preserve all calculator price tables, discount values and pricing functions.
- Require cleaning history for standard cleaning; show the first deep-clean amount on mobile and reset the review when selections change.
- Route one-time standard requests to one-time frequency. Expose the existing deep-clean service on the services page.
- Separate general inquiries from booking requests in the backend emails and success screen. A visit to the success URL alone is not a receipt.
- Server-side date and service-area validation, HTML escaping, delivery timeout, origin check and a hidden bot trap.
- Stable request UUIDs and separate Resend owner/customer idempotency keys for retries. Owner delivery failure remains an error; failed customer acknowledgment does not erase a received request.
- Improve page/header clearance, mobile wordmark, wrapping controls, footer navigation, menu keyboard access, focus and reduced-motion behavior.
- Align pricing explanation with the current calculator; replace “exact price” promises with price/estimate wording; remove unsupported claims about two brothers performing every clean.
- Prerender 19 actual React pages during the production build, with route-specific metadata and canonical www URLs. Noindex the receipt page. Organization and FAQ structured data contain no invented reviews or address.
- Add consent-aware GTM integration events and sanitized campaign labels. Names, email, address, phone, ZIP and notes are never sent in these events. No new analytics cookies/storage.
- Upgrade React Router to patched v7, apply compatible dependency fixes, remove Lovable tooling and broken Lovable Playwright imports. Build configuration explicitly uses Node 22.
- Add a GitHub Actions build/test/type-check workflow. It activates only after the source is pushed.

## Validation

Production build, 20 automated tests, app/API type checks and targeted lint passed before final packaging. Verify the final build again after applying the patch. All 19 HTML pages were checked for unique title/canonical/H1, valid structured data and local image paths. Pricing configuration has no diff from the baseline. `npm audit --omit=dev` reports zero known vulnerabilities in production dependencies; some development-tool advisories still require major upgrades and have not been forced.

Browser visual QA could not run because the environment blocked the internal preview address. This is not a visual pass. No live test leads were sent.

## Release prerequisites still open

1. GitHub installed, but this session exposes no authenticated GitHub tool or git push credential. Push dry-run failed. No passwords or tokens should be sent in chat.
2. Verify the Vercel project connects to this repo/main and inspect the resulting deployment. Current live artifact cannot be mapped conclusively to a commit. Reconcile Muse's unpublished c7cba46/f60f466 first; this patch already removes the broken pixel insertion and includes the metadata correction.
3. Old clearspaceatlanta.com remains a separate Lovable-hosted build with a dead phone. Redirect DNS/hosting access is absent here. Use a permanent redirect preserving useful paths, then verify both root and deep URLs. Do not claim this is done.
4. GTM container GTM-5CRF8657 and Termly are present. Actual GA4, Ads and consent/tag settings are inaccessible. Map gh_lead_submit to the booking-lead conversion; gh_contact_submit is a question, not a booking. Configure page views to avoid double counts, test consent refusal/grant and confirm receipt of events before spending.
5. Verify operational photo-report, card-payment, SMS and response-time promises against Muse's actual fulfillment setup. No live card-payment integration was added. Current website prices are explicitly not yet approved; kept unchanged by owner instruction.

Do not describe this package as an ideal or advertising-ready live site until deployment, browser QA, live email delivery, consent/tag checks and operational promises are verified.
