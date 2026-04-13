#!/usr/bin/env node
// Auto-load .env file from the current working directory before any command
// imports read process.env. Uses Node 22's built-in loadEnvFile (no deps).
// Silently skips if .env doesn't exist. Existing env vars always win.
try {
  process.loadEnvFile();
} catch {
  // .env missing or unreadable — continue without it
}

import { Command } from "commander";
import { runCommand } from "./commands/run.js";
import { devCommand } from "./commands/dev.js";
import { webhookCommand } from "./commands/webhook.js";
import { configCommand } from "./commands/config.js";
import { startCommand } from "./commands/start.js";
import { migrateCommand } from "./commands/migrate.js";

const program = new Command();

program
  .name("ura")
  .description("urateam CLI")
  .version("0.1.0");

program.addCommand(runCommand);
program.addCommand(devCommand);
program.addCommand(webhookCommand);
program.addCommand(configCommand);
program.addCommand(startCommand);
program.addCommand(migrateCommand);

program.parse();
