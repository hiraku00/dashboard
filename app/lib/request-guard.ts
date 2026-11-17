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

/** すべてのレスポンスに付ける。
 *  CSP は frame-ancestors だけにしてある: このアプリは自分のページを iframe に入れておらず、他所から
 *  埋め込まれる理由も無い（クリックジャッキング対策）。script-src などの CSP は、vinext の
 *  インラインスクリプトや mermaid が動かなくなるおそれがあるので、まだ入れていない。 */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** アプリが自分で付けたヘッダーは上書きしない。 */
export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
}
