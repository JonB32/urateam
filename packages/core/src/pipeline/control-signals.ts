/**
 * In-memory per-run stop signals for the pipeline runner.
 *
 * Surfaces (dashboard, Slack, CLI) all funnel through `requestStop()` and the
 * runner consults `getStopSignal()` between stages. The executor subscribes via
 * `onStop()` so that "cancel" mode can interrupt an in-flight Agent SDK stream
 * (graceful stops simply skip the remaining stages once the current one ends).
 *
 * Single-process state: resets on container restart. Cross-container
 * coordination (Redis) is intentionally out of scope — matches the existing
 * BEC-170 pause caveat.
 */

import { createLogger } from "../logger.js";

const log = createLogger({ component: "pipeline.control-signals" });

/**
 * Stop intent attached to a run.
 *
 * - `"cancel"` — interrupt the running stage immediately by aborting the Agent
 *   SDK stream; mark the run as aborted. Tokens already spent on the current
 *   stage are lost.
 * - `"graceful"` — let the current stage finish, then skip remaining stages.
 *   No PR, no fanout. Strictly cheaper to clean up after.
 */
export type StopMode = "cancel" | "graceful";

const signals = new Map<string, StopMode>();
const listeners = new Map<string, Set<() => void>>();

/**
 * Request a stop for `runId`. Idempotent. Calling with `"cancel"` after
 * `"graceful"` upgrades the signal (cancel is strictly stronger). The reverse
 * is a no-op so an in-flight cancel can't be downgraded mid-stream.
 *
 * Returns the effective mode after the call.
 */
export function requestStop(runId: string, mode: StopMode): StopMode {
  const existing = signals.get(runId);
  if (existing === "cancel") {
    // Already at strongest — no-op.
    return existing;
  }
  signals.set(runId, mode);
  log.info({ runId, mode, previous: existing ?? null }, "stop signal recorded");
  // Notify listeners only on `"cancel"` — graceful is polled at stage boundaries
  // and doesn't need to interrupt a running stream.
  if (mode === "cancel") {
    const subs = listeners.get(runId);
    if (subs) {
      for (const cb of subs) {
        try {
          cb();
        } catch (err) {
          log.warn({ runId, err }, "stop listener threw");
        }
      }
    }
  }
  return mode;
}

/** Returns the current stop signal for `runId`, or `undefined` if none set. */
export function getStopSignal(runId: string): StopMode | undefined {
  return signals.get(runId);
}

/**
 * Clears any signal for `runId`. Called by the runner once it has finished
 * processing the stop (e.g. after marking the run aborted).
 */
export function clearStopSignal(runId: string): void {
  signals.delete(runId);
  listeners.delete(runId);
}

/**
 * Subscribe a listener that fires when a `"cancel"` signal is recorded for
 * `runId`. Returns an unsubscribe function. Use this in the executor to call
 * `.return()` on the SDK iterator and break out of the stream.
 *
 * If a `"cancel"` signal is already pending when this is called, the listener
 * is invoked synchronously so subscribers can't miss an early request.
 */
export function onStop(runId: string, listener: () => void): () => void {
  if (signals.get(runId) === "cancel") {
    try {
      listener();
    } catch (err) {
      log.warn({ runId, err }, "stop listener threw on immediate fire");
    }
  }
  let set = listeners.get(runId);
  if (!set) {
    set = new Set();
    listeners.set(runId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

/** Test/reset helper. Not exported from the package barrel. */
export function _clearAllSignals(): void {
  signals.clear();
  listeners.clear();
}
