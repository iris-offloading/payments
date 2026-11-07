// The provider-neutral model. Every adapter maps its provider's objects onto these shapes, and
// every object keeps the provider's own under `raw`, so an app can reach past the model when it
// must. Times are milliseconds since the epoch; money is in the currency's smallest unit.

/** An amount in the currency's smallest unit (cents for USD), with its ISO currency in lower case. */
export interface Money {
  amount: number;
  currency: string;
}

export type Metadata = Record<string, string>;

/**
 * A price to buy: `{ lookupKey }` finds the provider's active price by a key the app sets in the
 * provider's dashboard (so sandbox and live run the same code), `{ id }` names it directly, and
 * `{ inline }` defines it in code for this checkout alone.
 */
export type PriceRef = { lookupKey: string } | { id: string } | { inline: InlinePrice };

export interface InlinePrice {
  /** In the currency's smallest unit. */
  amount: number;
  currency: string;
  /** The product name the customer sees. */
  name: string;
  /** Bills every interval; required for a subscription. */
  interval?: 'day' | 'week' | 'month' | 'year';
  /** A provider tax code, such as Stripe's txcd_10105001. */
  taxCode?: string;
}

export interface LineItem {
  price: PriceRef;
  quantity?: number;
}

export type SubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'paused'
  | 'canceled';

export interface Subscription {
  id: string;
  customer: string;
  status: SubscriptionStatus;
  /**
   * Whether the subscription still gives access: trialing, active, or past_due while the provider
   * retries the payment. An app with a stricter rule reads `status` and `latestInvoicePaid`.
   */
  live: boolean;
  items: { price: string; lookupKey: string | null; quantity: number }[];
  /** The billing period now running, or null when the provider doesn't say. */
  period: { start: number; end: number } | null;
  /** When a cancelled subscription stops, or null while it renews. */
  endsAt: number | null;
  /** Whether the latest invoice (the period's start or the last switch) is paid; null when unknown. */
  latestInvoicePaid: boolean | null;
  created: number;
  metadata: Metadata;
  raw: unknown;
}

/** What a payment paid for. */
export type PaymentPurpose =
  | { kind: 'subscription'; subscription: string; invoice: string; reason: InvoiceReason; lines: InvoiceLine[] }
  | { kind: 'one_time'; checkoutSession: string | null; metadata: Metadata }
  | { kind: 'unknown' };

/** Why an invoice was made: a subscription's first one, a renewal, a plan switch, or anything else. */
export type InvoiceReason = 'create' | 'cycle' | 'update' | 'other';

export interface InvoiceLine {
  price: string | null;
  lookupKey: string | null;
  /** Negative for a credit, such as the unused part of the old plan after a switch. */
  amount: number;
  period: { start: number; end: number };
}

/** A captured payment from a customer. */
export interface Payment {
  /** The provider's stable id for the payment: Stripe's PaymentIntent id. */
  id: string;
  /** The provider's id for the charge itself, when it differs from `id`. */
  charge: string | null;
  customer: string | null;
  amount: Money;
  /** How much has been refunded so far, in total. */
  refunded: number;
  purpose: PaymentPurpose;
  created: number;
  metadata: Metadata;
}

/** A paid one-time checkout, as customerState lists them. */
export interface Purchase {
  checkoutSession: string;
  payment: string | null;
  amount: Money;
  created: number;
  metadata: Metadata;
  raw: unknown;
}

export interface Refund {
  id: string;
  payment: string;
  amount: Money;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'requires_action';
  raw: unknown;
}

/**
 * - inquiry: the bank asked a question (Stripe's warning_*); no money has moved.
 * - open: money is withdrawn and the dispute awaits a response or a decision.
 * - won / lost: decided. Won returns the money.
 * - closed: an inquiry that ended, or a dispute prevented before it started; no money moved.
 */
export type DisputeStage = 'inquiry' | 'open' | 'won' | 'lost' | 'closed';

export interface Dispute {
  id: string;
  payment: string | null;
  charge: string | null;
  amount: Money;
  stage: DisputeStage;
  /** Whether the disputed money is out of the merchant's balance now. */
  withdrawn: boolean;
  reason: string;
  /** The provider's own status word. */
  status: string;
  /** When the response is due, if one is. */
  respondBy: number | null;
  raw: unknown;
}

interface EventBase {
  /** The provider's event id: unique, so an app can process each event once (see `processOnce`). */
  id: string;
  provider: string;
  /** The provider's event type, as sent. */
  providerType: string;
  created: number;
  livemode: boolean;
  raw: unknown;
}

interface CheckoutFields {
  customer: string | null;
  checkoutSession: string;
  mode: 'subscription' | 'one_time';
  subscription: string | null;
  payment: string | null;
  /** The app's own id for the buyer, as passed to checkout. */
  clientReference: string | null;
  metadata: Metadata;
}

/**
 * Webhook events, normalized. They say what happened and to whom; they never decide what an app
 * grants. Events can arrive late, twice, or out of order, so an app should treat them as hints to
 * re-read state (customerState, resolvePayment) wherever order matters.
 */
export type PaymentEvent = EventBase &
  (
    | (CheckoutFields & {
        type: 'checkout.completed';
        /** False while a delayed method (a bank debit) is still confirming; checkout.paid follows. */
        paid: boolean;
        amount: Money | null;
      })
    /** A delayed payment method confirmed, or failed, a completed checkout. */
    | (CheckoutFields & { type: 'checkout.paid' | 'checkout.failed' })
    | {
        type: 'subscription.created' | 'subscription.updated' | 'subscription.deleted';
        customer: string;
        subscription: Subscription;
      }
    | {
        /** A subscription invoice was paid: a first payment, a renewal or a switch. */
        type: 'invoice.paid' | 'invoice.payment_failed';
        customer: string;
        subscription: string | null;
        invoice: string;
        reason: InvoiceReason;
        amount: Money;
        lines: InvoiceLine[];
      }
    | {
        /** `refunded` is the payment's total refunded so far, not only this refund's. */
        type: 'payment.refunded';
        customer: string | null;
        payment: Payment;
        refunded: number;
      }
    | {
        type: 'dispute.opened' | 'dispute.updated' | 'dispute.closed';
        customer: string | null;
        dispute: Dispute;
        /** What the disputed payment paid for; null when it can't be found. */
        payment: Payment | null;
      }
    | { type: 'customer.updated' | 'customer.deleted'; customer: string }
    | { type: 'unhandled'; customer: string | null }
  );

export type PaymentEventType = PaymentEvent['type'];

export interface CheckoutInput {
  customer: string;
  mode: 'subscription' | 'one_time';
  items: LineItem[];
  successUrl: string;
  cancelUrl: string;
  /** The app's own id for the buyer, echoed back on checkout events. */
  clientReference?: string;
  /** Set on the checkout, and copied onto the subscription or the payment it makes. */
  metadata?: Metadata;
  allowPromotionCodes?: boolean;
  automaticTax?: boolean;
  /** Days of free trial for a subscription. */
  trialDays?: number;
  idempotencyKey?: string;
}

export interface PortalInput {
  customer: string;
  returnUrl: string;
  /** Opens the portal straight on cancelling or changing one subscription. */
  flow?: { type: 'cancel' | 'update'; subscription: string };
  /** A provider-specific portal configuration id. */
  configuration?: string;
}

export interface RefundInput {
  /** A Payment id, or for Stripe a charge id (ch_...) too. */
  payment: string;
  /** Part of the payment, in the smallest unit; the whole remaining amount when left out. */
  amount?: number;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  metadata?: Metadata;
  idempotencyKey?: string;
}

export interface CustomerState {
  /** Every subscription the customer has, newest first, ended ones included. */
  subscriptions: Subscription[];
  /** Paid one-time checkouts, newest first. */
  purchases: Purchase[];
}

/** One payment platform. Adapters implement it; apps depend only on this. */
export interface PaymentProvider {
  readonly name: string;
  /** Whether this provider is pointed at live money rather than a sandbox. */
  readonly livemode: boolean;

  /** The customer for an app user: `existing` when given, else a new one (idempotent per user). */
  ensureCustomer(input: { userId: string; email: string; name?: string; existing?: string | null; metadata?: Metadata }): Promise<string>;
  /** Deletes the customer, which cancels its subscriptions at once. */
  deleteCustomer(customer: string): Promise<void>;

  /** A hosted checkout page for a subscription or a one-time purchase. */
  checkout(input: CheckoutInput): Promise<{ id: string; url: string }>;
  /** A hosted page where the customer manages subscriptions, payment methods and invoices. */
  portal(input: PortalInput): Promise<{ url: string }>;

  /** The customer's subscriptions and one-time purchases as the provider has them now. */
  customerState(customer: string): Promise<CustomerState>;
  getSubscription(id: string): Promise<Subscription | null>;
  cancelSubscription(id: string, opts?: { at?: 'now' | 'period_end' }): Promise<Subscription>;
  /** A payment and what it paid for, by Payment id or (Stripe) charge id. */
  resolvePayment(id: string): Promise<Payment | null>;

  refund(input: RefundInput): Promise<Refund>;

  /**
   * Verifies a webhook request's signature and returns its event, normalized. Throws a
   * PaymentError with code 'bad_signature' when it isn't from the provider. Reads the body; pass
   * the body when it was already read.
   */
  parseWebhook(req: Request, body?: string): Promise<PaymentEvent>;
}
