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

// The start of a YYYY-MM-DD date in America/New_York as a UTC
// timestamp (midnight NY). A fixed -04:00/-05:00 offset is wrong
// across EST/EDT, so the wall-clock reading is converted via Intl —
// the same technique as the owner's visitWindowStartETMs (which uses
// the window hour instead of midnight). Returns NaN for a malformed
// date. Midnight always exists (DST shifts at 2 AM), so the result
// is defined for every valid calendar date.
export function visitDateStartNYMs(visitDate: string | null | undefined): number {
  if (typeof visitDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) return NaN;
  const [y, m, d] = visitDate.split("-").map(Number);
  // Date.UTC normalises out-of-range parts (month 13, day 40) into a
  // real date, so validate the calendar date explicitly first.
  if (m < 1 || m > 12 || d < 1) return NaN;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > daysInMonth) return NaN;
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  const wallAsUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  if (!Number.isFinite(wallAsUTC)) return NaN;
  return guess + (guess - wallAsUTC);
}

// The earliest moment the auto-charge timer can fire for a sent
// report: the later of (a) the start of the effective visit date in
// America/New_York (the charge gate opens at midnight NY on the visit
// date — a charge before the visit date is impossible, see
// selectDue/paymentBasis), and (b) 24h after the report was sent.
// This is the deadline the client and the owner must both see —
// showing only (b) tells the client they will be charged before the
// visit, which can never happen. An absent/malformed visit date
// never delays the timer (falls back to sent + 24h); an
// absent/unparseable sent time returns null.
export function autoChargeDeadlineMs(
  sentAt: string | null | undefined,
  effectiveVisitDateStr: string | null | undefined,
): number | null {
  const sentMs = Date.parse(sentAt ?? "");
  if (!Number.isFinite(sentMs)) return null;
  const sentDeadline = sentMs + 24 * 3600 * 1000;
  const visitStart = visitDateStartNYMs(effectiveVisitDateStr);
  if (!Number.isFinite(visitStart)) return sentDeadline;
  return Math.max(visitStart, sentDeadline);
}
