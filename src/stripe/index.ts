// The Stripe adapter. Prices are found by lookup key, so the same code runs against a sandbox and
// live mode; Stripe stays the record, and the app re-reads it (customerState, resolvePayment)
// wherever event order matters.
import { PaymentError } from '../errors.ts';
import type {
  CheckoutInput,
  CustomerState,
  Metadata,
  Payment,
  PaymentEvent,
  PaymentProvider,
  PaymentPurpose,
  PortalInput,
  PriceRef,
  Purchase,
  Refund,
  RefundInput,
  Subscription,
} from '../types.ts';
import { stripeClient, type StripeParams, type StripeRequest } from './client.ts';
import { invoiceLines, invoiceReason, invoiceSubscription, meta, str, toDispute, toPayment, toRefund, toSubscription, type Obj } from './map.ts';
import { verifyStripeSignature } from './webhook.ts';

export { stripeClient, stripeForm, type StripeParams, type StripeRequest } from './client.ts';
export { signStripePayload, verifyStripeSignature } from './webhook.ts';

/** The API version requests are pinned to unless `apiVersion` says otherwise. */
export const STRIPE_API_VERSION = '2026-02-25.clover';

export interface StripeOptions {
  /** A secret (sk_...) or restricted (rk_...) key. */
  secretKey: string | undefined;
  /** Webhook signing secrets (whsec_...); several while rotating. */
  webhookSecret?: string | string[] | undefined;
  apiVersion?: string;
  /** Seconds a webhook signature stays valid. */
  webhookTolerance?: number;
  /** Whether this is live money; read from the key's prefix when left out. */
  livemode?: boolean;
  /** Another API base URL, such as a local stand-in for tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Stripe Connect: act on this connected account. */
  account?: string;
  /** Clock for webhook checks, for tests. */
  now?: () => number;
}

export interface StripeProvider extends PaymentProvider {
  readonly name: 'stripe';
  /** The raw API, for anything the neutral interface doesn't cover. */
  readonly request: StripeRequest;
  /** The active price with this lookup key (cached per isolate). Throws 'no_price' when there is none. */
  priceId(lookupKey: string): Promise<string>;
}

/** Pages a list follows at most (5,000 objects); past that it throws rather than return part of the list. */
const MAX_PAGES = 50;
const PAGE = 100;

/**
 * Price ids by lookup key, both ways. A key moves to a new price when the price changes in Stripe,
 * so an entry lasts PRICE_TTL, and a checkout that Stripe refuses drops the entries it used.
 */
const PRICE_TTL = 10 * 60_000;
const priceIds = new Map<string, { id: string; at: number }>();
const lookupKeys = new Map<string, string>();

/** Charge ids, as opposed to PaymentIntent ids. */
const isChargeId = (id: string) => id.startsWith('ch_') || id.startsWith('py_');

/** `p`, or null when Stripe has no such object. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof PaymentError && err.code === 'not_found') return null;
    throw err;
  }
}

export function createStripeProvider(opts: StripeOptions): StripeProvider {
  const key = opts.secretKey;
  const livemode = opts.livemode ?? /^[rs]k_live_/.test(key ?? '');
  const secrets = (Array.isArray(opts.webhookSecret) ? opts.webhookSecret : [opts.webhookSecret]).filter((s): s is string => !!s);
  const now = opts.now ?? Date.now;
  // One Stripe account per key (and connected account), so cached prices never cross accounts.
  const cache = `${key ?? ''}|${opts.account ?? ''}|`;

  const request: StripeRequest = key
    ? stripeClient({ secretKey: key, apiVersion: opts.apiVersion ?? STRIPE_API_VERSION, baseUrl: opts.baseUrl, fetch: opts.fetch, account: opts.account })
    : () => Promise.reject(new PaymentError('not_configured', 'Stripe has no secret key on this server.'));

  async function list<T>(path: string, params: StripeParams): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await request<{ data: (T & { id: string })[]; has_more: boolean }>('GET', path, { ...params, limit: PAGE, starting_after: after });
      out.push(...page.data);
      if (!page.has_more || !page.data.length) return out;
      after = page.data[page.data.length - 1]!.id;
    }
    throw new PaymentError('invalid', `Stripe ${path} lists more than ${MAX_PAGES * PAGE} objects.`);
  }

  async function priceId(lookupKey: string): Promise<string> {
    const known = priceIds.get(cache + lookupKey);
    if (known && now() - known.at < PRICE_TTL) return known.id;
    const { data } = await request<{ data: { id: string }[] }>('GET', '/v1/prices', { lookup_keys: [lookupKey], active: true, limit: 1 });
    const id = data[0]?.id;
    if (!id) throw new PaymentError('no_price', `No active Stripe price has the lookup key ${lookupKey}.`);
    priceIds.set(cache + lookupKey, { id, at: now() });
    lookupKeys.set(cache + id, lookupKey);
    return id;
  }
  const keyOf = (price: string) => lookupKeys.get(cache + price) ?? null;
  const resolvePrice = (p: PriceRef) => ('id' in p ? Promise.resolve(p.id) : priceId(p.lookupKey));

  /**
   * What a charge paid for: a subscription invoice, a one-time Checkout, or a bare PaymentIntent.
   * Errors propagate, so a webhook fails and Stripe retries rather than misfile the payment.
   */
  async function purposeOf(charge: Obj): Promise<PaymentPurpose> {
    const pi = str(charge.payment_intent);
    // Older API versions name the invoice on the charge; newer ones list it under invoice payments.
    const invoice: Obj | null =
      typeof charge.invoice === 'string'
        ? await request<Obj>('GET', `/v1/invoices/${encodeURIComponent(charge.invoice)}`)
        : pi
          ? ((await request<{ data: { invoice: Obj | null }[] }>('GET', '/v1/invoice_payments', { payment: { type: 'payment_intent', payment_intent: pi }, expand: ['data.invoice'], limit: 1 })).data[0]?.invoice ?? null)
          : null;
    const sub = invoice && typeof invoice === 'object' ? invoiceSubscription(invoice) : null;
    if (invoice && sub) return { kind: 'subscription', subscription: sub, invoice: invoice.id, reason: invoiceReason(invoice), lines: invoiceLines(invoice, keyOf) };
    if (!pi) return { kind: 'unknown' };
    const session = (await request<{ data: Obj[] }>('GET', '/v1/checkout/sessions', { payment_intent: pi, limit: 1 })).data[0];
    return session ? { kind: 'one_time', checkoutSession: session.id, metadata: meta(session.metadata) } : { kind: 'one_time', checkoutSession: null, metadata: meta(charge.metadata) };
  }

  async function paymentOfCharge(charge: Obj): Promise<Payment> {
    return toPayment(charge, await purposeOf(charge));
  }

  async function chargeById(id: string): Promise<Obj | null> {
    if (isChargeId(id)) return orNull(request<Obj>('GET', `/v1/charges/${encodeURIComponent(id)}`));
    const pi = await orNull(request<Obj>('GET', `/v1/payment_intents/${encodeURIComponent(id)}`, { expand: ['latest_charge'] }));
    return pi?.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  }

  async function resolvePayment(id: string): Promise<Payment | null> {
    const charge = await chargeById(id);
    return charge ? paymentOfCharge(charge) : null;
  }

  async function getSubscription(id: string): Promise<Subscription | null> {
    const s = await orNull(request<Obj>('GET', `/v1/subscriptions/${encodeURIComponent(id)}`, { expand: ['latest_invoice'] }));
    return s && toSubscription(s);
  }

  async function toEvent(e: Obj): Promise<PaymentEvent> {
    const base = { id: e.id as string, provider: 'stripe', providerType: e.type as string, created: (e.created ?? 0) * 1000, livemode: !!e.livemode, raw: e };
    const o: Obj = e.data?.object ?? {};
    const customer = str(o.customer);
    // A sandbox event sent to a live endpoint (or the reverse) must not touch real accounts.
    if (typeof e.livemode === 'boolean' && e.livemode !== livemode) return { ...base, type: 'unhandled', customer };
    switch (e.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.async_payment_failed': {
        if (o.mode !== 'payment' && o.mode !== 'subscription') return { ...base, type: 'unhandled', customer };
        const common = {
          customer,
          checkoutSession: o.id as string,
          mode: o.mode === 'payment' ? ('one_time' as const) : ('subscription' as const),
          subscription: str(o.subscription),
          payment: str(o.payment_intent),
          clientReference: o.client_reference_id ?? null,
          metadata: meta(o.metadata),
        };
        if (e.type === 'checkout.session.completed') {
          const paid = o.payment_status === 'paid' || o.payment_status === 'no_payment_required';
          return { ...base, ...common, type: 'checkout.completed', paid, amount: typeof o.amount_total === 'number' ? { amount: o.amount_total, currency: o.currency ?? '' } : null };
        }
        return { ...base, ...common, type: e.type === 'checkout.session.async_payment_succeeded' ? 'checkout.paid' : 'checkout.failed' };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        const type = e.type === 'customer.subscription.created' ? 'subscription.created' : e.type === 'customer.subscription.deleted' ? 'subscription.deleted' : 'subscription.updated';
        return { ...base, type, customer: customer ?? '', subscription: toSubscription(o) };
      }
      case 'invoice.paid':
      case 'invoice.payment_failed':
        return {
          ...base,
          type: e.type,
          customer: customer ?? '',
          subscription: invoiceSubscription(o),
          invoice: o.id,
          reason: invoiceReason(o),
          amount: { amount: e.type === 'invoice.paid' ? (o.amount_paid ?? 0) : (o.amount_due ?? 0), currency: o.currency ?? '' },
          lines: invoiceLines(o, keyOf),
        };
      case 'charge.refunded':
        return { ...base, type: 'payment.refunded', customer, payment: await paymentOfCharge(o), refunded: o.amount_refunded ?? 0 };
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.funds_reinstated':
      case 'charge.dispute.closed': {
        const dispute = toDispute(o);
        const payment = dispute.charge ? await resolvePayment(dispute.charge) : dispute.payment ? await resolvePayment(dispute.payment) : null;
        const type = e.type === 'charge.dispute.created' ? 'dispute.opened' : e.type === 'charge.dispute.closed' ? 'dispute.closed' : 'dispute.updated';
        return { ...base, type, customer: payment?.customer ?? null, dispute, payment };
      }
      case 'customer.updated':
      case 'customer.deleted':
        return { ...base, type: e.type, customer: o.id };
      default:
        return { ...base, type: 'unhandled', customer };
    }
  }

  return {
    name: 'stripe',
    livemode,
    request,
    priceId,

    async ensureCustomer({ userId, email, name, existing, metadata }) {
      if (existing) return existing;
      // Two checkouts at once get one customer. The key holds the email, since Stripe refuses a key
      // reused with other parameters; it lasts 24 hours, so the app stores the id it gets.
      const c = await request<{ id: string }>('POST', '/v1/customers', { email, name, metadata: { ...metadata, user_id: userId } }, { idempotencyKey: `customer:${userId}:${email}` });
      return c.id;
    },

    async deleteCustomer(customer) {
      await orNull(request('DELETE', `/v1/customers/${encodeURIComponent(customer)}`));
    },

    async checkout(input: CheckoutInput) {
      const line_items = await Promise.all(input.items.map(async (i) => ({ price: await resolvePrice(i.price), quantity: i.quantity ?? 1 })));
      const forget = () => input.items.forEach((i) => 'lookupKey' in i.price && priceIds.delete(cache + i.price.lookupKey));
      const metadata: Metadata | undefined = input.metadata;
      const params: StripeParams = {
        mode: input.mode === 'one_time' ? 'payment' : 'subscription',
        customer: input.customer,
        line_items,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.clientReference,
        metadata,
        allow_promotion_codes: input.allowPromotionCodes,
        automatic_tax: input.automaticTax ? { enabled: true } : undefined,
        // Automatic tax needs an address, which Checkout may save on the existing customer.
        customer_update: input.automaticTax ? { address: 'auto', name: 'auto' } : undefined,
        subscription_data: input.mode === 'subscription' ? { metadata, trial_period_days: input.trialDays } : undefined,
        payment_intent_data: input.mode === 'one_time' ? { metadata } : undefined,
      };
      const s = await request<{ id: string; url: string | null }>('POST', '/v1/checkout/sessions', params, { idempotencyKey: input.idempotencyKey }).catch((err) => {
        // Perhaps a cached price that was archived: the next try looks the keys up again.
        if (err instanceof PaymentError && err.code === 'invalid') forget();
        throw err;
      });
      if (!s.url) throw new PaymentError('unavailable', 'Stripe made a Checkout Session without a URL.');
      return { id: s.id, url: s.url };
    },

    async portal(input: PortalInput) {
      const flow = input.flow;
      const flow_data: StripeParams | undefined = !flow
        ? undefined
        : flow.type === 'cancel'
          ? { type: 'subscription_cancel', subscription_cancel: { subscription: flow.subscription } }
          : { type: 'subscription_update', subscription_update: { subscription: flow.subscription } };
      const s = await request<{ url: string }>('POST', '/v1/billing_portal/sessions', { customer: input.customer, return_url: input.returnUrl, configuration: input.configuration, flow_data });
      return { url: s.url };
    },

    async customerState(customer): Promise<CustomerState> {
      const [subs, sessions] = await Promise.all([
        list<Obj>('/v1/subscriptions', { customer, status: 'all', expand: ['data.latest_invoice'] }),
        list<Obj>('/v1/checkout/sessions', { customer, status: 'complete' }),
      ]);
      const purchases: Purchase[] = sessions
        .filter((s) => s.mode === 'payment' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required'))
        .map((s) => ({
          checkoutSession: s.id,
          payment: str(s.payment_intent),
          amount: { amount: s.amount_total ?? 0, currency: s.currency ?? '' },
          created: (s.created ?? 0) * 1000,
          metadata: meta(s.metadata),
          raw: s,
        }));
      return { subscriptions: subs.map(toSubscription).sort((a, b) => b.created - a.created), purchases: purchases.sort((a, b) => b.created - a.created) };
    },

    getSubscription,

    async cancelSubscription(id, { at = 'now' } = {}) {
      const s =
        at === 'now'
          ? await request<Obj>('DELETE', `/v1/subscriptions/${encodeURIComponent(id)}`, { expand: ['latest_invoice'] })
          : await request<Obj>('POST', `/v1/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: true, expand: ['latest_invoice'] });
      return toSubscription(s);
    },

    resolvePayment,

    async refund(input: RefundInput): Promise<Refund> {
      const target = isChargeId(input.payment) ? { charge: input.payment } : { payment_intent: input.payment };
      const r = await request<Obj>('POST', '/v1/refunds', { ...target, amount: input.amount, reason: input.reason, metadata: input.metadata }, { idempotencyKey: input.idempotencyKey });
      return toRefund(r);
    },

    async parseWebhook(req: Request, body?: string) {
      if (!secrets.length) throw new PaymentError('not_configured', 'Stripe has no webhook secret on this server.');
      const payload = body ?? (await req.text());
      if (!(await verifyStripeSignature(payload, req.headers.get('stripe-signature'), secrets, opts.webhookTolerance ?? 300, now()))) {
        throw new PaymentError('bad_signature', 'The webhook is not signed by Stripe, or its signature is too old.');
      }
      let event: Obj;
      try {
        event = JSON.parse(payload);
      } catch (cause) {
        throw new PaymentError('invalid', 'The webhook body is not JSON.', { cause });
      }
      return toEvent(event);
    },
  };
}
