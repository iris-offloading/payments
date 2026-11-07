import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeProvider } from '../src/testing/index.ts';
import { DatabaseSync } from 'node:sqlite';

type SQLInputValue = null | number | bigint | string | Uint8Array;
import { PAYMENT_EVENTS_SQL, processOnce, type D1Like } from '../src/d1.ts';
import { PaymentError } from '../src/errors.ts';

const DAY = 86_400_000;

test('a subscription can be bought, renewed, refunded and disputed, and the app sees each event', async () => {
  let now = 1_000;
  const pay = new FakeProvider({ prices: { pro: 2400, pack: 500 }, now: () => now });
  const customer = await pay.ensureCustomer({ userId: 'u1', email: 'a@b.c' });
  assert.equal(await pay.ensureCustomer({ userId: 'u1', email: 'a@b.c' }), customer, 'one customer per user');

  const { id } = await pay.checkout({ customer, mode: 'subscription', items: [{ price: { lookupKey: 'pro' } }], successUrl: 'x', cancelUrl: 'y', metadata: { plan: 'pro' } });
  const bought = pay.completeCheckout(id);
  assert.deepEqual(bought.map((e) => e.type), ['subscription.created', 'invoice.paid', 'checkout.completed']);

  const [sub] = (await pay.customerState(customer)).subscriptions;
  assert.ok(sub && sub.live && sub.latestInvoicePaid);
  now += 30 * DAY;
  assert.deepEqual(pay.renew(sub.id).map((e) => e.type), ['invoice.paid', 'subscription.updated']);

  const renewal = [...pay.payments.values()].at(-1)!;
  assert.equal(renewal.purpose.kind === 'subscription' && renewal.purpose.reason, 'cycle');
  await pay.refund({ payment: renewal.id, amount: 1000 });
  await assert.rejects(pay.refund({ payment: renewal.id, amount: 2000 }), (e: unknown) => e instanceof PaymentError && e.code === 'invalid');

  const dispute = pay.openDispute(renewal.id);
  pay.closeDispute(dispute.id, 'won');
  const last = pay.events.at(-1)!;
  assert.ok(last.type === 'dispute.closed' && last.dispute.stage === 'won' && !last.dispute.withdrawn);

  // Round trip through the app's webhook route.
  const parsed = await pay.parseWebhook(pay.webhookRequest(last));
  assert.equal(parsed.id, last.id);
  await assert.rejects(pay.parseWebhook(new Request('https://x', { method: 'POST', body: '{}' })), (e: unknown) => e instanceof PaymentError && e.code === 'bad_signature');
});

test('a cancel at period end ends the subscription at renewal', async () => {
  const pay = new FakeProvider({ prices: { pro: 2400 } });
  const customer = await pay.ensureCustomer({ userId: 'u1', email: 'a@b.c' });
  const { id } = await pay.checkout({ customer, mode: 'subscription', items: [{ price: { lookupKey: 'pro' } }], successUrl: 'x', cancelUrl: 'y' });
  pay.completeCheckout(id);
  const sub = (await pay.customerState(customer)).subscriptions[0]!;
  await pay.cancelSubscription(sub.id, { at: 'period_end' });
  assert.deepEqual(pay.renew(sub.id).map((e) => e.type), ['subscription.deleted']);
  assert.equal((await pay.getSubscription(sub.id))?.status, 'canceled');
});

test('one-time purchases show in customerState', async () => {
  const pay = new FakeProvider({ prices: { pack: 500 } });
  const customer = await pay.ensureCustomer({ userId: 'u1', email: 'a@b.c' });
  const { id } = await pay.checkout({ customer, mode: 'one_time', items: [{ price: { lookupKey: 'pack' }, quantity: 2 }], successUrl: 'x', cancelUrl: 'y', metadata: { pack: '100' } });
  const [done] = pay.completeCheckout(id);
  assert.ok(done?.type === 'checkout.completed' && done.paid && done.amount?.amount === 1000);
  const { purchases } = await pay.customerState(customer);
  assert.deepEqual(purchases.map((p) => [p.checkoutSession, p.amount.amount, p.metadata.pack]), [[id, 1000, '100']]);
});

/** D1's API over node:sqlite, enough for processOnce. */
function sqliteDb(): D1Like & { sql: DatabaseSync } {
  const sql = new DatabaseSync(':memory:');
  sql.exec(PAYMENT_EVENTS_SQL);
  return {
    sql,
    prepare: (query: string) => ({
      bind: (...v: unknown[]) => ({
        run: async () => ({ meta: { changes: Number(sql.prepare(query).run(...(v as SQLInputValue[])).changes) } }),
        first: async <T>() => (sql.prepare(query).get(...(v as SQLInputValue[])) as T | undefined) ?? null,
      }),
    }),
  };
}

test('processOnce applies an event once, and forgets it when applying fails', async () => {
  const db = sqliteDb();
  const event = { id: 'evt_1', provider: 'stripe', type: 'invoice.paid' };
  let applied = 0;
  assert.equal(await processOnce(db, event, async () => void applied++), 'applied');
  assert.equal(await processOnce(db, event, async () => void applied++), 'duplicate');
  assert.equal(applied, 1);

  const failing = { ...event, id: 'evt_2' };
  await assert.rejects(processOnce(db, failing, async () => { throw new Error('db down'); }), /db down/);
  assert.equal(await processOnce(db, failing, async () => {}), 'applied', 'the retry applies it');
});

test('processOnce holds an unfinished claim for its lease, then lets a retry take over', async () => {
  const db = sqliteDb();
  const event = { id: 'evt_1', provider: 'stripe', type: 'invoice.paid' };
  // A Worker that died mid-apply: claimed, never done.
  db.sql.prepare("INSERT INTO payment_events (id, provider, type, created_at) VALUES ('stripe:evt_1', 'stripe', 'invoice.paid', 1000)").run();
  assert.equal(await processOnce(db, event, async () => {}, { now: () => 1000 + 60_000 }), 'busy');
  assert.equal(await processOnce(db, event, async () => {}, { now: () => 1000 + 5 * 60_000 }), 'applied');
  assert.equal(await processOnce(db, event, async () => {}, { now: () => 1000 + 60 * 60_000 }), 'duplicate');
});

test('the fake takes price ids as well as lookup keys, and a trial starts free', async () => {
  const pay = new FakeProvider({ prices: { pro: 2400 } });
  const customer = await pay.ensureCustomer({ userId: 'u1', email: 'a@b.c' });
  const { id } = await pay.checkout({ customer, mode: 'subscription', items: [{ price: { id: FakeProvider.priceId('pro') } }], successUrl: 'x', cancelUrl: 'y', trialDays: 7 });
  const events = pay.completeCheckout(id);
  const paid = events.find((e) => e.type === 'invoice.paid');
  assert.ok(paid?.type === 'invoice.paid' && paid.amount.amount === 0);
  assert.equal((await pay.customerState(customer)).subscriptions[0]?.status, 'trialing');
});
