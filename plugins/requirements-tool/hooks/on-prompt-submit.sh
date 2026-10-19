#!/usr/bin/env bash
# UserPromptSubmit フック。SR-8 の自己適用（CLAUDE.md「常時適用するプロセスルール」）を
# 促す固定の注意書きを additionalContext として毎回差し込む。
# JSON は Claude Code の UserPromptSubmit フック契約（hookSpecificOutput.additionalContext）に従う。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

# 対象プロジェクトの正本ルート（req-init が作る docs/requirements）の解決。
# - プラグイン導入時（CLAUDE_PLUGIN_ROOT 設定済み）: PROJECT_ROOT はプラグイン本体を指し、
#   そこには必ず docs/requirements があるため基準に使えない。CLAUDE_PROJECT_DIR、無ければ
#   実行時 cwd（$PWD）を対象プロジェクトとみなす。
# - このリポジトリ自身の直接運用（CLAUDE_PLUGIN_ROOT 未設定）: PROJECT_ROOT が正本を持つ。
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  TARGET_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
else
  TARGET_DIR="${CLAUDE_PROJECT_DIR:-$PROJECT_ROOT}"
fi

# SOL-10（うるささ制御・沈黙条件）: req-init 未実施（正本ルート不在）のプロジェクトでは
# 要求チェックを促す対象がないため注入しない。トークン消費を避けるための既定の沈黙条件。
if [ ! -d "$TARGET_DIR/docs/requirements" ]; then
  exit 0
fi

# SOL-10（うるささ制御・枠の最小実装）: プロジェクトデータ側の設定で本トリガの
# 有効/無効を切り替える。既定（ファイル・キーなし）は on。off 明記時のみ抑止する。
NOISE_CONF="$TARGET_DIR/docs/requirements/meta/noise-control.conf"
if [ -f "$NOISE_CONF" ] && grep -qE '^[[:space:]]*prompt_check[[:space:]]*=[[:space:]]*off[[:space:]]*$' "$NOISE_CONF"; then
  exit 0
fi

# プラグイン化対応（SR-26・ADR-004）: このリポジトリの直接運用（.claude/settings.json 経由、
# CLAUDE_PLUGIN_ROOT 未設定）では scripts/ は PROJECT_ROOT の隣にあり "scripts/req_lint.ts" が
# そのまま通る。他プロジェクトへプラグイン導入された場合（CLAUDE_PLUGIN_ROOT 設定済み）は
# scripts/ 本体はプラグイン側にあるため、案内するコマンドをそちらに向ける。
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  LINT_CMD="node \\\"\${CLAUDE_PLUGIN_ROOT}/scripts/req_lint.ts\\\""
else
  LINT_CMD="node scripts/req_lint.ts"
fi

# 注意: ここは通常のダブルクオート文字列（$'...' の ANSI-C クオートは使わない）。
# \n は実改行ではなく「バックスラッシュ + n」の2文字のまま JSON 文字列内に残り、
# JSON パーサ側で改行エスケープとして解釈される。
CONTEXT="[要求チェック] このプロンプトに要求・要件の追加/変更が混ざっていないか確認する（主語が人・組織なら要求、主語がシステムなら要件）。\n混在していたら: docs/requirements/ に ID 付き md を追記し meta/changelog.md の版を更新 → ${LINT_CMD} で検査。\n既存の要求・要件との矛盾とトレーサビリティの不足も検査し、検出・検査結果を応答の中で施主に報告する（黙って書き換えない）。"

printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$CONTEXT"

exit 0
