import { Command } from "commander";
import { mkdirSync } from "node:fs";
import {
  resolveUserLevelHome,
  userLevelConfigPath,
  userLevelDataDir,
  userLevelReposDir,
  writeUserLevelConfig,
  readUserLevelConfig,
} from "../lib/user-level-config.js";

/**
 * Bootstrap a user-level urateam install at `~/.urateam/` (or `$URATEAM_HOME`).
 *
 * Creates the directory skeleton (`config.json`, `data/`, `repos/`) and
 * prints a one-line next-step hint. Idempotent: if `config.json` already
 * exists, the existing config is preserved — only missing subdirectories
 * are created.
 */
export const initCommand = new Command("init")
  .description(
    "Bootstrap a user-level urateam install at ~/.urateam (or $URATEAM_HOME)",
  )
  .action(() => {
    const home = resolveUserLevelHome();
    mkdirSync(home, { recursive: true });
    mkdirSync(userLevelDataDir(), { recursive: true });
    mkdirSync(userLevelReposDir(), { recursive: true });

    if (readUserLevelConfig() !== null) {
      console.log(
        `ura init: ${userLevelConfigPath()} already exists — leaving it untouched.`,
      );
      return;
    }
    writeUserLevelConfig({ version: 1, repos: [] });
    console.log(`ura init: created ${home}`);
    console.log("Next: ura repo add <url>");
  });
