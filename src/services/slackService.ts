import {ISlackService} from "../interfaces/ISlackService";
import {CrcV2_CirclesBackingInitiated} from "@circles-sdk/data/dist/events/events";

export class SlackService implements ISlackService {
  constructor(private webhookUrl: string) {
  }

  async notifyBackingNotCompleted(e: CrcV2_CirclesBackingInitiated, reason: string): Promise<void> {
    const text =
      `⚠️ Backing stuck. Reason: ${reason}.
- backer: ${e.backer}
- instance: ${e.circlesBackingInstance}
- tx: ${e.transactionHash}
- block: ${e.blockNumber}
- initiatedAt: ${e.timestamp}`;

    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        text: text
      })
    });
    if (!res.ok) {
      throw new Error(`Slack notify failed: ${res.status} ${await res.text()}`);
    }
  }

  async notifySlackStartorCrash(message: string): Promise<void> {
    if (!this.webhookUrl) {
      console.warn(`Slack notification (no webhook configured): ${message}`);
      return;
    }

    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        text: message
      })
    });
    if (!res.ok) {
      throw new Error(`Slack notify failed: ${res.status} ${await res.text()}`);
    }
  }
}
