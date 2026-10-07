# ADR 0678: 09/28 にマージされた A 群の前半7本（#1308・#1310・#1318・#1319・#1324・#1327・#1329）の確かめ直しで見つかった穴に歯を足す（Issue #1827）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1827](https://github.com/takecchi/mnemora/issues/1827)。
これは試験だけの変更で、実装・`*-conformance.ts`・`__fixtures__/` は触らない（変異を一時的に当てただけで、控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた）。ADR 0607・0608・0611 の表にある変異は当て直していない。

## 経緯【実測】

約束ごとに、足りない側とやりすぎた側の変異を当てた。結果の表は Issue #1827 のコメントにある。約束が後の採用済み ADR で動いていた点は次のとおり。

- ADR 0521（testkit の fixture と core の Fake も大文字の id を Postgres と同じ記憶として扱う）は #1324・#1327 の「fixture では大文字は not_found」を逆にした。この点は当てていない。
- ADR 0380（reextract の退けた記憶の確認は版を問わない）は #1319 の「今の extractorVersion」を広げた。広がった約束に当てた。

## 足した歯

| PR | すり抜けた変異 | 歯 |
|---|---|---|
| #1310 | 案内の条件に英語の `message` の一致を足す／条件を英語の `message` に絞る／案内の文書名を壊す／`cause` が `null` で投げる | `packages/postgres/src/__tests__/migration-failure-message-edges.test.ts` |
| #1318 | `droppedCandidates.message` の NUL・孤立サロゲートの置き換えを外す／500 字の切りを変える／空文字の `code` を通す／全件が落ちたとき最後の例外を投げる／`created` の追記の失敗を握りつぶす | `packages/core/src/__tests__/extract-dropped-candidate-record-fake.test.ts` |
| #1318 | Postgres・fixture の `createMemoriesWithOutboxAndEvents` が全件落ちたとき最後の例外を投げる | `packages/postgres/src/__tests__/memory-store-batch-first-error.postgres.test.ts` |
| #1319 | 最新でなく最初の `superseded` イベントの理由を見る／退けた記憶が2件あっても `skipped` を先頭だけにする | `packages/postgres/src/__tests__/reextract-withdrawn-latest-superseded-reason.postgres.test.ts` |
| #1324・#1327・#1329 | restoreArchived・purge・markContested が `getMany` へ小文字の id を渡す／`resolveContested` が `supersededById` を小文字にして渡す／restoreArchived・purge・reflect の混在した綴りの突き合わせを小文字だけにする／同じ綴りの重複を混在に数える／綴りの違う `winnerId` で store を余計に読む | `packages/core/src/__tests__/store-id-passthrough-other-mouths.test.ts` |

歯は、元の変異を当てると赤になることを確かめてから入れた。

## 塞がなかったもの

- #1308: 前のクエリを SQL に送らない変異は、返す結果が同じ（等価）。ベクトルを DB が拒む入力は ADR 0424 以降なく、観測できるのは SQL の本数だけ。
- #1324: `reinforceMany` の去重を外す変異は等価（`UPDATE … FROM unnest` は同じ行を1回しか更新しない）。
- #1327: `resolveContestedPair` の `supersededById` の正規化を外す変異と、`resolveOrphanedContested` の `contestedWithId` の正規化を外す変異は等価（形の検査は `normalizeUuidCase` を通し、SQL の uuid 比較は大文字小文字を区別しない）。
- #1319: `superseded` イベントの一覧を `kind` で絞らない変異は等価（`superseded` の記憶の最後のイベントは `superseded`）。

## これが覆るとしたら

案内の条件（`code` と `routine`）、落とした候補の記録の形、退けた記憶に数える `superseded` の理由、store へ渡す id を変えないこと、が変わるとき。
