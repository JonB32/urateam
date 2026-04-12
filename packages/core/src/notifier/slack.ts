import type { Notifier, PipelineRun, StageResult, PipelineResult, PipelineError, DailyTokenSummary } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "SlackNotifier" });

export class SlackNotifier implements Notifier {
  constructor(private webhookUrl?: string) {}

  async onPipelineStart(run: PipelineRun): Promise<void> {
    await this.send({
      blocks: [{
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🚀 *Pipeline started* — ${run.issueTitle}\nPipeline: \`${run.pipelineKey}\` | Branch: \`${run.branch}\``,
        },
      }],
    });
  }

  async onStageComplete(run: PipelineRun, stage: string, result: StageResult): Promise<void> {
    const emoji = result.status === "completed" ? "✅" : "❌";
    let text = `${emoji} *Stage complete: ${stage}* — ${run.issueTitle}\n`;
    text += `Status: ${result.status} | Tokens: ${result.inputTokens.toLocaleString()} in / ${result.outputTokens.toLocaleString()} out`;

    await this.send({
      blocks: [{
        type: "section",
        text: { type: "mrkdwn", text },
      }],
    });
  }

  async onPipelineComplete(run: PipelineRun, result: PipelineResult): Promise<void> {
    const emoji = result.autoMerged ? "🎉" : "✅";
    let text = `${emoji} *Pipeline complete* — ${run.issueTitle}\n`;
    text += `Stages: ${result.stagesCompleted} | Tokens: ${result.totalInputTokens.toLocaleString()} in / ${result.totalOutputTokens.toLocaleString()} out`;
    if (result.prUrl) {
      text += `\n<${result.prUrl}|View PR>`;
    }
    if (result.autoMerged) {
      text += `\n✅ Auto-merged to main`;
    }

    await this.send({
      blocks: [{
        type: "section",
        text: { type: "mrkdwn", text },
      }],
    });
  }

  async onHumanReviewNeeded(run: PipelineRun, prUrl: string, reason: string): Promise<void> {
    await this.send({
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "👀 Human Review Needed" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${run.issueTitle}*\n<${prUrl}|View PR>\n\n*Reason:* ${reason}`,
          },
        },
        {
          type: "context",
          elements: [{
            type: "mrkdwn",
            text: `Pipeline: \`${run.pipelineKey}\` | Run: \`${run.id.slice(0, 8)}\``,
          }],
        },
      ],
    });
  }

  async onPipelineFailed(run: PipelineRun, error: PipelineError): Promise<void> {
    let text = `❌ *Pipeline failed* — ${run.issueTitle}\n`;
    text += `Stage: ${error.stage} | Error: ${error.message}`;
    if (error.retriesExhausted) {
      text += `\nRetries exhausted`;
    }

    await this.send({
      blocks: [{
        type: "section",
        text: { type: "mrkdwn", text },
      }],
    });
  }

  async onTokenBudgetAlert(run: PipelineRun, usedTokens: number, maxTokens: number): Promise<void> {
    const pct = Math.round((usedTokens / maxTokens) * 100);
    await this.send({
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "⚠️ Token Budget Alert" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${run.issueTitle}*\nUsage: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${pct}%)`,
          },
        },
        {
          type: "context",
          elements: [{
            type: "mrkdwn",
            text: `Pipeline: \`${run.pipelineKey}\` | Run: \`${run.id.slice(0, 8)}\``,
          }],
        },
      ],
    });
  }

  async onDailyTokenSummary(summary: DailyTokenSummary): Promise<void> {
    const totalTokens = summary.totalInputTokens + summary.totalOutputTokens;
    await this.send({
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `📊 Daily Token Summary — ${summary.date}` },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              `*Total tokens*: ${totalTokens.toLocaleString()} (${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out)`,
              `*Runs completed*: ${summary.runsCompleted}`,
              `*Runs failed*: ${summary.runsFailed}`,
            ].join("\n"),
          },
        },
      ],
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
      log.error({ err: e }, "Slack notification failed");
    }
  }
}
