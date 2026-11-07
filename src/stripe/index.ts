// The Stripe adapter. Prices are found by lookup key, so the same code runs against a sandbox and
// live mode; Stripe stays the record, and the app re-reads it (customerState, resolvePayment)
// wherever event order matters.
import { isPaymentError, PaymentError } from '../errors.ts';
import { newestFirst } from '../model.ts';
import type { CheckoutInput, CustomerState, Payment, PaymentEvent, PaymentEventType, PaymentProvider, PaymentPurpose, PortalInput, Refund, RefundInput, Subscription } from '../types.ts';
import { stripeClient, type StripeParams, type StripeRequest } from './client.ts';
import { invoiceLines, invoiceReason, invoiceSubscription, isPaidSession, meta, money, ms, str, toDispute, toPayment, toPurchase, toRefund, toSubscription, type Obj } from './map.ts';
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
  /** Clock for webhook checks and the price cache, for tests. */
  now?: () => number;
  /**
   * Whether parseWebhook asks Stripe what a refunded or disputed payment paid for (1 to 3 calls).
   * When false, refund events carry purpose 'unknown' and dispute events no payment; call
   * paymentPurpose or resolvePayment where the app needs them. Default true.
   */
  resolvePayments?: boolean;
}

export interface StripeProvider extends PaymentProvider {
  readonly name: 'stripe';
  /** The raw API, for anything the neutral interface doesn't cover. */
  readonly request: StripeRequest;
  /** The active price with this lookup key (cached a few minutes). Throws 'no_price' when there is none. */
  priceId(lookupKey: string): Promise<string>;
}

/** Pages a list follows at most (5,000 objects); past that it throws rather than return part of the list. */
const MAX_PAGES = 50;
const PAGE = 100;

/**
 * Price ids by lookup key, per Stripe account. A key moves to a new price when the price changes in
 * Stripe, so an entry lasts PRICE_TTL. The promise is cached, so concurrent lookups share one call.
 */
const PRICE_TTL = 5 * 60_000;
const priceIds = new Map<string, { id: Promise<string>; at: number }>();

/** Stripe event types onto neutral ones; any other type is 'unhandled'. */
const EVENT_TYPES: Record<string, PaymentEventType> = {
  'checkout.session.completed': 'checkout.completed',
  'checkout.session.async_payment_succeeded': 'checkout.paid',
  'checkout.session.async_payment_failed': 'checkout.failed',
  'customer.subscription.created': 'subscription.created',
  'customer.subscription.updated': 'subscription.updated',
  'customer.subscription.paused': 'subscription.updated',
  'customer.subscription.resumed': 'subscription.updated',
  'customer.subscription.deleted': 'subscription.deleted',
  'invoice.paid': 'invoice.paid',
  'invoice.payment_failed': 'invoice.payment_failed',
  'charge.refunded': 'payment.refunded',
  'charge.dispute.created': 'dispute.opened',
  'charge.dispute.updated': 'dispute.updated',
  'charge.dispute.funds_withdrawn': 'dispute.updated',
  'charge.dispute.funds_reinstated': 'dispute.updated',
  'charge.dispute.closed': 'dispute.closed',
  'customer.updated': 'customer.updated',
  'customer.deleted': 'customer.deleted',
};

/** Charge ids, as opposed to PaymentIntent ids. */
const isChargeId = (id: string) => id.startsWith('ch_') || id.startsWith('py_');

/** `p`, or null when Stripe has no such object. */
const orNull = <T>(p: Promise<T>): Promise<T | null> =>
  p.catch((err) => {
    if (isPaymentError(err, 'not_found')) return null;
    throw err;
  });

async function sha256(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...hash.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createStripeProvider(opts: StripeOptions): StripeProvider {
  const key = opts.secretKey;
  const livemode = opts.livemode ?? /^[rs]k_live_/.test(key ?? '');
  const secrets = (Array.isArray(opts.webhookSecret) ? opts.webhookSecret : [opts.webhookSecret]).filter((s): s is string => !!s);
  const now = opts.now ?? Date.now;
  const resolve = opts.resolvePayments ?? true;
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
    throw new PaymentError('too_many', `Stripe ${path} lists more than ${MAX_PAGES * PAGE} objects.`);
  }

  function priceId(lookupKey: string): Promise<string> {
    const known = priceIds.get(cache + lookupKey);
    if (known && now() - known.at < PRICE_TTL) return known.id;
    const id = request<{ data: { id: string }[] }>('GET', '/v1/prices', { lookup_keys: [lookupKey], active: true, limit: 1 }).then(({ data }) => {
      if (!data[0]) throw new PaymentError('no_price', `No active Stripe price has the lookup key ${lookupKey}.`);
      return data[0].id;
    });
    priceIds.set(cache + lookupKey, { id, at: now() });
    // A failed lookup isn't kept.
    id.catch(() => priceIds.get(cache + lookupKey)?.id === id && priceIds.delete(cache + lookupKey));
    return id;
  }

  /**
   * What a charge paid for: a subscription invoice, a one-time Checkout, or a bare PaymentIntent.
   * Errors propagate, so a webhook fails and Stripe retries rather than misfile the payment.
   */
  async function purposeOf(charge: Obj): Promise<PaymentPurpose> {
    const pi = str(charge.payment_intent);
    // Older API versions name the invoice on the charge; newer ones list it under invoice payments.
    const invoice: Obj | string | null =
      typeof charge.invoice === 'string'
        ? await request<Obj>('GET', `/v1/invoices/${encodeURIComponent(charge.invoice)}`)
        : pi
          ? ((await request<{ data: { invoice: Obj | string | null }[] }>('GET', '/v1/invoice_payments', { payment: { type: 'payment_intent', payment_intent: pi }, expand: ['data.invoice'], limit: 1 })).data[0]?.invoice ?? null)
          : null;
    // Expanded as asked, or else just its id.
    if (typeof invoice === 'string') return purposeOf({ ...charge, invoice });
    const sub = invoice && typeof invoice === 'object' ? invoiceSubscription(invoice) : null;
    if (invoice && sub) return { kind: 'subscription', subscription: sub, invoice: invoice.id, reason: invoiceReason(invoice), lines: invoiceLines(invoice) };
    if (!pi) return { kind: 'unknown' };
    const session = (await request<{ data: Obj[] }>('GET', '/v1/checkout/sessions', { payment_intent: pi, limit: 1 })).data[0];
    return { kind: 'one_time', checkoutSession: session?.id ?? null, metadata: meta(session ? session.metadata : charge.metadata) };
  }

  async function resolvePayment(id: string): Promise<Payment | null> {
    const charge = isChargeId(id)
      ? await orNull(request<Obj>('GET', `/v1/charges/${encodeURIComponent(id)}`))
      : (await orNull(request<Obj>('GET', `/v1/payment_intents/${encodeURIComponent(id)}`, { expand: ['latest_charge'] })))?.latest_charge;
    return charge && typeof charge === 'object' ? toPayment(charge, await purposeOf(charge)) : null;
  }

  async function getSubscription(id: string): Promise<Subscription | null> {
    const s = await orNull(request<Obj>('GET', `/v1/subscriptions/${encodeURIComponent(id)}`, { expand: ['latest_invoice'] }));
    return s && toSubscription(s);
  }

  async function toEvent(e: Obj): Promise<PaymentEvent> {
    const base = { id: e.id as string, provider: 'stripe', providerType: e.type as string, created: ms(e.created), livemode: !!e.livemode, raw: e };
    const o: Obj = e.data?.object ?? {};
    const customer = str(o.customer);
    const unhandled: PaymentEvent = { ...base, type: 'unhandled', customer };
    // A sandbox event sent to a live endpoint (or the reverse) must not touch real accounts.
    if (typeof e.livemode === 'boolean' && e.livemode !== livemode) return unhandled;
    const type = EVENT_TYPES[e.type];
    switch (type) {
      case 'checkout.completed':
      case 'checkout.paid':
      case 'checkout.failed': {
        if (o.mode !== 'payment' && o.mode !== 'subscription') return unhandled;
        const fields = {
          customer,
          checkoutSession: o.id as string,
          mode: o.mode === 'payment' ? ('one_time' as const) : ('subscription' as const),
          subscription: str(o.subscription),
          payment: str(o.payment_intent),
          clientReference: o.client_reference_id ?? null,
          metadata: meta(o.metadata),
        };
        if (type !== 'checkout.completed') return { ...base, ...fields, type };
        return { ...base, ...fields, type, paid: isPaidSession(o), amount: typeof o.amount_total === 'number' ? money(o.amount_total, o.currency) : null };
      }
      case 'subscription.created':
      case 'subscription.updated':
      case 'subscription.deleted':
        return { ...base, type, customer: customer ?? '', subscription: toSubscription(o) };
      case 'invoice.paid':
      case 'invoice.payment_failed':
        return {
          ...base,
          type,
          customer: customer ?? '',
          subscription: invoiceSubscription(o),
          invoice: o.id,
          reason: invoiceReason(o),
          amount: money(type === 'invoice.paid' ? o.amount_paid : o.amount_due, o.currency),
          lines: invoiceLines(o),
        };
      case 'payment.refunded':
        return { ...base, type, customer, payment: toPayment(o, resolve ? await purposeOf(o) : { kind: 'unknown' }), refunded: o.amount_refunded ?? 0 };
      case 'dispute.opened':
      case 'dispute.updated':
      case 'dispute.closed': {
        const dispute = toDispute(o);
        const ref = dispute.charge ?? dispute.payment;
        const payment = ref && resolve ? await resolvePayment(ref) : null;
        return { ...base, type, customer: payment?.customer ?? null, dispute, payment };
      }
      case 'customer.updated':
      case 'customer.deleted':
        return { ...base, type, customer: o.id };
      default:
        return unhandled;
    }
  }

  return {
    name: 'stripe',
    livemode,
    request,
    priceId,

    async ensureCustomer({ userId, email, name, existing, metadata }) {
      if (existing) return existing;
      const params = { email: email ?? undefined, name, metadata: { ...metadata, user_id: userId } };
      // Two checkouts at once get one customer. Stripe refuses a key reused with other parameters,
      // so the key carries a hash of them; it lasts 24 hours, so the app stores the id it gets.
      const idempotencyKey = `customer:${userId}:${await sha256(JSON.stringify(params))}`;
      return (await request<{ id: string }>('POST', '/v1/customers', params, { idempotencyKey })).id;
    },

    async deleteCustomer(customer) {
      await orNull(request('DELETE', `/v1/customers/${encodeURIComponent(customer)}`));
    },

    async checkout(input: CheckoutInput) {
      const line_items = await Promise.all(
        input.items.map(async ({ price: p, quantity = 1 }) => {
          if ('id' in p) return { price: p.id, quantity };
          if ('lookupKey' in p) return { price: await priceId(p.lookupKey), quantity };
          const { amount, currency, name, interval, taxCode } = p.inline;
          return { price_data: { currency, unit_amount: amount, product_data: { name, tax_code: taxCode }, recurring: interval && { interval } }, quantity };
        }),
      );
      const { metadata, mode } = input;
      const s = await request<{ id: string; url: string | null }>(
        'POST',
        '/v1/checkout/sessions',
        {
          mode: mode === 'one_time' ? 'payment' : 'subscription',
          customer: input.customer,
          line_items,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.clientReference,
          metadata,
          allow_promotion_codes: input.allowPromotionCodes,
          automatic_tax: input.automaticTax && { enabled: true },
          // Automatic tax needs an address, which Checkout may save on the existing customer.
          customer_update: input.automaticTax && { address: 'auto', name: 'auto' },
          subscription_data: mode === 'subscription' ? { metadata, trial_period_days: input.trialDays } : undefined,
          payment_intent_data: mode === 'one_time' ? { metadata } : undefined,
          invoice_creation: mode === 'one_time' && input.invoice ? { enabled: true } : undefined,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (!s.url) throw new PaymentError('unavailable', 'Stripe made a Checkout Session without a URL.');
      return { id: s.id, url: s.url };
    },

    async portal({ customer, returnUrl, configuration, flow }: PortalInput) {
      const flowType = flow && `subscription_${flow.type}`;
      const flow_data = flow && flowType ? { type: flowType, [flowType]: { subscription: flow.subscription } } : undefined;
      const s = await request<{ url: string }>('POST', '/v1/billing_portal/sessions', { customer, return_url: returnUrl, configuration, flow_data });
      return { url: s.url };
    },

    async customerState(customer): Promise<CustomerState> {
      const [subs, sessions] = await Promise.all([
        list<Obj>('/v1/subscriptions', { customer, status: 'all', expand: ['data.latest_invoice'] }),
        list<Obj>('/v1/checkout/sessions', { customer, status: 'complete' }),
      ]);
      return {
        subscriptions: newestFirst(subs.map(toSubscription)),
        purchases: newestFirst(sessions.filter((s) => s.mode === 'payment' && isPaidSession(s)).map(toPurchase)),
      };
    },

    getSubscription,

    async cancelSubscription(id, { at = 'now', idempotencyKey } = {}) {
      const path = `/v1/subscriptions/${encodeURIComponent(id)}`;
      const s =
        at === 'now'
          ? await request<Obj>('DELETE', path, { expand: ['latest_invoice'] }, { idempotencyKey })
          : await request<Obj>('POST', path, { cancel_at_period_end: true, expand: ['latest_invoice'] }, { idempotencyKey });
      return toSubscription(s);
    },

    resolvePayment,

    paymentPurpose: (id) => purposeOf({ payment_intent: id }),

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
