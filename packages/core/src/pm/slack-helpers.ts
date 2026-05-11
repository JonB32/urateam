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

/**
 * React to a Slack message (or any thing that has a channel + ts) with the
 * given emoji name (no surrounding colons). Fire-and-forget — failures are
 * logged at info because they're best-effort UX and we never want a missed
 * reaction to surface as a user-visible error.
 *
 * Slash commands have no `ts` to react to, so for those the caller uses
 * `chat.postEphemeral` instead. See `postSlackEphemeral` below.
 */
export async function reactToSlackMessage(
  botToken: string,
  channel: string,
  ts: string,
  emoji: string,
): Promise<void> {
  try {
    const resp = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, timestamp: ts, name: emoji }),
    });
    const data = (await resp.json()) as any;
    if (!data?.ok) {
      // `already_reacted` is benign — operator re-mentioned the bot in the
      // same thread. Other errors are worth logging for ops visibility.
      const benign = data?.error === "already_reacted";
      const level = benign ? "info" : "warn";
      log[level]({ error: data?.error, channel, ts, emoji }, "Slack reactions.add returned ok:false");
    }
  } catch (err) {
    log.error({ err, channel, ts, emoji }, "Slack reactions.add failed");
  }
}
