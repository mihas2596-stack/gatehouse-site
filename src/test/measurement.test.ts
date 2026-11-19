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

  it('P1-1: UTM labels survive a reload with no UTMs in the URL (Stripe return)', async () => {
    const original = window.location.href;
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/?utm_source=meta&utm_medium=cpc&utm_campaign=launch');
    vi.resetModules();
    try {
      const first = await import('../lib/measurement');
      target.Termly = { getConsentState: () => ({ analytics: true }) };
      expect(first.trackFunnel('gh_lead_submit', { form_type: 'quote' })).toBe(true);
      expect(target.dataLayer).toEqual([{ event: 'gh_lead_submit', form_type: 'quote', utm_source: 'meta', utm_medium: 'cpc', utm_campaign: 'launch' }]);
      // The Stripe return URL carries no UTMs — a fresh load must read
      // the stored labels back instead of losing the attribution.
      delete target.dataLayer;
      window.history.replaceState({}, '', '/thank-you?session_id=cs_test_123');
      vi.resetModules();
      const second = await import('../lib/measurement');
      expect(second.trackFunnel('gh_card_saved', { form_type: 'quote' })).toBe(true);
      expect(target.dataLayer).toEqual([{ event: 'gh_card_saved', form_type: 'quote', utm_source: 'meta', utm_medium: 'cpc', utm_campaign: 'launch' }]);
    } finally {
      window.history.replaceState({}, '', original);
      window.sessionStorage.clear();
    }
  });

  it('P1-1: once-per-booking dedup survives a reload and never stores the raw token', async () => {
    const original = window.location.href;
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/save-card?bt=v2.secret-token-for-booking-1');
    vi.resetModules();
    try {
      const first = await import('../lib/measurement');
      target.Termly = { getConsentState: () => ({ analytics: true }) };
      expect(first.trackFunnel('gh_card_saved', { form_type: 'quote' }, 'v2.secret-token-for-booking-1')).toBe(true);
      expect(target.dataLayer).toHaveLength(1);
      // The raw token must appear nowhere in storage or the payload.
      expect(window.sessionStorage.getItem('gh_funnel_emitted')).not.toContain('v2.secret-token-for-booking-1');
      expect(JSON.stringify(target.dataLayer)).not.toContain('v2.secret-token-for-booking-1');
      // A reload (Stripe return) must not re-fire the same booking.
      delete target.dataLayer;
      vi.resetModules();
      const second = await import('../lib/measurement');
      expect(second.trackFunnel('gh_card_saved', { form_type: 'quote' }, 'v2.secret-token-for-booking-1')).toBe(false);
      expect(target.dataLayer).toBeUndefined();
      // A different booking still fires.
      expect(second.trackFunnel('gh_card_saved', { form_type: 'quote' }, 'v2.secret-token-for-booking-2')).toBe(true);
      expect(target.dataLayer).toHaveLength(1);
    } finally {
      window.history.replaceState({}, '', original);
      window.sessionStorage.clear();
    }
  });
});
