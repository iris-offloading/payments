import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripeForm } from '../src/stripe/client.ts';
import { signStripePayload, verifyStripeSignature } from '../src/stripe/webhook.ts';

test('stripeForm encodes nested objects and arrays the way Stripe reads them', () => {
  const form = stripeForm({
    mode: 'subscription',
    line_items: [{ price: 'price_1', quantity: 2 }],
    metadata: { user_id: 'u1' },
    expand: ['data.invoice'],
    skip: undefined,
    none: null,
    flag: true,
  });
  assert.equal(
    decodeURIComponent(form.toString()),
    'mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=2&metadata[user_id]=u1&expand[0]=data.invoice&flag=true',
  );
});

test('signatures verify, and fail when tampered, stale, or signed with another secret', async () => {
  const now = 1_800_000_000_000;
  const body = '{"id":"evt_1"}';
  const header = await signStripePayload(body, 'whsec_a', now);
  assert.equal(await verifyStripeSignature(body, header, ['whsec_a'], 300, now), true);
  assert.equal(await verifyStripeSignature(body, header, ['whsec_old', 'whsec_a'], 300, now), true, 'any secret during a rotation');
  assert.equal(await verifyStripeSignature(body + ' ', header, ['whsec_a'], 300, now), false);
  assert.equal(await verifyStripeSignature(body, header, ['whsec_b'], 300, now), false);
  assert.equal(await verifyStripeSignature(body, header, ['whsec_a'], 300, now + 301_000), false);
  assert.equal(await verifyStripeSignature(body, null, ['whsec_a'], 300, now), false);
  assert.equal(await verifyStripeSignature(body, 't=1,v1=zz', ['whsec_a'], 300, now), false);
});
