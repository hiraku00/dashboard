import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    contentType: text("content_type").notNull(),
    creatorName: text("creator_name").notNull().default(""),
    seriesTitle: text("series_title").notNull().default(""),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    priority: integer("priority"),
    status: text("status").notNull().default("backlog"),
    addedOn: text("added_on"),
    watchedOn: text("watched_on"),
    comment: text("comment").notNull().default(""),
    sourceSystem: text("source_system").notNull().default("manual"),
    externalId: text("external_id"),
    rawSource: text("raw_source"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("items_status_idx").on(table.status),
    index("items_type_idx").on(table.contentType),
    index("items_added_on_idx").on(table.addedOn),
    index("items_creator_idx").on(table.creatorName),
    uniqueIndex("items_source_external_idx").on(table.sourceSystem, table.externalId),
  ],
);

export const itemLinks = sqliteTable(
  "item_links",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull(),
    label: text("label").notNull().default(""),
    url: text("url").notNull(),
    linkType: text("link_type").notNull().default("reference"),
    position: integer("position").notNull().default(0),
    canonicalUrl: text("canonical_url").notNull().default(""),
  },
  (table) => [index("item_links_item_idx").on(table.itemId), index("item_links_canonical_idx").on(table.canonicalUrl)],
);

export const importRuns = sqliteTable("import_runs", {
  id: text("id").primaryKey(),
  sourceName: text("source_name").notNull(),
  totalCount: integer("total_count").notNull().default(0),
  createdCount: integer("created_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
