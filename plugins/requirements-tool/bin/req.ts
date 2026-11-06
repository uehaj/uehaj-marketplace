#!/usr/bin/env node
/**
 * bin/req.ts — 統一CLI（SOL-33。req gen 一本化＋spec 廃止＋個別HTML削除で ADR-009 v1.4 に
 * 更新）。req <サブコマンド> [引数...] を対応する scripts/req_*.ts へ透過的に委譲する
 * ディスパッチャ。
 *
 * 命名規約: 生成系サブコマンドは gen 1つに統一した（旧 view/tree/spec/guided/document/
 * bundle は廃止）。req gen は scripts/req_bundle.ts を実行し、3ビュー（文書・ツリー・
 * 通読レビュー）を1枚に束ねたバンドル（既定 docs/generated/バンドル.html）だけを生成する。
 * 個別ビューの HTML はもう生成しない（バンドル内のペイン切替で見る）。
 *
 * 実装方針: 外部依存ゼロ（node:child_process / node:path のみ）。Node 23.6+ の
 * 型剥がしで直接実行し、ビルド工程を持たない（ADR-001 / ADR-003）。各サブコマンドの
 * 引数はそのまま対応スクリプトへ透過し、終了コードも透過する（--out の既定値も
 * scripts/req_bundle.ts 側に単一ソースのまま。bin/req.ts に既定値を持たない）。
 */
import { spawn } from "node:child_process";
import * as path from "node:path";

type SubcommandName = "gen" | "lint" | "check" | "slice" | "gaps" | "validate" | "next" | "triggers" | "guard" | "impact" | "coverage" | "init" | "import" | "serve";

interface SubcommandDef {
  script: string;
  desc: string;
}

// サブコマンド対応表。1 サブコマンド : 1 スクリプトの 1:1 対応。
const SUBCOMMANDS: Record<SubcommandName, SubcommandDef> = {
  gen: { script: "req_bundle.ts", desc: "バンドル（文書・ツリー・通読レビューを束ねた単一 HTML）の生成" },
  lint: { script: "req_lint.ts", desc: "正本の検査（構文・状態不変条件・トレーサビリティ）" },
  check: {
    script: "req_check.ts",
    desc: "正本の意味層の検査（矛盾候補・裁定に遡れない手段の提示。判定は施主）",
  },
  slice: {
    script: "req_slice.ts",
    desc: "任意の軸での断面と、その断面での過不足の算出（--axis group 等）",
  },
  validate: {
    script: "req_validate.ts",
    desc: "証跡つき妥当性確認の記録と「実装済みだが未検証」の一覧",
  },
  next: {
    script: "req_next.ts",
    desc: "次に取り組む候補と根拠の提案（優先度の因子は差し替え可能な仮説）",
  },
  triggers: {
    script: "req_triggers.ts",
    desc: "トリガ基準レジストリの照合とうるささ制御の適用（提示する問い・蓄積の算出）",
  },
  guard: {
    script: "req_guard.ts",
    desc: "危険操作のガード（正本の大量削除・スキーマ破壊・生成物の直接編集の検出）",
  },
  impact: {
    script: "req_impact.ts",
    desc: "要求と実装の双方向連動（--id で伝搬先、--file で書き戻し先、--unmapped で未対応）",
  },
  coverage: {
    script: "req_coverage.ts",
    desc: "テストの十分性（要件の被覆と行カバレッジ）の算出。--lcov で行カバレッジを併記",
  },
  gaps: { script: "req_gaps.ts", desc: "正本と実装状態のギャップの決定的算出（未実装・要レビュー・孤児）" },
  init: { script: "req_init.ts", desc: "正本の初期化（必須アウトプットカタログの投入）" },
  import: {
    script: "req_import.ts",
    desc: "外部文書の走査（--scan）と計画に基づく取り込み適用（--apply）",
  },
  serve: { script: "req_review_serve.ts", desc: "レビューサーバ（3 ビューの配信・正本への書き戻し）" },
};

// 一覧表示の見出し順。
const HELP_ORDER: SubcommandName[] = ["gen", "lint", "check", "slice", "gaps", "validate", "next", "triggers", "guard", "impact", "coverage", "init", "import", "serve"];

function scriptsDir(): string {
  return path.resolve(import.meta.dirname, "..", "scripts");
}

function printUsage(toStream: "stdout" | "stderr"): void {
  const lines: string[] = [];
  lines.push("使い方: req <サブコマンド> [引数...]");
  lines.push("");
  lines.push("サブコマンド一覧（対応するスクリプトへ引数を透過して実行する）:");
  for (const name of HELP_ORDER) {
    const def = SUBCOMMANDS[name];
    lines.push(`  req ${name.padEnd(12)} ${def.desc}`);
  }
  lines.push("");
  lines.push("例: req lint --root docs/requirements");
  lines.push("    req gen --root docs/requirements --out docs/generated/バンドル.html");
  const text = lines.join("\n") + "\n";
  if (toStream === "stdout") {
    process.stdout.write(text);
  } else {
    process.stderr.write(text);
  }
}

function isKnownSubcommand(name: string): name is SubcommandName {
  return Object.prototype.hasOwnProperty.call(SUBCOMMANDS, name);
}

function main(): void {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printUsage("stdout");
    process.exitCode = 0;
    return;
  }

  if (!isKnownSubcommand(subcommand)) {
    process.stderr.write(`req: 未知のサブコマンドです: ${subcommand}\n\n`);
    printUsage("stderr");
    process.exitCode = 1;
    return;
  }

  const scriptPath = path.join(scriptsDir(), SUBCOMMANDS[subcommand].script);
  const child = spawn(process.execPath, [scriptPath, ...rest], { stdio: "inherit" });

  child.on("error", (err) => {
    process.stderr.write(`req: ${subcommand} の起動に失敗しました: ${err.message}\n`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.stderr.write(`req: ${subcommand} がシグナル ${signal} で終了しました\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}

main();
