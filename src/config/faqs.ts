// All site FAQs live here so /faq and any JSON-LD stay in sync.
export const FAQS: { q: string; a: string; link?: { href: string; label: string } }[] = [
  {
    q: "How much does it cost?",
    a: "Your price depends on bedrooms, full bathrooms, the type of clean, frequency, cleaning history and add-ons. Square footage and half bathrooms help us plan your visit; they do not change the calculator price. Most homes can see an estimate online. Larger homes — email hello@gatehousehomecleaning.com for a custom quote.",
    link: { href: "/#pricing", label: "See the pricing table" },
  },
  {
    q: "How do I pay?",
    a: "Booking is free — nothing is charged when you send your request. After the clean you get a room-by-room photo report, and your card is charged when you approve the report.",
  },
  {
    q: "When exactly is my card charged?",
    a: "When you approve your photo report — or automatically 24 hours after we send it, if you haven't reported an issue. If the report email doesn't reach you, we pause and check manually.",
  },
  {
    q: "Is my card safe with you?",
    a: "Yes. When you pay, your card is processed securely through Stripe, the payment platform used by millions of businesses. We never see or store your full card number.",
  },
  {
    q: "Do I need to be home?",
    a: "No. You can give us a door code or leave a key. If you prefer to be home, that's fine too — you'll have the same arrival window every visit.",
  },
  {
    q: "What about pets?",
    a: "Pets are welcome. Add the pet option when you book so we plan extra time for hair and paw prints. Let us know if a pet should stay in a closed room while we work.",
  },
  {
    q: "How do I pause or cancel?",
    a: "Email us to reschedule or cancel. Reschedule or cancel free up to 48 hours before your visit. Later cancellations: $25. There's no long-term commitment, so you can pause the schedule any time.",
  },
  {
    q: "What if the cleaner can't make it?",
    a: "We contact you as soon as we know and offer the next available day that works for you. If we have to cancel a visit, you are never charged for it.",
  },
  {
    q: "What if I'm not happy with the cleaning?",
    a: "Missed something on the checklist? We fix it free within 72 hours. Email a photo of the missed item to hello@gatehousehomecleaning.com within 24 hours after your photo report is sent.",
  },
  {
    q: "Who will be cleaning my home?",
    a: "Cleans are done by independent cleaning professionals. We tell you your cleaner's name before each visit.",
  },
  {
    q: "Do you bring your own supplies and equipment?",
    a: "Yes. Every visit includes professional-grade supplies, vacuum, mop, microfiber cloths, and standard household cleaning products. You don't need to provide anything.",
  },
  {
    q: "What if you can't get into my home?",
    a: "If we can't get in at the scheduled time, the full visit price is charged.",
  },
  {
    q: "What if something gets damaged?",
    a: "Tell us within 48 hours with a photo. We'll review it with you directly.",
  },
];
