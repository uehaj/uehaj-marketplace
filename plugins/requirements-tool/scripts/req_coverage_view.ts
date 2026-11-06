#!/usr/bin/env node
/**
 * req_coverage_view.ts — テストの十分性を可視化する「カバレッジビュー」（レビューサーバ第5の
 * タブ。SOL-55 / SR-65）。読み取り専用。
 *
 * 2 軸を 1 画面に並べる（施主裁定 2026-08-09「両方を並べて見る」）:
 *   要件の被覆 … どの要求・要件に、それを検査するテストがあるか（direct / rollup / manual / none）
 *   行カバレッジ … 実装のどれだけがテストで実行されたか（Node 標準の lcov 出力を読む）
 * 片方だけでは十分性が判断できないため（要件に対応するテストが在っても実装の大部分が未実行なら
 * 不足、行カバレッジが高くても要件を検査していなければ「何を確かめたか」が言えない）。
 *
 * 旧「状況ビュー」（SR-22 / SOL-21〜24。2026-08-02 に施主裁定で廃止）との違い: あちらは
 * 「プロンプト待ちごとに自動再生成され常時更新される」ビューで、廃止の理由もその常時性に伴う
 * 手数だった。本ビューは施主が明示的に開く読み取り専用の集計であり、自動再生成・フック連動を
 * 持たない。したがって廃止裁定と衝突しない（この判断は SOL-55 rationale に記録した）。
 *
 * 行カバレッジの入力（lcov）は任意。無ければ「未計測」と表示し、要件の被覆だけを出す
 * ——計測はテスト全体の実行を伴うため、ビューを開くたびに走らせない。
 *
 * 生成は決定的。実行時刻・乱数は埋め込まない。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { esc, renderSiteHeader, pageTitle, REVIEW_TOPBAR_CSS, REVIEW_NAV_JS, KIND_COLLAPSED_LABEL } from "./req_tree.ts";
import { runCoverage, type CoverageResult, type CoverageKind, type RequirementCoverage } from "./req_coverage.ts";

function defaultRoot(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

/** 判定の表示名と説明（画面上で語を説明する。SR-62 と同じ姿勢）。 */
const KIND_META: ReadonlyMap<CoverageKind, { label: string; desc: string }> = new Map([
  ["direct", { label: "名指しあり", desc: "その ID を名指しするテストがある" }],
  ["rollup", { label: "下位で間接", desc: "自分を実現する下位レコードにテストがあり、間接的に確かめられる" }],
  ["manual", { label: "機械検査外", desc: "手動確認と明記されている、または章・成果物カタログで合否判定の対象でない" }],
  ["none", { label: "テストの穴", desc: "名指しのテストも下位のテストも無い" }],
]);

const CSS = `:root {
  --ground: #FBFAFF; --surface: #FFFFFF; --ink: #1F1D2B; --ink-soft: #5C5870;
  --rule: #E2DFF5; --accent: #534AB7; --accent-soft: #EEEDFE;
  --none: #8A5A00; --none-soft: #FDF6E3; --direct: #1E6B3C; --direct-soft: #E3F3E6;
  --rollup: #2F7FBF; --rollup-soft: #EAF4FC; --manual: #6B6880; --manual-soft: #F0EFF5;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink);
  font-family: "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; line-height: 1.7; }
main { max-width: 1100px; margin: 0 auto; padding: 0 1.4rem 4rem; }
${REVIEW_TOPBAR_CSS}
.cov-guide { margin: .3rem 0 1.2rem; padding: .35rem .8rem; background: var(--accent-soft);
  border-left: 3px solid var(--accent); border-radius: 0 4px 4px 0; font-size: .85rem; color: var(--accent); }
.cov-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .8rem; margin: 0 0 1.6rem; }
.cov-tile { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; padding: .8rem 1rem; }
.cov-tile .n { font-size: 1.8rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; }
.cov-tile .label { font-size: .82rem; font-weight: 700; }
.cov-tile .desc { font-size: .74rem; color: var(--ink-soft); margin-top: .25rem; }
.cov-tile.k-direct .n, .cov-tile.k-direct .label { color: var(--direct); }
.cov-tile.k-rollup .n, .cov-tile.k-rollup .label { color: var(--rollup); }
.cov-tile.k-manual .n, .cov-tile.k-manual .label { color: var(--manual); }
.cov-tile.k-none .n, .cov-tile.k-none .label { color: var(--none); }
h2 { font-size: 1.05rem; margin: 2rem 0 .6rem; padding-bottom: .3rem; border-bottom: 1px solid var(--rule); }
.cov-filter { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin: 0 0 .8rem; }
.cov-filter-label { font-size: .78rem; color: var(--ink-soft); }
.cov-filter-btn { font: inherit; font-size: .78rem; padding: .2rem .7rem; border-radius: 999px;
  border: 1px solid var(--accent); background: var(--surface); color: var(--accent); cursor: pointer; }
.cov-filter-btn.active { background: var(--accent); color: #fff; }
table { width: 100%; border-collapse: collapse; font-size: .84rem; }
.table-scroll { overflow-x: auto; }
th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { font-size: .74rem; letter-spacing: .06em; color: var(--ink-soft); font-weight: 700; white-space: nowrap; }
td.id { font-family: var(--mono); font-weight: 700; white-space: nowrap; }
td.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.badge { font-size: .7rem; padding: .1rem .5rem; border-radius: 999px; white-space: nowrap;
  border: 1px solid var(--rule); background: var(--manual-soft); color: var(--manual); }
.badge.k-direct { border-color: var(--direct); background: var(--direct-soft); color: var(--direct); }
.badge.k-rollup { border-color: var(--rollup); background: var(--rollup-soft); color: var(--rollup); }
.badge.k-none { border-color: var(--none); background: var(--none-soft); color: var(--none); }
.kind-chip { font-family: var(--mono); font-size: .68rem; color: var(--ink-soft); white-space: nowrap; }
.files { font-family: var(--mono); font-size: .72rem; color: var(--ink-soft); }
.bar { position: relative; height: .55rem; background: var(--rule); border-radius: 999px; min-width: 90px; }
.bar > span { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--accent); }
.bar.low > span { background: var(--none); }
.note { font-size: .82rem; color: var(--ink-soft); margin: .6rem 0 0; }
.uncounted { background: var(--none-soft); border: 1px solid var(--none); border-radius: 8px;
  padding: .8rem 1rem; font-size: .85rem; color: var(--none); }
`;

const JS = `(function () {
${REVIEW_NAV_JS}
function filterRows(kind) {
  document.querySelectorAll('.cov-filter-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-kind') === kind);
  });
  document.querySelectorAll('tr[data-kind]').forEach(function (tr) {
    tr.style.display = (kind === '*' || tr.getAttribute('data-kind') === kind) ? '' : 'none';
  });
  return false;
}
window.REQ_COVERAGE = { filterRows: filterRows };
// ヘッダのビュー切替タブ（SOL-30）。イシュービューと同じ扱い——書き戻しは持たないが、
// サーバ配信されていればタブで他のビューへ行ける（施主指示 2026-08-11）。
applyReviewNav(document, function (id) { return document.getElementById(id); }, false);
})();
`;

function renderBadge(kind: CoverageKind): string {
  const meta = KIND_META.get(kind);
  return `<span class="badge k-${kind}">${esc(meta?.label ?? kind)}</span>`;
}

function renderRequirementRow(r: RequirementCoverage): string {
  const kindLabel = r.kind !== null ? (KIND_COLLAPSED_LABEL.get(r.kind) ?? r.kind) : "?";
  const evidence =
    r.coverage === "direct"
      ? r.testFiles.map((f) => esc(f.replace(/^tests\//, ""))).join(" ")
      : r.coverage === "rollup"
        ? `${r.via.map((v) => esc(v)).join(" ")} 経由`
        : "";
  return (
    `<tr data-kind="${r.coverage}">` +
    `<td class="id">${esc(r.id)}</td>` +
    `<td><span class="kind-chip">${esc(kindLabel)}</span></td>` +
    `<td>${esc(r.title)}</td>` +
    `<td>${renderBadge(r.coverage)}</td>` +
    `<td class="num">${r.coverage === "direct" ? r.testFileCount : ""}</td>` +
    `<td class="files">${evidence}</td>` +
    "</tr>"
  );
}

function buildBody(result: CoverageResult): string {
  const total = result.requirements.length;
  const parts: string[] = [];
  parts.push(
    renderSiteHeader({
      view: "coverage",
      subtitle: "テストの十分性",
      extraHtml:
        '<span class="spacer"></span>' +
        `<span class="review-filter-count">テストの穴 ${result.summary.none} 件</span>`,
    }),
  );
  parts.push("<main>");
  parts.push(
    '<p class="cov-guide">テストの十分性を 2 つの軸で示します。上段は「どの要求・要件に、それを検査するテストがあるか」、下段は「実装のどれだけがテストで実行されたか」です。片方だけでは十分性は判断できないため並べています。この画面は読み取り専用です。</p>',
  );

  // 要件の被覆: 判定ごとのタイル
  parts.push("<h2>要件のテスト被覆</h2>");
  parts.push('<div class="cov-tiles">');
  for (const kind of ["direct", "rollup", "manual", "none"] as CoverageKind[]) {
    const meta = KIND_META.get(kind);
    parts.push(
      `<div class="cov-tile k-${kind}">` +
        `<div class="n">${result.summary[kind]}</div>` +
        `<div class="label">${esc(meta?.label ?? kind)}</div>` +
        `<div class="desc">${esc(meta?.desc ?? "")}</div>` +
        "</div>",
    );
  }
  parts.push("</div>");

  // 穴（none）が 1 件でもあれば、それを先に名指しで出す——一覧を読ませる前に「何が足りないか」を渡す
  const holes = result.requirements.filter((r) => r.coverage === "none");
  if (holes.length > 0) {
    parts.push(
      `<div class="uncounted"><strong>テストの穴 ${holes.length} 件</strong>: ` +
        holes.map((h) => `<code>${esc(h.id)}</code>`).join(" ") +
        "</div>",
    );
  }

  // 絞り込み＋一覧
  parts.push('<div class="cov-filter">');
  parts.push('<span class="cov-filter-label">判定で絞り込み:</span>');
  parts.push(
    `<button type="button" class="cov-filter-btn active" data-kind="*" onclick="return REQ_COVERAGE.filterRows('*');">すべて ${total}</button>`,
  );
  for (const kind of ["direct", "rollup", "manual", "none"] as CoverageKind[]) {
    if (result.summary[kind] === 0) continue;
    const meta = KIND_META.get(kind);
    parts.push(
      `<button type="button" class="cov-filter-btn" data-kind="${kind}" ` +
        `onclick="return REQ_COVERAGE.filterRows('${kind}');">${esc(meta?.label ?? kind)} ${result.summary[kind]}</button>`,
    );
  }
  parts.push("</div>");
  parts.push('<div class="table-scroll"><table>');
  parts.push(
    "<thead><tr><th>ID</th><th>種別</th><th>タイトル</th><th>判定</th><th>テスト数</th><th>根拠</th></tr></thead><tbody>",
  );
  for (const r of result.requirements) parts.push(renderRequirementRow(r));
  parts.push("</tbody></table></div>");
  parts.push(
    '<p class="note">対応づけの根拠はテストコード中の ID 参照です（別の対応表は持ちません——台帳は実体とずれるため）。' +
      "したがって ID を書いていないテストは根拠になりません。廃止・却下されたレコードは対象外です。</p>",
  );

  // 行カバレッジ
  parts.push("<h2>行カバレッジ（scripts/）</h2>");
  if (result.lines === null) {
    parts.push(
      '<div class="uncounted">未計測です。' +
        "<code>node --test --experimental-test-coverage --test-reporter=lcov " +
        "--test-reporter-destination=coverage.lcov \"tests/**/*.test.ts\"</code> で計測し、" +
        "<code>--lcov coverage.lcov</code> を渡すとここに表示されます" +
        "（計測はテスト全体の実行を伴うため、ビューを開くたびには走らせません）。</div>",
    );
  } else {
    const found = result.lines.reduce((a, b) => a + b.linesFound, 0);
    const hit = result.lines.reduce((a, b) => a + b.linesHit, 0);
    const rate = found === 0 ? 0 : (hit / found) * 100;
    parts.push('<div class="cov-tiles">');
    parts.push(
      `<div class="cov-tile"><div class="n">${rate.toFixed(1)}%</div><div class="label">全体</div>` +
        `<div class="desc">${hit} / ${found} 行が実行された</div></div>`,
    );
    parts.push("</div>");
    parts.push('<div class="table-scroll"><table>');
    parts.push("<thead><tr><th>ファイル</th><th>行カバレッジ</th><th>割合</th><th>実行 / 全体</th></tr></thead><tbody>");
    // 低いものから並べる（読み手の関心は「どこが薄いか」にある）
    for (const f of [...result.lines].sort((a, b) => a.lineRate - b.lineRate)) {
      const pct = f.lineRate * 100;
      parts.push(
        "<tr>" +
          `<td class="files">${esc(f.file.replace(/^scripts\//, ""))}</td>` +
          `<td><div class="bar${pct < 70 ? " low" : ""}"><span style="width:${pct.toFixed(1)}%"></span></div></td>` +
          `<td class="num">${pct.toFixed(1)}%</td>` +
          `<td class="num">${f.linesHit} / ${f.linesFound}</td>` +
          "</tr>",
      );
    }
    parts.push("</tbody></table></div>");
  }
  parts.push("</main>");
  return parts.join("");
}

/** カバレッジビューの完全 HTML を生成する（バンドル対象外＝fragment の口を持たない）。 */
export function buildCoverageHtml(root: string, lcovPath: string | null = null): string {
  const result = runCoverage(root, lcovPath);
  const parts: string[] = [];
  parts.push("<!doctype html>");
  parts.push('<html lang="ja">');
  parts.push("<head>");
  parts.push('<meta charset="UTF-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
  parts.push(`<title>${pageTitle("coverage", "テストの十分性")}</title>`);
  parts.push(`<style>\n${CSS}\n</style>`);
  parts.push("</head>");
  parts.push("<body>");
  parts.push(buildBody(result));
  parts.push(`<script>\n${JS}\n</script>`);
  parts.push("</body>");
  parts.push("</html>");
  return parts.join("\n") + "\n";
}

function main(): number {
  const { values } = parseArgs({
    options: { root: { type: "string" }, lcov: { type: "string" }, out: { type: "string" } },
  });
  const root = values.root ?? defaultRoot();
  const html = buildCoverageHtml(root, values.lcov ?? null);
  if (values.out === undefined) {
    process.stdout.write(html);
  } else {
    fs.mkdirSync(path.dirname(values.out), { recursive: true });
    fs.writeFileSync(values.out, html, "utf-8");
    console.log(`req_coverage_view: ${values.out} を生成しました。`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
