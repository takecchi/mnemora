# ADR 0671: 09/30 マージの前半の残り（#1523・#1525・#1527・#1529・#1534・#1537・#1538・#1542・#1543）の確かめ直しで見つかった穴に歯を足す（Issue #1734）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1734](https://github.com/takecchi/mnemora/issues/1734)。担当は mgr-98090b71、測ったのは作業者。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・TSDoc・migration・CHANGELOG・公開の適合テスト（`*-conformance.ts`）は触らない（[ADR 0667](./0667-merged-0930-front-a-recheck-teeth.md)・[ADR 0668](./0668-merged-0930-front-b-recheck-teeth.md) と同じ）。

## 経緯

2026-09-30（UTC）にマージされた89本の確かめ直し（#1734）のうち、A 群の先頭の9本（#1523・#1525・#1527・#1529・#1534・#1537・#1538・#1542・#1543）に、足りない側とやりすぎた側の変異を当てた。測定は main `735c0805`【実測】。変異の数とすり抜けは次のとおりで、表は #1734 の各コメントにある。

| PR    | ADR        | 変異 | すり抜け（約束の内） | 同値 |
| ----- | ---------- | ---- | -------------------- | ---- |
| #1523 | 0420       | 39   | 4                    | 0    |
| #1525 | （hunt-n） | 21   | 4                    | 0    |
| #1527 | 0424       | 27   | 8                    | 1    |
| #1529 | 0426       | 12   | 3                    | 1    |

約束の内で同値でないもの38本に歯を足した。足した歯ごとに、元の変異を `cp` で当てて赤になること、戻して `cmp` が一致し緑になることを確かめた。後の ADR で約束が広がったもの（#1523 の ADR 0544・0568、#1527 の ADR 0467・0470）は、広がった約束に当てた。狭まった・意味が変わった約束は無かった。

## 決定【判断】

1. **実装は変えない。**公開の適合テストにも足さない。歯は各パッケージの固有のテストに置く。
2. 次の歯を足す。

| PR    | すり抜けた変異                                               | 足した歯（置き場所）                                                                                                                                                                                           | 変異での赤                  |
| ----- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| #1523 | `reextract` が `abortIfAllConflicted: true` を渡す           | 書き込み直前に置き換え元が `archived` になり、`reextract` が例外にならず `skipped` で返る（`packages/postgres` の新規 `abort-if-superseded-gaps.postgres.test.ts`。Postgres と fixture）                       | 赤（2）                     |
| #1523 | superseded の見直しを forgotten より先に置く                 | forgotten と superseded が両方に当たると `SourceMemoryForgottenError`（同上）                                                                                                                                  | 赤（1）                     |
| #1523 | 見直しの `ORDER BY id ASC` を外す                            | `changed` が id 昇順（同上）                                                                                                                                                                                   | 赤（1）                     |
| #1523 | cost-summary の必須 outcome 一覧に余計な値を足す             | 7値ちょうどの内訳が `ok:true`（`scripts/__tests__/consolidation-cost-summary-lib.test.mjs`）                                                                                                                   | 赤（1）                     |
| #1525 | float4 で正確に表せない値（`rounded !== value`）も断る       | 0.1・1e38・1e-30・0.3 が通る（`packages/postgres` の新規 `half-life-float4-accepts-fitting-values.postgres.test.ts`）                                                                                          | 赤（5）                     |
| #1525 | `halfLifeRecalls: null` を検査へ回す                         | `null` が通る（同上）                                                                                                                                                                                          | 赤（1）                     |
| #1525 | openai の空 `embed` を signal 付きなら常に断る               | abort していない signal の空配列は `[]`（`packages/openai` の `abort-signal.test.ts`）                                                                                                                         | 赤（1）                     |
| #1525 | local-embedding の同じ変異                                   | 同上（`packages/local-embedding` の `abort-signal.test.ts`）                                                                                                                                                   | 赤（1）                     |
| #1527 | 正規化を NFKC にする・小文字にそろえる・文中の空白をまとめる | 大文字小文字・全角半角・文中の空白だけが違う文は contested（`packages/core` の新規 `claim-key-normalized-equal-both-sides.test.ts`）                                                                           | 赤（各1。3本）              |
| #1527 | 行側を正規化しない                                           | 先に保存した側が NFD・末尾空白でも contested にならない（同上）                                                                                                                                                | 赤（1）                     |
| #1527 | contested の相手は content が等しくても除かない              | A・B が contested の後に A と等しい C が来て `matchCount` が1（同上）                                                                                                                                          | 赤（1）                     |
| #1527 | trigram の検索語の NUL の検査を外す                          | 文面を全体で比べ、store 自身の明示の例外であること（`packages/postgres` の新規 `lexical-query-nul-only.postgres.test.ts`）。適合テストの `/query.*NUL/` は DB の生の例外（`Failed query: … NULL …`）にも当たる | 赤（1）                     |
| #1527 | NUL の検査を `\u0000-\u0008` に広げる（Postgres・testkit）   | `\u0001` を含む検索語は断られない（同上）                                                                                                                                                                      | 赤（Postgres 2、testkit 1） |
| #1529 | 全部消えたあと、テナントの空の入れ物を残す                   | `subjectActivitySeq.has(tenantId)` が偽（`packages/testkit` の新規 `in-memory-erase-tenant-gaps.test.ts`）                                                                                                     | 赤（1）                     |
| #1529 | `dryRun` でも冪等キーを消す                                  | `dryRun` の後も同じ入力が `created: false`（同上）                                                                                                                                                             | 赤（1）                     |
| #1529 | `onMemoriesDeleted` が最後の1つで置き換える                  | `InMemoryVectorStore` を2つ載せても両方の埋め込みが消える（同上）                                                                                                                                              | 赤（1）                     |

| #1534 | `Ctx`・`OutboxJob`・`Memory`（出力にも使う型）・`build*Fixture` の `overrides` を `undefined` も受けるよう広げる（広げなかった型を広げすぎる） | 広げなかった型に `undefined` を渡す行へ `@ts-expect-error` を付けた probe を、`exactOptionalPropertyTypes: true` で型検査し、診断0件を見る（`scripts` の新規 `exact-optional-narrow-types.test.mjs`・`exact-optional-narrow-types.probe.ts`）。陽性対照：exact を切ると TS2578 | 赤（各1。4本） |

| #1537 | 群の `note` の `matches` を昇順にしない・`memberIdsTruncated`／`matchesTruncated` を `>=` にする（境界）・`observe()` の `memberIds`／`matchMemoryIds` を先頭10件にする | ちょうど10件・11件の境界、store が一致を降順で返しても昇順の先頭10件、戻り値は全員（`packages/core` の新規 `contested-group-note-boundaries.test.ts`） | 赤（各1。6本） |
| #1537 | testkit・Fake の `markContestedGroup` が、対の片割れ（contested で `contestedWithId` あり）にも `updated` を積まない | 群の一員・対の片割れ・active の混在で、積まれる id が対の片割れと active だけ（`packages/testkit` の新規 `in-memory-contested-group-unchanged-members.test.ts`。InMemory と Fake） | 赤（各1。2本） |
| #1537 | `unitTokens` をつなげて1回数える・`unitChars` をコードポイントで数える | 単位の文字数・トークン数の定義を直接見る（`packages/core` の新規 `recall-budget-cut-unit-values.test.ts`。参照実装が同じ関数を呼ぶので、一緒に動いて見えなかった） | 赤（各2。2本） |

| #1538 | recall の後置の status の門が contested を落とす | contested の記憶が段1・連想枠で返る（`packages/core` の新規 `recall-status-gate-keeps-contested.test.ts`） | 赤（2） |
| #1538 | `archiveDecayed` の `reachedLimit` を「1件でも掃いたら true」「`limit - 1` 件以上で true」にする（Postgres・testkit） | 対象2件で `limit` 5・3 は false、2 は true（`packages/postgres` の新規 `archive-decayed-reached-limit-under-limit.postgres.test.ts`。InMemory と Postgres） | 赤（各2・1。4本） |

| #1542 | （すり抜けなし） | 足していない。128ケースの表と、InMemory・Postgres に同じ表を当てる歯が、30の変異（NUL・int4・Invalid Date・`nowSeq`・`purgedAt`・一括 jsonb 経路）をすべて捕まえた | — |

| #1543 | （すり抜けなし） | 足していない。PR の歯と適合テストが、17の変異のうち約束の内の14をすべて捕まえた | — |

3. **歯を足さないもの（約束の外・同値）**

| PR           | 変異                                                                                    | 理由                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| #1527        | `sliceAtGraphemeBoundary` の `text.length <= limit` を `<` にする                       | 同値。長さ＝上限のとき、走査も全文を返す                                                                                             |
| #1529        | 埋め込みを消す条件から `tenantId` の一致を外す                                          | 同値（推測）。`InMemoryVectorStore.upsert` は `ctx` のテナントの memory にしか書けず、埋め込みの `memoryId` は常にそのテナントを指す |
| #1534        | 実行時の `undefined` と省略が同じ扱いであること                                         | 約束の外とした（約束は型。PR 本文の実測は使い捨てで、歯は無いまま）                                                                  |
| #1523〜#1529 | 文書だけの項目（#1525 の N-6・N-7・O-4・M-1・M-2・M-4）・型だけの変更（`declare` など） | 約束の外（試験・型検査・文書の読み比べが受け持つ）。読み比べはしていない                                                             |

## 引き受けた負債

- #1523 の `PR の歯の細さ`：`consolidate`・`reflect` の読み直しや store の欄を縛る変異は、Postgres と fixture の歯だけが捕まえる。core の4ファイルはどれも捕まえない（core の Fake は `abortIfSuperseded` を実装しない）。縛りは薄い側にあるまま。
- #1523 の `ORDER BY id ASC` は、行ロックの順（複数の書き手の待ち合わせの向き）としては歯で縛れない。縛ったのは `changed` の昇順だけ。
- #1527 の C1・C2 は core・Postgres とも1件ずつの赤。NFC・trim をそれぞれ1場面だけが縛る。
- #1525 の文書だけの項目は、実装との読み比べをしていない。

## これが覆るとしたら

- #1529 E10 が同値でないと分かれば（`upsert` が他テナントの memory にも書けるようになれば）、歯を足す。
- 約束の外とした文書だけの項目に、振る舞いの約束が入っていると分かれば、その項目に歯を足す。

## 測ったこと【実測】

足した歯ごとに、元の変異を当てて赤、戻して `cmp` で一致、緑を確かめた（数は上の表）。

- 開発の途中で、Postgres（ポート56391）が止まっていた間に取った一部の測定は無効とし、再起動して測り直した。
- 走らせたのは名指しのファイルだけ（`--maxWorkers=2`）。全スイートは走らせていない。
