export interface AuthExpiredMessages {
  hint: string;
  slackText: string;
}

export function getAuthExpiredMessages(
  authMethod: "oauth-token" | "mounted-session",
): AuthExpiredMessages {
  if (authMethod === "oauth-token") {
    return {
      hint: "Run `claude setup-token` to regenerate the token, update CLAUDE_CODE_OAUTH_TOKEN in your env, and restart the container. See deploy/CLAUDE_AUTH.md.",
      slackText:
        "⚠ *Claude OAuth token expired or revoked* — new pipeline runs will fail immediately.\n" +
        "Fix: run `claude setup-token` to regenerate the token, set `CLAUDE_CODE_OAUTH_TOKEN` in your `.env`, and restart the container.\n" +
        "See `deploy/CLAUDE_AUTH.md` for details.",
    };
  }
  return {
    hint: "Run `claude login` in the container, or switch to CLAUDE_CODE_OAUTH_TOKEN (see deploy/CLAUDE_AUTH.md)",
    slackText:
      "⚠ *Claude session auth expired* — new pipeline runs will fail immediately.\n" +
      "Fix: `docker compose exec <service> claude login`\n" +
      "Or switch to `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token` once). " +
      "See `deploy/CLAUDE_AUTH.md` for details.",
  };
}
