# payments

Provider-agnostic payments for our SaaS apps on Cloudflare Workers: subscriptions, one-time
purchases, refunds, disputes and webhooks. Stripe is the first provider.

The library talks to the payment provider and turns what it says into a small neutral model. It
does **not** decide what a payment buys: credits, plans and clawback rules stay in each app, which
reads clean facts ("payment `pi_1` paid for subscription `sub_1`'s renewal and is now refunded
1,200 of 2,400 cents") and applies its own rules.

- No dependencies. `fetch` and WebCrypto only, so it runs on Workers, Node 22+, Bun and Deno.
- Prices by lookup key, so the same code runs against a Stripe sandbox and live mode.
- Every normalized object keeps the provider's own under `raw`, and `stripe.request` reaches any
  Stripe endpoint, for the cases the neutral model doesn't cover.
- An in-memory `FakeProvider` for app tests, and `processOnce` for once-only webhook handling on D1.

## Install

Private, installed from GitHub at a tag. npm builds `dist/` on install (`prepare`).

```sh
npm install github:iris-offloading/payments#v0.1.0
```

## Entry points

| Import | What |
| --- | --- |
| `@iris-offloading/payments` | Types (`PaymentProvider`, `PaymentEvent`, `Subscription`, `Payment`, …) and `PaymentError` |
| `@iris-offloading/payments/stripe` | `createStripeProvider`, plus the raw client and signature helpers |
| `@iris-offloading/payments/testing` | `FakeProvider` for tests |
| `@iris-offloading/payments/d1` | `processOnce` and the `payment_events` table SQL |

## Use

```ts
import { createStripeProvider } from '@iris-offloading/payments/stripe';
import { processOnce } from '@iris-offloading/payments/d1';
import { isPaymentError, type PaymentProvider } from '@iris-offloading/payments';

const providerOf = (env: Env): PaymentProvider =>
  createStripeProvider({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });

// Start a subscription.
app.post('/billing/checkout', async (c) => {
  const pay = providerOf(c.env);
  const user = c.get('user');
  const customer = await pay.ensureCustomer({ userId: user.id, email: user.email, existing: user.stripe_customer });
  const { url } = await pay.checkout({
    customer,
    mode: 'subscription', // or 'one_time'
    items: [{ price: { lookupKey: 'myapp_pro_monthly' } }],
    successUrl: 'https://myapp.example/billing?done=1',
    cancelUrl: 'https://myapp.example/pricing',
    clientReference: user.id,
    metadata: { plan: 'pro' },
  });
  return c.json({ url });
});

// Webhooks.
app.post('/billing/webhook', async (c) => {
  const pay = providerOf(c.env);
  let event;
  try {
    event = await pay.parseWebhook(c.req.raw);
  } catch (err) {
    if (isPaymentError(err, 'bad_signature')) return c.text('Bad signature', 400);
    throw err;
  }
  const result = await processOnce(c.env.DB, event, async (e) => {
    switch (e.type) {
      case 'checkout.completed':
      case 'subscription.updated':
      case 'subscription.deleted':
      case 'invoice.paid':
        // Events can arrive late or out of order: re-read the provider and set the plan from it.
        if (e.customer) await syncPlan(c.env, await pay.customerState(e.customer));
        break;
      case 'payment.refunded':
        // e.payment.purpose says what it paid for; e.refunded is the total refunded so far.
        await takeBack(c.env, e.payment, e.refunded);
        break;
      case 'dispute.opened':
      case 'dispute.updated':
      case 'dispute.closed':
        // e.dispute.withdrawn: whether the money is out now; stage: inquiry, open, won, lost, closed.
        await onDispute(c.env, e.dispute, e.payment);
        break;
    }
  });
  // Another delivery of this event is still being applied: let Stripe retry later.
  if (result === 'busy') return c.text('Busy', 409);
  return c.json({ received: true });
});
```

`processOnce` claims each event before applying it and marks it done after. A claim whose Worker
died mid-apply lapses after five minutes, so Stripe's retry applies the event then. It needs this table in a migration (`PAYMENT_EVENTS_SQL` holds the same SQL):

```sql
CREATE TABLE IF NOT EXISTS payment_events (id TEXT PRIMARY KEY, provider TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, claimed_at INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0);
```

## The provider interface

| Method | Does |
| --- | --- |
| `ensureCustomer({ userId, email, existing? })` | `existing`, or a new customer (two calls at once get one; store the id) |
| `deleteCustomer(id)` | Deletes it, which ends its subscriptions |
| `checkout(input)` | Hosted checkout for a subscription or a one-time purchase |
| `portal({ customer, returnUrl, flow? })` | Hosted page to manage or cancel subscriptions |
| `customerState(customer)` | All subscriptions and paid one-time purchases, as the provider has them now |
| `getSubscription(id)`, `cancelSubscription(id, { at })` | Read one; cancel now or at period end |
| `resolvePayment(id)` | A payment and what it paid for (subscription invoice or one-time checkout) |
| `paymentPurpose(payment)` | What a payment paid for, when an event left it `unknown` |
| `refund({ payment, amount? })` | Full or partial refund |
| `parseWebhook(request)` | Verified, normalized `PaymentEvent` |

### Events

| Type | Stripe events | Carries |
| --- | --- | --- |
| `checkout.completed` | `checkout.session.completed` | mode, `paid`, subscription or payment, metadata, client reference |
| `checkout.paid`, `checkout.failed` | `checkout.session.async_payment_*` | a delayed method (bank debit) settled |
| `subscription.created`, `.updated`, `.deleted` | `customer.subscription.*` | the `Subscription` |
| `invoice.paid`, `invoice.payment_failed` | same | subscription, reason (`create`, `cycle`, `update`), lines |
| `payment.refunded` | `charge.refunded` | the `Payment` with its purpose, total refunded |
| `dispute.opened`, `.updated`, `.closed` | `charge.dispute.*` | the `Dispute` (stage, `withdrawn`) and the `Payment` |
| `customer.updated`, `customer.deleted` | same | customer id |
| `unhandled` | anything else, or an event from the other mode (sandbox vs live) | `providerType`, `raw` |

Errors are `PaymentError` with a `code`: `not_configured`, `bad_signature`, `not_found`, `invalid`,
`rate_limited`, `unavailable`, `no_price`, `too_many`.

## Stripe notes

- Requests are pinned to API version `2026-02-25.clover` (override with `apiVersion`). Readers accept
  both the old and new shapes of fields Stripe has moved (an invoice's subscription, a line's price,
  a charge's invoice).
- `livemode` comes from the key prefix. Events from the other mode come back `unhandled`, so a
  sandbox test can't credit a real account.
- Webhook endpoints should subscribe to: `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
  `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`,
  `charge.dispute.updated`, `charge.dispute.closed`.
- Prices are given by lookup key (`{ lookupKey }`), by id (`{ id }`), or defined in code for one
  checkout (`{ inline: { amount, currency, name, interval?, taxCode? } }`).
- Price ids are cached per Stripe account for five minutes, so a price changed in the dashboard is
  picked up soon after.
- Newer API versions put only the price id on invoice lines, so `line.lookupKey` is usually null;
  compare `line.price` with `await stripe.priceId(key)`.
- `parseWebhook` asks Stripe what a refunded or disputed payment paid for (1 to 3 calls). When it
  can't, it throws instead of guessing; answer 5xx and Stripe retries. An app that usually knows
  from its own records passes `resolvePayments: false` and calls `paymentPurpose` /
  `resolvePayment` only when it needs to.

## Adding a provider

Implement `PaymentProvider` in `src/<provider>/`, map its objects onto `src/types.ts`, and add an
export to `package.json`. Keep provider details out of the types; put them in `raw`.

## Develop

```sh
npm install
npm test          # node --test, no network
npm run typecheck
npm run build
```
