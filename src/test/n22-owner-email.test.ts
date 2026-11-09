// @vitest-environment node
// N22: the owner's notification mailbox lives in one place
// (api/_owner_email.ts) behind OWNER_NOTIFICATION_EMAIL, with the
// long-standing mailbox as the fallback when the variable is unset.
import { describe, it, expect, vi, afterEach } from "vitest";
import { ownerNotificationEmail } from "../../api/_owner_email";

afterEach(() => { vi.unstubAllEnvs(); });

describe("ownerNotificationEmail", () => {
  it("falls back to the owner's mailbox without the env var", () => {
    vi.stubEnv("OWNER_NOTIFICATION_EMAIL", "");
    expect(ownerNotificationEmail()).toBe("nikolajmihasenok@gmail.com");
  });

  it("uses OWNER_NOTIFICATION_EMAIL when set, trimmed", () => {
    vi.stubEnv("OWNER_NOTIFICATION_EMAIL", "  owner@example.com  ");
    expect(ownerNotificationEmail()).toBe("owner@example.com");
  });

  it("a whitespace-only value falls back instead of mailing nowhere", () => {
    vi.stubEnv("OWNER_NOTIFICATION_EMAIL", "   ");
    expect(ownerNotificationEmail()).toBe("nikolajmihasenok@gmail.com");
  });
});
