import pg from 'pg';

// AI tracing spans (mastra.mastra_ai_spans) accumulate forever otherwise —
// the table shares the memory Postgres, so unbounded growth eventually
// degrades live chat (exponential-gnui). Payloads are already capped by
// bulkyPayloadTruncator; this prunes whole rows past the retention window.
const RETENTION_DAYS = Number(process.env.SPAN_RETENTION_DAYS ?? '30');
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Logger = { info: (msg: string) => void; error: (msg: string) => void };

let timer: ReturnType<typeof setInterval> | undefined;

async function sweep(logger: Logger): Promise<void> {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
  });
  try {
    const result = await pool.query(
      `DELETE FROM mastra.mastra_ai_spans WHERE "startedAt" < now() - ($1 || ' days')::interval`,
      [String(RETENTION_DAYS)],
    );
    logger.info(
      `🧹 [span-retention] Pruned ${result.rowCount ?? 0} spans older than ${RETENTION_DAYS}d`,
    );
  } catch (err) {
    logger.error(`🧹 [span-retention] Sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Start the daily retention sweep. First run is delayed a minute so boot
 * isn't competing with the gateways and agent validation for the DB.
 */
export function startSpanRetention(logger: Logger): void {
  if (timer) return;
  if (RETENTION_DAYS <= 0) {
    logger.info('🧹 [span-retention] Disabled (SPAN_RETENTION_DAYS <= 0)');
    return;
  }
  setTimeout(() => {
    void sweep(logger);
  }, 60_000);
  timer = setInterval(() => {
    void sweep(logger);
  }, SWEEP_INTERVAL_MS);
}

export function stopSpanRetention(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
