/**
 * Proactive Notifier
 * 
 * Takes check results, uses Paddy to compose a helpful message,
 * then sends it via Telegram.
 */

import TelegramBot from 'node-telegram-bot-api';
import { createLogger } from '@mastra/core/logger';
import { projectManagerAgent } from '../agents/index.js';
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
 * Compose a helpful message using the PM agent
 */
async function composeMessage(result: ProactiveCheckResult): Promise<string> {
  const issues: string[] = [];

  if (result.staleProjects.length > 0) {
    const projectList = result.staleProjects
      .map(p => `- "${p.name}" (${p.lastActivityDays} days since activity)`)
      .join('\n');
    issues.push(`**Stale Projects:**\n${projectList}`);
  }

  if (result.overdueActions.length > 0) {
    const actionList = result.overdueActions
      .slice(0, 5) // Limit to top 5
      .map(a => `- "${a.title}" (${a.daysOverdue} days overdue)`)
      .join('\n');
    const more = result.overdueActions.length > 5 
      ? `\n...and ${result.overdueActions.length - 5} more` 
      : '';
    issues.push(`**Overdue Actions:**\n${actionList}${more}`);
  }

  if (result.atRiskGoals.length > 0) {
    const goalList = result.atRiskGoals
      .map(g => `- "${g.title}" (${g.daysRemaining} days left, ${g.progress}% done)`)
      .join('\n');
    issues.push(`**At-Risk Goals:**\n${goalList}`);
  }

  if (result.riskSignals.length > 0) {
    const criticalSignals = result.riskSignals.filter(
      r => r.severity === 'high' || r.severity === 'critical'
    );
    if (criticalSignals.length > 0) {
      const signalList = criticalSignals.map(r => `- ${r.message}`).join('\n');
      issues.push(`**Sprint Risks:**\n${signalList}`);
    }
  }

  if (issues.length === 0) {
    return ''; // Nothing to report
  }

  // Use Paddy to compose a helpful, human message
  const prompt = `You're doing a proactive check-in. The following issues were detected:

${issues.join('\n\n')}

Compose a brief, friendly Telegram message (max 500 chars) that:
1. Highlights the most important issue(s)
2. Asks a helpful question to unblock progress
3. Keeps it conversational, not robotic

Don't list everything - focus on what matters most. Be encouraging but direct.`;

  try {
    const response = await projectManagerAgent.generate(prompt);
    return typeof response.text === 'string' ? response.text : String(response.text);
  } catch (error) {
    logger.error('❌ [ProactiveNotifier] Agent composition failed:', error);
    // Fallback to simple message
    return `Hey! Quick check-in: You have ${result.staleProjects.length} stale projects and ${result.overdueActions.length} overdue actions. Want to tackle something today?`;
  }
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
    const message = await composeMessage(result);
    if (!message) {
      return false;
    }

    await bot.sendMessage(result.telegramChatId, message, {
      parse_mode: 'Markdown',
    });

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
