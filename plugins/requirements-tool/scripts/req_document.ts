#!/usr/bin/env node
/**
 * req_document.ts — docs/requirements/ 正本から「文書体裁ビュー」（レビューサーバ第3の
 * タブ。SOL-31）を一方向生成する。
 *
 * 参照実装（202604_AI_Driven_Requiment_Development/apps/req-web の「文書ビュー」）相当の
 * 内容として、章番号つきの章立て・目次・整形された本文を持つ「読み物」として読める HTML
 * を生成する。既存2ビュー（req_tree.ts のツリー、req_guided.ts のガイド付きレビュー）が
 * 種別横断・章節通読という断面であるのに対し、本ビューは「成果物としての文書」の断面
 * （SR-10 の多角的ビューの一断面）を提供する。
 *
 * 生成は決定的（同一入力 → バイト同一の出力）。タイムスタンプ・乱数は埋め込まない。
 * 版・日付は docs/requirements/meta/changelog.md の先頭 `## v… — YYYY-MM-DD` 見出しから
 * 決定的にパースするのみで、実行時刻（Date.now() 等）は使わない。
 *
 * 流用（二重実装を避ける。SR-24）: 種別ラベル（KIND_LABEL）、共通トップバー
 * （renderSiteHeader / REVIEW_TOPBAR_CSS）、版パース（readChangelogHead）、
 * ホバーバルーン一式（REQ_BALLOON_CSS/REQ_BALLOON_JS/buildBalloonData/renderJsonScript）、
 * フラグメントサニタイズ（sanitizeHtmlFragment）、素の ID 表記の自動リンク化
 * （autolinkReqIds。SOL-41 追記）、参照リンクのタイトル併記
 * （enrichReqLinkLabels。SOL-31 追記）は scripts/req_tree.ts から import して再利用する
 * （SOL-41 で req_guided.ts も同じものを使うため export された）。
 *
 * 本文（SOL-34・ADR-010）: 本文は docs/requirements/meta/narrative.html（AI が req-narrate
 * スキルの規範に従って書く本文フラグメント）を合成して作る。目次・フロート目次は
 * フラグメント内の h2/h3 を走査して決定的に生成する。
 *
 * フラグメントが無いとき（施主裁定 2026-08-05）: レコード忠実表示へのフォールバックは
 * 行わず、生成方法を示す案内パネル（renderNarrativeMissingPanel）を本文に出す。
 * 以前はフォールバックがあったため「読める体裁の何か」が常に出てしまい、本文が未執筆で
 * あることに気づけなかった。バンドルは 3 ビュー同梱の単一 HTML なので生成自体は止めない
 * （ツリー・通読レビューは本文の有無に依存しない）。この変更で章番号の算出・レコード節の
 * 転記・confidence 凡例は不要になったため削除した。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { ReqRecord, loadRecords } from "./reqlib.ts";
import {
  esc,
  KIND_LABEL,
  renderSiteHeader,
  pageTitle,
  REVIEW_TOPBAR_CSS,
  REVIEW_NAV_JS,
  REVIEW_SIDEBAR_CSS,
  REVIEW_SIDEBAR_JS,
  buildSidebarEntries,
  renderSidebar,
  buildContext,
  isConfirmed,
  BUNDLE_NAV_JS,
  readChangelogHead,
  REQ_BALLOON_CSS,
  REQ_BALLOON_JS,
  buildBalloonData,
  renderJsonScript,
  sanitizeHtmlFragment,
  enrichReqLinkLabels,
  autolinkReqIds,
} from "./req_tree.ts";
import { scopeCss, prefixFragmentIds, scopeScript, validateFragmentOpts, type BuildOpts, type FragmentResult } from "./req_fragment.ts";

function defaultRoot(): string {
  // 既定の対象は呼び出し元プロジェクト（プラグイン自身の正本を黙って対象にしない）
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

function defaultOut(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "generated", "要件定義書.html");
}

// ---------------------------------------------------------------------------
// meta/changelog.md からの版・日付の決定的パース
// ---------------------------------------------------------------------------

// meta/changelog.md の先頭見出しからの版・日付の読み取りは readChangelogHead
// （scripts/req_tree.ts から import。SOL-41 で req_guided.ts も必要になったため export
// された。二重実装を避ける。SR-24）。

// ---------------------------------------------------------------------------
// 状態バッジ（confidence）の配色・表示ラベル
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CSS（指示書指定の文書体裁スタイル。外部依存ゼロ・自己完結）
// ---------------------------------------------------------------------------

const CSS = `html { scroll-behavior: smooth; }
/* 参照の確認状態マーカー（施主指示 2026-08-11）。本文の読みを妨げない弱い表示にする
   （SOL-31 の参照様式に合わせる）。未確認はサーバ配信時に押せるボタンとして働く。 */
.req-link-state { font: inherit; font-size: .68rem; line-height: 1; vertical-align: super; margin-left: .15em; padding: .1em .3em; border-radius: 999px; border: 1px solid transparent; background: transparent; cursor: default; }
.req-link-state[data-req-state="confirmed"] { color: #2f8a56; }
.req-link-state[data-req-state="unconfirmed"] { color: #a15c00; border-color: #e6d2a8; background: #fdf6e7; }
.req-link-state[data-req-state="sending"] { color: #666; }
.req-link-state:not([disabled]) { cursor: pointer; }
.req-link-state:not([disabled]):hover { border-color: #534AB7; color: #534AB7; background: #EEEDFE; }
body { font-family: "Helvetica Neue","Hiragino Sans","Yu Gothic",sans-serif; line-height: 1.75; color: #1f2937; margin: 0; }
/* ヘッダ（.site-header）は本文カラムより先に、全幅・左寄せで置く（施主指摘 2026-07-30
   「ヘッダブロック全体が中央寄せカラムに入り、他の2ページより右へずれる」の是正）。
   本文（doc-container）だけを読み物として中央の列に収める。ヘッダ自身の左右余白は
   REVIEW_TOPBAR_CSS の .site-header が持つ（tree/guided と同じ値で揃える）。 */
.doc-container { max-width: 980px; margin: 0 auto; padding: 0 28px 2rem; }
/* 右サイドバー（未レビュー状況。施主指示 2026-08-11）。通読レビューと同じ器
   （REVIEW_SIDEBAR_CSS）を使い、レイアウトだけ文書ビューの構造に合わせる。本文は
   中央寄せのまま、サイドバーは右の帯として並べる。 */
.doc-main-area { display: flex; align-items: flex-start; gap: 0; }
.doc-main-area > .doc-container { flex: 1 1 auto; min-width: 0; }
.doc-main-area > .review-sidebar { position: sticky; top: 0; max-height: 100vh; }
/* フロート章 TOC とサイドバーは同じ右の帯を使う。サイドバーを開いている間は TOC を出さない
   （両方を並べると本文が細くなり、読み物としての体裁が崩れる）。サイドバーを畳めば
   従来どおり TOC が出る——右の帯をどちらに使うかを利用者が選べる形にする。 */
body:has(.review-sidebar:not(.collapsed)) .floating-toc { display: none; }
/* 本文に出てこないレコードの行をクリックしたときの合図（1.6 秒で消える）。 */
.review-sidebar-item.not-in-body { background: #fdf6e7; color: #a15c00; }
/* 参照までスクロールしたときの一時強調（ツリー・通読レビューの hash-highlight と同じ流儀）。 */
a[data-req-link].hash-highlight { background: #fff3bf; color: #534AB7; opacity: 1; }
/* 右サイドバー的にフロートする章 TOC（施主追加指示 2026-07-31）。既定は非表示、
   .doc-container（980px content + 左右28px padding = 1036px の中央寄せ）と重ならない
   十分な幅がある画面でのみ表示する（min-width は施主指定の目安=1280px）。
   left は「.doc-container の右端（centered box の外側）+ 24px の隙間」を viewport 幅から
   都度算出し、右端が画面外に出ないよう width 側も min() で可変にする。この式で組む限り、
   ブレークポイントの数値をどう選んでも構造的に本文カラムへ重ならない（幅が足りない時は
   TOC 自体が細くなるだけ）。 */
.floating-toc { display: none; }
@media (min-width: 1280px) {
  .floating-toc {
    display: block;
    position: fixed;
    top: 7.6rem;
    left: calc(50vw + 518px + 24px);
    width: min(230px, calc(100vw - (50vw + 518px + 24px) - 16px));
    max-height: calc(100vh - 7.6rem - 1.2rem);
    overflow-y: auto;
    box-sizing: border-box;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: .7rem .9rem;
    font-size: .8rem;
    box-shadow: 0 4px 14px rgba(0,0,0,.08);
  }
}
.floating-toc-title { margin: 0; font-size: .7rem; font-weight: 700; letter-spacing: .04em; color: #64748b; text-transform: uppercase; }
.floating-toc-list { list-style: none; margin: .4rem 0 0; padding: 0; }
.floating-toc-item { margin: .1rem 0; }
.floating-toc-item a { display: block; padding: .2rem .4rem; border-radius: 4px; line-height: 1.35; color: #245c73; text-decoration: none; }
.floating-toc-item a:hover { background: #eef2f7; }
.floating-toc-item a.active { background: #dbeafe; color: #1e3a5f; font-weight: 600; }
.floating-toc-item.depth-1 a { margin-left: .8rem; width: calc(100% - .8rem); }
.floating-toc-item.depth-2 a { margin-left: 1.6rem; width: calc(100% - 1.6rem); }
h1 { color: #1e3a5f; }
h2 { color: #245c73; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px; margin-top: 1.8em; }
h3 { color: #334155; margin-top: 1.4em; }
a.ref { color: #94a3b8; font-size: .82em; margin-left: 4px; text-decoration: none; }
a.ref:hover { color: #2563eb; }
table { border-collapse: collapse; width: 100%; margin: .8rem 0; }
th, td { border: 1px solid #cbd5e1; padding: .35rem .6rem; text-align: left; vertical-align: top; }
th { background: #e2e8f0; color: #1e3a5f; }
tr:nth-child(even) td { background: #f8fafc; }
.doc-meta { color: #64748b; font-size: .88rem; }
.badge { font-weight: 600; font-size: .82rem; padding: .05rem .4rem; border-radius: 3px; }
.status-confirmed { color: #166534; background: #f0fdf4; }
.status-tentative { color: #b45309; background: #fffbeb; }
.status-multiple { color: #7c3aed; background: #f5f3ff; }
.status-undecided { color: #b91c1c; background: #fef2f2; }
.status-unknown { color: #475569; background: #f1f5f9; }
.rationale { border-left: 4px solid #d97706; background: #fffbeb; padding: 8px 12px; font-size: .92em; }
.record-meta { color: #64748b; font-size: .82rem; }
.record-meta a { color: #64748b; }
.chapter-intro { margin: .6rem 0 1rem; }
.toc-chapter { margin: .3rem 0; }
.toc-records { list-style: none; margin: .2rem 0 .6rem; padding-left: 1.4rem; }
.toc-records li { margin: .15rem 0; font-size: .92rem; }
.doc-end { text-align: center; color: #94a3b8; margin: 3rem 0 1rem; }
/* ナラティブ・フラグメント合成（SOL-34）。本文コンテナ自体の見た目は既存の h2/h3/p 規則を
   そのまま流用し（二重実装を避ける。SR-24）、ここでは器（弱リンク・バルーン・生成時点の
   ドリフト表示）だけを追加する。 */
.narrative { margin: 0 0 1.4rem; }
.narrative-meta { margin: .2rem 0 0; }
.narrative-warning { color: #b45309; }
/* 本文フラグメント未生成時の案内パネル（施主裁定 2026-08-05。フォールバックの置き換え）。 */
.narrative-missing { margin: 1.2rem 0; }
.narrative-missing #narrative-missing { border: 1px solid #fcd34d; background: #fffbeb; border-radius: 8px; padding: .4rem 1.2rem 1.2rem; }
.narrative-missing h2 { color: #92400e; border-bottom-color: #fcd34d; margin-top: 1.2em; }
.narrative-missing h3 { color: #92400e; }
.narrative-missing-cmd { background: #1f2937; color: #f8fafc; border-radius: 6px; padding: .6rem .9rem; overflow-x: auto; }
.narrative-missing-cmd code { background: none; color: inherit; }
/* 弱参照リンク様式（req-web 取り込み1）＋ホバーバルーン（req-web 取り込み2）は
   REQ_BALLOON_CSS（scripts/req_tree.ts。SOL-41 で req_guided.ts と共有するため export
   された。二重実装を避ける。SR-24）。 */
${REQ_BALLOON_CSS}${REVIEW_TOPBAR_CSS}
${REVIEW_SIDEBAR_CSS}
`;

// ---------------------------------------------------------------------------
// 実行時 JS（レビューUI有効化・ビュー切替。req_guided.ts の initReviewUI と同じ規約）
// ---------------------------------------------------------------------------

const JS = `window.REQ_DOC = (function () {
${REVIEW_NAV_JS}
${REVIEW_SIDEBAR_JS}
var IDP = '';
var ROOT = document;
function byId(x) { return ROOT.querySelector('#' + IDP + CSS.escape(x)); }
// req_tree.ts の rootIsVisible() と同じ理由・同じ実装（祖先の display:none を正しく
// 反映するため getClientRects() を使う。getComputedStyle(ROOT).display は ROOT 自身の
// 指定値しか見ず、祖先の非表示を反映しない）。
function rootIsVisible() { return IDP === '' || ROOT.getClientRects().length > 0; }
function initReviewUI() {
  var enabled = typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '';
  var reviewerInput = byId('review-reviewer-input');
  if (reviewerInput) {
    var stored = null;
    try { stored = localStorage.getItem('reqtree:reviewerName'); } catch (e) {}
    if (stored) { reviewerInput.value = stored; }
    reviewerInput.disabled = !enabled;
    // 記名は他ビューと同じキー（reqtree:reviewerName）で保持する。文書ビューから承認できる
    // ようになったため、ここでも入力を保存する（従来は表示だけで保存していなかった）。
    reviewerInput.addEventListener('input', saveReviewerName);
  }
  // ヘッダのタブと注記は共通処理（applyReviewNav）に委ねる。配信されていればタブを出し、
  // 書き戻せるときだけ注記を隠す（判定を各ビューに書かない。SR-24）。
  applyReviewNav(ROOT, byId, enabled);
  // ビュー切替タブ・相互ディープリンク（SOL-30/SOL-31）。一時サーバ配信時のみ表示する
  // （file:// 単体閲覧では従来どおり読み取り専用の単体ビューのまま）。
  // 相互ディープリンク（SOL-30）は書き戻しの有無ではなく「行き来できるか」で決まるが、
  // 従来どおり enabled で切り替える（tree ⇄ guided はどちらも書き戻し可のビューであり、
  // 判定が分かれる場面が無い）。タブ自体は applyReviewNav が配信状態で出す。
  ROOT.querySelectorAll('.cross-jump').forEach(function (el) { el.style.display = enabled ? '' : 'none'; });
}
// 文書ビューからの確認（承認）の書き戻し（施主指示 2026-08-11「文書ビューの要件への参照で
// 『確認、未確認』がわかるようにして。そしてそこをクリックするとその項目をレビュー承認
// できるようにして」）。
//
// このビューは長らく「サーバへ一切通信しない一方向ビュー」だった（SOL-31）。読みながら
// 気づいた確認を、通読レビューへ移動せずその場で済ませられるようにするための改訂で、
// 送るのは既存の approve verdict ひとつだけ——判定の語彙も書き戻し先も増やさない
// （SOL-50 の単一状態モデルにそのまま乗る。SR-24）。
function getReviewerName() {
  var el = byId('review-reviewer-input');
  return el ? el.value.trim() : '';
}
function saveReviewerName() {
  try { localStorage.setItem('reqtree:reviewerName', getReviewerName()); } catch (e) {}
}
// 同じ ID の参照は本文中に何度でも現れる。書き戻しは 1 回で、表示はその ID の全マーカーを更新する。
function setReqLinkState(id, state, title) {
  ROOT.querySelectorAll('.req-link-state[data-req-state-id="' + id + '"]').forEach(function (btn) {
    btn.setAttribute('data-req-state', state);
    btn.setAttribute('title', title);
    btn.setAttribute('aria-label', title);
    var mark = btn.querySelector('.req-link-state-mark');
    if (mark) { mark.textContent = state === 'confirmed' ? '\u2713' : '未'; }
    btn.disabled = state === 'confirmed';
  });
}
function approveFromDocument(id, btn) {
  if (!(typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '')) { return false; }
  var reviewer = getReviewerName();
  if (!reviewer) {
    // 記名は既存のガードと同じく必須（AI も匿名も approval を確定できない。SOL-16）。
    setReqLinkState(id, 'unconfirmed', id + ': レビュアー名（記名）を入力してください');
    var input = byId('review-reviewer-input');
    if (input && input.focus) { input.focus(); }
    return false;
  }
  setReqLinkState(id, 'sending', id + ': 送信中…');
  fetch(window.__REVIEW_ENDPOINT__, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer: reviewer, items: [{ id: id, verdict: 'approve', comment: '', questions: '' }] }),
  }).then(function (res) {
    return res.text().then(function (text) { return { ok: res.ok, text: text }; });
  }).then(function (result) {
    var parsed = null;
    try { parsed = JSON.parse(result.text); } catch (e) {}
    var first = parsed && parsed.results ? parsed.results[0] : null;
    if (result.ok && first && first.ok) {
      setReqLinkState(id, 'confirmed', id + ': 確認済み');
      // サイドバーの確認状況も同時に更新する（通読レビューと同じ共有関数。SR-24）。
      setSidebarChecked(id, true);
    } else {
      var msg = (first && first.error) || (parsed && parsed.error) || '送信に失敗しました';
      setReqLinkState(id, 'unconfirmed', id + ': ' + msg);
    }
  }).catch(function (e) {
    setReqLinkState(id, 'unconfirmed', id + ': 通信に失敗しました（' + e + '）');
  });
  return false;
}
// サイドバーの行クリック（施主指示 2026-08-11）。本文中のその ID の最初の参照までスクロール
// して一時的に強調する。本文に出てこないレコード（ナラティブが触れていないもの）もあるため、
// 見つからないときはサイドバーの行にその旨を出す——黙って何も起きない操作にしない。
function gotoDocumentRecord(id) {
  var anchor = ROOT.querySelector('a[data-req-link="' + id + '"]');
  if (!anchor) {
    var row = ROOT.querySelector('.review-sidebar-item[data-side-id="' + id + '"]');
    if (row) {
      row.classList.add('not-in-body');
      setTimeout(function () { row.classList.remove('not-in-body'); }, 1600);
    }
    return false;
  }
  if (anchor.scrollIntoView) { anchor.scrollIntoView({ block: 'center' }); }
  anchor.classList.add('hash-highlight');
  setTimeout(function () { anchor.classList.remove('hash-highlight'); }, 2000);
  return false;
}
// マーカーは本文中に多数あるため、個別の onclick を焼き込まず 1 つの委譲ハンドラで受ける
// （生成物を小さく保つ。バルーンの委譲ハンドラと同じ流儀）。
function initReqLinkStates() {
  var enabled = typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '';
  ROOT.querySelectorAll('.req-link-state').forEach(function (btn) {
    // 静的閲覧（file://）では押せない——状態の表示だけを行う（既存の二態規約）。
    btn.disabled = !enabled || btn.getAttribute('data-req-state') === 'confirmed';
  });
  if (!enabled) { return; }
  // 捕捉フェーズで受ける。バルーン（initReqBalloon）の委譲ハンドラも同じ document 上に
  // あり、参照アンカーのクリックをツリービューへの遷移に変える。同じノードに登録された
  // ハンドラは stopPropagation では止まらない（登録順に全部走る）ため、先に走る捕捉
  // フェーズで受けて stopPropagation する——マーカーの押下が遷移に化けるのを防ぐ。
  ROOT.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== ROOT) {
      if (el.classList && el.classList.contains('req-link-state')) {
        e.preventDefault();
        e.stopPropagation();
        approveFromDocument(el.getAttribute('data-req-state-id'), el);
        return;
      }
      el = el.parentNode;
    }
  }, true);
}
function initFloatingToc() {
  var toc = ROOT.querySelector('.floating-toc');
  if (!toc) { return; }
  var links = Array.prototype.slice.call(toc.querySelectorAll('a[data-toc-target]'));
  if (links.length === 0) { return; }
  var byTarget = {};
  links.forEach(function (a) { byTarget[a.getAttribute('data-toc-target')] = a; });
  function setActive(id) {
    links.forEach(function (a) { a.classList.remove('active'); });
    var active = byTarget[id];
    if (active) { active.classList.add('active'); }
  }
  // id（bare な data-toc-target の値）↔ 実要素を対で持つ（{ id, el }）。フラグメント時
  // （ADR-013 段階2）は実要素の実 DOM id に idp が付くため、entry.target.id / sec.id の
  // ような「実 DOM id を読んで bare な byTarget キーと突き合わせる」実装は不一致で壊れる
  // （byTarget のキーは data-toc-target の値＝常に bare のまま。id 属性側だけ idp が付く）。
  // 要素参照そのもので突き合わせることでスタンドアロン・フラグメントの両方で正しく動く。
  var targetIds = Object.keys(byTarget);
  var sections = targetIds
    .map(function (id) { return { id: id, el: byId(id) }; })
    .filter(function (s) { return s.el; });
  if (sections.length === 0) { return; }
  if (typeof IntersectionObserver === 'function') {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) { return; }
        var match = sections.filter(function (s) { return s.el === entry.target; })[0];
        if (match) { setActive(match.id); }
      });
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
    sections.forEach(function (s) { observer.observe(s.el); });
  } else {
    // IntersectionObserver 非対応環境向けのフォールバック（scroll イベントで現在位置を推定）。
    var onScroll = function () {
      if (!rootIsVisible()) { return; }
      var pos = window.scrollY + window.innerHeight * 0.2;
      var current = sections[0];
      sections.forEach(function (s) { if (s.el.offsetTop <= pos) { current = s; } });
      setActive(current.id);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
}
// initReqBalloon（req-web 取り込み2）は REQ_BALLOON_JS（scripts/req_tree.ts。SOL-41 で
// req_guided.ts と共有するため export された。二重実装を避ける。SR-24）。
${REQ_BALLOON_JS}
(function () {
  initReviewUI();
  // SOL-38: バンドル（req_bundle.ts）に埋め込まれ、かつオンライン配信でないときだけ
  // .view-tabs を有効化し、クリックを親フレームへの postMessage に差し替える。
  initBundleNav();
  initFloatingToc();
  initReqBalloon();
  // 参照の確認状態マーカー（施主指示 2026-08-11）。バルーンより後に登録する——
  // マーカーのクリックは stopPropagation でバルーン側の委譲ハンドラへ渡さない。
  initReqLinkStates();
  // サイドバー（未レビュー状況）。折りたたみ状態・「未確認のみ」フィルタは通読レビューと
  // 同じ localStorage キーで共有する——同じ 1 つのレビューセッションの設定として扱う。
  restoreSidebarCollapsed();
  restoreSidebarFilter();
})();
${BUNDLE_NAV_JS}
// activate-on-first-show: シェル（バンドル）がこのビューを可視化した時に呼ぶフック
// （施主裁定 ADR-013）。floating-toc の追跡は IntersectionObserver（非表示中も登録済みで
// 可視化後に自動追従）または window scroll ガード（rootIsVisible）で追随するため、
// 本ビューには可視化直後に明示的な再計算が必要な幾何測定は無い（no-op）。将来必要になれば
// ここに追加する。
function activate() {}
return {
  activate: activate,
  initBundleNav: initBundleNav,
  // サイドバー（施主指示 2026-08-11）のインライン handler から呼ぶ（他ビューと同じ
  // 名前空間つき handler 規約。ADR-013）。
  gotoDocumentRecord: gotoDocumentRecord,
  toggleSidebar: toggleSidebar,
  toggleSidebarFilter: toggleSidebarFilter,
};
})();
`;

// ---------------------------------------------------------------------------
// レンダリング
// ---------------------------------------------------------------------------

/**
 * 「本書について」節（SOL-34）。本文は常にナラティブ（meta/narrative.html）由来なので、
 * 文面は 1 通りしかない（フォールバック用の文面と confidence 凡例は施主裁定 2026-08-05 で
 * フォールバックごと削除した）。
 */
function renderAboutSection(): string {
  const parts: string[] = ['<section id="about">'];
  parts.push("<h2>本書について</h2>");
  parts.push(
    "<p>本書は <code>docs/requirements/</code>（正本）をもとに、AI が執筆規範" +
      "（req-narrate スキル）に従って書いたナラティブ（<code>docs/requirements/meta/" +
      "narrative.html</code>）を本文として合成した読み物ビューです。本文は正本を書き換え" +
      "ない一方向生成ですが、非決定的です（同一の正本からも実行ごとに文言が変わることが" +
      "あります。ADR-010）。目次・参照様式・ホバーバルーンなどの器（<code>scripts/" +
      "req_document.ts</code>）は決定的に生成します。本文中の薄い色の参照リンクに" +
      "マウスを乗せると、該当レコードの要約（ID・種別・状態・タイトル・本文冒頭）が" +
      "バルーン表示されます。編集は正本側、またはナラティブの再執筆に対して行い、この" +
      "ファイルを直接編集しないでください。</p>",
  );
  parts.push("</section>");
  return parts.join("");
}

/**
 * 本文フラグメント（meta/narrative.html）が無いときの案内パネル（施主裁定 2026-08-05）。
 * 以前はレコード忠実表示へ自動フォールバックしていたが、それでは「文書ビューとして読める
 * 体裁の何か」が常に出てしまい、本文が未執筆であることに気づけなかった。ここでは本文を
 * 出さず、生成方法だけを示す（バンドル自体は生成を続け、ツリー・通読レビューは使える）。
 * 決定的生成（同一入力→バイト同一）を保つため、日時や環境依存の値は含めない。
 */
function renderNarrativeMissingPanel(): string {
  const parts: string[] = ['<main class="narrative-missing">'];
  parts.push('<section id="narrative-missing">');
  parts.push("<h2>本文（ナラティブ）が未生成です</h2>");
  parts.push(
    "<p>文書ビューの本文は、正本から AI が執筆する読み物（ナラティブ）です。" +
      "本文フラグメント <code>docs/requirements/meta/narrative.html</code> が見つからないため、" +
      "本文を表示していません（レコードをそのまま並べた代替表示は行いません）。" +
      "ツリービューと通読レビューは本文の有無に関係なく利用できます。</p>",
  );
  parts.push("<h3>生成方法</h3>");
  parts.push(
    "<p>Claude Code で次のスキルを起動すると、正本を読んで本文フラグメントを執筆します" +
      "（正本は書き換えません）。</p>",
  );
  parts.push('<pre class="narrative-missing-cmd"><code>/req-narrate</code></pre>');
  parts.push(
    "<p>執筆後、ビューを再生成すると本文が合成されます。</p>",
  );
  parts.push('<pre class="narrative-missing-cmd"><code>./bin/req gen</code></pre>');
  parts.push("<h3>フラグメントの契約</h3>");
  parts.push("<ul>");
  parts.push(
    "<li>置き場所は <code>docs/requirements/meta/narrative.html</code>（1 ファイル）。</li>",
  );
  parts.push(
    "<li>中身は <code>&lt;body&gt;</code> 内相当の HTML 断片。" +
      "<code>&lt;html&gt;</code> / <code>&lt;head&gt;</code> は含めない" +
      "（目次・様式・バルーンは <code>scripts/req_document.ts</code> が決定的に付ける）。</li>",
  );
  parts.push(
    "<li>章立ては <code>&lt;h2&gt;</code> / <code>&lt;h3&gt;</code> で表す" +
      "（目次とフロート目次はこの見出しを走査して作られる）。</li>",
  );
  parts.push(
    "<li>正本レコードへの参照は <code>data-req-link=\"BR-1\"</code> のように属性で示す" +
      "（ホバーバルーンで解決される）。</li>",
  );
  parts.push(
    "<li>先頭に <code>&lt;!-- narrative: 2026-08-05 v0.2 --&gt;</code> の形で生成時点を" +
      "書くと、正本の版と並記されドリフトが見える。</li>",
  );
  parts.push("</ul>");
  parts.push("</section>");
  parts.push("</main>");
  return parts.join("");
}


// ---------------------------------------------------------------------------
// ナラティブ・フラグメントの合成（SOL-34・ADR-010）
// ---------------------------------------------------------------------------

/** 見出し1件（h2/h3）。TOC・フロート TOC 双方の共通入力にする（二重実装を避ける）。 */
interface NarrativeHeading {
  id: string;
  level: 2 | 3;
  /** タグを除いたプレーンテキスト（TOC のリンク文字列に使う。html エンティティはそのまま）。 */
  text: string;
}

/**
 * `<root>/meta/narrative.html` を読む。無ければ null（呼び出し側が従来のレコード忠実表示へ
 * フォールバックする）。docs/requirements/meta/narrative.html はこのファイル自身が読む前提
 * ではない場合があるため（並行執筆中）、fixture 側から与えられた root に対してのみ動く
 * 純粋な読み取り関数として書く。
 */
/**
 * 参照リンクへの確認状態マーカー（施主指示 2026-08-11「文書ビューの要件への参照で、
 * 『確認、未確認』がわかるようにして。そしてそこをクリックするとその項目をレビュー承認
 * できるようにして」）。
 *
 * 本文中の `data-req-link` 付きアンカーの直後に、そのレコードが確認済みか未確認かを示す
 * 小さなマーカーを差し込む。判定は通読レビューと同じ isConfirmed（approval=agreed ∧
 * review_required=false。req_tree.ts の共有ヘルパ。SR-24——同じ「確認済み」の意味を
 * ビューごとに定義しない）で、生成時点の正本から決定的に算出する。
 *
 * マーカーは参照の読みを妨げない弱い表示にする（SOL-31 の「参照は薄色・下線なし」の方針を
 * 引き継ぐ）。未確認のマーカーはサーバ配信時にボタンとして働き、押すと承認を書き戻す。
 * 同じ ID が本文中に何度現れても、書き戻し後は全部が確認済みへ変わる（data-req-state を
 * ID で引く）。
 */
export function decorateReqLinkStates(html: string, recordsById: Map<string, ReqRecord>): string {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole: string, attrs: string, inner: string) => {
    const idMatch = /\bdata-req-link\s*=\s*"([^"]*)"/i.exec(attrs);
    if (!idMatch) return whole;
    const record = recordsById.get(idMatch[1]);
    if (!record) return whole;
    const id = idMatch[1];
    const confirmed = isConfirmed(record);
    const label = confirmed ? "確認済み" : "未確認";
    const marker =
      `<button type="button" class="req-link-state" data-req-state-id="${esc(id)}" ` +
      `data-req-state="${confirmed ? "confirmed" : "unconfirmed"}" disabled ` +
      `title="${esc(id)}: ${label}" aria-label="${esc(id)}: ${label}">` +
      `<span class="req-link-state-mark">${confirmed ? "✓" : "未"}</span></button>`;
    return `${whole}${marker}`;
  });
}

function readNarrativeFragment(root: string): string | null {
  const filePath = path.join(root, "meta", "narrative.html");
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * フラグメント冒頭の `<!-- narrative: … -->` コメント（本文の生成時点の自己申告）を取り出す。
 * 無ければ note は null（フラグメント自体はそのまま使う。フォールバックにはしない）。
 */
function extractLeadingNarrativeComment(raw: string): { note: string | null; rest: string } {
  const m = /^\s*<!--\s*narrative:\s*([\s\S]*?)\s*-->/.exec(raw);
  if (!m) return { note: null, rest: raw };
  return { note: m[1].trim(), rest: raw.slice(m[0].length) };
}

// フラグメント契約（SOL-34）の寛容なサニタイズは sanitizeHtmlFragment（scripts/req_tree.ts。
// SOL-41 で req_guided.ts のストーリーフラグメントとも共有するため export された。
// 二重実装を避ける。SR-24）。呼び出しは buildDocumentHtml 内で
// sanitizeHtmlFragment(rest, "SOL-34") として行う。

/**
 * フラグメント内の h2/h3 を走査し、id を持たない見出しには生成順で `n-<連番>` を付与する
 * （フラグメント内容が同じなら出力も同じ＝純関数。時刻・乱数は使わない）。戻り値の html は
 * 見出しに id を補った後のフラグメント本体、headings は TOC・フロート TOC 生成の共通入力。
 */
function extractNarrativeHeadings(html: string): { html: string; headings: NarrativeHeading[] } {
  const headings: NarrativeHeading[] = [];
  let seq = 0;
  const out = html.replace(
    /<h([23])((?:\s+[^>]*)?)>([\s\S]*?)<\/h\1>/gi,
    (_whole: string, levelStr: string, attrs: string, inner: string) => {
      const level = (levelStr === "2" ? 2 : 3) as 2 | 3;
      const idMatch = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      let id = idMatch ? idMatch[1] ?? idMatch[2] ?? "" : "";
      let newAttrs = attrs;
      if (id === "") {
        seq += 1;
        id = `n-${seq}`;
        // 既存の id 属性が空（id="" / id=''）だった場合はその場で置き換える。単純に
        // 追記すると `id="" id="n-1"` のような重複 id 属性になり、ブラウザは最初の
        // （空の）id を採用するため TOC のアンカーが実体を持たなくなる。
        newAttrs = idMatch ? attrs.replace(idMatch[0], `id="${id}"`) : `${attrs} id="${id}"`;
      }
      const text = inner.replace(/<[^>]+>/g, "").trim();
      headings.push({ id, level, text });
      return `<h${levelStr}${newAttrs}>${inner}</h${levelStr}>`;
    },
  );
  return { html: out, headings };
}

/** 目次（フラグメント時: h2/h3 見出し走査由来。既存の章/レコード2階層と同じネスト構造）。 */
function renderNarrativeToc(headings: NarrativeHeading[]): string {
  const parts: string[] = ['<nav id="toc">', "<h2>目次</h2>", '<ol class="toc-chapters">'];
  let liOpen = false;
  let ulOpen = false;
  for (const h of headings) {
    if (h.level === 2) {
      if (ulOpen) {
        parts.push("</ul>");
        ulOpen = false;
      }
      if (liOpen) parts.push("</li>");
      parts.push(`<li class="toc-chapter"><a href="#${esc(h.id)}">${h.text}</a>`);
      liOpen = true;
    } else {
      if (!ulOpen) {
        parts.push('<ul class="toc-records">');
        ulOpen = true;
      }
      parts.push(`<li><a href="#${esc(h.id)}">${h.text}</a></li>`);
    }
  }
  if (ulOpen) parts.push("</ul>");
  if (liOpen) parts.push("</li>");
  parts.push("</ol>", "</nav>");
  return parts.join("");
}

/** フロート TOC（フラグメント時: h2/h3 見出し走査由来。renderFloatingToc の見出し版）。 */
function renderNarrativeFloatingToc(headings: NarrativeHeading[]): string {
  const parts: string[] = ['<nav class="floating-toc" aria-label="章 TOC（フロート表示）">'];
  parts.push('<p class="floating-toc-title">章</p>');
  parts.push('<ul class="floating-toc-list">');
  for (const h of headings) {
    const depth = h.level === 2 ? 0 : 1;
    parts.push(
      `<li class="floating-toc-item depth-${depth}"><a href="#${esc(h.id)}" data-toc-target="${esc(h.id)}">${h.text}</a></li>`,
    );
  }
  parts.push("</ul>", "</nav>");
  return parts.join("");
}

// BalloonEntry・buildBalloonData・renderJsonScript は scripts/req_tree.ts から import
// する（SOL-41 で req_guided.ts と共有するため export された。二重実装を避ける。SR-24）。

/** フラグメント契約違反の警告を、出力に埋める HTML コメントへ変換する（寛容な扱い）。 */
function renderNarrativeWarnings(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return warnings.map((w) => `<!-- narrative fragment warning: ${w.replace(/--/g, "—")} -->`).join("\n");
}

/**
 * 文書体裁ビューを生成する。`opts.fragment` を渡すとバンドル（req_bundle.ts）用の
 * フラグメント（{ styles, html, script }）を返す。省略時（スタンドアロン）は従来どおり
 * 完全 HTML の文字列を返し、挙動・出力バイトは不変（ADR-013 段階2）。
 */
export function buildDocumentHtml(root: string): string;
export function buildDocumentHtml(
  root: string,
  opts: BuildOpts & { fragment: NonNullable<BuildOpts["fragment"]> },
): FragmentResult;
export function buildDocumentHtml(root: string, opts?: BuildOpts): string | FragmentResult;
export function buildDocumentHtml(root: string, opts?: BuildOpts): string | FragmentResult {
  const result = loadRecords(root);
  if (result.errors.length > 0) {
    throw new Error("req_document: 正本の読み込みに失敗しました:\n" + result.errors.join("\n"));
  }

  const records = result.records;

  const kindOrder: { kind: string; label: string }[] = [
    { kind: "business_requirement", label: KIND_LABEL.get("business_requirement") ?? "BR" },
    { kind: "stakeholder_requirement", label: KIND_LABEL.get("stakeholder_requirement") ?? "SR" },
    { kind: "use_case", label: KIND_LABEL.get("use_case") ?? "U" },
    { kind: "solution_requirement", label: KIND_LABEL.get("solution_requirement") ?? "SOL" },
    { kind: "mandatory_output", label: KIND_LABEL.get("mandatory_output") ?? "MO" },
  ];
  const countsText = kindOrder
    .map(({ kind, label }) => `${label} ${records.filter((r) => r.kind === kind).length}`)
    .join("・");

  const head = readChangelogHead(root);
  const versionText = head !== null ? `版: v${head.version}（${head.date}）` : "版: 不明（changelog未検出）";

  // 本文（SOL-34）: `<root>/meta/narrative.html` をフラグメントとして合成する。
  // 無い場合はレコード忠実表示へフォールバックせず、生成方法の案内パネルを本文に出す
  // （施主裁定 2026-08-05。フォールバックは「文書ビューとして読める体裁の何か」が常に
  // 出てしまうため、本文が未執筆であることに気づけないという問題があった）。
  // バンドルは 3 ビュー同梱の単一 HTML なので、ここで生成自体を止めることはしない
  // （ツリー・通読レビューは本文の有無に依存しない）。
  const narrativeRaw = readNarrativeFragment(root);
  // 参照リンクのタイトル併記（SOL-31 追記）: 本文中の data-req-link がID±状態のみの表示の
  // ときタイトルを併記する（enrichReqLinkLabels。req_tree.ts の共有ヘルパ。SR-24）。
  const recordsById = new Map(records.filter((r) => r.id !== null).map((r) => [r.id as string, r]));

  let tocHtml: string;
  let floatingTocHtml: string;
  let mainHtml: string;
  let narrativeMetaHtml = "";
  let narrativeWarningsHtml = "";

  if (narrativeRaw !== null) {
    const { note, rest } = extractLeadingNarrativeComment(narrativeRaw);
    const { html: sanitized, warnings } = sanitizeHtmlFragment(rest, "SOL-34");
    // 素の ID 表記の参照リンク化（SOL-41 追記／施主指示 2026-08-07）: 本文の地の文に
    // 混在する素の ID（既存 <a>・<code> の中は対象外）を data-req-link 付きの参照アンカーへ
    // 自動昇格する（req_tree.ts の共有ヘルパ。SR-24）。
    const autolinked = autolinkReqIds(sanitized, recordsById);
    const enriched = enrichReqLinkLabels(autolinked, recordsById);
    // 確認状態のマーカー（施主指示 2026-08-11）。タイトル併記の後に付ける——マーカーは
    // アンカーの外側に出す要素なので、内側の表示テキストを見る enrichReqLinkLabels の
    // 判定に影響しない順序にする。
    const withStates = decorateReqLinkStates(enriched, recordsById);
    const { html: withIds, headings } = extractNarrativeHeadings(withStates);

    tocHtml = renderNarrativeToc(headings);
    floatingTocHtml = renderNarrativeFloatingToc(headings);
    mainHtml = `<main class="narrative">${withIds}</main>`;
    narrativeWarningsHtml = renderNarrativeWarnings(warnings);
    if (note !== null) {
      narrativeMetaHtml = `<p class="doc-meta narrative-meta">本文の生成時点: ${esc(note)}｜正本の最新版: ${esc(versionText.replace(/^版:\s*/, ""))}</p>`;
    }
  } else {
    tocHtml = "";
    floatingTocHtml = "";
    mainHtml = renderNarrativeMissingPanel();
  }
  const balloonData = buildBalloonData(records);

  // ADR-013 段階2: 完全 HTML の外枠（doctype/head/body）と本文コンテンツ（bodyParts）の
  // 組み立てを分離した（req_tree.ts / req_guided.ts と同じ規約。標準出力はバイト不変）。
  const bodyParts: string[] = [];

  // ヘッダは全ビュー共通（renderSiteHeader）。以前はここだけツールバーが h1 の上にあり、
  // ラッパーも `.doc-topbar` と独自だった（施主指摘 2026-07-28「各ページのヘッダが不統一」）。
  // ヘッダは本文の中央寄せカラム（.doc-container）の外に置き、tree/guided と同じ全幅・
  // 左寄せにする（施主指摘 2026-07-30「ヘッダブロック全体が中央寄せカラムに入っている」）。
  // 見出しは「文書ビュー」の一語にする（施主指示 2026-08-11）。旧「要件定義書（文書体裁）」は
  // タブ・h1・title で言い方が揺れていたうえ、SEC-4 の固有名称辞書の見出し語（文書ビュー）とも
  // 食い違っていた。副題は付けない——「文書ビュー — 文書体裁」は同語反復になる。
  bodyParts.push(renderSiteHeader({ view: "document" }));
  // フロート TOC（施主追加指示 2026-07-31）はヘッダの直後・.doc-container の外に置く
  // （position: fixed のため DOM 上の位置自体は見た目に影響しないが、本文カラムの内側に
  // 混ぜないという構造を明示するため兄弟要素にする）。
  bodyParts.push(floatingTocHtml);
  // 本文とサイドバーを横に並べる（施主指示 2026-08-11「文書ビューにも、未レビュー状況が
  // わかる右サイドバーをつけて」）。サイドバーは通読レビューと同じ器を使う（SR-24）。
  bodyParts.push('<div class="doc-main-area">');
  bodyParts.push('<div class="doc-container">');
  if (narrativeWarningsHtml !== "") bodyParts.push(narrativeWarningsHtml);
  bodyParts.push(`<p class="doc-meta">${esc(versionText)}｜${esc(countsText)}</p>`);
  if (narrativeMetaHtml !== "") bodyParts.push(narrativeMetaHtml);

  // 本文が無いときは「本書について」（ナラティブ前提の説明）を出さない。
  // 案内パネル（renderNarrativeMissingPanel）がその役割を兼ねる。
  if (narrativeRaw !== null) bodyParts.push(renderAboutSection());
  bodyParts.push(tocHtml);

  bodyParts.push(mainHtml);

  bodyParts.push('<p class="doc-end">— 文書終わり —</p>');
  bodyParts.push("</div>"); // .doc-container
  // 行クリックは本文中のその ID の最初の参照へスクロールする（通読レビューの
  // gotoCanonicalRecord に相当する、このビューなりの「その項目まで行く」操作）。
  const ctx = buildContext(records);
  const sections = records.filter((r) => r.kind === "document_section");
  bodyParts.push(
    renderSidebar(buildSidebarEntries(sections, ctx, new Map(), new Map()), ctx, {
      ns: "REQ_DOC",
      onClickExpr: (jsId) => `gotoDocumentRecord(${jsId});`,
      note: "正本の全レコード（本文に出てこないものも含む）",
    }),
  );
  bodyParts.push("</div>"); // .doc-main-area

  bodyParts.push(renderJsonScript("req-balloon-data", balloonData));

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
  parts.push(`<title>${pageTitle("document")}</title>`);
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

  const htmlText = buildDocumentHtml(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, htmlText, "utf-8");
  console.log(`req_document: ${out} を生成しました。`);
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
