#!/usr/bin/env node
/**
 * req_slice.ts — 任意の軸での断面と、その軸での過不足を都度算出する（SOL-6 / SR-10）。
 *
 * 「断面」= ある軸（axes の 1 キー、または種別・状態）の値ごとにレコードを束ねたもの。
 * 「過不足」= その断面ごとに次の 2 つを出す:
 *   過剰（excess）  … どの上位（親 kind）にも仕えない要素。SR-10 の「どの上位要求にも
 *                     仕えない要素」。BR は上位を持たないため対象外。
 *   不足（missing） … その断面に属する上位（BR/SR）のうち、下位から一件も traces_to されて
 *                     いないもの。断面の中に閉じて判定する（断面をまたいだ被覆を求めると
 *                     「グループ A の要件がグループ B の BR を覆っていない」という当然の事実が
 *                     全断面に並び、読めるシグナルにならない。初版で実測して改めた）。
 *
 * lint の親なし要件・未カバー要求（トレーサビリティ軸のみ）を、任意の軸へ一般化したもの
 * （SR-10 の statement: 「SR-4 の必要性・十分性検査をトレーサビリティ軸以外の全軸へ一般化」）。
 * lint と重複する検査を再実装しているのではなく、lint が軸を固定して「違反」を出すのに対し、
 * 本スクリプトは軸を引数に取り「その断面での過不足」を出す（SR-24: 役割が違う）。
 *
 * 出力は決定的（値の昇順・ID 昇順）。実行時刻・乱数は使わない。読み取り専用。
 */
import * as path from "node:path";
import { parseArgs } from "node:util";

import { ReqRecord, loadRecords } from "./reqlib.ts";

function defaultRoot(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

/** 下位 kind → その上位 kind（トレーサビリティの向き）。 */
const PARENT_KIND: ReadonlyMap<string, string> = new Map([
  ["stakeholder_requirement", "business_requirement"],
  ["solution_requirement", "stakeholder_requirement"],
]);

/** 軸として使える特別な名前（axes のキー以外）。 */
export const SPECIAL_AXES: readonly string[] = ["kind", "approval", "implementation", "validation"];

/** レコードから指定軸の値を取り出す（配列は複数の値として展開。未設定は "(未設定)"）。 */
export function axisValues(r: ReqRecord, axis: string): string[] {
  if (axis === "kind") return [r.kind ?? "(未設定)"];
  if (axis === "approval" || axis === "implementation" || axis === "validation") {
    const v = r.state[axis];
    return [typeof v === "string" && v !== "" ? v : "(未設定)"];
  }
  const v = r.axes[axis];
  if (v === undefined || v === null || v === "") return ["(未設定)"];
  if (Array.isArray(v)) {
    if (v.length === 0) return ["(未設定)"];
    return v.map((x) => String(x)).sort();
  }
  return [String(v)];
}

export interface SliceBucket {
  value: string;
  recs: string[];
  /** その断面に属し、上位 kind へ一件も traces_to していないレコード（過剰） */
  excess: string[];
  /** その断面に属する上位レコードのうち、下位から一件も traces_to されていないもの（不足） */
  missing: string[];
}

export interface SliceResult {
  axis: string;
  buckets: SliceBucket[];
}

function compareId(a: string, b: string): number {
  const ma = /^([A-Za-z]+)-0*(\d+)$/.exec(a);
  const mb = /^([A-Za-z]+)-0*(\d+)$/.exec(b);
  if (ma && mb) {
    if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
    return Number.parseInt(ma[2], 10) - Number.parseInt(mb[2], 10);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 指定軸での断面と過不足を算出する。 */
export function buildSlice(records: ReqRecord[], axis: string): SliceResult {
  const byId = new Map<string, ReqRecord>();
  for (const r of records) if (r.id !== null) byId.set(r.id, r);

  // 誰が誰を traces_to しているか（下位 → 上位）の逆引き
  const tracedBy = new Map<string, string[]>();
  for (const r of records) {
    if (r.id === null) continue;
    for (const t of r.tracesTo) {
      const list = tracedBy.get(t) ?? [];
      list.push(r.id);
      tracedBy.set(t, list);
    }
  }

  const buckets = new Map<string, ReqRecord[]>();
  for (const r of records) {
    if (r.id === null) continue;
    for (const v of axisValues(r, axis)) {
      const list = buckets.get(v) ?? [];
      list.push(r);
      buckets.set(v, list);
    }
  }

  const out: SliceBucket[] = [];
  for (const value of [...buckets.keys()].sort()) {
    const recs = buckets.get(value) ?? [];
    const recIds = recs.map((r) => r.id as string).sort(compareId);

    // 過剰: この断面のレコードのうち、自分の上位 kind へ一件も traces_to していないもの。
    // confidence: undecided（意図的な未決定。SR-17）は不足・過剰の検出から除く（lint と同じ扱い）。
    const excess: string[] = [];
    for (const r of recs) {
      if (r.id === null) continue;
      if (r.state["confidence"] === "undecided") continue;
      const parentKind = PARENT_KIND.get(r.kind ?? "");
      if (parentKind === undefined) continue; // BR・SEC・U・MO は上位を持たない
      const hasParent = r.tracesTo.some((t) => byId.get(t)?.kind === parentKind);
      if (!hasParent) excess.push(r.id);
    }

    // 不足: この断面に属する上位レコードのうち、下位から一件も traces_to されていないもの。
    //
    // 「同じ断面の中で」上位が下位に支えられているかを見る——断面をまたいだ被覆を求めると
    // 「グループ A の要件がグループ B の全 BR を覆っていない」という当然の事実が全断面に
    // 並び、読めるシグナルにならない（初版はそう実装して実測でノイズだと分かったため、
    // 断面内に閉じた定義に改めた）。
    const missing: string[] = [];
    for (const r of recs) {
      if (r.id === null) continue;
      if (r.state["confidence"] === "undecided") continue;
      const isParentKind = [...PARENT_KIND.values()].includes(r.kind ?? "");
      if (!isParentKind) continue;
      const referrers = tracedBy.get(r.id) ?? [];
      if (referrers.length === 0) missing.push(r.id);
    }
    missing.sort(compareId);

    out.push({ value, recs: recIds, excess, missing });
  }
  return { axis, buckets: out };
}

function formatText(r: SliceResult): string {
  const lines: string[] = [`軸「${r.axis}」の断面: ${r.buckets.length} 個`];
  for (const b of r.buckets) {
    lines.push(`  ${b.value}: ${b.recs.length} 件`);
    if (b.excess.length > 0) {
      lines.push(`    過剰（上位に仕えない）: ${b.excess.join(", ")}`);
    }
    if (b.missing.length > 0) {
      lines.push(`    不足（下位に支えられていない上位）: ${b.missing.join(", ")}`);
    }
  }
  return lines.join("\n");
}

export function runSlice(root: string, axis: string): SliceResult {
  const result = loadRecords(root);
  if (result.errors.length > 0) {
    throw new Error("req_slice: 正本の読み込みに失敗しました:\n" + result.errors.join("\n"));
  }
  return buildSlice(result.records, axis);
}

function main(): number {
  const { values } = parseArgs({
    options: { root: { type: "string" }, axis: { type: "string" }, json: { type: "boolean" } },
  });
  const root = values.root ?? defaultRoot();
  const axis = values.axis ?? "group";
  const result = runSlice(root, axis);
  if (values.json === true) {
    process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  } else {
    console.log(formatText(result));
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
