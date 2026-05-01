import type { ReviewProvider, ReviewModelRun, ReviewContext } from "./review-provider.js";
import { OpenRouterClient } from "./openrouter-client.js";
import { buildReviewPrompt, parseReviewFindings } from "./review-prompt.js";
import { collectWorkdirSnapshot } from "./workdir-snapshot.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "OpenRouterFanout" });

export interface OpenRouterFanoutConfig {
  apiKey: string;
  baseUrl: string;
  models: string[];
  timeoutMs: number;
  maxInputTokens: number;
}

export class OpenRouterFanoutProvider implements ReviewProvider {
  readonly id = "openrouter" as const;
  private readonly client: OpenRouterClient;

  constructor(private readonly cfg: OpenRouterFanoutConfig) {
    this.client = new OpenRouterClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  }

  async runReview(ctx: ReviewContext): Promise<ReviewModelRun[]> {
    const snapshot = await collectWorkdirSnapshot(ctx.workdir, ctx.baseRef);
    const prompt = buildReviewPrompt({
      handoff: ctx.handoff,
      diff: snapshot.diff,
      files: snapshot.files,
      maxInputTokens: this.cfg.maxInputTokens,
    });

    const settled = await Promise.allSettled(
      this.cfg.models.map((modelId) => this.runOne(modelId, prompt)),
    );

    return settled.map((res, i) => {
      const modelId = this.cfg.models[i];
      if (res.status === "fulfilled") {
        return { ...res.value, truncatedFiles: prompt.truncatedFiles || undefined };
      }
      const err = res.reason as Error;
      log.warn({ modelId, err: err.message }, "fanout model failed");
      return {
        modelId,
        providerId: "openrouter" as const,
        status: "failed" as const,
        findings: [],
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        errorMessage: err.message,
        truncatedFiles: prompt.truncatedFiles > 0 ? prompt.truncatedFiles : undefined,
      };
    });
  }

  private async runOne(
    modelId: string,
    prompt: ReturnType<typeof buildReviewPrompt>,
  ): Promise<ReviewModelRun> {
    const startedAt = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    try {
      const result = await this.client.chatCompletion(modelId, prompt.messages, {
        signal: ac.signal,
      });
      const findings = parseReviewFindings(result.content);
      return {
        modelId,
        providerId: "openrouter" as const,
        status: "completed" as const,
        findings,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const msg =
        ac.signal.aborted
          ? `timed out after ${this.cfg.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        modelId,
        providerId: "openrouter" as const,
        status: "failed" as const,
        findings: [],
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startedAt,
        errorMessage: msg,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
