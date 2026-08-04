import { createLogger } from '../utils/logger.js';

const logger = createLogger({ name: 'ClearCapture', level: 'info' });

const INGEST_PATH = '/api/ground/ingest';
const MEDIA_PATH = '/api/ground/media';
// The endpoint accepts up to 500 messages per request; stay well under it so
// a single failed POST never loses a huge slice of the queue.
const MAX_BATCH = 100;
// Pacing between POSTs while draining. The endpoint is our own; this is just
// politeness so a burst (e.g. reconnect replay) doesn't hammer it.
const MIN_INTERVAL_MS = 500;
const MAX_QUEUE_SIZE = 2000;
// The media endpoint rejects payloads over 50 MB with a 413; precheck so we
// never download/transfer bytes that are doomed to be refused.
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
// A media message waits at most this long for its download + upload before
// the mirror gives up and ships the message with metadata refs only.
const MEDIA_TIMEOUT_MS = 60_000;
// Media uploads queue separately from the ingest batches (they are slow and
// large). Past this depth a reconnect replay of a media-heavy group would
// stall the mirror, so further messages degrade straight to metadata refs.
const MAX_MEDIA_QUEUE_SIZE = 200;

/**
 * One captured group message, in the shape the clear-api live-ingest
 * endpoint accepts (see clear-api src/routes/ground-ingest.ts):
 * `{ groupJid, messageId, senderJid, senderName?, timestamp, text?,
 *   mediaKeys?, mediaRefs?, isEdited? }`.
 *
 * `mediaKeys` (S3 keys) come from `POST /api/ground/media`: when a message
 * carries `media`, the mirror downloads the bytes and uploads them first,
 * then ships the returned key inside the ingest payload. Any media failure
 * degrades to the metadata refs alone — text mirroring is never blocked.
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
  /** Media bytes to upload before ingest. The download is injected so the
   * sync never touches a Baileys socket (and tests stay hermetic). */
  media?: ClearCaptureMedia;
  /** S3 keys returned by the media upload. Filled in by the sync itself —
   * callers only supply `media`. */
  mediaKeys?: string[];
}

export interface ClearCaptureMedia {
  info: CaptureMediaInfo;
  /** Downloads the media bytes (gateway: Baileys downloadMediaMessage). */
  download: () => Promise<Uint8Array>;
}

/**
 * Media metadata extracted from a Baileys message for the mirror payload.
 * Used both for the human-readable refs and for the byte upload (filename,
 * content type, size precheck).
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

/** Extensions for the mimetypes WhatsApp actually sends; the upload part's
 * filename supplies the stored object's extension. */
const EXT_BY_MIMETYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
};

/** Filename for the multipart file part: the real filename when the proto
 * has one (documents), otherwise `image.jpg` style from the mimetype. */
export function mediaFileName(info: CaptureMediaInfo): string {
  if (info.fileName) return info.fileName;
  const mimetype = info.mimetype?.split(';')[0]?.trim().toLowerCase() ?? '';
  const ext = EXT_BY_MIMETYPE[mimetype] ?? mimetype.split('/')[1] ?? 'bin';
  return `${info.kind}.${ext || 'bin'}`;
}

/** Bound a promise without cancelling the underlying work (Baileys media
 * downloads are not abortable); the mirror just stops waiting. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
  private readonly mediaUrl: string;
  private readonly apiKey: string;
  private readonly minIntervalMs: number;
  private readonly mediaTimeoutMs: number;
  private queue: ClearCaptureMessage[] = [];
  private seen = new Set<string>();
  private draining = false;
  /** Media messages waiting for their byte upload, single-flight like the
   * ingest drain. Each one joins the ingest queue once its upload attempt
   * resolves (with mediaKeys on success, metadata refs alone otherwise). */
  private mediaQueue: ClearCaptureMessage[] = [];
  private mediaDraining = false;

  constructor(
    baseUrl: string,
    apiKey: string,
    options?: { minIntervalMs?: number; mediaTimeoutMs?: number },
  ) {
    const base = baseUrl.replace(/\/+$/, '');
    this.ingestUrl = `${base}${INGEST_PATH}`;
    this.mediaUrl = `${base}${MEDIA_PATH}`;
    this.apiKey = apiKey;
    this.minIntervalMs = options?.minIntervalMs ?? MIN_INTERVAL_MS;
    this.mediaTimeoutMs = options?.mediaTimeoutMs ?? MEDIA_TIMEOUT_MS;
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

    // Media rides ahead of ingest: the upload's S3 key has to be in hand to
    // include as mediaKeys in the ingest payload (the contract accepts either
    // arrival order, but upload-first keeps the flow single-path). Text-only
    // messages skip straight to the ingest queue and are never delayed by a
    // media transfer.
    if (message.media) {
      if (this.mediaQueue.length >= MAX_MEDIA_QUEUE_SIZE) {
        logger.info(
          `clear-api media queue full (${MAX_MEDIA_QUEUE_SIZE}); message ${message.messageId} falls back to metadata refs`,
        );
        this.pushForIngest(message);
        return;
      }
      this.mediaQueue.push(message);
      void this.drainMedia();
      return;
    }

    this.pushForIngest(message);
  }

  private pushForIngest(message: ClearCaptureMessage): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      const dropped = this.queue.shift();
      logger.warn(`clear-api capture queue full (${MAX_QUEUE_SIZE}); dropped oldest message ${dropped?.messageId}`);
    }
    this.queue.push(message);
    void this.drain();
  }

  /**
   * Single-flight media worker. One upload attempt per message — success
   * attaches the S3 key; any failure (download error, timeout, 4xx/413,
   * oversize) logs at info and the message ships with metadata refs only.
   * Never throws, never retries.
   */
  private async drainMedia(): Promise<void> {
    if (this.mediaDraining) return;
    this.mediaDraining = true;
    try {
      while (this.mediaQueue.length > 0) {
        const message = this.mediaQueue.shift();
        if (!message) continue;
        try {
          const key = await this.uploadMedia(message);
          if (key) message.mediaKeys = [key];
        } catch (err) {
          logger.info(
            `media for message ${message.messageId} falls back to metadata refs: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.pushForIngest(message);
        if (this.mediaQueue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, this.minIntervalMs));
        }
      }
    } finally {
      this.mediaDraining = false;
    }
  }

  /**
   * Download the bytes and POST them to /api/ground/media. Returns the S3
   * key to ride the ingest payload, or null when the media was skipped for
   * an expected reason (oversize, consent gate) — throws for everything
   * else so drainMedia logs one info line.
   */
  private async uploadMedia(message: ClearCaptureMessage): Promise<string | null> {
    const media = message.media;
    if (!media) return null;
    const { info, download } = media;

    if (info.sizeBytes !== null && info.sizeBytes > MAX_MEDIA_BYTES) {
      logger.info(
        `skipping media upload for message ${message.messageId}: ${formatSize(info.sizeBytes)} exceeds the ${formatSize(MAX_MEDIA_BYTES)} limit`,
      );
      return null;
    }

    const bytes = await withTimeout(download(), this.mediaTimeoutMs, 'media download');
    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      // The proto's fileLength can be missing or wrong; recheck real bytes.
      logger.info(
        `skipping media upload for message ${message.messageId}: downloaded ${formatSize(bytes.byteLength)} exceeds the ${formatSize(MAX_MEDIA_BYTES)} limit`,
      );
      return null;
    }

    const form = new FormData();
    // The part filename supplies the stored extension; the part content
    // type becomes the S3 ContentType.
    form.append(
      'file',
      new Blob([bytes as BlobPart], { type: info.mimetype ?? 'application/octet-stream' }),
      mediaFileName(info),
    );
    form.append('groupJid', message.groupJid);
    form.append('sourceMessageExternalId', `whatsapp:${message.groupJid}:${message.messageId}`);

    const res = await fetch(this.mediaUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.mediaTimeoutMs),
    });

    if (res.status === 403) {
      // Consent gate — expected for allowlisted-but-unconsented groups.
      // Nothing was stored server-side; the ingest POST will be told the
      // same thing. Do not retry.
      const body = await res.text().catch(() => '');
      logger.info(
        `clear-api consent gate rejected media for message ${message.messageId} (not retried): ${body.slice(0, 500)}`,
      );
      return null;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`clear-api media ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json().catch(() => null)) as { key?: unknown } | null;
    return data && typeof data.key === 'string' && data.key.length > 0 ? data.key : null;
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
          ...(m.mediaKeys && m.mediaKeys.length > 0 ? { mediaKeys: m.mediaKeys } : {}),
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
