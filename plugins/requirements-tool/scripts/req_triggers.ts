#!/usr/bin/env node
/**
 * req_triggers.ts — エリシテーション・トリガ基準レジストリの照合（SOL-15 / SR-18）と、
 * 能動起動のうるささ制御（SOL-10）の適用。
 *
 * レジストリ（`<root>/meta/triggers/*.md`。1 基準 1 ファイル）を読み、正本の現在の状態を
 * 各基準の条件に照合して「発火候補」を出す。基準の条件は自然文（`when`）で書かれており、
 * 機械的な照合は本スクリプトが基準 ID ごとに実装する——自然文を汎用に解釈する仕組みは作らない
 * （SOL-16「検査失敗時は安全側に倒す」の考え方: 解釈に失敗して誤った発火をするより、
 * 実装済みの基準だけを確実に照合する。未知の ID は「未実装の基準」として明示的に報告する）。
 *
 * うるささ制御（SOL-10）: `<root>/meta/noise-control.conf` の
 *   max_per_session（1 セッションの上限。既定 3）
 *   silence_when（沈黙条件。既定 mid_task,lint_failing,review_open）
 * を適用する。沈黙条件に該当する状況は呼び出し側が `--situation` で渡す（このスクリプトは
 * 状況を推測しない）。抑止された候補は捨てず「蓄積（deferred）」として返す——SR-18 の
 * 「今に関係しない検出は蓄積してまとめて提示」に対応する。
 *
 * 発火と施主の反応のログは `meta/trigger-log.md` へ追記できる（--log）。これが優先度の
 * 決定因子の候補仮説（SOL-11）に接続するデータになる。
 *
 * 読み取り専用（--log 指定時のみログへ追記する）。出力は決定的。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { ReqRecord, loadRecords, parseFrontmatter } from "./reqlib.ts";

function defaultRoot(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

export interface TriggerCriterion {
  id: string;
  title: string;
  when: string;
  ask: string;
  status: string;
  orderPrinciple: number | null;
}

/** レジストリ（meta/triggers/*.md）を読む。README.md は基準ではないので除く。 */
export function loadTriggers(root: string): TriggerCriterion[] {
  const dir = path.join(root, "meta", "triggers");
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".md") && n !== "README.md")
      .sort();
  } catch {
    return [];
  }
  const out: TriggerCriterion[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf-8");
    } catch {
      continue;
    }
    let fm: Record<string, unknown>;
    try {
      // parseFrontmatter は [frontmatter, body] のタプルを返す
      const [frontmatter] = parseFrontmatter(text);
      fm = frontmatter as Record<string, unknown>;
    } catch {
      continue; // 壊れた基準は無視する（レジストリの欠陥で照合全体を止めない）
    }
    const id = typeof fm["id"] === "string" ? (fm["id"] as string) : null;
    if (id === null) continue;
    const op = fm["order_principle"];
    out.push({
      id,
      title: typeof fm["title"] === "string" ? (fm["title"] as string) : "",
      when: typeof fm["when"] === "string" ? (fm["when"] as string) : "",
      ask: typeof fm["ask"] === "string" ? (fm["ask"] as string) : "",
      status: typeof fm["status"] === "string" ? (fm["status"] as string) : "active",
      orderPrinciple: typeof op === "number" ? op : null,
    });
  }
  return out;
}

export interface NoiseControl {
  maxPerSession: number;
  silenceWhen: string[];
}

/** noise-control.conf を読む（無ければ控えめ側の既定）。パース不能な行は無視する。 */
export function loadNoiseControl(root: string): NoiseControl {
  const p = path.join(root, "meta", "noise-control.conf");
  let maxPerSession = 3;
  let silenceWhen = ["mid_task", "lint_failing", "review_open"];
  let text: string;
  try {
    text = fs.readFileSync(p, "utf-8");
  } catch {
    return { maxPerSession, silenceWhen };
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "max_per_session") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n >= 0) maxPerSession = n;
    } else if (key === "silence_when") {
      silenceWhen = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    }
  }
  return { maxPerSession, silenceWhen };
}

export interface Firing {
  trigger: string;
  /** その基準に該当したレコード */
  recs: string[];
  ask: string;
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

/**
 * 基準 ID ごとの照合実装。レジストリの `when`（自然文）に対応する機械的条件をここに置く。
 * 対応する実装が無い基準は evaluate() が「未実装」として報告する（黙って無視しない）。
 */
const MATCHERS: ReadonlyMap<string, (records: ReqRecord[]) => string[]> = new Map([
  // TRG-01: 変更困難（reversibility: low）が未合意のまま、依存する下位の実装が進んでいる
  [
    "TRG-01",
    (records) => {
      const byId = new Map<string, ReqRecord>();
      for (const r of records) if (r.id !== null) byId.set(r.id, r);
      const out: string[] = [];
      for (const r of records) {
        if (r.id === null) continue;
        if (r.axes["reversibility"] !== "low") continue;
        if (r.state["approval"] !== "candidate") continue;
        const dependentsStarted = records.some(
          (d) => d.tracesTo.includes(r.id as string) && d.state["implementation"] !== "not_started",
        );
        if (dependentsStarted) out.push(r.id);
      }
      return out.sort(compareId);
    },
  ],
  // TRG-02: 境界が未合意のまま、同じ意味グループの他レコードが実装済み
  [
    "TRG-02",
    (records) => {
      const out: string[] = [];
      for (const r of records) {
        if (r.id === null) continue;
        if (r.axes["boundary"] !== true) continue;
        if (r.state["approval"] !== "candidate") continue;
        const g = r.axes["group"];
        if (typeof g !== "string" || g === "") continue;
        const siblingImplemented = records.some(
          (s) => s.id !== r.id && s.axes["group"] === g && s.state["implementation"] === "implemented",
        );
        if (siblingImplemented) out.push(r.id);
      }
      return out.sort(compareId);
    },
  ],
  // TRG-03: 合意済みの BR/SR がどの下位からも traces_to されていない
  [
    "TRG-03",
    (records) => {
      const referenced = new Set<string>();
      for (const r of records) for (const t of r.tracesTo) referenced.add(t);
      const out: string[] = [];
      for (const r of records) {
        if (r.id === null) continue;
        if (r.kind !== "business_requirement" && r.kind !== "stakeholder_requirement") continue;
        if (r.state["approval"] !== "agreed") continue;
        if (r.state["confidence"] === "undecided") continue; // 意図的な未決定は不足としない（SR-17）
        if (!referenced.has(r.id)) out.push(r.id);
      }
      return out.sort(compareId);
    },
  ],
]);

export interface EvaluateResult {
  /** 提示する発火（うるささ制御を通過したもの） */
  fired: Firing[];
  /** 抑止され蓄積された発火（捨てない。まとめて提示する機会を待つ） */
  deferred: Firing[];
  /** 沈黙条件で全体が抑止された場合の理由 */
  silencedBy: string | null;
  /** レジストリにあるが照合実装が無い基準（黙って無視しないための報告） */
  unimplemented: string[];
}

export function evaluate(
  records: ReqRecord[],
  triggers: TriggerCriterion[],
  noise: NoiseControl,
  situation: string[],
): EvaluateResult {
  const unimplemented: string[] = [];
  const all: Firing[] = [];
  for (const t of triggers) {
    if (t.status !== "active") continue; // 淘汰された基準は照合しない（記録は残す）
    const matcher = MATCHERS.get(t.id);
    if (matcher === undefined) {
      unimplemented.push(t.id);
      continue;
    }
    const recs = matcher(records);
    if (recs.length > 0) all.push({ trigger: t.id, recs, ask: t.ask.trim() });
  }
  all.sort((a, b) => (a.trigger < b.trigger ? -1 : a.trigger > b.trigger ? 1 : 0));

  const hit = noise.silenceWhen.find((s) => situation.includes(s));
  if (hit !== undefined) {
    return { fired: [], deferred: all, silencedBy: hit, unimplemented };
  }
  return {
    fired: all.slice(0, noise.maxPerSession),
    deferred: all.slice(noise.maxPerSession),
    silencedBy: null,
    unimplemented,
  };
}

function formatText(r: EvaluateResult): string {
  const lines: string[] = [];
  if (r.silencedBy !== null) {
    lines.push(`沈黙条件「${r.silencedBy}」に該当するため、この場では提示しません（蓄積します）。`);
  }
  lines.push(`提示する問い: ${r.fired.length} 件`);
  for (const f of r.fired) {
    lines.push(`  [${f.trigger}] 対象: ${f.recs.join(", ")}`);
    lines.push(`    ${f.ask}`);
  }
  lines.push(`蓄積（今は提示しない）: ${r.deferred.length} 件`);
  for (const f of r.deferred) lines.push(`  [${f.trigger}] 対象: ${f.recs.join(", ")}`);
  if (r.unimplemented.length > 0) {
    lines.push(`照合実装が無い基準: ${r.unimplemented.join(", ")}（基準は登録済みですが照合されていません）`);
  }
  return lines.join("\n");
}

/** 発火と反応のログへ追記する（SOL-11 の因子仮説データに接続する入力）。 */
export function appendTriggerLog(root: string, date: string, r: EvaluateResult, reaction: string): string {
  const p = path.join(root, "meta", "trigger-log.md");
  let existing = "";
  try {
    existing = fs.readFileSync(p, "utf-8");
  } catch {
    existing =
      "# トリガ基準の発火ログ（SOL-15 / SOL-11）\n\n" +
      "各基準の発火と施主の反応を記録する。優先度の決定因子の候補仮説（meta/priority-factors.json）の入力。\n\n";
  }
  const lines: string[] = [`## ${date}`, ""];
  for (const f of r.fired) lines.push(`- 提示 [${f.trigger}] 対象: ${f.recs.join(", ")}`);
  for (const f of r.deferred) lines.push(`- 蓄積 [${f.trigger}] 対象: ${f.recs.join(", ")}`);
  if (r.silencedBy !== null) lines.push(`- 沈黙条件: ${r.silencedBy}`);
  if (reaction !== "") lines.push(`- 施主の反応: ${reaction}`);
  lines.push("");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, existing.replace(/\n*$/, "\n\n") + lines.join("\n"), "utf-8");
  return p;
}

function main(): number {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      situation: { type: "string" },
      json: { type: "boolean" },
      log: { type: "boolean" },
      date: { type: "string" },
      reaction: { type: "string" },
    },
  });
  const root = values.root ?? defaultRoot();
  const loaded = loadRecords(root);
  if (loaded.errors.length > 0) {
    console.error("req_triggers: 正本の読み込みに失敗しました:\n" + loaded.errors.join("\n"));
    return 2;
  }
  const situation = (values.situation ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const result = evaluate(loaded.records, loadTriggers(root), loadNoiseControl(root), situation);
  if (values.json === true) {
    process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  } else {
    console.log(formatText(result));
  }
  if (values.log === true) {
    if (values.date === undefined) {
      console.error("req_triggers: --log には --date（例 2026-08-09）が必要です");
      return 2;
    }
    const p = appendTriggerLog(root, values.date, result, values.reaction ?? "");
    console.log(`発火ログを追記しました: ${p}`);
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
