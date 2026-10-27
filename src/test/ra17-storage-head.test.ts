// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { storageObjectInfo } from "../../api/_db";

// RA17: the authenticated Storage HEAD must carry the service key in
// BOTH headers (apikey + Bearer) on the primary request — the old code
// sent a broken key and every HEAD 403'd. The signed-URL fallback must
// still run when the primary request fails or throws.

const SB_KEY = "sb_service_role_key_123";

type Call = { url: string; method: string; headers: Record<string, string> };

let calls: Call[];
let primaryMode: "ok" | "forbidden" | "throw";
let fallbackOk: boolean;

function headRes(headers: Record<string, string>, ok = true, status = 200) {
  return {
    ok, status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => ({}),
    text: async () => "",
  };
}

async function fetchMock(url: string, init?: { method?: string; headers?: Record<string, string> }) {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = (init?.headers ?? {}) as Record<string, string>;
  calls.push({ url: String(url), method, headers });
  if (String(url).includes("/object/sign/report-photos/") && method === "POST") {
    if (!fallbackOk) return headRes({}, false, 403);
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ signedURL: "/object/sign/report-photos/visits/x/a.jpg?token=signed123" }),
      text: async () => "",
    };
  }
  if (String(url).includes("token=signed123") && method === "HEAD") {
    return headRes({ "content-type": "image/jpeg", "content-length": "4242" });
  }
  if (String(url).includes("/object/report-photos/") && method === "HEAD") {
    if (primaryMode === "throw") throw new Error("network down");
    if (primaryMode === "forbidden") return headRes({}, false, 403);
    return headRes({ "content-type": "image/jpeg", "content-length": "1234" });
  }
  return headRes({}, false, 404);
}

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SB_KEY);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  calls = [];
  primaryMode = "ok";
  fallbackOk = true;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("RA17 storage HEAD", () => {
  it("primary HEAD carries the service key in both headers", async () => {
    const info = await storageObjectInfo("visits/x/a.jpg");
    expect(info).toEqual({ contentType: "image/jpeg", size: 1234 });
    const primary = calls.find((c) => c.url.includes("/object/report-photos/") && c.method === "HEAD");
    expect(primary).toBeTruthy();
    expect(primary!.headers["apikey"]).toBe(SB_KEY);
    expect(primary!.headers["Authorization"]).toBe(`Bearer ${SB_KEY}`);
    // No fallback needed on a healthy primary.
    expect(calls.some((c) => c.url.includes("/object/sign/"))).toBe(false);
  });

  it("primary 403 falls back to the signed URL probe", async () => {
    primaryMode = "forbidden";
    const info = await storageObjectInfo("visits/x/a.jpg");
    expect(info).toEqual({ contentType: "image/jpeg", size: 4242 });
    expect(calls.some((c) => c.url.includes("/object/sign/") && c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url.includes("token=signed123") && c.method === "HEAD")).toBe(true);
  });

  it("primary network throw falls back to the signed URL probe", async () => {
    primaryMode = "throw";
    const info = await storageObjectInfo("visits/x/a.jpg");
    expect(info).toEqual({ contentType: "image/jpeg", size: 4242 });
  });
});
