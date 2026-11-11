import "@testing-library/jest-dom";
import { afterEach } from "vitest";

afterEach(() => {
  if (typeof sessionStorage === "undefined") return;
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith("gh_quote_draft_v1")) sessionStorage.removeItem(key);
  }
});

if (typeof window !== "undefined") Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
