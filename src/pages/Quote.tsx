import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";
import { campaignAttribution, trackFunnel } from "@/lib/measurement";
import { Calculator, Sparkles, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  calcPrice,
  firstVisitPrice,
  tierFor,
  FOUNDING_FIRST_CLEAN,
  FOUNDING_RECURRING,
  ADDONS,
  ADDONS_INCLUDED_IN,
  MAX_INTERIOR_WINDOWS,
  EXTRA_TIME_NOTE,
  SIZE_BANDS,
  SIZE_BAND_LABEL,
  BEDROOM_CHOICES,
  FULL_BATH_CHOICES,
  HALF_BATH_CHOICES,
  FREQUENCY_OPTIONS,
  FREQUENCY_LABEL,
  SERVICE_OPTIONS,
  SERVICE_LABEL_CALC,
  type CalcServiceKey,
  type FrequencyKey,
  type SizeBandKey,
} from "@/config/calculator";

import { SERVICE_ZIPS, earliestServiceDate, validServiceDate } from "@/config/service-area";

const resolveService = (param: string | null): CalcServiceKey => {
  const p = (param ?? "").toLowerCase();
  if (p.includes("move")) return "moveinout";
  if (p.includes("deep")) return "deep";
  return "standard";
};

// Exact consent wording, stored with every booking request.
const TERMS_CONSENT_TEXT =
  "I agree to the Terms of Service, including the arbitration clause in Section 16, and the Privacy Policy. I consent to booking texts at the number I provided, including confirmations, reminders and my photo report. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help.";
const PHOTO_CONSENT_TEXT =
  "I agree to photos of the cleaned rooms for the approval photo report I receive before my card is charged.";

const Quote = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [sizeBand, setSizeBand] = useState<SizeBandKey>("under2500");
  const [bedrooms, setBedrooms] = useState<number>(3);
  const [fullBaths, setFullBaths] = useState<number>(2);
  const [halfBaths, setHalfBaths] = useState<number>(0);
  const [recentlyCleaned, setRecentlyCleaned] = useState<"yes" | "no" | "">("");
  const [frequency, setFrequency] = useState<FrequencyKey>(params.get("frequency") === "onetime" ? "onetime" : "every2weeks");
  const [service, setService] = useState<CalcServiceKey>(resolveService(params.get("service")));
  const [zip, setZip] = useState("");
  const [isFounding, setIsFounding] = useState(params.get("founding") === "true");

  const [insideOven, setInsideOven] = useState(false);
  const [insideFridge, setInsideFridge] = useState(false);
  const [insideCabinets, setInsideCabinets] = useState(false);
  const [interiorWindows, setInteriorWindows] = useState(0);
  const [pets, setPets] = useState(false);

  const addons = useMemo(
    () => ({ insideOven, insideFridge, insideCabinets, interiorWindows, pets }),
    [insideOven, insideFridge, insideCabinets, interiorWindows, pets]
  );

  const tier = tierFor(bedrooms, fullBaths);
  const answered = recentlyCleaned !== "";
  const needsCleaningHistory = service === "standard" && !answered;
  const cleanedRecently = recentlyCleaned === "yes";
  // Frequency only applies to a standard clean.
  const isRecurring = service === "standard" && frequency === "every2weeks";
  // Standard cleans in homes not cleaned professionally in the last 3 months
  // start with a deep clean.
  const deepFirstVisit = service === "standard" && recentlyCleaned === "no";

  const recurringPrice = useMemo(
    () => calcPrice({ bedrooms, fullBaths, service: "standard", frequency: "every2weeks", addons }),
    [bedrooms, fullBaths, addons]
  );
  const oneTimePrice = useMemo(
    () => calcPrice({ bedrooms, fullBaths, service, frequency: "onetime", addons }),
    [bedrooms, fullBaths, service, addons]
  );
  const firstVisit = useMemo(
    () => firstVisitPrice(bedrooms, fullBaths, cleanedRecently, addons),
    [bedrooms, fullBaths, cleanedRecently, addons]
  );
  const deepOneTime = useMemo(
    () => calcPrice({ bedrooms, fullBaths, service: "deep", frequency: "onetime", addons }),
    [bedrooms, fullBaths, addons]
  );

  // The headline number used for the booking request.
  const mainPrice = isRecurring ? answered ? firstVisit : recurringPrice : deepFirstVisit ? deepOneTime : oneTimePrice;

  const foundingApplies = isFounding && service === "standard" && tier !== null;
  const foundingFirst = foundingApplies && tier ? FOUNDING_FIRST_CLEAN[tier] : null;
  const foundingRecurring = foundingApplies && tier && isRecurring ? FOUNDING_RECURRING[tier] : null;

  // ZIP eligibility: empty = neutral; 5 digits and not in set = out of area.
  const zipEntered = zip.length === 5;
  const zipPartial = zip.length > 0 && zip.length < 5;
  const zipInArea = zipEntered && SERVICE_ZIPS.has(zip);
  const zipOutOfArea = zipEntered && !SERVICE_ZIPS.has(zip);
  const canProceed = zipInArea && tier !== null;
  const showPrice = !zipOutOfArea && tier !== null;

  // ---- Booking request form ----
  const { toast } = useToast();
  const [booking, setBooking] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
    date: "",
    time: "",
    notes: "",
    website: "",
    termsConsent: false,
    photoConsent: false,
  });
  const [bookingErrors, setBookingErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reviewReady, setReviewReady] = useState(false);
  const requestRef = useRef<{ id: string; time: string } | null>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  // Any quote change must be reviewed again before the request is sent.
  useEffect(() => {
    setReviewReady(false);
    requestRef.current = null;
    setSubmitError("");
  }, [sizeBand, bedrooms, fullBaths, halfBaths, recentlyCleaned, frequency, service, zip, isFounding, addons]);
  const refs = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    phone: useRef<HTMLInputElement>(null),
    address: useRef<HTMLInputElement>(null),
    date: useRef<HTMLInputElement>(null),
    termsConsent: useRef<HTMLInputElement>(null),
    photoConsent: useRef<HTMLInputElement>(null),
  };
  // Preferred date: earliest is today + 3 days.
  const minDate = earliestServiceDate();

  const handleBookingChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    requestRef.current = null;
    const t = e.target as HTMLInputElement;
    if (t.type === "checkbox") {
      setBooking((p) => ({ ...p, [t.name]: t.checked }));
    } else {
      setBooking((p) => ({ ...p, [t.name]: t.value }));
    }
    setBookingErrors((p) => ({ ...p, [t.name]: "" }));
    setReviewReady(false);
  };

  const fieldError = (field: "name" | "email" | "phone" | "address" | "date", value: string) => {
    if (field === "name") return value.trim().length < 1 ? "Enter your name." : "";
    if (field === "email")
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? "" : "Enter a valid email, like name@example.com.";
    if (field === "address") return value.trim().length < 5 ? "Enter your street address." : "";
    if (field === "date") {
      if (!validServiceDate(value) || value < minDate) return `Choose a valid date on or after ${minDate}.`;
      return "";
    }
    const digits = value.replace(/\D/g, "");
    return digits.length === 10 || (digits.length === 11 && digits.startsWith("1")) ? "" : "Enter a 10-digit US phone number.";
  };

  const handleBookingBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const name = e.target.name as "name" | "email" | "phone" | "address" | "date";
    if (!(["name", "email", "phone", "address", "date"] as string[]).includes(name)) return;
    setBookingErrors((p) => ({ ...p, [name]: fieldError(name, e.target.value) }));
  };

  const validateBooking = () => {
    const errs: Record<string, string> = {};
    (["name", "email", "phone", "address", "date"] as const).forEach((f) => {
      const msg = fieldError(f, booking[f]);
      if (msg) errs[f] = msg;
    });
    if (!booking.termsConsent) errs.termsConsent = "Please agree to the Terms, Privacy Policy and booking texts.";
    if (!booking.photoConsent) errs.photoConsent = "Please agree to the approval photo report.";
    return errs;
  };

  const canSubmit = canProceed && showPrice && !needsCleaningHistory && !isSubmitting;

  const handleBookingSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (needsCleaningHistory) {
      document.getElementById("q-recent-yes")?.focus();
      return;
    }
    if (!canProceed) {
      toast({
        title: "Enter a ZIP in our service area",
        description: "We serve Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell.",
        variant: "destructive",
      });
      return;
    }
    const errs = validateBooking();
    setBookingErrors(errs);
    if (Object.keys(errs).length) {
      trackFunnel("gh_form_error", { form_type: "quote", error_stage: "validation" });
      const order: Array<keyof typeof refs> = ["name", "email", "phone", "address", "date", "termsConsent", "photoConsent"];
      for (const f of order) if (errs[f]) { refs[f].current?.focus(); break; }
      return;
    }
    if (!reviewReady) {
      setReviewReady(true);
      trackFunnel("gh_quote_review", { form_type: "quote", service_type: service, frequency: isRecurring ? "every2weeks" : "onetime" });
      requestAnimationFrame(() => { reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); reviewRef.current?.focus({ preventScroll: true }); });
      return;
    }
    setIsSubmitting(true);
    try {
      const included = ADDONS_INCLUDED_IN[service];
      const addonList = [
        insideOven && !included.includes("insideOven") ? ADDONS.insideOven.label : "",
        insideFridge && !included.includes("insideFridge") ? ADDONS.insideFridge.label : "",
        insideCabinets && !included.includes("insideCabinets") ? ADDONS.insideCabinets.label : "",
        interiorWindows > 0 ? `${interiorWindows} interior windows` : "",
        pets ? ADDONS.pets.label : "",
      ].filter(Boolean).join(", ");
      const summary = [
        SIZE_BAND_LABEL[sizeBand],
        `${bedrooms} BR`,
        `${fullBaths} full BA`,
        `${halfBaths} half BA`,
        `Tier ${tier}`,
        SERVICE_LABEL_CALC[service],
        service === "standard" ? FREQUENCY_LABEL[frequency] : "One-time",
         `Professionally cleaned in last 3 months: ${answered ? (cleanedRecently ? "Yes" : "No") : "Not answered"}`,
        `Street address: ${booking.address.trim()}`,
        zip ? `ZIP ${zip}` : "",
        isRecurring
          ? !answered || firstVisit === recurringPrice
            ? `Price $${recurringPrice} per visit, every other week`
            : `First visit $${firstVisit} per visit, then $${recurringPrice} per visit, every other week`
          : `Price $${mainPrice} per visit`,
        foundingApplies
          ? foundingRecurring !== null
            ? `Founding: first clean $${foundingFirst}, then $${foundingRecurring} per visit for 6 months`
            : `Founding: first clean $${foundingFirst}`
          : "",
        addonList ? `Add-ons (every visit): ${addonList}` : "",
      ].filter(Boolean).join(" · ");
      requestRef.current ??= { id: crypto.randomUUID(), time: new Date().toISOString() };
      const consentRecord = [
        "Consent record",
        `Timestamp: ${requestRef.current.time}`,
        `sms_consent: ${booking.termsConsent} — "${TERMS_CONSENT_TEXT}"`,
        `terms_consent: ${booking.termsConsent} — "${TERMS_CONSENT_TEXT}"`,
        `photo_consent: ${booking.photoConsent} — "${PHOTO_CONSENT_TEXT}"`,
      ].join("\n");
      const payload = {
        request_id: requestRef.current.id,
        website: booking.website,
        name: booking.name.trim(),
        phone: booking.phone.trim(),
        email: booking.email.trim(),
        service: SERVICE_LABEL_CALC[service],
        date: booking.date,
        time: booking.time,
        message: `${summary}${booking.notes ? `\n\nNotes: ${booking.notes}` : ""}\n\n${consentRecord}`,
        founding: foundingApplies,
        bedrooms: String(bedrooms),
        bathrooms: String(fullBaths + halfBaths * 0.5),
        zip: zip || "",
        address: booking.address.trim(),
        price: String(mainPrice ?? ""),
        source: "quote",
        attribution: campaignAttribution(),
        terms_consent: booking.termsConsent,
        photo_consent: booking.photoConsent,
        sms_consent: booking.termsConsent,
      };
      setSubmitError("");
      const res = await fetch("/api/send-contact-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let data: { ok?: boolean; customerEmailSent?: boolean; errors?: Record<string, string> } | null = null;
      try {
        data = await res.json();
      } catch {
        /* ignore */
      }
      if (!res.ok) {
        if (data?.errors) {
          const fieldErrs: Record<string, string> = {};
          const other: string[] = [];
          for (const [k, v] of Object.entries(data.errors)) {
            if (k === "name" || k === "email" || k === "phone" || k === "address" || k === "date" || k === "terms_consent" || k === "photo_consent") fieldErrs[k === "terms_consent" ? "termsConsent" : k === "photo_consent" ? "photoConsent" : k] = v;
            else other.push(v);
          }
          setBookingErrors((p) => ({ ...p, ...fieldErrs }));
          if (other.length) setSubmitError(other.join(" "));
          const first = (Object.keys(refs) as Array<keyof typeof refs>).find((f) => fieldErrs[f]);
          if (first) refs[first].current?.focus();
          setReviewReady(false);
          return;
        }
        throw new Error("Booking request failed");
      }
      if (!data?.ok) throw new Error("Booking request failed");
      trackFunnel("gh_lead_submit", { form_type: "quote", service_type: service, frequency: isRecurring ? "every2weeks" : "onetime" });
      navigate("/thank-you", { state: { submitted: true, kind: "booking", customerEmailSent: data.customerEmailSent } });
    } catch (err) {
      console.error("Quote booking error");
      trackFunnel("gh_form_error", { form_type: "quote", error_stage: "delivery" });
      setSubmitError("Something went wrong. Please try again or email us at hello@gatehousehomecleaning.com.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectClass =
    "w-full px-4 py-3 rounded-lg border border-border bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring";
  const addonNote = "(every visit)";
  const includedAddons = ADDONS_INCLUDED_IN[service];

  return (
    <div className="page-shell">
      <SEO
        title="See Your Cleaning Price | Gatehouse"
        description="Enter your home size, bedrooms and bathrooms to see your cleaning price online, then pick a day."
        url="https://gatehousehomecleaning.com/quote"
      />
      <section className="py-6 md:py-8 bg-warm-gradient">
        <div className="container max-w-3xl text-center">
          <p className="font-script text-xl text-golden mb-2">See Price</p>
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-3">
            See Your <span className="text-gradient-gold">Price</span>
          </h1>
          <p className="text-muted-foreground text-lg">
            No email needed to see your price.
          </p>
        </div>
      </section>

      <section className="pt-4 pb-12 md:pt-6 md:pb-16">
        <div className="container max-w-3xl">
          <div className="bg-card rounded-2xl p-6 sm:p-8 md:p-10 shadow-warm-lg">
            <div className="flex items-center gap-2 mb-6">
              <Calculator className="w-5 h-5 text-primary" />
              <h2 className="font-heading text-2xl font-bold">Quote Calculator</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="md:col-span-2">
                <label htmlFor="q-size" className="block text-sm font-medium mb-1.5">Home size (sq ft)</label>
                <select id="q-size" value={sizeBand} onChange={(e) => setSizeBand(e.target.value as SizeBandKey)} className={selectClass}>
                  {SIZE_BANDS.map((b) => (
                    <option key={b.key} value={b.key}>{b.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="q-bed" className="block text-sm font-medium mb-1.5">Bedrooms</label>
                <select id="q-bed" value={bedrooms} onChange={(e) => setBedrooms(Number(e.target.value))} className={selectClass}>
                  {BEDROOM_CHOICES.map((n) => (
                    <option key={n} value={n}>{n} {n === 1 ? "bedroom" : "bedrooms"}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="q-fullba" className="block text-sm font-medium mb-1.5">Full bathrooms</label>
                <select id="q-fullba" value={fullBaths} onChange={(e) => setFullBaths(Number(e.target.value))} className={selectClass}>
                  {FULL_BATH_CHOICES.map((n) => (
                    <option key={n} value={n}>{n} {n === 1 ? "full bathroom" : "full bathrooms"}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="q-halfba" className="block text-sm font-medium mb-1.5">Half bathrooms</label>
                <select id="q-halfba" value={halfBaths} onChange={(e) => setHalfBaths(Number(e.target.value))} className={selectClass}>
                  {HALF_BATH_CHOICES.map((n) => (
                    <option key={n} value={n}>{n} {n === 1 ? "half bathroom" : "half bathrooms"}</option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <p id="service-label" className="block text-sm font-medium mb-2">Type of cleaning</p>
                <div role="radiogroup" aria-labelledby="service-label" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {SERVICE_OPTIONS.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      role="radio"
                      aria-checked={service === t.key}
                      onClick={() => setService(t.key)}
                      className={`px-4 py-3 rounded-lg border-2 min-h-[44px] font-semibold transition-all text-left ${
                        service === t.key
                          ? "border-primary bg-peach/40 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Sparkles className={`w-4 h-4 ${service === t.key ? "text-primary" : "text-muted-foreground"}`} />
                        {t.label}
                      </div>
                      <p className="text-xs font-normal text-muted-foreground mt-1">{t.tagline}</p>
                    </button>
                  ))}
                </div>
              </div>

              {service === "standard" && (
                <div className="md:col-span-2">
                  <label htmlFor="q-frequency" className="block text-sm font-medium mb-1.5">How often</label>
                  <select
                    id="q-frequency"
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value as FrequencyKey)}
                    className={selectClass}
                  >
                    {FREQUENCY_OPTIONS.map((f) => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="md:col-span-2">
                <label htmlFor="q-zip" className="block text-sm font-medium mb-1.5">ZIP code (service area check)</label>
                <input
                  id="q-zip"
                  type="text"
                  inputMode="numeric"
                  maxLength={5}
                  value={zip}
                  onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))}
                  placeholder="30024"
                  aria-invalid={zipOutOfArea}
                  aria-describedby="zip-msg"
                  className={`w-full px-4 py-3 rounded-lg border bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring ${
                    zipOutOfArea ? "border-destructive" : "border-border"
                  }`}
                />
                <p id="zip-msg" className="mt-2 text-sm" role={zipOutOfArea ? "alert" : undefined}>
                  {zipPartial && <span className="text-muted-foreground">Enter a 5-digit ZIP code.</span>}
                  {zipInArea && <span className="text-foreground">We clean homes in {zip}.</span>}
                  {zipOutOfArea && (
                    <span className="text-destructive">
                      We don't serve this ZIP yet. We serve Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell.
                    </span>
                  )}
                </p>
              </div>
            </div>

            {/* Founding spot */}
            <div className="mt-6 flex items-start gap-3">
              <input
                id="q-founding"
                type="checkbox"
                checked={isFounding}
                onChange={(e) => setIsFounding(e.target.checked)}
                className="mt-1 h-5 w-5 rounded border-input text-primary focus:ring-2 focus:ring-ring"
              />
              <label htmlFor="q-founding" className="text-sm text-foreground leading-snug">
                I'm claiming a founding spot (first 10 households)
              </label>
            </div>

            {/* Add-ons */}
            <div className="mt-6">
              <p className="block text-sm font-medium mb-2">Add-ons</p>
              <div className="flex flex-col gap-3">
                {!includedAddons.includes("insideOven") && (
                  <label htmlFor="q-addon-oven" className="flex items-center gap-2 text-sm">
                    <input id="q-addon-oven" type="checkbox" className="h-5 w-5" checked={insideOven} onChange={(e) => setInsideOven(e.target.checked)} />
                    {ADDONS.insideOven.label} (+${ADDONS.insideOven.price}) <span className="text-muted-foreground">{addonNote}</span>
                  </label>
                )}
                {!includedAddons.includes("insideFridge") && (
                  <label htmlFor="q-addon-fridge" className="flex items-center gap-2 text-sm">
                    <input id="q-addon-fridge" type="checkbox" className="h-5 w-5" checked={insideFridge} onChange={(e) => setInsideFridge(e.target.checked)} />
                    {ADDONS.insideFridge.label} (+${ADDONS.insideFridge.price}) <span className="text-muted-foreground">{addonNote}</span>
                  </label>
                )}
                {!includedAddons.includes("insideCabinets") && (
                  <label htmlFor="q-addon-cabinets" className="flex items-center gap-2 text-sm">
                    <input id="q-addon-cabinets" type="checkbox" className="h-5 w-5" checked={insideCabinets} onChange={(e) => setInsideCabinets(e.target.checked)} />
                    {ADDONS.insideCabinets.label} (+${ADDONS.insideCabinets.price}) <span className="text-muted-foreground">{addonNote}</span>
                  </label>
                )}
                <label htmlFor="q-addon-pets" className="flex items-center gap-2 text-sm">
                  <input id="q-addon-pets" type="checkbox" className="h-5 w-5" checked={pets} onChange={(e) => setPets(e.target.checked)} />
                  {ADDONS.pets.label} (+${ADDONS.pets.price}) <span className="text-muted-foreground">{addonNote}</span>
                </label>
                <div className="flex items-center gap-3 text-sm">
                  <label htmlFor="q-windows">
                    {ADDONS.interiorWindow.label} (+${ADDONS.interiorWindow.price} each){" "}
                    <span className="text-muted-foreground">{addonNote}</span>
                  </label>
                  <input
                    id="q-windows"
                    type="number"
                    min={0}
                    max={MAX_INTERIOR_WINDOWS}
                    value={interiorWindows}
                    onChange={(e) =>
                      setInteriorWindows(Math.min(MAX_INTERIOR_WINDOWS, Math.max(0, Number(e.target.value) || 0)))
                    }
                    className="w-20 px-3 py-2 rounded-lg border border-border bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
            </div>

            {service === "standard" && (
              <fieldset className="mt-6">
                <legend className="block text-sm font-medium mb-2">Has a professional cleaner cleaned this home in the last 3 months? *</legend>
                <p className="text-sm text-muted-foreground mb-2">This determines whether your first visit needs a deep clean.</p>
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  {(["yes", "no"] as const).map((v) => (
                    <label key={v} className="flex items-center gap-2 text-sm min-h-[44px]">
                      <input id={`q-recent-${v}`} type="radio" name="recentlyCleaned" value={v} checked={recentlyCleaned === v} onChange={() => setRecentlyCleaned(v)} className="h-5 w-5" required />
                      {v === "yes" ? "Yes" : "No"}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {/* Result */}
            <div className="mt-8 p-6 rounded-xl bg-peach-gradient border border-border text-center" aria-live="polite">
              {tier === null ? (
                <p className="font-heading text-2xl font-bold text-primary"><a href="mailto:hello@gatehousehomecleaning.com" className="underline">Email us for a price</a></p>
              ) : zipOutOfArea ? (
                <p className="text-base font-semibold text-foreground">
                  We don't serve this ZIP yet. We serve Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell.
                </p>
              ) : (
                <>
                  <p className="text-sm font-medium text-muted-foreground mb-1">{needsCleaningHistory ? "Answer the cleaning-history question above to confirm your first-visit price." : "Your price"}</p>
                  {needsCleaningHistory && !isRecurring ? (
                    <p className="text-base text-foreground">Select Yes or No above to see your price.</p>
                  ) : isRecurring ? (
                    <div className="flex flex-col items-center gap-1">
                      {!answered ? (
                        <p className="text-base text-foreground">Regular visits: ${recurringPrice} every other week. Your first visit may cost more if a deep clean is needed.</p>
                      ) : firstVisit === recurringPrice ? (
                        <span className="font-heading text-3xl sm:text-4xl font-bold text-primary">
                          ${recurringPrice} per visit, every other week
                        </span>
                      ) : (
                        <>
                          <span className="font-heading text-3xl sm:text-4xl font-bold text-primary">
                            First visit: ${firstVisit} per visit
                          </span>
                          <p className="text-base font-semibold text-foreground mt-1.5">
                            Then ${recurringPrice} per visit, every other week
                          </p>
                        </>
                      )}
                      {recentlyCleaned === "no" && (
                        <p className="text-sm text-muted-foreground mt-1">
                          Homes not cleaned professionally in the last 3 months start with a deep clean.
                        </p>
                      )}
                    </div>
                  ) : (
                    <>
                      <p className="font-heading text-4xl md:text-5xl font-bold text-primary">
                        ${mainPrice} per visit
                      </p>
                      {deepFirstVisit && (
                        <p className="text-sm text-muted-foreground mt-2">
                          Homes not cleaned professionally in the last 3 months start with a deep clean.
                        </p>
                      )}
                    </>
                  )}

                  {foundingApplies && (
                    <div className="mt-3 text-sm text-foreground">
                      <p>Founding price, first clean: ${foundingFirst} (30% off)</p>
                      {foundingRecurring !== null && (
                        <p>Founding rate for 6 months: ${foundingRecurring} per visit</p>
                      )}
                    </div>
                  )}
                </>
              )}

              <p className="text-sm text-muted-foreground mt-3">{EXTRA_TIME_NOTE}</p>

              <a
                href="#booking-request"
                className="inline-flex items-center justify-center gap-2 rounded-full px-8 py-4 mt-5 min-h-[52px] font-bold tracking-wide shadow-warm-lg hover:scale-[1.03] transition-all bg-primary text-primary-foreground"
              >
                Request this booking
              </a>
            </div>

             {/* BOOKING REQUEST STEP */}
             <form
              id="booking-request"
              onSubmit={handleBookingSubmit}
              noValidate
               className="mt-10 scroll-mt-16 pb-20 md:scroll-mt-28 md:pb-0"
            >
              <div className="flex items-center gap-2 mb-2">
                <h2 className="font-heading text-2xl font-bold">Request your booking</h2>
              </div>
              <p className="text-sm text-muted-foreground mb-2">Fields marked * are required.</p>
              <p className="text-sm text-foreground mb-6">
                Confirmed within one business day. Nothing is charged at booking. You see the photo report before we
                charge your card.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label htmlFor="b-name" className="block text-sm font-medium mb-1.5">Your name *</label>
                  <input
                    id="b-name" name="name" type="text" ref={refs.name} required autoComplete="name"
                    value={booking.name} onChange={handleBookingChange} onBlur={handleBookingBlur}
                    aria-required="true"
                    aria-invalid={!!bookingErrors.name}
                    aria-describedby={bookingErrors.name ? "b-name-error" : undefined}
                    placeholder="Your name"
                    className="w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {bookingErrors.name && <p id="b-name-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.name}</p>}
                </div>
                <div>
                  <label htmlFor="b-email" className="block text-sm font-medium mb-1.5">Email *</label>
                  <input
                    id="b-email" name="email" type="email" ref={refs.email} required autoComplete="email"
                    value={booking.email} onChange={handleBookingChange} onBlur={handleBookingBlur}
                    aria-required="true"
                    aria-invalid={!!bookingErrors.email}
                    aria-describedby={bookingErrors.email ? "b-email-error" : undefined}
                    placeholder="you@example.com"
                    className="w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {bookingErrors.email && <p id="b-email-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.email}</p>}
                </div>
                <div>
                  <label htmlFor="b-phone" className="block text-sm font-medium mb-1.5">Phone *</label>
                  <input
                    id="b-phone" name="phone" type="tel" ref={refs.phone} required autoComplete="tel"
                    value={booking.phone} onChange={handleBookingChange} onBlur={handleBookingBlur}
                    aria-required="true"
                    aria-invalid={!!bookingErrors.phone}
                    aria-describedby={bookingErrors.phone ? "b-phone-error" : undefined}
                    placeholder="(404) 555-1234"
                    className="w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {bookingErrors.phone && <p id="b-phone-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.phone}</p>}
                </div>
                <div>
                  <label htmlFor="b-address" className="block text-sm font-medium mb-1.5">Street address *</label>
                  <input
                    id="b-address" name="address" type="text" ref={refs.address} required autoComplete="street-address" maxLength={200}
                    value={booking.address} onChange={handleBookingChange} onBlur={handleBookingBlur}
                    aria-invalid={!!bookingErrors.address} aria-describedby={bookingErrors.address ? "b-address-error" : undefined}
                    placeholder="Street number and street name"
                    className="w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {bookingErrors.address && <p id="b-address-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.address}</p>}
                </div>
                <div>
                  <label htmlFor="b-date" className="block text-sm font-medium mb-1.5">Preferred date * (YYYY-MM-DD)</label>
                  <input
                    id="b-date" name="date" type="date" min={minDate} ref={refs.date}
                    required maxLength={10} pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"
                    value={booking.date} onChange={handleBookingChange} onBlur={handleBookingBlur}
                    aria-invalid={!!bookingErrors.date} aria-describedby={bookingErrors.date ? "b-date-error" : undefined}
                    className="w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {bookingErrors.date && <p id="b-date-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.date}</p>}
                </div>
                <div className="md:col-span-2">
                  <label htmlFor="b-time" className="block text-sm font-medium mb-1.5">Preferred arrival window</label>
                  <select
                    id="b-time" name="time"
                    value={booking.time} onChange={handleBookingChange}
                    className="w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">Select a window...</option>
                    <option value="morning">Morning (7 AM – 11 AM)</option>
                    <option value="midday">Midday (11 AM – 2 PM)</option>
                    <option value="afternoon">Afternoon (2 PM – 5 PM)</option>
                    <option value="flexible">I'm flexible</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label htmlFor="b-notes" className="block text-sm font-medium mb-1.5">Notes (optional)</label>
                  <textarea
                    id="b-notes" name="notes" rows={3}
                    value={booking.notes} onChange={handleBookingChange}
                    placeholder="Anything we should know? Pets, access, focus areas…"
                    className="w-full px-4 py-3 rounded-lg border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                  />
                </div>
              </div>

              <div className="mt-5 flex items-start gap-3">
                <input
                  id="b-terms" name="termsConsent" type="checkbox" required ref={refs.termsConsent}
                  checked={booking.termsConsent} onChange={handleBookingChange}
                  aria-required="true" aria-invalid={!!bookingErrors.termsConsent} aria-describedby={bookingErrors.termsConsent ? "b-terms-error" : undefined}
                  className="mt-1 h-5 w-5 rounded border-input text-primary focus:ring-2 focus:ring-ring"
                />
                <label htmlFor="b-terms" className="text-sm text-foreground leading-snug">
                  I agree to the{" "}
                  <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline text-primary">Terms of Service</a>
                  , including the arbitration clause in Section 16, and the{" "}
                   <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline text-primary">Privacy Policy</a>. I consent to booking texts at the number I provided, including confirmations, reminders and my photo report. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. *
                </label>
              </div>
              {bookingErrors.termsConsent && <p id="b-terms-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.termsConsent}</p>}

              <div className="mt-4 flex items-start gap-3">
                <input
                  id="b-photo" name="photoConsent" type="checkbox" required ref={refs.photoConsent}
                  checked={booking.photoConsent} onChange={handleBookingChange}
                  aria-required="true" aria-invalid={!!bookingErrors.photoConsent} aria-describedby={bookingErrors.photoConsent ? "b-photo-error" : undefined}
                  className="mt-1 h-5 w-5 rounded border-input text-primary focus:ring-2 focus:ring-ring"
                />
                <label htmlFor="b-photo" className="text-sm text-foreground leading-snug">
                  {PHOTO_CONSENT_TEXT} *
                </label>
              </div>
              {bookingErrors.photoConsent && <p id="b-photo-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.photoConsent}</p>}

              <div hidden aria-hidden="true"><label htmlFor="b-website">Leave this empty</label><input id="b-website" name="website" tabIndex={-1} autoComplete="off" value={booking.website} onChange={handleBookingChange} /></div>
              {reviewReady && (
                 <div ref={reviewRef} tabIndex={-1} className="mt-6 scroll-mt-24 rounded-lg border border-border bg-background p-5 text-sm text-foreground">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-heading text-lg font-bold">Review your details</h3>
                    <Button variant="outline" type="button" onClick={() => { setReviewReady(false); document.getElementById("q-size")?.focus(); }}>Edit</Button>
                  </div>
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 break-words">
                    <dt className="font-semibold">Home</dt><dd>{SIZE_BAND_LABEL[sizeBand]}, {bedrooms} bed, {fullBaths} full bath, {halfBaths} half bath · ZIP {zip}</dd>
                     <dt className="font-semibold">Service</dt><dd>{SERVICE_LABEL_CALC[service]} · {service === "standard" ? FREQUENCY_LABEL[frequency] : "One-time"}{deepFirstVisit ? " · First visit: Deep clean" : ""}</dd>
                     <dt className="font-semibold">Price</dt><dd>${mainPrice} per visit{isRecurring && answered && firstVisit !== recurringPrice ? `; then $${recurringPrice} every other week` : isRecurring ? ", every other week" : ""}</dd>
                    <dt className="font-semibold">Date</dt><dd>{booking.date} · {booking.time || "Flexible arrival window"}</dd>
                    <dt className="font-semibold">Contact</dt><dd className="min-w-0 break-all">{booking.name} · {booking.email} · {booking.phone}<br />{booking.address}</dd>
                  </dl>
                </div>
              )}

              <div role="alert" className="mt-4 text-sm text-destructive empty:hidden">{submitError}</div>
              <Button variant="hero" size="xl" type="submit" disabled={!canSubmit} className="w-full mt-6 min-h-[48px]">
                {isSubmitting
                  ? "Sending..."
                  : !canProceed
                    ? "Enter a ZIP in our service area"
                    : needsCleaningHistory ? "Answer the cleaning-history question above"
                    : reviewReady ? <>Send my booking request <Send className="w-5 h-5" /></> : "Review my details"}
              </Button>
              <p className="text-xs text-foreground text-center mt-4">
                Your booking request goes straight to us. We confirm your booking within one business day — usually much sooner.
              </p>
            </form>
          </div>
        </div>
      </section>

      {/* Mobile price bar — hidden until a price is available */}
      {showPrice && !needsCleaningHistory && (
        <div className="quote-price-bar fixed inset-x-0 z-40 border-t border-border bg-card px-4 py-2 shadow-warm-lg md:hidden">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-foreground">
              <span className="block text-xs font-normal text-muted-foreground">Your price</span>
               ${mainPrice} {deepFirstVisit ? "first visit" : "per visit"}
               {isRecurring && firstVisit !== recurringPrice && <span className="block text-xs">Then ${recurringPrice} every other week</span>}
            </p>
            <a
              href="#booking-request"
              className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-primary px-5 text-sm font-bold text-primary-foreground"
            >
              Request this booking
            </a>
          </div>
        </div>
      )}
    </div>
  );
};

export default Quote;
