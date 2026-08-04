import { createLogger } from '../utils/logger.js';

const logger = createLogger({ name: 'ClearCapture', level: 'info' });

const INGEST_PATH = '/api/ground/ingest';
// The endpoint accepts up to 500 messages per request; stay well under it so
// a single failed POST never loses a huge slice of the queue.
const MAX_BATCH = 100;
// Pacing between POSTs while draining. The endpoint is our own; this is just
// politeness so a burst (e.g. reconnect replay) doesn't hammer it.
const MIN_INTERVAL_MS = 500;
const MAX_QUEUE_SIZE = 2000;

/**
 * One captured group message, in the shape the clear-api live-ingest
 * endpoint accepts (see clear-api src/routes/ground-ingest.ts):
 * `{ groupJid, messageId, senderJid, senderName?, timestamp, text?,
 *   mediaKeys?, mediaRefs?, isEdited? }`.
 *
 * `mediaKeys` (S3 keys) are deliberately absent: the live-ingest contract
 * only accepts JSON references — it has no byte-upload path — so the
 * gateway mirrors media as metadata refs (see describeCaptureMedia) and
 * the S3 upload path is a clear-api follow-up.
 */
export interface ClearCaptureMessage {
  groupJid: string;
  messageId: string;
  senderJid: string;
  senderName?: string | null;
  timestamp: Date;
  /** Message text / media caption. Null for caption-less media. */
  text?: string | null;
  /** Human-readable media metadata refs (filename, mimetype, size). */
  mediaRefs?: string[];
  isEdited?: boolean;
}

/**
 * Media metadata extracted from a Baileys message for the mirror payload.
 * Metadata only — the gateway does not download media bytes for the mirror
 * (the ingest endpoint has nowhere to put them; see ClearCaptureMessage).
 */
export interface CaptureMediaInfo {
  kind: 'image' | 'video' | 'document';
  fileName: string | null;
  mimetype: string | null;
  sizeBytes: number | null;
  /** Caption carried on the media node (covers document captions, which
   * the gateway's extractText does not read). */
  caption: string | null;
}

/** The slices of a Baileys proto.IMessage the media describer reads.
 * Structural (not the baileys type) so tests stay hermetic. */
interface MediaMessageContentLike {
  imageMessage?: MediaNodeLike | null;
  videoMessage?: MediaNodeLike | null;
  documentMessage?: MediaNodeLike | null;
  documentWithCaptionMessage?: { message?: MediaMessageContentLike | null } | null;
}

interface MediaNodeLike {
  caption?: string | null;
  fileName?: string | null;
  mimetype?: string | null;
  /** proto int64: number or Long. */
  fileLength?: number | { toString(): string } | null;
}

function toSizeBytes(fileLength: MediaNodeLike['fileLength']): number | null {
  if (fileLength === null || fileLength === undefined) return null;
  const n = typeof fileLength === 'number' ? fileLength : Number(fileLength.toString());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function describeNode(kind: CaptureMediaInfo['kind'], node: MediaNodeLike): CaptureMediaInfo {
  return {
    kind,
    fileName: node.fileName?.trim() || null,
    mimetype: node.mimetype?.trim() || null,
    sizeBytes: toSizeBytes(node.fileLength),
    caption: node.caption?.trim() || null,
  };
}

/**
 * Describe the image/video/document media carried by a message, if any.
 * Returns null for pure text (and for media kinds the mirror doesn't
 * cover, e.g. audio/stickers).
 */
export function describeCaptureMedia(
  message: MediaMessageContentLike | null | undefined,
): CaptureMediaInfo | null {
  if (!message) return null;
  if (message.imageMessage) return describeNode('image', message.imageMessage);
  if (message.videoMessage) return describeNode('video', message.videoMessage);
  if (message.documentMessage) return describeNode('document', message.documentMessage);
  const wrapped = message.documentWithCaptionMessage?.message?.documentMessage;
  if (wrapped) return describeNode('document', wrapped);
  return null;
}

function formatSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} kB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render media info as a single mediaRefs string, filename-first so the
 * ingest side (which titles caption-less threads from the first ref) shows
 * something meaningful: `report.pdf (application/pdf, 1.2 MB)`,
 * `image (image/jpeg, 245 kB)`.
 */
export function formatMediaRef(info: CaptureMediaInfo): string {
  const name = info.fileName ?? info.kind;
  const details = [info.mimetype, info.sizeBytes !== null ? formatSize(info.sizeBytes) : null]
    .filter((part): part is string => part !== null);
  return details.length > 0 ? `${name} (${details.join(', ')})` : name;
}

/**
 * Mirrors captured allowlisted-group WhatsApp messages to the clear-api
 * ground-ingest endpoint (WhatsApp Signal Pipeline V2 transport). Same
 * fire-and-forget pattern as NotionCaptureSync: callers enqueue and move
 * on; a single worker drains the queue in batches. Nothing in here may
 * throw into the gateway's message loop.
 *
 * Consent is enforced server-side: clear-api rejects any batch containing
 * a group JID without recorded message-content consent (403). That is an
 * expected outcome for allowlisted-but-unconsented groups, so 403s are
 * logged quietly and never retried.
 *
 * Dedupe is in-memory (per process); the endpoint itself is idempotent on
 * (source, messageId), so redelivery across restarts is harmless.
 */
export class ClearCaptureSync {
  private readonly ingestUrl: string;
  private readonly apiKey: string;
  private readonly minIntervalMs: number;
  private queue: ClearCaptureMessage[] = [];
  private seen = new Set<string>();
  private draining = false;

  constructor(baseUrl: string, apiKey: string, options?: { minIntervalMs?: number }) {
    this.ingestUrl = `${baseUrl.replace(/\/+$/, '')}${INGEST_PATH}`;
    this.apiKey = apiKey;
    this.minIntervalMs = options?.minIntervalMs ?? MIN_INTERVAL_MS;
  }

  /** Returns null (with a log) when the env isn't configured, so callers can no-op. */
  static fromEnv(): ClearCaptureSync | null {
    const baseUrl = process.env.CLEAR_API_URL;
    const apiKey = process.env.CLEAR_GROUND_API_KEY;
    if (!baseUrl || !apiKey) {
      logger.info('CLEAR_API_URL / CLEAR_GROUND_API_KEY not set — clear-api ground capture disabled');
      return null;
    }
    return new ClearCaptureSync(baseUrl, apiKey);
  }

  enqueue(message: ClearCaptureMessage): void {
    const dedupeKey = `${message.groupJid}:${message.messageId}`;
    if (this.seen.has(dedupeKey)) return;
    this.seen.add(dedupeKey);

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      const dropped = this.queue.shift();
      logger.warn(`clear-api capture queue full (${MAX_QUEUE_SIZE}); dropped oldest message ${dropped?.messageId}`);
    }
    this.queue.push(message);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, MAX_BATCH);
        try {
          await this.postBatch(batch);
        } catch (err) {
          // Fire-and-forget: log and move on. The endpoint's idempotency
          // means anything re-enqueued later (e.g. after restart via
          // upstream redelivery) creates no duplicates.
          logger.error(`Failed to mirror ${batch.length} message(s) to clear-api:`, err);
        }
        if (this.queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, this.minIntervalMs));
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async postBatch(batch: ClearCaptureMessage[]): Promise<void> {
    const res = await fetch(this.ingestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: batch.map(m => ({
          groupJid: m.groupJid,
          messageId: m.messageId,
          senderJid: m.senderJid,
          senderName: m.senderName ?? null,
          timestamp: m.timestamp.toISOString(),
          text: m.text ?? null,
          ...(m.mediaRefs && m.mediaRefs.length > 0 ? { mediaRefs: m.mediaRefs } : {}),
          ...(m.isEdited !== undefined ? { isEdited: m.isEdited } : {}),
        })),
      }),
    });

    if (res.status === 403) {
      // Consent gate — expected for groups on the capture allowlist whose
      // clear-api consent record doesn't (yet) cover message content.
      // Nothing was persisted server-side; do not retry.
      const body = await res.text().catch(() => '');
      logger.info(
        `clear-api consent gate rejected ${batch.length} message(s) (not retried): ${body.slice(0, 500)}`,
      );
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`clear-api ingest ${res.status}: ${body.slice(0, 500)}`);
    }
  }
}
