import type { Notifier, PipelineRun, StageResult, PipelineResult, PipelineError, DailyTokenSummary } from "../types.js";

export class CompositeNotifier implements Notifier {
  constructor(private notifiers: Notifier[]) {}

  async onPipelineStart(run: PipelineRun): Promise<void> {
    await Promise.allSettled(this.notifiers.map(n => n.onPipelineStart(run)));
  }

  async onStageComplete(run: PipelineRun, stage: string, result: StageResult): Promise<void> {
    await Promise.allSettled(this.notifiers.map(n => n.onStageComplete(run, stage, result)));
  }

  async onPipelineComplete(run: PipelineRun, result: PipelineResult): Promise<void> {
    await Promise.allSettled(this.notifiers.map(n => n.onPipelineComplete(run, result)));
  }

  async onPipelineFailed(run: PipelineRun, error: PipelineError): Promise<void> {
    await Promise.allSettled(this.notifiers.map(n => n.onPipelineFailed(run, error)));
  }

  async onHumanReviewNeeded(run: PipelineRun, prUrl: string, reason: string): Promise<void> {
    await Promise.allSettled(
      this.notifiers.map(n => n.onHumanReviewNeeded?.(run, prUrl, reason)),
    );
  }

  async onTokenBudgetAlert(run: PipelineRun, usedTokens: number, maxTokens: number): Promise<void> {
    await Promise.allSettled(
      this.notifiers.filter(n => n.onTokenBudgetAlert).map(n => n.onTokenBudgetAlert!(run, usedTokens, maxTokens)),
    );
  }

  async onDailyTokenSummary(summary: DailyTokenSummary): Promise<void> {
    await Promise.allSettled(
      this.notifiers.filter(n => n.onDailyTokenSummary).map(n => n.onDailyTokenSummary!(summary)),
    );
  }

  async onPRMerged(run: PipelineRun): Promise<void> {
    await Promise.allSettled(
      this.notifiers.filter(n => n.onPRMerged).map(n => n.onPRMerged!(run)),
    );
  }
}
