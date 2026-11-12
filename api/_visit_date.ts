// Shared payment-date gate (B): the visit's effective date — the
// confirmed date from the journal when set, else the scheduled visit
// date — compared with "today" in America/New_York as YYYY-MM-DD
// strings. A visit may be reported and paid on or after its date,
// never before. This is the same rule as isFutureVisitDate in
// api/cleaner.ts and api/report.ts, shared here so the money path
// (charge, timer, publish) enforces it too instead of each endpoint
// re-deriving it. An absent or malformed date never blocks (legacy
// rows without a date are not gated by this rule).

export function todayInNewYork(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(nowMs));
}

export function isFutureVisitDate(visitDate: string | null | undefined, nowMs = Date.now()): boolean {
  if (typeof visitDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) return false;
  return visitDate > todayInNewYork(nowMs);
}

type JournalLike = {
  event: string;
  detail: Record<string, unknown> | null;
};

// The confirmed date from the journal: the latest visit_confirmed
// event's `date` detail (the owner-confirmed, possibly rescheduled,
// date). Events are newest-first, so the first match is the latest
// confirmation. Empty when never confirmed.
export function confirmedDateOf(events: JournalLike[]): string {
  const ev = events.find((e) => e.event === "visit_confirmed");
  const d = ev?.detail?.["date"];
  return typeof d === "string" ? d : "";
}

// The effective visit date: the confirmed date when set, else the
// scheduled visit date. Either may be absent (legacy rows) — an
// absent date never blocks.
export function effectiveVisitDate(
  confirmedDate: string | null | undefined,
  visitDate: string | null | undefined,
): string {
  if (typeof confirmedDate === "string" && confirmedDate) return confirmedDate;
  if (typeof visitDate === "string" && visitDate) return visitDate;
  return "";
}
