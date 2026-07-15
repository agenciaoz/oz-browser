-- OZ Browser admin — per-license proxy bundles.
-- Each license key can carry a set of proxies that the app imports + auto-assigns
-- on activation. Stored plain (delivered over HTTPS, re-stored in the app Keychain).
CREATE TABLE IF NOT EXISTS proxies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,
  name       TEXT,
  protocol   TEXT NOT NULL DEFAULT 'https',
  host       TEXT NOT NULL,
  port       INTEGER NOT NULL,
  username   TEXT,
  password   TEXT,
  country    TEXT,
  city       TEXT,
  tags       TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proxies_key ON proxies(key);
