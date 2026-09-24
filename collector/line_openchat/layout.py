"""ノートウィンドウの寸法・色の実測値(pt, ウィンドウ左上が原点).

LINE for Mac のダークテーマ、ノートウィンドウ幅428ptでの検証結果(2026-09-24)。
LINEの見た目が変わったら、ここだけを直す。
"""
from __future__ import annotations

WIN_W = 428.0
WIN_H = 1130.0

BG = (0x2D, 0x2E, 0x30)          # 背景色
BG_TOLERANCE = 30                # RGBの差の合計がこの値以内なら背景

TOP_MARGIN = 58.0                # これより上はウィンドウのタイトル「ノート」
NOTE_X_MAX = 32.0                # ノート本文・時刻行の左端はこれより左
NAME_X_MIN = 40.0                # 作者名の左端(アバターの右)
NAME_X_MAX = 80.0
SIDE_X_MIN = 330.0               # 右端の小さな文字(リアクション数など)
SIDE_W_MAX = 70.0
LINK_CARD_X_MIN = 100.0          # リンクプレビューの文字はこれより右

AVATAR_X0, AVATAR_X1 = 16.0, 40.0
AVATAR_LEFT_BG_X = 10.0          # アバターの左外側(背景色のはず)
AVATAR_RIGHT_BG_X = 47.5         # アバターの右外側(背景色のはず). 公式バッジは x≈45 まで張り出す。名前の文字は x≥49
AVATAR_MIN_FILL = 0.25
AVATAR_MIN_H, AVATAR_MAX_H = 22.0, 34.0   # 文字行(約15pt)・帯やカード(35pt超)と区別する
AVATAR_TOP_EDGE = TOP_MARGIN + 30.0       # これより上で始まるアバターは切れている可能性

# 公式バッジ: 青い丸(実測で #0070FF の単色と、#00A4FF→#0096FF の縦グラデーションの両方があった)
BADGE_X0, BADGE_X1 = 32.0, 49.0
BADGE_MIN_PIXELS = 40            # 1ptごとに数えた画素数. 丸の面積は約110pt²

# リアクション・コメント数の行(アイコンと数字の並び)
ICON_W_MIN, ICON_W_MAX = 15.0, 18.5
COUNTS_ROW_ABOVE_TIME = 15.5     # 時刻行の上端から、数の行の中心までの距離
COUNTS_SCAN_X_MAX = 200.0
COUNT_BRIGHT_SUM = 330           # RGBの合計がこれを超えたら明るい画素(アイコン・数字)
COUNT_CLUSTER_GAP = 4.0

# 文章の組み立て
PARAGRAPH_GAP = 24.0             # 行の上端の差がこれを超えたら段落の区切り
WRAP_RIGHT = 390.0               # 行の右端がこれ以上なら折り返し(次の行へ続く)
