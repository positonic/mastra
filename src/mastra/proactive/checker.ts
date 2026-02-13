/**
 * Proactive Checker
 * 
 * Calls Exponential APIs to find:
 * - Stale projects (no activity in X days)
 * - Overdue actions
 * - At-risk goals
 * - Sprint risk signals
 */

import { createLogger } from '@mastra/core/logger';
import { authenticatedTrpcCall } from '../utils/authenticated-fetch.js';
import type {
  ProactiveCheckResult,
  UserContext,
  StaleProject,
  OverdueAction,
  AtRiskGoal,
  RiskSignal,
} from './types.js';

const logger = createLogger({
  name: 'ProactiveChecker',
  level: 'info',
});

// Configuration
const STALE_THRESHOLD_DAYS = 7; // Projects with no activity in 7+ days

/**
 * Run a proactive check for a single user
 */
export async function checkUser(ctx: UserContext): Promise<ProactiveCheckResult> {
  const { userId, authToken, workspaceId, telegramChatId } = ctx;
  const authOptions = { authToken, userId };

  logger.info(`🔍 [ProactiveChecker] Checking user ${userId} workspace ${workspaceId}`);

  const result: ProactiveCheckResult = {
    userId,
    workspaceId,
    telegramChatId,
    timestamp: new Date(),
    staleProjects: [],
    overdueActions: [],
    atRiskGoals: [],
    riskSignals: [],
    hasIssues: false,
  };

  try {
    // 1. Get all active projects and check for staleness
    const projectsResult = await authenticatedTrpcCall<any[]>(
      'project.getAllProjects',
      { workspaceId, status: 'ACTIVE' },
      authOptions
    );
    
    const projects = projectsResult.data || [];
    const now = new Date();

    for (const project of projects) {
      const lastActivity = project.updatedAt ? new Date(project.updatedAt) : null;
      if (lastActivity) {
        const daysSinceActivity = Math.floor(
          (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24)
        );
        if (daysSinceActivity >= STALE_THRESHOLD_DAYS) {
          result.staleProjects.push({
            id: project.id,
            name: project.name,
            lastActivityDays: daysSinceActivity,
            status: project.status,
          });
        }
      }
    }

    // 2. Get overdue actions
    const actionsResult = await authenticatedTrpcCall<any[]>(
      'action.getOverdueActions',
      { workspaceId },
      authOptions
    );

    const overdueActions = actionsResult.data || [];
    for (const action of overdueActions) {
      const dueDate = new Date(action.dueDate);
      const daysOverdue = Math.floor(
        (now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      result.overdueActions.push({
        id: action.id,
        title: action.title,
        projectName: action.project?.name || 'No project',
        dueDate: action.dueDate,
        daysOverdue,
      });
    }

    // 3. Get at-risk goals (due soon, low progress)
    const goalsResult = await authenticatedTrpcCall<any[]>(
      'goal.getAllGoals',
      { workspaceId },
      authOptions
    );

    const goals = goalsResult.data || [];
    for (const goal of goals) {
      if (goal.dueDate && goal.status === 'ACTIVE') {
        const dueDate = new Date(goal.dueDate);
        const daysRemaining = Math.floor(
          (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        );
        const progress = goal.progress || 0;

        // At risk: due within 14 days and less than 50% complete
        if (daysRemaining <= 14 && daysRemaining > 0 && progress < 50) {
          result.atRiskGoals.push({
            id: goal.id,
            title: goal.title,
            dueDate: goal.dueDate,
            progress,
            daysRemaining,
          });
        }
      }
    }

    // 4. Get sprint risk signals (if active sprint exists)
    try {
      const sprintResult = await authenticatedTrpcCall<any>(
        'sprintAnalytics.getActiveSprint',
        { workspaceId },
        authOptions
      );

      if (sprintResult.data?.id) {
        const risksResult = await authenticatedTrpcCall<RiskSignal[]>(
          'sprintAnalytics.getRiskSignals',
          { listId: sprintResult.data.id },
          authOptions
        );
        result.riskSignals = risksResult.data || [];
      }
    } catch (sprintError) {
      // Sprint analytics might not be set up - that's OK
      logger.debug(`[ProactiveChecker] No sprint data for workspace ${workspaceId}`);
    }

    // Determine if there are any issues worth reporting
    result.hasIssues =
      result.staleProjects.length > 0 ||
      result.overdueActions.length > 0 ||
      result.atRiskGoals.length > 0 ||
      result.riskSignals.some(r => r.severity === 'high' || r.severity === 'critical');

    logger.info(
      `✅ [ProactiveChecker] User ${userId}: ` +
      `${result.staleProjects.length} stale projects, ` +
      `${result.overdueActions.length} overdue actions, ` +
      `${result.atRiskGoals.length} at-risk goals, ` +
      `${result.riskSignals.length} risk signals`
    );

    return result;
  } catch (error) {
    logger.error(`❌ [ProactiveChecker] Failed for user ${userId}:`, error);
    throw error;
  }
}
