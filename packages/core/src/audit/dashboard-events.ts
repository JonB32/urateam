import type { AuditEvent } from "../types.js";
import { base } from "./internal.js";

export function dashboardLoginEvent(args: {
  userId: string;
  email: string;
  workosUserId: string;
}): AuditEvent {
  return base({
    eventType: "dashboard.login",
    actor: `dashboard:${args.email}`,
    actorType: "dashboard-user",
    payload: {
      userId: args.userId,
      email: args.email,
      workosUserId: args.workosUserId,
    },
  });
}

export function dashboardLogoutEvent(args: {
  userId: string;
  email: string;
}): AuditEvent {
  return base({
    eventType: "dashboard.logout",
    actor: `dashboard:${args.email}`,
    actorType: "dashboard-user",
    payload: { userId: args.userId },
  });
}

export function dashboardLoginDeniedEvent(args: {
  email: string;
  reason: "domain-mismatch";
}): AuditEvent {
  return base({
    eventType: "dashboard.login_denied",
    actor: `dashboard:${args.email}`,
    actorType: "dashboard-user",
    payload: { reason: args.reason },
  });
}

function dashboardManualActionEvent(
  actor: string,
  actorType: "dashboard-user" | "system",
  payload: Record<string, unknown>,
  extra?: { runId?: string | null; issueId?: string | null },
): AuditEvent {
  return base({
    eventType: "dashboard.manual_action",
    actor,
    actorType,
    ...extra,
    payload,
  });
}

export function dashboardGrantRoleEvent(args: {
  targetUserId: string;
  targetEmail: string;
  oldRole: string;
  newRole: string;
  actorUserId: string;
  actorEmail: string;
}): AuditEvent {
  return dashboardManualActionEvent(`dashboard:${args.actorEmail}`, "dashboard-user", {
    action: "grant_role",
    targetUserId: args.targetUserId,
    targetEmail: args.targetEmail,
    oldRole: args.oldRole,
    newRole: args.newRole,
    actorUserId: args.actorUserId,
  });
}

export function dashboardRevokeRoleEvent(args: {
  targetUserId: string;
  targetEmail: string;
  oldRole: string;
  newRole: string;
  actorUserId: string;
  actorEmail: string;
}): AuditEvent {
  return dashboardManualActionEvent(`dashboard:${args.actorEmail}`, "dashboard-user", {
    action: "revoke_role",
    targetUserId: args.targetUserId,
    targetEmail: args.targetEmail,
    oldRole: args.oldRole,
    newRole: args.newRole,
    actorUserId: args.actorUserId,
  });
}

export function dashboardBootstrapAdminEvent(args: {
  targetUserId: string;
  targetEmail: string;
}): AuditEvent {
  return dashboardManualActionEvent("system", "system", {
    action: "bootstrap_admin",
    targetUserId: args.targetUserId,
    targetEmail: args.targetEmail,
    envVarMatched: true,
  });
}

export function dashboardRetryRunEvent(args: {
  runId: string;
  issueId: string;
  previousStatus: string;
  actorUserId: string;
  actorEmail: string;
}): AuditEvent {
  return dashboardManualActionEvent(
    `dashboard:${args.actorEmail}`,
    "dashboard-user",
    { action: "retry_run", previousStatus: args.previousStatus, actorUserId: args.actorUserId },
    { runId: args.runId, issueId: args.issueId },
  );
}

export function configLoadedEvent(args: {
  path: string;
  sha256: string;
  tier: string;
}): AuditEvent {
  return base({
    eventType: "config.loaded",
    actor: "system",
    actorType: "system",
    payload: { path: args.path, sha256: args.sha256, tier: args.tier },
  });
}

/**
 * `ura start --tunnel <mode>` brought a public tunnel up. Emitted once per
 * successful start (including restarts after a tunnel failure). Payload
 * carries the public URL so operators can see what their daemon is
 * reachable as.
 */
export function tunnelStartedEvent(args: {
  provider: "cloudflare-quick" | "cloudflare-token";
  publicUrl: string;
  restartCount: number;
}): AuditEvent {
  return base({
    eventType: "tunnel.started",
    actor: "system",
    actorType: "system",
    payload: {
      provider: args.provider,
      publicUrl: args.publicUrl,
      restartCount: args.restartCount,
    },
  });
}

/**
 * `ura start` reloaded the user-level config without a restart. Payload
 * lists what changed so operators can spot unexpected mutations.
 */
export function configReloadedEvent(args: {
  added: string[];
  removed: string[];
  modifiedSafe: string[];
  modifiedUnsafe: string[];
  sha256: string;
}): AuditEvent {
  return base({
    eventType: "config.reloaded",
    actor: "system",
    actorType: "system",
    payload: {
      added: args.added,
      removed: args.removed,
      modifiedSafe: args.modifiedSafe,
      modifiedUnsafe: args.modifiedUnsafe,
      sha256: args.sha256,
    },
  });
}

/**
 * Tunnel child process exited — either gracefully (operator stopped the
 * daemon) or because the restart cap was hit. Payload carries the exit
 * code / signal so operators can spot tunnel-flap loops in the audit log.
 */
export function tunnelStoppedEvent(args: {
  provider: "cloudflare-quick" | "cloudflare-token";
  restartCount: number;
  exitCode: number | null;
  signal: string | null;
}): AuditEvent {
  return base({
    eventType: "tunnel.stopped",
    actor: "system",
    actorType: "system",
    payload: {
      provider: args.provider,
      restartCount: args.restartCount,
      exitCode: args.exitCode,
      signal: args.signal,
    },
  });
}

/**
 * `ura self-auth-linear` completed — the operator authorized urateam in
 * Linear and the CLI persisted the access token to `~/.urateam/.env`.
 *
 * Payload deliberately omits the access token. workspaceId / workspaceName
 * are operational metadata; they're not sensitive in the same way the
 * token is.
 */
export function linearOauthCompletedEvent(args: {
  workspaceId: string;
  workspaceName?: string;
  actor: string;
}): AuditEvent {
  return base({
    eventType: "linear.oauth_completed",
    actor: args.actor,
    actorType: "cli",
    payload: {
      workspaceId: args.workspaceId,
      ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
    },
  });
}

/**
 * `ura service install` succeeded — a platform service unit (launchd plist
 * or systemd-user .service) was written and loaded. Emitted opportunistically
 * from the CLI when the daemon DB already exists; never blocks the install.
 */
export function serviceInstalledEvent(args: {
  platform: "darwin" | "linux";
  unitPath: string;
  actor: string;
}): AuditEvent {
  return base({
    eventType: "service.installed",
    actor: args.actor,
    actorType: "cli",
    payload: { platform: args.platform, unitPath: args.unitPath },
  });
}

/**
 * `ura service uninstall` succeeded — the unit file was removed and the
 * service stopped. Counterpart to `serviceInstalledEvent`.
 */
export function serviceUninstalledEvent(args: {
  platform: "darwin" | "linux";
  unitPath: string;
  actor: string;
}): AuditEvent {
  return base({
    eventType: "service.uninstalled",
    actor: args.actor,
    actorType: "cli",
    payload: { platform: args.platform, unitPath: args.unitPath },
  });
}
