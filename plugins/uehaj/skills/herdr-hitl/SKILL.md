---
name: herdr-hitl
description: 対話入力が要るコマンド（rm -i、git commit -p / rebase -i / add -p、ssh のパスワード、対話インストーラ、REPL）を herdr の別ペインで script 記録つきで起動し、人間に答えさせてから結果を取り込む。Bash ツールでは対話入力を扱えないので、y/n やエディタ操作が発生するコマンドはこのスキルで人間に渡す。HERDR_ENV=1 のときだけ使える。
---

# herdr-hitl — 人間に入力させる対話コマンド

`HERDR_ENV` が `1` でなければ herdr の外なので使えない。その旨を言って止まる。

`script` は擬似端末を挟んで入出力を記録するだけなので、人間がペインで打った文字はそのまま
中のプログラムに届き、ログにも残る。Claude は起動と回収だけを担い、答えは人間が打つ。

## 手順

以下の `$SKILL_DIR` は、このスキル読み込み時に示される "Base directory for this skill" のパス。

1. 起動。ペインを右に分割し、`script` で包んで実行し、フォーカスを人間側に渡す。

   ```bash
   bash "$SKILL_DIR/hitl.sh" start --prompt 'remove .*\?' -- rm -i junk.txt
   # → PANE=w7W:p7 LOG=/…/workdir/hitl-20260927-2030.log
   ```

   `--prompt` は「入力待ちになった」と判断する正規表現。エディタが開く `rebase -i` のように
   目印が無いときは省略する。

2. 終了を待つ。Bash ツールを `run_in_background: true` で呼ぶと、人間が答えた瞬間に
   コマンドが終了し、Claude が自動で再開される。人間に「終わったら教えて」と頼む必要はない。

   ```bash
   bash "$SKILL_DIR/hitl.sh" wait w7W:p7 "$LOG"
   # 終了時の出力:
   # EXIT=0
   # --- log ---
   # remove junk.txt? y
   ```

3. **ターンを終える。** 「右ペインで `y/n` を打ってください」とだけ言う。
   `send-keys` で代わりに答えない。パスワードや削除・force push の最終確認は特に。

4. 再開したら、`wait` の出力（exit code と人間の入力込みの全記録）を読んで続行し、
   `herdr pane close w7W:p7` で閉じる。

   途中で様子を見たいときは `hitl.sh status <pane>`（`running` / `done`）と
   `herdr pane read <pane> --source visible --lines 20`。

## 知っておくこと

- `script` のログはプロセス終了時にまとめて書かれることがある。途中経過は `pane read` で見る。
- ペイン ID は閉じると詰め替わる。`start` の出力を使い、古い ID を使い回さない。
- 人間が Claude 側のペインで文字を打つとフォーカスが戻る。`start` はそのたびに右へ渡し直すので、
  人間が「打てない」と言ったら `herdr pane focus --pane <自分> --direction right`。
- `wait-output` は `--match`（部分一致）と `--regex` が排他。
- 対話が不要なコマンドはこのスキルの対象外。普通に Bash ツールで実行する。
