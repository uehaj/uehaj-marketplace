---
name: gh-issue-map
description: GitHub リポジトリの issue・PR・コミットの対応表と、依存（blocked by）・PR がどの issue の作業か・PR の積み上げ・言及を辺で結んだグラフを、1 枚の自己完結 HTML にする。gh api graphql で読むだけで、GitHub には書き込まない。「issue と PR の関係を図にして」「この issue の作業はどの PR か」「PR のスタックを見たい」「依存グラフ」「issue map」で使う。手で呼ぶなら /uehaj:gh-issue-map [owner/repo] [--since 6m]。
---

# gh-issue-map: issue・PR・コミットの表と依存グラフ

以下の `$SKILL_DIR` は、このスキル読み込み時に示される "Base directory for this skill" のパス。
要るのは `gh`（`gh auth login` 済み）、`python3`（標準ライブラリだけ）、ブラウザ。

## 手順

1. 集める。読み取りの GraphQL だけを使う。issue と PR を 50 件ずつ取り、sys1grep 規模（issue 82・PR 99）で約 12 秒。

   ```bash
   python3 "$SKILL_DIR/tools/collect.py" --repo owner/name --since 6m --out workdir/issue-map.json
   ```

   - `--repo` を省くと、今のディレクトリのリポジトリ（`gh repo view`）。
   - `--since` は更新日の下限。`YYYY-MM-DD`、`90d`、`12w`、`6m`、`1y`。既定 `6m`。
   - `--max-pages`（既定 200）はページ数の上限。超えたら警告して打ち切る。打ち切りの警告が出たら `--since` を短くする。
2. 描く。

   ```bash
   python3 "$SKILL_DIR/tools/render.py" --data workdir/issue-map.json --out workdir/issue-map.html
   ```

   ブランチ名に issue 番号を入れる規約があれば `--branch-re` で渡す（1 番目のグループが番号。既定 `^issue-(\d+)-`）。
   ページの JS が評価するので JavaScript の正規表現で書く（名前付きグループは `(?<n>…)`。`(?P<n>…)` や `(?i)` は使えない）。
   規約が無いリポジトリでも害はない（当たらないだけ）。
3. 出力した HTML の絶対パスを `file://` で示す。`$ARGUMENTS` に `owner/repo` や `--since` があればそのまま渡す。

## HTML の中身

- 「表」と「グラフ」のタブ。期間・状態・種類（issue / PR）・ラベル・検索の絞り込みは両方に効く。
  期間は閉じた日（開いているものは作成日）で判定する。更新日は持たない。
- 表の行は issue。開くと親子、blocked by / blocking、作業する PR とそのコミット、参照したコミット、言及元が出る。
  どの issue にも結びつかない PR は末尾にまとめる。
- グラフの辺の種類（チェックボックス。既定は order・impl・stack）:

  | kind | 意味 | 向き |
  |---|---|---|
  | order | blocked by（先に終わらせるもの） | 止める issue → 止められる issue |
  | impl | この PR がこの issue の作業をする | PR → issue |
  | stack | base が別の PR の head | 土台の PR → 上の PR |
  | share | 同じコミットを含む | 向きなし |
  | mention | 本文・コメント・コミットでの言及 | 言及元 → 先 |

  impl の由来（`src`）は 3 つで、線の濃さで分ける。api は GitHub が「この PR で閉じる」と認識したもの、
  text は PR 本文の `Closes #N` を正規表現で拾ったもの（base が main 以外の PR は api が空になるため）、
  name はブランチ名から推したもの。同じ 2 点に impl があれば mention を、直接の stack があれば share を描かない。
- ノードの形: issue は角丸、PR は角。色は状態（open 緑・merged 紫・closed 灰・not planned 斜線）。
  収集の範囲外の番号と別リポジトリは破線の枠。sub-issue の親子は枠（クラスタ）で、切り替えられる。
- 「PR を隠す」と、PR を通る辺を、その PR が作業する issue 同士に付け替える。
- 箱を押すと表の該当行へ移動する。↗ は GitHub を開く。

## データ（`collect.py` の出力）

取りに行かないと分からない事実だけを持つ。辺・逆向きの関係・子の一覧は HTML の JS が描画時に導く。

```json
{"v": 1, "repo": "owner/name", "at": "2026-10-04T00:30:00Z", "since": "2026-04-04",
 "i": {"81": {"t": "題名", "s": "closed", "r": "not_planned", "a": "login", "c": "2026-09-25", "d": "2026-09-26",
              "l": ["enhancement"], "p": 70, "b": [79, 80], "x": [87, "other/repo#12"], "rc": ["2b2ff41e00"]}},
 "p": {"176": {"t": "題名", "s": "open", "dr": true, "c": "2026-10-03", "h": "issue-152-sample-split",
               "bs": "issue-152-dedup-verify", "cm": ["9f0c1d2e3a"]},
       "147": {"t": "題名", "s": "merged", "c": "2026-09-30", "d": "2026-10-01", "h": "issue-143-dedup-auto",
               "bs": "main", "cl": [143], "kw": [143], "cm": ["c147a00000"], "mc": "892b0a4c1d"}},
 "cs": {"2b2ff41e00": ["2026-10-03", "login", "1 行目"]}}
```

`i` は issue、`p` は PR、`cs` はコミット（`[日付, 作者, 1 行目]`）。`t` 題名、`s` 状態、`r` 閉じた理由（not_planned / duplicate のときだけ）、
`dr` draft、`a` 作者、`c` / `d` 作成日 / 閉じた日（PR はマージ日）、`l` ラベル、`p` 親、`b` blocked by、`x` 言及元、
`rc` 本文で参照したコミット、`h` / `bs` head / base ブランチ、`cl` GitHub が認識した閉じる issue、`kw` 本文の `Closes #N`、
`cm` / `mc` PR のコミット / マージコミット。空の値はキーごと省く。

## 限界

- **期間外の issue への新しい言及は落ちる。** 言及は言及された側のタイムラインから取るが、言及されても相手の `updatedAt` は
  進まない（uehaj/sys1grep で、言及を受けた issue 76 件中 35 件は、最後の言及が `updatedAt` より後だった。2026-10-04 実測）。
  古い issue との結びつきを見たいときは `--since` を広げる。
- 親・blocked by・閉じる issue が別リポジトリにあるものは持たない（言及だけは `owner/repo#N` で持つ）。
- 範囲外の番号は番号だけで、題名は出ない。
- 差分取得とキャッシュは無い。毎回全部取り直す。
- 配置は最長経路の段組みで、辺は箱の上を通ることがある。数千件規模では期間か検索で絞って見る。
