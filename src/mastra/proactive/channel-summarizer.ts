/**
 * Periodic channel summarizer (ADR-0023, exponential repo).
 *
 * A new gateway job, separate from the per-message Notion writer (untouched):
 * once per cadence, for each watched WhatsApp group, summarize the traffic
 * since the group's last summary and push ONE finished summary to exponential's
 * `mastra.recordChannelSummary` endpoint. Raw messages never leave mastra.
 *
 * Design (ADR-0023):
 *   - The cadence is a global env constant `WHATSAPP_SUMMARY_INTERVAL_HOURS`
 *     (default 24); the *watching* authority remains `WHATSAPP_CAPTURE_GROUP_JIDS`.
 *   - Window = "since `lastSummarizedAt`" (half-open). Zero messages → no LLM
 *     call, no POST. An LLM "nothing project-relevant" result → no POST.
 *   - The watermark advances ONLY after a 2xx, so a failed/dropped delivery
 *     re-summarizes the same window next run (at-least-once; exponential dedups).
 *
 * The window math (`computeWindow`) and the post/skip decision (`shouldPost`)
 * are pure functions; the LLM call and HTTP POST are thin shells around them.
 * `runChannelSummarizer` takes its side-effecting collaborators as injectable
 * dependencies so the orchestration is unit-testable without network/LLM/DB.
 */
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

import { createLogger } from '../utils/logger.js';
import { decryptToken } from '../utils/gateway-shared.js';
import { authenticatedTrpcCall } from '../utils/authenticated-fetch.js';
import {
  getGroupDisplayName,
  getLastSummarizedAt,
  readWindowMessages,
  setLastSummarizedAt,
  type WindowMessage,
} from '../bots/channel-summary-store.js';

export type { WindowMessage } from '../bots/channel-summary-store.js';

const logger = createLogger({ name: 'ChannelSummarizer', level: 'info' });

const PROVIDER = 'whatsapp';
const DEFAULT_INTERVAL_HOURS = 24;

export interface SummaryWindow {
  start: Date | null;
  end: Date;
}

/**
 * Half-open window `(start, end]` to summarize. `start` is the last watermark;
 * on the first-ever run (no watermark) it bootstraps to one cadence interval
 * before `now` so a fresh group doesn't summarize its entire history at once.
 */
export function computeWindow(
  lastSummarizedAt: Date | null,
  now: Date,
  intervalHours = DEFAULT_INTERVAL_HOURS,
): SummaryWindow {
  if (lastSummarizedAt) {
    return { start: lastSummarizedAt, end: now };
  }
  return {
    start: new Date(now.getTime() - intervalHours * 60 * 60 * 1000),
    end: now,
  };
}

/**
 * Whether a summary should be POSTed: only when the window had messages AND the
 * model returned non-empty, project-relevant signal. Empty / whitespace-only
 * results are the model's "nothing happened" signal and are suppressed.
 */
export function shouldPost(messageCount: number, llmResult: string): boolean {
  return messageCount > 0 && llmResult.trim().length > 0;
}

/** Read the cadence (hours) from the env, falling back to the default. */
export function summaryIntervalHours(): number {
  const raw = Number(process.env.WHATSAPP_SUMMARY_INTERVAL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_HOURS;
}

/** Parse the watched-group allowlist (the *watching* authority). */
export function watchedGroupJids(): string[] {
  return (process.env.WHATSAPP_CAPTURE_GROUP_JIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const SUMMARY_SYSTEM_PROMPT = [
  'You summarize a window of group-chat messages into a short status update for a',
  'workspace activity feed. Surface only project-relevant signal: decisions,',
  'blockers, requests, commitments, deadlines, and notable updates. Name people by',
  'their display name. Be concise — a few sentences at most, no preamble.',
  '',
  'CRITICAL: if nothing project-relevant happened (idle chatter, greetings,',
  'off-topic banter, or nothing of substance), reply with an EMPTY string and',
  'nothing else. Never invent activity. Never write "no significant activity" or',
  'any filler — an empty reply means "skip".',
].join(' ');

/** Render captured messages into a compact transcript for the model. */
function renderTranscript(messages: WindowMessage[]): string {
  return messages
    .map((m) => `${m.senderName ?? 'Unknown'}: ${m.text}`)
    .join('\n');
}

/**
 * LLM summarization (thin shell around the model). Returns trimmed text; an
 * empty string means "nothing project-relevant — suppress".
 */
export async function summarizeMessages(
  messages: WindowMessage[],
): Promise<string> {
  const { text } = await generateText({
    model: openai('gpt-4o-mini'),
    system: SUMMARY_SYSTEM_PROMPT,
    prompt: renderTranscript(messages),
  });
  return text.trim();
}

export interface RecordChannelSummaryPayload {
  provider: string;
  externalId: string;
  summary: string;
  displayName?: string;
  windowStart: string;
  windowEnd: string;
  messageCount: number;
}

/** Injectable collaborators — defaulted to the real implementations. */
export interface ChannelSummarizerDeps {
  now: () => Date;
  intervalHours: number;
  jids: string[];
  getConnectedUsers: () => Array<{
    sessionId: string;
    userId: string;
    isConnected: boolean;
    encryptedAuthToken?: string;
  }>;
  decrypt: (encrypted: string) => string | null;
  getLastSummarizedAt: (userId: string, jid: string) => Promise<Date | null>;
  setLastSummarizedAt: (userId: string, jid: string, at: Date) => Promise<void>;
  readWindowMessages: (
    userId: string,
    jid: string,
    start: Date | null,
    end: Date,
  ) => Promise<WindowMessage[]>;
  getGroupDisplayName: (userId: string, jid: string) => Promise<string | null>;
  summarize: (messages: WindowMessage[]) => Promise<string>;
  post: (
    payload: RecordChannelSummaryPayload,
    auth: { authToken: string; userId: string; sessionId: string },
  ) => Promise<void>;
}

export interface ChannelSummarizerStats {
  groups: number;
  posted: number;
  skipped: number;
  errors: number;
}

async function defaultGetConnectedUsers() {
  const { getWhatsAppGateway } = await import('../bots/whatsapp-gateway.js');
  const gateway = getWhatsAppGateway();
  return gateway ? gateway.getConnectedUsers() : [];
}

/** Default POST shell: throws on non-2xx (authenticatedTrpcCall throws). */
async function defaultPost(
  payload: RecordChannelSummaryPayload,
  auth: { authToken: string; userId: string; sessionId: string },
): Promise<void> {
  await authenticatedTrpcCall('mastra.recordChannelSummary', payload, {
    authToken: auth.authToken,
    userId: auth.userId,
    sessionId: auth.sessionId,
    tokenKind: 'whatsapp-gateway',
  });
}

function resolveDeps(
  overrides?: Partial<ChannelSummarizerDeps>,
): ChannelSummarizerDeps {
  return {
    now: () => new Date(),
    intervalHours: summaryIntervalHours(),
    jids: watchedGroupJids(),
    // Real connected-users come from the gateway via defaultGetConnectedUsers()
    // (resolved lazily in runChannelSummarizer to avoid a load-time circular
    // import); this default is only the fallback when nothing is injected.
    getConnectedUsers: () => [],
    decrypt: (encrypted: string) =>
      decryptToken(encrypted, process.env.AUTH_SECRET ?? ''),
    getLastSummarizedAt,
    setLastSummarizedAt,
    readWindowMessages,
    getGroupDisplayName,
    summarize: summarizeMessages,
    post: defaultPost,
    ...overrides,
  };
}

/**
 * One summarization pass over every watched group, for every connected user
 * whose session has captured it. Returns run stats. Never throws — per-group
 * failures are logged and counted so one bad group can't abort the rest.
 */
export async function runChannelSummarizer(
  overrides?: Partial<ChannelSummarizerDeps>,
): Promise<ChannelSummarizerStats> {
  const deps = resolveDeps(overrides);
  const stats: ChannelSummarizerStats = {
    groups: 0,
    posted: 0,
    skipped: 0,
    errors: 0,
  };

  if (deps.jids.length === 0) {
    logger.info('No watched groups (WHATSAPP_CAPTURE_GROUP_JIDS empty); nothing to summarize');
    return stats;
  }

  const usersFromOverride = overrides?.getConnectedUsers;
  const users = usersFromOverride
    ? usersFromOverride()
    : await defaultGetConnectedUsers();
  const connected = users.filter((u) => u.isConnected && u.encryptedAuthToken);

  if (connected.length === 0) {
    logger.info('No connected users with auth tokens; nothing to summarize');
    return stats;
  }

  for (const user of connected) {
    const authToken = deps.decrypt(user.encryptedAuthToken!);
    if (!authToken) {
      logger.warn(`Failed to decrypt token for user ${user.userId}; skipping`);
      continue;
    }

    for (const jid of deps.jids) {
      stats.groups++;
      try {
        const now = deps.now();
        const last = await deps.getLastSummarizedAt(user.userId, jid);
        const window = computeWindow(last, now, deps.intervalHours);
        const messages = await deps.readWindowMessages(
          user.userId,
          jid,
          window.start,
          window.end,
        );

        // Zero-message windows: no LLM call, no POST (and no watermark move).
        if (messages.length === 0) {
          stats.skipped++;
          continue;
        }

        const summary = await deps.summarize(messages);
        if (!shouldPost(messages.length, summary)) {
          // Nothing project-relevant — suppress; leave the watermark so the
          // window re-evaluates with later context next run.
          stats.skipped++;
          continue;
        }

        const displayName = await deps.getGroupDisplayName(user.userId, jid);
        await deps.post(
          {
            provider: PROVIDER,
            externalId: jid,
            summary,
            displayName: displayName ?? undefined,
            windowStart: (window.start ?? window.end).toISOString(),
            windowEnd: window.end.toISOString(),
            messageCount: messages.length,
          },
          { authToken, userId: user.userId, sessionId: user.sessionId },
        );

        // Advance the watermark ONLY after a confirmed 2xx (post() resolved).
        await deps.setLastSummarizedAt(user.userId, jid, window.end);
        stats.posted++;
      } catch (error) {
        stats.errors++;
        logger.error(
          `Channel summary failed for user ${user.userId} group ${jid}:`,
          error,
        );
      }
    }
  }

  logger.info(
    `Channel summarizer pass complete: ${stats.posted} posted, ` +
      `${stats.skipped} skipped, ${stats.errors} error(s) over ${stats.groups} group-checks`,
  );
  return stats;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Register the periodic summarizer on the cadence env (default 24h). Opt-in via
 * `ENABLE_CHANNEL_SUMMARIZER=true` so it never fires against prod data during a
 * local `mastra dev` boot. Safe to call once at gateway startup.
 */
export function startChannelSummarizer(): void {
  if (process.env.ENABLE_CHANNEL_SUMMARIZER !== 'true') {
    logger.info(
      'Channel summarizer disabled (set ENABLE_CHANNEL_SUMMARIZER=true to enable)',
    );
    return;
  }
  if (timer) return;

  const intervalMs = summaryIntervalHours() * 60 * 60 * 1000;
  timer = setInterval(() => {
    runChannelSummarizer().catch((err) => {
      logger.error('Channel summarizer run failed:', err);
    });
  }, intervalMs);
  // Don't keep the event loop alive solely for this timer.
  timer.unref?.();
  logger.info(
    `Channel summarizer started (every ${summaryIntervalHours()}h)`,
  );
}

export function stopChannelSummarizer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
