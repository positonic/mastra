/**
 * Proactive Notifier
 *
 * Takes check results and sends template-based notifications via Telegram.
 *
 * SECURITY: This pipeline runs autonomously with no human in the loop.
 * We use structured templates instead of LLM generation to prevent
 * prompt injection via crafted project names, action titles, etc.
 */

import TelegramBot from 'node-telegram-bot-api';
import { createLogger } from '@mastra/core/logger';
import { sanitizeForPrompt } from '../utils/content-safety.js';
import type { ProactiveCheckResult } from './types.js';

const logger = createLogger({
  name: 'ProactiveNotifier',
  level: 'info',
});

// Telegram bot instance (reuse from gateway or create dedicated)
let bot: TelegramBot | null = null;

export function initNotifier(telegramToken: string): void {
  if (!telegramToken) {
    logger.warn('⚠️ [ProactiveNotifier] No Telegram token - notifications disabled');
    return;
  }
  bot = new TelegramBot(telegramToken);
  logger.info('✅ [ProactiveNotifier] Initialized');
}

/**
 * Compose a notification from a fixed template.
 *
 * SECURITY: No LLM in the loop. All user-controlled strings are sanitized
 * and interpolated into a static template. This eliminates the risk of
 * prompt injection via crafted project/action names in this autonomous pipeline.
 */
/** Escape Telegram Markdown V1 special characters in user-controlled strings. */
function escapeMd(text: string): string {
  return text.replace(/([*_`\[\]])/g, '\\$1');
}

function composeMessage(result: ProactiveCheckResult): string {
  const safe = (text: string, maxLen = 80) =>
    escapeMd(sanitizeForPrompt(text, { maxLength: maxLen, flagSuspicious: false }));

  const sections: string[] = [];

  if (result.staleProjects.length > 0) {
    const top3 = result.staleProjects.slice(0, 3);
    const names = top3.map(p => `"${safe(p.name)}" (${p.lastActivityDays}d)`).join(', ');
    const extra = result.staleProjects.length > 3
      ? ` +${result.staleProjects.length - 3} more`
      : '';
    sections.push(`🔴 *${result.staleProjects.length} stale project(s):* ${names}${extra}`);
  }

  if (result.overdueActions.length > 0) {
    const top3 = result.overdueActions.slice(0, 3);
    const names = top3.map(a => `"${safe(a.title)}" (${a.daysOverdue}d overdue)`).join(', ');
    const extra = result.overdueActions.length > 3
      ? ` +${result.overdueActions.length - 3} more`
      : '';
    sections.push(`⏰ *${result.overdueActions.length} overdue action(s):* ${names}${extra}`);
  }

  if (result.atRiskGoals.length > 0) {
    const top3 = result.atRiskGoals.slice(0, 3);
    const names = top3.map(g => `"${safe(g.title)}" (${g.daysRemaining}d left, ${g.progress}%)`).join(', ');
    sections.push(`⚠️ *${result.atRiskGoals.length} at-risk goal(s):* ${names}`);
  }

  // Notification includes high+critical risks (intentionally broader than
  // formatDailyDigest which only counts critical) to prompt user action.
  const criticalRisks = result.riskSignals.filter(
    r => r.severity === 'high' || r.severity === 'critical'
  );
  if (criticalRisks.length > 0) {
    sections.push(`🚨 *${criticalRisks.length} sprint risk(s)* need attention`);
  }

  if (sections.length === 0) {
    return '';
  }

  return `Hey! Quick check-in:\n\n${sections.join('\n\n')}\n\nWhat would you like to tackle first?`;
}

/**
 * Send a proactive notification to a user
 */
export async function notifyUser(result: ProactiveCheckResult): Promise<boolean> {
  if (!result.hasIssues) {
    logger.debug(`[ProactiveNotifier] No issues for user ${result.userId}, skipping`);
    return false;
  }

  if (!bot) {
    logger.warn('⚠️ [ProactiveNotifier] Bot not initialized, cannot send');
    return false;
  }

  try {
    const message = composeMessage(result);
    if (!message) {
      return false;
    }

    try {
      await bot.sendMessage(result.telegramChatId, message, {
        parse_mode: 'Markdown',
      });
    } catch (parseErr) {
      // Markdown parse failure — retry as plain text
      logger.warn(`⚠️ [ProactiveNotifier] Markdown parse failed, retrying plain text`);
      await bot.sendMessage(result.telegramChatId, message);
    }

    logger.info(`📤 [ProactiveNotifier] Sent to chat ${result.telegramChatId}`);
    return true;
  } catch (error) {
    logger.error(`❌ [ProactiveNotifier] Failed to send to ${result.telegramChatId}:`, error);
    return false;
  }
}

/**
 * Format a simple daily digest (no agent, just data)
 */
export function formatDailyDigest(result: ProactiveCheckResult): string {
  const lines: string[] = ['📊 *Daily Project Digest*\n'];

  if (result.staleProjects.length > 0) {
    lines.push(`🔴 ${result.staleProjects.length} stale project(s)`);
  }
  if (result.overdueActions.length > 0) {
    lines.push(`⏰ ${result.overdueActions.length} overdue action(s)`);
  }
  if (result.atRiskGoals.length > 0) {
    lines.push(`⚠️ ${result.atRiskGoals.length} at-risk goal(s)`);
  }

  const criticalRisks = result.riskSignals.filter(r => r.severity === 'critical').length;
  if (criticalRisks > 0) {
    lines.push(`🚨 ${criticalRisks} critical risk(s)`);
  }

  if (lines.length === 1) {
    lines.push('✅ All clear! No issues detected.');
  }

  return lines.join('\n');
}
