#!/usr/bin/env node
/**
 * req_guard.ts — 危険操作のガードと生成ビュー直接編集の検出（SOL-16 / SR-19）。
 *
 * SOL-16 のうち、既存実装で満たされていなかった 2 点を担う:
 *   (1) 正本の大量削除・スキーマ破壊の検出。作業ツリーの現状と HEAD を比べ、削除・改変の
 *       規模が閾値を超えたら警告する。ここで「ブロック」するのは適用そのものではなく
 *       「気づかないまま進むこと」で、判断は施主に残す（AI が単独で確定しない SOL-16 と同じ姿勢）。
 *   (2) 生成ビュー（docs/generated/ 配下）の直接編集の検出。生成物は一方向生成であり手で
 *       直しても次の生成で消えるため、手編集の痕跡を検出して報告する。
 *
 * 「AI が単独で approval=agreed / validation=passed を確定できない」の強制は既存実装が担う:
 *   approval → reqlib.applyReviewActions が reviewer（記名）必須で拒否する
 *   validation → req_validate.ts が記名なし・証跡なしの passed を inconclusive へ格下げする
 * 本スクリプトはそれらを再実装せず、検査（--check-enforcement）でその強制が生きていることを
 * 確認するだけにする（SR-24: 二重実装しない）。
 *
 * 終了コード: 危険の検出あり=1、なし=0（内部エラー=2）。フックから呼んで止めるための規約。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

function defaultRoot(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

/** プロジェクトルート（正本 root から 2 つ上）。 */
function projectRootFor(root: string): string {
  return path.resolve(root, "..", "..");
}

/**
 * 大量削除の閾値。正本 1 件の削除は通常の運用（陳腐化した要求の整理）で起きるが、
 * 複数件が一度に消えるのは事故（スクリプトの誤り・取り違え）の可能性が高い。
 * 閾値 3 は「意図的な整理なら changelog に版として書く手間を惜しまないはず」という運用前提から。
 */
export const MASS_DELETE_THRESHOLD = 3;

export interface GuardFinding {
  kind: "mass_delete" | "schema_break" | "generated_edit";
  message: string;
  files: string[];
}

/** git status --porcelain を読む（git が無い・リポジトリでない場合は空）。 */
function gitStatus(projectRoot: string): { status: string; file: string }[] {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf-8" });
  } catch {
    return [];
  }
  const rows: { status: string; file: string }[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    rows.push({ status: line.slice(0, 2).trim(), file: line.slice(3).trim() });
  }
  return rows;
}

/** 正本ファイルの大量削除を検出する。 */
export function findMassDelete(root: string): GuardFinding | null {
  const projectRoot = projectRootFor(root);
  const rel = path.relative(projectRoot, root).split(path.sep).join("/");
  const deleted = gitStatus(projectRoot)
    .filter((r) => r.status === "D" && r.file.startsWith(`${rel}/`) && r.file.endsWith(".md"))
    .map((r) => r.file)
    .sort();
  if (deleted.length < MASS_DELETE_THRESHOLD) return null;
  return {
    kind: "mass_delete",
    message:
      `正本のレコードが ${deleted.length} 件削除されています（閾値 ${MASS_DELETE_THRESHOLD} 件）。` +
      "意図した整理なら changelog に版として記録してください。意図していなければ復元してください。",
    files: deleted,
  };
}

/**
 * スキーマ破壊を検出する。frontmatter の必須フィールドを失ったレコードを探す。
 * lint も同じ欠落を検出するが、lint は「正本の現在の欠陥」を報告するのに対し、
 * ここでは「変更によって壊れたか」（＝git 上で変更されたファイルに限って見る）を判定し、
 * フックから「この変更を進めてよいか」の判断材料にする。
 */
export function findSchemaBreak(root: string): GuardFinding | null {
  const projectRoot = projectRootFor(root);
  const rel = path.relative(projectRoot, root).split(path.sep).join("/");
  const changed = gitStatus(projectRoot)
    .filter((r) => r.status !== "D" && r.file.startsWith(`${rel}/`) && r.file.endsWith(".md"))
    .map((r) => r.file);
  const broken: string[] = [];
  for (const f of changed.sort()) {
    // meta/ 配下（changelog・reviews・validations・triggers 等）は正本レコードではないので
    // 対象外。frontmatter を持たないのが正常であり、必須フィールド検査より先に外す
    // （順序を逆にすると meta の md 全部が「スキーマ破壊」に見える。実測で判明）。
    if (f.startsWith(`${rel}/meta/`)) continue;
    const abs = path.join(projectRoot, f);
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    if (!text.startsWith("---")) {
      broken.push(f);
      continue;
    }
    for (const key of ["id:", "kind:", "title:", "state:"]) {
      if (!text.includes(`\n${key}`) && !text.startsWith(`---\n${key}`)) {
        broken.push(f);
        break;
      }
    }
  }
  if (broken.length === 0) return null;
  return {
    kind: "schema_break",
    message:
      "変更されたレコードで frontmatter の必須フィールド（id / kind / title / state）が失われています。" +
      "更新を中止して復元してください（検査失敗時は安全側に倒す）。",
    files: [...new Set(broken)].sort(),
  };
}

/** 生成ビュー（docs/generated/）の直接編集を検出する。 */
export function findGeneratedEdit(root: string): GuardFinding | null {
  const projectRoot = projectRootFor(root);
  const generated = gitStatus(projectRoot)
    .filter((r) => r.file.startsWith("docs/generated/"))
    .map((r) => r.file)
    .sort();
  if (generated.length === 0) return null;
  // 生成物の変更自体は正常（再生成した直後は必ず差分が出る）。手編集かどうかは、
  // 再生成しても同じ内容になるかで判定するのが本筋だが、それには生成の実行が必要になる。
  // ここでは「生成物に差分があるが、その入力（正本）に差分が無い」＝再生成では説明できない
  // 変更、という条件で手編集を疑う。
  const rel = path.relative(projectRoot, root).split(path.sep).join("/");
  const corpusChanged = gitStatus(projectRoot).some((r) => r.file.startsWith(`${rel}/`));
  if (corpusChanged) return null;
  return {
    kind: "generated_edit",
    message:
      "生成ビュー（docs/generated/）に変更がありますが、入力である正本には変更がありません。" +
      "生成物の直接編集は禁止です（次の生成で失われます）。正本を直して再生成してください。",
    files: generated,
  };
}

/** AI 単独確定の強制が生きているかの検査（再実装せず、既存実装の存在を確認する）。 */
export function checkEnforcement(projectRoot: string): string[] {
  const problems: string[] = [];
  try {
    const reqlib = fs.readFileSync(path.join(projectRoot, "scripts", "reqlib.ts"), "utf-8");
    if (!reqlib.includes("reviewer（記名）が必須です")) {
      problems.push("reqlib.applyReviewActions の記名必須チェックが見つかりません（approval の単独確定を防げません）");
    }
  } catch {
    problems.push("scripts/reqlib.ts が読めません");
  }
  try {
    const validate = fs.readFileSync(path.join(projectRoot, "scripts", "req_validate.ts"), "utf-8");
    if (!validate.includes("applySafetyRules")) {
      problems.push("req_validate の安全側規約が見つかりません（validation の単独確定を防げません）");
    }
  } catch {
    problems.push("scripts/req_validate.ts が読めません");
  }
  return problems;
}

export interface GuardResult {
  findings: GuardFinding[];
  enforcementProblems: string[];
}

export function runGuard(root: string): GuardResult {
  const findings: GuardFinding[] = [];
  for (const f of [findMassDelete(root), findSchemaBreak(root), findGeneratedEdit(root)]) {
    if (f !== null) findings.push(f);
  }
  return { findings, enforcementProblems: checkEnforcement(projectRootFor(root)) };
}

function main(): number {
  const { values } = parseArgs({ options: { root: { type: "string" }, json: { type: "boolean" } } });
  const root = values.root ?? defaultRoot();
  const result = runGuard(root);
  if (values.json === true) {
    process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  } else {
    if (result.findings.length === 0 && result.enforcementProblems.length === 0) {
      console.log("req_guard: 危険操作は検出されませんでした。");
    }
    for (const f of result.findings) {
      console.log(`[${f.kind}] ${f.message}`);
      for (const file of f.files.slice(0, 10)) console.log(`  - ${file}`);
      if (f.files.length > 10) console.log(`  …ほか ${f.files.length - 10} 件`);
    }
    for (const p of result.enforcementProblems) console.log(`[enforcement] ${p}`);
  }
  return result.findings.length > 0 || result.enforcementProblems.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
