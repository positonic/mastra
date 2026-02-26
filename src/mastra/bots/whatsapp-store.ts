import { PgVector } from '@mastra/pg';
import { openai } from '@ai-sdk/openai';
import { embed } from 'ai';
import pg from 'pg';
import { createLogger } from '@mastra/core/logger';

const logger = createLogger({
  name: 'WhatsAppStore',
  level: 'info',
});

// Types
export interface ChatMeta {
  contactName?: string;
  pushName?: string;
  phoneNumber?: string | null;
  isGroup?: boolean;
}

export interface StoredMessage {
  jid: string;
  messageId: string;
  fromMe: boolean;
  text: string;
  timestamp: Date;
  senderName?: string;
}

export interface ChatSummary {
  jid: string;
  phoneNumber: string | null;
  contactName: string | null;
  pushName: string | null;
  isGroup: boolean;
  lastMessageAt: string | null;
  messageCount: number;
}

export interface MessageRecord {
  messageId: string;
  fromMe: boolean;
  text: string;
  timestamp: string;
  senderName: string | null;
  contactName?: string | null;
  phoneNumber?: string | null;
  jid?: string;
}

export interface SemanticResult {
  text: string;
  fromMe: boolean;
  timestamp: string;
  senderName: string | null;
  contactName: string | null;
  phoneNumber: string | null;
  jid: string;
  relevance: number;
}

interface EmbeddingQueueItem {
  id: string;
  text: string;
  metadata: Record<string, any>;
}

// Constants
const MIN_EMBEDDING_LENGTH = 20;
const EMBEDDING_BATCH_SIZE = 20;
const EMBEDDING_FLUSH_INTERVAL_MS = 5000;
const VECTOR_INDEX_NAME = 'whatsapp_message_embeddings';
const SCHEMA_NAME = 'whatsapp_messages';

// Backoff constants for quota errors
const INITIAL_BACKOFF_MS = 60_000;     // 1 minute
const MAX_BACKOFF_MS = 30 * 60_000;    // 30 minutes
const MAX_QUEUE_SIZE = 500;            // Drop oldest messages if queue grows too large

export class WhatsAppMessageStore {
  private vectorStore: PgVector;
  private pool: pg.Pool;
  private embeddingQueue: EmbeddingQueueItem[] = [];
  private embedBatchTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private embeddingBackoffUntil: number = 0;   // Timestamp until which we skip embedding
  private embeddingBackoffMs: number = 0;       // Current backoff duration

  constructor() {
    this.vectorStore = new PgVector({
      id: 'whatsapp-messages',
      connectionString: process.env.DATABASE_URL!,
      schemaName: SCHEMA_NAME,
    });
    this.pool = this.vectorStore.pool;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    // Create schema
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA_NAME}`);

    // Create chats table
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.chats (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        jid           TEXT NOT NULL,
        phone_number  TEXT,
        contact_name  TEXT,
        push_name     TEXT,
        is_group      BOOLEAN DEFAULT false,
        last_message_at TIMESTAMPTZ,
        message_count INTEGER DEFAULT 0,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, jid)
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_wa_chats_user_id
      ON ${SCHEMA_NAME}.chats(user_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_wa_chats_last_message
      ON ${SCHEMA_NAME}.chats(user_id, last_message_at DESC)
    `);

    // Create messages table
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.messages (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        chat_id       TEXT NOT NULL REFERENCES ${SCHEMA_NAME}.chats(id),
        jid           TEXT NOT NULL,
        message_id    TEXT NOT NULL,
        from_me       BOOLEAN NOT NULL,
        text          TEXT NOT NULL,
        timestamp     TIMESTAMPTZ NOT NULL,
        sender_name   TEXT,
        has_embedding BOOLEAN DEFAULT false,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, message_id)
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_wa_messages_chat
      ON ${SCHEMA_NAME}.messages(chat_id, timestamp DESC)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_wa_messages_user_time
      ON ${SCHEMA_NAME}.messages(user_id, timestamp DESC)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_wa_messages_text_search
      ON ${SCHEMA_NAME}.messages USING gin(to_tsvector('english', text))
    `);

    // Create vector index for semantic search
    await this.vectorStore.createIndex({
      indexName: VECTOR_INDEX_NAME,
      dimension: 1536,
      metric: 'cosine',
    });

    // Start the embedding flush timer
    this.embedBatchTimer = setInterval(() => {
      this.flushEmbeddingQueue().catch(err => {
        logger.error('Error flushing embedding queue:', err);
      });
    }, EMBEDDING_FLUSH_INTERVAL_MS);

    this.initialized = true;
    logger.info('WhatsApp message store initialized');
  }

  // ── Chat management ──

  async ensureChat(userId: string, jid: string, meta?: ChatMeta): Promise<string> {
    const chatId = `${userId}:${jid}`;

    await this.pool.query(`
      INSERT INTO ${SCHEMA_NAME}.chats (id, user_id, jid, phone_number, contact_name, push_name, is_group)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, jid) DO UPDATE SET
        phone_number = COALESCE(EXCLUDED.phone_number, ${SCHEMA_NAME}.chats.phone_number),
        contact_name = COALESCE(EXCLUDED.contact_name, ${SCHEMA_NAME}.chats.contact_name),
        push_name = COALESCE(EXCLUDED.push_name, ${SCHEMA_NAME}.chats.push_name),
        is_group = COALESCE(EXCLUDED.is_group, ${SCHEMA_NAME}.chats.is_group),
        updated_at = NOW()
    `, [
      chatId,
      userId,
      jid,
      meta?.phoneNumber ?? null,
      meta?.contactName ?? null,
      meta?.pushName ?? null,
      meta?.isGroup ?? false,
    ]);

    return chatId;
  }

  // ── Message storage ──

  async storeMessage(userId: string, msg: StoredMessage): Promise<void> {
    const chatId = await this.ensureChat(userId, msg.jid, {
      pushName: msg.senderName,
    });

    const msgId = `${userId}:${msg.messageId}`;

    await this.pool.query(`
      INSERT INTO ${SCHEMA_NAME}.messages (id, user_id, chat_id, jid, message_id, from_me, text, timestamp, sender_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (user_id, message_id) DO NOTHING
    `, [
      msgId,
      userId,
      chatId,
      msg.jid,
      msg.messageId,
      msg.fromMe,
      msg.text,
      msg.timestamp,
      msg.senderName ?? null,
    ]);

    // Update chat stats
    await this.pool.query(`
      UPDATE ${SCHEMA_NAME}.chats
      SET message_count = message_count + 1,
          last_message_at = GREATEST(last_message_at, $2),
          updated_at = NOW()
      WHERE id = $1
    `, [chatId, msg.timestamp]);

    // Queue embedding for non-trivial messages
    if (msg.text.length >= MIN_EMBEDDING_LENGTH) {
      this.queueEmbedding(msgId, msg.text, {
        userId,
        chatId,
        jid: msg.jid,
        messageId: msg.messageId,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp.toISOString(),
        senderName: msg.senderName || null,
      });
    }
  }

  async storeBatch(userId: string, messages: StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;

    // Process in chunks to avoid overwhelming the DB
    const CHUNK_SIZE = 100;
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      const chunk = messages.slice(i, i + CHUNK_SIZE);

      // Ensure chats exist for all JIDs in this chunk
      const jids = [...new Set(chunk.map(m => m.jid))];
      for (const jid of jids) {
        const firstMsg = chunk.find(m => m.jid === jid);
        await this.ensureChat(userId, jid, {
          pushName: firstMsg?.senderName,
        });
      }

      // Bulk insert messages
      for (const msg of chunk) {
        const chatId = `${userId}:${msg.jid}`;
        const msgId = `${userId}:${msg.messageId}`;

        try {
          await this.pool.query(`
            INSERT INTO ${SCHEMA_NAME}.messages (id, user_id, chat_id, jid, message_id, from_me, text, timestamp, sender_name)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (user_id, message_id) DO NOTHING
          `, [
            msgId,
            userId,
            chatId,
            msg.jid,
            msg.messageId,
            msg.fromMe,
            msg.text,
            msg.timestamp,
            msg.senderName ?? null,
          ]);
        } catch (err) {
          // Skip individual message failures during batch import
          logger.debug(`Skipping message ${msg.messageId}: ${err}`);
        }
      }

      // Update chat stats for all affected chats
      for (const jid of jids) {
        const chatId = `${userId}:${jid}`;
        const chatMsgs = chunk.filter(m => m.jid === jid);
        const latestTimestamp = chatMsgs.reduce(
          (max, m) => m.timestamp > max ? m.timestamp : max,
          chatMsgs[0].timestamp,
        );

        await this.pool.query(`
          UPDATE ${SCHEMA_NAME}.chats
          SET message_count = (
            SELECT COUNT(*) FROM ${SCHEMA_NAME}.messages WHERE chat_id = $1
          ),
          last_message_at = GREATEST(last_message_at, $2),
          updated_at = NOW()
          WHERE id = $1
        `, [chatId, latestTimestamp]);
      }
    }

    logger.info(`Stored batch of ${messages.length} messages for user ${userId}`);
  }

  // ── Search and query methods ──

  async listChats(
    userId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{ chats: ChatSummary[]; total: number }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM ${SCHEMA_NAME}.chats WHERE user_id = $1`,
      [userId],
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const result = await this.pool.query(`
      SELECT jid, phone_number, contact_name, push_name, is_group, last_message_at, message_count
      FROM ${SCHEMA_NAME}.chats
      WHERE user_id = $1
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    return {
      chats: result.rows.map(row => ({
        jid: row.jid,
        phoneNumber: row.phone_number,
        contactName: row.contact_name,
        pushName: row.push_name,
        isGroup: row.is_group,
        lastMessageAt: row.last_message_at?.toISOString() ?? null,
        messageCount: row.message_count,
      })),
      total,
    };
  }

  async getChatHistory(
    userId: string,
    jid: string,
    opts?: { limit?: number; before?: Date },
  ): Promise<{
    messages: MessageRecord[];
    chatInfo: { contactName: string | null; phoneNumber: string | null; totalMessages: number };
    hasMore: boolean;
  }> {
    const limit = opts?.limit ?? 50;
    const chatId = `${userId}:${jid}`;

    // Get chat info
    const chatResult = await this.pool.query(
      `SELECT contact_name, phone_number, message_count FROM ${SCHEMA_NAME}.chats WHERE id = $1`,
      [chatId],
    );

    const chatInfo = chatResult.rows[0]
      ? {
          contactName: chatResult.rows[0].contact_name,
          phoneNumber: chatResult.rows[0].phone_number,
          totalMessages: chatResult.rows[0].message_count,
        }
      : { contactName: null, phoneNumber: null, totalMessages: 0 };

    // Get messages
    const params: any[] = [chatId, limit + 1]; // fetch one extra to check hasMore
    let beforeClause = '';
    if (opts?.before) {
      beforeClause = 'AND m.timestamp < $3';
      params.push(opts.before);
    }

    const result = await this.pool.query(`
      SELECT m.message_id, m.from_me, m.text, m.timestamp, m.sender_name
      FROM ${SCHEMA_NAME}.messages m
      WHERE m.chat_id = $1 ${beforeClause}
      ORDER BY m.timestamp DESC
      LIMIT $2
    `, params);

    const hasMore = result.rows.length > limit;
    const messages = result.rows.slice(0, limit).reverse().map(row => ({
      messageId: row.message_id,
      fromMe: row.from_me,
      text: row.text,
      timestamp: row.timestamp.toISOString(),
      senderName: row.sender_name,
    }));

    return { messages, chatInfo, hasMore };
  }

  async searchKeyword(
    userId: string,
    query: string,
    opts?: { jid?: string; limit?: number },
  ): Promise<MessageRecord[]> {
    // Build tsquery from the search terms
    const tsQuery = query
      .split(/\s+/)
      .filter(w => w.length > 0)
      .join(' & ');

    if (!tsQuery) return [];

    const params: any[] = [userId, tsQuery];
    let jidFilter = '';
    if (opts?.jid) {
      jidFilter = 'AND m.jid = $3';
      params.push(opts.jid);
    }
    params.push(opts?.limit ?? 20);

    const result = await this.pool.query(`
      SELECT m.message_id, m.from_me, m.text, m.timestamp, m.sender_name,
             m.jid, c.contact_name, c.phone_number,
             ts_rank(to_tsvector('english', m.text), to_tsquery('english', $2)) AS rank
      FROM ${SCHEMA_NAME}.messages m
      JOIN ${SCHEMA_NAME}.chats c ON m.chat_id = c.id
      WHERE m.user_id = $1
        AND to_tsvector('english', m.text) @@ to_tsquery('english', $2)
        ${jidFilter}
      ORDER BY rank DESC, m.timestamp DESC
      LIMIT $${params.length}
    `, params);

    return result.rows.map(row => ({
      messageId: row.message_id,
      fromMe: row.from_me,
      text: row.text,
      timestamp: row.timestamp.toISOString(),
      senderName: row.sender_name,
      contactName: row.contact_name,
      phoneNumber: row.phone_number,
      jid: row.jid,
    }));
  }

  async searchSemantic(
    userId: string,
    query: string,
    opts?: { jid?: string; topK?: number },
  ): Promise<SemanticResult[]> {
    const { embedding } = await embed({
      model: openai.embedding('text-embedding-3-small'),
      value: query,
    });

    const filter: Record<string, any> = { userId };
    if (opts?.jid) {
      filter.jid = opts.jid;
    }

    const results = await this.vectorStore.query({
      indexName: VECTOR_INDEX_NAME,
      queryVector: embedding,
      topK: opts?.topK ?? 10,
      filter,
    });

    return results.map(r => ({
      text: (r.metadata?.content as string) || '',
      fromMe: (r.metadata?.fromMe as boolean) || false,
      timestamp: (r.metadata?.timestamp as string) || '',
      senderName: (r.metadata?.senderName as string) || null,
      contactName: null, // Not stored in vector metadata
      phoneNumber: null,
      jid: (r.metadata?.jid as string) || '',
      relevance: r.score || 0,
    }));
  }

  // ── Embedding queue ──

  private queueEmbedding(id: string, text: string, metadata: Record<string, any>): void {
    // Drop oldest messages if queue grows too large (quota exhaustion scenario)
    if (this.embeddingQueue.length >= MAX_QUEUE_SIZE) {
      const dropped = this.embeddingQueue.splice(0, this.embeddingQueue.length - MAX_QUEUE_SIZE + 1);
      logger.warn(`⚠️ Embedding queue overflow: dropped ${dropped.length} oldest messages`);
    }

    this.embeddingQueue.push({ id, text, metadata });

    // Flush immediately if batch is full
    if (this.embeddingQueue.length >= EMBEDDING_BATCH_SIZE) {
      this.flushEmbeddingQueue().catch(err => {
        logger.error('Error flushing embedding queue:', err);
      });
    }
  }

  private isQuotaError(error: unknown): boolean {
    const msg = String(error);
    return msg.includes('insufficient_quota') ||
      msg.includes('exceeded your current quota') ||
      (typeof error === 'object' && error !== null && 'statusCode' in error && (error as any).statusCode === 429);
  }

  private async flushEmbeddingQueue(): Promise<void> {
    if (this.embeddingQueue.length === 0) return;

    // Respect backoff — don't attempt embeddings while backing off
    if (Date.now() < this.embeddingBackoffUntil) {
      return;
    }

    const batch = this.embeddingQueue.splice(0, EMBEDDING_BATCH_SIZE);
    const embeddings: number[][] = [];
    const metadataArray: Record<string, any>[] = [];
    const ids: string[] = [];
    let quotaHit = false;

    for (const item of batch) {
      if (quotaHit) {
        // Re-queue remaining items — don't waste API calls
        this.embeddingQueue.unshift(item);
        continue;
      }

      try {
        const { embedding } = await embed({
          model: openai.embedding('text-embedding-3-small'),
          value: item.text,
        });
        embeddings.push(embedding);
        metadataArray.push({ ...item.metadata, content: item.text });
        ids.push(item.id);

        // Reset backoff on success
        if (this.embeddingBackoffMs > 0) {
          logger.info('✅ Embedding quota restored, resuming normal operation');
          this.embeddingBackoffMs = 0;
          this.embeddingBackoffUntil = 0;
        }
      } catch (error) {
        if (this.isQuotaError(error)) {
          quotaHit = true;
          // Re-queue this item for retry
          this.embeddingQueue.unshift(item);

          // Exponential backoff
          this.embeddingBackoffMs = this.embeddingBackoffMs === 0
            ? INITIAL_BACKOFF_MS
            : Math.min(this.embeddingBackoffMs * 2, MAX_BACKOFF_MS);
          this.embeddingBackoffUntil = Date.now() + this.embeddingBackoffMs;

          const mins = Math.round(this.embeddingBackoffMs / 60_000);
          logger.warn(
            `⚠️ OpenAI quota exceeded — pausing embeddings for ${mins}m ` +
            `(${this.embeddingQueue.length} messages queued)`
          );
        } else {
          // Non-quota error: log and drop the message (not retryable)
          logger.error(`Failed to embed message ${item.id}:`, error);
        }
      }
    }

    if (embeddings.length > 0) {
      try {
        await this.vectorStore.upsert({
          indexName: VECTOR_INDEX_NAME,
          vectors: embeddings,
          metadata: metadataArray,
          ids,
        });

        // Mark messages as having embeddings
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
        await this.pool.query(
          `UPDATE ${SCHEMA_NAME}.messages SET has_embedding = true WHERE id IN (${placeholders})`,
          ids,
        );

        logger.debug(`Embedded ${embeddings.length} messages`);
      } catch (error) {
        logger.error('Failed to upsert embeddings:', error);
      }
    }
  }

  // ── Lifecycle ──

  async shutdown(): Promise<void> {
    if (this.embedBatchTimer) {
      clearInterval(this.embedBatchTimer);
      this.embedBatchTimer = null;
    }

    // Final flush
    await this.flushEmbeddingQueue();

    logger.info('WhatsApp message store shut down');
  }
}

// Singleton
let globalStore: WhatsAppMessageStore | null = null;

export function getWhatsAppMessageStore(): WhatsAppMessageStore {
  if (!globalStore) {
    globalStore = new WhatsAppMessageStore();
  }
  return globalStore;
}
