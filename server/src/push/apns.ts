import type Database from "better-sqlite3";
import { ApnsClient, Errors, Notification, type Host } from "apns2";

export interface ApnsConfig {
  team: string;
  keyId: string;
  signingKey: string;
  topic: string;
  host?: Host | string;
}

export interface RunFinishedPushInfo {
  conversationId: string;
  title: string | null;
  body: string;
}

/** Token-based APNs sender (§5). Outbound-only from the Pi, so delivery works even with the phone's VPN off. */
export class PushService {
  private client: ApnsClient;

  constructor(private sqlite: Database.Database, config: ApnsConfig) {
    this.client = new ApnsClient({
      team: config.team,
      keyId: config.keyId,
      signingKey: config.signingKey,
      defaultTopic: config.topic,
      host: config.host,
    });
  }

  async notifyRunFinished(info: RunFinishedPushInfo): Promise<void> {
    const devices = this.sqlite.prepare(`SELECT id, apns_token FROM devices`).all() as Array<{ id: string; apns_token: string }>;
    if (devices.length === 0) return;

    await Promise.all(
      devices.map(async (d) => {
        const notification = new Notification(d.apns_token, {
          alert: { title: info.title ?? "Pocket Agent", body: info.body.slice(0, 150) },
          data: { conversationId: info.conversationId },
          sound: "default",
        });
        try {
          await this.client.send(notification);
        } catch (err) {
          const reason = err instanceof Error && "reason" in err ? (err as { reason?: string }).reason : undefined;
          if (reason === Errors.unregistered || reason === Errors.badDeviceToken) {
            this.sqlite.prepare(`DELETE FROM devices WHERE id = ?`).run(d.id);
            return;
          }
          // Anything else (BadTopic, Expired/InvalidProviderToken, TooManyRequests,
          // ServiceUnavailable, ...) previously vanished silently — this is the only
          // feature that can only be validated in production, so log what's wrong.
          console.error(`apns send failed for device ${d.id}: ${reason ?? String(err)}`);
        }
      }),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
