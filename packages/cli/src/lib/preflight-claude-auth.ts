/**
 * OSS-tier Claude session auth pre-flight, shared by `ura dev` and `ura start`.
 *
 * The OSS tier of urateam runs against the local `claude` CLI session, which
 * expires silently in the background (typically weekly). Without this gate
 * the first inbound Linear webhook after expiry would burn through tokens,
 * fail mid-pipeline, and leave the operator to manually unstick the Linear
 * issue from "in progress" before re-authing. The Anthropic API tier
 * (long-lived API key) has no session-lifetime semantics — `isClaudeAuthValid`
 * resolves true there and the gate is a no-op.
 *
 * On failure: prints an operator-actionable banner and exits 1.
 *
 * See urateam#40.
 */
export async function preflightClaudeAuth(opts: {
  /**
   * The bin name to surface in the banner (`ura dev` vs `ura start`).
   * Surfacing the actual entry point the operator typed reduces confusion.
   */
  command: "ura dev" | "ura start";
  /**
   * When true, the banner mentions the `docker compose exec ... claude login`
   * variant. Used by `ura start` (production / containerized).
   */
  containerized?: boolean;
}): Promise<void> {
  const { isClaudeAuthValid } = await import("@urateam/core");
  if (await isClaudeAuthValid()) return;

  const reauth = opts.containerized
    ? "Run `claude login` (or `docker compose exec <service> claude login` if running\n" +
      "  containerized)"
    : "Run `claude login`";
  console.error(
    "⚠ Claude session auth check failed at startup.\n" +
      "  The local `claude` session is missing or expired.\n" +
      `  ${reauth} and restart \`${opts.command}\`. Without this fix,\n` +
      "  webhooks will fail mid-pipeline and the agent will mark Linear issues\n" +
      "  as failed — requiring manual recovery.\n",
  );
  process.exit(1);
}
