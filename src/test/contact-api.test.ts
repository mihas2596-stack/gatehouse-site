// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import handler from "../../api/send-contact-email";
import { earliestServiceDate, validServiceDate } from "../config/service-area";

const origin = "https://www.gatehousehomecleaning.com";
function response() {
  const res = { code: 0, body: {} as Record<string, unknown>, status(code: number) { this.code = code; return this; }, json(body: Record<string, unknown>) { this.body = body; }, setHeader: vi.fn(), end: vi.fn() };
  return res;
}
const contact = { name: '<b>Nick</b>', email: 'client@example.com', message: '<img src=x onerror=alert(1)>', source: 'contact' };
beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 'test-key');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'test-id' }) }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('contact delivery', () => {
  it('escapes HTML and replies to general questions without a fabricated estimate', async () => {
    const res = response();
    await handler({ method: 'POST', headers: { origin }, body: contact }, res);
    expect(res.code).toBe(200);
    const calls = vi.mocked(fetch).mock.calls;
    const owner = JSON.parse(String(calls[0][1]?.body));
    expect(owner.html).toContain('&lt;img');
    expect(owner.html).not.toContain('<img');
    const customer = JSON.parse(String(calls[1][1]?.body));
    expect(customer.text).toContain('general inquiry, not a booking request');
    expect(customer.text).not.toContain('Your estimate:');
  });
  it('rejects a forged booking outside the service area before sending email', async () => {
    const res = response();
    await handler({ method: 'POST', headers: { origin }, body: { ...contact, source: 'quote', phone: '4045550100', zip: '90210', address: '1 Example Street', date: '2099-12-01', terms_consent: true, photo_consent: true } }, res);
    expect(res.code).toBe(400);
    expect(res.body.errors).toHaveProperty('zip');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not report success when owner delivery fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as Response);
    const res = response();
    await handler({ method: 'POST', headers: { origin }, body: contact }, res);
    expect(res.code).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retains a successful request when only the customer acknowledgment fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response).mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as Response);
    const res = response();
    await handler({ method: 'POST', headers: { origin }, body: contact }, res);
    expect(res.code).toBe(200);
    expect(res.body.customerEmailSent).toBe(false);
  });
  it('rejects filled bot traps without sending mail', async () => {
    const res = response();
    await handler({ method: 'POST', headers: { origin }, body: { ...contact, website: 'spam' } }, res);
    expect(res.code).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses separate provider retry keys for owner and customer email', async () => {
    const res = response();
    const id = 'd51b7d65-1b4a-47b4-b5b1-f661dcc4ed8b';
    await handler({ method: 'POST', headers: { origin }, body: { ...contact, request_id: id } }, res);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][1]?.headers).toHaveProperty('Idempotency-Key', `owner/${id}`);
    expect(calls[1][1]?.headers).toHaveProperty('Idempotency-Key', `customer/${id}`);
  });
  it('rejects unrelated browser origins', async () => {
    const res = response();
    await handler({ method: 'POST', headers: { origin: 'https://unrelated.example' }, body: contact }, res);
    expect(res.code).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
describe('Atlanta service dates', () => {
  it('uses the Atlanta calendar day even when UTC is already tomorrow', () => {
    expect(earliestServiceDate(new Date('2026-10-05T01:00:00Z'))).toBe('2026-10-07');
  });
  it('rejects nonexistent dates and handles leap years', () => {
    expect(validServiceDate('2027-02-29')).toBe(false);
    expect(validServiceDate('2028-02-29')).toBe(true);
    expect(validServiceDate('2026-04-31')).toBe(false);
  });
});
