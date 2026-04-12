import { consumeAgentStream } from "../executor/agent-stream.js";
import { isClaudeAuthValid } from "../executor/auth-check.js";

const PM_AGENT_MODEL = "claude-haiku-4-5-20251001";
const PM_AGENT_SONNET_MODEL = "claude-sonnet-4-5-20251001";

// The Agent SDK registers exit listeners per query() call. With frequent PM Agent
// ticks these accumulate past Node's default limit of 10. Raise it to prevent warnings.
if (typeof process !== "undefined" && process.setMaxListeners) {
  process.setMaxListeners(Math.max(process.getMaxListeners(), 50));
}

function makeCallClaudeWithModel(model: string): (prompt: string) => Promise<string> {
  let callFn: ((prompt: string) => Promise<string>) | null = null;
  return async (prompt: string) => {
    // Pre-flight auth check — fail fast before burning a query.
    if (!(await isClaudeAuthValid())) {
      throw new Error(
        "Claude auth credentials are invalid or expired. Run: docker compose exec <service> claude login",
      );
    }

    if (!callFn) {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      callFn = async (p: string) => {
        const messages = query({
          prompt: p,
          options: { model, maxTurns: 1, allowedTools: [] },
        });
        const result = await consumeAgentStream(messages);
        return result.lastText;
      };
    }
    return callFn(prompt);
  };
}

export function makeCallClaude(): (prompt: string) => Promise<string> {
  return makeCallClaudeWithModel(PM_AGENT_MODEL);
}

export function makeCallClaudeSonnet(): (prompt: string) => Promise<string> {
  return makeCallClaudeWithModel(PM_AGENT_SONNET_MODEL);
}
