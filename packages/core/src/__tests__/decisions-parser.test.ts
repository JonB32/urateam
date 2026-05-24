import { describe, it, expect } from "vitest";
import { parseDecisionsBlock } from "../executor/extract-handoff.js";

const validAgentOutput = `
Some agent prose explaining the work...

<decisions>
{
  "decisions": [
    {
      "choice": "use Zod refinement instead of preprocess",
      "reason": "preserves error path",
      "alternativesConsidered": ["preprocess", "transform"]
    }
  ],
  "leftUnhandled": [
    { "case": "schema v2", "reason": "out of scope" }
  ],
  "keyFiles": ["packages/core/src/types.ts"]
}
</decisions>

More prose after the block.
`;

describe("parseDecisionsBlock (BEC-227 Phase 4 / Track D)", () => {
  it("extracts a valid decisions block", () => {
    const got = parseDecisionsBlock(validAgentOutput);
    expect(got).not.toBeNull();
    expect(got!.decisions).toHaveLength(1);
    expect(got!.decisions[0]!.choice).toBe("use Zod refinement instead of preprocess");
    expect(got!.leftUnhandled).toHaveLength(1);
    expect(got!.keyFiles).toEqual(["packages/core/src/types.ts"]);
  });

  it("returns null when no <decisions> block is present", () => {
    expect(parseDecisionsBlock("just some prose, no block")).toBeNull();
  });

  it("returns null when the block contains malformed JSON", () => {
    const bad = "<decisions>{ not valid json }</decisions>";
    expect(parseDecisionsBlock(bad)).toBeNull();
  });

  it("returns null when the JSON doesn't match the schema", () => {
    const wrong = `<decisions>{"decisions": [{"missing_choice": true}]}</decisions>`;
    expect(parseDecisionsBlock(wrong)).toBeNull();
  });

  it("extracts the LAST block if the agent emits multiple", () => {
    const dual = `
<decisions>{"decisions": [{"choice": "first", "reason": "r"}]}</decisions>
<decisions>{"decisions": [{"choice": "second", "reason": "r"}]}</decisions>
`;
    const got = parseDecisionsBlock(dual);
    expect(got!.decisions[0]!.choice).toBe("second");
  });

  it("handles arbitrary whitespace inside the block", () => {
    const padded = `<decisions>\n\n  {"decisions": []}  \n\n</decisions>`;
    const got = parseDecisionsBlock(padded);
    expect(got).not.toBeNull();
    expect(got!.decisions).toEqual([]);
  });
});
