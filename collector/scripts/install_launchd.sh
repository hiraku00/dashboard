#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
template="$project_root/collector/launchd/com.watch-list.manage-asset-collector.plist.template"
target="$HOME/Library/LaunchAgents/com.watch-list.manage-asset-collector.plist"

mkdir -p "$(dirname -- "$target")"
sed "s|__PROJECT_ROOT__|$project_root|g" "$template" > "$target"
plutil -lint "$target"

domain="gui/$(id -u)"
launchctl bootout "$domain/com.watch-list.manage-asset-collector" 2>/dev/null || true
launchctl bootstrap "$domain" "$target"
echo "Installed $target"
