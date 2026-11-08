#!/usr/bin/env node
/**
 * req_init.ts — 必須アウトプットカタログの初期投入（SR-25）。
 *
 * templates/mandatory-outputs/（ツール本体側のカタログ）から、対象プロジェクトの
 * docs/requirements/（プロジェクト側の正本）へ、未決の必須アウトプット（MO）レコードを
 * 投入する。冪等: 既に同じ ID が正本に存在する項目はスキップして報告する。
 *
 * ツール本体とプロジェクト正本の分離（SR-26）: カタログはアップデートで更新される
 * 本体資産、投入済み MO レコードはアップデートで上書きされないプロジェクト資産。
 * 本スクリプトはその一方向の橋渡しのみを行う（正本側の既存レコードには触らない）。
 *
 * 投入時の state（未決の表現）: approval=candidate / disposition=active /
 * implementation=not_applicable / validation=not_applicable / confidence=undecided。
 *
 * 非該当の扱い（施主裁定 2026-07-05）: プロジェクトに該当しない MO は削除せず、
 * approval=rejected の要件として保持する（INV-1 により disposition は active 以外へ）。
 *
 * 終了コード: 成功=0（全件スキップでも成功）、エラー=2。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { loadRecords, parseFrontmatter, FrontmatterError } from "./reqlib.ts";

function defaultCatalog(): string {
  return path.resolve(import.meta.dirname, "..", "templates", "mandatory-outputs");
}

function defaultRoot(): string {
  // 既定の対象は呼び出し元プロジェクト（プラグイン自身の正本を黙って対象にしない。
  // セルフホスティング時はカレント＝リポジトリ自身なので従来どおり動く）
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

const HELP = `req_init.ts — 必須アウトプットカタログの初期投入（SR-25）

使い方: node scripts/req_init.ts [--catalog <dir>] [--root <dir>]

  --catalog  カタログディレクトリ（既定: templates/mandatory-outputs）
  --root     投入先の正本ディレクトリ（既定: docs/requirements）
  --help     このヘルプを表示

冪等: 既に同じ ID が正本に存在する項目は投入せずスキップして報告する。
非該当の扱い: プロジェクトに該当しない MO は削除せず approval=rejected の要件として
保持する（INV-1 により disposition は active 以外へ。施主裁定 2026-07-05）。`;

function main(): number {
  const { values } = parseArgs({
    options: {
      catalog: { type: "string" },
      root: { type: "string" },
      help: { type: "boolean" },
    },
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const catalog = values.catalog ?? defaultCatalog();
  const root = values.root ?? defaultRoot();

  if (!fs.existsSync(catalog) || !fs.statSync(catalog).isDirectory()) {
    console.error(`req_init: カタログディレクトリが存在しません: ${catalog}`);
    return 2;
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`req_init: 投入先の正本ディレクトリが存在しません: ${root}`);
    return 2;
  }

  // 投入先の既存 ID を収集（解析エラーがあれば安全側に倒して中止。SOL-16）
  const existing = loadRecords(root);
  if (existing.errors.length > 0) {
    console.error("req_init: 投入先の正本に解析エラーがあるため中止します（安全側）:");
    for (const e of existing.errors) console.error(`  - ${e}`);
    return 2;
  }
  const existingIds = new Set(existing.records.map((r) => r.id).filter((x) => x !== null));

  // カタログの読み込み（README.md 等の非レコードは除外）
  const names = fs
    .readdirSync(catalog)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();

  let injected = 0;
  let skipped = 0;
  const problems: string[] = [];

  for (const name of names) {
    const srcPath = path.join(catalog, name);
    const text = fs.readFileSync(srcPath, "utf-8");
    let id: string | null = null;
    try {
      const [fm] = parseFrontmatter(text);
      id = typeof fm["id"] === "string" ? (fm["id"] as string) : null;
    } catch (e) {
      if (e instanceof FrontmatterError) {
        problems.push(`${name}: カタログ項目の frontmatter 解析エラー: ${e.message}`);
        continue;
      }
      throw e;
    }
    if (!id) {
      problems.push(`${name}: カタログ項目に id がありません`);
      continue;
    }

    const destPath = path.join(root, name);
    if (existingIds.has(id)) {
      console.log(`req_init: スキップ ${id}（既に正本に存在: ${name}）`);
      skipped += 1;
      continue;
    }
    if (fs.existsSync(destPath)) {
      problems.push(
        `${name}: 投入先に同名ファイルが存在しますが ID ${id} は未登録です（不整合のため投入しません）`,
      );
      continue;
    }
    fs.writeFileSync(destPath, text, "utf-8");
    console.log(`req_init: 投入 ${id} → ${destPath}`);
    injected += 1;
  }

  if (problems.length > 0) {
    console.error(`req_init: ${problems.length} 件の問題があります:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.log(`req_init: 投入 ${injected} 件、スキップ ${skipped} 件（既存 ID）`);
    return 2;
  }

  console.log(`req_init: 投入 ${injected} 件、スキップ ${skipped} 件（既存 ID）`);
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
