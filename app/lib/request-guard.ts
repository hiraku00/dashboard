/** Worker の入口で、リクエストとレスポンスに掛ける、ブラウザ向けの守り。I/O の無い純粋な関数だけを置く
 *  （単体テストが、workerd 抜きで読み込めるように）。
 *
 *  Access の認証は Cookie（CF_Authorization）で成り立つので、別のサイトのページから、ログイン中の
 *  ブラウザにこのアプリへ書き込みのリクエストを送らせる（CSRF）ことが、理屈の上ではできる。
 *  ブラウザは書き込みのリクエストに、送り元を示す Origin を必ず付けるので、それが自分のホストと違えば断る。
 *  collector などの非ブラウザ（Service Token）は Origin を付けないので、影響しない。 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 別のサイトから来た書き込み（POST・PATCH・PUT・DELETE）なら true。Origin が無いものは非ブラウザなので false。 */
export function isCrossSiteWrite(request: Request): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    // "null"（サンドボックス化された iframe など）や、読めない値。
    return true;
  }
}

/** CSP。このアプリが実際に読み込んでいるものだけを許す:
 *  - script / style は自分のオリジンと、インライン（vinext が初期表示のデータをインラインの
 *    スクリプトで渡し、React・mermaid がインラインの style を使う）。外部のスクリプトや、
 *    eval は許さない。
 *  - 画像は https 全般（YouTube・TVer・リンク先の og:image など、保存した URL をそのまま表示する）と
 *    data: / blob:。
 *  - 通信（fetch）は自分のオリジンだけ。ページに仕込まれたスクリプトが、データを外へ送れない。
 *  - frame-ancestors 'none' は、他所から埋め込まれない（クリックジャッキング対策）。
 *  インラインのスクリプトを許している間は、XSS を止める力は限られる（ノンスを使う形にすれば
 *  止められるが、vinext 側の対応が要る）。それでも、外部への送信・外部スクリプト・base や form の
 *  差し替えは止まる。 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** すべてのレスポンスに付ける。 */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** アプリが自分で付けたヘッダーは上書きしない。 */
export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
}
