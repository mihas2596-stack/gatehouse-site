import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";
import { campaignAttribution, trackFunnel } from "@/lib/measurement";
import { Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  calcPrice,
  globalTestCutActive,
  priceBreakdown,
  scaleTestPrice,
  tierFor,
  ADDONS,
  ADDONS_INCLUDED_IN,
  MAX_INTERIOR_WINDOWS,
  EXTRA_TIME_NOTE,
  SIZE_BANDS,
  SIZE_BAND_LABEL,
  EXTRA_ZONES,
  EXTRA_ZONE_LABEL,
  type ExtraZoneKey,
  BEDROOM_CHOICES,
  FULL_BATH_CHOICES,
  HALF_BATH_CHOICES,
  FREQUENCY_OPTIONS,
  FREQUENCY_LABEL,
  SERVICE_OPTIONS,
  SERVICE_LABEL_CALC,
  type CalcServiceKey,
  type FrequencyKey,
  type PriceBreakdown,
  type SizeBandKey,
} from "@/config/calculator";

import {
  ENTRY_METHODS,
  ENTRY_DETAILS,
  ENTRY_METHOD_LABEL,
  ENTRY_DETAIL_LABEL,
  entrySummaryLabel,
  type EntryMethodChoice,
  type EntryDetailChoice,
} from "@/config/entry";

import { SERVICE_ZIPS, earliestServiceDate, validServiceDate } from "@/config/service-area";

const resolveService = (param: string | null): CalcServiceKey => {
  const p = (param ?? "").toLowerCase();
  if (p.includes("move")) return "moveinout";
  if (p.includes("deep")) return "deep";
  return "standard";
};

// Exact consent wording, stored with every booking request.
const TERMS_CONSENT_TEXT =
  "I agree to the Terms, including binding arbitration (Section 16), and acknowledge the Privacy Policy.";
const SMS_CONSENT_MAIN = "Text me booking updates. Optional — email works too.";
const SMS_DISCLOSURE =
  "Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase.";
const SMS_CONSENT_TEXT = `${SMS_CONSENT_MAIN} ${SMS_DISCLOSURE}`;
const PHOTO_CONSENT_MAIN =
  "I consent to photos inside my home of the cleaned rooms for my private cleaning report.";
const PHOTO_CONSENT_SUB = "Kept for 90 days. Never published without separate written permission.";
const PHOTO_CONSENT_TEXT = `${PHOTO_CONSENT_MAIN} ${PHOTO_CONSENT_SUB}`;

const Quote = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [sizeBand, setSizeBand] = useState<SizeBandKey>("notsure");
  const [extraZones, setExtraZones] = useState<ExtraZoneKey[]>([]);
  const toggleZone = (key: ExtraZoneKey) =>
    setExtraZones((prev) => (prev.includes(key) ? prev.filter((z) => z !== key) : [...prev, key]));
  const [bedrooms, setBedrooms] = useState<number>(3);
  const [fullBaths, setFullBaths] = useState<number>(2);
  const [halfBaths, setHalfBaths] = useState<number>(0);
  const [recentlyCleaned, setRecentlyCleaned] = useState<"yes" | "no" | "">("");
  const [frequency, setFrequency] = useState<FrequencyKey>(params.get("frequency") === "onetime" ? "onetime" : "every2weeks");
  const [service, setService] = useState<CalcServiceKey>(resolveService(params.get("service")));
  const [zip, setZip] = useState("");
  // Owner price-test mode: a signed `tp` token in the URL switches this
  // quote to reduced test prices — but ONLY after the server verifies the
  // token (signature + expiry). An unverified token never scales prices,
  // so ordinary visitors can never see test prices by guessing a parameter.
  const testToken = params.get("tp") ?? "";
  const [testTokenOk, setTestTokenOk] = useState(false);
  const [testTokenChecked, setTestTokenChecked] = useState(testToken === "");
  useEffect(() => {
    if (!testToken) return;
    let cancelled = false;
    fetch(`/api/owner-auth?token=${encodeURIComponent(testToken)}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { setTestTokenOk(d?.ok === true); setTestTokenChecked(true); } })
      .catch(() => { if (!cancelled) setTestTokenChecked(true); });
    return () => { cancelled = true; };
  }, [testToken]);
  useEffect(() => {
    try {
      if (testTokenOk) sessionStorage.setItem("gh_test_pricing", "1");
      else sessionStorage.removeItem("gh_test_pricing");
    } catch { /* private mode */ }
  }, [testTokenOk]);
  // Owner order 2026-10-24: during the 48h global test window every
  // visitor sees test prices, token or not.
  const globalCut = globalTestCutActive();
  const testMode = (testToken !== "" && testTokenOk) || globalCut;
  const dispPrice = (n: number): number => (testMode ? scaleTestPrice(n) : n);
  // Money display: whole dollars stay "$224", cents always show two
  // decimals ("$1.50", never "$1.5").
  const fmt$ = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
  // US-style date for summaries ("November 7, 2026"). Noon avoids TZ shifts.
  const fmtDate = (iso: string): string => {
    const d = new Date(`${iso}T12:00:00`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  };
  const WINDOW_LABEL: Record<string, string> = {
    morning: "Morning (7 AM – 11 AM)",
    midday: "Midday (11 AM – 2 PM)",
    afternoon: "Afternoon (2 PM – 5 PM)",
    flexible: "I'm flexible",
  };

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

  // UNIFIED PRICE BREAKDOWN — the single source of truth for every price
  // shown on this page AND sent with the booking request. One first-visit
  // total, one recurring total, add-ons included in both (except add-ons
  // already covered by a deep clean). Replaces the scattered memos that
  // showed contradictory numbers at the same time.
  const breakdown = useMemo<PriceBreakdown | null>(
    () =>
      service === "standard"
        ? priceBreakdown({
            bedrooms,
            fullBaths,
            frequency,
            // Unanswered cleaning history prices as a standard clean; the UI
            // asks the client to answer before the first-visit price is final.
            recentlyCleaned: cleanedRecently || !answered,
            addons,
            testScale: testMode,
          })
        : null,
    [service, bedrooms, fullBaths, frequency, cleanedRecently, answered, addons, testMode]
  );
  // Deep and move-in/out are one-time by nature.
  const oneTimeTotal = useMemo(
    () =>
      service === "deep" || service === "moveinout"
        ? calcPrice({ bedrooms, fullBaths, service, frequency: "onetime", addons, testScale: testMode })
        : null,
    [service, bedrooms, fullBaths, addons]
  );

  // The headline first-visit price used for the booking request.
  const mainPrice = service === "standard" ? breakdown?.first_total ?? null : oneTimeTotal;

  // ZIP eligibility: empty = neutral; 5 digits and not in set = out of area.
  const zipEntered = zip.length === 5;
  const zipPartial = zip.length > 0 && zip.length < 5;
  const zipInArea = zipEntered && SERVICE_ZIPS.has(zip);
  const zipOutOfArea = zipEntered && !SERVICE_ZIPS.has(zip);
  // A valid in-area ZIP is the gate. Large homes (tier null: 6+ bedrooms or
  // 6+ full bathrooms) have no table price, but the request still goes
  // through — as a custom-quote request, not a ZIP error.
  const isLargeHome = tier === null;
  // Scope-planning flags: an unsure or very large size, or any extra area,
  // means the owner reviews the scope with the client BEFORE confirming.
  // None of this ever changes the shown price by itself.
  const scopeReasons: string[] = [
    ...(sizeBand === "notsure" ? ["home size not sure"] : []),
    ...(sizeBand === "4000plus" ? ["4,000+ sq ft"] : []),
    ...(extraZones.length ? [`extra areas: ${extraZones.map((z) => EXTRA_ZONE_LABEL[z]).join(", ")}`] : []),
  ];
  const scopeReview = scopeReasons.length > 0;
  const canProceed = zipInArea;
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
    smsConsent: false,
    city: "",
    state: "GA",
    apt: "",
  });
  // Entry preference (not a secret): chosen on step 2, stored with the
  // booking, shown on step 3, thank-you, owner and cleaner surfaces.
  // Codes/key locations are never part of it.
  const [entryMethod, setEntryMethod] = useState<EntryMethodChoice | "">("");
  const [entryDetail, setEntryDetail] = useState<EntryDetailChoice | "">("");
  const [entryNotes, setEntryNotes] = useState("");
  const [bookingErrors, setBookingErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // Extras start collapsed so the price form stays short; the summary
  // line always shows what is selected, even while collapsed.
  const [extrasOpen, setExtrasOpen] = useState(false);
  const extrasSummary = [
    insideOven && "Inside oven",
    insideFridge && "Inside fridge",
    insideCabinets && "Inside cabinets",
    pets && "Pets",
    interiorWindows > 0 && `${interiorWindows} window${interiorWindows > 1 ? "s" : ""}`,
  ].filter(Boolean).join(", ");
  const firstStepRender = useRef(true);
  // Land at the top of the new step with focus on its heading. The
  // old code scrolled BEFORE React re-rendered (smooth scroll plus
  // Safari scroll anchoring left the user at the bottom of the new
  // step); scrolling after render, instantly, fixes it for every
  // transition, including Back/Edit buttons that only setStep.
  useEffect(() => {
    if (firstStepRender.current) { firstStepRender.current = false; return; }
    const heading = document.getElementById(`quote-step-${step}-heading`);
    heading?.scrollIntoView?.({ behavior: "auto", block: "start" });
    heading?.focus();
  }, [step]);
  const requestRef = useRef<{ id: string; time: string } | null>(null);
  // Any quote change must be reviewed again before the request is sent.
  useEffect(() => {
    requestRef.current = null;
    setSubmitError("");
  }, [sizeBand, bedrooms, fullBaths, halfBaths, recentlyCleaned, frequency, service, zip, addons, extraZones]);
  const refs = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    phone: useRef<HTMLInputElement>(null),
    address: useRef<HTMLInputElement>(null),
    city: useRef<HTMLInputElement>(null),
    state: useRef<HTMLInputElement>(null),
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
  };

  const fieldError = (field: "name" | "email" | "phone" | "address" | "city" | "state" | "date", value: string) => {
    if (field === "name") return value.trim().length < 1 ? "Enter your name." : "";
    if (field === "email")
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? "" : "Enter a valid email, like name@example.com.";
    if (field === "address") return value.trim().length < 5 ? "Enter your street address." : "";
    if (field === "city") return value.trim().length < 2 ? "Enter your city." : "";
    if (field === "state") return value.trim().length < 2 ? "Enter your state." : "";
    if (field === "date") {
      if (!validServiceDate(value) || value < minDate) return `Choose a valid date on or after ${minDate}.`;
      return "";
    }
    const digits = value.replace(/\D/g, "");
    return digits.length === 10 || (digits.length === 11 && digits.startsWith("1")) ? "" : "Enter a 10-digit US phone number.";
  };

  const handleBookingBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const name = e.target.name as "name" | "email" | "phone" | "address" | "city" | "state" | "date";
    if (!(["name", "email", "phone", "address", "city", "state", "date"] as string[]).includes(name)) return;
    setBookingErrors((p) => ({ ...p, [name]: fieldError(name, e.target.value) }));
  };

  // Step 2 -> 3 checks only the visit fields; the Terms/photo consents
  // live on step 3 and are checked on the final submit, not on Review.
  const validateBooking = (requireConsents = true) => {
    const errs: Record<string, string> = {};
    (["name", "email", "phone", "address", "city", "state", "date"] as const).forEach((f) => {
      const msg = fieldError(f, booking[f]);
      if (msg) errs[f] = msg;
    });
    if (requireConsents) {
      if (!booking.termsConsent) errs.termsConsent = "Please agree to the Terms of Service and Privacy Policy.";
      if (!booking.photoConsent) errs.photoConsent = "Please agree to the approval photo report.";
    }
    return errs;
  };

  const goToStep2 = () => {
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
    setStep(2);
  };
  const goToStep3 = () => {
    // Step-2 validation: visit fields + the choices that live on step 2
    // (entry method, photo consent). Terms stay on step 3.
    const errs = { ...validateBooking(false), ...entryErrors() };
    if (!booking.photoConsent) errs.photoConsent = "Please agree to the approval photo report.";
    setBookingErrors(errs);
    if (Object.keys(errs).length) {
      trackFunnel("gh_form_error", { form_type: "quote", error_stage: "validation" });
      const order: Array<keyof typeof refs> = ["name", "email", "phone", "address", "city", "state", "date"];
      for (const f of order) if (errs[f]) { refs[f].current?.focus(); return; }
      if (errs.entryMethod) { document.getElementById("entry-home")?.focus(); return; }
      if (errs.entryDetail) { document.getElementById("entry-detail-door_code")?.focus(); return; }
      if (errs.photoConsent) { refs.photoConsent.current?.focus(); return; }
      return;
    }
    setStep(3);
  };
  const priceSummaryText = isLargeHome
    ? "Custom quote — we confirm your price with you before confirming your visit, and before anything is charged"
    : service === "standard" && breakdown
      ? isRecurring
        ? `First visit ${fmt$(breakdown.first_total)}${breakdown.first_service === "deep" ? " (deep clean)" : ""}, then ${fmt$(breakdown.recurring_total)} per visit, every other week`
        : `One-time: ${fmt$(breakdown.first_total)}`
      : mainPrice !== null
        ? `${fmt$(mainPrice)} one-time`
        : "";
  const canSubmit = canProceed && !needsCleaningHistory && !isSubmitting;
  // Full address for the booking: street, unit, city, state, ZIP.
  const fullAddress = useMemo(() => {
    const street = booking.address.trim();
    const aptPart = booking.apt.trim() ? `, ${booking.apt.trim()}` : "";
    const cityPart = booking.city.trim();
    const stateZip = `${booking.state.trim()} ${zip}`.trim();
    return [street + aptPart, cityPart, stateZip].filter(Boolean).join(", ");
  }, [booking.address, booking.apt, booking.city, booking.state, zip]);
  const entryErrors = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!entryMethod) e.entryMethod = "Choose how to arrange entry.";
    if (entryMethod === "arrange_before" && !entryDetail) e.entryDetail = "Choose how you'll arrange entry.";
    return e;
  };

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
    const errs = { ...validateBooking(), ...entryErrors() };
    setBookingErrors(errs);
    if (Object.keys(errs).length) {
      trackFunnel("gh_form_error", { form_type: "quote", error_stage: "validation" });
      const order: Array<keyof typeof refs> = ["name", "email", "phone", "address", "city", "state", "date", "termsConsent", "photoConsent"];
      for (const f of order) if (errs[f]) { refs[f].current?.focus(); return; }
      if (errs.entryMethod) { document.getElementById("entry-home")?.focus(); return; }
      if (errs.entryDetail) { document.getElementById("entry-detail-door_code")?.focus(); return; }
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
        `Street address: ${fullAddress}`,
        zip ? `ZIP ${zip}` : "",
        `Entry: ${entrySummaryLabel(entryMethod || null, entryDetail || null)}`,
        isLargeHome
          ? "Custom quote requested — home has 6+ bedrooms or 6+ full bathrooms, no table price"
          : isRecurring && breakdown
          ? answered
            ? `First visit ${fmt$(breakdown.first_total)}${breakdown.first_service === "deep" ? " (deep clean)" : ""}, then ${fmt$(breakdown.recurring_total)} per visit, every other week`
            : `From ${fmt$(breakdown.recurring_total)} per visit, every other week — answer the cleaning-history question to confirm the first-visit price`
          : breakdown
            ? `Total ${fmt$(breakdown.first_total)} (one visit${breakdown.first_service === "deep" ? ", deep clean" : ""})`
            : `Price ${fmt$(mainPrice)} per visit`,
        addonList ? `Add-ons (${isRecurring ? "every visit" : "this visit"}): ${addonList}` : "",
        extraZones.length ? `Extra areas to clean: ${extraZones.map((z) => EXTRA_ZONE_LABEL[z]).join(", ")}` : "",
        scopeReview ? `Scope review needed: YES (${scopeReasons.join("; ")})` : "",
      ].filter(Boolean).join(" · ");
      // Idempotency: one request_id per booking attempt, kept in
      // sessionStorage so a retry — even after a page reload — reuses it and
      // the server reproduces the same booking instead of a duplicate. The id
      // rotates when the booking content changes or after a successful send.
      if (!requestRef.current) {
        const sig = JSON.stringify([booking.email, booking.date, service, bedrooms, fullBaths, zip, frequency, mainPrice, sizeBand, extraZones, entryMethod, entryDetail, entryNotes, booking.city, booking.state, booking.apt]);
        let id: string | null = null;
        try {
          if (sessionStorage.getItem("gh_request_sig") === sig) id = sessionStorage.getItem("gh_request_id");
          if (!id) {
            id = crypto.randomUUID();
            sessionStorage.setItem("gh_request_id", id);
            sessionStorage.setItem("gh_request_sig", sig);
          }
        } catch { id = crypto.randomUUID(); }
        requestRef.current = { id, time: new Date().toISOString() };
      }
      const consentRecord = [
        "Consent record",
        `Timestamp: ${requestRef.current.time}`,
        `sms_consent: ${booking.smsConsent} — "${SMS_CONSENT_TEXT}"`,
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
        extra_zones: extraZones.map((z) => EXTRA_ZONE_LABEL[z]).join(", "),
        scope_review: scopeReview,
        scope_reasons: scopeReasons.join("; "),
        notes: booking.notes.trim(),
        consent_record: consentRecord,
        bedrooms: String(bedrooms),
        bathrooms: String(fullBaths + halfBaths * 0.5),
        full_baths: String(fullBaths),
        half_baths: String(halfBaths),
        zip: zip || "",
        address: fullAddress,
        city: booking.city.trim(),
        state: booking.state.trim(),
        apt: booking.apt.trim(),
        entry_method: entryMethod || undefined,
        entry_detail: entryDetail || undefined,
        entry_notes: entryNotes.trim() || undefined,
        price: String(mainPrice ?? ""),
        // Server recomputes the exact breakdown from these — the browser
        // price is never trusted for the signed booking token.
        frequency: isRecurring ? "every2weeks" : "onetime",
        service_key: service,
        cleaned_recently: answered ? cleanedRecently : undefined,
        addons: { insideOven, insideFridge, insideCabinets, interiorWindows, pets },
        recurring: isRecurring && breakdown ? String(breakdown.recurring_total) : "",
        test_token: testMode ? testToken : undefined,
        source: "quote",
        attribution: campaignAttribution(),
        terms_consent: booking.termsConsent,
        photo_consent: booking.photoConsent,
        sms_consent: booking.smsConsent,
      };
      setSubmitError("");
      const res = await fetch("/api/send-contact-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let data: { ok?: boolean; customerEmailSent?: boolean; errors?: Record<string, string>; bt?: string } | null = null;
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
                return;
        }
        throw new Error("Booking request failed");
      }
      if (!data?.ok) throw new Error("Booking request failed");
      // Booking accepted: the next booking in this tab gets a fresh request_id.
      try { sessionStorage.removeItem("gh_request_id"); sessionStorage.removeItem("gh_request_sig"); } catch { /* ignore */ }
      requestRef.current = null;
      trackFunnel("gh_lead_submit", { form_type: "quote", service_type: service, frequency: isRecurring ? "every2weeks" : "onetime" });
      // Recap shown on /thank-you: price, date, arrival window, current
      // status and response time. Never a "confirmed" promise — the date is
      // a request until Nick confirms availability by email.
      const recapPrice =
        service === "standard" && breakdown
          ? isRecurring
            ? breakdown.first_total === breakdown.recurring_total && breakdown.first_service === "standard"
              ? `${fmt$(breakdown.recurring_total)} per visit, every other week`
              : `First visit ${fmt$(breakdown.first_total)}${breakdown.first_service === "deep" ? " (deep clean)" : ""}, then ${fmt$(breakdown.recurring_total)} per visit, every other week`
            : `One-time: ${fmt$(breakdown.first_total)}`
          : mainPrice !== null
            ? `${fmt$(mainPrice)} one-time`
            : "";
      navigate("/thank-you", {
        state: {
          submitted: true,
          kind: "booking",
          customerEmailSent: data.customerEmailSent,
          bt: data.bt,
          recap: {
            price: recapPrice,
            email: booking.email.trim(),
            date: booking.date,
            window: WINDOW_LABEL[booking.time] ?? "Flexible arrival window",
            entry: entrySummaryLabel(entryMethod || null, entryDetail || null),
            status: "Request received — not confirmed yet",
            response: "We confirm by email within one business day",
          },
          // Structured plan for the merged finish step on /thank-you:
          // amounts come from the same breakdown the server re-derives, so
          // the summary, the consent and the future charge cannot diverge.
          plan: {
            service: SERVICE_LABEL_CALC[service],
            first: mainPrice,
            recurring: isRecurring && breakdown ? breakdown.recurring_total : null,
            firstIsDeep: breakdown?.first_service === "deep",
          },
        },
      });
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
  const addonNote = isRecurring ? "(every visit)" : "(this visit)";
  const includedAddons = ADDONS_INCLUDED_IN[service];
  // Human-readable add-on summary for the price block, e.g. "Inside oven +$35 (every visit)".
  const priceBlockAddons = [
    insideOven && !includedAddons.includes("insideOven") ? `Inside oven +${fmt$(dispPrice(ADDONS.insideOven.price))}` : "",
    insideFridge && !includedAddons.includes("insideFridge") ? `Inside fridge +${fmt$(dispPrice(ADDONS.insideFridge.price))}` : "",
    insideCabinets && !includedAddons.includes("insideCabinets") ? `Inside cabinets +${fmt$(dispPrice(ADDONS.insideCabinets.price))}` : "",
    interiorWindows > 0 ? `${interiorWindows} interior windows +${fmt$(dispPrice(interiorWindows * ADDONS.interiorWindow.price))}` : "",
    pets ? `Pets +${fmt$(dispPrice(ADDONS.pets.price))}` : "",
  ].filter(Boolean).join(", ");

  return (
    <div className="page-shell">
      <SEO
        title="See Your Cleaning Price | Gatehouse"
        description="Enter your home size, bedrooms and bathrooms to see your cleaning price online, then pick a day."
        url="https://gatehousehomecleaning.com/quote"
      />
      <section className="py-4 md:py-6 bg-warm-gradient">
        <div className="container max-w-3xl text-center">
          <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-3">
            A clear <span className="text-gradient-gold">price</span> for your home
          </h1>
          <p className="text-muted-foreground text-lg">
            No email needed to see your price.
          </p>
          <div className="mt-5 max-w-md mx-auto">
            <p className="text-center text-sm font-semibold" aria-current="step">
              Step {step} of 3 · {step === 1 ? "Your home & price" : step === 2 ? "Your visit" : "Review & save card"}
            </p>
            <div
              className="mt-2 flex gap-1.5"
              role="progressbar"
              aria-valuemin={1}
              aria-valuemax={3}
              aria-valuenow={step}
              aria-label="Booking progress"
            >
              {[1, 2, 3].map((n) => (
                <span key={n} className={`h-1.5 flex-1 rounded-full ${n <= step ? "bg-primary" : "bg-border"}`} aria-hidden="true" />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="pt-2 pb-12 md:pt-4 md:pb-16">
        <div className="container max-w-3xl">
          <div className="bg-card rounded-2xl p-6 sm:p-8 md:p-10 shadow-warm-lg">
            {testMode && (
              <p className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
                Test booking: prices on this page are reduced for a payment test.
              </p>
            )}
            {testToken && testTokenChecked && !testTokenOk && !globalCut && (
              <p className="mb-6 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
                This test link is invalid or expired — regular prices apply.
              </p>
            )}

            {step === 1 && (<>
            <h2 id="quote-step-1-heading" tabIndex={-1} className="font-heading text-2xl font-bold mb-6 scroll-mt-24 outline-none">Your home &amp; price</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
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
                <label htmlFor="q-zip" className="block text-sm font-medium mb-1.5">ZIP code (service area check)</label>
                <input
                  id="q-zip"
                  type="text"
                  inputMode="numeric"
                  maxLength={5}
                  value={zip}
                  onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))}
                  placeholder="e.g. 30024"
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
                      We don't serve this ZIP yet. We serve Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell. <a href="mailto:hello@gatehousehomecleaning.com" className="underline">Email us</a> and we’ll let you know when we expand to your area.
                    </span>
                  )}
                </p>
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
                      <p className="text-sm font-normal text-muted-foreground mt-1">{t.tagline}</p>
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

            </div>

            {/* Add-ons — collapsed by default so the price form stays short. */}
            <div className="mt-6">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <button
                  type="button"
                  aria-expanded={extrasOpen}
                  onClick={() => setExtrasOpen((v) => !v)}
                  className="min-h-[44px] text-sm font-semibold text-primary underline"
                >
                  Add extras (optional)
                </button>
                <span className="text-sm text-muted-foreground">
                  {extrasSummary || "None selected"}
                </span>
              </div>
              {extrasOpen && (<div className="flex flex-col gap-3 mt-1">
                {!includedAddons.includes("insideOven") && (
                  <label htmlFor="q-addon-oven" className="flex min-h-[44px] items-center gap-2 py-1 text-sm">
                    <input id="q-addon-oven" type="checkbox" className="h-5 w-5" checked={insideOven} onChange={(e) => setInsideOven(e.target.checked)} />
                    {ADDONS.insideOven.label} (+{fmt$(dispPrice(ADDONS.insideOven.price))}) <span className="text-muted-foreground">{addonNote}</span>
                  </label>
                )}
                {!includedAddons.includes("insideFridge") && (
                  <label htmlFor="q-addon-fridge" className="flex min-h-[44px] items-center gap-2 py-1 text-sm">
                    <input id="q-addon-fridge" type="checkbox" className="h-5 w-5" checked={insideFridge} onChange={(e) => setInsideFridge(e.target.checked)} />
                    {ADDONS.insideFridge.label} (+{fmt$(dispPrice(ADDONS.insideFridge.price))}) <span className="text-muted-foreground">{addonNote}</span>
                  </label>
                )}
                {!includedAddons.includes("insideCabinets") && (
                  <label htmlFor="q-addon-cabinets" className="flex min-h-[44px] items-center gap-2 py-1 text-sm">
                    <input id="q-addon-cabinets" type="checkbox" className="h-5 w-5" checked={insideCabinets} onChange={(e) => setInsideCabinets(e.target.checked)} />
                    {ADDONS.insideCabinets.label} (+{fmt$(dispPrice(ADDONS.insideCabinets.price))}) <span className="text-muted-foreground">{addonNote}</span>
                  </label>
                )}
                <label htmlFor="q-addon-pets" className="flex min-h-[44px] items-center gap-2 py-1 text-sm">
                  <input id="q-addon-pets" type="checkbox" className="h-5 w-5" checked={pets} onChange={(e) => setPets(e.target.checked)} />
                  {ADDONS.pets.label} (+{fmt$(dispPrice(ADDONS.pets.price))}) <span className="text-muted-foreground">{addonNote} — extra pet-hair cleanup</span>
                </label>
                <div className="flex items-center gap-3 text-sm">
                  <label htmlFor="q-windows">
                    {ADDONS.interiorWindow.label} (+{fmt$(dispPrice(ADDONS.interiorWindow.price))} each){" "}
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
                <p className="text-sm text-muted-foreground">These are the only extras. Nothing is pre-selected for you.</p>
              </div>)}
            </div>

            {service === "standard" && (
              <fieldset className="mt-6">
                <legend className="block text-sm font-medium mb-2">Has a professional cleaner cleaned this home in the last 3 months? *</legend>
                <p className="text-sm text-muted-foreground mb-2">This determines whether your first visit needs a deep clean — and what it costs. If it does, the price above shows the deep-clean first visit and the regular price after it, before you book.</p>
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

            <p className="mt-6 text-sm text-foreground">
              Every visit covers your rooms top to bottom — kitchen, bathrooms, bedrooms and living areas.{" "}
              <a href="/whats-included" className="underline text-primary">See the full room-by-room list</a>.
            </p>

            {/* Result */}
            <div className="mt-8 p-6 rounded-xl bg-peach-gradient border border-border text-center" aria-live="polite">
              {tier === null ? (
                <>
                  <p className="font-heading text-2xl font-bold text-primary"><a href="mailto:hello@gatehousehomecleaning.com" className="underline">Email us for a price</a></p>
                  <p className="text-sm text-muted-foreground mt-2">Homes with 6+ bedrooms or 6+ full bathrooms get an individual quote.</p>
                </>
              ) : zipOutOfArea ? (
                <p className="text-base font-semibold text-foreground">
                  We don't serve this ZIP yet. We serve Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell. <a href="mailto:hello@gatehousehomecleaning.com" className="underline">Email us</a> and we’ll let you know when we expand to your area.
                </p>
              ) : (
                <>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Your price</p>
                  {service !== "standard" ? (
                    // Deep and move-in/out: one total, oven/fridge/cabinets included.
                    <>
                      <p className="font-heading text-4xl md:text-5xl font-bold text-primary">
                        {fmt$(oneTimeTotal ?? 0)} <span className="text-xl font-semibold">one-time</span>
                      </p>
                      <p className="text-sm text-muted-foreground mt-2">
                        {SERVICE_LABEL_CALC[service]}. Inside oven, fridge and cabinets are included — never charged twice.
                      </p>
                    </>
                  ) : !answered ? (
                    <div className="flex flex-col items-center gap-1">
                      <p className="text-base text-foreground">
                        {isRecurring
                          ? <>Regular visits: <strong>{fmt$(breakdown?.recurring_total ?? 0)}</strong> every other week.</>
                          : <>One-time clean: <strong>{fmt$(breakdown?.first_total ?? 0)}</strong>.</>}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Answer the cleaning-history question above to confirm your first-visit price — a deep clean may be needed first. Not sure? Pick your best guess — we review the scope with you before confirming your visit.
                      </p>
                    </div>
                  ) : breakdown ? (
                    <div className="flex flex-col items-center gap-1">
                      {isRecurring && breakdown.first_total === breakdown.recurring_total && breakdown.first_service === "standard" ? (
                        <>
                          <span className="font-heading text-3xl sm:text-4xl font-bold text-primary">
                            {fmt$(breakdown.recurring_total)} per visit
                          </span>
                          <p className="text-base font-semibold text-foreground mt-1.5">
                            First visit: {fmt$(breakdown.first_total)} · then {fmt$(breakdown.recurring_total)} per visit, every other week
                          </p>
                        </>
                      ) : (
                        <>
                          <span className="font-heading text-3xl sm:text-4xl font-bold text-primary">
                            First visit: {fmt$(breakdown.first_total)}
                            {breakdown.first_service === "deep" && <span className="text-xl font-semibold"> — deep clean</span>}
                          </span>
                          {isRecurring && (
                            <p className="text-base font-semibold text-foreground mt-1.5">
                              Then {fmt$(breakdown.recurring_total)} per visit, every other week
                            </p>
                          )}
                          {!isRecurring && (
                            <p className="text-base font-semibold text-foreground mt-1.5">One-time visit</p>
                          )}
                        </>
                      )}
                      {breakdown.first_service === "deep" && (
                        <p className="text-sm text-muted-foreground mt-1">
                          Homes not cleaned professionally in the last 3 months start with a deep clean. Inside oven,
                          fridge and cabinets are included in a deep clean — never charged twice.
                          {isRecurring && " Your first visit is the deep clean; after that, your visits are standard cleanings at the recurring rate above."}
                        </p>
                      )}
                      {priceBlockAddons && (
                        <p className="text-sm text-muted-foreground mt-1">Add-ons, {isRecurring ? "every visit" : "this visit"}: {priceBlockAddons}</p>
                      )}
                    </div>
                  ) : null}
                </>
              )}

              <p className="text-sm text-muted-foreground mt-3">Fixed when you send your request. Nothing is charged today. {EXTRA_TIME_NOTE} Extra time is separate, optional work — it is never added automatically.</p>

              <Button
                type="button"
                variant="hero"
                size="xl"
                onClick={goToStep2}
                className="mt-5"
              >
                Continue to visit details
              </Button>
            </div>
            </>)}

             {/* BOOKING REQUEST STEP */}
             <form
              id="booking-request"
              onSubmit={handleBookingSubmit}
              noValidate
               className="mt-2 scroll-mt-16 pb-20 md:scroll-mt-28 md:pb-0"
            >
              {step === 2 && (<>
                <h2 id="quote-step-2-heading" tabIndex={-1} className="font-heading text-2xl font-bold mb-2 scroll-mt-24 outline-none">Your visit</h2>
              <p className="text-sm text-muted-foreground mb-2">Fields marked * are required.</p>
              <p className="text-sm text-foreground mb-6">
                We confirm your date within one business day. Nothing is charged at booking. After the visit you get a photo report first — the charge comes when you approve it, or 24 hours after it&apos;s sent if you haven&apos;t reported an issue.
              </p>
              <div className="mb-6 rounded-lg border border-border bg-background p-4 text-sm">
                <p><strong>Price so far:</strong> {priceSummaryText}</p>
                <p className="text-muted-foreground mt-1">{SIZE_BAND_LABEL[sizeBand]}, {bedrooms} bed, {fullBaths} full bath, {halfBaths} half bath · ZIP {zip || "—"}</p>
              </div>
              <div className="mt-6 flex items-start gap-3">
                <input
                  id="b-photo" name="photoConsent" type="checkbox" required ref={refs.photoConsent}
                  checked={booking.photoConsent} onChange={handleBookingChange}
                  aria-required="true" aria-invalid={!!bookingErrors.photoConsent} aria-describedby={bookingErrors.photoConsent ? "b-photo-error" : undefined}
                  className="mt-1 h-5 w-5 rounded border-input text-primary focus:ring-2 focus:ring-ring"
                />
                <label htmlFor="b-photo" className="text-sm text-foreground leading-snug">
                  {PHOTO_CONSENT_MAIN} *
                  <span className="mt-1 block text-sm text-muted-foreground">{PHOTO_CONSENT_SUB}</span>
                </label>
              </div>
              {bookingErrors.photoConsent && <p id="b-photo-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.photoConsent}</p>}

              {/* PLANNING THE VISIT — size and extra areas never change the price */}
              <div className="mt-6 rounded-lg border border-border bg-background p-4">
                <h3 className="font-heading text-base font-bold">Planning your visit</h3>
                <div className="mt-3">
                  <label htmlFor="q-size" className="block text-sm font-medium mb-1.5">Approximate home size — if you know it</label>
                  <select id="q-size" value={sizeBand} onChange={(e) => setSizeBand(e.target.value as SizeBandKey)} className={selectClass}>
                    {SIZE_BANDS.map((b) => (
                      <option key={b.key} value={b.key}>{b.label}</option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-sm text-muted-foreground">An estimate is fine. This helps us plan enough cleaning time.</p>
                </div>
                <fieldset className="mt-4">
                  <legend className="text-sm font-medium">Any extra areas to clean?</legend>
                  <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {EXTRA_ZONES.map((z) => (
                      <label key={z.key} htmlFor={`q-zone-${z.key}`} className="flex min-h-[44px] items-center gap-2 py-1 text-sm">
                        <input
                          id={`q-zone-${z.key}`} type="checkbox"
                          checked={extraZones.includes(z.key)} onChange={() => toggleZone(z.key)}
                          className="h-5 w-5 rounded border-input text-primary focus:ring-2 focus:ring-ring"
                        />
                        {z.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {scopeReview && (
                  <p className="mt-3 text-sm font-medium text-foreground">
                    We&apos;ll review the cleaning scope before confirming your visit. Your visit price is fixed when you send your request. If the scope review shows different work is needed, we agree any change with you before confirming, never after.
                  </p>
                )}
              </div>
              </>)}
              {step === 3 && (<>
                <h2 id="quote-step-3-heading" tabIndex={-1} className="font-heading text-2xl font-bold mb-2 scroll-mt-24 outline-none">Review &amp; save card</h2>
              <p className="text-sm text-foreground mb-6">
                Check everything below, then send your request. Saving a card does not confirm your date — we confirm within one business day.
              </p>
              <div className="mb-6 rounded-lg border border-border bg-background p-5 text-base">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-heading text-lg font-bold">Your request</h3>
                  <Button variant="link" type="button" className="min-h-[44px] px-1 text-sm font-semibold" onClick={() => setStep(2)}>Edit details</Button>
                </div>
                <dl className="mt-3 space-y-2">
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Service</dt><dd className="font-semibold text-right">{SERVICE_LABEL_CALC[service]} · {service === "standard" ? FREQUENCY_LABEL[frequency] : "One-time"}{deepFirstVisit ? " · First visit: Deep clean" : ""}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Requested date</dt><dd className="font-semibold text-right">{booking.date ? fmtDate(booking.date) : "—"} · {WINDOW_LABEL[booking.time] ?? "Flexible arrival window"}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Address</dt><dd className="font-semibold text-right">{fullAddress || "—"}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Entry</dt><dd className="font-semibold text-right">{entrySummaryLabel(entryMethod || null, entryDetail || null)}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Current visit price</dt><dd className="font-semibold text-right">{priceSummaryText}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Due today</dt><dd className="font-semibold text-right">$0</dd></div>
                </dl>
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-semibold text-primary">View all details</summary>
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 break-words">
                    <dt className="font-semibold">Home</dt><dd>{SIZE_BAND_LABEL[sizeBand]}, {bedrooms} bed, {fullBaths} full bath, {halfBaths} half bath · ZIP {zip}{extraZones.length ? ` · Extra areas: ${extraZones.map((z) => EXTRA_ZONE_LABEL[z]).join(", ")}` : ""}</dd>
                    <dt className="font-semibold">Service</dt><dd>{SERVICE_LABEL_CALC[service]} · {service === "standard" ? FREQUENCY_LABEL[frequency] : "One-time"}{deepFirstVisit ? " · First visit: Deep clean" : ""}</dd>
                    <dt className="font-semibold">Price</dt><dd>{isLargeHome ? "Custom quote — we confirm your price with you before anything is booked" : service === "standard" && breakdown ? <>{isRecurring && breakdown.first_total === breakdown.recurring_total && breakdown.first_service === "standard" ? <>{fmt$(breakdown.recurring_total)} per visit, every other week</> : <>First visit {fmt$(breakdown.first_total)}{breakdown.first_service === "deep" ? " (deep clean)" : ""}{isRecurring ? <> , then {fmt$(breakdown.recurring_total)} every other week</> : ", one-time"}</>}</> : <>{fmt$(mainPrice ?? 0)} one-time</>}</dd>
                    <dt className="font-semibold">Date</dt><dd>{booking.date ? fmtDate(booking.date) : "—"} · {WINDOW_LABEL[booking.time] ?? "Flexible arrival window"}</dd>
                    <dt className="font-semibold">Contact</dt><dd className="min-w-0 break-all">{booking.name} · {booking.email} · {booking.phone}<br />{fullAddress}</dd>
                  </dl>
                  {scopeReview && (
                    <p className="mt-3 text-sm text-foreground">We&apos;ll review the cleaning scope before confirming your visit. Your visit price is fixed when you send your request. If the scope review shows different work is needed, we agree any change with you before confirming, never after.</p>
                  )}
                </details>
              </div>
              </>)}

              {step === 2 && (<>
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
                  <p className="mt-1.5 text-sm text-muted-foreground">For arrival updates on the day of your visit.</p>
                </div>
                <div className="md:col-span-2 flex items-start gap-3">
                  <input
                    id="b-sms" name="smsConsent" type="checkbox"
                    checked={booking.smsConsent} onChange={handleBookingChange}
                    className="mt-1 h-5 w-5 rounded border-input text-primary focus:ring-2 focus:ring-ring"
                  />
                  <label htmlFor="b-sms" className="text-sm text-foreground leading-snug">
                    {SMS_CONSENT_MAIN}
                    <span className="mt-1 block text-sm text-muted-foreground">{SMS_DISCLOSURE}</span>
                  </label>
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
                <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-5">
                  <div>
                    <label htmlFor="b-city" className="block text-sm font-medium mb-1.5">City *</label>
                    <input
                      id="b-city" name="city" type="text" ref={refs.city} required autoComplete="address-level2"
                      value={booking.city} onChange={handleBookingChange} onBlur={handleBookingBlur}
                      aria-required="true" aria-invalid={!!bookingErrors.city} aria-describedby={bookingErrors.city ? "b-city-error" : undefined}
                      placeholder="Sugar Hill"
                      className="w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    {bookingErrors.city && <p id="b-city-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.city}</p>}
                  </div>
                  <div>
                    <label htmlFor="b-state" className="block text-sm font-medium mb-1.5">State *</label>
                    <input
                      id="b-state" name="state" type="text" ref={refs.state} required autoComplete="address-level1" maxLength={2}
                      value={booking.state} onChange={handleBookingChange} onBlur={handleBookingBlur}
                      aria-required="true" aria-invalid={!!bookingErrors.state} aria-describedby={bookingErrors.state ? "b-state-error" : undefined}
                      placeholder="GA"
                      className="w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    {bookingErrors.state && <p id="b-state-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.state}</p>}
                  </div>
                  <div>
                    <label htmlFor="b-apt" className="block text-sm font-medium mb-1.5">Apartment / unit (optional)</label>
                    <input
                      id="b-apt" name="apt" type="text" autoComplete="address-line2"
                      value={booking.apt} onChange={handleBookingChange}
                      placeholder="Apt 4"
                      className="w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
                <div className="md:col-span-2 rounded-lg border border-border bg-background p-4">
                  <p id="entry-label" className="block text-sm font-medium mb-1">How would you like to arrange entry? *</p>
                  <p className="text-sm text-muted-foreground mb-3">You’re welcome to be home for your cleaning. Choose what works best for you.</p>
                  <div role="radiogroup" aria-labelledby="entry-label" className="flex flex-col gap-1">
                    {ENTRY_METHODS.map((m) => (
                      <label key={m} className="flex min-h-[44px] items-center gap-2 py-1 text-sm">
                        <input id={`entry-${m}`} type="radio" name="entryMethod" value={m} checked={entryMethod === m} onChange={() => { setEntryMethod(m); if (m !== "arrange_before") setEntryDetail(""); setBookingErrors((p) => ({ ...p, entryMethod: "", entryDetail: "" })); }} className="h-5 w-5" />
                        {ENTRY_METHOD_LABEL[m]}
                      </label>
                    ))}
                  </div>
                  {bookingErrors.entryMethod && <p role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.entryMethod}</p>}
                  {entryMethod === "arrange_before" && (
                    <div className="mt-3">
                      <p id="entry-detail-label" className="block text-sm font-medium mb-1">How will you arrange entry?</p>
                      <div role="radiogroup" aria-labelledby="entry-detail-label" className="flex flex-col gap-1">
                        {ENTRY_DETAILS.map((d) => (
                          <label key={d} className="flex min-h-[44px] items-center gap-2 py-1 text-sm">
                            <input id={`entry-detail-${d}`} type="radio" name="entryDetail" value={d} checked={entryDetail === d} onChange={() => { setEntryDetail(d); setBookingErrors((p) => ({ ...p, entryDetail: "" })); }} className="h-5 w-5" />
                            {ENTRY_DETAIL_LABEL[d]}
                          </label>
                        ))}
                      </div>
                      {bookingErrors.entryDetail && <p role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.entryDetail}</p>}
                      <p className="mt-2 text-sm text-muted-foreground">No entry codes are needed now. You can add private entry details after your visit is confirmed.</p>
                    </div>
                  )}
                  <div className="mt-3">
                    <label htmlFor="b-entry-notes" className="block text-sm font-medium mb-1.5">Parking or building notes (optional)</label>
                    <input
                      id="b-entry-notes" type="text" value={entryNotes} onChange={(e) => setEntryNotes(e.target.value)} maxLength={500}
                      placeholder="e.g. Park in the driveway, gate intercom at the front"
                      className="w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <p className="mt-1 text-sm text-muted-foreground">Do not put entry codes, alarm codes or key locations here. Private entry details are added after your visit is confirmed.</p>
                  </div>
                </div>
                <div>
                  <label htmlFor="b-date" className="block text-sm font-medium mb-1.5">Preferred date *</label>
                  <input
                    id="b-date" name="date" type="date" min={minDate} ref={refs.date}
                    required maxLength={10} pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"
                    value={booking.date} onChange={handleBookingChange} onBlur={handleBookingBlur}
                    aria-invalid={!!bookingErrors.date} aria-describedby={bookingErrors.date ? "b-date-error" : undefined}
                    className="w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {bookingErrors.date && <p id="b-date-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.date}</p>}
                  <p className="mt-1.5 text-sm text-muted-foreground">We book at least 3 days ahead — we&apos;ll confirm availability within one business day.</p>
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
                    placeholder="Pets, focus areas, rooms to skip…"
                    className="w-full px-4 py-3 rounded-lg border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                  />
                  <p className="mt-1.5 text-sm text-muted-foreground">For cleaning preferences only — do not put entry codes, keys or alarm codes here. Private entry details are added after your visit is confirmed.</p>
                </div>
              </div>
              <div className="mt-6 flex flex-col sm:flex-row gap-3">
                <Button variant="outline" type="button" className="min-h-[44px]" onClick={() => setStep(1)}>Back to price</Button>
                <Button variant="hero" type="button" className="min-h-[48px] flex-1" onClick={goToStep3}>Review my request</Button>
              </div>
              </>)}

              {step === 3 && (<>
              <div className="mt-5 flex items-start gap-3">
                <input
                  id="b-terms" name="termsConsent" type="checkbox" required ref={refs.termsConsent}
                  checked={booking.termsConsent} onChange={handleBookingChange}
                  aria-required="true" aria-invalid={!!bookingErrors.termsConsent} aria-describedby={bookingErrors.termsConsent ? "b-terms-error" : undefined}
                  className="mt-1 h-5 w-5 rounded border-input text-primary focus:ring-2 focus:ring-ring"
                />
                <label htmlFor="b-terms" className="text-sm text-foreground leading-snug">
                  I agree to the{" "}
                  <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline text-primary">Terms</a>
                  , including binding arbitration (Section 16), and acknowledge the{" "}
                  <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline text-primary">Privacy Policy</a>. *
                </label>
              </div>
              {bookingErrors.termsConsent && <p id="b-terms-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.termsConsent}</p>}





              <div hidden aria-hidden="true"><label htmlFor="b-website">Leave this empty</label><input id="b-website" name="website" tabIndex={-1} autoComplete="off" value={booking.website} onChange={handleBookingChange} /></div>
              <div role="alert" className="mt-4 text-sm text-destructive empty:hidden">{submitError}</div>
              <div className="mt-6 rounded-xl border border-border bg-card p-5 text-base leading-relaxed">
                  <h3 className="font-heading text-lg font-bold mb-2">Payment</h3>
                  <p className="text-lg leading-relaxed"><span className="font-semibold">Nothing is charged today.</span> Your card is charged when you approve your cleaning report, or automatically 24 hours after we send it if you haven’t reported an issue.</p>
                  <ul className="mt-3 list-disc space-y-2 pl-5 text-base">
                    <li><strong>Why your card now?</strong> So paying later takes one tap — approve the photo report and you’re done. No prepayment, no second checkout.</li>
                    <li><strong>Safe with Stripe.</strong> Your card details go straight to Stripe, our payment processor. We never see or store your full card number.</li>
                    <li><strong>You stay in control.</strong> Report an issue within 24 hours and the automatic charge is blocked for this visit — it never runs on its own afterwards. You approve again to pay once we&apos;ve fixed it.</li>
                  </ul>
                  <p className="mt-3 text-base text-muted-foreground">Saving a card doesn’t confirm your date — we confirm it by email within one business day.</p>
                </div>
              <div className="mt-6 flex flex-col sm:flex-row gap-3">
                <Button variant="outline" type="button" className="min-h-[44px]" onClick={() => setStep(2)}>Back to visit details</Button>
                <Button variant="hero" size="xl" type="submit" disabled={!canSubmit} className="flex-1 min-h-[48px]">
                  {isSubmitting
                    ? "Sending..."
                    : !canProceed
                      ? "Enter a ZIP in our service area"
                      : needsCleaningHistory ? "Answer the cleaning-history question above"
                      : "Continue to save card — $0 today"}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground text-center mt-3">
                Questions? Call <a href="tel:+17705258599" className="underline">(770) 525-8599</a> or email <a href="mailto:hello@gatehousehomecleaning.com" className="underline">hello@gatehousehomecleaning.com</a>.
              </p>
              </>)}
            </form>
          </div>
        </div>
      </section>

    </div>
  );
};

export default Quote;
