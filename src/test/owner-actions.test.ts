// @vitest-environment node
// Regression tests for the owner "Needs attention" / row / card
// consistency bug (audit 30.10): cancelled visits appeared in Needs
// attention with "Open to assign a cleaner" / "Open to confirm the
// date" while their rows and cards said "No action needed" —
// even though the server rejects those actions for cancelled visits
// with 409. Queue, row, and card must agree, so these tests pin the
// shared rule in src/lib/ownerActions.ts.
import { describe, it, expect, vi } from "vitest";
import { attentionItems, nextActionFor, stripeLabel, visitBadgeLabel } from "@/lib/ownerActions";

const base = {
  status: "requested",
  visit_confirmed: false,
  request_approved: false,
  cleaner_name: null,
  report_status: "none",
  payment_failed: false,
  issue_open: false,
  entry_agreed: false,
  visit_date: null,
};

describe("cancelled visits never get pipeline actions", () => {
  it("cancelled + no cleaner → no attention items, no action", () => {
    const v = { ...base, status: "cancelled" };
    expect(attentionItems(v)).toEqual([]);
    expect(nextActionFor(v, false)).toBe("No action needed");
  });

  it("cancelled + cleaner + unconfirmed → no attention items, no action", () => {
    const v = { ...base, status: "cancelled", cleaner_name: "Taylor Allen" };
    expect(attentionItems(v)).toEqual([]);
    expect(nextActionFor(v, false)).toBe("No action needed");
  });

  it("cancelled + unapproved request → no approve item", () => {
    const v = { ...base, status: "cancelled", request_approved: false };
    expect(attentionItems(v)).toEqual([]);
  });

  it("cancelled + submitted report → no review item", () => {
    const v = { ...base, status: "cancelled", cleaner_name: "Taylor Allen", report_status: "submitted" };
    expect(attentionItems(v)).toEqual([]);
    expect(nextActionFor(v, false)).toBe("No action needed");
  });

  it("cancelled + open issue → only the resolve item, everywhere", () => {
    const v = { ...base, status: "cancelled", cleaner_name: "Taylor Allen", visit_confirmed: true, issue_open: true };
    expect(attentionItems(v)).toEqual([{ label: "Open to resolve the issue", focus: "report" }]);
    expect(nextActionFor(v, false)).toBe("Resolve the customer issue");
  });
});

describe("live visits keep their pipeline actions", () => {
  it("requested + unapproved → approve item and row action", () => {
    const v = { ...base, status: "requested" };
    expect(attentionItems(v).map((i) => i.label)).toContain("Open to approve request");
    expect(nextActionFor(v, false)).toBe("Approve request");
  });

  it("approved + no cleaner → assign item and row action", () => {
    const v = { ...base, status: "requested", request_approved: true };
    expect(attentionItems(v).map((i) => i.label)).toContain("Open to assign a cleaner");
    expect(nextActionFor(v, false)).toBe("Assign a cleaner");
  });

  it("cleaner + unconfirmed → confirm item and row action", () => {
    const v = { ...base, status: "confirmed", cleaner_name: "Taylor Allen" };
    expect(attentionItems(v).map((i) => i.label)).toContain("Open to confirm the date");
    expect(nextActionFor(v, false)).toBe("Confirm the date");
  });

  it("confirmed + submitted report → review item and row action", () => {
    const v = { ...base, status: "report_sent", visit_confirmed: true, cleaner_name: "Taylor Allen", report_status: "submitted" };
    expect(attentionItems(v).map((i) => i.label)).toContain("Open to review the report");
    expect(nextActionFor(v, false)).toBe("Review the report");
  });

  it("confirmed + open issue → resolve item and row action", () => {
    const v = { ...base, status: "report_sent", visit_confirmed: true, cleaner_name: "Taylor Allen", report_status: "sent", issue_open: true };
    expect(attentionItems(v).map((i) => i.label)).toContain("Open to resolve the issue");
    expect(nextActionFor(v, false)).toBe("Resolve the customer issue");
  });

  it("paid → no action unless an issue is open", () => {
    const v = { ...base, status: "paid", visit_confirmed: true, cleaner_name: "Taylor Allen", report_status: "sent" };
    expect(attentionItems(v)).toEqual([]);
    expect(nextActionFor(v, false)).toBe("No action needed");
    expect(nextActionFor({ ...v, issue_open: true }, false)).toBe("Resolve the customer issue");
  });
});

describe("bounced report is a re-send task, not 'waiting for review'", () => {
  it("sent + bounced → Resend the report + delivery-failed item", () => {
    const v = { ...base, status: "report_sent", visit_confirmed: true, cleaner_name: "Taylor Allen", report_status: "sent", report_bounced: true };
    expect(nextActionFor(v, false)).toBe("Resend the report");
    expect(attentionItems(v)).toEqual([{ label: "Open: report delivery failed", focus: "report" }]);
  });

  it("sent + delivered → still waiting for review", () => {
    const v = { ...base, status: "report_sent", visit_confirmed: true, cleaner_name: "Taylor Allen", report_status: "sent" };
    expect(nextActionFor(v, false)).toBe("Waiting for the customer’s review");
    expect(attentionItems(v)).toEqual([]);
  });
});

describe("no raw machine values leak into owner UI", () => {
  it("shows the same urgent entry task in the row and attention queue", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-03T12:00:00Z"));
    const visit = { ...base, status: "confirmed", visit_confirmed: true, request_approved: true, cleaner_name: "Test Cleaner", visit_date: "2026-11-04" };
    expect(nextActionFor(visit, false)).toBe("Arrange entry with the client");
    expect(attentionItems(visit)).toEqual([{ label: "Open: entry not agreed", focus: "summary" }]);
    const finished = { ...visit, report_status: "sent", status: "report_sent" };
    expect(nextActionFor(finished, false)).toBe("Waiting for the customer’s review");
    expect(attentionItems(finished)).toEqual([]);
    vi.restoreAllMocks();
  });
  it("maps Stripe-side states to plain words", () => {
    expect(stripeLabel("awaiting_card")).toBe("Waiting for card");
    expect(stripeLabel("card_ready")).toBe("Card ready");
    expect(stripeLabel("payment_pending")).toBe("Payment pending");
    expect(stripeLabel("report_sent")).toBe("Report sent");
    expect(stripeLabel("")).toBe("—");
  });
});

// C7: a "confirmed" row with a sent report must badge as "Report
// sent" — the visit is past confirmation and waiting on the client.
// Terminal rows keep their own label.
describe("visitBadgeLabel follows the report, not just the row status", () => {
  it("shows Report sent for a confirmed row with a sent report", () => {
    expect(visitBadgeLabel("confirmed", "sent")).toBe("Report sent");
  });
  it("keeps the row label when no report is sent", () => {
    expect(visitBadgeLabel("confirmed", "none")).toBe("Confirmed");
    expect(visitBadgeLabel("requested", "none")).toBe("Requested");
    expect(visitBadgeLabel("report_sent", "sent")).toBe("Report sent");
  });
  it("keeps Paid and Cancelled even with a sent report", () => {
    expect(visitBadgeLabel("paid", "sent")).toBe("Paid");
    expect(visitBadgeLabel("cancelled", "sent")).toBe("Cancelled");
  });
});

// Stale requests must never suggest immediate dispatch into a past date.
it("routes an unfinished past visit to review before assignment", () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-06T12:00:00Z"));
  expect(nextActionFor({ status: "requested", report_status: "none", visit_date: "2026-11-01" }, false)).toBe("Review the past visit date");
  expect(nextActionFor({ status: "requested", report_status: "none", visit_date: "2026-11-07" }, false)).toBe("Approve request");
});
