// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { dbRpc } from "../../api/_db";
import handler from "../../api/_sms_handler";
import { linkMac, message, normalizePhone, validSignature, type Payload } from "../../api/_sms";

vi.mock("../../api/_db", () => ({ dbRpc: vi.fn() }));
const rpc = vi.mocked(dbRpc);
const origin = "https://sms.example.com";
const id = "bd084b6e-540f-4525-a271-cbaa43a8ceb6";
const phone = "+14045550123";
const sid = "SM" + "1".repeat(32);
const payload = { id, phone, audience: "client", kind: "paid", amount: 1234 } as Payload;
const credentials = { authorization: "Bearer cron-secret" };
function response() {
  return { code: 0, status(n: number) { this.code = n; return this; }, end: vi.fn(), setHeader: vi.fn() };
}
beforeEach(() => {
  for (const [key, value] of Object.entries({
    SMS_PUBLIC_ORIGIN: origin, SMS_MODE: "pilot", SMS_PILOT_PHONE: phone,
    SMS_CRON_SECRET: "cron-secret", TWILIO_ACCOUNT_SID: "ACdemo", TWILIO_AUTH_TOKEN: "auth", TWILIO_MESSAGING_SERVICE_SID: "MGdemo",
    TWILIO_SMS_NUMBER: "+18005550111", SMS_LINK_SECRET: "secret", BOOKING_LINK_SECRET: "key"
  })) vi.stubEnv(key, value);
  rpc.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("SMS dispatcher", () => {
  it.each(["off", "disabled"])("keeps the queue untouched in %s mode", async (mode) => {
    vi.stubEnv("SMS_MODE", mode);
    await handler({ method: "GET", headers: credentials, url: "/api/visit?sms=1" }, response());
    expect(rpc).not.toHaveBeenCalled();
  });
  it("protects the worker", async () => {
    const res = response();
    await handler({ method: "GET", headers: {}, url: "/api/visit?sms=1" }, res);
    expect(res.code).toBe(403); expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    [201, "accepted"], [429, "retry"], [400, "failed"], [503, "unknown"], [0, "unknown"],
  ] as const)("records the outcome for provider result %s", async (status, result) => {
    rpc.mockResolvedValueOnce({ id, phone }).mockResolvedValueOnce(payload).mockResolvedValueOnce(true).mockResolvedValueOnce({});
    const network = vi.fn().mockResolvedValueOnce(Response.json({ valid: true, country_code: "US", phone_number: phone }));
    if (status) network.mockResolvedValueOnce(Response.json({ sid }, { status }));
    else network.mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", network);
    const res = response();
    await handler({ method: "GET", headers: credentials, url: "/api/visit?sms=1" }, res);
    expect(res.code).toBe(200); expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls[1][1].body.get("Body")).toContain("$12.34");
    expect(rpc).toHaveBeenCalledWith("gh_sms_finish", expect.objectContaining({ job: id, result }));
  });
  it("rejects a Canadian NANP recipient after Lookup", async () => {
    rpc.mockResolvedValueOnce({ id, phone }).mockResolvedValueOnce(true).mockResolvedValueOnce({});
    const network = vi.fn().mockResolvedValue(Response.json({ valid: true, country_code: "CA", phone_number: phone }));
    vi.stubGlobal("fetch", network);
    await handler({ method: "GET", headers: credentials, url: "/api/visit?sms=1" }, response());
    expect(network).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("gh_sms_finish", expect.objectContaining({ result: "suppressed" }));
  });
  it("aborts if consent changes during Lookup", async () => {
    rpc.mockResolvedValueOnce({ id, phone }).mockResolvedValueOnce({}).mockResolvedValueOnce(true).mockResolvedValueOnce({});
    const network = vi.fn().mockResolvedValue(Response.json({ valid: true, country_code: "US", phone_number: phone }));
    vi.stubGlobal("fetch", network);
    await handler({ method: "GET", headers: credentials, url: "/api/visit?sms=1" }, response());
    expect(network).toHaveBeenCalledTimes(1);
  });
});
describe("SMS webhooks and links", () => {
  const path = "/api/visit?sms=1";
  const fields = { From: phone, To: "+18005550111", AccountSid: "ACdemo", Body: "STOP", MessageSid: sid };
  const signed = createHmac("sha1", "auth").update(origin + path + "AccountSidACdemoBodySTOPFrom" + phone + "MessageSid" + sid + "To" + fields.To).digest("base64");
  it("validates the exact URL and every form field", () => {
    expect(validSignature(origin + path, fields, "auth", signed)).toBe(true);
    expect(validSignature(origin + path + "?extra=1", fields, "auth", signed)).toBe(false);
    expect(validSignature(origin + path, { ...fields, Body: "HELP" }, "auth", signed)).toBe(false);
  });
  it("records a signed STOP and does not issue a duplicate reply", async () => {
    rpc.mockResolvedValue(true);
    const res = response();
    await handler({ url: path, method: "POST", headers: { "x-twilio-signature": signed, "content-type": "application/x-www-form-urlencoded" }, body: fields }, res);
    expect(res.code).toBe(200);
    expect(rpc).toHaveBeenCalledWith("gh_sms_keyword", expect.objectContaining({ command: "STOP", number: phone }));
    expect(res.end).toHaveBeenCalledWith("<Response/>");
  });
  it.each([["received", ""], ["confirmed", ""], ["complete", "#report"]])("opens the private destination for %s", async (kind, anchor) => {
    const email = "test@example.invalid";
    const until = String(Math.floor(Date.now() / 1000) + 300);
    rpc.mockResolvedValueOnce({ id, kind, email, booking: "booking-test", audience: "client" });
    const sig = linkMac(id, until, email, "secret");
    const res = response();
    await handler({ method: "GET", headers: {}, url: path + "&open=" + id + "&until=" + until + "&sig=" + sig }, res);
    expect(res.code).toBe(303);
    const location = new URL(res.setHeader.mock.calls.find(([key]) => key === "Location")![1], origin);
    expect(location.pathname).toBe("/visit");
    expect(location.searchParams.get("bt")).toMatch(/^v2\./);
    expect(location.hash).toBe(anchor);
  });
  it("rejects expired links before querying private records", async () => {
    const res = response(); await handler({ method: "GET", url: path + "&open=" + id + "&until=1000000000&sig=x", headers: {} }, res);
    expect(res.code).toBe(410); expect(rpc).not.toHaveBeenCalled();
  });
  it("binds links to the assignment generation", () => {
    expect(linkMac(id, "123", "assignment1", "key")).not.toBe(linkMac(id, "123", "assignment2", "key"));
  });
  it("normalizes US-format numbers and rejects extensions", () => {
    expect(normalizePhone("1 (404) 555-0123")).toBe(phone);
    expect(normalizePhone("+1 404 555 0123 ext 1")).toBeNull();
  });
  it("acknowledges a request with a private link while the visit date is pending", () => {
    const body = message({ ...payload, kind: "received" }, "https://example.com/visit");
    expect(body).toContain("date is pending confirmation");
    expect(body).toContain("https://example.com/visit");
  });
  it.each(["confirmed", "assigned", "reminder", "rescheduled", "complete", "payment_reminder", "issue", "paid", "cancelled", "cleaner_action", "report_returned"])("renders service template %s", kind => {
    expect(message({ ...payload, kind }, "https://example.com/")).toMatch(/^Gatehouse Home Cleaning:/);
  });
});
