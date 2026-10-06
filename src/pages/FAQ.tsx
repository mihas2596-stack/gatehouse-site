import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import SEO from "@/components/SEO";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { FAQS } from "@/config/faqs";

const FAQ = () => (
  <div className="page-shell">
    <SEO
      title="House Cleaning FAQ | Gatehouse Home Cleaning"
      description="Answers about payment, home access, pets, pausing visits and cancellation for cleaning in North Atlanta."
      url="https://gatehousehomecleaning.com/faq"
    />
    <Helmet>
      <script type="application/ld+json">{JSON.stringify({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: FAQS.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      })}</script>
    </Helmet>

    <section className="bg-warm-gradient py-12 md:py-16">
      <div className="container max-w-3xl text-center">
        <p className="font-script text-xl text-golden mb-2">Good questions</p>
        <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-3">
          Frequently Asked Questions
        </h1>
        <p className="text-foreground text-lg">
          Payment, access, pets, pausing and cancelling — all in one place.
        </p>
      </div>
    </section>

    <section className="py-12 md:py-16">
      <div className="container max-w-3xl">
        <Accordion type="single" collapsible className="rounded-2xl border border-border bg-card px-5">
          {FAQS.map((faq, index) => (
            <AccordionItem key={faq.q} value={`item-${index}`}>
              <AccordionTrigger className="text-left font-heading text-base font-semibold text-sage-foreground hover:no-underline md:text-lg">
                {faq.q}
              </AccordionTrigger>
              <AccordionContent className="text-base leading-relaxed text-muted-foreground">
                {faq.a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>

        <div className="mt-10 text-center">
          <Button asChild variant="hero" size="lg" className="rounded-full px-8">
            <Link to="/quote">See My Price</Link>
          </Button>
        </div>
      </div>
    </section>
  </div>
);

export default FAQ;
