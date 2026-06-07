-- Down for 0001_initial. Drop in reverse dependency order.

DROP INDEX IF EXISTS pushes_status;
DROP INDEX IF EXISTS pushes_user;
DROP TABLE IF EXISTS pushes;

DROP INDEX IF EXISTS candidates_orphan_source;
DROP TABLE IF EXISTS candidates;

DROP TABLE IF EXISTS gsc_data;

DROP INDEX IF EXISTS edges_dst;
DROP TABLE IF EXISTS edges;

DROP INDEX IF EXISTS pages_site_slug;
DROP INDEX IF EXISTS pages_site;
DROP TABLE IF EXISTS pages;

DROP INDEX IF EXISTS sites_user_url;
DROP INDEX IF EXISTS sites_user;
DROP TABLE IF EXISTS sites;

DROP TABLE IF EXISTS magic_tokens;

DROP INDEX IF EXISTS sessions_user;
DROP TABLE IF EXISTS sessions;

DROP TABLE IF EXISTS users;
