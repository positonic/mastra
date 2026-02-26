/**
 * Proactive Checker
 *
 * Calls Exponential APIs to find:
 * - Stale projects (no activity in X days)
 * - Overdue actions
 * - At-risk goals
 * - Sprint risk signals
 *
 * Each check runs independently — a single endpoint failure does not
 * prevent other checks from completing.
 */

import { createLogger } from '@mastra/core/logger';
import { authenticatedTrpcCall, authenticatedTrpcQuery } from '../utils/authenticated-fetch.js';
import { captureException } from '../utils/sentry.js';
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
 * Run a proactive check for a single user.
 *
 * Each check (projects, actions, goals, sprints) runs independently
 * with its own error handling. A failing check logs the error and
 * continues — it never aborts the entire run.
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

  // Run all checks independently — each one catches its own errors
  const [staleProjects, overdueActions, atRiskGoals, riskSignals] = await Promise.allSettled([
    checkStaleProjects(workspaceId, authOptions),
    checkOverdueActions(authOptions),
    checkAtRiskGoals(authOptions),
    checkSprintRisks(workspaceId, authOptions),
  ]);

  // Collect results from settled promises
  if (staleProjects.status === 'fulfilled') {
    result.staleProjects = staleProjects.value;
  } else {
    logger.error(`❌ [ProactiveChecker] Stale projects check failed for user ${userId}:`, staleProjects.reason);
    captureException(staleProjects.reason, { userId, check: 'staleProjects' });
  }

  if (overdueActions.status === 'fulfilled') {
    result.overdueActions = overdueActions.value;
  } else {
    logger.error(`❌ [ProactiveChecker] Overdue actions check failed for user ${userId}:`, overdueActions.reason);
    captureException(overdueActions.reason, { userId, check: 'overdueActions' });
  }

  if (atRiskGoals.status === 'fulfilled') {
    result.atRiskGoals = atRiskGoals.value;
  } else {
    logger.error(`❌ [ProactiveChecker] At-risk goals check failed for user ${userId}:`, atRiskGoals.reason);
    captureException(atRiskGoals.reason, { userId, check: 'atRiskGoals' });
  }

  if (riskSignals.status === 'fulfilled') {
    result.riskSignals = riskSignals.value;
  } else {
    // Sprint analytics is optional — many workspaces don't use it
    logger.debug(`[ProactiveChecker] Sprint risk check failed for user ${userId}:`, riskSignals.reason);
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
}

// --- Individual check functions ---

/**
 * Check for stale projects (no activity in STALE_THRESHOLD_DAYS+ days).
 * Uses project.getAll (GET query) — the same endpoint as getAllProjectsTool.
 */
async function checkStaleProjects(
  workspaceId: string,
  authOptions: { authToken: string; userId: string },
): Promise<StaleProject[]> {
  const queryInput = { json: { workspaceId } };
  const endpoint = `project.getAll?input=${encodeURIComponent(JSON.stringify(queryInput))}`;

  const { data } = await authenticatedTrpcQuery<any>(endpoint, authOptions);

  // project.getAll may return projects at various nesting levels
  const projects = Array.isArray(data) ? data : (data?.json || data || []);
  const projectsArray = Array.isArray(projects) ? projects : [];

  const now = new Date();
  const stale: StaleProject[] = [];

  for (const project of projectsArray) {
    if (project.status !== 'ACTIVE') continue;

    const lastActivity = project.updatedAt ? new Date(project.updatedAt) : null;
    if (lastActivity && !isNaN(lastActivity.getTime())) {
      const daysSinceActivity = Math.floor(
        (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24)
      );
      if (daysSinceActivity >= STALE_THRESHOLD_DAYS) {
        stale.push({
          id: project.id,
          name: project.name,
          lastActivityDays: daysSinceActivity,
          status: project.status,
        });
      }
    }
  }

  return stale;
}

/**
 * Check for overdue actions using the briefing endpoint.
 *
 * There is no dedicated "get overdue actions" endpoint. The morning
 * briefing endpoint aggregates overdue actions across all projects,
 * so we reuse it here. This is a GET query.
 */
async function checkOverdueActions(
  authOptions: { authToken: string; userId: string },
): Promise<OverdueAction[]> {
  const { data } = await authenticatedTrpcQuery<any>(
    'briefing.getMorningBriefing',
    authOptions,
  );

  if (!data?.overdueActions) return [];

  const now = new Date();
  return data.overdueActions.map((action: any) => {
    const dueDate = action.dueDate ? new Date(action.dueDate) : null;
    const daysOverdue = dueDate && !isNaN(dueDate.getTime())
      ? Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    return {
      id: action.id,
      title: action.name || action.title || 'Untitled',
      projectName: action.projectName || 'No project',
      dueDate: action.dueDate || '',
      daysOverdue,
    };
  });
}

/**
 * Check for at-risk goals (due soon with low progress).
 * Uses mastra.getAllGoals (GET query) — the same endpoint as getAllGoalsTool.
 */
async function checkAtRiskGoals(
  authOptions: { authToken: string; userId: string },
): Promise<AtRiskGoal[]> {
  const { data } = await authenticatedTrpcQuery<any>('mastra.getAllGoals', authOptions);

  // getAllGoals may return { goals: [...] } or directly [...]
  const goals = Array.isArray(data) ? data : (data?.goals || data || []);
  const goalsArray = Array.isArray(goals) ? goals : [];

  const now = new Date();
  const atRisk: AtRiskGoal[] = [];

  for (const goal of goalsArray) {
    if (!goal.dueDate || goal.status !== 'ACTIVE') continue;

    const dueDate = new Date(goal.dueDate);
    if (isNaN(dueDate.getTime())) continue;

    const daysRemaining = Math.floor(
      (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );
    const progress = goal.progress || 0;

    // At risk: due within 14 days and less than 50% complete
    if (daysRemaining <= 14 && daysRemaining > 0 && progress < 50) {
      atRisk.push({
        id: goal.id,
        title: goal.title,
        dueDate: goal.dueDate,
        progress,
        daysRemaining,
      });
    }
  }

  return atRisk;
}

/**
 * Check for sprint risk signals (high/critical severity).
 * Uses sprintAnalytics endpoints (POST mutations — the same as pm-tools).
 */
async function checkSprintRisks(
  workspaceId: string,
  authOptions: { authToken: string; userId: string },
): Promise<RiskSignal[]> {
  const sprintResult = await authenticatedTrpcCall<any>(
    'sprintAnalytics.getActiveSprint',
    { workspaceId },
    authOptions,
  );

  if (!sprintResult.data?.id) return [];

  const risksResult = await authenticatedTrpcCall<RiskSignal[]>(
    'sprintAnalytics.getRiskSignals',
    { listId: sprintResult.data.id },
    authOptions,
  );

  return risksResult.data || [];
}
