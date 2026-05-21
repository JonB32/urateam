import type { Notifier, PipelineRun, StageResult, PipelineResult, PipelineError } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "LinearNotifier" });

/**
 * Simple bounded TTL cache.  Entries expire after `ttlMs` milliseconds.
 * When the map reaches `maxSize`, the oldest inserted entry is evicted
 * (insertion-order eviction via Map's guaranteed iteration order).
 */
class TTLCache<K, V> {
  private entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize: number,
  ) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): void {
    if (this.entries.size >= this.maxSize && !this.entries.has(key)) {
      // Evict the oldest entry (first in insertion order)
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) this.entries.delete(firstKey);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

export const LINEAR_STATES = {
  IN_PROGRESS: "In Progress",
  IN_REVIEW: "In Review",
  DONE: "Done",
  BLOCKED: "Blocked",
} as const;

export interface LinearNotifierConfig {
  apiKey: string;
}

export class LinearNotifier implements Notifier {
  private apiKey: string;
  // Bounded TTL caches: 15-min expiry, max 500/1000 entries.
  // Prevents unbounded memory growth in long-running services processing
  // hundreds of teams and issues.
  private stateCache = new TTLCache<string, string>(15 * 60 * 1000, 500);
  private issueIdCache = new TTLCache<string, { id: string; teamId?: string }>(15 * 60 * 1000, 1000);
  private clientPromise: Promise<any> | null = null;

  constructor(config: LinearNotifierConfig) {
    this.apiKey = config.apiKey;
  }

  private async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = import("@linear/sdk").then(
        ({ LinearClient }) => new LinearClient({ apiKey: this.apiKey }),
      );
    }
    return this.clientPromise;
  }

  async onPipelineStart(run: PipelineRun): Promise<void> {
    await Promise.all([
      this.postComment(run.issueId,
        `🤖 **Agent Run #${run.id.slice(0, 8)}** — Pipeline: ${run.pipelineKey}\n\n` +
        `Branch: \`${run.branch}\`\n` +
        `Repo: ${run.repoUrl}\n\n` +
        `Starting pipeline...`
      ),
      this.transitionState(run.issueId, LINEAR_STATES.IN_PROGRESS),
    ]);
  }

  async onStageComplete(run: PipelineRun, stage: string, result: StageResult): Promise<void> {
    const status = result.status === "completed" ? "✅" : "❌";
    let comment = `🤖 **Agent Run #${run.id.slice(0, 8)}** — Stage: ${stage} ${status}\n\n`;

    if (result.handoffArtifact) {
      const ha = result.handoffArtifact;
      comment += `**Files changed**: ${ha.filesChanged.join(", ") || "none"}\n`;
      if (ha.context.testResults) {
        const tr = ha.context.testResults;
        comment += `**Tests**: ${tr.passed} passed, ${tr.failed} failed\n`;
      }
    }
    comment += `**Tokens used**: ${result.inputTokens.toLocaleString()} input / ${result.outputTokens.toLocaleString()} output\n`;

    await this.postComment(run.issueId, comment);
  }

  async onPipelineComplete(run: PipelineRun, result: PipelineResult): Promise<void> {
    let comment = `🤖 **Agent Run #${run.id.slice(0, 8)}** — Pipeline Complete ✅\n\n`;
    if (result.prUrl) {
      comment += `**PR**: ${result.prUrl}\n`;
    }
    comment += `**Stages completed**: ${result.stagesCompleted}\n`;
    comment += `**Total tokens**: ${result.totalInputTokens.toLocaleString()} input / ${result.totalOutputTokens.toLocaleString()} output\n`;
    if (result.autoMerged) {
      comment += `\n✅ **Auto-merged** — changes were trivial and passed all checks.`;
    }

    const tasks: Promise<void>[] = [this.postComment(run.issueId, comment)];
    if (result.autoMerged) {
      tasks.push(this.transitionState(run.issueId, LINEAR_STATES.DONE));
    } else if (result.prUrl) {
      // BEC-165: ensure every pipeline that opens a PR moves Linear off
      // "In Progress". Previously this was delegated to onHumanReviewNeeded,
      // but the runner doesn't call that on every PR-creating path (e.g.
      // auto-implement with autoMerge:false, no draft-flagging, no rebase
      // conflict). Without this catch-all, the issue stayed on "In Progress"
      // and recover-stuck moved it back to Backlog 30 min later → re-run
      // loop on completed work, burning agent + OpenRouter tokens.
      // Idempotent w/ onHumanReviewNeeded's transition (paths that call both
      // see one extra Linear API call, no behavior change).
      tasks.push(this.transitionState(run.issueId, LINEAR_STATES.IN_REVIEW));
    }
    await Promise.all(tasks);
  }

  async onHumanReviewNeeded(run: PipelineRun, prUrl: string, reason: string): Promise<void> {
    await Promise.all([
      this.postComment(run.issueId,
        `🤖 **Agent Run #${run.id.slice(0, 8)}** — Human Review Needed 👀\n\n` +
        `**PR**: ${prUrl}\n` +
        `**Reason**: ${reason}\n\n` +
        `Please review and merge manually.`
      ),
      this.transitionState(run.issueId, LINEAR_STATES.IN_REVIEW),
    ]);
  }

  async onPRMerged(run: PipelineRun): Promise<void> {
    await Promise.all([
      this.postComment(run.issueId,
        `🤖 **Agent Run #${run.id.slice(0, 8)}** — PR Merged ✅\n\n` +
        (run.prUrl ? `**PR**: ${run.prUrl}\n\n` : "") +
        `The pull request has been merged.`
      ),
      this.transitionState(run.issueId, LINEAR_STATES.DONE),
    ]);
  }

  // onDailyTokenSummary intentionally omitted — daily summaries are cross-run
  // aggregates that don't map to per-issue comments. Use Slack/Discord instead.

  async onTokenBudgetAlert(run: PipelineRun, usedTokens: number, maxTokens: number): Promise<void> {
    const pct = Math.round((usedTokens / maxTokens) * 100);
    await this.postComment(run.issueId,
      `🤖 **Agent Run #${run.id.slice(0, 8)}** — ⚠️ Token Budget Warning\n\n` +
      `Usage: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${pct}%)\n` +
      `The run will be aborted if the budget is exceeded.`
    );
  }

  async onPipelineFailed(run: PipelineRun, error: PipelineError): Promise<void> {
    await Promise.all([
      this.postComment(run.issueId,
        `🤖 **Agent Run #${run.id.slice(0, 8)}** — Pipeline Failed ❌\n\n` +
        `**Failed at stage**: ${error.stage}\n` +
        `**Error**: ${error.message}\n` +
        `**Retries exhausted**: ${error.retriesExhausted ? "Yes" : "No"}\n`
      ),
      this.transitionState(run.issueId, LINEAR_STATES.BLOCKED),
    ]);
  }

  private async resolveIssueId(issueIdentifier: string): Promise<{ id: string; teamId?: string } | null> {
    const cached = this.issueIdCache.get(issueIdentifier);
    if (cached) return cached;

    const client = await this.getClient();
    const results = await client.searchIssues(issueIdentifier);
    const issue = results.nodes[0];
    if (!issue) return null;

    const teamId = (await issue.team)?.id;
    const resolved = { id: issue.id, teamId };
    this.issueIdCache.set(issueIdentifier, resolved);
    return resolved;
  }

  private async postComment(issueIdentifier: string, body: string): Promise<void> {
    try {
      const client = await this.getClient();
      const resolved = await this.resolveIssueId(issueIdentifier);
      if (resolved) {
        await client.createComment({ issueId: resolved.id, body });
      }
    } catch (e) {
      log.error({ issueIdentifier, err: e }, "failed to post Linear comment");
    }
  }

  private async transitionState(issueIdentifier: string, stateName: string): Promise<void> {
    try {
      const client = await this.getClient();
      const resolved = await this.resolveIssueId(issueIdentifier);
      if (!resolved?.teamId) return;

      const { teamId } = resolved;
      if (!this.stateCache.has(`${teamId}:${stateName}`)) {
        const team = await client.team(teamId!);
        const states = await team.states();
        for (const state of states.nodes) {
          this.stateCache.set(`${teamId}:${state.name}`, state.id);
        }
      }

      const stateId = this.stateCache.get(`${teamId}:${stateName}`);
      if (stateId) {
        await client.updateIssue(resolved.id, { stateId });
      }
    } catch (e) {
      log.error({ issueIdentifier, stateName, err: e }, "failed to transition Linear issue state");
    }
  }
}
