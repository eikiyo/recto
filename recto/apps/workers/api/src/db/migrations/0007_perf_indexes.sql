-- 0007_perf_indexes — additive hot-path indexes (no data change, no drops).
-- Targets measured query shapes (2026-06-07 latency hardening):
--
--  1. pushes(candidate_id) — the cascade DELETE in DELETE /api/sites/:id
--     ("DELETE FROM pushes WHERE candidate_id IN (...)") and any
--     candidate->push lookup previously full-scanned pushes (no index on
--     candidate_id; only user_id + status were indexed).
--
--  2. pushes(user_id, pushed_at DESC) — the audit page (GET /api/pushes) does
--     "WHERE user_id = ? [AND status = ?] ORDER BY pushed_at DESC LIMIT ?".
--     With only pushes_user(user_id), SQLite filtered by user then did a
--     filesort + scanned to satisfy ORDER BY pushed_at. This composite lets the
--     index serve the filter AND the order, so LIMIT short-circuits after N rows
--     — the audit list renders without sorting the user's whole push history.
--     (The status-filtered variant still uses this index for user+order and
--     applies status as a cheap residual.)
--
--  3. candidates(source_page_id) — the cascade DELETE matches
--     "source_page_id IN (...)"; the existing UNIQUE(orphan_page_id,
--     source_page_id) only covers the orphan_page_id leftmost prefix, so the
--     source_page_id branch full-scanned candidates.
--
-- All IF NOT EXISTS so re-running is a no-op.

CREATE INDEX IF NOT EXISTS pushes_candidate     ON pushes(candidate_id);
CREATE INDEX IF NOT EXISTS pushes_user_pushed   ON pushes(user_id, pushed_at DESC);
CREATE INDEX IF NOT EXISTS candidates_source    ON candidates(source_page_id);
