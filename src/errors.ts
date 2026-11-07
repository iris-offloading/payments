/**
 * - not_configured: the provider is missing a key or secret.
 * - bad_signature: a webhook didn't come from the provider, or came too late.
 * - not_found: the provider has no such object.
 * - invalid: the provider refused the request as malformed (4xx other than 404 and 429).
 * - rate_limited: the provider asked to slow down (429).
 * - unavailable: the provider failed or couldn't be reached (5xx, network).
 * - no_price: no active price has the lookup key.
 */
export type PaymentErrorCode = 'not_configured' | 'bad_signature' | 'not_found' | 'invalid' | 'rate_limited' | 'unavailable' | 'no_price';

/** Every error this library throws. `message` is for logs; show users your own words. */
export class PaymentError extends Error {
  readonly code: PaymentErrorCode;
  /** The HTTP status the provider answered, when it answered. */
  readonly status: number | null;
  /** The provider's own error code, such as Stripe's `resource_missing`. */
  readonly providerCode: string | null;

  constructor(code: PaymentErrorCode, message: string, opts: { status?: number | null; providerCode?: string | null; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'PaymentError';
    this.code = code;
    this.status = opts.status ?? null;
    this.providerCode = opts.providerCode ?? null;
  }
}

export const isPaymentError = (err: unknown, code?: PaymentErrorCode): err is PaymentError =>
  err instanceof PaymentError && (code === undefined || err.code === code);
