import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackFunnel } from '../lib/measurement';
const target = window as Window & { Termly?: { getConsentState: () => { analytics: boolean } }; dataLayer?: Record<string, unknown>[] };
afterEach(() => { delete target.Termly; delete target.dataLayer; vi.restoreAllMocks(); });
describe('consent-aware measurement', () => {
  it('does not queue events before the consent manager is ready', () => {
    trackFunnel('gh_lead_submit', { form_type: 'quote' });
    expect(target.dataLayer).toBeUndefined();
  });
  it('respects a refusal', () => {
    target.Termly = { getConsentState: () => ({ analytics: false }) };
    trackFunnel('gh_lead_submit', { form_type: 'quote' });
    expect(target.dataLayer).toBeUndefined();
  });
  it('provides a nonpersonal conversion event after consent', () => {
    target.Termly = { getConsentState: () => ({ analytics: true }) };
    trackFunnel('gh_lead_submit', { form_type: 'quote', service_type: 'deep', frequency: 'onetime' });
    expect(target.dataLayer).toEqual([{ event: 'gh_lead_submit', form_type: 'quote', service_type: 'deep', frequency: 'onetime' }]);
  });
  it('queues the review and card-saved stages without personal data', () => {
    target.Termly = { getConsentState: () => ({ analytics: true }) };
    trackFunnel('gh_quote_review', { form_type: 'quote' });
    trackFunnel('gh_card_saved', { form_type: 'quote' });
    expect(target.dataLayer).toEqual([
      { event: 'gh_quote_review', form_type: 'quote' },
      { event: 'gh_card_saved', form_type: 'quote' },
    ]);
  });
  it('queues each accepted request once and copies only valid campaign labels', async () => {
    const original = window.location.href;
    window.history.replaceState({}, '', '/?utm_source=meta&utm_campaign=qa_launch&utm_content=%3Ctest%3E&email=client%40example.com');
    vi.resetModules();
    try {
      const { trackFunnel: track } = await import('../lib/measurement');
      target.Termly = { getConsentState: () => ({ analytics: true }) };
      expect(track('gh_lead_submit', { form_type: 'quote' }, 'request-a')).toBe(true);
      expect(track('gh_lead_submit', { form_type: 'quote' }, 'request-a')).toBe(false);
      expect(track('gh_lead_submit', { form_type: 'quote' }, 'request-b')).toBe(true);
      expect(target.dataLayer).toEqual(Array.from({ length: 2 }, () => ({
        event: 'gh_lead_submit', form_type: 'quote', utm_source: 'meta', utm_campaign: 'qa_launch',
      })));
    } finally {
      window.history.replaceState({}, '', original);
    }
  });
});
