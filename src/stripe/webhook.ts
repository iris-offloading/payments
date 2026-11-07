// Stripe-Signature checks with WebCrypto: t=<seconds>,v1=<hex HMAC-SHA256 of "t.body">.

const encoder = new TextEncoder();

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Whether `header` signs `payload` with any of `secrets` (several during a rotation), at a time
 * within `toleranceSec` of `now`.
 */
export async function verifyStripeSignature(payload: string, header: string | null, secrets: string[], toleranceSec = 300, now = Date.now()): Promise<boolean> {
  if (!header) return false;
  let t = NaN;
  const sigs: Uint8Array<ArrayBuffer>[] = [];
  for (const part of header.split(',')) {
    const [k, v = ''] = part.trim().split('=', 2);
    if (k === 't') t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) sigs.push(hexBytes(v));
  }
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSec || !sigs.length) return false;
  const data = encoder.encode(`${t}.${payload}`);
  for (const secret of secrets) {
    if (!secret) continue;
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    for (const sig of sigs) if (await crypto.subtle.verify('HMAC', key, sig, data)) return true;
  }
  return false;
}

/** A Stripe-Signature header for `payload`, for tests and local tools. */
export async function signStripePayload(payload: string, secret: string, now = Date.now()): Promise<string> {
  const t = Math.floor(now / 1000);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${t}.${payload}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
