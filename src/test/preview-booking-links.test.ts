// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clientVisitLink } from "../../api/_booking_links";
import { cleanerLinkUrl } from "../../api/_cleaner_link";
import { ownerPanelUrl } from "../../api/_owner_email";

const LIVE = "https://www.gatehousehomecleaning.com";
const DEPLOYMENT = "gatehouse-site-deployment-team.vercel.app";
const BRANCH = "gatehouse-site-git-qa-team.vercel.app";
const VISIT = "7cdbda4b-ccab-4ec7-b1b3-0e96a00e7f5b";

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_URL", DEPLOYMENT);
  vi.stubEnv("VERCEL_BRANCH_URL", BRANCH);
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  { environment: "production", branch: BRANCH, expected: LIVE },
  { environment: "preview", branch: BRANCH, expected: `https://${BRANCH}` },
  { environment: "preview", branch: "example.com", expected: `https://${DEPLOYMENT}` },
])("keeps client, cleaner and owner links on $expected", ({ environment, branch, expected }) => {
  vi.stubEnv("VERCEL_ENV", environment);
  vi.stubEnv("VERCEL_BRANCH_URL", branch);
  const client = new URL(clientVisitLink("fixture-secret", { bid: "fixture", email: "client@example.com" }, "#report"));
  expect(client.origin).toBe(expected);
  expect(client.pathname).toBe("/visit");
  expect(client.searchParams.get("bt")).toMatch(/^v2\./);
  expect(client.hash).toBe("#report");
  expect(cleanerLinkUrl("fixture")).toBe(`${expected}/cleaner?ct=fixture`);
  expect(ownerPanelUrl(VISIT)).toBe(`${expected}/owner?visit=${VISIT}`);
});

it("stops link generation when preview has no trusted deployment URL", () => {
  vi.stubEnv("VERCEL_URL", undefined);
  vi.stubEnv("VERCEL_BRANCH_URL", "example.com");
  expect(() => ownerPanelUrl(VISIT)).toThrow("preview_site_origin_unavailable");
});
