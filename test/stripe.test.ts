import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStripeProvider, signStripePayload } from '../src/stripe/index.ts';
import { PaymentError } from '../src/errors.ts';
import { fakeStripe, type Route } from './helpers.ts';

const NOW = 1_800_000_000_000;
const SECRET = 'whsec_test';

let n = 0;
/** A provider on a fresh fake Stripe; a unique key per test keeps the price cache apart. */
function setup(routes: Record<string, Route> = {}, extra: { secretKey?: string } = {}) {
  const api = fakeStripe(routes);
  const stripe = createStripeProvider({ secretKey: extra.secretKey ?? `sk_test_${++n}`, webhookSecret: SECRET, fetch: api.fetch, now: () => NOW, account: `acct_${n}` });
  return { api, stripe };
}

async function webhook(event: object, secret = SECRET) {
  const body = JSON.stringify(event);
  return new Request('https://app.test/webhook', { method: 'POST', headers: { 'stripe-signature': await signStripePayload(body, secret, NOW) }, body });
}

const ev = (type: string, object: object, livemode = false) => ({ id: `evt_${type}`, type, created: NOW / 1000, livemode, data: { object } });

test('checkout finds prices by lookup key once, and passes metadata to the subscription', async () => {
  const { api, stripe } = setup({
    'GET /v1/prices': (c) => ({ data: [{ id: `price_for_${c.params.get('lookup_keys[0]')}` }] }),
    'POST /v1/checkout/sessions': () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' }),
  });
  const input = {
    customer: 'cus_1',
    mode: 'subscription' as const,
    items: [{ price: { lookupKey: 'pro_monthly' } }],
    successUrl: 'https://app.test/ok',
    cancelUrl: 'https://app.test/no',
    clientReference: 'user_1',
    metadata: { plan: 'pro' },
    idempotencyKey: 'k1',
  };
  assert.deepEqual(await stripe.checkout(input), { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
  await stripe.checkout(input);
  assert.equal(api.calls.filter((c) => c.path === '/v1/prices').length, 1, 'price looked up once');
  const post = api.calls.find((c) => c.method === 'POST')!;
  assert.equal(post.params.get('mode'), 'subscription');
  assert.equal(post.params.get('line_items[0][price]'), 'price_for_pro_monthly');
  assert.equal(post.params.get('subscription_data[metadata][plan]'), 'pro');
  assert.equal(post.params.get('payment_intent_data[metadata][plan]'), null);
  assert.equal(post.params.get('client_reference_id'), 'user_1');
  assert.equal(post.headers.get('idempotency-key'), 'k1');
  assert.equal(post.headers.get('stripe-version'), '2026-02-25.clover');
});

test('a missing lookup key is a no_price error', async () => {
  const { stripe } = setup({ 'GET /v1/prices': () => ({ data: [] }) });
  await assert.rejects(stripe.priceId('nope'), (e: unknown) => e instanceof PaymentError && e.code === 'no_price');
});

test('without a key every call is not_configured', async () => {
  const stripe = createStripeProvider({ secretKey: undefined });
  await assert.rejects(stripe.getSubscription('sub_1'), (e: unknown) => e instanceof PaymentError && e.code === 'not_configured');
});

test('errors map to codes, and a missing subscription reads as null', async () => {
  const { stripe } = setup({
    'GET /v1/subscriptions/sub_busy': () => ({ status: 429, body: { error: { message: 'slow down' } } }),
    'GET /v1/subscriptions/sub_bad': () => ({ status: 500, body: { error: { message: 'oops' } } }),
  });
  assert.equal(await stripe.getSubscription('sub_gone'), null);
  await assert.rejects(stripe.getSubscription('sub_busy'), (e: unknown) => e instanceof PaymentError && e.code === 'rate_limited' && e.status === 429);
  await assert.rejects(stripe.getSubscription('sub_bad'), (e: unknown) => e instanceof PaymentError && e.code === 'unavailable');
});

test('customerState follows pages and keeps only paid one-time checkouts', async () => {
  const sub = (id: string, created: number) => ({
    id,
    customer: 'cus_1',
    status: 'active',
    created,
    cancel_at: null,
    cancel_at_period_end: true,
    items: { data: [{ current_period_start: 100, current_period_end: 200, quantity: 1, price: { id: 'price_p', lookup_key: 'pro' } }] },
    latest_invoice: { id: 'in_1', status: 'paid' },
    metadata: {},
  });
  const { api, stripe } = setup({
    'GET /v1/subscriptions': (c) =>
      c.params.get('starting_after') ? { data: [sub('sub_2', 20)], has_more: false } : { data: [sub('sub_1', 10)], has_more: true },
    'GET /v1/checkout/sessions': () => ({
      data: [
        { id: 'cs_paid', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 500, currency: 'usd', created: 5, metadata: { pack: '100' } },
        { id: 'cs_unpaid', mode: 'payment', payment_status: 'unpaid', created: 6 },
        { id: 'cs_sub', mode: 'subscription', payment_status: 'paid', created: 7 },
      ],
      has_more: false,
    }),
  });
  const state = await stripe.customerState('cus_1');
  assert.deepEqual(state.subscriptions.map((s) => s.id), ['sub_2', 'sub_1']);
  const s = state.subscriptions[0]!;
  assert.equal(s.live, true);
  assert.deepEqual(s.period, { start: 100_000, end: 200_000 });
  assert.equal(s.endsAt, 200_000, 'cancel at period end ends at the period end');
  assert.equal(s.latestInvoicePaid, true);
  assert.deepEqual(s.items, [{ price: 'price_p', lookupKey: 'pro', quantity: 1 }]);
  assert.deepEqual(state.purchases.map((p) => [p.checkoutSession, p.payment, p.amount.amount, p.metadata.pack]), [['cs_paid', 'pi_1', 500, '100']]);
  assert.equal(api.calls.find((c) => c.path === '/v1/subscriptions')!.params.get('status'), 'all');
});

test('refund targets a charge or a payment intent', async () => {
  const { api, stripe } = setup({
    'POST /v1/refunds': (c) => ({ id: 're_1', payment_intent: c.params.get('payment_intent') ?? 'pi_x', amount: Number(c.params.get('amount') ?? 900), currency: 'usd', status: 'succeeded' }),
  });
  const r = await stripe.refund({ payment: 'pi_1', amount: 300, idempotencyKey: 'r1' });
  assert.deepEqual([r.payment, r.amount.amount, r.status], ['pi_1', 300, 'succeeded']);
  await stripe.refund({ payment: 'ch_1' });
  assert.equal(api.calls[1]!.params.get('charge'), 'ch_1');
  assert.equal(api.calls[1]!.params.get('amount'), null, 'the whole rest when no amount');
});

test('cancel now deletes; cancel at period end sets the flag', async () => {
  const s = { id: 'sub_1', customer: 'cus_1', status: 'canceled', created: 1, items: { data: [] } };
  const { api, stripe } = setup({ 'DELETE /v1/subscriptions/sub_1': () => s, 'POST /v1/subscriptions/sub_1': () => ({ ...s, status: 'active', cancel_at_period_end: true }) });
  assert.equal((await stripe.cancelSubscription('sub_1')).live, false);
  assert.equal((await stripe.cancelSubscription('sub_1', { at: 'period_end' })).live, true);
  assert.equal(api.calls[1]!.params.get('cancel_at_period_end'), 'true');
});

test('webhooks with a bad signature are refused', async () => {
  const { stripe } = setup();
  await assert.rejects(stripe.parseWebhook(await webhook(ev('customer.updated', { id: 'cus_1' }), 'whsec_other')), (e: unknown) => e instanceof PaymentError && e.code === 'bad_signature');
});

test('checkout.session.completed is normalized', async () => {
  const { stripe } = setup();
  const e = await stripe.parseWebhook(
    await webhook(ev('checkout.session.completed', { id: 'cs_1', mode: 'payment', payment_status: 'unpaid', customer: 'cus_1', payment_intent: 'pi_1', amount_total: 1500, currency: 'usd', client_reference_id: 'u1', metadata: { pack: '500' } })),
  );
  assert.equal(e.type, 'checkout.completed');
  if (e.type !== 'checkout.completed') return;
  assert.deepEqual([e.mode, e.paid, e.payment, e.customer, e.clientReference, e.metadata.pack, e.amount?.amount], ['one_time', false, 'pi_1', 'cus_1', 'u1', '500', 1500]);
});

test('a sandbox event sent to a live endpoint is unhandled', async () => {
  const { stripe } = setup({}, { secretKey: 'sk_live_x' });
  const e = await stripe.parseWebhook(await webhook(ev('checkout.session.completed', { id: 'cs_1', mode: 'payment', payment_status: 'paid' }, false)));
  assert.equal(e.type, 'unhandled');
});

test('invoice.paid reads the new API shape', async () => {
  const { stripe } = setup();
  const e = await stripe.parseWebhook(
    await webhook(
      ev('invoice.paid', {
        id: 'in_1',
        customer: 'cus_1',
        billing_reason: 'subscription_cycle',
        amount_paid: 2400,
        currency: 'usd',
        parent: { subscription_details: { subscription: 'sub_1' } },
        lines: { data: [{ amount: 2400, period: { start: 10, end: 20 }, pricing: { price_details: { price: 'price_pro' } } }] },
      }),
    ),
  );
  assert.equal(e.type, 'invoice.paid');
  if (e.type !== 'invoice.paid') return;
  assert.deepEqual([e.subscription, e.reason, e.amount.amount], ['sub_1', 'cycle', 2400]);
  assert.deepEqual(e.lines, [{ price: 'price_pro', lookupKey: null, amount: 2400, period: { start: 10_000, end: 20_000 } }]);
});

test('a refund says which subscription invoice it paid for', async () => {
  const { stripe } = setup({
    'GET /v1/invoice_payments': () => ({
      data: [{ invoice: { id: 'in_1', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_1' } }, lines: { data: [] } } }],
    }),
    'GET /v1/checkout/sessions': () => ({ data: [{ id: 'cs_1', metadata: {} }] }),
  });
  const e = await stripe.parseWebhook(await webhook(ev('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', customer: 'cus_1', amount: 2400, amount_refunded: 1200, currency: 'usd' })));
  assert.equal(e.type, 'payment.refunded');
  if (e.type !== 'payment.refunded') return;
  assert.equal(e.refunded, 1200);
  assert.deepEqual([e.payment.id, e.payment.charge, e.payment.amount.amount], ['pi_1', 'ch_1', 2400]);
  assert.deepEqual(e.payment.purpose, { kind: 'subscription', subscription: 'sub_1', invoice: 'in_1', reason: 'create', lines: [] });
});

test('a dispute finds its one-time checkout through the charge, and reports its stage', async () => {
  const { stripe } = setup({
    'GET /v1/charges/ch_1': () => ({ id: 'ch_1', payment_intent: 'pi_1', customer: 'cus_1', amount: 1500, amount_refunded: 0, currency: 'usd' }),
    'GET /v1/invoice_payments': () => ({ data: [] }),
    'GET /v1/checkout/sessions': () => ({ data: [{ id: 'cs_9', metadata: { pack: '500' } }] }),
  });
  const dispute = { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 1500, currency: 'usd', reason: 'fraudulent', evidence_details: { due_by: 50 } };
  const opened = await stripe.parseWebhook(await webhook(ev('charge.dispute.created', { ...dispute, status: 'needs_response' })));
  assert.equal(opened.type, 'dispute.opened');
  if (opened.type !== 'dispute.opened') return;
  assert.deepEqual([opened.customer, opened.dispute.stage, opened.dispute.withdrawn, opened.dispute.respondBy], ['cus_1', 'open', true, 50_000]);
  assert.deepEqual(opened.payment?.purpose, { kind: 'one_time', checkoutSession: 'cs_9', metadata: { pack: '500' } });

  const inquiry = await stripe.parseWebhook(await webhook(ev('charge.dispute.created', { ...dispute, status: 'warning_needs_response' })));
  assert.ok(inquiry.type === 'dispute.opened' && inquiry.dispute.stage === 'inquiry' && !inquiry.dispute.withdrawn);
  const won = await stripe.parseWebhook(await webhook(ev('charge.dispute.closed', { ...dispute, status: 'won' })));
  assert.ok(won.type === 'dispute.closed' && won.dispute.stage === 'won' && !won.dispute.withdrawn);
});

test('subscription events carry the subscription, and unknown events are unhandled', async () => {
  const { stripe } = setup();
  const del = await stripe.parseWebhook(await webhook(ev('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1', status: 'canceled', created: 1, items: { data: [] } })));
  assert.ok(del.type === 'subscription.deleted' && del.subscription.id === 'sub_1' && !del.subscription.live);
  const other = await stripe.parseWebhook(await webhook(ev('payout.paid', { id: 'po_1' })));
  assert.equal(other.type, 'unhandled');
  assert.equal(other.providerType, 'payout.paid');
});

test('a subscription cancelled now says when it ended', async () => {
  const { stripe } = setup({ 'DELETE /v1/subscriptions/sub_1': () => ({ id: 'sub_1', customer: 'cus_1', status: 'canceled', created: 1, ended_at: 50, canceled_at: 50, cancel_at: null, cancel_at_period_end: false, items: { data: [] } }) });
  assert.equal((await stripe.cancelSubscription('sub_1')).endsAt, 50_000);
});

test('a refund event fails, rather than guess, when Stripe cannot say what the payment was for', async () => {
  const { stripe } = setup({ 'GET /v1/invoice_payments': () => ({ status: 503, body: { error: { message: 'down' } } }) });
  await assert.rejects(
    stripe.parseWebhook(await webhook(ev('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', amount: 2400, amount_refunded: 2400, currency: 'usd' }))),
    (e: unknown) => e instanceof PaymentError && e.code === 'unavailable',
  );
});

test('prices are cached per Stripe key, and dropped when a checkout is refused', async () => {
  let version = 1;
  const routes: Record<string, Route> = {
    'GET /v1/prices': () => ({ data: [{ id: `price_v${version}` }] }),
    'POST /v1/checkout/sessions': (c) => (c.params.get('line_items[0][price]') === `price_v${version}` ? { id: 'cs_1', url: 'u' } : { status: 400, body: { error: { message: 'price archived' } } }),
  };
  const api = fakeStripe(routes);
  const a = createStripeProvider({ secretKey: 'sk_test_cache_a', fetch: api.fetch });
  const b = createStripeProvider({ secretKey: 'sk_test_cache_b', fetch: api.fetch });
  const input = { customer: 'cus_1', mode: 'one_time' as const, items: [{ price: { lookupKey: 'pack' } }], successUrl: 's', cancelUrl: 'c' };
  await a.checkout(input);
  await b.checkout(input);
  assert.equal(api.calls.filter((c) => c.path === '/v1/prices').length, 2, 'one lookup per account');
  version = 2; // The price changed in Stripe and the key moved.
  await assert.rejects(a.checkout(input));
  assert.deepEqual(await a.checkout(input), { id: 'cs_1', url: 'u' });
});
