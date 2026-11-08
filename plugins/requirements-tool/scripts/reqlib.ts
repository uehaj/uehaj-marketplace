/**
 * reqlib — docs/requirements/ 正本の共有ライブラリ（Python 版 reqlib.py の同値移植）。
 *
 * req_lint.ts と req_document.ts の両方から使う（renderMarkdown は旧 req_spec.ts から
 * 移動。req gen 一本化＋spec 廃止）。外部依存ゼロの方針のため、
 * YAML フロントマターは Node 標準機能のみで書いた限定パーサで読む
 * （実装計画書 §3.2 のスキーマで実際に使う構文のサブセットのみをサポートする）。
 *
 * サポートする構文:
 *   - `key: value`                  スカラー（文字列 / null / true / false / 整数）
 *   - `key: [a, b, c]` / `key: []`  フローリスト（要素はスカラー）
 *   - `key: |` に続く字下げブロック   複数行リテラル文字列（改行を保持）
 *   - `key:` の次行がさらに深い字下げ  ネストしたマッピング
 *   - `key:`（次行がなし/同深度以下） null
 *   - 行頭 `#` の行、空行                コメント・無視
 *
 * このサブセット以外（アンカー・タグ・複数行フローなど）は本プロジェクトの
 * 正本では使わない前提。
 *
 * Node 23.6+ の型剥がし（type stripping）による直接実行を前提とするため、
 * 型消去できない構文（enum / namespace / parameter properties 等）は使わない。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

export type YamlMap = { [key: string]: YamlValue };

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterError";
  }
}

/** Python の repr() 風の値表示（エラーメッセージの同値性のため）。 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") {
    return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(pyRepr).join(", ") + "]";
  }
  return String(value);
}

function indentOf(line: string): number {
  return line.length - line.replace(/^ */, "").length;
}

function isBlankOrComment(line: string): boolean {
  const s = line.trim();
  return s === "" || s.startsWith("#");
}

function parseScalar(text: string): YamlValue {
  const t = text.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (t.length >= 2 && t[0] === t[t.length - 1] && (t[0] === "'" || t[0] === '"')) {
    return t.slice(1, -1);
  }
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((part) => parseScalar(part));
  }
  return t; // 素の文字列
}

function splitKeyValue(line: string): [string, string] {
  const idx = line.indexOf(":");
  if (idx === -1) {
    throw new FrontmatterError(`コロンのない行です: ${pyRepr(line)}`);
  }
  return [line.slice(0, idx).trim(), line.slice(idx + 1)];
}

function parseBlock(lines: string[], idx: number, baseIndent: number): [YamlMap, number] {
  const result: YamlMap = {};
  const n = lines.length;
  while (idx < n) {
    const raw = lines[idx];
    if (isBlankOrComment(raw)) {
      idx += 1;
      continue;
    }
    const ind = indentOf(raw);
    if (ind < baseIndent) break;
    if (ind > baseIndent) {
      throw new FrontmatterError(`想定外の字下げです: ${pyRepr(raw)}`);
    }
    const [key, rest] = splitKeyValue(raw.trim());
    const restStripped = rest.trim();
    idx += 1;
    if (restStripped === "|") {
      const contentLines: string[] = [];
      let blockIndent: number | null = null;
      while (idx < n) {
        const l2 = lines[idx];
        if (l2.trim() === "") {
          contentLines.push("");
          idx += 1;
          continue;
        }
        const ind2 = indentOf(l2);
        if (ind2 <= baseIndent) break;
        if (blockIndent === null) blockIndent = ind2;
        contentLines.push(l2.length >= blockIndent ? l2.slice(blockIndent) : l2.replace(/^ +/, ""));
        idx += 1;
      }
      while (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") {
        contentLines.pop();
      }
      result[key] = contentLines.join("\n");
    } else if (restStripped === "") {
      let peek = idx;
      while (peek < n && isBlankOrComment(lines[peek])) peek += 1;
      if (peek < n && indentOf(lines[peek]) > baseIndent) {
        const [nested, nextIdx] = parseBlock(lines, peek, indentOf(lines[peek]));
        result[key] = nested;
        idx = nextIdx;
      } else {
        result[key] = null;
      }
    } else {
      result[key] = parseScalar(restStripped);
    }
  }
  return [result, idx];
}

/**
 * 先頭の `---` 〜 `---` を YAML ライクなフロントマターとしてパースし、
 * [frontmatterMap, bodyText] を返す。
 */
export function parseFrontmatter(text: string): [YamlMap, string] {
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") {
    throw new FrontmatterError("frontmatter の開始 '---' がありません");
  }
  let endIdx: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === null) {
    throw new FrontmatterError("frontmatter の終端 '---' がありません");
  }
  const fmLines = lines.slice(1, endIdx);
  let body = lines.slice(endIdx + 1).join("\n");
  if (body.startsWith("\n")) body = body.slice(1);
  const [data] = parseBlock(fmLines, 0, 0);
  return [data, body];
}

/** 本文を `## 見出し` 単位のセクションに分解する（`# タイトル` 行は無視）。 */
export function parseBodySections(body: string): { [heading: string]: string } {
  const sections: { [heading: string]: string } = {};
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      if (current !== null) {
        sections[current] = buf.join("\n").replace(/^\n+|\n+$/g, "");
      }
      current = line.slice(3).trim();
      buf = [];
    } else if (line.startsWith("# ") && current === null) {
      continue;
    } else {
      buf.push(line);
    }
  }
  if (current !== null) {
    sections[current] = buf.join("\n").replace(/^\n+|\n+$/g, "");
  }
  return sections;
}

// ---------------------------------------------------------------------------
// スキーマ定義（実装計画書 §3.2）
// ---------------------------------------------------------------------------

export const KIND_VALUES: ReadonlySet<string> = new Set([
  "business_requirement",
  "stakeholder_requirement",
  "solution_requirement",
  "mandatory_output", // 必須アウトプット（SR-25。定型要件カタログから投入される未決レコード）
  "document_section", // 文書節（SR-27。主たる木＝仕様書の章節構造のノード）
  "use_case", // ユースケース（SOL-44。ID プレフィックス U。traces_to は SR を指す）
]);

export const STATE_ENUMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["approval", new Set(["candidate", "agreed", "rejected", "superseded"])],
  ["disposition", new Set(["active", "held", "deferred", "obsolete"])],
  ["implementation", new Set(["not_started", "in_progress", "implemented", "not_applicable"])],
  ["validation", new Set(["unvalidated", "passed", "failed", "inconclusive", "not_applicable"])],
  ["confidence", new Set(["unexamined", "undecided", "provisional", "confirmed"])],
]);

// 子kind -> 親kind（上向き traces_to が指すべき先）。business_requirement は最上位で親を持たない。
// mandatory_output も親を要求しない（traces_to 空を許容＝親なし検査の対象外。SR-25 の設計判断。
// traces_to を書いた場合は参照先の実在のみ検査され、参照先の kind は制約されない）。
// document_section は traces_to の親子kind検査・親なし検査の対象外（主たる木の
// parent/also_belongs_to で位置づけられるため。SR-27）。
export const KIND_PARENT: ReadonlyMap<string, string | null> = new Map([
  ["business_requirement", null],
  ["stakeholder_requirement", "business_requirement"],
  ["solution_requirement", "stakeholder_requirement"],
  ["mandatory_output", null],
  ["document_section", null],
  ["use_case", "stakeholder_requirement"],
]);

export const ID_PREFIX_FOR_KIND: ReadonlyMap<string, string> = new Map([
  ["business_requirement", "BR"],
  ["stakeholder_requirement", "SR"],
  ["solution_requirement", "SOL"],
  ["mandatory_output", "MO"],
  ["document_section", "SEC"],
  ["use_case", "U"],
]);

// axes.phase の許容範囲（実装計画書 §5 のフェーズ構成）と工程横断の専用値
// （施主裁定 2026-07-05 フェーズ0検収: cross-cutting は「すべてのフェーズに一致する」）。
export const PHASE_MIN = 0;
export const PHASE_MAX = 4;
export const PHASE_CROSS_CUTTING = "cross-cutting";

/**
 * axes.phase の値を検査する。妥当なら null、不正ならエラーメッセージを返す。
 *
 * 許容: 0..4 の整数リスト（空可）、または文字列 'cross-cutting'。
 * リスト内への文字列混在・範囲外整数・他の文字列は不正。
 */
export function validatePhase(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null; // phase 軸なし（axes は開いたキー空間のため必須にはしない）
  }
  if (value === PHASE_CROSS_CUTTING) return null;
  if (typeof value === "string") {
    return (
      `axes.phase の値が不正です（${pyRepr(value)}）。` +
      `許容: ${PHASE_MIN}..${PHASE_MAX} の整数リスト（空可）または '${PHASE_CROSS_CUTTING}'`
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (
        typeof item !== "number" ||
        !Number.isInteger(item) ||
        item < PHASE_MIN ||
        item > PHASE_MAX
      ) {
        return (
          `axes.phase のリスト要素が不正です（${pyRepr(item)}）。` +
          `要素は ${PHASE_MIN}..${PHASE_MAX} の整数のみ（'${PHASE_CROSS_CUTTING}' はリスト内混在不可）`
        );
      }
    }
    return null;
  }
  return (
    `axes.phase の型が不正です（${pyRepr(value)}）。` +
    `許容: ${PHASE_MIN}..${PHASE_MAX} の整数リスト（空可）または '${PHASE_CROSS_CUTTING}'`
  );
}

// 実装計画書 §3.2 に明示された「軸間不変条件」の確定分のみ。
// それ以外の不変条件はソリューション要件定義で確定する予定（本スクリプトでは追加しない）。
export const CONFIRMED_INVARIANTS: ReadonlyArray<
  [string, (st: YamlMap) => boolean, string]
> = [
  [
    "INV-1",
    (st) => !(st["approval"] === "rejected" && st["disposition"] === "active"),
    "approval=rejected の項目が disposition=active になっている（却下済みを『今扱う』は矛盾）",
  ],
  [
    "INV-2",
    (st) => !(st["approval"] === "candidate" && st["implementation"] === "implemented"),
    "approval=candidate の項目が implementation=implemented になっている（未合意のまま実装済みは矛盾）",
  ],
  [
    "INV-3",
    (st) => !(st["disposition"] === "obsolete" && st["validation"] === "passed"),
    "disposition=obsolete の項目が validation=passed になっている（陳腐化した要求が検証合格は矛盾）",
  ],
];

export class ReqRecord {
  path: string;
  frontmatter: YamlMap;
  body: string;

  constructor(filePath: string, frontmatter: YamlMap, body: string) {
    this.path = filePath;
    this.frontmatter = frontmatter;
    this.body = body;
  }

  get id(): string | null {
    const v = this.frontmatter["id"];
    return typeof v === "string" ? v : null;
  }

  get kind(): string | null {
    const v = this.frontmatter["kind"];
    return typeof v === "string" ? v : null;
  }

  get title(): string | null {
    const v = this.frontmatter["title"];
    return typeof v === "string" ? v : null;
  }

  get state(): YamlMap {
    const v = this.frontmatter["state"];
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as YamlMap) : {};
  }

  get tracesTo(): string[] {
    const v = this.frontmatter["traces_to"];
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  }

  /** 主たる木（consist-of）の親 ID。frontmatter の `parent` キー（スカラー）。SR-27。 */
  get parentId(): string | null {
    const v = this.frontmatter["parent"];
    return typeof v === "string" ? v : null;
  }

  /** 従たる also-belongs-to 弧の参照先 ID 群。frontmatter の `also_belongs_to` キー（フローリスト）。SR-27。 */
  get alsoBelongsTo(): string[] {
    const v = this.frontmatter["also_belongs_to"];
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  }

  get axes(): YamlMap {
    const v = this.frontmatter["axes"];
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as YamlMap) : {};
  }

  get confidence(): string | null {
    const v = this.state["confidence"];
    return typeof v === "string" ? v : null;
  }

  /**
   * verification フィールドの生文字列。frontmatter["verification"]。
   * 文字列でなければ（null・未設定・型不一致）null。
   * 3記法（auto: / rollup: / manual:）の判定は呼び出し側が行う。
   */
  get verification(): string | null {
    const v = this.frontmatter["verification"];
    return typeof v === "string" ? v : null;
  }

  idNumber(): number {
    const m = /(\d+)$/.exec(this.id ?? "");
    return m ? parseInt(m[1], 10) : 0;
  }

  /**
   * 文書節（document_section）の並び順。frontmatter の `order` キー（整数）。
   * 主に SEC（章）のルート表示順に使う。未設定なら null（呼び出し側で idNumber に
   * フォールバックする）。
   */
  get order(): number | null {
    const v = this.frontmatter["order"];
    return typeof v === "number" ? v : null;
  }
}

export interface LoadResult {
  records: ReqRecord[];
  errors: string[];
}

export function loadRecords(root: string): LoadResult {
  const result: LoadResult = { records: [], errors: [] };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    result.errors.push(`正本ディレクトリが存在しません: ${root}`);
    return result;
  }
  if (!stat.isDirectory()) {
    result.errors.push(`正本ディレクトリが存在しません: ${root}`);
    return result;
  }
  const names = fs
    .readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .sort();
  for (const name of names) {
    const filePath = path.join(root, name);
    if (!fs.statSync(filePath).isFile()) continue;
    const text = fs.readFileSync(filePath, "utf-8");
    try {
      const [fm, body] = parseFrontmatter(text);
      result.records.push(new ReqRecord(filePath, fm, body));
    } catch (e) {
      if (e instanceof FrontmatterError) {
        result.errors.push(`${name}: frontmatter 解析エラー: ${e.message}`);
        continue;
      }
      throw e;
    }
  }
  result.records.sort((a, b) => {
    const ka = a.kind ?? "";
    const kb = b.kind ?? "";
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.idNumber() - b.idNumber();
  });
  return result;
}

/** ファイル名（例 SR-08.md）から正準表記（例 SR-8）を導出する。 */
export function canonicalIdFromFilename(filePath: string): string | null {
  const stem = path.basename(filePath).replace(/\.[^.]*$/, "");
  const m = /^([A-Za-z]+)-0*(\d+)$/.exec(stem);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

// ---------------------------------------------------------------------------
// ビュー上レビューの正本への書き戻し（SR-33 / ADR-007 / SOL-26）。
//
// req_review_serve.ts（一時ローカル HTTP サーバ）が受け取ったレビュー結果を、
// docs/requirements/ 正本へ確定的に反映する共有ロジック。config-edit-safety の方針
// （複雑な構造を持つファイルの全体再シリアライズを避ける）に従い、frontmatter は
// 「最小限の行単位置換」（正規表現で該当行だけ書き換え）で編集し、YAML 全体を
// parseFrontmatter → 再シリアライズすることはしない。書き込みは一時ファイル→
// リネームで行い、置換前に再パースできることを検証する。
//
// 判定（verdict）ごとの効果（SOL-26 / 施主裁定 ADR-007、SR-59 / SOL-50 で単一状態モデルに
// 拡張）:
//   - approve（承認＝確認。SOL-50 の通読レビューでは「確認」チェックボックスの
//     チェック操作がこの verdict を送る）: axes.review_required が true なら false に、
//     state.confidence が provisional なら confirmed に、state.approval が agreed でなければ
//     agreed に上げる（それ以外の state 軸は変えない）。SR-59 の施主裁定
//     （確認と承認を1つの状態にする）により、v0.120 まで review_required/confidence の
//     昇格のみで approval を candidate のまま残していた挙動を是正した——確認（チェック）＝
//     承認（agreed）であり、中間状態を残さない。
//   - unconfirm（確認の取り消し。SOL-50。チェックボックスの解除操作がこの verdict を送る）:
//     approve の逆操作。state.approval が candidate でなければ candidate に、
//     axes.review_required が true でなければ true に戻す（state.confidence は変えない
//     ——一度確認済みの水準まで検討したという事実は取り消さない）。コメントは不要（reject と
//     異なり必須にしない）。取り消しの事実は他の判定と同じく
//     meta/reviews/<ID>.md に記名・時刻つきで追記される（黙って消さない。SOL-16 の
//     記名・記録の思想と整合）。
//   - reject（却下）: review_required は残す（差戻し）。コメントが必須（コメント無しは
//     エラーとして扱い、他の action の処理は継続する）。変更要望もこの判定で表現する
//     （施主裁定 2026-08-05: 「変更する」を第4の verdict として増やさず、却下＋コメントに
//     寄せる。却下は要求そのものの否定ではなく差戻しであり、変更要望はこの意味に収まる。
//     verdict の語彙を増やさないため、正本の frontmatter・POST /review の JSON・下書きの
//     localStorage 形式はいずれも不変）。ビュー側はこの使い方を判定欄に注記する
//     （req_tree.ts renderVerdictFieldset。tree・guided 共用）。
//   - hold（保留）: state.disposition を held にし、hold.reason を記録する
//     （既存の hold: ブロックがあれば reason だけ更新、無ければ新規挿入）。
// comment はどの判定でも docs/requirements/meta/reviews/<ID>.md に追記する（1レコード
// 1ファイル、無ければ作成）。questions は docs/requirements/meta/open-questions.md に
// OQ として追記する（次の問い直し・補完ループの入力になる。SR-1/SR-4/SR-11）。
// ---------------------------------------------------------------------------

export type ReviewVerdict = "approve" | "reject" | "hold" | "unconfirm";

export interface ReviewAction {
  id: string;
  verdict: ReviewVerdict;
  reviewer: string;
  comment?: string | null;
  questions?: string | null;
}

export interface ReviewActionResult {
  id: string;
  ok: boolean;
  verdict?: ReviewVerdict;
  error?: string;
  changes: string[];
}

export interface ApplyReviewActionsSummary {
  dryRun: boolean;
  results: ReviewActionResult[];
}

/** 一時ファイル→リネームで書き込む（config-edit-safety: 直接 'w' 上書きしない）。 */
export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

interface FrontmatterSplit {
  headIdx: number; // 開始 '---' の行番号（常に0）
  endIdx: number; // 終端 '---' の行番号
  lines: string[]; // ファイル全体の行配列
  fmLines: string[]; // frontmatter 部分だけの行配列（headIdx+1..endIdx-1）
}

function splitFrontmatterLines(text: string): FrontmatterSplit | null {
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") return null;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;
  return { headIdx: 0, endIdx, lines, fmLines: lines.slice(1, endIdx) };
}

/**
 * frontmatter 行配列内で、トップレベルキー（インデント0）`key:` の行範囲
 * [start, end) を求める。end はその次のトップレベルキー行（無ければ配列末尾）。
 * 空行・コメント行は範囲判定でスキップする（ブロック内容と誤認しない）。
 */
function topLevelBlockRange(fmLines: string[], key: string): { start: number; end: number } | null {
  const startRe = new RegExp(`^${key}:`);
  let start = -1;
  for (let i = 0; i < fmLines.length; i++) {
    if (startRe.test(fmLines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = fmLines.length;
  for (let i = start + 1; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (isBlankOrComment(line)) continue;
    if (indentOf(line) === 0) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** [start,end) の範囲内で `key: value` のネストしたスカラー行を探し値を返す（無ければ null）。 */
function getScalarInRange(fmLines: string[], range: { start: number; end: number }, key: string): string | null {
  const re = new RegExp(`^\\s*${key}:\\s*(.*)$`);
  for (let i = range.start + 1; i < range.end; i++) {
    const m = re.exec(fmLines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

/** [start,end) の範囲内の `key: value` 行を新しい値に置換する（インデントは保持）。見つからなければ false。 */
function setScalarInRange(
  fmLines: string[],
  range: { start: number; end: number },
  key: string,
  newValue: string,
): boolean {
  const re = new RegExp(`^(\\s*)${key}:\\s*(.*)$`);
  for (let i = range.start + 1; i < range.end; i++) {
    const m = re.exec(fmLines[i]);
    if (m) {
      fmLines[i] = `${m[1]}${key}: ${newValue}`;
      return true;
    }
  }
  return false;
}

/** `key: |` 形式のリテラルブロック行群を組み立てる（reqlib.parseBlock が読める形式）。 */
function buildLiteralBlockLines(key: string, indent: number, content: string): string[] {
  const pad = " ".repeat(indent);
  const contentPad = " ".repeat(indent + 2);
  const contentLines = content.split("\n");
  return [`${pad}${key}: |`, ...contentLines.map((l) => `${contentPad}${l}`)];
}

/**
 * トップレベル `hold:` ブロックの `reason` を設定する（既存の reason（スカラー/リテラル
 * ブロックいずれも）があれば置換、`hold:` ブロック自体が無ければ `state:` ブロックの直後
 * （無ければ frontmatter 末尾）に新規挿入する）。文字列改行を保持できるよう常にリテラル
 * ブロック（`reason: |`）形式で書く（コロン・引用符を含むコメント本文でも安全）。
 */
function setOrInsertHoldReason(fmLines: string[], reasonText: string): string[] {
  const result = fmLines.slice();
  const reasonBlockLines = buildLiteralBlockLines("reason", 2, reasonText);
  const holdRange = topLevelBlockRange(result, "hold");

  if (holdRange) {
    let reasonLineIdx = -1;
    for (let i = holdRange.start + 1; i < holdRange.end; i++) {
      if (/^\s*reason:/.test(result[i])) {
        reasonLineIdx = i;
        break;
      }
    }
    if (reasonLineIdx !== -1) {
      const reasonIndent = indentOf(result[reasonLineIdx]);
      const isLiteral = /:\s*\|\s*$/.test(result[reasonLineIdx]);
      let removeEnd = reasonLineIdx + 1;
      if (isLiteral) {
        while (removeEnd < holdRange.end) {
          const l = result[removeEnd];
          if (isBlankOrComment(l)) {
            removeEnd += 1;
            continue;
          }
          if (indentOf(l) <= reasonIndent) break;
          removeEnd += 1;
        }
      }
      result.splice(reasonLineIdx, removeEnd - reasonLineIdx, ...reasonBlockLines);
    } else {
      result.splice(holdRange.start + 1, 0, ...reasonBlockLines);
    }
  } else {
    const stateRange = topLevelBlockRange(result, "state");
    const insertAt = stateRange ? stateRange.end : result.length;
    result.splice(insertAt, 0, "hold:", ...reasonBlockLines);
  }
  return result;
}

function reviewLogPath(root: string, id: string): string {
  return path.join(root, "meta", "reviews", `${id}.md`);
}

function openQuestionsPath(root: string): string {
  return path.join(root, "meta", "open-questions.md");
}

const VERDICT_LABEL: Readonly<Record<ReviewVerdict, string>> = {
  approve: "承認",
  reject: "却下",
  hold: "保留",
  unconfirm: "確認の取り消し",
};

/** meta/reviews/<ID>.md に判定・コメントを追記する（1レコード1ファイル。無ければ作成）。 */
function appendReviewLog(
  root: string,
  id: string,
  entry: { reviewer: string; verdict: ReviewVerdict; comment?: string | null; at: Date },
): void {
  const filePath = reviewLogPath(root, id);
  const dateStr = entry.at.toISOString();
  const commentText = entry.comment && entry.comment.trim() !== "" ? entry.comment.trim() : "（コメントなし）";
  const block = `## ${dateStr} ${entry.reviewer} — ${VERDICT_LABEL[entry.verdict]}\n\n${commentText}\n\n`;
  let existing: string;
  try {
    existing = fs.readFileSync(filePath, "utf-8");
  } catch {
    existing = `# ${id} レビュー記録\n\n`;
  }
  writeFileAtomic(filePath, existing + block);
}

/** 既存 open-questions.md の `## OQ-<n>` から次番号を決める（無ければ1）。 */
function nextOqNumber(text: string): number {
  const nums = [...text.matchAll(/## OQ-(\d+)/g)].map((m) => parseInt(m[1], 10));
  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

/** docs/requirements/meta/open-questions.md に新規 OQ を追記する（AI が後で拾う。SR-1/SR-4/SR-11）。 */
function appendOpenQuestion(
  root: string,
  id: string,
  question: { reviewer: string; text: string; at: Date },
): void {
  const filePath = openQuestionsPath(root);
  let existing: string;
  try {
    existing = fs.readFileSync(filePath, "utf-8");
  } catch {
    existing = "確認事項の記録 Open Questions\n";
  }
  const n = nextOqNumber(existing);
  const dateStr = question.at.toISOString().slice(0, 10);
  const block =
    `\n## OQ-${n}\n` +
    `問い: ${question.text.trim()}（対象: ${id}、起票: ${question.reviewer}, ${dateStr}）\n` +
    `回答: （未回答）\n` +
    `状態: 未解消\n`;
  writeFileAtomic(filePath, existing + block);
}

/**
 * ビュー上レビュー結果を正本へ適用する（SOL-26）。dryRun=true のときは frontmatter・
 * meta の書き込みを一切行わず、適用したであろう差分の要約（changes）だけを返す
 * （施主が確認できる dry-run 差分提示→適用の様式。SOL-17 と同じ流儀）。
 *
 * action ごとに独立して処理し、1件のエラー（未知の id・verdict 不正・reject の
 * コメント欠落等）が他の action の処理を止めない。
 */
export function applyReviewActions(
  root: string,
  actions: ReviewAction[],
  opts?: { dryRun?: boolean },
): ApplyReviewActionsSummary {
  const dryRun = opts?.dryRun ?? false;
  const { records } = loadRecords(root);
  const byId = new Map<string, ReqRecord>();
  for (const r of records) {
    if (r.id !== null && !byId.has(r.id)) byId.set(r.id, r);
  }

  const now = new Date();
  const results: ReviewActionResult[] = [];

  for (const action of actions) {
    const changes: string[] = [];
    const idForReport = typeof action?.id === "string" ? action.id : String(action?.id ?? "");
    try {
      if (typeof action.id !== "string" || action.id.trim() === "") {
        results.push({ id: idForReport, ok: false, error: "id が指定されていません。", changes });
        continue;
      }
      if (
        action.verdict !== "approve" &&
        action.verdict !== "reject" &&
        action.verdict !== "hold" &&
        action.verdict !== "unconfirm"
      ) {
        results.push({
          id: action.id,
          ok: false,
          error: `verdict の値が不正です（許容: approve/reject/hold/unconfirm）: ${String(action.verdict)}`,
          changes,
        });
        continue;
      }
      if (typeof action.reviewer !== "string" || action.reviewer.trim() === "") {
        results.push({ id: action.id, ok: false, verdict: action.verdict, error: "reviewer（記名）が必須です。", changes });
        continue;
      }
      if (action.verdict === "reject" && (!action.comment || action.comment.trim() === "")) {
        results.push({
          id: action.id,
          ok: false,
          verdict: action.verdict,
          error: "却下（reject）にはコメントが必須です（差戻しの理由を記録する）。",
          changes,
        });
        continue;
      }

      const rec = byId.get(action.id);
      if (!rec) {
        results.push({ id: action.id, ok: false, verdict: action.verdict, error: `正本に ${action.id} が見つかりません。`, changes });
        continue;
      }

      const originalText = fs.readFileSync(rec.path, "utf-8");
      const split = splitFrontmatterLines(originalText);
      if (!split) {
        results.push({
          id: action.id,
          ok: false,
          verdict: action.verdict,
          error: `${path.basename(rec.path)}: frontmatter の解析に失敗しました。`,
          changes,
        });
        continue;
      }
      let fmLines = split.fmLines.slice();

      if (action.verdict === "approve") {
        const axesRange = topLevelBlockRange(fmLines, "axes");
        if (axesRange && getScalarInRange(fmLines, axesRange, "review_required") === "true") {
          setScalarInRange(fmLines, axesRange, "review_required", "false");
          changes.push("axes.review_required: true -> false");
        }
        const stateRange = topLevelBlockRange(fmLines, "state");
        if (stateRange) {
          if (getScalarInRange(fmLines, stateRange, "confidence") === "provisional") {
            setScalarInRange(fmLines, stateRange, "confidence", "confirmed");
            changes.push("state.confidence: provisional -> confirmed");
          }
          // SR-59 / SOL-50: 確認（チェック）＝承認。approval が agreed でなければ agreed に
          // 上げる（中間状態を残さない。v0.120 の是正）。
          const currentApproval = getScalarInRange(fmLines, stateRange, "approval");
          if (currentApproval !== "agreed") {
            if (setScalarInRange(fmLines, stateRange, "approval", "agreed")) {
              changes.push(`state.approval: ${currentApproval ?? "?"} -> agreed`);
            }
          }
        }
        if (changes.length === 0) {
          changes.push("frontmatter への変更なし（review_required は既に false、confidence は provisional でない、approval は既に agreed）");
        }
      } else if (action.verdict === "unconfirm") {
        // SOL-50 (a): 確認チェックの解除。approve の逆操作（confidence は変えない）。
        const axesRange = topLevelBlockRange(fmLines, "axes");
        if (axesRange && getScalarInRange(fmLines, axesRange, "review_required") !== "true") {
          setScalarInRange(fmLines, axesRange, "review_required", "true");
          changes.push("axes.review_required: false -> true");
        }
        const stateRange = topLevelBlockRange(fmLines, "state");
        if (stateRange) {
          const currentApproval = getScalarInRange(fmLines, stateRange, "approval");
          if (currentApproval !== "candidate") {
            if (setScalarInRange(fmLines, stateRange, "approval", "candidate")) {
              changes.push(`state.approval: ${currentApproval ?? "?"} -> candidate`);
            }
          }
        }
        if (changes.length === 0) {
          changes.push("frontmatter への変更なし（review_required は既に true、approval は既に candidate）");
        }
      } else if (action.verdict === "reject") {
        changes.push("axes.review_required: 変更なし（却下のため差戻し。レビュー必須を維持）");
      } else {
        // hold
        const stateRange = topLevelBlockRange(fmLines, "state");
        if (!stateRange) {
          throw new Error(`${path.basename(rec.path)}: state ブロックが見つかりません（hold を適用できません）。`);
        }
        const currentDisposition = getScalarInRange(fmLines, stateRange, "disposition");
        if (currentDisposition !== "held") {
          setScalarInRange(fmLines, stateRange, "disposition", "held");
          changes.push(`state.disposition: ${currentDisposition ?? "?"} -> held`);
        } else {
          changes.push("state.disposition: 既に held");
        }
        const dateOnly = now.toISOString().slice(0, 10);
        const reasonText =
          action.comment && action.comment.trim() !== ""
            ? `${action.reviewer}のレビュー（保留、${dateOnly}）: ${action.comment.trim()}`
            : `${action.reviewer}のレビュー（保留、${dateOnly}）。コメントなし。`;
        fmLines = setOrInsertHoldReason(fmLines, reasonText);
        changes.push("hold.reason を記録");
      }

      const newLines = [...split.lines.slice(0, split.headIdx + 1), ...fmLines, ...split.lines.slice(split.endIdx)];
      const newText = newLines.join("\n");

      // 書き込み前の検証: 再パースできること・id/kind が変化していないこと。
      const [reparsed] = parseFrontmatter(newText);
      if (reparsed["id"] !== rec.frontmatter["id"] || reparsed["kind"] !== rec.frontmatter["kind"]) {
        throw new Error("編集後の frontmatter で id/kind が変化しました（安全のため書き込みを中止しました）。");
      }

      const hasQuestion = typeof action.questions === "string" && action.questions.trim() !== "";

      if (!dryRun) {
        if (newText !== originalText) {
          writeFileAtomic(rec.path, newText);
        }
        appendReviewLog(root, action.id, {
          reviewer: action.reviewer,
          verdict: action.verdict,
          comment: action.comment,
          at: now,
        });
        changes.push(`meta/reviews/${action.id}.md に追記`);
        if (hasQuestion) {
          appendOpenQuestion(root, action.id, { reviewer: action.reviewer, text: action.questions as string, at: now });
          changes.push("meta/open-questions.md に OQ を追記");
        }
      } else {
        changes.push("[dry-run] 正本・meta への書き込みは行っていません");
        changes.push(`[dry-run] meta/reviews/${action.id}.md への追記（未実施）`);
        if (hasQuestion) {
          changes.push("[dry-run] meta/open-questions.md への OQ 追記（未実施）");
        }
      }

      results.push({ id: action.id, ok: true, verdict: action.verdict, changes });
    } catch (e) {
      results.push({
        id: idForReport,
        ok: false,
        verdict: action?.verdict,
        error: e instanceof Error ? e.message : String(e),
        changes,
      });
    }
  }

  return { dryRun, results };
}

// ---------------------------------------------------------------------------
// meta/*.md の軽量 Markdown レンダラ（旧 scripts/req_spec.ts。req gen 一本化＋spec 廃止に
// 伴い、唯一の残存利用元 scripts/req_document.ts から参照できるよう reqlib.ts へ移動した。
// ロジックは無変更（移動のみ）。req_tree.ts 側にも別実装の renderInlineMarkdown があるが、
// あちらはテーブル非対応の別レンダラであり独立を保つ）。
// ---------------------------------------------------------------------------

/** Python 版 esc() と同値: None は空文字、リストは "[a, b]"、それ以外は文字列化して HTML エスケープ。 */
function mdEsc(s: unknown): string {
  if (s === null || s === undefined) return "";
  let text: string;
  if (Array.isArray(s)) {
    text = "[" + s.map((x) => String(x)).join(", ") + "]"; // Python str(list) と同形
  } else if (s === true) {
    text = "True"; // Python str(True) と同形（render_axes は事前に小文字へ変換する）
  } else if (s === false) {
    text = "False";
  } else {
    text = String(s);
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** meta/*.md で実際に使われている行内記法（`code`, **強調**）だけを変換する。 */
function renderInline(text: string): string {
  const escaped = mdEsc(text);
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** `\|` エスケープを解いてからテーブルセル区切りの `|` だけで分割する。 */
function splitTableRow(inner: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      cur += "|";
      i += 1;
    } else if (inner[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += inner[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * meta/*.md の軽量 Markdown レンダラ（見出し `##`、リスト `-`/`1.`、テーブル、段落のみ対応）。
 * フル Markdown 仕様には対応しない（ADR-001 の外部依存ゼロ方針。meta/*.md が実際に使う
 * 記法のサブセットのみをカバーする）。非対応の記法はエスケープされた生テキストとして残る。
 * headingOffset: meta 内の `##` は本文の章見出し（h2）より一段下げて埋め込むためのオフセット
 * （h2+offset、最大 h6 にクランプ）。
 */
export function renderMarkdown(text: string, headingOffset = 1): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  const html: string[] = [];
  let i = 0;
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listTag: "ul" | "ol" | null = null;

  function flushParagraph(): void {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }
  }
  function flushList(): void {
    if (listTag !== null) {
      html.push(`<${listTag}>` + listItems.map((it) => `<li>${it}</li>`).join("") + `</${listTag}>`);
      listItems = [];
      listTag = null;
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    const heading = /^(#{2,6}) (.+)$/.exec(line);
    const tableRow = /^\|(.+)\|\s*$/.exec(line);
    const listItem = /^[-*] (.+)$/.exec(line);
    const orderedItem = /^\d+\. (.+)$/.exec(line);

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      i += 1;
    } else if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(6, heading[1].length + headingOffset);
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
    } else if (tableRow) {
      flushParagraph();
      flushList();
      const rows: string[][] = [];
      while (i < lines.length) {
        const m = /^\|(.+)\|\s*$/.exec(lines[i]);
        if (!m) break;
        rows.push(splitTableRow(m[1]));
        i += 1;
      }
      if (rows.length >= 2 && rows[1].every((c) => /^:?-+:?$/.test(c))) {
        const headerCells = rows[0].map((c) => `<th>${renderInline(c)}</th>`).join("");
        const bodyRows = rows
          .slice(2)
          .map((r) => "<tr>" + r.map((c) => `<td>${renderInline(c)}</td>`).join("") + "</tr>");
        html.push("<table><tr>" + headerCells + "</tr>" + bodyRows.join("") + "</table>");
      } else {
        for (const r of rows) {
          html.push(`<p>${renderInline(r.join(" | "))}</p>`);
        }
      }
    } else if (listItem || orderedItem) {
      flushParagraph();
      const tag = listItem ? "ul" : "ol";
      if (listTag !== null && listTag !== tag) flushList();
      listTag = tag;
      const itemLines = [listItem ? listItem[1] : (orderedItem as RegExpExecArray)[1]];
      i += 1;
      while (i < lines.length && lines[i].trim() !== "" && /^\s+\S/.test(lines[i]) && !/^[-*] |^\d+\. |^#{2,6} |^\|/.test(lines[i].trim())) {
        itemLines.push(lines[i].trim());
        i += 1;
      }
      listItems.push(renderInline(itemLines.join(" ")));
    } else {
      paragraph.push(line);
      i += 1;
    }
  }
  flushParagraph();
  flushList();
  return html.join("\n");
}
