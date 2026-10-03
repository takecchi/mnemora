# ADR 0598: 10/01 にマージされた #1582〜#1597 の確かめ直しで見つかった穴を塞ぐ（アクセント付きのラテン文字・`createRecall` の `createdAt` の写し・`excludeMemoryIds` の等しさ）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンのマネージャー（mgr-9a36f2f4）が書いた。歯を書く穴と書かない隙間を分けたのはクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0580](./0580-adr-0568-nonexistent-id-and-event-get-controls.md) などの試験だけの PR と同じ）。

## 経緯【実測】

2026-10-01（UTC）にマージされ、Fake・testkit の fixture・出荷パッケージの src を変えた7本（#1597・#1594・#1588・#1583・#1586・#1584・#1582）を、いまの main で独立に確かめ直した。約束ごとに「足りない実装」「やりすぎた実装」の変異を当て、名指しのファイルを走らせた。すり抜けたのは次の4つ。

| PR・ADR | 約束 | すり抜けた変異 | 通った理由 |
|---|---|---|---|
| #1597（[ADR 0490](./0490-language-mismatch-latin-letters-only.md)） | ラテン文字は「文字（`\p{L}`）かつ `Script=Latin`」を数える。0490 の当てた形の表は「本文がアクセント付きラテン（スペイン語）は陽性」 | `LATIN = /[A-Za-z]/gu`（ASCII の英字だけ） | テストのどのファイルにも、アクセント付きのラテン文字を含む入力が無かった（grep で確かめた） |
| #1588（[ADR 0480](./0480-recall-record-createdat-invalid-date-fake-aliasing.md)） | Fake の `createRecall` は書く側で写しを取る（別名参照を残さない） | `createdAt` だけ呼び手の Date をそのまま保存する | 別名参照の歯は、入力の `query`・`explain` と、戻り値の `createdAt` しか書き換えていなかった |
| #1594（[ADR 0485](./0485-find-correction-candidates-exclude-ids.md)） | `excludeMemoryIds` は id の等しさ（大文字小文字は畳む）で除外する | 渡した文字列で始まる id も除外する | 前方一致の関係にある id を渡す歯が無かった |
| #1583（[ADR 0476](./0476-label-upsert-lock-order-and-taxonomy-probes.md)） | `labels` を触る順は、どの経路でもコードポイント順 | 作成の経路（upsert）だけ降順にする | 下の「縛っていないもの」 |

## 決定【判断】

1. 実装は変えない。
2. 歯を足す（試験だけ。どれも `packages/core/src/__tests__/`）。
   - **#1597**: `language-mismatch.test.ts` に「アクセント付きのラテン文字もラテン文字として数える」。日本語の観測にスペイン語の本文（`panadería`・`mañana`）とフランス語の本文（`préfère`・`café`・`crème`・`réunions`・`à`・`côté`）を当て、印が付くこと、`contentLatinLetters` が本文の `\p{L}` の数と等しいこと（ASCII の英字の数より多いことを前提として先に確かめる）、`contentLatinShare` が 1 であること。印の有無だけでは足りない——スペイン語の文はアクセント付きの文字が少なく、ASCII だけを数えても割合が 0.9 を割らないので、印は付いたままになる。
   - **#1588**: `fake-purge-expired-recalls-and-completed-jobs.test.ts` の別名参照の歯に、渡した `createdAt` を `setTime(0)` で書き換えても `getRecall` の `createdAt` が渡したときの値のままであることを足す。
   - **#1594**: `correction-candidates-exclude-edges.test.ts` に「除外は id の等しさで比べる」。Fake の id は全体で共有する通し番号の `mem-N` なので、「別の記憶の id で始まる id」の組（`mem-1` と `mem-10`）を確実には作れない。代わりに、実在の id の末尾の1字を落とした文字列（どの記憶の id でもないが、実在の id はこれで始まる）を `excludeMemoryIds` に渡し、`excludedCount` が 0 で、実在の記憶が候補に残ることを見る。前方一致で除外する実装はこれを除外する。

## 変異試験【実測】

実装ファイルを `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめ、同じファイルを緑に戻した。

| 変異 | 赤 | 戻して |
|---|---|---|
| L2: `LATIN = /[A-Za-z]/gu` | スペイン語（`expected 59 to be 61`）・フランス語（`expected null not to be null`。印が付かない）の2本 | `language-mismatch.test.ts` 19本緑 |
| K1: `createdAt: record.createdAt !== undefined ? record.createdAt : new Date()` | 別名参照の歯（`expected '1970-…' to be '2026-03-01…'`） | 6本緑 |
| C3: 渡した文字列で始まる id も除外する | 等しさの歯（`expected 1 to be +0`） | 4本緑 |

## 縛っていないもの

- **#1583（ADR 0476）の作成の経路だけ逆順にする変異（D2）**: 決定的な歯は作りにくい隙間として、歯にしない（クローンの判断）。
  - D2 では、作成の経路（`createMemory` → `upsertProposedLabels`）が降順になり、`supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents` の先取り（`lockExistingLabelsInNameOrder`。名前順の `SELECT … FOR UPDATE` 1文）や purge・scrub の名前順と食い違う。本番では低い確率で循環待ち（40P01）になりうる【判断】。
  - 既存の歯（`label-upsert-lock-order.postgres.test.ts`・`label-lock-order-cross-memory.postgres.test.ts`）は「作成どうし」「先取りする経路どうし」「purge が UPDATE の途中で眠る間の作成」を見る。作成どうしは同じ（逆の）順で揃うので循環しない。先取りは1文で一瞬に終わり、その最中に逆順の作成を割り込ませる仕掛けが無い。【実測】D2 で2本・8件が3回とも緑。
  - 捕まえるには、labels のロックを取る順を記録して見る（実行した SQL の順の観測など）別の仕掛けが要る。費用に見合わないと見て、歯にしない。
- **#1583 の「`Memory.tags` は並べ替えずに保存する」のやりすぎ側（保存する `tags` を並べ替える変異）**: 確かめていない。ADR 0476 の2本目の歯（`["d","a","d","b"]` のまま保存される）が捕まえると読んだが、変異は走らせていない【未確認】。
- 確かめ直しで当てなかった変異（同値の変異・ADR が当てた変異の繰り返し・届かない死んだコード）は、確かめ直しの報告に理由を書いた。

## これが覆るとしたら

言語の事後検査が数える文字の範囲を変えるとき（ADR 0490）。Fake が `createRecall` の入力の写しを取る範囲を変えるとき（ADR 0480）。`excludeMemoryIds` の突き合わせを等しさ以外にすると決めたとき（ADR 0485）。
