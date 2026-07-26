import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("defines the watch list product", async () => { const [page, app, layout] = await Promise.all([readFile(new URL("../app/page.tsx", import.meta.url), "utf8"), readFile(new URL("../app/watch-list-app.tsx", import.meta.url), "utf8"), readFile(new URL("../app/layout.tsx", import.meta.url), "utf8")]); assert.match(page, /WatchListApp/); assert.match(app, /Watch List/); assert.match(app, /target="_blank"/); assert.match(app, /dateLabel/); assert.match(app, /api\/items/); assert.match(app, /cdn-cgi\/access\/logout/); assert.match(layout, /私の鑑賞リスト/); });
