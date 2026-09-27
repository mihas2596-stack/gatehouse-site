import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Mail, MapPin, Clock, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "react-router-dom";
import SEO from "@/components/SEO";

const Contact = () => {
  const { toast } = useToast();
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    message: "",
    privacy: false,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fieldRefs = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    message: useRef<HTMLTextAreaElement>(null),
    privacy: useRef<HTMLInputElement>(null),
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const target = e.target as HTMLInputElement;
    if (target.type === "checkbox") {
      setFormData((prev) => ({ ...prev, [target.name]: target.checked }));
      setErrors((p) => ({ ...p, [target.name]: "" }));
      return;
    }
    setFormData((prev) => ({ ...prev, [target.name]: target.value }));
    setErrors((p) => ({ ...p, [target.name]: "" }));
  };

  const validate = () => {
    const errs: Record<string, string> = {};
    const name = String(formData.name ?? "").trim();
    if (name.length < 1) errs.name = "Enter your name.";
    const email = String(formData.email ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = "Enter a valid email, like name@example.com.";
    const message = String(formData.message ?? "").trim();
    if (message.length < 1) errs.message = "Enter your question.";
    if (!formData.privacy) errs.privacy = "Please acknowledge our Privacy Policy to continue.";
    return errs;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      const order: Array<keyof typeof fieldRefs> = ["name", "email", "message", "privacy"];
      for (const f of order) {
        if (errs[f]) {
          fieldRefs[f].current?.focus();
          break;
        }
      }
      return;
    }
    setIsSubmitting(true);

    try {
      const res = await fetch("/api/send-contact-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name.trim(),
          email: formData.email.trim(),
          phone: "",
          service: "Question / general inquiry",
          date: "",
          time: "",
          message: formData.message.trim(),
          founding: false,
        }),
      });

      if (!res.ok) throw new Error("Contact request failed");

      window.location.href = "/thank-you";
      return;
    } catch (err) {
      console.error("Contact form error:", err);
      toast({
        title: "Something went wrong",
        description: "Please try again or email us at hello@gatehousehomecleaning.com.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="pt-24">
      <SEO
        title="Contact Gatehouse Home Cleaning"
        description="Send your question about house cleaning in North Atlanta and we reply the same day."
        url="https://gatehousehomecleaning.com/contact"
      />
      <section className="pt-12 pb-8 bg-warm-gradient">
        <div className="container text-center max-w-3xl">
          <p className="font-script text-xl text-golden mb-2">Questions?</p>
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
            Have a Question? <span className="text-gradient-gold">Message Us</span>
          </h1>
          <p className="text-foreground text-lg">
            This form is for general questions and inquiries. To book a cleaning, see your price online — then request your date. We confirm bookings within one business day.
          </p>
        </div>
      </section>

      <section className="pt-6 pb-16">
        <div className="container max-w-4xl">
          <div className="mb-6 rounded-xl border border-primary/30 bg-peach/30 px-5 py-4 text-center">
            <p className="text-sm md:text-base text-foreground">
              Ready to book?{" "}
              <Link to="/quote" className="font-semibold text-primary underline underline-offset-2">
                Get a quote &amp; book →
              </Link>
            </p>
          </div>
          <ContactForm
            formData={formData}
            handleChange={handleChange}
            handleSubmit={handleSubmit}
            isSubmitting={isSubmitting}
            errors={errors}
            fieldRefs={fieldRefs}
          />
        </div>
      </section>

      <section className="pb-16">
        <div className="container">
          <ContactInfo />
        </div>
      </section>
    </div>
  );
};

const ContactInfo = () => (
  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
    <div className="space-y-8">
    <div>
      <h2 className="font-heading text-2xl font-bold mb-6">Reach Out Anytime</h2>
      <div className="space-y-5">
        <a href="mailto:hello@gatehousehomecleaning.com" className="flex items-center gap-4 p-4 bg-card rounded-xl shadow-warm hover:shadow-warm-lg transition-all group min-h-[44px]">
          <div className="w-12 h-12 rounded-lg bg-golden-light flex items-center justify-center group-hover:bg-golden/30 transition-colors">
            <Mail className="w-6 h-6 text-accent-foreground" />
          </div>
          <div>
            <p className="font-semibold">Email Us</p>
            <p className="text-muted-foreground text-sm">hello@gatehousehomecleaning.com</p>
          </div>
        </a>
      </div>
    </div>
    </div>

    <div className="space-y-8">
    <div className="flex items-start gap-3 text-sm text-muted-foreground">
      <Clock className="w-5 h-5 text-golden mt-0.5" />
      <div>
        <p className="font-medium text-foreground">Response Time</p>
        <p>We reply within one business day.</p>
        <p>Booking requests are confirmed within one business day.</p>
      </div>
    </div>

    <div className="flex items-start gap-3 text-sm text-muted-foreground">
      <MapPin className="w-5 h-5 text-golden mt-0.5" />
      <div>
        <p className="font-medium text-foreground">Service Area</p>
        <p>North Atlanta suburbs — Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell.</p>
      </div>
    </div>

    <div className="rounded-xl overflow-hidden shadow-warm">
      <iframe
        src="https://www.google.com/maps?q=Suwanee,+GA&center=34.07,-84.05&z=10&hl=en&gl=us&output=embed"
        width="100%"
        height="250"
        style={{ border: 0 }}
        allowFullScreen
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        title="Gatehouse Home Cleaning Service Area"
      />
    </div>
    </div>
  </div>
);

interface ContactFormProps {
  formData: Record<string, string | boolean>;
  handleChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
  handleSubmit: (e: React.FormEvent) => void;
  isSubmitting: boolean;
  errors: Record<string, string>;
  fieldRefs: {
    name: React.RefObject<HTMLInputElement>;
    email: React.RefObject<HTMLInputElement>;
    message: React.RefObject<HTMLTextAreaElement>;
    privacy: React.RefObject<HTMLInputElement>;
  };
}

const ContactForm = ({ formData, handleChange, handleSubmit, isSubmitting, errors, fieldRefs }: ContactFormProps) => (
  <div id="contact-form" className="scroll-mt-16 md:scroll-mt-28">
    <form onSubmit={handleSubmit} noValidate className="bg-card rounded-2xl p-6 sm:p-8 md:p-10 shadow-warm-lg">
      <h3 className="font-heading text-2xl font-bold mb-2">Send us a question</h3>
      <p className="text-foreground text-sm mb-8">
        General questions only. To book a cleaning, please{" "}
        <Link to="/quote" className="font-semibold text-primary underline underline-offset-2">get a quote &amp; book</Link>.
      </p>

      <p className="text-sm text-muted-foreground mb-4">Fields marked * are required.</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div>
          <label htmlFor="name" className="block text-sm font-medium mb-1.5">Your Name *</label>
          <input
            id="name" name="name" type="text" required autoComplete="name" ref={fieldRefs.name}
            value={String(formData.name ?? "")} onChange={handleChange}
            aria-required="true"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "name-error" : undefined}
            placeholder="Your name"
            className="w-full px-4 py-3 rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-all min-h-[44px]"
          />
          {errors.name && <p id="name-error" role="alert" className="mt-1 text-sm text-destructive">{errors.name}</p>}
        </div>
        <div>
          <label htmlFor="email" className="block text-sm font-medium mb-1.5">Email Address *</label>
          <input
            id="email" name="email" type="email" required autoComplete="email" ref={fieldRefs.email}
            value={String(formData.email ?? "")} onChange={handleChange}
            aria-required="true"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            placeholder="you@example.com"
            className="w-full px-4 py-3 rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-all min-h-[44px]"
          />
          {errors.email && <p id="email-error" role="alert" className="mt-1 text-sm text-destructive">{errors.email}</p>}
        </div>
        <div className="md:col-span-2">
          <label htmlFor="message" className="block text-sm font-medium mb-1.5">Your Message *</label>
          <textarea
            id="message" name="message" rows={5} required ref={fieldRefs.message}
            value={String(formData.message ?? "")} onChange={handleChange}
            aria-required="true"
            aria-invalid={!!errors.message}
            aria-describedby={errors.message ? "message-error" : undefined}
            placeholder="What would you like to ask?"
            className="w-full px-4 py-3 rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-all resize-none"
          />
          {errors.message && <p id="message-error" role="alert" className="mt-1 text-sm text-destructive">{errors.message}</p>}
        </div>
      </div>

      <div className="mt-5 flex items-start gap-3">
        <input
          id="privacy"
          name="privacy"
          type="checkbox"
          ref={fieldRefs.privacy}
          checked={!!formData.privacy}
          onChange={handleChange}
          aria-required="true"
          aria-invalid={!!errors.privacy}
          aria-describedby={errors.privacy ? "privacy-error" : undefined}
          className="mt-1 h-5 w-5 rounded border-input text-primary focus:ring-2 focus:ring-ring"
        />
        <label htmlFor="privacy" className="text-sm text-foreground leading-snug">
          I acknowledge Gatehouse Home Cleaning will use my email to reply to this question and that my information is handled per the{" "}
          <Link to="/privacy" className="underline text-primary">Privacy Policy</Link>.
        </label>
      </div>
      {errors.privacy && <p id="privacy-error" role="alert" className="mt-1 text-sm text-destructive">{errors.privacy}</p>}

      <Button variant="hero" size="xl" type="submit" disabled={isSubmitting} className="w-full mt-6 min-h-[44px]">
        {isSubmitting ? "Sending..." : <>Send My Question <Send className="w-5 h-5" /></>}
      </Button>

      <p className="text-xs text-foreground text-center mt-4">
        We'll respond within one business day. We use your details only to reply to you. See our Privacy Policy.
      </p>
    </form>
  </div>
);

export default Contact;
