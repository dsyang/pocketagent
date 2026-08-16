import type Database from "better-sqlite3";
import type { Db } from "./db/client.js";
import type { EventLog } from "./events/log.js";
import type { Runner } from "./jobs/runner.js";
import type { PushService } from "./push/apns.js";

export interface AppContext {
  sqlite: Database.Database;
  db: Db;
  eventLog: EventLog;
  runner: Runner;
  push: PushService | null;
  openRouterApiKey: string;
  defaultModel: string;
}
