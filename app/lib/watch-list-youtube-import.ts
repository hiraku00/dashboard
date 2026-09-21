/** Pure merge of a YouTube preview into the Watch List editor's draft -- no
 *  React, no I/O, so it is unit-tested under vitest's plain-Node "node"
 *  project (see tests/watch-list-youtube-import.test.mjs).
 *
 *  Only what the fetch actually learned about the video is written: the
 *  channel name (`seriesTitle`), the title and the video link. Everything
 *  else on the draft -- 人物・媒体 (`creatorName`), the content type, the
 *  description, other links -- is the user's and is left as it was. The
 *  preview used to be spread over the draft wholesale, which blanked
 *  `creatorName` with the route's placeholder "" and replaced every link. */

type ImportedLink = { id?: string; label: string; url: string; linkType?: string };

export type YouTubePreviewItem = { seriesTitle: string; title: string; links: ImportedLink[] };

export function applyYouTubePreview<Draft extends { seriesTitle: string; title: string; links: ImportedLink[] }>(draft: Draft, preview: YouTubePreviewItem): Draft {
  // A blank row is the editor's empty placeholder, not something to keep.
  const kept = draft.links.filter((link) => link.label.trim() || link.url.trim());
  const added = preview.links.filter((link) => !kept.some((existing) => existing.url.trim() === link.url));
  return {
    ...draft,
    seriesTitle: preview.seriesTitle.trim() || draft.seriesTitle,
    title: preview.title.trim() || draft.title,
    links: [...kept, ...added],
  };
}
