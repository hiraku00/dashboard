-- Collapse asset_snapshots to one row per (source_id, as_of_date).
--
-- The collector syncs 8-20 times a day and every sync appended a new snapshot
-- row per source, but both /api/manage-asset/state and /api/manage-asset/history
-- only ever use the newest row per source and date -- the rest were scanned on
-- every request and then thrown away. At 40 days of data that was 4,377 of
-- 5,057 snapshot rows (and 14,069 of 16,241 position rows) read for nothing.
--
-- Must run BEFORE the code that upserts snapshots ships. Creating the unique
-- index fails while duplicates remain; db/index.ts runs that same CREATE
-- UNIQUE INDEX outside its startup batch and tolerates the failure, so an
-- unmigrated database only breaks the sync route's upsert, not every route.
--
-- Already applied to production on 2026-09-04, by hand with `wrangler d1
-- execute --file` before this directory existed, so d1_migrations has no row
-- for it. Re-running is a no-op and safe: with the unique index in place no
-- duplicate can exist, so both DELETEs match nothing, and the CREATE is
-- IF NOT EXISTS. Applying it through `wrangler d1 migrations apply` simply
-- records it.
--
-- Result of that run: 5,057 -> 680 snapshot rows, 16,241 -> 2,172 position
-- rows, 0 duplicate groups remaining, displayed per-date totals unchanged
-- (verified against a pre-migration fingerprint).
--
-- A full pre-migration backup of both tables is in R2 under
-- manage-asset/backup/2026-09-04-pre-dedupe/.
--
-- The row kept per group is the one both readers already resolve to: newest by
-- the run's received_at, then captured_at, then rowid. Verified against the
-- production data -- the two routes' differing tiebreaks pick the same row in
-- all 680 groups, so no displayed value changes.

DELETE FROM asset_positions
WHERE snapshot_id IN (
  SELECT id FROM (
    SELECT s.id,
      ROW_NUMBER() OVER (
        PARTITION BY s.source_id, s.as_of_date
        ORDER BY COALESCE(r.received_at, '') DESC, s.captured_at DESC, s.rowid DESC
      ) AS rn
    FROM asset_snapshots s
    LEFT JOIN asset_sync_runs r ON r.id = s.run_id
  ) WHERE rn > 1
);

DELETE FROM asset_snapshots
WHERE id IN (
  SELECT id FROM (
    SELECT s.id,
      ROW_NUMBER() OVER (
        PARTITION BY s.source_id, s.as_of_date
        ORDER BY COALESCE(r.received_at, '') DESC, s.captured_at DESC, s.rowid DESC
      ) AS rn
    FROM asset_snapshots s
    LEFT JOIN asset_sync_runs r ON r.id = s.run_id
  ) WHERE rn > 1
);

-- What makes the duplicates impossible from here on. The sync route's upsert
-- targets this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS asset_snapshots_source_date_unique
  ON asset_snapshots(source_id, as_of_date);
