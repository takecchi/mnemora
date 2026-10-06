# ADR 0631: 09/30 にマージされた PR の後ろ半分（D・E・F・G 群）の確かめ直しで見つかった穴に歯を足す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1734](https://github.com/takecchi/mnemora/issues/1734) のうち、mgr-9efc452c が受け持った後ろ半分（D・E・F・G 群の21本）のコメント。H 群（文書）は別の担当に移ったので、ここには含まない。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】はマネージャーの判定。
これは試験だけの変更で、実装・migration・CHANGELOG・適合テスト（`*-conformance.ts`）・CI と vitest の設定は触らない（[ADR 0621](./0621-merged-0930-1465-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯

#1734 の確かめ直しで、PR ごとに約束（PR 本文・コード・ADR）を取り出し、足りない側とやりすぎ側の変異を当てた【実測】。どの歯にも捕まらなかった変異（すり抜け）のうち、約束の内のものを、この PR の歯で塞ぐ。各すり抜けの変異の正確な形は、#1734 の PR ごとのコメントにある。

数えないもの【判断】:
- 振る舞いが変わらない変異（到達不能・同値・`RelationKind` が1種・`Attributes` の値が文字列だけ、など）。
- 後の PR の歯が既に捕まえる変異のうち、この PR の歯を足しても価値が増えないもの（#1496 は例外。下の表）。

## 決定【判断】

1. 実装は変えない。
2. 歯を足す。歯ごとに、今の main で緑、#1734 のコメントに書いたその変異を1つずつ当てて赤、`cp` で戻して `cmp` で一致させた後に緑、を実測した【実測。Postgres は自分専用の PostgreSQL 17 + pgvector、`C.UTF-8`。Redis・API の鍵の要る試験は走らせていない】。

| 出所 | すり抜けの変異 | 足した歯 | 赤 |
| --- | --- | --- | --- |
| #1462 | index の `Number.isInteger` を外す／次元の検査を最後のベクトルだけにする／次元の message に入力本文を入れる | `packages/openai/src/__tests__/embedding-response-validation.test.ts` の it.each 3本（index が 0.5・1.5・NaN、次元違いが 0/1/2 番目、6経路で本文を含めない） | 4・2・1件 |
| #1483 | record の message から `{ key, value }` の案内を外す／`z.lazy` を一律に落とす | `packages/anthropic/src/__tests__/structured-output-zod-shapes.test.ts`（cause の文言、`z.lazy` の偽陽性なし） | 13・1件 |
| #1532 | 判定関数の name の検査を「相手の名前だけ断る」に弱める | openai・anthropic の `error-guard.test.ts`（name が他の値で kind を持つものは false） | 各3件 |
| #1454 | `NEVER_PUBLISHED_TARGETS` に `@mnemora/bullmq` を戻す | `scripts/__tests__/check-publish-pack.test.mjs`（一覧が空） | 1件 |
| #1476 | migration の実在検査を無効にする | `scripts/__tests__/migration-v1-changelog-migrations.test.mjs`（歯のファイル内の検査を `missingMigrationFiles` に出し、合成の名前と一時ディレクトリで赤・緑を見る部品の it） | 1件 |
| #1510 | Queue の error を最初の1回だけ渡す | `packages/bullmq/src/__tests__/tick-driver.queue-error.test.ts`（2回の emit が2回とも届く） | 1件 |
| #1550 | `export *` を辿った名前の一部を取りこぼす | `scripts/__tests__/check-consumer-install-lib.test.mjs`（実 snapshot が既知の名前を名指しで含む。一覧の全文は焼き込まない） | 1件 |
| #1502 | `{ query }` 形でスプレッドの順を逆にする | `packages/core/src/__tests__/consolidate-reflect-skip-scope-aggregate.test.ts`（`scopeAggregate: undefined` を明示しても skip） | 2件 |
| #1499 | 長さの検査を外す／frontier の id 昇順の整列を外す／安全弁で止まった後も往復する／`listRelatedMany` の createdAt を固定値にする | `packages/core/src/__tests__/list-related-many-round-trips.test.ts`（3経路の長さ、降順の getMany での菱形、星150・子孫60 の往復）、`packages/postgres/src/__tests__/list-related-many.postgres.test.ts`（createdAt が `listRelated` と等しい） | 6・2・2・1件 |
| #1490 | mark の `updated_at` を外す／イベントの `size_before_bytes` を落とす／`at` を無視する | `packages/postgres/src/__tests__/contested-group-conflict-id.postgres.test.ts` | 1・2・2件 |
| #1497 | outbox の索引の部分述語を外す（recalls に足す）／`FOR UPDATE SKIP LOCKED` を `FOR UPDATE` にする | `outbox-purge-index.test.ts`・`recalls-purge-index.test.ts`（`pg_indexes.indexdef`、対象選択の SQL） | 各1件 |
| #1453 | fixture から `long` 空間の埋め込みの行を消す | `upgrade-from-released.postgres.test.ts` の beforeAll（migration の前に各空間の表に行がある） | 赤（スイートが落ちる） |
| #1489 | `confirmStatsPresence` の ANALYZE を外す／歯2 から確認の呼び出しを外す | `recall-roundtrip-count.postgres.test.ts`（`reltuples >= 0`、確認済みでない vectorStore で測ると投げる） | 4・4・1件 |
| #1472 | カウンタのリセットを外す／shuffle の修正を取り消す | `process-counters-start-at-zero-{a,b}.postgres.test.ts`（共有の `process-counters-start-at-zero-teeth.ts`）、`embedding-space-table-enumeration-consistency.postgres.test.ts`（空間の表が無い状態から始める形） | 2・1件 |
| #1496 | Postgres の候補ごとの SAVEPOINT をやめる | `observe-created-event-same-tx.postgres.test.ts`（claim key の索引上限 54000 で DB が拒む候補を真ん中に置き、`createMemoriesWithOutboxAndEvents` を直に呼ぶ。前後の候補と、書けた記憶ぶんの `created` が残る） | 1件（SQLSTATE 25P02） |

3. 足さなかったすり抜け【判断】:
   - #1483 の tuple・date・transform の cause の固定: `unrepresentable: "throw"` にしても、date・transform は zod と SDK が同じ message を投げ、tuple は zod が投げない。message で見分けられず、スタックを見る歯は壊れやすい。実質同値として数えない。
   - #1499 の「止まった後の起点を打ち切る `break` を外す」2本: 辺は `relationEdges` にしか入らず、出力（`collectGroupComponent` の単位組み）を変える入力を作れなかった。
   - #1472 の「setupFiles で共有クライアントが閉じていることを見る」: vitest の設定を変えないと書けない。
   - #1501 の値の比較を `==` にする変異: `Attributes` の値は文字列だけ（`Record<string, string>`）なので同値。
   - 方針の判断が要る3件は、この PR に入れずにクローンに聞いている: #1476 の「出荷後も全 migration 名が migration-v1.md に現れる」歯、#1490 の「文の数の上限」の歯（歯の doc が数を固定しないと明記）、#1472 の「並列 project の `isolate: false` を固定する」歯（ADR 0397 を変えるとき一緒に直すことになる）。
   - ⚠ **2026-10-06 追記（上の3件の決着。クローン（miku）の判断で、オーナーの判断ではない）**:
     - #1476: migration-v1.md が「全 migration を挙げる」と自分で書いているときだけ縛る、と決まった。【現物】migration-v1.md はそう書いていない（`0001`〜`0011` を名指しせず、版ごとに「追加で適用する N 本」を並べる形）。⟹ **足さない**。
     - #1490: 歯の doc の「文の数を固定しない」に従い、**足さない**。
     - #1472: **足す**——`packages/postgres/src/__tests__/vitest-config-isolate.test.ts`。`vitest.config.mts` を import し、並列 project の `isolate` が `false`、直列 project の `isolate` が `false` でない（既定の `true`）ことを見る。落ちたときの文言は「ADR 0397 を変えるなら、この歯も直すこと」。【実測】変異（並列を `isolate: true` にする／直列に `isolate: false` を足す）それぞれで、狙った it だけが1件赤。`cp` で戻して `cmp` 一致の後に2件緑。

## 引き受けた負債

- #1472 のカウンタのリセットの歯は、2つのファイルが同じ worker に載るときだけ変異を捕まえる（変異試験は `--maxWorkers=1` で見た）。worker が分かれると緑のまま。
- #1496 の変異は、後の PR の歯（`claim-key-index-limit-error`・`savepoint-rollback-error`）も捕まえる。ここで足すのは、#1496 自身の歯の前提（NUL は SQL を投げる前に落ちる）を、DB が拒む値で補うため。
