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

/** HTML の 1 リクエストごとに作る、スクリプト用のノンス（推測できない一回限りの値）。 */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** CSP。このアプリが実際に読み込んでいるものだけを許す:
 *  - script は自分のオリジンと、ノンスの付いたインラインだけ。ノンスは HTML のリクエストごとに作り
 *    （worker/index.ts）、vinext が初期表示のデータを渡すインラインのスクリプトに付ける。ノンスの無い
 *    インラインのスクリプト（HTML に紛れ込んだ <script>、onclick などの属性）と、外部のスクリプト、
 *    eval は動かない。ノンスを渡さない呼び出し（API など、HTML でない応答）は、従来どおり
 *    'unsafe-inline' を許す形にする（そこにはスクリプトが無いので、実害は無い）。
 *  - style は自分のオリジンとインライン（React・mermaid がインラインの style 属性を使う）。
 *  - 画像は https 全般（YouTube・TVer・リンク先の og:image など、保存した URL をそのまま表示する）と
 *    data: / blob:。
 *  - 通信（fetch）は自分のオリジンだけ。ページに仕込まれたスクリプトが、データを外へ送れない。
 *  - frame-ancestors 'none' は、他所から埋め込まれない（クリックジャッキング対策）。 */
export function contentSecurityPolicy(nonce?: string): string {
  return [
    "default-src 'self'",
    nonce ? `script-src 'self' 'nonce-${nonce}'` : "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** すべてのレスポンスに付ける。 */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "content-security-policy": contentSecurityPolicy(),
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** アプリが自分で付けたヘッダーは上書きしない。 */
export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
}
