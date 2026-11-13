// @vitest-environment node
// G3: consent-voiding uses at-or-after (>=), not strict (>). A
// republication or a dispute sharing the approval's exact timestamp
// must void it — ties fail closed (the client re-approves the current
// report) instead of charging on stale consent.
import { describe, it, expect } from "vitest";
import { clientApprovedEvent, type BasisEvent } from "../../api/_payment_basis";

const T = "2026-11-13T10:00:00.000Z";
const ev = (event: string, created_at: string): BasisEvent => ({ event, detail: null, created_at });
const approval = (created_at: string): BasisEvent => ({ event: "report_approved", detail: { via: "client" }, created_at });

describe("G3: consent voiding at-or-after", () => {
  it("a republication at the approval's exact timestamp voids it", () => {
    expect(clientApprovedEvent([approval(T), ev("report_sent", T)])).toBeNull();
  });

  it("a dispute at the approval's exact timestamp voids it", () => {
    expect(clientApprovedEvent([approval(T), ev("issue_opened", T)])).toBeNull();
  });

  it("a republication after the approval voids it", () => {
    expect(clientApprovedEvent([approval(T), ev("report_sent", "2026-11-13T10:00:01.000Z")])).toBeNull();
  });

  it("a dispute after the approval voids it", () => {
    expect(clientApprovedEvent([approval(T), ev("issue_opened", "2026-11-13T10:00:01.000Z")])).toBeNull();
  });

  it("events strictly before the approval do not void it", () => {
    const got = clientApprovedEvent([ev("report_sent", "2026-11-13T09:59:59.000Z"), approval(T)]);
    expect(got?.event).toBe("report_approved");
  });

  it("an approval alone stays valid", () => {
    expect(clientApprovedEvent([approval(T)])?.event).toBe("report_approved");
  });
});
