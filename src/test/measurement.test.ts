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
});
