// @vitest-environment node
import { describe, it, expect } from "vitest";
import { confirmAttemptKey } from "../../api/_payment_intent";

// RA13: confirm-attempt keys come from the journal, not from the card.
// Retrying an attempt whose outcome is UNKNOWN reuses its key (safe
// Stripe replay); a new attempt after an established outcome gets the
// next key. Keys are per payment intent: attempts logged against
// another intent never shift this intent's numbering — so a card
// change (A -> B -> C, same intent, one attempt per card) yields
// distinct keys, while a retry of the same card after an unknown
// outcome replays the same key.

const BID = "bid-ra13-1";
const VERSION = 2;

function evt(pi: string, attempt: number, outcome: string, key?: string) {
  return {
    event: "payment_confirm_attempt",
    detail: { pi, attempt, outcome, key: key ?? `charge_${BID}_v${VERSION}_confirm_${attempt}` },
  };
}

describe("RA13 confirm attempt keys", () => {
  it("first attempt on a fresh intent is _confirm_1", () => {
    const r = confirmAttemptKey(BID, VERSION, "pi_new", []);
    expect(r).toEqual({ key: `charge_${BID}_v${VERSION}_confirm_1`, attempt: 1, reuse: false });
  });

  it("a new attempt after a failed one gets the next key", () => {
    const r = confirmAttemptKey(BID, VERSION, "pi_1", [evt("pi_1", 1, "failed")]);
    expect(r).toEqual({ key: `charge_${BID}_v${VERSION}_confirm_2`, attempt: 2, reuse: false });
  });

  it("retry after an unknown outcome reuses the same key and attempt", () => {
    const events = [evt("pi_1", 1, "failed"), evt("pi_1", 2, "unknown")];
    const r = confirmAttemptKey(BID, VERSION, "pi_1", events);
    expect(r).toEqual({ key: `charge_${BID}_v${VERSION}_confirm_2`, attempt: 2, reuse: true });
  });

  it("attempts on another intent are ignored", () => {
    const events = [evt("pi_other", 1, "failed"), evt("pi_other", 2, "failed")];
    const r = confirmAttemptKey(BID, VERSION, "pi_1", events);
    expect(r).toEqual({ key: `charge_${BID}_v${VERSION}_confirm_1`, attempt: 1, reuse: false });
  });

  it("cards A -> B -> C on one intent: distinct keys per card, replay on unknown", () => {
    // Card A, attempt 1, outcome unknown (response lost).
    let r = confirmAttemptKey(BID, VERSION, "pi_1", []);
    expect(r.key).toBe(`charge_${BID}_v${VERSION}_confirm_1`);
    // Retry of card A after the unknown outcome: same key.
    r = confirmAttemptKey(BID, VERSION, "pi_1", [evt("pi_1", 1, "unknown")]);
    expect(r).toEqual({ key: `charge_${BID}_v${VERSION}_confirm_1`, attempt: 1, reuse: true });
    // Card A established as failed; card B gets the next key.
    r = confirmAttemptKey(BID, VERSION, "pi_1", [evt("pi_1", 1, "failed")]);
    expect(r.key).toBe(`charge_${BID}_v${VERSION}_confirm_2`);
    // Card B failed; card C gets the next key.
    r = confirmAttemptKey(BID, VERSION, "pi_1", [evt("pi_1", 1, "failed"), evt("pi_1", 2, "failed")]);
    expect(r.key).toBe(`charge_${BID}_v${VERSION}_confirm_3`);
  });
});
