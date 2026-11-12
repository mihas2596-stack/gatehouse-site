export default function PaymentSummary({ showCard = false, compact = false }: { showCard?: boolean; compact?: boolean }) {
  if (compact) {
    return (
      <section aria-labelledby="quote-payment-heading" className="rounded-xl border border-border bg-card p-4 text-left sm:p-6">
        <h2 id="quote-payment-heading" className="font-heading text-3xl font-bold text-sage-foreground sm:text-4xl">When you pay</h2>
        <div className="mt-4 rounded-lg bg-sage/15 p-4 sm:p-5">
          <p className="text-2xl font-bold text-sage-foreground">$0 charged today</p>
          <p className="mt-2 text-lg leading-relaxed sm:text-xl sm:leading-relaxed">
            Save your card with Stripe for this visit. Only Stripe handles your full card number.
          </p>
        </div>
        <dl className="mt-5 divide-y divide-border text-lg leading-relaxed sm:text-xl sm:leading-relaxed">
          <div className="pb-4">
            <dt className="font-bold">Review your cleaning first</dt>
            <dd className="mt-1">
              We’ll send you a photo report after cleaning. Select <strong>Approve &amp; pay</strong> to pay.
              If you don’t approve or report an issue, we’ll charge your card automatically <strong>24 hours after we send the report</strong>.
            </dd>
          </div>
          <div className="pt-4">
            <dt className="font-bold">Something missed?</dt>
            <dd className="mt-1">
              Select <strong>Report an issue</strong> within those 24 hours to stop automatic payment for this visit.
              Once we resolve the issue, you choose when to approve and pay.
            </dd>
          </div>
        </dl>
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
