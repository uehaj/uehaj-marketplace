#!/usr/bin/env node
/**
 * req_impact.ts — 要求と実装の双方向連動（SOL-8 / SR-7）。
 *
 * 「要求の記録が開発セッションから切り離された別世界であってはならない」（SR-7）ための道具。
 * 2 つの向きを扱う:
 *
 *   要求 → 実装（--id <ID>）: その要求・要件を実装しているコード箇所を示す。要求が変わった
 *     ときに、どのファイルを直す必要があるかが分かる（変更の伝搬先）。子孫（traces_to で
 *     遡ってくる下位レコード）の実装箇所も含める——上位が変われば下位の実装も影響を受ける。
 *
 *   実装 → 要求（--file <path>）: そのファイルがどの要求・要件を実装しているかを示す。
 *     実装中の発見をどのレコードへ書き戻すべきかが分かる。
 *
 * 対応づけの根拠は「コード中に現れる ID 参照」（コメント・文言に書かれた `SOL-41` 等）とする。
 * 別の対応表を新設しない——表を作れば必ず実体とずれる（更新されない台帳になる）。コード側の
 * 参照は変更時に目に入るため、実体との乖離が起きにくい。この選択の帰結として「ID を書いて
 * いない実装は検出できない」が、それは「対応が記録されていない」という事実そのものであり、
 * 隠すべきではない（未対応として報告する）。
 *
 * 読み取り専用。出力は決定的（パス昇順・ID 昇順）。
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

/** 走査対象のディレクトリ（実装の実体が置かれる場所）。 */
const SCAN_DIRS: readonly string[] = ["scripts", "bin", "hooks", "skills", "commands", "tests"];

/** 走査対象の拡張子。 */
const SCAN_EXTS: readonly string[] = [".ts", ".js", ".sh", ".md", ".ps1"];

/** ファイルを再帰的に集める（決定的: パス昇順）。 */
function collectFiles(dir: string): string[] {
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
      out.push(...collectFiles(p));
    } else if (SCAN_EXTS.some((ext) => e.name.endsWith(ext))) {
      out.push(p);
    }
  }
  return out;
}

export interface ImplIndex {
  /** ID → その ID を参照しているファイル（プロジェクト相対パス。昇順） */
  byId: Map<string, string[]>;
  /** ファイル → そのファイルが参照している ID（昇順） */
  byFile: Map<string, string[]>;
}

/**
 * コード中の ID 参照から対応関係の索引を作る。
 * ID の形は正本に実在するものだけを対象にする（`SR-8` のような一般的な綴りが偶然一致する
 * 誤検出を避けるため、正本の ID 集合で絞る）。
 */
export function buildImplIndex(root: string, records: ReqRecord[]): ImplIndex {
  const projectRoot = projectRootFor(root);
  const ids = new Set<string>();
  for (const r of records) if (r.id !== null) ids.add(r.id);

  const byId = new Map<string, string[]>();
  const byFile = new Map<string, string[]>();

  for (const dir of SCAN_DIRS) {
    for (const abs of collectFiles(path.join(projectRoot, dir))) {
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf-8");
      } catch {
        continue;
      }
      const rel = path.relative(projectRoot, abs).split(path.sep).join("/");
      const found = new Set<string>();
      for (const m of text.matchAll(/\b(BR|SR|SOL|MO|SEC|U)-(\d+)\b/g)) {
        // 正準表記（SR-8）へ寄せてから正本の ID 集合と照合する
        const canonical = `${m[1]}-${Number.parseInt(m[2], 10)}`;
        if (ids.has(canonical)) found.add(canonical);
      }
      if (found.size === 0) continue;
      const list = [...found].sort(compareId);
      byFile.set(rel, list);
      for (const id of list) {
        const files = byId.get(id) ?? [];
        files.push(rel);
        byId.set(id, files);
      }
    }
  }
  for (const [id, files] of byId) byId.set(id, files.sort());
  return { byId, byFile };
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

/** その ID に traces_to で遡ってくる下位レコードを再帰的に集める（変更の伝搬先）。 */
export function descendantsOf(id: string, records: ReqRecord[]): string[] {
  const children = new Map<string, string[]>();
  for (const r of records) {
    if (r.id === null) continue;
    for (const t of r.tracesTo) {
      const list = children.get(t) ?? [];
      list.push(r.id);
      children.set(t, list);
    }
  }
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const c of children.get(cur) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(c);
    }
  }
  return [...seen].sort(compareId);
}

export interface ForwardResult {
  id: string;
  /** その ID を直接参照している実装箇所 */
  direct: string[];
  /** 下位レコード（traces_to で遡ってくるもの）の実装箇所 */
  viaDescendants: { id: string; files: string[] }[];
  /** 実装箇所が 1 件も見つからなかったか（対応が記録されていない状態） */
  unmapped: boolean;
}

export function impactOfRequirement(root: string, id: string): ForwardResult {
  const loaded = loadRecords(root);
  if (loaded.errors.length > 0) {
    throw new Error("req_impact: 正本の読み込みに失敗しました:\n" + loaded.errors.join("\n"));
  }
  const index = buildImplIndex(root, loaded.records);
  const direct = index.byId.get(id) ?? [];
  const viaDescendants: { id: string; files: string[] }[] = [];
  for (const d of descendantsOf(id, loaded.records)) {
    const files = index.byId.get(d) ?? [];
    if (files.length > 0) viaDescendants.push({ id: d, files });
  }
  return { id, direct, viaDescendants, unmapped: direct.length === 0 && viaDescendants.length === 0 };
}

export interface ReverseResult {
  file: string;
  ids: string[];
}

export function requirementsOfFile(root: string, file: string): ReverseResult {
  const loaded = loadRecords(root);
  if (loaded.errors.length > 0) {
    throw new Error("req_impact: 正本の読み込みに失敗しました:\n" + loaded.errors.join("\n"));
  }
  const index = buildImplIndex(root, loaded.records);
  const projectRoot = projectRootFor(root);
  const rel = path.isAbsolute(file)
    ? path.relative(projectRoot, file).split(path.sep).join("/")
    : file.split(path.sep).join("/");
  return { file: rel, ids: index.byFile.get(rel) ?? [] };
}

/** 対応が記録されていない要件の一覧（実装済みなのにコードから参照されていないもの）。 */
export function unmappedImplemented(root: string): string[] {
  const loaded = loadRecords(root);
  if (loaded.errors.length > 0) {
    throw new Error("req_impact: 正本の読み込みに失敗しました:\n" + loaded.errors.join("\n"));
  }
  const index = buildImplIndex(root, loaded.records);
  const out: string[] = [];
  for (const r of loaded.records) {
    if (r.id === null) continue;
    if (r.kind !== "solution_requirement") continue;
    if (r.state["implementation"] !== "implemented") continue;
    if ((index.byId.get(r.id) ?? []).length === 0) out.push(r.id);
  }
  return out.sort(compareId);
}

function main(): number {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      id: { type: "string" },
      file: { type: "string" },
      unmapped: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const root = values.root ?? defaultRoot();

  if (values.unmapped === true) {
    const ids = unmappedImplemented(root);
    if (values.json === true) {
      process.stdout.write(JSON.stringify({ unmappedImplemented: ids }, null, 1) + "\n");
    } else {
      console.log(`実装済みだがコードから参照されていない要件: ${ids.length} 件`);
      for (const id of ids) console.log(`  - ${id}`);
      console.log("（対応が記録されていない状態です。実装箇所に ID を書くと変更の伝搬が追えます）");
    }
    return 0;
  }

  if (values.id !== undefined) {
    const r = impactOfRequirement(root, values.id);
    if (values.json === true) {
      process.stdout.write(JSON.stringify(r, null, 1) + "\n");
    } else {
      console.log(`${r.id} の変更が影響する実装箇所:`);
      for (const f of r.direct) console.log(`  - ${f}`);
      for (const d of r.viaDescendants) {
        console.log(`  [${d.id} 経由]`);
        for (const f of d.files) console.log(`    - ${f}`);
      }
      if (r.unmapped) console.log("  （対応する実装箇所が見つかりません。ID がコードに書かれていないか、未実装です）");
    }
    return 0;
  }

  if (values.file !== undefined) {
    const r = requirementsOfFile(root, values.file);
    if (values.json === true) {
      process.stdout.write(JSON.stringify(r, null, 1) + "\n");
    } else {
      console.log(`${r.file} が実装している要求・要件:`);
      for (const id of r.ids) console.log(`  - ${id}`);
      if (r.ids.length === 0) console.log("  （ID 参照が見つかりません。書き戻し先が不明です）");
    }
    return 0;
  }

  console.error("req_impact: --id <ID>（要求→実装）、--file <path>（実装→要求）、--unmapped のいずれかを指定してください");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
