/**
 * req_fragment.ts — 単一 HTML 化（iframe 廃止・ADR-013）のフラグメントモード共通機構。
 *
 * req_tree.ts / req_guided.ts / req_document.ts の3ビューが「フラグメント（{ styles, html,
 * script } を返す。完全 HTML を返さない）」を実装するときに共有する、生成側スコープ化の
 * 実体をここに集約する（二重実装を避ける。SR-24）。各ビューの buildXxxHtml は、通常
 * （opts なし）は従来どおり完全 HTML を返し、`opts.fragment` が渡されたときだけ
 * ここの関数を呼んで id/href/name/for/aria-labelledby の付与と CSS のスコープ化・
 * 実行時 JS の IDP/ROOT 差し替えを行う。スタンドアロン出力（opts なし）はバイト不変
 * （このモジュールの関数は一切呼ばれない）。
 *
 * 各ビューの JS 定数はいずれも次の2行を先頭付近に持つ（段階1で確立した規約）:
 *   var IDP = '';
 *   var ROOT = document;
 * フラグメント時はこの2行だけをリテラル文字列置換で書き換える（式を丸ごと生成し直すより
 * 事故が少ない。置換値は関数形式の replacer で渡し、idp/rootClass に `$&` 等の特殊トークンが
 * 混入しても誤爆しない — String.prototype.replace は置換値が文字列だと `$&` 等を解釈するため）。
 */

/** フラグメントモードの呼び出し側オプション（バンドル側が3ビュー分をそれぞれ生成する）。 */
export interface FragmentOpts {
  /** id・href フラグメント・name・for・aria-labelledby に付与する接頭辞（例: "tree-"）。 */
  idp: string;
  /** 実行時の名前空間（"REQ_TREE" 等）。CSS の @keyframes 名の重複回避にのみ使う。 */
  ns: string;
  /** このビューのフラグメントが自身を囲む `<div class="${rootClass}">` のクラス名。
   *  CSS スコープ化・実行時 JS の ROOT 解決の両方で使う。バンドル内で他ビューと重複
   *  しないユニークな値を呼び出し側が渡す責務を持つ。 */
  rootClass: string;
}

/** buildHtml 等に渡す共通オプション。fragment を省略すればスタンドアロン（完全 HTML）。 */
export interface BuildOpts {
  fragment?: FragmentOpts;
}

/** フラグメントモードの戻り値。3つとも `<head>`/`<body>` 等の外枠を含まない断片。 */
export interface FragmentResult {
  /** rootClass 配下へスコープ化済みの CSS（`<style>` の中身のみ）。 */
  styles: string;
  /** idp 付与済みの本文 HTML。自身を `<div class="${rootClass}">…</div>` で囲む。 */
  html: string;
  /** IDP/ROOT を差し替え済みの実行時 JS（`<script>` の中身のみ）。 */
  script: string;
}

/**
 * idp・rootClass の受け入れ可能な文字集合（英数字・`_`・`-` のみ、先頭は英字）。
 * scopeCss は `.${rootClass}` を、scopeScript は `JSON.stringify("." + rootClass)` を、
 * buildXxxHtml の自己ラップ div は `esc(rootClass)` をそれぞれ独立に組み立てる
 * （3箇所がバラバラに rootClass を扱う）。ここでいずれの文字も esc() の対象文字
 * （& < > " '）を含まないと保証しておけば、esc() 済みの値と生の値が食い違う余地が
 * そもそも生まれない（3箇所の呼び出し規約を揃えるより、入力を狭める方が安全）。
 */
const SAFE_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * FragmentOpts の idp・rootClass が安全な文字集合であることを検査する（buildXxxHtml の
 * フラグメント分岐の入口で呼ぶ）。idp は空文字列も許す（スタンドアロン相当の呼び出しを
 * 妨げないため）。呼び出し側（req_bundle.ts。段階3）の実装ミスを生成時に検知するための
 * ガードであり、実データ（正本）には依存しない。
 */
export function validateFragmentOpts(opts: FragmentOpts): void {
  if (opts.idp !== "" && !SAFE_TOKEN_RE.test(opts.idp)) {
    throw new Error(`req_fragment: idp は英字始まりの英数字/_/- のみを許容する（実際: ${JSON.stringify(opts.idp)}）`);
  }
  if (!SAFE_TOKEN_RE.test(opts.rootClass)) {
    throw new Error(`req_fragment: rootClass は英字始まりの英数字/_/- のみを許容する（実際: ${JSON.stringify(opts.rootClass)}）`);
  }
}

// ---------------------------------------------------------------------------
// id/href/name/for/aria-labelledby への idp 付与
// ---------------------------------------------------------------------------

/**
 * 属性値（二重引用符・単一引用符の両方）に idp を前置する。属性名の直前に空白を要求する
 * ことで `data-id="…"` や `data-toc-target="…"` のような別属性を誤って拾わない
 * （`data-id` の場合 "id" の直前は "-" であり空白ではないため対象外になる）。
 * `data-toc-target` 等は実行時 JS が byId() 経由（呼び出し側で自動的に idp が付く）で
 * 消費するデータ値であり、ここで書き換えると二重に付いてしまうため意図的に対象にしない。
 */
function prefixAttrValues(html: string, attrName: string, idp: string, multi = false): string {
  const re = new RegExp(`(\\s${attrName}=)(["'])([^"']*)\\2`, "gi");
  return html.replace(re, (_whole, lead: string, quote: string, value: string) => {
    if (multi) {
      const prefixed = value
        .split(/\s+/)
        .filter((v) => v !== "")
        .map((v) => idp + v)
        .join(" ");
      return `${lead}${quote}${prefixed}${quote}`;
    }
    return `${lead}${quote}${idp}${value}${quote}`;
  });
}

/**
 * `href="#…"` （同一ページ内フラグメント。値が1文字以上必須。`href="#"` のような
 * プレースホルダは対象外）にだけ idp を前置する。`href="/"` `href="/guided#BR-1"` のような
 * 絶対パス（相互ビュー間ディープリンク・タブ）は対象外（stage 3/4 のシェル側ルーティングの
 * 対象で、本モジュールの責務ではない）。
 */
function prefixHrefFragments(html: string, idp: string): string {
  const re = /(\shref=)(["'])#([^"']+)\2/gi;
  return html.replace(re, (_whole, lead: string, quote: string, value: string) => `${lead}${quote}#${idp}${value}${quote}`);
}

/**
 * html を「タグ（`<…>`。属性の書き換え対象）」と「地の文・コメント（書き換え対象外）」に
 * 分割し、タグ部分だけに fn を適用する。属性を素朴な正規表現だけで拾うと、地の文が
 * たまたま `id="…"` のような見た目を持つ場合（narrative.html は人手記述で、実例として
 * `既に id="custom-anchor" を振っているため…` のような説明文が実在する）に誤って
 * 書き換えてしまう（実際に narrative_tree fixture で発生を確認した不具合）。属性値の
 * 引用符内の `>` でタグを終端しないよう簡易に引用符を追跡し、`<!-- … -->` コメントは
 * 中身を一切見ずそのまま通す（コメント内に `<script>` 等のタグに見える文字列が
 * 入っていても無関係に保つ）。
 */
function transformTagsOnly(html: string, fn: (tag: string) => string): string {
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const stop = end === -1 ? n : end + 3;
      out += html.slice(lt, stop); // コメントは中身を見ず素通し
      i = stop;
      continue;
    }
    let j = lt + 1;
    let quote: string | null = null;
    while (j < n) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = null;
        j += 1;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        j += 1;
        continue;
      }
      if (c === ">") {
        j += 1;
        break;
      }
      j += 1;
    }
    out += fn(html.slice(lt, j));
    i = j;
  }
  return out;
}

/**
 * 生成済み本文 HTML（1ビュー分。`<body>`〜`</body>` の中身）に idp を付与する
 * （id・href フラグメント・name・for・aria-labelledby。段階1申し送り事項2）。
 * タグの外（地の文・コメント）は対象にしない（上の transformTagsOnly 参照）。
 * idp が空文字列（スタンドアロン相当）のときは何もしない。
 */
export function prefixFragmentIds(html: string, idp: string): string {
  if (idp === "") return html;
  return transformTagsOnly(html, (tag) => {
    let out = tag;
    out = prefixAttrValues(out, "id", idp);
    out = prefixHrefFragments(out, idp);
    out = prefixAttrValues(out, "name", idp);
    out = prefixAttrValues(out, "for", idp);
    out = prefixAttrValues(out, "aria-labelledby", idp, true);
    return out;
  });
}

// ---------------------------------------------------------------------------
// 実行時 JS の IDP/ROOT 差し替え
// ---------------------------------------------------------------------------

const IDP_DECL = "var IDP = '';";
const ROOT_DECL = "var ROOT = document;";

/** 文字列中に needle がちょうど1回だけ現れることを確認する（0回・2回以上はどちらも異常）。 */
function assertExactlyOnce(haystack: string, needle: string, label: string): void {
  const count = haystack.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(
      `req_fragment: scopeScript は ${label} がちょうど1回現れることを前提にしている（実際: ${count}回）。JS テンプレートの先頭規約が変わっていないか確認してください。`,
    );
  }
}

/**
 * 各ビューの JS 定数の先頭2行（`var IDP = '';` / `var ROOT = document;`）だけをリテラル
 * 文字列置換で差し替える（段階1で確立した規約に依存。式を丸ごと再構築しない）。
 * 置換値は関数形式の replacer で渡す（idp/rootClass に `$&` 等が混じっても
 * String.prototype.replace の特殊トークン解釈に触れないようにするため）。
 */
export function scopeScript(js: string, idp: string, rootClass: string): string {
  assertExactlyOnce(js, IDP_DECL, "var IDP = '';");
  assertExactlyOnce(js, ROOT_DECL, "var ROOT = document;");
  let out = js.replace(IDP_DECL, () => `var IDP = ${JSON.stringify(idp)};`);
  out = out.replace(ROOT_DECL, () => `var ROOT = document.querySelector(${JSON.stringify("." + rootClass)});`);
  return out;
}

// ---------------------------------------------------------------------------
// CSS スコープ化（rootClass 配下へ）
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @keyframes の識別子を ns で衝突回避リネームする（段階2要件「@keyframes 名は ns」）。
 * 定義側（`@keyframes <name> {`）と利用側（`animation: <name> …` / `animation-name: <name>`
 * 等、`<name>` を裸の識別子として書く箇所全部）を、同じ単語境界正規表現1回の走査で
 * まとめて書き換える（定義側もこの正規表現にマッチするため、個別の2段処理は不要）。
 *
 * 既知の制限（意図的な単純化。CSS を構文的に解釈しているわけではない）: 単語境界一致のため、
 * キーフレーム名と**まったく同じ文字列**のクラス／ID セレクタが同じ CSS 内に存在すると
 * それも書き換えてしまう。誤爆の典型（`.foo` セレクタ）を減らすため、直前が `.` / `#`
 * （セレクタの接頭）である出現は除外する（否定後読み）。これで完全には防げないが、
 * 実運用で最も起きやすい形は避けられる。取りこぼしの余地は CI の allowlist 検査
 * （段階5）が最終防波堤になる。
 */
function renameKeyframes(css: string, ns: string): string {
  const names = new Set<string>();
  const declRe = /@keyframes\s+([A-Za-z_-][A-Za-z0-9_-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(css)) !== null) {
    names.add(m[1]);
  }
  let out = css;
  for (const name of names) {
    const newName = `${ns}-kf-${name}`;
    const wordRe = new RegExp(`(?<![.#])\\b${escapeRegExp(name)}\\b`, "g");
    out = out.replace(wordRe, () => newName);
  }
  return out;
}

/** 文字列/コメントをスキップしつつ、対象文字集合のいずれかに depth==0 でぶつかる位置を探す。 */
function isQuote(c: string): boolean {
  return c === '"' || c === "'";
}

/**
 * トップレベル（`()` `[]` 文字列リテラルの外）のコンマでのみ分割する（セレクタリストの
 * 分割。段階2要件「カンマ分割は :not()/[] 内で割らない」）。
 */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (isQuote(c)) {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[") {
      depth += 1;
      continue;
    }
    if (c === ")" || c === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * セレクタ1個を rootClass 配下へ写す。html/body/:root はルート自身（`.rootClass`）に、
 * `*` は「自身＋全子孫」（`.rootClass, .rootClass *`）に、それ以外は子孫セレクタとして
 * 前置する（段階2要件「html/body→ルート自身」）。戻り値は0〜2要素の配列（`*` だけ2要素）。
 */
function mapSingleSelector(sel: string, rootClass: string): string[] {
  const trimmed = sel.trim();
  if (trimmed === "") return [];
  const norm = trimmed.toLowerCase();
  if (norm === "html" || norm === "body" || norm === ":root") {
    return [`.${rootClass}`];
  }
  if (trimmed === "*") {
    return [`.${rootClass}`, `.${rootClass} *`];
  }
  return [`.${rootClass} ${trimmed}`];
}

/** セレクタリスト（コンマ区切り文字列）を rootClass 配下へ写し、重複を除いて結合する
 * （段階2要件「`*`→dedup」。html,body が両方 `.rootClass` に写って重複するケースも含む）。 */
function scopeSelectorList(preludeText: string, rootClass: string): string {
  const raw = splitTopLevelCommas(preludeText);
  const mapped: string[] = [];
  for (const part of raw) {
    for (const m of mapSingleSelector(part, rootClass)) mapped.push(m);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of mapped) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out.join(", ");
}

/** CSS 本体1ブロック分を走査し、次の空白/コメント/セレクタ or @-rule 境界までを返す走査結果。 */
interface ScanResult {
  /** ブロック開始 `{` の位置（プレリュード終端）。見つからなければ -1。 */
  bracePos: number;
  /** `;` で終わる（ブロックを持たない）文までの終端位置。ブロックが先に見つかれば -1。 */
  semiPos: number;
}

/** i から走査し、depth==0 の `{` または `;` のどちらが先に来るかを探す（文字列・コメント・
 *  丸括弧・角括弧の中は無視する）。 */
function scanForBlockOrStatementEnd(text: string, i: number): ScanResult {
  let depth = 0;
  let quote: string | null = null;
  let j = i;
  const n = text.length;
  while (j < n) {
    const c = text[j];
    if (quote) {
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === quote) quote = null;
      j += 1;
      continue;
    }
    if (isQuote(c)) {
      quote = c;
      j += 1;
      continue;
    }
    if (c === "/" && text[j + 1] === "*") {
      const end = text.indexOf("*/", j + 2);
      j = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "(" || c === "[") {
      depth += 1;
      j += 1;
      continue;
    }
    if (c === ")" || c === "]") {
      depth = Math.max(0, depth - 1);
      j += 1;
      continue;
    }
    if (depth === 0 && c === "{") return { bracePos: j, semiPos: -1 };
    if (depth === 0 && c === ";") return { bracePos: -1, semiPos: j };
    j += 1;
  }
  return { bracePos: -1, semiPos: -1 };
}

/** `{` の直後（bodyStart）から、対応する閉じ `}` の位置を返す（文字列・コメスト・入れ子
 *  ブロックを無視しない＝正しく数える。段階2要件「`}` 分割は :not()/[] 内で割らない」の
 *  実体はこの深さ計上）。 */
function findMatchingBrace(text: string, bodyStart: number): number {
  let bd = 1;
  let k = bodyStart;
  let quote: string | null = null;
  const n = text.length;
  while (k < n && bd > 0) {
    const c = text[k];
    if (quote) {
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === quote) quote = null;
      k += 1;
      continue;
    }
    if (isQuote(c)) {
      quote = c;
      k += 1;
      continue;
    }
    if (c === "/" && text[k + 1] === "*") {
      const end = text.indexOf("*/", k + 2);
      k = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "{") {
      bd += 1;
      k += 1;
      continue;
    }
    if (c === "}") {
      bd -= 1;
      k += 1;
      continue;
    }
    k += 1;
  }
  return k - 1; // '}' の位置（末尾まで来て閉じなかった場合は text.length - 1 を指す）
}

/**
 * CSS のトップレベル文の列を rootClass 配下へスコープ化する（再帰。段階2要件
 * 「@media/@supports 再帰」）。`@keyframes`／`@font-face` 等その他の @-rule はセレクタでは
 * ないため中身を書き換えず素通しする。空白・コメントは位置ごと保存する。
 */
function transformCssBlock(text: string, rootClass: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const scan = scanForBlockOrStatementEnd(text, i);
    if (scan.bracePos === -1 && scan.semiPos === -1) {
      out += text.slice(i);
      break;
    }
    if (scan.semiPos !== -1) {
      // ブロックを持たない文（例: @charset "UTF-8";）。現行ビュー CSS には存在しないが
      // 素通しで安全側に振る。
      out += text.slice(i, scan.semiPos + 1);
      i = scan.semiPos + 1;
      continue;
    }
    const bracePos = scan.bracePos;
    const preludeRaw = text.slice(i, bracePos);
    const prelude = preludeRaw.trim();
    const bodyStart = bracePos + 1;
    const closeBrace = findMatchingBrace(text, bodyStart);
    const body = text.slice(bodyStart, closeBrace);
    if (prelude.startsWith("@")) {
      const nameMatch = /^@([A-Za-z-]+)/.exec(prelude);
      const atName = nameMatch ? nameMatch[1].toLowerCase() : "";
      if (atName === "media" || atName === "supports") {
        const inner = transformCssBlock(body, rootClass);
        out += `${prelude} {${inner}}`;
      } else {
        // @keyframes（内側は 0%/100%/from/to のキーフレームセレクタでスコープ対象外）・
        // @font-face・@page 等: セレクタを持たないため素通し。
        out += `${prelude} {${body}}`;
      }
    } else {
      out += `${scopeSelectorList(prelude, rootClass)} {${body}}`;
    }
    i = closeBrace + 1;
  }
  return out;
}

/**
 * ビュー1個分の CSS 定数を rootClass 配下へスコープ化する（段階2の入口関数）。
 * ns は @keyframes 名の衝突回避にのみ使う。
 */
export function scopeCss(css: string, rootClass: string, ns: string): string {
  const renamed = renameKeyframes(css, ns);
  return transformCssBlock(renamed, rootClass);
}
