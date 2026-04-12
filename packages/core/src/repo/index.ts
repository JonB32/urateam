export {
  gitExec,
  gitExecSafe,
  gitExecRaw,
  cloneRepo,
  fetchLatest,
  createWorktree,
  createWorktreeFromRemote,
  deleteWorktree,
  pushBranch,
  pushBranchForce,
  autoCommitChanges,
  rebaseBranch,
  abortRebase,
  createPRViaCli,
  mergePRViaCli,
  getDiffLineCount,
  checkDuplicateBranch,
  branchName,
  getCurrentBranch,
  verifyBranchMatch,
  installPrePushHook,
  cleanupWorktrees,
} from "./git.js";

export {
  createGitHubClient,
  createPR,
  addPRComment,
} from "./github.js";
export type { GitHubConfig, CreatePROptions } from "./github.js";

export {
  buildAuthenticatedUrl,
  createMR,
  addMRComment,
} from "./gitlab.js";
export type { GitLabConfig, CreateMROptions } from "./gitlab.js";

export { resolveRepo, parseRepoUrl, parseGitLabUrl } from "./config.js";
