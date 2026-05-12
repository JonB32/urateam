#!/usr/bin/env node
// Re-export all public types and functions from scaffold.ts so that
// existing code importing from @create-urateam (or ../index.js in tests)
// continues to work without changes.
import {
  scaffold,
  normalizeBasePath,
  decodeLicense,
  buildEnv,
  resolveSecrets,
} from "./scaffold.js";
import { runWizard } from "./wizard.js";

export { scaffold, normalizeBasePath, decodeLicense, buildEnv, resolveSecrets };
export type {
  PmAgentOptions,
  GithubFeedbackOptions,
  ScaffoldOptions,
  LicenseInfo,
  ScaffoldResult,
} from "./scaffold.js";

async function main() {
  const arg = process.argv[2] ?? ".";
  if (arg === "--help" || arg === "-h") {
    console.log("Usage: create-urateam [project-name]");
    console.log("  create-urateam              # adds .urateam/ to current directory (default)");
    console.log("  create-urateam .            # same as above");
    console.log("  create-urateam my-project   # creates new directory and adds .urateam/ inside");
    process.exit(0);
  }

  const wizardResult = await runWizard(arg);
  if (wizardResult === null) {
    // Early-exit: existing .env detected; template files were refreshed internally.
    return;
  }

  const { scaffoldOptions, deployMode, domain, dashboardBasePath, anthropicAuth } =
    wizardResult;

  const result = scaffold(scaffoldOptions);

  // --- Next steps printout ---
  console.log(`\n  ✓ urateam sidecar installed in ${result.urateamDir}\n`);

  if (Object.keys(result.generatedSecrets).length > 0) {
    console.log("  Auto-generated secrets (saved to .env — record these now):");
    if (result.generatedSecrets.dashboardPassword) {
      console.log(
        `    Dashboard login: admin / ${result.generatedSecrets.dashboardPassword}`,
      );
    }
    if (result.generatedSecrets.postgresPassword) {
      console.log(`    POSTGRES_PASSWORD: ${result.generatedSecrets.postgresPassword}`);
    }
    if (result.generatedSecrets.githubWebhookSecret) {
      // Show the full secret — the operator needs it to paste into GitHub's
      // webhook UI for HMAC signatures to match.
      console.log(`    GITHUB_WEBHOOK_SECRET: ${result.generatedSecrets.githubWebhookSecret}`);
      console.log(`    ↑ paste this into the webhook's "Secret" field at github.com/<repo>/settings/hooks/new`);
    }
    console.log("");
  }

  if (result.license) {
    console.log(`  License: ${result.license.tier}`);
    if (result.license.features.length > 0) {
      console.log(`  Features: ${result.license.features.join(", ")}`);
    }
    console.log("");
  }

  if (result.todos.length > 0) {
    console.log("  Still to do (edit .urateam/.env or run the noted commands):");
    for (const todo of result.todos) {
      console.log(`    • ${todo}`);
    }
    console.log("");
  }

  // Detail any .env updates the operator must do before bringing the stack up.
  if (result.todos.length > 0) {
    console.log("  Before starting the stack, edit .urateam/.env to fill in:");
    for (const todo of result.todos) {
      console.log(`    • ${todo}`);
    }
    console.log("");
  }

  console.log("  Next:");
  if (arg !== ".") console.log(`    cd ${arg}`);
  console.log("    cd .urateam");
  if (result.todos.length > 0) {
    console.log("    # ↑ open .env in your editor and fill in the TODOs above first");
  }
  if (deployMode === "production") {
    console.log("    docker compose up -d --build");
    if (anthropicAuth === "cli") {
      console.log("    docker compose exec agent claude login    # device-flow auth");
    }
    console.log("    docker compose exec agent gh auth login   # device-flow auth");
    console.log("");
    console.log("  After the stack is up:");
    console.log(`    1. Add a webhook in Linear → Settings → API → Webhooks`);
    console.log(`         URL: https://${domain || "<your-domain>"}/webhooks/linear`);
    if (dashboardBasePath) {
      console.log(`         ⚠ NOT https://${domain || "<your-domain>"}${dashboardBasePath}/webhooks/linear`);
      console.log(`         (webhook routes are server-level, not under DASHBOARD_BASE_PATH)`);
    }
    console.log(`         Subscribe to: Issue state changes`);
    console.log(`         Copy the secret → paste into .env as LINEAR_WEBHOOK_SECRET → restart the stack`);
    const dashboardUrl = dashboardBasePath
      ? `https://${domain || "<your-domain>"}${dashboardBasePath}`
      : `https://${domain || "<your-domain>"}`;
    console.log(`    2. Open the dashboard at ${dashboardUrl} (admin / your-generated-password)`);
    console.log(`    3. Move a Linear issue to Todo with a pipeline label to trigger your first run`);
  } else {
    console.log("    pnpm install");
    console.log("    ura dev");
  }
  console.log("\n  Slack / PM agent setup walkthrough:");
  console.log("    https://github.com/JonB32/urateam/blob/main/docs/slack-setup.md");
  console.log("\n  See CLAUDE.md in the project root for agent context.\n");
}

const isEntrypoint = process.argv[1]?.endsWith("create-urateam") ||
                     process.argv[1]?.endsWith("index.js");
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
