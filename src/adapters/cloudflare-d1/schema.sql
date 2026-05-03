-- DDL for the ratelimit table — run once via `wrangler d1 execute` before
-- first deploy of the D1 adapter.
CREATE TABLE IF NOT EXISTS ratelimit (
  key       TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  data      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ratelimit_updated_at_idx
  ON ratelimit (updated_at);
