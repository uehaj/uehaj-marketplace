# ワーカーセッションの開き方

Claude Code 2.1.289 の `claude --help`、`claude agents --help`、SendMessage のツール説明、herdr のヘルプで確かめた。
「未確認」はこのスキルを書く時点で試していないもの。セッションを実際に開く試験はしていない。

## herdr の中（`HERDR_ENV=1`）

ペインを分け、Claude を名前付きで起動し、プロンプトを送る。手順の詳細は herdr スキルに従う。

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus   # .result.pane.pane_id を取る
herdr agent start worker-1 --kind claude --pane <pane_id> -- -n worker-1 --permission-mode <コーディネーターと同じ>
herdr agent prompt worker-1 "<ワーカー用プロンプト>" --wait --timeout 120000
```

- herdr の名前は `[a-z][a-z0-9_-]{0,31}` で、生きているエージェントの中で一意。
- `-- -n worker-1 --permission-mode …` で Claude 側のセッション名と mode も揃える（`--` の後は Claude にそのまま渡る。
  Claude 側の名前が ListAgents にそのまま出るかは未確認）。
- ワーカーが質問 UI で止まると herdr の状態が `blocked` になる。`herdr agent read` で見て、答えはユーザーに聞く。

## バックグラウンドセッション（`claude --bg`）

```bash
claude --bg -n worker-1 --permission-mode <コーディネーターと同じ> "<ワーカー用プロンプト>"
claude agents --json     # id, name, cwd, kind, state, sessionId, startedAt
claude logs <id>         # 直近の端末出力。TTY 不要なのでツールから使える
```

- `claude attach <id>` は端末で開いて操作する（TTY が要るので、ツールからでなくユーザーに使ってもらう）。
  stop / rm / respawn もある。
- `-w, --worktree [name]` を付けると git worktree を作ってそこで動く。
- バックグラウンドでは、質問が出ても誰も気づかず止まる（`claude agents --json` の `state` が `blocked`）。
  ワーカー用プロンプトの「質問しない」の段を必ず入れる。
- ネットワークやプロキシを切り替えた後は、バックグラウンドのセッションが古い設定のまま API に届かないことがある。
  `claude agents` で状態を見る。
- `--bg` と `-n` と位置引数のプロンプトを同時に渡す形は、ヘルプ上は成り立つが未確認。

## `/fork`

`/fork [prompt]` は今の会話をまるごと複製した新しいバックグラウンドセッションを作る（2.1.289 の組み込みコマンド）。
コーディネーターの文脈を全部持ち込むので、ワーカーの既定にはしない。経緯を知っている必要がある 1 件の作業を
切り出すときに使う。複製先の名前は、`claude agents --json` の一覧では `<親の名前> ⑂ <プロンプトの先頭>` の形で出ている
（一覧からの推定で、/fork を実行して確かめてはいない）。

## ユーザーに開いてもらう

最も確実。ユーザーに次を頼む。

```
別の端末で、このリポジトリのディレクトリから
  claude -n worker-1
を起動し、次のプロンプトを貼ってください。（プロンプト）
```

## 宛先

- **待機中のセッションが受信で目覚めるか。** SendMessage の説明は「受け手の次のツールラウンドで取り出される」
  とだけ言い、idle のセッションが受信で新しいターンを始めるとは書いていない。運用では、idle のセッションに送った
  メッセージで受け手が新しいターンを始めて返信したのを複数回観察した（Claude Code 2.1.289、2026-10-04。
  docs で保証された挙動ではない）。このスキルはこれに依存する。ワーカーが長く沈黙したら、ユーザーに
  そのセッションへ一言入れてもらう。
- `-n` を付けずに起動したセッションの名前は cwd のディレクトリ名になる（`claude agents --json` で確認）。
  同じチェックアウトで複数のセッションが動くと同名になるので、コーディネーターもワーカーも `-n` で名前を付ける。

- SendMessage の宛先は ListAgents の行頭の `name [ref]`。名前が一意なら名前だけでよく、同名が居るときだけ `[ref]` を付ける。
  `[ref]` は直前の ListAgents かエラーに出たものだけが通る。
- `uds:<socket>` / `bridge:<session id>` の形の宛先は、2.1.289 ではセッション間のファイル送信の説明に明記されている。
  SendMessage の説明には無いが、`uds:/tmp/cc-socks/<pid>.sock` で宛てて届いた運用実績がある。名前が曖昧で `[ref]` も
  通らないときの最後の手段にする。ソケットのディレクトリは `/tmp/cc-socks` または `/tmp/cc-socks-<N>` のことがある。
- ListAgents のパラメータは、このスキルを書いた環境では読み込めず未確認。SendMessage の説明によれば、
  一覧に出るピアは生きていて、行に busy / idle が出る。
- `claude agents` の一覧画面からセッションを起動する機能（`--model` などの「dispatched sessions」の既定値がある）は未確認。
