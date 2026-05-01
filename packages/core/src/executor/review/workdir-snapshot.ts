import { gitExecSafe } from "../../repo/git.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorkdirSnapshot {
  diff: string;
  files: Array<{ path: string; body: string }>;
}

/**
 * Collect the diff against baseRef and the body of every changed file.
 * Used as input to the single-shot review prompt.
 */
export async function collectWorkdirSnapshot(
  workdir: string,
  baseRef: string,
): Promise<WorkdirSnapshot> {
  const diff = await gitExecSafe(["diff", `${baseRef}...HEAD`], workdir);
  const namesOut = await gitExecSafe(
    ["diff", "--name-only", `${baseRef}...HEAD`],
    workdir,
  );
  const paths = namesOut.split("\n").map((s) => s.trim()).filter(Boolean);
  const files: Array<{ path: string; body: string }> = [];
  for (const p of paths) {
    try {
      const body = await readFile(join(workdir, p), "utf8");
      files.push({ path: p, body });
    } catch {
      // file deleted in HEAD — skip
    }
  }
  return { diff, files };
}
