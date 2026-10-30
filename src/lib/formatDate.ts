// US-style date for client-facing summaries. Date-only strings
// (YYYY-MM-DD) are formatted without a timezone shift, so a visit on
// 2026-11-07 never renders as November 6.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const fmtDateUS = (d: string | null | undefined): string => {
  if (!d) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
};
