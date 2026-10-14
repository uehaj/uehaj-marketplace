#!/usr/bin/env node
/**
 * req_gaps.ts — 正本と実装状態のギャップを決定的に算出する CLI（SOL-47 / ADR-014）。
 *
 * ギャップ種別 v1（SOL-47 statement (a)）:
 *   - unimpl:  kind=solution_requirement ∧ state.approval=agreed ∧ state.disposition=active ∧
 *              state.implementation ∈ {not_started, in_progress} ∧ axes.implementation_detail が true でない
 *   - review:  axes.review_required=true の全レコード（kind 不問）
 *   - orphan:  どの U（kind=use_case）にも遡られない SR/SOL の単一集約エントリ
 *
 * 出力 JSON はキー順・並び順まで固定した決定的な形（SOL-47 (b)(c)(h)）。
 * 読み取り専用（正本もイシューも書かない。SOL-47 (g)）。
 *
 * lint との境界: lint は正本自体の欠陥、gaps は正本は正しいが世界が追いついていない
 * 状態を検出する（SR-24。同じ検査の二重実装を防ぐため lint 側の検査ロジックは
 * ここでは再実装しない）。
 *
 * 終了コード: 常に 0（ギャップの存在はエラーではない。SOL-47 CLI 仕様）。
 */
import * as path from "node:path";
import * as crypto from "node:crypto";
import { parseArgs } from "node:util";

import { ReqRecord, loadRecords } from "./reqlib.ts";
import { readChangelogHead } from "./req_tree.ts";

function defaultRoot(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

export interface UnimplGap {
  key: string;
  type: "unimpl";
  rec: string;
  parent: string | null;
  hash: string;
}

export interface ReviewGap {
  key: string;
  type: "review";
  rec: string;
  hash: string;
}

export interface OrphanGap {
  key: "orphan";
  type: "orphan";
  recs: string[];
}

export type Gap = UnimplGap | ReviewGap | OrphanGap;

export interface GapsResult {
  corpus: string;
  gaps: Gap[];
}

/** レコードの ID を `[PREFIX, 番号]` に分解する（並び順の安定化用）。 */
function splitId(id: string): [string, number] {
  const m = /^([A-Za-z]+)-0*(\d+)$/.exec(id);
  if (!m) return [id, 0];
  return [m[1], parseInt(m[2], 10)];
}

/** ID の prefix 辞書順 → 番号昇順で比較する（SOL-47: 「prefix順+番号順で安定」）。 */
function compareId(a: string, b: string): number {
  const [pa, na] = splitId(a);
  const [pb, nb] = splitId(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  return na - nb;
}

/** hash: sha256(statement + "\n" + (verification ?? "")) の hex 先頭 8 文字（SOL-47 (d)）。 */
function computeHash(r: ReqRecord): string {
  const statement = typeof r.frontmatter["statement"] === "string" ? (r.frontmatter["statement"] as string) : "";
  const verification = r.verification ?? "";
  const digest = crypto.createHash("sha256").update(`${statement}\n${verification}`).digest("hex");
  return digest.slice(0, 8);
}

/**
 * 正本を検査してギャップ一覧を算出する（決定的。実行時刻・乱数・オブジェクト列挙順に
 * 依存しない）。
 */
export function computeGaps(root: string): GapsResult {
  const { records } = loadRecords(root);

  const byId = new Map<string, ReqRecord>();
  for (const r of records) {
    if (r.id !== null && !byId.has(r.id)) byId.set(r.id, r);
  }

  // U から見た「遡られる」集合: U の traces_to に直接現れる SR/SOL の ID → その U 群。
  const tracedByUse = new Map<string, string[]>(); // 遡られる対象 ID -> 遡る U ID の一覧
  for (const r of records) {
    if (r.kind !== "use_case" || r.id === null) continue;
    for (const target of r.tracesTo) {
      const list = tracedByUse.get(target) ?? [];
      list.push(r.id);
      tracedByUse.set(target, list);
    }
  }

  function idNumber(id: string): number {
    const m = /(\d+)$/.exec(id);
    return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
  }

  /** id を直接遡る U 群（U が直接 traces_to している場合）。 */
  function directUses(id: string): string[] {
    return tracedByUse.get(id) ?? [];
  }

  /** SOL が遡られる U 群: 直接遡る U ∪ SOL の traces_to 先 SR を遡る U（SOL-47 orphan 定義）。 */
  function usesReachingSol(sol: ReqRecord): string[] {
    const uses = new Set<string>(directUses(sol.id as string));
    for (const srId of sol.tracesTo) {
      for (const uId of directUses(srId)) uses.add(uId);
    }
    return [...uses];
  }

  // --- unimpl -------------------------------------------------------------
  const unimplGaps: UnimplGap[] = [];
  for (const r of records) {
    if (r.kind !== "solution_requirement" || r.id === null) continue;
    const state = r.state;
    if (state["approval"] !== "agreed") continue;
    if (state["disposition"] !== "active") continue;
    if (state["implementation"] !== "not_started" && state["implementation"] !== "in_progress") continue;
    if (r.axes["implementation_detail"] === true) continue;

    const uses = usesReachingSol(r);
    let parent: string | null = null;
    for (const uId of uses) {
      if (parent === null || idNumber(uId) < idNumber(parent)) parent = uId;
    }
    unimplGaps.push({ key: `unimpl:${r.id}`, type: "unimpl", rec: r.id, parent, hash: computeHash(r) });
  }
  unimplGaps.sort((a, b) => compareId(a.rec, b.rec));

  // --- review --------------------------------------------------------------
  const reviewGaps: ReviewGap[] = [];
  for (const r of records) {
    if (r.id === null) continue;
    if (r.axes["review_required"] !== true) continue;
    reviewGaps.push({ key: `review:${r.id}`, type: "review", rec: r.id, hash: computeHash(r) });
  }
  reviewGaps.sort((a, b) => compareId(a.rec, b.rec));

  // --- orphan ---------------------------------------------------------------
  const orphanRecs: string[] = [];
  for (const r of records) {
    if (r.id === null) continue;
    if (r.kind === "stakeholder_requirement") {
      if (directUses(r.id).length === 0) orphanRecs.push(r.id);
    } else if (r.kind === "solution_requirement") {
      if (usesReachingSol(r).length === 0) orphanRecs.push(r.id);
    }
  }
  orphanRecs.sort(compareId);

  const gaps: Gap[] = [...unimplGaps, ...reviewGaps];
  if (orphanRecs.length > 0) {
    gaps.push({ key: "orphan", type: "orphan", recs: orphanRecs });
  }

  const head = readChangelogHead(root);
  const corpus = head ? `v${head.version}` : "不明";

  return { corpus, gaps };
}

/** JSON をキー順固定でシリアライズする（決定性維持。オブジェクトリテラルの構築順に依存）。 */
export function serializeGaps(result: GapsResult): string {
  const gapsJson = result.gaps
    .map((g) => {
      if (g.type === "orphan") {
        return `{"key":${JSON.stringify(g.key)},"type":${JSON.stringify(g.type)},"recs":${JSON.stringify(g.recs)}}`;
      }
      if (g.type === "unimpl") {
        return (
          `{"key":${JSON.stringify(g.key)},"type":${JSON.stringify(g.type)},` +
          `"rec":${JSON.stringify(g.rec)},"parent":${JSON.stringify(g.parent)},"hash":${JSON.stringify(g.hash)}}`
        );
      }
      return (
        `{"key":${JSON.stringify(g.key)},"type":${JSON.stringify(g.type)},` +
        `"rec":${JSON.stringify(g.rec)},"hash":${JSON.stringify(g.hash)}}`
      );
    })
    .join(",");
  return `{"corpus":${JSON.stringify(result.corpus)},"gaps":[${gapsJson}]}`;
}

function formatSummary(result: GapsResult): string {
  const unimpl = result.gaps.filter((g): g is UnimplGap => g.type === "unimpl");
  const review = result.gaps.filter((g): g is ReviewGap => g.type === "review");
  const orphan = result.gaps.find((g): g is OrphanGap => g.type === "orphan");

  const lines: string[] = [];
  lines.push(`req_gaps: corpus=${result.corpus}`);
  lines.push(`  未実装（unimpl）: ${unimpl.length} 件`);
  for (const g of unimpl) {
    lines.push(`    - ${g.rec}（parent: ${g.parent ?? "なし"}, hash: ${g.hash}）`);
  }
  lines.push(`  要レビュー（review）: ${review.length} 件`);
  for (const g of review) {
    lines.push(`    - ${g.rec}（hash: ${g.hash}）`);
  }
  lines.push(`  孤児（orphan）: ${orphan ? orphan.recs.length : 0} 件`);
  if (orphan) {
    lines.push(`    - ${orphan.recs.join(", ")}`);
  }
  return lines.join("\n");
}

function main(): number {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const root = values.root ?? defaultRoot();
  const result = computeGaps(root);

  if (values.json) {
    console.log(serializeGaps(result));
  } else {
    console.log(formatSummary(result));
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
