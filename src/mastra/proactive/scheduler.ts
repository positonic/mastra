/**
 * Proactive Scheduler
 *
 * Runs periodic checks for all paired Telegram users
 * and sends proactive notifications when issues are found.
 * Also delivers WhatsApp morning briefings to connected users.
 */

import cron from 'node-cron';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '@mastra/core/logger';
import { checkUser } from './checker.js';
import { initNotifier, notifyUser, formatDailyDigest } from './notifier.js';
import { deliverWhatsAppBriefings } from './whatsapp-briefing.js';
import { decryptToken } from '../utils/gateway-shared.js';
import type { UserContext } from './types.js';

const logger = createLogger({
  name: 'ProactiveScheduler',
  level: 'info',
});

// Configuration
const SESSIONS_DIR = process.env.TELEGRAM_SESSIONS_DIR || path.join(os.homedir(), '.mastra', 'telegram-sessions');
const MAPPINGS_FILE = path.join(SESSIONS_DIR, 'telegram-mappings.json');
const AUTH_SECRET = process.env.AUTH_SECRET;

// Cron schedules (configurable via env)
const MORNING_SCHEDULE = process.env.PROACTIVE_MORNING_CRON || '0 9 * * 1-5';  // 9am weekdays
const EVENING_SCHEDULE = process.env.PROACTIVE_EVENING_CRON || '0 18 * * 1-5'; // 6pm weekdays

// Track scheduled tasks for cleanup
let morningTask: cron.ScheduledTask | null = null;
let eveningTask: cron.ScheduledTask | null = null;

/**
 * Load all paired users from Telegram mappings
 */
async function loadPairedUsers(): Promise<UserContext[]> {
  if (!AUTH_SECRET) {
    logger.warn('⚠️ AUTH_SECRET not configured - cannot decrypt tokens');
    return [];
  }

  try {
    const data = await fs.readFile(MAPPINGS_FILE, 'utf8');
    const mappings = JSON.parse(data) as Record<string, any>;
    
    const users: UserContext[] = [];
    for (const [chatId, mapping] of Object.entries(mappings)) {
      if (mapping.encryptedAuthToken && mapping.workspaceId) {
        try {
          const authToken = decryptToken(mapping.encryptedAuthToken, AUTH_SECRET);
          users.push({
            userId: mapping.userId,
            authToken,
            workspaceId: mapping.workspaceId,
            telegramChatId: parseInt(chatId, 10),
            telegramUsername: mapping.telegramUsername,
          });
        } catch (decryptError) {
          logger.warn(`⚠️ Failed to decrypt token for chat ${chatId}:`, decryptError);
        }
      }
    }
    
    return users;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info('📂 No Telegram mappings file found - no users to check');
      return [];
    }
    throw error;
  }
}

/**
 * Run proactive checks for all users
 */
async function runProactiveChecks(type: 'morning' | 'evening'): Promise<void> {
  logger.info(`🚀 [ProactiveScheduler] Starting ${type} check run`);

  // --- Telegram proactive alerts ---
  let notificationsSent = 0;
  let errorsEncountered = 0;

  const users = await loadPairedUsers();
  if (users.length > 0) {
    logger.info(`👥 [ProactiveScheduler] Checking ${users.length} Telegram user(s)`);

    for (const user of users) {
      try {
        const result = await checkUser(user);

        if (result.hasIssues) {
          const sent = await notifyUser(result);
          if (sent) notificationsSent++;
        }
      } catch (error) {
        logger.error(`❌ [ProactiveScheduler] Error checking user ${user.userId}:`, error);
        errorsEncountered++;
      }
    }
  }

  // --- WhatsApp morning briefings (morning only) ---
  let whatsappBriefingsSent = 0;
  if (type === 'morning') {
    try {
      const whatsappStats = await deliverWhatsAppBriefings();
      whatsappBriefingsSent = whatsappStats.sent;
    } catch (error) {
      logger.error('❌ [ProactiveScheduler] WhatsApp briefing delivery failed:', error);
    }
  }

  logger.info(
    `✅ [ProactiveScheduler] ${type} run complete: ` +
    `${notificationsSent} Telegram notification(s), ` +
    `${whatsappBriefingsSent} WhatsApp briefing(s), ` +
    `${errorsEncountered} error(s)`
  );
}

/**
 * Start the proactive scheduler
 */
export function startScheduler(): void {
  const telegramToken = process.env.TELEGRAM_GATEWAY_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

  if (telegramToken) {
    initNotifier(telegramToken);
  } else {
    logger.warn('⚠️ [ProactiveScheduler] No Telegram token - Telegram notifications disabled');
  }

  // Schedule morning check (Telegram alerts + WhatsApp briefings)
  morningTask = cron.schedule(MORNING_SCHEDULE, () => {
    runProactiveChecks('morning').catch(err => {
      logger.error('❌ [ProactiveScheduler] Morning check failed:', err);
    });
  }, {
    timezone: process.env.TZ || 'Europe/Berlin',
  });

  // Schedule evening check (Telegram alerts only)
  eveningTask = cron.schedule(EVENING_SCHEDULE, () => {
    runProactiveChecks('evening').catch(err => {
      logger.error('❌ [ProactiveScheduler] Evening check failed:', err);
    });
  }, {
    timezone: process.env.TZ || 'Europe/Berlin',
  });

  logger.info(
    `🕐 [ProactiveScheduler] Started with schedules: ` +
    `morning="${MORNING_SCHEDULE}", evening="${EVENING_SCHEDULE}" ` +
    `(Telegram: ${telegramToken ? 'enabled' : 'disabled'}, WhatsApp: enabled)`
  );
}

/**
 * Stop the proactive scheduler
 */
export function stopScheduler(): void {
  if (morningTask) {
    morningTask.stop();
    morningTask = null;
  }
  if (eveningTask) {
    eveningTask.stop();
    eveningTask = null;
  }
  logger.info('🛑 [ProactiveScheduler] Stopped');
}

/**
 * Manually trigger a check (for testing)
 */
export async function triggerCheck(type: 'morning' | 'evening' = 'morning'): Promise<void> {
  await runProactiveChecks(type);
}
