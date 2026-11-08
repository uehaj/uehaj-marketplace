#!/usr/bin/env node
/**
 * req_bundle.ts — docs/requirements/ 正本から3ビュー（文書・ツリー・通読レビュー）を
 * 1枚の自己完結 HTML に束ねた「バンドル」を一方向生成する（SOL-38 / ADR-013）。
 *
 * 方式（ADR-013 裁定。CSP で iframe を禁止する配信先の出現を受け ADR-012 の iframe srcdoc
 * 方式を supersede）: iframe を使わず、単一ドキュメントに3ビューを同居させる。各ビューは
 * buildDocumentHtml/buildHtml/buildGuidedHtml を「フラグメントモード」
 * （opts.fragment = { idp, ns, rootClass }）で呼び、`{ styles, html, script }` を受け取る
 * （関数を呼ぶ＝常に正本と同期する。生成物ファイルを読まない。SR-24 の二重実装回避の徹底）。
 * フラグメント化そのもの（id/href/name/for/aria-labelledby への idp 付与・CSS の
 * rootClass 配下スコープ化・実行時 JS の IDP/ROOT 差し替え）は scripts/req_fragment.ts と
 * 各ビューの buildXxxHtml が担う（ADR-013 段階2で実装済み）。本ファイル（段階3）の責務は
 * 3ビュー分のフラグメントを固定順（doc → tree → guided）で合成し、最小限のシェル
 * （ペイン表示切替＋ハッシュルーティングのみ。独自タブバー・ヘッダーは持たない）を
 * 追加することに限られる。
 *
 * 3ビューの完全隔離は、iframe ではなく次の組み合わせで実現する（ADR-013）:
 *   - idp（"doc-"/"tree-"/"guided-"）による id/href/name/for/aria-labelledby の重複回避
 *   - rootClass（"doc-root"/"tree-root"/"guided-root"）による CSS スコープ化・
 *     実行時 JS の ROOT 解決
 *   - ns（"REQ_DOC"/"REQ_TREE"/"REQ_GUIDED"。req_tree.ts の viewNamespace() が導出）による
 *     window.REQ_* 名前空間の分離（onclick 属性は元より `REQ_TREE.selectNode(...)` の形で
 *     名前空間経由。段階1で確立済み）
 * この3点がビュー毎に一意であることは各ビュー側の validateFragmentOpts が生成時に検査する。
 *
 * ペイン切替: 3ビューのフラグメント html は生成時点で常に全て DOM 上に存在する
 * （遅延生成ではなく、同一入力→バイト同一の決定性を最優先する。SOL-38 の verification が
 * 求める「同一入力でバイト同一」を、実行時 JS の分岐に依存せず生成 HTML 自体の構造で
 * 保証する）。表示切替は `.reqview-pane.show` の付け外しのみ（display の on/off。
 * transform/filter/will-change は使わない — 各ビューの `.trace-overlay` / `.modal-backdrop` /
 * `.draft-preview-panel` が `position: fixed` を使っており、祖先に transform/filter が付くと
 * その祖先自身が containing block になってしまい、fixed 要素がビューポート基準で
 * 配置されなくなるため。ADR-013 の帰結）。
 *
 * ハッシュルーティング（window.__reqBundleGo(pane)。2階建て）: `#<pane>` または
 * `#<pane>/<rest>` の先頭セグメントだけをペイン選択に使い、`<rest>` 部分（各ビュー自身が
 * 将来使うかもしれない内部ハッシュ）には一切手を触れない。先頭セグメントが既知のペイン名
 * （doc/tree/guided）でなければ「無視」する（起動時のみ既定ペイン doc へフォールバックし、
 * 起動後の hashchange では現在のペイン表示を変えない。既定ペインへ強制的に落とさない。
 * ADR-013 段階2の申し送り事項3）。ペイン内リンク（`.node`/`.reflink` 等）は onclick 側で
 * 常に `return false` するため、通常操作でこの2階建て構造がハッシュに現れることはない
 * （`.cross-jump` は file:// 単体閲覧と同じ理由で既定非表示のまま。段階3の対象外）。
 *
 * 各ビューを可視化する直前に必ず display を切り替え、その後で `<ns>.activate()`
 * （幾何計測の再計算。ADR-013）を呼ぶ（順序が重要。ADR-013 段階2の rootIsVisible() は
 * `ROOT.getClientRects().length > 0` で判定するため、display 切替前に activate() を呼ぶと
 * ゼロボックスで計測してしまい、ツリーの divider・トレース矢印オーバーレイが誤った位置で
 * 初期化される）。
 *
 * postMessage は一切使わない（3ビューは同一 window・同一 document・同一 localStorage を
 * 共有するため元より不要。iframe 廃止に伴い ADR-012 のストレージブリッジ・
 * `__reqBundleNav` postMessage・`window.__REQ_BUNDLE_VIEW__` 注入はすべて削除した）。
 *
 * 生成は決定的（同一入力 → バイト同一の出力）。タイムスタンプ・乱数は埋め込まない。
 * 版・日付・プロジェクト識別子は req_tree.ts の computeProjectMeta（changelog.md 由来）を
 * そのまま使う（二重実装を避ける。SR-24）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import {
  esc,
  SITE_NAME,
  computeProjectMeta,
  viewNamespace,
  buildHtml as buildTreeHtml,
} from "./req_tree.ts";
import { buildDocumentHtml } from "./req_document.ts";
import { buildGuidedHtml } from "./req_guided.ts";
import type { FragmentResult } from "./req_fragment.ts";

function defaultRoot(): string {
  // 既定の対象は呼び出し元プロジェクト（プラグイン自身の正本を黙って対象にしない）
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

function defaultOut(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "generated", "バンドル.html");
}

// ---------------------------------------------------------------------------
// ペイン定義（固定順。doc → tree → guided。styles/pane div/script のいずれもこの順で
// 配置する。stage 5 の決定性検査・構造検査の対象）
// ---------------------------------------------------------------------------

type PaneId = "doc" | "tree" | "guided";

/** idp・rootClass・ns は id ごとに1箇所（ここ）だけで決める。build 側は必ずこの3値を
 *  読んで FragmentOpts を組み立てる（値をクロージャに個別リテラルで埋め込むと、
 *  片方だけ書き換えて他方を直し忘れる事故の余地が生まれるため、単一の入力にする）。 */
interface PaneDef {
  id: PaneId;
  idp: string;
  rootClass: string;
  ns: string;
  rawBuild: (root: string, opts: { fragment: { idp: string; ns: string; rootClass: string } }) => FragmentResult;
}

const PANE_DEFS: readonly PaneDef[] = [
  { id: "doc", idp: "doc-", rootClass: "doc-root", ns: viewNamespace("document"), rawBuild: buildDocumentHtml },
  { id: "tree", idp: "tree-", rootClass: "tree-root", ns: viewNamespace("tree"), rawBuild: buildTreeHtml },
  { id: "guided", idp: "guided-", rootClass: "guided-root", ns: viewNamespace("guided"), rawBuild: buildGuidedHtml },
];

function buildPane(root: string, def: PaneDef): FragmentResult {
  return def.rawBuild(root, { fragment: { idp: def.idp, ns: def.ns, rootClass: def.rootClass } });
}

// ---------------------------------------------------------------------------
// 親シェルの CSS（外部依存ゼロ・自己完結。3ビュー本体の CSS には各ビューの
// scopeCss 済み styles を追加で連結する。セレクタは重複しない前提 — rootClass が
// ビューごとに一意なため）
// ---------------------------------------------------------------------------

const SHELL_CSS = `* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { font-family: "Hiragino Sans", "Yu Gothic", sans-serif; color: #222; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.bundle-main { flex: 1 1 auto; position: relative; }
.reqview-pane { display: none; position: absolute; inset: 0; width: 100%; height: 100%; overflow: auto; }
.reqview-pane.show { display: block; }
`;

// ---------------------------------------------------------------------------
// 親シェルの JS。トップレベルの名前空間汚染を避けるため IIFE 1個に包む（3ビューの
// window.REQ_* IIFE と同じ規約。段階5 の「3 IIFE 外にトップレベル function 0」検査の対象）。
// 公開 API は window.__reqBundleGo(pane) のみ（各ビュー側の initBundleNav が直接呼ぶ。
// 段階4）。postMessage は使わない（同一 window のため不要）。
// ---------------------------------------------------------------------------

const SHELL_JS = `(function () {
var PANE_IDS = ['doc', 'tree', 'guided'];
var PANE_NS = { doc: 'REQ_DOC', tree: 'REQ_TREE', guided: 'REQ_GUIDED' };
function showPane(pane) {
  PANE_IDS.forEach(function (p) {
    var el = document.getElementById('pane-' + p);
    if (el) { el.classList.toggle('show', p === pane); }
  });
}
// activate() は必ず showPane() の後に呼ぶ（display 切替→幾何計測の順序。ADR-013
// 段階2の rootIsVisible() が ROOT.getClientRects() ベースのため、非表示のまま呼ぶと
// ゼロボックスで計測してしまう）。
function activatePane(pane) {
  showPane(pane);
  var ns = window[PANE_NS[pane]];
  if (ns && typeof ns.activate === 'function') { ns.activate(); }
}
// 2階建てハッシュ（#<pane> または #<pane>/<rest>）の先頭セグメントだけを見る。
// <rest> 部分には一切手を触れない（将来のペイン内ディープリンクのための余地。
// 本段階では消費しない）。
function currentPaneFromHash() {
  var raw = location.hash ? location.hash.slice(1) : '';
  var slash = raw.indexOf('/');
  return slash === -1 ? raw : raw.slice(0, slash);
}
// 公開 API: 各ビューの .view-tabs クリック（initBundleNav。段階4）から直接呼ばれる。
// 現在のペインと異なる場合だけハッシュを書き換える（#<pane>/<rest> の <rest> を
// 不必要に消し飛ばさない — 既に目的のペインにいる場合は何もしない）。
window.__reqBundleGo = function (pane) {
  if (PANE_IDS.indexOf(pane) === -1) { return; }
  if (currentPaneFromHash() !== pane) { location.hash = '#' + pane; }
  activatePane(pane);
};
// 各ビューの initBundleNav（自身の .view-tabs を表示しクリックを window.__reqBundleGo
// 経由に差し替える。req_tree.ts の BUNDLE_NAV_JS。3ビュー共通）は window.__reqBundleGo
// の存在だけで有効化を判定するため、この呼び出しは必ず window.__reqBundleGo を定義した
// 「あと」でなければならない（3ビューのスクリプトはシェルより先に実行されるため、各ビュー
// 自身の IIFE 内からの initBundleNav() 呼び出しは早期 return で無害に終わる —
// スタンドアロン/サーバ配信で window.__reqBundleGo が定義されないままなのと同じ経路。
// タブを実際に表示させるのはここでの呼び出しだけ）。
PANE_IDS.forEach(function (p) {
  var ns = window[PANE_NS[p]];
  if (ns && typeof ns.initBundleNav === 'function') { ns.initBundleNav(); }
});
// hashchange: 先頭セグメントが既知のペイン名でなければ無視する（既定ペインへ落とさない。
// ADR-013 段階2の申し送り事項3）。
function handleHashChange() {
  var pane = currentPaneFromHash();
  if (PANE_IDS.indexOf(pane) === -1) { return; }
  activatePane(pane);
}
// 起動時のみ、未知/空のハッシュは既定ペイン doc にフォールバックする（この時点では
// 「現在のペイン」というものがまだ存在しないため、hashchange とは扱いが異なる）。
function bootstrap() {
  var pane = currentPaneFromHash();
  if (PANE_IDS.indexOf(pane) === -1) { pane = 'doc'; }
  activatePane(pane);
}
window.addEventListener('hashchange', handleHashChange);
bootstrap();
})();
`;

export function buildBundleHtml(root: string): string {
  const panes = PANE_DEFS.map((def) => ({ def, frag: buildPane(root, def) }));
  const meta = computeProjectMeta(root);

  const parts: string[] = [];
  parts.push("<!doctype html>");
  parts.push('<html lang="ja">');
  parts.push("<head>");
  parts.push('<meta charset="UTF-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
  parts.push(`<title>${esc(meta.projectId)} ${esc(meta.version)}（バンドル） — ${esc(SITE_NAME)}</title>`);
  parts.push(`<style>\n${SHELL_CSS}\n${panes.map((p) => p.frag.styles).join("\n")}\n</style>`);
  parts.push("</head>");
  parts.push("<body>");

  // 親ページは最小のシェル（ペインの表示切替のみ）。ビュー切替のナビ自体は各ビュー内の
  // .view-tabs（initBundleNav。段階4）が担うため、独自のタブバー・ヘッダーは持たない
  // （ADR-012 時代の施主指示 2026-08-04「もともとのようにページ上部ナビバー的に」を
  // 単一ドキュメント化後も維持する）。
  parts.push('<main class="bundle-main">');
  for (const { def, frag } of panes) {
    parts.push(`<div class="reqview-pane" id="pane-${def.id}" data-pane="${def.id}">${frag.html}</div>`);
  }
  parts.push("</main>");

  // 実行時 JS: 3ビュー分のスクリプト（window.REQ_DOC/REQ_TREE/REQ_GUIDED を定義する）を
  // 先に置き、シェルの JS（window.__reqBundleGo 等。3ビューの名前空間を参照する）を最後に
  // 置く（依存順）。
  for (const { frag } of panes) {
    parts.push(`<script>\n${frag.script}\n</script>`);
  }
  parts.push(`<script>\n${SHELL_JS}\n</script>`);
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

  const htmlText = buildBundleHtml(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, htmlText, "utf-8");
  console.log(`req_bundle: ${out} を生成しました。`);
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
