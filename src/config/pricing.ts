// ===========================================================
// Service keys and labels.
// All live pricing lives in src/config/calculator.ts —
// the single source of truth for numbers shown on the site.
// ===========================================================

export type ServiceKey = "standard" | "deep" | "moveinout" | "recurring";

// Human-readable labels matching the Contact form <select> options.
export const SERVICE_LABEL: Record<ServiceKey, string> = {
  standard: "Standard Cleaning",
  deep: "Deep Cleaning",
  moveinout: "Move-In / Move-Out",
  recurring: "Recurring Plan",
};

export const PRICE_NOTE = "See your price online before you book.";
export const RESPONSE_TIME = "within one business day";

/** Resolve a URL ?service= param (key or label) to a ServiceKey. */
export function resolveServiceParam(param: string | null | undefined): ServiceKey {
  if (!param) return "standard";
  const p = param.toLowerCase();
  if (p === "deep" || p.includes("deep")) return "deep";
  if (p === "moveinout" || p.includes("move")) return "moveinout";
  if (p === "recurring" || p.includes("recur")) return "recurring";
  return "standard";
}
