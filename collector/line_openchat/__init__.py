"""LINEオープンチャットのノートから、ちきりんさんの投稿を取り出すcollector.

LINEは参照のみ。投稿・リアクション・削除などの書き込み操作は、safety.py が
機械的に禁止している。設計は docs/chikirin-openchat.md を参照。
"""

VERSION = "line-openchat/1"
