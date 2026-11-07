// Rules of the neutral model that every adapter shares.
import type { SubscriptionStatus } from './types.ts';

/** States that keep access. past_due keeps it while the provider retries the payment. */
const LIVE = new Set<SubscriptionStatus>(['trialing', 'active', 'past_due']);

/** Whether a subscription in `status` still gives access. */
export const isLive = (status: SubscriptionStatus): boolean => LIVE.has(status);

/** Newest first, the order customerState promises. */
export const newestFirst = <T extends { created: number }>(items: T[]): T[] => items.sort((a, b) => b.created - a.created);
