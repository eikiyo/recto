-- Waitlist for new-cohort signups. Pre-user: no users-row yet, no session.
-- Email is the natural unique key; stored lowercased so dedupe is trivial.
-- ip + ua are kept for spam triage only — never returned to clients.

CREATE TABLE waitlist (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  source      TEXT,
  ip          TEXT,
  ua          TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_waitlist_created ON waitlist(created_at);
