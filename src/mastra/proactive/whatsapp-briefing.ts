/**
 * WhatsApp Morning Briefing
 *
 * Fetches structured briefing data from Exponential's briefing.getMorningBriefing
 * tRPC endpoint and delivers WhatsApp-formatted messages to connected users.
 *
 * SECURITY: Template-based formatting only. No LLM in the loop.
 * All user-controlled strings are sanitized before interpolation.
 */

import { createLogger } from '@mastra/core/logger';
import { sanitizeForPrompt } from '../utils/content-safety.js';
import { decryptToken } from '../utils/gateway-shared.js';
import { authenticatedTrpcCall } from '../utils/authenticated-fetch.js';
import { captureException } from '../utils/sentry.js';

const logger = createLogger({
  name: 'WhatsAppBriefing',
  level: 'info',
});

// --- Types mirroring Exponential's briefing router response ---

interface BriefingCalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  isAllDay: boolean;
}

interface BriefingAction {
  id: string;
  name: string;
  dueDate: string | null;
  priority: string;
  projectName: string | null;
  isOverdue: boolean;
}

interface BriefingProject {
  id: string;
  name: string;
  progress: number;
  status: string;
  actionCount: number;
}

interface BriefingTranscription {
  id: string;
  title: string;
  summary: string | null;
  createdAt: string;
  projectName: string | null;
}

interface MorningBriefing {
  date: string;
  greeting: string;
  calendarEvents: BriefingCalendarEvent[];
  actionsDueToday: BriefingAction[];
  overdueActions: BriefingAction[];
  projectsNeedingAttention: BriefingProject[];
  recentMeetingNotes: BriefingTranscription[];
  summary: {
    totalEvents: number;
    totalActionsDue: number;
    totalOverdue: number;
    projectsAtRisk: number;
  };
}

// --- Sanitization & helpers ---

/**
 * Sanitize a user-controlled string for safe WhatsApp message interpolation.
 * Strips control characters, truncates, and removes WhatsApp formatting chars
 * that could break the template layout.
 */
function safeWA(text: string, maxLen = 80): string {
  let sanitized = sanitizeForPrompt(text, { maxLength: maxLen, flagSuspicious: false });
  // Strip WhatsApp formatting characters (no escape mechanism in WhatsApp)
  sanitized = sanitized.replace(/[*_~`]/g, '');
  return sanitized;
}

/** Format an ISO date string to a short time like "9:00" or "14:30". */
function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    return `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
  } catch {
    return '??:??';
  }
}

/** Calculate days between an ISO date string and now. */
function daysAgo(isoString: string): number {
  try {
    const date = new Date(isoString);
    const now = new Date();
    return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

// --- Formatter ---

/**
 * Format a MorningBriefing into a WhatsApp-friendly text message.
 *
 * SECURITY: Pure template function. No LLM. All user-controlled strings
 * are sanitized via safeWA() before interpolation.
 */
export function formatBriefingForWhatsApp(briefing: MorningBriefing): string {
  const sections: string[] = [];

  // Greeting (from server, sanitize since it includes the user's name)
  sections.push(safeWA(briefing.greeting, 200));

  // Calendar events
  if (briefing.calendarEvents.length > 0) {
    const lines = ['*📅 Calendar*'];
    const events = briefing.calendarEvents.slice(0, 8);
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const title = safeWA(event.title, 60);
      if (event.isAllDay) {
        lines.push(`${i + 1}. ${title} (all day)`);
      } else {
        lines.push(`${i + 1}. ${title} (${formatTime(event.start)} - ${formatTime(event.end)})`);
      }
    }
    if (briefing.calendarEvents.length > 8) {
      lines.push(`   +${briefing.calendarEvents.length - 8} more`);
    }
    sections.push(lines.join('\n'));
  }

  // Actions due today
  if (briefing.actionsDueToday.length > 0) {
    const lines = ['*📋 Due Today*'];
    const actions = briefing.actionsDueToday.slice(0, 8);
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const name = safeWA(action.name, 60);
      const project = action.projectName ? ` (${safeWA(action.projectName, 30)})` : '';
      lines.push(`${i + 1}. *${name}*${project}`);
    }
    if (briefing.actionsDueToday.length > 8) {
      lines.push(`   +${briefing.actionsDueToday.length - 8} more`);
    }
    sections.push(lines.join('\n'));
  }

  // Overdue actions
  if (briefing.overdueActions.length > 0) {
    const lines = ['*🔴 Overdue*'];
    const actions = briefing.overdueActions.slice(0, 8);
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const name = safeWA(action.name, 60);
      const overdueDays = action.dueDate ? daysAgo(action.dueDate) : '?';
      const project = action.projectName ? `, ${safeWA(action.projectName, 30)}` : '';
      lines.push(`${i + 1}. *${name}* (${overdueDays}d overdue${project})`);
    }
    if (briefing.overdueActions.length > 8) {
      lines.push(`   +${briefing.overdueActions.length - 8} more`);
    }
    sections.push(lines.join('\n'));
  }

  // Projects needing attention
  if (briefing.projectsNeedingAttention.length > 0) {
    const lines = ['*⚠️ Projects Needing Attention*'];
    const projects = briefing.projectsNeedingAttention.slice(0, 5);
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      const name = safeWA(project.name, 40);
      lines.push(`${i + 1}. *${name}* (${project.progress}% progress, ${project.actionCount} active actions)`);
    }
    if (briefing.projectsNeedingAttention.length > 5) {
      lines.push(`   +${briefing.projectsNeedingAttention.length - 5} more`);
    }
    sections.push(lines.join('\n'));
  }

  // Recent meeting notes
  if (briefing.recentMeetingNotes.length > 0) {
    const lines = ['*📝 Recent Meeting Notes*'];
    const notes = briefing.recentMeetingNotes.slice(0, 3);
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      const title = safeWA(note.title, 50);
      const project = note.projectName ? ` (${safeWA(note.projectName, 30)})` : '';
      lines.push(`${i + 1}. ${title}${project}`);
    }
    sections.push(lines.join('\n'));
  }

  // Empty briefing fallback
  if (sections.length === 1) {
    sections.push('Looks like a clear day ahead. No actions due and no calendar events.');
  }

  return sections.join('\n\n');
}

// --- Delivery service ---

const AUTH_SECRET = process.env.AUTH_SECRET;

/**
 * Deliver morning briefings to all connected WhatsApp users.
 *
 * For each connected session with a valid encrypted auth token:
 * 1. Decrypt the token
 * 2. Fetch the briefing from Exponential's tRPC endpoint
 * 3. Format for WhatsApp
 * 4. Send via the gateway's public sendTextMessage API
 *
 * Errors are logged and captured to Sentry per-user; a single user's
 * failure does not abort delivery to others.
 */
export async function deliverWhatsAppBriefings(): Promise<{
  attempted: number;
  sent: number;
  errors: number;
  skipped: number;
}> {
  const stats = { attempted: 0, sent: 0, errors: 0, skipped: 0 };

  // Dynamic import to avoid circular dependency at module load time
  const { getWhatsAppGateway } = await import('../bots/whatsapp-gateway.js');
  const gateway = getWhatsAppGateway();
  if (!gateway) {
    logger.info('📵 [WhatsAppBriefing] WhatsApp gateway not available, skipping');
    return stats;
  }

  if (!AUTH_SECRET) {
    logger.warn('⚠️ [WhatsAppBriefing] AUTH_SECRET not configured, cannot decrypt tokens');
    return stats;
  }

  const users = gateway.getConnectedUsers();
  const connectedUsers = users.filter(u => u.isConnected && u.encryptedAuthToken);

  if (connectedUsers.length === 0) {
    logger.info('📭 [WhatsAppBriefing] No connected WhatsApp users with auth tokens');
    return stats;
  }

  logger.info(`🌅 [WhatsAppBriefing] Starting morning briefing delivery for ${connectedUsers.length} user(s)`);

  for (const user of connectedUsers) {
    stats.attempted++;

    try {
      const authToken = decryptToken(user.encryptedAuthToken!, AUTH_SECRET);
      if (!authToken) {
        logger.warn(`⚠️ [WhatsAppBriefing] Failed to decrypt token for user ${user.userId}, skipping`);
        stats.skipped++;
        continue;
      }

      // Fetch morning briefing (workspaceId not required — endpoint returns cross-workspace data)
      const { data: briefing } = await authenticatedTrpcCall<MorningBriefing>(
        'briefing.getMorningBriefing',
        {},
        { authToken, userId: user.userId, sessionId: user.sessionId }
      );

      if (!briefing) {
        logger.warn(`⚠️ [WhatsAppBriefing] Empty briefing response for user ${user.userId}`);
        stats.skipped++;
        continue;
      }

      const message = formatBriefingForWhatsApp(briefing);

      const sent = await gateway.sendTextMessage(user.sessionId, message);
      if (sent) {
        stats.sent++;
        logger.info(`📤 [WhatsAppBriefing] Delivered to user ${user.userId} (session ${user.sessionId})`);
      } else {
        stats.errors++;
        logger.warn(`⚠️ [WhatsAppBriefing] sendTextMessage returned false for user ${user.userId}`);
      }
    } catch (error) {
      stats.errors++;
      logger.error(`❌ [WhatsAppBriefing] Failed for user ${user.userId}:`, error);
      captureException(error, {
        userId: user.userId,
        sessionId: user.sessionId,
        operation: 'deliverWhatsAppBriefings',
      });
    }
  }

  logger.info(
    `✅ [WhatsAppBriefing] Delivery complete: ` +
    `${stats.sent} sent, ${stats.errors} error(s), ${stats.skipped} skipped ` +
    `out of ${stats.attempted} attempted`
  );

  return stats;
}
