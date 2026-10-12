#!/usr/bin/env node
/**
 * req_coverage.ts — テストの十分性を 2 軸で算出する（SR-65 / SOL-55）。
 *
 * 軸 1: 要件の被覆（requirement coverage）
 *   各要求・要件に対して、それを検査するテストがあるか。対応づけの根拠は「テストコード中に
 *   現れる ID 参照」——req_impact.ts と同じ方針で、別の対応表（台帳）は作らない（台帳は必ず
 *   実体とずれる）。判定は 4 段階:
 *     direct  … その ID を名指しするテストがある
 *     rollup  … 自分を指す下位レコードが direct（上位は下位の検査で間接的に確かめられる）
 *     manual  … verification が「機械的に検査しない」旨を含む、または kind が検査対象外
 *     none    … どちらも無い＝テストの穴
 *
 * 軸 2: 行カバレッジ（line coverage）
 *   Node 標準の `--experimental-test-coverage` の lcov 出力を読む（外部依存なし。SR-64 と
 *   同じ方針）。lcov ファイルが無ければ「未計測」として扱い、要件の被覆だけを出す
 *   ——カバレッジ計測はテストの実行を伴い時間がかかるため、常に強制はしない。
 *
 * 2 軸を並べるのは、片方だけでは十分性が判断できないから: 要件に対応するテストが在っても
 * 実装の大部分が未実行なら不足だし、行カバレッジが高くても要件を検査していなければ
 * 「何を確かめたのか」が言えない。
 *
 * 読み取り専用・決定的（同一入力→同一出力）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { ReqRecord, loadRecords } from "./reqlib.ts";

function defaultRoot(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

function projectRootFor(root: string): string {
  return path.resolve(root, "..", "..");
}

/** テストファイルを集める場所。 */
const TEST_DIR = "tests";

/**
 * 要件の被覆の判定。
 * SEC（章）と MO（必須アウトプット）は「テストで検査する」対象ではない——章は文書構造、
 * MO は成果物カタログであり、いずれも合否を機械判定する性質を持たない。これらは manual に寄せる。
 */
const NOT_TEST_TARGET_KINDS: ReadonlySet<string> = new Set(["document_section", "mandatory_output"]);

/** verification に「機械的に検査しない」意図が書かれているかの手掛かり。 */
const MANUAL_MARKERS: readonly string[] = ["手動", "目視", "主観", "施主が確認", "実機で確認"];

export type CoverageKind = "direct" | "rollup" | "manual" | "none";

export interface RequirementCoverage {
  id: string;
  kind: string | null;
  title: string;
  coverage: CoverageKind;
  /** その ID を名指しするテストファイル（プロジェクト相対・昇順） */
  testFiles: string[];
  /** 名指しの件数（テストファイル内の出現回数の合計ではなくファイル数） */
  testFileCount: number;
  /** rollup の場合、direct な下位レコードの ID */
  via: string[];
}

export interface FileCoverage {
  file: string;
  lineRate: number;
  linesFound: number;
  linesHit: number;
}

export interface CoverageResult {
  /** 要件の被覆の集計（判定ごとの件数） */
  summary: Record<CoverageKind, number>;
  requirements: RequirementCoverage[];
  /** 行カバレッジ（lcov が無ければ null＝未計測） */
  lines: FileCoverage[] | null;
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

/** tests/ 配下のファイルを再帰的に集める（決定的）。 */
function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // fixture は「テストの入力データ」であってテストコードではない。ここで拾うと
      // fixture 内の ID が「テストがある」ことの根拠になってしまい、被覆を過大評価する。
      if (e.name === "fixtures") continue;
      out.push(...collectTestFiles(p));
    } else if (e.name.endsWith(".ts") || e.name.endsWith(".js")) {
      out.push(p);
    }
  }
  return out;
}

/** テストコード中の ID 参照から「ID → テストファイル」の索引を作る。 */
export function buildTestIndex(root: string, records: ReqRecord[]): Map<string, string[]> {
  const projectRoot = projectRootFor(root);
  const ids = new Set<string>();
  for (const r of records) if (r.id !== null) ids.add(r.id);

  const index = new Map<string, string[]>();
  for (const abs of collectTestFiles(path.join(projectRoot, TEST_DIR))) {
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const rel = path.relative(projectRoot, abs).split(path.sep).join("/");
    const found = new Set<string>();
    for (const m of text.matchAll(/\b(BR|SR|SOL|MO|SEC|U)-(\d+)\b/g)) {
      const canonical = `${m[1]}-${Number.parseInt(m[2], 10)}`;
      if (ids.has(canonical)) found.add(canonical);
    }
    for (const id of found) {
      const list = index.get(id) ?? [];
      list.push(rel);
      index.set(id, list);
    }
  }
  for (const [id, files] of index) index.set(id, files.sort());
  return index;
}

/** verification が手動確認を明示しているか。 */
function isManualByVerification(r: ReqRecord): boolean {
  const v = r.frontmatter["verification"];
  if (typeof v !== "string") return false;
  return MANUAL_MARKERS.some((m) => v.includes(m));
}

/** 要件の被覆を算出する。 */
export function buildRequirementCoverage(root: string, records: ReqRecord[]): RequirementCoverage[] {
  const index = buildTestIndex(root, records);

  // 誰が誰を traces_to しているか（上位 → 下位）
  const childrenOf = new Map<string, string[]>();
  for (const r of records) {
    if (r.id === null) continue;
    for (const t of r.tracesTo) {
      const list = childrenOf.get(t) ?? [];
      list.push(r.id);
      childrenOf.set(t, list);
    }
  }

  const out: RequirementCoverage[] = [];
  for (const r of records) {
    if (r.id === null) continue;
    // 廃止・却下は十分性の対象外（もう満たす必要がないもののテストを求めない）
    if (r.state["disposition"] !== "active") continue;
    if (r.state["approval"] === "rejected") continue;

    const testFiles = index.get(r.id) ?? [];
    const direct = testFiles.length > 0;
    const viaChildren = (childrenOf.get(r.id) ?? []).filter((c) => (index.get(c) ?? []).length > 0).sort(compareId);

    let coverage: CoverageKind;
    if (direct) coverage = "direct";
    else if (viaChildren.length > 0) coverage = "rollup";
    else if (NOT_TEST_TARGET_KINDS.has(r.kind ?? "") || isManualByVerification(r)) coverage = "manual";
    else coverage = "none";

    out.push({
      id: r.id,
      kind: r.kind,
      title: r.title ?? "",
      coverage,
      testFiles,
      testFileCount: testFiles.length,
      via: viaChildren,
    });
  }
  out.sort((a, b) => compareId(a.id, b.id));
  return out;
}

/**
 * lcov ファイルを読んでファイル単位の行カバレッジにする。
 * 対象は scripts/ 配下（テストコード自身のカバレッジは十分性の指標にならないので除く）。
 */
export function parseLcov(lcovPath: string): FileCoverage[] | null {
  let text: string;
  try {
    text = fs.readFileSync(lcovPath, "utf-8");
  } catch {
    return null;
  }
  const out: FileCoverage[] = [];
  let current: string | null = null;
  let found = 0;
  let hit = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = line.slice(3).trim();
      found = 0;
      hit = 0;
    } else if (line.startsWith("LF:")) {
      found = Number.parseInt(line.slice(3), 10) || 0;
    } else if (line.startsWith("LH:")) {
      hit = Number.parseInt(line.slice(3), 10) || 0;
    } else if (line.startsWith("end_of_record")) {
      if (current !== null && current.startsWith("scripts/")) {
        out.push({
          file: current,
          linesFound: found,
          linesHit: hit,
          lineRate: found === 0 ? 0 : hit / found,
        });
      }
      current = null;
    }
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

export function runCoverage(root: string, lcovPath: string | null): CoverageResult {
  const loaded = loadRecords(root);
  if (loaded.errors.length > 0) {
    throw new Error("req_coverage: 正本の読み込みに失敗しました:\n" + loaded.errors.join("\n"));
  }
  const requirements = buildRequirementCoverage(root, loaded.records);
  const summary: Record<CoverageKind, number> = { direct: 0, rollup: 0, manual: 0, none: 0 };
  for (const r of requirements) summary[r.coverage] += 1;
  return { summary, requirements, lines: lcovPath === null ? null : parseLcov(lcovPath) };
}

function formatText(r: CoverageResult): string {
  const total = r.requirements.length;
  const lines: string[] = [];
  lines.push(`要件のテスト被覆: ${total} 件中`);
  lines.push(`  direct（名指しのテストあり）: ${r.summary.direct} 件`);
  lines.push(`  rollup（下位のテストで間接的）: ${r.summary.rollup} 件`);
  lines.push(`  manual（機械的に検査しない）: ${r.summary.manual} 件`);
  lines.push(`  none（テストの穴）: ${r.summary.none} 件`);
  if (r.summary.none > 0) {
    lines.push("");
    lines.push("テストの穴（none）:");
    for (const req of r.requirements.filter((x) => x.coverage === "none")) {
      lines.push(`  - ${req.id} ${req.title}`);
    }
  }
  if (r.lines !== null) {
    lines.push("");
    const found = r.lines.reduce((a, b) => a + b.linesFound, 0);
    const hit = r.lines.reduce((a, b) => a + b.linesHit, 0);
    lines.push(`行カバレッジ（scripts/）: ${found === 0 ? 0 : ((hit / found) * 100).toFixed(1)}%（${hit}/${found} 行）`);
    for (const f of [...r.lines].sort((a, b) => a.lineRate - b.lineRate).slice(0, 10)) {
      lines.push(`  ${(f.lineRate * 100).toFixed(1).padStart(5)}%  ${f.file}`);
    }
  } else {
    lines.push("");
    lines.push("行カバレッジ: 未計測（--lcov <path> で lcov ファイルを渡すと集計します）");
  }
  return lines.join("\n");
}

function main(): number {
  const { values } = parseArgs({
    options: { root: { type: "string" }, lcov: { type: "string" }, json: { type: "boolean" } },
  });
  const root = values.root ?? defaultRoot();
  const result = runCoverage(root, values.lcov ?? null);
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
