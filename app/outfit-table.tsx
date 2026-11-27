import { outfitParts, type Outfit } from "./lib/outfit";

/** モーニングページに書いた服装を、上・中・下の段ごとに1行の表にする(書いた段だけ。列は段・品名・ブランド)。日報とモーニングページの画面で使う */
export function OutfitTable({ outfit, className }: { outfit: Outfit; className: string }) {
  const parts = outfitParts(outfit);
  if (!parts.length) return null;
  return (
    <table className={`outfit-table ${className}`}>
      <caption>服装</caption>
      <tbody>
        {parts.map((part) => (
          <tr key={part.label}>
            <th scope="row">{part.label}</th>
            <td>{part.item || "—"}</td>
            <td className="outfit-brand">{part.brand}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
