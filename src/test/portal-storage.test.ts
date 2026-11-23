import { expect, it, vi } from "vitest";
import { resolveLinkToken } from "../lib/tokenStrip";

it("opens and preserves a visit link for reload when browser storage is blocked", () => {
  const original = window.location.href;
  const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  try {
    window.history.replaceState({}, "", "/visit?bt=sample#report");
    expect(resolveLinkToken("bt", "test")).toBe("sample");
    expect(window.location.search).toBe("?bt=sample");
    expect(window.location.hash).toBe("#report");
  } finally {
    storage.mockRestore();
    window.history.replaceState({}, "", original);
  }
});
