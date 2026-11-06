#!/usr/bin/env node
/**
 * req_guided.ts — docs/requirements/ 正本から「ガイド付き通読レビュービュー」を
 * 一方向生成する（SR-34 / ADR-008 / SOL-28）。
 *
 * プレゼンテーション型 HTML（1画面1スライド、横送り）を生成する。表紙・目次・
 * 章節（SEC）ごとのスライドで構成し、各節スライドにはその節を parent とするレコード
 * （SEC 以外）のカードと「どうしますか？」確認 UI（承認/却下/保留・コメント・
 * AIへの追加質問）を並べる。確認の入力は一時サーバ配信時（req_review_serve.ts の
 * GET /guided）のみ有効化し、scripts/reqlib.ts の applyReviewActions（SOL-26）へ
 * POST /review で書き戻す。file:// 単体閲覧時は読み取り専用（SOL-25 と同じ二態）。
 *
 * 生成は決定的（同一入力 → バイト同一の出力）。タイムスタンプ・乱数は埋め込まない。
 *
 * 流用（二重実装を避ける。SR-24）: 種別ラベル・種別定義（KIND_LABEL /
 * KIND_COLLAPSED_LABEL / kindDefinition / kindTitleAttr）、XSS 対策込みの Markdown
 * 簡易レンダラ（renderInlineMarkdown / renderBodyMarkdown。SAFE_LINK_SCHEME による
 * href スキーム許可リスト検査を含む）、axes.group によるサブセクション分け
 * （groupByAxesGroup / UNGROUPED_LABEL）、要レビューバッジ（isReviewRequired /
 * reviewBadgeHtml）、木構造コンテキスト（TreeContext / buildContext）、章の並び順
 * （compareRoots）は scripts/req_tree.ts から import して再利用する（同ロジックの
 * 二重実装を避けるため、req_tree.ts 側にも export を追加したのみで、req_tree.ts の
 * ロジック自体は変更していない）。
 * ただし CSS・JS 本体（プレゼンテーション UI・スライド送り・進捗管理）は req_tree.ts の
 * ボード型 UI と要件が異なるため独自に実装する。レビュー操作の action JSON 形式
 * （{ reviewer, items: [{ id, verdict, comment, questions }] }）と、記名の localStorage
 * キー（reqtree:reviewerName。ツリービューと共有）は req_tree.ts の実装と同じ様式に揃える。
 *
 * 章節（SEC）の文書順への平坦化: SEC は入れ子（parent が別の SEC）になり得るため、
 * ルート SEC（parent: null）を compareRoots 順に並べたうえで、各 SEC の直下の子のうち
 * kind が document_section のものを同じ順序基準で再帰的に辿る（深さ優先・行きがけ順）。
 * サイクル（正本の不整合）が万一あっても無限ループしないよう訪問済み集合で防御する。
 *
 * 順序モードの名称（施主指示 2026-08-11、別セッション経由）: 表示名を「節順」から「網羅レビュー」へ
 * 改名した。ユースケースレビューと対になる名前にする意図。内部の識別子（data-order-mode・
 * currentMode・data-mode の 'section'）と保存済みの localStorage 値は変えていない——表示名の
 * 変更であり、生成物の構造や保存値まで動かす必要がないため。v0.143 以前の changelog・
 * meta/reviews に残る「節順」は当時の記録としてそのまま残す。
 *
 * 順序モード・ステッパー（SOL-41 / SR-49。2026-08-11 改訂）: 既定の「網羅レビュー」（上記の平坦化）に
 * 加え、「ユースケースレビュー」を持つ。両デッキのスライドは同じ `.slides` コンテナに同居し、
 * `data-mode` 属性で識別する（決定性を最優先し、表示切替は実行時 JS の display トグルのみで
 * 行う。ADR-013 のバンドル display 切替と同じ考え方）。別視点のカードは review-box を持たない
 * （二重実装しない方針。renderRecordCard の canonical なカードへ gotoCanonicalRecord で
 * ジャンプする）。ステッパー（renderStepper）は両デッキの全スライド分を生成時にドットとして
 * 焼き込み、実行時 JS（refreshStepper）が現在のモードのものだけを表示し現在位置・確認済み
 * （reqguided:progress の汎用キー）を反映する。
 *
 * 廃止したモード「ストーリーレビュー」（施主指示 2026-08-11「ストーリーレビューを削除して」）:
 * BR 起点の依存の縦筋を AI 執筆の `meta/stories.json` から組み立てるモードを持っていたが、
 * 実測でユースケースレビューがその範囲をほぼ包含していた（ストーリーが触れる 75 件のうち
 * 68 件が重複。固有は BR 7 件と 31 版古い語りだけ）ため、モード・定義ファイル・執筆スキルを
 * まとめて退役させた（SOL-41 改訂 / SOL-42 廃止）。選択画面・別視点カードの器はユースケース
 * レビューが引き継いで使う（クラス名・DOM id は歴史的な `story-` の名前のまま）。
 *
 * レコードカードの生値チップ撤去（SOL-41 statement 追記／施主指摘 2026-08-07）: state 5軸
 * チップ・axes チップは出さない（管理メタデータはバルーンとツリービューのモーダルで見る）。
 * カードに残すのは種別バッジ・要レビューバッジ・所属バッジ（ユースケース）と、
 * state.confidence === "provisional" のときの「仮決め」／state.approval === "candidate" の
 * ときの「候補」の一語バッジ（provisionalBadgeHtml / candidateApprovalBadgeHtml。「なぜ判定
 * するか」の最小信号は保つ）。ツリービュー・文書ビューのチップ表示は変更しない。
 *
 * もう 1 つの順序モード「ユースケースレビュー」（SOL-46 / SR-51）: 網羅レビューと並列の
 * `data-mode="usecase"` デッキ。AI 執筆の定義ファイルを持たず、正本（use_case レコードの
 * 本文と traces_to）だけから決定的に導出する（鮮度の問題が構造的に起きない——これが
 * ストーリーレビューを退役させ、こちらを残した理由）。デッキ構成: 選択スライド（U 一覧）→ 各 U の導入スライド（U 本文を
 * renderBodyMarkdown で描画）→ U 自身の裁定ステップ（records=[U]）→ traces_to のうち
 * stakeholder_requirement の ID ごとに1ステップ（宣言順。records=[その SR, その SR に
 * traces_to で遡及する solution_requirement を compareIds 順で列挙]）。ステップの語りは器の
 * 定型文（AI が実行時に生成するものではない）。裁定 UI は二重実装せず
 * renderRefRecordCard／gotoCanonicalRecord を再利用する（buildUseCaseDeck /
 * renderUseCaseSelectSlide / renderUseCaseIntroSlide / renderUseCaseStepSlide）。U が1件も無い
 * 正本では選択スライドに /req-usecase への案内バナーを出す（stories.json 未作成時のバナーと
 * 同じ様式）。
 *
 * 確認チェックボックス＋右サイドバー（SOL-50 / SR-59。単一状態モデル）: 判定 UI の「承認」を
 * 「確認」チェックボックスに置き換える（renderConfirmCheckbox）。チェック＝承認であり、
 * 既存の approve verdict（reqlib.ts applyReviewActions）をそのまま使って
 * state.approval: agreed・state.confidence: confirmed・axes.review_required: false を同時に
 * 書き戻す（二重実装しない）。チェック解除は新設した unconfirm verdict で
 * approval: candidate・review_required: true に戻し、取り消しの記録を meta/reviews/ に残す。
 * この確認チェックは review-box（却下/保留/コメント/追加質問。従来どおり残す）とは別の要素に
 * する——SOL-37 の下書き（オフライン）モードは `.review-box` 配下の input を一括で再有効化する
 * ため、確認チェックをその外に置くことで下書き verdict 語彙を変えずに済む。節（SEC）レコードの
 * スライドにも同じチェックを追加する（節一括確認は維持し、書き戻しは同じ状態セット）。
 * 右サイドバー（renderSidebar / buildSidebarEntries）は網羅レビューのデッキの全レコード（SEC 含む）を
 * 文書順に一覧し、チェック状態は生成時点の正本（isConfirmed）から導出、行クリックは
 * gotoCanonicalRecord で該当スライドへ移動する。書き戻しの入口はカード上の確認チェックボックス
 * 1箇所に限り、サイドバー自体は表示＋ナビゲーションのみ（二重実装しない）。
 * ユースケースレビュー中は、いま見ている範囲に含まれるレコードだけを
 * 残す（施主裁定 2026-08-10。UX イシュー 05。当初は「書き戻しの入口が網羅レビューにしかないので
 * サイドバーも網羅レビューを映すのが一貫する」として追従させない実装だったが、施主が正本全体の
 * 確認状況が一時的に見えなくなることを承知のうえで範囲限定を選んだ）。絞り込みは実行時の
 * クラス付け外し（syncSidebarScope）だけで行い、出力される行の集合と順序は不変に保つ。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { ReqRecord, loadRecords, parseBodySections } from "./reqlib.ts";
import {
  esc,
  KIND_LABEL,
  KIND_COLLAPSED_LABEL,
  kindDefinition,
  kindTitleAttr,
  renderBodyMarkdown,
  isReviewRequired,
  reviewBadgeHtml,
  renderVerdictFieldset,
  groupByAxesGroup,
  compareRoots,
  buildContext,
  renderSiteHeader,
  pageTitle,
  REVIEW_TOPBAR_CSS,
  REVIEW_SIDEBAR_CSS,
  REVIEW_SIDEBAR_JS,
  buildSidebarEntries,
  renderSidebar,
  compareIds,
  REVIEW_NAV_JS,
  isConfirmed,
  computeProjectMeta,
  renderDraftToolbarExtra,
  renderDraftNoticeBlock,
  renderDraftPreviewPanel,
  DRAFT_MODE_CSS,
  DRAFT_MODE_JS,
  HEARTBEAT_CSS,
  HEARTBEAT_JS,
  renderConnectionLostModal,
  BUNDLE_NAV_JS,
  nsHandlerAttr,
  readChangelogHead,
  REQ_BALLOON_CSS,
  REQ_BALLOON_JS,
  buildBalloonData,
  renderJsonScript,
  sanitizeHtmlFragment,
  enrichReqLinkLabels,
  autolinkReqIds,
  renderUseCaseDiagram,
  diagnoseUseCaseActors,
} from "./req_tree.ts";
import type { TreeContext } from "./req_tree.ts";
import { scopeCss, prefixFragmentIds, scopeScript, validateFragmentOpts, type BuildOpts, type FragmentResult } from "./req_fragment.ts";

function defaultRoot(): string {
  // 既定の対象は呼び出し元プロジェクト（プラグイン自身の正本を黙って対象にしない）
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

function defaultOut(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "generated", "ガイド付きレビュー.html");
}

// ---------------------------------------------------------------------------
// SEC の文書順への平坦化（入れ子 SEC を深さ優先・行きがけ順で辿る）
// ---------------------------------------------------------------------------

/**
 * 全レコードのうち document_section を、ルート（parent: null）から compareRoots 順に、
 * 各 SEC の子 SEC を同じ順序基準で再帰的に辿って文書順のリストにする。サイクルがあっても
 * 無限ループしないよう visited で防御する（正本の不整合に対する安全策。SR-27 の前提では
 * サイクルは無いはずだが、念のため）。
 *
 * export（SOL-31）: scripts/req_document.ts が同じ章立て順を必要とするため再利用する
 * （二重実装を避ける。SR-24）。ロジック自体は変えていない。
 */
export function flattenSections(records: ReqRecord[], ctx: TreeContext): ReqRecord[] {
  const roots = records
    .filter((r) => r.kind === "document_section" && r.parentId === null)
    .sort(compareRoots);

  const visited = new Set<string>();
  const result: ReqRecord[] = [];

  function visit(sec: ReqRecord): void {
    if (sec.id === null || visited.has(sec.id)) return;
    visited.add(sec.id);
    result.push(sec);
    const children = (ctx.childrenOf.get(sec.id) ?? []).filter((c) => c.kind === "document_section");
    const sorted = [...children].sort(compareRoots);
    for (const c of sorted) visit(c);
  }

  for (const r of roots) visit(r);
  return result;
}

// ---------------------------------------------------------------------------
// CSS / JS（プレゼンテーション型 UI。req_tree.ts のトーン＝紫系アクセント・Hiragino Sans
// に合わせるが、スライド送り・進捗管理は本ビュー独自の実装）
// ---------------------------------------------------------------------------

const CSS = `* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { font-family: "Hiragino Sans", "Yu Gothic", sans-serif; line-height: 1.7; color: #222; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
/* トップバー（ヘッダ）自体は renderSiteHeader が出す .site-header / .review-toolbar を
   そのまま使う（REVIEW_TOPBAR_CSS に定義を集約。SOL-32 追補で旧 .topbar 独自定義を廃止）。
   ここでは guided 固有の追加要素（要レビュー件数チップ・スライド進捗）のみ足す。 */
.progress { font-size: .82rem; color: #534AB7; font-weight: bold; white-space: nowrap; }
${REVIEW_TOPBAR_CSS}
${REVIEW_SIDEBAR_CSS}
${DRAFT_MODE_CSS}
${HEARTBEAT_CSS}
.draft-notice, .draft-unavailable-notice { margin: 0 1.4rem; }
.slides { flex: 1 1 auto; overflow: hidden; position: relative; }
.slide { display: none; position: absolute; inset: 0; overflow-y: auto; padding: 1.4rem 2rem 2rem; }
.slide.active { display: block; }
.hash-highlight { animation: reqguided-hash-flash 2s ease; }
@keyframes reqguided-hash-flash { 0% { box-shadow: 0 0 0 3px #e67e22; } 100% { box-shadow: 0 0 0 3px transparent; } }
.slide h2 { font-size: 1.3rem; color: #534AB7; border-bottom: 2px solid #534AB7; padding-bottom: .4rem; }
.slide h3 { font-size: 1rem; margin-top: 1.4rem; border-left: 4px solid #534AB7; padding-left: .5rem; }
/* 操作ガイダンス（施主指示 2026-08-07）: 全スライド種別の見出し直下に、そのページで
   何をすればよいかを一文で示す。控えめな案内色で他の説明ブロックと区別する。 */
.slide-guide { margin: .3rem 0 1rem; padding: .35rem .8rem; background: #f7f6fd; border-left: 3px solid #cfcbe8; border-radius: 0 4px 4px 0; font-size: .85rem; color: #534AB7; }
.cover-counts { display: flex; flex-wrap: wrap; gap: .8rem; margin: 1rem 0; }
.cover-count-tile { background: #EEEDFE; border-radius: 8px; padding: .6rem 1rem; min-width: 8rem; max-width: 14rem; }
.cover-count-tile .n { font-size: 1.4rem; font-weight: bold; color: #534AB7; }
.cover-count-tile .label { font-size: .8rem; color: #555; }
.cover-count-tile .def { font-size: .7rem; color: #666; line-height: 1.35; margin-top: .25rem; }
.cover-help { background: #f0eefc; border-radius: 6px; padding: .8rem 1rem; font-size: .85rem; margin-top: 1rem; }
.decision-guidance { margin: 1rem 0 1.4rem; }
.decision-guidance-title { margin: 0 0 .3rem; font-size: .88rem; font-weight: bold; color: #534AB7; }
.decision-guidance-box { background: #f0eefc; border-radius: 6px; padding: .8rem 1rem; font-size: .85rem; margin-bottom: .8rem; }
.decision-guidance-box p { margin: .35rem 0; }
.decision-guidance-box code { background: #e2ddf7; padding: .05rem .3rem; border-radius: 3px; margin-right: .25rem; }
.guidance-kind-counts { margin: .3rem 0 .5rem; }
.guidance-placeholder { color: #888; font-style: italic; font-size: .85rem; }
.decision-guidance-values .md-body { background: #fff; border: 1px solid #ded9f5; border-radius: 6px; padding: .7rem 1rem; }
.toc-list { list-style: none; margin: 0; padding: 0; }
.toc-item { display: flex; align-items: center; gap: .6rem; padding: .5rem .6rem; border-radius: 6px; margin: .2rem 0; }
.toc-item:hover { background: #EEEDFE; }
.toc-item a { color: #534AB7; text-decoration: none; font-weight: bold; }
.toc-item a:hover { text-decoration: underline; }
.toc-item .toc-meta { font-size: .78rem; color: #666; margin-left: auto; white-space: nowrap; }
.toc-item .toc-check { flex: 0 0 auto; width: 1.2rem; text-align: center; color: #1e6b3c; }
.toc-item.depth-1 { margin-left: 1.4rem; }
.toc-item.depth-2 { margin-left: 2.8rem; }
.md-body { font-size: .95rem; }
.md-body .md-heading { font-size: 1.05rem; margin: 1rem 0 .3rem; border-left: 3px solid #cfcbe8; padding-left: .5rem; }
.md-body .md-heading:first-child { margin-top: 0; }
.md-body p { margin: .5rem 0; }
.md-body ul, .md-body ol { margin: .4rem 0; padding-left: 1.3rem; }
.md-body li { margin: .2rem 0; }
.md-body code { background: #eae8f5; padding: .05rem .3rem; border-radius: 3px; font-size: .9em; }
.md-body pre.md-code { background: #f8f8f8; border: 1px solid #eee; border-radius: 4px; padding: .6rem .8rem; overflow-x: auto; font-size: .85rem; }
.md-body pre.md-code code { background: none; padding: 0; }
.md-body a { color: #534AB7; }
.record-card { border: 1px solid #ded9f5; border-radius: 8px; padding: .8rem 1rem 1rem; margin: 1rem 0; background: #fff; }
.record-card h4 { margin: 0 0 .4rem; font-size: 1rem; }
.kind-badge { display: inline-block; font-size: .68rem; font-family: monospace; background: #EEEDFE; color: #534AB7; border-radius: 4px; padding: .05rem .35rem; margin-left: .35rem; }
/* 所属バッジ（SOL-41 施主指示 2026-08-06。ストーリーレビュー廃止 2026-08-11 後はユースケース
   の所属だけが使う）。複数の筋に登場する場合は複数個並記する。網羅レビューの正準カード・別視点のカード両方に
   同じ見た目で出す。 */
.story-badge { display: inline-block; font-size: .68rem; font-family: monospace; background: #e6f3ee; color: #1e6b3c; border-radius: 4px; padding: .05rem .35rem; margin-left: .35rem; }
/* state.confidence=provisional／state.approval=candidate の一語バッジ（SOL-41 施主指摘
   2026-08-07。state 5軸チップ・axes チップの生値は撤去したが、「なぜ判定するか」の最小信号は
   残す）。review-badge と同じ橙系の控えめなトーンを流用する。 */
.review-badge, .state-badge { display: inline-block; font-size: .68rem; font-weight: bold; background: #fbefd3; color: #8a5a00; border-radius: 4px; padding: .05rem .35rem; margin-left: .35rem; }
.chip-row { display: flex; flex-wrap: wrap; gap: .35rem; margin: .5rem 0; }
.chip { display: inline-flex; align-items: baseline; gap: .3rem; font-size: .78rem; padding: .18rem .6rem; border-radius: 999px; white-space: nowrap; }
.chip-gray { background: #ececec; color: #555; }
.chip-amber { background: #fbefd3; color: #8a5a00; }
.traces-to { font-size: .82rem; color: #555; }
.traces-to code { background: #eae8f5; padding: .05rem .3rem; border-radius: 3px; margin-right: .3rem; }
.axes-group { margin: 1rem 0 .6rem; padding-left: .5rem; border-left: 2px solid #e2dff5; }
.axes-group-label { margin: 0 0 .2rem; font-size: .85rem; font-weight: bold; color: #534AB7; }
.axes-group-count { margin-left: .35rem; font-size: .7rem; font-weight: normal; color: #888; }
.axes-group-fallback .axes-group-label { color: #888; font-weight: normal; font-style: italic; }
.axes-group-body { padding-left: .8rem; }
.review-box { margin-top: .8rem; padding-top: .7rem; border-top: 1px dashed #e2dff5; }
.review-box h5 { margin: 0 0 .4rem; font-size: .88rem; color: #534AB7; }
.review-verdict-group { border: 1px solid #ddd; border-radius: 6px; padding: .4rem .7rem .5rem; margin: 0 0 .6rem; }
.review-verdict-group legend { font-size: .78rem; color: #666; padding: 0 .3rem; }
.review-verdict-group label { margin-right: 1rem; cursor: pointer; }
.review-field-label { display: block; font-size: .82rem; color: #666; margin: .5rem 0 .2rem; }
.review-box textarea { width: 100%; box-sizing: border-box; font: inherit; padding: .4rem .6rem; border: 1px solid #ccc; border-radius: 5px; resize: vertical; }
.review-actions { display: flex; align-items: center; gap: .7rem; margin-top: .6rem; }
.review-submit { font: inherit; padding: .35rem 1rem; border-radius: 5px; border: 1px solid #534AB7; background: #534AB7; color: #fff; cursor: pointer; }
.review-submit:disabled { opacity: .4; cursor: not-allowed; }
.review-status { font-size: .82rem; color: #666; }
.review-status-ok { color: #1e6b3c; }
.review-status-error { color: #a3271f; }
.no-records { color: #888; font-style: italic; }
.bulk-approve-bar { margin: 1.2rem 0 0; }
.bulk-approve-btn { font: inherit; padding: .4rem 1rem; border-radius: 5px; border: 1px solid #534AB7; background: #fff; color: #534AB7; cursor: pointer; }
.bulk-approve-btn:disabled { opacity: .4; cursor: not-allowed; }
.bulk-approve-confirm { margin: .6rem 0 0; padding: .7rem 1rem; border: 1px dashed #534AB7; border-radius: 6px; background: #f7f6fd; }
.bulk-approve-confirm-note { margin: 0 0 .5rem; font-size: .88rem; }
.bulk-approve-confirm-note code { background: #eae8f5; padding: .05rem .3rem; border-radius: 3px; margin-right: .25rem; }
.bulk-approve-actions { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; }
.bulk-approve-confirm-btn { font: inherit; padding: .35rem 1rem; border-radius: 5px; border: 1px solid #534AB7; background: #534AB7; color: #fff; cursor: pointer; }
.bulk-approve-cancel-btn { font: inherit; padding: .35rem 1rem; border-radius: 5px; border: 1px solid #ccc; background: #fff; color: #555; cursor: pointer; }
.bulk-approve-confirm-btn:disabled, .bulk-approve-cancel-btn:disabled { opacity: .4; cursor: not-allowed; }
.bulk-approve-status { font-size: .82rem; color: #666; }
.section-done-bar { display: flex; align-items: center; gap: .8rem; margin: 1.6rem 0 0; padding-top: .8rem; border-top: 1px solid #e2dff5; }
.section-done-btn { font: inherit; padding: .4rem 1rem; border-radius: 5px; border: 1px solid #534AB7; background: #534AB7; color: #fff; cursor: pointer; }
.section-done-note { font-size: .82rem; color: #666; }
.navbar { flex: 0 0 auto; display: flex; align-items: center; gap: .8rem; padding: .6rem 1rem; border-top: 1px solid #e2dff5; background: #F7F6FD; }
.navbar button { font: inherit; padding: .4rem 1rem; border-radius: 5px; border: 1px solid #534AB7; background: #fff; color: #534AB7; cursor: pointer; }
.navbar button:disabled { opacity: .4; cursor: not-allowed; }
.navbar .nav-hint { font-size: .78rem; color: #888; }
/* 順序モード切替＋ステッパー（SOL-41）。トップバー直下・.slides の前に置く固定バー
   （flex: 0 0 auto。.slides 側の flex: 1 1 auto を押し縮めない）。 */
.order-bar { flex: 0 0 auto; display: flex; flex-direction: column; gap: .35rem; padding: .5rem 1rem; border-top: 1px solid #e2dff5; background: #fbfaff; }
.order-mode-toggle { display: flex; gap: .4rem; }
.order-mode-btn { font: inherit; font-size: .82rem; padding: .3rem .9rem; border-radius: 999px; border: 1px solid #534AB7; background: #fff; color: #534AB7; cursor: pointer; }
.order-mode-btn.active { background: #534AB7; color: #fff; }
.stepper { display: none; align-items: center; gap: .3rem; overflow-x: auto; padding: .15rem .1rem; }
.stepper.current-mode { display: flex; }
.stepper-dot { flex: 0 0 auto; font: inherit; font-size: .72rem; width: 1.7rem; height: 1.7rem; border-radius: 999px; border: 1px solid #cfcbe8; background: #fff; color: #666; cursor: pointer; padding: 0; }
.stepper-dot.current { border-color: #534AB7; background: #534AB7; color: #fff; font-weight: bold; }
.stepper-dot.done:not(.current) { border-color: #1e6b3c; background: #e3f3e6; color: #1e6b3c; }
/* 範囲限定ステッパー（SOL-46 (f)）: 選択中のユースケースの範囲外のドットは出さない。 */
.stepper-dot.out-of-scope { display: none; }
.stepper-scope-label { flex: 0 0 auto; font-size: .78rem; font-weight: bold; color: #534AB7; margin-right: .2rem; }
.stepper-scope-hint { flex: 0 0 auto; font-size: .78rem; color: #888; display: none; }
.stepper.no-scope .stepper-scope-hint { display: inline; }
/* 順序モードの説明パネル（SOL-53）。3 モードの入口スライドで同一の見た目にする。 */
.mode-intro { margin: .8rem 0 1.2rem; padding: .8rem 1rem; background: #f7f6fd; border: 1px solid #e2dff5; border-radius: 6px; }
.mode-intro h3 { margin: 0 0 .4rem; font-size: .95rem; color: #534AB7; }
.mode-intro-lead { margin: 0 0 .6rem; font-size: .88rem; line-height: 1.7; color: #333; }
.mode-intro-facets { margin: 0; display: grid; grid-template-columns: 1fr; gap: .25rem; }
.mode-intro-facets > div { display: flex; gap: .6rem; align-items: baseline; }
.mode-intro-facets dt { flex: 0 0 5rem; font-size: .8rem; color: #666; }
.mode-intro-facets dd { margin: 0; font-size: .84rem; color: #333; }
/* 目次の分類見出し（SOL-53）。ステッパーの範囲と同じ区切りを目次でも示す。 */
.toc-group-heading { margin: .8rem 0 .2rem; padding: 0 0 .15rem; font-size: .8rem; font-weight: bold; color: #534AB7; border-bottom: 1px solid #e2dff5; list-style: none; }
.toc-group-heading:first-child { margin-top: 0; }
/* 選択画面・別視点カードの様式（SOL-41 由来。ストーリーレビュー廃止後もユースケース
   レビューが同じ器を使う。クラス名は歴史的な名前のまま——改名は生成物の id/class 契約と
   既存テストを広く壊すため行わない）。 */
.story-fallback-banner { background: #fdf3e6; border: 1px solid #f1c98b; border-radius: 6px; padding: .7rem 1rem; margin: .8rem 0; font-size: .85rem; color: #7a4a00; }
.story-version-note { color: #666; font-size: .85rem; }
.story-select-list { list-style: none; margin: 1rem 0; padding: 0; }
.story-select-item { display: flex; flex-direction: column; align-items: stretch; gap: .25rem; padding: .5rem .6rem; border-radius: 6px; margin: .2rem 0; }
.story-select-item:hover { background: #EEEDFE; }
/* 行全体（.story-select-row）クリックでレビュー開始（施主指摘 2026-08-07）。 */
.story-select-row { display: flex; align-items: center; gap: .6rem; cursor: pointer; }
.story-select-row a { color: #534AB7; text-decoration: none; font-weight: bold; }
.story-select-row a:hover { text-decoration: underline; }
.story-select-meta { font-size: .78rem; color: #666; margin-left: auto; white-space: nowrap; }
/* 明示的な開始ボタン（施主指摘 2026-08-07）。行クリックと並ぶ第2の開始操作。 */
.story-select-row a.story-select-start { font-weight: normal; font-size: .78rem; border: 1px solid #534AB7; border-radius: 999px; padding: .15rem .8rem; white-space: nowrap; }
.story-select-row a.story-select-start:hover { background: #534AB7; color: #fff; text-decoration: none; }
/* 所属レコードのコンパクトな列挙（施主指示 2026-08-07）。折返し可（white-space は既定の
   normal のまま）——件数が多いときも1行に収めようとして破綻しないようにする。 */
.story-select-members { font-size: .78rem; color: #666; }
.story-step-progress { color: #666; font-size: .85rem; margin: 0 0 .6rem; }
/* その筋が辿る対象レコードの一覧（施主指示 2026-08-07。導入スライド）。 */
.story-target-intro { margin: 1rem 0 .3rem; font-size: .88rem; font-weight: bold; color: #534AB7; }
.story-target-list { list-style: none; margin: 0 0 1.2rem; padding: 0; }
.story-target-list li { padding: .15rem 0; font-size: .88rem; }
.story-target-list a[data-req-link] { font-family: monospace; margin-right: .4rem; }
.story-narration { background: #f7f6fd; border-left: 3px solid #534AB7; border-radius: 0 6px 6px 0; padding: .7rem 1rem; margin: 0 0 1.2rem; }
.story-narration-placeholder { color: #888; font-style: italic; font-size: .85rem; }
.story-record-card { border-color: #cfcbe8; }
.story-card-jump { margin-top: .4rem; }
.story-card-jump a { color: #534AB7; }
.story-step-done-bar { display: flex; align-items: center; gap: .8rem; margin: 1.6rem 0 0; padding-top: .8rem; border-top: 1px solid #e2dff5; }
/* 確認チェックボックス＋右サイドバー（SOL-50 / SR-59。単一状態モデル）。 */
.main-area { flex: 1 1 auto; display: flex; overflow: hidden; min-height: 0; }
.main-area .slides { flex: 1 1 auto; }
.confirm-row { display: flex; align-items: center; gap: .6rem; margin: .4rem 0 .8rem; }
.confirm-label { display: flex; align-items: center; gap: .35rem; font-size: .92rem; font-weight: bold; cursor: pointer; }
.confirm-label input[type="checkbox"] { width: 1.1rem; height: 1.1rem; cursor: pointer; }
.confirm-status { font-size: .8rem; color: #666; }
/* アクター節を図にできなかったときの注記（施主裁定 2026-08-14）。本文は読めるので生成は
   止めないが、静かに落とさない——落ちた事実を書き手に見せる。 */
.usecase-actor-warning { font-size: .85rem; color: #a15c00; background: #fdf6e7; border: 1px solid #e6d2a8; border-radius: 6px; padding: .5rem .7rem; margin: .4rem 0 .8rem; }
/* 妥当性確認チェック（SOL-56）。承認の確認チェックと同じ動線に並べるが、別の判断であることが
   わかるよう一段控えめにし、左の縦線で従属関係を示す。 */
.validate-row { display: flex; align-items: center; gap: .6rem; margin: -.4rem 0 .8rem .2rem; padding-left: .6rem; border-left: 2px solid #cfe6d8; }
.validate-label { display: flex; align-items: center; gap: .35rem; font-size: .84rem; color: #2f6b4a; cursor: pointer; }
.validate-label input[type="checkbox"] { width: 1rem; height: 1rem; cursor: pointer; }
.validate-status { font-size: .78rem; color: #666; }
/* 確認済みカードの一覧性（UXイシュー 02）。チェックボックスの状態だけでは通読スクロール中に
   見分けにくいため、左端のアクセントバーと淡い背景で差を付ける（バッジは足さない——
   既存の「候補」「仮決め」バッジと並ぶと冗長になるため）。実行時の付け外しは toggleConfirm。 */
.record-card[data-confirmed="1"] { background: #f7fcf9; border-left: 4px solid #2f8a56; padding-left: calc(1rem - 3px); }
${REQ_BALLOON_CSS}`;

const JS = `window.REQ_GUIDED = (function () {
${REVIEW_NAV_JS}
${REVIEW_SIDEBAR_JS}
var IDP = '';
var ROOT = document;
function byId(x) { return ROOT.querySelector('#' + IDP + CSS.escape(x)); }
// req_tree.ts の rootIsVisible() と同じ理由・同じ実装（祖先の display:none を正しく
// 反映するため getClientRects() を使う。getComputedStyle(ROOT).display は ROOT 自身の
// 指定値しか見ず、祖先の非表示を反映しない）。
function rootIsVisible() { return IDP === '' || ROOT.getClientRects().length > 0; }
var currentSlide = 0;
// 順序モード（SOL-41 改訂 / SOL-46）: 網羅レビュー／ユースケースレビューの 2 モード。
// localStorage に保持し、既定は網羅レビュー。
var ORDER_MODE_KEY = 'reqguided:mode';
function loadOrderMode() {
  var raw = null;
  try { raw = localStorage.getItem(ORDER_MODE_KEY); } catch (e) {}
  return raw === 'usecase' ? raw : 'section';
}
var currentMode = loadOrderMode();
function reviewFetch(url, opts) {
  if (!window.__REVIEW_ENDPOINT__) { return Promise.reject(new Error('review endpoint is not available (file:// view)')); }
  return fetch(url, opts);
}
function getReviewerName() {
  var el = byId('review-reviewer-input');
  return el ? el.value.trim() : '';
}
function saveReviewerName() {
  try { localStorage.setItem('reqtree:reviewerName', getReviewerName()); } catch (e) {}
}
function submitReviewItem(id) {
  // SOL-37: エンドポイント未注入（file:// 単体閲覧）のときは下書きモード。送信ではなく
  // localStorage への保存に切り替える（オンライン時の以降の処理は一切変えない）。
  if (!(typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '')) {
    saveDraftFromBox(id);
    return false;
  }
  var box = ROOT.querySelector('.review-box[data-id="' + id + '"]');
  if (!box) { return false; }
  var statusEl = box.querySelector('.review-status');
  var verdictEl = box.querySelector('input[type="radio"]:checked');
  var verdict = verdictEl ? verdictEl.value : null;
  var reviewer = getReviewerName();
  if (!reviewer) { statusEl.textContent = 'レビュアー名（記名）を入力してください。'; statusEl.className = 'review-status review-status-error'; return false; }
  if (!verdict) { statusEl.textContent = '判定（却下/保留）を選んでください（承認は上部の「確認」チェックボックスで行います）。'; statusEl.className = 'review-status review-status-error'; return false; }
  var comment = box.querySelector('.review-comment').value;
  var questions = box.querySelector('.review-questions').value;
  statusEl.textContent = '送信中…';
  statusEl.className = 'review-status';
  reviewFetch(window.__REVIEW_ENDPOINT__, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer: reviewer, items: [{ id: id, verdict: verdict, comment: comment, questions: questions }] }),
  }).then(function (res) {
    return res.text().then(function (text) { return { ok: res.ok, text: text }; });
  }).then(function (result) {
    if (result.ok) {
      statusEl.textContent = '送信しました。';
      statusEl.className = 'review-status review-status-ok';
    } else {
      var msg = '送信に失敗しました。';
      try {
        var parsed = JSON.parse(result.text);
        var firstResult = parsed && parsed.results ? parsed.results[0] : null;
        msg = (firstResult && firstResult.error) || parsed.error || msg;
      } catch (e) {}
      statusEl.textContent = msg;
      statusEl.className = 'review-status review-status-error';
    }
  }).catch(function (e) {
    statusEl.textContent = '通信に失敗しました: ' + e;
    statusEl.className = 'review-status review-status-error';
    // SOL-51 追記（施主指示 2026-08-08）: 明示送信が実際に失敗して分かった切断は、
    // 背景の heartbeat とは別の文面（「このタブを閉じてください」）でモーダル表示する。
    showConnectionLostModal('explicit');
  });
  return false;
}
// レビューの終了操作は持たない（施主裁定 2026-08-09。SR-61・SOL-52 改訂）。判定は送信の
// たびに正本へ書かれており、終了操作が運ぶ結果は無い。サーバの停止は起動元の端末で行う。
function loadProgress() {
  var raw = null;
  try { raw = localStorage.getItem('reqguided:progress'); } catch (e) {}
  if (!raw) { return {}; }
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}
function saveProgress(progress) {
  try { localStorage.setItem('reqguided:progress', JSON.stringify(progress)); } catch (e) {}
}
function markSectionDone(secId) {
  var progress = loadProgress();
  progress[secId] = 'done';
  saveProgress(progress);
  refreshProgressUI();
}
function refreshProgressUI() {
  var progress = loadProgress();
  ROOT.querySelectorAll('.toc-check[data-sec-id]').forEach(function (el) {
    var secId = el.getAttribute('data-sec-id');
    el.textContent = progress[secId] === 'done' ? '\\u2713' : '';
  });
  refreshStepper(progress);
}
// 順序モード（SOL-41）: 網羅レビュー・ユースケースレビューの両デッキのスライドは同じ .slides コンテナに
// 同居する（決定性優先。バンドルの display 切替と同じ考え方）。data-mode でフィルタし、
// スライド送り（showSlide/slideCount）は常に「現在のモードのデッキ内」だけを対象にする。
function slidesForMode(mode) {
  var all = ROOT.querySelectorAll('.slide');
  var out = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].getAttribute('data-mode') === mode) { out.push(all[i]); }
  }
  return out;
}
// ステッパー（SOL-41）: 網羅レビュー／ユースケースレビューそれぞれのステッパー（.stepper[data-mode]）の
// うち、現在のモードのものだけを表示し、現在位置・確認済みステップを見た目で区別する。
// ドットは生成時（TS 側）に data-mode デッキと同じ順で1個ずつ静的に出力済みなので、
// ここでは表示切替とクラス付け外しのみを行う（onclick は生成時に焼き込み済み）。
// 範囲限定ステッパー（SOL-46 (f)）: data-scoped="1" のデッキでは、現在スライドが属する
// data-group（ユースケースレビューでは U の ID）のドットだけを表示する。範囲が未確定の
// スライド（ユースケース選択画面）では全ドットを隠し、案内文だけを出す。
function refreshStepper(progress) {
  if (!progress) { progress = loadProgress(); }
  ROOT.querySelectorAll('.stepper').forEach(function (nav) {
    var isCurrentDeck = nav.getAttribute('data-mode') === currentMode;
    nav.classList.toggle('current-mode', isCurrentDeck);
    var scoped = nav.getAttribute('data-scoped') === '1';
    var scope = null;
    if (scoped && isCurrentDeck) {
      var cur = nav.querySelector('.stepper-dot[data-idx="' + currentSlide + '"]');
      scope = cur ? cur.getAttribute('data-group') : null;
    }
    nav.classList.toggle('no-scope', scoped && scope === null);
    var scopeLabel = nav.querySelector('.stepper-scope-label');
    if (scopeLabel) { scopeLabel.textContent = scope === null ? '' : scope; }
    nav.querySelectorAll('.stepper-dot').forEach(function (dot) {
      var idx = parseInt(dot.getAttribute('data-idx'), 10);
      dot.classList.toggle('current', isCurrentDeck && idx === currentSlide);
      var key = dot.getAttribute('data-step-key');
      dot.classList.toggle('done', !!key && progress[key] === 'done');
      dot.classList.toggle('out-of-scope', scoped && dot.getAttribute('data-group') !== scope);
    });
  });
}
// order-mode-btn の active 表示・ステッパーのデッキ切替を現在の currentMode に合わせる。
// showSlide() の最初に必ず呼ぶことで、localStorage から復元した既定モードや
// setOrderMode() での切替を毎回反映する（activate() の先頭行は showSlide(0) のまま
// 不動。初期化ロジックはここに集約する）。
function syncOrderModeUi() {
  ROOT.querySelectorAll('.order-mode-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-order-mode') === currentMode);
  });
}
function slideCount() {
  return slidesForMode(currentMode).length;
}
function showSlide(n) {
  syncOrderModeUi();
  var slides = slidesForMode(currentMode);
  var count = slides.length;
  if (n < 0) { n = 0; }
  if (count > 0 && n > count - 1) { n = count - 1; }
  currentSlide = n;
  ROOT.querySelectorAll('.slide').forEach(function (s) { s.classList.remove('active'); });
  if (slides[n]) { slides[n].classList.add('active'); }
  var progressEl = byId('slide-progress');
  if (progressEl) { progressEl.textContent = (n + 1) + ' / ' + count; }
  var prevBtn = byId('nav-prev');
  var nextBtn = byId('nav-next');
  if (prevBtn) { prevBtn.disabled = n === 0; }
  if (nextBtn) { nextBtn.disabled = n === count - 1; }
  refreshStepper();
  syncSidebarScope();
  syncSidebarCurrent();
  return false;
}
function gotoSlide(n) {
  showSlide(n);
  return false;
}
// 順序モードの切替（SOL-41 / SOL-46）。localStorage（reqguided:mode）に保持し、切替後は
// そのデッキの先頭スライドへ戻る。
function setOrderMode(mode) {
  currentMode = mode === 'usecase' ? mode : 'section';
  try { localStorage.setItem(ORDER_MODE_KEY, currentMode); } catch (e) {}
  showSlide(0);
  return false;
}
function nextSlide() {
  showSlide(currentSlide + 1);
  return false;
}
function prevSlide() {
  showSlide(currentSlide - 1);
  return false;
}
function finishSectionAndNext(secId) {
  markSectionDone(secId);
  nextSlide();
  return false;
}
function openBulkApproveConfirm(secId) {
  var confirmEl = byId('bulk-approve-confirm-' + secId);
  if (!confirmEl) { return false; }
  confirmEl.style.display = '';
  var statusEl = confirmEl.querySelector('.bulk-approve-status');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'bulk-approve-status'; }
  return false;
}
function cancelBulkApprove(secId) {
  var confirmEl = byId('bulk-approve-confirm-' + secId);
  if (!confirmEl) { return false; }
  confirmEl.style.display = 'none';
  var statusEl = confirmEl.querySelector('.bulk-approve-status');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'bulk-approve-status'; }
  return false;
}
function runBulkApprove(secId) {
  var confirmEl = byId('bulk-approve-confirm-' + secId);
  if (!confirmEl) { return false; }
  var statusEl = confirmEl.querySelector('.bulk-approve-status');
  var reviewer = getReviewerName();
  if (!reviewer) {
    if (statusEl) { statusEl.textContent = 'レビュアー名（記名）を入力してください。'; statusEl.className = 'bulk-approve-status review-status-error'; }
    return false;
  }
  var ids = [];
  try { ids = JSON.parse(confirmEl.getAttribute('data-ids') || '[]'); } catch (e) { ids = []; }
  if (!ids.length) { return false; }
  // secId は網羅レビューの SEC ID、またはユースケースレビューのステップキー
  // （"usecase:<U-id>:<stepIdx>"。useCaseStepKey）のいずれか（SOL-41 / SOL-46。ストーリー
  // レビュー廃止 2026-08-11 まではその "story:…" キーも来ていた。機構は共通のまま、書き戻す
  // コメント文言だけを対象に応じて分ける。正本へ永続化される文字列なので「節」「ステップ」を混同しない）。
  // 語彙は「確認」に統一（施主指示 2026-08-09。SOL-50 の単一状態モデルでは確認＝承認なので、
  // 画面と記録の両方を「確認」に寄せる）。verdict の値（approve）は不変で、meta/reviews/ の
  // 既存記録は旧文言のまま残る（過去の記録は書き換えない）。
  var comment = secId.indexOf('usecase:') === 0
    ? 'ステップ一括確認（' + secId + '）'
    : '節一括確認（' + secId + '）';
  var items = ids.map(function (id) { return { id: id, verdict: 'approve', comment: comment, questions: '' }; });
  if (statusEl) { statusEl.textContent = '送信中…'; statusEl.className = 'bulk-approve-status'; }
  reviewFetch(window.__REVIEW_ENDPOINT__, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer: reviewer, items: items }),
  }).then(function (res) {
    return res.text().then(function (text) { return { ok: res.ok, text: text }; });
  }).then(function (result) {
    var parsed = null;
    try { parsed = JSON.parse(result.text); } catch (e) {}
    var results = (parsed && parsed.results) || [];
    var okIds = results.filter(function (r) { return r.ok; }).map(function (r) { return r.id; });
    var failCount = results.length - okIds.length;
    if (statusEl) {
      if (!result.ok && results.length === 0) {
        statusEl.textContent = (parsed && parsed.error) || '送信に失敗しました。';
        statusEl.className = 'bulk-approve-status review-status-error';
      } else {
        statusEl.textContent = '成功 ' + okIds.length + ' 件 / 失敗 ' + failCount + ' 件。' + (failCount > 0 ? ' 失敗した項目は個別に判定してください。' : '');
        statusEl.className = failCount > 0 ? 'bulk-approve-status review-status-error' : 'bulk-approve-status review-status-ok';
      }
    }
    okIds.forEach(function (id) {
      // data-record-id は網羅レビューの本カード（id="card-…"）と別視点のカード
      // （id="story-card-…"）の両方に付く（SOL-41）。どちらのモードでこの一括確認を
      // 押しても、両方のバッジを一括で隠す（見えている側だけ隠すより単純で、
      // どちらのモードで確認しても不整合が残らない）。
      ROOT.querySelectorAll('[data-record-id="' + id + '"] .review-badge').forEach(function (badge) {
        badge.style.display = 'none';
      });
      // 節一括確認・ステップ一括確認は SOL-50 の approve verdict と同じ書き戻しを行うため、
      // 確認チェックボックス・サイドバーも個別チェックと同じ即時反映をする。
      var cb = byId('confirm-' + id);
      if (cb) { cb.checked = true; }
      setSidebarChecked(id, true);
      setCardConfirmed(id, true);
    });
  }).catch(function (e) {
    if (statusEl) { statusEl.textContent = '通信に失敗しました: ' + e; statusEl.className = 'bulk-approve-status review-status-error'; }
    showConnectionLostModal('explicit');
  });
  return false;
}
// 確認チェックボックス（SOL-50 (a)(c)）。チェック＝承認（既存の approve verdict をそのまま
// 使う——確認と承認は同じ書き戻しのため二重実装しない）。チェック解除＝確認の取り消し
// （verdict: unconfirm）。書き戻し成功後にだけ画面へ反映し、失敗時はチェック状態を戻す
// （SOL-50 (b)「画面上の操作は書き戻し成功後に即時反映する」）。
function toggleConfirm(id, checked) {
  var checkbox = byId('confirm-' + id);
  var statusEl = byId('confirm-status-' + id);
  if (!(typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '')) {
    // チェックボックス自体が disabled のため通常は到達しない安全策。
    if (checkbox) { checkbox.checked = !checked; }
    return false;
  }
  var reviewer = getReviewerName();
  if (!reviewer) {
    if (checkbox) { checkbox.checked = !checked; }
    if (statusEl) { statusEl.textContent = 'レビュアー名（記名）を入力してください。'; statusEl.className = 'confirm-status review-status-error'; }
    return false;
  }
  var verdict = checked ? 'approve' : 'unconfirm';
  if (checkbox) { checkbox.disabled = true; }
  if (statusEl) { statusEl.textContent = '送信中…'; statusEl.className = 'confirm-status'; }
  reviewFetch(window.__REVIEW_ENDPOINT__, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer: reviewer, items: [{ id: id, verdict: verdict, comment: '', questions: '' }] }),
  }).then(function (res) {
    return res.text().then(function (text) { return { ok: res.ok, text: text }; });
  }).then(function (result) {
    var parsed = null;
    try { parsed = JSON.parse(result.text); } catch (e) {}
    var firstResult = parsed && parsed.results ? parsed.results[0] : null;
    var itemOk = !!(firstResult && firstResult.ok);
    if (result.ok && itemOk) {
      if (statusEl) {
        statusEl.textContent = checked ? '確認しました。' : '確認を取り消しました。';
        statusEl.className = 'confirm-status review-status-ok';
      }
      setSidebarChecked(id, checked);
      setCardConfirmed(id, checked);
      if (checked) {
        ROOT.querySelectorAll('[data-record-id="' + id + '"] .review-badge').forEach(function (badge) {
          badge.style.display = 'none';
        });
      }
    } else {
      if (checkbox) { checkbox.checked = !checked; }
      var msg = (firstResult && firstResult.error) || (parsed && parsed.error) || '送信に失敗しました。';
      if (statusEl) { statusEl.textContent = msg; statusEl.className = 'confirm-status review-status-error'; }
    }
  }).catch(function (e) {
    if (checkbox) { checkbox.checked = !checked; }
    if (statusEl) { statusEl.textContent = '通信に失敗しました: ' + e; statusEl.className = 'confirm-status review-status-error'; }
    showConnectionLostModal('explicit');
  }).then(function () {
    if (checkbox) { checkbox.disabled = false; }
  });
  return false;
}
// 妥当性確認チェック（SOL-56 / SR-66 方向 B）。承認（toggleConfirm）と同じ送信経路・同じ
// 記名ガードを使い、verdict だけが 'validate' になる（サーバ側が req_validate の記録経路へ
// 振り分ける）。取り消しは持たない——検証の記録は履歴であって、外して無かったことにする
// ものではない（記録を黙って消さない。SOL-50 (a) の取り消し記録と同じ思想）。成功したら
// チェックしたまま無効化する。
function toggleValidate(id, checked) {
  var checkbox = byId('validate-' + id);
  var statusEl = byId('validate-status-' + id);
  if (!checked) { return false; }
  if (!(typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '')) {
    if (checkbox) { checkbox.checked = false; }
    return false;
  }
  var reviewer = getReviewerName();
  if (!reviewer) {
    if (checkbox) { checkbox.checked = false; }
    if (statusEl) { statusEl.textContent = 'レビュアー名（記名）を入力してください。'; statusEl.className = 'validate-status review-status-error'; }
    return false;
  }
  if (checkbox) { checkbox.disabled = true; }
  if (statusEl) { statusEl.textContent = '送信中…'; statusEl.className = 'validate-status'; }
  reviewFetch(window.__REVIEW_ENDPOINT__, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer: reviewer, items: [{ id: id, verdict: 'validate', comment: '', questions: '' }] }),
  }).then(function (res) {
    return res.text().then(function (text) { return { ok: res.ok, text: text }; });
  }).then(function (result) {
    var parsed = null;
    try { parsed = JSON.parse(result.text); } catch (e) {}
    var first = parsed && parsed.results ? parsed.results[0] : null;
    if (result.ok && first && first.ok) {
      // 記録した結果（passed / inconclusive）は changes の 1 行目に入る。証跡が無いレコードは
      // inconclusive に格下げされるので、何が記録されたかをそのまま出す。
      var line = (first.changes && first.changes[0]) || '';
      var downgraded = line.indexOf('inconclusive') !== -1;
      if (statusEl) {
        statusEl.textContent = downgraded
          ? '記録しました（テストが無いため inconclusive）。'
          : '妥当性を確認しました。';
        statusEl.className = 'validate-status review-status-ok';
      }
    } else {
      if (checkbox) { checkbox.checked = false; checkbox.disabled = false; }
      var msg = (first && first.error) || (parsed && parsed.error) || '送信に失敗しました。';
      if (statusEl) { statusEl.textContent = msg; statusEl.className = 'validate-status review-status-error'; }
    }
  }).catch(function (e) {
    if (checkbox) { checkbox.checked = false; checkbox.disabled = false; }
    if (statusEl) { statusEl.textContent = '通信に失敗しました: ' + e; statusEl.className = 'validate-status review-status-error'; }
    showConnectionLostModal('explicit');
  });
  return false;
}
// いま見ているスライドに対応するサイドバー行を示し、必要ならその行までスクロールする
// （UXイシュー 06。実データで約150行あり、現在位置の目印が無いと目的の行を探しにくい）。
// 網羅レビューのデッキの節スライド（data-sec-id を持つ）だけが対象で、ユースケースの
// スライドでは印を消す（サイドバーは網羅レビューのデッキの一覧であり、モードに追従させない設計）。
function syncSidebarCurrent() {
  var active = ROOT.querySelector('.slide.active');
  var secId = active ? active.getAttribute('data-sec-id') : null;
  var target = null;
  ROOT.querySelectorAll('.review-sidebar-item').forEach(function (li) {
    var isCurrent = secId !== null && li.getAttribute('data-side-id') === secId;
    li.classList.toggle('review-sidebar-item-current', isCurrent);
    if (isCurrent) { target = li; }
  });
  // スクロールは「行が実際に見えている」ときだけ行う。scrollIntoView はスクロール可能な
  // 祖先をすべて動かすため、サイドバーが折りたたみ中・その行が「未確認のみ」フィルタで
  // 隠れている場合に呼ぶと、本文側のスクロール位置だけがスライド送りごとに動く事故になる。
  var sidebar = byId('review-sidebar');
  var hidden = (sidebar && sidebar.classList.contains('collapsed')) ||
    (target && (target.classList.contains('filtered-out') || target.classList.contains('out-of-scope')));
  if (target && !hidden && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'nearest' });
  }
}
// 範囲限定（SOL-50 (b) 改訂・施主裁定 2026-08-10「範囲を絞る」）。ユースケースレビュー中は、
// いま見ているユースケースに含まれるレコードだけを
// サイドバーに残す。行の集合と順序は生成時に固定（全件・文書順）で、絞り込みは
// out-of-scope クラスの付け外しだけで行う（生成物は現在位置に依存しない＝決定的）。
// 範囲は範囲限定ステッパー（data-scoped="1"）の現在ドットの data-group から取る
// （refreshStepper と同じ判定材料を使い、範囲の定義を二重に持たない）。
// 網羅レビューと、範囲が未確定のスライド（ユースケース選択画面）では絞らない。
function currentScopeGroup() {
  var nav = ROOT.querySelector('.stepper[data-mode="' + currentMode + '"][data-scoped="1"]');
  if (!nav) { return null; }
  var cur = nav.querySelector('.stepper-dot[data-idx="' + currentSlide + '"]');
  return cur ? cur.getAttribute('data-group') : null;
}
function syncSidebarScope() {
  var scope = currentMode === 'section' ? null : currentScopeGroup();
  var inScopeCount = 0;
  var shown = 0;
  ROOT.querySelectorAll('.review-sidebar-item').forEach(function (li) {
    var groups = (li.getAttribute('data-side-groups') || '').split(' ');
    var inScope = scope === null || groups.indexOf(scope) !== -1;
    li.classList.toggle('out-of-scope', !inScope);
    if (!inScope) { return; }
    inScopeCount++;
    // 「未確認のみ」フィルタは範囲限定と独立した軸なので、範囲に入っていても隠れる行がある。
    // 範囲の件数だけを出すと「17 件」と書いてあるのに 1 行も見えない状態が起きるため、
    // 範囲の件数と実際に見えている件数の両方を出す。
    if (!li.classList.contains('filtered-out')) { shown++; }
  });
  var note = byId('review-sidebar-note');
  if (note) {
    note.textContent = scope === null
      ? '網羅レビューの全レコード'
      : scope + ' の範囲: ' + inScopeCount + ' 件（表示中 ' + shown + ' 件）';
  }
}
function initReviewUI() {
  var enabled = typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '';
  var reviewerInput = byId('review-reviewer-input');
  if (reviewerInput) {
    var stored = null;
    try { stored = localStorage.getItem('reqtree:reviewerName'); } catch (e) {}
    if (stored) { reviewerInput.value = stored; }
    reviewerInput.disabled = !enabled;
    reviewerInput.addEventListener('input', saveReviewerName);
  }
  // ヘッダのタブと注記は共通処理（applyReviewNav）に委ねる。配信されていればタブを出し、
  // 書き戻せるときだけ注記を隠す（判定を各ビューに書かない。SR-24）。
  applyReviewNav(ROOT, byId, enabled);
  ROOT.querySelectorAll('.review-box').forEach(function (box) {
    box.querySelectorAll('input, textarea, button').forEach(function (el) { el.disabled = !enabled; });
    var readonlyNote = box.querySelector('.review-readonly-note');
    if (readonlyNote) { readonlyNote.style.display = enabled ? 'none' : ''; }
  });
  // 確認チェックボックス（SOL-50 (a)(c)(e)）: review-box の外に置く独立要素のため個別に
  // 有効化する。静的バンドル（endpoint 未注入）では disabled のまま（表示のみ・操作不可）。
  ROOT.querySelectorAll('.confirm-checkbox').forEach(function (el) { el.disabled = !enabled; });
  // 妥当性確認チェック（SOL-56）も同じ二態規約に従う（静的バンドルでは表示のみ）。
  ROOT.querySelectorAll('.validate-checkbox').forEach(function (el) { el.disabled = !enabled; });
  // 節一括確認（SOL-36）: file:// 単体閲覧（enabled=false）ではボタンごと非表示・無効化する。
  ROOT.querySelectorAll('.bulk-approve-bar').forEach(function (el) {
    el.style.display = enabled ? '' : 'none';
    el.querySelectorAll('button').forEach(function (b) { b.disabled = !enabled; });
  });
  ROOT.querySelectorAll('.bulk-approve-confirm').forEach(function (el) {
    el.querySelectorAll('button').forEach(function (b) { b.disabled = !enabled; });
  });
  // ビュー切替タブ・相互ディープリンク（SOL-30）。一時サーバ配信時のみ表示する
  // （file:// 単体閲覧では従来どおり読み取り専用の単体ビューのまま）。
  // 相互ディープリンク（SOL-30）は書き戻しの有無ではなく「行き来できるか」で決まるが、
  // 従来どおり enabled で切り替える（tree ⇄ guided はどちらも書き戻し可のビューであり、
  // 判定が分かれる場面が無い）。タブ自体は applyReviewNav が配信状態で出す。
  ROOT.querySelectorAll('.cross-jump').forEach(function (el) { el.style.display = enabled ? '' : 'none'; });
}
// 相互ディープリンク（SOL-30）: URL フラグメント #<レコードID> または #<SEC-ID> があれば
// 該当スライドへ遷移してカードを強調する。ツリー側からの「ツリーで文脈を見る」の戻り先
// ジャンプ、または直接のブックマークで使う。レコードカードが無い SEC（節スライド自体）
// への直接ジャンプにも対応する（カードが見つからない場合は #slide-sec-<ID> にフォールバック）。
function handleHashNavigation() {
  var raw = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
  if (!raw) { return; }
  var card = byId('card-' + raw);
  var slide = card ? card.closest('.slide') : byId('slide-sec-' + raw);
  if (!slide) { return; }
  // レコードカード・SEC スライドは網羅レビューのデッキにしかない（SOL-41。別視点のカードは別 id 体系
  // "story-card-…"＝歴史的な名前を持つ）。ユースケースレビューを見ている最中にハッシュ
  // リンクへ飛んだときも網羅レビューのデッキへ切り替えてから解決する。
  setOrderMode('section');
  var slides = slidesForMode('section');
  var idx = Array.prototype.indexOf.call(slides, slide);
  if (idx === -1) { return; }
  gotoSlide(idx);
  var target = card || slide;
  if (target && target.scrollIntoView) { target.scrollIntoView({ block: 'nearest' }); }
  target.classList.remove('hash-highlight');
  // 同じ要素へ連続でジャンプしてもアニメーションが再生されるよう、一度クラスを外してから
  // 次フレームで付け直す。
  requestAnimationFrame(function () {
    target.classList.add('hash-highlight');
    setTimeout(function () { target.classList.remove('hash-highlight'); }, 2000);
  });
}
// 別視点のカード（SOL-41 由来。いまはユースケースレビュー）から、網羅レビューの本カード
// （レビューUI一式を持つ canonical な .review-box。二重実装しない方針のため、別視点のカードには
// review-box を持たせず、代わりにこの関数でジャンプする）へ移動する。
// handleHashNavigation と似た解決ロジックだが、location.hash を書き換えず、かつ
// 既存のピン留めテスト文字列（byId('card-' + raw) 等）に影響しないよう別関数として持つ。
function gotoCanonicalRecord(id) {
  var card = byId('card-' + id);
  var slide = card ? card.closest('.slide') : byId('slide-sec-' + id);
  if (!slide) { return false; }
  setOrderMode('section');
  var slides = slidesForMode('section');
  var idx = Array.prototype.indexOf.call(slides, slide);
  if (idx !== -1) { gotoSlide(idx); }
  if (card && card.scrollIntoView) { card.scrollIntoView({ block: 'nearest' }); }
  return false;
}
// 選択画面の行内クリックガード（施主指摘 2026-08-07）: 所属レコードの参照リンク
// （data-req-link）の列挙は選択画面ではホバーバルーンのみに限定し、クリックでの要件への
// ジャンプを無効化する。initReqBalloon（REQ_BALLOON_JS。req_tree.ts 共有・他ビューでも使う
// ため変更しない。SR-24）の document click ハンドラは、クリックした要素の祖先 LI を1つ
// 広げて data-req-link を探す（「1 LI = 1 参照リンク」前提の他ビューでは正しい挙動）。
// 選択行は同じ LI に「開始操作（タイトル・開始ボタン）」と「複数の参照リンク
// 列挙」が混在するため、この祖先探索がタイトルクリックでも先頭の参照バッジへ誤って解決し、
// レビューを開始できなくなる（施主報告のバグの原因）。
// リスト要素自身に bubble フェーズのリスナーを直接付け、イベントが document まで伝播する
// 前に止める。stopPropagation はこの1件のイベントの残りの伝播だけを止め、行の開始操作
// 自身の onclick はバブリングがこの要素へ到達する前（対象要素そのものの段階）で既に実行済み
// のため影響を受けない。DOM上の位置関係で成立するため initReqBalloon() の呼び出し順序に
// 依存しない（登録順序に依存する document 上の対策より確実）。
// ユースケースレビューの選択画面（SOL-46）も同じ .story-select-list マークアップを再利用する
// （二重実装しない。SR-24）ため、以前は文書内に .story-select-list が複数（ストーリーレビュー用・
// ユースケースレビュー用）存在する。querySelector（単数形）は最初の1個にしかガードを付けない
// ため、querySelectorAll で全件にガードを付ける。
function guardSelectListClicks() {
  var lists = ROOT.querySelectorAll('.story-select-list');
  lists.forEach(function (list) {
    list.addEventListener('click', function (e) {
      var refLink = e.target && e.target.closest ? e.target.closest('[data-req-link]') : null;
      if (refLink) { e.preventDefault(); }
      e.stopPropagation();
    });
  });
}
(function () {
  activate();
  window.addEventListener('hashchange', handleHashNavigation);
  initReviewUI();
  // SOL-51: サーバ接続 heartbeat（window.__REVIEW_ENDPOINT__ 注入時のみ起動。file:// 単体
  // 閲覧・静的バンドルでは何もしない）。
  initHeartbeat();
  // SOL-38: バンドル（req_bundle.ts）に埋め込まれ、かつオンライン配信でないときだけ
  // .view-tabs を有効化し、クリックを親フレームへの postMessage に差し替える。
  initBundleNav();
  // SOL-37: window.__REVIEW_ENDPOINT__ 未注入（file:// 単体閲覧）のときだけ下書きモードを
  // 有効化する。initReviewUI() が disabled にしたフィールドを、下書きモードが使えるとき
  // だけ initDraftMode() が上書きで解除する（順序が重要）。
  initDraftMode();
  // ホバーバルーン（SOL-41）: 導入・語りに埋め込まれた
  // data-req-link を解決する（req_document.ts と同じ initReqBalloon。SR-24）。
  initReqBalloon();
  // ストーリー選択画面の行内クリックガード（施主指摘 2026-08-07）。上記 guardSelectListClicks
  // の説明を参照。
  guardSelectListClicks();
  // 矢印キーでのスライド送り。バンドル内で自分の ROOT が非可視のときは早期リターンする
  // ガードを挟む（ADR-013。他ビューが可視のときに矢印キーで自分のスライドが動かない）。
  document.addEventListener('keydown', function (e) {
    if (!rootIsVisible()) { return; }
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') { return; }
    if (e.key === 'ArrowRight') { nextSlide(); }
    else if (e.key === 'ArrowLeft') { prevSlide(); }
  });
})();
${DRAFT_MODE_JS}
${HEARTBEAT_JS}
${BUNDLE_NAV_JS}
${REQ_BALLOON_JS}
// activate-on-first-show: シェル（バンドル）がこのビューを可視化した時に1度だけ呼ぶ
// （施主裁定 ADR-013）。スタンドアロンでは load 時に一度だけ呼ばれる（動作は従来どおり）。
function activate() {
  showSlide(0);
  handleHashNavigation();
  refreshProgressUI();
  restoreSidebarCollapsed();
  restoreSidebarFilter();
}
return {
  submitReviewItem: submitReviewItem,
  activate: activate,
  initBundleNav: initBundleNav,
  gotoSlide: gotoSlide,
  nextSlide: nextSlide,
  prevSlide: prevSlide,
  setOrderMode: setOrderMode,
  gotoCanonicalRecord: gotoCanonicalRecord,
  finishSectionAndNext: finishSectionAndNext,
  openBulkApproveConfirm: openBulkApproveConfirm,
  cancelBulkApprove: cancelBulkApprove,
  runBulkApprove: runBulkApprove,
  toggleConfirm: toggleConfirm,
  toggleValidate: toggleValidate,
  toggleSidebar: toggleSidebar,
  toggleSidebarFilter: toggleSidebarFilter,
  copyAllDrafts: copyAllDrafts,
  clearAllDrafts: clearAllDrafts,
  toggleDraftPreview: toggleDraftPreview,
  closeDraftPreview: closeDraftPreview,
};
})();
`;

// ---------------------------------------------------------------------------
// レンダリング
// ---------------------------------------------------------------------------

/**
 * state.confidence === "provisional" のときの「仮決め」の一語バッジ（SOL-41 statement
 * 追記／施主指摘 2026-08-07）。state 5軸チップ・axes チップの生値を撤去した後も
 * 「なぜ判定するか」の最小信号を保つために残す。
 */
function provisionalBadgeHtml(r: ReqRecord): string {
  return r.confidence === "provisional"
    ? '<span class="state-badge" title="state.confidence: provisional">仮決め</span>'
    : "";
}

/** state.approval === "candidate" のときの「候補」の一語バッジ（SOL-41、上と同趣旨）。 */
function candidateApprovalBadgeHtml(r: ReqRecord): string {
  return r.state["approval"] === "candidate"
    ? '<span class="state-badge" title="state.approval: candidate">候補</span>'
    : "";
}

/**
 * 確認チェックボックス（SOL-50 (a)(c)。SR-59 の単一状態モデル）。チェック＝承認であり、
 * 書き戻しは既存の approve verdict をそのまま使う（state.approval: agreed・
 * state.confidence: confirmed・axes.review_required: false を同時に行う。二重実装しない）。
 * チェック解除＝確認の取り消し（verdict: unconfirm。approval: candidate・
 * review_required: true へ戻し、取り消しのレビュー記録が meta/reviews/ に追記される）。
 *
 * review-box とは別の要素として置く（SOL-37 の下書きモードは `.review-box` 配下の
 * input/textarea を一括で再有効化するが、この操作はオフラインモードの対象にしない
 * ——(e) 「オフラインモードの下書き verdict 語彙は一切変更しない」。renderRecordCard
 * （個別レコード）・renderSectionSlide（SEC 自身）の両方から呼ぶ。
 *
 * 呼び出し位置は「本文を読み終えた後」に揃える（UXイシュー 01。カード内では statement・
 * traces_to の後・review-box の直前、節スライドでは節の statement の後）。labelText は
 * 対象が視覚的に自明でない場所（節スライドは ID バッジを伴うカード枠が無い）で対象を
 * 明示するために差し替える（UXイシュー 08）。既定は "確認"。
 */
function renderConfirmCheckbox(r: ReqRecord, labelText: string = "確認"): string {
  const idAttr = esc(r.id);
  const jsId = esc(JSON.stringify(r.id ?? ""));
  const checkedAttr = isConfirmed(r) ? " checked" : "";
  return (
    `<div class="confirm-row" data-confirm-id="${idAttr}">` +
    `<label class="confirm-label"><input type="checkbox" class="confirm-checkbox" id="confirm-${idAttr}" disabled${checkedAttr} ` +
    `${nsHandlerAttr("REQ_GUIDED", "onchange", `toggleConfirm(${jsId}, this.checked);`)}> ${esc(labelText)}</label>` +
    `<span class="confirm-status" id="confirm-status-${idAttr}" aria-live="polite"></span>` +
    `</div>`
  );
}

/**
 * 妥当性確認チェック（SOL-56 / SR-66 方向 B。施主裁定 2026-08-11「妥当性確認を動線に畳み込む」）。
 *
 * 独立した CLI 操作（`req validate`）は実装以来 0 件のまま動かなかった。承認と同じ画面・同じ
 * 動線に置き、対象を「実装済みだが未検証」のレコードだけに絞って出す——全レコードに出すと
 * 確認の判断数が倍になり、レビュー負荷を下げるための機構が負荷を増やす（SR-66 に反する）。
 * 証跡は人に書かせず、書き戻し時に機械が算出する（req coverage の判定。req_validate の
 * applyInflowValidation）。既に確認済み（validation が unvalidated 以外）のレコードには出さない
 * ——済んだものを再び判断させない。
 */
function isValidationTarget(r: ReqRecord): boolean {
  return r.state["implementation"] === "implemented" && r.state["validation"] === "unvalidated";
}

function renderValidateCheckbox(r: ReqRecord): string {
  if (!isValidationTarget(r)) return "";
  const idAttr = esc(r.id);
  const jsId = esc(JSON.stringify(r.id ?? ""));
  return (
    `<div class="validate-row" data-validate-id="${idAttr}">` +
    `<label class="validate-label"><input type="checkbox" class="validate-checkbox" id="validate-${idAttr}" disabled ` +
    `${nsHandlerAttr("REQ_GUIDED", "onchange", `toggleValidate(${jsId}, this.checked);`)}> 実装も確かめた（妥当性確認）</label>` +
    `<span class="validate-status" id="validate-status-${idAttr}" aria-live="polite"></span>` +
    `</div>`
  );
}

/** 確認 UI「どうしますか？」（却下/保留/コメント/追加質問。SOL-50 (d)。承認は確認チェックボックスに
 * 移した——ここには残さない）。req_tree.ts のレビュー操作 UI と同じ action JSON 形式。 */
function renderReviewBox(r: ReqRecord): string {
  const idAttr = esc(r.id);
  const jsId = esc(JSON.stringify(r.id ?? ""));
  const parts: string[] = [`<div class="review-box" data-id="${idAttr}">`];
  parts.push("<h5>どうしますか？</h5>");
  parts.push(
    '<p class="review-readonly-note">このビューは読み取り専用です。レビュー結果を送信するには ' +
      "<code>node scripts/req_review_serve.ts --guided</code> で一時サーバ配信してください" +
      "（file:// 単体閲覧時は送信できません）。</p>",
  );
  parts.push(renderVerdictFieldset(idAttr, { includeApprove: false }));
  parts.push(`<label class="review-field-label" for="review-comment-${idAttr}">コメント</label>`);
  parts.push(`<textarea class="review-comment" id="review-comment-${idAttr}" rows="2" disabled></textarea>`);
  parts.push(`<label class="review-field-label" for="review-questions-${idAttr}">AIへの追加質問</label>`);
  parts.push(`<textarea class="review-questions" id="review-questions-${idAttr}" rows="2" disabled></textarea>`);
  parts.push('<div class="review-actions">');
  parts.push(
    `<button type="button" class="review-submit" disabled ${nsHandlerAttr("REQ_GUIDED", "onclick", `submitReviewItem(${jsId});`)}>送信</button>`,
  );
  parts.push('<span class="review-status" aria-live="polite"></span>');
  parts.push("</div>");
  parts.push("</div>");
  return parts.join("");
}

/**
 * 節の要レビュー一括確認ブロック（SOL-36 / SR-44）。対象（節配下で
 * axes.review_required=true のレコード）が1件以上ある節のみ描画する（N=0 では
 * 何も出さない。呼び出し側で ids.length===0 のガードは行わないため、必ず1件以上で呼ぶこと）。
 *
 * マークアップは常時出力し、有効化（一時サーバ配信で window.__REVIEW_ENDPOINT__ が
 * 注入されているか）に応じた表示切替は JS 側（initReviewUI）で行う（req_tree.ts /
 * req_guided.ts 既存の .view-tabs / .cross-jump と同じ二態規約）。押下しても即適用せず、
 * 対象 ID 一覧＋件数のインライン確認 UI（confirm() は使わない）を出し、「確認を実行」で
 * 確定する。記名必須の判定は実行時（runBulkApprove）に既存の個別送信と同じガードで行う。
 *
 * unitLabel（SOL-41）: 網羅レビューの節（既定 "節"）とストーリー順モードのステップ
 * （"ステップ"）で、この一括確認ボタンの機構は完全に同じだが表示文言だけを変える
 * （施主指示の文言「このステップの要レビューをまとめて確認」）。secId 自体は
 * SEC の ID（網羅レビュー）または `story:<storyId>:<stepIdx>`（ストーリー順。storyStepKey）が
 * 入る（機構が対象を区別しないための共通キーで、runBulkApprove 側は "story:" 接頭辞の
 * 有無だけでどちらかを判別する。関数名・引数名は既存のまま変えない）。
 */
function renderBulkApproveBlock(secId: string, reviewRequiredIds: string[], unitLabel: string = "節"): string {
  const idAttr = esc(secId);
  const idsJson = esc(JSON.stringify(reviewRequiredIds));
  const idsListHtml = reviewRequiredIds.map((id) => `<code>${esc(id)}</code>`).join(" ");
  const parts: string[] = [];
  parts.push(`<div class="bulk-approve-bar" data-sec-id="${idAttr}" style="display:none;">`);
  parts.push(
    `<button type="button" class="bulk-approve-btn" disabled ${nsHandlerAttr("REQ_GUIDED", "onclick", `openBulkApproveConfirm(${esc(JSON.stringify(secId))});`)}>` +
      `この${esc(unitLabel)}の要レビュー ${reviewRequiredIds.length} 件をまとめて確認</button>`,
  );
  parts.push("</div>");
  parts.push(
    `<div class="bulk-approve-confirm" id="bulk-approve-confirm-${idAttr}" data-ids="${idsJson}" style="display:none;">`,
  );
  parts.push(
    `<p class="bulk-approve-confirm-note">対象 ${reviewRequiredIds.length} 件をまとめて確認します: ${idsListHtml}</p>`,
  );
  parts.push('<div class="bulk-approve-actions">');
  parts.push(
    `<button type="button" class="bulk-approve-confirm-btn" disabled ${nsHandlerAttr("REQ_GUIDED", "onclick", `runBulkApprove(${esc(JSON.stringify(secId))});`)}>確認を実行</button>`,
  );
  parts.push(
    `<button type="button" class="bulk-approve-cancel-btn" disabled ${nsHandlerAttr("REQ_GUIDED", "onclick", `cancelBulkApprove(${esc(JSON.stringify(secId))});`)}>キャンセル</button>`,
  );
  parts.push('<span class="bulk-approve-status" aria-live="polite"></span>');
  parts.push("</div>");
  parts.push("</div>");
  return parts.join("");
}

/**
 * レコード1件分のカード（ID・種別バッジ・title・statement(Markdown)・review_requiredバッジ・
 * 仮決め/候補バッジ・所属ストーリーバッジ（SOL-41）・所属ユースケースバッジ（SOL-46）・
 * traces_to・確認UI）。state 5軸・axes の生値チップは出さない（SOL-41 statement 追記／
 * 施主指摘 2026-08-07。管理メタデータはバルーンとツリービューのモーダルで見る）。網羅レビューの
 * 正準カード（review-box を持つ本カード）。
 */
function renderRecordCard(
  r: ReqRecord,
  ucMembership: Map<string, UseCaseMembership[]>,
): string {
  const kindLabel = r.kind !== null ? (KIND_LABEL.get(r.kind) ?? r.kind) : "?";
  const idAttr = esc(r.id);
  // 確認済みの見た目（UXイシュー 02）は class ではなく data 属性で持つ（class="record-card"
  // 自体はマークアップ不変条件として既存テストが固定しているため、状態は別の軸に載せる）。
  const confirmedAttr = isConfirmed(r) ? ' data-confirmed="1"' : "";
  const parts: string[] = [
    `<article class="record-card" id="card-${idAttr}" data-record-id="${idAttr}"${confirmedAttr}>`,
  ];
  parts.push(
    `<h4><span class="id">${esc(r.id)}</span><span class="kind-badge"${kindTitleAttr(r.kind)}>${esc(kindLabel)}</span>${reviewBadgeHtml(r)}${provisionalBadgeHtml(r)}${candidateApprovalBadgeHtml(r)}${renderUseCaseMembershipBadges(r.id, ucMembership)}<span class="title"> ${esc(r.title)}</span></h4>`,
  );
  // 相互ディープリンク（SOL-30）: このレコードをツリービュー（/）の文脈（モーダル＋
  // トレースハイライト）で見る。一時サーバ配信時のみ initReviewUI() が表示する。
  // 段落（p）自体にも cross-jump クラス＋非表示スタイルを付け、リンクだけを隠して段落の
  // margin が空白として残る事故を避ける（initReviewUI は .cross-jump を一括トグルする）。
  parts.push(`<p class="cross-jump" style="display:none;"><a class="cross-jump" href="/#${idAttr}">→ ツリーで文脈を見る</a></p>`);

  const statementRaw = r.frontmatter["statement"];
  const statementText = typeof statementRaw === "string" ? statementRaw.replace(/\n+$/, "") : "";
  parts.push(
    statementText === ""
      ? '<p class="no-records">（statement なし）</p>'
      : `<div class="md-body">${renderBodyMarkdown(statementText)}</div>`,
  );

  if (r.tracesTo.length > 0) {
    parts.push(
      `<p class="traces-to">traces_to: ${r.tracesTo.map((tid) => `<code>${esc(tid)}</code>`).join("")}</p>`,
    );
  }

  // 「読む → 判断する」の順に揃える（UXイシュー 01）: 本文・traces_to の後、
  // 「どうしますか？」欄の直前に確認チェックボックスを置く。妥当性確認（SOL-56）は
  // 同じ動線＝確認チェックのすぐ隣に置き、対象のレコードにだけ出す。
  parts.push(renderConfirmCheckbox(r));
  parts.push(renderValidateCheckbox(r));
  parts.push(renderReviewBox(r));
  parts.push("</article>");
  return parts.join("");
}

/** レコード群を axes.group でサブセクション分けして描画する（req_tree.ts の様式を踏襲）。 */
function renderRecordsMaybeGrouped(
  records: ReqRecord[],
  ucMembership: Map<string, UseCaseMembership[]>,
): string {
  const sections = groupByAxesGroup(records);
  if (sections === null) {
    return records.map((r) => renderRecordCard(r, ucMembership)).join("");
  }
  const parts: string[] = [];
  for (const sec of sections) {
    parts.push(`<div class="axes-group${sec.isFallback ? " axes-group-fallback" : ""}">`);
    parts.push(
      `<p class="axes-group-label">${esc(sec.groupName)}<span class="axes-group-count">${sec.records.length} 件</span></p>`,
    );
    parts.push('<div class="axes-group-body">');
    parts.push(sec.records.map((r) => renderRecordCard(r, ucMembership)).join(""));
    parts.push("</div>");
    parts.push("</div>");
  }
  return parts.join("");
}

/**
 * 操作ガイダンス（施主指示 2026-08-07・changelog v0.112）。通読レビューの全スライド種別
 * （表紙・目次・節・ストーリー選択・導入・ステップ）の見出し直下に、そのページで何を
 * すればよいかを一文で示す。文言は各スライド種別ごとに固定（コード起草の定型文・決定的。
 * 施主指定の文言をそのまま器に埋め込む——AI が実行時に生成するものではない）。呼び出し側は
 * `<h2>...</h2>` を push した直後にこの関数の戻り値を push すること（全種別で位置を揃える）。
 */
function renderSlideGuide(text: string): string {
  return `<p class="slide-guide">${esc(text)}</p>`;
}

/**
 * 順序モードの説明パネル（SOL-53）。3 モードの入口スライド（網羅レビュー=目次・ストーリー=選択・
 * ユースケース=選択）が同じ様式で「このモードは何を単位に、何の順で流すのか」を説明する。
 * 施主指示 2026-08-08「ストーリーレビューがなんなのか、ユースケースレビューがなんなのかを
 * 説明いれて」「これらの画面間の統一をつけて」。
 *
 * 文言をここに集約するのは、3 画面それぞれのテンプレートに散らすと様式が揃わなくなるため
 * （SR-24: 二重実装しない）。lead は 1 行の定義、items は「単位／順序／向く場面」の 3 項目に
 * 揃える——3 モードを見比べたとき同じ軸で違いが読めるようにする。
 */
interface ModeIntroSpec {
  title: string;
  lead: string;
  unit: string;
  order: string;
  suited: string;
}

const MODE_INTRO: Map<"section" | "usecase", ModeIntroSpec> = new Map([
  [
    "section",
    {
      title: "網羅レビューとは",
      lead: "要求定義書の目次の順に、章節（SEC）を 1 つずつ読み進め、全件を抜けなく確認するモードです。判定の書き戻しはこのモードのカードが正本の入口になります。",
      unit: "章節（SEC）— レコード種別ごとのまとまり",
      order: "文書の目次順（概要 → 要求 → 要件 → 運営）",
      suited: "はじめて全体を通読するとき、抜けなく全件を確認したいとき",
    },
  ],
  [
    "usecase",
    {
      title: "ユースケースレビューとは",
      lead: "「アクターがシステムで目的を達成するまでの流れ」（ユースケース）を 1 つ選び、その根拠となる要求とそれを実現する要件を順に流すモードです。筋は U レコードの traces_to そのものなので、正本を更新すると自動で追随します（定義ファイルを持ちません）。",
      unit: "ユースケース（U）— アクターの目的 1 つ",
      order: "U 本文（流れ）→ U 自身の判定 → 根拠の SR ごと（その SR に遡る SOL を同席）",
      suited: "利用の流れが成立しているか、実現手段が揃っているかを見たいとき",
    },
  ],
]);

function renderModeIntro(mode: "section" | "usecase"): string {
  const spec = MODE_INTRO.get(mode);
  if (spec === undefined) return "";
  return (
    // スライド（<section class="slide">）の内側なので入れ子の <section> にしない
    // （説明ブロックであって文書の節ではない。スライド単位で切り出す既存の検査・
    // ADR-013 のフラグメント抽出が入れ子の閉じタグで途切れるのも避ける）。
    `<div class="mode-intro" data-intro-mode="${mode}">` +
    `<h3>${esc(spec.title)}</h3>` +
    `<p class="mode-intro-lead">${esc(spec.lead)}</p>` +
    '<dl class="mode-intro-facets">' +
    `<div><dt>単位</dt><dd>${esc(spec.unit)}</dd></div>` +
    `<div><dt>順序</dt><dd>${esc(spec.order)}</dd></div>` +
    `<div><dt>向く場面</dt><dd>${esc(spec.suited)}</dd></div>` +
    "</dl>" +
    "</div>"
  );
}

/** 表紙スライド。 */
function renderCoverSlide(records: ReqRecord[], sections: ReqRecord[]): string {
  const kindOrder: { kind: string; label: string }[] = [
    { kind: "business_requirement", label: KIND_COLLAPSED_LABEL.get("business_requirement") ?? "BR" },
    { kind: "stakeholder_requirement", label: KIND_COLLAPSED_LABEL.get("stakeholder_requirement") ?? "SR" },
    { kind: "use_case", label: KIND_COLLAPSED_LABEL.get("use_case") ?? "U" },
    { kind: "solution_requirement", label: KIND_COLLAPSED_LABEL.get("solution_requirement") ?? "SOL" },
    { kind: "mandatory_output", label: KIND_COLLAPSED_LABEL.get("mandatory_output") ?? "MO" },
    { kind: "document_section", label: KIND_COLLAPSED_LABEL.get("document_section") ?? "SEC" },
  ];
  const reviewRequiredCount = records.filter(isReviewRequired).length;

  const parts: string[] = ['<section class="slide" id="slide-cover" data-mode="section">'];
  parts.push("<h2>通読レビュー — 表紙</h2>");
  parts.push(renderSlideGuide("このビューの使い方を確認し、「次へ」で目次に進んでください。"));
  parts.push(
    '<p class="meta">本ビューは <code>docs/requirements/</code>（正本）から ' +
      "<code>scripts/req_guided.ts</code> が一方向生成したプレゼンテーション型のレビュービューです。" +
      "章節（SEC）の順に、説明資料（節の解説）と確認（どうしますか？→入力）が対になったスライドを" +
      "1画面ずつめくって読み進めます。</p>",
  );
  parts.push('<div class="cover-counts">');
  for (const { kind, label } of kindOrder) {
    const n = records.filter((r) => r.kind === kind).length;
    // 種別件数タイルに定義キャプションを常時表示（施主指示 2026-07-31。ホバーtitle
    // だけでは読み手が能動的に確認しないと定義が出ないため）。KIND_DEFINITION は
    // req_tree.ts の唯一の一次情報を import して使い、ここでは二重定義しない。
    // document_section（「文書の章」タイル）は対象外で kindDefinition が null を返す。
    const def = kindDefinition(kind);
    const defHtml = def !== null ? `<div class="def">${esc(def)}</div>` : "";
    parts.push(
      `<div class="cover-count-tile"><div class="n">${n}</div><div class="label">${esc(label)}</div>${defHtml}</div>`,
    );
  }
  parts.push(
    `<div class="cover-count-tile"><div class="n">${reviewRequiredCount}</div><div class="label">要レビュー件数</div></div>`,
  );
  parts.push(
    `<div class="cover-count-tile"><div class="n">${sections.length}</div><div class="label">節（スライド）数</div></div>`,
  );
  parts.push("</div>");
  parts.push('<div class="cover-help">');
  parts.push(
    "操作: 画面下部の「← 前へ / 次へ →」ボタン、またはキーボードの ←→ キーでスライドを送れます。" +
      "目次スライドから節をクリックすると、その節のスライドへ直接ジャンプします。各節スライドの" +
      "末尾にある「この節を確認済みにして次へ」ボタンで進捗を記録できます（ブラウザに保存）。",
  );
  parts.push("</div>");
  // 両ビューの使い分け案内（SOL-30）。ツリーへの実リンクは cross-jump 扱い（一時サーバ
  // 配信時のみ initReviewUI() が表示。file:// 単体閲覧では文章のみが読める）。
  parts.push(
    '<p class="cover-usage-guidance">はじめて確認する場合や、まとめて通読レビューしたい場合は、このまま次のスライドへ進んでください。' +
      "特定の裁定待ち項目だけを消化したい場合や、依存関係（parent／traces_to）を確認したい場合は、" +
      "探索型のツリービューが向いています。" +
      '<a class="cross-jump" href="/" style="display:none;"> → ツリービューを開く</a></p>',
  );
  parts.push("</section>");
  return parts.join("");
}

/**
 * 網羅レビューのデッキの範囲分け（SOL-53。施主裁定 2026-08-08「分類ごと、セクションごとの単位で
 * まとめてその範囲のステッパー」＝レコード種別でまとめる）。SEC はその節が収めるレコードの
 * 種別で束ねる——節の役割が「BR の章」「SR の章」…であり、種別がそのまま読み手の分類だから。
 * 特定の種別に対応しない節（概要・スコープ・用語・決定・付録など）は「その他」に落ちる。
 *
 * 区分は器側の定義として持ち、正本（SEC の frontmatter）は変更しない——SEC の親子構造を
 * 作り直すと文書ビュー・ツリービュー・トレースの見え方まで変わるため、表示上の束ねに
 * とどめる（施主裁定 2026-08-08 で「正本に親 SEC を追加する」案を採らなかった理由）。
 */
const SECTION_GROUP_OTHER = "その他";

/** その節に属する（SEC 以外の）レコードの種別から範囲名を決める。混在時は最多の種別を採る。 */
function sectionGroupName(sec: ReqRecord, ctx: TreeContext): string {
  if (sec.id === null) return SECTION_GROUP_OTHER;
  const children = (ctx.childrenOf.get(sec.id) ?? []).filter((c) => c.kind !== "document_section");
  const counts = new Map<string, number>();
  for (const c of children) {
    if (c.kind === null) continue;
    counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  }
  if (counts.size === 0) return SECTION_GROUP_OTHER;
  // 決定性: 件数降順、同数なら種別名の昇順（Map の挿入順に依存させない）。
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0];
  return KIND_COLLAPSED_LABEL.get(top) ?? top;
}

/** 目次スライド。SEC 一覧（クリックでジャンプ、各節のレコード数とレビュー必須数を添える）。 */
function renderTocSlide(sections: ReqRecord[], ctx: TreeContext): string {
  const parts: string[] = ['<section class="slide" id="slide-toc" data-mode="section">'];
  parts.push("<h2>目次</h2>");
  parts.push(renderSlideGuide("読みたい節を選ぶか、「次へ」で最初の節から順に読み進めてください。"));
  // モード説明パネル（SOL-53）: 他 2 モードの選択スライドと同じ様式・同じ位置に置く。
  parts.push(renderModeIntro("section"));
  // 一覧は範囲（分類）ごとの見出しで束ねる（SOL-53）。ステッパーの範囲と同じ区切りを
  // 目次でも見せることで、「いまどの分類を読んでいるか」が両方で一致して読める。
  parts.push('<ul class="toc-list">');
  let prevGroup: string | null = null;
  const seenGroups = new Set<string>();
  sections.forEach((sec, idx) => {
    const children = sec.id !== null ? (ctx.childrenOf.get(sec.id) ?? []).filter((c) => c.kind !== "document_section") : [];
    const reviewCount = children.filter(isReviewRequired).length;
    const slideIndex = idx + 2; // 0=表紙, 1=目次, 2以降=節
    const depth = sectionDepth(sec, ctx);
    const group = sectionGroupName(sec, ctx);
    if (group !== prevGroup) {
      // 同じ分類が文書順で離れて再登場することがある（「その他」＝特定種別に対応しない節は
      // 前段と付録に分かれる）。ステッパー側は同一範囲として通番を続けるため、目次見出しも
      // 「（続き）」と明示して 1 つの範囲であることを一致させる。
      const heading = seenGroups.has(group) ? `${group}（続き）` : group;
      seenGroups.add(group);
      parts.push(`<li class="toc-group-heading">${esc(heading)}</li>`);
      prevGroup = group;
    }
    parts.push(
      `<li class="toc-item depth-${Math.min(depth, 2)}"><span class="toc-check" data-sec-id="${esc(sec.id)}"></span>` +
        `<a href="#" ${nsHandlerAttr("REQ_GUIDED", "onclick", `gotoSlide(${slideIndex});`)}>${esc(sec.id)} ${esc(sec.title)}</a>` +
        `<span class="toc-meta">${children.length} 件（要レビュー ${reviewCount}）</span></li>`,
    );
  });
  parts.push("</ul>");
  parts.push("</section>");
  return parts.join("");
}

// ---------------------------------------------------------------------------
// 右サイドバー（SOL-50 (b)）。現在のレビュー（網羅レビューのデッキ）の全レコード ID を文書順
// （sections の並び＝flattenSections の行きがけ順、各節の直下は renderSectionSlide が
// カードを描く順と同じ children 順）に一覧する。SEC 自身も1行として含む（SOL-50 (c)）。
// ストーリー順・ユースケースレビューのデッキはこの一覧に対する別視点（renderRefRecordCard
// 経由で gotoCanonicalRecord へジャンプする）に過ぎず、確認チェックの実体（書き戻しの
// 唯一の入口）は網羅レビューのデッキの正準カード・SEC 自身にしか無い。そのため一覧の中身（行の集合・
// 順序・チェック状態の出どころ）は常に網羅レビューのデッキのものだが、ストーリー／ユースケース
// レビュー中は表示をその範囲だけに絞る（施主裁定 2026-08-10。syncSidebarScope）。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 意思決定ガイダンス（SR-34 追記 / SOL-29）
//
// (a) 位置づけと影響は正本から決定的に算出する。(b) 方針・価値観別の指針は
// SEC レコード本文の「## レビューガイダンス」節（AI が正本に執筆）をそのまま
// Markdown 表示するだけで、ビュー側は算出・判定を一切行わない（statement/verification
// の要求どおり、算出と執筆抽出の責務を分離する）。
// ---------------------------------------------------------------------------


/** traces_to の逆引き（参照先 id -> 参照元 id 一覧）。全レコードを対象に一度だけ構築する。 */
function buildReverseTracesMap(records: ReqRecord[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of records) {
    if (r.id === null) continue;
    for (const target of r.tracesTo) {
      const list = map.get(target) ?? [];
      list.push(r.id);
      map.set(target, list);
    }
  }
  return map;
}

interface SectionGuidance {
  index: number; // 1-based
  total: number;
  kindCounts: { kind: string; label: string; count: number }[];
  reviewRequiredCount: number;
  upstreamIds: string[];
  downstreamIds: string[];
  lowReversibilityIds: string[];
}

const GUIDANCE_KIND_ORDER: { kind: string; label: string }[] = [
  { kind: "business_requirement", label: KIND_COLLAPSED_LABEL.get("business_requirement") ?? "BR" },
  { kind: "stakeholder_requirement", label: KIND_COLLAPSED_LABEL.get("stakeholder_requirement") ?? "SR" },
  { kind: "use_case", label: KIND_COLLAPSED_LABEL.get("use_case") ?? "U" },
  { kind: "solution_requirement", label: KIND_COLLAPSED_LABEL.get("solution_requirement") ?? "SOL" },
  { kind: "mandatory_output", label: KIND_COLLAPSED_LABEL.get("mandatory_output") ?? "MO" },
];

/**
 * 節の「位置づけと影響」を正本から決定的に算出する。上流は節内レコードの traces_to が
 * 指す節外レコード id（重複除去・ID順）、下流は節内レコードを traces_to で参照する節外
 * レコード id（同）。可逆性の低い決定は節内レコードの axes.reversibility === "low"。
 */
function computeSectionGuidance(
  index: number,
  total: number,
  children: ReqRecord[],
  reverseTraces: Map<string, string[]>,
): SectionGuidance {
  const ownIds = new Set(children.map((c) => c.id).filter((id): id is string => id !== null));

  const kindCounts = GUIDANCE_KIND_ORDER.map(({ kind, label }) => ({
    kind,
    label,
    count: children.filter((c) => c.kind === kind).length,
  })).filter((kc) => kc.count > 0);
  const reviewRequiredCount = children.filter(isReviewRequired).length;

  const upstreamSet = new Set<string>();
  for (const c of children) {
    for (const t of c.tracesTo) {
      if (!ownIds.has(t)) upstreamSet.add(t);
    }
  }

  const downstreamSet = new Set<string>();
  for (const ownId of ownIds) {
    for (const sourceId of reverseTraces.get(ownId) ?? []) {
      if (!ownIds.has(sourceId)) downstreamSet.add(sourceId);
    }
  }

  const lowReversibilityIds = children
    .filter((c) => c.axes["reversibility"] === "low")
    .map((c) => c.id)
    .filter((id): id is string => id !== null)
    .sort(compareIds);

  return {
    index,
    total,
    kindCounts,
    reviewRequiredCount,
    upstreamIds: [...upstreamSet].sort(compareIds),
    downstreamIds: [...downstreamSet].sort(compareIds),
    lowReversibilityIds,
  };
}

const DOWNSTREAM_DISPLAY_LIMIT = 10;

/** (a) 位置づけと影響の枠。 */
function renderGuidancePositionBlock(g: SectionGuidance): string {
  const parts: string[] = ['<div class="decision-guidance-box">'];
  parts.push(`<p>第 ${g.index} 節／全 ${g.total} 節。</p>`);

  parts.push('<div class="chip-row guidance-kind-counts">');
  if (g.kindCounts.length === 0) {
    parts.push('<span class="chip chip-gray">この節を parent とするレコードなし</span>');
  } else {
    for (const kc of g.kindCounts) {
      parts.push(`<span class="chip chip-gray">${esc(kc.label)} ${kc.count} 件</span>`);
    }
  }
  parts.push(`<span class="chip chip-amber">要レビュー ${g.reviewRequiredCount} 件</span>`);
  parts.push("</div>");

  const upstreamText =
    g.upstreamIds.length === 0 ? "なし" : g.upstreamIds.map((id) => `<code>${esc(id)}</code>`).join("");
  parts.push(`<p><strong>上流</strong>（この節が遡る節外レコード）: ${upstreamText}</p>`);

  if (g.downstreamIds.length === 0) {
    parts.push("<p>この節の判断に依存する下流レコードはない。</p>");
  } else {
    const shown = g.downstreamIds.slice(0, DOWNSTREAM_DISPLAY_LIMIT);
    const rest = g.downstreamIds.length - shown.length;
    const shownText = shown.map((id) => `<code>${esc(id)}</code>`).join("");
    parts.push(
      `<p><strong>下流</strong>（この節に依存する節外レコード）: ${g.downstreamIds.length} 件 ${shownText}` +
        (rest > 0 ? ` ほか ${rest} 件` : "") +
        "</p>",
    );
  }

  if (g.lowReversibilityIds.length > 0) {
    parts.push(
      `<p><strong>変えにくい決定</strong>: ${g.lowReversibilityIds.map((id) => `<code>${esc(id)}</code>`).join("")}` +
        "（後から覆すコストが大きい）</p>",
    );
  }

  parts.push("</div>");
  return parts.join("");
}

/** (b) 方針・価値観別の指針。SEC 本文の「## レビューガイダンス」節を Markdown 表示するだけ。 */
function renderGuidanceValuesBlock(sec: ReqRecord): string {
  const bodySections = parseBodySections(sec.body);
  const guidanceText = bodySections["レビューガイダンス"];
  const parts: string[] = ['<div class="decision-guidance-values">'];
  if (typeof guidanceText === "string" && guidanceText.trim() !== "") {
    parts.push(`<div class="md-body">${renderBodyMarkdown(guidanceText)}</div>`);
  } else {
    parts.push(
      '<p class="guidance-placeholder">この節のレビューガイダンスは未執筆です' +
        "（正本の SEC 本文に「## レビューガイダンス」節を追記すると表示されます）。</p>",
    );
  }
  parts.push("</div>");
  return parts.join("");
}

/** 節スライドの意思決定ガイダンス（(a) 位置づけと影響 + (b) 方針・価値観別の指針）。 */
function renderDecisionGuidance(sec: ReqRecord, g: SectionGuidance): string {
  const parts: string[] = ['<div class="decision-guidance">'];
  parts.push('<p class="decision-guidance-title">この節の位置づけ</p>');
  parts.push(renderGuidancePositionBlock(g));
  parts.push('<p class="decision-guidance-title">方針・価値観別の指針</p>');
  parts.push(renderGuidanceValuesBlock(sec));
  parts.push("</div>");
  return parts.join("");
}

/**
 * SEC の入れ子深さ（ルート=0）。目次のインデント表示にのみ使う。
 * export（SOL-31）: scripts/req_document.ts の章番号（depth>0 で "1.1" 形式）算出にも
 * 再利用する（二重実装を避ける。SR-24）。
 */
export function sectionDepth(sec: ReqRecord, ctx: TreeContext): number {
  let depth = 0;
  let current: ReqRecord | undefined = sec;
  const visited = new Set<string>();
  while (current && current.parentId !== null && !visited.has(current.id ?? "")) {
    if (current.id !== null) visited.add(current.id);
    const parent = ctx.byId.get(current.parentId);
    if (!parent || parent.kind !== "document_section") break;
    depth += 1;
    current = parent;
  }
  return depth;
}

/** 節スライド1本（節タイトル・説明＋意思決定ガイダンス＋所属レコードのカード群＋確認済みボタン）。 */
function renderSectionSlide(
  sec: ReqRecord,
  ctx: TreeContext,
  sectionIndex: number,
  totalSections: number,
  reverseTraces: Map<string, string[]>,
  ucMembership: Map<string, UseCaseMembership[]>,
): string {
  const children = sec.id !== null ? (ctx.childrenOf.get(sec.id) ?? []).filter((c) => c.kind !== "document_section") : [];
  const idAttr = esc(sec.id);

  const parts: string[] = [`<section class="slide" id="slide-sec-${idAttr}" data-mode="section" data-sec-id="${idAttr}">`];
  parts.push(`<h2><span class="id">${esc(sec.id)}</span> ${esc(sec.title)}</h2>`);
  parts.push(
    renderSlideGuide(
      "ガイダンスを参考に各要求を読み、問題なければ「この節の要レビューをまとめて確認」、気になるものは個別に判定・コメントしてください。",
    ),
  );

  const statementRaw = sec.frontmatter["statement"];
  const statementText = typeof statementRaw === "string" ? statementRaw.replace(/\n+$/, "") : "";
  parts.push(
    statementText === ""
      ? '<p class="no-records">（この節の statement はありません）</p>'
      : `<div class="md-body">${renderBodyMarkdown(statementText)}</div>`,
  );

  const guidance = computeSectionGuidance(sectionIndex, totalSections, children, reverseTraces);
  parts.push(renderDecisionGuidance(sec, guidance));

  // 節（SEC）自身の確認チェック（SOL-50 (c)）。以前は節スライドに個別判定 UI が無かった
  // （節の裁定は配下レコードの一括確認だけで表現していた）が、節レコード自体も他のレコードと
  // 同様にチェック（承認）できるようにする。位置は節の statement と意思決定ガイダンスを
  // 読んだ後・配下レコードの見出しの前（UXイシュー 01。ガイダンスは節を判断するための
  // 読み物なので、その前にチェックを置くと個別カードで直したのと同じ「判断が先に来る」
  // 逆転が節の階層で起きる）。ラベルは対象（この節自体であり、配下レコードやスライド全体
  // ではない）を明示する（UXイシュー 08。節スライドにはカード枠と ID バッジが無いため
  // 既定の "確認" では対象が読み取れない）。
  parts.push(renderConfirmCheckbox(sec, `この節（${sec.id ?? ""}）自体を確認する`));
  parts.push(renderValidateCheckbox(sec));

  parts.push("<h3>この節のレコード</h3>");
  if (children.length === 0) {
    parts.push('<p class="no-records">（この節を parent とするレコードはありません）</p>');
  } else {
    parts.push(renderRecordsMaybeGrouped(children, ucMembership));
  }

  // 節一括確認（SOL-36 / SR-44）: N=0（節配下に要レビューのレコードが無い）節では
  // ボタンごと出さない。N は節配下（この節を parent とするレコード）で
  // axes.review_required=true の件数をビルド時に算出する（ハードコードしない）。
  const reviewRequiredIds = children
    .filter(isReviewRequired)
    .map((c) => c.id)
    .filter((id): id is string => id !== null)
    .sort(compareIds);
  if (reviewRequiredIds.length > 0 && sec.id !== null) {
    parts.push(renderBulkApproveBlock(sec.id, reviewRequiredIds));
  }

  parts.push('<div class="section-done-bar">');
  parts.push(
    `<button type="button" class="section-done-btn" ${nsHandlerAttr("REQ_GUIDED", "onclick", `finishSectionAndNext(${esc(JSON.stringify(sec.id ?? ""))});`)}>この節を確認済みにして次へ</button>`,
  );
  parts.push('<span class="section-done-note">進捗はブラウザ（localStorage）に保存され、目次に反映されます。</span>');
  parts.push("</div>");

  parts.push("</section>");
  return parts.join("");
}

/**
 * ステッパー（全モード共通）1ドット分のメタ情報。key が null のスライドは「確認済み」概念を持たない。
 * group が非 null のデッキでは、ステッパーは「現在スライドと同じ group のドットだけ」を表示する
 * （範囲限定ステッパー。SOL-46 (f)）。label は丸の中の表示文字（既定は通し番号）、title は
 * ホバー時の完全な位置説明。
 */
interface StepperSlideMeta {
  key: string | null;
  group?: string | null;
  label?: string;
  title?: string;
}

/**
 * ステッパー（SOL-41）。現在位置を示し、クリックでそのスライドへジャンプできる（gotoSlide
 * 流用）。網羅レビュー・ストーリー順・ユースケース順それぞれのデッキ分だけ生成し、実行時 JS
 * （refreshStepper）が現在のモードのものだけを表示する。ドットが多いデッキでも破綻しない
 * よう横スクロール可能なコンパクトな行にする（CSS の overflow-x: auto）。
 *
 * group を持つメタが 1 つでもあるデッキは「範囲限定ステッパー」（data-scoped="1"）になり、
 * 現在スライドと同じ group のドットだけを表示する（SOL-46 (f)。施主指示 2026-08-08:
 * ユースケースレビューでデッキ全体の通し番号が並ぶのは読めない）。範囲外のドットも HTML には
 * 常に出力し、表示切替だけを JS が行う（生成物は現在位置に依存しない＝決定的）。
 */
function renderStepper(mode: "section" | "usecase", metas: StepperSlideMeta[]): string {
  const label =
    mode === "section" ? "網羅レビューのステップ" : "ユースケースレビューのステップ";
  const scoped = metas.some((m) => (m.group ?? null) !== null);
  const scopedAttr = scoped ? ' data-scoped="1"' : "";
  const parts: string[] = [`<nav class="stepper" data-mode="${mode}"${scopedAttr} aria-label="${esc(label)}">`];
  if (scoped) {
    // 現在の範囲名（例: U-01）と、範囲未確定時の案内。中身は JS が埋める（生成時は空）。
    parts.push('<span class="stepper-scope-label"></span>');
    const hint =
      mode === "section"
        ? "節を選ぶとその分類のステップが表示されます"
        : "ユースケースを選ぶとステップが表示されます";
    parts.push(`<span class="stepper-scope-hint">${esc(hint)}</span>`);
  }
  metas.forEach((m, i) => {
    const keyAttr = m.key !== null ? ` data-step-key="${esc(m.key)}"` : "";
    const group = m.group ?? null;
    const groupAttr = group !== null ? ` data-group="${esc(group)}"` : "";
    const dotLabel = m.label ?? String(i + 1);
    const title = m.title ?? `${i + 1} / ${metas.length}`;
    parts.push(
      `<button type="button" class="stepper-dot" data-idx="${i}"${keyAttr}${groupAttr} title="${esc(title)}" ` +
        `${nsHandlerAttr("REQ_GUIDED", "onclick", `gotoSlide(${i});`)}>${esc(dotLabel)}</button>`,
    );
  });
  parts.push("</nav>");
  return parts.join("");
}

/** 網羅レビュー（旧称「網羅レビュー」。施主指示 2026-08-11 で改名）／ユースケースレビューの切替バー
 * （SOL-41 改訂 / SOL-46）。既定は網羅レビュー。内部の識別子（data-order-mode="section"・
 * currentMode の 'section'・data-mode="section"）は変えない——表示名の変更であり、保存済みの
 * localStorage の値や生成物の構造まで動かす必要がないため。
 * localStorage 保持は setOrderMode 側。ストーリーレビューは廃止した（施主指示 2026-08-11）。 */
function renderOrderModeBar(): string {
  return (
    '<div class="order-mode-toggle" role="group" aria-label="順序モード">' +
    `<button type="button" class="order-mode-btn active" data-order-mode="section" ${nsHandlerAttr("REQ_GUIDED", "onclick", "setOrderMode('section');")}>網羅レビュー</button>` +
    `<button type="button" class="order-mode-btn" data-order-mode="usecase" ${nsHandlerAttr("REQ_GUIDED", "onclick", "setOrderMode('usecase');")}>ユースケースレビュー</button>` +
    "</div>"
  );
}

/**
 * ストーリーレビューモードのレコードカード（SOL-41）。レビュー UI は二重実装しない方針
 * （SOL-41 statement）のため、renderRecordCard とは別にヘッダ・statement・traces_to のみを
 * 描き、review-box は持たせない。代わりに網羅レビューの本カード（review-box 一式を持つ
 * canonical な場所）へジャンプするリンクを置く。state 5軸・axes の生値チップは網羅レビューの本カード
 * 同様に出さない（SOL-41 statement 追記／施主指摘 2026-08-07）。
 * domKeySuffix は (story index)-(step index)-(step内のレコード順) で組み、同じレコードが
 * 複数ステップに登場しても id が重複しないようにする（fragment 不変条件の対象）。
 * 所属バッジは網羅レビューの正準カードと同じ様式で出す。renderRecordCard（網羅レビューの正準カード）と
 * 同じマップを参照するため、そのレコードの全所属（複数の筋への登場を含む）がどちらの
 * モードでも同じ内容で見える。
 */
function renderRefRecordCard(r: ReqRecord, domKeySuffix: string): string {
  const bareIdAttr = esc(r.id);
  const domIdAttr = esc(`${r.id ?? ""}-${domKeySuffix}`);
  const kindLabel = r.kind !== null ? (KIND_LABEL.get(r.kind) ?? r.kind) : "?";
  const parts: string[] = [
    `<article class="record-card story-record-card" id="story-card-${domIdAttr}" data-record-id="${bareIdAttr}">`,
  ];
  parts.push(
    `<h4><span class="id">${esc(r.id)}</span><span class="kind-badge"${kindTitleAttr(r.kind)}>${esc(kindLabel)}</span>${reviewBadgeHtml(r)}${provisionalBadgeHtml(r)}${candidateApprovalBadgeHtml(r)}<span class="title"> ${esc(r.title)}</span></h4>`,
  );

  const statementRaw = r.frontmatter["statement"];
  const statementText = typeof statementRaw === "string" ? statementRaw.replace(/\n+$/, "") : "";
  parts.push(
    statementText === ""
      ? '<p class="no-records">（statement なし）</p>'
      : `<div class="md-body">${renderBodyMarkdown(statementText)}</div>`,
  );

  if (r.tracesTo.length > 0) {
    parts.push(`<p class="traces-to">traces_to: ${r.tracesTo.map((tid) => `<code>${esc(tid)}</code>`).join("")}</p>`);
  }

  parts.push(
    `<p class="story-card-jump"><a href="#" ${nsHandlerAttr(
      "REQ_GUIDED",
      "onclick",
      `gotoCanonicalRecord(${esc(JSON.stringify(r.id ?? ""))});`,
    )}>→ 網羅レビューでこの項目をレビューする</a></p>`,
  );
  parts.push("</article>");
  return parts.join("");
}

/**
 * 所属レコードのコンパクトな列挙（ストーリー一覧。施主指示 2026-08-07）。ID のみを
 * data-req-link 付きで並べ、ホバーバルーンで内容を確認できるようにする（タイトルは
 * 添えない——コンパクトさを優先し、ホバーで読める情報を地の文で重複させない）。
 * ctx.byId に実在しない ID（正本の不整合）は無視する（req lint に委ねる）。
 */
function renderMemberIdList(ids: string[], ctx: TreeContext): string {
  const known = ids.filter((id) => ctx.byId.has(id));
  if (known.length === 0) return "";
  return known.map((id) => `<a class="ref" data-req-link="${esc(id)}">${esc(id)}</a>`).join("・");
}

/**
 * 対象レコードの一覧（ID＋タイトル。導入スライド。施主指示 2026-08-07）。
 * ctx.byId に実在しない ID は無視する（req lint に委ねる）。
 */
function renderTargetIdList(ids: string[], ctx: TreeContext): string {
  const items = ids
    .map((id) => ctx.byId.get(id))
    .filter((r): r is ReqRecord => r !== undefined)
    .map((r) => `<li><a class="ref" data-req-link="${esc(r.id)}">${esc(r.id)}</a> ${esc(r.title)}</li>`)
    .join("");
  return items === "" ? "" : `<ul class="story-target-list">${items}</ul>`;
}

/** ユースケース1件分のステップ仕様。kind: "self" は U 自身の裁定、"sr" は traces_to の SR。 */
interface UseCaseStepSpec {
  kind: "self" | "sr";
  srId: string | null;
  records: ReqRecord[];
}

/**
 * U の traces_to から SR ごとのステップを組み立てる（SOL-46 (c)）。SR の並びは traces_to の
 * 宣言順（ID 昇順に並べ替えない——U の書き手が意図した参照順を尊重する）。同じ SR が
 * traces_to に重複しても1ステップにまとめる。各 SR ステップの records は
 * [その SR, その SR に traces_to で遡及する solution_requirement を compareIds 順で列挙]。
 * traces_to のうち stakeholder_requirement でない、または正本に実在しない ID は無視する
 * （req lint に委ねる）。
 */
function buildUseCaseSteps(u: ReqRecord, ctx: TreeContext, records: ReqRecord[]): UseCaseStepSpec[] {
  const steps: UseCaseStepSpec[] = [{ kind: "self", srId: null, records: [u] }];
  const seenSr = new Set<string>();
  for (const srId of u.tracesTo) {
    if (seenSr.has(srId)) continue;
    const sr = ctx.byId.get(srId);
    if (!sr || sr.kind !== "stakeholder_requirement") continue;
    seenSr.add(srId);
    const sols = records
      .filter((r) => r.kind === "solution_requirement" && r.tracesTo.includes(srId))
      .sort((a, b) => compareIds(a.id ?? "", b.id ?? ""));
    steps.push({ kind: "sr", srId, records: [sr, ...sols] });
  }
  return steps;
}

/** ステップ群に登場する全レコード ID（記述順・重複除去）。選択画面の関連レコード列挙・
 * 導入スライドの対象一覧の元データに使う（storyRecordIds と同趣旨。SR-24）。 */
function useCaseStepAllIds(steps: UseCaseStepSpec[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const step of steps) {
    for (const r of step.records) {
      if (r.id !== null && !seen.has(r.id)) {
        seen.add(r.id);
        ids.push(r.id);
      }
    }
  }
  return ids;
}

/** ユースケースレビュー選択スライド（一覧。クリックで各 U の導入スライドへジャンプ）。
 * U レコードが1件も無い正本では、/req-usecase への案内バナーを出す（SOL-46 (g)。stories.json
 * 未作成時のバナーと同じ様式を踏襲する）。 */
function renderUseCaseSelectSlide(
  useCases: ReqRecord[],
  stepsByU: Map<string, UseCaseStepSpec[]>,
  introIndexByU: number[],
  ctx: TreeContext,
): string {
  const parts: string[] = ['<section class="slide" id="slide-usecase-select" data-mode="usecase">'];
  parts.push("<h2>ユースケースレビュー — 選択</h2>");
  parts.push(
    renderSlideGuide("レビューしたいユースケースを選んで開始してください。IDにマウスを乗せると内容を確認できます。"),
  );
  // モード説明パネル（SOL-53）: 3 モードで同じ様式・同じ位置（ガイダンス直下・一覧の前）。
  parts.push(renderModeIntro("usecase"));
  if (useCases.length === 0) {
    parts.push(
      '<div class="story-fallback-banner">正本に use_case（U）レコードがまだありません。' +
        "<code>/req-usecase</code> スキルを実行すると、アクターの目的単位で U レコードを仮決めで" +
        "執筆できます。</div>",
    );
  } else {
    parts.push('<ul class="story-select-list">');
    useCases.forEach((u, i) => {
      const idx = introIndexByU[i];
      const gotoAttr = nsHandlerAttr("REQ_GUIDED", "onclick", `gotoSlide(${idx});`);
      const steps = stepsByU.get(u.id ?? "") ?? [];
      const memberHtml = renderMemberIdList(useCaseStepAllIds(steps), ctx);
      parts.push(
        `<li class="story-select-item"><div class="story-select-row" ${gotoAttr}>` +
          `<a href="#" ${gotoAttr}>${esc(u.id)} ${esc(u.title)}</a>` +
          `<span class="story-select-meta">${steps.length} ステップ</span>` +
          `<a href="#" class="story-select-start" ${gotoAttr}>このユースケースをレビュー開始 →</a>` +
          "</div>" +
          (memberHtml !== "" ? `<div class="story-select-members">${memberHtml}</div>` : "") +
          "</li>",
      );
    });
    parts.push("</ul>");
  }
  parts.push("</section>");
  return parts.join("");
}

/** ユースケース1件の導入スライド（U 本文＝アクター・事前/事後条件・主フロー・代替/例外フローの
 * 描画。既存の md→HTML 変換ヘルパ renderBodyMarkdown を通す。SOL-46 (c)）。 */
function renderUseCaseIntroSlide(u: ReqRecord, ucIdx: number, steps: UseCaseStepSpec[], ctx: TreeContext): string {
  const parts: string[] = [`<section class="slide" id="slide-usecase-${ucIdx}-intro" data-mode="usecase">`];
  parts.push(`<h2>${esc(u.id)} ${esc(u.title)}</h2>`);
  parts.push(
    renderSlideGuide("このユースケースの流れと対象を確認し、「次へ」で最初のステップに進んでください。"),
  );
  // ユースケース図（SOL-49）: アクター節から決定的生成した SVG を本文冒頭に添える。
  // アクター節が無い・パース不能なら空文字列（本文のみ表示・生成は失敗させない）。
  parts.push(renderUseCaseDiagram(u));
  // 図にできなかった理由は黙って捨てず画面に出す（施主裁定 2026-08-14。イシュー 01）。
  // 「図が出ない」ではなく「成功したように見えて一部だけ描く」形で壊れると気づけないため。
  const actorNote = diagnoseUseCaseActors(u);
  if (actorNote !== null) {
    parts.push(`<p class="usecase-actor-warning">図に出せなかったアクター: ${esc(actorNote)}</p>`);
  }
  const bodyText = u.body.replace(/^\n+|\n+$/g, "");
  parts.push(
    bodyText === "" ? '<p class="no-records">（本文なし）</p>' : `<div class="md-body">${renderBodyMarkdown(bodyText)}</div>`,
  );
  parts.push(`<p class="story-step-progress">全 ${steps.length} ステップ。</p>`);
  const targetIds = useCaseStepAllIds(steps).filter((id) => id !== u.id);
  if (targetIds.length > 0) {
    parts.push('<p class="story-target-intro">このユースケースでは以下の要求・要件についてレビューしていきます。</p>');
    parts.push(renderTargetIdList(targetIds, ctx));
  }
  parts.push("</section>");
  return parts.join("");
}

/** ユースケースレビューのステップ識別キー（ステッパー・進捗・一括確認の対象キーに使う）。 */
function useCaseStepKey(u: ReqRecord, stepIdx: number): string {
  return `usecase:${u.id}:${stepIdx}`;
}

/**
 * ユースケースレビューのステップ1ステップ分の説明文（器の定型文。SOL-46 (c)（d）
 * ——AI が実行時に生成するものではなく、コード起草の決定的な文言）。SR への参照は素の
 * ID 表記で埋め込み、autolinkReqIds／enrichReqLinkLabels で参照リンク化＋タイトル併記する
 * （ストーリーレビューの narration と同じ変換。既に安全な固定文言のため sanitizeHtmlFragment
 * は不要——ユーザー入力や AI 執筆物ではない）。
 */
function renderUseCaseStepNarration(step: UseCaseStepSpec, ctx: TreeContext): string {
  const raw =
    step.kind === "self"
      ? "このユースケース自体の妥当性——この流れで目的が達成できるか——を裁定します。"
      : `(${step.srId}) はこのユースケースの根拠となる要求です。この要求に遡及する要件もあわせて示します。`;
  return enrichReqLinkLabels(autolinkReqIds(raw, ctx.byId), ctx.byId);
}

/** ユースケースレビューの1ステップのスライド（説明文＋レコードカード群＋要レビュー一括確認＋
 * 確認済みボタン）。裁定 UI は二重実装しない（renderRefRecordCard を再利用し、review-box を
 * 持たない。網羅レビューの正準カードへ gotoCanonicalRecord でジャンプする。SOL-46 (e)）。 */
function renderUseCaseStepSlide(
  u: ReqRecord,
  ucIdx: number,
  stepIdx: number,
  totalSteps: number,
  step: UseCaseStepSpec,
  ctx: TreeContext,
): string {
  const slideId = `slide-usecase-${ucIdx}-step-${stepIdx}`;
  const parts: string[] = [`<section class="slide" id="${slideId}" data-mode="usecase">`];
  parts.push(`<h2>${esc(u.id)} ${esc(u.title)} — ステップ ${stepIdx + 1} / ${totalSteps}</h2>`);
  parts.push(
    renderSlideGuide(
      "語りを踏まえて各要求を判定してください。問題なければ「このステップの要レビューをまとめて確認」が使えます。",
    ),
  );
  parts.push(`<div class="story-narration md-body">${renderUseCaseStepNarration(step, ctx)}</div>`);

  step.records.forEach((r, recIdx) => {
    parts.push(renderRefRecordCard(r, `uc-${ucIdx}-${stepIdx}-${recIdx}`));
  });

  const stepKey = useCaseStepKey(u, stepIdx);
  const reviewRequiredIds = step.records
    .filter(isReviewRequired)
    .map((r) => r.id)
    .filter((id): id is string => id !== null)
    .sort(compareIds);
  if (reviewRequiredIds.length > 0) {
    parts.push(renderBulkApproveBlock(stepKey, reviewRequiredIds, "ステップ"));
  }

  parts.push('<div class="story-step-done-bar">');
  parts.push(
    `<button type="button" class="section-done-btn" ${nsHandlerAttr(
      "REQ_GUIDED",
      "onclick",
      `finishSectionAndNext(${esc(JSON.stringify(stepKey))});`,
    )}>このステップを確認済みにして次へ</button>`,
  );
  parts.push('<span class="section-done-note">進捗はブラウザ（localStorage）に保存されます。</span>');
  parts.push("</div>");

  parts.push("</section>");
  return parts.join("");
}

/**
 * レコード id → 所属するユースケース・ステップの一覧（StoryMembership と同趣旨。SOL-46 (f)）。
 * buildUseCaseDeck がステップ構成を組み立てる際に一度だけ積む（並びは決定的:
 * ユースケース ID 昇順・ステップ記述順）。網羅レビューの正準カード（renderRecordCard）に
 * 所属バッジとして表示する。
 */
interface UseCaseMembership {
  ucId: string;
  /** 0始まりのステップ番号（バッジ表示は 1 始まりに変換する）。 */
  stepIdx: number;
}

/** レコードカードの種別バッジ列に添える所属ユースケースバッジ（例: `U-1(2)`）。所属が無い
 * レコード（id が null、またはどのユースケースにも登場しない）は空文字を返す。 */
function renderUseCaseMembershipBadges(id: string | null, membership: Map<string, UseCaseMembership[]>): string {
  if (id === null) return "";
  const entries = membership.get(id);
  if (!entries || entries.length === 0) return "";
  return entries
    .map(
      (e) =>
        `<span class="story-badge" title="所属: ${esc(e.ucId)} のステップ ${e.stepIdx + 1}">${esc(e.ucId)}(${e.stepIdx + 1})</span>`,
    )
    .join("");
}

/**
 * ユースケースレビューデッキ（選択スライド＋各 U の導入＋ステップ）を組み立てる。U レコードは
 * ID 昇順（compareIds）で並べる（SOL-46 (b)）。各 U の導入スライドがデッキ内で何番目か
 * （0=選択スライド）を先に計算し、選択スライドのリンク・ステッパーの両方に使う
 * （buildStoryDeck と同じ手順）。
 */
function buildUseCaseDeck(
  records: ReqRecord[],
  ctx: TreeContext,
): { slides: string[]; metas: StepperSlideMeta[]; ucMembership: Map<string, UseCaseMembership[]> } {
  const useCases = records
    .filter((r): r is ReqRecord => r.kind === "use_case" && r.id !== null)
    .sort((a, b) => compareIds(a.id ?? "", b.id ?? ""));

  const stepsByU = new Map<string, UseCaseStepSpec[]>();
  for (const u of useCases) {
    stepsByU.set(u.id as string, buildUseCaseSteps(u, ctx, records));
  }

  const introIndexByU: number[] = [];
  let cursor = 1; // 0 は選択スライド
  for (const u of useCases) {
    introIndexByU.push(cursor);
    const steps = stepsByU.get(u.id as string) ?? [];
    cursor += 1 + steps.length;
  }

  const slides: string[] = [renderUseCaseSelectSlide(useCases, stepsByU, introIndexByU, ctx)];
  // 選択スライドは範囲未確定（group なし）。範囲限定デッキではデッキ全体の件数を出さない。
  const metas: StepperSlideMeta[] = [{ key: null, label: "選", title: "ユースケース選択" }];
  const ucMembership = new Map<string, UseCaseMembership[]>();

  useCases.forEach((u, ucIdx) => {
    const steps = stepsByU.get(u.id as string) ?? [];
    const uId = u.id as string;
    slides.push(renderUseCaseIntroSlide(u, ucIdx, steps, ctx));
    // ステッパーは選択中のユースケースの範囲だけを表示する（SOL-46 (f)）。group は U の ID、
    // 丸の中は導入=「導」・以降は U 内のステップ番号にする（デッキ全体の通し番号にしない）。
    metas.push({ key: null, group: uId, label: "導", title: `${uId} 導入` });
    steps.forEach((step, stepIdx) => {
      slides.push(renderUseCaseStepSlide(u, ucIdx, stepIdx, steps.length, step, ctx));
      metas.push({
        key: useCaseStepKey(u, stepIdx),
        group: uId,
        label: String(stepIdx + 1),
        title: `${uId} ステップ ${stepIdx + 1} / ${steps.length}`,
      });
      for (const r of step.records) {
        if (r.id === null) continue;
        const list = ucMembership.get(r.id) ?? [];
        list.push({ ucId: u.id as string, stepIdx });
        ucMembership.set(r.id, list);
      }
    });
  });

  return { slides, metas, ucMembership };
}

/**
 * 通読レビュービューを生成する。`opts.fragment` を渡すとバンドル（req_bundle.ts）用の
 * フラグメント（{ styles, html, script }）を返す。省略時（スタンドアロン）は従来どおり
 * 完全 HTML の文字列を返し、挙動・出力バイトは不変（ADR-013 段階2）。
 */
export function buildGuidedHtml(root: string): string;
export function buildGuidedHtml(
  root: string,
  opts: BuildOpts & { fragment: NonNullable<BuildOpts["fragment"]> },
): FragmentResult;
export function buildGuidedHtml(root: string, opts?: BuildOpts): string | FragmentResult;
export function buildGuidedHtml(root: string, opts?: BuildOpts): string | FragmentResult {
  const result = loadRecords(root);
  if (result.errors.length > 0) {
    throw new Error("req_guided: 正本の読み込みに失敗しました:\n" + result.errors.join("\n"));
  }

  const records = result.records;
  const ctx = buildContext(records);
  const sections = flattenSections(records, ctx);

  // 要レビュー総件数（tree の .review-filter-count と同じ見た目のチップ。生成時点の
  // 実データから数える。ハードコードしない）。
  const reviewRequiredCount = records.filter(isReviewRequired).length;

  // SOL-37: 下書きモードの localStorage キー・「すべてコピー」出力の対象表記に使う
  // プロジェクト識別子・正本の版・生成日（changelog 由来。決定的）。
  const projectMeta = computeProjectMeta(root);

  const changelogHead = readChangelogHead(root);
  const currentVersionText =
    changelogHead !== null ? `v${changelogHead.version}（${changelogHead.date}）` : "不明（changelog未検出）";
  // ユースケースレビュー（SOL-46 / SR-51）: 正本（use_case レコードの本文と traces_to）だけから
  // 決定的に導出する。カードの裁定 UI は二重実装しない（網羅レビューの正準カードへジャンプする
  // renderRefRecordCard を再利用する）。
  const useCaseDeck = buildUseCaseDeck(records, ctx);
  // 網羅レビューのステッパー（SOL-53）: 他 2 モードと同じ範囲限定にする。範囲は分類（節が収める
  // レコード種別）で、丸の中は範囲内の局所番号。表紙・目次は範囲を持たない入口スライド
  // （選択スライドと同じ扱い＝「表」「目」）。
  const sectionGroupCounters = new Map<string, number>();
  const sectionStepperMetas: StepperSlideMeta[] = [
    { key: null, label: "表", title: "表紙" },
    { key: null, label: "目", title: "目次" },
    ...sections.map((sec) => {
      const group = sectionGroupName(sec, ctx);
      const n = (sectionGroupCounters.get(group) ?? 0) + 1;
      sectionGroupCounters.set(group, n);
      return { key: sec.id, group, label: String(n), title: `${group}: ${sec.id ?? ""} ${sec.title}` };
    }),
  ];

  // ADR-013 段階2: 完全 HTML の外枠（doctype/head/body）と本文コンテンツ（bodyParts）の
  // 組み立てを分離した（req_tree.ts と同じ規約。標準出力はバイト不変）。
  const bodyParts: string[] = [];
  // ヘッダは全ビュー共通（renderSiteHeader）。以前はここだけ `.topbar` という独自の
  // ラッパーに h1 を入れていた（施主指摘 2026-07-28「各ページのヘッダが不統一」）。
  // guided 固有の要素（要レビュー件数チップ・スライド進捗・下書き件数チップ/コピー/クリア）は
  // extraHtml で末尾に差し込む。
  bodyParts.push(
    renderSiteHeader({
      view: "guided",
      subtitle: "網羅レビュー",
      extraHtml:
        '<span class="spacer"></span>' +
        `<span class="review-filter-count">要レビュー ${reviewRequiredCount} 件</span>` +
        '<span class="progress" id="slide-progress">1 / 1</span>' +
        renderDraftToolbarExtra("REQ_GUIDED"),
    }),
  );
  // 順序モード切替＋ステッパー（SOL-41 改訂 2026-08-11）。トップバー直下・.slides の前に置く
  // 固定バー。ステッパーは網羅レビュー・ユースケースの両デッキ分を常に生成し、実行時 JS
  // （refreshStepper）が現在のモードのものだけを表示する（決定性優先）。
  bodyParts.push('<div class="order-bar">');
  bodyParts.push(renderOrderModeBar());
  bodyParts.push(renderStepper("section", sectionStepperMetas));
  bodyParts.push(renderStepper("usecase", useCaseDeck.metas));
  bodyParts.push("</div>");
  // SOL-37: 下書きモードの必読の注意書き（送信されないこと・すべてコピーで回収すること）。
  // オンライン時は非表示のまま（initDraftMode が何もしない）。スライドは絶対配置で
  // 重なるため、この注意書きはどのスライドが active でも常に見える位置（ヘッダ直下）に置く。
  bodyParts.push(renderDraftNoticeBlock(projectMeta));
  // 下書きプレビューのフローティングパネル（施主指示「オフラインレビューした内容を
  // プレビューできるように」）。tree と同じマークアップ・JS を共有する（SR-24）。
  bodyParts.push(renderDraftPreviewPanel("REQ_GUIDED"));
  // サーバ接続 heartbeat の切断モーダル（SOL-51 / SR-60）。既定非表示、initHeartbeat が
  // window.__REVIEW_ENDPOINT__ 注入時のみ起動する。
  bodyParts.push(renderConnectionLostModal());

  const reverseTraces = buildReverseTracesMap(records);

  // 右サイドバー（SOL-50 (b)）: 網羅レビューのデッキと同じスクロール領域（.main-area）に並べる
  // （既存の .slides / .navbar のレイアウトと共存させる。SOL-50 (b)）。
  const sidebarEntries = buildSidebarEntries(sections, ctx, useCaseDeck.ucMembership);

  bodyParts.push('<div class="main-area">');
  bodyParts.push('<div class="slides">');
  bodyParts.push(renderCoverSlide(records, sections));
  bodyParts.push(renderTocSlide(sections, ctx));
  sections.forEach((sec, idx) => {
    bodyParts.push(
      renderSectionSlide(sec, ctx, idx + 1, sections.length, reverseTraces, useCaseDeck.ucMembership),
    );
  });
  // ユースケースレビューデッキ（SOL-46）。網羅レビューのデッキと同じ .slides コンテナに同居し、
  // data-mode="usecase" で識別する（実行時 JS がモードごとに display を切替える）。
  bodyParts.push(...useCaseDeck.slides);
  bodyParts.push("</div>");
  bodyParts.push(
    renderSidebar(sidebarEntries, ctx, {
      ns: "REQ_GUIDED",
      onClickExpr: (jsId) => `gotoCanonicalRecord(${jsId});`,
      note: "網羅レビューの全レコード",
    }),
  );
  bodyParts.push("</div>");

  bodyParts.push('<div class="navbar">');
  bodyParts.push(`<button type="button" id="nav-prev" ${nsHandlerAttr("REQ_GUIDED", "onclick", "prevSlide();")}>← 前へ</button>`);
  bodyParts.push(`<button type="button" id="nav-next" ${nsHandlerAttr("REQ_GUIDED", "onclick", "nextSlide();")}>次へ →</button>`);
  bodyParts.push('<span class="nav-hint">キーボードの ←→ キーでも移動できます。</span>');
  bodyParts.push("</div>");

  // ホバーバルーン（SOL-41）: ストーリー順モードの intro/narration に埋め込まれた
  // data-req-link を解決するためのデータ島（req_document.ts と同じ規約。SR-24）。
  bodyParts.push(renderJsonScript("req-balloon-data", buildBalloonData(records)));

  const bodyHtml = bodyParts.join("\n");

  if (opts?.fragment) {
    validateFragmentOpts(opts.fragment);
    const { idp, ns, rootClass } = opts.fragment;
    return {
      styles: scopeCss(CSS, rootClass, ns),
      html: `<div class="${rootClass}">${prefixFragmentIds(bodyHtml, idp)}</div>`,
      script: scopeScript(JS, idp, rootClass),
    };
  }

  const parts: string[] = [];
  parts.push("<!doctype html>");
  parts.push('<html lang="ja">');
  parts.push("<head>");
  parts.push('<meta charset="UTF-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
  parts.push(`<title>${pageTitle("guided", "網羅レビュー")}</title>`);
  parts.push(`<style>\n${CSS}\n</style>`);
  parts.push("</head>");
  parts.push("<body>");
  parts.push(bodyHtml);
  parts.push(`<script>\n${JS}\n</script>`);
  parts.push("</body>");
  parts.push("</html>");
  return parts.join("\n") + "\n";
}

function main(): number {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      out: { type: "string" },
    },
  });
  const root = values.root ?? defaultRoot();
  const out = values.out ?? defaultOut();

  const htmlText = buildGuidedHtml(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, htmlText, "utf-8");
  console.log(`req_guided: ${out} を生成しました。`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
