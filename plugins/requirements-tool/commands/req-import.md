---
description: 指定したドキュメント（またはディレクトリ配下の群）を要求仕様の集合として正本にインポートする。実装詳細は SOL＋除外候補マーカーで取り込む
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(ls:*), Bash(find:*)
---

# req-import — ドキュメント群の正本への取り込み（SR-43・SOL-35）

施主が指定したドキュメント（md / html / txt 等。単体ファイルまたはディレクトリ）を読み、
要求・要件の言明を抽出して正本（`docs/requirements/`）へ**仮決めレコード**として追記する。
BR-5 のライフサイクル（外部文書のインポート → 読ませる → レビューで判断）の入口。
**施主の明示起動でのみ実行する**（正本への一括書き込みのため。ADR-009 の 4 面規約）。

取り込みは「走査（機械的）→ 判別（AI）→ 適用（機械的）」の3段。両端の機械的部分は
`req import`（`scripts/req_import.ts`）が担い、意味判断（本コマンド＝AI）が真ん中を担う。
両者は**計画 JSON** で受け渡す（req_init.ts と同型: CLI=機械的処理／コマンド=案内と判断）。

## 実行手順

1. **対象の確認と走査**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/req_import.ts" --scan <パス>
   --root "${CLAUDE_PROJECT_DIR}/docs/requirements" --out <一時JSON>` で対象文書を
   見出し単位に分割した目録（ファイル・見出し・原文抜粋・既存正本の由来との照合結果）を
   得る。ファイル数・セグメント数・既取り込み件数を施主に提示し、取り込み対象でよいか
   確認する。既存正本の現況（`req lint`・最大 ID）も確認する。
   あわせて**文書の地位**を施主に確認する:
   - **未承認の文書**（既定）→ 全件を仮決めで取り込む（手順 3-4 のとおり）
   - **承認済みの文書**（施主が「この文書は承認済み」と宣言した場合）→
     計画 JSON のトップレベルに `"approvedSource": true` と `"declaration": "<施主宣言の
     事実と日付>"` を書く。`req import --apply` がこれを見て `approval: agreed` /
     `confidence: confirmed` / `axes.review_required: false` で取り込み、declaration を
     「## 由来」に必記する。承認主体は施主の宣言であり（SOL-16 と整合）。ただし AI が
     付けた構造メタ（group・traces_to・parent）が AI の解釈であることは confidence_note
     に残る（`req import` が既定文で自動記載する）。実装詳細（除外候補）のマーカーは
     承認済みモードでも同様に付ける

2. **再取り込みの検査**: 手順1の `--scan` 出力の `alreadyImported`（ファイル単位・
   見出し単位）を確認する。既取り込みがあれば列挙して施主に提示し、続行/スキップ/
   上書き方針の指示を仰ぐ（上書きを強行する場合は手順4で `--force` を使う）。

3. **抽出と判別**: `--scan` の目録を読み、各セグメントから要求・要件の言明を抽出して
   判別する（本コマンドの意味判断。CLI は行わない）。
   - **主語規則**: 主語が組織＝BR ／ 人（利用者・関係者）＝SR ／ システム＝SOL
   - **詳細仕様・実装詳細**（アルゴリズム・画面項目定義・テーブル定義・ミドルウェア
     指定など、「何を満たすか」でなく「どう作るか」）は **SOL として取り込み**、
     計画 JSON のレコードに `"implementationDetail": true` を立てる（`req import --apply`
     が `axes.implementation_detail: true` と本文「## 位置づけ」への除外候補明記を行う）
   - 判別に迷うもの（主語が読み取れない等）は捨てず、最も近い kind で取り込んで
     `confidenceNote` に迷いの内容を書く

4. **計画 JSON の作成と適用**: 1 言明 = 1 レコードとして計画 JSON を書き、
   `req import --apply` で適用する。まず `--dry-run` で書き込み予定（ファイル名・ID・
   状態・スキップ理由）を施主に提示し、承認後に本適用する。

   計画 JSON のスキーマ:
   ```jsonc
   {
     "approvedSource": false,              // 承認済み文書モードなら true（手順1参照）
     "declaration": "施主宣言 2026-08-02: 本文書は承認済み",  // approvedSource=true のとき必須
     "records": [{
       "localId": "L1",                    // 任意。計画内の traces_to 相互参照に使う
       "kind": "stakeholder_requirement",  // business_requirement / stakeholder_requirement / solution_requirement / use_case
       "title": "…", "statement": "…", "rationale": "…",
       "traces_to": ["BR-5", "L2"],        // 既存の正本 ID または計画内 localId
       "parent": "SEC-6",                  // 省略時は kind から既定（BR→SEC-5, SR→SEC-6, SOL→SEC-10, U→SEC-12）
       "axes": { "group": "…", "phase": [2], "abstraction": "tactical", "category": "elicitation" },
       "implementationDetail": false,      // true なら実装詳細＝除外候補
       "confidenceNote": "…",              // 任意（省略時は req_import.ts が既定文を入れる）
       "source": { "path": "docs/foo.md", "heading": "3.2 検索", "lines": "120-138", "quote": "…" }
     }]
   }
   ```
   - `axes.group` は statement の意味から仮決め付与（SOL-27。既存の群名を再利用し
     乱立を避ける）
   - `traces_to` は取り込んだレコード間で AI が仮提案する（SOL→SR→BR、計画内は
     localId で相互参照できる）。遡り先が文書内に無い SOL は traces_to を空にせず、
     最も近い既存 SR か、無ければ「上位要求が文書に書かれていない」旨を本文に記録して
     施主に報告する
   - `source` には出所を必ず入れる: ソースファイルの相対パス（`--scan` 出力の path と
     同じ表記）＋見出し（または行範囲）＋原文の短い引用。`req import --apply` がこれを
     「## 由来」に記録する（外部文書へのトレーサビリティ・重複検査の両方に使われる）
   - 適用: `node "${CLAUDE_PLUGIN_ROOT}/scripts/req_import.ts" --apply <計画json>
     --root "${CLAUDE_PROJECT_DIR}/docs/requirements" --dry-run` → 施主確認 →
     `--dry-run` を外して本適用。1件でも検証エラーがあれば `req_import.ts` は何も
     書き込まずに終了するので、エラー内容を施主に示して計画 JSON を直してから再実行する
   - 計画 JSON に `verification` フィールドは無く、`req_import.ts` は取り込んだ
     全レコードに `verification: null` を書く（機械的な取り込み段では埋めない）。
     取り込んだ SOL（`solution_requirement`）の verification は、手順5の検査時に
     具体的で・可能なら数値（閾値・件数・時間等）を用いて合否を判定できる形に
     人手/AI で埋める（SR-48/SOL-40）。「〜できること」だけで判定条件を欠く
     曖昧な記述は差し戻す/指摘する。本質的に数値化できない SOL は、数値でなくとも
     「何をもって満たされたとするか」が判定可能な形であればよい。SR・BR には
     この条件を課さない（3階層の非対称性）

5. **検査と報告**: `req lint`（`node "${CLAUDE_PLUGIN_ROOT}/scripts/req_lint.ts" --root
   "${CLAUDE_PROJECT_DIR}/docs/requirements"`）を通し、既存レコードとの**矛盾**
   （同じ事項の相反する言明）と**不足**（カバーされない要求・遡れない要件）を検査する。
   取り込んだ SOL は verification が null のまま（手順4の注記）なので、`req_lint.ts`
   の SOL-40 必須検査（`solution_requirement の verification が空です`）が新規 SOL
   ごとに違反として出る。これは想定どおりの結果であり、各 SOL の verification を
   具体的な記述で埋めてから再度 `req lint` を通し、この違反が消えたことを確認する
   （手順4の注記を参照。「〜できること」だけの曖昧な記述で埋めて済ませない）。
   `meta/changelog.md` に版として記録し、ビューを再生成する。施主に次を報告する:
   - 取り込み件数（BR/SR/SOL 別、うち実装詳細＝除外候補の件数。`req_import.ts` の
     サマリ出力に含まれる）
   - 矛盾・不足の検査結果（矛盾は握りつぶさず裁定を仰ぐ）
   - 判別に迷ったレコードの一覧
   - **次の一手**: 通読レビュー（`/req-review` → /guided）で取り込み結果を網羅レビューに
     確認・裁定できること

## 注意

- 取り込みは追記のみ。既存レコードの変更・削除はしない
- 原文の意味を変えない・要求を捏造しない・状態を勝手に確定させない（すべて candidate。
  承認済み文書モードでも構造メタは confidence_note で仮決めと明示する）
- 大量（目安 50 言明超）になりそうなら、先に件数と分割方針を施主に相談してから進める
