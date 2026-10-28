// Entry-method vocabulary, shared by /quote, /visit, /owner and /cleaner.
// The quote-time choice is a PREFERENCE, not a secret: it lives in the
// visit row (gh_visits.entry_method/detail/notes) and may be shown to the
// owner and the assigned cleaner. Codes and key locations are NEVER part
// of it — those go only through the encrypted gh_visit_access channel
// after confirmation.
export const ENTRY_METHODS = ["home", "other_person", "arrange_before", "decide_later"] as const;
export type EntryMethodChoice = (typeof ENTRY_METHODS)[number];

export const ENTRY_METHOD_LABEL: Record<EntryMethodChoice, string> = {
  home: "I’ll be home to let the cleaner in.",
  other_person: "Someone else will let the cleaner in.",
  arrange_before: "I’ll arrange entry before the visit.",
  decide_later: "I’ll decide later — please contact me.",
};

export const ENTRY_DETAILS = ["door_code", "lockbox", "other"] as const;
export type EntryDetailChoice = (typeof ENTRY_DETAILS)[number];

export const ENTRY_DETAIL_LABEL: Record<EntryDetailChoice, string> = {
  door_code: "Door code / smart lock",
  lockbox: "Lockbox",
  other: "Other arrangement",
};

// Quote method -> /visit secrets-form method (home/someone/arrange).
// decide_later has no secrets-form equivalent: nothing is pre-selected.
export function toVisitMethod(m: EntryMethodChoice | null | undefined): "home" | "someone" | "arrange" | null {
  if (m === "home") return "home";
  if (m === "other_person") return "someone";
  if (m === "arrange_before") return "arrange";
  return null;
}

// /visit secrets-form method -> quote method.
export function fromVisitMethod(m: string | null | undefined): EntryMethodChoice | null {
  if (m === "home") return "home";
  if (m === "someone") return "other_person";
  if (m === "arrange") return "arrange_before";
  return null;
}

// Meeting the cleaner needs no secret, so the choice alone settles access.
export function entryChoiceSettled(m: EntryMethodChoice | null | undefined): boolean {
  return m === "home" || m === "other_person";
}

// One-line summary for step 3, thank-you and owner surfaces.
export function entrySummaryLabel(
  method: EntryMethodChoice | null | undefined,
  detail: EntryDetailChoice | null | undefined,
): string {
  if (!method) return "To be arranged";
  if (method === "decide_later") return "To be arranged";
  if (method === "arrange_before" && detail) return `${ENTRY_METHOD_LABEL[method]} (${ENTRY_DETAIL_LABEL[detail]})`;
  return ENTRY_METHOD_LABEL[method];
}
