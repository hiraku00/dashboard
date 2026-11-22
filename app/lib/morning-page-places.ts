/** モーニングページの「場所」(ヘッダーの表に手で書いた自由記述)を、意味でまとめる。D1に触れない純粋なロジック。
 *
 *  同じ場所でも「7F-中庭」「7F 中庭」「中庭」、「Focus 2」「Focus2」「7F Focus2」のように書き方が揺れるので、
 *  文字の一致ではなく、どこで書いたかの種類(自宅・建物の共用スペース・実家…)で数える。
 *  「自宅(co-working)」のように自宅の建物の共用スペースを書いた分は、自宅ではなく共用スペースに入れる。 */

export type PlaceGroup = "home" | "shared" | "family" | "friends" | "stay" | "cafe" | "transit" | "other";

/** 表示の順(凡例・積み上げの下から) */
export const PLACE_GROUPS: { group: PlaceGroup; label: string }[] = [
  { group: "home", label: "自宅" },
  { group: "shared", label: "共用スペース" },
  { group: "family", label: "実家" },
  { group: "friends", label: "知人・親戚の家" },
  { group: "stay", label: "宿泊先" },
  { group: "cafe", label: "カフェ・店" },
  { group: "transit", label: "移動中" },
  { group: "other", label: "その他・不明" },
];

export const placeGroupLabel = (group: PlaceGroup) => PLACE_GROUPS.find((entry) => entry.group === group)!.label;

// 上から順に当てる(「Cafe Amazon(トンロー駅前店)」は移動中より先にカフェ、「自宅(co-working)」は共用スペース、「自宅（槻木）」は実家のように、自宅の判定より先に見る)
const RULES: [PlaceGroup, RegExp][] = [
  ["family", /実家|槻木/],
  ["friends", /石川家/],
  ["cafe", /カフェ|cafe|エクセルシオール|サンマルク|ベローチェ|kitchen/i],
  ["transit", /バス|電車|空港|駅/],
  ["stay", /ホテル|hotel|お宿|ファーストキャビン|大東洋|アパ/i],
  ["shared", /co-?working|中庭|focus|R棟|sky|lounge|ラウンジ|\d+F/i],
  ["home", /^自宅/],
];

export function classifyPlace(place: string): PlaceGroup {
  const text = place.trim();
  if (!text) return "other";
  return RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
}

export type PlaceCounts = Record<PlaceGroup, number>;

export const emptyPlaceCounts = (): PlaceCounts => ({ home: 0, shared: 0, family: 0, friends: 0, stay: 0, cafe: 0, transit: 0, other: 0 });
