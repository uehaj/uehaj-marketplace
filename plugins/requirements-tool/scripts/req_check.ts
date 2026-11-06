#!/usr/bin/env node
/**
 * req_check.ts — 正本の意味層の検査（SOL-5 の「矛盾候補」と「手段トレース」）。
 *
 * lint（req_lint.ts）との境界（SR-24: 同じ検査を二重実装しない）:
 *   lint  = 正本自体の構文・スキーマ・不変条件・トレーサビリティの穴（＝機械的に「違反」と
 *           言い切れるもの。exit code 1 で止める）
 *   check = 「違反とは言い切れないが人が見るべき候補」（矛盾候補・裁定に遡れない手段）。
 *           候補の提示であり、判定は施主が行う（SOL-16: AI が単独で確定しない）。
 *           したがって exit code は常に 0（候補の存在はエラーではない。req gaps と同じ規約）。
 *
 * 検査 1: 矛盾候補（SOL-5）
 *   同じ意味グループ（axes.group）に属し、かつ statement が「相反する語」を含む組を候補として
 *   挙げる。テキストの完全な意味理解はしない——機械が確実に言えるのは「同じ関心事について
 *   反対の語が使われている」ことまでで、それが本当の矛盾かは適用条件（U-19）や文脈に依る。
 *   誤検出を抑えるため、(a) 同一グループ、(b) 対義語ペアの両側が別レコードに現れる、
 *   (c) 同じ対象語を共有する、の 3 条件を満たす組だけを挙げる。
 *
 * 検査 2: 手段トレース（SOL-5 / SR-23）
 *   実装に現れた手段（実装言語・ランタイム・外部依存・配布形態）が、裁定の記録（docs/ADR-*.html）
 *   に遡れるかを検査する。package.json の dependencies と、正本が言及する手段名を対象にし、
 *   どの ADR にも現れない手段を「裁定を経ていない可能性」として挙げる。
 *
 * 出力は決定的（同一入力→同一出力）。実行時刻・乱数は使わない。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { ReqRecord, loadRecords } from "./reqlib.ts";

function defaultRoot(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

/** プロジェクトルート（正本 root から 2 つ上）。ADR・package.json を探す起点。 */
export function projectRootFor(root: string): string {
  return path.resolve(root, "..", "..");
}

/**
 * 矛盾候補の検出に使う対義語ペア。
 * 「両側が同じ意味グループの別レコードに現れ、かつ同じ対象語を共有する」ときだけ候補になる。
 * 語彙を増やすほど誤検出が増えるため、要求文書で実際に対立を作る語に限る。
 */
export const ANTONYM_PAIRS: readonly [string, string][] = [
  ["必須", "任意"],
  ["禁止", "許可"],
  ["同期", "非同期"],
  ["常に", "決して"],
  ["有効", "無効"],
  ["含む", "除く"],
  ["自動", "手動"],
];

export interface ContradictionCandidate {
  group: string;
  a: string;
  b: string;
  /** 相反する語の組（"必須" vs "任意" 等） */
  antonym: [string, string];
  /** 両者が共有する対象語（この語について反対のことを言っている） */
  sharedTerm: string;
}

/** statement（と title）を検査対象のテキストとして取り出す。 */
function textOf(r: ReqRecord): string {
  const st = r.frontmatter["statement"];
  const body = typeof st === "string" ? st : "";
  return `${r.title ?? ""}\n${body}`;
}

/**
 * 対象語の候補を取り出す（漢字・カタカナの連なり 2 文字以上）。
 * 「同じ対象について反対のことを言っている」の判定に使うため、助詞・ひらがなは除く。
 */
function termsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[一-鿿゠-ヿ][一-鿿゠-ヿー]+/g)) {
    if (m[0].length >= 2) out.add(m[0]);
  }
  return out;
}

/** 矛盾候補を挙げる（決定的: ID 昇順の組で返す）。 */
export function findContradictionCandidates(records: ReqRecord[]): ContradictionCandidate[] {
  const byGroup = new Map<string, ReqRecord[]>();
  for (const r of records) {
    if (r.id === null) continue;
    const g = r.axes["group"];
    if (typeof g !== "string" || g === "") continue;
    const list = byGroup.get(g) ?? [];
    list.push(r);
    byGroup.set(g, list);
  }

  const out: ContradictionCandidate[] = [];
  for (const [group, list] of [...byGroup.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sorted = [...list].sort((a, b) => ((a.id ?? "") < (b.id ?? "") ? -1 : 1));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const ra = sorted[i];
        const rb = sorted[j];
        const ta = textOf(ra);
        const tb = textOf(rb);
        for (const [x, y] of ANTONYM_PAIRS) {
          // 一方が x を、他方が y を含む（同じレコードが両方持つ場合は対立ではない）
          const aHasX = ta.includes(x) && !ta.includes(y);
          const bHasY = tb.includes(y) && !tb.includes(x);
          const aHasY = ta.includes(y) && !ta.includes(x);
          const bHasX = tb.includes(x) && !tb.includes(y);
          if (!((aHasX && bHasY) || (aHasY && bHasX))) continue;
          // 同じ対象語を共有しているか（共有が無ければ別のことを言っているだけ）
          const termsA = termsOf(ta);
          const shared = [...termsOf(tb)]
            .filter((t) => termsA.has(t) && t !== x && t !== y)
            .sort();
          if (shared.length === 0) continue;
          out.push({
            group,
            a: ra.id as string,
            b: rb.id as string,
            antonym: [x, y],
            sharedTerm: shared[0],
          });
          break; // 1 組につき 1 件だけ挙げる（同じ組を語ごとに繰り返さない）
        }
      }
    }
  }
  return out;
}

export interface MeansGap {
  means: string;
  /** どこで観測された手段か（package.json の依存、または正本の言及） */
  source: string;
}

/**
 * 手段トレース（SR-23）。実装に現れた手段が ADR に遡れるかを検査する。
 * 対象は package.json の dependencies / devDependencies（外部依存＝典型的な「なし崩し」の入口）。
 * ADR は docs/ADR-*.html（および docs/adr/ 配下）の本文を素朴に走査する。
 */
export function findUntracedMeans(root: string): MeansGap[] {
  const projectRoot = projectRootFor(root);
  const adrText = readAdrCorpus(projectRoot);
  const out: MeansGap[] = [];

  const pkgPath = path.join(projectRoot, "package.json");
  let deps: string[] = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    for (const key of ["dependencies", "devDependencies"]) {
      const d = pkg[key];
      if (d !== null && typeof d === "object") deps.push(...Object.keys(d as Record<string, unknown>));
    }
  } catch {
    deps = [];
  }
  deps.sort();
  for (const d of deps) {
    if (!adrText.includes(d)) out.push({ means: d, source: "package.json の依存" });
  }
  return out;
}

/** ADR 群の本文を 1 つの文字列として読む（見つからなければ空文字列）。 */
function readAdrCorpus(projectRoot: string): string {
  const parts: string[] = [];
  const docsDir = path.join(projectRoot, "docs");
  const candidates: string[] = [];
  try {
    for (const name of fs.readdirSync(docsDir).sort()) {
      if (/^ADR-.*\.(html|md)$/.test(name)) candidates.push(path.join(docsDir, name));
    }
  } catch {
    /* docs が無い場合は空 */
  }
  const adrDir = path.join(docsDir, "adr");
  try {
    for (const name of fs.readdirSync(adrDir).sort()) {
      if (/\.(html|md)$/.test(name)) candidates.push(path.join(adrDir, name));
    }
  } catch {
    /* docs/adr が無い場合は空 */
  }
  for (const p of candidates) {
    try {
      parts.push(fs.readFileSync(p, "utf-8"));
    } catch {
      /* 読めないものは飛ばす */
    }
  }
  return parts.join("\n");
}

export interface CheckResult {
  contradictions: ContradictionCandidate[];
  untracedMeans: MeansGap[];
}

export function runCheck(root: string): CheckResult {
  const result = loadRecords(root);
  if (result.errors.length > 0) {
    throw new Error("req_check: 正本の読み込みに失敗しました:\n" + result.errors.join("\n"));
  }
  return {
    contradictions: findContradictionCandidates(result.records),
    untracedMeans: findUntracedMeans(root),
  };
}

function formatText(r: CheckResult): string {
  const lines: string[] = [];
  lines.push(`矛盾候補: ${r.contradictions.length} 件`);
  for (const c of r.contradictions) {
    lines.push(
      `  - ${c.a} と ${c.b}（グループ「${c.group}」）: 「${c.antonym[0]}」と「${c.antonym[1]}」が` +
        `同じ対象「${c.sharedTerm}」について使われています`,
    );
  }
  lines.push(`裁定に遡れない手段: ${r.untracedMeans.length} 件`);
  for (const m of r.untracedMeans) {
    lines.push(`  - ${m.means}（${m.source}）: どの ADR にも現れません`);
  }
  lines.push("");
  lines.push("いずれも「候補」です。矛盾かどうか・裁定が必要かは施主が判断します。");
  return lines.join("\n");
}

function main(): number {
  const { values } = parseArgs({ options: { root: { type: "string" }, json: { type: "boolean" } } });
  const root = values.root ?? defaultRoot();
  const result = runCheck(root);
  if (values.json === true) {
    process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  } else {
    console.log(formatText(result));
  }
  // 候補の存在はエラーではない（判定は施主。req gaps と同じ規約）。
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
