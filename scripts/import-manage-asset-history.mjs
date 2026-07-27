import fs from "node:fs/promises";

const portal = process.env.PORTAL_URL ?? "https://hiraku-watch-list.hiraku-watch-list.workers.dev";
const clientId = process.env.PORTAL_SYNC_CLIENT_ID;
const secret = process.env.PORTAL_SYNC_TOKEN;
if (!clientId || !secret) throw new Error("PORTAL_SYNC_CLIENT_ID と PORTAL_SYNC_TOKEN が必要です。");
const root = process.env.MANAGE_ASSET_ROOT ?? "/Users/hiraku/Practice/manage-asset";
const readJsonl = async name => (await fs.readFile(`${root}/data/${name}`, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
const snapshots = await readJsonl("snapshots.jsonl");
const exchangeSnapshots = await readJsonl("portfolio-snapshots.jsonl");
const lidoRewards = await readJsonl("lido-rewards.jsonl");
const rates = JSON.parse(await fs.readFile(`${root}/data/usd-jpy-rates.json`, "utf8"));
const headers = { "content-type": "application/json", "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": secret, "User-Agent": "manage-asset-history-migration/1.0" };
const post = async body => { const response = await fetch(`${portal}/api/manage-asset/history-import`, { method: "POST", headers, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(JSON.stringify(data)); return data; };
console.log(await post({ snapshots, exchangeSnapshots }));
console.log(await post({ lidoRewards, rates }));
console.log(JSON.stringify({ snapshots: snapshots.length, exchangeSnapshots: exchangeSnapshots.length, lidoRewards: lidoRewards.length, rates: rates.length }));
