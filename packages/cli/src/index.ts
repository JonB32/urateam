#!/usr/bin/env node
// Auto-load .env file from the current working directory before any command
// imports read process.env. Uses Node 22's built-in loadEnvFile (no deps).
// Silently skips if .env is absent (ENOENT). Warns on other errors
// (e.g., malformed content) so the user knows why their vars aren't loading.
// Existing env vars always win — loadEnvFile doesn't override them.
try {
  process.loadEnvFile();
} catch (err: unknown) {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code !== "ENOENT") {
    console.warn(
      `warning: failed to load .env from ${process.cwd()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

import { Command } from "commander";
import { runCommand } from "./commands/run.js";
import { devCommand } from "./commands/dev.js";
import { webhookCommand } from "./commands/webhook.js";
import { configCommand } from "./commands/config.js";
import { startCommand } from "./commands/start.js";
import { migrateCommand } from "./commands/migrate.js";
import { getPackageVersion } from "./version.js";
import { licenseCommand } from "./commands/license.js";

const program = new Command();

program
  .name("ura")
  .description("urateam CLI")
  .version(getPackageVersion());

program.addCommand(runCommand);
program.addCommand(devCommand);
program.addCommand(webhookCommand);
program.addCommand(configCommand);
program.addCommand(startCommand);
program.addCommand(migrateCommand);
program.addCommand(licenseCommand, { hidden: true });

program.parse();
