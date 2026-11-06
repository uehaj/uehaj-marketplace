---
description: 対象プロジェクトに要求工学ツールの正本ディレクトリを初期化し、必須アウトプットカタログ（MO）を投入する
allowed-tools: Bash(node:*), Bash(mkdir:*), Read
---

# req-init — 正本の初期化（SR-25・SR-26）

このプラグイン（requirements-tool）を対象プロジェクトへ導入した直後に実行する。
プラグイン本体（`scripts/` `templates/`）とプロジェクト固有の正本（`docs/requirements/`）
は分離されており、正本は各プロジェクト側に作る必要がある（ADR-004・SR-26）。

## 実行手順

1. 正本ディレクトリが対象プロジェクトに存在するか確認する。

   ```bash
   test -d "${CLAUDE_PROJECT_DIR}/docs/requirements" && echo "EXISTS" || echo "MISSING"
   ```

2. 存在しない場合は作成する。

   ```bash
   mkdir -p "${CLAUDE_PROJECT_DIR}/docs/requirements/meta"
   mkdir -p "${CLAUDE_PROJECT_DIR}/docs/generated"
   ```

3. 必須アウトプットカタログ（`templates/mandatory-outputs/`）を投入する。冪等な操作
   なので、既に投入済みの ID はスキップされる。

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/req_init.ts" \
     --catalog "${CLAUDE_PLUGIN_ROOT}/templates/mandatory-outputs" \
     --root "${CLAUDE_PROJECT_DIR}/docs/requirements"
   ```

4. 投入結果を検査する。

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/req_lint.ts" --root "${CLAUDE_PROJECT_DIR}/docs/requirements"
   ```

5. **統一 CLI の使い方を案内する（案内のみ。PATH への導入は行わない）**。
   `req` ディスパッチャは `bin/` にあるだけでよく、次の形で呼べることを伝える:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/req" <サブコマンド> [引数...]     # macOS / Linux
   # 例: "${CLAUDE_PLUGIN_ROOT}/bin/req" lint
   # サブコマンド: view(tree) / spec / guided / document / lint / init / serve
   ```

   Windows（PowerShell）では:

   ```powershell
   & "$env:CLAUDE_PLUGIN_ROOT\bin\req.ps1" <サブコマンド> [引数...]
   ```

   PATH に入れたい利用者は、自分のシェル設定で `bin/` を PATH に足すか、任意の場所へ
   シンボリックリンクを張ればよい（例: `ln -s "${CLAUDE_PLUGIN_ROOT}/bin/req" ~/.local/bin/req`）。
   これはツールの手順ではなく利用者自身の判断・操作とする。

6. **対象プロジェクトの `bin/` に委譲ラッパを生成する（毎回実行する冪等ステップ）**
   （ADR-009 v1.2）。プロジェクト自身が `bin/req` という入口を持ち、プラグインの場所を
   知らなくても呼べるようにする。**実体はコピーしない**（委譲のみ。プラグイン更新から
   乖離しないため）。再実行時もこのステップは省略しない:

   - `bin/req` が**無い** → 下記で生成し、生成した内容を施主に報告する。
   - `bin/req` が**あり内容が同一** → 何もせず「既に導入済み」と報告する。
   - `bin/req` が**あり内容が異なる** → 上書きせず差分を施主に提示して指示を仰ぐ。

   ```bash
   mkdir -p "${CLAUDE_PROJECT_DIR}/bin"
   cat > "${CLAUDE_PROJECT_DIR}/bin/req" <<WRAP
   #!/bin/sh
   # requirements-tool への委譲ラッパ（req-init が生成。ADR-009 v1.2）
   exec node "${CLAUDE_PLUGIN_ROOT}/bin/req.ts" "\$@"
   WRAP
   node -e "require('fs').chmodSync('${CLAUDE_PROJECT_DIR}/bin/req', 0o755)"
   ```

   Windows 併用プロジェクトでは同様に `bin/req.ps1`（`& node "<プラグインroot>\bin\req.ts" @args` ＋
   `exit $LASTEXITCODE` の 2 行）も生成する。グローバル環境（PATH・ホーム配下）には一切
   触れない。

7. **対象プロジェクトの CLAUDE.md に SR-8 断片が追記済みか確認する（毎回実行する冪等
   ステップ）**。プラグインは CLAUDE.md を配布できないため、常時プロセスルールの断片
   （`README.md` の「CLAUDE.md への追記」節にある
   「## 常時適用するプロセスルール（SR-8 の自己適用）」ブロック）が対象プロジェクトの
   CLAUDE.md に必要になる。

   ```bash
   grep -q "常時適用するプロセスルール（SR-8 の自己適用）" "${CLAUDE_PROJECT_DIR}/CLAUDE.md" 2>/dev/null \
     && echo "PRESENT" || echo "ABSENT"
   ```

   - `PRESENT` → 何もせず「追記済み」と報告する。
   - `ABSENT`（CLAUDE.md 自体が無い場合を含む） → `README.md` の断片を CLAUDE.md 末尾に
     追記（無ければ新規作成）し、追記した内容を施主に報告する。

8. 施主に次を報告する。

   - 投入した MO 件数・スキップした件数（既存 ID があった場合）
   - lint の結果（問題があれば内容）
   - 各 MO は `approval=candidate` / `confidence=undecided` の未決レコードとして
     入る。プロジェクトに該当しない項目は削除せず `approval=rejected` にする運用
     （`templates/mandatory-outputs/README.md` 参照）であることを伝える
   - `bin/req`（手順 6）と CLAUDE.md 断片（手順 7）の検査結果（生成した／追記した／
     既に導入済み）

## 前提

- 既に `docs/requirements/` に正本がある対象プロジェクトへの再実行は安全（冪等）。
  既存 ID のファイルは上書きされない。MO 投入はスキップされても、手順 6（bin ラッパ）と
  手順 7（CLAUDE.md 断片）の検査・生成は毎回行われる — 「無ければ作る・あれば何もしない」。
- `CLAUDE_PROJECT_DIR` と `CLAUDE_PLUGIN_ROOT` はプラグイン実行時に Claude Code が
  自動的に設定する環境変数。このリポジトリ自身（requirements-tool のセルフホスティング
  先）で直接使う場合は両者ともカレントディレクトリ相当になる。
