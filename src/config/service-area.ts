// Shared by the quote form and Vercel endpoint. No pricing rules here.
export const SERVICE_ZIPS = new Set([
  "30024", "30518", "30519", "30097", "30096", "30099",
  "30004", "30005", "30009", "30022", "30075", "30076", "30077",
]);

export function earliestServiceDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const date = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + 3));
  return date.toISOString().slice(0, 10);
}

export function validServiceDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
