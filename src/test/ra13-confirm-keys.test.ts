// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { confirmAttemptKey } from "../../api/_payment_intent";

// RA13 rewritten (N06): confirm-attempt keys are bound to the payment
// method and the intent, NOT to a position in the journal and NOT to
// the report version. Production journals are newest-first, so "last
// element" used to mean the OLDEST attempt, and the newest-60 window
// could reset numbering and collide keys. Same card + same intent
// replays the same key forever (safe Stripe replay of an unknown
// outcome); a new card gets a different key (a real new attempt);
// the key never depends on how many events survive in the window,
// and republication cannot change it (no version in the key at all).

const BID = "bid-ra13-1";
const PI = "pi_1";
const CARD_A = "pm_card_a";
const CARD_B = "pm_card_b";
const CARD_C = "pm_card_c";

function methodKey(pm: string) {
  return `charge_${BID}_confirm_${PI}_${createHash("sha256").update(pm).digest("hex").slice(0, 12)}`;
}

function evt(
  pi: string,
  attempt: number,
  outcome: string,
  paymentMethod: string,
  createdAt = "2026-10-27T10:00:00.000Z",
) {
  return {
    event: "payment_confirm_attempt",
    detail: { pi, attempt, outcome, payment_method: paymentMethod },
    created_at: createdAt,
  };
}

describe("RA13 confirm attempt keys (production journal order)", () => {
  it("first attempt on a fresh intent is attempt 1, key bound to card A", () => {
    const r = confirmAttemptKey(BID, PI, CARD_A, []);
    expect(r).toEqual({ key: methodKey(CARD_A), attempt: 1, reuse: false });
  });

  it("cards A -> B -> C on one intent: distinct keys, rising attempt numbers", () => {
    // Card A failed as attempt 1.
    let r = confirmAttemptKey(BID, PI, CARD_B, [evt(PI, 1, "failed", CARD_A)]);
    expect(r.key).toBe(methodKey(CARD_B));
    expect(r.attempt).toBe(2);
    expect(r.reuse).toBe(false);
    // Card B failed as attempt 2; card C is attempt 3 with its own key.
    r = confirmAttemptKey(BID, PI, CARD_C, [
      evt(PI, 1, "failed", CARD_A),
      evt(PI, 2, "failed", CARD_B),
    ]);
    expect(r.key).toBe(methodKey(CARD_C));
    expect(r.attempt).toBe(3);
    expect(r.reuse).toBe(false);
  });

  it("retry after an unknown outcome reuses the same key and attempt for the same card", () => {
    const events = [
      evt(PI, 1, "failed", CARD_A, "2026-10-27T10:00:00.000Z"),
      evt(PI, 2, "unknown", CARD_B, "2026-10-27T10:05:00.000Z"),
    ];
    const r = confirmAttemptKey(BID, PI, CARD_B, events);
    expect(r).toEqual({ key: methodKey(CARD_B), attempt: 2, reuse: true });
  });

  it("unknown outcome on card A does not make card B reuse anything", () => {
    const events = [evt(PI, 1, "unknown", CARD_A)];
    const r = confirmAttemptKey(BID, PI, CARD_B, events);
    expect(r.key).toBe(methodKey(CARD_B));
    expect(r.attempt).toBe(2);
    expect(r.reuse).toBe(false);
  });

  it("newest-first journal gives the same answer as chronological order", () => {
    const chronological = [
      evt(PI, 1, "failed", CARD_A, "2026-10-27T10:00:00.000Z"),
      evt(PI, 2, "unknown", CARD_B, "2026-10-27T10:05:00.000Z"),
    ];
    const newestFirst = [...chronological].reverse();
    expect(confirmAttemptKey(BID, PI, CARD_B, newestFirst)).toEqual(
      confirmAttemptKey(BID, PI, CARD_B, chronological),
    );
    expect(confirmAttemptKey(BID, PI, CARD_B, newestFirst)).toEqual({
      key: methodKey(CARD_B),
      attempt: 2,
      reuse: true,
    });
  });

  it("identical timestamps: the higher attempt number wins, not array position", () => {
    const sameTs = "2026-10-27T10:00:00.000Z";
    const events = [
      evt(PI, 2, "unknown", CARD_B, sameTs),
      evt(PI, 1, "failed", CARD_A, sameTs),
    ];
    const r = confirmAttemptKey(BID, PI, CARD_B, events);
    expect(r).toEqual({ key: methodKey(CARD_B), attempt: 2, reuse: true });
  });

  it("more than 60 window events cannot reset numbering for this intent", () => {
    const fillers = Array.from({ length: 70 }, (_, i) =>
      evt("pi_other", i + 1, "failed", CARD_A, "2026-10-27T09:00:00.000Z"),
    );
    const events = [
      ...fillers,
      evt(PI, 5, "failed", CARD_A, "2026-10-27T10:00:00.000Z"),
    ];
    const r = confirmAttemptKey(BID, PI, CARD_B, events);
    expect(r.key).toBe(methodKey(CARD_B));
    expect(r.attempt).toBe(6);
    expect(r.reuse).toBe(false);
  });

  it("attempts on another intent are ignored", () => {
    const events = [
      evt("pi_other", 1, "failed", CARD_A),
      evt("pi_other", 2, "failed", CARD_B),
    ];
    const r = confirmAttemptKey(BID, PI, CARD_A, events);
    expect(r).toEqual({ key: methodKey(CARD_A), attempt: 1, reuse: false });
  });

  it("the key carries no report version: republication cannot change attempt identity", () => {
    // There is no version parameter at all; the same inputs always
    // produce the same key, whatever the report version is.
    expect(confirmAttemptKey(BID, PI, CARD_A, []).key).toBe(methodKey(CARD_A));
    expect(confirmAttemptKey(BID, PI, CARD_A, []).key).toBe(
      confirmAttemptKey(BID, PI, CARD_A, []).key,
    );
  });
});
