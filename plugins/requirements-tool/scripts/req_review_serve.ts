#!/usr/bin/env node
/**
 * req_review_serve.ts — ツリービュー上レビュー（SR-33 / ADR-007）の一時ローカル配信サーバ。
 *
 * ADR-007（採用: ADR-005 の一時ローカル HTTP サーバ方式の拡張）に基づき、Node 標準の
 * http のみで 127.0.0.1 の空きポートに一時サーバを立て、req_tree.ts が生成する
 * インタラクティブ版ツリービューを配信する。既定ブラウザを開き、レビュー結果の POST を
 * scripts/reqlib.ts の applyReviewActions（SOL-26）で正本へ確定的に反映する。
 *
 * サーバを停止させる操作はブラウザ側に持たない（施主裁定 2026-08-09。SR-61・SOL-52 改訂。
 * 経緯は ADR-007）。停止は起動した端末で行う（Ctrl-C、または `kill $(lsof -ti :8765)`）。
 * 判定は送信のたびに正本へ書かれるため、終了操作が運ぶ結果は無い——一方で終了操作は、
 * 押した後に死んだ画面と生きて見える判定 UI を残し、heartbeat に切断障害を誤報告させ、
 * 端末を持たないレビュアーの自力再開を不能にしていた。
 *
 * ルーティング:
 *   GET  /       — req_tree.ts の buildHtml(root) を生成し、`window.__REVIEW_ENDPOINT__`
 *                  （値は "/review"）を注入して配信する。buildHtml 自体は変更しない
 *                  （生成物は決定的なまま。注入は配信直前の文字列挿入のみ）。
 *   GET  /guided — req_guided.ts の buildGuidedHtml(root)（SOL-28。網羅レビューガイド付き
 *                  レビュービュー）を生成し、同じく `window.__REVIEW_ENDPOINT__`
 *                  （値は "/review"）を注入して配信する。書き戻し先（POST /review）は
 *                  ツリービューと共有する（SOL-26 の適用経路を二重実装しない。SR-24）。
 *   GET  /document — req_document.ts の buildDocumentHtml(root)（SOL-31。章番号・目次
 *                  つきの文書体裁ビュー＝第3のタブ）を生成し、同じく
 *                  `window.__REVIEW_ENDPOINT__`（値は "/review"）を注入して配信する。
 *                  本ビューは読み取り専用の一方向生成のため POST /review は使わない
 *                  （サーバへの通信を一切持たない）。共通トップバーの記名欄は他2ビューと
 *                  同じ挙動にする。
 *   GET  /issues — req_issues_view.ts の buildIssuesHtml(root)（SOL-54 / SR-63。ローカル
 *                  Markdown イシュー（.scratch/<feature>/issues/*.md）の読み取り専用
 *                  ビューワ＝第4のタブ）を生成して配信する。他3ビューと違い
 *                  `window.__REVIEW_ENDPOINT__` を注入しない——書き戻しの経路を持たない
 *                  ビューに送信先を渡すと「この画面から書ける」という誤った信号になるため。
 *   GET  /coverage — req_coverage_view.ts の buildCoverageHtml(root)（SOL-55 / SR-65。テストの
 *                  十分性＝要件の被覆と行カバレッジを並べた第5のタブ）。イシュービューと同じく
 *                  書き戻しの経路を持たないため endpoint は注入しない。行カバレッジは
 *                  プロジェクト直下の coverage.lcov があれば読む（無ければ未計測と表示）。
 *   POST /review — JSON { reviewer, items: [{ id, verdict, comment?, questions? }] } を
 *                  受け取り、applyReviewActions(root, actions, { dryRun: false }) で
 *                  正本へ適用する。結果（適用件数・差分要約）を JSON で返す。
 *   GET  /ping   — サーバ接続 heartbeat 専用（SOL-51 / SR-60）。正本の読み込み・生成を
 *                  一切行わず 200 "ok" を即返すだけ。tree・guided 両ビューがこれを一定周期
 *                  で叩き、応答が無い・失敗したら画面上のモーダルで切断を知らせる
 *                  （req_tree.ts の initHeartbeat/HEARTBEAT_JS。document ビューは判定 UI が
 *                  無いため heartbeat の対象外）。
 *
 * --guided フラグ: 起動時に自動オープンする URL を /guided にする（--no-open 併用時は
 * 表示のみで自動オープンしない）。ルーティング自体は --guided の有無に関わらず GET /・
 * GET /guided の両方が常に有効（フラグは「どちらを最初に開くか」だけを決める）。
 *
 * 認証は記名のみ（POST の reviewer フィールド）。待受は 127.0.0.1 限定・外部送信なし
 * （単独ローカル運用前提。ADR-007 が明示した射程）。
 *
 * 外部 npm 依存は追加しない（node:http, node:fs, node:path, node:util,
 * node:child_process のみ）。
 *
 * 終了コード: SIGINT による停止=130（終了操作を廃した現在、これが通常の停止経路である）、
 * サーバ起動失敗=2、入力検証エラー（--root 不正等）=1。0 を返す経路は無い。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import * as http from "node:http";
import { spawn } from "node:child_process";

import { applyReviewActions } from "./reqlib.ts";
import { applyInflowValidation } from "./req_validate.ts";
import type { ReviewAction, ReviewVerdict } from "./reqlib.ts";
import { buildHtml } from "./req_tree.ts";
import { buildGuidedHtml } from "./req_guided.ts";
import { buildDocumentHtml } from "./req_document.ts";
import { buildIssuesHtml } from "./req_issues_view.ts";
import { buildCoverageHtml } from "./req_coverage_view.ts";

const REVIEW_PATH = "/review";
const GUIDED_PATH = "/guided";
const DOCUMENT_PATH = "/document";
// イシュービュー（SOL-54 / SR-63）。読み取り専用のため書き戻しエンドポイントは注入しない。
const ISSUES_PATH = "/issues";
// カバレッジビュー（SOL-55 / SR-65）。読み取り専用のため書き戻しエンドポイントは注入しない。
const COVERAGE_PATH = "/coverage";
const PING_PATH = "/ping";
// validate（SOL-56 / SR-66 方向 B）は他の 4 つと書き戻し先が違う——正本の state.validation と
// meta/validations/ を触り、meta/reviews/ には書かない。そのため applyReviewActions ではなく
// applyInflowValidation へ振り分ける（記録の形式・安全側の規約は req_validate の CLI と共用。
// 二重実装しない）。
const VERDICTS: ReadonlySet<string> = new Set(["approve", "reject", "hold", "unconfirm", "validate"]);
// 既定は固定ポート。ブラウザの localStorage は origin（ホスト:ポート）ごとに分離されるため、
// 毎回ランダムポートだとレビュアー名・折りたたみ状態等の保存が再起動で引き継がれない。
// 固定ポートで origin を安定させ localStorage を効かせる。使用中なら空きポートへフォールバック。
const DEFAULT_PORT = 8765;

interface CliOptions {
  root: string;
  port: number;
  noOpen: boolean;
  guided: boolean;
}

function defaultRoot(): string {
  // 既定の対象は呼び出し元プロジェクト（プラグイン自身の正本を黙って対象にしない）
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "docs", "requirements");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * req_tree.ts の buildHtml(root) の出力（決定的・file:// 安全）に、配信時にだけ
 * `window.__REVIEW_ENDPOINT__` を注入する。buildHtml 自体・生成済みファイルには
 * 触れない（文字列挿入のみ。<head> の直前に置き、本体スクリプトより先に実行させる）。
 */
function injectReviewEndpoint(html: string, endpointPath: string): string {
  return injectHead(html, `<script>window.__REVIEW_SERVED__=true;window.__REVIEW_ENDPOINT__=${JSON.stringify(endpointPath)};</script>\n`);
}

/**
 * 配信フラグだけを注入する（施主指示 2026-08-11「ローカルイシューのページも、他のレビュー画面と
 * ヘッダやナビゲーションを共通化する」）。
 *
 * 書き戻しの経路を持たないビュー（イシュー・カバレッジ）にも、サーバ配信であることは伝える。
 * 送信先（__REVIEW_ENDPOINT__）は渡さないので「この画面から書ける」という誤った信号にはならず
 * （SOL-54 (f) / SOL-55 (e) の趣旨は維持）、ヘッダのビュー切替タブだけが他の 3 ビューと同じに
 * なる——配信中なのにタブが出ず、注記が「読み取り専用（file://）」と表示されていたのを直す。
 */
function injectReviewServed(html: string): string {
  return injectHead(html, "<script>window.__REVIEW_SERVED__=true;</script>\n");
}

/** 生成済み HTML の </head> 直前にスクリプトを差し込む（本体スクリプトより先に実行させる）。 */
function injectHead(html: string, snippet: string): string {
  const idx = html.indexOf("</head>");
  if (idx === -1) return snippet + html;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

function parseReviewPayload(raw: unknown): { reviewer: string; actions: ReviewAction[] } {
  if (!isRecord(raw)) {
    throw new Error("req_review_serve: レビュー送信データはオブジェクトである必要があります。");
  }
  const reviewer = raw["reviewer"];
  if (typeof reviewer !== "string" || reviewer.trim() === "") {
    throw new Error("req_review_serve: reviewer（記名）が必須です。");
  }
  const itemsRaw = raw["items"];
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
    throw new Error("req_review_serve: items は1件以上の配列である必要があります。");
  }
  const actions: ReviewAction[] = itemsRaw.map((itemRaw, i) => {
    if (!isRecord(itemRaw)) {
      throw new Error(`req_review_serve: items[${i}] はオブジェクトである必要があります。`);
    }
    const id = itemRaw["id"];
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`req_review_serve: items[${i}].id は必須の文字列です。`);
    }
    const verdict = itemRaw["verdict"];
    if (typeof verdict !== "string" || !VERDICTS.has(verdict)) {
      throw new Error(`req_review_serve: items[${i}].verdict の値が不正です（許容: approve/reject/hold/unconfirm/validate）: ${String(verdict)}`);
    }
    const commentRaw = itemRaw["comment"];
    const questionsRaw = itemRaw["questions"];
    return {
      id,
      verdict: verdict as ReviewVerdict,
      reviewer,
      comment: typeof commentRaw === "string" ? commentRaw : null,
      questions: typeof questionsRaw === "string" ? questionsRaw : null,
    };
  });
  return { reviewer, actions };
}

/** 確認日（YYYY-MM-DD）。レビュー記録が applyReviewActions 側で実行時刻を使うのと同じ規約に
 * 揃える（生成物には日付を埋め込まないが、人の操作の記録には操作時点の日付を残す）。 */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function tryOpenBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.on("error", (err) => {
      console.error(`req_review_serve: ブラウザの自動起動に失敗しました。手動で開いてください: ${url}（${err.message}）`);
    });
    child.unref();
  } catch (e) {
    console.error(
      `req_review_serve: ブラウザの自動起動に失敗しました。手動で開いてください: ${url}（${e instanceof Error ? e.message : String(e)}）`,
    );
  }
}

// リクエスト経由でサーバを終了させる経路は無い（終了操作の廃止。SR-61・SOL-52 改訂）ため、
// 以前ここへ渡していた finish コールバックは受け取らない。停止は SIGINT・起動失敗の
// 2 経路だけが持つ（runReviewServer 側）。
function requestListener(root: string): http.RequestListener {
  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
      res.end("Bad Request");
      return;
    }

    if (req.method === "GET" && pathname === "/") {
      let html: string;
      try {
        html = buildHtml(root);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end(`req_review_serve: ツリービューの生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const injected = injectReviewEndpoint(html, REVIEW_PATH);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(injected);
      return;
    }

    if (req.method === "GET" && pathname === GUIDED_PATH) {
      let html: string;
      try {
        html = buildGuidedHtml(root);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end(
          `req_review_serve: ガイド付きレビュービューの生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      const injected = injectReviewEndpoint(html, REVIEW_PATH);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(injected);
      return;
    }

    if (req.method === "GET" && pathname === DOCUMENT_PATH) {
      let html: string;
      try {
        html = buildDocumentHtml(root);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end(
          `req_review_serve: 文書体裁ビューの生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      // 文書ビューは同日中に「読みながらその場で確認（承認）できる」ビューへ変わった
      // （施主指示 2026-08-11。SOL-31 改訂）。書き戻しの経路を持つビューになったので
      // 送信先を注入する——タブを出すためだけの便乗ではなく、実際に使う。
      // （同日午前に一度 injectReviewServed へ変えたが、それは「サーバへ一切通信しない」
      //   という当時の設計に合わせた変更で、その前提のほうが施主指示で覆った。）
      const injected = injectReviewEndpoint(html, REVIEW_PATH);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(injected);
      return;
    }

    if (req.method === "GET" && pathname === ISSUES_PATH) {
      // イシュービュー（SOL-54）: ローカルイシューの読み取り専用の窓。他 3 ビューと違い
      // injectReviewEndpoint を通さない——書き戻しの経路を持たないビューに送信先を渡すと、
      // 「この画面から書ける」という誤った信号になるため（SOL-54 (f)）。
      let html: string;
      try {
        html = buildIssuesHtml(root);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end(
          `req_review_serve: イシュービューの生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(injectReviewServed(html));
      return;
    }

    if (req.method === "GET" && pathname === COVERAGE_PATH) {
      // カバレッジビュー（SOL-55）: テストの十分性を読むための窓。イシュービューと同じく
      // 書き戻しの経路を持たないため injectReviewEndpoint を通さない。
      // 行カバレッジの入力（lcov）は、プロジェクト直下の coverage.lcov があれば拾う——
      // 無ければ「未計測」として要件の被覆だけを出す（ビューを開くたびにテスト全体は走らせない）。
      let html: string;
      try {
        const lcov = path.resolve(root, "..", "..", "coverage.lcov");
        html = buildCoverageHtml(root, fs.existsSync(lcov) ? lcov : null);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end(
          `req_review_serve: カバレッジビューの生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(injectReviewServed(html));
      return;
    }

    if (req.method === "GET" && pathname === PING_PATH) {
      // SOL-51 / SR-60: tree・guided 両ビューの heartbeat 専用の軽量エンドポイント。
      // 正本の再読み込み・再生成を一切行わず、サーバが生きていることだけを即答する。
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
      res.end("ok");
      return;
    }

    if (req.method === "POST" && pathname === REVIEW_PATH) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let bodyRaw: unknown;
        try {
          const text = Buffer.concat(chunks).toString("utf-8");
          bodyRaw = text === "" ? {} : JSON.parse(text);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
          res.end(JSON.stringify({ error: `送信データの JSON 解析に失敗しました: ${e instanceof Error ? e.message : String(e)}` }));
          return;
        }

        let parsed: { reviewer: string; actions: ReviewAction[] };
        try {
          parsed = parseReviewPayload(bodyRaw);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          return;
        }

        let summary: ReturnType<typeof applyReviewActions>;
        try {
          // validate は書き戻し先が違うため別経路へ。要求順（items の並び）どおりに結果を
          // 返す（クライアントは results[0] を見る）。
          const reviewActions = parsed.actions.filter((a) => (a.verdict as string) !== "validate");
          const applied = reviewActions.length > 0 ? applyReviewActions(root, reviewActions, { dryRun: false }) : null;
          const byId = new Map((applied?.results ?? []).map((r) => [r.id, r]));
          const results = parsed.actions.map((a) =>
            (a.verdict as string) === "validate"
              ? applyInflowValidation(root, { id: a.id, validatedBy: parsed.reviewer, date: todayIso() })
              : (byId.get(a.id) ?? { id: a.id, ok: false, verdict: a.verdict, error: "適用結果が見つかりません", changes: [] }),
          );
          summary = { ...(applied ?? { dryRun: false }), results } as ReturnType<typeof applyReviewActions>;
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
          res.end(JSON.stringify({ error: `正本への適用に失敗しました: ${e instanceof Error ? e.message : String(e)}` }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
        res.end(JSON.stringify(summary));
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
    res.end("Not Found");
  };
}

function runReviewServer(opts: CliOptions): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;

    const onSigint = (): void => {
      console.error("req_review_serve: 中断されました。");
      finish(130);
    };

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSigint);
      server.closeAllConnections();
      server.close();
      resolve(code);
    };

    const server = http.createServer(requestListener(opts.root));

    const onListening = (): void => {
      const addr = server.address();
      const actualPort = addr && typeof addr === "object" ? addr.port : opts.port;
      const url = `http://127.0.0.1:${actualPort}/`;
      // テストがこの行から URL を取る。必ず1行だけ標準出力に印字する（--guided 指定時も
      // 基点 URL は変えない。自動オープン先だけを /guided に切り替える）。
      console.log(`req_review_serve: ${url}`);

      if (!opts.noOpen) tryOpenBrowser(opts.guided ? `${url}guided` : url);
    };

    let triedFallback = false;
    server.on("error", (e: NodeJS.ErrnoException) => {
      // 既定の固定ポートが使用中なら、空きポート（0）へ一度だけフォールバックする。
      // その場合 origin が変わるため localStorage は固定ポート時と共有されない旨を通知する。
      if (e.code === "EADDRINUSE" && !triedFallback && opts.port !== 0) {
        triedFallback = true;
        console.error(
          `req_review_serve: ポート ${opts.port} は使用中のため空きポートで起動します（localStorage はポート ${opts.port} 起動時と共有されません）。`,
        );
        server.listen(0, "127.0.0.1", onListening);
        return;
      }
      console.error(`req_review_serve: サーバの起動に失敗しました: ${e.message}`);
      finish(2);
    });

    process.on("SIGINT", onSigint);

    server.listen(opts.port, "127.0.0.1", onListening);
  });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      port: { type: "string", default: String(DEFAULT_PORT) },
      "no-open": { type: "boolean", default: false },
      guided: { type: "boolean", default: false },
    },
  });

  const root = values.root ? path.resolve(values.root) : defaultRoot();
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`req_review_serve: --root で指定されたディレクトリが存在しません: ${root}`);
    return 1;
  }

  const port = Number.parseInt(values.port ?? "0", 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    console.error(`req_review_serve: --port は 0〜65535 の整数で指定してください: ${values.port}`);
    return 1;
  }

  const opts: CliOptions = {
    root,
    port,
    noOpen: Boolean(values["no-open"]),
    guided: Boolean(values["guided"]),
  };

  return runReviewServer(opts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    });
}
