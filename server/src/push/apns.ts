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
          if (err instanceof Error && "reason" in err) {
            const reason = (err as { reason?: string }).reason;
            if (reason === Errors.unregistered || reason === Errors.badDeviceToken) {
              this.sqlite.prepare(`DELETE FROM devices WHERE id = ?`).run(d.id);
            }
          }
        }
      }),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
