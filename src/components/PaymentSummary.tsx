export default function PaymentSummary({ showCard = false }: { showCard?: boolean }) {
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
