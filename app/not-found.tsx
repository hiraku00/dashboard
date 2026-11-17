import Link from "next/link";
import { PortalHeader } from "./portal-nav";

/** どのルートにも当たらない URL（消した記事、打ち間違い、古いブックマーク）の画面。
 *  何も無いと、フレームワークの素の「404」だけが出て、ポータルのメニューにも戻れなかった。 */
export default function NotFound() {
  return (
    <main className="portal-shell">
      <PortalHeader title="ページが見つかりません" />
      <div className="empty-state" role="alert">
        <strong>お探しのページはありません。</strong>
        <p>アドレスが違うか、移動または削除された可能性があります。</p>
        <Link href="/" prefetch={false}>ホームへ戻る</Link>
      </div>
    </main>
  );
}
