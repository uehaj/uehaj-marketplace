---
name: hatena-x-comment-refine
description: はてなブックマーク（b.hatena.ne.jp）に溜まった x.com / Twitter のブックマークを、リンク先のポスト本文を読んで「[タグ][タグ] 要約」形式のコメントに付け直す。Claude in Chrome でブラウザを操作し、はてブのコメント更新と RSS での照合まで行う。「はてブの x.com のブックマークにコメントをつけ直して」「Twitter のブクマのコメントを要約に書き換えたい」「コメントが空・短いブクマを整理したい」「x.com のブックマークにタグを付けたい」など、はてなブックマーク＋x.com/Twitter＋コメント整理の話で使う。togetter、note など他ドメインのブックマークにも同じ手順を流用できる。手で呼ぶなら /uehaj:hatena-x-comment-refine。
---

# はてブ x.com コメント付け直し

はてなブックマークに大量に溜まった x.com のブックマークは、タイトルが生URLのままで、コメントが空か「cc」のような自分用メモになっていることが多い。後から検索・回顧できるように、リンク先のポスト本文を実際に読んで、`[タグ][タグ] 要約` 形式のコメントに付け直す。

この作業は公開コメントの書き換えなので、実行前に必ず対象一覧と文面案をユーザーに見せて承認を得ること。

## 前提

- Claude in Chrome（mcp__claude-in-chrome__*）が使えること
- ユーザーのブラウザで、はてなと X の両方にログイン済みであること（X は未ログインだと本文が読めない）
- b.hatena.ne.jp を開いているタブが1枚あること（以下「はてなタブ」）。RSS取得・書き込み・最終確認はすべてこのタブ上の javascript_tool で行う
- 以下 `{user}` ははてなID。分からなければユーザーに聞くか、はてなタブで `https://b.hatena.ne.jp/my` を開いたときのリダイレクト先から読む

## 全体の流れ

1. スコープを確認する（件数・対象条件・コメント形式）
2. 対象ブックマークを RSS で一括収集する（はてなタブで fetch）
3. 各ポストの本文をブラウザで読む（X 用の作業タブ）
4. コメント案を作り、一覧をユーザーに提示して承認を得る
5. はてブのエントリーページで、編集フォームに JS で値を流し込んで保存する
6. RSS を読み直し、期待値とプログラムで突き合わせる

## 1. スコープを確認する

x.com のブックマークは数百〜数千件あることが普通なので、いきなり全件やらない。AskUserQuestion で次を確認する。

- 対象範囲: 直近何件か（20 / 50 / 100 / 全件）
- 対象条件: コメントが空のものだけか、短いもの（何文字以下か）も含めるか、全部か
- コメント形式: [タグ]＋要約 / 要約のみ / タグのみ

デフォルトの提案は「直近100件・15文字以下（空を含む）・[タグ]＋要約」。すでに長いコメントが付いているものは本人が考えて書いたものなので、勝手に上書きしない方が安全。

## 2. 対象ブックマークを収集する

ユーザーのブックマークをドメインで絞り込む URL はこれ（url パラメータが「そのドメイン配下」フィルタとして効く）:

```
https://b.hatena.ne.jp/{user}/bookmark?url=https%3A%2F%2Fx.com%2F
```

ページ内の検索ボックスは全文検索でありURL検索ができないので使わない。件数はこのページのタイトル（「ブックマーク / x.com (1,047)」）で分かる。

一覧の取得は RSS が圧倒的に速い（HTMLをスクレイプするとタグ一覧のサイドバーが巨大で読み取りコストが高い）。ページングは `page` パラメータ（1ページ20件、`of=` は無視される）。

**はてなタブ上で javascript_tool から同一オリジン fetch するのが最速・最正確。** WebFetch と違って要約モデルを通らないので、URL・コメントが逐語で取れる。

```js
const out=[];
for(let p=1;p<=5;p++){
  const t=await fetch(`https://b.hatena.ne.jp/{user}/bookmark.rss?url=https%3A%2F%2Fx.com%2F&page=${p}`).then(r=>r.text());
  const d=new DOMParser().parseFromString(t,'text/xml');
  d.querySelectorAll('item').forEach(i=>out.push({
    link:i.querySelector('link').textContent,
    desc:(i.querySelector('description')||{}).textContent||''
  }));
}
window.__t=out.map((o,k)=>({k,...o})).filter(x=>[...x.desc].length<=15);
window.__t.map(x=>x.k+'\t'+x.link+'\t'+x.desc).join('\n')
```

- description が既存コメント（タグは含まない）。タグは `dc:subject` 要素に1つずつ入る。
- 結果が長いとツール出力が `[TRUNCATED]` になるので、`window.__t` に置いてから短い形式で取り出す。
- 既存タグの使用頻度も同じ要領で `dc:subject` を数えると、タグ選びの参考になる（10ページ程度で十分）。
- WebFetch しか使えない環境なら「各itemのlinkとdescriptionを逐語で番号付きリストにして」と指示すれば代用できる。

重要: ここで得た link はブックマーク時のURLそのもの（`?s=20` が付いていたり、`x.com/i/status/...` だったり `x.com/{user}/status/...` だったりする）。編集ステップではこの完全一致のURLを使う必要があるので、原文のまま控えておく。

## 3. 各ポストの本文を読む

X 用の作業タブを1枚作り（tabs_create_mcp）、そこへ順に遷移して get_page_text する。

```
navigate https://x.com/{author}/status/{id} → wait 4s → get_page_text
```

- browser_batch で1回に **3〜4件** まとめる。長文の X 記事（Article）が混ざると出力が膨らみ、4件超のバッチは拡張側で失敗することがある。失敗したら件数を減らして再実行。
- get_page_text は `<article>` を拾うので、投稿者名・本文・引用ポスト・リンク先タイトルまで取れる。外国語ポストは X の自動翻訳が効いていれば日本語で返ってくる。
- 終わったら作業タブは tabs_close_mcp で閉じる。

読めないケース（対象から外し、最後にユーザーへ報告する）:

- 削除済み … `<main>` から「このページは存在しません」が返る
- 凍結アカウント … 「凍結されたアカウントによるポストです」とだけ返る
- 鍵アカウントも同様

## 4. コメント案を作って承認を得る

### 文面の作り方

`[タグ1][タグ2] 要約` の形。はてブは行頭の `[...]` をタグとして解釈し、100文字制限のカウントからも除外してくれる。タグは新規に作るより、ユーザーが既に使っているものに寄せる方が後で辿りやすい。

要約は、その投稿を読み返さなくても何の話か分かることを目指す。ツール名・固有名詞・数字・結論を優先し、「〜について解説」のような中身のない締めは避ける。宣伝目的やコミュニティノートが付いた投稿は、その旨を一言添えると後で判断材料になる。

既存の短いコメント（「cc」「grill-me」など）は本人にとって意味のあるキーワードなので、捨てずに新コメント冒頭のキーワードやタグとして残す。

例:

- 既存: grill-me / 内容: mattpocockが自分の25個のスキルを10分で紹介する動画
  → `[ClaudeCode][Skills] grill-me：mattpocockの25スキルを10分で解説する動画。Theo公認`
- 既存: (空) / 内容: Anthropic公式のOpus5向けプロンプトガイドの11項目解説（情報商材の宣伝つき）
  → `[Opus5][プロンプト] 公式Opus5ガイド解説：長さは明示指示、検証命令は削除、スコープ縛り、effortはlow/medium主軸（宣伝多め）`

### 文字数チェック

案は TSV（番号・URL・コメント）にまとめ、python で「先頭の `[..]` 群を除いた本文」が100文字以下か確認してから提示する。超えたものは言い換えて縮める。

### 承認

対象URL・既存コメント・新コメント案を並べた Markdown 表を作ってユーザーに渡し、AskUserQuestion で適用可否を聞く。公開コメントの一括書き換えは取り消しが面倒なので、ここを飛ばさない。

## 5. はてブのコメントを書き換える

編集はエントリーページのインライン編集フォームから行う。`/add`, `/bookmarklet`, `/entry/panel/` はすべてエントリーページへリダイレクトされるだけで使えない。

```
https://b.hatena.ne.jp/entry?url={ブックマーク時のURLをencodeしたもの}
```

### 推奨: 編集フォームに JS で値を入れてサイト自身の保存ボタンを押す

ページ上の構造:

- 編集ボタン: `.js-inplace-edit`
- インライン編集フォーム: `form.js-add-form:not(.bookmark-modal-form)`（`/my/bookmark` へ POST する）
- コメント欄: `textarea[name=annotation]`（タグもここに `[..]` で書く）
- チェックボックス: `post_twitter`, `privacy`, `bookmark_stock` — **post_twitter が ON なら中断する**

1件ぶんの JS（はてなタブで実行）:

```js
document.querySelector('.js-inplace-edit').click();
await new Promise(r=>setTimeout(r,1500));
const f=document.querySelector('form.js-add-form:not(.bookmark-modal-form)');
if(f.post_twitter.checked) throw 'tw';
const ta=f.annotation; ta.focus();
ta.value="<新コメント（JSON文字列としてエスケープ）>";
ta.dispatchEvent(new Event('input',{bubbles:true}));
f.querySelector('input[type=submit],button[type=submit]').click();
await new Promise(r=>setTimeout(r,2500));
'<番号> done'
```

これを python で全件ぶん生成し（コメントは `json.dumps(c, ensure_ascii=False)` で埋め込む）、browser_batch に「navigate → wait 3 → javascript_tool」×6件ずつ並べて流す。1件目だけは単独で実行し、RSS で反映を確かめてから残りを流すと安全。

利点: キー入力を使わないので、type が途中で切れる・漢字が化ける・1回目のクリックが効かない、といった問題がすべて起きない。1件あたりのツール呼び出しも実質1回。

注意:

- hidden フィールドの値（rks 等のトークン）を読み出したり、API を直接叩いたりはしない。あくまでフォームに値を入れてサイトの保存ボタンを押すだけにする（トークン類を含む出力はツール側でブロックされる）。
- フォームの class 名が変わったら、`[...document.querySelectorAll('form')]` で action・class・要素名（type=hidden の値は出さない）を列挙して構造を確認し直す。

### フォールバック: 画面操作で入力する

JS で動かない場合のみ。1件あたり3回のツール呼び出し:

- (a) `navigate → wait 5 → find("ブックマークを編集 button")`
- (b) `screenshot → left_click(ref) → wait 2 → key cmd+a → type "<新コメント>" → wait 1 → zoom(コメント欄)`
- (c) `key cmd+Return → wait 3 → zoom(コメント欄)`（保存は cmd+Return が効く）

このやり方の罠:

- ページ読み込み直後の1回目のクリックは効かない（ホバー扱いでツールチップが出るだけ）。直前に screenshot を挟むとタブがアクティブになり次のクリックが通る。zoom や hover では代替にならないことがある。
- クリックは必ず ref 指定で。座標指定はビューポートとずれて当たらない。
- 同一バッチ内でクリックを2回続けない（2回目でフォームが閉じ、cmd+Return が別要素に飛んでページ遷移することがある）。
- 複数タブがあるとクリックが不安定。tabs_context_mcp の selectedTabId で作業する。
- type が途中で切れることがある（タグだけ入って本文が入らない等）。zoom で確認してから保存する。確認前に cmd+Return しない。
- type は一部の漢字を化けさせる（「沈静化」→「遙静化」、「捌く」→「捗く」など）。常用度の低い漢字は避け、平易な語に言い換える。

## 6. 最終確認

はてなタブで RSS をキャッシュ回避パラメータ（`&v=${Date.now()}`）付きで読み直し、`dc:subject` から `[タグ]` を組み立てて description と連結したものを、期待値（URL→コメントの辞書）と**完全一致で比較**する。

```js
const W={/* "author/status/id": "[タグ][タグ] 要約", ... */};
const got={};
for(let p=1;p<=5;p++){
  const t=await fetch(`https://b.hatena.ne.jp/{user}/bookmark.rss?url=https%3A%2F%2Fx.com%2F&page=${p}&v=${Date.now()}`).then(r=>r.text());
  const d=new DOMParser().parseFromString(t,'text/xml');
  d.querySelectorAll('item').forEach(i=>{
    const tags=[...i.getElementsByTagName('dc:subject')].map(s=>'['+s.textContent+']').join('');
    got[i.querySelector('link').textContent.replace('https://x.com/','')]=tags+' '+i.querySelector('description').textContent.trim();
  });
}
const bad=Object.keys(W).filter(k=>got[k]!==W[k]).map(k=>k+' GOT:'+got[k]);
'ok='+(Object.keys(W).length-bad.length)+'\n'+bad.join('\n')
```

不一致があれば、その件だけ手順5をやり直す。目視や WebFetch の要約に頼らないこと（要約モデルが漢字を取り違えることがある）。

最後にユーザーへ報告する内容:

- 実際に更新した件数（と、突き合わせで全件一致したこと）
- 対象外にしたもの（削除済み・凍結アカウント、閾値を超えていたもの）とその理由
- 付与したタグの傾向（既存タグに寄せたもの / 新規に作ったもの）
