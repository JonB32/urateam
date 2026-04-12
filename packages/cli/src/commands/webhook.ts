import { Command } from "commander";
import { readFileSync } from "fs";

export const webhookCommand = new Command("webhook")
  .description("Simulate a webhook payload against the local server")
  .requiredOption("--file <path>", "Path to JSON webhook payload file")
  .option("--port <port>", "Local server port", "3000")
  .option("--secret <secret>", "Webhook secret for signing", "dev-secret")
  .action(async (options) => {
    const { createHmac } = await import("crypto");

    const payload = readFileSync(options.file, "utf-8");
    const hmac = createHmac("sha256", options.secret);
    hmac.update(payload);
    const signature = hmac.digest("hex");

    const url = `http://localhost:${options.port}/webhooks/linear`;

    console.log(`Sending webhook to ${url}`);
    console.log(`Payload: ${options.file}`);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Linear-Signature": signature,
        },
        body: payload,
      });
      const result = await response.json();
      console.log(`Response (${response.status}):`, JSON.stringify(result, null, 2));
    } catch (e) {
      console.error(`Failed to send webhook:`, e);
      console.error(`Is the dev server running? Try: lag dev`);
    }
  });
