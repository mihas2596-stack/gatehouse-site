import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import PaymentSummary from "@/components/PaymentSummary";
import SEO from "@/components/SEO";
import { campaignAttribution, trackFunnel } from "@/lib/measurement";
import { Home, Search, Package } from "lucide-react";
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
  BEDROOM_CHOICES,
  FULL_BATH_CHOICES,
  FREQUENCY_OPTIONS,
  FREQUENCY_LABEL,
  SERVICE_OPTIONS,
  SERVICE_LABEL_CALC,
  type CalcServiceKey,
  type FrequencyKey,
  type PriceBreakdown,
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
const PHOTO_CONSENT_MAIN =
  "I agree to photos of the cleaned rooms for my private cleaning report.";
const PHOTO_CONSENT_SUB = "Kept for 90 days. Never published without separate written permission. You can mark rooms you'd rather we skip in photos on your visit page before the visit.";
const PHOTO_CONSENT_TEXT = `${PHOTO_CONSENT_MAIN} ${PHOTO_CONSENT_SUB}`;

type QuoteDraft = {
  savedAt: number;
  zip: string;
  bedrooms: number;
  fullBaths: number;
  recentlyCleaned: "yes" | "no" | "";
  frequency: FrequencyKey;
  service: CalcServiceKey;
  addons: {
    insideOven: boolean;
    insideFridge: boolean;
    insideCabinets: boolean;
    interiorWindows: number;
    pets: boolean;
  };
};

const QUOTE_DRAFT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function readQuoteDraft(key: string | null): Partial<QuoteDraft> {
  if (!key) return {};
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return {};
    const draft: Partial<QuoteDraft> = JSON.parse(raw);
    const age = Date.now() - (draft.savedAt ?? 0);
    if (age >= 0 && age < QUOTE_DRAFT_MAX_AGE_MS) return draft;
    sessionStorage.removeItem(key);
  } catch { /* Storage may be disabled or the draft may be unreadable. */ }
  return {};
}

const Quote = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const initialService = resolveService(params.get("service"));
  const initialFrequency = params.get("frequency") === "onetime" ? "onetime" : "every2weeks";
  const selectedService = params.has("service") || params.has("frequency");
  const draftKey = params.has("tp") ? null
    : selectedService ? `gh_quote_draft_v1:${initialService}:${initialFrequency}` : "gh_quote_draft_v1";
  const [draft] = useState(() => readQuoteDraft(draftKey));
  const [bedrooms, setBedrooms] = useState<number>(draft.bedrooms ?? 3);
  const [fullBaths, setFullBaths] = useState<number>(draft.fullBaths ?? 2);
  const [recentlyCleaned, setRecentlyCleaned] = useState<"yes" | "no" | "">(draft.recentlyCleaned ?? "");
  const [frequency, setFrequency] = useState<FrequencyKey>(draft.frequency ?? initialFrequency);
  const [service, setService] = useState<CalcServiceKey>(draft.service ?? initialService);
  const [zip, setZip] = useState(draft.zip ?? "");
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

  const [insideOven, setInsideOven] = useState(draft.addons?.insideOven ?? false);
  const [insideFridge, setInsideFridge] = useState(draft.addons?.insideFridge ?? false);
  const [insideCabinets, setInsideCabinets] = useState(draft.addons?.insideCabinets ?? false);
  const [interiorWindows, setInteriorWindows] = useState(draft.addons?.interiorWindows ?? 0);
  const [pets, setPets] = useState(draft.addons?.pets ?? false);

  const addons = useMemo(
    () => ({ insideOven, insideFridge, insideCabinets, interiorWindows, pets }),
    [insideOven, insideFridge, insideCabinets, interiorWindows, pets]
  );

  useEffect(() => {
    if (!draftKey) return;
    // Only calculator inputs are saved. Contact details, access, consent and
    // prices stay out of the draft. A restored quote always recalculates.
    const current: QuoteDraft = { savedAt: Date.now(), zip, bedrooms, fullBaths, recentlyCleaned, frequency, service, addons };
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(current));
    } catch { /* A browser that blocks storage can still request a visit. */ }
  }, [draftKey, zip, bedrooms, fullBaths, recentlyCleaned, frequency, service, addons]);

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
    [service, bedrooms, fullBaths, addons, testMode]
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
  const canProceed = zipInArea;
  const showPrice = zipInArea && tier !== null;

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
    city: params.get("city")?.replace(/[^A-Za-z \-]/g, "").slice(0, 60) ?? "",
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
  // Step-1 validation errors: shown inline (never silent) when Continue is
  // pressed with the cleaning-history question unanswered or the ZIP
  // missing/invalid.
  const [step1HistoryError, setStep1HistoryError] = useState(false);
  const [step1ZipError, setStep1ZipError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLock = useRef(false);
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
  }, [bedrooms, fullBaths, recentlyCleaned, frequency, service, zip, addons]);
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
    if (field === "state") {
      if (!value.trim()) return "Enter your state.";
      return value.trim().toUpperCase() === "GA" ? "" : "We currently serve Georgia only — please enter GA.";
    }
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
      if (!booking.photoConsent) errs.photoConsent = "Please agree to photos for your private report.";
    }
    return errs;
  };

  const goToStep2 = () => {
    if (needsCleaningHistory) {
      setStep1HistoryError(true);
      document.getElementById("cleaning-history")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      document.getElementById("q-recent-yes")?.focus();
      return;
    }
    if (!canProceed) {
      if (!zipEntered) setStep1ZipError(zip.length === 0 ? "Enter your ZIP code to see your price." : "Enter a 5-digit ZIP code.");
      document.getElementById("q-zip")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      document.getElementById("q-zip")?.focus();
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
    if (!booking.photoConsent) errs.photoConsent = "Please agree to photos for your private report.";
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
    // Audit fix (§10): gh_quote_review was declared but never fired,
    // so "reached review" was unmeasurable. Fired once per entry here
    // (goToStep3 is the only path into step 3 besides Back/Edit, which
    // only setStep without re-validating).
    trackFunnel("gh_quote_review", { form_type: "quote" });
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
    if (submitLock.current) return;
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
    submitLock.current = true;
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
        `${bedrooms} BR`,
        `${fullBaths} full BA`,
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
      ].filter(Boolean).join(" · ");
      // Idempotency: one request_id per booking attempt, kept in
      // sessionStorage so a retry — even after a page reload — reuses it and
      // the server reproduces the same booking instead of a duplicate. The id
      // rotates when the booking content changes or after a successful send.
      if (!requestRef.current) {
        const sig = JSON.stringify([booking.email, booking.date, service, bedrooms, fullBaths, zip, frequency, mainPrice, entryMethod, entryDetail, entryNotes, booking.city, booking.state, booking.apt]);
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
        notes: booking.notes.trim(),
        consent_record: consentRecord,
        bedrooms: String(bedrooms),
        bathrooms: String(fullBaths),
        full_baths: String(fullBaths),
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
        test_price_window: globalCut,
        source: "quote",
        attribution: campaignAttribution(),
        terms_consent: booking.termsConsent,
        photo_consent: booking.photoConsent,
      };
      setSubmitError("");
      const res = await fetch("/api/send-contact-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let data: { ok?: boolean; customerEmailSent?: boolean; errors?: Record<string, string>; bt?: string; server_first?: string; server_recurring?: string } | null = null;
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
      try {
        sessionStorage.removeItem("gh_request_id");
        sessionStorage.removeItem("gh_request_sig");
        if (draftKey) sessionStorage.removeItem(draftKey);
      } catch { /* Storage may be disabled. */ }
      requestRef.current = null;
      trackFunnel("gh_lead_submit", { form_type: "quote", service_type: service, frequency: isRecurring ? "every2weeks" : "onetime" }, payload.request_id);
      // Recap shown on /thank-you: price, date, arrival window, current
      // status and response time. Never a "confirmed" promise — the date is
      // a request until Gatehouse confirms availability by email.
      // N23: the server returns its verified totals — when they differ
      // from what this tab showed, the recap, the plan and the card step
      // use the server values, and /thank-you says the price changed.
      const serverFirst = typeof data.server_first === "string" ? parseFloat(data.server_first) : NaN;
      const serverRecurring = typeof data.server_recurring === "string" ? parseFloat(data.server_recurring) : NaN;
      const effFirst = Number.isFinite(serverFirst) ? serverFirst : mainPrice;
      const effRecurring = Number.isFinite(serverRecurring)
        ? serverRecurring
        : isRecurring && breakdown ? breakdown.recurring_total : null;
      const serverPriceChanged = Number.isFinite(serverFirst) && mainPrice !== null && serverFirst !== mainPrice;
      const recapPrice =
        service === "standard" && breakdown
          ? isRecurring
            ? effFirst === effRecurring && breakdown.first_service === "standard"
              ? `${fmt$(effRecurring ?? breakdown.recurring_total)} per visit, every other week`
              : `First visit ${fmt$(effFirst ?? breakdown.first_total)}${breakdown.first_service === "deep" ? " (deep clean)" : ""}, then ${fmt$(effRecurring ?? breakdown.recurring_total)} per visit, every other week`
            : `One-time: ${fmt$(effFirst ?? breakdown.first_total)}`
          : effFirst !== null
            ? `${fmt$(effFirst)} one-time`
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
          // N23: effFirst/effRecurring are the server totals when the
          // server returned them — the card step never prices from a
          // stale browser tab.
          plan: {
            service: SERVICE_LABEL_CALC[service],
            first: effFirst,
            recurring: effRecurring,
            firstIsDeep: breakdown?.first_service === "deep",
          },
          serverPriceChanged,
        },
      });
    } catch (err) {
      console.error("Quote booking error");
      trackFunnel("gh_form_error", { form_type: "quote", error_stage: "delivery" });
      setSubmitError("Something went wrong. Please try again or email us at hello@gatehousehomecleaning.com.");
    } finally {
      submitLock.current = false;
      setIsSubmitting(false);
    }
  };

  const selectClass =
    "w-full px-4 py-3 rounded-lg border border-border bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring";
  const addonNote = isRecurring ? "(every visit)" : "(this visit)";
  const includedAddons = ADDONS_INCLUDED_IN[service];
  // Human-readable add-on summary for the price block, e.g. "Inside oven +$35 (every visit)".
  const priceBlockAddons = [
    insideOven && !includedAddons.includes("insideOven") ? `Inside oven +${fmt$(dispPrice(ADDONS.insideOven.price))} ${addonNote}` : "",
    insideFridge && !includedAddons.includes("insideFridge") ? `Inside fridge +${fmt$(dispPrice(ADDONS.insideFridge.price))} ${addonNote}` : "",
    insideCabinets && !includedAddons.includes("insideCabinets") ? `Inside cabinets +${fmt$(dispPrice(ADDONS.insideCabinets.price))} ${addonNote}` : "",
    interiorWindows > 0 ? `${interiorWindows} interior windows +${fmt$(dispPrice(interiorWindows * ADDONS.interiorWindow.price))} ${addonNote}` : "",
    pets ? `Pets +${fmt$(dispPrice(ADDONS.pets.price))} ${addonNote}` : "",
  ].filter(Boolean).join(", ");

  return (
    <div className="page-shell readable-flow">
      <SEO
        title="See Your Cleaning Price | Gatehouse"
        description="See your cleaning price online before sharing your contact details, then request a visit."
        url="https://gatehousehomecleaning.com/quote"
      />
      <section className="py-4 md:py-6 bg-warm-gradient">
        <div className="container max-w-3xl text-center">
          <h1 id="quote-step-1-heading" tabIndex={-1} className="font-heading text-3xl md:text-[44px] font-bold mb-3 scroll-mt-24 outline-none">
            {step === 1 ? "See your cleaning price" : step === 2 ? "Request a visit" : "Review your request"}
          </h1>
          <p className="text-muted-foreground text-lg">
            {step === 1
              ? "No email or card needed to see your price."
              : step === 2
                ? "Choose your preferred date. We’ll confirm availability by email."
                : "Check your visit details before saving your card."}
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
            <p className="text-sm text-muted-foreground mb-6">Choose your rooms and cleaning type to see your price.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="md:col-span-2">
                <label htmlFor="q-zip" className="block text-sm font-medium mb-1.5">ZIP code (service area check)</label>
                <input
                  id="q-zip"
                  type="text"
                  inputMode="numeric"
                  maxLength={5}
                  value={zip}
                  onChange={(e) => { setZip(e.target.value.replace(/\D/g, "")); setStep1ZipError(""); }}
                  placeholder="e.g. 30024"
                  aria-invalid={zipOutOfArea || !!step1ZipError}
                  aria-describedby="zip-msg"
                  className={`w-full px-4 py-3 rounded-lg border bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring ${
                    zipOutOfArea ? "border-destructive" : "border-border"
                  }`}
                />
                <p id="zip-msg" className="mt-2 text-sm" role={zipOutOfArea || step1ZipError ? "alert" : undefined}>
                  {step1ZipError && <span className="text-destructive">{step1ZipError}</span>}
                  {!step1ZipError && zipPartial && <span className="text-muted-foreground">Enter a 5-digit ZIP code.</span>}
                  {zipInArea && <span className="text-foreground">We clean homes in {zip}.</span>}
                  {zipOutOfArea && (
                    <span className="text-destructive">
                      We don't serve this ZIP yet. We serve Sugar Hill, Suwanee, Buford, Duluth, Johns Creek, Alpharetta and Roswell. <a href="mailto:hello@gatehousehomecleaning.com" className="underline">Email us</a> and we’ll let you know when we expand to your area.
                    </span>
                  )}
                </p>
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

              <div className="md:col-span-2">
                <p id="service-label" className="block text-sm font-medium mb-2">Type of cleaning</p>
                <div role="radiogroup" aria-labelledby="service-label" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {SERVICE_OPTIONS.map((t) => {
                    const Icon = t.key === "standard" ? Home : t.key === "deep" ? Search : Package;
                    return (
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
                        <Icon className={`w-4 h-4 ${service === t.key ? "text-primary" : "text-muted-foreground"}`} />
                        {t.label}
                      </div>
                      <p className="text-sm font-normal text-muted-foreground mt-1">{t.tagline}</p>
                    </button>
                    );
                  })}
                </div>
              </div>

              {service === "standard" && (
                <div className="md:col-span-2">
                  <p id="frequency-label" className="block text-sm font-medium mb-2">How often</p>
                  <div role="radiogroup" aria-labelledby="frequency-label" className="grid grid-cols-2 gap-3">
                    {FREQUENCY_OPTIONS.map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        role="radio"
                        aria-checked={frequency === f.key}
                        onClick={() => setFrequency(f.key)}
                        className={`px-4 py-3 rounded-lg border-2 min-h-[44px] font-semibold transition-all text-left ${
                          frequency === f.key
                            ? "border-primary bg-peach/40 text-foreground"
                            : "border-border bg-background text-muted-foreground hover:border-primary/40"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

            </div>

            {service === "standard" && (
              <fieldset className="mt-6" id="cleaning-history">
                <legend className="block text-sm font-medium mb-2">Professionally cleaned in the last 3 months? *</legend>
                {recentlyCleaned === "no" && (
                  <p className="text-sm text-muted-foreground mb-2">First visit will be a deep clean.</p>
                )}
                <div role="radiogroup" aria-label="Cleaned professionally in the last 3 months" aria-describedby={step1HistoryError ? "history-error" : undefined} className="grid grid-cols-2 gap-3">
                  {(["yes", "no"] as const).map((v) => (
                    <button
                      key={v}
                      id={v === "yes" ? "q-recent-yes" : "q-recent-no"}
                      type="button"
                      role="radio"
                      aria-checked={recentlyCleaned === v}
                      onClick={() => { setRecentlyCleaned(v); setStep1HistoryError(false); }}
                      className={`px-4 py-3 rounded-lg border-2 min-h-[44px] font-semibold transition-all text-left ${
                        recentlyCleaned === v
                          ? "border-primary bg-peach/40 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      {v === "yes" ? "Yes" : "No"}
                    </button>
                  ))}
                </div>
                {step1HistoryError && (
                  <p id="history-error" role="alert" className="mt-2 text-sm text-destructive">Please answer this — it sets your first-visit price.</p>
                )}
              </fieldset>
            )}

            {/* Add-ons — collapsed by default so the price form stays short. */}
            <div className="mt-6">
              <button
                type="button"
                aria-expanded={extrasOpen}
                onClick={() => setExtrasOpen((v) => !v)}
                className="min-h-[44px] rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground"
              >
                Add extras (optional) — {extrasSummary || "None selected"} {extrasOpen ? "⌃" : "⌄"}
              </button>
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
              ) : !zipInArea ? (
                <p className="text-base text-foreground">Enter your ZIP code to see your price.</p>
              ) : (
                <>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Your cleaning cost</p>
                  {service !== "standard" ? (
                    // Deep and move-in/out: one total, oven/fridge/cabinets included.
                    <>
                      <p className="font-heading text-3xl sm:text-4xl font-bold text-primary">
                        One-time cleaning: {fmt$(oneTimeTotal ?? 0)}
                      </p>
                      <p className="text-sm text-muted-foreground mt-2">
                        {SERVICE_LABEL_CALC[service]}. Inside oven, fridge and cabinets are included — never charged twice.
                      </p>
                      {service === "deep" && (
                        <p className="text-sm mt-2">
                          <Link to="/services" className="underline text-primary">Compare with a standard clean</Link>
                        </p>
                      )}
                    </>
                  ) : !answered ? (
                    <div className="flex flex-col items-center gap-1">
                      <p className="text-base text-foreground">
                        {isRecurring
                          ? <>Estimated regular visits: <strong>{fmt$(breakdown?.recurring_total ?? 0)}</strong> every other week.</>
                          : <>Estimated one-time clean: <strong>{fmt$(breakdown?.first_total ?? 0)}</strong>.</>}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Answer the cleaning-history question above to confirm your first-visit price — a deep clean may be needed first. Not sure? Pick your best guess — we'll confirm the details with you before your visit.
                      </p>
                    </div>
                  ) : breakdown ? (
                    <div className="flex flex-col items-center gap-1">
                      {isRecurring ? (
                        <>
                          <p className="font-heading text-2xl sm:text-3xl font-bold text-primary">
                            First visit ({breakdown.first_service === "deep" ? "Deep clean" : "Standard"}): {fmt$(breakdown.first_total)}
                          </p>
                          <p className="text-base font-semibold text-foreground mt-1.5">
                            Future visits (Standard): {fmt$(breakdown.recurring_total)} every other week
                          </p>
                        </>
                      ) : (
                        <p className="font-heading text-3xl sm:text-4xl font-bold text-primary">
                          One-time cleaning: {fmt$(breakdown.first_total)}
                        </p>
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

              {showPrice && <p className="mt-3 text-base font-semibold text-foreground">Due today: $0</p>}
              {showPrice && <p className="text-sm text-muted-foreground mt-2">Your price is locked in when you send your request.</p>}
              <p className="text-sm text-muted-foreground mt-1">Earliest visit: {fmtDate(minDate)}</p>

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
              <div className="mb-6 rounded-lg border border-border bg-background p-4 text-sm">
                <p><strong>Price so far:</strong> {priceSummaryText}</p>
                <p className="text-muted-foreground mt-1">{bedrooms} bed, {fullBaths} full bath · ZIP {zip || "—"}</p>
                <Link to="/whats-included" className="inline-flex min-h-[44px] items-center text-primary underline">See the full room-by-room list</Link>
              </div>

              </>)}
              {step === 3 && (<>
              <div className="mb-6 rounded-lg border border-border bg-background p-5 text-base">
                <div className="flex items-center justify-between gap-3">
                  <h2 id="quote-step-3-heading" tabIndex={-1} className="font-heading text-lg font-bold outline-none">Your request</h2>
                  <Button variant="link" type="button" className="min-h-[44px] px-1 text-sm font-semibold" onClick={() => setStep(2)}>Edit details</Button>
                </div>
                <dl className="mt-3 space-y-2">
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4"><dt className="text-muted-foreground">Service</dt><dd className="font-semibold text-left sm:text-right">{SERVICE_LABEL_CALC[service]} · {service === "standard" ? FREQUENCY_LABEL[frequency] : "One-time"}{deepFirstVisit ? " · First visit: Deep clean" : ""}</dd></div>
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4"><dt className="text-muted-foreground">Current visit price</dt><dd className="font-semibold text-left sm:text-right">{priceSummaryText}</dd></div>
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4"><dt className="text-muted-foreground">Requested date</dt><dd className="font-semibold text-left sm:text-right">{booking.date ? fmtDate(booking.date) : "—"} · {WINDOW_LABEL[booking.time] ?? "Flexible arrival window"}</dd></div>
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4"><dt className="text-muted-foreground">Address</dt><dd className="font-semibold text-left sm:text-right">{fullAddress || "—"}</dd></div>
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4"><dt className="text-muted-foreground">Entry</dt><dd className="font-semibold text-left sm:text-right">{entrySummaryLabel(entryMethod || null, entryDetail || null)}</dd></div>
                  {entryMethod === "decide_later" && (
                    <p className="mt-1 text-sm text-foreground">We will email you before your visit to help arrange entry. You don&apos;t need to share a door code now.</p>
                  )}
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4"><dt className="text-muted-foreground">Due today</dt><dd className="font-semibold text-left sm:text-right">$0</dd></div>
                </dl>
                <p className="mt-4 rounded-xl bg-sage/15 p-4 text-base leading-relaxed"><strong>Your date is still a request.</strong> We confirm your date, arrival window and cleaner by email within one business day.</p>
                <details className="mt-4">
                  <summary className="min-h-[44px] cursor-pointer py-2 text-base font-semibold text-primary">View all details</summary>
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 break-words">
                    <dt className="font-semibold">Home</dt><dd>{bedrooms} bedrooms · {fullBaths} full bathrooms</dd>
                    <dt className="font-semibold">Contact</dt><dd className="min-w-0 break-all">{booking.name} · {booking.email} · {booking.phone}<br />{fullAddress}</dd>
                  </dl>
                </details>
              </div>
              </>)}

              {step === 2 && (<>
              <h3 className="font-heading text-base font-bold mb-2">Contact details</h3>
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
                  <p className="mt-1.5 text-sm text-muted-foreground">For updates about your visit.</p>
                </div>
                <h3 className="font-heading text-base font-bold mb-2 md:col-span-2">Your preferred visit</h3>
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
                  <p className="mt-1.5 text-sm text-muted-foreground">Please don&apos;t put door codes or key details here — you&apos;ll add them privately on your confirmed visit page.</p>
                </div>
                <h3 className="font-heading text-base font-bold mb-2 md:col-span-2">Your home address</h3>
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
                  <details className="rounded-lg">
                    <summary className="cursor-pointer text-sm font-medium text-foreground min-h-[44px] flex items-center">Apartment / unit (optional)</summary>
                    <input
                      id="b-apt" name="apt" type="text" autoComplete="address-line2" aria-label="Apartment / unit (optional)"
                      value={booking.apt} onChange={handleBookingChange}
                      placeholder="Apt 4"
                      className="mt-1 w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </details>
                </div>
                <div className="md:col-span-2 rounded-lg border border-border bg-background p-4">
                  <p id="entry-label" className="block text-sm font-medium mb-1">How will your cleaner get in? *</p>
                  <p className="text-sm text-muted-foreground mb-3">Choose an option. No keys or entry codes needed now.</p>
                  <div role="radiogroup" aria-labelledby="entry-label" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {ENTRY_METHODS.map((m) => (
                      <label key={m} className={`flex min-h-[64px] cursor-pointer items-center gap-3 rounded-xl border p-4 text-base ${entryMethod === m ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-card"}`}>
                        <input id={`entry-${m}`} type="radio" name="entryMethod" value={m} checked={entryMethod === m} onChange={() => { setEntryMethod(m); if (m !== "arrange_before") setEntryDetail(""); setBookingErrors((p) => ({ ...p, entryMethod: "", entryDetail: "" })); }} className="h-5 w-5" />
                        {ENTRY_METHOD_LABEL[m]}
                      </label>
                    ))}
                  </div>
                  {entryMethod === "decide_later" && (
                    <p className="mt-3 text-sm text-foreground">We’ll email you to agree on entry before your visit.</p>
                  )}
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
                  <details className="mt-4">
                    <summary className="min-h-[44px] cursor-pointer font-semibold">Add parking or building notes (optional)</summary>
                    <label htmlFor="b-entry-notes" className="block text-sm font-medium mb-1.5">Parking or building notes (optional)</label>
                    <input
                      id="b-entry-notes" type="text" value={entryNotes} onChange={(e) => setEntryNotes(e.target.value)} maxLength={500}
                      placeholder="e.g. Park in the driveway, gate intercom at the front"
                      className="w-full px-4 py-3 rounded-lg border border-input bg-background min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <p className="mt-1 text-sm text-muted-foreground">For parking and directions only. Add codes privately after confirmation.</p>
                  </details>
                </div>

              </div>
              <h3 className="font-heading text-base font-bold mb-2">Your private photo report</h3>
              <p className="text-sm text-foreground mb-3">See the results after cleaning. Photos are never published without your separate written permission.</p>
              <div className="flex items-start gap-3">
                <input
                  id="b-photo" name="photoConsent" type="checkbox" required ref={refs.photoConsent}
                  checked={booking.photoConsent} onChange={handleBookingChange}
                  aria-required="true" aria-invalid={!!bookingErrors.photoConsent} aria-describedby={bookingErrors.photoConsent ? "b-photo-error" : undefined}
                  className="mt-1 h-5 w-5 rounded border-input text-primary focus:ring-2 focus:ring-ring"
                />
                <label htmlFor="b-photo" className="text-sm text-foreground leading-snug">
                  {PHOTO_CONSENT_MAIN} *

                </label>
              </div>
              <details className="mt-3 mb-5"><summary className="min-h-[44px] cursor-pointer text-base font-semibold">Photo privacy &amp; rooms to skip</summary><p className="mt-2 text-base leading-relaxed">{PHOTO_CONSENT_SUB}</p></details>
              {bookingErrors.photoConsent && <p id="b-photo-error" role="alert" className="mt-1 text-sm text-destructive">{bookingErrors.photoConsent}</p>}
              <div className="mt-6 rounded-lg border border-border bg-background p-4 text-sm">
                <p><strong>Your price:</strong></p>
                {service === "standard" && breakdown ? (
                  <>
                    <p className="mt-1">First visit: {fmt$(breakdown.first_total)}{breakdown.first_service === "deep" ? " (deep clean)" : ""}</p>
                    {isRecurring && <p className="mt-1">Then: {fmt$(breakdown.recurring_total)} per visit, every other week</p>}
                    {!isRecurring && <p className="mt-1">One-time visit</p>}
                  </>
                ) : (
                  <p className="mt-1">{priceSummaryText}</p>
                )}
                <p className="mt-1"><strong>Due today: $0</strong></p>
              </div>
              <div className="mt-6 flex flex-col sm:flex-row gap-3">
                <Button variant="outline" type="button" className="min-h-[44px]" onClick={() => setStep(1)}>Back to price</Button>
                <Button variant="hero" type="button" className="min-h-[48px] flex-1" onClick={goToStep3}>Review my request</Button>
              </div>
              </>)}

              {step === 3 && (<>
              <div hidden aria-hidden="true"><label htmlFor="b-website">Leave this empty</label><input id="b-website" name="website" tabIndex={-1} autoComplete="off" value={booking.website} onChange={handleBookingChange} /></div>
              <div role="alert" className="mt-4 text-sm text-destructive empty:hidden">{submitError}</div>
              <div className="mt-6"><PaymentSummary showCard /></div>
              <section className="mt-5 text-base leading-relaxed" aria-label="Changes and home access">
                <h3 className="font-semibold">Changes &amp; home access</h3>
                <p className="mt-2">Cancel free at least 48 hours before your visit. Later cancellations cost $25.</p>
                <p className="mt-2">Please arrange entry before the visit. <a href="/terms#terms-4" target="_blank" rel="noopener noreferrer" className="underline text-primary">See how to arrange access</a>.</p>
              </section>
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
              <p className="mt-2 text-sm text-muted-foreground">Binding arbitration means disputes are resolved outside court. You can opt out within 30 days — see Terms, Section 16.5.</p>
              <div className="mt-6 flex flex-col sm:flex-row gap-3">
                <Button variant="outline" type="button" className="min-h-[44px]" onClick={() => setStep(2)}>Back to visit details</Button>
                <Button variant="hero" size="xl" type="submit" disabled={!canSubmit} className="flex-1 min-h-[48px]">
                  {isSubmitting
                    ? "Sending..."
                    : !canProceed
                      ? "Enter a ZIP in our service area"
                      : needsCleaningHistory ? "Answer the cleaning-history question above"
                      : "Continue to Stripe — $0 today"}
                </Button>
              </div>
              <p className="mt-3 text-center text-base">Stripe handles your card details.</p>
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
