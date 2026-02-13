/**
 * Types for the proactive checker system
 */

export interface StaleProject {
  id: string;
  name: string;
  lastActivityDays: number;
  status: string;
}

export interface OverdueAction {
  id: string;
  title: string;
  projectName: string;
  dueDate: string;
  daysOverdue: number;
}

export interface AtRiskGoal {
  id: string;
  title: string;
  dueDate: string;
  progress: number;
  daysRemaining: number;
}

export interface RiskSignal {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  actionIds?: string[];
}

export interface ProactiveCheckResult {
  userId: string;
  workspaceId: string;
  telegramChatId: number;
  timestamp: Date;
  staleProjects: StaleProject[];
  overdueActions: OverdueAction[];
  atRiskGoals: AtRiskGoal[];
  riskSignals: RiskSignal[];
  hasIssues: boolean;
}

export interface UserContext {
  userId: string;
  authToken: string;
  workspaceId: string;
  telegramChatId: number;
  telegramUsername: string | null;
}
