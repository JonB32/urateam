export { agentProfiles, getAgentProfiles, DEFAULT_AGENT_PROFILES } from "./profiles.js";
export { resolveClaudeAuth, type ClaudeAuthCredentials } from "./auth-check.js";
export { createAuthMonitor, runAuthMonitorCheck, AUTH_MONITOR_INTERVAL_MS, type AuthMonitor } from "./auth-monitor.js";
export {
  checkTestQuality,
  analyzeTestFile,
  isTestFile,
  extractTestBlocks,
  TRIVIAL_MATCHERS,
  BEHAVIORAL_MATCHERS,
  TRIVIAL_THRESHOLD,
  type TestFileAnalysis,
  type TestQualityResult,
} from "./test-quality.js";
export { parseHandoffArtifact } from "./handoff.js";
export { executeStage, type ExecuteStageContext } from "./executor.js";
export { resolveSessionOpts, type ResolveSessionOptsParams } from "./session-resolver.js";
export { consumeAgentStream, parseJsonBlock, StageStalledError, StagePreStreamStalledError } from "./agent-stream.js";
export { sanitize, mapIssueToSchema, assemblePrompt } from "./prompt/index.js";
export {
  runDeepReview,
  deepFindingsToReviewFindings,
  buildDeepReviewContext,
  type DeepReviewFinding,
  type DeepReviewResult,
} from "./deep-review.js";

/**
 * Re-export of the Claude Agent SDK's transcript reader and message shape so
 * downstream packages (notably `@urateam/dashboard`, which doesn't take a
 * direct SDK dependency) can render historical session transcripts without
 * pulling the SDK in twice. BEC-227.
 */
export { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
