import { describe, it, expect } from "vitest";
import { extractHandoff } from "../executor/extract-handoff.js";

const outputWithDecisions = `
implemented the thing.

<handoff>
{"stage": "implement", "summary": "done", "filesChanged": ["a.ts"], "blockingFindings": []}
</handoff>

<decisions>
{ "decisions": [{ "choice": "x", "reason": "y" }], "leftUnhandled": [], "keyFiles": ["a.ts"] }
</decisions>
`;

describe("extractHandoff returns decision artifact alongside handoff (BEC-227 Phase 4 / Track D)", () => {
  it("attaches parsed decisions to the result", async () => {
    const got = await extractHandoff(
      outputWithDecisions,
      "run-1",
      "BEC-X",
      "implement",
      "/tmp/nowhere",
    );
    expect(got.decisions).not.toBeNull();
    expect(got.decisions!.decisions[0]!.choice).toBe("x");
    expect(got.decisions!.keyFiles).toEqual(["a.ts"]);
  });

  it("sets decisions to null when the block is absent", async () => {
    const got = await extractHandoff(
      "no decisions here. <handoff>{\"stage\":\"implement\",\"summary\":\"x\",\"filesChanged\":[],\"blockingFindings\":[]}</handoff>",
      "run-1",
      "BEC-X",
      "implement",
      "/tmp/nowhere",
    );
    expect(got.decisions).toBeNull();
  });
});
