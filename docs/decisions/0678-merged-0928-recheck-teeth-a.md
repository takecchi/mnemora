# ADR 0678: 09/28 にマージされた A 群14本（#1308・#1310・#1318・#1319・#1324・#1327・#1329・#1335・#1350・#1351・#1354・#1355・#1366・#1378）の確かめ直しで見つかった穴に歯を足す（Issue #1827）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1827](https://github.com/takecchi/mnemora/issues/1827)。
これは試験だけの変更で、実装・`*-conformance.ts`・`__fixtures__/` は触らない（変異を一時的に当てただけで、控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた）。ADR 0607・0608・0611 の表にある変異は当て直していない。

## 経緯【実測】

約束ごとに、足りない側とやりすぎた側の変異を当てた。結果の表は Issue #1827 のコメントにある。約束が後の採用済み ADR で動いていた点は次のとおり。

- ADR 0521（testkit の fixture と core の Fake も大文字の id を Postgres と同じ記憶として扱う）は #1324・#1327 の「fixture では大文字は not_found」を逆にした。この点は当てていない。
- ADR 0380（reextract の退けた記憶の確認は版を問わない）は #1319 の「今の extractorVersion」を広げた。広がった約束に当てた。
- 後半7本：ADR 0467（較正の標本の非有限の値・オーバーフローを借りに倒す）は #1351 の約束を広げた。ADR 0444（接続の包み。`begin` の失敗の解放・`rollback` の失敗の握り・捨てる接続のリスナー）は #1378 の約束を広げた。ADR 0499（`restoreSupersededBy` の NUL の検査は Invalid Date の早期 return のあと）は #1366 の約束を細かくした。広がった・細かくなった約束に当てた。撤回・逆になった約束は無い。

## 足した歯

| PR | すり抜けた変異 | 歯 |
|---|---|---|
| #1310 | 案内の条件に英語の `message` の一致を足す／条件を英語の `message` に絞る／案内の文書名を壊す／`cause` が `null` で投げる | `packages/postgres/src/__tests__/migration-failure-message-edges.test.ts` |
| #1318 | `droppedCandidates.message` の NUL・孤立サロゲートの置き換えを外す／500 字の切りを変える／空文字の `code` を通す／全件が落ちたとき最後の例外を投げる／`created` の追記の失敗を握りつぶす | `packages/core/src/__tests__/extract-dropped-candidate-record-fake.test.ts` |
| #1318 | Postgres・fixture の `createMemoriesWithOutboxAndEvents` が全件落ちたとき最後の例外を投げる | `packages/postgres/src/__tests__/memory-store-batch-first-error.postgres.test.ts` |
| #1319 | 最新でなく最初の `superseded` イベントの理由を見る／退けた記憶が2件あっても `skipped` を先頭だけにする | `packages/postgres/src/__tests__/reextract-withdrawn-latest-superseded-reason.postgres.test.ts` |
| #1324・#1327・#1329 | restoreArchived・purge・markContested が `getMany` へ小文字の id を渡す／`resolveContested` が `supersededById` を小文字にして渡す／restoreArchived・purge・reflect の混在した綴りの突き合わせを小文字だけにする／同じ綴りの重複を混在に数える／綴りの違う `winnerId` で store を余計に読む | `packages/core/src/__tests__/store-id-passthrough-other-mouths.test.ts` |
| #1335 | taxonomy の群で、隣り合う重複だけを畳む／大文字小文字を畳む | `packages/postgres/src/__tests__/claim-key-exclude-and-taxonomy-distinct.postgres.test.ts` |
| #1350 | 実効時刻で `occurredAt` を見ない／Invalid Date の `occurredAt` が `recordedAt` に倒れる／同じ候補の比較が 0 でない／件数を `memory.id` でなくオブジェクトで数える／`computeAffinity` が 0 を無いものとして扱う／拡張の行の一致で大文字小文字・行頭の空白・CRLF を落とす | `packages/core/src/__tests__/helper-tsdoc-promises-restored.test.ts`、`packages/postgres/src/__tests__/extension-mode.test.ts` |
| #1351 | 1種類の枝で傾きがちょうど0を採る／使えない標本が混ざると件数が狂う／構造項の `limitedBy`・帯の資格件数の桁上がりを差し引かない | `packages/core/src/__tests__/recall-footprint.test.ts` |
| #1354 | reflect の `tags: []` が材料の `tags` に倒れる | `packages/core/src/__tests__/reflect-blank-digest-and-tags.test.ts` |
| #1355 | `RecalledMemory.subjectId`・`OutboxJobRecord.tenantId`・`claimedBy` の `min(1)` を外す | `packages/core/src/__tests__/empty-string-output-schema-edges.test.ts` |
| #1366 | Invalid Date の `at` で、対象の確認が別の anchor の群を数える／確認の前に NUL を検査する | `packages/postgres/src/__tests__/restore-superseded-invalid-at.postgres.test.ts` |
| #1378 | Proxy が関数を束縛しない／callback 形の `connect` も包む／借りた直後に付けるリスナーが1 microtask 遅れる／`rollback` だけ失敗して捨てた接続のリスナーを外す／Error でない値の失敗に `cause` を足そうとする／`begin isolation level …` の失敗で解放しない | `packages/postgres/src/__tests__/drizzle-pool-proxy.test.ts`、`transaction-rollback-error.postgres.test.ts`、`transaction-begin-release.postgres.test.ts` |

歯は、元の変異を当てると赤になることを確かめてから入れた。

## 塞がなかったもの

- #1308: 前のクエリを SQL に送らない変異は、返す結果が同じ（等価）。ベクトルを DB が拒む入力は ADR 0424 以降なく、観測できるのは SQL の本数だけ。
- #1324: `reinforceMany` の去重を外す変異は等価（`UPDATE … FROM unnest` は同じ行を1回しか更新しない）。
- #1327: `resolveContestedPair` の `supersededById` の正規化を外す変異と、`resolveOrphanedContested` の `contestedWithId` の正規化を外す変異は等価（形の検査は `normalizeUuidCase` を通し、SQL の uuid 比較は大文字小文字を区別しない）。
- #1319: `superseded` イベントの一覧を `kind` で絞らない変異は等価（`superseded` の記憶の最後のイベントは `superseded`）。
- #1335: `findContestedByClaimKey` の `excludeMemoryId` が壊れた形で投げる変異は、#1431 で足された口で #1335 の約束の外。
- #1350: `truncateForFallbackDigest` の `trim` を `trimStart` にする変異は、元からの振る舞いで #1350 の約束の外。`assertSafeSchemaName` が `pg_` で始まる名前を入口で拒む変異は、TSDoc が「今の振る舞い」と書き、ADR 0611 が将来拒む余地を残すと決めたので縛らない。`computeAffinity` が `Infinity` の `similarity` を無いものとする変異は、TSDoc が `NaN` だけを書いているので外。
- #1351: 使える標本の条件 `memoryCount > 0` を `>= 0` にする変異は TSDoc に書かれていない選択で外。`indexBandStructuralTerms` の `bandChars` を差し引かない変異は、較正の標本では常に 0 なので等価。
- #1354・#1366: 追加の穴は上の表のとおり。#1366 で `restoreSupersededBy` が帯の有無によらず確認を走らせる変異は、ADR 0640 の下限の歯が捕まえる。

## これが覆るとしたら

案内の条件（`code` と `routine`）、落とした候補の記録の形、退けた記憶に数える `superseded` の理由、store へ渡す id を変えないこと、`compareScoredCandidates` の実効時刻、較正の「傾きが0以下なら借りる」、空文字の識別子を出力の schema が通さないこと、drizzle に渡す Proxy の包み方、が変わるとき。
