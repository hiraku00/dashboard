import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import initialWatchList from "../data/initial-watch-list.example.json";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Check the D1 binding in wrangler.jsonc before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}

let schemaReady = false;

export async function ensureSchema({ seed = true }: { seed?: boolean } = {}) {
  if (schemaReady) return;

  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, content_type TEXT NOT NULL, creator_name TEXT NOT NULL DEFAULT '',
      series_title TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      priority INTEGER, status TEXT NOT NULL DEFAULT 'backlog', added_on TEXT, watched_on TEXT,
      comment TEXT NOT NULL DEFAULT '', source_system TEXT NOT NULL DEFAULT 'manual', external_id TEXT,
      raw_source TEXT, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT,
      CHECK(content_type IN ('text','audio','movie','other')),
      CHECK(status IN ('backlog','in_progress','completed','dropped')),
      CHECK(priority IS NULL OR priority BETWEEN 1 AND 5)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS item_links (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', url TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'reference', position INTEGER NOT NULL DEFAULT 0,
      canonical_url TEXT NOT NULL DEFAULT '', FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS import_runs (
      id TEXT PRIMARY KEY, source_name TEXT NOT NULL, total_count INTEGER NOT NULL DEFAULT 0,
      created_count INTEGER NOT NULL DEFAULT 0, updated_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS items_status_idx ON items(status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS items_type_idx ON items(content_type)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS items_added_on_idx ON items(added_on)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS item_links_item_idx ON item_links(item_id)"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS items_source_external_idx ON items(source_system, external_id)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS text_tube_videos (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, channel_name TEXT NOT NULL DEFAULT '',
      thumbnail_url TEXT NOT NULL DEFAULT '', original_url TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '', detailed_script_object_key TEXT,
      detailed_script_sha256 TEXT, detailed_script_size INTEGER, published_at TEXT,
      view_count INTEGER NOT NULL DEFAULT 0, channel_thumbnail_url TEXT NOT NULL DEFAULT '',
      duration TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      deleted_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS text_tube_video_revisions (
      id TEXT PRIMARY KEY, video_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
      document_object_key TEXT NOT NULL, document_sha256 TEXT NOT NULL,
      document_size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      FOREIGN KEY(video_id) REFERENCES text_tube_videos(id) ON DELETE CASCADE
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS text_tube_videos_created_idx ON text_tube_videos(created_at DESC)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS text_tube_videos_channel_idx ON text_tube_videos(channel_name)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS asset_sources (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, provider TEXT NOT NULL,
      display_name TEXT NOT NULL, public_address TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, last_success_at TEXT, created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS asset_sync_runs (
      id TEXT PRIMARY KEY, client_run_id TEXT NOT NULL UNIQUE, client_version TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL,
      source_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS asset_snapshots (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_id TEXT NOT NULL,
      captured_at TEXT NOT NULL, as_of_date TEXT NOT NULL, total_usd REAL NOT NULL DEFAULT 0,
      total_jpy REAL NOT NULL DEFAULT 0, fx_usdjpy REAL, raw_object_key TEXT,
      raw_sha256 TEXT, raw_size INTEGER, raw_storage_status TEXT NOT NULL DEFAULT 'stored',
      FOREIGN KEY(run_id) REFERENCES asset_sync_runs(id), FOREIGN KEY(source_id) REFERENCES asset_sources(id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS asset_positions (
      id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, symbol TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0, price_usd REAL, value_usd REAL,
      value_jpy REAL, location_type TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT '',
      position_type TEXT NOT NULL DEFAULT 'asset', is_debt INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(snapshot_id) REFERENCES asset_snapshots(id) ON DELETE CASCADE
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS asset_snapshots_source_date_idx ON asset_snapshots(source_id, as_of_date DESC)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS asset_positions_snapshot_idx ON asset_positions(snapshot_id)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS asset_history_records (
      id TEXT PRIMARY KEY, record_type TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT '',
      as_of_date TEXT NOT NULL, captured_at TEXT NOT NULL, total_usd REAL NOT NULL DEFAULT 0,
      total_jpy REAL NOT NULL DEFAULT 0, fx_usdjpy REAL, payload_json TEXT NOT NULL,
      UNIQUE(record_type, source_id, as_of_date, captured_at)
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS asset_history_records_date_idx ON asset_history_records(record_type, as_of_date DESC)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS asset_lido_rewards (
      id TEXT PRIMARY KEY, reward_date TEXT NOT NULL, reward_type TEXT NOT NULL DEFAULT 'reward',
      change REAL, change_usd REAL, apr REAL, balance REAL, payload_json TEXT NOT NULL,
      UNIQUE(reward_date, reward_type, change, balance)
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS asset_lido_rewards_date_idx ON asset_lido_rewards(reward_date DESC)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS asset_fx_rates (
      rate_date TEXT PRIMARY KEY, rate REAL NOT NULL, payload_json TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS storage_objects (
      object_key TEXT PRIMARY KEY, category TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL, content_type TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT, deleted_at TEXT
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS storage_objects_category_idx ON storage_objects(category, created_at DESC)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS storage_usage_daily (
      usage_date TEXT PRIMARY KEY, object_count INTEGER NOT NULL DEFAULT 0,
      payload_bytes INTEGER NOT NULL DEFAULT 0, class_a_estimate INTEGER NOT NULL DEFAULT 0,
      class_b_estimate INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'ledger',
      updated_at TEXT NOT NULL
    )`),
  ]);
  const countResult = seed ? await env.DB.prepare("SELECT COUNT(*) AS count FROM items").all<{ count: number }>() : null;
  if (seed && Number(countResult?.results?.[0]?.count ?? 0) === 0) {
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (const seed of initialWatchList.items) {
      const id = crypto.randomUUID();
      statements.push(env.DB.prepare("INSERT INTO items (id,content_type,creator_name,series_title,title,description,priority,status,added_on,watched_on,comment,source_system,external_id,raw_source,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)")
        .bind(id, seed.contentType, seed.creatorName, seed.seriesTitle, seed.title, seed.description, seed.priority, seed.status, seed.addedOn, seed.watchedOn, seed.comment, seed.sourceSystem, seed.externalId, seed.rawSource, now, now));
      for (const [position, link] of seed.links.entries()) {
        const url = new URL(link.url); url.hash = "";
        statements.push(env.DB.prepare("INSERT INTO item_links (id,item_id,label,url,link_type,position,canonical_url) VALUES (?,?,?,?,?,?,?)")
          .bind(crypto.randomUUID(), id, link.label, link.url, link.linkType, position, url.toString()));
      }
    }
    for (let start = 0; start < statements.length; start += 50) await env.DB.batch(statements.slice(start, start + 50));
  }
  schemaReady = true;
}
