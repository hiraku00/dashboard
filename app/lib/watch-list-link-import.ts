/** Pure merge of a link preview (YouTube, NHK ONE, テレ東BIZ, TVer ...) into the Watch List editor's draft -- no
 *  React, no I/O, so it is unit-tested under vitest's plain-Node "node"
 *  project (see tests/watch-list-link-import.test.mjs).
 *
 *  The preview comes from /api/watch-list/link-preview, the same lookup the
 *  ちきりんオプチャ detail form uses. What it learned is written to the draft:
 *  the program / channel name (`seriesTitle`), the title and the link. The
 *  broadcaster (`creatorName`, 人物・媒体) is only filled in while it is
 *  blank: it is the user's, and a YouTube preview has none. Everything else
 *  -- the content type, the description, other links -- is left as it was.
 *  (The preview used to be spread over the draft wholesale, which blanked
 *  `creatorName` and replaced every link.) */
import { siteOf } from "./openchat-meta.ts";
import { youTubeVideoId } from "./youtube.ts";

type ImportedLink = { id?: string; label: string; url: string; linkType?: string };

export type LinkPreviewFields = { creatorName: string; seriesTitle: string; title: string };

/** リンクの表示名: 分かっているサイトはその名前(NHK ONE・テレ東BIZ・TVer)、YouTube は「YouTube」、ほかはドメイン。 */
export function linkLabel(url: string) {
  if (youTubeVideoId(url)) return "YouTube";
  const site = siteOf(url);
  if (site) return site.name;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export function applyLinkPreview<Draft extends { creatorName: string; seriesTitle: string; title: string; links: ImportedLink[] }>(draft: Draft, preview: LinkPreviewFields, url: string): Draft {
  // A blank row is the editor's empty placeholder, not something to keep.
  const kept = draft.links.filter((link) => link.label.trim() || link.url.trim());
  const added = kept.some((existing) => existing.url.trim() === url) ? [] : [{ label: linkLabel(url), url, linkType: "reference" }];
  return {
    ...draft,
    creatorName: draft.creatorName.trim() || preview.creatorName.trim(),
    seriesTitle: preview.seriesTitle.trim() || draft.seriesTitle,
    title: preview.title.trim() || draft.title,
    links: [...kept, ...added],
  };
}
