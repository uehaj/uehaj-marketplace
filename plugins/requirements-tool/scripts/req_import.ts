#!/usr/bin/env node
/**
 * req_import.ts — 外部文書群の正本への取り込み（SR-43 / SOL-35）。
 *
 * 取り込みは「走査（機械的）→ 判別（AI）→ 適用（機械的）」の3段。本スクリプトは
 * 両端の機械的部分だけを担う（意味判断＝BR/SR/SOL の判別・実装詳細の識別・
 * axes.group や traces_to の提案は commands/req-import.md（AI）が行う）。両者は
 * 計画 JSON で受け渡す（req_init.ts と同型: CLI=機械的処理／コマンド=案内と判断）。
 *
 *   node scripts/req_import.ts --scan <パス> [--root <正本dir>] [--out <json>]
 *   node scripts/req_import.ts --apply <計画json> [--root <正本dir>] [--dry-run] [--force]
 *   node scripts/req_import.ts --help
 *
 * 終了コード: 成功=0、入力・計画の検証エラー=1、IO エラー=2（req_init.ts の慣行）。
 *
 * 外部依存ゼロ（node 標準のみ）。Node 23.6+ の型剥がしで直接実行する。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import {
  ID_PREFIX_FOR_KIND,
  ReqRecord,
  loadRecords,
  parseBodySections,
  parseFrontmatter,
  validatePhase,
  writeFileAtomic,
} from "./reqlib.ts";
import type { YamlValue } from "./reqlib.ts";

// ---------------------------------------------------------------------------
// 既定値・定数
// ---------------------------------------------------------------------------

function defaultRoot(): string {
  // 既定の対象は呼び出し元プロジェクト（req_init.ts 等と同じ流儀）。
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

const ALLOWED_KINDS: ReadonlySet<string> = new Set([
  "business_requirement",
  "stakeholder_requirement",
  "solution_requirement",
  "use_case",
]);

// parent 省略時の既定（SOL-35 の裁定。use_case は SOL-44 で SEC-12 を追加）。
const DEFAULT_PARENT_FOR_KIND: ReadonlyMap<string, string> = new Map([
  ["business_requirement", "SEC-5"],
  ["stakeholder_requirement", "SEC-6"],
  ["solution_requirement", "SEC-10"],
  ["use_case", "SEC-12"],
]);

const SCAN_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".html", ".txt"]);
const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules", ".git"]);

const AXES_KEY_ORDER: readonly string[] = [
  "phase",
  "abstraction",
  "category",
  "group",
  "stakeholder_role",
  "reversibility",
  "boundary",
  "implementation_detail",
];

const HELP = `req_import.ts — 外部文書群の正本への取り込み（SR-43 / SOL-35）

使い方:
  node scripts/req_import.ts --scan <パス> [--root <dir>] [--out <json>]
  node scripts/req_import.ts --apply <計画json> [--root <dir>] [--dry-run] [--force]
  node scripts/req_import.ts --help

--scan  文書（単体ファイルまたはディレクトリ配下の群。*.md/*.html/*.txt。
        node_modules・.git・docs/generated は除外）を見出し単位で分割し、
        取り込み候補セグメントの目録を JSON で出力する（決定的。乱数・タイムスタンプ
        を含まない）。既存正本の「## 由来」との照合結果（alreadyImported）も含む。
        --out 未指定時は stdout へ JSON、人間向けサマリは常に stderr へ出す。

--apply 計画 JSON（意味判断は commands/req-import.md（AI）が行い、計画 JSON として
        本スクリプトへ渡す）に従って正本へレコードを書き込む。1件でも検証エラーが
        あれば何も書き込まずに終了する。ID は kind ごとに既存最大+1 の連番。
        既存レコードの「## 由来」に同じ source.path + heading があれば重複としてスキップ
        する（--force で重複検査を無視して新規追加を強行できる。既存の上書きはしない）。
  --dry-run  書き込まず、書く予定のファイル名・ID・状態・スキップ理由を一覧表示する。

--root  正本ディレクトリ（既定: docs/requirements。CLAUDE_PROJECT_DIR があればその配下）

終了コード: 成功=0、入力・計画の検証エラー=1、IO エラー=2。`;

// ---------------------------------------------------------------------------
// 共通ユーティリティ
// ---------------------------------------------------------------------------

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** 走査対象ファイルの表示パス（cwd 相対。cwd 外なら絶対）。--apply の source.path と同じ規約。 */
function relFromCwd(absPath: string): string {
  const rel = path.relative(process.cwd(), absPath);
  return toPosix(rel.startsWith("..") ? absPath : rel);
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function excerptOf(text: string, limit = 200): string {
  const norm = normalizeWhitespace(text);
  return norm.length > limit ? norm.slice(0, limit) : norm;
}

/** <script>/<style> の内容だけを空白化する（改行は保持し行番号を保つ）。 */
function blankBlocks(html: string, tagName: string): string {
  const re = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`, "gi");
  return html.replace(re, (m) => m.replace(/[^\n]/g, " "));
}

// ---------------------------------------------------------------------------
// --scan: セグメント分割
// ---------------------------------------------------------------------------

interface Segment {
  index: number;
  heading: string | null;
  headingPath: string[];
  excerpt: string;
  lineStart: number;
  lineEnd: number;
}

function splitMarkdown(text: string): Segment[] {
  const lines = text.split("\n");
  const boundaries: { lineIdx: number; level: number; heading: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m) {
      boundaries.push({ lineIdx: i, level: m[1].length, heading: m[2].replace(/#+\s*$/, "").trim() });
    }
  }
  const segments: Segment[] = [];
  let idx = 0;

  if (boundaries.length === 0) {
    segments.push({
      index: idx++,
      heading: null,
      headingPath: [],
      excerpt: excerptOf(lines.join(" ")),
      lineStart: 1,
      lineEnd: Math.max(lines.length, 1),
    });
    return segments;
  }

  if (boundaries[0].lineIdx > 0) {
    const pre = lines.slice(0, boundaries[0].lineIdx);
    segments.push({
      index: idx++,
      heading: null,
      headingPath: [],
      excerpt: excerptOf(pre.join(" ")),
      lineStart: 1,
      lineEnd: boundaries[0].lineIdx,
    });
  }

  const stack: { level: number; heading: string }[] = [];
  for (let bi = 0; bi < boundaries.length; bi++) {
    const b = boundaries[bi];
    while (stack.length > 0 && stack[stack.length - 1].level >= b.level) stack.pop();
    const headingPath = stack.map((s) => s.heading);
    const nextIdx = bi + 1 < boundaries.length ? boundaries[bi + 1].lineIdx : lines.length;
    const contentLines = lines.slice(b.lineIdx + 1, nextIdx);
    segments.push({
      index: idx++,
      heading: b.heading,
      headingPath,
      excerpt: excerptOf(contentLines.join(" ")),
      lineStart: b.lineIdx + 1,
      lineEnd: Math.max(nextIdx, b.lineIdx + 1),
    });
    stack.push({ level: b.level, heading: b.heading });
  }
  return segments;
}

function splitHtml(rawText: string): Segment[] {
  let text = blankBlocks(rawText, "script");
  text = blankBlocks(text, "style");

  const headingRe = /<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;
  const matches: { index: number; end: number; level: number; heading: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(text)) !== null) {
    matches.push({
      index: m.index,
      end: m.index + m[0].length,
      level: parseInt(m[1], 10),
      heading: normalizeWhitespace(stripTags(m[2])),
    });
  }

  function lineOf(offset: number): number {
    return text.slice(0, offset).split("\n").length;
  }

  const segments: Segment[] = [];
  let idx = 0;

  if (matches.length === 0) {
    segments.push({
      index: idx++,
      heading: null,
      headingPath: [],
      excerpt: excerptOf(stripTags(text)),
      lineStart: 1,
      lineEnd: Math.max(text.split("\n").length, 1),
    });
    return segments;
  }

  if (matches[0].index > 0) {
    const pre = text.slice(0, matches[0].index);
    segments.push({
      index: idx++,
      heading: null,
      headingPath: [],
      excerpt: excerptOf(stripTags(pre)),
      lineStart: 1,
      lineEnd: lineOf(matches[0].index),
    });
  }

  const stack: { level: number; heading: string }[] = [];
  for (let mi = 0; mi < matches.length; mi++) {
    const cur = matches[mi];
    while (stack.length > 0 && stack[stack.length - 1].level >= cur.level) stack.pop();
    const headingPath = stack.map((s) => s.heading);
    const nextIndex = mi + 1 < matches.length ? matches[mi + 1].index : text.length;
    const content = text.slice(cur.end, nextIndex);
    segments.push({
      index: idx++,
      heading: cur.heading,
      headingPath,
      excerpt: excerptOf(stripTags(content)),
      lineStart: lineOf(cur.index),
      lineEnd: Math.max(lineOf(nextIndex), lineOf(cur.index)),
    });
    stack.push({ level: cur.level, heading: cur.heading });
  }
  return segments;
}

function splitText(text: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let idx = 0;
  let blockStart: number | null = null;
  let blockLines: string[] = [];

  function flush(endLine: number): void {
    if (blockStart === null) return;
    if (blockLines.some((l) => l.trim() !== "")) {
      segments.push({
        index: idx++,
        heading: null,
        headingPath: [],
        excerpt: excerptOf(blockLines.join(" ")),
        lineStart: blockStart,
        lineEnd: endLine,
      });
    }
    blockStart = null;
    blockLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    if (lines[i].trim() === "") {
      flush(lineNo - 1);
      continue;
    }
    if (blockStart === null) blockStart = lineNo;
    blockLines.push(lines[i]);
  }
  flush(lines.length);

  if (segments.length === 0) {
    segments.push({
      index: 0,
      heading: null,
      headingPath: [],
      excerpt: "",
      lineStart: 1,
      lineEnd: Math.max(lines.length, 1),
    });
  }
  return segments;
}

function splitByExtension(ext: string, text: string): Segment[] {
  if (ext === ".md") return splitMarkdown(text);
  if (ext === ".html") return splitHtml(text);
  return splitText(text);
}

// ---------------------------------------------------------------------------
// --scan: ファイル列挙
// ---------------------------------------------------------------------------

function isExcludedDir(absDir: string): boolean {
  const base = path.basename(absDir);
  if (EXCLUDED_DIR_NAMES.has(base)) return true;
  if (base === "generated" && path.basename(path.dirname(absDir)) === "docs") return true;
  return false;
}

function listTargetFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return SCAN_EXTENSIONS.has(path.extname(target).toLowerCase()) ? [path.resolve(target)] : [];
  }
  const results: string[] = [];
  function walk(dir: string): void {
    if (isExcludedDir(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile() && SCAN_EXTENSIONS.has(path.extname(name).toLowerCase())) {
        results.push(abs);
      }
    }
  }
  walk(path.resolve(target));
  return results;
}

// ---------------------------------------------------------------------------
// --scan: 既取り込み照合
// ---------------------------------------------------------------------------

interface ProvenanceMatch {
  matched: boolean;
  recordIds: string[];
}

function loadProvenanceTexts(root: string): Map<string, string> | null {
  if (!fs.existsSync(root)) return null;
  const { records, errors } = loadRecords(root);
  if (errors.length > 0) return null;
  const map = new Map<string, string>();
  for (const r of records) {
    if (!r.id) continue;
    const sections = parseBodySections(r.body);
    const text = sections["由来"] ?? "";
    if (text) map.set(r.id, text);
  }
  return map;
}

function matchProvenance(
  provenance: Map<string, string> | null,
  relPath: string,
  heading: string | null,
): { fileLevel: ProvenanceMatch; segmentLevel: ProvenanceMatch } {
  if (!provenance) {
    return { fileLevel: { matched: false, recordIds: [] }, segmentLevel: { matched: false, recordIds: [] } };
  }
  const fileIds: string[] = [];
  const segIds: string[] = [];
  for (const [id, text] of provenance) {
    if (!text.includes(relPath)) continue;
    fileIds.push(id);
    if (heading !== null && text.includes(heading)) segIds.push(id);
  }
  return {
    fileLevel: { matched: fileIds.length > 0, recordIds: fileIds },
    segmentLevel: { matched: segIds.length > 0, recordIds: segIds },
  };
}

// ---------------------------------------------------------------------------
// --scan: 本体
// ---------------------------------------------------------------------------

interface ScanFileEntry {
  path: string;
  alreadyImported: ProvenanceMatch;
  segments: (Segment & { alreadyImported: ProvenanceMatch })[];
}

interface ScanResult {
  files: ScanFileEntry[];
  summary: {
    fileCount: number;
    segmentCount: number;
    alreadyImportedFileCount: number;
    alreadyImportedSegmentCount: number;
  };
}

function runScan(target: string, root: string): { result: ScanResult; ioError?: string } {
  if (!fs.existsSync(target)) {
    return { result: { files: [], summary: { fileCount: 0, segmentCount: 0, alreadyImportedFileCount: 0, alreadyImportedSegmentCount: 0 } }, ioError: `走査対象が存在しません: ${target}` };
  }
  const absFiles = listTargetFiles(target).sort((a, b) => (relFromCwd(a) < relFromCwd(b) ? -1 : relFromCwd(a) > relFromCwd(b) ? 1 : 0));
  const provenance = loadProvenanceTexts(root);

  const files: ScanFileEntry[] = [];
  let segmentCount = 0;
  let alreadyImportedFileCount = 0;
  let alreadyImportedSegmentCount = 0;

  for (const absFile of absFiles) {
    const relPath = relFromCwd(absFile);
    const ext = path.extname(absFile).toLowerCase();
    const text = fs.readFileSync(absFile, "utf-8");
    const segments = splitByExtension(ext, text);

    const fileMatchIds = new Set<string>();
    const seenSegments: (Segment & { alreadyImported: ProvenanceMatch })[] = [];
    for (const seg of segments) {
      const { fileLevel, segmentLevel } = matchProvenance(provenance, relPath, seg.heading);
      for (const id of fileLevel.recordIds) fileMatchIds.add(id);
      if (segmentLevel.matched) alreadyImportedSegmentCount += 1;
      seenSegments.push({ ...seg, alreadyImported: segmentLevel });
      segmentCount += 1;
    }
    const fileMatch: ProvenanceMatch = { matched: fileMatchIds.size > 0, recordIds: [...fileMatchIds].sort() };
    if (fileMatch.matched) alreadyImportedFileCount += 1;

    files.push({ path: relPath, alreadyImported: fileMatch, segments: seenSegments });
  }

  return {
    result: {
      files,
      summary: {
        fileCount: files.length,
        segmentCount,
        alreadyImportedFileCount,
        alreadyImportedSegmentCount,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// --apply: 計画 JSON の型
// ---------------------------------------------------------------------------

interface PlanSource {
  path: string;
  heading?: string | null;
  lines?: string | null;
  quote?: string | null;
}

interface PlanRecord {
  localId?: string;
  kind: string;
  title: string;
  statement: string;
  rationale?: string;
  traces_to?: string[];
  parent?: string;
  axes?: Record<string, YamlValue>;
  implementationDetail?: boolean;
  confidenceNote?: string;
  source: PlanSource;
}

interface Plan {
  approvedSource?: boolean;
  declaration?: string;
  records: PlanRecord[];
}

// ---------------------------------------------------------------------------
// --apply: スカラー・ブロックの安全な emit
// ---------------------------------------------------------------------------

function needsQuoting(s: string): boolean {
  if (s === "") return true;
  if (/^-?\d+$/.test(s)) return true;
  if (s === "true" || s === "false" || s === "null" || s === "~") return true;
  if (/^[[\]'"#]/.test(s)) return true;
  if (s.includes("\n")) return true;
  return false;
}

function emitScalarString(s: string): string {
  if (!needsQuoting(s)) return s;
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `'${s.replace(/'/g, "''")}'`;
}

function emitLiteralBlock(key: string, content: string): string {
  const text = (content ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const out = [`${key}: |`];
  for (const l of lines) out.push(l === "" ? "" : `  ${l}`);
  return out.join("\n");
}

function emitInlineOrBlock(key: string, value: string): string {
  if (value.includes("\n")) return emitLiteralBlock(key, value);
  return `${key}: ${emitScalarString(value)}`;
}

function emitAxesValue(v: YamlValue): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v === "cross-cutting" ? v : emitScalarString(v);
  if (Array.isArray(v)) {
    return (
      "[" +
      v
        .map((x) => (typeof x === "number" ? String(x) : emitScalarString(String(x))))
        .join(", ") +
      "]"
    );
  }
  throw new Error(`axes の値の型に対応していません: ${JSON.stringify(v)}`);
}

function buildAxesEntries(
  planAxes: Record<string, YamlValue> | undefined,
  implementationDetail: boolean,
  reviewRequired: boolean,
): [string, YamlValue][] {
  const axes: Record<string, YamlValue> = { ...(planAxes ?? {}) };
  if (implementationDetail) axes.implementation_detail = true;
  delete axes.review_required;

  const entries: [string, YamlValue][] = [];
  for (const k of AXES_KEY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(axes, k)) {
      entries.push([k, axes[k]]);
      delete axes[k];
    }
  }
  for (const k of Object.keys(axes).sort()) {
    entries.push([k, axes[k]]);
  }
  entries.push(["review_required", reviewRequired]);
  return entries;
}

// ---------------------------------------------------------------------------
// --apply: 由来・本文の組み立て
// ---------------------------------------------------------------------------

function buildProvenanceText(source: PlanSource, approvedSource: boolean, declaration?: string): string {
  const lines: string[] = [];
  lines.push(`- ソース: ${source.path}`);
  lines.push(`- 見出し: ${source.heading ?? "（見出しなし）"}`);
  lines.push(`- 行: ${source.lines ?? "（不明）"}`);
  if (source.quote) lines.push(`- 引用: > ${source.quote}`);
  if (approvedSource) lines.push(`- 承認: 施主宣言（${declaration ?? ""}）`);
  return lines.join("\n");
}

function buildBody(id: string, title: string, provenanceText: string, implementationDetail: boolean): string {
  let body = `# ${id} — ${title}\n\n## 由来\n${provenanceText}\n`;
  if (implementationDetail) {
    body +=
      `\n## 位置づけ\n本レコードは実装詳細であり、要求仕様（Specification）としては` +
      `**除外の候補**である。採否は施主のレビューで裁定する\n`;
  }
  return body;
}

const DEFAULT_CANDIDATE_NOTE =
  "req import による取り込み（未承認文書）。要求本体・axes・traces_to・parent はいずれも" +
  "AI仮決めのためレビュー必須（review_required）。";
const DEFAULT_APPROVED_NOTE =
  "文書自体は施主宣言により承認済み（approvedSource）。ただし構造メタ（axes・traces_to・" +
  "parent）はAIの解釈であり、レビュー対象。";

// ---------------------------------------------------------------------------
// --apply: 検証・準備
// ---------------------------------------------------------------------------

interface PreparedRecord {
  planRecord: PlanRecord;
  parent: string;
  approvedSource: boolean;
  declaration?: string;
}

function recordLabel(pr: PlanRecord, index: number): string {
  return pr.localId ? `${pr.localId}（${pr.title ?? "無題"}）` : `records[${index}]（${pr.title ?? "無題"}）`;
}

/**
 * 計画 JSON を検証する。エラーがあれば全件をまとめて返す（1件でも不正なら何も
 * 書き込まない方針。呼び出し側が判断する）。
 */
function validatePlan(
  plan: Plan,
  root: string,
  existing: { records: ReqRecord[]; errors: string[] },
): { errors: string[]; prepared: PreparedRecord[]; localIdMap: Map<string, PlanRecord> } {
  const errors: string[] = [];
  const prepared: PreparedRecord[] = [];

  if (!Array.isArray(plan.records)) {
    errors.push("計画 JSON の records は配列である必要があります。");
    return { errors, prepared, localIdMap: new Map() };
  }

  const approvedSource = plan.approvedSource === true;
  if (approvedSource && (!plan.declaration || plan.declaration.trim() === "")) {
    errors.push("approvedSource: true のときは declaration（施主宣言の事実と日付）が必須です。");
  }

  const existingIds = new Set(existing.records.map((r) => r.id).filter((x): x is string => x !== null));
  const existingById = new Map<string, ReqRecord>();
  for (const r of existing.records) if (r.id) existingById.set(r.id, r);

  const localIdMap = new Map<string, PlanRecord>();
  const localIdCounts = new Map<string, number>();
  for (const pr of plan.records) {
    if (pr.localId) {
      localIdCounts.set(pr.localId, (localIdCounts.get(pr.localId) ?? 0) + 1);
      localIdMap.set(pr.localId, pr);
    }
  }
  for (const [lid, count] of localIdCounts) {
    if (count > 1) errors.push(`localId '${lid}' が計画内で複数のレコードに使われています（重複）。`);
  }

  plan.records.forEach((pr, index) => {
    const label = recordLabel(pr, index);

    if (typeof pr.kind !== "string" || !ALLOWED_KINDS.has(pr.kind)) {
      errors.push(
        `${label}: kind の値が不正です（${JSON.stringify(pr.kind)}）。許容: business_requirement / stakeholder_requirement / solution_requirement / use_case`,
      );
    }
    if (typeof pr.title !== "string" || pr.title.trim() === "") {
      errors.push(`${label}: title が非空の文字列である必要があります。`);
    }
    if (typeof pr.statement !== "string" || pr.statement.trim() === "") {
      errors.push(`${label}: statement が非空の文字列である必要があります。`);
    }
    if (!pr.source || typeof pr.source.path !== "string" || pr.source.path.trim() === "") {
      errors.push(`${label}: source.path が必要です。`);
    }

    const tracesTo = Array.isArray(pr.traces_to) ? pr.traces_to : [];
    for (const target of tracesTo) {
      if (!existingIds.has(target) && !localIdMap.has(target)) {
        errors.push(`${label}: traces_to の参照先 '${target}' が正本にも計画内 localId にも見つかりません。`);
      }
    }

    const kindOk = typeof pr.kind === "string" && ALLOWED_KINDS.has(pr.kind);
    const parent = pr.parent ?? (kindOk ? DEFAULT_PARENT_FOR_KIND.get(pr.kind) : undefined);
    if (!parent) {
      errors.push(`${label}: parent を解決できません（kind が不正なため既定値も決まりません）。`);
    } else {
      const parentRec = existingById.get(parent);
      if (!parentRec) {
        errors.push(`${label}: parent の参照先 '${parent}' が正本に存在しません。`);
      } else if (parentRec.kind !== "document_section") {
        errors.push(`${label}: parent '${parent}' は document_section（章節）である必要があります。`);
      }
    }

    if (pr.axes && "phase" in pr.axes) {
      const phaseError = validatePhase(pr.axes.phase as YamlValue);
      if (phaseError) errors.push(`${label}: axes.${phaseError}`.replace("axes.axes.", "axes."));
    }

    if (parent) {
      prepared.push({
        planRecord: pr,
        parent,
        approvedSource,
        declaration: plan.declaration,
      });
    }
  });

  return { errors, prepared, localIdMap };
}

// ---------------------------------------------------------------------------
// --apply: ID 采番・重複検査・書き込み計画の構築
// ---------------------------------------------------------------------------

interface DuplicateInfo {
  matched: boolean;
  recordIds: string[];
}

function findDuplicate(existing: ReqRecord[], source: PlanSource): DuplicateInfo {
  const ids: string[] = [];
  for (const r of existing) {
    if (!r.id) continue;
    const sections = parseBodySections(r.body);
    const text = sections["由来"] ?? "";
    if (!text) continue;
    if (!text.includes(source.path)) continue;
    if (source.heading && !text.includes(source.heading)) continue;
    ids.push(r.id);
  }
  return { matched: ids.length > 0, recordIds: ids };
}

interface WritePlanItem {
  status: "write" | "skip";
  id?: string;
  filename?: string;
  kind: string;
  implementationDetail: boolean;
  approval: string;
  confidence: string;
  reviewRequired: boolean;
  duplicate?: DuplicateInfo;
  text?: string;
  title: string;
  localId?: string;
}

function buildWritePlan(
  prepared: PreparedRecord[],
  existing: ReqRecord[],
  force: boolean,
): { items: WritePlanItem[]; error?: string } {
  const existingMaxByKind = new Map<string, number>();
  for (const [kind, prefix] of ID_PREFIX_FOR_KIND) {
    let max = 0;
    for (const r of existing) {
      if (r.id && r.id.startsWith(`${prefix}-`)) {
        const n = r.idNumber();
        if (n > max) max = n;
      }
    }
    existingMaxByKind.set(kind, max);
  }

  // localId -> 最終的な参照先 ID（書き込み対象なら新規 ID、重複スキップなら既存の一致先）。
  const resolvedIdForLocal = new Map<string, string>();
  const items: WritePlanItem[] = [];

  for (const pr of prepared) {
    const { planRecord: rec, approvedSource } = pr;
    const dup = force ? { matched: false, recordIds: [] } : findDuplicate(existing, rec.source);

    if (dup.matched) {
      if (rec.localId) {
        resolvedIdForLocal.set(rec.localId, dup.recordIds[0]);
      }
      items.push({
        status: "skip",
        kind: rec.kind,
        implementationDetail: rec.implementationDetail === true,
        approval: approvedSource ? "agreed" : "candidate",
        confidence: approvedSource ? "confirmed" : "provisional",
        reviewRequired: !approvedSource,
        duplicate: dup,
        title: rec.title,
        localId: rec.localId,
      });
      continue;
    }

    const prefix = ID_PREFIX_FOR_KIND.get(rec.kind);
    if (!prefix) {
      return { items, error: `内部エラー: kind '${rec.kind}' に対応する ID prefix がありません。` };
    }
    const nextNum = (existingMaxByKind.get(rec.kind) ?? 0) + 1;
    existingMaxByKind.set(rec.kind, nextNum);
    const id = `${prefix}-${nextNum}`;
    const filename = `${prefix}-${String(nextNum).padStart(2, "0")}.md`;
    if (rec.localId) resolvedIdForLocal.set(rec.localId, id);

    items.push({
      status: "write",
      id,
      filename,
      kind: rec.kind,
      implementationDetail: rec.implementationDetail === true,
      approval: approvedSource ? "agreed" : "candidate",
      confidence: approvedSource ? "confirmed" : "provisional",
      reviewRequired: !approvedSource,
      title: rec.title,
      localId: rec.localId,
    });
  }

  // 第2パス: traces_to を最終 ID へ解決してテキストを組み立てる。
  let writeIdx = 0;
  for (let i = 0; i < prepared.length; i++) {
    const item = items[i];
    if (item.status !== "write") continue;
    const rec = prepared[i].planRecord;
    const parent = prepared[i].parent;
    const approvedSource = prepared[i].approvedSource;
    const declaration = prepared[i].declaration;

    const tracesTo = (Array.isArray(rec.traces_to) ? rec.traces_to : []).map(
      (t) => resolvedIdForLocal.get(t) ?? t,
    );

    const confidenceNote =
      rec.confidenceNote ?? (approvedSource ? DEFAULT_APPROVED_NOTE : DEFAULT_CANDIDATE_NOTE);

    const axesEntries = buildAxesEntries(rec.axes, item.implementationDetail, item.reviewRequired);

    const fmLines: string[] = [];
    fmLines.push(`id: ${item.id}`);
    fmLines.push(`kind: ${rec.kind}`);
    fmLines.push(`title: ${emitScalarString(rec.title)}`);
    fmLines.push(emitLiteralBlock("statement", rec.statement));
    fmLines.push(emitLiteralBlock("rationale", rec.rationale ?? ""));
    fmLines.push(`traces_to: [${tracesTo.join(", ")}]`);
    fmLines.push("state:");
    fmLines.push(`  approval: ${item.approval}`);
    fmLines.push(`  disposition: active`);
    fmLines.push(`  implementation: not_started`);
    fmLines.push(`  validation: unvalidated`);
    fmLines.push(`  confidence: ${item.confidence}`);
    fmLines.push(emitInlineOrBlock("confidence_note", confidenceNote));
    fmLines.push("axes:");
    for (const [k, v] of axesEntries) fmLines.push(`  ${k}: ${emitAxesValue(v)}`);
    fmLines.push("verification: null");
    fmLines.push(`parent: ${parent}`);
    fmLines.push("also_belongs_to: []");

    const provenanceText = buildProvenanceText(rec.source, approvedSource, declaration);
    const body = buildBody(item.id!, rec.title, provenanceText, item.implementationDetail);

    const text = `---\n${fmLines.join("\n")}\n---\n\n${body}`;

    // 書き込み前の安全確認（再パース可能・id/kind が一致すること。config-edit-safety）。
    try {
      const [reparsed] = parseFrontmatter(text);
      if (reparsed.id !== item.id || reparsed.kind !== rec.kind) {
        return { items, error: `${item.id}: 生成した frontmatter の再解析で id/kind が一致しません（内容に frontmatter を壊す文字列が含まれている可能性があります）。` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { items, error: `${item.id ?? rec.localId ?? "(unknown)"}: 生成した frontmatter の解析に失敗しました: ${msg}` };
    }

    item.text = text;
    writeIdx += 1;
  }

  return { items };
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

function printScanSummary(result: ScanResult): void {
  process.stderr.write(
    `req_import --scan: ファイル ${result.summary.fileCount} 件・セグメント ${result.summary.segmentCount} 件` +
      `（既取り込み: ファイル ${result.summary.alreadyImportedFileCount} 件・セグメント ${result.summary.alreadyImportedSegmentCount} 件）\n`,
  );
}

function runApply(planPath: string, root: string, dryRun: boolean, force: boolean): number {
  if (!fs.existsSync(planPath)) {
    console.error(`req_import: 計画 JSON が見つかりません: ${planPath}`);
    return 2;
  }
  let planText: string;
  try {
    planText = fs.readFileSync(planPath, "utf-8");
  } catch (e) {
    console.error(`req_import: 計画 JSON を読み込めません: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  let plan: Plan;
  try {
    plan = JSON.parse(planText);
  } catch (e) {
    console.error(`req_import: 計画 JSON の構文エラーです: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`req_import: 正本ディレクトリが存在しません: ${root}`);
    return 2;
  }
  const existing = loadRecords(root);
  if (existing.errors.length > 0) {
    console.error("req_import: 正本に解析エラーがあるため中止します（安全側）:");
    for (const e of existing.errors) console.error(`  - ${e}`);
    return 2;
  }

  const { errors, prepared, localIdMap } = validatePlan(plan, root, existing);
  void localIdMap;
  if (errors.length > 0) {
    console.error(`req_import: 計画 JSON に ${errors.length} 件の検証エラーがあります（何も書き込みません）:`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }

  const { items, error } = buildWritePlan(prepared, existing.records, force);
  if (error) {
    console.error(`req_import: ${error}（何も書き込みません）`);
    return 1;
  }

  const toWrite = items.filter((it) => it.status === "write");
  const skipped = items.filter((it) => it.status === "skip");

  if (dryRun) {
    console.log(`req_import --apply --dry-run: 書き込みは行いません。`);
    for (const it of toWrite) {
      console.log(
        `  [書込予定] ${it.id} (${it.filename}) kind=${it.kind} approval=${it.approval} ` +
          `confidence=${it.confidence} review_required=${it.reviewRequired}` +
          (it.implementationDetail ? " [実装詳細/除外候補]" : ""),
      );
    }
    for (const it of skipped) {
      console.log(
        `  [スキップ] ${it.localId ?? it.title} — 既存レコードと重複（由来一致: ${it.duplicate?.recordIds.join(", ")}）`,
      );
    }
  } else {
    for (const it of toWrite) {
      const filePath = path.join(root, it.filename!);
      writeFileAtomic(filePath, it.text!);
      console.log(`req_import: 追加 ${it.id} → ${filePath}`);
    }
    for (const it of skipped) {
      console.log(`req_import: スキップ ${it.localId ?? it.title}（既存と重複: ${it.duplicate?.recordIds.join(", ")}）`);
    }
  }

  const byKind = new Map<string, number>();
  let implCount = 0;
  for (const it of toWrite) {
    byKind.set(it.kind, (byKind.get(it.kind) ?? 0) + 1);
    if (it.implementationDetail) implCount += 1;
  }
  const kindLabel = (k: string) => ID_PREFIX_FOR_KIND.get(k) ?? k;
  const breakdown = [...byKind.entries()].map(([k, n]) => `${kindLabel(k)} ${n}件`).join("・") || "0件";

  console.log(
    `req_import: ${dryRun ? "[dry-run] " : ""}追加 ${toWrite.length} 件（${breakdown}、うち実装詳細 ${implCount} 件）／` +
      `スキップ ${skipped.length} 件`,
  );
  if (!dryRun && toWrite.length > 0) {
    console.log("req_import: 次は `req lint` と通読レビュー（/guided）で確認してください。");
  }

  return 0;
}

function main(): number {
  let values: {
    scan?: string;
    apply?: string;
    root?: string;
    out?: string;
    "dry-run"?: boolean;
    force?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      options: {
        scan: { type: "string" },
        apply: { type: "string" },
        root: { type: "string" },
        out: { type: "string" },
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch (e) {
    console.error(`req_import: 引数エラー: ${e instanceof Error ? e.message : String(e)}`);
    console.error(HELP);
    return 1;
  }

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const root = values.root ?? defaultRoot();

  if (values.scan && values.apply) {
    console.error("req_import: --scan と --apply は同時に指定できません。");
    return 1;
  }

  if (values.scan) {
    const { result, ioError } = runScan(values.scan, root);
    if (ioError) {
      console.error(`req_import: ${ioError}`);
      return 2;
    }
    const json = JSON.stringify(result, null, 2);
    if (values.out) {
      fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
      fs.writeFileSync(values.out, json + "\n", "utf-8");
    } else {
      process.stdout.write(json + "\n");
    }
    printScanSummary(result);
    return 0;
  }

  if (values.apply) {
    return runApply(values.apply, root, values["dry-run"] === true, values.force === true);
  }

  console.error("req_import: --scan または --apply のいずれかを指定してください。");
  console.error(HELP);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
