// A small Stripe API client on fetch: form encoding, a pinned API version, idempotency keys and
// typed errors. No Node APIs, so it runs on Workers as is.
import { PaymentError } from '../errors.ts';

export type StripeParams = { [key: string]: string | number | boolean | null | undefined | StripeParams | (string | number | StripeParams)[] };

/** `params` in Stripe's form encoding: nested objects and arrays as `a[b][0][c]`. Null and undefined are left out. */
export function stripeForm(params: StripeParams, out = new URLSearchParams(), prefix = ''): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object') stripeForm(item, out, `${key}[${i}]`);
        else out.append(`${key}[${i}]`, String(item));
      });
    } else if (typeof v === 'object') stripeForm(v, out, key);
    else out.append(key, String(v));
  }
  return out;
}

export type StripeMethod = 'GET' | 'POST' | 'DELETE';

export interface StripeRequestOptions {
  idempotencyKey?: string;
}

export type StripeRequest = <T>(method: StripeMethod, path: string, params?: StripeParams, opts?: StripeRequestOptions) => Promise<T>;

export interface StripeClientOptions {
  secretKey: string;
  apiVersion: string;
  /** Another base URL, such as a local stand-in for tests. */
  baseUrl?: string;
  /** Another fetch, for tests. */
  fetch?: typeof fetch;
  /** Stripe Connect: act on this connected account. */
  account?: string;
}

export function stripeClient(opts: StripeClientOptions): StripeRequest {
  const base = (opts.baseUrl ?? 'https://api.stripe.com').replace(/\/$/, '');
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  return async <T>(method: StripeMethod, path: string, params: StripeParams = {}, ro: StripeRequestOptions = {}): Promise<T> => {
    const form = stripeForm(params);
    const query = method !== 'POST' && form.size ? `?${form}` : '';
    const headers: Record<string, string> = { authorization: `Bearer ${opts.secretKey}`, 'stripe-version': opts.apiVersion };
    if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
    if (ro.idempotencyKey) headers['idempotency-key'] = ro.idempotencyKey;
    if (opts.account) headers['stripe-account'] = opts.account;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}${query}`, { method, headers, body: method === 'POST' ? form : undefined });
    } catch (cause) {
      throw new PaymentError('unavailable', `Stripe ${method} ${path} failed: ${(cause as Error)?.message ?? cause}`, { cause });
    }
    const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: string } }) | null;
    if (res.ok && json) return json;
    const message = `Stripe ${method} ${path} answered ${res.status}: ${json?.error?.message ?? 'no body'}`;
    const code = res.status === 404 ? 'not_found' : res.status === 429 ? 'rate_limited' : res.status >= 400 && res.status < 500 ? 'invalid' : 'unavailable';
    throw new PaymentError(code, message, { status: res.status, providerCode: json?.error?.code ?? null });
  };
}
