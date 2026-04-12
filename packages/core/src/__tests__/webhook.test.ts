import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { verifyLinearSignature } from "../webhook/signature.js";
import { parseStateChange } from "../webhook/parser.js";
import stateChangePayload from "./fixtures/webhook-state-change.json" with { type: "json" };
import commentPayload from "./fixtures/webhook-comment.json" with { type: "json" };

// Helper to generate a valid HMAC signature
function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// verifyLinearSignature
// ---------------------------------------------------------------------------
describe("verifyLinearSignature", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ type: "Issue", action: "update" });

  it("returns true for valid signature", () => {
    const sig = sign(body, secret);
    expect(verifyLinearSignature(body, sig, secret)).toBe(true);
  });

  it("returns false for invalid signature", () => {
    expect(verifyLinearSignature(body, "bad-signature", secret)).toBe(false);
  });

  it("returns false for wrong secret", () => {
    const sig = sign(body, "wrong-secret");
    expect(verifyLinearSignature(body, sig, secret)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseStateChange
// ---------------------------------------------------------------------------
describe("parseStateChange", () => {
  it("extracts issue data from state change webhook", () => {
    const result = parseStateChange(stateChangePayload);
    expect(result).not.toBeNull();
    expect(result!.issue.id).toBe("issue-uuid-123");
    expect(result!.issue.identifier).toBe("LIN-42");
    expect(result!.issue.title).toBe("Add user search");
    expect(result!.issue.description).toBe("Implement search functionality");
    expect(result!.issue.priority).toBe(2);
    expect(result!.issue.teamId).toBe("team-frontend");
    expect(result!.issue.labels).toEqual([{ name: "auto-implement" }]);
    expect(result!.newState).toBe("Todo");
    expect(result!.previousState).toBeNull();
  });

  it("returns null for comment webhooks", () => {
    expect(parseStateChange(commentPayload)).toBeNull();
  });

  it("returns null for non-update actions", () => {
    const payload = { ...stateChangePayload, action: "create" };
    expect(parseStateChange(payload)).toBeNull();
  });

  it("returns null when no stateId in updatedFrom", () => {
    const payload = { ...stateChangePayload, updatedFrom: {} };
    expect(parseStateChange(payload)).toBeNull();
  });
});
