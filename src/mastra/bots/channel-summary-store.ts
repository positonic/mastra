/**
 * channel-summary-store — mastra-side persistence for the periodic channel
 * summarizer (ADR-0023, exponential repo).
 *
 * Two jobs, both against mastra's own Postgres (the `whatsapp_messages` schema,
 * same DATABASE_URL the WhatsApp message store uses):
 *   1. A small per-(user, group) `channel_watermarks` row holding
 *      `last_summarized_at` — the watermark advanced only after exponential
 *      confirms receipt of a summary.
 *   2. Read-only access to the captured messages in a half-open window for one
 *      group, plus the group's display name.
 *
 * Raw messages NEVER leave mastra — this module only reads them to build a
 * summary in-process; only the finished summary is pushed to exponential.
 */
import pg from 'pg';

const SCHEMA_NAME = 'whatsapp_messages';

let pool: pg.Pool | null = null;
let initPromise: Promise<void> | null = null;

function getPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

/** Lazily create the watermark table (idempotent; mastra has no migrations). */
async function ensureInitialized(): Promise<void> {
  initPromise ??= getPool().query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.channel_watermarks (
      user_id            TEXT NOT NULL,
      jid                TEXT NOT NULL,
      last_summarized_at TIMESTAMPTZ NOT NULL,
      updated_at         TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, jid)
    )
  `).then(() => undefined);
  return initPromise;
}

export interface WindowMessage {
  senderName: string | null;
  text: string;
  timestamp: Date;
}

/** The watermark for a group, or `null` if it has never been summarized. */
export async function getLastSummarizedAt(
  userId: string,
  jid: string,
): Promise<Date | null> {
  await ensureInitialized();
  const { rows } = await getPool().query<{ last_summarized_at: Date }>(
    `SELECT last_summarized_at FROM ${SCHEMA_NAME}.channel_watermarks
     WHERE user_id = $1 AND jid = $2`,
    [userId, jid],
  );
  return rows[0]?.last_summarized_at ?? null;
}

/** Advance (upsert) the watermark. Call ONLY after a confirmed 2xx delivery. */
export async function setLastSummarizedAt(
  userId: string,
  jid: string,
  at: Date,
): Promise<void> {
  await ensureInitialized();
  await getPool().query(
    `INSERT INTO ${SCHEMA_NAME}.channel_watermarks (user_id, jid, last_summarized_at, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, jid)
     DO UPDATE SET last_summarized_at = EXCLUDED.last_summarized_at, updated_at = NOW()`,
    [userId, jid, at],
  );
}

/**
 * Captured messages for a group in the half-open window `(start, end]`, oldest
 * first. `start` may be `null` for the first-ever window (no lower bound).
 */
export async function readWindowMessages(
  userId: string,
  jid: string,
  start: Date | null,
  end: Date,
): Promise<WindowMessage[]> {
  const params: unknown[] = [userId, jid, end];
  let lowerBound = '';
  if (start) {
    params.push(start);
    lowerBound = `AND timestamp > $4`;
  }
  const { rows } = await getPool().query<{
    sender_name: string | null;
    text: string;
    timestamp: Date;
  }>(
    `SELECT sender_name, text, timestamp
     FROM ${SCHEMA_NAME}.messages
     WHERE user_id = $1 AND jid = $2 AND timestamp <= $3 ${lowerBound}
     ORDER BY timestamp ASC`,
    params,
  );
  return rows.map((r) => ({
    senderName: r.sender_name,
    text: r.text,
    timestamp: r.timestamp,
  }));
}

/** Human-readable group name from the captured chat row, else `null`. */
export async function getGroupDisplayName(
  userId: string,
  jid: string,
): Promise<string | null> {
  const { rows } = await getPool().query<{
    contact_name: string | null;
    push_name: string | null;
  }>(
    `SELECT contact_name, push_name FROM ${SCHEMA_NAME}.chats
     WHERE user_id = $1 AND jid = $2`,
    [userId, jid],
  );
  return rows[0]?.contact_name ?? rows[0]?.push_name ?? null;
}
