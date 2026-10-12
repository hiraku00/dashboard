#!/usr/bin/env node
// 相次ぐ不正アクセス・情報漏えいについての注意喚起に沿って、このアプリを点検する。
//   IPA     https://www.ipa.go.jp/security/security-alert/2026/alert20261009.html
//   JPCERT  https://www.jpcert.or.jp/at/2026/at260030.html (JPCERT-AT-2026-0030)
//
// 読み取りだけを行う。本番へ送るのは Access に止められるリクエストだけで、
// Worker も D1 も動かない(D1 の読み取り枠を使わない)。
//
// 使い方:
//   node scripts/security-check.mjs
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/security-check.mjs
//     → Access のポリシー・サービストークン・認証ログ(直近30日)も見る
//       (トークンには Access: Apps and Policies / Service Tokens / Audit Logs の Read が要る)
//
// 終了コード: 要対応(NG)が1つでもあれば 1。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const baseUrl = (process.env.SMOKE_BASE_URL ?? "https://dashboard.hiraku00.workers.dev").replace(/\/$/, "");

// JPCERT-AT-2026-0030 に載っている不審な送信元IP(正規利用の可能性もあると注記あり)。
const IOC_IPS = [
  "20.210.128.125",
  "3.112.252.14", "54.95.112.6", "69.10.51.162", "172.86.91.7", "210.149.87.120",
  "31.76.91.2", "136.117.40.140", "136.85.58.5", "141.11.187.186", "207.241.172.54",
  "213.163.202.171", "221.216.140.49", "221.216.140.129",
  "124.133.237.18",
];

const results = [];
const ok = (section, message) => results.push({ level: "OK", section, message });
const warn = (section, message) => results.push({ level: "WARN", section, message });
const ng = (section, message) => results.push({ level: "NG", section, message });
const info = (section, message) => results.push({ level: "INFO", section, message });

const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, ...opts });
  } catch (error) {
    // npm audit / git grep は「見つかった」「見つからない」を終了コードで返すので stdout を拾う。
    if (typeof error.stdout === "string") return error.stdout;
    throw error;
  }
};

const isGuarded = (response) => {
  const location = response.headers.get("location") ?? "";
  const challenge = response.headers.get("www-authenticate") ?? "";
  return challenge.toLowerCase().includes("cloudflare-access") || location.includes("cloudflareaccess.com");
};

const probe = async (urlPath, init = {}) =>
  fetch(`${baseUrl}${urlPath}`, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init });

// ---------------------------------------------------------------------------
// 1. 非公開APIを含む全エンドポイントが Access の後ろにあるか
//    (JPCERT ケースB: 画面からは呼べない内部APIを直接叩く・不正形式のトークンで応答差を見る)
// ---------------------------------------------------------------------------
async function checkAccessGuard() {
  const section = "Access(全エンドポイント)";
  const apiRoutes = run("find", ["app", "-name", "route.ts"])
    .split("\n")
    .filter(Boolean)
    .map((file) => file.replace(/^app/, "").replace(/\/route\.ts$/, "").replace(/\[[^\]]+\]/g, "1"))
    .filter((route) => route.startsWith("/api/"));
  const pages = ["/", "/watch-list", "/text-tube", "/manage-asset", "/todo"];

  // 素のリクエストに加え、不正形式の Access トークン・サービストークンを付けたもの、
  // 書き込み系メソッドでも Access が先に止めることを確かめる。
  const variants = [
    { label: "GET", init: {} },
    { label: "POST", init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } },
    { label: "GET+偽JWT", init: { headers: { "cf-access-jwt-assertion": "eyJhbGciOiJub25lIn0.e30.", cookie: "CF_Authorization=x" } } },
    { label: "POST+偽サービストークン", init: { method: "POST", headers: { "cf-access-client-id": "x.access", "cf-access-client-secret": "x", "content-type": "application/json" }, body: "{}" } },
  ];

  let checked = 0;
  const leaks = [];
  for (const urlPath of [...pages, ...apiRoutes]) {
    for (const { label, init } of urlPath.startsWith("/api/") ? variants : variants.slice(0, 1)) {
      checked += 1;
      try {
        const response = await probe(urlPath, init);
        if (!isGuarded(response)) leaks.push(`${label} ${urlPath} → HTTP ${response.status}`);
      } catch (error) {
        leaks.push(`${label} ${urlPath} → 失敗 (${error.message})`);
      }
    }
  }
  if (leaks.length) ng(section, `Access を通らずに応答したもの:\n      ${leaks.join("\n      ")}`);
  else ok(section, `${checked} 件のリクエスト(ページ ${pages.length} + API ${apiRoutes.length} 経路)がすべて Access で止まった`);
}

// ---------------------------------------------------------------------------
// 2. 設定ファイル・バックアップファイルが取られないか
//    (JPCERT ケースA: 環境設定ファイルやバックアップファイルの窃取)
//    静的アセットは Access の外で配信されるので(wrangler.jsonc のコメント参照)ここが穴になりうる。
// ---------------------------------------------------------------------------
const SENSITIVE_NAME = /(^|\/)(\.env(\..*)?|\.dev\.vars(\..*)?|\.git|\.npmrc|wrangler\.(jsonc?|toml)|.*\.(bak|old|orig|swp|sql|sqlite3?|db|dump|pem|key|p12|zip|tar|gz|tgz|war|jsp|map))$/i;

async function checkSensitiveFiles() {
  const section = "設定・バックアップファイル";
  const walk = (dir) =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const full = path.join(dir, entry.name);
          return entry.isDirectory() ? [full + "/", ...walk(full)] : [full];
        })
      : [];

  // ソースマップは公開アセットにあるとソースが読めてしまうので含める。
  const exposed = ["public", "dist/client"].flatMap((dir) =>
    walk(path.join(root, dir)).map((file) => path.relative(root, file)).filter((file) => SENSITIVE_NAME.test(file.replace(/\/$/, ""))),
  );
  if (!fs.existsSync(path.join(root, "dist/client"))) warn(section, "dist/client が無い(npm run build 後に再実行すると配信物も見られる)");
  if (exposed.length) ng(section, `Access の外で配信される場所に置かれている:\n      ${exposed.join("\n      ")}`);
  else ok(section, "public/ と dist/client/ に設定・バックアップ・ソースマップ類は無い");

  const candidates = ["/.env", "/.dev.vars", "/.git/config", "/.git/HEAD", "/wrangler.jsonc", "/package.json", "/backup.zip", "/db.sqlite", "/assets/.env", "/index.jsp", "/manager/html"];
  const served = [];
  for (const urlPath of candidates) {
    try {
      const response = await probe(urlPath);
      if (!isGuarded(response) && response.status < 300) served.push(`${urlPath} → HTTP ${response.status}`);
    } catch (error) {
      served.push(`${urlPath} → 失敗 (${error.message})`);
    }
  }
  if (served.length) ng(section, `本番で取得できてしまう:\n      ${served.join("\n      ")}`);
  else ok(section, `本番で ${candidates.length} 種類の設定・バックアップ・Webシェル系のパスを試し、どれも取れなかった`);
}

// ---------------------------------------------------------------------------
// 3. 秘密情報がリポジトリに入っていないか
//    (JPCERT ケースB: 他所で漏れた API キーの悪用)
// ---------------------------------------------------------------------------
function checkCommittedSecrets() {
  const section = "コミット済みの秘密情報";
  const tracked = run("git", ["ls-files"]).split("\n").filter(Boolean);
  const badFiles = tracked.filter((file) => /(^|\/)(\.env|\.dev\.vars)(\.|$)/.test(file) && !/\.example$/.test(file));
  if (badFiles.length) ng(section, `追跡されている秘密ファイル: ${badFiles.join(", ")}`);

  const patterns = [
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "AKIA[0-9A-Z]{16}",
    "sk-(ant-|proj-)?[A-Za-z0-9_-]{20,}",
    "gh[pousr]_[A-Za-z0-9]{36}",
    "xox[baprs]-[A-Za-z0-9-]{10,}",
    "AIza[0-9A-Za-z_-]{35}",
    "(api[_-]?key|secret|token|password)[\"']?\\s*[:=]\\s*[\"'][A-Za-z0-9/+_.-]{24,}[\"']",
  ];
  const hits = run("git", ["grep", "-nIiE", patterns.join("|"), "--", ".", ":!package-lock.json"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(0, 160));
  if (hits.length) warn(section, `秘密情報らしき文字列(誤検知を含みうるので目で確認):\n      ${hits.join("\n      ")}`);
  if (!badFiles.length && !hits.length) ok(section, "追跡中のファイルに秘密ファイル・鍵らしき文字列は無い");
}

// ---------------------------------------------------------------------------
// 4. 既知の脆弱性が残っていないか(IPA: 未適用の脆弱性対応パッチ / JPCERT ケースA・C)
// ---------------------------------------------------------------------------
function checkNpmAudit() {
  const section = "npm 依存の既知脆弱性";
  let report;
  try {
    report = JSON.parse(run("npm", ["audit", "--json"]));
  } catch (error) {
    warn(section, `npm audit を実行できなかった (${error.message.split("\n")[0]})`);
    return;
  }
  const vulns = Object.values(report.vulnerabilities ?? {});
  const prodNames = new Set(
    Object.keys(JSON.parse(run("npm", ["ls", "--omit=dev", "--all", "--json"])).dependencies ?? {}),
  );
  const describe = (v) => {
    const advisories = [...new Set(v.via.filter((via) => typeof via === "object").map((via) => via.url?.split("/").pop()).filter(Boolean))];
    const fix =
      v.fixAvailable === true ? "修正版あり"
      : v.fixAvailable ? `修正: ${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? " メジャー変更" : ""}`
      : "修正版なし";
    return `${v.name} (${v.severity}${prodNames.has(v.name) ? ", 本番依存" : ""}) ${advisories.join(" ")} [${fix}]`;
  };
  const serious = vulns.filter((v) => v.severity === "critical" || v.severity === "high");
  const rest = vulns.length - serious.length;
  if (serious.length) {
    const lines = serious.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1)).map(describe);
    // devDependencies だけの脆弱性は Worker に載らないので WARN にとどめる。
    const anyProd = serious.some((v) => prodNames.has(v.name) || v.effects?.some((name) => prodNames.has(name)));
    (anyProd ? ng : warn)(section, `high/critical ${serious.length} 件${anyProd ? "" : "(すべて開発用依存)"}:\n      ${lines.join("\n      ")}`);
  } else {
    ok(section, "high/critical は無い");
  }
  if (rest) info(section, `low/moderate ${rest} 件(npm audit で詳細)`);
}

function checkPythonDeps() {
  const section = "collector の Python 依存";
  // launchd の collector はこの python3 で動く(memory: collector launchd Python deps)。
  const python = fs.existsSync("/usr/local/bin/python3") ? "/usr/local/bin/python3" : "python3";
  const reqs = path.join(root, "collector/requirements.txt");
  try {
    const out = run(python, ["-m", "pip_audit", "-r", reqs, "--format", "json", "--progress-spinner", "off"]);
    const deps = JSON.parse(out).dependencies ?? [];
    const vulnerable = deps.filter((d) => d.vulns?.length);
    if (vulnerable.length) ng(section, vulnerable.map((d) => `${d.name} ${d.version}: ${d.vulns.map((v) => `${v.id}(修正 ${v.fix_versions.join("/") || "なし"})`).join(", ")}`).join("\n      "));
    else ok(section, `pip-audit: ${deps.length} パッケージに既知脆弱性なし`);
  } catch {
    const outdated = run(python, ["-m", "pip", "list", "--outdated", "--format", "json"]);
    const names = fs.readFileSync(reqs, "utf8").split("\n").map((line) => line.split(/[<>=\s]/)[0].toLowerCase()).filter(Boolean);
    const stale = (JSON.parse(outdated || "[]")).filter((p) => names.includes(p.name.toLowerCase()));
    warn(
      section,
      `pip-audit が無いので脆弱性は未確認(${python} -m pip install pip-audit で入る)。` +
        (stale.length ? `\n      更新があるもの: ${stale.map((p) => `${p.name} ${p.version}→${p.latest_version}`).join(", ")}` : " requirements のパッケージはすべて最新"),
    );
  }
}

// ---------------------------------------------------------------------------
// 5. この Mac で外向きに開いている待ち受けポート
//    (JPCERT: 業務上不要なサービスや管理機能のインターネット公開を停止する)
// ---------------------------------------------------------------------------
function checkListeningPorts() {
  const section = "Mac の待ち受けポート";
  let out;
  try {
    out = run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  } catch {
    warn(section, "lsof を実行できなかった");
    return;
  }
  const open = [...new Set(
    out.split("\n").slice(1).filter(Boolean)
      .map((line) => line.split(/\s+/))
      .filter((cols) => /^(\*|0\.0\.0\.0|\[::\]):\d+$/.test(cols[8] ?? ""))
      .map((cols) => `${cols[0]} ${cols[8]}`),
  )];
  // rapportd(Handoff 等)と ControlCenter(AirPlay レシーバー)は macOS 標準。
  const system = open.filter((entry) => /^(rapportd|ControlCe)/.test(entry));
  const other = open.filter((entry) => !system.includes(entry));
  if (system.length) info(section, `macOS 標準(AirPlay レシーバー等。不要ならシステム設定で切れる): ${system.join(", ")}`);
  if (other.length) warn(section, `全インターフェースで待ち受けているもの(LAN/外部から届きうる。不要なら止める):\n      ${other.join("\n      ")}`);
  if (!other.length) ok(section, "macOS 標準以外に全インターフェースで待ち受けているプロセスは無い(自分のユーザーで見える範囲)");
}

// ---------------------------------------------------------------------------
// 6. Cloudflare Access のアカウント棚卸し・トークン・認証ログ(任意)
//    (IPA: 作成していない/無効のはずのアカウントの確認、ログの確認 / JPCERT: 長期間有効なトークンを避ける)
// ---------------------------------------------------------------------------
async function checkCloudflare() {
  const section = "Cloudflare Access";
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    info(section, "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID が無いので省略(ポリシー・サービストークン・認証ログを見るには設定して再実行)");
    return;
  }
  const api = async (p) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${p}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.success) throw new Error(`${p}: HTTP ${response.status} ${body.errors?.map((e) => e.message).join("; ") ?? ""}`);
    return body.result;
  };

  try {
    const host = new URL(baseUrl).host;
    const apps = (await api("/access/apps")).filter((a) => [a.domain, ...(a.self_hosted_domains ?? [])].some((d) => d?.startsWith(host)));
    if (!apps.length) ng(section, `${host} を守る Access アプリが見つからない`);
    for (const app of apps) {
      for (const policy of app.policies ?? []) {
        const rules = JSON.stringify(policy.include ?? []);
        const broad = /"everyone"|"email_domain"|"ip"|"any_valid_service_token"/.test(rules);
        (broad ? warn : info)(section, `アプリ「${app.name}」ポリシー「${policy.name}」(${policy.decision}) 対象: ${rules}${broad ? "  ← 広すぎないか確認" : ""}`);
      }
    }
  } catch (error) {
    warn(section, `アプリ・ポリシーを読めなかった (${error.message})`);
  }

  try {
    const now = Date.now();
    for (const t of await api("/access/service_tokens")) {
      const expires = t.expires_at ? Date.parse(t.expires_at) : Infinity;
      const lastSeen = t.last_seen_at ? new Date(t.last_seen_at).toISOString().slice(0, 10) : "未使用";
      const days = Math.round((expires - now) / 86_400_000);
      const note = expires < now ? "期限切れ(不要なら削除)" : days > 365 ? `残り ${days} 日 ← 長すぎないか` : `残り ${days} 日`;
      (days > 365 || expires < now ? warn : info)(section, `サービストークン「${t.name}」 最終使用 ${lastSeen} / ${note}`);
    }
  } catch (error) {
    warn(section, `サービストークンを読めなかった (${error.message})`);
  }

  try {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const logs = await api(`/access/logs/access_requests?since=${encodeURIComponent(since)}&limit=1000&direction=desc`);
    const iocHits = logs.filter((l) => IOC_IPS.includes(l.ip_address));
    const denied = logs.filter((l) => l.allowed === false);
    const users = [...new Set(logs.filter((l) => l.allowed).map((l) => l.user_email))];
    if (iocHits.length) ng(section, `注意喚起のIPからの認証記録:\n      ${iocHits.map((l) => `${l.created_at} ${l.ip_address} ${l.user_email} allowed=${l.allowed}`).join("\n      ")}`);
    else ok(section, `直近30日の認証ログ ${logs.length} 件に注意喚起のIPは無い`);
    info(section, `通過したユーザー: ${users.join(", ") || "なし"}(知らないアドレスが無いか確認)`);
    if (denied.length) warn(section, `拒否 ${denied.length} 件。送信元: ${[...new Set(denied.map((l) => `${l.ip_address}(${l.country ?? "?"})`))].slice(0, 20).join(", ")}`);
  } catch (error) {
    warn(section, `認証ログを読めなかった (${error.message})`);
  }
}

// ---------------------------------------------------------------------------

await checkAccessGuard();
await checkSensitiveFiles();
checkCommittedSecrets();
checkNpmAudit();
checkPythonDeps();
checkListeningPorts();
await checkCloudflare();

info("手作業", "Workers のログ・使っている外部サービス(取引所・DeBank・YouTube 等)のログイン履歴と API キーは、各サービスの画面で直近1か月→3か月と確認する(IPA の点検項目)");
info("参考", `JPCERT の不審IP: ${IOC_IPS.join(", ")}`);

const mark = { OK: "\x1b[32m✔ OK  \x1b[0m", WARN: "\x1b[33m▲ WARN\x1b[0m", NG: "\x1b[31m✖ NG  \x1b[0m", INFO: "\x1b[36mℹ INFO\x1b[0m" };
for (const r of results) console.log(`${mark[r.level]} [${r.section}] ${r.message}`);
const count = (level) => results.filter((r) => r.level === level).length;
console.log(`\nNG ${count("NG")} / WARN ${count("WARN")} / OK ${count("OK")}`);
process.exit(count("NG") ? 1 : 0);
