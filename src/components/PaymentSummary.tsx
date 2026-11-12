export default function PaymentSummary({ showCard = false, compact = false }: { showCard?: boolean; compact?: boolean }) {
  if (compact) {
    return (
      <section aria-labelledby="quote-payment-heading" className="rounded-xl border border-border bg-card p-4 text-left sm:p-5">
        <h2 id="quote-payment-heading" className="font-heading text-2xl font-bold text-sage-foreground">When you pay</h2>
        <p className="mt-2 text-base leading-relaxed">
          Save your card with Stripe. Gatehouse never sees or stores your full card number.
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-base leading-relaxed">
          <li>After cleaning, we send your photo report. Approve it to pay.</li>
          <li>If you neither approve nor report an issue, we charge your card automatically <strong>24 hours after we send the report</strong>.</li>
          <li>Report an issue within those 24 hours to stop automatic payment for this visit. You approve again to pay after the issue is resolved.</li>
        </ul>
      </section>
    );
  }

  return <section aria-label="How payment works" className="rounded-xl border border-border bg-card p-5 sm:p-6 text-left">
    <h3 className="font-heading text-2xl font-bold">{showCard ? "Save your card. Pay after cleaning." : "When you pay"}</h3>
    <dl className="mt-5 space-y-5 text-lg leading-relaxed">
      {showCard && <div><dt className="font-semibold">Today: $0</dt><dd className="mt-1 text-base">Save a card for this visit through Stripe, so you won’t need to enter it after cleaning. Gatehouse never sees or stores your full card number.</dd></div>}
      <div><dt className="font-semibold">Review, then pay</dt><dd className="mt-1 text-base">After cleaning, we send your photo report. Choose “Approve &amp; pay” to charge your card.</dd></div>
      <div><dt className="font-semibold">24 hours to review</dt><dd className="mt-1 text-base">Your card is charged automatically 24 hours after we send the report if you haven’t approved it or reported an issue.</dd></div>
      <div><dt className="font-semibold">Something missed?</dt><dd className="mt-1 text-base">Use “Report an issue” on your visit page within those 24 hours. Automatic charging stays off for this visit, including after the fix. You approve again to pay.</dd></div>
    </dl>
  </section>;
}
