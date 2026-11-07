// Stripe objects onto the neutral model. Stripe has moved fields between API versions (an invoice's
// subscription, a line's price, a charge's invoice), so each reader accepts the old and new shapes.
import type { Dispute, DisputeStage, InvoiceLine, InvoiceReason, Metadata, Money, Payment, PaymentPurpose, Refund, Subscription, SubscriptionStatus } from '../types.ts';

// Loose shapes: only the fields read here, all optional, since versions differ.
export type Obj = Record<string, any>;

const ms = (sec: unknown): number => (typeof sec === 'number' ? sec * 1000 : 0);
const msOrNull = (sec: unknown): number | null => (typeof sec === 'number' ? sec * 1000 : null);
/** An id, whether Stripe sent the id or the expanded object. */
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as Obj).id === 'string' ? (v as Obj).id : null);
export const meta = (v: unknown): Metadata => (v && typeof v === 'object' ? { ...(v as Metadata) } : {});
const money = (amount: unknown, currency: unknown): Money => ({ amount: typeof amount === 'number' ? amount : 0, currency: typeof currency === 'string' ? currency : '' });

/** States that keep access. past_due keeps it while Stripe retries the payment. */
const LIVE = new Set<SubscriptionStatus>(['trialing', 'active', 'past_due']);

export function toSubscription(s: Obj): Subscription {
  const items: Obj[] = s.items?.data ?? [];
  // Since API 2025-03-31 the period is on each item; before, on the subscription.
  const first = items[0] ?? {};
  const start = first.current_period_start ?? s.current_period_start;
  const end = first.current_period_end ?? s.current_period_end;
  // Ended at once (a cancel now, or unpaid) has ended_at; a cancel later, cancel_at or the period end.
  const endsAt = s.ended_at ?? s.cancel_at ?? (s.cancel_at_period_end ? end : null);
  const inv = s.latest_invoice;
  const status = s.status as SubscriptionStatus;
  return {
    id: s.id,
    customer: str(s.customer) ?? '',
    status,
    live: LIVE.has(status),
    items: items.map((i) => ({ price: str(i.price) ?? '', lookupKey: i.price?.lookup_key ?? null, quantity: i.quantity ?? 1 })),
    period: typeof start === 'number' && typeof end === 'number' ? { start: ms(start), end: ms(end) } : null,
    endsAt: msOrNull(endsAt),
    latestInvoicePaid: inv && typeof inv === 'object' ? inv.status === 'paid' : null,
    created: ms(s.created),
    metadata: meta(s.metadata),
    raw: s,
  };
}

/** The subscription an invoice bills, in either API shape. */
export const invoiceSubscription = (inv: Obj): string | null =>
  str(inv.parent?.subscription_details?.subscription) ?? str(inv.subscription);

export function invoiceReason(inv: Obj): InvoiceReason {
  switch (inv.billing_reason) {
    case 'subscription_create':
      return 'create';
    case 'subscription_cycle':
      return 'cycle';
    case 'subscription_update':
      return 'update';
    default:
      return 'other';
  }
}

/** An invoice's lines; `lookupKeys` names prices by id where the line itself doesn't carry the key. */
export function invoiceLines(inv: Obj, lookupKeys: (priceId: string) => string | null): InvoiceLine[] {
  return ((inv.lines?.data ?? []) as Obj[]).map((l) => {
    const price = str(l.pricing?.price_details?.price) ?? str(l.price);
    return {
      price,
      lookupKey: l.price?.lookup_key ?? l.pricing?.price_details?.price?.lookup_key ?? (price ? lookupKeys(price) : null),
      amount: l.amount ?? 0,
      period: { start: ms(l.period?.start), end: ms(l.period?.end) },
    };
  });
}

export function toPayment(charge: Obj, purpose: PaymentPurpose): Payment {
  return {
    id: str(charge.payment_intent) ?? charge.id,
    charge: charge.id ?? null,
    customer: str(charge.customer),
    amount: money(charge.amount, charge.currency),
    refunded: charge.amount_refunded ?? 0,
    purpose,
    created: ms(charge.created),
    metadata: meta(charge.metadata),
  };
}

const STAGES: Record<string, DisputeStage> = {
  warning_needs_response: 'inquiry',
  warning_under_review: 'inquiry',
  warning_closed: 'closed',
  needs_response: 'open',
  under_review: 'open',
  won: 'won',
  lost: 'lost',
  prevented: 'closed',
};
/** Dispute states while its money is out of the balance. An inquiry or a prevented dispute moves none. */
const WITHDRAWN = new Set(['needs_response', 'under_review', 'lost']);

export function toDispute(d: Obj): Dispute {
  return {
    id: d.id,
    payment: str(d.payment_intent),
    charge: str(d.charge),
    amount: money(d.amount, d.currency),
    stage: STAGES[d.status] ?? 'open',
    withdrawn: WITHDRAWN.has(d.status),
    reason: d.reason ?? 'general',
    status: d.status,
    respondBy: msOrNull(d.evidence_details?.due_by),
    raw: d,
  };
}

export function toRefund(r: Obj): Refund {
  return {
    id: r.id,
    payment: str(r.payment_intent) ?? str(r.charge) ?? '',
    amount: money(r.amount, r.currency),
    status: r.status,
    raw: r,
  };
}
