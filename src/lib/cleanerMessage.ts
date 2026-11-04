import { fmtDateUS } from "./formatDate";

export function cleanerJobMessage(visit: {
  visit_date: string | null; window: string | null; address: string | null;
}, url: string): string {
  const window = ({ morning: "7–11 AM ET", midday: "11 AM–2 PM ET", afternoon: "2–5 PM ET", flexible: "arrival window to be agreed with Nick" } as Record<string, string>)[visit.window ?? ""]
    ?? (visit.window ? `${visit.window} (Atlanta time)` : "arrival window to be confirmed");
  return `Hi! Your Gatehouse cleaning:\n${fmtDateUS(visit.visit_date)} · ${window}\nAddress: ${visit.address || "Check your job page"}\n\nOpen your job page before leaving — no app needed:\n${url}\n\nCheck the entry instructions. For each room: BEFORE photo, checklist, then AFTER photo. Do not photograph the client's no-photo rooms — add a reason instead.\n\nWhen all photos are uploaded and changes are saved, tap \"Finish & send report\".\n\nCan't get in or need help? Contact Nick before starting: hello@gatehousehomecleaning.com or (770) 525-8599.\n\nKeep this job link private.`;
}
