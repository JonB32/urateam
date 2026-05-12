/**
 * Tier 1c — spec-vs-impl JSDoc gate.
 *
 * Catches the failure mode where the autonomous agent writes a JSDoc that
 * references a config / option / env / deps / options field by name, but
 * never actually adds that field to any schema or implementation. (The PR
 * #254 failure mode is detailed in `docs/superpowers/plans/2026-05-11-
 * pipeline-reliability-tiers.md`; we intentionally do NOT spell the
 * canonical example symbol here so the corpus check doesn't launder it
 * past the gate in regression tests.)
 *
 * Algorithm (per file in the agent's diff):
 *   1. Find every `/** ... *\/` block.
 *   2. Inside each block, extract identifiers matching
 *      `\b(config|opts|env|deps|options)\.([A-Za-z_][A-Za-z0-9_]*)\b`.
 *   3. For each unique (file, symbol), check whether the symbol exists in any
 *      `.ts` / `.tsx` / `.js` / `.jsx` file under the worktree.
 *   4. If not found, emit a `SpecVsImplFinding`. The runner pushes a
 *      `category: "spec-vs-impl"` blocking ReviewFinding and forces draft.
 *
 * Heuristic — false positives are accepted as warnings in v1. Calibrate after
 * two weeks of production data per the operator brief. Escape hatch:
 * `URATEAM_DISABLE_SPEC_VS_IMPL_GATE=true`.
 *
 * Architecture: the matcher (`extractPromisedSymbols`) is pure and unit-
 * tested directly. The corpus-lookup is injected via `corpusContainsSymbol`
 * so tests don't need a real worktree. The git layer
 * (`enumerateChangedTsFiles` + `buildWorktreeCorpus`) is glued together by
 * the public `checkSpecVsImpl` entry point.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gitExecSafe } from "../repo/git.js";

const PROMISED_REF_REGEX =
  /\b(config|opts|env|deps|options)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const JSDOC_BLOCK_REGEX = /\/\*\*[\s\S]*?\*\//g;

export interface PromisedSymbol {
  prefix: "config" | "opts" | "env" | "deps" | "options";
  symbol: string;
}

/**
 * Pure matcher: scans `content` for JSDoc blocks and returns the list of
 * `<prefix>.<symbol>` references inside them, preserving first-occurrence
 * order and deduplicating across blocks.
 */
export function extractPromisedSymbols(content: string): PromisedSymbol[] {
  const seen = new Set<string>();
  const result: PromisedSymbol[] = [];

  const jsdocBlocks = content.match(JSDOC_BLOCK_REGEX);
  if (!jsdocBlocks) return result;

  for (const block of jsdocBlocks) {
    for (const match of block.matchAll(PROMISED_REF_REGEX)) {
      const prefix = match[1] as PromisedSymbol["prefix"];
      const symbol = match[2]!;
      const key = `${prefix}.${symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ prefix, symbol });
    }
  }

  return result;
}

export interface SpecVsImplFinding {
  /** Worktree-relative path of the file that contains the JSDoc reference. */
  filePath: string;
  /** The bare symbol promised in the docblock (the part after the prefix —
   *  e.g. `maxAttempts` for a docblock that referenced `config.maxAttempts`). */
  promisedSymbol: string;
  /** The prefix it was referenced under (e.g. `config`). */
  promisedPrefix: PromisedSymbol["prefix"];
}

/**
 * Pure orchestrator for the per-file check. Given a list of changed files
 * (path + content) and a corpus-lookup function, returns the list of
 * findings. Exported for unit testing; the runner uses `checkSpecVsImpl`
 * instead.
 */
export function checkSpecVsImplFromContent(args: {
  files: Array<{ path: string; content: string }>;
  corpusContainsSymbol: (symbol: string) => boolean;
}): SpecVsImplFinding[] {
  const findings: SpecVsImplFinding[] = [];
  for (const file of args.files) {
    const promised = extractPromisedSymbols(file.content);
    for (const p of promised) {
      if (!args.corpusContainsSymbol(p.symbol)) {
        findings.push({
          filePath: file.path,
          promisedSymbol: p.symbol,
          promisedPrefix: p.prefix,
        });
      }
    }
  }
  return findings;
}

export interface SpecVsImplResult {
  findings: SpecVsImplFinding[];
  skipped: boolean;
}

const TS_EXT_REGEX = /\.(tsx?|jsx?)$/;

/**
 * Enumerate TS/TSX/JS/JSX files added or modified vs `origin/<baseBranch>`.
 * The gate only inspects the agent's own changes; pre-existing JSDoc drift in
 * the rest of the repo is not in scope.
 *
 * Fail-open: a git error returns an empty list.
 */
async function enumerateChangedTsFiles(
  worktreePath: string,
  baseBranch: string,
): Promise<string[]> {
  const out = await gitExecSafe(
    [
      "diff",
      "--name-only",
      "--diff-filter=AM",
      `origin/${baseBranch}...HEAD`,
    ],
    worktreePath,
  );
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => TS_EXT_REGEX.test(p));
}

/**
 * Build a string corpus by concatenating every TS/TSX/JS/JSX file under the
 * worktree (excluding `node_modules`, `dist`, `.git`). The corpus is searched
 * via `.includes(symbol)` — fast and good enough for heuristic detection.
 * False positives are acceptable per the brief.
 */
async function buildWorktreeCorpus(worktreePath: string): Promise<string> {
  const out = await gitExecSafe(
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*.ts",
      "*.tsx",
      "*.js",
      "*.jsx",
    ],
    worktreePath,
  );
  const paths = out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  let corpus = "";
  for (const p of paths) {
    try {
      corpus += "\n" + (await readFile(join(worktreePath, p), "utf8"));
    } catch {
      // Skip unreadable files; the corpus is best-effort.
    }
  }
  return corpus;
}

/**
 * Public entry point. Scans the agent's added/modified TS files for JSDoc
 * references that aren't defined anywhere in the worktree's tracked source.
 * Returns a flat list of findings.
 *
 * Escape hatch: `URATEAM_DISABLE_SPEC_VS_IMPL_GATE=true` short-circuits.
 *
 * Fail-open behavior: errors during git or filesystem access return an empty
 * result with `skipped: false`. The runner additionally wraps the call in a
 * try/catch and logs a warning rather than blocking the pipeline.
 */
export async function checkSpecVsImpl(
  worktreePath: string,
  baseBranch: string,
): Promise<SpecVsImplResult> {
  if (process.env.URATEAM_DISABLE_SPEC_VS_IMPL_GATE === "true") {
    return { findings: [], skipped: true };
  }

  const changedFiles = await enumerateChangedTsFiles(worktreePath, baseBranch);
  if (changedFiles.length === 0) {
    return { findings: [], skipped: false };
  }

  // Read only the changed files for the JSDoc scan. The corpus (used for
  // symbol existence) is built once over the whole worktree.
  const filePairs: Array<{ path: string; content: string }> = [];
  for (const p of changedFiles) {
    try {
      const content = await readFile(join(worktreePath, p), "utf8");
      filePairs.push({ path: p, content });
    } catch {
      // Skip — likely deleted in HEAD; not relevant for the JSDoc scan.
    }
  }

  if (filePairs.length === 0) {
    return { findings: [], skipped: false };
  }

  const corpus = await buildWorktreeCorpus(worktreePath);

  const findings = checkSpecVsImplFromContent({
    files: filePairs,
    corpusContainsSymbol: (sym) => corpus.includes(sym),
  });

  return { findings, skipped: false };
}
