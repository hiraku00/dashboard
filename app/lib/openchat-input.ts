/** ちきりんオプチャの同期API(app/api/openchat/sync)が受け取るデータの検証と整形。
 *  D1にもcloudflare:workersにも触れない純粋なロジックなので、vitestの "node" project で
 *  そのままテストできる(app/lib/watch-list-item-input.ts と同じ理由)。設計は
 *  docs/chikirin-openchat.md。 */

export const MAX_NOTES_PER_REQUEST = 10;
export const MAX_COMMENTS_PER_NOTE = 60;
export const MAX_COMMENTS_PER_REQUEST = 60;
export const MAX_BODY_CHARS = 20000;

export const PRECISIONS = ["exact", "approx_min", "approx_hour"] as const;
export type Precision = (typeof PRECISIONS)[number];
export const RUN_STATUSES = ["success", "partial", "failed", "aborted"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type CommentInput = {
  id: string; ordinal: number; authorName: string; isTarget: boolean; bodyText: string;
  postedAt: string; postedAtPrecision: Precision; postedAtRaw: string; ocrMinConfidence: number | null;
  firstSeenAt: string; lastSeenAt: string; deletedAt: string | null;
};

export type NoteInput = {
  id: string; room: string; authorName: string; authorIsTarget: boolean; programTitle: string; linkTitle: string;
  linkUrl: string; bodyText: string; bodyComplete: boolean; postedAt: string; postedAtPrecision: Precision;
  postedAtRaw: string; commentCount: number; needsRecheck: boolean; firstSeenAt: string; lastCheckedAt: string;
  deletedAt: string | null; comments: CommentInput[];
};

function clean(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 本文は前後の空白と行末の空白だけ整える(段落の空行は残す)。 */
function cleanBody(value: unknown): string {
  return typeof value === "string" ? value.replace(/[ \t　]+$/gm, "").trim().slice(0, MAX_BODY_CHARS) : "";
}

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/;
const ISO_ANY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/;

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

/** 保存する時刻は必ずUTCの "YYYY-MM-DDTHH:MM:SSZ" にそろえる(並べ替えを文字列比較で行うため)。 */
export function normalizeUtc(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_UTC_RE.test(value)) return null;
  const withSeconds = value.length === 17 ? `${value.slice(0, 16)}:00Z` : value;
  return Number.isNaN(Date.parse(withSeconds)) ? null : withSeconds;
}

function normalizeStamp(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_ANY_RE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function isPrecision(value: unknown): value is Precision {
  return typeof value === "string" && (PRECISIONS as readonly string[]).includes(value);
}

function count(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 && n < 100000 ? n : 0;
}

export type Normalized<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

export function normalizeComment(raw: unknown, noteId: string): Normalized<CommentInput> {
  if (!raw || typeof raw !== "object") return { error: "コメントの形式が正しくありません。" };
  const c = raw as Record<string, unknown>;
  if (!validId(c.id)) return { error: `コメントのidが不正です(note ${noteId})。` };
  const postedAt = normalizeUtc(c.postedAt);
  if (!postedAt) return { error: `コメント${c.id}の postedAt が不正です。` };
  if (!isPrecision(c.postedAtPrecision)) return { error: `コメント${c.id}の postedAtPrecision が不正です。` };
  const body = cleanBody(c.bodyText);
  const authorName = clean(c.authorName, 200);
  if (!authorName) return { error: `コメント${c.id}の authorName が必要です。` };
  const seen = normalizeStamp(c.firstSeenAt) ?? postedAt;
  const confidence = typeof c.ocrMinConfidence === "number" && Number.isFinite(c.ocrMinConfidence)
    ? Math.min(1, Math.max(0, c.ocrMinConfidence)) : null;
  return {
    value: {
      id: c.id, ordinal: count(c.ordinal), authorName, isTarget: c.isTarget === true, bodyText: body, postedAt,
      postedAtPrecision: c.postedAtPrecision, postedAtRaw: clean(c.postedAtRaw, 60), ocrMinConfidence: confidence,
      firstSeenAt: seen, lastSeenAt: normalizeStamp(c.lastSeenAt) ?? seen, deletedAt: normalizeStamp(c.deletedAt),
    },
  };
}

export function normalizeNote(raw: unknown): Normalized<NoteInput> {
  if (!raw || typeof raw !== "object") return { error: "ノートの形式が正しくありません。" };
  const n = raw as Record<string, unknown>;
  if (!validId(n.id)) return { error: "ノートのidが不正です。" };
  const postedAt = normalizeUtc(n.postedAt);
  if (!postedAt) return { error: `ノート${n.id}の postedAt が不正です。` };
  if (!isPrecision(n.postedAtPrecision)) return { error: `ノート${n.id}の postedAtPrecision が不正です。` };
  const room = clean(n.room, 100);
  const authorName = clean(n.authorName, 200);
  if (!room || !authorName) return { error: `ノート${n.id}の room と authorName が必要です。` };
  const rawComments = Array.isArray(n.comments) ? n.comments : [];
  if (rawComments.length > MAX_COMMENTS_PER_NOTE) return { error: `ノート${n.id}のコメントは1リクエストあたり${MAX_COMMENTS_PER_NOTE}件までです。` };
  const comments: CommentInput[] = [];
  for (const rc of rawComments) {
    const c = normalizeComment(rc, n.id);
    if (c.error !== undefined) return { error: c.error };
    comments.push(c.value);
  }
  const seen = normalizeStamp(n.firstSeenAt) ?? postedAt;
  return {
    value: {
      id: n.id, room, authorName, authorIsTarget: n.authorIsTarget === true, programTitle: clean(n.programTitle, 200),
      linkTitle: clean(n.linkTitle, 300), linkUrl: /^https?:\/\//.test(clean(n.linkUrl, 1000)) ? clean(n.linkUrl, 1000) : "",
      bodyText: cleanBody(n.bodyText), bodyComplete: n.bodyComplete === true, postedAt, postedAtPrecision: n.postedAtPrecision,
      postedAtRaw: clean(n.postedAtRaw, 60), commentCount: count(n.commentCount), needsRecheck: n.needsRecheck === true,
      firstSeenAt: seen, lastCheckedAt: normalizeStamp(n.lastCheckedAt) ?? seen, deletedAt: normalizeStamp(n.deletedAt), comments,
    },
  };
}

export type NotesBatch = { notes: NoteInput[]; errors: Array<{ id: string; error: string }> };

/** 1リクエストぶんのノートを検証する。壊れたノートは errors に入れ、ほかのノートは保存できるようにする。 */
export function normalizeNotesBatch(raw: unknown): Normalized<NotesBatch> {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "notesが必要です。" };
  if (raw.length > MAX_NOTES_PER_REQUEST) return { error: `notesは1リクエストあたり${MAX_NOTES_PER_REQUEST}件までです。` };
  const notes: NoteInput[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  let commentTotal = 0;
  for (const item of raw) {
    const result = normalizeNote(item);
    const id = item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string" ? String((item as Record<string, unknown>).id) : "";
    if (result.error !== undefined) { errors.push({ id, error: result.error }); continue; }
    commentTotal += result.value.comments.length;
    notes.push(result.value);
  }
  if (commentTotal > MAX_COMMENTS_PER_REQUEST) return { error: `コメントは1リクエストあたり${MAX_COMMENTS_PER_REQUEST}件までです。` };
  return { value: { notes, errors } };
}

export type CompleteInput = {
  status: RunStatus; notesScanned: number; notesOpened: number; commentsNew: number; targetCommentsNew: number; warnings: string[];
};

export function normalizeComplete(raw: Record<string, unknown>): Normalized<CompleteInput> {
  const status = raw.status;
  if (typeof status !== "string" || !(RUN_STATUSES as readonly string[]).includes(status)) return { error: "statusが不正です。" };
  const stats = (raw.stats && typeof raw.stats === "object" ? raw.stats : {}) as Record<string, unknown>;
  const warnings = (Array.isArray(raw.warnings) ? raw.warnings : []).map((w) => clean(w, 300)).filter(Boolean).slice(0, 50);
  return {
    value: {
      status: status as RunStatus, notesScanned: count(stats.notesScanned), notesOpened: count(stats.notesOpened),
      commentsNew: count(stats.commentsNew), targetCommentsNew: count(stats.targetCommentsNew), warnings,
    },
  };
}
