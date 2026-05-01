import { z } from "zod";
import { ReviewFindingSchema, type ReviewFinding, type HandoffArtifact } from "../../types.js";
import type { ChatMessage } from "./openrouter-client.js";

const SYSTEM_PROMPT = `You are a careful code reviewer. Review the diff and changed files for issues in three dimensions:
- reuse: duplication of existing code
- quality: bugs, error-handling, type misuse, edge cases
- efficiency: needless work, N+1 queries, hot-loop allocations

Output exactly one JSON object and nothing else, matching this shape:
{ "findings": [
    { "severity": "blocking" | "warning" | "suggestion",
      "file": "path/to/file.ext",
      "line": <integer>,
      "category": "reuse" | "quality" | "efficiency",
      "description": "<concise>",
      "fix": "<concrete suggestion>" }
  ]
}
Return an empty findings array if you find nothing.`;

export interface BuildPromptInput {
  handoff: HandoffArtifact;
  diff: string;
  files: Array<{ path: string; body: string }>;
  maxInputTokens: number;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  estimatedInputTokens: number;
  truncatedFiles: number;
}

/** Cheap heuristic: ~4 chars/token. Good enough to gate truncation. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function buildReviewPrompt(input: BuildPromptInput): BuiltPrompt {
  const { handoff, diff, files, maxInputTokens } = input;
  const intentBlock = [
    "## Intent",
    handoff.context.issueIntent,
    "",
    "## Constraints",
    ...handoff.context.constraints.map((c) => `- ${c}`),
    "",
    "## Assumptions",
    ...handoff.context.assumptions.map((a) => `- ${a}`),
    "",
  ].join("\n");

  const diffBlock = ["## Diff", "```diff", diff, "```", ""].join("\n");

  // Token-budget tail-truncate file bodies. Keep diff and intent always.
  const fixedTokens =
    estimateTokens(SYSTEM_PROMPT) +
    estimateTokens(intentBlock) +
    estimateTokens(diffBlock);
  let remaining = maxInputTokens - fixedTokens;
  const includedFiles: typeof files = [];
  let truncatedFiles = 0;
  for (const f of files) {
    const block = `\n## File: ${f.path}\n\`\`\`\n${f.body}\n\`\`\`\n`;
    const cost = estimateTokens(block);
    if (cost <= remaining) {
      includedFiles.push(f);
      remaining -= cost;
    } else {
      truncatedFiles += 1;
    }
  }

  const filesBlock = includedFiles
    .map((f) => `\n## File: ${f.path}\n\`\`\`\n${f.body}\n\`\`\`\n`)
    .join("");

  const userContent = `${intentBlock}\n${diffBlock}\n${filesBlock}`;

  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    estimatedInputTokens: fixedTokens + estimateTokens(filesBlock),
    truncatedFiles,
  };
}

const FindingsEnvelopeSchema = z.object({
  findings: z.array(ReviewFindingSchema),
});

/** Extract the first balanced top-level JSON object from a string. */
function extractFirstJsonObject(s: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function parseReviewFindings(raw: string): ReviewFinding[] {
  const objStr = extractFirstJsonObject(raw);
  if (!objStr)
    throw new Error(
      "model output not parseable as ReviewFinding[]: no JSON object found",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(objStr);
  } catch (e) {
    throw new Error(
      `model output not parseable as ReviewFinding[]: ${(e as Error).message}`,
    );
  }
  const result = FindingsEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `model output not parseable as ReviewFinding[]: ${result.error.message}`,
    );
  }
  return result.data.findings;
}
