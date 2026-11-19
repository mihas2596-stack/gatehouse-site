type FunnelEvent = "gh_visit_confirmed_view" | "gh_report_view" | "gh_payment_success_view" | "gh_issue_status_view" | "gh_page_view" | "gh_quote_start" | "gh_quote_review" | "gh_lead_submit" | "gh_card_saved" | "gh_contact_submit" | "gh_form_error";
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
// The landing UTMs live in memory for SPA navigation AND in sessionStorage,
// so they survive the Stripe redirect: the app reloads on the return URL,
// which carries no UTMs, and the stored labels are read back instead. A
// fresh UTM in the URL always wins over the stored one. No cookies are added.
const CAMPAIGN_STORAGE_KEY = "gh_campaign";
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content"] as const;
const UTM_VALUE = /^[a-zA-Z0-9._-]{1,80}$/;

function readStoredCampaign(): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem(CAMPAIGN_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const key of UTM_KEYS) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "string" && UTM_VALUE.test(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

const landingCampaign: Record<string, string> = {};
if (typeof window !== "undefined") {
  // Stored labels first (the Stripe return), then the URL wins.
  Object.assign(landingCampaign, readStoredCampaign());
  const params = new URLSearchParams(window.location.search);
  let changed = false;
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value && UTM_VALUE.test(value)) { landingCampaign[key] = value; changed = true; }
  }
  if (changed) {
    try { window.sessionStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(landingCampaign)); } catch { /* storage unavailable — the in-memory copy still works for this load */ }
  }
}

export function campaignAttribution(): Record<string, string> {
  return analyticsAllowed() ? { ...landingCampaign } : {};
}

// These are GTM integration events, not proof that a GA4/Ads tag is configured.
// Never pass names, email, phone, address, ZIP, notes, or quote values here.
// The oncePer value is hashed before it is used as a dedup key, so a raw
// value (a request id, or a booking-link token) is never stored and never
// enters the event payload. The dedup set itself is persisted in
// sessionStorage, so a reload (the Stripe return) does not re-fire an
// event the same tab already sent — one event per booking.
const EMITTED_STORAGE_KEY = "gh_funnel_emitted";

function hashOncePer(value: string): string {
  // cyrb53 — deterministic and synchronous; good enough for a dedup key.
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}

const emitted = new Set<string>();
if (typeof window !== "undefined") {
  try {
    const raw = window.sessionStorage.getItem(EMITTED_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) for (const key of parsed) if (typeof key === "string") emitted.add(key);
    }
  } catch { /* unreadable store — dedup restarts empty for this tab */ }
}

function persistEmitted(): void {
  try { window.sessionStorage.setItem(EMITTED_STORAGE_KEY, JSON.stringify([...emitted])); } catch { /* ignore */ }
}

export function trackFunnel(event: FunnelEvent, details: EventDetails = {}, oncePer?: string): boolean {
  if (!analyticsAllowed()) return false;
  const dedupeKey = oncePer ? `${event}:${hashOncePer(oncePer)}` : undefined;
  if (dedupeKey && emitted.has(dedupeKey)) return false;
  const target = window as MeasurementWindow;
  target.dataLayer ??= [];
  target.dataLayer.push({ event, ...landingCampaign, ...details });
  if (dedupeKey) { emitted.add(dedupeKey); persistEmitted(); }
  return true;
}
