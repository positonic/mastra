import * as Sentry from '@sentry/node';

// Track initialization state
let isInitialized = false;

/**
 * Initialize Sentry error tracking.
 * Does nothing if SENTRY_DSN is not configured.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    console.log('Sentry: Disabled (SENTRY_DSN not configured)');
    return;
  }

  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      // Capture 100% of transactions for performance monitoring
      tracesSampleRate: 1.0,
      // Add release info if available
      release: process.env.npm_package_version,
    });

    isInitialized = true;
    console.log('Sentry: Initialized successfully');
  } catch (error) {
    console.error('Sentry: Failed to initialize', error);
  }
}

/**
 * Capture an exception to Sentry with optional context.
 * Safe to call even if Sentry is not initialized.
 */
export function captureException(
  error: Error | unknown,
  context?: {
    userId?: string;
    sessionId?: string;
    operation?: string;
    extra?: Record<string, unknown>;
  }
): void {
  // Always log locally
  console.error(`[Error] ${context?.operation || 'Unknown operation'}:`, error);

  if (!isInitialized) return;

  Sentry.withScope((scope) => {
    if (context?.userId) {
      scope.setUser({ id: context.userId });
    }
    if (context?.sessionId) {
      scope.setTag('session_id', context.sessionId);
    }
    if (context?.operation) {
      scope.setTag('operation', context.operation);
    }
    if (context?.extra) {
      scope.setExtras(context.extra);
    }

    Sentry.captureException(error);
  });
}

/**
 * Capture an auth failure specifically.
 * Adds auth-specific tags for filtering in Sentry.
 */
export function captureAuthFailure(
  error: Error | unknown,
  context: {
    userId?: string;
    sessionId?: string;
    endpoint?: string;
    statusCode?: number;
  }
): void {
  // Always log locally with clear identifier
  console.error(`[AUTH FAILURE] ${context.endpoint || 'Unknown endpoint'}:`, {
    statusCode: context.statusCode,
    userId: context.userId,
    sessionId: context.sessionId,
    error: error instanceof Error ? error.message : String(error),
  });

  if (!isInitialized) return;

  Sentry.withScope((scope) => {
    scope.setLevel('warning');
    scope.setTag('error_type', 'auth_failure');
    scope.setTag('status_code', String(context.statusCode || 'unknown'));

    if (context.userId) {
      scope.setUser({ id: context.userId });
    }
    if (context.sessionId) {
      scope.setTag('session_id', context.sessionId);
    }
    if (context.endpoint) {
      scope.setTag('endpoint', context.endpoint);
    }

    Sentry.captureException(error);
  });
}

/**
 * Capture a message (non-error event) to Sentry.
 */
export function captureMessage(
  message: string,
  level: 'info' | 'warning' | 'error' = 'info',
  context?: Record<string, unknown>
): void {
  console.log(`[${level.toUpperCase()}] ${message}`);

  if (!isInitialized) return;

  Sentry.withScope((scope) => {
    scope.setLevel(level);
    if (context) {
      scope.setExtras(context);
    }
    Sentry.captureMessage(message);
  });
}

/**
 * Flush pending events before shutdown.
 * Call this during graceful shutdown.
 */
export async function flushSentry(timeout = 2000): Promise<void> {
  if (!isInitialized) return;

  try {
    await Sentry.close(timeout);
  } catch (error) {
    console.error('Sentry: Error during flush', error);
  }
}

export { Sentry };
