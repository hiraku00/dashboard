/** モーニングページのヘッダーの表「服装」(`上:ストライプシャツ (UNIQLO)<br>中:Tシャツ (WHITESVILLE)<br>下:白デニム (UNIQLO)`)。
 *  auto-daily-report が上・中・下の段ごとに、品名と末尾の括弧のブランドに分けて送り、
 *  morning_pages の outfit_top / outfit_top_brand(中・下も同じ)に置く。
 *  服装はその日の朝に書くので、日報 D にはページ D の服装を出す。 */

export type OutfitLayer = { item: string; brand: string };
export type Outfit = { top: OutfitLayer; middle: OutfitLayer; bottom: OutfitLayer };

export const OUTFIT_LAYERS = [
  { key: "top", label: "上" },
  { key: "middle", label: "中" },
  { key: "bottom", label: "下" },
] as const;

export const emptyOutfit = (): Outfit => ({ top: { item: "", brand: "" }, middle: { item: "", brand: "" }, bottom: { item: "", brand: "" } });

export const hasOutfit = (outfit: Outfit | null | undefined): outfit is Outfit =>
  Boolean(outfit && OUTFIT_LAYERS.some(({ key }) => outfit[key].item || outfit[key].brand));

/** 書いた段だけを「上」と品名・ブランドの組で返す(表示用) */
export function outfitParts(outfit: Outfit | null | undefined): ({ label: string } & OutfitLayer)[] {
  if (!outfit) return [];
  return OUTFIT_LAYERS.filter(({ key }) => outfit[key].item || outfit[key].brand).map(({ key, label }) => ({ label, ...outfit[key] }));
}

/** D1 の行(outfit_top・outfit_top_brand など)から読む。列が無い・NULL の値は空文字 */
export function outfitFromRow(row: Record<string, unknown>): Outfit {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const layer = (key: string): OutfitLayer => ({ item: text(row[`outfit_${key}`]), brand: text(row[`outfit_${key}_brand`]) });
  return { top: layer("top"), middle: layer("middle"), bottom: layer("bottom") };
}

/** SELECT に並べる列 */
export const OUTFIT_COLUMNS = "outfit_top, outfit_top_brand, outfit_middle, outfit_middle_brand, outfit_bottom, outfit_bottom_brand";
