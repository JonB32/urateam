/**
 * Tier 1c — spec-vs-impl JSDoc gate.
 *
 * Scans newly-added JSDoc blocks for references to `config.X` / `opts.X` /
 * `env.X` / `deps.X` / `options.X` and verifies the referenced symbol exists
 * SOMEWHERE in the worktree's TS/TSX/JS files. If absent, the runner pushes a
 * blocking `category: "spec-vs-impl"` finding. Catches PR #254-style failures
 * where docs promised `implementProviderFallback` but it was never added to
 * the Zod schema or referenced in any implementation.
 *
 * The matcher is a pure function (`extractPromisedSymbols`) so the unit tests
 * don't need a git or worktree. The verification step (`isSymbolDefined`)
 * uses a configurable lookup so tests inject a fake source corpus.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  extractPromisedSymbols,
  checkSpecVsImplFromContent,
} from "../pipeline/spec-vs-impl-gate.js";

const ENV_KEY = "URATEAM_DISABLE_SPEC_VS_IMPL_GATE";

describe("extractPromisedSymbols — extracts config.X / opts.X / env.X / deps.X / options.X from JSDoc blocks", () => {
  it("extracts a single config.foo reference from a JSDoc block", () => {
    const content = `
/**
 * Does a thing. Reads \`config.maxAttempts\` to determine the limit.
 */
export function doThing() {}
`;
    expect(extractPromisedSymbols(content)).toEqual([
      { prefix: "config", symbol: "maxAttempts" },
    ]);
  });

  it("extracts multiple references across one block, deduplicated", () => {
    const content = `
/**
 * Uses config.maxAttempts and config.maxAttempts (twice) and opts.timeoutMs.
 * Also references env.NODE_ENV.
 */
`;
    const result = extractPromisedSymbols(content);
    // Order preserved on first occurrence; duplicates removed.
    expect(result).toEqual([
      { prefix: "config", symbol: "maxAttempts" },
      { prefix: "opts", symbol: "timeoutMs" },
      { prefix: "env", symbol: "NODE_ENV" },
    ]);
  });

  it("extracts the BEC-201-style case (docblock promises a non-existent provider-fallback field)", () => {
    // Synthetic symbol so the runtime corpus check isn't laundered by this
    // test file itself appearing in the worktree's tracked-source corpus.
    const content = `
/**
 * Configures the provider chain. When \`config.aBec201RegressionField\` is
 * set, the secondary provider is used if the primary fails.
 */
export const Schema = z.object({ implementProvider: z.string() });
`;
    expect(extractPromisedSymbols(content)).toEqual([
      { prefix: "config", symbol: "aBec201RegressionField" },
    ]);
  });

  it("handles multi-line JSDoc blocks", () => {
    const content = `
/**
 * Long block.
 *
 * @remarks
 * Reads
 *   config.foo
 * and
 *   opts.bar
 * to compute the result.
 */
`;
    expect(extractPromisedSymbols(content)).toEqual([
      { prefix: "config", symbol: "foo" },
      { prefix: "opts", symbol: "bar" },
    ]);
  });

  it("supports deps.X and options.X prefixes", () => {
    const content = `
/**
 * Uses deps.logger and options.timeout.
 */
`;
    expect(extractPromisedSymbols(content)).toEqual([
      { prefix: "deps", symbol: "logger" },
      { prefix: "options", symbol: "timeout" },
    ]);
  });
});

describe("extractPromisedSymbols — ignores code outside JSDoc blocks", () => {
  it("does NOT match references in regular code", () => {
    const content = `
const x = config.foo;
const y = opts.bar;
return env.NODE_ENV;
`;
    expect(extractPromisedSymbols(content)).toEqual([]);
  });

  it("does NOT match references in single-line // comments", () => {
    const content = `
// References config.foo in a line comment
const x = 1;
`;
    expect(extractPromisedSymbols(content)).toEqual([]);
  });

  it("does NOT match references in regular /* */ block comments (only JSDoc /** */)", () => {
    const content = `
/* config.foo here is in a regular block comment, not JSDoc */
const x = 1;
`;
    expect(extractPromisedSymbols(content)).toEqual([]);
  });

  it("returns empty for content without any JSDoc", () => {
    expect(extractPromisedSymbols("")).toEqual([]);
    expect(extractPromisedSymbols("const x = 1;\nfunction f() {}\n")).toEqual([]);
  });
});

describe("checkSpecVsImplFromContent — flags symbols not defined in any TS file", () => {
  it("BEC-201-style regression: docblock promises a config field absent from code → finding", () => {
    // Uses a synthetic symbol (rather than the real BEC-201 string) so that
    // the runtime corpus check is not laundered by this test file itself.
    const fileContent = `
/**
 * Configures the provider chain. When \`config.aBec201RegressionField\` is
 * set, the secondary provider is used if the primary fails.
 */
export const Schema = z.object({
  implementProvider: z.string(),
});
`;
    // Pretend the worktree's TS corpus contains only `implementProvider`, not
    // the promised `aBec201RegressionField`.
    const corpus = "implementProvider implementProvider implementProvider";

    const findings = checkSpecVsImplFromContent({
      files: [{ path: "src/pipeline/config.ts", content: fileContent }],
      corpusContainsSymbol: (sym) => corpus.includes(sym),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      filePath: "src/pipeline/config.ts",
      promisedSymbol: "aBec201RegressionField",
    });
  });

  it("emits one finding per (file, symbol), deduped across multiple JSDoc blocks in the same file", () => {
    const fileContent = `
/** First block: config.fooMissing */
export function a() {}

/** Second block: config.fooMissing again, and opts.barMissing */
export function b() {}
`;
    const findings = checkSpecVsImplFromContent({
      files: [{ path: "src/foo.ts", content: fileContent }],
      corpusContainsSymbol: () => false, // nothing defined
    });

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.promisedSymbol).sort()).toEqual([
      "barMissing",
      "fooMissing",
    ]);
  });

  it("emits findings per file when same symbol is promised in two files but defined in neither", () => {
    const findings = checkSpecVsImplFromContent({
      files: [
        { path: "a.ts", content: "/** config.zzz */" },
        { path: "b.ts", content: "/** config.zzz */" },
      ],
      corpusContainsSymbol: () => false,
    });

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.filePath).sort()).toEqual(["a.ts", "b.ts"]);
  });
});

describe("checkSpecVsImplFromContent — does NOT fire when the symbol IS defined somewhere", () => {
  it("config.maxAttempts in docs + maxAttempts in schema → no finding", () => {
    const fileContent = `
/**
 * Reads \`config.maxAttempts\` to determine the limit.
 */
export const PipelineConfigSchema = z.object({
  maxAttempts: z.number(),
});
`;
    const findings = checkSpecVsImplFromContent({
      files: [{ path: "src/config.ts", content: fileContent }],
      corpusContainsSymbol: (sym) => sym === "maxAttempts",
    });

    expect(findings).toEqual([]);
  });

  it("multiple promised symbols, all defined elsewhere → no findings", () => {
    const fileContent = `
/** Uses config.a, opts.b, env.c, deps.d. */
`;
    const defined = new Set(["a", "b", "c", "d"]);
    const findings = checkSpecVsImplFromContent({
      files: [{ path: "src/x.ts", content: fileContent }],
      corpusContainsSymbol: (sym) => defined.has(sym),
    });

    expect(findings).toEqual([]);
  });

  it("returns empty for an empty file list", () => {
    const findings = checkSpecVsImplFromContent({
      files: [],
      corpusContainsSymbol: () => false,
    });
    expect(findings).toEqual([]);
  });
});

describe("checkSpecVsImpl env-var escape hatch", () => {
  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("when URATEAM_DISABLE_SPEC_VS_IMPL_GATE=true, returns skipped=true and empty findings", async () => {
    process.env[ENV_KEY] = "true";
    const { checkSpecVsImpl } = await import("../pipeline/spec-vs-impl-gate.js");
    const result = await checkSpecVsImpl("/nonexistent", "main");
    expect(result).toEqual({ findings: [], skipped: true });
  });
});
