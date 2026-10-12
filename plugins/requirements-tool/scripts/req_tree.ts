#!/usr/bin/env node
/**
 * req_tree.ts — docs/requirements/ 正本から主たる木（consist-of。SR-27）の文書ビューを
 * 一方向生成する。
 *
 * - 入力: docs/requirements/*.md（正本）の parent（主たる内包・単一）/ also_belongs_to
 *   （従たる内包・複数可）フィールド。
 * - 出力: 既定で docs/generated/ツリー.html。
 * - 生成は決定的（同一入力 → バイト同一の出力）。タイムスタンプ・乱数は埋め込まない。
 *
 * このページは「文書そのもの（Word/PDF）」を生成する機能ではなく、要求定義書.html と
 * 同種の「文書ビュー」（正本から一方向生成された表示）である。ただし
 * 章節構造そのものの全体表示（仕様書の目次に沿った通し表示）は要求定義書.html が
 * 担い続ける。本ページは種別（kind）を主軸にした横断ビューである。
 *
 * レイアウト（施主裁定 2026-07-19: 案C＋GitLabイシューボード式折りたたみ。使い捨て
 * モックアップ workdir/mockups/c_board.html の比較検討を経て、本番実装として本ファイルに
 * 反映した）:
 *   - 左 65%＝種別カラムボード（.board）。左から BR / SR / SOL / MO の
 *     4カラムを横並び（flex row）にする。各カラムの幅は件数に応じた flex-grow の
 *     重み付け（最小幅 9rem を確保）。カラムの配置章（見出し）は従来どおり
 *     buildKindColumns が実データの parent 関係から導出する（ハードコードしない。
 *     BR→SEC-5, SR→SEC-6, MO→SEC-7 は単一見出し、SOL→SEC-10/SEC-11 は章ごとの
 *     小見出しグループ。詳細は buildKindColumns のコメントを参照）。旧v0.84までは
 *     5番目に「文書の章」カラム（kind カラムの見出しに使われなかった残りの SEC ルート）
 *     があったが、その内容は文書ビュー（/document のナラティブ）が担うようになったため
 *     ツリーから外した（施主裁定。SEC レコード自体は正本から削除しない。renderDetailPanel
 *     によるモーダルは全 kind 共通で引き続き生成されるため、他レコードからの
 *     parent/traces_to/also_belongs_to リンク経由では従来どおり到達できる）。
 *   - カード（レコード1件の行）は1行表示（overflow: ellipsis、`title` 属性に
 *     「ID タイトル」の全文）にした（v0.32 まではノードの折り返し表示を許容していたが、
 *     カラム幅が件数連動で狭くなり得るため1行に統一）。
 *   - 右 35%＝詳細ペイン（.detail-pane）。位置は position: sticky で常に画面に固定表示され、
 *     ノードをクリックすると即座に切り替わる（旧v0.32はボードの下に全幅で表示していたが、
 *     本改修で右固定に変更。selectNode の実装自体は変えていない）。
 *   - カラムの折りたたみ（新規。GitLab イシューボードの Backlog 列に倣う）: 各カラムの
 *     ヘッダに折りたたみボタン（◀）を持ち、押すとカラムが幅 ~2.2rem の縦書き帯に畳まれる。
 *     帯には KIND_COLLAPSED_LABEL（略語＋日本語名。例: 「SR ステークホルダー要求（18）」）
 *     ＋件数を表示し（長い SEC タイトルは使わない）、帯自体をクリックすると展開に戻る。
 *     writing-mode: vertical-rl は帯コンテナ自体ではなく `.collapsed-label`（テキスト
 *     部分）だけにかけている（施主指摘 2026-07-19: 帯コンテナに直接かけると flex の
 *     主軸が反転し、`justify-content: flex-start` が縦中央寄せのように見えてしまい、
 *     アイコン・ラベルが帯の縦中央に浮いて見える不具合があったため）。帯コンテナは
 *     通常の上下 flex column のままにして、アイコン・ラベルが上端から詰めて並ぶ。
 *     折りたたみ状態は localStorage（キー = `reqtree:collapsed:<kind>`）に保存し、
 *     再読込後も維持する（localStorage が使えない環境でも例外を握りつぶし壊れないように
 *     try/catch で保護。外部通信は行わない）。
 *     **空カラム（該当レコード0件）は既定で折りたたみ状態**にする（非表示にはしない。
 *     「まだ無い」ことが縦帯として見える）。localStorage に明示的な保存値があれば
 *     そちらを既定より優先する（buildHtml 生成時点の HTML は決定的なままで、
 *     localStorage の参照・上書きは実行時 JS が担う）。
 *   - トレース（traces_to）ハイライト（施主裁定 2026-07-19。案A
 *     workdir/mockups/a_traceflow.html の実装を本ファイルに移植）: カード（.node）を
 *     クリックして選択すると、(a) そのレコードの traces_to 先（上流。`.trace-hl-up`、
 *     右上に ↑ の印）と、(b) そのレコードを traces_to で指す側（下流。`.trace-hl-down`、
 *     右上に ↓ の印）を橙系の枠色で強調する。両方とも同系色（橙）だが、境界線の実線/破線と
 *     矢印の向きで上流/下流を視覚的に区別する。選択が変わるたびに一度クリアしてから
 *     付け替える（selectNode に統合。詳細ペインの traces_to リンクも同じ selectNode を
 *     呼ぶため同様に追随する）。判定は data-traces-to 属性（JSON配列。renderTreeItem /
 *     renderColumnHeadingLink の両方の `.node` に埋め込む）を実行時 JS が突き合わせるだけで、
 *     追加のサーバ側計算・外部通信は発生しない。折りたたまれたカラムの中に強調対象がある
 *     場合は、縦帯（.column-collapsed-bar）にも `.has-trace`（下端に橙の下線）を付け、
 *     開かないと関連が見えない事態を避ける（updateCollapsedBandTraceMarkers）。
 *   - ルート＝parent が null のレコード（設計上は SEC-1..11 のみだが、将来 parent の
 *     付け忘れがあっても「はぐれルート」として消えずに表示される安全策）。
 *   - ルート（章）の並び順は frontmatter の `order`（整数）昇順。`order` 未設定のルートは
 *     従来どおり idNumber 昇順にフォールバックする。
 *   - 子（BR/SR/MO 等、ルート以外）の並び順は loadRecords の既存ソート（kind 文字列昇順,
 *     idNumber 昇順）を踏襲する。
 *
 * 詳細ペインのヘッダ圧縮（施主指示 2026-07-19「このヘッダ情報を、色などもつかって領域を
 * 圧縮しかつみやすくして」）:
 *   - `kind: xxx` のメタ行は廃止。kind はタイトル横の既存バッジで表現し、バッジの
 *     `title` 属性にフル kind 名を入れる（ホバーで確認できる）。
 *   - 状態5軸の表（state-table）は廃止し、1行の色チップ列（.chip-row）にした。
 *     各チップは「軸の短縮ラベル＋値」（例: 承認 agreed）。値の意味に応じて
 *     緑（良好）/ 琥珀（暫定・進行・注意）/ 赤（問題）/ 灰（未着手・不適用・未検討）/
 *     紫（意図的未定）に色分けする（stateChipClass。未知の値は灰にフォールバックし、
 *     enum の変更をハードコードで落とさない）。
 *   - axes も表（axes-table）を廃し、中立色のチップ列にした。値が空（[]・null・
 *     空文字列）または false のチップは淡色（dimmed）にする（消さない。「未設定である
 *     こと」自体を見せる）。
 *   - 関係リンクの行ラベルは簡潔にした（「主たる親（parent）:」→「親:」、
 *     「必要性トレース（traces_to）:」→「traces_to:」）。リンクの構造自体
 *     （renderRefLink・also_belongs_to の注記）は変えていない。
 *
 * カラム内の意味的サブセクション（施主指示 2026-07-19「それぞれの要求の集合で、
 * サブセクションで意味的なグルーピングをつくってまとめたい」。groupByAxesGroup /
 * renderRecordsMaybeGrouped）:
 *   - 各種別カラム内（SOL は SEC-10/11 各グループの内側。2階層）で、カードを
 *     frontmatter の `axes.group`（文字列）でサブセクション分けする。小見出しの様式は
 *     既存の SOL SEC-10/11 見出しと同系（控えめ・グループ名＋件数）。
 *   - グループの並び順は「所属レコードの最小 idNumber」昇順（決定的）。グループ内は
 *     既存ソート順をそのまま踏襲する。
 *   - 非回帰のフォールバック: カラム（SOL は SEC グループ）内の誰も axes.group を
 *     持たなければサブセクション見出しを出さずフラット表示する（groupByAxesGroup が
 *     null を返す）。1件以上が axes.group を持つ場合、持たないレコードは末尾の
 *     「未分類」サブセクションに回す。これにより group 未付与の利用プロジェクトの
 *     見た目は変わらない。
 *   - 折りたたみ帯・トレースハイライト・右詳細ペインの挙動はサブセクションを跨いでも
 *     変わらない（renderTreeItem 自体・data-traces-to は変えていない）。
 *   - インデント（施主指示 2026-07-19「SECで分類したらその配下はインデントして」）:
 *     SEC 見出し（SOL の SEC-10/11 小見出し）配下のカード群は `.subgroup-body`
 *     （padding-left: .9rem）で、axes.group 見出し配下のカード群は `.axes-group-body`
 *     （padding-left: .8rem）で、それぞれ見出しより一段インデントする。SEC→group→カード
 *     の2階層になる場合はインデントが積み重なり、従属関係が視覚的に分かるようにした。
 *
 * 詳細ペインの見出し文言変更と context の Markdown レンダリング（施主指示 2026-07-19）:
 *   - 見出し「statement」→「要求・要件の内容」、「本文」→「context」に変更。
 *     statement（frontmatter の生テキスト）は引き続き pre 表示のまま
 *     （プレーンテキストなので Markdown 解釈は不要）。
 *   - context（本文。ReqRecord.body）は renderBodyMarkdown で Markdown を HTML に
 *     レンダリングする。ADR-001 の外部依存ゼロ方針を保つため、req_tree.ts 内に
 *     自己完結した小型レンダラを実装した（scripts/reqlib.ts の renderMarkdown とは
 *     独立の実装。詳細は renderBodyMarkdown / renderInlineMarkdown のコメントを参照）。
 *     対応記法: 見出し（##/###/####）・段落・箇条書き（-/1.）・太字 **…**・
 *     インラインコード `…`・コードフェンス ```・リンク [text](url)（href もエスケープ）。
 *     全テキストは必ず esc() してからマークアップを適用するため XSS 安全で、未対応の
 *     記法（表・入れ子リスト等）はプレーン段落として安全側に落ちる。本文先頭の H1 行
 *     （詳細パネルの見出しと重複する）は1つだけ読み飛ばす。
 *   - リンクの href はスキーム許可リスト（SAFE_LINK_SCHEME = http(s):/mailto:/#/相対パス）
 *     で検証する（自動レビュー指摘・MEDIUM 対処）。`javascript:` 等の危険スキームは
 *     アンカー化せずリンクテキストのみプレーン表示に落とす（href="#" への差し替えより
 *     安全側かつ情報も落ちない）。
 *
 * レーン（カラム）幅のドラッグリサイズ（施主指示 2026-07-19「レーン間をドラッグして
 * 幅を任意に変更できるように」。旧 v0.30 の左右分割 divider 実装を一般化した）:
 *   - カラム同士の境界、およびボードと右詳細ペインの境界に細い divider（col-resize
 *     カーソル・hover で色が変わる）を挟む。ドラッグ中は divider の左側（前の兄弟要素）
 *     の `flex` を px 固定値にし、最小幅（カラムは9rem・ボード/詳細ペインは14rem相当）を
 *     下回らないようクランプする（setupDivider）。
 *   - 手動で変えた幅は localStorage（キー = `reqtree:width:<kind>` / `reqtree:width:board`）
 *     に保存し、再読込後も維持する。折りたたみ⇔展開を跨いでも壊れないよう、展開時に
 *     保存済み幅があれば復元する（toggleColumn 内）。localStorage が使えない環境でも
 *     try/catch で保護し壊れない。
 *   - 折りたたまれたカラムに隣接する境界はドラッグ不可にする（refreshDividers が
 *     `.divider.disabled` を付け外しする。トレースハイライトの折りたたみ帯マーカーと同じ
 *     タイミング＝toggleColumn 実行時に再計算する）。
 *   - 生成される HTML 自体（divider の DOM 構造）は決定的なまま。localStorage の参照・
 *     ドラッグ操作はすべて実行時 JS が担う。
 *
 * 凡例の折りたたみ（施主指示 2026-07-20）:
 *   - 既存の凡例（.legend）をネイティブ `<details><summary>凡例</summary>…</details>` に
 *     変更した（JS 不要・決定的。既定は閉＝`open` 属性を出力しない）。
 *
 * トレーサビリティ関係図セクション → カード間オーバーレイ矢印への置き換え
 * （施主裁定 2026-07-20。一度は層状 DAG 関係図をボード上部の折りたたみセクションとして
 * 取り込んだが、画面を圧迫する・スクロール操作が煩雑という理由で廃止し、代わりに
 * カード自体の上に重ねる矢印オーバーレイに置き換えた。このスクリプトは他ビュー生成器へ
 * 依存しない）:
 *   - カード（.node）を選択（selectNode）すると、そのカードの上流（traces_to 先）・
 *     下流（自分を traces_to で指すカード）へ向かう矢印を、ボードに重ねた透明な
 *     `#trace-overlay`（SVG。position: fixed・pointer-events: none。redrawTraceOverlay
 *     実行時に `.board` の getBoundingClientRect() に合わせて位置・サイズを揃える）に
 *     都度描画する（選択中のカードの分だけ。全エッジを常時描画するわけではない）。
 *     上流=橙実線、下流=橙破線（既存のカード枠ハイライト trace-hl-up/down・折りたたみ帯の
 *     has-trace 印と同じ配色で統一。どちらも矢印に加えて維持している）。
 *   - 各カードの anchor 点は getBoundingClientRect() から求める（相手が左右どちらに
 *     あるかで自分の右端/左端中央を選ぶ）。折りたたみ列の中・非表示など幅/高さが0の
 *     カードは安全にスキップ（線を引かない）。スクロールで `.board` の外に出た分は
 *     オーバーレイ自体を `.board` の可視領域に一致させているため自然にクリップされる。
 *   - 再描画は requestAnimationFrame でスロットルする（scheduleOverlayRedraw）。
 *     フック: selectNode（選択変更）・toggleColumn（折りたたみ開閉）・divider のドラッグ
 *     （onMove）・window の resize・document 全体を capture で監視する scroll（ボード/
 *     カラム/ページのどの要素がスクロールしても検知できる）・すべての `<details>` の
 *     toggle イベント（凡例などの開閉）。redrawTraceOverlay 自体の呼び出しは try/catch で
 *     囲み、描画中の例外が他機能を巻き込まないようにしている。
 *
 * 依存矢印はホバーで再描画（施主指示 2026-07-20。上の節の「選択（selectNode）すると…
 * 都度描画する」は、この指示でホバーとクリックの2系統に分かれた。以下が最終形）:
 *   - ハイライト計算（上流/下流の判定・trace-hl-up/down の付け替え・折りたたみ帯の
 *     has-trace マーカー更新・オーバーレイ再描画の予約）を `highlightTraces(id)` /
 *     `clearTraces()` に括り出し、selectNode（クリック）と mouseenter/mouseleave
 *     （ホバー）の両方から呼ぶ共通処理にした。
 *   - ホバー（mouseenter）は一時プレビュー: `hoveredTraceId` にホバー中カードの id を
 *     入れて `highlightTraces(hoveredTraceId)` を呼ぶ。モーダルは開かない。
 *   - mouseleave では `hoveredTraceId` を null に戻し、「クリックで選択中（`.node.selected`。
 *     sticky）のカードがあればそのカードの矢印に戻す、無ければ `clearTraces()` で消す」
 *     （ホバー＝一時プレビュー、クリック選択＝固定表示という役割分担）。
 *   - `redrawTraceOverlay` が実際にどのカードの矢印を描くかは `currentTraceId()`
 *     （ホバー中があれば優先、無ければ `.node.selected` にフォールバック）で決める。
 *     `selectNode` 自身は `.detail-panel` の active 付け替え・モーダルの開閉・
 *     `.node.selected` の付け替えのみを担い、ハイライト計算そのものは
 *     `highlightTraces(id)` に委譲する（selectNode は "id を渡してハイライトも固定する"
 *     だけの薄い呼び出し元になった）。
 *
 * 右固定詳細ペインの廃止 → クリックで開く中央モーダル表示、および要レビューの可視化
 * （施主裁定 2026-07-20。この節より上の記述にある「右35%固定（sticky）詳細ペイン」は
 * この裁定で廃止済み。過去の裁定の記録として文面はそのまま残している。廃止直後は
 * 一度 hover/フォーカスのポップアップとして実装したが、同日中の施主の方針変更で
 * 「クリックしてモーダルで表示」に変更した。以下は最終形の記述）:
 *   - `.board` を全幅（100%）にした。ボードと右ペインの間にあった divider は撤去し、
 *     カラム間の divider のみが残る（setupDivider の minPx はカラム最小幅 144px 固定）。
 *   - 全レコード分の `.detail-panel`（renderDetailPanel）は `#detail-modal-backdrop`
 *     （`.modal-backdrop`。画面全体を覆う半透明の backdrop）の中にまとめて埋め込む。
 *     生成時点では backdrop も各パネルも非表示（backdrop は既定 `display: none`、
 *     `.open` で `display: flex` になり中央に配置。パネルは既定 `display: none`、
 *     `.active` で `display: block`）。
 *   - カード（`.node`）をクリック（アンカー要素なので Enter も自然に発火する。Space は
 *     アンカーの既定動作では発火しないため keydown で明示的に補っている）すると
 *     selectNode(id) が対象の `.detail-panel` に `active` を付けて openDetailModal が
 *     backdrop を開く（`target.focus()` も試みる。tabindex="-1" なのでタブ順には
 *     含まれないが `.focus()` は呼べる）。モーダル内の parent/traces_to リンクは
 *     同じ selectNode を呼ぶため、開いたまま中身だけ差し替わる。
 *   - 閉じる手段は3つ: パネル右上の `.detail-close` ボタン（onclick で
 *     closeDetailModal）、backdrop の空白部分クリック（クリックされた要素が backdrop
 *     自身のときだけ閉じる。パネル内側のクリックは伝播してもターゲットが異なるため
 *     素通りする）、Esc キー（backdrop が `.open` のときだけ）。closeDetailModal は
 *     モーダルの開閉のみを扱い、ボード上の選択（`.node.selected`）・トレースハイライトは
 *     クリアしない（施主指示「モーダルを閉じてもボード上の選択ハイライトは残してよい」）。
 *   - トレース枠ハイライト（trace-hl-up/down）・折りたたみ帯マーカー・オーバーレイ矢印は
 *     クリック（＝モーダルを開く操作）に自然に追随する（selectNode 自体の判定ロジックは
 *     変更していない。呼び出し元がクリック/キー操作にまとまっただけ）。
 *   - 要レビュー可視化（施主裁定「カードにバッジ＋絞り込み」）: `axes.review_required`
 *     が真のレコードのカードに橙系バッジ（`.review-badge`）を出す（reqlib.ts は変更せず、
 *     既存の `ReqRecord.axes` getter から `isReviewRequired` が直接読む）。ボード上部の
 *     `.review-filter-bar` にチェックボックス「要レビューのみ表示」を置き、ON のとき
 *     `.board.review-filter-on` が付き、`.node:not(.col-heading):not(.is-review-required)`
 *     を非表示にする（カラム自体・カラム/サブセクション見出し＝`.col-heading` は残す）。
 *     チェック状態は localStorage（`reqtree:reviewFilter`）に保存する。総件数は
 *     生成時点の実データから数える（`reviewRequiredCount`。ハードコードしない）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { ReqRecord, loadRecords, parseBodySections } from "./reqlib.ts";
import { scopeCss, prefixFragmentIds, scopeScript, validateFragmentOpts, type BuildOpts, type FragmentResult } from "./req_fragment.ts";

export type { BuildOpts, FragmentOpts, FragmentResult } from "./req_fragment.ts";

function defaultRoot(): string {
  // 既定の対象は呼び出し元プロジェクト（プラグイン自身の正本を黙って対象にしない）
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

function defaultOut(): string {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "generated", "ツリー.html");
}

/** 他のビュー生成スクリプトの esc() と同値。 */
export function esc(s: unknown): string {
  if (s === null || s === undefined) return "";
  let text: string;
  if (Array.isArray(s)) {
    text = "[" + s.map((x) => String(x)).join(", ") + "]";
  } else if (s === true) {
    text = "True";
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

/**
 * インラインハンドラ（onclick/onchange）を単一ヘルパ経由で出す（ADR-013。単一ドキュメント＋
 * 名前空間化）。v1 は onclick 値の先頭に名前空間（REQ_TREE）を付けるだけ
 * （namespace-on-onclick）。将来 addEventListener 委譲方式へ切り替えるときもこのヘルパ
 * 1箇所を直せば済む。expr は末尾の `;` を含めて渡す（呼び出し側の記述をそのまま踏襲）。
 */
export function nsHandlerAttr(ns: string, event: "onclick" | "onchange", expr: string): string {
  return `${event}="return ${ns}.${expr}"`;
}

export const KIND_LABEL: ReadonlyMap<string, string> = new Map([
  ["business_requirement", "BR"],
  ["stakeholder_requirement", "SR"],
  ["solution_requirement", "SOL"],
  ["mandatory_output", "MO"],
  ["document_section", "SEC"],
  ["use_case", "U"],
]);

// 折りたたみ帯（縦書き）のラベル。略語だけでは読み手が種別を思い出せないという
// 施主指摘（2026-07-19）を受け、略語＋日本語名にした。document_section は略語（SEC）と
// 日本語名が実質同じ意味になるため重複させず日本語名のみにする。req_tree.ts 自身は
// 「文書の章」カラムを持たない（施主裁定でツリー表示から外した）が、このマップ自体は
// req_guided.ts が自分の SEC タイル表示に流用しているため、エントリは残す（SR-24。
// 二重実装を避ける）。
export const KIND_COLLAPSED_LABEL: ReadonlyMap<string, string> = new Map([
  ["business_requirement", "BR ビジネス要求"],
  ["stakeholder_requirement", "SR ステークホルダー要求"],
  ["solution_requirement", "SOL ソリューション要件"],
  ["mandatory_output", "MO 必須アウトプット"],
  ["document_section", "文書の章"],
  ["use_case", "U: ユースケース"],
]);

// 種別（kind）の的確な定義文（施主指示 2026-07-21「BR,SR,SOLなどの的確な定義をタイトルの
// ところに付記して」＋裁定「ホバーでヒント表示・対象 BR/SR/SOL/MO」。2026-07-31 施主指示で
// BR/SR/SOL の文言を正本 SEC-5/6/10 の title/statement と揃えた表現に更新。ホバーだけでなく
// 画面上に常時見える説明（カラム見出し直下のキャプション・guided 表紙タイル）でも同じ値を
// 参照する「二重定義しない」ための唯一の一次情報）。対象は BR/SR/SOL/MO/U で
// SEC（document_section）は意図的に含めない（マップに無い kind は呼び出し側で title 属性
// 自体を出さずに従来どおり振る舞う）。MO は施主指示により既存の定義文を維持（変えない）。
// U（use_case）は SOL-44 で追加。
// 種別が視覚的に現れる箇所（カードの kind バッジ・カラム見出し・折りたたみ帯ラベル・
// モーダルヘッダの kind バッジ・常時表示のキャプション）すべてがこのマップを共通の
// 一次情報として使う。
export const KIND_DEFINITION: ReadonlyMap<string, string> = new Map([
  ["business_requirement", "組織全体が目指す目標（なぜやるか）。主語は組織。"],
  [
    "stakeholder_requirement",
    "現場の利用者・関係者の個別のニーズ（どう使いたいか・どう困っているか）。主語は人。",
  ],
  ["solution_requirement", "システムが満たすべき検証可能な条件。BR/SR との違いは主語＝システム。"],
  [
    "mandatory_output",
    "MO（Mandatory Output / 必須アウトプット）: プロジェクトで必ず確定させるべき決定事項のカタログ（要求そのものではなく、決めるべき事項）。",
  ],
  [
    "use_case",
    "アクターがシステムとの相互作用を通じて目的を達成するまでの流れ。主語はアクターとシステムの対。",
  ],
]);

/** kind に対応する定義文（無ければ null。SEC 等は意図的に未収載）。 */
export function kindDefinition(kind: string | null | undefined): string | null {
  if (kind === null || kind === undefined) return null;
  return KIND_DEFINITION.get(kind) ?? null;
}

/**
 * 共通トップバー（ビュー切替タブ・記名欄・完了ボタン・readonly 注記）が使う CSS 断片
 * （SOL-30）。tree・guided 双方の CSS 定数に埋め込んで見た目を共有する（マークアップの
 * 共有は renderReviewTopbar が担う）。
 */
/**
 * 全ビュー共通のヘッダ・ナビゲーション制御（施主指示 2026-08-11「ローカルイシューのページも、
 * 他のレビュー画面とヘッダやナビゲーションを共通化する」）。
 *
 * 「サーバ配信されているか」と「書き戻せるか」は別の事実である。統一前は両方を
 * `window.__REVIEW_ENDPOINT__` 1 つで判定していたため、書き戻しを持たない読み取り専用の
 * ビュー（イシュー・カバレッジ）はサーバで配信していてもビュー切替タブが出ず、注記も
 * 「読み取り専用（file://）」と表示していた——http で配信されているのに file:// と名乗る
 * 誤りで、5 ビューを行き来できない原因でもあった。
 *
 * そこでサーバは配信する全ビューに `window.__REVIEW_SERVED__` を注入し、タブの表示は
 * こちらで判定する。書き戻し UI の有効化は従来どおり `__REVIEW_ENDPOINT__` で判定する
 * （読み取り専用ビューでは注入されないまま＝操作できないまま）。
 *
 * この JS は 5 ビューが取り込んで使う（各ビューが自前で判定を書かない。SR-24）。byId は
 * 各ビューが自分の IIFE 内に持つ（バンドルの id 接頭辞に対応するため）ので引数で受け取る。
 */
/**
 * 右サイドバー（確認状況）の見た目。通読レビュー（SOL-50 (b)）が最初に持ち、2026-08-11 に
 * 文書ビュー（SOL-31 改訂・施主指示「文書ビューにも、未レビュー状況がわかる右サイドバーを
 * つけて」）へも広げたため、両ビューが同じものを取り込む形にした（SR-24）。
 */
/** ID の自然な順序比較（例: BR-2 < BR-10）。プレフィックスの英字→番号の順。
 * 通読レビューが持っていたものを、サイドバーの共有にあわせて移した（SR-24）。 */
export function compareIds(a: string, b: string): number {
  const ma = /^([A-Za-z]+)-(\d+)$/.exec(a);
  const mb = /^([A-Za-z]+)-(\d+)$/.exec(b);
  if (ma && mb) {
    if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
    return parseInt(ma[2], 10) - parseInt(mb[2], 10);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface SidebarEntry {
  id: string;
  kind: string | null;
  isSection: boolean;
  /** このレコードが属するストーリー／ユースケースの ID（範囲限定の照合キー。ステッパーの
   * data-group と同じ値の集合。SOL-50 (b) 改訂・施主裁定 2026-08-10）。 */
  groups: string[];
}

/** サイドバー掲載順（文書順）の全レコード一覧を組み立てる。renderSectionSlide が
 * カードを描く順（children の並び）と同じ順序基準を使う（二重実装しない）。
 * 各行にはユースケースの所属 ID も持たせる（範囲限定の照合用。行の集合と順序はモードに
 * よらず一定で、絞り込みは実行時にクラスで行う＝生成物は決定的なまま）。
 * ストーリーレビューの所属 ID も渡していたが、同モードの廃止（2026-08-11）で無くなった。 */
export function buildSidebarEntries(
  sections: ReqRecord[],
  ctx: TreeContext,
  ucMembership: Map<string, { ucId: string; stepIdx: number }[]>,
): SidebarEntry[] {
  const groupsOf = (id: string): string[] => {
    const gs = new Set<string>();
    for (const m of ucMembership.get(id) ?? []) gs.add(m.ucId);
    return [...gs].sort(compareIds);
  };
  const entries: SidebarEntry[] = [];
  for (const sec of sections) {
    if (sec.id === null) continue;
    entries.push({ id: sec.id, kind: sec.kind, isSection: true, groups: groupsOf(sec.id) });
    const children = (ctx.childrenOf.get(sec.id) ?? []).filter((c) => c.kind !== "document_section");
    for (const c of children) {
      if (c.id === null) continue;
      entries.push({ id: c.id, kind: c.kind, isSection: false, groups: groupsOf(c.id) });
    }
  }
  return entries;
}

/**
 * 右サイドバー本体（SOL-50 (b)）。各行のチェック状態は isConfirmed（正本の
 * approval=agreed ∧ review_required=false）から導出する（生成時点の静的な値。実行時の
 * 更新は toggleConfirm/runBulkApprove の setSidebarChecked が担う）。行クリックは
 * gotoCanonicalRecord（網羅レビューの正準スライドへ遷移。既存のジャンプ機構を再利用し、
 * 二重実装しない）。狭い画面向けの折りたたみはヘッダのトグルボタン（toggleSidebar）で行う。
 */
export interface SidebarRenderOpts {
  /** 行クリック時に呼ぶ JS 式（`(id)` を受ける関数呼び出しの雛形）。ビューごとに違う——
   * 通読レビューは正準スライドへの遷移、文書ビューは本文中の参照へのスクロール。 */
  onClickExpr: (jsId: string) => string;
  /** ハンドラの名前空間（nsHandlerAttr の第1引数）。 */
  ns: string;
  /** ヘッダ直下の注記（対象範囲の明示）。 */
  note: string;
}

export function renderSidebar(entries: SidebarEntry[], ctx: TreeContext, opts: SidebarRenderOpts): string {
  const parts: string[] = ['<aside class="review-sidebar" id="review-sidebar">'];
  parts.push('<div class="review-sidebar-header">');
  parts.push(
    `<button type="button" class="review-sidebar-toggle" id="review-sidebar-toggle" ${nsHandlerAttr(opts.ns, "onclick", "toggleSidebar();")} title="サイドバーを閉じる" aria-label="サイドバーを閉じる">` +
      '<span class="review-sidebar-toggle-icon">◂</span><span class="review-sidebar-toggle-label"> 閉じる</span></button>',
  );
  parts.push('<span class="review-sidebar-title">確認状況</span>');
  parts.push("</div>");
  // 対象範囲の明示（UXイシュー 05）。網羅レビューでは全件、ストーリー／ユースケースレビュー中は
  // その範囲だけに絞る（施主裁定 2026-08-10）。文言は実行時に syncSidebarScope が書き換える
  // ので、生成時は網羅レビュー（既定）の文言を入れておく。
  parts.push(`<p class="review-sidebar-note" id="review-sidebar-note">${esc(opts.note)}</p>`)
  // 「未確認のみ」フィルタ（SOL-50 (b) 追記。施主指示 2026-08-09）。サイドバー自身は
  // 表示＋ナビゲーションのみ（書き戻しを持たない）ため、この操作もサーバへ通信しない
  // 純クライアント側のフィルタであり、確認チェックボックスと違って disabled にしない
  // （既存のサイドバー折りたたみトグルと同じ「常時有効」方針。静的バンドル・file:// でも
  // 生成時点のチェック状態を使ってそのまま絞り込める）。
  parts.push('<div class="review-sidebar-filter-row">');
  parts.push(
    `<label class="review-sidebar-filter-label"><input type="checkbox" id="review-sidebar-filter-unconfirmed" checked ` +
      `${nsHandlerAttr(opts.ns, "onchange", "toggleSidebarFilter(this.checked);")}> 未確認のみ</label>`,
  );
  parts.push("</div>");
  parts.push('<ul class="review-sidebar-list">');
  for (const e of entries) {
    const rec = ctx.byId.get(e.id);
    const checked = rec !== undefined && isConfirmed(rec);
    const kindLabel = e.kind !== null ? (KIND_LABEL.get(e.kind) ?? e.kind) : "?";
    parts.push(
      `<li class="review-sidebar-item${e.isSection ? " review-sidebar-item-sec" : ""}" data-side-id="${esc(e.id)}" ` +
        `data-side-groups="${esc(e.groups.join(" "))}" ` +
        `${nsHandlerAttr(opts.ns, "onclick", opts.onClickExpr(esc(JSON.stringify(e.id))))}>` +
        `<span class="review-sidebar-check" data-side-check="${esc(e.id)}">${checked ? "✓" : ""}</span>` +
        `<span class="review-sidebar-kind">${esc(kindLabel)}</span>` +
        `<span class="review-sidebar-id">${esc(e.id)}</span>` +
        "</li>",
    );
  }
  parts.push("</ul>");
  parts.push("</aside>");
  return parts.join("");
}


export const REVIEW_SIDEBAR_CSS = `/* 右サイドバー。狭い画面では折りたたみ可（.collapsed。req_tree.ts の列折りたたみ帯と同じ
   考え方——トグルボタン＋localStorage 保持。SOL-50 (b)）。 */
.review-sidebar { flex: 0 0 auto; width: 15rem; border-left: 1px solid #e2dff5; background: #fbfaff; display: flex; flex-direction: column; overflow: hidden; }
.review-sidebar.collapsed { width: 2.6rem; }
.review-sidebar.collapsed .review-sidebar-title, .review-sidebar.collapsed .review-sidebar-list, .review-sidebar.collapsed .review-sidebar-filter-row { display: none; }
.review-sidebar-header { flex: 0 0 auto; display: flex; align-items: center; gap: .4rem; padding: .5rem .5rem; border-bottom: 1px solid #e2dff5; }
.review-sidebar-toggle { font: inherit; font-size: .78rem; padding: .1rem .45rem; border-radius: 4px; border: 1px solid #534AB7; background: #fff; color: #534AB7; cursor: pointer; }
/* 折りたたみトグルは矢印の向きだけに頼らず、状態に応じた文言（閉じる/開く）を出す
   （UXイシュー 07）。回転させるのはアイコン部分のみで、文言は回転させない。 */
.review-sidebar-toggle-icon { display: inline-block; }
.review-sidebar.collapsed .review-sidebar-toggle-icon { transform: rotate(180deg); }
.review-sidebar.collapsed .review-sidebar-toggle-label { display: none; }
.review-sidebar-title { font-size: .82rem; font-weight: bold; color: #534AB7; white-space: nowrap; }
/* サイドバーの対象範囲を明示する注記（UXイシュー 05）。網羅レビューでは全件、ストーリー／
   ユースケースレビュー中はその範囲だけに絞る（施主裁定 2026-08-10）。文言は実行時に
   syncSidebarScope が書き換える。 */
.review-sidebar-note { font-size: .7rem; color: #777; margin: .15rem 0 0; line-height: 1.35; }
.review-sidebar.collapsed .review-sidebar-note { display: none; }
/* 「未確認のみ」フィルタ行（SOL-50 (b) 追記）。ヘッダ直下・リストの上に置く固定行。 */
.review-sidebar-filter-row { flex: 0 0 auto; padding: .4rem .6rem; border-bottom: 1px solid #e2dff5; }
.review-sidebar-filter-label { display: flex; align-items: center; gap: .35rem; font-size: .78rem; color: #555; cursor: pointer; white-space: nowrap; }
.review-sidebar-list { list-style: none; margin: 0; padding: .3rem; overflow-y: auto; flex: 1 1 auto; }
.review-sidebar-item.filtered-out { display: none; }
/* 範囲限定（ストーリー／ユースケースレビュー中。SOL-50 (b) 改訂・施主裁定 2026-08-10）。
   「未確認のみ」フィルタとは独立した軸なので、別クラス・別ルールで持つ。 */
.review-sidebar-item.out-of-scope { display: none; }
.review-sidebar-item { display: flex; align-items: center; gap: .35rem; padding: .3rem .4rem; border-radius: 5px; cursor: pointer; font-size: .8rem; }
.review-sidebar-item:hover { background: #EEEDFE; }
/* いま見ているスライドに対応する行（UXイシュー 06）。長大な一覧の中の現在位置を示す。 */
.review-sidebar-item-current { background: #EEEDFE; box-shadow: inset 3px 0 0 #534AB7; }
.review-sidebar-item-sec { font-weight: bold; margin-top: .4rem; }
.review-sidebar-check { flex: 0 0 auto; width: 1rem; text-align: center; color: #1e6b3c; font-weight: bold; }
.review-sidebar-kind { flex: 0 0 auto; font-size: .68rem; font-family: monospace; background: #EEEDFE; color: #534AB7; border-radius: 4px; padding: .05rem .3rem; }
.review-sidebar-id { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 900px) { .review-sidebar { width: 11rem; } .review-sidebar-kind { display: none; } }`;

/**
 * 右サイドバー（確認状況）の実行時 JS のうち、ビューに依存しない部分——折りたたみ・
 * 「未確認のみ」フィルタ・チェック表示の更新。通読レビュー（SOL-50 (b)）が最初に持ち、
 * 文書ビュー（SOL-31 改訂 2026-08-11）へ広げたので共有に移した（SR-24）。
 * 現在位置の強調（syncSidebarCurrent）・範囲限定（syncSidebarScope）は通読レビュー固有の
 * 概念なので移さない。byId / ROOT は取り込み側の IIFE が持つ前提（他の共有 JS と同じ）。
 */
export const REVIEW_SIDEBAR_JS = `
// 右サイドバーのチェック表示更新（SOL-50 (b)）。チェックボックス自身は持たせず（サイドバーは
// 表示＋ナビゲーションのみで、書き戻しの入口はカード上の確認チェックボックス1箇所に限る。
// 二重実装しない）、印（チェックマーク）のテキストだけを切り替える。「未確認のみ」フィルタが
// オンのときは、その行の表示/非表示も同時に更新する（確認操作の即時反映と両立させる。
// SOL-50 (b) 追記）。
// 確認済みカードの見た目（UXイシュー 02）。生成時のクラス付与（renderRecordCard）と同じ
// 判定を実行時にも反映する。data-record-id は網羅レビューの正準カードとストーリー／ユースケースの
// 別視点カードの両方に付いているので、どのモードで確認しても両方の見た目が揃う
// （.review-badge を一括で隠すのと同じ考え方）。
function setCardConfirmed(id, checked) {
  ROOT.querySelectorAll('.record-card[data-record-id="' + id + '"]').forEach(function (card) {
    if (checked) { card.setAttribute('data-confirmed', '1'); } else { card.removeAttribute('data-confirmed'); }
  });
}
function setSidebarChecked(id, checked) {
  var el = ROOT.querySelector('.review-sidebar-check[data-side-check="' + id + '"]');
  if (el) { el.textContent = checked ? '\\u2713' : ''; }
  var li = el ? el.closest('.review-sidebar-item') : null;
  applySidebarItemVisibility(li);
}
// 右サイドバーの折りたたみ切替（SOL-50 (b)。狭い画面向け。req_tree.ts の列折りたたみ帯と
// 同じ考え方——トグル＋localStorage 保持）。
// トグルの文言・支援テキストを現在の状態に合わせる（UXイシュー 07）。矢印の向きだけでは
// 「押すとどちらに変わるのか」が伝わらないため、ボタン自身に動作を書く（展開時は
// 「閉じる」、折りたたみ時は「開く」。折りたたみ時は幅が狭く文言を出せないので、
// title/aria-label だけを切り替える）。
function syncSidebarToggleLabel() {
  var sidebar = byId('review-sidebar');
  var btn = byId('review-sidebar-toggle');
  if (!sidebar || !btn) { return; }
  var collapsed = sidebar.classList.contains('collapsed');
  var text = collapsed ? 'サイドバーを開く' : 'サイドバーを閉じる';
  btn.setAttribute('title', text);
  btn.setAttribute('aria-label', text);
  btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  var label = btn.querySelector('.review-sidebar-toggle-label');
  if (label) { label.textContent = collapsed ? ' 開く' : ' 閉じる'; }
}
function toggleSidebar() {
  var sidebar = byId('review-sidebar');
  if (!sidebar) { return false; }
  var collapsed = !sidebar.classList.contains('collapsed');
  sidebar.classList.toggle('collapsed', collapsed);
  try { localStorage.setItem('reqguided:sidebarCollapsed', collapsed ? '1' : '0'); } catch (e) {}
  syncSidebarToggleLabel();
  return false;
}
function restoreSidebarCollapsed() {
  var sidebar = byId('review-sidebar');
  if (!sidebar) { return; }
  var stored = null;
  try { stored = localStorage.getItem('reqguided:sidebarCollapsed'); } catch (e) {}
  if (stored === '1') { sidebar.classList.add('collapsed'); }
  syncSidebarToggleLabel();
}
// 「未確認のみ」フィルタ（SOL-50 (b) 追記。施主指示 2026-08-09）。サーバへは通信しない
// 純クライアント側の絞り込み。localStorage に保持し、確認チェック（setSidebarChecked）・
// 一括確認（runBulkApprove の setSidebarChecked 呼び出し）のいずれで行のチェック状態が
// 変わっても、フィルタがオンなら即座に表示/非表示へ反映する。
function isSidebarFilterOn() {
  var cb = byId('review-sidebar-filter-unconfirmed');
  return !!(cb && cb.checked);
}
function applySidebarItemVisibility(li) {
  if (!li) { return; }
  var checkEl = li.querySelector('.review-sidebar-check');
  var confirmed = !!(checkEl && checkEl.textContent === '\\u2713');
  li.classList.toggle('filtered-out', isSidebarFilterOn() && confirmed);
}
function applySidebarFilter() {
  ROOT.querySelectorAll('.review-sidebar-item').forEach(function (li) { applySidebarItemVisibility(li); });
}
function toggleSidebarFilter(checked) {
  try { localStorage.setItem('reqguided:sidebarFilterUnconfirmed', checked ? '1' : '0'); } catch (e) {}
  applySidebarFilter();
  return false;
}
function restoreSidebarFilter() {
  var cb = byId('review-sidebar-filter-unconfirmed');
  if (!cb) { return; }
  var stored = null;
  try { stored = localStorage.getItem('reqguided:sidebarFilterUnconfirmed'); } catch (e) {}
  // 既定はオン（施主指示 2026-08-09「未確認のみチェックをデフォルトにして」）。明示的に
  // オフにしたときだけ '0' が入るので、未保存（null）は既定のオンとして扱う。
  cb.checked = stored !== '0';
  applySidebarFilter();
}
`;

export const REVIEW_NAV_JS = `
function isReviewServed() {
  if (window.__REVIEW_SERVED__ === true) { return true; }
  return typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '';
}
// ビュー切替タブ（SOL-30）とツールバーの注記を、配信状態・書き戻し可否から決める。
// writable を省略すると「書き戻しの経路を持たないビュー」として扱う。
function applyReviewNav(ROOT, byId, writable) {
  var served = isReviewServed();
  ROOT.querySelectorAll('.view-tabs').forEach(function (el) { el.style.display = served ? '' : 'none'; });
  var note = byId('review-toolbar-note');
  if (note) {
    note.style.display = writable === true ? 'none' : '';
    note.textContent = served ? '読み取り専用のビュー' : '読み取り専用（file://）';
  }
}
`;

export const REVIEW_TOPBAR_CSS = `.view-tabs { display: flex; gap: .5rem; align-items: center; }
.view-tabs a { padding: .25rem .75rem; border-radius: 999px; background: #EEEDFE; color: #534AB7; text-decoration: none; font-size: .85rem; font-weight: bold; white-space: nowrap; }
.view-tabs a.active { background: #534AB7; color: #fff; }
.review-readonly-note { color: #888; font-size: .8rem; }
.review-verdict-note { color: #666; font-size: .78rem; margin: .45rem 0 0; line-height: 1.5; }
.review-filter-count { color: #8a5a00; font-weight: bold; }
.cross-jump { color: #534AB7; text-decoration: underline; font-size: .82rem; white-space: nowrap; }
.site-header { margin: 0 0 1rem; padding: 1.2rem 1.4rem 0; }
.site-header h1 { margin: 0 0 .6rem; font-size: 1.35rem; line-height: 1.35; }
.site-header .site-name { display: block; font-size: .78rem; font-weight: normal; color: #666; margin-top: .2rem; }
.site-header .review-toolbar { margin: 0; }
.review-toolbar { display: flex; align-items: center; gap: .8rem; margin: 0 0 .8rem; font-size: .85rem; flex-wrap: wrap; }
.review-toolbar .spacer { flex: 1 1 auto; }
.review-toolbar label { white-space: nowrap; }
.review-toolbar input[type="text"] { font: inherit; padding: .25rem .5rem; border: 1px solid #ccc; border-radius: 5px; margin-left: .3rem; }
.review-toolbar button { font: inherit; padding: .3rem .8rem; border-radius: 5px; border: 1px solid #534AB7; background: #534AB7; color: #fff; cursor: pointer; }
.review-toolbar button:disabled { opacity: .4; cursor: not-allowed; }
`;

// ---------------------------------------------------------------------------
// SOL-37: 静的ビューのオフライン下書きモードと回収規約（SR-45 / ADR-011）。
//
// モード判別は既存の window.__REVIEW_ENDPOINT__ 注入の有無のまま（新機構を作らない。
// ADR-011 裁定）。注入あり＝オンライン（従来どおり即時 POST。挙動は一切変えない）、
// 注入なし＝下書きモード（既存のレビューボックスを disabled 解除し、入力を
// localStorage に保存・復元する）。tree（req_tree.ts）・guided（req_guided.ts）の
// 両方から使うため、CSS・JS 断片・埋め込みメタ情報（プロジェクト識別子・正本の版）の
// 算出はここに集約する（REVIEW_TOPBAR_CSS / renderReviewTopbar と同じ「共有部は
// req_tree.ts に export する」既存慣行）。
//
// localStorage キー: `reqdraft:<プロジェクト識別子>:<レコードID>`（判定・コメント・
// 質問を1つの JSON にまとめて保存）、記名は `reqdraft:<プロジェクト識別子>:__reviewer`。
// file:// の localStorage はブラウザによってはオリジン単位（≒ファイルパス無視）で共有
// されるため、識別子をキーに含めてプロジェクト間の混線を防ぐ（ADR-011）。
// ---------------------------------------------------------------------------

export interface ProjectMeta {
  projectId: string;
  version: string;
  date: string;
}

/**
 * 正本 root からプロジェクト識別子を導出する。root は `<project>/docs/requirements`
 * 相当のディレクトリを想定し、その2階層上のディレクトリ名を識別子にする（実プロジェクト
 * では `<project>/docs/requirements` → `<project>` 名、テスト fixture では
 * `tests/fixtures/<name>/docs/requirements` → `<name>` になる）。root がその想定より浅い
 * 場合は root 自身のディレクトリ名にフォールバックする。
 */
export function projectIdentifier(root: string): string {
  const resolved = path.resolve(root);
  const candidate = path.basename(path.dirname(path.dirname(resolved)));
  return candidate !== "" && candidate !== path.sep ? candidate : path.basename(resolved);
}

export interface ChangelogHead {
  version: string;
  date: string;
}

/**
 * meta/changelog.md の先頭の `## v<版> — <YYYY-MM-DD> (曜)` 見出しから版と日付を取る。
 * scripts/req_document.ts の同名ロジック（版・生成日の文書ビュー表示に使用）と同じ
 * 正規表現。SOL-41 で req_guided.ts もストーリー順モードの版並記に必要になったため
 * export した（req_document.ts 側は独立コピーのまま。3ビューとも変更対象が同時に
 * 増えるほど深い共有ではなく、req_tree.ts/req_guided.ts 間の2度目の再利用だけを
 * まず解消する）。ファイルが無い・見出しが見つからない場合は null
 * （呼び出し側が「不明」表示にフォールバックする）。実行時刻は一切使わない
 * （決定性維持。req_tree.ts / req_guided.ts の生成は同一入力→バイト同一の出力のまま）。
 */
export function readChangelogHead(root: string): ChangelogHead | null {
  const filePath = path.join(root, "meta", "changelog.md");
  let text: string;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const m = /^## v(\S+)\s*—\s*(\d{4}-\d{2}-\d{2})/m.exec(text);
  if (!m) return null;
  return { version: m[1], date: m[2] };
}

/** 生成 HTML に埋め込むプロジェクト識別子・正本の版・日付（版が特定できないときは「不明」）。 */
export function computeProjectMeta(root: string): ProjectMeta {
  const head = readChangelogHead(root);
  return {
    projectId: projectIdentifier(root),
    version: head !== null ? `v${head.version}` : "不明",
    date: head !== null ? head.date : "不明",
  };
}

/**
 * トップバー（.review-toolbar）に差し込む下書き件数チップ＋「プレビュー」／
 * 「すべてコピー」／「クリア」ボタン。オンライン時は initDraftMode が何もしないため
 * 既定の display:none のまま隠れる（既存の .view-tabs / .cross-jump と同じ二態規約）。
 * 「プレビュー」（施主指示「オフラインレビューした内容をプレビューできるように」）は
 * renderDraftPreviewPanel が出すフローティングパネルの開閉トグル（toggleDraftPreview）を
 * 呼ぶだけで、一覧の組み立て自体は buildDraftCopyText（「すべてコピー」と同じ関数）を
 * 再利用する（二重実装を避ける。SR-24）。
 */
export function renderDraftToolbarExtra(ns: string): string {
  return (
    '<span class="draft-toolbar" id="draft-toolbar" style="display:none;">' +
    '<span class="draft-count-chip" id="draft-count-chip">下書き 0 件</span>' +
    `<button type="button" class="draft-preview-btn" ${nsHandlerAttr(ns, "onclick", "toggleDraftPreview();")}>💬 プレビュー</button>` +
    `<button type="button" class="draft-copy-btn" ${nsHandlerAttr(ns, "onclick", "copyAllDrafts();")}>📋 すべてコピー</button>` +
    `<button type="button" class="draft-clear-btn" ${nsHandlerAttr(ns, "onclick", "clearAllDrafts();")}>クリア</button>` +
    '<span class="draft-status" id="draft-status" aria-live="polite"></span>' +
    "</span>"
  );
}

/**
 * 下書きプレビューのフローティングパネル（施主指示「オフラインレビューした内容を
 * プレビューできるように」）。
 * 内容（レコードID・判定・コメント・質問）は開くたびに buildDraftCopyText() の出力
 * （＝「すべてコピー」と同一のテキスト）を #draft-preview-body にそのまま差し込むだけで、
 * 一覧の組み立てロジックを別に持たない。既定 display:none（tree/guided 双方の
 * ページ全体で1個だけ。オンライン時は開くボタン自体が隠れているため実質開かれない）。
 * パネル内にも「コピー」ボタンを持つ（copyAllDrafts を再利用。結果は既存の
 * #draft-status に表示される）。
 */
export function renderDraftPreviewPanel(ns: string): string {
  return (
    '<div class="draft-preview-panel" id="draft-preview-panel" style="display:none;" aria-hidden="true">' +
    '<div class="draft-preview-header">' +
    '<span class="draft-preview-title">💬 レビュー結果（下書きプレビュー）</span>' +
    `<button type="button" class="draft-preview-close" ${nsHandlerAttr(ns, "onclick", "closeDraftPreview();")} aria-label="閉じる">×</button>` +
    "</div>" +
    '<pre class="draft-preview-body" id="draft-preview-body"></pre>' +
    '<div class="draft-preview-actions">' +
    `<button type="button" class="draft-preview-copy-btn" ${nsHandlerAttr(ns, "onclick", "copyAllDrafts();")}>📋 コピー</button>` +
    "</div>" +
    "</div>"
  );
}

/**
 * 下書きモードの必読の注意書き（送信されないこと・「すべてコピー」で回収すること）と、
 * localStorage が使えない環境向けの代替メッセージ。生成 HTML には常に両方のマークアップを
 * 出力し、どちらを見せるかは initDraftMode が実行時に window.__REVIEW_ENDPOINT__ の有無・
 * localStorage の可否を見て出し分ける（決定性維持。file:// 単体閲覧でも markup 自体は
 * 変わらない）。data-project-id/data-version/data-date は「すべてコピー」出力の対象表記
 * （プロジェクト識別子・正本の版・生成日）に実行時 JS が使う。
 */
export function renderDraftNoticeBlock(meta: ProjectMeta): string {
  return (
    `<div class="draft-notice" id="draft-notice" style="display:none;" data-project-id="${esc(meta.projectId)}" data-version="${esc(meta.version)}" data-date="${esc(meta.date)}">` +
    "<p>これはオフライン下書きモードです。入力はこのブラウザ内にのみ保存されます。サーバや正本には送信されません。" +
    "レビューが済んだら「📋 すべてコピー」で施主に渡してください。</p>" +
    "</div>" +
    '<div class="draft-unavailable-notice" id="draft-unavailable-notice" style="display:none;">' +
    "<p>このブラウザでは下書きを保存できません（プライベートモード等で localStorage が使えない可能性があります）。</p>" +
    "</div>"
  );
}

export const DRAFT_MODE_CSS = `.draft-notice { background: #fdf3e6; border: 1px solid #f1c98b; border-radius: 6px; padding: .7rem 1rem; margin: .8rem 0 1rem; font-size: .85rem; color: #7a4a00; }
.draft-unavailable-notice { background: #f9dedb; border: 1px solid #eab8b0; border-radius: 6px; padding: .7rem 1rem; margin: .8rem 0 1rem; font-size: .85rem; color: #a3271f; }
.draft-toolbar { display: inline-flex; align-items: center; gap: .5rem; }
.draft-count-chip { background: #EEEDFE; color: #534AB7; border-radius: 999px; padding: .2rem .7rem; font-size: .8rem; font-weight: bold; white-space: nowrap; }
.draft-copy-btn, .draft-clear-btn, .draft-preview-btn { font: inherit; padding: .3rem .8rem; border-radius: 5px; border: 1px solid #534AB7; background: #fff; color: #534AB7; cursor: pointer; }
.draft-copy-btn:hover, .draft-clear-btn:hover, .draft-preview-btn:hover { background: #EEEDFE; }
.draft-status { font-size: .8rem; color: #666; }
.draft-status-ok { color: #1e6b3c; }
.draft-status-error { color: #a3271f; }
.draft-preview-panel { position: fixed; right: 1.2rem; bottom: 1.2rem; width: min(420px, calc(100vw - 2.4rem)); max-height: min(70vh, 560px); background: #fff; border: 1px solid #534AB7; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.25); z-index: 70; flex-direction: column; overflow: hidden; }
.draft-preview-header { display: flex; align-items: center; justify-content: space-between; gap: .6rem; padding: .55rem .8rem; background: #534AB7; color: #fff; }
.draft-preview-title { font-size: .85rem; font-weight: bold; }
.draft-preview-close { border: none; background: none; color: #fff; font-size: 1.1rem; line-height: 1; cursor: pointer; padding: .1rem .5rem; border-radius: 4px; }
.draft-preview-close:hover { background: rgba(255,255,255,.2); }
.draft-preview-body { flex: 1 1 auto; margin: 0; padding: .8rem; overflow-y: auto; white-space: pre-wrap; font-family: "Hiragino Sans", "Yu Gothic", sans-serif; font-size: .8rem; color: #222; background: #fafafa; }
.draft-preview-actions { flex: 0 0 auto; padding: .5rem .8rem; border-top: 1px solid #e2dff5; display: flex; justify-content: flex-end; }
.draft-preview-copy-btn { font: inherit; padding: .3rem .8rem; border-radius: 5px; border: 1px solid #534AB7; background: #fff; color: #534AB7; cursor: pointer; }
.draft-preview-copy-btn:hover { background: #EEEDFE; }
`;

/**
 * SOL-37 下書きモードの JS 本体。tree（詳細モーダル内の .review-box）・guided
 * （スライド内の .review-box）は同一のクラス名・フィールド構造（.review-comment /
 * .review-questions / 判定ラジオ / .review-status）を持つため、この一式をそのまま
 * 両ビューの JS テンプレートへ埋め込んで共有する（二重実装を避ける。SR-24）。
 *
 * すべて `function` 宣言（トップレベルで巻き上げられる）のため、埋め込み位置は
 * JS テンプレート内のどこでもよい（両ビューとも既存 IIFE の直後に追記し、IIFE 内から
 * `initReviewUI();` の直後で `initDraftMode();` を呼ぶ）。fetch は一切呼ばない
 * （送信しないことがこのモードの前提。既存の reviewFetch 経由の1箇所ガードは変えない）。
 */
export const DRAFT_MODE_JS = `var DRAFT_VERDICT_LABEL_JA = { approve: '承認', reject: '却下', hold: '保留' };
function draftMeta() {
  var el = byId('draft-notice');
  return {
    projectId: el ? (el.getAttribute('data-project-id') || '') : '',
    version: el ? (el.getAttribute('data-version') || '') : '',
    date: el ? (el.getAttribute('data-date') || '') : '',
  };
}
function draftKey(id) {
  return 'reqdraft:' + draftMeta().projectId + ':' + id;
}
function draftReviewerKey() {
  return 'reqdraft:' + draftMeta().projectId + ':__reviewer';
}
function draftLocalStorageAvailable() {
  try {
    var probeKey = '__reqdraft_probe__';
    localStorage.setItem(probeKey, '1');
    localStorage.removeItem(probeKey);
    return true;
  } catch (e) {
    return false;
  }
}
// SOL-38 の postMessage ストレージブリッジ（ADR-012。srcdoc iframe 間で localStorage を
// 橋渡しするための仕組み）は ADR-013（単一ドキュメント化）で iframe 自体を廃止したため
// 削除した。tree/guided/document は常に同一 window・同一 localStorage を共有するため、
// 子ビュー側の橋渡しは元より不要（段階1申し送り事項1）。以降は localStorage への
// 直接アクセスのみ。
function loadDraftItem(id) {
  var raw = null;
  try { raw = localStorage.getItem(draftKey(id)); } catch (e) {}
  if (!raw) { return null; }
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function saveDraftItem(id, data) {
  var key = draftKey(id);
  try {
    localStorage.setItem(key, JSON.stringify(data));
    return true;
  } catch (e) {
    return false;
  }
}
function clearDraftItem(id) {
  var key = draftKey(id);
  try { localStorage.removeItem(key); } catch (e) {}
}
function collectReviewBoxIds() {
  var ids = [];
  ROOT.querySelectorAll('.review-box[data-id]').forEach(function (box) {
    ids.push(box.getAttribute('data-id'));
  });
  return ids;
}
function readReviewBoxState(box) {
  var verdictEl = box.querySelector('input[type="radio"]:checked');
  var commentEl = box.querySelector('.review-comment');
  var questionsEl = box.querySelector('.review-questions');
  return {
    verdict: verdictEl ? verdictEl.value : null,
    comment: commentEl ? commentEl.value : '',
    questions: questionsEl ? questionsEl.value : '',
  };
}
function isDraftEmpty(d) {
  if (!d) { return true; }
  var hasComment = typeof d.comment === 'string' && d.comment.trim() !== '';
  var hasQuestions = typeof d.questions === 'string' && d.questions.trim() !== '';
  return !d.verdict && !hasComment && !hasQuestions;
}
function saveDraftFromBox(id) {
  var box = ROOT.querySelector('.review-box[data-id="' + id + '"]');
  if (!box) { return; }
  var statusEl = box.querySelector('.review-status');
  var data = readReviewBoxState(box);
  if (isDraftEmpty(data)) {
    clearDraftItem(id);
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'review-status'; }
  } else {
    var ok = saveDraftItem(id, data);
    if (statusEl) {
      statusEl.textContent = ok ? '下書きを保存しました。' : 'このブラウザでは下書きを保存できません。';
      statusEl.className = ok ? 'review-status review-status-ok' : 'review-status review-status-error';
    }
  }
  refreshDraftCount();
}
function restoreDraftToBox(id) {
  var box = ROOT.querySelector('.review-box[data-id="' + id + '"]');
  if (!box) { return; }
  var data = loadDraftItem(id);
  if (!data) { return; }
  if (data.verdict) {
    var radio = box.querySelector('input[type="radio"][value="' + data.verdict + '"]');
    if (radio) { radio.checked = true; }
  }
  var commentEl = box.querySelector('.review-comment');
  if (commentEl && typeof data.comment === 'string') { commentEl.value = data.comment; }
  var questionsEl = box.querySelector('.review-questions');
  if (questionsEl && typeof data.questions === 'string') { questionsEl.value = data.questions; }
  var statusEl = box.querySelector('.review-status');
  if (statusEl) { statusEl.textContent = '保存済みの下書きを復元しました。'; statusEl.className = 'review-status review-status-ok'; }
}
function refreshDraftCount() {
  var ids = collectReviewBoxIds();
  var count = 0;
  ids.forEach(function (id) { if (loadDraftItem(id)) { count += 1; } });
  var chip = byId('draft-count-chip');
  if (chip) { chip.textContent = '下書き ' + count + ' 件'; }
  return count;
}
function getDraftReviewerName() {
  var el = byId('review-reviewer-input');
  return el ? el.value.trim() : '';
}
function saveDraftReviewerName() {
  var key = draftReviewerKey();
  var value = getDraftReviewerName();
  try { localStorage.setItem(key, value); } catch (e) {}
}
function restoreDraftReviewerName() {
  var el = byId('review-reviewer-input');
  if (!el) { return; }
  var key = draftReviewerKey();
  var stored = '';
  try { stored = localStorage.getItem(key) || ''; } catch (e) {}
  el.value = stored;
}
function clearDraftReviewerName() {
  var key = draftReviewerKey();
  try { localStorage.removeItem(key); } catch (e) {}
}
function buildDraftCopyText() {
  var meta = draftMeta();
  var reviewer = getDraftReviewerName();
  var lines = [];
  lines.push('# レビュー結果（オフライン下書き）');
  lines.push('対象: ' + meta.projectId + ' ' + meta.version + '（生成 ' + meta.date + '）');
  lines.push('レビュアー: ' + (reviewer || '（未記名）'));
  var ids = collectReviewBoxIds();
  var any = false;
  ids.forEach(function (id) {
    var d = loadDraftItem(id);
    if (!d) { return; }
    any = true;
    lines.push('');
    lines.push('## ' + id);
    lines.push('判定: ' + (d.verdict ? (DRAFT_VERDICT_LABEL_JA[d.verdict] || d.verdict) : '（なし）'));
    lines.push('コメント: ' + (d.comment || ''));
    lines.push('質問: ' + (d.questions || ''));
  });
  if (!any) {
    lines.push('');
    lines.push('（下書きはまだありません）');
  }
  return lines.join('\\n');
}
function draftCopyFallback(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
function reportDraftCopyResult(ok) {
  var statusEl = byId('draft-status');
  if (!statusEl) { return; }
  statusEl.textContent = ok ? 'コピーしました。' : 'コピーに失敗しました。表示されたテキストを選択してコピーしてください。';
  statusEl.className = ok ? 'draft-status draft-status-ok' : 'draft-status draft-status-error';
}
function copyAllDrafts() {
  var text = buildDraftCopyText();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      reportDraftCopyResult(true);
    }).catch(function () {
      reportDraftCopyResult(draftCopyFallback(text));
    });
  } else {
    reportDraftCopyResult(draftCopyFallback(text));
  }
  return false;
}
// 下書きプレビュー（施主指示「オフラインレビューした内容をプレビューできるように」）。
// 一覧の組み立ては buildDraftCopyText() をそのまま使う（「すべてコピー」と同一テキスト。
// 二重実装を避ける。SR-24）。パネル自体は #draft-preview-panel（renderDraftPreviewPanel）。
function openDraftPreview() {
  var panel = byId('draft-preview-panel');
  var body = byId('draft-preview-body');
  if (body) { body.textContent = buildDraftCopyText(); }
  if (panel) {
    panel.style.display = 'flex';
    panel.setAttribute('aria-hidden', 'false');
  }
  return false;
}
function closeDraftPreview() {
  var panel = byId('draft-preview-panel');
  if (panel) {
    panel.style.display = 'none';
    panel.setAttribute('aria-hidden', 'true');
  }
  return false;
}
function toggleDraftPreview() {
  var panel = byId('draft-preview-panel');
  var isOpen = !!panel && panel.style.display !== 'none' && panel.style.display !== '';
  return isOpen ? closeDraftPreview() : openDraftPreview();
}
function clearAllDrafts() {
  var ids = collectReviewBoxIds();
  ids.forEach(function (id) {
    clearDraftItem(id);
    var box = ROOT.querySelector('.review-box[data-id="' + id + '"]');
    if (!box) { return; }
    box.querySelectorAll('input[type="radio"]').forEach(function (r) { r.checked = false; });
    var commentEl = box.querySelector('.review-comment');
    if (commentEl) { commentEl.value = ''; }
    var questionsEl = box.querySelector('.review-questions');
    if (questionsEl) { questionsEl.value = ''; }
    var statusEl = box.querySelector('.review-status');
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'review-status'; }
  });
  clearDraftReviewerName();
  var reviewerInput = byId('review-reviewer-input');
  if (reviewerInput) { reviewerInput.value = ''; }
  refreshDraftCount();
  var previewPanel = byId('draft-preview-panel');
  if (previewPanel && previewPanel.style.display !== 'none' && previewPanel.style.display !== '') {
    openDraftPreview();
  }
  var statusEl2 = byId('draft-status');
  if (statusEl2) { statusEl2.textContent = 'すべての下書きを削除しました。'; statusEl2.className = 'draft-status'; }
  return false;
}
function initDraftMode() {
  var enabled = typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '';
  if (enabled) { return; }
  if (draftLocalStorageAvailable()) {
    activateDraftUi();
    return;
  }
  // ADR-013 で iframe（バンドルの srcdoc）を廃止したため、自身の localStorage が使えない
  // ときのブリッジ・フォールバック（SOL-38 / ADR-012）は削除した（段階1申し送り事項1）。
  // localStorage が使えない場合は明示エラーのみを表示する。
  var unavailable = byId('draft-unavailable-notice');
  if (unavailable) { unavailable.style.display = ''; }
}
function activateDraftUi() {
  var notice = byId('draft-notice');
  var toolbar = byId('draft-toolbar');
  if (notice) { notice.style.display = ''; }
  if (toolbar) { toolbar.style.display = ''; }
  var toolbarNote = byId('review-toolbar-note');
  // 施主指示 2026-08-04:「下書きモード（送信されません）」→「オフラインモード」。
  // 「送信されません」の注記はここでは繰り返さない。同じ画面に出る必読の注意書き
  // （draft-notice、この関数が表示している）が送信されないことを既に述べており、
  // ツールバーの短いラベルで二重に言う必要がない。
  if (toolbarNote) { toolbarNote.textContent = 'オフラインモード'; }
  restoreDraftReviewerName();
  var reviewerInput = byId('review-reviewer-input');
  if (reviewerInput) {
    reviewerInput.disabled = false;
    reviewerInput.addEventListener('input', saveDraftReviewerName);
  }
  ROOT.querySelectorAll('.review-box').forEach(function (box) {
    var id = box.getAttribute('data-id');
    box.querySelectorAll('input, textarea').forEach(function (el) { el.disabled = false; });
    var submitBtn = box.querySelector('.review-submit');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '下書き保存';
    }
    var readonlyNote = box.querySelector('.review-readonly-note');
    if (readonlyNote) {
      readonlyNote.textContent = 'この判定・コメントはこのブラウザ内にのみ保存されます（下書き）。送信されません。';
    }
    restoreDraftToBox(id);
    box.querySelectorAll('.review-comment, .review-questions').forEach(function (el) {
      el.addEventListener('input', function () { saveDraftFromBox(id); });
    });
    box.querySelectorAll('input[type="radio"]').forEach(function (el) {
      el.addEventListener('change', function () { saveDraftFromBox(id); });
    });
  });
  refreshDraftCount();
}
`;

// ---------------------------------------------------------------------------
// サーバ接続 heartbeat と切断モーダル（SOL-51 / SR-60）。tree・guided の両ビュー
// （一時サーバ配信時に判定 UI を持つ2ビュー。document ビューは読み取り専用のため対象外）が
// 共有する。既存の GET /・/guided・/document は正本の再生成を伴うため heartbeat には使わず、
// req_review_serve.ts に新設する軽量な GET /ping（200 を即返すだけ）を使う。
// window.__REVIEW_ENDPOINT__ 未注入（file:// 単体閲覧・静的バンドル）では起動しない
// （既存の initReviewUI() の有効/無効判定と同じガード条件）。判定 UI 自体は disabled 化
// しない（SOL-51 rationale: 再接続後にそのまま送信できるようにするため）。
// ---------------------------------------------------------------------------

/** 切断モーダルの markup。tree・guided それぞれの body 組み立てで1回だけ push する。 */
export function renderConnectionLostModal(): string {
  return (
    '<div class="conn-lost-overlay" id="conn-lost-overlay" role="alertdialog" aria-hidden="true">' +
    '<div class="conn-lost-modal">' +
    "<h2>サーバとの接続が切れています</h2>" +
    '<p id="conn-lost-message">レビューサーバ（req_review_serve.ts）への接続が確認できません。判定操作を行っても送信されません。</p>' +
    '<p class="conn-lost-note" id="conn-lost-note">接続が復旧すると自動的に閉じます。</p>' +
    "</div></div>"
  );
}

export const HEARTBEAT_CSS = `.conn-lost-overlay { position: fixed; inset: 0; background: rgba(20,15,40,.45); display: none; align-items: center; justify-content: center; z-index: 200; }
.conn-lost-overlay.show { display: flex; }
.conn-lost-modal { background: #fff; border-radius: 10px; padding: 1.4rem 1.6rem; max-width: 26rem; box-shadow: 0 12px 40px rgba(0,0,0,.3); text-align: center; }
.conn-lost-modal h2 { margin: 0 0 .6rem; font-size: 1.05rem; color: #a3271f; }
.conn-lost-modal p { margin: .4rem 0; font-size: .88rem; color: #333; }
.conn-lost-note { color: #666; font-size: .8rem; }
`;

/**
 * heartbeat 本体（SOL-51）。5秒ごとに GET /ping を叩き、成功（2xx）ならモーダルを閉じ、
 * 失敗（ネットワークエラー・非2xx）なら開く。window.__REVIEW_ENDPOINT__ 未注入のときは
 * 何もしない（file:// 単体閲覧・静的バンドルには対象サーバが無い）。fetch は既存の
 * reviewFetch（window.__REVIEW_ENDPOINT__ の存在チェックでガード済みの唯一の fetch 呼び出し
 * 箇所。tree・guided 各ビューが自分の IIFE 内で定義済み）を再利用する——新たに生の fetch
 * 呼び出しを増やさない（「fetch( の呼び出しはガード付きの1箇所だけ」という file:// 安全性の
 * 既存不変条件を保つ。SR-24）。tree・guided 両ビューの既存 IIFE へそのまま埋め込んで共有する
 * （DRAFT_MODE_JS と同じ埋め込みパターン。二重実装しない）。
 */
export const HEARTBEAT_JS = `var HEARTBEAT_INTERVAL_MS = 5000;
var heartbeatTimer = null;
// 切断モーダルは2つの文面を持つ（施主指示 2026-08-08）。
//   'heartbeat' — 背景監視（pingOnce）が検出した切断。一時的な瞬断の可能性があるため
//                 「接続が復旧すると自動的に閉じます」と案内する（既定）。
//   'explicit'  — 明示送信（確認チェック・却下/保留の送信・一括確認）が実際に失敗して
//                 初めて分かる切断。サーバ自体が終了している確度が高いため、復旧を
//                 期待させず「このタブを閉じてください」と案内する。
// 一度 'explicit' になったら、以後の 'heartbeat' 側の失敗表示では上書きしない
// （復旧を待たせる文面へ後退させない）。閉じるのは pingOnce の成功時のみ
// （明示送信からの成功では呼ばない——この関数は heartbeat の成否だけを見る）。
var connLostMode = null;
function showConnectionLostModal(mode) {
  mode = (mode === 'explicit') ? 'explicit' : 'heartbeat';
  if (connLostMode === 'explicit') { mode = 'explicit'; }
  connLostMode = mode;
  var messageEl = byId('conn-lost-message');
  var noteEl = byId('conn-lost-note');
  if (messageEl) {
    messageEl.textContent = (mode === 'explicit')
      ? 'サーバとの接続が切れました。このタブを閉じてください。'
      : 'レビューサーバ（req_review_serve.ts）への接続が確認できません。判定操作を行っても送信されません。';
  }
  if (noteEl) { noteEl.style.display = (mode === 'explicit') ? 'none' : ''; }
  var el = byId('conn-lost-overlay');
  if (el) { el.classList.add('show'); el.setAttribute('aria-hidden', 'false'); }
}
function hideConnectionLostModal() {
  connLostMode = null;
  var el = byId('conn-lost-overlay');
  if (el) { el.classList.remove('show'); el.setAttribute('aria-hidden', 'true'); }
}
function pingOnce() {
  reviewFetch('/ping', { method: 'GET', cache: 'no-store' }).then(function (res) {
    if (res.ok) { hideConnectionLostModal(); } else { showConnectionLostModal('heartbeat'); }
  }).catch(function () { showConnectionLostModal('heartbeat'); });
}
function initHeartbeat() {
  if (!(typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '')) { return; }
  if (heartbeatTimer) { return; }
  heartbeatTimer = setInterval(pingOnce, HEARTBEAT_INTERVAL_MS);
}
`;

/**
 * バンドル（SOL-38 / ADR-013）でのビュー切替 JS。req_bundle.ts のシェルが定義する
 * window.__reqBundleGo（同一 window。iframe 不使用のため postMessage は不要）の存在
 * だけで有効化を判定する（ADR-012 時代の window.__REQ_BUNDLE_VIEW__ 注入は iframe の
 * srcdoc 先頭に文字列挿入する仕組みだったため、単一ドキュメント化に伴い廃止した。
 * window.__reqBundleGo が定義されているのはバンドルのシェル JS が実行された後だけであり、
 * 追加の判定フラグは不要——サーバ配信（window.__REVIEW_ENDPOINT__ あり）でも file://
 * 単体閲覧でも window.__reqBundleGo は定義されないため、この1点のチェックで十分）。
 *
 * 有効時は既存の `.view-tabs`（renderReviewTopbar が生成する3タブ。href は
 * `/`・`/guided`・`/document` のまま不変）を表示し、クリックを preventDefault して
 * window.__reqBundleGo(pane) を直接呼ぶ（同一 window の関数呼び出し。ADR-013 段階3の
 * シェルが display 切替→activate() の順序を保証する）。href→バンドルの pane id への
 * 対応はここに集約する（二重実装を避ける。SR-24）。
 *
 * tree/guided/document の3ビューとも initReviewUI() の直後にこの initBundleNav() を
 * 呼ぶ（initReviewUI() が .view-tabs を非表示にした後に、バンドル時だけ上書きで
 * 表示する。順序が重要）。
 */
export const BUNDLE_NAV_JS = `function bundleNavPaneForHref(href) {
  if (href === '/') { return 'tree'; }
  if (href === '/guided') { return 'guided'; }
  if (href === '/document') { return 'doc'; }
  return null;
}
function initBundleNav() {
  if (typeof window.__reqBundleGo !== 'function') { return; }
  ROOT.querySelectorAll('.view-tabs').forEach(function (nav) {
    nav.style.display = '';
    nav.querySelectorAll('a[href]').forEach(function (a) {
      var pane = bundleNavPaneForHref(a.getAttribute('href'));
      // バンドルに存在しないビュー（イシュービュー。SOL-54 (h) でバンドル対象外）のタブは
      // 押しても行き先が無いため、バンドルでは出さない（死にリンクを見せない）。
      if (pane === null) { a.style.display = 'none'; return; }
      a.addEventListener('click', function (e) {
        e.preventDefault();
        window.__reqBundleGo(pane);
      });
    });
  });
}
`;

/**
 * `title="…"` 属性そのもの（前置スペース込み）。定義文が無ければ空文字列を返し、
 * 呼び出し側は他の属性と単純に文字列連結するだけで良い（SEC 等は title を出さない）。
 */
export function kindTitleAttr(kind: string | null | undefined): string {
  const def = kindDefinition(kind);
  return def ? ` title="${esc(def)}"` : "";
}

const CSS = `* { box-sizing: border-box; }
html, body { margin: 0; }
body { font-family: "Hiragino Sans", "Yu Gothic", sans-serif; line-height: 1.7; color: #222; }
/* ヘッダ（.site-header）の左右余白は REVIEW_TOPBAR_CSS 側で自己完結させ、body の padding には
   依存させない（3ビューで同じ位置に揃えるため。SOL-32 追補）。本文側の左右余白・下端の
   余白は .page-content が引き継ぐ。 */
.page-content { padding: 0 1.4rem 2rem; }
h1 { font-size: 1.1rem; border-bottom: 2px solid #534AB7; padding-bottom: .5rem; margin-top: 0; }
h2 { font-size: 1.2rem; margin-top: 0; }
h3 { font-size: 1rem; margin-top: 1.4rem; border-left: 4px solid #534AB7; padding-left: .5rem; }
.meta { color: #666; font-size: .85rem; }
.legend { background: #f0eefc; border-radius: 6px; padding: .7rem 1rem; font-size: .8rem; margin: .8rem 0 1rem; }
.legend summary { cursor: pointer; font-weight: bold; color: #534AB7; }
.legend ul { margin: .5rem 0 0; padding-left: 1.2rem; }
.trace-overlay { position: fixed; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: 40; overflow: hidden; }
.overlay-edge { fill: none; }
.overlay-edge-up { stroke: #e67e22; stroke-width: 2; }
.overlay-edge-down { stroke: #e67e22; stroke-width: 2; stroke-dasharray: 6,4; }
.layout { display: flex; align-items: flex-start; }
.review-filter-bar { display: flex; align-items: center; gap: .8rem; margin: .3rem 0 .6rem; font-size: .85rem; }
.review-filter-bar label { cursor: pointer; user-select: none; }
${REVIEW_TOPBAR_CSS}
${DRAFT_MODE_CSS}
${HEARTBEAT_CSS}
.review-box { margin-top: 1.4rem; padding-top: .9rem; border-top: 1px solid #e2dff5; }
.review-box h3 { margin-top: 0; }
.review-box .review-readonly-note { margin: 0 0 .6rem; }
.review-verdict-group { border: 1px solid #ddd; border-radius: 6px; padding: .4rem .7rem .5rem; margin: 0 0 .6rem; }
.review-verdict-group legend { font-size: .78rem; color: #666; padding: 0 .3rem; }
.review-verdict-group label { margin-right: 1rem; cursor: pointer; }
.review-field-label { display: block; font-size: .82rem; color: #666; margin: .5rem 0 .2rem; }
.review-box textarea { width: 100%; box-sizing: border-box; font: inherit; padding: .4rem .6rem; border: 1px solid #ccc; border-radius: 5px; resize: vertical; }
.review-actions { display: flex; align-items: center; gap: .7rem; margin-top: .6rem; }
.review-submit { font: inherit; padding: .35rem 1rem; border-radius: 5px; border: 1px solid #534AB7; background: #534AB7; color: #fff; cursor: pointer; }
.review-submit:disabled { opacity: .4; cursor: not-allowed; }
.review-status { font-size: .82rem; color: #666; }
.review-status-ok { color: #1e6b3c; }
.review-status-error { color: #a3271f; }
.board { width: 100%; display: flex; flex-direction: row; align-items: flex-start; max-height: 82vh; overflow-x: auto; overflow-y: hidden; margin: 1rem 0 1.4rem; padding-bottom: .4rem; }
.board.review-filter-on .node:not(.col-heading):not(.is-review-required) { display: none; }
.divider { flex: 0 0 10px; align-self: stretch; cursor: col-resize; position: relative; }
.divider::before { content: ""; position: absolute; left: 4px; top: .3rem; bottom: .3rem; width: 2px; border-radius: 1px; background: #ddd; }
.divider:hover::before, .divider.dragging::before { background: #534AB7; }
.divider.disabled { cursor: default; pointer-events: none; }
.divider.disabled::before { background: transparent; }
.column { position: relative; flex: 1 1 0; min-width: 9rem; max-height: 82vh; display: flex; flex-direction: column; background: #fafafa; border: 1px solid #eee; border-radius: 8px; }
.column.collapsed { flex: 0 0 2.2rem !important; min-width: 2.2rem !important; max-width: 2.2rem !important; }
.column-collapsed-bar { display: none; }
.column.collapsed .column-collapsed-bar { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: .5rem; height: 100%; min-height: 6rem; padding: .7rem .2rem; cursor: pointer; color: #534AB7; font-size: .8rem; }
.column.collapsed .column-collapsed-bar:hover { background: #EEEDFE; }
.column.collapsed .column-collapsed-bar.has-trace { box-shadow: inset 0 -4px 0 0 #e67e22; }
.column.collapsed .column-inner { display: none; }
.collapsed-toggle-icon { flex: 0 0 auto; font-size: .7rem; }
.collapsed-label { flex: 0 0 auto; writing-mode: vertical-rl; text-orientation: mixed; }
.column-inner { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
.column-head { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: baseline; gap: .3rem; padding: .7rem .8rem .5rem; border-bottom: 1px solid #e2dff5; }
.col-head-main { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: .3rem; }
.col-toggle { flex: 0 0 auto; border: none; background: none; cursor: pointer; color: #534AB7; font-size: .8rem; padding: 0 .2rem 0 0; line-height: 1; }
.col-toggle:hover { color: #322c73; }
.col-label { font-size: .88rem; margin: 0; color: #534AB7; min-width: 0; }
.col-count { margin: .3rem 0 0; font-size: .72rem; color: #666; }
.column-head .col-count { margin: 0 0 0 auto; }
.col-def { flex: 1 0 100%; margin: .2rem 0 0; font-size: .72rem; color: #666; line-height: 1.35; }
.column-body { flex: 1 1 auto; overflow-y: auto; padding: .6rem .8rem .8rem; min-height: 0; }
.subgroup { margin: 0 0 1rem; }
.subgroup:last-child { margin-bottom: 0; }
.sub-count { margin: .15rem 0 .3rem; }
.subgroup-body { padding-left: .9rem; }
.axes-group { margin: 0 0 .7rem; padding-left: .5rem; border-left: 2px solid #e2dff5; }
.axes-group:last-child { margin-bottom: 0; }
.axes-group-label { margin: 0 0 .2rem; font-size: .8rem; font-weight: bold; color: #534AB7; }
.axes-group-count { margin-left: .35rem; font-size: .68rem; font-weight: normal; color: #888; }
.axes-group-fallback { border-left-color: #ddd; }
.axes-group-fallback .axes-group-label { color: #888; font-weight: normal; font-style: italic; }
.axes-group-body { padding-left: .8rem; }
.tree, .tree ul { list-style: none; margin: 0; padding-left: 1.1rem; }
.tree { padding-left: 0; }
.tree li { margin: .25rem 0; }
.node { position: relative; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; border-left: 2px solid #cfcbe8; padding: .15rem .5rem; border-radius: 3px; text-decoration: none; color: inherit; }
.node:hover { background: #EEEDFE; }
.node.selected { background: #534AB7; border-left-color: #534AB7; }
.node.selected .id, .node.selected .kind-badge, .node.selected .title { color: #fff; }
.node.selected .kind-badge { background: rgba(255,255,255,.25); }
.node.trace-hl-up, .node.trace-hl-down { background: #fff6ec; border-left-color: #e67e22; box-shadow: inset 0 0 0 1px #e67e22; }
.node.trace-hl-up { border-left-style: solid; }
.node.trace-hl-down { border-left-style: dashed; }
.node.trace-hl-up::after, .node.trace-hl-down::after { position: absolute; top: 0; right: .3rem; font-size: .72rem; font-weight: bold; color: #e67e22; line-height: 1.55; }
.node.trace-hl-up::after { content: "↑"; }
.node.trace-hl-down::after { content: "↓"; }
.col-heading { margin-bottom: .1rem; }
.id { font-family: monospace; font-weight: bold; color: #534AB7; }
.kind-badge { display: inline-block; font-size: .68rem; font-family: monospace; background: #EEEDFE; color: #534AB7; border-radius: 4px; padding: .05rem .35rem; margin-left: .35rem; }
.review-badge { display: inline-block; font-size: .68rem; font-weight: bold; background: #fbefd3; color: #8a5a00; border-radius: 4px; padding: .05rem .35rem; margin-left: .35rem; }
.title { margin-left: .4rem; font-size: .92rem; }
.also-marker { margin-left: .3rem; font-size: .75rem; color: #a99fe0; cursor: help; }
.also-marker-in { color: #7c9e6a; }
.modal-backdrop { display: none; position: fixed; inset: 0; z-index: 60; align-items: center; justify-content: center; background: rgba(24,20,40,.5); padding: 2rem 1rem; overflow: auto; }
.modal-backdrop.open { display: flex; }
.detail-panel { display: none; position: relative; background: #fff; border: 1px solid #534AB7; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.3); padding: .9rem 1.1rem 1.3rem; margin: 0; overflow: auto; max-height: 85vh; max-width: 48rem; width: 100%; }
.detail-panel.active { display: block; }
.detail-panel:focus { outline: none; }
.detail-close { position: absolute; top: .5rem; right: .6rem; border: none; background: none; font-size: 1.15rem; line-height: 1; cursor: pointer; color: #534AB7; padding: .2rem .55rem; border-radius: 4px; }
.detail-close:hover { background: #EEEDFE; }
.detail-title { margin-left: .5rem; }
.chip-row { display: flex; flex-wrap: wrap; gap: .35rem; margin: .5rem 0; }
.chip { display: inline-flex; align-items: baseline; gap: .3rem; font-size: .78rem; padding: .18rem .6rem; border-radius: 999px; white-space: nowrap; }
.chip-green { background: #e3f3e6; color: #1e6b3c; }
.chip-amber { background: #fbefd3; color: #8a5a00; }
.chip-red { background: #f9dedb; color: #a3271f; }
.chip-gray { background: #ececec; color: #555; }
.chip-purple { background: #ece9fb; color: #534AB7; }
.chip-axis { background: #eeeaff; color: #443f8a; }
.chip-axis.chip-dimmed { background: #f5f4fb; color: #9891c4; }
.rel { margin: 1rem 0; }
.rel p { margin: .3rem 0; }
.also-belongs { display: block; margin: .25rem 0; padding: .25rem .6rem; border: 1px dashed #a99fe0; border-radius: 4px; font-style: italic; color: #534AB7; font-size: .85rem; background: #faf9ff; max-width: 42rem; }
.reflink { color: #534AB7; text-decoration: underline; }
.body-text { white-space: pre-wrap; background: #f8f8f8; border: 1px solid #eee; border-radius: 4px; padding: .8rem 1rem; font-family: "Hiragino Sans", "Yu Gothic", sans-serif; font-size: .92rem; }
.confidence-note { font-size: .82rem; color: #8a5a00; background: #fdf7ea; border: 1px solid #f1e2b8; border-radius: 4px; padding: .4rem .7rem; margin: .5rem 0; }
.md-body { font-size: .92rem; }
.md-body .md-heading { font-size: 1rem; margin: 1rem 0 .3rem; border-left: 3px solid #cfcbe8; padding-left: .5rem; }
.md-body .md-heading:first-child { margin-top: 0; }
.md-body p { margin: .5rem 0; }
.md-body ul, .md-body ol { margin: .4rem 0; padding-left: 1.3rem; }
.md-body li { margin: .2rem 0; }
.md-body code { background: #eae8f5; padding: .05rem .3rem; border-radius: 3px; font-size: .9em; }
.md-body pre.md-code { background: #f8f8f8; border: 1px solid #eee; border-radius: 4px; padding: .6rem .8rem; overflow-x: auto; font-size: .85rem; }
.md-body pre.md-code code { background: none; padding: 0; }
.md-body a { color: #534AB7; }
`;

const JS = `window.REQ_TREE = (function () {
${REVIEW_NAV_JS}
var IDP = '';
var ROOT = document;
function byId(x) { return ROOT.querySelector('#' + IDP + CSS.escape(x)); }
// getComputedStyle(ROOT).display は ROOT 自身に指定された display の解決値であり、
// 祖先の display:none の影響を受けない（display は継承されず、祖先が非表示でも子要素
// 自身の display の計算値は変わらない）。バンドル（段階3）では ROOT（rootClass の
// 自己ラップ div）の外側にシェルの表示切替 div（.reqview-pane）が入るため、
// getComputedStyle(ROOT).display での判定は非表示ペインでも常に true を返してしまい、
// resize/scroll/keydown のガード（activate() が存在する理由そのもの）が効かなくなる。
// getClientRects().length はレンダリングされたボックスの実在を見るため、自身または
// 祖先いずれの display:none も正しく反映する。
function rootIsVisible() { return IDP === '' || ROOT.getClientRects().length > 0; }
var hoveredTraceId = null;
// 依存矢印・カード枠ハイライトの描画は selectNode（クリック=モーダル開閉）から分離した
// （施主指示 2026-07-20「依存矢印はホバーで再描画」）。highlightTraces(id) が実際の
// ハイライト計算＋折りたたみ帯マーカー更新＋オーバーレイ再描画予約を担い、hover
// （一時プレビュー）と click（selectNode。固定表示）の両方から呼ぶ。
function highlightTraces(id) {
  var clicked = ROOT.querySelector('.node[data-id="' + id + '"]');
  var tracesTo = [];
  if (clicked) {
    try { tracesTo = JSON.parse(clicked.getAttribute('data-traces-to') || '[]'); } catch (e) {}
  }
  ROOT.querySelectorAll('.node').forEach(function (n) {
    n.classList.remove('trace-hl-up', 'trace-hl-down');
    var nid = n.getAttribute('data-id');
    if (nid === id) { return; }
    if (tracesTo.indexOf(nid) !== -1) { n.classList.add('trace-hl-up'); }
    var own = [];
    try { own = JSON.parse(n.getAttribute('data-traces-to') || '[]'); } catch (e) {}
    if (own.indexOf(id) !== -1) { n.classList.add('trace-hl-down'); }
  });
  updateCollapsedBandTraceMarkers();
  scheduleOverlayRedraw();
}
function clearTraces() {
  ROOT.querySelectorAll('.node').forEach(function (n) { n.classList.remove('trace-hl-up', 'trace-hl-down'); });
  updateCollapsedBandTraceMarkers();
  scheduleOverlayRedraw();
}
// hover（一時プレビュー）優先、なければクリックで選択中（sticky）のカード。
// redrawTraceOverlay が「今どのカードの矢印を描くか」を決めるのに使う。
function currentTraceId() {
  if (hoveredTraceId) { return hoveredTraceId; }
  var sel = ROOT.querySelector('.node.selected');
  return sel ? sel.getAttribute('data-id') : null;
}
function selectNode(id) {
  var panels = ROOT.querySelectorAll('.detail-panel');
  panels.forEach(function (p) { p.classList.remove('active'); });
  var target = byId('detail-' + id);
  if (target) {
    target.classList.add('active');
    openDetailModal();
    try { target.focus(); } catch (e) {}
  }
  ROOT.querySelectorAll('.node').forEach(function (n) {
    n.classList.toggle('selected', n.getAttribute('data-id') === id);
  });
  highlightTraces(id);
  return false;
}
// 右固定詳細ペイン廃止（施主裁定 2026-07-20）→ 中央モーダル表示（施主の方針変更
// 2026-07-20。当初はホバー/フォーカスのポップアップとして実装したが、クリックで開く
// モーダルに変更した）。#detail-modal-backdrop が画面全体を覆う半透明の backdrop で、
// selectNode が .detail-panel に active を付けたあとこれを開く。閉じてもボード上の
// 選択・トレースハイライトは残す（selectNode 自体はクリアしない）。
function openDetailModal() {
  var backdrop = byId('detail-modal-backdrop');
  if (backdrop) { backdrop.classList.add('open'); }
}
function closeDetailModal() {
  var backdrop = byId('detail-modal-backdrop');
  if (backdrop) { backdrop.classList.remove('open'); }
  ROOT.querySelectorAll('.detail-panel.active').forEach(function (p) { p.classList.remove('active'); });
  return false;
}
function toggleReviewFilter(checked) {
  var board = byId('req-board');
  if (board) { board.classList.toggle('review-filter-on', checked); }
  try { localStorage.setItem('reqtree:reviewFilter', checked ? '1' : '0'); } catch (e) {}
  scheduleOverlayRedraw();
  return false;
}
// ビュー上レビュー（SR-33 / ADR-007 / SOL-25）。一時サーバ配信時（req_review_serve.ts が
// GET / の応答に window.__REVIEW_ENDPOINT__ を注入する）だけ、ここから正本への書き戻しへ
// つながる POST を送る。file:// 単体閲覧では window.__REVIEW_ENDPOINT__ が存在しないため、
// このスクリプト内で外部通信を発生させる箇所は reviewFetch のみに集約し、その内部で必ず
// endpoint の有無を確認してから発生させる（endpoint が無ければ通信自体を起こさない）。
function reviewFetch(url, opts) {
  if (!window.__REVIEW_ENDPOINT__) { return Promise.reject(new Error('review endpoint is not available (file:// view)')); }
  return fetch(url, opts);
}
function getReviewerName() {
  var el = byId('review-reviewer-input');
  return el ? el.value.trim() : '';
}
function saveReviewerName() {
  try { localStorage.setItem('reqtree:reviewerName', getReviewerName()); } catch (e) {}
}
function submitReviewItem(id) {
  // SOL-37: エンドポイント未注入（file:// 単体閲覧）のときは下書きモード。送信ではなく
  // localStorage への保存に切り替える（オンライン時の以降の処理は一切変えない）。
  if (!(typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '')) {
    saveDraftFromBox(id);
    return false;
  }
  var box = ROOT.querySelector('.review-box[data-id="' + id + '"]');
  if (!box) { return false; }
  var statusEl = box.querySelector('.review-status');
  var verdictEl = box.querySelector('input[type="radio"]:checked');
  var verdict = verdictEl ? verdictEl.value : null;
  var reviewer = getReviewerName();
  if (!reviewer) { statusEl.textContent = 'レビュアー名（記名）を入力してください。'; statusEl.className = 'review-status review-status-error'; return false; }
  if (!verdict) { statusEl.textContent = '判定（承認/却下/保留）を選んでください。'; statusEl.className = 'review-status review-status-error'; return false; }
  var comment = box.querySelector('.review-comment').value;
  var questions = box.querySelector('.review-questions').value;
  statusEl.textContent = '送信中…';
  statusEl.className = 'review-status';
  reviewFetch(window.__REVIEW_ENDPOINT__, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer: reviewer, items: [{ id: id, verdict: verdict, comment: comment, questions: questions }] }),
  }).then(function (res) {
    return res.text().then(function (text) { return { ok: res.ok, text: text }; });
  }).then(function (result) {
    if (result.ok) {
      statusEl.textContent = '送信しました。';
      statusEl.className = 'review-status review-status-ok';
      setTimeout(function () { closeDetailModal(); }, 700);
    } else {
      var msg = '送信に失敗しました。';
      try {
        var parsed = JSON.parse(result.text);
        var firstResult = parsed && parsed.results ? parsed.results[0] : null;
        msg = (firstResult && firstResult.error) || parsed.error || msg;
      } catch (e) {}
      statusEl.textContent = msg;
      statusEl.className = 'review-status review-status-error';
    }
  }).catch(function (e) {
    statusEl.textContent = '通信に失敗しました: ' + e;
    statusEl.className = 'review-status review-status-error';
    // SOL-51 追記（施主指示 2026-08-08）: 明示送信（この判定送信）が実際に失敗して
    // 分かった切断は、背景の heartbeat とは別の文面（「このタブを閉じてください」）で
    // モーダル表示する（サーバ終了の確度が高いため、復旧を期待させない）。
    showConnectionLostModal('explicit');
  });
  return false;
}
// レビューの終了操作は持たない（施主裁定 2026-08-09。SR-61・SOL-52 改訂）。判定は送信の
// たびに正本へ書かれており、終了操作が運ぶ結果は無い。サーバの停止は起動元の端末で行う。
function initReviewUI() {
  var enabled = typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '';
  var reviewerInput = byId('review-reviewer-input');
  if (reviewerInput) {
    var stored = null;
    try { stored = localStorage.getItem('reqtree:reviewerName'); } catch (e) {}
    if (stored) { reviewerInput.value = stored; }
    reviewerInput.disabled = !enabled;
    reviewerInput.addEventListener('input', saveReviewerName);
  }
  // ヘッダのタブと注記は共通処理（applyReviewNav）に委ねる。配信されていればタブを出し、
  // 書き戻せるときだけ注記を隠す（判定を各ビューに書かない。SR-24）。
  applyReviewNav(ROOT, byId, enabled);
  ROOT.querySelectorAll('.review-box').forEach(function (box) {
    box.querySelectorAll('input, textarea, button').forEach(function (el) { el.disabled = !enabled; });
    var readonlyNote = box.querySelector('.review-readonly-note');
    if (readonlyNote) { readonlyNote.style.display = enabled ? 'none' : ''; }
  });
  // ビュー切替タブ・相互ディープリンク（SOL-30）。一時サーバ配信時のみ表示する
  // （file:// 単体閲覧では従来どおり読み取り専用の単体ビューのまま）。
  // 相互ディープリンク（SOL-30）は書き戻しの有無ではなく「行き来できるか」で決まるが、
  // 従来どおり enabled で切り替える（tree ⇄ guided はどちらも書き戻し可のビューであり、
  // 判定が分かれる場面が無い）。タブ自体は applyReviewNav が配信状態で出す。
  ROOT.querySelectorAll('.cross-jump').forEach(function (el) { el.style.display = enabled ? '' : 'none'; });
}
function updateCollapsedBandTraceMarkers() {
  var sections = ROOT.querySelectorAll('.column');
  sections.forEach(function (section) {
    var hasTrace = section.querySelector('.node.trace-hl-up, .node.trace-hl-down') !== null;
    var bar = section.querySelector('.column-collapsed-bar');
    if (bar) { bar.classList.toggle('has-trace', hasTrace); }
  });
}
function toggleColumn(el) {
  var section = el.closest('.column');
  if (!section) { return false; }
  var collapsed = !section.classList.contains('collapsed');
  section.classList.toggle('collapsed', collapsed);
  var kind = section.getAttribute('data-kind');
  try {
    if (kind) { localStorage.setItem('reqtree:collapsed:' + kind, collapsed ? '1' : '0'); }
  } catch (e) {}
  if (!collapsed && kind) {
    // 展開時: このカラムを担当する divider に手動保存済みの幅があれば復元する
    // （折りたたみ⇔展開を跨いでも手動リサイズが壊れないように）。
    var ownDivider = ROOT.querySelector('.divider[data-resizes="' + kind + '"]');
    if (ownDivider) {
      var storedWidth = loadDividerWidth(kind);
      if (storedWidth !== null) {
        var storedPx = parseInt(storedWidth, 10);
        if (!isNaN(storedPx)) { section.style.flex = '0 0 ' + storedPx + 'px'; }
      }
    }
  }
  updateCollapsedBandTraceMarkers();
  refreshDividers();
  scheduleOverlayRedraw();
  return false;
}
var overlayRedrawScheduled = false;
function scheduleOverlayRedraw() {
  if (overlayRedrawScheduled) { return; }
  overlayRedrawScheduled = true;
  requestAnimationFrame(function () {
    overlayRedrawScheduled = false;
    try { redrawTraceOverlay(); } catch (e) {}
  });
}
function redrawTraceOverlay() {
  // カード間のトレース矢印オーバーレイ（施主裁定 2026-07-20）。選択中のカードの
  // 上流/下流の分だけ都度描画する（全エッジ常時描画はしない）。
  // オーバーレイは .board の可視領域にぴったり合わせるので、スクロールで
  // ボード外に出た端点は自然にクリップされ、折りたたみ・非表示で幅/高さが0のカードは
  // 明示的にスキップする。
  var overlay = byId('trace-overlay');
  var board = byId('req-board');
  while (overlay && overlay.firstChild) { overlay.removeChild(overlay.firstChild); }
  if (!overlay || !board) { return; }
  var boardRect = board.getBoundingClientRect();
  overlay.style.left = boardRect.left + 'px';
  overlay.style.top = boardRect.top + 'px';
  overlay.style.width = boardRect.width + 'px';
  overlay.style.height = boardRect.height + 'px';
  overlay.setAttribute('width', String(Math.max(0, Math.round(boardRect.width))));
  overlay.setAttribute('height', String(Math.max(0, Math.round(boardRect.height))));

  // 描画対象は「ホバー中のカード（一時プレビュー）」を優先し、無ければ「クリックで
  // 選択中（sticky）のカード」にフォールバックする（施主指示 2026-07-20）。
  var id = currentTraceId();
  if (!id) { return; }
  var selected = ROOT.querySelector('.node[data-id="' + id + '"]');
  if (!selected) { return; }
  var tracesTo = [];
  try { tracesTo = JSON.parse(selected.getAttribute('data-traces-to') || '[]'); } catch (e) {}

  var svgNS = 'http://www.w3.org/2000/svg';
  var defs = document.createElementNS(svgNS, 'defs');
  var marker = document.createElementNS(svgNS, 'marker');
  marker.setAttribute('id', 'trace-overlay-arrow');
  marker.setAttribute('viewBox', '0 0 8 8');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '4');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto-start-reverse');
  var markerPath = document.createElementNS(svgNS, 'path');
  markerPath.setAttribute('d', 'M0,0 L8,4 L0,8 z');
  markerPath.setAttribute('fill', '#e67e22');
  marker.appendChild(markerPath);
  defs.appendChild(marker);
  overlay.appendChild(defs);

  function hasArea(rect) { return rect.width > 0 && rect.height > 0; }
  function anchor(rect, useRight) {
    return {
      x: (useRight ? rect.right : rect.left) - boardRect.left,
      y: (rect.top + rect.bottom) / 2 - boardRect.top,
    };
  }
  function drawEdge(fromRect, toRect, cls) {
    if (!hasArea(fromRect) || !hasArea(toRect)) { return; } // 折りたたみ・非表示は安全にスキップ
    var fromIsLeft = fromRect.left <= toRect.left;
    var p1 = anchor(fromRect, fromIsLeft);
    var p2 = anchor(toRect, !fromIsLeft);
    var midX = (p1.x + p2.x) / 2;
    var d = 'M ' + p1.x + ' ' + p1.y + ' C ' + midX + ' ' + p1.y + ', ' + midX + ' ' + p2.y + ', ' + p2.x + ' ' + p2.y;
    var path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', cls);
    path.setAttribute('marker-end', 'url(#trace-overlay-arrow)');
    overlay.appendChild(path);
  }

  var selfRect = selected.getBoundingClientRect();
  tracesTo.forEach(function (tid) {
    var upEl = ROOT.querySelector('.node[data-id="' + tid + '"]');
    if (upEl) { drawEdge(selfRect, upEl.getBoundingClientRect(), 'overlay-edge overlay-edge-up'); }
  });
  ROOT.querySelectorAll('.node[data-id]').forEach(function (n) {
    var nid = n.getAttribute('data-id');
    if (nid === id) { return; }
    var own = [];
    try { own = JSON.parse(n.getAttribute('data-traces-to') || '[]'); } catch (e) {}
    if (own.indexOf(id) !== -1) {
      drawEdge(n.getBoundingClientRect(), selfRect, 'overlay-edge overlay-edge-down');
    }
  });
}
function saveDividerWidth(key, px) {
  try { localStorage.setItem('reqtree:width:' + key, String(px)); } catch (e) {}
}
function loadDividerWidth(key) {
  var v = null;
  try { v = localStorage.getItem('reqtree:width:' + key); } catch (e) {}
  return v;
}
function refreshDividers() {
  var dividers = ROOT.querySelectorAll('.divider');
  dividers.forEach(function (divider) {
    var target = divider.previousElementSibling;
    var next = divider.nextElementSibling;
    var targetCollapsed = !!(target && target.classList && target.classList.contains('collapsed'));
    var nextCollapsed = !!(next && next.classList && next.classList.contains('collapsed'));
    divider.classList.toggle('disabled', targetCollapsed || nextCollapsed);
  });
}
function setupDivider(divider) {
  var target = divider.previousElementSibling;
  if (!target) { return; }
  var key = divider.getAttribute('data-resizes') || '';
  var minPx = 144; // カラムの最小幅 9rem 相当（16px基準）。右詳細ペイン廃止後は divider はカラム間のみ。
  var dragging = false;
  function onMove(e) {
    if (!dragging) { return; }
    var rect = target.getBoundingClientRect();
    var w = e.clientX - rect.left;
    if (w < minPx) { w = minPx; }
    target.style.flex = '0 0 ' + w + 'px';
    e.preventDefault();
    scheduleOverlayRedraw();
  }
  function stop() {
    if (!dragging) { return; }
    dragging = false;
    divider.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', stop);
    if (key) { saveDividerWidth(key, Math.round(target.getBoundingClientRect().width)); }
  }
  divider.addEventListener('mousedown', function (e) {
    if (divider.classList.contains('disabled')) { return; }
    dragging = true;
    divider.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', stop);
    e.preventDefault();
  });
  if (key) {
    var stored = loadDividerWidth(key);
    if (stored !== null && !target.classList.contains('collapsed')) {
      var storedPx = parseInt(stored, 10);
      if (!isNaN(storedPx) && storedPx >= minPx) {
        target.style.flex = '0 0 ' + storedPx + 'px';
      }
    }
  }
}
(function () {
  var sections = ROOT.querySelectorAll('.column');
  for (var i = 0; i < sections.length; i++) {
    var section = sections[i];
    var kind = section.getAttribute('data-kind');
    var stored = null;
    try { stored = localStorage.getItem('reqtree:collapsed:' + kind); } catch (e) {}
    if (stored === '1') { section.classList.add('collapsed'); }
    else if (stored === '0') { section.classList.remove('collapsed'); }
  }
  ROOT.querySelectorAll('.divider').forEach(setupDivider);
  activate();
  // 詳細モーダル（施主の方針変更 2026-07-20。クリックで開く中央モーダル表示）。
  // カード（.node）はアンカー要素なので Enter は onclick を自然に発火するが、Space は
  // アンカーの既定動作では発火しないため keydown で明示的に補う（アクセシビリティ）。
  //
  // 依存矢印はホバーで再描画（施主指示 2026-07-20）: mouseenter で highlightTraces を
  // 呼び、そのカードの上流/下流をプレビュー表示する（モーダルは開かない・軽い一時表示）。
  // mouseleave では、クリックで選択中（sticky）のカードがあればそのカードの矢印に戻し、
  // 無ければ clearTraces() で消す（ホバー＝一時プレビュー、クリック選択＝固定表示）。
  ROOT.querySelectorAll('.node[data-id]').forEach(function (n) {
    n.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        selectNode(n.getAttribute('data-id'));
      }
    });
    n.addEventListener('mouseenter', function () {
      hoveredTraceId = n.getAttribute('data-id');
      highlightTraces(hoveredTraceId);
    });
    n.addEventListener('mouseleave', function () {
      hoveredTraceId = null;
      var sel = ROOT.querySelector('.node.selected');
      if (sel) { highlightTraces(sel.getAttribute('data-id')); } else { clearTraces(); }
    });
  });
  // backdrop 自体（パネルの外側）をクリックしたら閉じる。パネル内側のクリックは
  // イベントターゲットが backdrop 自身にならないため素通りする。
  var modalBackdrop = byId('detail-modal-backdrop');
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', function (e) {
      if (e.target === modalBackdrop) { closeDetailModal(); }
    });
  }
  // Esc キーで閉じる（モーダルが開いているときだけ）。バンドル内で自分の ROOT が
  // アクティブ（可視）でないときは早期リターンする（他ビューの Esc に反応しない）。
  document.addEventListener('keydown', function (e) {
    if (!rootIsVisible()) { return; }
    if (e.key === 'Escape' || e.key === 'Esc') {
      var b = byId('detail-modal-backdrop');
      if (b && b.classList.contains('open')) { closeDetailModal(); }
    }
  });
  // 「要レビューのみ表示」トグルの復元（施主裁定 2026-07-20。localStorage キー =
  // reqtree:reviewFilter）。
  var reviewToggle = byId('review-filter-toggle');
  if (reviewToggle) {
    var storedReviewFilter = null;
    try { storedReviewFilter = localStorage.getItem('reqtree:reviewFilter'); } catch (e) {}
    if (storedReviewFilter === '1') {
      reviewToggle.checked = true;
      var reviewBoard = byId('req-board');
      if (reviewBoard) { reviewBoard.classList.add('review-filter-on'); }
    }
  }
  // トレース矢印オーバーレイの再描画フック（施主裁定 2026-07-20。カード選択・折りたたみ・
  // divider ドラッグでの再描画は selectNode/toggleColumn/onMove 側で個別に呼んでいる。
  // ここではそれ以外の汎用トリガをまとめて登録する: window resize、document 全体を
  // capture で監視する scroll（ボード・カラム・ページのどの要素がスクロールしても拾える）、
  // すべての <details>（凡例など）の開閉。）
  window.addEventListener('resize', function () { if (!rootIsVisible()) { return; } scheduleOverlayRedraw(); });
  document.addEventListener('scroll', function () { if (!rootIsVisible()) { return; } scheduleOverlayRedraw(); }, true);
  ROOT.querySelectorAll('details').forEach(function (d) {
    d.addEventListener('toggle', scheduleOverlayRedraw);
  });
  // ビュー上レビュー UI の有効/無効切り替え（SR-33 / ADR-007 / SOL-25）。
  // window.__REVIEW_ENDPOINT__ は req_review_serve.ts が配信時にだけ注入する。
  initReviewUI();
  // SOL-51: サーバ接続 heartbeat（window.__REVIEW_ENDPOINT__ 注入時のみ起動。file:// 単体
  // 閲覧・静的バンドルでは何もしない）。
  initHeartbeat();
  // SOL-38: バンドル（req_bundle.ts）に埋め込まれ、かつオンライン配信でないときだけ
  // .view-tabs を有効化し、クリックを親フレームへの postMessage に差し替える。
  initBundleNav();
  // SOL-37: window.__REVIEW_ENDPOINT__ 未注入（file:// 単体閲覧）のときだけ下書きモードを
  // 有効化する。initReviewUI() が disabled にしたフィールドを、下書きモードが使えるとき
  // だけ initDraftMode() が上書きで解除する（順序が重要）。
  initDraftMode();
  // 相互ディープリンク（SOL-30）: URL フラグメント #<レコードID> があれば、対応する
  // レコードのモーダルを開きトレースハイライトを発火する（selectNode に委譲。ガイド側
  // からの「通読レビューでこの項目を見る」ジャンプ、または直接のブックマークで使う）。
  // 既存の内部リンク（.node・.reflink）は href="#detail-<ID>" 形式で data-id と一致しない
  // ため、誤って再発火することはない。
  function handleHashNavigation() {
    var raw = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
    if (!raw) { return; }
    var panel = ROOT.querySelector('.detail-panel[data-id="' + raw + '"]');
    if (panel) { selectNode(raw); }
  }
  window.addEventListener('hashchange', handleHashNavigation);
  handleHashNavigation();
})();
${DRAFT_MODE_JS}
${HEARTBEAT_JS}
${BUNDLE_NAV_JS}
// activate-on-first-show: シェル（バンドル）がこのビューを可視化した時に1度だけ呼ぶ、
// 幾何計測の再計算（施主裁定 ADR-013）。スタンドアロンでは load 時に一度だけ呼ばれる
// （IDP=='' なので rootIsVisible() は常に true。動作は従来どおり）。
function activate() {
  refreshDividers();
  scheduleOverlayRedraw();
}
return {
  selectNode: selectNode,
  submitReviewItem: submitReviewItem,
  activate: activate,
  initBundleNav: initBundleNav,
  toggleColumn: toggleColumn,
  closeDetailModal: closeDetailModal,
  toggleReviewFilter: toggleReviewFilter,
  copyAllDrafts: copyAllDrafts,
  clearAllDrafts: clearAllDrafts,
  toggleDraftPreview: toggleDraftPreview,
  closeDraftPreview: closeDraftPreview,
};
})();
`;

export interface TreeContext {
  byId: Map<string, ReqRecord>;
  childrenOf: Map<string, ReqRecord[]>;
  reverseAlso: Map<string, string[]>; // target id -> source ids（従たる内包で自分を指す側）
}

export function buildContext(records: ReqRecord[]): TreeContext {
  const byId = new Map<string, ReqRecord>();
  for (const r of records) {
    if (r.id !== null && !byId.has(r.id)) byId.set(r.id, r);
  }

  const childrenOf = new Map<string, ReqRecord[]>();
  for (const r of records) {
    const p = r.parentId;
    if (p === null) continue;
    const list = childrenOf.get(p) ?? [];
    list.push(r);
    childrenOf.set(p, list);
  }

  const reverseAlso = new Map<string, string[]>();
  for (const r of records) {
    if (r.id === null) continue;
    for (const target of r.alsoBelongsTo) {
      const list = reverseAlso.get(target) ?? [];
      list.push(r.id);
      reverseAlso.set(target, list);
    }
  }

  return { byId, childrenOf, reverseAlso };
}

/**
 * ルート（章）の並び順比較。`order`（frontmatter の整数フィールド）昇順、未設定は
 * 最後尾に回してから idNumber 昇順にフォールバックする。v0.31。
 */
export function compareRoots(a: ReqRecord, b: ReqRecord): number {
  const oa = a.order ?? Number.POSITIVE_INFINITY;
  const ob = b.order ?? Number.POSITIVE_INFINITY;
  if (oa !== ob) return oa - ob;
  return a.idNumber() - b.idNumber();
}

/** parent / also_belongs_to / traces_to のリンク（クリックで右ペインの対象ノードへ遷移）。 */
function renderRefLink(id: string, rec: ReqRecord | undefined): string {
  const jsId = esc(JSON.stringify(id));
  const label = rec ? `${esc(id)} ${esc(rec.title)}` : esc(id);
  return `<a class="reflink" href="#detail-${esc(id)}" data-id="${esc(id)}" ${nsHandlerAttr("REQ_TREE", "onclick", `selectNode(${jsId});`)}>${label}</a>`;
}

/**
 * axes.review_required === true のときだけ true を返す（reqlib.ts は変更しない方針の
 * ため、既存の axes getter が返す生の YamlMap から直接読む。施主指示 2026-07-20）。
 */
export function isReviewRequired(r: ReqRecord): boolean {
  return r.axes["review_required"] === true;
}

/**
 * 「確認済み」の判定（SOL-50 の確認チェックと同じ意味）。approval が agreed で、かつ
 * 要レビューが外れている状態を確認済みとする。通読レビューのチェック状態・サイドバー・
 * 文書ビューの参照マーカーが同じ判定を使う（ビューごとに「確認済み」を定義しない。SR-24）。
 */
export function isConfirmed(r: ReqRecord): boolean {
  return r.state["approval"] === "agreed" && !isReviewRequired(r);
}

/** 要レビューバッジ（axes.review_required === true のときだけ表示。控えめな橙/黄系）。 */
export function reviewBadgeHtml(r: ReqRecord): string {
  return isReviewRequired(r) ? '<span class="review-badge" title="axes.review_required: true">要レビュー</span>' : "";
}

// ---------------------------------------------------------------------------
// ホバーバルーン・弱参照リンク（req-web 取り込み2。SOL-34 で req_document.ts に実装）。
// SOL-41 で req_guided.ts のストーリー順モード（narration/intro 内の data-req-link）も
// 同じ仕組みを必要としたため、二重実装を避けるためここへ export した（req_document.ts は
// これらを import して使う側に変わる。SR-24）。
// ---------------------------------------------------------------------------

/** 弱参照リンク様式＋ホバーバルーンの CSS（req-web 取り込み1/2）。 */
export const REQ_BALLOON_CSS = `a[data-req-link] { color: #64748b; text-decoration: none; opacity: .75; transition: color .15s ease, opacity .15s ease; }
a[data-req-link]:hover { color: #534AB7; opacity: 1; }
p:has(a[data-req-link]):hover,
li:has(a[data-req-link]):hover,
dd:has(a[data-req-link]):hover,
blockquote:has(a[data-req-link]):hover { background: #f8fafc; }
.req-balloon { position: absolute; width: 320px; max-width: 90vw; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; padding: .7rem .9rem; font-size: .82rem; line-height: 1.5; box-shadow: 0 6px 18px rgba(0,0,0,.15); z-index: 9999; color: #1f2937; }
.req-balloon .balloon-id { font-weight: 700; font-family: monospace; }
.req-balloon .balloon-kind { display: inline-block; padding: .05rem .4rem; border-radius: 3px; font-size: .75rem; font-weight: 600; background: #EEEDFE; color: #534AB7; margin-left: .3rem; }
.req-balloon .balloon-title { font-weight: 600; margin: .3rem 0 .2rem; }
.req-balloon .balloon-state { color: #64748b; font-size: .78rem; margin-bottom: .3rem; }
.req-balloon .balloon-preview { color: #334155; }
`;

/** レコード要約1件分（ホバーバルーンの表示内容）。 */
export interface BalloonEntry {
  kind: string;
  title: string;
  state: string;
  preview: string;
}

/**
 * 全レコードの要約マップ（id → 種別ラベル・タイトル・状態の短い要約・本文冒頭140字）。
 * 決定的（正本のみから生成。実行時刻・乱数は使わない）。ホバーバルーン（req-web 取り込み2）
 * が実行時 JS から読む #req-balloon-data の中身になる。
 */
export function buildBalloonData(records: ReqRecord[]): Record<string, BalloonEntry> {
  const approvalLabel = STATE_KEY_SHORT_LABEL.get("approval") ?? "approval";
  const confidenceLabel = STATE_KEY_SHORT_LABEL.get("confidence") ?? "confidence";
  const out: Record<string, BalloonEntry> = {};
  for (const r of records) {
    if (r.id === null) continue;
    const kind = r.kind !== null ? (KIND_LABEL.get(r.kind) ?? r.kind) : "?";
    const title = r.title ?? "";
    const approval = typeof r.state["approval"] === "string" ? String(r.state["approval"]) : "—";
    const confidence = typeof r.state["confidence"] === "string" ? String(r.state["confidence"]) : "—";
    const state = `${approvalLabel}: ${approval}／${confidenceLabel}: ${confidence}`;
    const statementRaw = r.frontmatter["statement"];
    const statementText = typeof statementRaw === "string" ? statementRaw.replace(/\s+/g, " ").trim() : "";
    const preview = statementText.slice(0, 140);
    out[r.id] = { kind, title, state, preview };
  }
  return out;
}

/**
 * JSON を `<script type="application/json">` として安全に埋め込む（値の中に "</script" が
 * 現れても早期終了しないよう `<` を \\u003c にエスケープする。JSON.parse の結果は変わらない）。
 */
export function renderJsonScript(id: string, data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script type="application/json" id="${esc(id)}">${json}</script>`;
}

/**
 * ホバーバルーンの実行時 JS（req-web 取り込み2）。委譲リスナーは document への
 * mouseover/mouseout/click 1箇所のみ。バンドル（ADR-013）では doc・guided の両ビューが
 * それぞれこの関数を own IIFE 内で呼ぶため、同一 document に2つの initReqBalloon() が
 * 独立に document レベルの委譲リスナーを登録することになる。ROOT.contains(link) の
 * ガードを入れているのは、そのとき自分の ROOT 配下ではない data-req-link（他ビューの
 * 領域）をこの呼び出しが処理してしまい、同じホバーで2つのバルーンが出る事故を防ぐため
 * （ADR-013 の keydown ガードと同じ理由）。IDP='' のスタンドアロン時は ROOT===document
 * なので常に true（挙動は非回帰）。
 */
export const REQ_BALLOON_JS = `function initReqBalloon() {
  var dataEl = byId('req-balloon-data');
  if (!dataEl) { return; }
  var data;
  try { data = JSON.parse(dataEl.textContent || '{}'); } catch (e) { return; }
  var balloonEl = null;
  function ensureBalloon() {
    if (balloonEl) { return balloonEl; }
    balloonEl = document.createElement('div');
    balloonEl.className = 'req-balloon';
    balloonEl.style.display = 'none';
    document.body.appendChild(balloonEl);
    return balloonEl;
  }
  function findReqLink(el) {
    if (!ROOT.contains(el)) { return null; }
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.matches('[data-req-link]')) { return el; }
      if (/^(P|LI|DD|BLOCKQUOTE)$/.test(el.tagName)) {
        var inner = el.querySelector('[data-req-link]');
        if (inner) { return inner; }
      }
      el = el.parentElement;
    }
    return null;
  }
  function showBalloon(link) {
    var id = link.getAttribute('data-req-link');
    var info = data[id];
    if (!info) { return; }
    var b = ensureBalloon();
    b.innerHTML = '<div><span class="balloon-id"></span><span class="balloon-kind"></span></div>' +
      '<div class="balloon-title"></div><div class="balloon-state"></div><div class="balloon-preview"></div>';
    b.querySelector('.balloon-id').textContent = id;
    b.querySelector('.balloon-kind').textContent = info.kind;
    b.querySelector('.balloon-title').textContent = info.title;
    b.querySelector('.balloon-state').textContent = info.state;
    b.querySelector('.balloon-preview').textContent = info.preview;
    var rect = link.getBoundingClientRect();
    b.style.left = (window.scrollX + rect.left) + 'px';
    b.style.top = (window.scrollY + rect.bottom + 6) + 'px';
    b.style.display = 'block';
  }
  function hideBalloon() {
    if (balloonEl) { balloonEl.style.display = 'none'; }
  }
  document.addEventListener('mouseover', function (e) {
    var link = findReqLink(e.target);
    if (link) { showBalloon(link); }
  });
  document.addEventListener('mouseout', function (e) {
    var link = findReqLink(e.target);
    if (link) { hideBalloon(); }
  });
  document.addEventListener('click', function (e) {
    var link = findReqLink(e.target);
    if (!link) { return; }
    var enabled = typeof window.__REVIEW_ENDPOINT__ === 'string' && window.__REVIEW_ENDPOINT__ !== '';
    if (enabled) {
      e.preventDefault();
      window.location.href = '/#' + link.getAttribute('data-req-link');
    }
  });
}
`;

/** 正規表現のメタ文字をエスケープする（data-req-link の ID を安全にリテラルとして使うため）。 */
function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `data-req-link` 付き参照リンクの表示テキストが ID のみ（または「(ID)」「(ID, 状態)」の
 * ような ID±状態のみ）で、レコードのタイトルを含んでいないとき、ビルド時に表示テキストの
 * 末尾へ「 タイトル」を追記する（SOL-31 追記・施主指示 2026-08-06。ホバーせずとも何の参照か
 * 読めるように）。
 *
 * 対象は本文（req_document.ts のナラティブ）・ストーリー narration/intro（req_guided.ts）
 * など、AI 執筆のフラグメント内に埋め込まれた `<a data-req-link="ID">…</a>` 全般（共有ヘルパ
 * として req_tree.ts に置き、各ビューの合成パスに1箇所ずつ挟む。二重実装しない。SR-24）。
 *
 * 判定（決定的・べき等）:
 *   - `<a>` タグの属性に `data-req-link="ID"` が無ければ無変更（このヘルパの対象外）。
 *   - ID が recordsById に存在しない（未知 ID）場合は無変更（正本の不整合は req lint に委ねる）。
 *   - タイトルが空文字なら追記しても意味がないため無変更。
 *   - 表示テキスト（トリム後）が既にタイトルを部分文字列として含む場合は無変更
 *     （二重併記防止。このヘルパを2回適用しても結果が変わらないべき等性の根拠でもある）。
 *   - 表示テキストが「ID」「(ID)」「(ID, 任意の状態文字列)」のいずれの形（ID のみ・ID±状態
 *     のみ）にも一致しない場合（既に自由な説明文が入っている等）は無変更。
 *   - 上記をすべて通過したときのみ、表示テキストの末尾に半角スペース＋エスケープ済み
 *     タイトルを追記する（既存の表示テキストは変えない。前置きの状態表記等はそのまま残る）。
 *
 * `<a>` タグの再構成は属性文字列（attrs）と内側テキスト（inner）を分離して組み直す方式で行い、
 * `String.replace` を「全体文字列内で inner を検索」する形では行わない（attrs 側に inner と
 * 同じ文字列が偶然含まれる場合の誤爆を避けるため）。
 */
export function enrichReqLinkLabels(html: string, recordsById: Map<string, ReqRecord>): string {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole: string, attrs: string, inner: string) => {
    const idMatch = /\bdata-req-link\s*=\s*"([^"]*)"/i.exec(attrs);
    if (!idMatch) return whole;
    const record = recordsById.get(idMatch[1]);
    if (!record) return whole;
    const title = (record.title ?? "").trim();
    if (title === "") return whole;
    const trimmedInner = inner.trim();
    if (trimmedInner.includes(title)) return whole;
    const idPattern = escapeRegExpLiteral(idMatch[1]);
    const idOnlyRe = new RegExp(`^\\(?\\s*${idPattern}\\s*(?:,[^()]*)?\\s*\\)?$`);
    if (!idOnlyRe.test(trimmedInner)) return whole;
    return `<a${attrs}>${inner} ${esc(title)}</a>`;
  });
}

/** autolinkReqIds が素の ID として認識する接頭辞（reqlib.ts の ID 発行規則と同じ集合）。 */
const BARE_REQ_ID_RE = /\b(?:BR|SR|SOL|MO|U)-\d+\b/g;

/**
 * 素の ID 表記（リンクでないプレーンテキストの「BR-1」等）を、ビルド時に data-req-link
 * 付きの参照アンカーへ自動昇格する（SOL-41 追記／施主指示 2026-08-07）。ストーリーの
 * intro・narration や文書ビューのナラティブには、AI が書いた地の文の中に生の ID が
 * 混在することがあり（実データの stories.json に実在）、リンクやホバーバルーン
 * （initReqBalloon）の対象にならないまま埋もれていた。
 *
 * 走査はタグ・属性を意識して行う（単純な正規表現の全体置換ではない）。HTML 断片を
 * タグ（`<...>`）とテキストランに分割し、`<a>`・`<code>` 要素の内側（開始〜終了タグの
 * 間。入れ子は深さで数える。閉じタグ過多で深さが負にならないよう Math.max で下限0に
 * 留める）にあるテキストランは変換しない——`<a>` の中を変換しないのは既存リンクの表示
 * テキストを壊さないため、`<code>` の中を変換しないのはコード的な引用（ファイル名・
 * 識別子の例示）を意図せずリンク化しないため。属性値はタグ全体を1トークンとして扱う
 * （タグの外に出ない）ため、そもそもテキストランの走査対象に入らない
 * （enrichReqLinkLabels と同じ前提）。
 *
 * 変換対象は recordsById に実在する ID のみ（未知 ID は無変更。正本の不整合検査は
 * req lint に委ねる）。適用順は autolinkReqIds → enrichReqLinkLabels（タイトル併記は
 * 自動昇格した参照にも及ぶ）。
 */
export function autolinkReqIds(html: string, recordsById: Map<string, ReqRecord>): string {
  const tokenRe = /<[^>]*>|[^<]+/g;
  let anchorDepth = 0;
  let codeDepth = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html)) !== null) {
    const token = m[0];
    if (token.charAt(0) === "<") {
      out.push(token);
      const tagMatch = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(token);
      if (tagMatch) {
        const closing = tagMatch[1] === "/";
        const tagName = tagMatch[2].toLowerCase();
        const selfClosing = /\/\s*>$/.test(token);
        if (tagName === "a") {
          if (closing) anchorDepth = Math.max(0, anchorDepth - 1);
          else if (!selfClosing) anchorDepth += 1;
        } else if (tagName === "code") {
          if (closing) codeDepth = Math.max(0, codeDepth - 1);
          else if (!selfClosing) codeDepth += 1;
        }
      }
      continue;
    }
    if (anchorDepth > 0 || codeDepth > 0) {
      out.push(token);
      continue;
    }
    out.push(
      token.replace(BARE_REQ_ID_RE, (idText) =>
        recordsById.has(idText) ? `<a class="ref" data-req-link="${esc(idText)}">${esc(idText)}</a>` : idText,
      ),
    );
  }
  return out.join("");
}

/**
 * フラグメント契約の寛容なサニタイズ（SOL-34 の narrative.html／SOL-41 の stories.json
 * intro/narration で共通に使う）。`<script>` は実行され得るため必ず除去する。
 * `<html>`/`<head>`/`<style>` は構造を壊さないよう本文はそのまま残し、契約違反があった旨を
 * warnings として返すのみ（呼び出し側がヘッダ付近に警告コメントとして埋め込む）。
 * contractRef はどの SOL の契約に基づく検査かを警告文に出すための表示用ラベル。
 */
export function sanitizeHtmlFragment(html: string, contractRef: string): { html: string; warnings: string[] } {
  const warnings: string[] = [];
  let out = html;
  if (/<script[\s>]/i.test(out)) {
    out = out.replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, "");
    out = out.replace(/<script[^>]*\/?>/gi, "");
    warnings.push(`フラグメントに <script> が含まれていたため除去しました（契約: ${contractRef}）。`);
  }
  for (const tag of ["html", "head", "style"]) {
    if (new RegExp(`<${tag}[\\s>]`, "i").test(out)) {
      warnings.push(
        `フラグメントに <${tag}> が含まれています（契約違反。器の <${tag}> のみを使う想定です。${contractRef}）。`,
      );
    }
  }
  return { html: out, warnings };
}

/**
 * カラム内の木のノード（1行カード。overflow は ellipsis、`title` 属性に「ID タイトル」の
 * 全文を持つ。クリック可能・also_belongs_to の有無を印で示す）。
 */
function renderTreeItem(r: ReqRecord, ctx: TreeContext, initialId: string | null): string {
  const kindLabel = r.kind !== null ? (KIND_LABEL.get(r.kind) ?? r.kind) : "?";
  const isSelected = r.id !== null && r.id === initialId;
  const reviewRequired = isReviewRequired(r);
  const idAttr = esc(r.id);
  const jsId = esc(JSON.stringify(r.id ?? ""));
  const titleAttr = esc(`${r.id ?? ""} ${r.title ?? ""}`);
  const tracesToJson = esc(JSON.stringify(r.tracesTo));

  const parts: string[] = [];
  parts.push("<li>");
  parts.push(
    `<a class="node${isSelected ? " selected" : ""}${reviewRequired ? " is-review-required" : ""}" href="#detail-${idAttr}" data-id="${idAttr}" data-traces-to="${tracesToJson}" title="${titleAttr}" ${nsHandlerAttr("REQ_TREE", "onclick", `selectNode(${jsId});`)}>`,
  );
  parts.push(`<span class="id">${esc(r.id)}</span>`);
  parts.push(`<span class="kind-badge"${kindTitleAttr(r.kind)}>${esc(kindLabel)}</span>`);
  parts.push(reviewBadgeHtml(r));
  parts.push(`<span class="title">${esc(r.title)}</span>`);
  if (r.alsoBelongsTo.length > 0) {
    parts.push(
      `<span class="also-marker" title="従たる内包（also_belongs_to）先: ${esc(r.alsoBelongsTo.join(", "))}">⇢</span>`,
    );
  }
  const sources = r.id !== null ? (ctx.reverseAlso.get(r.id) ?? []) : [];
  if (sources.length > 0) {
    parts.push(
      `<span class="also-marker also-marker-in" title="この節を従たる内包で指すレコード: ${esc(sources.join(", "))}">⇠</span>`,
    );
  }
  parts.push("</a>");

  const children = r.id !== null ? (ctx.childrenOf.get(r.id) ?? []) : [];
  if (children.length > 0) {
    parts.push("<ul>");
    for (const child of children) {
      parts.push(renderTreeItem(child, ctx, initialId));
    }
    parts.push("</ul>");
  }
  parts.push("</li>");
  return parts.join("");
}

/**
 * カラム見出し／小見出し用のリンク（対応する SEC レコード自身。クリックで詳細に遷移）。
 * `columnKind` は「この見出しがどの種別カラム（BR/SR/SOL/MO）の見出しとして機能しているか」
 * （見出しの実体は SEC レコードなので、SEC 自身の kind バッジには定義文を付けない代わりに、
 * リンク全体の title でカラムの種別を示す。施主指示 2026-07-21）。
 */
function renderColumnHeadingLink(
  secId: string,
  ctx: TreeContext,
  initialId: string | null,
  columnKind: string | null = null,
): string {
  const rec = ctx.byId.get(secId);
  const kindLabel = rec !== undefined && rec.kind !== null ? (KIND_LABEL.get(rec.kind) ?? rec.kind) : "SEC";
  const isSelected = secId === initialId;
  const idAttr = esc(secId);
  const jsId = esc(JSON.stringify(secId));
  const tracesToJson = esc(JSON.stringify(rec?.tracesTo ?? []));

  const parts: string[] = [];
  parts.push(
    `<a class="node col-heading${isSelected ? " selected" : ""}" href="#detail-${idAttr}" data-id="${idAttr}" data-traces-to="${tracesToJson}"${kindTitleAttr(columnKind)} ${nsHandlerAttr("REQ_TREE", "onclick", `selectNode(${jsId});`)}>`,
  );
  parts.push(`<span class="id">${esc(secId)}</span>`);
  parts.push(`<span class="kind-badge">${esc(kindLabel)}</span>`);
  parts.push(`<span class="title">${esc(rec !== undefined ? rec.title : null)}</span>`);
  parts.push("</a>");
  return parts.join("");
}

/**
 * SEC id 群を章の並び順（order 昇順 → idNumber 昇順 → id 文字列。compareRoots と同値の
 * 基準を、レコードが見つからない id にもフォールバックできる形で適用する）で並べる。
 */
function sortSecIds(ids: Iterable<string>, ctx: TreeContext): string[] {
  return [...ids].sort((a, b) => {
    const ra = ctx.byId.get(a);
    const rb = ctx.byId.get(b);
    const oa = ra?.order ?? Number.POSITIVE_INFINITY;
    const ob = rb?.order ?? Number.POSITIVE_INFINITY;
    if (oa !== ob) return oa - ob;
    const na = ra?.idNumber() ?? 0;
    const nb = rb?.idNumber() ?? 0;
    if (na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** 種別カラム1本分の集計結果。secId ごとの groups に分かれる（1件なら見出しがそのままカラム見出し）。 */
interface KindColumn {
  kind: string;
  label: string;
  groups: { secId: string; children: ReqRecord[] }[];
  totalCount: number;
}

const KIND_COLUMNS_SPEC: { kind: string; label: string }[] = [
  { kind: "business_requirement", label: "BR" },
  { kind: "stakeholder_requirement", label: "SR" },
  { kind: "use_case", label: "U" },
  { kind: "solution_requirement", label: "SOL" },
  { kind: "mandatory_output", label: "MO" },
];

/**
 * 「kind ごとの配置章」をハードコードせず、実データの parent 関係から導出する
 * （各 kind のレコード群の parent を集計し、実際に使われている章の集合を求める）。
 * 1章に集約されていれば単一見出し、複数章に分かれていれば章ごとの小見出しグループになる
 * （現状: BR→SEC-5, SR→SEC-6, MO→SEC-7 は単一、SOL→SEC-10/SEC-11 は2グループ）。
 */
function buildKindColumns(records: ReqRecord[], ctx: TreeContext): KindColumn[] {
  return KIND_COLUMNS_SPEC.map(({ kind, label }) => {
    const recordsOfKind = records.filter((r) => r.kind === kind);
    const parentIds = new Set<string>();
    for (const r of recordsOfKind) {
      if (r.parentId !== null) parentIds.add(r.parentId);
    }
    const groups = sortSecIds(parentIds, ctx).map((secId) => ({
      secId,
      children: ctx.childrenOf.get(secId) ?? [],
    }));
    return { kind, label, groups, totalCount: recordsOfKind.length };
  });
}

/**
 * カラム1本の外枠（折りたたみ機構込み）を共通で組み立てる。renderKindColumn が使う
 * （GitLab イシューボードの列折りたたみに倣った新規機構。施主裁定 2026-07-19）。
 *
 * 件数0（空カラム）は既定で折りたたみ状態にする。折りたたみ時は幅 ~2.2rem の
 * 縦書き帯（KIND_COLLAPSED_LABEL の略語＋日本語名＋件数。長い SEC タイトルは使わない）になり、帯クリックで
 * 展開する。折りたたみ状態は実行時 JS が localStorage を見て上書きする
 * （このHTML自体は決定的に生成され、localStorage の参照はここでは行わない）。
 */
function renderColumnShell(opts: {
  kind: string;
  ariaLabel: string;
  totalCount: number;
  headerContentHtml: string;
  bodyHtml: string;
}): string {
  const collapsedLabelBase = KIND_COLLAPSED_LABEL.get(opts.kind) ?? KIND_LABEL.get(opts.kind) ?? opts.kind;
  const isEmpty = opts.totalCount === 0;
  const weight = Math.max(opts.totalCount, 1);

  const parts: string[] = [];
  parts.push(
    `<section class="column${isEmpty ? " collapsed" : ""}" data-kind="${esc(opts.kind)}" style="flex: ${weight} 1 0;" aria-label="${esc(opts.ariaLabel)}">`,
  );
  parts.push(
    `<div class="column-collapsed-bar" ${nsHandlerAttr("REQ_TREE", "onclick", "toggleColumn(this);")} title="${esc(opts.ariaLabel)}を展開する">` +
      `<span class="collapsed-toggle-icon">▶</span><span class="collapsed-label"${kindTitleAttr(opts.kind)}>${esc(collapsedLabelBase)}（${opts.totalCount}）</span></div>`,
  );
  parts.push('<div class="column-inner">');
  parts.push('<header class="column-head">');
  // ◀ と見出しは 1 つの弾力コンテナに入れて分離させない。header 直下に並べると
  // flex-wrap でカラムが狭いときに見出しだけが次行へ送られる（2026-07-27 の指摘）。
  // 件数は従来どおり幅が足りなければ折り返してよい。
  parts.push('<div class="col-head-main">');
  parts.push(
    `<button type="button" class="col-toggle" ${nsHandlerAttr("REQ_TREE", "onclick", "toggleColumn(this);")} aria-label="折りたたむ" title="折りたたむ">◀</button>`,
  );
  parts.push(opts.headerContentHtml);
  parts.push("</div>");
  parts.push(`<p class="col-count">${opts.totalCount} 件</p>`);
  // 展開時見出しの下に定義キャプションを常時表示（施主指示 2026-07-31。ホバー title
  // だけでは読み手が定義を能動的に確認しないと出ないため）。KIND_DEFINITION に無い kind
  // （呼び出し側は BR/SR/SOL/MO のみなので現状は起こらないが、将来 KIND_DEFINITION に
  // 無い kind のカラムが増えても安全なようにガードしている）には出さない。折りたたみ時は
  // .column.collapsed .column-inner が非表示になるため、このキャプションも自動的に隠れる。
  const def = kindDefinition(opts.kind);
  if (def !== null) {
    parts.push(`<p class="col-def">${esc(def)}</p>`);
  }
  parts.push("</header>");
  parts.push('<div class="column-body">');
  parts.push(opts.bodyHtml);
  parts.push("</div>"); // .column-body
  parts.push("</div>"); // .column-inner
  parts.push("</section>");
  return parts.join("");
}

/** axes.group が無いレコードの受け皿サブセクション名。 */
export const UNGROUPED_LABEL = "未分類";

export interface AxesGroupSection {
  groupName: string;
  isFallback: boolean;
  records: ReqRecord[];
}

/**
 * カラム内（または SOL の SEC-10/11 各グループ内）のレコード群を frontmatter の
 * `axes.group`（文字列）で意味的にサブセクション分けする（施主指示 2026-07-19
 * 「それぞれの要求の集合で、サブセクションで意味的なグルーピングをつくってまとめたい」）。
 *
 * - 誰も axes.group を持たない場合は null を返す（呼び出し側はフラット表示にフォールバック。
 *   group 未付与の利用プロジェクトの見た目を変えないための非回帰策）。
 * - 1件以上 axes.group を持つ場合、持たないレコードは末尾の「未分類」サブセクションに回す。
 * - グループの並び順は「所属レコードの最小 idNumber」昇順（決定的）。グループ内の順序は
 *   引数 records の順序（＝呼び出し側が渡す既存ソート順）をそのまま踏襲する。
 */
export function groupByAxesGroup(records: ReqRecord[]): AxesGroupSection[] | null {
  const hasAnyGroup = records.some((r) => typeof r.axes["group"] === "string" && r.axes["group"] !== "");
  if (!hasAnyGroup) return null;

  const byGroup = new Map<string, ReqRecord[]>();
  const ungrouped: ReqRecord[] = [];
  for (const r of records) {
    const g = r.axes["group"];
    if (typeof g === "string" && g !== "") {
      const list = byGroup.get(g) ?? [];
      list.push(r);
      byGroup.set(g, list);
    } else {
      ungrouped.push(r);
    }
  }

  const groupNames = [...byGroup.keys()].sort((a, b) => {
    const minA = Math.min(...byGroup.get(a)!.map((r) => r.idNumber()));
    const minB = Math.min(...byGroup.get(b)!.map((r) => r.idNumber()));
    return minA - minB;
  });

  const sections: AxesGroupSection[] = groupNames.map((groupName) => ({
    groupName,
    isFallback: false,
    records: byGroup.get(groupName)!,
  }));
  if (ungrouped.length > 0) {
    sections.push({ groupName: UNGROUPED_LABEL, isFallback: true, records: ungrouped });
  }
  return sections;
}

/**
 * レコード群を1つの `<ul class="tree">` として描画する。ただし groupByAxesGroup が
 * サブセクションを検出した場合は、控えめな小見出し（既存の SOL SEC-10/11 見出しと同系の
 * 様式＝グループ名＋件数）ごとに分けて描画する（2階層になる場合はこの関数を入れ子で呼ぶ）。
 */
function renderRecordsMaybeGrouped(records: ReqRecord[], ctx: TreeContext, initialId: string | null): string {
  const sections = groupByAxesGroup(records);
  if (sections === null) {
    const parts: string[] = ['<ul class="tree">'];
    for (const r of records) parts.push(renderTreeItem(r, ctx, initialId));
    parts.push("</ul>");
    return parts.join("");
  }

  const parts: string[] = [];
  for (const sec of sections) {
    parts.push(`<div class="axes-group${sec.isFallback ? " axes-group-fallback" : ""}">`);
    parts.push(
      `<p class="axes-group-label">${esc(sec.groupName)}<span class="axes-group-count">${sec.records.length} 件</span></p>`,
    );
    // group 見出し配下のカードは見出しより一段インデントする（施主指示 2026-07-19
    // 「SECで分類したらその配下はインデントして」を axes.group の階層にも適用）。
    parts.push('<div class="axes-group-body">');
    parts.push('<ul class="tree">');
    for (const r of sec.records) parts.push(renderTreeItem(r, ctx, initialId));
    parts.push("</ul>");
    parts.push("</div>");
    parts.push("</div>");
  }
  return parts.join("");
}

/**
 * 種別カラム1本（見出し＋件数＋木）を描画する。
 *
 * カラムの見出し（ヘッダ）は常に種別ラベル（BR/SR/SOL/MO）にする。配下の配置章（SEC）が
 * 1つだけの場合でも、以前は見出しを SEC 見出しリンクに差し替えていたため、その種別カラム
 * だけ展開時に種別が分からなくなる不具合があった（施主フィードバック 2026-07-27）。
 * 配置章が1つでも複数でも、本文側の構造（.subgroup 内の SEC 見出しリンク＋件数＋
 * インデント）は統一する（グループ数1と2以上の分岐を廃止した最小変更）。
 */
function renderKindColumn(col: KindColumn, ctx: TreeContext, initialId: string | null): string {
  const headerLabel = KIND_COLLAPSED_LABEL.get(col.kind) ?? col.label;
  const headerContentHtml = `<h2 class="col-label"${kindTitleAttr(col.kind)}>${esc(headerLabel)}</h2>`;

  const bodyParts: string[] = [];
  if (col.groups.length === 0) {
    bodyParts.push('<p class="meta">（該当レコードなし）</p>');
  } else {
    for (const g of col.groups) {
      bodyParts.push('<div class="subgroup">');
      bodyParts.push(renderColumnHeadingLink(g.secId, ctx, initialId, col.kind));
      bodyParts.push(`<p class="col-count sub-count">${g.children.length} 件</p>`);
      // SEC 見出し（例: SOL の SEC-10/SEC-11）配下のカードは見出しより一段インデントする
      // （施主指示 2026-07-19「SECで分類したらその配下はインデントして」）。
      bodyParts.push('<div class="subgroup-body">');
      bodyParts.push(renderRecordsMaybeGrouped(g.children, ctx, initialId));
      bodyParts.push("</div>");
      bodyParts.push("</div>");
    }
  }

  return renderColumnShell({
    kind: col.kind,
    ariaLabel: `${col.label}カラム`,
    totalCount: col.totalCount,
    headerContentHtml,
    bodyHtml: bodyParts.join(""),
  });
}

// ---------------------------------------------------------------------------
// 詳細ペインのヘッダ圧縮（状態5軸・axes を色チップ列で表す。施主指示 2026-07-19）
// ---------------------------------------------------------------------------

export const STATE_KEYS: readonly string[] = ["approval", "disposition", "implementation", "validation", "confidence"];

export const STATE_KEY_SHORT_LABEL: ReadonlyMap<string, string> = new Map([
  ["approval", "承認"],
  ["disposition", "扱い"],
  ["implementation", "実装"],
  ["validation", "検証"],
  ["confidence", "確度"],
]);

// 状態値の意味に応じた配色。未知の値（enum 拡張・typo 等）は灰にフォールバックし、
// ハードコードした集合から漏れても表示自体は壊れないようにする。
const STATE_CHIP_GREEN: ReadonlySet<string> = new Set(["agreed", "active", "implemented", "passed", "confirmed"]);
const STATE_CHIP_AMBER: ReadonlySet<string> = new Set([
  "candidate",
  "in_progress",
  "provisional",
  "inconclusive",
  "held",
  "deferred",
  "unvalidated",
]);
const STATE_CHIP_RED: ReadonlySet<string> = new Set(["rejected", "failed"]);
const STATE_CHIP_GRAY: ReadonlySet<string> = new Set([
  "not_started",
  "not_applicable",
  "unexamined",
  "obsolete",
  "superseded",
]);
const STATE_CHIP_PURPLE: ReadonlySet<string> = new Set(["undecided"]);

export function stateChipClass(value: unknown): string {
  if (typeof value !== "string") return "chip-gray";
  if (STATE_CHIP_GREEN.has(value)) return "chip-green";
  if (STATE_CHIP_AMBER.has(value)) return "chip-amber";
  if (STATE_CHIP_RED.has(value)) return "chip-red";
  if (STATE_CHIP_GRAY.has(value)) return "chip-gray";
  if (STATE_CHIP_PURPLE.has(value)) return "chip-purple";
  return "chip-gray"; // 未知の値のフォールバック
}

/** axes の値が「空」（[] / null / undefined / 空文字列 / false）かどうか。 */
export function isAxesValueEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (value === false) return true;
  if (typeof value === "string" && value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/** axes チップの表示テキスト（esc 後に空文字列になる値は「—」で見せる）。 */
export function axesValueText(value: unknown): string {
  const t = esc(value);
  return t === "" ? "—" : t;
}

// ---------------------------------------------------------------------------
// context（本文）の軽量 Markdown レンダラ（施主指示 2026-07-19）
//
// ADR-001 の外部依存ゼロ方針を維持するため、req_tree.ts 内に自己完結した実装を持つ
// （scripts/reqlib.ts の renderMarkdown とは独立。あちらはテーブル対応が要るが
// コードフェンスは非対応、本レンダラは逆にコードフェンス対応でテーブルは非対応と、
// それぞれの用途に絞ったサブセットにしている）。
//
// 対応記法: 見出し（##/###/####。h2〜h4）、段落、箇条書き（- / 1.）、太字 **…**、
// インラインコード `…`、コードフェンス ```、リンク [text](url)（href もエスケープ）。
// 全テキストは必ず esc() を通してからマークアップを適用するため XSS 安全であり、
// 未対応の記法（表・入れ子リスト・斜体等）はプレーン段落として安全側に落ちる。
// ---------------------------------------------------------------------------

// リンクの href に許すスキームの許可リスト（自動レビュー指摘・MEDIUM 対処）。
// `javascript:` 等の危険スキームによる XSS を防ぐため、ここにマッチしない href は
// アンカー化せずリンクテキストのみプレーン表示に落とす（href="#" への差し替えより
// 安全側かつ情報も落ちない）。esc() 済みの文字列に対して判定しても、許可対象の
// プレフィックス（http/https/mailto/#/相対パス）自体には & < > " ' を含まないため
// 生値に対する判定と等価になる。
const SAFE_LINK_SCHEME = /^(https?:|mailto:|#|\/)/i;

/**
 * インライン記法（太字・インラインコード・リンク）を適用する。text は必ず esc() 済みの
 * 前提で呼ぶこと（呼び出し側で escape してから渡す）。
 */
export function renderInlineMarkdown(rawText: string): string {
  const escaped = esc(rawText);
  // リンク [text](url) → href 部分もエスケープ済みの文字列をそのまま使う（esc() が
  // 済んでいるので &, <, >, ", ' はすでに実体参照化されており、属性値として安全）。
  // ただし href のスキームは許可リストで検証し、危険スキームはリンク化しない。
  const withLinks = escaped.replace(
    /\[([^\]]+)\]\(([^()\s]+)\)/g,
    (_m, linkText: string, href: string) =>
      SAFE_LINK_SCHEME.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${linkText}</a>`
        : linkText,
  );
  const withCode = withLinks.replace(/`([^`]+)`/g, "<code>$1</code>");
  const withBold = withCode.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return withBold;
}

/**
 * context（本文。ReqRecord.body）を Markdown として HTML にレンダリングする。
 * 本文先頭の H1（`# タイトル` 行）は詳細パネルの見出しと重複するため1つだけ読み飛ばす
 * （直後の空行も1行だけ併せて読み飛ばし、余白を詰める）。
 */
export function renderBodyMarkdown(text: string): string {
  const allLines = text.replace(/\n+$/, "").split("\n");
  let start = 0;
  if (allLines.length > 0 && /^#\s+.+$/.test(allLines[0])) {
    start = 1;
    if (start < allLines.length && allLines[start].trim() === "") start += 1;
  }
  const lines = allLines.slice(start);

  const html: string[] = [];
  let i = 0;
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listTag: "ul" | "ol" | null = null;

  function flushParagraph(): void {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
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
    const fence = /^```/.test(line.trim());
    const heading = /^(#{2,4}) (.+)$/.exec(line);
    const listItem = /^[-*] (.+)$/.exec(line);
    const orderedItem = /^\d+\. (.+)$/.exec(line);

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      i += 1;
    } else if (fence) {
      flushParagraph();
      flushList();
      i += 1;
      const codeLines: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 閉じ ``` を消費
      html.push(`<pre class="md-code"><code>${esc(codeLines.join("\n"))}</code></pre>`);
    } else if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length; // 2..4 -> h2..h4
      html.push(`<h${level} class="md-heading">${renderInlineMarkdown(heading[2])}</h${level}>`);
      i += 1;
    } else if (listItem || orderedItem) {
      flushParagraph();
      const tag = listItem ? "ul" : "ol";
      if (listTag !== null && listTag !== tag) flushList();
      listTag = tag;
      const itemLines = [listItem ? listItem[1] : (orderedItem as RegExpExecArray)[1]];
      i += 1;
      // インデントされた継続行（次の箇条書き・見出し・コードフェンスでない）は同じ項目に併合する。
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        /^\s+\S/.test(lines[i]) &&
        !/^[-*] |^\d+\. |^#{2,4} |^```/.test(lines[i].trim())
      ) {
        itemLines.push(lines[i].trim());
        i += 1;
      }
      listItems.push(renderInlineMarkdown(itemLines.join(" ")));
    } else {
      paragraph.push(line);
      i += 1;
    }
  }
  flushParagraph();
  flushList();
  return html.join("\n");
}

/**
 * レビュー判定のラジオ群（承認/却下/保留）と、変更要望の出し方の注記。
 *
 * export（SR-24）: tree・guided の両ビューが同一のマークアップを出す必要があるため関数に
 * 集約する（以前は両ファイルに同じ3行が重複していた）。
 *
 * 判定に「変更する」を第4の値として増やすのではなく、変更要望は「却下＋コメント」で
 * 表現する（施主裁定 2026-08-05）。却下は要求そのものの否定ではなく差戻し
 * （reqlib.ts applyReviewActions: review_required を維持し、コメントを必須にする）であり、
 * 変更要望はこの意味にそのまま収まる。judgment の語彙を増やさないことで、正本の
 * frontmatter・POST /review の JSON・下書きの localStorage 形式のいずれも不変に保つ。
 * 注記はこの使い方を利用者に明示するためのもので、UI 側の唯一の変更点。
 *
 * includeApprove（SOL-50）: 既定 true（tree ビューは従来どおり承認/却下/保留の3値）。
 * 通読レビュー（guided）は SOL-50 で「承認」を確認チェックボックスに置き換えたため、
 * このラジオ群からは外す（却下/保留はそのまま残す。renderReviewBox が false を渡す）。
 */
export function renderVerdictFieldset(idAttr: string, opts?: { includeApprove?: boolean }): string {
  const includeApprove = opts?.includeApprove ?? true;
  const approveOption = includeApprove
    ? `<label><input type="radio" name="review-verdict-${idAttr}" value="approve" disabled> 承認</label>`
    : "";
  return (
    `<fieldset class="review-verdict-group"><legend>判定</legend>` +
    approveOption +
    `<label><input type="radio" name="review-verdict-${idAttr}" value="reject" disabled> 却下</label>` +
    `<label><input type="radio" name="review-verdict-${idAttr}" value="hold" disabled> 保留</label>` +
    `<p class="review-verdict-note">変更を求めるときは「却下」を選び、変更内容をコメントに書いてください（却下は差戻しの意味で、コメントが必須です）。</p>` +
    `</fieldset>`
  );
}

// ---------------------------------------------------------------------------
// ユースケース図の決定的生成（SOL-49）。U レコード（kind: use_case）の本文
// 「## アクター」節と id・title のみを入力に、UML 様式のユースケース図を
// インライン SVG で生成する。guided（導入スライド）・tree（詳細モーダル）の
// 両ビューがここから import する共有ヘルパ（既存の enrichReqLinkLabels 等と
// 同じ共有パターン）。
// ---------------------------------------------------------------------------

/** ユースケース図のアクター1件（名前と、括弧内の役割説明。役割は無いこともある）。 */
export interface UseCaseActor {
  name: string;
  role: string | null;
}

/**
 * U 本文の「## アクター」節を「名前（役割）」の区切り（読点「、」・全角スラッシュ「／」・
 * 半角スラッシュ「/」）でパースする（括弧の外にある区切り文字でだけ分割し、括弧内の
 * 読点・句点・改行では分割しない）。
 *
 * 区切りに「／」「/」を加えたのは別プロジェクトからのバグ報告（2026-08-11。放送大学学園の
 * 調達仕様プロジェクトで U 16 件すべてが「／」区切りで書かれていた）による。「、」しか
 * 区切りに使っていなかったため、行全体が 1 エントリになり、外部システムや協働アクターが
 * 図から消えていた。書き手側の再発防止は skills/req-usecase/SKILL.md の雛形で行う。
 * 節が無い・空・1件もパースできない場合は null を返す（呼び出し側はこの場合、
 * 図を出さず本文のみ表示する＝生成を失敗させない。SOL-49）。
 */
export function parseUseCaseActors(body: string): UseCaseActor[] | null {
  const sections = parseBodySections(body);
  const raw = sections["アクター"];
  if (raw === undefined) return null;
  // 節内に空行（段落区切り）があれば最初の段落だけを対象にする。改行は
  // markdown ソース上の折り返しに過ぎない（語の途中で改行されている実例が
  // あるため）ため、単純に除去して連結する。
  const firstPara = (raw.split(/\n\s*\n/)[0] ?? "").replace(/\n/g, "").trim();
  if (firstPara === "") return null;
  const actors = splitUseCaseActorEntries(firstPara)
    .map(parseUseCaseActorEntry)
    .filter((a): a is UseCaseActor => a !== null);
  return actors.length > 0 ? actors : null;
}

/** 「、」区切りだが（）内の「、」では分割しない（全角・半角括弧の両方に対応）。 */
const USECASE_ACTOR_SEPARATORS = new Set(["、", "／", "/"]);

function splitUseCaseActorEntries(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of text) {
    if (ch === "（" || ch === "(") depth++;
    else if (ch === "）" || ch === ")") depth = Math.max(0, depth - 1);
    if (USECASE_ACTOR_SEPARATORS.has(ch) && depth === 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf !== "") parts.push(buf);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** 「名前（役割）」または「名前」の1エントリをパースする。名前末尾の句点は装飾のため除く。
 *
 * 役割は最初の括弧の中だけを取る。閉じ括弧の後にまだ文字が残っている場合は「この行の構造を
 * 解釈できなかった」として、役割を作らず行全体を名前として返す——ここで残りを役割に詰めると、
 * 未知の区切り文字で並べた行が「名前＝先頭の1人／役割＝残り全部」という嘘のラベルになる
 * （2026-08-11 のバグ報告で実害を確認。報告では「正規表現を非貪欲にする」案だったが、末尾
 * アンカー `$` がある限り非貪欲でも最後の「）」まで届くため効かない。構造の判定で切る）。 */
function parseUseCaseActorEntry(entry: string): UseCaseActor | null {
  const stripTrailingDot = (s: string): string => s.replace(/[。.]+$/, "").trim();
  const m = entry.match(/^([^（(]+)[（(]([^）)]*)[）)]([\s\S]*)$/);
  if (m && m[3].trim() === "") {
    const name = stripTrailingDot(m[1]);
    const role = m[2].trim();
    return name === "" ? null : { name, role: role === "" ? null : role };
  }
  const name = stripTrailingDot(entry);
  return name === "" ? null : { name, role: null };
}

const USECASE_DIAGRAM_ROW_HEIGHT = 88;
const USECASE_DIAGRAM_ACTOR_X = 46;
const USECASE_DIAGRAM_MARGIN_TOP = 34;
const USECASE_DIAGRAM_LABEL_MAX_CHARS = 12;
const USECASE_DIAGRAM_WIDTH = 480;

/** 文字列を（サロゲートペアを分断しないよう）コードポイント単位で maxChars 文字ごとに
 * 折り返す。決定的な固定幅折り返し（単語境界を持たない日本語のため単純な文字数割り）。 */
function wrapUseCaseDiagramLabel(text: string, maxChars: number): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  let cur: string[] = [];
  for (const ch of chars) {
    cur.push(ch);
    if (cur.length >= maxChars) {
      lines.push(cur.join(""));
      cur = [];
    }
  }
  if (cur.length > 0) lines.push(cur.join(""));
  return lines.length > 0 ? lines : [""];
}

/**
 * U レコードのユースケース図（左: アクター人型＋名前。右: システム境界矩形の中に
 * U の ID・タイトルの楕円。各アクターから楕円へ実線）をインライン SVG で決定的に
 * 生成する（SOL-49）。アクター節が無い・パース不能な場合は空文字列を返す（本文のみ
 * 表示・生成は失敗させない）。配色は stroke/fill に currentColor のみを使い、
 * 表示側のテーマ（ライト/ダーク）に追随する。外部リソース参照（URL・script・
 * 外部フォント）は一切含めない。id 属性は使わない（同一ページに複数箇所
 * 挿入されても重複しない）。
 */
/**
 * アクター節を図にできなかった理由（施主裁定 2026-08-14。イシュー 01）。
 *
 * これまでは解釈できないと図を出さずに黙っていた。2026-08-11 の不具合——別プロジェクトの
 * U 16 件すべてが「／」区切りで書かれ、区切りに「、」しか見ていなかったため全員が 1 人に
 * 潰れていた——が長期間気づかれなかったのは、この静かな失敗のせいである。「図が出ない」なら
 * 気づけたが、「成功したように見えて 1 人だけ描く」形だったので誰も異常と思わなかった。
 *
 * 区切り文字を足しても、次に別の書き方が現れればまた静かに壊れる。そこで理由を返し、
 * 呼び出し側が画面に出せるようにする（生成は従来どおり失敗させない。SOL-49）。
 */
export function diagnoseUseCaseActors(u: ReqRecord): string | null {
  const sections = parseBodySections(u.body);
  const raw = sections["アクター"];
  if (raw === undefined) return "「## アクター」節がありません。";
  const firstPara = (raw.split(/\n\s*\n/)[0] ?? "").replace(/\n/g, "").trim();
  if (firstPara === "") return "「## アクター」節が空です。";
  const entries = splitUseCaseActorEntries(firstPara);
  const parsed = entries.map(parseUseCaseActorEntry);

  // (1) 名前すら取れなかったエントリ（空文字など）。図から落ちる。
  const dropped = entries.filter((_, i) => parsed[i] === null);
  if (dropped.length === entries.length) {
    return `「## アクター」節を 1 件も解釈できませんでした（区切りは「、」「／」「/」）: ${firstPara}`;
  }
  if (dropped.length > 0) {
    return `「## アクター」節の ${dropped.length} 件が図から落ちました: ${dropped.join(" | ")}`;
  }

  // (2) 構造を解釈できなかったエントリ。役割を作らず行全体を名前にする安全側の扱いを
  // している（嘘の役割を出さないため）が、それは「1 人の長い名前」として図に出るので、
  // 書き手には壊れて見えない。ここで気づけるようにする——2026-08-11 の不具合はこの形
  // （未対応の区切りで並べた行が 1 人に潰れる）だった。
  const unstructured = entries.filter((e, i) => {
    const a = parsed[i];
    if (a === null) return false;
    // 括弧があるのに役割が取れていない＝閉じ括弧の後に文字が残っている（区切り漏れの兆候）
    return a.role === null && /[（(]/.test(e);
  });
  if (unstructured.length > 0) {
    return `「## アクター」節の ${unstructured.length} 件で括弧の構造を解釈できず、行全体を 1 人の名前として扱いました（区切りは「、」「／」「/」。役割は名前の直後の括弧に書きます）: ${unstructured.join(" | ")}`;
  }
  return null;
}

export function renderUseCaseDiagram(u: ReqRecord): string {
  const actors = parseUseCaseActors(u.body);
  if (!actors) return "";

  const labelSource = `${u.id ?? ""} ${u.title ?? ""}`.trim();
  const lines = wrapUseCaseDiagramLabel(labelSource, USECASE_DIAGRAM_LABEL_MAX_CHARS);
  const ellipseRy = 34 + lines.length * 15;
  const ellipseRx = 128;
  const bodyHeight = Math.max(actors.length * USECASE_DIAGRAM_ROW_HEIGHT, ellipseRy * 2 + 40);
  const height = bodyHeight + USECASE_DIAGRAM_MARGIN_TOP * 2;
  const width = USECASE_DIAGRAM_WIDTH;
  const systemX = 210;
  const systemWidth = width - systemX - 20;
  const ellipseCx = systemX + systemWidth / 2;
  const ellipseCy = height / 2;

  const parts: string[] = [];
  parts.push(
    `<svg class="usecase-diagram" viewBox="0 0 ${width} ${height}" ` +
      `style="width:100%;height:auto;max-width:${width}px;" ` +
      `role="img" aria-label="${esc(labelSource)}のユースケース図">`,
  );
  parts.push(
    `<rect x="${systemX}" y="${USECASE_DIAGRAM_MARGIN_TOP - 24}" width="${systemWidth}" ` +
      `height="${bodyHeight + 24}" fill="none" stroke="currentColor" stroke-width="1.5" rx="6"/>`,
  );
  parts.push(
    `<text x="${systemX + systemWidth / 2}" y="${USECASE_DIAGRAM_MARGIN_TOP - 6}" text-anchor="middle" ` +
      `font-size="12" fill="currentColor">${esc("システム")}</text>`,
  );
  actors.forEach((actor, i) => {
    const cy = USECASE_DIAGRAM_MARGIN_TOP + USECASE_DIAGRAM_ROW_HEIGHT / 2 + i * USECASE_DIAGRAM_ROW_HEIGHT;
    parts.push(
      `<line x1="${USECASE_DIAGRAM_ACTOR_X + 12}" y1="${cy}" x2="${ellipseCx - ellipseRx}" y2="${ellipseCy}" ` +
        `stroke="currentColor" stroke-width="1.25"/>`,
    );
  });
  parts.push(
    `<ellipse cx="${ellipseCx}" cy="${ellipseCy}" rx="${ellipseRx}" ry="${ellipseRy}" ` +
      `fill="none" stroke="currentColor" stroke-width="1.5"/>`,
  );
  lines.forEach((line, i) => {
    const dy = (i - (lines.length - 1) / 2) * 15;
    parts.push(
      `<text x="${ellipseCx}" y="${ellipseCy + dy + 4}" text-anchor="middle" font-size="11" ` +
        `fill="currentColor">${esc(line)}</text>`,
    );
  });
  actors.forEach((actor, i) => {
    const cy = USECASE_DIAGRAM_MARGIN_TOP + USECASE_DIAGRAM_ROW_HEIGHT / 2 + i * USECASE_DIAGRAM_ROW_HEIGHT;
    const titleHtml = actor.role !== null ? `<title>${esc(actor.role)}</title>` : "";
    parts.push(
      `<g transform="translate(${USECASE_DIAGRAM_ACTOR_X},${cy})">` +
        titleHtml +
        `<circle cx="0" cy="-19" r="7" fill="none" stroke="currentColor" stroke-width="2"/>` +
        `<line x1="0" y1="-12" x2="0" y2="10" stroke="currentColor" stroke-width="2"/>` +
        `<line x1="-10" y1="-2" x2="10" y2="-2" stroke="currentColor" stroke-width="2"/>` +
        `<line x1="0" y1="10" x2="-9" y2="27" stroke="currentColor" stroke-width="2"/>` +
        `<line x1="0" y1="10" x2="9" y2="27" stroke="currentColor" stroke-width="2"/>` +
        `<text x="0" y="42" text-anchor="middle" font-size="11" fill="currentColor">${esc(actor.name)}</text>` +
        `</g>`,
    );
  });
  parts.push("</svg>");
  return `<div class="usecase-diagram-wrap">${parts.join("")}</div>`;
}

/** カードクリックで開く中央モーダルの中身（1レコード分。施主の方針変更 2026-07-20）。 */
function renderDetailPanel(r: ReqRecord, ctx: TreeContext): string {
  const kindLabel = r.kind !== null ? (KIND_LABEL.get(r.kind) ?? r.kind) : "?";
  const state = r.state;
  const axes = r.axes;
  const idAttr = esc(r.id);
  const jsIdForReview = esc(JSON.stringify(r.id ?? ""));

  // 右固定詳細ペインは廃止し（施主裁定 2026-07-20）、カードクリック（Enter/Space での
  // キーボード操作も含む）で開く中央モーダルに置き換えた。`active` クラスは初期状態では
  // 常に付けず（ページ読み込み時点で開いているモーダルは無い）、実行時 JS
  // （selectNode → openDetailModal）がクリック/キー操作に応じて付け外しする。
  // role="dialog"・aria-modal・aria-labelledby はモーダルとしての意味づけ、tabindex="-1"
  // は開いたときに `.focus()` できるようにするため（タブ順自体には含めない）。
  const parts: string[] = [];
  parts.push(
    `<article class="detail-panel" id="detail-${idAttr}" data-id="${idAttr}" role="dialog" aria-modal="true" aria-labelledby="detail-${idAttr}-title" tabindex="-1">`,
  );
  parts.push(
    `<button type="button" class="detail-close" ${nsHandlerAttr("REQ_TREE", "onclick", "closeDetailModal();")} aria-label="閉じる" title="閉じる">×</button>`,
  );
  // kind バッジの title: BR/SR/SOL/MO は的確な定義文を主にする（施主指示 2026-07-21）。
  // 定義文が無い kind（SEC 等）は従来どおり raw kind 名を title にする（非回帰）。
  const kindBadgeTitle = kindDefinition(r.kind) ?? (r.kind !== null ? r.kind : "");
  parts.push(
    `<h2 id="detail-${idAttr}-title"><span class="id">${esc(r.id)}</span><span class="kind-badge" title="${esc(kindBadgeTitle)}">${esc(kindLabel)}</span><span class="detail-title">${esc(r.title)}</span></h2>`,
  );

  // 相互ディープリンク（SOL-30）: このレコードを通読レビュー（/guided）の該当スライドで
  // 見る。一時サーバ配信時のみ initReviewUI() が表示する（既定 display:none）。
  // 段落（p）自体にも cross-jump クラス＋非表示スタイルを付け、リンクだけを隠して段落の
  // margin が空白として残る事故を避ける（initReviewUI は .cross-jump を一括トグルする）。
  parts.push(
    `<p class="cross-jump" style="display:none;"><a class="reflink cross-jump" href="/guided#${idAttr}">→ 通読レビューでこの項目を見る</a></p>`,
  );

  // 状態5軸: 色チップ列（表は廃止。kind: xxx のメタ行も廃止しバッジの title に統合）。
  parts.push('<div class="chip-row state-chip-row">');
  for (const key of STATE_KEYS) {
    const value = state[key] ?? null;
    const shortLabel = STATE_KEY_SHORT_LABEL.get(key) ?? key;
    const cls = stateChipClass(value);
    const valueText = typeof value === "string" ? esc(value) : "—";
    parts.push(`<span class="chip ${cls}" title="${esc(key)}">${esc(shortLabel)} ${valueText}</span>`);
  }
  parts.push("</div>");

  // axes: 中立色チップ列（空/false は dimmed。消さずに「未設定であること」を見せる）。
  const axesKeys = Object.keys(axes);
  parts.push('<div class="chip-row axes-chip-row">');
  if (axesKeys.length === 0) {
    parts.push('<span class="chip chip-axis chip-dimmed">axes なし</span>');
  } else {
    for (const key of axesKeys) {
      const value = axes[key];
      const dimmed = isAxesValueEmpty(value);
      parts.push(
        `<span class="chip chip-axis${dimmed ? " chip-dimmed" : ""}" title="${esc(key)}">${esc(key)}: ${axesValueText(value)}</span>`,
      );
    }
  }
  parts.push("</div>");

  // confidence_note（axes とは別の frontmatter 直下フィールド）。review_required の
  // 状態自体は axes チップ列に既に出るため重複させず、ここでは注記文のみ表示する
  // （施主指示 2026-07-20）。
  const confidenceNoteRaw = r.frontmatter["confidence_note"];
  const confidenceNoteText = typeof confidenceNoteRaw === "string" ? confidenceNoteRaw : "";
  if (confidenceNoteText !== "") {
    parts.push(`<p class="confidence-note">confidence_note: ${esc(confidenceNoteText)}</p>`);
  }

  parts.push('<div class="rel">');
  if (r.parentId !== null) {
    parts.push(`<p>親: ${renderRefLink(r.parentId, ctx.byId.get(r.parentId))}</p>`);
  } else {
    parts.push('<p class="meta">親: なし（ルートノード）</p>');
  }
  for (const target of r.alsoBelongsTo) {
    parts.push(
      `<p class="also-belongs">＊ この記録は ${renderRefLink(target, ctx.byId.get(target))} にも従たる内包で属する</p>`,
    );
  }
  const sources = r.id !== null ? (ctx.reverseAlso.get(r.id) ?? []) : [];
  for (const sourceId of sources) {
    parts.push(
      `<p class="also-belongs">＊ ${renderRefLink(sourceId, ctx.byId.get(sourceId))} がこの節にも従たる内包で属する</p>`,
    );
  }
  if (r.tracesTo.length > 0) {
    parts.push(
      `<p>traces_to: ${r.tracesTo.map((tid) => renderRefLink(tid, ctx.byId.get(tid))).join(", ")}</p>`,
    );
  }
  parts.push("</div>");

  // statement（frontmatter の生テキスト）はプレーンテキストのため引き続き pre 表示。
  // 見出しは施主指示 2026-07-19 で「statement」→「要求・要件の内容」に変更。
  const statementRaw = r.frontmatter["statement"];
  const statementText = typeof statementRaw === "string" ? statementRaw.replace(/\n+$/, "") : "";
  parts.push("<h3>要求・要件の内容</h3>");
  parts.push(
    statementText === ""
      ? '<p class="meta">（statement なし）</p>'
      : `<pre class="body-text">${esc(statementText)}</pre>`,
  );

  // context（本文。ReqRecord.body）は Markdown としてレンダリングする。見出しは
  // 施主指示 2026-07-19 で「本文」→「context」に変更（renderBodyMarkdown が
  // 先頭の H1 行の重複表示を1つだけスキップする）。
  const bodyText = r.body.replace(/^\n+|\n+$/g, "");
  parts.push("<h3>context</h3>");
  // ユースケース図（SOL-49）: kind: use_case のときだけ、本文冒頭にアクター節から
  // 決定的生成した SVG を添える。アクター節が無い・パース不能なら空文字列（本文のみ）。
  if (r.kind === "use_case") {
    parts.push(renderUseCaseDiagram(r));
  }
  parts.push(
    bodyText === "" ? '<p class="meta">（本文なし）</p>' : `<div class="md-body">${renderBodyMarkdown(bodyText)}</div>`,
  );

  // ビュー上レビュー操作 UI（SR-33 / ADR-007 / SOL-25）。生成 HTML は常にこのマークアップを
  // 出力するが、判定ラジオ・コメント/質問欄・送信ボタンはすべて既定で disabled にする
  // （決定性・file:// 安全性の両立: buildHtml の出力自体は endpoint の有無に関わらず
  // バイト同一。実行時 JS の initReviewUI が `window.__REVIEW_ENDPOINT__` の有無を見て、
  // 一時サーバ配信時（req_review_serve.ts）だけ disabled を外す。file:// 単体閲覧では
  // JS が動かなくても markup 自体が disabled なので送信手段が出ない）。
  parts.push(`<div class="review-box" data-id="${idAttr}">`);
  parts.push("<h3>レビュー</h3>");
  parts.push(
    '<p class="review-readonly-note">このビューは読み取り専用です。レビュー結果を送信するには ' +
      "<code>node scripts/req_review_serve.ts</code> で一時サーバ配信してください（file:// 単体閲覧時は送信できません）。</p>",
  );
  parts.push(renderVerdictFieldset(idAttr));
  parts.push(`<label class="review-field-label" for="review-comment-${idAttr}">コメント</label>`);
  parts.push(`<textarea class="review-comment" id="review-comment-${idAttr}" rows="3" disabled></textarea>`);
  parts.push(`<label class="review-field-label" for="review-questions-${idAttr}">AIへの追加質問</label>`);
  parts.push(`<textarea class="review-questions" id="review-questions-${idAttr}" rows="2" disabled></textarea>`);
  parts.push('<div class="review-actions">');
  parts.push(
    `<button type="button" class="review-submit" disabled ${nsHandlerAttr("REQ_TREE", "onclick", `submitReviewItem(${jsIdForReview});`)}>送信</button>`,
  );
  parts.push('<span class="review-status" aria-live="polite"></span>');
  parts.push("</div>");
  parts.push("</div>"); // .review-box

  parts.push("</article>");
  return parts.join("");
}

export interface ReviewTopbarOptions {
  /** どちらのビューから呼ばれたか（タブの active 表示に使う）。 */
  active: "tree" | "guided" | "document";
  /** ビュー固有の追加要素（guided の #slide-progress 等）。末尾に差し込む。 */
  extraHtml?: string;
}

/**
 * 3ビュー共通のトップバー中身（ビュー切替タブ・記名欄・readonly 注記。SOL-30、第3タブ
 * 「文書ビュー」は SOL-31）。ラッパー要素（tree の `.review-toolbar` /
 * guided の `.topbar` / document の同様のラッパー）はビューごとにレイアウトが異なるため
 * 呼び出し側が持ち、ここでは中の要素だけを返す。
 *
 * サーバを終了させるボタンは持たない（施主裁定 2026-08-09。SR-61・SOL-52 改訂）。
 * ブラウザから止めた後は、死んだ画面に見た目だけ生きた判定 UI が残り、heartbeat が
 * 誤って切断障害を報告し、レビュアーは自力で再開できない——止める利得が無かったため、
 * 停止手段を起動元の端末に一本化した。詳細は ADR-007。
 *
 * `#review-reviewer-input` / `#review-toolbar-note` の id・属性・文言・属性順は現行の
 * 文字列を厳密に維持する（tests/req_tree.test.ts / tests/req_guided.test.ts が
 * 完全一致・部分一致の双方で固定しているため）。
 *
 * タブ（`.view-tabs`）・相互ディープリンク（呼び出し側が付ける `.cross-jump`）は既定
 * `style="display:none;"` とし、initReviewUI() が window.__REVIEW_ENDPOINT__ の有無
 * （一時サーバ配信かどうか）を見て表示を切り替える（file:// 単体閲覧では現れない）。
 */
/** ビュー識別子（active）から実行時の名前空間名を導出する（REQ_TREE/REQ_GUIDED/REQ_DOC）。 */
export function viewNamespace(view: "tree" | "guided" | "document"): string {
  if (view === "tree") return "REQ_TREE";
  if (view === "guided") return "REQ_GUIDED";
  return "REQ_DOC";
}

export function renderReviewTopbar(opts: ReviewTopbarOptions): string {
  const parts: string[] = [];
  parts.push('<nav class="view-tabs" style="display:none;" aria-label="ビュー切替">');
  parts.push(`<a href="/"${opts.active === "tree" ? ' class="active"' : ""}>ツリー</a>`);
  parts.push(`<a href="/guided"${opts.active === "guided" ? ' class="active"' : ""}>通読レビュー</a>`);
  // タブの文言は VIEW_LABELS を唯一の出どころにする（ここに直書きすると h1・title と
  // ずれる。施主指示 2026-08-11 の改名で「要件定義書（文書体裁）」→「文書ビュー」）。
  parts.push(`<a href="/document"${opts.active === "document" ? ' class="active"' : ""}>${VIEW_LABELS.document}</a>`);
  // イシュービュー（SOL-54 / SR-63）。読み取り専用の窓なので、他タブと同じ見た目で並べる。
  parts.push(`<a href="/issues"${opts.active === "issues" ? ' class="active"' : ""}>イシュー</a>`);
  // カバレッジビュー（SOL-55 / SR-65）。テストの十分性を読むための窓（読み取り専用）。
  parts.push(`<a href="/coverage"${opts.active === "coverage" ? ' class="active"' : ""}>カバレッジ</a>`);
  parts.push("</nav>");
  parts.push(
    '<label for="review-reviewer-input">レビュアー: ' +
      '<input type="text" id="review-reviewer-input" placeholder="記名" disabled></label>',
  );
  // 終了ボタンは置かない（施主裁定 2026-08-09。SR-61・SOL-52 改訂）。ブラウザからサーバを
  // 止める操作は作らず、停止は起動した端末（Ctrl-C / kill）に一本化する。
  parts.push('<span id="review-toolbar-note" class="review-readonly-note">読み取り専用（file://）</span>');
  if (opts.extraHtml) parts.push(opts.extraHtml);
  return parts.join("");
}

/** 全ビュー共通のサイト名。title と h1 の両方で使う。 */
export const SITE_NAME = "ライトウェイト要求工学ツール";

/** ビューの識別子と、ヘッダ・タブに出す名前。 */
export const VIEW_LABELS = {
  tree: "ツリー",
  guided: "通読レビュー",
  document: "文書ビュー",
  spec: "要求定義書",
  // イシュービュー（SOL-54 / SR-63）。レビューサーバ配信の第4のタブ。
  issues: "イシュー",
  // カバレッジビュー（SOL-55 / SR-65）。レビューサーバ配信の第5のタブ。
  coverage: "カバレッジ",
} as const;

export type ViewId = keyof typeof VIEW_LABELS;

export interface SiteHeaderOptions {
  /** どのビューか。h1 の見出しとタブの active 表示に使う */
  view: ViewId;
  /** 見出しに添える補足（例: ツリーの「種別カラム（BR / SR / SOL / MO）」）。省略可 */
  subtitle?: string;
  /** ビュー固有の追加要素（guided のスライド進捗等）。ツールバー末尾に差し込む */
  extraHtml?: string;
  /** レビュー操作を持たないビュー（spec）では false にしてツールバーを省く */
  withToolbar?: boolean;
}

/**
 * 全ビュー共通のヘッダ（施主指示 2026-07-28「各ページのヘッダが不統一なので統一して」）。
 *
 * 統一前は次のようにばらついていた。
 *   - tree:     `<h1>ツリービュー — 種別カラム（…）</h1>` ＋ 別要素の `.review-toolbar`
 *   - guided:   `.topbar` の中に `<h1>ガイド付きレビュー（網羅レビュー）</h1>`
 *   - status:   `<h1>状況 — ライトウェイト要求工学ツール</h1>`（ツールバー無し）
 *   - view:     `<h1>要求定義書（生成ビュー） — ライトウェイト要求工学ツール</h1>`（同）
 *   - document: `<h1>要件定義書</h1>`（同。2026-08-11 に「文書ビュー」へ改名）
 * サイト名が付くものと付かないもの、ラッパー要素名、ツールバーの有無が混在していた。
 *
 * ここでは `<header class="site-header">` に一本化し、h1 を
 * 「<ビュー名>（— <subtitle>）＋ サイト名」の形に揃える。トップバーの中身は
 * 既存の renderReviewTopbar をそのまま使う（二重実装を避ける。SR-24）。
 */
export function renderSiteHeader(opts: SiteHeaderOptions): string {
  const name = VIEW_LABELS[opts.view];
  const heading = opts.subtitle === undefined ? name : `${name} — ${opts.subtitle}`;
  const parts: string[] = [];
  parts.push('<header class="site-header">');
  parts.push(`<h1>${heading}<span class="site-name">${SITE_NAME}</span></h1>`);
  if (opts.withToolbar !== false) {
    parts.push('<div class="review-toolbar">');
    // タブの active はサーバ配信される 3 ビューだけが対象（status / spec は静的生成のみ）。
    const active =
      opts.view === "tree" ||
      opts.view === "guided" ||
      opts.view === "document" ||
      opts.view === "issues" ||
      opts.view === "coverage"
        ? opts.view
        : "tree";
    parts.push(
      renderReviewTopbar(opts.extraHtml === undefined ? { active } : { active, extraHtml: opts.extraHtml }),
    );
    parts.push("</div>");
  }
  parts.push("</header>");
  return parts.join("");
}

/** ページの <title>。h1 と同じ語を使い、ビュー間で書式を揃える。 */
export function pageTitle(view: ViewId, subtitle?: string): string {
  const name = VIEW_LABELS[view];
  return subtitle === undefined ? `${name} — ${SITE_NAME}` : `${name}（${subtitle}） — ${SITE_NAME}`;
}

/**
 * ツリービューを生成する。`opts.fragment` を渡すとバンドル（req_bundle.ts）用の
 * フラグメント（{ styles, html, script }）を返す。省略時（スタンドアロン）は従来どおり
 * 完全 HTML の文字列を返し、挙動・出力バイトは不変（ADR-013 段階2）。
 */
export function buildHtml(root: string): string;
export function buildHtml(root: string, opts: BuildOpts & { fragment: NonNullable<BuildOpts["fragment"]> }): FragmentResult;
export function buildHtml(root: string, opts?: BuildOpts): string | FragmentResult;
export function buildHtml(root: string, opts?: BuildOpts): string | FragmentResult {
  const result = loadRecords(root);
  if (result.errors.length > 0) {
    throw new Error("req_tree: 正本の読み込みに失敗しました:\n" + result.errors.join("\n"));
  }

  const records = result.records;
  const ctx = buildContext(records);
  const roots = records.filter((r) => r.parentId === null).sort(compareRoots);

  const kindColumns = buildKindColumns(records, ctx);

  const brColumn = kindColumns.find((c) => c.kind === "business_requirement");
  const initialId =
    brColumn !== undefined && brColumn.groups.length > 0
      ? brColumn.groups[0].secId
      : roots.length > 0
        ? roots[0].id
        : records.length > 0
          ? records[0].id
          : null;

  // axes.review_required === true の総件数（施主裁定 2026-07-20「要レビュー総件数を出す」）。
  const reviewRequiredCount = records.filter(isReviewRequired).length;

  // SOL-37: 下書きモードの localStorage キー・「すべてコピー」出力の対象表記に使う
  // プロジェクト識別子・正本の版・生成日（changelog 由来。決定的）。
  const projectMeta = computeProjectMeta(root);

  // ADR-013 段階2: 完全 HTML の組み立て（doctype/head/body の外枠）と、本文コンテンツ
  // （bodyParts）の組み立てを分離した。フラグメント時は外枠を作らず bodyParts だけを
  // 使う（idp 付与・rootClass ラップは buildHtml の末尾で行う）。スタンドアロン時の
  // 最終文字列は分離前と完全に同一（bodyParts.join("\n") を1要素として parts に積むのは
  // 個々の要素を積むのと結合結果が同じ。文字列連結の結合律）。
  const bodyParts: string[] = [];
  // ヘッダは全ビュー共通（renderSiteHeader）。h1 の書式・ラッパー要素・ツールバーの
  // 位置をビュー間で揃えるため、ここでビュー固有の組み立てはしない。
  bodyParts.push(
    renderSiteHeader({
      view: "tree",
      subtitle: "種別カラム BR / SR / SOL / MO",
      extraHtml: renderDraftToolbarExtra("REQ_TREE"),
    }),
  );
  // ヘッダ以降のビュー本文は .page-content に包み、左右・下端の余白をここでまとめて持つ
  // （ヘッダ自身の余白は .site-header 側で自己完結。SOL-32 追補）。
  bodyParts.push('<div class="page-content">');
  // SOL-37: 下書きモードの必読の注意書き（送信されないこと・すべてコピーで回収すること）。
  // オンライン時は非表示のまま（initDraftMode が何もしない）。
  bodyParts.push(renderDraftNoticeBlock(projectMeta));
  // 下書きプレビューのフローティングパネル（施主指示「オフラインレビューした内容を
  // プレビューできるように」）。既定 display:none（トップバーの「💬 プレビュー」ボタンで
  // 開閉。オンライン時はボタン自体が隠れているため実質開かれない）。
  bodyParts.push(renderDraftPreviewPanel("REQ_TREE"));
  // サーバ接続 heartbeat の切断モーダル（SOL-51 / SR-60）。既定非表示、initHeartbeat が
  // window.__REVIEW_ENDPOINT__ 注入時のみ起動する。
  bodyParts.push(renderConnectionLostModal());
  bodyParts.push(
    '<p class="meta">本ページは <code>docs/requirements/</code>（正本）から ' +
      "<code>scripts/req_tree.ts</code> が一方向生成した文書ビューです。種別（kind）を" +
      "主軸に、ボードを全幅で BR / SR / SOL / MO の横並びカラムに分けて表示" +
      "します。各カラムの見出しは、そのカラムに実際に集約されている章（SEC レコード）" +
      "自身です。カードをクリック（フォーカスして Enter/Space でも同様）すると、レコード" +
      "全文を中央モーダルで表示します（右上×ボタン・モーダル外クリック・Esc キーで閉じられ、" +
      "モーダル内の親/traces_to リンクをクリックすると開いたまま対象レコードに切り替わります）。" +
      "カラムは" +
      "ヘッダの◀ボタン、または縦書き帯のクリックで折りたたみ・展開でき、状態は" +
      "ブラウザに保存されます（該当レコードが0件のカラムは既定で折りたたみ表示）。" +
      "章節構造そのものの通し表示は要求定義書.html が引き続き担います。本ページは" +
      "要求定義書.html と同種の生成ビューであり、Word/PDF 等の文書ファイルを" +
      "出力するものではありません。編集は正本側（md + frontmatter）に対して行い、この" +
      "ファイルを直接編集しないでください。</p>",
  );
  bodyParts.push('<details class="legend">');
  bodyParts.push("<summary>凡例</summary>");
  bodyParts.push("<ul>");
  bodyParts.push(
    "<li>カラム見出し＝そのカラムに実際に集約されている章（SEC）。1章に集約されていれば" +
      "章そのものが見出しになり、複数章に分かれていれば（例: SOL の SEC-10/SEC-11）章ごとの" +
      "小見出しでグループ分けする</li>",
  );
  bodyParts.push(
    "<li>BR＝組織全体が目指す目標（なぜやるか。主語は組織）、SR＝現場の利用者・関係者の" +
      "個別のニーズ（どう使いたいか・どう困っているか。主語は人）、SOL＝システムが満たすべき" +
      "検証可能な条件（主語はシステム）。BR と SR の違いは視点と目的の範囲（組織全体の" +
      "「なぜ」か、現場の「どう使いたいか」か）、SOL との違いは主語（BR/SR は組織・人、" +
      "SOL はシステム）</li>",
  );
  bodyParts.push(
    "<li>カード（各ノード）は1行表示。全文はマウスオーバー（title 属性）で確認できるほか、" +
      "クリック（または Enter/Space）すると全文モーダルが開く</li>",
  );
  bodyParts.push(
    "<li>カラムの◀ボタン、または折りたたみ後の縦書き帯クリックで開閉できる。0件のカラムは既定で折りたたみ状態</li>",
  );
  bodyParts.push(
    "<li>カラム内の左枠線つき小見出しは axes.group（意味的なグルーピング）によるサブセクション。" +
      "誰も group を持たない場合は出ない。group 未設定のレコードは末尾の「未分類」にまとまる</li>",
  );
  bodyParts.push(
    "<li>⇢ ＝従たる内包（also_belongs_to）で他ノードにも属する印、⇠ ＝他ノードから従たる内包で指されている印（主たる木と視覚的に区別）</li>",
  );
  bodyParts.push(
    "<li>橙色の「要レビュー」バッジ＝axes.review_required が true のカード。ボード上部の" +
      "「要レビューのみ表示」チェックボックスで絞り込める（状態はブラウザに保存）</li>",
  );
  bodyParts.push(
    "<li>カードをクリックすると、そのレコードの traces_to 先（上流。右上に↑）と、" +
      "そのレコードを traces_to で指す側（下流。右上に↓）を橙枠で強調する。折りたたまれた" +
      "カラムに強調対象が含まれる場合は、縦帯の下端にも橙の下線が付く</li>",
  );
  bodyParts.push(
    "<li>モーダル内の状態5軸・axes は色チップで示す。状態チップは緑=良好・琥珀=暫定/進行/注意・" +
      "赤=問題・灰=未着手/不適用/未検討・紫=意図的未定。axes チップは値が空/false だと淡色（dimmed）になる" +
      "（項目自体は消さない）</li>",
  );
  bodyParts.push(
    '<li>モーダル内の破線枠・斜体の注記（<span class="also-belongs" style="display:inline; margin:0;">例</span>）が従たる内包の詳細</li>',
  );
  bodyParts.push("</ul>");
  bodyParts.push("</details>");

  // 要レビュー絞り込みトグル＋総件数（施主裁定 2026-07-20「カードにバッジ＋絞り込み」）。
  // チェック状態は toggleReviewFilter が localStorage（reqtree:reviewFilter）に保存し、
  // 初期化 IIFE が再読込後も復元する。件数は生成時点の実データから数える（ハードコードしない）。
  bodyParts.push('<div class="review-filter-bar">');
  bodyParts.push(
    `<label><input type="checkbox" id="review-filter-toggle" ${nsHandlerAttr("REQ_TREE", "onchange", "toggleReviewFilter(this.checked);")}> 要レビューのみ表示</label>`,
  );
  bodyParts.push(`<span class="review-filter-count">要レビュー ${reviewRequiredCount} 件</span>`);
  bodyParts.push("</div>");

  bodyParts.push('<div class="layout">');

  // 左: 種別カラムボード（BR / SR / SOL / MO）。カラム間はドラッグで幅変更できる
  // divider を挟む（施主指示 2026-07-19「レーン間をドラッグして幅を任意に変更できるように」。
  // 旧 v0.30 の左右分割 divider 実装を一般化した。右固定詳細ペイン廃止（施主裁定 2026-07-20）
  // に伴い、ボード⇔詳細ペイン間の divider は撤去し、カラム間の divider のみが残る）。
  // divider の data-resizes は「自分の左側（前の兄弟要素）を resize する」対象の kind を
  // 示す。折りたたまれたカラムに隣接する divider は実行時 JS が disabled にする）。
  const columnRenders: { kind: string; html: string }[] = kindColumns.map((col) => ({
    kind: col.kind,
    html: renderKindColumn(col, ctx, initialId),
  }));

  bodyParts.push('<div class="board" id="req-board" aria-label="種別カラムボード">');
  columnRenders.forEach((c, idx) => {
    bodyParts.push(c.html);
    if (idx < columnRenders.length - 1) {
      bodyParts.push(
        `<div class="divider" data-resizes="${esc(c.kind)}" role="separator" aria-orientation="vertical" title="ドラッグで幅を調整"></div>`,
      );
    }
  });
  bodyParts.push("</div>"); // .board

  // カード選択時にトレース矢印を描く透明オーバーレイ（施主裁定 2026-07-20。廃止した
  // トレーサビリティ関係図パネルの置き換え）。位置・サイズは実行時 JS が #req-board の
  // getBoundingClientRect() に合わせて揃える（生成HTML自体は空のsvgのままで決定的）。
  bodyParts.push('<svg id="trace-overlay" class="trace-overlay" aria-hidden="true"></svg>');

  bodyParts.push("</div>"); // .layout

  // 全レコード分の詳細モーダル（施主裁定 2026-07-20: 右固定詳細ペインを廃止。当初は
  // hover/focus のポップアップに置き換えたが、同日中の施主の方針変更でクリック
  // （Enter/Space によるキーボード操作を含む）で開く中央モーダルに変更した）。
  // #detail-modal-backdrop が画面全体を覆う半透明の backdrop（既定 display:none、
  // `.open` で display:flex になり中央に配置）。各 `.detail-panel` は既定 display:none、
  // selectNode が対象だけに `.active`（display:block）を付ける。backdrop の空白部分
  // （= クリックされた要素が backdrop 自身）をクリックすると閉じる。
  bodyParts.push('<div class="modal-backdrop" id="detail-modal-backdrop" aria-hidden="true">');
  for (const r of records) {
    bodyParts.push(renderDetailPanel(r, ctx));
  }
  bodyParts.push("</div>");

  bodyParts.push("</div>"); // .page-content

  const bodyHtml = bodyParts.join("\n");

  if (opts?.fragment) {
    validateFragmentOpts(opts.fragment);
    const { idp, ns, rootClass } = opts.fragment;
    return {
      styles: scopeCss(CSS, rootClass, ns),
      html: `<div class="${rootClass}">${prefixFragmentIds(bodyHtml, idp)}</div>`,
      script: scopeScript(JS, idp, rootClass),
    };
  }

  const parts: string[] = [];
  parts.push("<!doctype html>");
  parts.push('<html lang="ja">');
  parts.push("<head>");
  parts.push('<meta charset="UTF-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
  parts.push(`<title>${pageTitle("tree", "種別カラム BR / SR / SOL / MO")}</title>`);
  parts.push(`<style>\n${CSS}\n</style>`);
  parts.push("</head>");
  parts.push("<body>");
  parts.push(bodyHtml);
  parts.push(`<script>\n${JS}\n</script>`);
  parts.push("</body>");
  parts.push("</html>");
  return parts.join("\n") + "\n";
}

function main(): number {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      out: { type: "string" },
    },
  });
  const root = values.root ?? defaultRoot();
  const out = values.out ?? defaultOut();

  const htmlText = buildHtml(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, htmlText, "utf-8");
  console.log(`req_tree: ${out} を生成しました。`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
