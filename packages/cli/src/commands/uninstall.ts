import { Command } from "commander";
import { rmSync, existsSync } from "node:fs";
import { resolveUserLevelHome } from "../lib/user-level-config.js";

/**
 * `ura uninstall` — remove the user-level urateam install.
 *
 * Deletes `~/.urateam/` (or `$URATEAM_HOME`) recursively. Destructive, so
 * gated on `--yes`. Without `--yes`, prints what would be deleted along
 * with the explicit command to confirm.
 *
 * Idempotent: no-op when the directory doesn't exist (operators who
 * already removed it by hand shouldn't see an error).
 *
 * Does NOT uninstall the npm binary — that's an `npm uninstall -g
 * @urateam/cli` step the operator runs themselves. We print the hint
 * so they don't have to remember.
 */
export const uninstallCommand = new Command("uninstall")
  .description(
    "Remove the user-level urateam install at ~/.urateam (or $URATEAM_HOME)",
  )
  .option("--yes", "Skip the confirmation prompt — destructive")
  .action((opts: { yes?: boolean }) => {
    const home = resolveUserLevelHome();
    if (!existsSync(home)) {
      console.log(
        `ura uninstall: ${home} does not exist — nothing to remove.`,
      );
      return;
    }
    if (!opts.yes) {
      console.log(
        `ura uninstall: this will DELETE ${home} (config, data, cloned repos).\n` +
          `Re-run with --yes to confirm:\n` +
          `  ura uninstall --yes\n` +
          `Then run 'npm uninstall -g @urateam/cli' to remove the CLI binary.`,
      );
      return;
    }
    rmSync(home, { recursive: true, force: true });
    console.log(`ura uninstall: removed ${home}.`);
    console.log("Also run: npm uninstall -g @urateam/cli");
  });
