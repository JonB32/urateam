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
// Module-level constants
// ---------------------------------------------------------------------------

/** Default workflow state name to use when creating new Linear tickets. */
export const DEFAULT_TRIAGE_STATE_NAME = "Triage";

/** Maximum number of GitHub issues fetched per page from the REST API. */
const GITHUB_ISSUES_PER_PAGE = 100;

/**
 * Linear state `type` values that indicate a ticket is fully complete.
 * The `type` field is an enum on the Linear side and is the preferred check.
 */
const COMPLETED_STATE_TYPES: ReadonlySet<string> = new Set(["completed"]);

/**
 * Linear state `name` values (lower-cased) that indicate a ticket is Done.
 * Used as a fallback when `type` is absent from the API response.
 */
const COMPLETED_STATE_NAMES: ReadonlySet<string> = new Set(["done"]);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable error message from an unknown thrown value.
 * Avoids duplicating `err instanceof Error ? err.message : String(err)` across files.
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
   * When multiple labels are provided, **OR semantics** apply: issues matching
   * ANY of the listed labels are included (not only those carrying all labels).
   * Duplicates (issues with multiple matching labels) are deduplicated by number.
   * Example: `["urateam-quality-observer", "bug", "enhancement"]`
   */
  labelFilters?: string[];
  /**
   * Name of the Linear workflow state for new tickets.
   * Defaults to `DEFAULT_TRIAGE_STATE_NAME` ("Triage").
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
 *
 * Linear lookups are parallelised with `Promise.all` to minimise wall-clock
 * time when processing many issues.
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

  const triageStateName = config.triageStateName ?? DEFAULT_TRIAGE_STATE_NAME;

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

  // Validate and split the githubRepo string before any API call.
  const parts = config.githubRepo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid githubRepo format '${config.githubRepo}'. Expected 'owner/repo'.`,
    );
  }
  const [owner, repo] = parts as [string, string];

  // Fetch open GitHub issues (filtered by labels when provided).
  // The GitHub REST API treats comma-separated labels as AND (intersection),
  // not OR (union). To get OR semantics for multiple label filters, we call
  // listIssues once per label and deduplicate by issue number.
  let ghIssues: GitHubIssue[];
  if (!config.labelFilters || config.labelFilters.length <= 1) {
    // Single call: no filter, or exactly one label (no AND/OR ambiguity).
    ghIssues = await clients.github.listIssues({
      owner,
      repo,
      labels: config.labelFilters?.[0],
      state: "open",
      per_page: GITHUB_ISSUES_PER_PAGE,
    });
  } else {
    // Multiple labels: call once per label to get OR semantics, then dedup.
    const perLabelResults = await Promise.all(
      config.labelFilters.map((label) =>
        clients.github.listIssues({
          owner,
          repo,
          labels: label,
          state: "open",
          per_page: GITHUB_ISSUES_PER_PAGE,
        }),
      ),
    );
    // Deduplicate by issue number (Map preserves insertion order; first occurrence wins).
    const seen = new Map<number, GitHubIssue>();
    for (const batch of perLabelResults) {
      for (const issue of batch) {
        if (!seen.has(issue.number)) {
          seen.set(issue.number, issue);
        }
      }
    }
    ghIssues = [...seen.values()];
  }

  log.info(
    { count: ghIssues.length, repo: config.githubRepo },
    "fetched open GitHub issues",
  );

  // Parallelise all Linear "does this ticket exist?" lookups before processing.
  // With N issues this reduces wall-clock time from O(N × RTT) to O(RTT).
  const existingTickets = await Promise.all(
    ghIssues.map((issue) =>
      findLinearTicketForGhIssue(
        clients.linear,
        issue.number,
        config.linearTeamId,
      ).catch((err) => {
        log.warn(
          { err, ghNumber: issue.number },
          "failed to look up Linear ticket for GH issue; will treat as not found",
        );
        return null;
      }),
    ),
  );

  for (let i = 0; i < ghIssues.length; i++) {
    const ghIssue = ghIssues[i]!;
    const existing = existingTickets[i] ?? null;
    result.processed++;

    try {
      if (existing) {
        log.info(
          { ghNumber: ghIssue.number, linearId: existing.identifier },
          "GH issue already synced to Linear — skipping",
        );
        result.skipped++;

        // Bidirectional close: close GH issue if Linear ticket is Done.
        if (config.bidirectionalClose) {
          const isDone =
            COMPLETED_STATE_TYPES.has(existing.state.type ?? "") ||
            COMPLETED_STATE_NAMES.has(existing.state.name?.toLowerCase() ?? "");

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
      const msg = getErrorMessage(err);
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
        per_page: per_page ?? GITHUB_ISSUES_PER_PAGE,
      });
      // Octokit's `listForRepo` returns both issues and PRs; filter PRs out.
      // Cast via `unknown` to bridge Octokit's detailed item type to our minimal
      // interface — the fields we rely on (`number`, `title`, `body`, `html_url`,
      // `labels`, `state`) are always present on non-PR issue responses.
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
 *
 * The `as Promise<...>` casts below are safe because:
 * 1. The SDK returns objects that match the interface at runtime — we only
 *    request fields present in every Linear issue/state/workflow-state response.
 * 2. Tests use mock clients that satisfy the interface without any SDK coupling,
 *    so mismatches surface immediately in CI if the SDK changes shape.
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
