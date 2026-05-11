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
  mergeMRWhenPipelineSucceeds,
} from "./gitlab.js";
export type { GitLabConfig, CreateMROptions } from "./gitlab.js";

export {
  buildBitbucketAuthenticatedUrl,
  createBitbucketPR,
  addBitbucketPRComment,
  mergeBitbucketPR,
  parseBitbucketUrl,
} from "./bitbucket.js";
export type { BitbucketConfig, CreateBitbucketPROptions } from "./bitbucket.js";

export { resolveRepo, parseRepoUrl, parseGitLabUrl } from "./config.js";
