/**
 * Tests for the claude.auth_expired audit event (BEC-207).
 *
 * The preflightClaudeAuth() tests live in packages/cli/src/__tests__/preflight-claude-auth.test.ts.
 * This file tests the new audit event builder and AuditEventTypeSchema addition.
 */
import { describe, it, expect } from "vitest";
import { claudeAuthExpiredEvent } from "../audit/events.js";
import { AuditEventTypeSchema } from "../types.js";

describe("claudeAuthExpiredEvent (BEC-207)", () => {
  it("returns a valid AuditEvent with eventType claude.auth_expired", () => {
    const now = new Date();
    const event = claudeAuthExpiredEvent({ detectedAt: now });
    expect(event.eventType).toBe("claude.auth_expired");
    expect(event.actor).toBe("system");
    expect(event.actorType).toBe("system");
    expect(event.id).toMatch(/^evt_/);
    expect(event.payload).toMatchObject({
      detectedAt: now.toISOString(),
    });
    expect(event.payload.hint).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("AuditEventTypeSchema includes claude.auth_expired", () => {
    const result = AuditEventTypeSchema.safeParse("claude.auth_expired");
    expect(result.success).toBe(true);
  });

  it("produces a parseable ISO date string for detectedAt", () => {
    const now = new Date();
    const event = claudeAuthExpiredEvent({ detectedAt: now });
    const parsed = new Date(event.payload.detectedAt as string);
    expect(isNaN(parsed.getTime())).toBe(false);
    // Should be within 1 second of the input date
    expect(Math.abs(parsed.getTime() - now.getTime())).toBeLessThan(1000);
  });
});
