/** The FROM/JOIN behind "one row per source: its newest snapshot".
 *
 *  Shared by app/lib/queries/manage-asset.ts's assetState() and
 *  app/lib/queries/portal.ts's portalSummary(), which both need this exact
 *  set of rows -- the home page's asset total must match Manage Asset's own
 *  total (see Issue/PR #132, where it didn't) -- but select different
 *  columns from it. Each used to carry its own copy of this JOIN, kept in
 *  step only by a code comment pointing at the other; this makes it one
 *  statement neither can drift from.
 *
 *  asset_snapshots has UNIQUE(source_id, as_of_date), so a source's newest
 *  date identifies exactly one row, and the grouping is answered from that
 *  index (covering) instead of ranking every snapshot ever taken with
 *  ROW_NUMBER(). Callers append their own SELECT column list before this and
 *  ORDER BY after it. */
export const LATEST_SNAPSHOT_JOIN = `FROM asset_snapshots s
  JOIN (SELECT source_id, MAX(as_of_date) AS as_of_date FROM asset_snapshots GROUP BY source_id) latest
    ON latest.source_id = s.source_id AND latest.as_of_date = s.as_of_date
  JOIN asset_sources a ON a.id = s.source_id`;
