---
name: sys1grep
description: 語ではなく意味で行を探す grep（sys1grep、Jev）。ログ・チケット・文書・ソース・git のコミットから「なぜ失敗したか」「顧客が怒っている問い合わせ」「API キーを読んでいる箇所」「〜を変えたコミット」のように、検索語が決まらない・言い換えや否定や多言語を含む・答えが数行に収まる問いで、Grep や全文読みの前に使う。Grep の当たりが多すぎるとき、0 のとき、大きなファイルを丸ごと読みそうなときにも使う。「〜から何が言えるか」「傾向は」「どういうことか」「まとめて」のように、当たった行を読んで解釈する問いには、行を自分で読む前に使う（`--summarize` で小さなモデルに読ませ、答えだけ受け取る）。実行したコマンドが失敗し、最後のエラーに原因が書かれていないときは、出力をパイプで渡して原因の仮説を意味で探す。識別子が分かっていれば -e '/RE/' -a "意味" で正規表現に意味を重ねる。 手で呼ぶなら /uehaj:sys1grep <意味> [対象] [オプション]。
---

# sys1grep: 意味で絞り、当たりだけ読む

- コマンドは `npx -y @uehaj/sys1grep@0.5.0-next.1`（以下 `sys1grep`）。PATH の `sys1grep` / 旧 `semgrep` は版が違いうる。
- キーは `SYS1GREP_API_KEY` か `~/.config/sys1grep/.env`。`./.env` は読まれない。未設定エラーは `sys1grep --help` 末尾の手順を示して止まる。
- 検索した行は TypeSafe（Jev）へ、`--summarize` では Anthropic（haiku）へも送られる。秘密や社外秘を含みそうな対象は、実行前にその旨を 1 行断る。
- マッチ後にどのみち全体を読むタスク（設計の把握、概要図）には使わない。
- `/uehaj:sys1grep` で呼ばれたときは `$ARGUMENTS` が意味・対象・オプション。`-` で始まる語と `-e/-a/-v` の式はそのまま渡す。

**1 回で終える。** 呼び出しの回数が費用を決める。1 回走らせ、その出力で答える。`--help` は読まない。当たった後に対象全体を開かない。

## 判断の順

1. **成果物**
   - 答えや解釈（理由、一覧、傾向、何が言えるか）: `--summarize`。自分のコンテキストに入るのは要約だけ。当たりが数十行でも要約に回す。
   - 場所や原文（開く・直す・行番号）: `-n`。前後は `-C 2`。有無・件数・ファイル名: `-q` / `-c` / `-l`。確率を見る: `-p`。
2. **対象**: ファイルを並べる。ディレクトリは `-r`（.git、鍵、生成物、.gitignore の対象は自動で除く）。`--include` / `--exclude`、
   `--changed-within=7d`。git の索引は `git sys1grep --cached`、コミットは `-g`。標準入力も読める（`cmd 2>&1 | sys1grep …`）。
   意味の中の「Python のファイル」「昨日」「未コミット」は自動で対象を絞る（stderr の `sys1grep: scope:` を見る）。
3. **単位**: 既定は行。複数行のレコードは `-z`、散文の文ごとは `--sentence`。
4. **式**
   - OR は `-e A -e B`、AND は `-e A -a B`、AND NOT は `-e A -v B`。`-a` / `-v` は直前の `-e` か `-Q` の後ろに置く。
   - `-Q "問い"` は問いに答えている行。`-e "…"` は「〜という記述」の行。意味は英語が最も安定。
   - **意味は行を絞るフィルタ。** 対象全体の解釈（何が言えるか、傾向は）を頼むときは、意味を付けず正規表現だけで対象を決める
     （`--summarize --dedup -e '/WARN/'`）。意味を足すと、それに合わない少数派の行が要約から消える。
   - **識別子・固定文字列は正規表現の項 `/RE/flags` に書き、同じ項に意味を重ねる**: `-e '/retry|backoff/i' -a "ネットワーク失敗の後で再試行している"`。
     正規表現はローカルで判定し、当たった行だけを送る。別の `-e` / `-Q` にすると OR になり、正規表現の無い項は対象全体を送る。
   - 厳しさ: `--level strict` / `loose`。
5. **費用**: 機械が吐くログは `--dedup`。`-r` で正規表現の無い項は先に `--dry-run`。1 ドルを超えそうなら止まる（通すなら `-y`）。
6. **実行と解釈**: Bash の timeout は 300000。終了コード 0 は当たり、1 は該当なし（繰り返しても同じ）、2 はエラー。
   混じるなら `--level strict`、空なら `--level loose` を 1 回だけ。それでも空なら、使った式と scope を添えて「該当なし」と報告する。

```sh
sys1grep -r -n --dedup -e '/ERROR|FATAL/' -a "a customer-facing request failed" logs/
sys1grep -n -C 2 -e "customer is asking for a refund" -v "the refund was already issued" tickets/*.txt
sys1grep -r --summarize --dedup -n -e '/WARN/' logs/                        # 全体から何が言えるか
sys1grep -r --summarize -n -Q "why did the nightly job fail" logs/          # 検索語が決まらない問い
sys1grep --summarize --summarize-prompt='3 行以内で共通する原因を' -e "the customer is angry" tickets/*.txt
sys1grep -g --summarize -Q "why was the retry logic changed"                # コミットの履歴
```

`--summarize` の注意: `-q` / `-l` / `-c` とは併用できない。200 KB を超える一致は終了コード 2（式を絞るか `--dedup`）。
裏取りを減らすなら `--summarize-prompt` で「各主張に該当行数と代表の行番号、最後に読んだ行数 N」を書かせる
（N が `-c` の総数より少なければ、意味で絞られている）。

## 失敗したコマンドの原因をログから探す

最後のエラーが症状だけ（「照合が合わない」「exit code 4」）で、WARN / ERROR が回復済みのノイズばかりなら、原因は印の付かない
INFO / DEBUG の 1 行にあることが多い。「なぜ失敗したか」と問うとノイズの ERROR しか当たらないので、**原因の仮説**を並べ、
**症状を添えて要約に選ばせる**。

```sh
cmd 2>&1 | sys1grep -n --dedup --level strict --summarize \
  --summarize-prompt='The job ended with: "<最後のエラー文>". Which of these lines could cause that? Name at most 3 candidates with line numbers and one reason each; say which is most likely. Ignore routine maintenance.' \
  -e "a component, writer, job or feature was paused, disabled, skipped or put on hold" \
  -e "a configuration, endpoint, region, credential or data source was changed or switched" \
  -e "an input, file or table was empty, missing, or had fewer records or columns than expected" \
  -e "a fallback or default value was used instead of the real one"
```

候補の行が決まったら、その前後だけを確かめる。
