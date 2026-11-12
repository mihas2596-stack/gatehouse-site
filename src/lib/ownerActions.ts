// Owner task rules — the single source of truth for "what's next".
// The Needs-attention queue, the list rows, and the detail card all
// derive from these functions, so a visit can never show "No action
// needed" in one place and "Confirm the date" in another.
//
// Server transition guards (api/booking-action.ts) reject approve,
// assign, and confirm for cancelled/paid visits with 409 — these
// functions are the display side of the same rule, never a replacement
// for the server check.

export type FocusBlock = "summary" | "cleaner" | "schedule" | "report" | "payment";

export type AttentionVisit = {
  status: string;
  visit_confirmed?: boolean;
  request_approved?: boolean;
  cleaner_name?: string | null;
  report_status?: string;
  payment_failed?: boolean;
  issue_open?: boolean;
  entry_agreed?: boolean;
  visit_date?: string | null;
  report_bounced?: boolean;
};

export type AttentionItem = { label: string; focus: FocusBlock };

const needsEntry = (v: AttentionVisit): boolean => {
  if (!v.visit_confirmed || v.status === "cancelled" || v.status === "paid" || v.entry_agreed || !v.visit_date) return false;
  if (v.report_status === "submitted" || v.report_status === "sent") return false;
  const days = (Date.parse(`${v.visit_date}T12:00:00Z`) - Date.now()) / (24 * 3600 * 1000);
  return days >= -1 && days <= 2;
};

// Compare calendar dates in the service area's timezone. A past request
// needs a review, not a misleading instruction to dispatch immediately.
export const isPastUnfinishedVisit = (v: AttentionVisit, now = new Date(Date.now())): boolean => {
  if (!v.visit_date || v.status === "paid" || v.status === "cancelled") return false;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return v.visit_date.slice(0, 10) < today;
};

// Plain-words visit status for badges and headers — the owner should
// never have to translate internal row statuses.
export const visitLabel = (s: string): string => {
  switch (s) {
    case "requested": return "Requested";
    case "confirmed": return "Confirmed";
    case "report_sent": return "Report sent";
    case "report_submitted": return "Report ready for review";
    case "approved": return "Approved";
    case "paid": return "Paid";
    // Fix round 2: a refunded visit is its own status — the payment
    // was returned, so it must not read as Paid (or as an upcoming
    // visit) anywhere in the panel.
    case "refunded": return "Refunded";
    case "cancelled": return "Cancelled";
    case "issue_open": return "Issue open";
    default: return s || "—";
  }
};

// C7: the visit badge must reflect the report, not just the row
// status — a "confirmed" row with a sent report is a visit whose
// report is already with the client. Terminal rows keep their own
// label: a paid visit is Paid, not "Report sent".
export const visitBadgeLabel = (status: string, reportStatus?: string): string => {
  if (reportStatus === "sent" && status !== "paid" && status !== "cancelled") return "Report sent";
  return visitLabel(status);
};

export const reportLabel = (s: string): string => {
  switch (s) {
    case "none": return "Waiting for cleaner’s report";
    case "draft": return "Cleaner is working on the report";
    case "returned": return "Report returned to cleaner";
    case "submitted": return "Report ready for review";
    case "sent": return "Report sent to the client";
    default: return s || "—";
  }
};

// Plain-words Stripe-side state (the /api/booking-action "status" action
// returns machine values like awaiting_card) for the detail card.
export const stripeLabel = (s: string): string => {
  switch (s) {
    case "requested": return "Requested";
    case "awaiting_card": return "Waiting for card";
    case "card_ready": return "Card ready";
    case "approved": return "Approved";
    case "report_sent": return "Report sent";
    case "issue_open": return "Issue open";
    case "payment_pending": return "Payment pending";
    case "paid": return "Paid";
    case "cancelled": return "Cancelled";
    default:
      if (!s) return "—";
      return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
};

// One action line for a list row and the detail card summary.
// Confirmation proof is the visit_confirmed event, never the row status:
// after a report is published the row moves to report_sent, and deriving
// "Confirm the date" from the status would contradict the client page.
export const nextActionFor = (v: AttentionVisit, paymentFailed: boolean): string => {
  if (v.status === "cancelled" || v.status === "paid") {
    // Terminal visits have no pipeline actions left — except an open
    // issue, which the card still offers to resolve.
    return v.issue_open ? "Resolve the customer issue" : "No action needed";
  }
  if (v.issue_open) return "Resolve the customer issue";
  if (isPastUnfinishedVisit(v) && (!v.report_status || ["none", "draft", "returned"].includes(v.report_status))) return "Review the past visit date";
  if (!v.visit_confirmed) {
    if (v.report_status === "sent" || v.report_status === "submitted") return "Review the visit record";
    if (v.status === "requested" && !v.request_approved) return "Approve request";
    if (!v.cleaner_name) return "Assign a cleaner";
    return "Confirm the date";
  }
  if (v.report_status === "submitted") return "Review the report";
  if (paymentFailed) return "Retry the payment";
  if (v.issue_open) return "Resolve the customer issue";
  // A bounced report never reached the client: "waiting for review"
  // would be a lie — the next step is a re-send, not patience.
  if (v.report_bounced) return "Resend the report";
  if (needsEntry(v)) return "Arrange entry with the client";
  if (v.report_status === "sent") return "Waiting for the customer’s review";
  if (v.report_status === "none" || v.report_status === "draft" || v.report_status === "returned") return "Waiting for the cleaner’s report";
  return "No action needed";
};

// Needs-attention items: one button per open task, each opening the
// visit at the block that needs it. Buttons only OPEN the visit — they
// do not perform the action, so labels must say so.
export const attentionItems = (v: AttentionVisit): AttentionItem[] => {
  // Cancelled visits never get pipeline actions: the server rejects
  // approve/assign/confirm for them with 409, and the card says
  // "No action needed". The only legitimate leftover is an open issue,
  // which the card still offers to resolve.
  if (v.status === "cancelled") {
    return v.issue_open ? [{ label: "Open to resolve the issue", focus: "report" }] : [];
  }
  const items: AttentionItem[] = [];
  if (v.issue_open) items.push({ label: "Open to resolve the issue", focus: "report" });
  if (isPastUnfinishedVisit(v) && (!v.report_status || ["none", "draft", "returned"].includes(v.report_status))) {
    items.push({ label: "Open to review the past visit date", focus: "schedule" });
    return items;
  }
  // A submitted (or sent) report without a confirmation event is an
  // inconsistent record: work happened without an agreed visit. It
  // needs an explicit review-and-repair confirmation, not a routine
  // date confirmation.
  const needsReview = !v.visit_confirmed && (v.report_status === "submitted" || v.report_status === "sent");
  if (v.status === "requested" && !v.request_approved) items.push({ label: "Open to approve request", focus: "summary" });
  if (!v.cleaner_name) items.push({ label: "Open to assign a cleaner", focus: "schedule" });
  else if (needsReview) items.push({ label: "Open: needs review", focus: "schedule" });
  else if (!v.visit_confirmed) items.push({ label: "Open to confirm the date", focus: "schedule" });
  if (v.report_status === "submitted") items.push({ label: "Open to review the report", focus: "report" });
  if (v.report_bounced) items.push({ label: "Open: report delivery failed", focus: "report" });
  if (v.payment_failed) items.push({ label: "Open: payment failed", focus: "payment" });
  // Entry signal: a confirmed visit within 2 days whose entry method is
  // not agreed yet — the owner sees it here, and the cron sends the
  // client one reminder (deduped by journal event).
  if (needsEntry(v)) items.push({ label: "Open: entry not agreed", focus: "summary" });
  return items;
};
