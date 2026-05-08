// SPDX-License-Identifier: BUSL-1.1
/**
 * GitHub Issues → Linear sync utility.
 *
 * Syncs open GitHub issues to Linear tickets in a Triage state.
 * Idempotent via `[GH#NNN]` title-prefix convention.
 *
 * Optionally closes GitHub issues when their Linear counterpart reaches a
 * completed state (bidirectional close-out, gated behind `bidirectionalClose`).
 *
 * Usage:
 *   - Invoke from scripts/gh-linear-sync.ts (GitHub Action entry point).
 *   - Inject mock clients in tests for deterministic unit testing.
 *
 * Operator mental model:
 *   GitHub = inbound (public filings, quality-observer findings)
 *   Linear  = triage / work-tracking / autonomous-pipeline routing
 */
import { createLogger } from "../logger.js";

const log = createLogger({ component: "gh-linear-sync" });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Idempotency marker written into the Linear issue body. */
export function makeIdempotencyMarker(ghIssueNumber: number): string {
  return `<!-- gh-linear-sync:${ghIssueNumber} -->`;
}

/**
 * Minimal GitHub issue shape returned by the REST API.
 * Pull-requests share the same endpoint and must be filtered out by callers.
 */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name?: string }>;
  state: string;
}

/** Minimal Linear issue shape needed for sync decisions. */
export interface LinearSyncIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: { name: string; type?: string };
}

/** Minimal Linear workflow state shape. */
export interface LinearSyncState {
  id: string;
  name: string;
  type?: string;
}

/**
 * Mockable GitHub REST client interface.
 * The real implementation wraps `@octokit/rest` (created by `createGitHubSyncClientFromToken`).
 */
export interface GitHubSyncClient {
  listIssues(options: {
    owner: string;
    repo: string;
    labels?: string;
    state?: "open" | "closed" | "all";
    per_page?: number;
  }): Promise<GitHubIssue[]>;
  closeIssue(options: {
    owner: string;
    repo: string;
    issue_number: number;
  }): Promise<void>;
}

/**
 * Mockable Linear client interface.
 * The real implementation wraps `@linear/sdk` (created by `createLinearSyncClientFromApiKey`).
 */
export interface LinearSyncClient {
  issues(args: {
    filter: object;
    first?: number;
  }): Promise<{ nodes: LinearSyncIssue[] }>;
  workflowStates(args: {
    filter: object;
  }): Promise<{ nodes: LinearSyncState[] }>;
  createIssue(input: {
    teamId: string;
    title: string;
    description: string;
    stateId: string;
  }): Promise<{ issue?: { id: string; identifier: string } | null }>;
}

/** Configuration for a single sync run. */
export interface GhLinearSyncConfig {
  /** GitHub personal access token (or `GITHUB_TOKEN` from GH Actions). */
  githubToken: string;
  /** Repository in `"owner/repo"` format. */
  githubRepo: string;
  /** Linear API key. */
  linearApiKey: string;
  /** Linear team ID to create issues in. */
  linearTeamId: string;
  /**
   * GitHub label names to filter issues by.
   * When empty or omitted, all open issues are processed.
   * Example: `["urateam-quality-observer", "bug", "enhancement"]`
   */
  labelFilters?: string[];
  /**
   * Name of the Linear workflow state for new tickets.
   * Defaults to `"Triage"`.
   */
  triageStateName?: string;
  /**
   * When `true`, GitHub issues whose Linear counterpart has moved to a
   * completed state are automatically closed on GitHub.
   * Default: `false`.
   */
  bidirectionalClose?: boolean;
  /**
   * When `true`, log planned actions but skip all writes.
   * Useful for validating the configuration without mutating data.
   * Default: `false`.
   */
  dryRun?: boolean;
}

/** Summary of a completed sync run. */
export interface SyncResult {
  /** Number of GitHub issues examined. */
  processed: number;
  /** Number of new Linear tickets created. */
  created: number;
  /** Number of GitHub issues already tracked in Linear (skipped). */
  skipped: number;
  /** Number of GitHub issues closed (bidirectional close). */
  closed: number;
  /** Per-issue error messages for issues that could not be synced. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

/**
 * Find an existing Linear ticket for a GitHub issue by the `[GH#NNN]` title
 * prefix convention. Returns `null` if no matching ticket exists.
 */
export async function findLinearTicketForGhIssue(
  linearClient: LinearSyncClient,
  ghIssueNumber: number,
  teamId: string,
): Promise<LinearSyncIssue | null> {
  const titlePrefix = `[GH#${ghIssueNumber}]`;

  const results = await linearClient.issues({
    filter: {
      team: { id: { eq: teamId } },
      title: { startsWith: titlePrefix },
    },
    first: 1,
  });

  return results.nodes[0] ?? null;
}

/**
 * Create a Linear ticket for a GitHub issue in the specified state.
 *
 * The body includes:
 * - Original GitHub issue body
 * - A permalink back to the GitHub issue
 * - An idempotency marker (`<!-- gh-linear-sync:NNN -->`)
 */
export async function createLinearTicketForGhIssue(
  linearClient: LinearSyncClient,
  ghIssue: GitHubIssue,
  teamId: string,
  triageStateId: string,
): Promise<{ id: string; identifier: string }> {
  const marker = makeIdempotencyMarker(ghIssue.number);
  const title = `[GH#${ghIssue.number}] ${ghIssue.title}`;
  const description = [
    ghIssue.body ?? "",
    "",
    "---",
    `**Source:** [GitHub Issue #${ghIssue.number}](${ghIssue.html_url})`,
    "",
    marker,
  ].join("\n");

  const result = await linearClient.createIssue({
    teamId,
    title,
    description,
    stateId: triageStateId,
  });

  if (!result.issue) {
    throw new Error(
      `Linear createIssue returned no issue for GH#${ghIssue.number}`,
    );
  }

  return result.issue;
}

/**
 * Run the GitHub → Linear sync.
 *
 * For each open GitHub issue that matches the label filters:
 * 1. Checks if a Linear ticket already exists (via `[GH#NNN]` title prefix).
 * 2. If not, creates one in the Triage state.
 * 3. If `bidirectionalClose` is enabled and the Linear ticket is Done,
 *    closes the corresponding GitHub issue.
 *
 * The operation is **idempotent**: calling it multiple times for the same
 * GitHub issue will not create duplicate Linear tickets.
 */
export async function runGhLinearSync(
  config: GhLinearSyncConfig,
  clients: {
    github: GitHubSyncClient;
    linear: LinearSyncClient;
  },
): Promise<SyncResult> {
  const result: SyncResult = {
    processed: 0,
    created: 0,
    skipped: 0,
    closed: 0,
    errors: [],
  };

  const triageStateName = config.triageStateName ?? "Triage";

  // Resolve workflow states once up-front.
  const statesResp = await clients.linear.workflowStates({
    filter: { team: { id: { eq: config.linearTeamId } } },
  });

  const triageState = statesResp.nodes.find((s) => s.name === triageStateName);
  if (!triageState) {
    const available = statesResp.nodes.map((s) => s.name).join(", ");
    throw new Error(
      `Linear state "${triageStateName}" not found for team ${config.linearTeamId}. ` +
        `Available states: ${available}`,
    );
  }

  const [owner, repo] = config.githubRepo.split("/");

  // Fetch open GitHub issues (filtered by labels when provided).
  const ghIssues = await clients.github.listIssues({
    owner,
    repo,
    labels: config.labelFilters?.join(","),
    state: "open",
    per_page: 100,
  });

  log.info(
    { count: ghIssues.length, repo: config.githubRepo },
    "fetched open GitHub issues",
  );

  for (const ghIssue of ghIssues) {
    result.processed++;

    try {
      const existing = await findLinearTicketForGhIssue(
        clients.linear,
        ghIssue.number,
        config.linearTeamId,
      );

      if (existing) {
        log.info(
          { ghNumber: ghIssue.number, linearId: existing.identifier },
          "GH issue already synced to Linear — skipping",
        );
        result.skipped++;

        // Bidirectional close: close GH issue if Linear ticket is Done.
        if (config.bidirectionalClose) {
          const isDone =
            existing.state.type === "completed" ||
            existing.state.name.toLowerCase() === "done";

          if (isDone) {
            if (!config.dryRun) {
              await clients.github.closeIssue({
                owner,
                repo,
                issue_number: ghIssue.number,
              });
            }
            log.info(
              {
                ghNumber: ghIssue.number,
                linearId: existing.identifier,
                dryRun: config.dryRun ?? false,
              },
              "closed GH issue (Linear ticket is Done)",
            );
            result.closed++;
          }
        }
      } else {
        // Create a new Linear ticket for this GitHub issue.
        if (!config.dryRun) {
          const created = await createLinearTicketForGhIssue(
            clients.linear,
            ghIssue,
            config.linearTeamId,
            triageState.id,
          );
          log.info(
            { ghNumber: ghIssue.number, linearId: created.identifier },
            "created Linear ticket for GH issue",
          );
        } else {
          log.info(
            {
              ghNumber: ghIssue.number,
              title: ghIssue.title,
              dryRun: true,
            },
            "[dry-run] would create Linear ticket",
          );
        }
        result.created++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, ghNumber: ghIssue.number }, "failed to sync GH issue");
      result.errors.push(`GH#${ghIssue.number}: ${msg}`);
    }
  }

  log.info(result, "gh-linear-sync complete");
  return result;
}

// ---------------------------------------------------------------------------
// Real client factories (used by scripts/gh-linear-sync.ts)
// ---------------------------------------------------------------------------

/**
 * Create a `GitHubSyncClient` backed by `@octokit/rest`.
 * Pull-requests are automatically excluded from `listIssues` results.
 */
export async function createGitHubSyncClientFromToken(
  token: string,
): Promise<GitHubSyncClient> {
  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({ auth: token });

  return {
    async listIssues({ owner, repo, labels, state, per_page }) {
      const resp = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        labels,
        state: state ?? "open",
        per_page: per_page ?? 100,
      });
      // Octokit's `listForRepo` returns both issues and PRs; filter PRs out.
      // Cast via unknown to bridge the Octokit item type to our minimal interface.
      return resp.data.filter(
        (i) => !("pull_request" in i && i.pull_request),
      ) as unknown as GitHubIssue[];
    },
    async closeIssue({ owner, repo, issue_number }) {
      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number,
        state: "closed",
      });
    },
  };
}

/**
 * Create a `LinearSyncClient` backed by `@linear/sdk`.
 *
 * The Linear SDK uses lazy Promise-like relations for fields such as `state`.
 * The factory casts via `unknown` to bridge the SDK's complex types to our
 * minimal flat interface (which the real data satisfies at runtime).
 */
export async function createLinearSyncClientFromApiKey(
  apiKey: string,
): Promise<LinearSyncClient> {
  const { LinearClient } = await import("@linear/sdk");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = new LinearClient({ apiKey });

  return {
    async issues(args) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      return client.issues(args) as Promise<{ nodes: LinearSyncIssue[] }>;
    },
    async workflowStates(args) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      return client.workflowStates(args) as Promise<{ nodes: LinearSyncState[] }>;
    },
    async createIssue(input) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      return client.createIssue(input) as Promise<{
        issue?: { id: string; identifier: string } | null;
      }>;
    },
  };
}
