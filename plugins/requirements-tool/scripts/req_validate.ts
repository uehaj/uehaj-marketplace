#!/usr/bin/env node
/**
 * req_validate.ts — 要求単位の妥当性確認を証跡つきで記録する（SOL-9 / SR-13）。
 *
 * ループの最後の弧（実装 → validation → 記録）を閉じる。
 *
 * 記録先は `<root>/meta/validations/<ID>.md`（施主裁定 2026-08-09）。既存の
 * `meta/reviews/<ID>.md` と同じ流儀——1 レコード 1 ファイル・確認のたびに追記して履歴を残す
 * ——にした。正本の frontmatter にスキーマを増やす案は採らない（既存の lint・全ビューに
 * 影響が及ぶのに対し、得られるのは同じ情報だから）。frontmatter は `state.validation` の
 * 1 軸だけを更新する。
 *
 * 安全側の規約（SOL-9 statement・SOL-16）:
 *   - 証跡（evidence）が空なら `passed` にせず `inconclusive` として記録する（拒否ではなく
 *     格下げ。確認した事実自体は残す価値があるため）。
 *   - AI 判定の `passed` は施主承認まで確定しない。`--by` に記名が無い確認は `passed` に
 *     できない（AI が単独で validation を確定できない。SOL-16）。
 *
 * 一覧（--list）: `implementation: implemented ∧ validation: unvalidated` の要求＝
 * 「実装済みだが未検証」を出す（SOL-9 verification）。
 *
 * 出力・書き込みは決定的。日付は引数（--date）で受け取り、実行時刻を埋め込まない
 * （同一入力→同一出力。他の生成スクリプトと同じ規約）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { ReqRecord, loadRecords } from "./reqlib.ts";
import { buildRequirementCoverage } from "./req_coverage.ts";

function defaultRoot(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

/** 検証結果の値（state.validation の enum のうち、確認の結果として書けるもの）。 */
export const VALIDATION_RESULTS: readonly string[] = ["passed", "failed", "inconclusive"];

export interface ValidationEntry {
  id: string;
  /** 何で確かめたか（自動テスト・手動確認・レビュー等） */
  method: string;
  /** 証跡（テスト名・ログ・画面の記録など。空なら passed にしない） */
  evidence: string;
  result: string;
  /** 確認の限界（どこまでしか言えないか） */
  limitations: string;
  /** 確認者（記名。空なら passed にしない＝AI 単独で確定させない） */
  validatedBy: string;
  date: string;
}

export interface ValidationOutcome {
  entry: ValidationEntry;
  /** 要求された result から実際に記録される result（格下げが起きたかを見るため） */
  appliedResult: string;
  /** 格下げの理由（無ければ null） */
  downgradeReason: string | null;
}

/**
 * 安全側の判定（SOL-9）。証跡なし・記名なしの passed は通さず inconclusive へ落とす。
 * failed の格下げはしない（不合格は証跡が薄くても不合格として残す価値がある）。
 */
export function applySafetyRules(entry: ValidationEntry): ValidationOutcome {
  if (entry.result !== "passed") {
    return { entry, appliedResult: entry.result, downgradeReason: null };
  }
  if (entry.evidence.trim() === "") {
    return {
      entry,
      appliedResult: "inconclusive",
      downgradeReason: "証跡（evidence）が無いため passed にせず inconclusive として記録しました",
    };
  }
  if (entry.validatedBy.trim() === "") {
    return {
      entry,
      appliedResult: "inconclusive",
      downgradeReason:
        "確認者の記名（--by）が無いため passed にせず inconclusive として記録しました（AI は単独で validation を確定できません。SOL-16）",
    };
  }
  return { entry, appliedResult: "passed", downgradeReason: null };
}

/** 「実装済みだが未検証」の要求を一覧する（SOL-9 verification）。 */
export function listImplementedUnvalidated(records: ReqRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (r.id === null) continue;
    if (r.state["implementation"] !== "implemented") continue;
    if (r.state["validation"] !== "unvalidated") continue;
    out.push(r.id);
  }
  return out.sort((a, b) => {
    const ma = /^([A-Za-z]+)-0*(\d+)$/.exec(a);
    const mb = /^([A-Za-z]+)-0*(\d+)$/.exec(b);
    if (ma && mb) {
      if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
      return Number.parseInt(ma[2], 10) - Number.parseInt(mb[2], 10);
    }
    return a < b ? -1 : 1;
  });
}

/** 検証記録ファイルのパス。 */
export function validationFilePath(root: string, id: string): string {
  return path.join(root, "meta", "validations", `${id}.md`);
}

/** 検証記録の 1 エントリを md として整形する（reviews と同じ見出し様式）。 */
export function formatEntry(o: ValidationOutcome): string {
  const e = o.entry;
  const lines: string[] = [];
  lines.push(`## ${e.date} ${e.validatedBy === "" ? "(記名なし)" : e.validatedBy} — ${o.appliedResult}`);
  lines.push("");
  lines.push(`- method: ${e.method === "" ? "(未記入)" : e.method}`);
  lines.push(`- evidence: ${e.evidence === "" ? "(なし)" : e.evidence}`);
  lines.push(`- limitations: ${e.limitations === "" ? "(未記入)" : e.limitations}`);
  if (o.downgradeReason !== null) {
    lines.push(`- 注記: ${o.downgradeReason}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** 検証記録を追記し、正本の state.validation を更新する。 */
export function recordValidation(root: string, o: ValidationOutcome): { file: string; recordUpdated: boolean } {
  const file = validationFilePath(root, o.entry.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf-8");
  } catch {
    existing = `# ${o.entry.id} 検証記録\n\n`;
  }
  fs.writeFileSync(file, existing.replace(/\n*$/, "\n\n") + formatEntry(o), "utf-8");

  // 正本の state.validation を更新（1 軸だけを触る。他のフィールドは並びも含めて不変）。
  const recPath = path.join(root, `${canonicalFileBase(o.entry.id)}.md`);
  let updated = false;
  try {
    const src = fs.readFileSync(recPath, "utf-8");
    const next = src.replace(
      /(\nstate:(?:\n  \w+: [^\n]*)*?\n  validation: )(\w+)/,
      `$1${o.appliedResult}`,
    );
    if (next !== src) {
      fs.writeFileSync(recPath, next, "utf-8");
      updated = true;
    }
  } catch {
    updated = false;
  }
  return { file, recordUpdated: updated };
}

/**
 * 動線内での妥当性確認（SOL-56 / SR-66・方向 B。施主裁定 2026-08-11）。
 *
 * 通読レビューの確認（承認）と同じ画面・同じ 1 操作で妥当性確認を記録する。独立した CLI 操作を
 * 要する形（`req validate`）では実装以来 0 件のまま動かなかったという実測に対する解であり、
 * 記録の形式（meta/validations/<ID>.md ＋ state.validation の 1 軸更新）と安全側の規約
 * （applySafetyRules）は CLI とまったく同じものを再利用する（二重実装しない。SR-24）。
 *
 * 証跡（evidence）は人に書かせず機械が算出する——ここで入力欄を増やすと、レビュー負荷を
 * 下げるための機構が負荷を増やす。算出の材料は `req coverage`（SOL-55）の要件被覆の判定と
 * 根拠テストファイルで、判定が none（そのレコードを名指しするテストも、下位の direct も無い）の
 * ときは passed にせず inconclusive として記録する（証跡が実在しないため）。
 *
 * 記名（validatedBy）は呼び出し側が必須にする。記名の無い passed は applySafetyRules が
 * inconclusive へ落とす（AI が単独で validation を確定できない。SOL-16）。
 */
export function applyInflowValidation(
  root: string,
  input: { id: string; validatedBy: string; date: string; records?: ReqRecord[] },
): { id: string; ok: boolean; verdict: "validate"; error?: string; changes: string[] } {
  const records = input.records ?? loadRecords(root).records;
  const rec = records.find((r) => r.id === input.id);
  if (rec === undefined) {
    return { id: input.id, ok: false, verdict: "validate", error: `${input.id} は正本に存在しません`, changes: [] };
  }
  if (rec.state["implementation"] !== "implemented") {
    return {
      id: input.id,
      ok: false,
      verdict: "validate",
      error: `${input.id} は implementation: implemented ではありません（妥当性確認の対象は実装済みのものだけです）`,
      changes: [],
    };
  }
  const cov = buildRequirementCoverage(root, records).find((c) => c.id === input.id) ?? null;
  const kind = cov?.coverage ?? "none";
  const basis =
    kind === "direct"
      ? `req coverage: direct（${input.id} を名指しするテスト: ${(cov?.testFiles ?? []).join(", ")}）`
      : kind === "rollup"
        ? `req coverage: rollup（下位の direct: ${(cov?.via ?? []).join(", ")}）`
        : kind === "manual"
          ? "req coverage: manual（機械判定の対象外。画面での確認による）"
          : "req coverage: none（このレコードを名指しするテストが無い）";
  const outcome = applySafetyRules({
    id: input.id,
    method: "通読レビューの動線内での確認（画面で本文と実装状態を確認）",
    evidence: `${basis}／${input.validatedBy} が通読レビュー画面で確認`,
    result: kind === "none" ? "inconclusive" : "passed",
    limitations:
      "画面上の確認とテストの有無までで、実装が要求を満たすことの網羅的な検査ではない。行カバレッジは req coverage で別に見る。",
    validatedBy: input.validatedBy,
    date: input.date,
  });
  const written = recordValidation(root, outcome);
  const changes = [
    `state.validation: ${String(rec.state["validation"])} -> ${outcome.appliedResult}`,
    `${path.relative(root, written.file)} に追記`,
  ];
  if (!written.recordUpdated) {
    return { id: input.id, ok: false, verdict: "validate", error: "正本の state.validation を更新できませんでした", changes: [] };
  }
  return { id: input.id, ok: true, verdict: "validate", changes };
}

/** ID → ファイル名の基底（正準表記。SR-1 → SR-01）。 */
function canonicalFileBase(id: string): string {
  const m = /^([A-Za-z]+)-0*(\d+)$/.exec(id);
  if (!m) return id;
  return `${m[1]}-${m[2].padStart(2, "0")}`;
}

function main(): number {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      list: { type: "boolean" },
      id: { type: "string" },
      method: { type: "string" },
      evidence: { type: "string" },
      result: { type: "string" },
      limitations: { type: "string" },
      by: { type: "string" },
      date: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const root = values.root ?? defaultRoot();
  const loaded = loadRecords(root);
  if (loaded.errors.length > 0) {
    console.error("req_validate: 正本の読み込みに失敗しました:\n" + loaded.errors.join("\n"));
    return 2;
  }

  // 既定動作は一覧（--list 省略時も、id が無ければ一覧を出す）
  if (values.list === true || values.id === undefined) {
    const ids = listImplementedUnvalidated(loaded.records);
    if (values.json === true) {
      process.stdout.write(JSON.stringify({ implementedUnvalidated: ids }, null, 1) + "\n");
    } else {
      console.log(`実装済みだが未検証: ${ids.length} 件`);
      for (const id of ids) console.log(`  - ${id}`);
    }
    return 0;
  }

  const id = values.id;
  if (!loaded.records.some((r) => r.id === id)) {
    console.error(`req_validate: ${id} は正本に存在しません`);
    return 2;
  }
  const result = values.result ?? "inconclusive";
  if (!VALIDATION_RESULTS.includes(result)) {
    console.error(`req_validate: --result の値が不正です（${result}）。${VALIDATION_RESULTS.join(" / ")} のいずれか`);
    return 2;
  }
  if (values.date === undefined) {
    console.error("req_validate: --date（確認日。例 2026-08-09）が必要です（実行時刻は埋め込みません）");
    return 2;
  }

  const outcome = applySafetyRules({
    id,
    method: values.method ?? "",
    evidence: values.evidence ?? "",
    result,
    limitations: values.limitations ?? "",
    validatedBy: values.by ?? "",
    date: values.date,
  });
  const written = recordValidation(root, outcome);
  if (values.json === true) {
    process.stdout.write(JSON.stringify({ ...outcome, written }, null, 1) + "\n");
  } else {
    console.log(`${id}: ${outcome.appliedResult} として記録しました（${written.file}）`);
    if (outcome.downgradeReason !== null) console.log(`  注記: ${outcome.downgradeReason}`);
    if (!written.recordUpdated) console.log("  警告: 正本の state.validation を更新できませんでした");
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
