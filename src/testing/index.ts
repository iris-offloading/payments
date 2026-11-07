// An in-memory provider for app tests: the same interface as a real adapter, plus methods that act
// out what a customer or bank would do (pay a checkout, renew, dispute) and record the events a
// real provider would send. Apps test their webhook handling by feeding those events back in
// through webhookRequest and parseWebhook, without stubbing HTTP.
import { PaymentError } from '../errors.ts';
import type {
  CheckoutInput,
  CustomerState,
  Dispute,
  Metadata,
  Money,
  Payment,
  PaymentEvent,
  PaymentProvider,
  Purchase,
  Refund,
  RefundInput,
  Subscription,
} from '../types.ts';

interface Session {
  id: string;
  input: CheckoutInput;
  prices: { price: string; lookupKey: string | null; quantity: number }[];
  status: 'open' | 'complete';
}

export interface FakeOptions {
  /** Price amounts by lookup key, in the smallest unit. */
  prices: Record<string, number>;
  currency?: string;
  /** Length of a billing period. */
  periodMs?: number;
  webhookSecret?: string;
  now?: () => number;
}

const DAY = 86_400_000;

type Fields = 'id' | 'provider' | 'providerType' | 'created' | 'livemode' | 'raw';
/** An event as the fake builds it, before the fields every event shares. */
type EventInput = PaymentEvent extends infer E ? (E extends unknown ? Omit<E, Fields> : never) : never;

export class FakeProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly livemode = false;
  /** Every event the fake has sent, oldest first. */
  readonly events: PaymentEvent[] = [];
  readonly customers = new Map<string, { email: string; userId: string; deleted: boolean }>();
  readonly subscriptions = new Map<string, Subscription>();
  readonly payments = new Map<string, Payment>();
  readonly disputes = new Map<string, Dispute>();
  readonly sessions = new Map<string, Session>();
  readonly purchases: Purchase[] = [];
  private seq = 0;
  private readonly opts: Required<FakeOptions>;

  constructor(opts: FakeOptions) {
    this.opts = { currency: 'usd', periodMs: 30 * DAY, webhookSecret: 'fake_secret', now: Date.now, ...opts };
  }

  /** The id the fake gives the price with this lookup key. */
  static priceId(lookupKey: string) {
    return `price_${lookupKey}`;
  }

  private id(prefix: string) {
    return `${prefix}_${++this.seq}`;
  }
  private now() {
    return this.opts.now();
  }
  private money(amount: number): Money {
    return { amount, currency: this.opts.currency };
  }
  private priceOf(lookupKey: string) {
    const amount = this.opts.prices[lookupKey];
    if (amount === undefined) throw new PaymentError('no_price', `No price has the lookup key ${lookupKey}.`);
    return amount;
  }
  private emit(e: EventInput): PaymentEvent {
    const id = this.id('evt');
    const event = { ...e, id, provider: this.name, providerType: e.type, created: this.now(), livemode: false, raw: null } as PaymentEvent;
    this.events.push(event);
    return event;
  }

  async ensureCustomer({ userId, email, existing }: { userId: string; email: string; existing?: string | null }) {
    if (existing) return existing;
    for (const [id, c] of this.customers) if (c.userId === userId && !c.deleted) return id;
    const id = this.id('cus');
    this.customers.set(id, { email, userId, deleted: false });
    return id;
  }

  async deleteCustomer(customer: string) {
    const c = this.customers.get(customer);
    if (!c) return;
    c.deleted = true;
    for (const s of this.subscriptions.values()) if (s.customer === customer && s.live) this.endSubscription(s);
    this.emit({ type: 'customer.deleted', customer });
  }

  async checkout(input: CheckoutInput) {
    const prices = input.items.map((i) => {
      // A price's id is `price_` and its lookup key.
      const lookupKey = 'lookupKey' in i.price ? i.price.lookupKey : i.price.id.replace(/^price_/, '');
      this.priceOf(lookupKey);
      return { price: FakeProvider.priceId(lookupKey), lookupKey, quantity: i.quantity ?? 1 };
    });
    const id = this.id('cs');
    this.sessions.set(id, { id, input, prices, status: 'open' });
    return { id, url: `https://fake.pay/checkout/${id}` };
  }

  async portal(input: { customer: string }) {
    return { url: `https://fake.pay/portal/${input.customer}` };
  }

  async customerState(customer: string): Promise<CustomerState> {
    return {
      subscriptions: [...this.subscriptions.values()].filter((s) => s.customer === customer).sort((a, b) => b.created - a.created),
      purchases: this.purchases.filter((p) => (this.payments.get(p.payment ?? '')?.customer ?? null) === customer).sort((a, b) => b.created - a.created),
    };
  }

  async getSubscription(id: string) {
    return this.subscriptions.get(id) ?? null;
  }

  async cancelSubscription(id: string, { at = 'now' }: { at?: 'now' | 'period_end' } = {}) {
    const s = this.subscriptions.get(id);
    if (!s) throw new PaymentError('not_found', `No subscription ${id}.`);
    if (at === 'now') this.endSubscription(s);
    else {
      s.endsAt = s.period?.end ?? this.now();
      this.emit({ type: 'subscription.updated', customer: s.customer, subscription: { ...s } });
    }
    return s;
  }

  async resolvePayment(id: string) {
    return this.payments.get(id) ?? null;
  }

  async refund(input: RefundInput): Promise<Refund> {
    const p = this.payments.get(input.payment);
    if (!p) throw new PaymentError('not_found', `No payment ${input.payment}.`);
    const amount = input.amount ?? p.amount.amount - p.refunded;
    if (amount <= 0 || p.refunded + amount > p.amount.amount) throw new PaymentError('invalid', 'Refund exceeds the payment.');
    p.refunded += amount;
    this.emit({ type: 'payment.refunded', customer: p.customer, payment: { ...p }, refunded: p.refunded });
    return { id: this.id('re'), payment: p.id, amount: this.money(amount), status: 'succeeded', raw: null };
  }

  async parseWebhook(req: Request, body?: string): Promise<PaymentEvent> {
    if (req.headers.get('x-fake-signature') !== this.opts.webhookSecret) throw new PaymentError('bad_signature', 'Not signed by the fake provider.');
    const { id } = JSON.parse(body ?? (await req.text())) as { id: string };
    const event = this.events.find((e) => e.id === id);
    if (!event) throw new PaymentError('invalid', `No event ${id}.`);
    return event;
  }

  // ---- Acting out the outside world ----

  /** A request carrying `event` the way the provider would send it, for the app's webhook route. */
  webhookRequest(event: PaymentEvent, url = 'https://app.test/webhook'): Request {
    return new Request(url, { method: 'POST', headers: { 'x-fake-signature': this.opts.webhookSecret, 'content-type': 'application/json' }, body: JSON.stringify({ id: event.id }) });
  }

  /** The customer pays (or, with `paid: false`, starts a delayed payment for) checkout `id`. Returns the events sent. */
  completeCheckout(id: string, { paid = true }: { paid?: boolean } = {}): PaymentEvent[] {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open') throw new PaymentError('invalid', `Checkout ${id} isn't open.`);
    s.status = 'complete';
    const from = this.events.length;
    const total = s.prices.reduce((n, p) => n + this.priceOf(p.lookupKey!) * p.quantity, 0);
    const metadata: Metadata = { ...s.input.metadata };
    const common = { customer: s.input.customer, checkoutSession: id, clientReference: s.input.clientReference ?? null, metadata };
    if (s.input.mode === 'one_time') {
      const payment = paid ? this.pay(s.input.customer, total, { kind: 'one_time', checkoutSession: id, metadata }) : null;
      if (payment) this.purchases.push({ checkoutSession: id, payment: payment.id, amount: this.money(total), created: this.now(), metadata, raw: null });
      this.emit({ type: 'checkout.completed', ...common, mode: 'one_time', paid, subscription: null, payment: payment?.id ?? null, amount: this.money(total) });
    } else {
      const start = this.now();
      const sub: Subscription = {
        id: this.id('sub'),
        customer: s.input.customer,
        status: paid ? (s.input.trialDays ? 'trialing' : 'active') : 'incomplete',
        live: paid,
        items: s.prices.map((p) => ({ price: p.price, lookupKey: p.lookupKey, quantity: p.quantity })),
        period: { start, end: start + this.opts.periodMs },
        endsAt: null,
        latestInvoicePaid: paid,
        created: start,
        metadata,
        raw: null,
      };
      this.subscriptions.set(sub.id, sub);
      this.emit({ type: 'subscription.created', customer: sub.customer, subscription: { ...sub } });
      // A trial's first invoice is for nothing.
      const payment = paid ? this.invoice(sub, 'create', s.input.trialDays ? 0 : total) : null;
      this.emit({ type: 'checkout.completed', ...common, mode: 'subscription', paid, subscription: sub.id, payment: payment?.id ?? null, amount: this.money(total) });
    }
    return this.events.slice(from);
  }

  /** Starts the next billing period of subscription `id` and pays it. Returns the events sent. */
  renew(id: string, { paid = true }: { paid?: boolean } = {}): PaymentEvent[] {
    const s = this.subscriptions.get(id);
    if (!s || !s.live || !s.period) throw new PaymentError('invalid', `Subscription ${id} isn't live.`);
    const from = this.events.length;
    if (s.endsAt !== null && s.endsAt <= s.period.end) {
      this.endSubscription(s);
      return this.events.slice(from);
    }
    s.period = { start: s.period.end, end: s.period.end + this.opts.periodMs };
    const total = s.items.reduce((n, i) => n + this.priceOf(i.lookupKey!) * i.quantity, 0);
    if (paid) {
      s.status = 'active';
      this.invoice(s, 'cycle', total);
    } else {
      s.status = 'past_due';
      s.latestInvoicePaid = false;
      this.emit({ type: 'invoice.payment_failed', customer: s.customer, subscription: s.id, invoice: this.id('in'), reason: 'cycle', amount: this.money(total), lines: [] });
    }
    this.emit({ type: 'subscription.updated', customer: s.customer, subscription: { ...s } });
    return this.events.slice(from);
  }

  /** The bank opens a dispute over the whole of payment `id`. Returns the dispute. */
  openDispute(id: string, reason = 'fraudulent'): Dispute {
    const p = this.payments.get(id);
    if (!p) throw new PaymentError('not_found', `No payment ${id}.`);
    const dispute: Dispute = { id: this.id('dp'), payment: p.id, charge: p.charge, amount: { ...p.amount }, stage: 'open', withdrawn: true, reason, status: 'needs_response', respondBy: this.now() + 7 * DAY, raw: null };
    this.disputes.set(dispute.id, dispute);
    this.emit({ type: 'dispute.opened', customer: p.customer, dispute: { ...dispute }, payment: { ...p } });
    return dispute;
  }

  /** The bank decides dispute `id`. */
  closeDispute(id: string, outcome: 'won' | 'lost'): Dispute {
    const d = this.disputes.get(id);
    if (!d) throw new PaymentError('not_found', `No dispute ${id}.`);
    Object.assign(d, { stage: outcome, status: outcome, withdrawn: outcome === 'lost' });
    const p = d.payment ? (this.payments.get(d.payment) ?? null) : null;
    this.emit({ type: 'dispute.closed', customer: p?.customer ?? null, dispute: { ...d }, payment: p && { ...p } });
    return d;
  }

  private pay(customer: string, amount: number, purpose: Payment['purpose']): Payment {
    const p: Payment = { id: this.id('pi'), charge: this.id('ch'), customer, amount: this.money(amount), refunded: 0, purpose, created: this.now(), metadata: {} };
    this.payments.set(p.id, p);
    return p;
  }

  private invoice(s: Subscription, reason: 'create' | 'cycle', total: number): Payment {
    const invoice = this.id('in');
    const lines = s.items.map((i) => ({ price: i.price, lookupKey: i.lookupKey, amount: total && this.priceOf(i.lookupKey!) * i.quantity, period: { ...s.period! } }));
    const payment = this.pay(s.customer, total, { kind: 'subscription', subscription: s.id, invoice, reason, lines });
    s.latestInvoicePaid = true;
    this.emit({ type: 'invoice.paid', customer: s.customer, subscription: s.id, invoice, reason, amount: this.money(total), lines });
    return payment;
  }

  private endSubscription(s: Subscription) {
    s.status = 'canceled';
    s.live = false;
    s.endsAt = this.now();
    this.emit({ type: 'subscription.deleted', customer: s.customer, subscription: { ...s } });
  }
}
