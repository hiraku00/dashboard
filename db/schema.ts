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

export const todoBoards = sqliteTable("todo_boards", {
  id: text("id").primaryKey(), name: text("name").notNull(), timezone: text("timezone").notNull().default("Asia/Bangkok"),
  createdAt: text("created_at").notNull(), archivedAt: text("archived_at"),
});

export const todoColumns = sqliteTable("todo_columns", {
  id: text("id").primaryKey(), boardId: text("board_id").notNull(), name: text("name").notNull(),
  kind: text("kind").notNull(), position: integer("position").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [index("todo_columns_board_position_idx").on(table.boardId, table.position)]);

export const todoRoutines = sqliteTable("todo_routines", {
  id: text("id").primaryKey(), boardId: text("board_id").notNull(), title: text("title").notNull(),
  description: text("description").notNull().default(""), priority: integer("priority"), scheduleType: text("schedule_type").notNull(),
  weekdays: text("weekdays").notNull().default(""), defaultColumnId: text("default_column_id").notNull(), active: integer("active").notNull().default(1),
  version: integer("version").notNull().default(1), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(), deletedAt: text("deleted_at"),
}, (table) => [index("todo_routines_board_active_idx").on(table.boardId, table.active)]);

export const todoTasks = sqliteTable("todo_tasks", {
  id: text("id").primaryKey(), boardId: text("board_id").notNull(), columnId: text("column_id").notNull(), routineId: text("routine_id"),
  occurrenceDate: text("occurrence_date"), title: text("title").notNull(), description: text("description").notNull().default(""),
  priority: integer("priority"), dueTime: text("due_time"), position: integer("position").notNull(), completedAt: text("completed_at"),
  skippedAt: text("skipped_at"), version: integer("version").notNull().default(1), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(), deletedAt: text("deleted_at"),
}, (table) => [index("todo_tasks_board_date_column_position_idx").on(table.boardId, table.occurrenceDate, table.columnId, table.position), uniqueIndex("todo_tasks_routine_date_idx").on(table.routineId, table.occurrenceDate)]);

export const todoTaskEvents = sqliteTable("todo_task_events", {
  id: text("id").primaryKey(), taskId: text("task_id").notNull(), eventType: text("event_type").notNull(),
  fromColumnId: text("from_column_id"), toColumnId: text("to_column_id"), occurredAt: text("occurred_at").notNull(),
}, (table) => [index("todo_task_events_task_idx").on(table.taskId, table.occurredAt)]);
