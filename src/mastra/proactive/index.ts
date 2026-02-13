/**
 * Proactive Module
 * 
 * Scheduled checks and notifications to keep projects moving.
 */

export { checkUser } from './checker.js';
export { initNotifier, notifyUser, formatDailyDigest } from './notifier.js';
export { startScheduler, stopScheduler, triggerCheck } from './scheduler.js';
export type {
  ProactiveCheckResult,
  UserContext,
  StaleProject,
  OverdueAction,
  AtRiskGoal,
  RiskSignal,
} from './types.js';
