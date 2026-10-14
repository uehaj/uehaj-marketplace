#!/usr/bin/env node
/**
 * req_next.ts — 「次に取り組むべき」候補と根拠を提案する（SOL-11 / SR-12）。
 *
 * SR-12 の要点は「優先度を出すこと」ではなく「何が優先度を決めるのかが未知であり、その決定
 * 因子の発見自体が目標」という点にある。したがって本スクリプトは順位を固定した式を埋め込まず、
 * **因子を差し替え可能な仮説として外出しした実験フレーム**として作る（SOL-11 statement）:
 *
 *   - 因子（factor）は「レコードから 0..1 のスコアを出す関数」＋「重み」＋「なぜこれが駆動を
 *     生むと考えるか（仮説の文）」の 3 点セット。
 *   - 既定の重みは `<root>/meta/priority-factors.json` で上書きできる（無ければ組み込みの既定）。
 *     この 1 ファイルを書き換えるだけで別の仮説を試せる＝実験できる、という形にした。
 *   - 出力には必ず「なぜその順なのか」の内訳（どの因子がどれだけ効いたか）を添える。順位だけを
 *     出すと施主は裁定できず、因子仮説の検証もできない（SR-21: 具体的な言葉で提示する）。
 *
 * 提案であって決定ではない（SOL-16: AI は単独で確定しない）。裁定は施主が行う。
 * 出力は決定的（同一入力→同一出力。同点は ID 昇順で安定化）。読み取り専用。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { ReqRecord, loadRecords } from "./reqlib.ts";

function defaultRoot(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

export interface FactorDef {
  key: string;
  /** なぜこの因子が「次に取り組むべき」を決めると考えるか（仮説の文） */
  hypothesis: string;
  weight: number;
  /** レコードから 0..1 のスコアを出す */
  score: (r: ReqRecord, ctx: ScoreContext) => number;
}

export interface ScoreContext {
  /** そのレコードを traces_to で指している下位レコードの数（依存の解放度の代理指標） */
  dependentCount: Map<string, number>;
}

/**
 * 組み込みの因子仮説（既定）。いずれも「これが駆動を生む」という仮説であり、確定した重み付けでは
 * ない。重みは meta/priority-factors.json で差し替えられる。
 */
export const DEFAULT_FACTORS: readonly FactorDef[] = [
  {
    key: "blocking",
    hypothesis:
      "多くの下位が依存している上位ほど、確定させると多くの作業が同時に解放される（依存の解放が駆動を生む）",
    weight: 3,
    score: (r, ctx) => {
      const n = r.id === null ? 0 : (ctx.dependentCount.get(r.id) ?? 0);
      return Math.min(n / 5, 1); // 5 件以上でほぼ最大（飽和させて 1 件の巨大依存に引きずられないようにする）
    },
  },
  {
    key: "irreversibility",
    hypothesis:
      "後から変えにくい決定（reversibility: low）を先に決めるほど手戻りが小さい（SR-18 の順序原則 1）",
    weight: 3,
    score: (r) => (r.axes["reversibility"] === "low" ? 1 : r.axes["reversibility"] === "medium" ? 0.4 : 0),
  },
  {
    key: "boundary",
    hypothesis: "境界（契約）を実装より先に固定すると内側を並行して進められる（SR-18 の順序原則 2）",
    weight: 2,
    score: (r) => (r.axes["boundary"] === true ? 1 : 0),
  },
  {
    key: "awaiting_decision",
    hypothesis: "裁定待ち（仮決め・要レビュー）は施主の 1 回の判断で前進する＝着手コストが小さい",
    weight: 2,
    score: (r) => {
      const provisional = r.state["confidence"] === "provisional";
      const needsReview = r.axes["review_required"] === true;
      return needsReview && provisional ? 1 : needsReview || provisional ? 0.5 : 0;
    },
  },
  {
    key: "unimplemented",
    hypothesis: "合意済みなのに未実装のものは、記録と世界の乖離としてそのまま残り続ける",
    weight: 1,
    score: (r) => {
      if (r.kind !== "solution_requirement") return 0;
      if (r.state["approval"] !== "agreed") return 0;
      const impl = r.state["implementation"];
      return impl === "not_started" ? 1 : impl === "in_progress" ? 0.6 : 0;
    },
  },
];

/** meta/priority-factors.json（あれば）で重みを上書きする。因子の実装自体は差し替えない。 */
export function loadWeights(root: string): Map<string, number> {
  const out = new Map<string, number>();
  const p = path.join(root, "meta", "priority-factors.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    const weights = parsed["weights"];
    if (weights !== null && typeof weights === "object") {
      for (const [k, v] of Object.entries(weights as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) out.set(k, v);
      }
    }
  } catch {
    /* 無ければ既定の重みを使う */
  }
  return out;
}

export interface Candidate {
  id: string;
  title: string;
  total: number;
  /** どの因子がどれだけ効いたか（根拠。順位だけを出さないため必須） */
  breakdown: { key: string; score: number; weight: number; contribution: number }[];
}

export interface NextResult {
  /** 使った因子仮説（重みを含む）。実験フレームなので出力に必ず残す */
  factors: { key: string; weight: number; hypothesis: string }[];
  candidates: Candidate[];
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

export function proposeNext(records: ReqRecord[], weights: Map<string, number>, limit: number): NextResult {
  const dependentCount = new Map<string, number>();
  for (const r of records) {
    for (const t of r.tracesTo) dependentCount.set(t, (dependentCount.get(t) ?? 0) + 1);
  }
  const ctx: ScoreContext = { dependentCount };

  const factors = DEFAULT_FACTORS.map((f) => ({ ...f, weight: weights.get(f.key) ?? f.weight }));

  const scored: Candidate[] = [];
  for (const r of records) {
    if (r.id === null) continue;
    // 終わっているもの・扱わないものは候補にしない
    if (r.state["disposition"] !== "active") continue;
    if (r.state["approval"] === "rejected") continue;
    if (r.kind === "document_section") continue; // 章は作業単位ではない

    const breakdown = factors.map((f) => {
      const s = f.score(r, ctx);
      return { key: f.key, score: s, weight: f.weight, contribution: s * f.weight };
    });
    const total = breakdown.reduce((acc, b) => acc + b.contribution, 0);
    if (total <= 0) continue;
    scored.push({ id: r.id, title: r.title ?? "", total, breakdown });
  }

  // 決定的: スコア降順 → 同点は ID 昇順
  scored.sort((a, b) => b.total - a.total || compareId(a.id, b.id));
  return {
    factors: factors.map((f) => ({ key: f.key, weight: f.weight, hypothesis: f.hypothesis })),
    candidates: scored.slice(0, limit),
  };
}

function formatText(r: NextResult): string {
  const lines: string[] = [];
  lines.push("使用した因子仮説（meta/priority-factors.json の weights で差し替え可能）:");
  for (const f of r.factors) lines.push(`  [重み ${f.weight}] ${f.key}: ${f.hypothesis}`);
  lines.push("");
  lines.push(`次に取り組む候補: ${r.candidates.length} 件`);
  for (const [i, c] of r.candidates.entries()) {
    lines.push(`  ${i + 1}. ${c.id} ${c.title}（スコア ${c.total.toFixed(2)}）`);
    const effective = c.breakdown.filter((b) => b.contribution > 0).sort((a, b) => b.contribution - a.contribution);
    lines.push(`     根拠: ${effective.map((b) => `${b.key} ${b.contribution.toFixed(2)}`).join(" / ")}`);
  }
  lines.push("");
  lines.push("これは提案です。順位・因子の重みが妥当かの裁定は施主が行います（AI は単独で決めません）。");
  return lines.join("\n");
}

function main(): number {
  const { values } = parseArgs({
    options: { root: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" } },
  });
  const root = values.root ?? defaultRoot();
  const loaded = loadRecords(root);
  if (loaded.errors.length > 0) {
    console.error("req_next: 正本の読み込みに失敗しました:\n" + loaded.errors.join("\n"));
    return 2;
  }
  const limit = values.limit === undefined ? 10 : Math.max(1, Number.parseInt(values.limit, 10) || 10);
  const result = proposeNext(loaded.records, loadWeights(root), limit);
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
