import { outfitParts, type Outfit } from "./lib/outfit";

/** モーニングページに書いた服装の1行(上・中・下の書いた段だけ。ブランドは品名の後ろに薄く)。日報とモーニングページの画面で使う */
export function OutfitLine({ outfit, className }: { outfit: Outfit; className: string }) {
  return (
    <p className={`outfit-line ${className}`}>
      <span>服装</span>
      {outfitParts(outfit).map((part) => (
        <span key={part.label}>
          <b>{part.label}</b>
          {part.item}
          {part.brand ? <small>{part.brand}</small> : null}
        </span>
      ))}
    </p>
  );
}
