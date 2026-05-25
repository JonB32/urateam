import { createLogger } from "../logger.js";

const log = createLogger({ component: "HangDetection" });

/** Interval at which the runner checks for implement-stage hangs. */
export const HANG_DETECTION_INTERVAL_MS = 5 * 60_000; // 5 minutes

/** Elapsed time without progress that constitutes a hang. */
export const DEFAULT_HANG_THRESHOLD_MS = 30 * 60_000; // 30 minutes

export interface HangDiagnostics {
  runId: string;
  stage: string;
  lastUpdateTime: Date;
  elapsedMs: number;
  hangThresholdMs: number;
  processUptimeSeconds: number;
  memoryUsageMb: number;
  cpuUserMs: number;
}

/**
 * Checks whether a stage has gone without progress for longer than
 * `hangThresholdMs` (default 30 minutes). Returns true and logs an
 * ERROR-level message with diagnostics when a hang is detected.
 *
 * Called by the executor at `HANG_DETECTION_INTERVAL_MS` (5 min) intervals
 * during implement stage execution. Designed as a pure function for testability
 * — the caller is responsible for tracking `lastUpdateTime`.
 *
 * Note: this function only DETECTS and LOGS hangs. Actual termination is
 * handled by the existing StageStalledError / WALL_CLOCK_STAGE_TIMEOUT_MS
 * guards in consumeAgentStream and executor.ts, or manually via terminateRun().
 */
export function detectStageHang(
  runId: string,
  stage: string,
  lastUpdateTime: Date,
  hangThresholdMs = DEFAULT_HANG_THRESHOLD_MS,
): boolean {
  const elapsedMs = Date.now() - lastUpdateTime.getTime();

  if (elapsedMs < hangThresholdMs) return false;

  const cpuUsage = process.cpuUsage();
  const diagnostics: HangDiagnostics = {
    runId,
    stage,
    lastUpdateTime,
    elapsedMs,
    hangThresholdMs,
    processUptimeSeconds: Math.round(process.uptime()),
    memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    cpuUserMs: Math.round(cpuUsage.user / 1000),
  };

  log.error(
    diagnostics,
    `stage hang detected: ${stage} stage for run ${runId} has had no progress for ` +
      `${Math.round(elapsedMs / 60_000)} minutes (last update: ${lastUpdateTime.toISOString()})`,
  );

  return true;
}
