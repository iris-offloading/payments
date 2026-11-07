// Process each webhook event once on Cloudflare D1. Providers retry and repeat events, so an app
// records each event id before applying it, and forgets it again when applying fails, so the
// provider's retry applies it then.

/** The parts of a D1Database this module uses, so it needs no Workers types. */
export interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<{ meta: { changes: number } }> } };
}

/** The table processOnce writes. Add it to a migration, under any name you pass as `table`. */
export const PAYMENT_EVENTS_SQL = `CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`;

/**
 * Runs `apply` for `event` unless an earlier call already did. Returns 'applied', or 'duplicate'
 * when the event was seen before. When `apply` throws, the event is forgotten and the error
 * rethrown, so the webhook can answer 500 and the provider retries.
 */
export async function processOnce<E extends { id: string; provider: string; type: string }>(
  db: D1Like,
  event: E,
  apply: (event: E) => Promise<void>,
  opts: { table?: string; now?: () => number } = {},
): Promise<'applied' | 'duplicate'> {
  const table = opts.table ?? 'payment_events';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Bad table name ${table}`);
  const fresh = await db
    .prepare(`INSERT OR IGNORE INTO ${table} (id, provider, type, created_at) VALUES (?, ?, ?, ?)`)
    .bind(`${event.provider}:${event.id}`, event.provider, event.type, (opts.now ?? Date.now)())
    .run();
  if (!fresh.meta.changes) return 'duplicate';
  try {
    await apply(event);
    return 'applied';
  } catch (err) {
    await db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(`${event.provider}:${event.id}`).run();
    throw err;
  }
}
