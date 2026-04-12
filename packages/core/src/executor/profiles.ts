import type { AgentProfile } from "../types.js";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const HAIKU_MODEL = "claude-haiku-4-5";

export const agentProfiles: Record<string, AgentProfile> = {
  triage: {
    tools: ["Read", "Glob", "Grep", "WebSearch"],
    maxInputTokens: 30_000,
    maxTurns: 10,
    model: DEFAULT_MODEL,
  },
  reproduce: {
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    maxInputTokens: 50_000,
    maxTurns: 20,
    model: DEFAULT_MODEL,
  },
  implement: {
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    maxInputTokens: 100_000,
    maxTurns: 50,
    model: DEFAULT_MODEL,
  },
  test: {
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    maxInputTokens: 30_000,
    maxTurns: 25,
    model: HAIKU_MODEL,
  },
  review: {
    tools: ["Read", "Glob", "Grep", "Bash"],
    maxInputTokens: 80_000,
    maxTurns: 20,
    model: DEFAULT_MODEL,
  },
};
