#!/usr/bin/env python3
"""collect.py の JSON から、表とグラフのタブを持つ 1 枚の自己完結 HTML を書く。

    python3 render.py --data map.json --out map.html [--branch-re '^issue-(\\d+)-']

辺は永続化しない。埋め込んだ JS（DERIVE_JS）がブラウザで導く。テストは同じ JS を node で呼ぶ。
"""
import argparse, json, os, re

DEFAULT_BRANCH_RE = r"^issue-(\d+)-"

DERIVE_JS = r"""
function byId(a, b) {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  return na ? -1 : nb ? 1 : (a < b ? -1 : a > b ? 1 : 0);
}
function pairKey(a, b) { return [a, b].sort(byId).join(' '); }

function childrenOf(D) {
  const out = {};
  Object.entries(D.i || {}).forEach(([n, v]) => {
    if (v.p != null) (out[String(v.p)] = out[String(v.p)] || []).push(n);
  });
  Object.values(out).forEach(k => k.sort(byId));
  return out;
}

function prsOfCommit(D) {
  const out = {};
  Object.entries(D.p || {}).forEach(([n, v]) =>
    (v.cm || []).concat(v.mc ? [v.mc] : []).forEach(c => {
      const l = out[c] = out[c] || [];
      if (!l.includes(n)) l.push(n);
    }));
  return out;
}

// 辺 {k, a, b, s}。k: order / impl / stack / share / mention、s: api / text / name。
function deriveEdges(D, branchRe) {
  const I = D.i || {}, P = D.p || {}, out = [], seen = new Set();
  const add = (k, a, b, s) => {
    a = String(a); b = String(b);
    const key = k + ' ' + (k === 'share' ? pairKey(a, b) : a + ' ' + b);
    if (a === b || seen.has(key)) return;
    seen.add(key); out.push({k, a, b, s});
  };
  // #N は issue と PR で番号空間を共有する。正規表現で拾った番号は PR でないときだけ issue とみなす。
  const notPR = x => !(String(x) in P);
  Object.entries(I).forEach(([n, v]) => (v.b || []).forEach(b => add('order', b, n, 'api')));
  const re = new RegExp(branchRe);
  Object.entries(P).forEach(([n, v]) => {
    (v.cl || []).forEach(x => add('impl', n, x, 'api'));
    (v.kw || []).filter(notPR).forEach(x => add('impl', n, x, 'text'));
    const m = re.exec(v.h || '');
    if (m && m[1] && notPR(m[1])) add('impl', n, m[1], 'name');
  });
  const heads = {};
  Object.entries(P).forEach(([n, v]) => { if (v.h) (heads[v.h] = heads[v.h] || []).push(n); });
  Object.entries(P).forEach(([n, v]) => (heads[v.bs] || []).forEach(m => add('stack', m, n, 'api')));
  const stacked = new Set(out.filter(e => e.k === 'stack').map(e => pairKey(e.a, e.b)));
  const byCommit = {};
  Object.entries(P).forEach(([n, v]) => (v.cm || []).forEach(c => (byCommit[c] = byCommit[c] || []).push(n)));
  Object.values(byCommit).forEach(ns => ns.forEach((a, i) => ns.slice(i + 1).forEach(b => {
    if (!stacked.has(pairKey(a, b))) add('share', ...[a, b].sort(byId), 'api');
  })));
  const implPair = new Set(out.filter(e => e.k === 'impl').map(e => pairKey(e.a, e.b)));
  const mention = (a, b) => { if (!implPair.has(pairKey(String(a), String(b)))) add('mention', a, b, 'api'); };
  const cpr = prsOfCommit(D);
  [I, P].forEach(T => Object.entries(T).forEach(([n, v]) => {
    (v.x || []).forEach(x => mention(x, n));
    (v.rc || []).forEach(c => (cpr[c] || []).forEach(pr => mention(pr, n)));
  }));
  return out;
}

// 絞り込みを当てた図の中身。o: {kinds, srcs, hidePR, hops, clusters, match(id)}
function view(D, edges, o) {
  let es = edges.filter(e => o.kinds.has(e.k) && o.srcs.has(e.s));
  if (o.hidePR) {
    const P = D.p || {}, impl = {}, seen = new Set(), out = [];
    edges.filter(e => e.k === 'impl').forEach(e => (impl[e.a] = impl[e.a] || []).push(e.b));
    const ends = x => x in P ? (impl[x] || []) : [x];
    es.filter(e => e.k !== 'impl').forEach(e => ends(e.a).forEach(a => ends(e.b).forEach(b => {
      const key = e.k + ' ' + a + ' ' + b;
      if (a === b || seen.has(key)) return;
      seen.add(key);
      out.push({k: e.k, a, b, s: e.s, via: e.a === a && e.b === b ? null : '#' + e.a + ' → #' + e.b});
    })));
    es = out;
  }
  es = es.filter(e => o.hops ? (o.match(e.a) || o.match(e.b)) : (o.match(e.a) && o.match(e.b)));
  const nodes = new Map();
  const put = x => { if (!nodes.has(x)) nodes.set(x, !o.match(x)); };
  es.forEach(e => { put(e.a); put(e.b); });
  const clusters = [];
  if (o.clusters) Object.entries(childrenOf(D)).forEach(([p, kids]) => {
    const members = [p].concat(kids).filter(x => nodes.has(x) || o.match(x));
    if (members.length < 2) return;
    members.forEach(put);
    clusters.push({p, members});
  });
  return {nodes: [...nodes].map(([id, dim]) => ({id, dim})).sort((x, y) => byId(x.id, y.id)), edges: es, clusters};
}

const BOX_W = 230, BOX_H = 40, GAP_X = 60, GAP_Y = 14, SHELF_W = 1500;
// 段は有向の辺の最長経路で決める（循環があっても止まる）。連結成分ごとに並べ、幅を超えたら折り返す。
function layout(v) {
  const ids = v.nodes.map(n => n.id), layer = {}, parent = {};
  ids.forEach(n => { layer[n] = 0; parent[n] = n; });
  const dir = v.edges.filter(e => e.k !== 'share');
  for (let round = 0; round < ids.length; round++) {
    let moved = false;
    dir.forEach(e => { if (layer[e.b] < layer[e.a] + 1) { layer[e.b] = layer[e.a] + 1; moved = true; } });
    if (!moved) break;
  }
  const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const join = (a, b) => { parent[find(a)] = find(b); };
  v.edges.forEach(e => join(e.a, e.b));
  const group = {};
  v.clusters.forEach(c => c.members.forEach(m => { join(m, c.p in parent ? c.p : c.members[0]); group[m] = group[m] || c.p; }));
  const comps = {};
  ids.forEach(n => (comps[find(n)] = comps[find(n)] || []).push(n));
  const pos = {};
  let x0 = 0, y0 = 0, rowH = 0;
  const BAND = 24;
  Object.values(comps).sort((a, b) => b.length - a.length).forEach(comp => {
    const cols = {};
    comp.forEach(n => (cols[layer[n]] = cols[layer[n]] || []).push(n));
    const keys = Object.keys(cols).map(Number), lo = Math.min(...keys);
    // 枠の中に枠の外のノードが入らないよう、親子の組ごとに行の帯を取り、組に属さないノードはその下に置く。
    const groups = [...new Set(comp.map(n => group[n]).filter(Boolean))].sort(byId);
    const band = {}, rowOf = {};
    let rows = 0;
    groups.forEach((g, i) => {
      band[g] = {start: rows, i};
      rows += Math.max(...Object.values(cols).map(c => c.filter(n => group[n] === g).length));
    });
    Object.values(cols).forEach(c => {
      const used = {};
      let free = rows;
      c.sort(byId).forEach(n => {
        const g = group[n];
        rowOf[n] = g ? [band[g].start + (used[g] = (used[g] || 0) + 1) - 1, band[g].i] : [free++, groups.length];
      });
    });
    const yOf = n => y0 + 18 + rowOf[n][0] * (BOX_H + GAP_Y) + rowOf[n][1] * BAND;
    const w = (Math.max(...keys) - lo + 1) * (BOX_W + GAP_X) - GAP_X;
    const h = Math.max(...comp.map(yOf)) - y0 + BOX_H;
    if (x0 && x0 + w > SHELF_W) { x0 = 0; y0 += rowH + 40; rowH = 0; }
    comp.forEach(n => { pos[n] = [x0 + (layer[n] - lo) * (BOX_W + GAP_X), yOf(n)]; });
    x0 += w + 50; rowH = Math.max(rowH, h);
  });
  return pos;
}

if (typeof module !== 'undefined') module.exports = {deriveEdges, childrenOf, view, layout, prsOfCommit};
"""

HTML = r"""<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__REPO__ issue map</title>
<style>
:root{--fg:#1f2328;--mut:#656d76;--line:#d0d7de;--bg:#fff;--soft:#f6f8fa;--acc:#0969da;
  --open:#1a7f37;--open-bg:#dafbe1;--merged:#8250df;--merged-bg:#fbefff;--closed:#6e7781;--closed-bg:#eaeef2;}
@media (prefers-color-scheme: dark){:root{--fg:#e6edf3;--mut:#8d96a0;--line:#30363d;--bg:#0d1117;--soft:#161b22;
  --acc:#4493f8;--open:#3fb950;--open-bg:#12261e;--merged:#a371f7;--merged-bg:#231a35;--closed:#8d96a0;--closed-bg:#21262d;}}
html,body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.6 -apple-system,"Segoe UI","Hiragino Kaku Gothic ProN",Meiryo,sans-serif;}
.doc{max-width:1560px;margin:0 auto;padding:18px 16px 80px;}
h1{font-size:20px;font-weight:600;margin:0 0 2px;} .sub{color:var(--mut);font-size:12px;margin:0 0 12px;}
a{color:var(--acc);text-decoration:none;} a:hover{text-decoration:underline;}
code,.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;}
.panel{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 0 6px;z-index:5;}
.row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:5px;}
.lab{font-size:11.5px;color:var(--mut);min-width:56px;}
.chip,.tab{font-size:12px;padding:2px 10px;border:1px solid var(--line);border-radius:14px;background:var(--bg);color:var(--fg);cursor:pointer;}
.chip.on,.tab.on{background:var(--fg);border-color:var(--fg);color:var(--bg);}
.tab{border-radius:4px;font-size:13px;padding:3px 14px;}
label.ck{font-size:12px;display:inline-flex;gap:3px;align-items:center;margin-right:6px;cursor:pointer;}
input[type=search],select{font-size:12.5px;padding:3px 7px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg);}
input[type=search]{width:260px;max-width:100%;}
.count{font-size:12px;color:var(--mut);margin-left:auto;}
details{border:1px solid var(--line);border-radius:4px;margin-bottom:4px;}
summary{list-style:none;cursor:pointer;padding:6px 10px;display:flex;gap:8px;align-items:baseline;}
summary::-webkit-details-marker{display:none;} summary:hover{background:var(--soft);}
details[open]>summary{background:var(--soft);border-bottom:1px solid var(--line);}
.num{font-family:ui-monospace,Menlo,monospace;font-weight:600;flex:none;min-width:58px;}
.ttl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.meta{flex:none;font-size:11.5px;color:var(--mut);}
.st{flex:none;font-size:11px;padding:0 8px;border-radius:10px;color:#fff;}
.st-open{background:var(--open);} .st-merged{background:var(--merged);} .st-closed{background:var(--closed);}
.lbl{flex:none;font-size:10.5px;padding:0 7px;border-radius:9px;border:1px solid var(--line);color:var(--mut);}
.body{padding:8px 14px 10px;font-size:12.5px;} .body h4{margin:8px 0 2px;font-size:12px;color:var(--mut);}
.body ul{margin:0;padding-left:18px;}
.empty{padding:24px;text-align:center;color:var(--mut);}
.grp{margin:14px 0 6px;font-weight:600;color:var(--mut);}
.flash{outline:3px solid #d4a72c;}
[hidden]{display:none!important;} #gwrap svg{display:block;} #gwrap{overflow:auto;border:1px solid var(--line);border-radius:4px;max-height:78vh;}
#graph .nd{cursor:pointer;} #graph .nd:hover rect.box{stroke:var(--fg);stroke-width:2;}
.legend{font-size:11.5px;color:var(--mut);margin:6px 0;}
.legend svg{vertical-align:middle;}
.note{font-size:11.5px;color:var(--mut);margin-top:10px;}
</style></head><body><div class="doc">
<h1>__REPO__ の issue・PR・コミット</h1>
<p class="sub" id="sub"></p>
<div class="panel">
  <div class="row"><button class="tab on" data-tab="table">表</button><button class="tab" data-tab="graph">グラフ</button>
    <span class="count" id="count"></span></div>
  <div class="row"><span class="lab">期間</span><span id="period"></span>
    <span class="lab">状態</span><span id="state"></span><span class="lab">種類</span><span id="type"></span></div>
  <div class="row"><span class="lab">ラベル</span><select id="label"></select>
    <span class="lab">検索</span><input type="search" id="q" placeholder="番号・題名・作者・ブランチ・コミット（空白で AND）"></div>
  <div class="row" id="gopts" hidden><span class="lab">辺</span>
    <label class="ck"><input type="checkbox" name="kind" value="order" checked>order</label>
    <label class="ck"><input type="checkbox" name="kind" value="impl" checked>impl</label>
    <label class="ck"><input type="checkbox" name="kind" value="stack" checked>stack</label>
    <label class="ck"><input type="checkbox" name="kind" value="share">share</label>
    <label class="ck"><input type="checkbox" name="kind" value="mention">mention</label>
    <span class="lab">由来</span>
    <label class="ck"><input type="checkbox" name="src" value="api" checked>api</label>
    <label class="ck"><input type="checkbox" name="src" value="text" checked>text</label>
    <label class="ck"><input type="checkbox" name="src" value="name" checked>name</label>
    <span class="lab">表示</span>
    <label class="ck"><input type="checkbox" id="hidepr">PR を隠す</label>
    <label class="ck"><input type="checkbox" id="clusters" checked>親子の枠</label>
    <label class="ck"><input type="checkbox" id="hops" checked>絞り込み外の相手も薄く出す</label></div>
</div>
<div id="table"></div>
<div id="graph" hidden>
  <div class="legend" id="legend"></div>
  <div id="gwrap"></div>
</div>
<p class="note">辺の向き: order は止める issue → 止められる issue、impl は PR → issue、stack は土台の PR → 上の PR、
mention は言及元 → 先。share（同じコミットを含む PR）は向きなし。由来 api は GitHub の構造化データ、text は PR 本文の
<code>Closes #N</code>、name はブランチ名（<code>__BRANCHRE_TEXT__</code>）から推したもの。
同じ 2 点に impl があれば mention を、stack があれば share を描かない。</p>
<script type="application/json" id="data">__DATA__</script>
<script>__DERIVE__</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const BRANCH_RE = __BRANCHRE__;
const I = D.i || {}, P = D.p || {}, CS = D.cs || {};
const EDGES = deriveEdges(D, BRANCH_RE);
const KIDS = childrenOf(D), CPR = prsOfCommit(D);
const ALL = Object.keys(I).concat(Object.keys(P)).sort((a, b) => Number(b) - Number(a));
const AT = new Date(D.at);
const PERIODS = [['1週間', 7], ['1ヶ月', 31], ['3ヶ月', 92], ['全部', 0]];
const STATES = [['すべて', ''], ['open', 'open'], ['closed', 'closed'], ['merged', 'merged']];
const TYPES = [['すべて', ''], ['issue', 'i'], ['PR', 'p']];
let period = 0, state = '', type = '', label = '', terms = [], tab = 'table', shown = 200;

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const item = id => I[id] ? {t: 'i', v: I[id]} : P[id] ? {t: 'p', v: P[id]} : null;
const lastOf = v => v.d || v.c || '';
function url(id) {
  const m = /^(.+)#(\d+)$/.exec(id);
  if (m) return 'https://github.com/' + m[1] + '/issues/' + m[2];
  return 'https://github.com/' + D.repo + (P[id] ? '/pull/' : '/issues/') + id;
}
const ext = (id, label) => `<a href="${esc(url(id))}" target="_blank" rel="noopener" title="GitHub で開く">${esc(label || '#' + id)}↗</a>`;
const implTo = {}, implFrom = {};
EDGES.filter(e => e.k === 'impl').forEach(e => {
  (implTo[e.a] = implTo[e.a] || []).push(e);
  (implFrom[e.b] = implFrom[e.b] || []).push(e);
});
const blocking = {};
Object.entries(I).forEach(([n, v]) => (v.b || []).forEach(b => (blocking[b] = blocking[b] || []).push(n)));

const HAY = {};
function hay(id) {
  if (HAY[id]) return HAY[id];
  const v = item(id).v, p = [id, '#' + id, v.t, v.a, (v.l || []).join(' '), v.h, v.bs];
  (v.cm || []).concat(v.mc ? [v.mc] : [], v.rc || []).forEach(c => p.push(c, ...(CS[c] || [])));
  return HAY[id] = p.filter(Boolean).join(' ').toLowerCase();
}
function daysBefore(d) { return d ? (AT - new Date(d + 'T00:00:00Z')) / 86400000 : 1e9; }
function match(id) {
  const it = item(id);
  if (!it) return false;
  if (period && daysBefore(lastOf(it.v)) > period) return false;
  if (state && it.v.s !== state) return false;
  if (type && it.t !== type) return false;
  if (label && !(it.v.l || []).includes(label)) return false;
  return terms.every(w => hay(id).includes(w));
}

function stBadge(v) {
  const txt = v.s + (v.r ? ' (' + v.r.replace('_', ' ') + ')' : '') + (v.dr ? ' draft' : '');
  return `<span class="st st-${v.s}">${esc(txt)}</span>`;
}
function commitLi(c) {
  const x = CS[c] || [];
  return `<li><span class="mono">${esc(c)}</span> ${esc(x[2] || '')} <span class="meta">${esc(x[0] || '')} ${esc(x[1] || '')}</span></li>`;
}
const refs = ns => ns.map(n => item(String(n)) ? `<a href="#" data-jump="${esc(n)}">#${esc(n)}</a>` : ext(String(n))).join(' ');
const SRC = {api: '', text: '（本文の Closes から）', name: '（ブランチ名から）'};
function prBlock(n, how) {
  const v = P[n];
  const out = [`<li>${ext(n)} ${stBadge(v)} ${esc(v.t)} ${how ? '<span class="meta">' + how + '</span>' : ''}<br>`,
    `<span class="meta mono">${esc(v.h || '')} → ${esc(v.bs || '')}</span> <span class="meta">${esc(v.a || '')} ${esc(v.c || '')}${v.d ? ' – ' + esc(v.d) : ''}</span><ul>`];
  (v.cm || []).forEach(c => out.push(commitLi(c)));
  if (v.mc && !(v.cm || []).includes(v.mc)) out.push('<li class="meta">マージコミット</li>' + commitLi(v.mc));
  out.push('</ul></li>');
  return out.join('');
}
function detail(id) {
  const it = item(id), v = it.v, out = [];
  const line = (h, xs) => { if (xs && xs.length) out.push(`<h4>${h}</h4><ul><li>${refs(xs)}</li></ul>`); };
  if (it.t === 'i') {
    if (v.p != null) line('親', [v.p]);
    line('子', KIDS[id]);
    line('止めている issue（blocked by）', v.b);
    line('止められている issue（blocking）', blocking[id]);
    const prs = (implFrom[id] || []).filter(e => P[e.a]);
    if (prs.length) out.push('<h4>この issue の作業をする PR</h4><ul>' + prs.map(e => prBlock(e.a, SRC[e.s])).join('') + '</ul>');
  } else {
    out.push('<ul>' + prBlock(id, '') + '</ul>');
    line('この PR が作業する issue', (implTo[id] || []).map(e => e.b));
  }
  if ((v.rc || []).length) out.push('<h4>本文でこれを参照したコミット</h4><ul>' + v.rc.map(c =>
    commitLi(c).replace('</li>', CPR[c] ? ' <span class="meta">PR ' + CPR[c].map(p => '#' + p).join(' ') + '</span></li>' : ' <span class="meta">PR なし（直接 push）</span></li>')).join('') + '</ul>');
  line('言及した issue / PR', v.x);
  out.push(`<h4>リンク</h4><ul><li>${ext(id, (it.t === 'i' ? 'issue #' : 'PR #') + id)}</li></ul>`);
  return out.join('');
}
function rowHtml(id) {
  const it = item(id), v = it.v, prs = it.t === 'i' ? (implFrom[id] || []).filter(e => P[e.a]) : [];
  return `<details id="n-${id}" data-n="${id}"><summary><span class="num">${ext(id)}</span>${stBadge(v)}` +
    `<span class="meta">${it.t === 'i' ? 'issue' : 'PR'}</span><span class="ttl">${esc(v.t)}</span>` +
    (v.l || []).map(l => `<span class="lbl">${esc(l)}</span>`).join('') +
    (it.t === 'i' ? `<span class="meta">PR ${prs.length}</span>` : '') +
    `<span class="meta">${esc(lastOf(v))}</span></summary><div class="body"></div></details>`;
}

function renderTable(hit) {
  const box = document.getElementById('table');
  const issues = Object.keys(I).filter(n => match(n) || (implFrom[n] || []).some(e => P[e.a] && match(e.a)))
    .sort((a, b) => lastOf(I[b]).localeCompare(lastOf(I[a])) || b - a);
  const orphan = Object.keys(P).filter(n => match(n) && !(implTo[n] || []).some(e => I[e.b]))
    .sort((a, b) => lastOf(P[b]).localeCompare(lastOf(P[a])) || b - a);
  const rows = issues.concat(orphan.length ? ['_none'] : [], orphan);
  if (!issues.length && !orphan.length) { box.innerHTML = '<div class="empty">条件に合うものがありません。</div>'; return; }
  let html = rows.slice(0, shown).map(n => n === '_none'
    ? `<div class="grp">issue に結びつかない PR（${orphan.length}）</div>` : rowHtml(n)).join('');
  if (rows.length > shown) html += `<button class="chip" id="more">さらに表示（残り ${rows.length - shown}）</button>`;
  box.innerHTML = html;
  const more = document.getElementById('more');
  if (more) more.onclick = () => { shown += 200; render(); };
}
document.getElementById('table').addEventListener('toggle', e => {
  const d = e.target, b = d.querySelector && d.querySelector('.body');
  if (d.open && b && !b.dataset.done) { b.innerHTML = detail(d.dataset.n); b.dataset.done = '1'; }
}, true);

const COLORS = {open: ['--open-bg', '--open'], merged: ['--merged-bg', '--merged'], closed: ['--closed-bg', '--closed']};
const EDGE_STYLE = {
  order: {c: '#cf222e', w: 1.8, d: '', arrow: true}, stack: {c: '#8250df', w: 3.2, d: '', arrow: true},
  impl: {c: '#0969da', w: 1.2, d: '', arrow: true}, share: {c: '#6e7781', w: 1.4, d: '2 3', arrow: false},
  mention: {c: '#8c959f', w: 1, d: '4 4', arrow: true}};
function clip(s, px) {
  let used = 0;
  for (let i = 0; i < s.length; i++) { used += s.charCodeAt(i) > 0x7f ? 12 : 6.6; if (used > px) return s.slice(0, i) + '…'; }
  return s;
}
function opts() {
  const on = n => new Set([...document.querySelectorAll(`input[name=${n}]:checked`)].map(x => x.value));
  return {kinds: on('kind'), srcs: on('src'), hidePR: document.getElementById('hidepr').checked,
    clusters: document.getElementById('clusters').checked, hops: document.getElementById('hops').checked ? 1 : 0, match};
}
function renderGraph() {
  const v = view(D, EDGES, opts()), pos = layout(v), wrap = document.getElementById('gwrap');
  const counts = {};
  v.edges.forEach(e => counts[e.k] = (counts[e.k] || 0) + 1);
  document.getElementById('legend').innerHTML = legend() + '<br>描いた辺: ' +
    (Object.entries(counts).map(([k, n]) => k + ' ' + n).join('、') || 'なし') + ' ／ ノード ' + v.nodes.length;
  if (!v.nodes.length) { wrap.innerHTML = '<div class="empty">描く辺がありません。辺の種類や絞り込みを変えてください。</div>'; return; }
  const W = Math.max(...Object.values(pos).map(p => p[0])) + BOX_W + 20;
  const H = Math.max(...Object.values(pos).map(p => p[1])) + BOX_H + 20;
  const s = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-size="12" font-family="sans-serif"><defs>`,
    '<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">',
    '<rect width="6" height="6" fill="var(--closed-bg)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--closed)" stroke-width="1.2" opacity=".5"/></pattern>'];
  Object.entries(EDGE_STYLE).forEach(([k, st]) => s.push(`<marker id="ar-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${st.c}"/></marker>`));
  s.push('</defs>');
  v.clusters.forEach(c => {
    const ps = c.members.filter(m => pos[m]).map(m => pos[m]);
    const x = Math.min(...ps.map(p => p[0])) - 8, y = Math.min(...ps.map(p => p[1])) - 16;
    const w = Math.max(...ps.map(p => p[0])) + BOX_W + 8 - x, h = Math.max(...ps.map(p => p[1])) + BOX_H + 8 - y;
    s.push(`<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="none" stroke="#d4a72c" stroke-width="1.5" stroke-dasharray="6 3"/>` +
      `<text x="${x + 8}" y="${y + 11}" font-size="10.5" fill="#9a6700">#${esc(c.p)} の子</text></g>`);
  });
  v.edges.forEach(e => {
    let [xa, ya] = pos[e.a], [xb, yb] = pos[e.b];
    const st = EDGE_STYLE[e.k];
    let sx = xa + BOX_W, sy = ya + BOX_H / 2, ex = xb, ey = yb + BOX_H / 2;
    if (xa === xb) { sx = xa + BOX_W / 2; sy = ya + (yb > ya ? BOX_H : 0); ex = xb + BOX_W / 2; ey = yb + (yb > ya ? 0 : BOX_H); }
    else if (xa > xb) { sx = xa; ex = xb + BOX_W; }
    const mx = (sx + ex) / 2, d = xa === xb ? `M${sx},${sy} C${sx + 40},${sy} ${ex + 40},${ey} ${ex},${ey}`
      : `M${sx},${sy} C${mx},${sy} ${mx},${ey} ${ex},${ey}`;
    const tip = `${e.k}: #${e.a} → #${e.b}` + (SRC[e.s] || '') + (e.via ? `（PR を隠したため。元は ${e.via}）` : '');
    s.push(`<path d="${d}" fill="none" stroke="${st.c}" stroke-width="${st.w}" stroke-dasharray="${st.d}"` +
      ` opacity="${e.s === 'api' ? 0.9 : 0.4}"${st.arrow ? ` marker-end="url(#ar-${e.k})"` : ''}><title>${esc(tip)}</title></path>`);
  });
  v.nodes.forEach(n => {
    const [x, y] = pos[n.id], it = item(n.id), vv = it && it.v;
    const isPR = it && it.t === 'p', [bg, fg] = vv ? COLORS[vv.s] : ['--bg', '--closed'];
    const fill = vv && vv.r === 'not_planned' ? 'url(#hatch)' : `var(${bg})`;
    const stroke = vv ? `stroke="var(${fg})"` : 'stroke="var(--closed)" stroke-dasharray="4 3"';
    const sub = vv ? (isPR ? 'PR' : 'issue') + ' · ' + vv.s + (vv.r ? ' (' + vv.r.replace('_', ' ') + ')' : '') + (vv.dr ? ' · draft' : '') : '範囲外';
    s.push(`<g class="nd" data-n="${esc(n.id)}" opacity="${n.dim ? 0.45 : 1}"><title>${esc('#' + n.id + ' ' + (vv ? vv.t : '（収集の範囲外）'))}</title>` +
      `<rect class="box" x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="${isPR ? 0 : 10}" fill="${fill}" ${stroke} stroke-width="1.3"/>` +
      `<text x="${x + 9}" y="${y + 16}" fill="var(--fg)"><tspan font-weight="600">#${esc(n.id)}</tspan> ${esc(clip(vv ? vv.t : '', BOX_W - 70 - 7 * String(n.id).length))}</text>` +
      `<text x="${x + 9}" y="${y + 32}" font-size="10.5" fill="var(${fg})">${esc(sub)}</text>` +
      `<a href="${esc(url(n.id))}" target="_blank" rel="noopener"><title>GitHub で開く</title><rect x="${x + BOX_W - 22}" y="${y}" width="22" height="18" fill="transparent"/>` +
      `<text x="${x + BOX_W - 16}" y="${y + 13}" fill="var(--acc)" font-weight="bold">↗</text></a></g>`);
  });
  s.push('</svg>');
  wrap.innerHTML = s.join('');
}
function legend() {
  const line = k => { const st = EDGE_STYLE[k];
    return `<svg width="34" height="10"><line x1="1" y1="5" x2="33" y2="5" stroke="${st.c}" stroke-width="${st.w}" stroke-dasharray="${st.d}"/></svg>${k}`; };
  const box = (rx, v, t) => `<svg width="22" height="14"><rect x="1" y="1" width="20" height="12" rx="${rx}" fill="var(${v}-bg)" stroke="var(${v})"/></svg>${t}`;
  return Object.keys(EDGE_STYLE).map(line).join(' ') + ' ／ ' + box(5, '--open', 'issue') + ' ' + box(0, '--open', 'PR') +
    ' 色: <span style="color:var(--open)">open</span> <span style="color:var(--merged)">merged</span> <span style="color:var(--closed)">closed</span>（斜線は not planned、破線の枠は収集の範囲外） ／ 箱を押すと表の行へ、↗ は GitHub';
}
document.getElementById('gwrap').addEventListener('click', e => {
  if (e.target.closest('a')) return;
  const g = e.target.closest('g.nd');
  if (g && !jumpTo(g.dataset.n)) window.open(url(g.dataset.n), '_blank', 'noopener');
});
document.getElementById('table').addEventListener('click', e => {
  const a = e.target.closest('a[data-jump]');
  if (a) { e.preventDefault(); jumpTo(a.dataset.jump); }
});
function jumpTo(id) {
  if (!item(id)) return false;
  let row = id;
  if (P[id]) { const iss = (implTo[id] || []).find(e => I[e.b]); if (iss) row = iss.b; }
  setTab('table');
  let el = document.getElementById('n-' + row);
  if (!el) {
    period = 0; state = ''; type = ''; label = ''; terms = []; document.getElementById('q').value = '';
    shown = 1e9; render(); el = document.getElementById('n-' + row);
  }
  if (!el) return false;
  el.open = true;
  el.scrollIntoView({block: 'center'});
  el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2000);
  return true;
}

function chips(id, items, cur, set) {
  const el = document.getElementById(id);
  el.innerHTML = '';
  items.forEach(([t, val]) => {
    const b = document.createElement('button');
    b.className = 'chip' + (val === cur ? ' on' : ''); b.textContent = t;
    b.onclick = () => { set(val); shown = 200; render(); };
    el.appendChild(b);
  });
}
function setTab(t) {
  tab = t;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.getElementById('table').hidden = t !== 'table';
  document.getElementById('graph').hidden = t !== 'graph';
  document.getElementById('gopts').hidden = t !== 'graph';
  render();
}
function render() {
  chips('period', PERIODS, period, v => period = v);
  chips('state', STATES, state, v => state = v);
  chips('type', TYPES, type, v => type = v);
  const hit = ALL.filter(match);
  document.getElementById('count').textContent = `該当 ${hit.length} / 全体 ${ALL.length}`;
  if (tab === 'table') renderTable(hit); else renderGraph();
}
(function init() {
  const labels = {};
  Object.values(I).forEach(v => (v.l || []).forEach(l => labels[l] = (labels[l] || 0) + 1));
  const sel = document.getElementById('label');
  sel.innerHTML = '<option value="">すべて</option>' + Object.keys(labels).sort().map(l => `<option value="${esc(l)}">${esc(l)} (${labels[l]})</option>`).join('');
  sel.onchange = () => { label = sel.value; render(); };
  document.getElementById('q').addEventListener('input', e => { terms = e.target.value.toLowerCase().split(/\s+/).filter(Boolean); shown = 200; render(); });
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  document.getElementById('gopts').addEventListener('change', render);
  document.getElementById('sub').textContent = `取得 ${D.at} ／ ${D.since} 以降に更新されたもの ／ issue ${Object.keys(I).length}・PR ${Object.keys(P).length}・コミット ${Object.keys(CS).length}`;
  render();
})();
</script>
</div></body></html>
"""


def embed_json(obj):
    """`<script>` の中に置く JSON。題名に `</script>` や `<!--` があってもページを壊さないよう、< > & を逃がす。"""
    return (json.dumps(obj, ensure_ascii=False)
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))


def render_html(data, branch_re):
    from html import escape
    vals = {"REPO": escape(data["repo"]), "DATA": embed_json(data), "DERIVE": DERIVE_JS,
            "BRANCHRE": embed_json(branch_re), "BRANCHRE_TEXT": escape(branch_re)}
    return re.sub(r"__(REPO|DATA|DERIVE|BRANCHRE_TEXT|BRANCHRE)__", lambda m: vals[m.group(1)], HTML)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="collect.py の出力")
    ap.add_argument("--out", required=True, help="書き出す HTML")
    ap.add_argument("--branch-re", default=DEFAULT_BRANCH_RE,
                    help="PR の head ブランチ名から issue 番号を取る正規表現。1 番目のグループが番号（既定 %(default)s）")
    a = ap.parse_args()
    re.compile(a.branch_re)
    with open(a.data, encoding="utf-8") as f:
        data = json.load(f)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(render_html(data, a.branch_re))
    print(os.path.abspath(a.out))


if __name__ == "__main__":
    main()
