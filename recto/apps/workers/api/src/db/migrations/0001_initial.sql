-- recto initial schema (D1 / SQLite). Mirrors TRD §4. Paired down at 0001_initial.down.sql.

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  created_at          INTEGER NOT NULL,
  last_login_at       INTEGER,
  anchor_credits      INTEGER NOT NULL DEFAULT 0,
  byok_openai_key     BLOB,
  byok_anthropic_key  BLOB,
  digest_opt_in       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL,
  ip_hash     TEXT,
  ua_hash     TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE magic_tokens (
  hash        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE TABLE licenses (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  appsumo_code  TEXT NOT NULL UNIQUE,
  tier          INTEGER NOT NULL,
  redeemed_at   INTEGER NOT NULL,
  refunded_at   INTEGER,
  stacked_into  TEXT REFERENCES licenses(id)
);

CREATE TABLE sites (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  url               TEXT NOT NULL,
  cms               TEXT NOT NULL,
  wp_username       TEXT,
  wp_app_password   BLOB,
  webflow_api_key   BLOB,
  gsc_refresh_token BLOB,
  gsc_property      TEXT,
  last_crawl_at     INTEGER,
  crawl_pages       INTEGER,
  vector_namespace  TEXT NOT NULL
);
CREATE INDEX sites_user ON sites(user_id);
CREATE UNIQUE INDEX sites_user_url ON sites(user_id, url);

CREATE TABLE pages (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  slug            TEXT NOT NULL,
  title           TEXT,
  h1              TEXT,
  excerpt         TEXT,
  content_hash    TEXT NOT NULL,
  depth           INTEGER,
  last_modified   INTEGER,
  crawled_at      INTEGER NOT NULL
);
CREATE INDEX pages_site ON pages(site_id);
CREATE UNIQUE INDEX pages_site_slug ON pages(site_id, slug);

CREATE TABLE edges (
  src_page_id   TEXT NOT NULL REFERENCES pages(id),
  dst_page_id   TEXT NOT NULL REFERENCES pages(id),
  anchor_text   TEXT,
  PRIMARY KEY (src_page_id, dst_page_id)
);
CREATE INDEX edges_dst ON edges(dst_page_id);

CREATE TABLE gsc_data (
  page_id       TEXT NOT NULL REFERENCES pages(id),
  day           TEXT NOT NULL,
  impressions   INTEGER NOT NULL,
  clicks        INTEGER NOT NULL,
  position      REAL,
  PRIMARY KEY (page_id, day)
);

CREATE TABLE candidates (
  id                  TEXT PRIMARY KEY,
  orphan_page_id      TEXT NOT NULL REFERENCES pages(id),
  source_page_id      TEXT NOT NULL REFERENCES pages(id),
  similarity          REAL NOT NULL,
  source_authority    INTEGER NOT NULL,
  anchor_text         TEXT NOT NULL,
  paragraph_excerpt   TEXT NOT NULL,
  generated_at        INTEGER NOT NULL,
  llm_provider        TEXT NOT NULL,
  cost_neurons        INTEGER
);
CREATE UNIQUE INDEX candidates_orphan_source ON candidates(orphan_page_id, source_page_id);

CREATE TABLE pushes (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  candidate_id    TEXT NOT NULL REFERENCES candidates(id),
  pushed_at       INTEGER NOT NULL,
  status          TEXT NOT NULL,
  failure_code    TEXT,
  failure_msg     TEXT,
  verified_at     INTEGER,
  verified_via    TEXT,
  undone_at       INTEGER
);
CREATE INDEX pushes_user ON pushes(user_id);
CREATE INDEX pushes_status ON pushes(status);
