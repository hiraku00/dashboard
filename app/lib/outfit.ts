/** モーニングページのヘッダーの表「服装」(`上:シャツ(Uniqlo U)<br>中:Tシャツ(WhitesVille)<br>下:デニム(白)`)。
 *  auto-daily-report が上・中・下の段ごとに書いたままの値で送り、morning_pages の outfit_top / outfit_middle / outfit_bottom に置く。
 *  服装はその日の朝に書くので、日報 D にはページ D の服装を出す。 */

export type Outfit = { top: string; middle: string; bottom: string };

export const OUTFIT_LAYERS = [
  { key: "top", label: "上" },
  { key: "middle", label: "中" },
  { key: "bottom", label: "下" },
] as const;

export const EMPTY_OUTFIT: Outfit = { top: "", middle: "", bottom: "" };

export const hasOutfit = (outfit: Outfit | null | undefined): outfit is Outfit => Boolean(outfit && (outfit.top || outfit.middle || outfit.bottom));

/** 書いた段だけを「上」「シャツ(Uniqlo U)」の組で返す(表示用) */
export function outfitParts(outfit: Outfit | null | undefined): { label: string; value: string }[] {
  if (!outfit) return [];
  return OUTFIT_LAYERS.filter((layer) => outfit[layer.key]).map((layer) => ({ label: layer.label, value: outfit[layer.key] }));
}

/** D1 の行(outfit_top など)から読む。列が無い・NULL の値は空文字 */
export function outfitFromRow(row: Record<string, unknown>): Outfit {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return { top: text(row.outfit_top), middle: text(row.outfit_middle), bottom: text(row.outfit_bottom) };
}
