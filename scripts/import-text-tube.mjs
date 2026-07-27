#!/usr/bin/env node
import fs from "node:fs/promises";

const [inputPath, baseUrl = "http://127.0.0.1:8787"] = process.argv.slice(2);
if (!inputPath) {
  console.error("Usage: node scripts/import-text-tube.mjs export.json [portal-url]");
  process.exit(1);
}

const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
const videos = Array.isArray(input) ? input : input.videos;
if (!Array.isArray(videos)) throw new Error("videos配列を含むJSONを指定してください。");

const clientId = process.env.PORTAL_SYNC_CLIENT_ID;
const clientSecret = process.env.PORTAL_SYNC_TOKEN;
if (!clientId || !clientSecret) throw new Error("PORTAL_SYNC_CLIENT_IDとPORTAL_SYNC_TOKENが必要です。");
const headers = {
  "content-type": "application/json",
  "CF-Access-Client-Id": clientId,
  "CF-Access-Client-Secret": clientSecret,
  "User-Agent": "text-tube-portal-migration/1.0",
};
let created = 0;
let failed = 0;
for (const source of videos) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/text-tube/videos`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: source.title,
      channelName: source.channelName ?? source.channel_name,
      thumbnailUrl: source.thumbnailUrl ?? source.thumbnail_url,
      originalUrl: source.originalUrl ?? source.original_url,
      summary: source.summary,
      publishedAt: source.publishedAt ?? source.published_at,
      viewCount: source.viewCount ?? source.view_count,
      channelThumbnailUrl: source.channelThumbnailUrl ?? source.channel_thumbnail_url,
      duration: source.duration,
    }),
  });
  if (!response.ok) {
    failed += 1;
    console.error(`登録失敗: ${source.title}`, await response.text());
    continue;
  }
  const { id } = await response.json();
  const document = source.detailedScript ?? source.detailed_script;
  if (document) {
    const documentResponse = await fetch(`${baseUrl.replace(/\/$/, "")}/api/text-tube/videos/${id}/document`, { method: "POST", headers: { ...headers, "content-type": "text/markdown; charset=utf-8" }, body: document });
    if (!documentResponse.ok) {
      failed += 1;
      console.error(`本文保存失敗: ${source.title}`, await documentResponse.text());
      continue;
    }
  }
  created += 1;
}
console.log(JSON.stringify({ total: videos.length, created, failed }));
process.exitCode = failed ? 2 : 0;
