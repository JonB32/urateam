import { z } from "zod";

export const ReleaseManagerTriggersSchema = z.object({
  mergedPRsSince: z.number().int().positive().optional(),
  timeSinceLastHours: z.number().int().positive().optional(),
  ciGreenForMinutes: z.number().int().positive().optional(),
  requireSlackApproval: z.boolean().default(false),
});
export type ReleaseManagerTriggers = z.infer<typeof ReleaseManagerTriggersSchema>;

export const ReleaseManagerConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** Cron expression — defaults to every 30 minutes. Parsed by croner at scheduler start. */
    schedule: z.string().default("*/30 * * * *"),
    triggers: ReleaseManagerTriggersSchema,
    /** Version bump policy. "major" is intentionally absent — humans must retag manually. */
    versionBump: z.enum(["patch", "minor", "conventional-commits"]).default("patch"),
    /** Required when triggers.requireSlackApproval=true. Channel ID or "#name". */
    slackChannel: z.string().optional(),
    /** Branch the agent watches and tags from. */
    branch: z.string().default("main"),
    /** Optional path globs — only fire if PRs since last tag touched these files. v2 may add this. */
    paths: z.array(z.string()).optional(),
  })
  .superRefine((cfg, ctx) => {
    const t = cfg.triggers;
    const anyTrigger =
      t.mergedPRsSince !== undefined ||
      t.timeSinceLastHours !== undefined ||
      t.ciGreenForMinutes !== undefined ||
      t.requireSlackApproval === true;
    if (!anyTrigger) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggers"],
        message: "at least one trigger field must be set (mergedPRsSince, timeSinceLastHours, ciGreenForMinutes, or requireSlackApproval=true)",
      });
    }
    if (t.requireSlackApproval === true && !cfg.slackChannel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slackChannel"],
        message: "slackChannel is required when triggers.requireSlackApproval=true",
      });
    }
  });
export type ReleaseManagerConfig = z.infer<typeof ReleaseManagerConfigSchema>;

/** Computed snapshot of the world at decision time. */
export interface CollectedState {
  /** Last tag string in 'vX.Y.Z' form, or null if no tags exist yet. */
  lastTag: string | null;
  lastTagSha: string | null;
  lastTagAt: Date | null;
  /** SHA of the tip of the configured branch. */
  headSha: string;
  /** Count of commits between lastTagSha and headSha (a proxy for "merged PRs since last tag"). */
  mergedCommitsSinceLastTag: number;
  /** Subset of commit messages between lastTagSha and headSha — drives conventional-commits scan. */
  commitsSinceLastTag: Array<{ message: string }>;
  /** Aggregated CI status for headSha. "green" iff all required check_runs are "success". */
  ciStatus: "green" | "not-green" | "unavailable";
  /** Time at which CI first became green for headSha. null when not green or unavailable. */
  ciGreenSince: Date | null;
  /** True iff a fresh, un-consumed approval row exists for (repo, branch). */
  hasFreshApproval: boolean;
  /** Slack user id of the most recent fresh approval (for audit). null if hasFreshApproval=false. */
  freshApprovalApprover: string | null;
  /** True iff the latest tag in the repo is newer than what we last fired. Re-baselines counters. */
  manualTagDetected: boolean;
}

export type DecisionResult =
  | { kind: "fire"; reason: string }
  | { kind: "skip"; reason: string }
  | { kind: "awaiting-approval"; reason: string };
