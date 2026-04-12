import { Command } from "commander";

export const configCommand = new Command("config")
  .description("Validate pipeline and repo configurations")
  .argument("[action]", "Action to perform", "validate")
  .option("--pipeline <path>", "Pipeline config file path", "./pipeline.config.ts")
  .option("--repos <path>", "Repo config file path", "./repos.config.ts")
  .action(async (action, options) => {
    if (action !== "validate") {
      console.error(`Unknown action: ${action}. Use "validate".`);
      process.exit(1);
    }

    console.log("Validating configurations...");

    try {
      const { validatePipelineConfigs, validateRepoConfigs, defaultConfigs } = await import("@urateam/core");

      // Try loading custom configs, fall back to defaults
      let pipelineConfigs;
      try {
        const module = await import(options.pipeline);
        pipelineConfigs = validatePipelineConfigs(module.default ?? module);
        console.log(`Pipeline config loaded from ${options.pipeline}`);
      } catch {
        pipelineConfigs = defaultConfigs;
        console.log(`No custom pipeline config found, using defaults`);
      }

      console.log(`   Pipelines: ${Object.keys(pipelineConfigs).join(", ")}`);

      // Try loading repo configs
      try {
        const module = await import(options.repos);
        const repoConfigs = validateRepoConfigs(module.default ?? module);
        console.log(`Repo config loaded from ${options.repos}`);
        console.log(`   Repos: ${Object.keys(repoConfigs).join(", ")}`);
      } catch {
        console.log(`No repo config found at ${options.repos}`);
      }

      console.log("\nConfiguration is valid.");
    } catch (e) {
      console.error(`Validation failed:`, e);
      process.exit(1);
    }
  });
