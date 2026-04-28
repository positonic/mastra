/**
 * Logger wrapper that adapts PinoLogger to accept `unknown` meta arguments.
 *
 * In Mastra 1.x, PinoLogger.{info,warn,error,debug} expects `Record<string, any>`
 * for the meta argument, but our bots/proactive code routinely passes caught
 * `unknown` errors. This wrapper normalizes those to `{ err: <value> }` (or the
 * value itself if it already looks like a plain object) so call sites stay
 * untouched.
 */
import { PinoLogger, type PinoLoggerOptions, type LogLevel } from '@mastra/loggers';

export type { LogLevel };

function normalizeMeta(meta: unknown): Record<string, any> | undefined {
  if (meta === undefined || meta === null) return undefined;
  if (meta instanceof Error) {
    return {
      err: {
        name: meta.name,
        message: meta.message,
        stack: meta.stack,
      },
    };
  }
  if (typeof meta === 'object') {
    // Plain object / array — pass as-is. PinoLogger will accept it.
    return meta as Record<string, any>;
  }
  return { value: meta };
}

export interface AppLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

class AppLoggerImpl implements AppLogger {
  constructor(private readonly inner: PinoLogger) {}

  debug(message: string, meta?: unknown): void {
    this.inner.debug(message, normalizeMeta(meta));
  }
  info(message: string, meta?: unknown): void {
    this.inner.info(message, normalizeMeta(meta));
  }
  warn(message: string, meta?: unknown): void {
    this.inner.warn(message, normalizeMeta(meta));
  }
  error(message: string, meta?: unknown): void {
    this.inner.error(message, normalizeMeta(meta));
  }

  /** Expose the underlying PinoLogger when the strict IMastraLogger type is required (e.g. Mastra constructor). */
  get raw(): PinoLogger {
    return this.inner;
  }
}

export function createLogger(options: PinoLoggerOptions): AppLogger & { raw: PinoLogger } {
  return new AppLoggerImpl(new PinoLogger(options));
}
