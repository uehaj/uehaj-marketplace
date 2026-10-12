# requirements-tool

ライトウェイトな要求工学ツール。要求・要件を **1 件 1 md（＋YAML frontmatter）** の
正本として管理し、暗黙の要求検出（プロンプトからの自動抽出）・決定的な検査/生成 CLI・
静的 HTML ビュー・ブラウザ上でのレビュー（判定・コメント・追加質問の正本への書き戻し）を
提供する。

このディレクトリは Claude Code プラグインの本体（`skills/` `hooks/` `commands/` `scripts/`
`templates/` `bin/`）。利用者のプロジェクトの正本（`docs/requirements/`）は含まない。

## 本体とプロジェクト固有データの分離

| 区分 | 内容 | アップデート |
|---|---|---|
| **本体**（プラグインに含む） | `bin/`（req.ts）、`scripts/`（reqlib.ts, req_lint.ts, req_tree.ts, req_guided.ts, req_document.ts, req_bundle.ts, req_fragment.ts, req_review_serve.ts, req_init.ts, req_import.ts）、`templates/`（必須アウトプットカタログ）、`skills/`、`hooks/`、`commands/` | 対象。プラグイン更新で書き換わる |
| **プロジェクト固有データ**（プラグインに含まない） | 各プロジェクトの `docs/requirements/`（正本）、`docs/generated/`（生成物）、CLAUDE.md、worklog/ | 対象外。アップデートで一切触れない |

この分離線が、アップデートで正本が壊れないことの構造的な保証になる。
プラグイン本体のファイル群は対象プロジェクトの `docs/requirements/` に一切書き込まない
（書き込むのは `commands/req-init.md` が明示的に呼ぶ `req_init.ts` のみで、これも
既存 ID をスキップする冪等な一方向の橋渡し）。

## インストール

```bash
claude plugin marketplace add uehaj/uehaj-marketplace
claude plugin install requirements-tool@uehaj-marketplace
```

導入先のプロジェクトでは、続けて「[インストール後にやること](#インストール後にやること)」の
`/req-init` を実行する。

ローカルで試すだけなら、このディレクトリを指定してセッション限りで読み込める。

```bash
claude --plugin-dir /path/to/uehaj-marketplace/plugins/requirements-tool
```

### アップデート

```bash
claude plugin update requirements-tool
```

`scripts/` `templates/` `skills/` `hooks/` `commands/`（本体）だけが更新される。対象
プロジェクトの `docs/requirements/`（正本）は分離されているため、アップデートで
書き換わらない（上表）。

## インストール後にやること

### 1. 正本の初期化

```
/req-init
```

`docs/requirements/` を作成し、必須アウトプットカタログ（MO-1..9）を未決レコードとして
投入する（`templates/mandatory-outputs/`、SR-25）。既存の正本がある場合は既存 ID を
スキップする冪等な操作。

### 2. CLAUDE.md への追記（プラグインが配れない部分）

Claude Code のプラグインは CLAUDE.md を配布できない。常時プロセスルール（SR-8: 通常の
プロンプトから要求・要件の追加/変更を暗黙に検出する）は `skills/requirements-loop/` と
`hooks/hooks.json`（UserPromptSubmit で注意書きを注入）で大部分を補っているが、
プロジェクト固有の運用として明文化したい場合は、対象プロジェクトの CLAUDE.md に次の
断片を追記することを推奨する。

```markdown
## 常時適用するプロセスルール（SR-8 の自己適用）

施主のプロンプト（指示）に要求の追加・変更が混ざっていたら、明示的な宣言が
なくても検出し、次を行うこと:

1. 要求か要件かを判別する（主語が人・組織＝要求、主語がシステム＝要件）。
2. `docs/requirements/` に ID を振った md として追記し、`meta/changelog.md`（存在する
   場合）の版と変更履歴を更新する。
3. 既存の要求・要件との矛盾を検査する。矛盾があれば握りつぶさず提示し、裁定を仰ぐ。
4. 不足（トレーサビリティの穴）を検査する。
5. 検出・検査結果を応答の中で報告する（黙って書き換えない）。

詳細な手順は requirements-tool プラグインの `skills/requirements-loop/SKILL.md` を参照。
```

## 提供するもの

- **`skills/requirements-loop/`** — SR-8 の自己適用（暗黙の要求検出→追記→矛盾検査→
  不足検査→報告）の手順。CLAUDE.md を配れない制約をスキルとフックで補う。
- **`skills/req-review/`** — 正本のレビュー開始。一時ローカル HTTP サーバ
  （`req_review_serve.ts`）を立て、3 ビュー（ツリー＝自由巡回／ガイド付きレビュー＝
  網羅レビューの通読／要件定義書＝文書体裁）を共通トップバーで行き来しながら、判定・コメント・
  追加質問をその場で正本へ書き戻す。レビュー完了でサーバは終了する。
- **`commands/req-init.md`** — `/req-init`。正本の初期化・必須アウトプットカタログの投入。
- **`hooks/hooks.json`** — `UserPromptSubmit`（要求チェックの注意書きを注入）。
  `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` で本体とプロジェクトのパスを解決する。
- **`scripts/`** — 決定的な検査・生成 CLI。Node 23.6+ の型剥がしで直接実行、外部依存ゼロ。
  `--root` / `--out` を明示すればプラグイン導入先でも、このリポジトリでの直接実行
  （`node scripts/req_lint.ts`、統一 CLI なら `node bin/req.ts lint`）でも同じスクリプトが
  動く。生成系サブコマンドは `req gen` 1つに一本化されている（旧 view/spec/guided/
  document/bundle は廃止。個別ビューの HTML は生成しない）。
  - `req_lint.ts` — 正本の検査（構文・状態不変条件・トレーサビリティのカバレッジ）
  - `req_bundle.ts` — バンドル（文書・ツリー・通読レビューの3ビューを1枚に束ねた単一
    HTML）の生成。`req gen` の実体
  - `req_tree.ts` / `req_guided.ts` / `req_document.ts` — バンドルを構成する各ビュー本体
    （ツリー・ガイド付きレビュー・文書体裁）。レビューサーバもこれらを直接呼ぶ
  - `req_review_serve.ts` — 一時レビューサーバ（上記 3 ビューの配信と正本への書き戻し）
  - `req_init.ts` — 正本の初期化
  - `req_import.ts` — 外部文書の走査・取り込み

生成ビューはいずれも正本からの一方向・決定的生成（同一入力→バイト同一）で、同じ HTML が
サーバ配信ではレビュー UI 有効、`file://` では読み取り専用として振る舞う（二態規約）。

## 文書ビューの本文（narrative.html）の生成方法

3 ビューのうち**文書ビューの本文だけは正本から自動生成されない**。本文は AI が執筆する
読み物（ナラティブ）で、本文フラグメント `docs/requirements/meta/narrative.html` として
保存する。器（目次・フロート目次・参照様式・ホバーバルーン）は
`scripts/req_document.ts` が決定的に付ける。

```bash
# 1. 本文を執筆する（Claude Code のスキル。正本は書き換えない）
/req-narrate

# 2. ビューを再生成して本文を合成する
./bin/req gen        # または node bin/req.ts gen
```

フラグメントが無い場合、**レコード忠実表示へのフォールバックは行わない**（施主裁定
2026-08-05。フォールバックがあると本文が未執筆でも「読める体裁の何か」が出てしまい、
未生成であることに気づけないため）。文書ビューの本文の位置に上記の生成方法を示す案内
パネルが出る。バンドルの生成自体は止まらないので、ツリービューと通読レビューは本文の
有無に関係なく使える。

フラグメントの契約:

- 置き場所は `docs/requirements/meta/narrative.html`（1 ファイル）
- 中身は `<body>` 内相当の HTML 断片。`<html>` / `<head>` は含めない
- 章立ては `<h2>` / `<h3>`（目次とフロート目次はこの見出しを走査して作られる）
- 正本レコードへの参照は `data-req-link="BR-1"` の属性で示す（ホバーバルーンで解決）
- 先頭に `<!-- narrative: 2026-08-05 v0.2 -->` の形で生成時点を書くと、正本の版と
  並記されドリフトが見える
- `<script>` 等の契約違反タグは生成時に除去され、警告コメントが HTML に残る

## 検証コマンド

```bash
# プラグイン構造の検証
claude plugin validate plugins/requirements-tool --strict

# 正本の検査（対象プロジェクトの docs/requirements を指す）
node scripts/req_lint.ts --root docs/requirements
```

## ライセンス・作者

MIT。Junji UEHARA（[uehaj](https://github.com/uehaj)）。
