import { userInfo } from "node:os";

/**
 * Build stage-specific permission options.
 * implement/reproduce get acceptEdits; others get default.
 * AGENT_BYPASS_PERMISSIONS=true overrides all stages.
 *
 * When running as root (UID 0), Claude Code rejects permission flags
 * for security reasons. In that case, omit permission options entirely
 * and let Claude Code use its own defaults.
 */
export function buildStagePermissionOptions(stage: string): Record<string, unknown> {
  // Claude Code blocks --dangerously-skip-permissions and permission modes
  // when running as root/sudo. Skip all permission options in that case.
  try {
    if (userInfo().uid === 0) return {};
  } catch {
    // userInfo() can throw on some platforms — proceed with normal logic
  }

  if (process.env.AGENT_BYPASS_PERMISSIONS === "true") {
    return {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };
  }
  if (stage === "implement" || stage === "reproduce") {
    return { permissionMode: "acceptEdits" };
  }
  return { permissionMode: "default" };
}
