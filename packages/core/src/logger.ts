import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";
import { Writable } from "node:stream";

/**
 * Root structured logger for the Linear Agent Framework.
 *
 * Configuration:
 *   LOG_LEVEL  — pino log level (trace | debug | info | warn | error | fatal).
 *                Defaults to "info".
 *   LOG_PRETTY — set to "1" for human-readable output during local development.
 */

/**
 * A writable stream that fans out to stdout plus any additional streams
 * registered via addLogStream(). This allows Slack alert hooks to be
 * wired in at runtime without recreating the root logger.
 *
 * Note: only used in production mode (LOG_PRETTY !== "1"). When pretty
 * printing is enabled, pino uses a worker-thread transport that bypasses
 * this stream.
 */
class DynamicMultiStream extends Writable {
  private extras: Writable[] = [];

  addStream(stream: Writable): void {
    this.extras.push(stream);
  }

  _write(chunk: Buffer, _enc: BufferEncoding, callback: () => void): void {
    process.stdout.write(chunk);
    for (const s of this.extras) {
      s.write(chunk);
    }
    callback();
  }
}

const _multiStream = new DynamicMultiStream();

const _pinoOptions: pino.LoggerOptions = {
  name: "urateam",
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
};

export const rootLogger: pino.Logger =
  process.env.LOG_PRETTY === "1"
    ? pino({
        ..._pinoOptions,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        },
      })
    : pino(_pinoOptions, _multiStream);

/**
 * Add an additional Writable destination to the root logger's output.
 * Each log line (serialised JSON) will be forwarded to the stream.
 *
 * No-op when LOG_PRETTY=1 is set (transport mode).
 *
 * Use this to attach the SlackAlertStream at startup:
 *   addLogStream(createSlackAlertStream(manager));
 */
export function addLogStream(stream: Writable): void {
  if (process.env.LOG_PRETTY === "1") return;
  _multiStream.addStream(stream);
}

/**
 * Create a child logger with additional bound fields.
 * Use this to attach correlation IDs (runId, stage, etc.) to every log line.
 *
 * Example:
 *   const log = createLogger({ component: "PipelineRunner", runId });
 *   log.info("pipeline started");
 *   // → { "runId": "...", "component": "PipelineRunner", "msg": "pipeline started", ... }
 */
export function createLogger(context: Record<string, unknown>): pino.Logger {
  return rootLogger.child(context);
}

/**
 * Log context propagated via AsyncLocalStorage so shared modules (git.ts,
 * coordination.ts) can include issueId/runId without changing their signatures.
 */
export interface LogContext {
  runId?: string;
  issueId?: string;
}

const logContextStorage = new AsyncLocalStorage<LogContext>();

/**
 * Run fn within a log context. All log lines emitted by shared modules
 * (git.ts, coordination.ts) inside fn will automatically include the
 * provided issueId and runId fields.
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return logContextStorage.run(context, fn);
}

/**
 * Return the current log context from AsyncLocalStorage, or undefined when
 * called outside a runWithLogContext scope.
 */
export function getLogContext(): LogContext | undefined {
  return logContextStorage.getStore();
}
