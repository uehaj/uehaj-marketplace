#!/usr/bin/env node
/**
 * req_lint.ts — docs/requirements/ 正本の決定的検査（SOL-17 の lint 相当）。
 * Python 版 req_lint.py の同値移植（Node 23.6+ の型剥がしで直接実行）。
 *
 * 検査内容:
 *   1. frontmatter の構文検査（reqlib.parseFrontmatter が例外を出さないか）
 *   2. 必須フィールドの存在と kind / state 各軸の enum 値検査
 *   3. ID の一意性、およびファイル名 <-> frontmatter id の整合（正準表記）
 *   4. traces_to の実在検査（参照先 ID が存在するか）と親子 kind の整合
 *   5. 軸間不変条件（実装計画書 §3.2 で確定した INV-1..3 のみ）
 *   6. 親なし要件（SR 等が親 kind に一件も traces_to しない）の検出
 *   7. 未カバー要求（BR がどの子からも traces_to されない）の検出
 *   8. axes.phase の値検査（0..4 の整数リスト（空可）または 'cross-cutting'。
 *      施主裁定 2026-07-05 フェーズ0検収）
 *   9. 主たる木（parent / also_belongs_to）検査（SR-27）: parent の実在・kind制約、
 *      also_belongs_to の実在・parent との重複禁止、内包グラフの循環検出
 *   10. SOL の verification 検証可能性（SR-48/SOL-40）: kind=solution_requirement の
 *      verification が空（null/空文字/空白のみ）なら違反。加えて lintVerificationWarnings()
 *      が「極端に短い」を保守的閾値（15文字未満）で警告として挙げる（exit code には影響しない）
 *   11. axes.group の付与漏れ（SOL-27）: SR/SOL/U/MO で未設定なら警告として挙げる
 *      （違反にはしない。group は AI 仮決め＋施主承認で決まる意味づけであり、
 *      機械が「無いから不正」と断ずる性質のものではない。exit code には影響しない）
 *
 * confidence: undecided の項目は、6/7 の「不足」検出から除外する
 * （SR-17: 意図的な未決定を不足の誤検出にしない）。
 *
 * 終了コード: 問題なし=0、問題あり=1（内部エラー時は 2）。
 */
import * as path from "node:path";
import { parseArgs } from "node:util";

import {
  CONFIRMED_INVARIANTS,
  KIND_PARENT,
  KIND_VALUES,
  ReqRecord,
  STATE_ENUMS,
  canonicalIdFromFilename,
  loadRecords,
  validatePhase,
} from "./reqlib.ts";
import type { YamlMap } from "./reqlib.ts";

function defaultRoot(): string {
  // 既定の対象は呼び出し元プロジェクト（プラグイン自身の正本を黙って対象にしない）
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

/** Python の sorted(list) の repr 表示に合わせる（例: ['agreed', 'candidate']）。 */
function pySortedList(values: Iterable<string>): string {
  const sorted = [...values].sort();
  return "[" + sorted.map((v) => `'${v}'`).join(", ") + "]";
}

function relTo(root: string, filePath: string): string {
  const rel = path.relative(root, filePath);
  return rel.startsWith("..") ? filePath : rel;
}

export function lint(root: string): string[] {
  const findings: string[] = [];
  const result = loadRecords(root);
  for (const e of result.errors) findings.push(`[parse] ${e}`);
  const records = result.records;

  const byId = new Map<string, ReqRecord[]>();
  for (const r of records) {
    const rel = relTo(root, r.path);

    // 2. 必須フィールド・enum 検査
    if (!r.id) {
      findings.push(`[schema] ${rel}: id フィールドがありません`);
    }
    if (r.kind === null || !KIND_VALUES.has(r.kind)) {
      const kindRepr = r.kind === null ? "None" : `'${r.kind}'`;
      findings.push(
        `[schema] ${rel}: kind の値が不正です（${kindRepr}）。取りうる値: ${pySortedList(KIND_VALUES)}`,
      );
    }
    if (!r.title) {
      findings.push(`[schema] ${rel}: title フィールドがありません`);
    }
    if (!r.frontmatter["statement"]) {
      findings.push(`[schema] ${rel}: statement フィールドがありません`);
    }

    // SOL-40/SR-48: kind=solution_requirement の verification 検証可能性（必須層）。
    // 主語がシステムである SOL には「合否判定できる verification」を課す（SR には課さない。
    // 3階層の非対称性。SOL-40 rationale）。disposition/approval に関わらず全件に適用する
    // （title・statement 等、他の必須フィールド検査も held/rejected を免除していないのに合わせる）。
    if (r.kind === "solution_requirement") {
      const v = r.frontmatter["verification"];
      const isEmpty = v === null || v === undefined || (typeof v === "string" && v.trim() === "");
      if (isEmpty) {
        findings.push(
          `[schema] ${rel}: solution_requirement の verification が空です` +
            `（合否判定できる具体的な記述が必須。SR-48/SOL-40）`,
        );
      }
    }

    const state = r.state;
    if (Object.keys(state).length === 0) {
      findings.push(`[schema] ${rel}: state ブロックがありません`);
    } else {
      for (const [axis, allowed] of STATE_ENUMS) {
        const val = state[axis];
        if (val === null || val === undefined) {
          findings.push(`[schema] ${rel}: state.${axis} がありません`);
        } else if (typeof val !== "string" || !allowed.has(val)) {
          const valRepr = typeof val === "string" ? `'${val}'` : String(val);
          findings.push(
            `[schema] ${rel}: state.${axis} の値が不正です（${valRepr}）。取りうる値: ${pySortedList(allowed)}`,
          );
        }
      }
    }

    // axes.phase の値検査（0..4 の整数リスト（空可）または 'cross-cutting'。
    // 施主裁定 2026-07-05 フェーズ0検収）
    const phaseError = validatePhase(r.axes["phase"]);
    if (phaseError) {
      findings.push(`[schema] ${rel}: ${phaseError}`);
    }

    // disposition=held のとき hold.reason が必須
    if (state["disposition"] === "held") {
      const hold = r.frontmatter["hold"];
      const holdMap =
        hold !== null && typeof hold === "object" && !Array.isArray(hold)
          ? (hold as YamlMap)
          : null;
      if (!holdMap || !holdMap["reason"]) {
        findings.push(`[schema] ${rel}: disposition=held には hold.reason が必須です`);
      }
    }

    // 3. ファイル名 <-> id 整合
    const canonical = canonicalIdFromFilename(r.path);
    if (canonical === null) {
      findings.push(`[schema] ${rel}: ファイル名が <PREFIX>-<番号> の形式ではありません`);
    } else if (r.id && canonical !== r.id) {
      findings.push(
        `[schema] ${rel}: ファイル名由来の正準 ID（${canonical}）と frontmatter の id（${r.id}）が一致しません`,
      );
    }

    if (r.id) {
      const list = byId.get(r.id) ?? [];
      list.push(r);
      byId.set(r.id, list);
    }

    // 5. 軸間不変条件（確定分のみ）
    for (const [invId, predicate, message] of CONFIRMED_INVARIANTS) {
      let ok = true;
      try {
        ok = predicate(state);
      } catch {
        ok = true;
      }
      if (!ok) {
        findings.push(`[invariant ${invId}] ${rel}: ${message}`);
      }
    }
  }

  // 3続き. ID 一意性
  for (const [rid, recs] of byId) {
    if (recs.length > 1) {
      const paths = recs.map((r) => path.basename(r.path)).join(", ");
      findings.push(`[schema] id 重複: ${rid} が複数ファイルで使われています（${paths}）`);
    }
  }

  // 4. traces_to の実在検査・親子kind整合
  for (const r of records) {
    const rel = relTo(root, r.path);
    const parentKind =
      r.kind !== null && KIND_VALUES.has(r.kind) ? (KIND_PARENT.get(r.kind) ?? null) : null;
    for (const target of r.tracesTo) {
      const targetRecs = byId.get(target);
      if (!targetRecs || targetRecs.length === 0) {
        findings.push(`[trace] ${rel}: traces_to の参照先 '${target}' が存在しません`);
        continue;
      }
      if (parentKind !== null) {
        for (const tr of targetRecs) {
          if (tr.kind !== parentKind) {
            const trKindRepr = tr.kind === null ? "None" : `'${tr.kind}'`;
            findings.push(
              `[trace] ${rel}: traces_to の参照先 '${target}' の kind が ${trKindRepr} で、` +
                `期待される親 kind '${parentKind}' と一致しません`,
            );
          }
        }
      }
    }
    if (r.kind === "business_requirement" && r.tracesTo.length > 0) {
      findings.push(`[trace] ${rel}: business_requirement は最上位のため traces_to を持てません`);
    }
  }

  // 6. 親なし要件（confidence=undecided は不足検出から除外。SR-17）
  for (const r of records) {
    const rel = relTo(root, r.path);
    const parentKind =
      r.kind !== null && KIND_VALUES.has(r.kind) ? (KIND_PARENT.get(r.kind) ?? null) : null;
    if (parentKind === null) continue;
    if (r.confidence === "undecided") continue;
    if (r.tracesTo.length === 0) {
      findings.push(
        `[coverage] ${rel}: ${r.id} はどの ${parentKind} にも traces_to していません（親なし要件）`,
      );
    }
  }

  // 7. 未カバー要求（BR が誰からも参照されない）
  const referenced = new Set<string>();
  for (const r of records) {
    for (const target of r.tracesTo) referenced.add(target);
  }
  for (const r of records) {
    if (r.kind !== "business_requirement") continue;
    const rel = relTo(root, r.path);
    if (r.confidence === "undecided") continue;
    if (r.id !== null && !referenced.has(r.id)) {
      findings.push(
        `[coverage] ${rel}: ${r.id} はどの下位要件からも traces_to されていません（未カバー）`,
      );
    }
  }

  // 9. 主たる木（parent / also_belongs_to）検査（SR-27）
  const PARENTABLE_KINDS = new Set([
    "business_requirement",
    "stakeholder_requirement",
    "mandatory_output",
    "use_case",
  ]);
  for (const r of records) {
    const rel = relTo(root, r.path);

    // a. parent実在検査
    const parentTarget = r.parentId;
    let parentResolved = false;
    if (parentTarget !== null) {
      const targetRecs = byId.get(parentTarget);
      if (!targetRecs || targetRecs.length === 0) {
        findings.push(`[tree] ${rel}: parent の参照先 '${parentTarget}' が存在しません`);
      } else {
        parentResolved = true;
        // b. 種別制約（参照先が存在する場合のみ。二重報告を避ける）
        if (r.kind !== null && (PARENTABLE_KINDS.has(r.kind) || r.kind === "document_section")) {
          for (const tr of targetRecs) {
            if (tr.kind !== "document_section") {
              const trKindRepr = tr.kind === null ? "None" : `'${tr.kind}'`;
              findings.push(
                `[tree] ${rel}: ${r.kind} の parent は document_section でなければなりません` +
                  `（参照先 '${parentTarget}' の kind: ${trKindRepr}）`,
              );
            }
          }
        }
      }
    }

    // c. also_belongs_to実在検査
    for (const target of r.alsoBelongsTo) {
      const targetRecs = byId.get(target);
      if (!targetRecs || targetRecs.length === 0) {
        findings.push(`[tree] ${rel}: also_belongs_to の参照先 '${target}' が存在しません`);
      }
    }

    // d. also_belongs_to と parent の重複禁止
    if (parentResolved && parentTarget !== null && r.alsoBelongsTo.includes(parentTarget)) {
      findings.push(
        `[tree] ${rel}: also_belongs_to に主たる parent と同じ参照先 '${parentTarget}' が含まれています（重複）`,
      );
    }
  }

  // e. 循環検出（parent と also_belongs_to を合わせた内包グラフ）
  {
    const idToRecord = new Map<string, ReqRecord>();
    for (const r of records) {
      if (r.id !== null && !idToRecord.has(r.id)) idToRecord.set(r.id, r);
    }
    const reportedCycleMembers = new Set<string>();
    const visiting = new Set<string>();
    const visited = new Set<string>();

    function edgesFrom(id: string): string[] {
      const rec = idToRecord.get(id);
      if (!rec) return [];
      const targets: string[] = [];
      if (rec.parentId !== null && idToRecord.has(rec.parentId)) targets.push(rec.parentId);
      for (const t of rec.alsoBelongsTo) {
        if (idToRecord.has(t)) targets.push(t);
      }
      return targets;
    }

    function dfs(id: string, stack: string[]): void {
      if (reportedCycleMembers.has(id)) return;
      if (visiting.has(id)) {
        const cycleStart = stack.indexOf(id);
        const cycle = stack.slice(cycleStart).concat([id]);
        for (const member of cycle) reportedCycleMembers.add(member);
        findings.push(`[tree] 循環参照が検出されました（parent/also_belongs_to）: ${cycle.join(" -> ")}`);
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      stack.push(id);
      for (const next of edgesFrom(id)) {
        if (reportedCycleMembers.has(id)) break;
        dfs(next, stack);
      }
      stack.pop();
      visiting.delete(id);
      visited.add(id);
    }

    for (const id of idToRecord.keys()) {
      if (!visited.has(id) && !reportedCycleMembers.has(id)) {
        dfs(id, []);
      }
    }
  }

  return findings;
}

/**
 * SOL-40/SR-48: verification の質に対する保守的な弱シグナル警告（機械層のうち非ブロッキング側）。
 * lint() の必須検査（非空検査）とは別関数にして exit code に影響させない
 * （「違反として報告」＝lint()、「警告として挙げる」＝本関数、という SOL-40 の動詞の区別に対応）。
 *
 * 閾値の根拠（2026-08-05 実測。docs/requirements/ 全 SOL 40件の verification 文字数）:
 *   最短 24 文字（SOL-12）、以降 28・31・33・35…と分布。誤検出ゼロを絶対条件とするため、
 *   実測最短値より十分下（15文字未満。SOL-40.md 本文が候補として明示した例値）を閾値にした。
 *   → 既存 40 件はいずれも発火しない。
 *
 * 検討したが採用しなかった候補: 「句点も条件語（数値・『こと』以外の検証動作）も持たない」を
 * 短さと OR で組み合わせる案。実測で SOL-20（40文字、句点なし・数値なし）が該当し誤検出になる
 * ため不採用（誤検出ゼロが絶対条件）。短さ単独の閾値のみを採用する。
 *
 * 質の最終判断（具体性・合否判定可能性）はここでは行わない。人・AI の判断に委ねる
 * （requirements-loop / req-import / req-review の各手順。SOL-40 (b) 意味層）。
 */
const WEAK_VERIFICATION_MIN_LENGTH = 15;

export function lintVerificationWarnings(root: string): string[] {
  const warnings: string[] = [];
  const { records } = loadRecords(root);
  for (const r of records) {
    if (r.kind !== "solution_requirement") continue;
    const v = r.frontmatter["verification"];
    if (typeof v !== "string") continue; // 非空検査（lint()側）が別途担当
    const trimmed = v.trim();
    if (trimmed === "") continue; // 同上
    if (trimmed.length < WEAK_VERIFICATION_MIN_LENGTH) {
      const rel = relTo(root, r.path);
      warnings.push(
        `[quality-warn] ${rel}: solution_requirement の verification が極端に短い` +
          `（${trimmed.length}文字）。合否判定できる具体性を確認してください（SOL-40。` +
          `質の最終判断は人・AI に委ねる保守的な警告）`,
      );
    }
  }
  warnings.push(...lintAxesGroupWarnings(records, root));
  return warnings;
}

/**
 * SOL-27: 意味グループ（axes.group）の付与漏れの弱シグナル警告。
 *
 * 新規レコードへの group 付与はスキル層（requirements-loop）が担うが、スキルを通らない経路
 * （手で md を足す・外部から取り込む）では漏れる。漏れたレコードはツリービューで「未分類」に
 * 落ちて埋もれるため、器の側でも検出して報告する。
 *
 * 違反（exit 1）ではなく警告にしたのは、group が「AI の仮決め＋施主の承認」で決まる
 * 意味づけであり、機械が「無いから不正」と断ずる性質のものではないため（verification の
 * 「極端に短い」と同じ、質に関する弱シグナルの扱い）。テスト fixture が group を持たない
 * 最小レコードとして書かれていることとも両立する。
 *
 * 対象は SR / SOL / U / MO。BR と SEC は意味グループを持たない設計（全体を束ねる側であり、
 * 群に属する側ではない）ため対象外。
 */
const GROUPED_KINDS: ReadonlySet<string> = new Set([
  "stakeholder_requirement",
  "solution_requirement",
  "use_case",
  "mandatory_output",
]);

export function lintAxesGroupWarnings(records: ReqRecord[], root: string): string[] {
  const warnings: string[] = [];
  for (const r of records) {
    if (r.kind === null || !GROUPED_KINDS.has(r.kind)) continue;
    const g = r.axes["group"];
    const missing = g === null || g === undefined || (typeof g === "string" && g.trim() === "");
    if (!missing) continue;
    warnings.push(
      `[axes-warn] ${relTo(root, r.path)}: axes.group が未設定です` +
        `（意味グループは仮決めで付与し review_required を立てる運用。SOL-27。` +
        `未設定のままだとビューで「未分類」に埋もれます）`,
    );
  }
  return warnings;
}

function main(): number {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
    },
  });
  const root = values.root ?? defaultRoot();

  const findings = lint(root);
  const warnings = lintVerificationWarnings(root);

  if (findings.length === 0) {
    console.log(`req_lint: OK — ${root} に問題は見つかりませんでした。`);
  } else {
    console.log(`req_lint: ${findings.length} 件の問題が見つかりました（${root}）:`);
    for (const f of findings) {
      console.log(`  - ${f}`);
    }
  }

  // 警告（SOL-40 の弱シグナル）は exit code に影響しない（違反=lint findings とは別扱い）。
  if (warnings.length > 0) {
    console.log(`req_lint: ${warnings.length} 件の警告があります（exit code には影響しません）:`);
    for (const w of warnings) {
      console.log(`  - ${w}`);
    }
  }

  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
