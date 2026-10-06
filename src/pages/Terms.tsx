import SEO from "@/components/SEO";

const Terms = () => {
  return (
    <div className="page-shell">
      <SEO
        title="Terms of Service | Gatehouse Home Cleaning"
        description="Booking, payment, cancellation and service-concern terms for Gatehouse Home Cleaning in North Atlanta, Georgia."
        url="https://gatehousehomecleaning.com/terms"
      />
      <div
        className="mx-auto"
        style={{
          maxWidth: "800px",
          padding: "40px",
          lineHeight: 1.7,
        }}
      >
        <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-8">
          Terms of Service
        </h1>

        <p className="mb-6 font-semibold">
          Effective Date: May 15, 2026
          <br />
          Last Updated: September 17, 2026
        </p>

        <p className="mb-8">
          PLEASE READ THESE TERMS OF SERVICE CAREFULLY. BY ACCESSING OR USING THE GATEHOUSE HOME CLEANING WEBSITE OR BOOKING OUR CLEANING SERVICES, YOU AGREE TO BE LEGALLY BOUND BY THESE TERMS. IF YOU DO NOT AGREE, DO NOT USE OUR WEBSITE OR SERVICES.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">1. Agreement to Terms</h2>
        <p className="mb-8">
          These Terms of Service ("Terms") constitute a legally binding agreement between you ("Client," "you," "your") and Gatehouse Home Cleaning ("Company," "we," "us," "our") regarding your access to and use of the website located at{" "}
          <a
            href="https://gatehousehomecleaning.com"
            className="text-primary underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            https://gatehousehomecleaning.com
          </a>{" "}
          (the "Site") and any cleaning services we provide (collectively, the "Services").
        </p>
        <p className="mb-8">
          By using the Site or booking Services, you represent that you are at least 18 years of age and have the legal capacity to enter into a binding contract.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">2. Company Information</h2>
        <p className="mb-4 font-semibold">Gatehouse Home Cleaning</p>
        <p className="mb-4">
          Email:{" "}
          <a href="mailto:hello@gatehousehomecleaning.com" className="text-primary underline">
            hello@gatehousehomecleaning.com
          </a>
        </p>
        <p className="mb-4">Location: Atlanta, Georgia, United States</p>
        <p className="mb-8">
          Service area: Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell, Georgia.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">3. Description of Services</h2>
        <p className="mb-4">We provide residential cleaning services, which may include:</p>
        <ul className="list-disc pl-6 mb-8 space-y-2">
          <li>Standard cleaning (one-time or every other week)</li>
          <li>Deep cleaning (one-time)</li>
          <li>Move-in / move-out cleaning (one-time)</li>
          <li>Add-on services as listed on the Site: inside oven, inside fridge, inside cabinets, interior windows, pets</li>
        </ul>
        <p className="mb-8">
          We are an independent business and do not act as an employment agency.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">4. Booking, Confirmation, and Modification</h2>
        <p className="mb-4">
          <strong>4.1 Booking Requests.</strong> Submitting a booking request through the Site or by email constitutes an offer to engage our Services. No agreement for Services is formed until we issue written confirmation (email or SMS).
        </p>
        <p className="mb-4">
          <strong>4.2 Right to Refuse.</strong> We reserve the right, at our sole discretion, to decline, reschedule, or terminate any booking, including but not limited to circumstances involving safety concerns, abusive behavior, unsanitary conditions, or misrepresentation of property condition.
        </p>
        <p className="mb-8">
          <strong>4.3 Property Access.</strong> You are responsible for providing safe and lawful access to the property at the scheduled time. Failure to provide access constitutes a lockout (see Section 6).
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">5. Pricing and Payment</h2>
        <p className="mb-4">
          <strong>5.1 Price.</strong> The price shown at booking is based on the details you provide. If the home differs materially from those details, extra time is billed at $45 per hour. We contact you before extra time starts.
        </p>
        <p className="mb-4">
          <strong>5.2 Payment.</strong> You add a payment card when you book. Nothing is charged at booking. After each visit we send a room-by-room photo report. If you approve the report, or do not respond within 24 hours after it is sent, the visit is approved and your card is charged the visit price. If you report a missed item on the checklist within that window, your card is not charged for the visit until the item is fixed. Payments are processed by Stripe.
        </p>
        <p className="mb-4">
          <strong>5.3 Late Payment.</strong> Unpaid amounts may accrue a late fee of 1.5% per month or the maximum amount permitted by Georgia law, whichever is less. We may suspend Services for accounts with outstanding balances.
        </p>
        <p className="mb-8">
          <strong>5.4 Chargebacks.</strong> Initiating a chargeback without first attempting to resolve a dispute with us in good faith constitutes a material breach of these Terms.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">6. Cancellation, Rescheduling, and Lockouts</h2>
        <ul className="list-disc pl-6 mb-8 space-y-2">
          <li>
            <strong>Free cancellation or rescheduling:</strong> up to 48 hours before your visit.
          </li>
          <li>
            <strong>Later cancellations:</strong> $25.
          </li>
          <li>
            <strong>Lockout:</strong> if we cannot access the property at the scheduled time, the full visit price is charged.
          </li>
        </ul>
        <p className="mb-8">
          To cancel or reschedule, text, call or email us.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">7. Service Concerns</h2>
        <p className="mb-8">
          Missed something on the checklist? Tell us by text or email with a photo within 24 hours after your photo report is sent. We fix it free within 72 hours.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">8. Client Responsibilities</h2>
        <p className="mb-4">You agree to:</p>
        <ul className="list-disc pl-6 mb-8 space-y-2">
          <li>Provide accurate access information, including codes, keys, and instructions.</li>
          <li>Disclose in advance the presence of pets, alarm systems, surveillance devices, or any unusual conditions.</li>
          <li>Secure or remove fragile, valuable, irreplaceable, or sentimental items prior to our arrival.</li>
          <li>Ensure functional utilities (electricity, water, lighting, climate control) at the property.</li>
          <li>Provide a safe working environment, free of biohazards, pest infestations, and unlawful substances.</li>
          <li>Disclose any infectious illness in the household at least 24 hours prior to service.</li>
        </ul>
        <p className="mb-8">
          Failure to meet these responsibilities may result in additional charges, partial or non-performance of Services, or termination of the booking without refund.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">9. Services We Do Not Provide</h2>
        <p className="mb-4">
          For safety, liability, and ethical reasons, our cleaning professionals will not:
        </p>
        <ul className="list-disc pl-6 mb-8 space-y-2">
          <li>Handle biohazards including blood, bodily fluids, vomit, feces, or animal waste</li>
          <li>Clean exterior windows</li>
          <li>Move furniture or appliances exceeding 30 pounds</li>
          <li>Clean inside chimneys, fireplaces, or wood-burning stoves</li>
          <li>Address active pest or rodent infestations</li>
          <li>Clean areas affected by mold, asbestos, lead paint, or water damage requiring remediation</li>
          <li>Handle hazardous chemicals or weapons</li>
          <li>Provide childcare, eldercare, or pet care of any kind</li>
          <li>Climb beyond a two-step stool</li>
        </ul>
        <p className="mb-8">
          If these conditions are encountered on-site, our personnel may decline or limit Services without refund.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">10. Limitation of Liability</h2>
        <p className="mb-4">
          <strong>10.1 Liability.</strong> We perform Services with reasonable care. Service-related issues are handled under Section 7 (Service Concerns) and the damage-claims process described below.
        </p>
        <p className="mb-4">
          <strong>10.2 Damage Claims.</strong> All claims must be submitted in writing to{" "}
          <a href="mailto:hello@gatehousehomecleaning.com" className="text-primary underline">
            hello@gatehousehomecleaning.com
          </a>{" "}
          within 48 hours of service completion and must include: (a) detailed description of the damage; (b) photographic evidence; (c) proof of value where applicable. Claims submitted after 48 hours are waived.
        </p>
        <p className="mb-4">
          <strong>10.3 Exclusions.</strong> We are not liable for:
        </p>
        <ul className="list-disc pl-6 mb-4 space-y-2">
          <li>Pre-existing damage, wear and tear, or deterioration</li>
          <li>Damage to items not properly secured, mounted, or affixed (including loose shelving, unstable décor, improperly hung artwork)</li>
          <li>Damage to items of extraordinary sentimental or monetary value that were not specifically disclosed in writing prior to service</li>
          <li>Damage caused by use of cleaning products or methods at your specific request</li>
          <li>Damage caused by defects in the property itself</li>
          <li>Loss or damage to cash, jewelry, firearms, or financial instruments</li>
          <li>Indirect, incidental, consequential, special, exemplary, or punitive damages</li>
          <li>Lost profits, business interruption, or loss of data</li>
        </ul>
        <p className="mb-8">
          <strong>10.4 Liability Cap.</strong> TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR TOTAL AGGREGATE LIABILITY FOR ANY CLAIM ARISING OUT OF OR RELATED TO THESE TERMS OR THE SERVICES SHALL NOT EXCEED THE AMOUNT YOU PAID US FOR THE SPECIFIC SERVICE GIVING RISE TO THE CLAIM.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">11. Indemnification</h2>
        <p className="mb-8">
          You agree to indemnify, defend, and hold harmless Gatehouse Home Cleaning, its owners, officers, employees, agents, and independent contractors from and against any and all claims, liabilities, damages, losses, costs, and expenses (including reasonable attorneys' fees) arising out of or related to: (a) your breach of these Terms; (b) your violation of any law or third-party right; (c) your negligent or wrongful conduct; (d) any condition of the property not disclosed prior to service.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">12. Disclaimers</h2>
        <p className="mb-8">
          THE SITE AND SERVICES ARE PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
        </p>
        <p className="mb-8">
          We do not warrant that the Site will be uninterrupted, error-free, or free of viruses or other harmful components.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">13. Intellectual Property</h2>
        <p className="mb-8">
          All content on the Site — including but not limited to text, graphics, logos, icons, images, photographs, audio clips, video clips, data compilations, software, and the trade name "Gatehouse Home Cleaning" — is the exclusive property of the Company or its licensors and is protected by United States and international copyright, trademark, and other intellectual property laws.
        </p>
        <p className="mb-8">
          You may not reproduce, distribute, modify, create derivative works of, publicly display, publicly perform, republish, download, store, or transmit any of the Site content without our prior written consent.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">14. Privacy</h2>
        <p className="mb-8">
          Your use of the Site and Services is also governed by our{" "}
          <a href="/privacy" className="text-primary underline">
            Privacy Policy
          </a>
          , which is incorporated into these Terms by reference. By using the Services, you consent to the collection and use of your personal information as described in the Privacy Policy.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">15. Electronic Communications</h2>
        <p className="mb-8">
          We send booking emails to the address you provide. Standard message and data rates may apply. You may opt out of marketing communications at any time by replying STOP to text messages, clicking "unsubscribe" in emails, or contacting us directly. Text messages are sent only if you opt in at booking. Reply STOP at any time to stop text messages, or HELP for help.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">16. Dispute Resolution and Binding Arbitration</h2>
        <p className="mb-4">
          <strong>16.1 Informal Resolution.</strong> Before initiating any formal dispute, you agree to first contact us at{" "}
          <a href="mailto:hello@gatehousehomecleaning.com" className="text-primary underline">
            hello@gatehousehomecleaning.com
          </a>{" "}
          and attempt to resolve the dispute in good faith for a period of at least thirty (30) days.
        </p>
        <p className="mb-4">
          <strong>16.2 Binding Arbitration.</strong> If the dispute is not resolved informally, any controversy or claim arising out of or relating to these Terms or the Services shall be resolved by{" "}
          <strong>binding arbitration</strong>{" "}
          administered by the American Arbitration Association (AAA) under its Consumer Arbitration Rules. The arbitration shall be conducted in Atlanta, Georgia. Judgment on the arbitration award may be entered in any court of competent jurisdiction.
        </p>
        <p className="mb-4">
          <strong>16.3 Class Action Waiver.</strong> YOU AND GATEHOUSE HOME CLEANING EACH WAIVE THE RIGHT TO PARTICIPATE IN A CLASS ACTION LAWSUIT OR CLASS-WIDE ARBITRATION AGAINST THE OTHER PARTY. Claims must be brought in an individual capacity only.
        </p>
        <p className="mb-4">
          <strong>16.4 Exceptions.</strong> Notwithstanding the above, either party may bring a claim in small-claims court if it qualifies, and either party may seek injunctive or equitable relief in court to protect intellectual property rights.
        </p>
        <p className="mb-8">
          <strong>16.5 Opt-Out.</strong> You may opt out of the arbitration agreement in Section 16.2 by sending written notice to{" "}
          <a href="mailto:hello@gatehousehomecleaning.com" className="text-primary underline">
            hello@gatehousehomecleaning.com
          </a>{" "}
          within thirty (30) days of first agreeing to these Terms. The notice must include your full name, address, and a clear statement that you wish to opt out of arbitration.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">17. Governing Law and Jurisdiction</h2>
        <p className="mb-8">
          These Terms shall be governed by and construed in accordance with the laws of the State of Georgia, United States, without regard to its conflict of law principles. Subject to Section 16, the exclusive venue for any dispute not subject to arbitration shall be the state or federal courts located in Fulton County, Georgia, and you consent to the personal jurisdiction of such courts.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">18. Severability</h2>
        <p className="mb-8">
          If any provision of these Terms is held to be invalid, illegal, or unenforceable by a court of competent jurisdiction, the remaining provisions shall remain in full force and effect, and the invalid provision shall be replaced with a valid provision that most closely approximates the original intent.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">19. Waiver</h2>
        <p className="mb-8">
          No failure or delay by us in exercising any right under these Terms shall constitute a waiver of that right. No waiver shall be effective unless in writing and signed by an authorized representative of the Company.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">20. Assignment</h2>
        <p className="mb-8">
          You may not assign or transfer your rights or obligations under these Terms without our prior written consent. We may assign these Terms at any time without notice or consent.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">21. Force Majeure</h2>
        <p className="mb-8">
          We shall not be liable for any failure or delay in performance caused by events beyond our reasonable control, including but not limited to acts of God, natural disasters, pandemics, government actions, labor disputes, utility failures, or transportation disruptions.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">22. Entire Agreement</h2>
        <p className="mb-8">
          These Terms, together with the{" "}
          <a href="/privacy" className="text-primary underline">
            Privacy Policy
          </a>{" "}
          and any written confirmations issued for specific bookings, constitute the entire agreement between you and Gatehouse Home Cleaning regarding the Services and supersede all prior agreements, representations, and understandings, whether oral or written.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">23. Changes to These Terms</h2>
        <p className="mb-8">
          We may revise these Terms at any time by posting an updated version on the Site. The "Effective Date" and "Last Updated" fields at the top reflect the latest revision. Continued use of the Site or Services after changes are posted constitutes your acceptance of the revised Terms. We encourage you to review these Terms periodically.
        </p>

        <h2 className="font-heading text-2xl font-bold mb-4">24. Contact</h2>
        <p className="mb-4 font-semibold">Gatehouse Home Cleaning</p>
        <p className="mb-4">
          Email:{" "}
          <a href="mailto:hello@gatehousehomecleaning.com" className="text-primary underline">
            hello@gatehousehomecleaning.com
          </a>
        </p>
        <p className="mb-8">Atlanta, Georgia, United States</p>

        <p className="text-sm text-muted-foreground mt-12 pt-6 border-t border-border">
          These Terms of Service were prepared for Gatehouse Home Cleaning and are effective as of May 15, 2026.
        </p>
      </div>
    </div>
  );
};

export default Terms;
