#!/usr/bin/env node
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
