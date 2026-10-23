// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { storageSignUpload } from "../../api/_db";

describe("storageSignUpload (night fix 2026-10-22)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reads the url field of the upload-sign response", async () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ url: "/object/upload/sign/report-photos/visits/v1/kitchen/a.jpg?token=tok123" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const out = await storageSignUpload("visits/v1/kitchen/a.jpg");
    expect(out?.signedUrl).toBe(
      "https://example.supabase.co/storage/v1/object/upload/sign/report-photos/visits/v1/kitchen/a.jpg?token=tok123",
    );
  });

  it("degrades to null when the network fails instead of throwing", async () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(storageSignUpload("visits/v1/kitchen/a.jpg")).resolves.toBeNull();
  });
});
