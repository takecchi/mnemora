# ADR 0603: 09/29 にマージされた #1437・#1435 の確かめ直しで見つかった穴を塞ぐ（`deleteAcrossSpaces` が渡していない記憶を残すこと・退けたかを最新の superseded で決めること）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

クローンのマネージャー（mgr-9a36f2f4）が書いた。歯を書くと決めたのはクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0598](./0598-adr-0490-0480-0485-merged-pr-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯【実測】

2026-09-29（UTC）にマージされ、実装を変えた7本を、いまの main で独立に確かめ直した。このうち #1437・#1435 で、次の変異がどの歯にも捕まらなかった（ほかの5本の穴は別の ADR で塞ぐ）。

| PR・ADR | 約束 | すり抜けた変異 | 通った理由 |
|---|---|---|---|
| #1437（[ADR 0382](./0382-vector-store-delete-across-spaces.md)） | `VectorStore.deleteAcrossSpaces(ctx, memoryIds)` は、渡した `memoryIds` の行を全 space から消す | testkit の InMemory・core の Fake が、渡した id 以外も含めてテナントの行を全部消す | 適合テスト（`@mnemora/testkit` の `vector-store-conformance.ts`）の `deleteAcrossSpaces` の歯は、記憶を1件しか置いていなかった。testkit の適合テスト（667件）、testkit の8本、postgres 側で InMemory と突き合わせる3本がすべて緑 |
| #1435（[ADR 0380](./0380-reextract-withdrawn-across-extractor-versions.md)） | reextract は、訂正の解決で負けた `superseded`（**最新**の `superseded` イベントの `meta.reason === "contested_resolved"`）を「退けた」と数える | 最初の `superseded` イベントの理由で決める | `superseded` のイベントを2つ以上持つ記憶の歯が無かった。reextract を叩く core の24本・postgres 側の4本がすべて緑 |

適合テストは、外部の adapter の作者も使う出荷物である。1件の purge でテナントの全部の embedding を消す adapter が通る隙間は、Fake・fixture だけの話より重い【判断】。

## 決定【判断】

1. 実装は変えない。
2. 歯を足す（試験だけ）。
   - **#1437**: `packages/testkit/src/vector-store-conformance.ts` に「`deleteAcrossSpaces`: 渡していない memoryId の行は、同じテナント・同じ space でも残る」。同じテナントに記憶を2件置き、どちらも2つの space に行を持たせ、片方だけを消す。2つの space の検索が、残した記憶だけを返すこと。適合テストなので、testkit の InMemory と `@mnemora/postgres` の両方に流れる。
   - **#1435**: `packages/core/src/__tests__/wait-state-change-skipped.test.ts` に2本。記憶 x を訂正の解決で負けさせ（今の時刻で `contested_resolved` の superseded イベント）、それより前、または後の時刻に `meta.reason: "consolidated"` の superseded イベントを足してから reextract する。最新が `contested_resolved` なら打ち切る（`extraction: "skipped"`）。最新が機構の置き換えなら打ち切らない（`extraction: "ok"`、記憶を1件書く）。向きを逆にした2本で、最初のイベントで決める実装を両側から見分ける。

## 変異試験【実測】

実装ファイルを `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめ、同じファイルを緑に戻した。

| 変異 | 側 | 赤 | 戻して |
|---|---|---|---|
| testkit `deleteAcrossSpaces` がテナントの行を全部消す | やりすぎ | 新しい歯（`expected [] to deeply equal [ 'mem-…' ]`） | 適合テスト 668件緑 |
| testkit `deleteAcrossSpaces` が何も消さない | 足りない | 既存の「複数 space にある同じ memoryId の行が、全部消える」と新しい歯の2本 | 同上 |
| reextract が最初の superseded イベントの理由で決める | 取り違え | 新しい2本（`expected 'ok' to be 'skipped'`・`expected 'skipped' to be 'ok'`） | 16本緑 |
| reextract が訂正で負けた superseded も数えない | 足りない | 既存の3本と新しい「最新が contested_resolved なら…打ち切る」 | 16本緑 |
| reextract が superseded を理由を見ずに全部数える | やりすぎ | 既存の対照2本と新しい「最新が機構の置き換えなら…打ち切らない」 | 16本緑 |

新しい適合テストの歯は、`@mnemora/postgres`（PostgreSQL 17、`C.UTF-8`）でも緑であることを確かめた（`conformance.postgres.test.ts` の `deleteAcrossSpaces` の6本）。

## 縛っていないもの

- core の Fake の `deleteAcrossSpaces` は、適合テストを通らない（Issue #768 のコメント2）。同じ「テナントの行を全部消す」変異は Fake でもすり抜けたが、この ADR では Fake の歯を足していない（クローンの判断は適合テストに足すこと）。
- reextract の歯は core の Fake で書いた。testkit の InMemory・Postgres で同じ形を流す歯は足していない（runtime の判定は store に依らない1か所なので、Fake で縛れば足りると見た）。

## これが覆るとしたら

`deleteAcrossSpaces` の契約が、渡した id 以外も消してよいものに変わるとき（ADR 0382）。reextract が「退けた」と数える条件を、最新の superseded イベント以外で決めると変えるとき（ADR 0380）。
