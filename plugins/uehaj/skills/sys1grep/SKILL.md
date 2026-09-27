---
name: sys1grep
description: ログ・チケット・文書・ソース・git のコミットから、語ではなく意味で行を探す grep（sys1grep、TypeSafe Jev）。「なぜ失敗したか」「顧客が怒っている問い合わせ」「API キーを読んでいる箇所」「〜を変えたコミット」のように、検索語が決まらない・言い換えや否定や多言語を含む・答えが数行に収まる問いで、Grep や全文読みの前に使う。対象を丸ごと読まずに済ませてトークンを節約するのが目的。識別子や固定文字列が分かっていても Grep に戻らず、`-e '/RE/' -a "meaning"` の正規表現項でローカルに絞ってから意味を重ねる。手で呼ぶなら /uehaj:sys1grep <意味> [対象] [オプション]。
---

# sys1grep — 意味で絞り、当たりだけ読む

対象をコンテキストに入れる前に、Jev（安い判定モデル）に行を絞らせ、既定では `--summarize` で haiku に要約まで
させる。自分のコンテキストに入るのは要約だけ。実測（git log 1,242 行、「なぜ ./.env を読まなくなったか」）:
直読み 33,152 トークン・$0.070、絞った 7 行 1,272 トークン・$0.005、答えは同じ。
節約はツール呼び出しの回数で決まる。1 回の呼び出しごとにコンテキスト全体を読み直すので、sys1grep は 1 回走らせて
その出力で答える。同じ検索を `head` / `tail` / `wc` で分けて走らせない。出力が長いのは式が緩いか `--summarize` の出番。

- コマンドは `npx -y @uehaj/sys1grep@0.5.0-next.0`（以下 `sys1grep`）。PATH の `sys1grep` / 旧 `semgrep` は版が違いうる。
- キーは `SYS1GREP_API_KEY` か `~/.config/sys1grep/.env`。`./.env` は読まれない。未設定エラーは `sys1grep --help` 末尾の手順を示して止まる。
- 検索した行は TypeSafe へ、`--summarize` では当たった行が Anthropic へも送られる。秘密や社外秘を含みそうな対象は、実行前にその旨を 1 行断る。
- 損益分岐は約 50 行。対象がそれ未満なら直読み。マッチ後にどのみち全体を読むタスク（設計の把握、概要図）には使わない。
- `/uehaj:sys1grep` で呼ばれたときは `$ARGUMENTS` が意味・対象・オプション。`-` で始まる語と `-e/-a/-v` の式はそのまま渡す。

## 手順

1. **成果物を決める。** 既定は `--summarize`。
   - 答え（理由、事実、「どれ」「挙げて」、一覧、要約）→ `--summarize -Q "question"`。`-Q` は「問いに答えている行」、
     `-e` は「〜という記述」。出力は要約だけで、行は自分のコンテキストに入らない。
   - 場所（ユーザーがその行を開く・直す、または行番号や原文を求めている）→ `-n`。前後が要るときだけ `-C 2`。
   - 有無・件数・ファイル名 → `-q` / `-c` / `-l`。
2. **対象を決める。** ディレクトリは `-r`（.git、node_modules、鍵、.gitignore 対象は自動で除外）。
   コミットは `-g`（1 コミット 1 レコード。`git log | …` のパイプは要らない。ファイル名は pathspec）。
   機械が吐くログは `--dedup`（ID・数値・時刻だけ違う行を 1 回で判定）。NUL 区切りのレコードは `-z`。
   JSONL のような巨大行は `jq` で 1 件 1 行にしてから。
3. **式を組む。** 意味は英語（精度が最も安定）。OR `-e A -e B`、AND `-e A -a B`、AND NOT `-e A -v B`。1 意味 1 条件。
   時期・言語や拡張子・置き場所・作者・git の状態は意味の中に書く（`-r`/`-g` の auto-scope が対象を先に絞る）。
   識別子・例外名・固定文字列が分かる部分は `-e '/RE/i' -a "meaning"` の正規表現項に書く。正規表現はローカルで
   判定してリクエストを出さず、当たった行だけに意味を尋ねるので、Grep で当ててから読むより送る行も読む行も減る。
   正規表現だけで足りるなら `-a` は要らない（リクエストなし、grep と同じ）。
4. **1 回実行し、判定する。** Bash の `timeout` は 300000 にする（`--summarize` は 10〜60 秒、ネストした Claude の中では
   さらに長い）。バックグラウンドに回されたら出力ファイルを待って読む。再実行は最大 1 回。意味に合わない行が混じる → `--level strict`。空 → `--level loose`、それでも空なら「該当なし」。
   stderr の `sys1grep: scope:` が意図と違う → `--no-auto-scope` か `--include` / `--changed-within` で明示。終了コード 2 は stderr をそのまま示す。
5. **読む・報告する。** 当たった後に対象全体を開かない（開けば節約はゼロ）。要約に日付・順序・原文が足りなければ
   同じ式を `-n` で 1 回走らせて当たり行を取り、足りない箇所は `sed -n 'A,Bp'` の行範囲だけ。
   報告は行（`file:line`、`-g` ならハッシュと件名）か要約をそのまま、使った式と効いた scope を 1 行。

```sh
sys1grep -g --summarize -Q "why is ./.env no longer read"
sys1grep -r -n --dedup -e '/ERROR|FATAL/' -a "a customer-facing request failed" logs/
sys1grep -r -n -e "the API key is read from a file, in the source code" .
sys1grep -n -C 2 -e "customer is asking for a refund" -v "the refund was already issued" tickets/*.txt
```

完了条件: 要約か `file:line` 付きの行が示され、対象全体を開いておらず、sys1grep の実行が 2 回以内。
または「該当なし」と式・閾値・scope が示されている。オプションはこの文書にあるもので足りる。
