import type { RequestContext } from '@mastra/core/request-context';

export interface AppRequestContextValues {
  authToken: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  whatsappSession: string;
}

export type AppRequestContext = RequestContext<AppRequestContextValues>;

/**
 * Cast an untyped RequestContext (from a Mastra ToolExecutionContext) to our typed
 * AppRequestContext so that `.get("authToken")` returns `string | undefined`
 * instead of `unknown`.
 */
export function asAppContext(
  ctx: RequestContext<unknown> | undefined,
): AppRequestContext | undefined {
  return ctx as AppRequestContext | undefined;
}
