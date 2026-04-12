import type { Notifier, PipelineRun, StageResult, PipelineResult, PipelineError, DailyTokenSummary } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "DiscordNotifier" });

const COLOR_YELLOW = 0xffaa00;
const COLOR_GREEN = 0x00ff00;
const COLOR_RED = 0xff0000;

export class DiscordNotifier implements Notifier {
  constructor(private webhookUrl?: string) {}

  async onPipelineStart(run: PipelineRun): Promise<void> {
    await this.send({
      embeds: [{
        title: "Pipeline Started",
        description: `**${run.issueTitle}**\nPipeline: \`${run.pipelineKey}\`\nBranch: \`${run.branch}\``,
        color: COLOR_YELLOW,
      }],
    });
  }

  async onStageComplete(run: PipelineRun, stage: string, result: StageResult): Promise<void> {
    const color = result.status === "completed" ? COLOR_GREEN : COLOR_RED;
    const status = result.status === "completed" ? "Completed" : "Failed";

    await this.send({
      embeds: [{
        title: `Stage ${status}: ${stage}`,
        description: `**${run.issueTitle}**\nTokens: ${result.inputTokens.toLocaleString()} in / ${result.outputTokens.toLocaleString()} out`,
        color,
      }],
    });
  }

  async onPipelineComplete(run: PipelineRun, result: PipelineResult): Promise<void> {
    let description = `Stages: ${result.stagesCompleted}\nTokens: ${result.totalInputTokens.toLocaleString()} in / ${result.totalOutputTokens.toLocaleString()} out`;
    if (result.prUrl) {
      description += `\n[View PR](${result.prUrl})`;
    }

    await this.send({
      embeds: [{
        title: "Pipeline Complete",
        description,
        color: COLOR_GREEN,
      }],
    });
  }

  async onHumanReviewNeeded(run: PipelineRun, prUrl: string, reason: string): Promise<void> {
    await this.send({
      embeds: [{
        title: "Human Review Needed",
        description: `**${run.issueTitle}**\n[View PR](${prUrl})\n\n**Reason:** ${reason}\n\nPipeline: \`${run.pipelineKey}\` | Run: \`${run.id.slice(0, 8)}\``,
        color: COLOR_YELLOW,
      }],
    });
  }

  async onPipelineFailed(run: PipelineRun, error: PipelineError): Promise<void> {
    let description = `**Stage**: ${error.stage}\n**Error**: ${error.message}`;
    if (error.retriesExhausted) {
      description += `\nRetries exhausted`;
    }

    await this.send({
      embeds: [{
        title: "Pipeline Failed",
        description,
        color: COLOR_RED,
      }],
    });
  }

  async onTokenBudgetAlert(run: PipelineRun, usedTokens: number, maxTokens: number): Promise<void> {
    const pct = Math.round((usedTokens / maxTokens) * 100);
    await this.send({
      embeds: [{
        title: "Token Budget Alert",
        description: `**${run.issueTitle}**\nUsage: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${pct}%)\n\nPipeline: \`${run.pipelineKey}\` | Run: \`${run.id.slice(0, 8)}\``,
        color: COLOR_YELLOW,
      }],
    });
  }

  async onDailyTokenSummary(summary: DailyTokenSummary): Promise<void> {
    const totalTokens = summary.totalInputTokens + summary.totalOutputTokens;
    await this.send({
      embeds: [{
        title: `Daily Token Summary — ${summary.date}`,
        description: [
          `**Total tokens**: ${totalTokens.toLocaleString()} (${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out)`,
          `**Runs completed**: ${summary.runsCompleted}`,
          `**Runs failed**: ${summary.runsFailed}`,
        ].join("\n"),
        color: COLOR_GREEN,
      }],
    });
  }

  private async send(payload: object): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      log.error({ err: e }, "Discord notification failed");
    }
  }
}
