import { createLogger } from "../logger.js";
const log = createLogger({ component: "PmAgent:slack" });

export async function postSlackMessage(botToken: string, payload: object): Promise<any> {
  try {
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await resp.json() as any;
    if (!data?.ok) {
      log.warn({ error: data?.error }, "Slack chat.postMessage returned ok:false");
    }
    return data;
  } catch (err) {
    log.error({ err }, "Slack postMessage failed");
    return null;
  }
}
