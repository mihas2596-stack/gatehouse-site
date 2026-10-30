// All site FAQs live here so /faq and any JSON-LD stay in sync.
export const FAQS: { q: string; a: string; link?: { href: string; label: string } }[] = [
  {
    q: "How much does it cost?",
    a: "Your price depends on bedrooms, full bathrooms, the type of clean, frequency, cleaning history and add-ons. Square footage and half bathrooms help us plan your visit; they do not change the calculator price. Most homes can see an estimate online. Larger homes — email hello@gatehousehomecleaning.com for a custom quote.",
    link: { href: "/#pricing", label: "See the pricing table" },
  },
  {
    q: "How do I pay?",
    a: "Booking is free — nothing is charged when you send your request. After the clean you get a room-by-room photo report. Your card is charged when you approve the report, or automatically 24 hours after we send it if you haven't reported an issue.",
  },
  {
    q: "When exactly is my card charged?",
    a: "Your card is charged when you approve the report, or automatically 24 hours after we send it if you haven't reported an issue. If we learn the report email could not be delivered, the automatic charge does not run until the report reaches you another way.",
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
    a: "Cancel or reschedule on your visit page or by email. Reschedule or cancel free up to 48 hours before your visit. Later cancellations: $25. There's no long-term commitment, so you can pause the schedule any time.",
  },
  {
    q: "What if the cleaner can't make it?",
    a: "We contact you as soon as we know and offer the next available day that works for you. If we have to cancel a visit, you are never charged for it.",
  },
  {
    q: "What if I'm not happy with the cleaning?",
    a: "Missed something on the checklist? We fix it free within 72 hours. Tap Report an issue on your photo report page — or email a photo of the missed item to hello@gatehousehomecleaning.com — within 24 hours after your photo report is sent. While your issue is open, the automatic charge is blocked for this visit. After we fix it, you approve the report again to pay — the automatic charge never resumes on its own.",
  },
  {
    q: "Who will be cleaning my home?",
    a: "Cleans are done by independent cleaning professionals, matched to your home by Gatehouse. Before your visit, your visit page shows your cleaner's name (and a photo when they've agreed to share one). If your cleaner ever changes, we tell you before the visit.",
  },
  {
    q: "What happens with the photos in my report?",
    a: "Photos are taken only for your private report — rooms, not people; faces, documents and screens are avoided. Only you (through your private link) and the Gatehouse team can see them. They're kept for 90 days, then deleted, and never published without your separate written permission. You can mark rooms as not-to-photograph on your visit page before the visit.",
  },
  {
    q: "Do you bring your own supplies and equipment?",
    a: "Yes. Every visit includes professional-grade supplies, vacuum, mop, microfiber cloths, and standard household cleaning products. You don't need to provide anything.",
  },
  {
    q: "What if you can't get into my home?",
    a: "We re-check your access instructions, try to reach you, and wait before marking the visit missed. If we still can't get in, the full visit price is charged under our Terms. Clear entry instructions on your visit page prevent this — you can add or change them any time before the visit.",
  },
  {
    q: "What if something gets damaged?",
    a: "Tell us within 48 hours with a photo. We'll review it with you directly.",
  },
];
