#!/usr/bin/env node
/**
 * req_issues_view.ts — ローカル Markdown 方式のイシュー（`.scratch/<feature>/issues/*.md`）を
 * 読み取り専用で一覧・閲覧する「イシュービュー」（レビューサーバ第4のタブ。SOL-54 / SR-63）を
 * 一方向生成する。
 *
 * 対象の形式は `docs/agents/issue-tracker.md` の規約:
 *   `.scratch/<feature-slug>/issues/<NN>-<slug>.md`
 *   ファイル冒頭付近の `Status:` 行にトリアージ状態（`docs/agents/triage-labels.md` の 5 ロール）
 *   最初の `# ` 見出しがタイトル
 *
 * 読み取り専用（SOL-54 (f)）: 書き戻しの経路を一切持たない。`Status:` の変更・コメント追記・
 * 新規作成はファイル／スキルの仕事であり、このビューからは正本もイシューファイルも変更されない。
 * したがって生成物に POST を送るコードを含めない（レビュー UI の初期化も呼ばない）。
 *
 * バンドル（req gen）の対象外（SOL-54 (h)）: イシューは作業チケットであって正本の一部ではなく、
 * 配布物に載せる対象ではないため、fragment 生成の口を持たない（既存 3 ビューと異なる点）。
 *
 * 生成は決定的（同一入力 → バイト同一の出力）。走査結果はパスでソートし、実行時刻・乱数は
 * 埋め込まない。
 *
 * 流用（二重実装を避ける。SR-24）: esc・共通トップバー（renderSiteHeader / REVIEW_TOPBAR_CSS）・
 * md→HTML 変換（renderBodyMarkdown）・ホバーバルーン一式（REQ_BALLOON_CSS/REQ_BALLOON_JS/
 * buildBalloonData/renderJsonScript）・素の ID 表記の自動リンク化（autolinkReqIds）は
 * scripts/req_tree.ts から import する。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { loadRecords, type ReqRecord } from "./reqlib.ts";
import {
  esc,
  renderSiteHeader,
  pageTitle,
  REVIEW_TOPBAR_CSS,
  REVIEW_NAV_JS,
  REQ_BALLOON_CSS,
  REQ_BALLOON_JS,
  buildBalloonData,
  renderJsonScript,
  renderBodyMarkdown,
  autolinkReqIds,
} from "./req_tree.ts";

/** 状態が読めなかったイシューの表示ラベル（SOL-54 (b): 読み込みは失敗させない）。 */
export const STATUS_UNKNOWN_LABEL = "（状態なし）";

/**
 * 既知の状態（`docs/agents/triage-labels.md` の 5 ロール＋実運用で現れる resolved）。
 * ここに無い値も一覧からは落とさず、そのまま表示する（辞書に無い値を隠すと、綴り違いの
 * イシューが「存在しないもの」になってしまう。SOL-54 (c)）。
 */
export const KNOWN_STATUSES: readonly string[] = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
  "resolved",
];

export interface IssueEntry {
  /** フィーチャー（`.scratch/` 直下のディレクトリ名） */
  feature: string;
  /** ファイル名先頭の連番（`01` → 1）。数字で始まらないファイルは null */
  seq: number | null;
  /** 表示用の連番文字列（ファイル名のまま。`01` の 0 を落とさない） */
  seqLabel: string;
  /** 最初の `# ` 見出し。無ければファイル名（拡張子なし） */
  title: string;
  /** `Status:` 行の値。無ければ null */
  status: string | null;
  /** 本文（`Status:` 行や `# ` 見出しを含む生の md 全体） */
  body: string;
  /** 一覧・本文の DOM id に使う安定キー */
  key: string;
}

/** `.scratch` ディレクトリの位置。正本 root（…/docs/requirements）から 2 つ上がプロジェクト。 */
export function scratchDirFor(root: string): string {
  return path.resolve(root, "..", "..", ".scratch");
}

/** 先頭の `# ` 見出しを取り出す（無ければ null）。 */
function extractTitle(text: string): string | null {
  for (const line of text.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * `Status:` 行の値を取り出す（無ければ null）。issue-tracker.md は「冒頭付近の Status: 行」と
 * しか定めていないため行位置は決め打ちにせず、本文中の最初の `Status:` 行を採る。
 * `## Comments` 以降に現れる引用（過去の状態の言及）を拾わないよう、最初の一致で止める。
 */
function extractStatus(text: string): string | null {
  for (const line of text.split("\n")) {
    const m = /^Status:\s*(\S+)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * `.scratch/<feature>/issues/*.md` を走査して IssueEntry の配列を返す。
 * `.scratch` が無い・issues が無い・空でもエラーにせず空配列を返す（SOL-54 (g)）。
 * 並びは決定的（フィーチャー名昇順 → 連番昇順 → ファイル名昇順）。
 */
export function loadIssues(root: string): IssueEntry[] {
  const scratch = scratchDirFor(root);
  let features: string[];
  try {
    features = fs
      .readdirSync(scratch, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }

  const entries: IssueEntry[] = [];
  for (const feature of features) {
    const issuesDir = path.join(scratch, feature, "issues");
    let files: string[];
    try {
      files = fs
        .readdirSync(issuesDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".md"))
        .map((d) => d.name)
        .sort();
    } catch {
      continue;
    }
    for (const name of files) {
      let body: string;
      try {
        body = fs.readFileSync(path.join(issuesDir, name), "utf-8");
      } catch {
        continue;
      }
      const base = name.replace(/\.md$/, "");
      const seqMatch = /^(\d+)/.exec(base);
      entries.push({
        feature,
        seq: seqMatch ? Number.parseInt(seqMatch[1], 10) : null,
        seqLabel: seqMatch ? seqMatch[1] : "—",
        title: extractTitle(body) ?? base,
        status: extractStatus(body),
        body,
        key: `${feature}/${base}`,
      });
    }
  }
  // 連番なし（seq === null）は末尾へ。同順位はファイル名で決定的に並べる。
  entries.sort((a, b) => {
    if (a.feature !== b.feature) return a.feature < b.feature ? -1 : 1;
    const as = a.seq ?? Number.MAX_SAFE_INTEGER;
    const bs = b.seq ?? Number.MAX_SAFE_INTEGER;
    if (as !== bs) return as - bs;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return entries;
}

/** 状態別の件数（表示順は KNOWN_STATUSES → 未知の値の昇順 → 状態なし）。 */
export function countByStatus(issues: IssueEntry[]): { status: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const i of issues) {
    const k = i.status ?? "";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out: { status: string; label: string; count: number }[] = [];
  for (const s of KNOWN_STATUSES) {
    const n = counts.get(s);
    if (n !== undefined) out.push({ status: s, label: s, count: n });
  }
  const unknown = [...counts.keys()].filter((k) => k !== "" && !KNOWN_STATUSES.includes(k)).sort();
  for (const s of unknown) out.push({ status: s, label: s, count: counts.get(s) ?? 0 });
  const none = counts.get("");
  if (none !== undefined) out.push({ status: "", label: STATUS_UNKNOWN_LABEL, count: none });
  return out;
}

/** 状態バッジ。既知の値は色分けし、未知の値も表示は落とさない。 */
function renderStatusBadge(status: string | null): string {
  const label = status ?? STATUS_UNKNOWN_LABEL;
  const known = status !== null && KNOWN_STATUSES.includes(status);
  const cls = known ? `issue-status status-${esc(status)}` : "issue-status status-other";
  return `<span class="${cls}">${esc(label)}</span>`;
}

const CSS = `:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; color: #222; background: #fff; line-height: 1.7; }
main { max-width: 1000px; margin: 0 auto; padding: 0 1.4rem 3rem; }
${REVIEW_TOPBAR_CSS}
${REQ_BALLOON_CSS}
.issue-guide { margin: .3rem 0 1rem; padding: .35rem .8rem; background: #f7f6fd; border-left: 3px solid #cfcbe8; border-radius: 0 4px 4px 0; font-size: .85rem; color: #534AB7; }
.issue-filter { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin: 0 0 1rem; padding: .6rem .8rem; background: #fbfaff; border: 1px solid #e2dff5; border-radius: 6px; }
.issue-filter-label { font-size: .8rem; color: #666; margin-right: .2rem; }
.issue-filter-btn { font: inherit; font-size: .8rem; padding: .25rem .7rem; border-radius: 999px; border: 1px solid #534AB7; background: #fff; color: #534AB7; cursor: pointer; }
.issue-filter-btn.active { background: #534AB7; color: #fff; }
.issue-feature { margin: 1.4rem 0 .4rem; font-size: .95rem; color: #534AB7; border-bottom: 1px solid #e2dff5; padding-bottom: .2rem; }
.issue-list { list-style: none; margin: 0; padding: 0; }
.issue-item { border-bottom: 1px solid #f0eef9; }
.issue-row { display: flex; gap: .6rem; align-items: baseline; padding: .5rem .2rem; cursor: pointer; }
.issue-row:hover { background: #fbfaff; }
.issue-seq { flex: 0 0 2.2rem; font-size: .8rem; color: #888; text-align: right; }
.issue-title { flex: 1 1 auto; font-size: .9rem; }
.issue-status { flex: 0 0 auto; font-size: .72rem; padding: .1rem .5rem; border-radius: 999px; white-space: nowrap; border: 1px solid #ccc; background: #f5f5f5; color: #555; }
.issue-status.status-needs-triage { border-color: #d9a300; background: #fdf6e3; color: #8a5a00; }
.issue-status.status-needs-info { border-color: #9a7bd0; background: #f3eefc; color: #5b3a9e; }
.issue-status.status-ready-for-agent { border-color: #2f7fbf; background: #eaf4fc; color: #1a5c91; }
.issue-status.status-ready-for-human { border-color: #2f9f6f; background: #eafaf2; color: #1a7350; }
.issue-status.status-wontfix { border-color: #999; background: #f0f0f0; color: #666; }
.issue-status.status-resolved { border-color: #1e6b3c; background: #e3f3e6; color: #1e6b3c; }
.issue-body { display: none; padding: .4rem 1rem 1.2rem 3rem; font-size: .88rem; }
.issue-item.open .issue-body { display: block; }
.issue-body h1, .issue-body h2, .issue-body h3 { font-size: .92rem; margin: 1rem 0 .3rem; color: #333; }
.issue-body code { background: #f5f4fb; padding: .05rem .3rem; border-radius: 3px; font-size: .85em; }
.issue-body pre { background: #f7f6fd; padding: .6rem .8rem; border-radius: 4px; overflow-x: auto; }
.issue-empty { margin: 1rem 0; padding: .8rem 1rem; background: #fdf3e6; border: 1px solid #f1c98b; border-radius: 6px; font-size: .85rem; color: #7a4a00; }
.issue-readonly-note { margin: 1.2rem 0 0; font-size: .8rem; color: #888; }
`;

/**
 * 実行時 JS。読み取り専用なので送信系（reviewFetch / POST）は一切持たない。
 * 状態の絞り込みと本文の開閉、そしてホバーバルーンの初期化だけを行う。
 */
const JS = `(function () {
${REVIEW_NAV_JS}
// 共有 JS（REQ_BALLOON_JS）が前提とするヘルパ。他 3 ビューは自分の IIFE 内で同じものを
// 定義しており、本ビューでも同じ規約に合わせる（バンドルのフラグメント化で id に接頭辞が
// 付く前提のため、単純な document.getElementById にはしない）。定義漏れのまま
// initReqBalloon() を呼ぶと「byId is not defined」で例外になり、ページの実行時 JS が
// そこで止まる——E2E テスト（実ブラウザでの読み込み）で検出した。
var ROOT = document;
var IDP = '';
function byId(x) { return ROOT.querySelector('#' + IDP + CSS.escape(x)); }
${REQ_BALLOON_JS}
function toggleIssue(key) {
  var item = document.querySelector('.issue-item[data-key="' + key + '"]');
  if (item) { item.classList.toggle('open'); }
  return false;
}
// 状態の絞り込み（SOL-54 (d)）。画面内に留め、URL・サーバへは持たせない。
function filterIssues(status) {
  document.querySelectorAll('.issue-filter-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-status') === status);
  });
  document.querySelectorAll('.issue-item').forEach(function (item) {
    var s = item.getAttribute('data-status');
    item.style.display = (status === '*' || s === status) ? '' : 'none';
  });
  // 全件隠れたフィーチャー見出しは出さない（空の見出しが残ると件数の読み違いになる）。
  document.querySelectorAll('.issue-feature-group').forEach(function (group) {
    var any = false;
    group.querySelectorAll('.issue-item').forEach(function (item) {
      if (item.style.display !== 'none') { any = true; }
    });
    group.style.display = any ? '' : 'none';
  });
  return false;
}
// レコード ID 参照のクリックでツリービューへ飛ぶ（読み取り専用の遷移）。共有バルーン JS の
// クリック遷移は window.__REVIEW_ENDPOINT__ の有無を「サーバ配信か」の判定に使っているが、
// 本ビューは書き戻し経路を持たない＝endpoint を注入しない（SOL-54 (f)）ため、その判定では
// 遷移が起きない。ここで本ビュー専用に遷移だけを足す（送信は行わない）。
document.addEventListener('click', function (e) {
  var el = e.target;
  while (el && el !== document.body) {
    if (el.getAttribute && el.getAttribute('data-req-link')) {
      e.preventDefault();
      window.location.href = '/#' + el.getAttribute('data-req-link');
      return;
    }
    el = el.parentNode;
  }
});
window.REQ_ISSUES = { toggleIssue: toggleIssue, filterIssues: filterIssues };
initReqBalloon();
// ヘッダのビュー切替タブ（SOL-30）。本ビューは書き戻しを持たない（endpoint を注入しない）が、
// サーバ配信されていれば他のビューへ行き来できる——タブの表示は配信状態で決める
// （施主指示 2026-08-11。判定は applyReviewNav に集約し、ここでは呼ぶだけ）。
applyReviewNav(ROOT, byId, false);
})();
`;

/**
 * イシュービューの本文（body の中身）を組み立てる。
 *
 * 正本（レコード）はホバーバルーンと ID 自動リンクのためだけに読む。読めなくても
 * イシュービューは成立するため、失敗時はバルーンなしで続行する（イシューを読む窓が
 * 正本の不整合で開かなくなるのは筋が悪い）。
 */
function buildBody(root: string, issues: IssueEntry[]): string {
  let recordsById: Map<string, ReqRecord> = new Map();
  let balloonJson: string | null = null;
  try {
    const result = loadRecords(root);
    if (result.errors.length === 0) {
      for (const r of result.records) {
        if (r.id !== null) recordsById.set(r.id, r);
      }
      balloonJson = renderJsonScript("req-balloon-data", buildBalloonData(result.records));
    }
  } catch {
    recordsById = new Map();
  }
  const parts: string[] = [];
  parts.push(
    renderSiteHeader({
      view: "issues",
      subtitle: "ローカルイシュー",
      extraHtml: `<span class="spacer"></span><span class="review-filter-count">イシュー ${issues.length} 件</span>`,
    }),
  );
  parts.push("<main>");
  parts.push(
    '<p class="issue-guide">ローカルの作業イシュー（.scratch/&lt;feature&gt;/issues/）の一覧です。行をクリックすると本文が開きます。この画面は読み取り専用で、状態の変更・コメント追記はファイルまたはスキルで行います。</p>',
  );

  if (issues.length === 0) {
    // SOL-54 (g): 0 件でもビューは失敗させず、規約と次の一手を案内する。
    parts.push(
      '<div class="issue-empty">ローカルイシューが見つかりませんでした（<code>.scratch/&lt;feature&gt;/issues/*.md</code> が無い、または空）。' +
        "イシューの置き場と書式は <code>docs/agents/issue-tracker.md</code> の規約に従います" +
        "（1 フィーチャー 1 ディレクトリ・<code>NN-slug.md</code>・冒頭付近の <code>Status:</code> 行）。</div>",
    );
    parts.push("</main>");
    return parts.join("");
  }

  // 絞り込み（状態別の件数つき）。既定は「すべて」。
  parts.push('<div class="issue-filter">');
  parts.push('<span class="issue-filter-label">状態で絞り込み:</span>');
  parts.push(
    `<button type="button" class="issue-filter-btn active" data-status="*" onclick="return REQ_ISSUES.filterIssues('*');">すべて ${issues.length}</button>`,
  );
  for (const c of countByStatus(issues)) {
    parts.push(
      `<button type="button" class="issue-filter-btn" data-status="${esc(c.status)}" ` +
        `onclick="return REQ_ISSUES.filterIssues(this.dataset.status);">${esc(c.label)} ${c.count}</button>`,
    );
  }
  parts.push("</div>");

  // フィーチャー（ディレクトリ）ごとに束ねて連番昇順（loadIssues の並びのまま）。
  let currentFeature: string | null = null;
  let groupOpen = false;
  for (const issue of issues) {
    if (issue.feature !== currentFeature) {
      if (groupOpen) parts.push("</ul></div>");
      currentFeature = issue.feature;
      const n = issues.filter((i) => i.feature === issue.feature).length;
      parts.push('<div class="issue-feature-group">');
      parts.push(`<h2 class="issue-feature">${esc(issue.feature)} <span class="issue-seq">${n} 件</span></h2>`);
      parts.push('<ul class="issue-list">');
      groupOpen = true;
    }
    const keyAttr = esc(issue.key);
    // 本文は既存の md→HTML 変換を流用し、素の ID 表記はバルーンで引けるよう自動リンク化する。
    const bodyHtml = autolinkReqIds(renderBodyMarkdown(issue.body), recordsById);
    parts.push(
      `<li class="issue-item" data-key="${keyAttr}" data-status="${esc(issue.status ?? "")}">` +
        `<div class="issue-row" onclick="return REQ_ISSUES.toggleIssue(this.parentNode.dataset.key);">` +
        `<span class="issue-seq">${esc(issue.seqLabel)}</span>` +
        `<span class="issue-title">${esc(issue.title)}</span>` +
        renderStatusBadge(issue.status) +
        "</div>" +
        `<div class="issue-body">${bodyHtml}</div>` +
        "</li>",
    );
  }
  if (groupOpen) parts.push("</ul></div>");

  parts.push(
    '<p class="issue-readonly-note">この画面はイシューを読むための窓です（読み取り専用）。' +
      "正本と実装状態の差は <code>req gaps</code>、イシューとの突合は <code>/req-issues</code> が担います。</p>",
  );
  parts.push("</main>");

  if (balloonJson !== null) parts.push(balloonJson);
  return parts.join("");
}

/** イシュービューの完全 HTML を生成する（バンドル用 fragment の口は持たない。SOL-54 (h)）。 */
export function buildIssuesHtml(root: string): string {
  const issues = loadIssues(root);
  const bodyHtml = buildBody(root, issues);
  const parts: string[] = [];
  parts.push("<!doctype html>");
  parts.push('<html lang="ja">');
  parts.push("<head>");
  parts.push('<meta charset="UTF-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
  parts.push(`<title>${pageTitle("issues", "ローカルイシュー")}</title>`);
  parts.push(`<style>\n${CSS}\n</style>`);
  parts.push("</head>");
  parts.push("<body>");
  parts.push(bodyHtml);
  parts.push(`<script>\n${JS}\n</script>`);
  parts.push("</body>");
  parts.push("</html>");
  return parts.join("\n") + "\n";
}

function defaultRoot(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

function main(): number {
  const { values } = parseArgs({ options: { root: { type: "string" }, out: { type: "string" } } });
  const root = values.root ?? defaultRoot();
  const htmlText = buildIssuesHtml(root);
  if (values.out === undefined) {
    process.stdout.write(htmlText);
  } else {
    fs.mkdirSync(path.dirname(values.out), { recursive: true });
    fs.writeFileSync(values.out, htmlText, "utf-8");
    console.log(`req_issues_view: ${values.out} を生成しました。`);
  }
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
