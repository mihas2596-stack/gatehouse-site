type FunnelEvent = "gh_page_view" | "gh_quote_start" | "gh_quote_review" | "gh_lead_submit" | "gh_contact_submit" | "gh_form_error";
type EventDetails = {
  page_path?: string;
  form_type?: "quote" | "contact";
  service_type?: string;
  frequency?: string;
  error_stage?: "validation" | "delivery";
};
type MeasurementWindow = Window & {
  Termly?: { getConsentState?: () => { analytics?: boolean } };
  dataLayer?: Record<string, unknown>[];
};

function analyticsAllowed(): boolean {
  if (typeof window === "undefined") return false;
  try { return (window as MeasurementWindow).Termly?.getConsentState?.().analytics === true; }
  catch { return false; }
}

// Campaign labels only; no query strings, click identifiers or customer data.
// Kept in memory for SPA navigation. No cookies or browser storage are added.
const landingCampaign: Record<string, string> = {};
if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search);
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content"]) {
    const value = params.get(key);
    if (value && /^[a-zA-Z0-9._-]{1,80}$/.test(value)) landingCampaign[key] = value;
  }
}

export function campaignAttribution(): Record<string, string> {
  return analyticsAllowed() ? { ...landingCampaign } : {};
}

// These are GTM integration events, not proof that a GA4/Ads tag is configured.
// Never pass names, email, phone, address, ZIP, notes, or quote values here.
export function trackFunnel(event: FunnelEvent, details: EventDetails = {}): boolean {
  if (!analyticsAllowed()) return false;
  const target = window as MeasurementWindow;
  target.dataLayer ??= [];
  target.dataLayer.push({ event, ...details });
  return true;
}
