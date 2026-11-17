#!/bin/sh
# 本番 D1 の週次バックアップ（scripts/backup-d1.mjs）を launchd に登録する。
#
#   sh scripts/install-backup-launchd.sh              登録する（すでにあれば入れ替える）
#   sh scripts/install-backup-launchd.sh --print      登録せず、生成する plist を表示する
#   sh scripts/install-backup-launchd.sh --uninstall  登録を外し、plist を消す
#
# リポジトリの現在位置と、いまの node の場所を埋め込んで ~/Library/LaunchAgents/ に plist を置く。
# リポジトリを移動したり、node を入れ替えたりしたら、もう一度実行する。
# バックアップの置き場は ~/Backups/dashboard/（新しい8件だけ残す）、ログは ~/Library/Logs/dashboard-d1-backup.log。
set -eu

label="com.watch-list.d1-backup"
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
template="$project_root/scripts/launchd/$label.plist.template"
target="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$target"
  echo "Removed $label"
  exit 0
fi

node_bin=$(command -v node) || { echo "node が見つかりません。" >&2; exit 1; }
node_dir=$(dirname -- "$node_bin")
plist=$(sed -e "s|__PROJECT_ROOT__|$project_root|g" -e "s|__NODE__|$node_bin|g" -e "s|__NODE_DIR__|$node_dir|g" -e "s|__HOME__|$HOME|g" "$template")

if [ "${1:-}" = "--print" ]; then
  printf '%s\n' "$plist"
  exit 0
fi

mkdir -p "$(dirname -- "$target")" "$HOME/Library/Logs"
printf '%s\n' "$plist" > "$target"
plutil -lint "$target"
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$target"
echo "Installed $target"
echo "すぐに試すには: launchctl kickstart gui/$(id -u)/$label"
