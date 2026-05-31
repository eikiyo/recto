-- Raw outgoing anchor links per page. Materialized into `edges` once both src
-- and dst pages exist. Lets the crawler ingest in any order and still produce
-- a complete link graph after the run completes.

CREATE TABLE outlinks (
  src_page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  dst_slug      TEXT NOT NULL,
  anchor_text   TEXT,
  PRIMARY KEY (src_page_id, dst_slug)
);
CREATE INDEX outlinks_slug ON outlinks(dst_slug);
