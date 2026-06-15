import { createLogger } from '../utils/logger.js';

const logger = createLogger({ name: 'NotionCapture', level: 'info' });

const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1/pages';
// Notion allows ~3 requests/second per integration; stay under it.
const MIN_INTERVAL_MS = 350;
const MAX_QUEUE_SIZE = 2000;
const NOTION_TEXT_LIMIT = 2000; // Notion rich_text/title hard cap per text object.

export interface CaptureRow {
  messageId: string;
  text: string;
  senderName?: string | null;
  timestamp: Date;
  fromMe: boolean;
}

/**
 * Appends captured WhatsApp messages as rows to a Notion database, using a
 * dedicated internal-integration token (NOTION_CAPTURE_TOKEN). Fire-and-forget:
 * callers enqueue and move on; a single worker drains the queue at a safe rate.
 *
 * Dedupe is in-memory (per process) — each live message arrives once, so this
 * prevents accidental double-enqueues within a run. It does NOT dedupe across
 * restarts; the MessageID column lets you clean up manually if ever needed.
 */
export class NotionCaptureSync {
  private readonly token: string;
  private readonly databaseId: string;
  private queue: CaptureRow[] = [];
  private seen = new Set<string>();
  private draining = false;

  private constructor(token: string, databaseId: string) {
    this.token = token;
    this.databaseId = databaseId;
  }

  /** Returns null (with a log) when the env isn't configured, so callers can no-op. */
  static fromEnv(): NotionCaptureSync | null {
    const token = process.env.NOTION_CAPTURE_TOKEN;
    const databaseId = process.env.NOTION_CAPTURE_DATABASE_ID;
    if (!token || !databaseId) {
      logger.info('NOTION_CAPTURE_TOKEN / NOTION_CAPTURE_DATABASE_ID not set — Notion capture disabled');
      return null;
    }
    return new NotionCaptureSync(token, databaseId);
  }

  enqueue(row: CaptureRow): void {
    if (this.seen.has(row.messageId)) return;
    this.seen.add(row.messageId);

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      const dropped = this.queue.shift();
      logger.warn(`Notion capture queue full (${MAX_QUEUE_SIZE}); dropped oldest message ${dropped?.messageId}`);
    }
    this.queue.push(row);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const row = this.queue.shift()!;
        try {
          await this.writeRow(row);
        } catch (err) {
          logger.error(`Failed to write message ${row.messageId} to Notion:`, err);
        }
        await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL_MS));
      }
    } finally {
      this.draining = false;
    }
  }

  private async writeRow(row: CaptureRow): Promise<void> {
    const text = (row.text || '').slice(0, NOTION_TEXT_LIMIT);
    const res = await fetch(NOTION_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: this.databaseId },
        properties: {
          Message: { title: [{ text: { content: text } }] },
          Sender: { rich_text: [{ text: { content: (row.senderName ?? '').slice(0, NOTION_TEXT_LIMIT) } }] },
          Date: { date: { start: row.timestamp.toISOString() } },
          Direction: { select: { name: row.fromMe ? 'outgoing' : 'incoming' } },
          MessageID: { rich_text: [{ text: { content: row.messageId } }] },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Notion API ${res.status}: ${body}`);
    }
  }
}
