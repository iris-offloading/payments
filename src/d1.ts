// Process each webhook event once on Cloudflare D1. Providers retry and repeat events, so an app
// claims each event id before applying it and marks it done after. A claim that never finished (the
// Worker died mid-apply) lapses after a lease, so the provider's retry applies the event then.

/** The parts of a D1Database this module uses, so it needs no Workers types. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<{ meta: { changes: number } }>; first<T>(): Promise<T | null> };
  };
}

/** The table processOnce writes. Add it to a migration, under any name you pass as `table`. */
export const PAYMENT_EVENTS_SQL = `CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);`;

/** How long an unfinished claim holds before a retry may take the event over. */
const LEASE = 5 * 60_000;

/**
 * Runs `apply` for `event` unless another call already did, or is doing it now. Returns:
 * - 'applied': this call applied it.
 * - 'duplicate': it was applied before; answer 2xx.
 * - 'busy': another call claimed it in the last few minutes and hasn't finished; answer 409 or
 *   5xx so the provider retries later.
 * When `apply` throws, the claim is dropped and the error rethrown, so the webhook can answer 5xx
 * and the provider retries.
 */
export async function processOnce<E extends { id: string; provider: string; type: string }>(
  db: D1Like,
  event: E,
  apply: (event: E) => Promise<void>,
  opts: { table?: string; now?: () => number; leaseMs?: number } = {},
): Promise<'applied' | 'duplicate' | 'busy'> {
  const table = opts.table ?? 'payment_events';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Bad table name ${table}`);
  const id = `${event.provider}:${event.id}`;
  const now = (opts.now ?? Date.now)();
  // A new claim, or one that lapsed unfinished.
  const claimed = await db
    .prepare(`INSERT INTO ${table} (id, provider, type, created_at, done) VALUES (?1, ?2, ?3, ?4, 0)
      ON CONFLICT (id) DO UPDATE SET created_at = ?4 WHERE done = 0 AND created_at <= ?5`)
    .bind(id, event.provider, event.type, now, now - (opts.leaseMs ?? LEASE))
    .run();
  if (!claimed.meta.changes) {
    const row = await db.prepare(`SELECT done FROM ${table} WHERE id = ?`).bind(id).first<{ done: number }>();
    return row?.done ? 'duplicate' : 'busy';
  }
  try {
    await apply(event);
  } catch (err) {
    await db.prepare(`DELETE FROM ${table} WHERE id = ? AND done = 0 AND created_at = ?`).bind(id, now).run().catch(() => {});
    throw err;
  }
  await db.prepare(`UPDATE ${table} SET done = 1 WHERE id = ?`).bind(id).run();
  return 'applied';
}
