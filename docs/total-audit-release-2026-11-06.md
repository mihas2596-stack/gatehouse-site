# Total audit fixes — 6 November 2026

Base: main / production `68a07bfea329faea7a9904e737265d3cfd7e21e7`.
Owner authorized implementation and deployment of the audit fixes, plus one
more week of reduced test prices. No live charge, real cleaner dispatch,
new client Terms acceptance or historical booking reprice is part of release QA.

| Audit findings | Implementation / limit |
|---|---|
| F01–F06 | Per-booking state; explicit card choice and replacement; strict card-choice and cancellation persistence; cancelled views. Checkout uses the exact SetupIntent card. Charging pins the visit's selected card rather than the shared customer default. |
| F07, F12, F13 | New visit checklists map the 43 public standard tasks to rooms, include paid extras, additional zones, and first Deep work. Existing live checklists remain as agreed. |
| F08, F14 | Unknown network/database state never becomes successful booking/card advice. Missing visit insert returns failure before success emails. |
| F09, F17 | Own booking name and original confirmation deadline; shared Stripe identity is never rewritten to bypass charge validation. |
| F10, F11, F24, F25 | Photo-based progressing retention batches; 90-day draft expiry; failed storage deletes retain retry records; decode failures reject files. |
| F15, F16, F38, F39 | Escaped owner email fields; separate action and notification outcomes; resend current status; consistent readable email layouts and direct actions; contact acknowledgment failure visible. Provider acceptance is not proof of inbox delivery. |
| F18 | Paid-visit next-invitation action, with 24h repeat guard; client requests a fresh visit with current price and consent. Public copy states each visit is arranged and confirmed. No automatic recurring schedule claimed. |
| F19 | Main complaint action is Report an issue, which blocks charging immediately. Email remains a manual owner workflow; inbox integration and automatic email-to-dispute handling are NOT configured by this release. UPDATE (PR #6, HEAD 9deb615): outdated — automatic processing of replies to the photo-report email was added (`gh_accept_report_email_reply`, `RESEND_REPORT_REPLY_DOMAIN` / `RESEND_REPORT_REPLIES_ENABLED`); a verified client reply now opens an issue and blocks the charge. |
| F20–F22 | Human status labels, issue priority, past-date review, older-visit pagination and explicit owner test flag. Historic test bookings are not deleted automatically. |
| F23 | Prior release already preserves new phone contacts and provides owner-only historical repair. Missing historical numbers are NOT guessed or filled in bulk. |
| F26–F33 | Heading hierarchy, concise hero/services/contact/area copy, city prefill, clearer client card step, cleaner before/after photo controls and finish readiness; mobile CTA hides during focus and no longer floats as a pill over text. |
| F34 | Existing first-Deep pricing rule retained: changing that policy requires a business decision, not a silent audit fix. |
| F35 | Owner pre-dispatch reminder; no invented background-check/insurance claims. Actual contractor acceptance, supplies, insurance and repair capacity require operational verification. |
| F36, F37 | Calmer entry explanation; existing full-visit fee disclosed; Privacy date and actual photo/access lifecycle aligned. Terms and payment rules retained. |
| F40 | Added consent-gated confirmed/report/payment/issue page-view events. Real analytics configuration and conversion improvement require separate measurement; no lift guaranteed. |

## Price window

Both browser and server cutoff: `2026-11-13T20:59:59Z`, Friday 13 November
2026 at 23:59 Minsk. Existing 0.01 scaling and $1.50 maximum stay unchanged.
Pinned prices of existing bookings stay unchanged. Full prices resume after
this window automatically. Reduced LIVE prices are not Stripe test mode.

## Validation

Meaningful regression coverage includes new card journal failures, verified
Checkout persistence, cross-booking state and card isolation, booking insert
failure, exact paid work scope, escaped email content, retention progress,
failed deletion retry, original deadlines and past-date owner tasks. Existing
payment, consent, issue, idempotency and 5760-case matrices are retained.

Final full-suite, typecheck, production/prerender build, preview and production
verification outcomes are recorded in the external release report. A paid live
end-to-end flow and a Stripe test-mode staging cycle are not claimed.
