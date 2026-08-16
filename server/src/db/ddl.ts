// Hand-written DDL (not drizzle-kit generated) so we can use CHECK
// constraints, partial indexes, and WITHOUT ROWID clustering that drizzle-kit
// does not model. Applied idempotently (CREATE ... IF NOT EXISTS) at startup.
export const DDL = `
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT,
  model         TEXT NOT NULL,
  last_seq      INTEGER NOT NULL DEFAULT 0,
  last_message_at      INTEGER,
  last_message_preview TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conv_recency ON conversations(updated_at DESC, id);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content           TEXT NOT NULL,
  citations         TEXT,
  run_id            TEXT,
  client_message_id TEXT,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS msg_client_id ON messages(conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS msg_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS runs (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK (status IN
                     ('queued','running','completed','failed','cancelled')),
  model            TEXT NOT NULL,
  error            TEXT,
  usage            TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  heartbeat_at     INTEGER,
  started_at       INTEGER,
  finished_at      INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_active ON runs(status) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS run_events (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  run_id           TEXT NOT NULL,
  type             TEXT NOT NULL,
  payload          TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id);

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  apns_token    TEXT NOT NULL UNIQUE,
  platform      TEXT NOT NULL DEFAULT 'ios',
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
`;
