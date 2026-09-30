# ADR 0410: 抽出の `created` イベントは、記憶と同じトランザクションで書く（任意メソッド `createMemoriesWithOutboxAndEvents?`）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

> **⚠ これはクローンの委譲で動く担い手が書いた。オーナーの判断ではない**（ADR 0220）。
> 方針（抽出の経路だけを直す・`MemoryStore` に任意メソッドを足す・実装は Postgres と testkit の fixture・
> 範囲外の経路は触らない）は、委譲元のマネージャーが決めた。この ADR はその内側の設計（イベントと落とした
> 候補の受け渡し）と、確かめたことを書く。

---

## 文脈

[ADR 0347](./0347-extract-write-path-redelivery-and-unsaveable-candidates.md) は、抽出の書き込みを
次の形にした。

1. `processExtractJob` は、LLM を呼ぶ前に `listBySourceObservation` を見て、記憶が1件でも在れば何もせずに返す（決定1）。
2. `createMemoriesFromCandidates` は、候補ごとに `createMemoryWithOutbox` を呼び、保存できない候補だけを落として残りを書く。
   全件が落ちたら最初の例外を投げる（決定2）。
3. 落とした候補は、残った候補の `created` の `meta.droppedCandidates` に残す（決定3）。そのために、全候補を書いてから `created` を積む（決定4）。

**穴（D-3）**: 記憶のコミットと `created` の `EventStore.append` は別の文（別コミット）である。`append` が一時的に
失敗すると、`observe`（sync）も `tick`（deferred の extract ジョブ）も例外になるが、**記憶は残る**。あとの再送や
tick は、決定1の `listBySourceObservation` で「在る」と見て素通りするので、**`created` は0件のまま残る**。
監査ログ（`memory_events`）に、記憶の誕生が載らない。ADR 0347 は「`created` の追記が遅れる窓が広がった」を
負債として挙げていたが、この窓は閉じていなかった。

ADR 0100 の「守れないもの」は、`created` イベントが記憶の作成と同じトランザクションに無いことを明示していた
（docs/memory-model.md §11 行5 が名指ししたのは「旧行の更新」と「新 Memory の作成」の対であり、`created` は含まれない）。
本 ADR は、そのうち**抽出の経路**だけを直す。

経路は sync の `observe` と、deferred の `processExtractJob` で、どちらも `runExtraction` →
`createMemoriesFromCandidates` を通る。

## 決めたこと

1. **`MemoryStore` に任意メソッド `createMemoriesWithOutboxAndEvents?` を足す。**

   ```ts
   createMemoriesWithOutboxAndEvents?(
     ctx: Ctx,
     news: ReadonlyArray<{ input: NewMemory; jobKinds: OutboxJobKind[] }>,
     buildCreatedEvent: (
       memory: Memory,
       dropped: ReadonlyArray<{ index: number; error: unknown }>,
     ) => NewMemoryEvent,
     opts?: { now?: Date },
   ): Promise<{
     written: Array<{ index: number; memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
     dropped: Array<{ index: number; error: unknown }>;
   }>;
   ```

   全候補の記憶・outbox・`created` を **1つのトランザクション**で書く。名前は既存の `createMemoryWithOutbox` と
   `supersedeWithNewMemories` の語に合わせた。

2. **候補ごとに SAVEPOINT を張り、保存できない候補だけを巻き戻す。**（ADR 0347 決定2 を1トランザクションの中で守る。）
   Postgres は文が失敗するとトランザクション全体が aborted になり、外側で握りつぶしても以後の文が全部落ちる。
   SAVEPOINT が無いと「1件の NUL で残りの候補も全部落ちる」。SAVEPOINT の巻き戻しで落ちた候補の例外は、
   `dropped`（`index` と、store が投げた例外そのもの）に積む。
   **全候補が落ちたら、最初の例外をそのまま投げ、何も書かない**（外側のトランザクションごと巻き戻る）。

3. **`created` は、書けた候補（`created: true` のものだけ）について、全候補の成否が確定してから、同じトランザクションで積む。**
   （ADR 0347 決定3・4 を守る。）冪等な再送（`created: false`）では積まない。`created` の INSERT が失敗したら、
   トランザクション全体を巻き戻す——**記憶も outbox も残らない**。この例外は `dropped` に混ぜず、そのまま投げる。
   すると sync では `observe` が例外になり、再送で候補が全部書き直される（記憶が残らないので、決定1の「在る」に当たらない）。
   deferred では extract ジョブが失敗し、ジョブの失敗の扱いに従う（記憶は残らない。下の「確かめたこと」）。

4. **イベントと落とした候補の受け渡し: core が `buildCreatedEvent` を渡し、store が同じトランザクションで呼んで INSERT する。**
   - `meta`（`reason`・`sourceObservationId`・`extractorVersion`・`failureKind`・`droppedCandidates`・`languageMismatch`）は
     core が組み立てる。`appendCreatedEvent` の組み立てを `buildCreatedEventFor`（書かない純関数）に切り出し、
     別コミットの旧経路（`appendCreatedEvent`）と、この口に渡す `buildCreatedEvent` が共有する——2つの経路の `meta` の形がずれない。
   - `droppedCandidates` は store の中で確定するので、`buildCreatedEvent(memory, dropped)` の第2引数で store が渡す。
     `dropped` は `{ index, error }`（`index` は `news` の索引）。**store は例外を返すだけで、記述への変換
     （`describeDroppedCandidate`。原因の最内の code/message・NUL と孤立サロゲートの置換・500 文字）は core 側のまま**
     （core が `news[index]` の `contentHash` と組み合わせて `DroppedCandidate` にする。`contentHash` を store へ渡さずに済む）。
   - `buildCreatedEvent` は同期・副作用なしで、書き込みの途中（トランザクションの中）で呼ばれる。
   - `supersedeWithNewMemories` は組み立て済みのイベント（`event: NewMemoryEvent`）を渡し、store が
     `meta.supersededById` だけを足す形だった。この口は、`meta` に足すものが「落とした候補」という**呼び出しの中で確定する値**
     なので、イベントの雛形ではなく組み立てる関数を渡す形にした（雛形に store が `droppedCandidates` を足す案は、下）。

5. **claim key の衝突検出（`detectContested`）は今どおり、書いたあとに走らせる。**この口の外（core）。`created: true` の候補だけ、
   `written` の順に。

6. **口の有無だけで経路を選ぶ。撃って投げられたときに、旧経路で撃ち直さない**（ADR 0100 の `supersedeWithNewMemories` と同じ規律。
   二重に書きうる）。口を持たない adapter は、今までの経路（候補ごとの `createMemoryWithOutbox` ＋ 別の `EventStore.append`）のまま。

7. **実装は `@mnemora/postgres` の `PostgresMemoryStore` と、`@mnemora/testkit` の `InMemoryMemoryStore`。**
   - Postgres: `createMemoryWithOutbox` の1件ぶんの書き込みを private の `insertMemoryWithOutboxRows` に切り出して共有し
     （SQL は書き写さない）、候補ごとに drizzle の入れ子の `tx.transaction`（= SAVEPOINT）で包む。`created` は
     `EventStore.append` を経由せず、同じトランザクションで `memory_events` へ直接 INSERT する（`supersedeWithNewMemories` と同じ形）。
   - インメモリ: 書き込みは `await` を挟まない同期区間で、その前の状態（Memory・冪等キー・outbox・ラベル）を `captureWriteState` で
     写し取り、失敗したら戻す（`supersedeWithNewMemories` の巻き戻しをこの関数に切り出して共有した）。`created` は共有の `events`
     配列に積み、積めなければ（イベントが書けない値・`push` が投げる）全体を戻して `events` の長さも切り戻す。

8. **適合テストに `supportsCreateMemoriesWithOutboxAndEvents?`（任意の3状態フラグ）と2本の歯を足す。**（Postgres とインメモリで `true`。）
   (a) 候補の途中で1件が保存できなくても、ほかの候補と `created`（落とした候補の情報付き）が揃う（再送で `created` を積まない・
   全候補が落ちたら投げて何も書かない、まで含む）。(b) `created` の書き込みが失敗したら、記憶も outbox も残らない。
   失敗させる手段は、adapter の内部に触らず、`at` が Invalid Date のイベントを `buildCreatedEvent` で返す
   （Postgres は `memory_events` への INSERT が、fixture はイベントの検査が拒む——どちらも `EventStore.append` と同じ拒み方）。

## 採らなかった案

- **`createMemoryWithOutbox` を候補ごとに呼び、`created` を `updateStatusWithEvent` のような別口で積む案。** 記憶とイベントが別コミットのまま。穴が閉じない。
- **1つの `tx` を core が持つ（トランザクションのハンドルを公開する）案。** ADR 0012 D-ingest-1 が採らなかった形。`MemoryStore` の口の外に
  トランザクション境界が出る。
- **イベントの雛形を渡し、store が `droppedCandidates` を `meta` に足す案。** `describeDroppedCandidate`（原因の最内の取り方・置換・500 文字）を
  store に持たせるか、store が生の例外を core の関数に渡す必要があり、`meta` の組み立てが core と store に割れる。関数を渡せば、
  組み立てはすべて core に残る。
- **`created` の追記が失敗したときだけ、旧経路で撃ち直す案（フォールバック）。** 記憶が既にコミットされたか判断できず、二重に書きうる。
  ADR 0100 の規律（口の不在に対してだけ旧経路に落ちる）に反する。
- **`MemoryStore` の必須メソッドにする案。** 第三者 adapter を壊す破壊的変更。
- **`createMemoryWithOutbox` の戻り値を変える、または `createMemoryWithOutbox` に `event` 引数を足す案。** 既存の口の意味論を変える。
  抽出は候補が複数で、落とした候補が確定してから `created` を積む必要があり、1件ずつの口では表せない。
- **範囲外の経路（下の「残り」）も同時にこの口へ寄せる案。** 決定済みの方針（抽出だけ）に反する。経路ごとに `abortIfForgotten`・
  `supersede`・冪等の意味論が違い、まとめて直すと差分が読めなくなる。

## 引き受けた負債（守れないもの）

- 🔴 **この口を持たない adapter では、取りこぼしが残る。**`createMemoryWithOutbox` の経路のままなので、`created` の append が失敗すると
  記憶だけ残り、再送・tick は素通りして `created` が0件のままになる。任意メソッドである以上、第三者 adapter の上では恒久的に守れない
  （ADR 0100「守れないもの」の「任意メソッドである以上……」と同じ形）。⛔「ADR 0410 が入ったから抽出の `created` は取りこぼさない」と読まないこと——
  守られるのは、この口を実装した adapter（`@mnemora/postgres`・`@mnemora/testkit` のインメモリ）の上だけ。core のテスト用 `FakeMemoryStore` は実装しない。
- 🔴 **口の有無は原子性の証拠ではない。**`supersedeWithNewMemories` と同じ。実装しているが実際には1トランザクションで書いていない adapter を、この機構は見抜けない。
- 🔴 **残り: 範囲外の経路の `created` は、今までどおり別コミットのまま取りこぼしうる**（`runtime.ts` で `created` を積む箇所を `grep` で数えた。`appendCreatedEvent` の呼び出しは3箇所で、うち1つが抽出（この ADR の対象。口を持たない adapter の旧経路として残る）、
  残る2つが `reextract`。`kind: "created"` を `deps.eventStore.append` へ直書きしているのが3箇所。範囲外は合わせて5箇所）:
  1. `reextract` の、`supersedeWithNewMemories` を使う経路（口あり）の `created` — `appendCreatedEvent(ctx, memory, observation, "ok", null)`（`reextract` の中）。
  2. `reextract` の、口が無い adapter 向けの `createMemoryWithOutbox` のループ（口なし）の `created` — 同じく `appendCreatedEvent`。
  3. `consolidate` の、`supersedeWithNewMemories` を使う経路（口あり）の統合先の `created` — `deps.eventStore.append`（`buildCreatedEvent()`、`meta.reason: "consolidated"`）。
  4. `consolidate` の、口が無い adapter 向けの `createMemoryWithOutbox`（口なし）の統合先の `created` — 同じく `deps.eventStore.append`。
  5. `reflect` の内省の `created` — `deps.eventStore.append`（`meta.reason: "reflected"`）。
  委譲の指示は「6経路」と数えていたが、`grep` で見つけたのはこの5箇所である（数え方の違いか、見落としかは確かめていない）。
  `reextract` の `supersede` の `superseded` イベントは `supersedeWithNewMemories` の中で同じトランザクションに積まれる（ADR 0100）ので、ここには数えない。
  これらは、記憶を書いたあと・イベントを積む前に落ちると、抽出と同じ形の取りこぼしを残す。
- **deferred の extract ジョブは、落ちると終端 `failed` になり、自動では再試行されない**（Phase 1 の今のジョブの扱い）。この口で記憶は残らなくなるが、
  そのジョブが自動で書き直されるわけではない。再送（`observe` を同じ `externalId` でもう一度）や、ジョブの手動での再投入は、この ADR の範囲外。
- **`created` の INSERT の失敗と、保存できない候補の区別は、SAVEPOINT の内側か外側かだけである。**保存できない候補のふりをした一時的な障害
  （SAVEPOINT の中で起きた一時的な失敗）は、今までと同じく候補を落として残りを書く（ADR 0347 の負債のまま。core は両者を見分けられない）。
- **公開の型に1点、小さな変化がある。**`ContestedWithoutCompanionError.method` の union に `"createMemoriesWithOutboxAndEvents"` を足した。
  この欄で網羅的に分岐（`never` 検査）している呼び出し側は、型検査で新しい値を指摘される。ほかは任意メソッドと任意フラグの追加のみ。
- インメモリ実装の候補ごとの巻き戻し（`captureWriteState` の呼び出し）は、今の入力では観測できない。`createMemoryIdempotent` が書く前に検査するため、
  投げる候補は何も書いていない。変異試験でこの巻き戻しを外しても、歯は赤くならなかった（同値の変異）。将来、書いた後に投げる検査が増えたときの保険として残した。
- インメモリの `created` は `InMemoryMemoryStore.events` に積まれる。`InMemoryEventStore` を第2引数無しで組み立てる既存の形（クラス doc が注意している）では、
  抽出の `created` が `EventStore.list` に出ない。既存の組み立ての注意がこの経路にも及んだだけで、組み立て方は変えていない。

## これが覆るとしたら

- **オーナーが「`created` イベントも §11 行5 の対に含める」と決めたとき。**そのとき任意メソッドでは足りず、範囲外の5箇所と、口を持たない adapter の扱い
  （必須化＝破壊的変更）の判断が要る。
- **ジョブの失敗の扱いが変わる（extract ジョブの自動再試行が入る）とき。**deferred の「失敗中は何も残らず、あとで揃う」が、再試行の設計と噛み合うか見直す。
- **`MemoryStore` に、トランザクションを扱う共通の口（ADR 0012 が採らなかったハンドル）が入るとき。**この口と `supersedeWithNewMemories` を含めて畳めるか見直す。
- **範囲外の経路の取りこぼしが実運用で見つかったとき。**その経路を同じ形で直す判断（別の ADR）。

## 確かめたこと

- **歯（`packages/postgres/src/__tests__/observe-created-event-same-tx.postgres.test.ts`、InMemory / Postgres × sync / deferred × 2本 = 8本）**は、歯だけを先に commit した
  `ac62aeb` の実装で **8本すべて赤**、この実装で **8本すべて緑**（歯は変えていない）。歯を書いた担当が確認していないと書いた点——sync で失敗後に再送したときに件数が揃うのは、
  sync の extract ジョブが完了にならずに残り、`tick` が拾い直すことに依存する——は、この実装で **InMemory・Postgres の両方で緑**になった（sync の3件・2件の期待が通る）。
  InMemory 側で共有 `events` 配列の `push` を投げさせる失敗の注入と、インメモリの巻き戻し（全体の `restoreAll`）は噛み合う（下の変異試験 M4 が赤くする）。
- **[ADR 0407](./0407-sync-observe-extract-job-lease.md)（#1492、sync の extract ジョブを claim 済みで積む）との衝突を、rebase で確かめた。**歯の「sync で失敗した後、tick が拾い直して件数が揃う」は、
  ジョブが claim 済み（`attempts = 1`）のまま残り、**リース切れまで tick に拾われなくなった**ため、rebase 直後に sync の4本が赤くなった（実装の退行ではなく、歯の前提が変わった）。
  歯の主張は弱めず、テスト側の runtime に注入した時計を、再試行の tick の前にリースより長く進める形にした（実時間は待たない）。
  この歯の調整後も、口を使わない旧経路（`createBatch` を `undefined` にした変異）では8本すべて赤で、実装では8本すべて緑。
- **変異試験**（実測。1つ入れて狙った歯が赤くなることを見て、戻して緑に戻ることを確かめた。戻しは `cp`）:

  | 変異 | 赤くなった歯 |
  | --- | --- |
  | M1: Postgres で `created` の INSERT をやめる | 適合2本＋歯 Postgres の4本（6本） |
  | M2: Postgres で候補ごとの SAVEPOINT をやめる | 適合 (a)＋歯 Postgres NUL の1本（2本） |
  | M3: Postgres で `created` の INSERT の失敗を握りつぶす | 適合 (b)＋歯 Postgres の4本（5本） |
  | M4: インメモリで全体の巻き戻し（`restoreAll`）をやめる | 適合 (b)（インメモリ）＋歯 InMemory の4本（5本） |
  | M5: インメモリで候補ごとの巻き戻し（`restoreOne`）をやめる | **赤くならない（同値の変異。上の負債）** |
  | M6: インメモリで `created` を積まない | 適合 (a)（インメモリ）＋歯 InMemory の4本（5本） |

- **既存の2本の歯が、口を持つ store では成り立たなくなった。**実装後の `test:db` 全体で、次の2ファイル（各 Postgres・InMemory の計4本）が30秒でタイムアウトして赤くなった。どちらも
  「候補を1件ずつ書く途中」の形を作る歯で、`createMemoryWithOutbox` を保留にして待つため、口を持つ store では保留の対象が呼ばれず、門に到達しない（**実装の退行ではなく、歯が縛っていた旧経路の窓がこの store から無くなった**ことによる）:
  - `tick-sequential-redelivery.postgres.test.ts` の「1回目が候補の一部だけを書いて止まると、再配達は残りを書かず、reextract で回復する」
  - `observe-created-event-after-purge.postgres.test.ts`（書いた1件が `created` の前に forget・purge される窓）
  歯を弱めず、**口を持たない adapter のふり**（`createMemoriesWithOutboxAndEvents` を `undefined` にする）をして走らせる形に直し、旧経路の振る舞いを縛り続けた。
  さらに `tick-sequential-redelivery` に、口を持つ store の新しい歯を足した（全候補のコミットの前にワーカーが止まると何も書かれず、再配達が全候補と `created` を書く）。
  `ObserveResult.memoryIds` の doc（Issue #1234 の追記）にも、この窓が口を持たない adapter の経路の話であることを追記した。
- 適合テスト: Postgres とインメモリの両方で、追加した2本が緑（実行した数字は PR 本文）。`supportsCreateMemoriesWithOutboxAndEvents` を省略した adapter には
  「⚠ 未検査」の named it が1本登録される（`conformance-omitted-flags-named-it.test.ts` に11個目として足した）。
- 公開 API の snapshot（core・postgres・testkit）と、`docs/architecture.md` §5 の写しを更新し、`scripts/__tests__/architecture-section5-*` を通した（実行結果は PR 本文）。

## 確かめていないこと

- 範囲外の5箇所が、実際に取りこぼす入力を歯で確かめていない（同じ形であることをコードで読んだだけ）。
- 本物の並行（同じ Observation を2つの `tick`／`observe` が同時に処理する）での、この口と決定1の相互作用。ADR 0347 の並行の2本は、この口でも変えていないが、この口に対しては測っていない。
- 第三者 adapter が、口を実装したうえで SAVEPOINT 相当の巻き戻しを正しく行うか。適合テスト (a) が固定しているのは、保存できない候補が真ん中にあっても残りが揃うことだけ。
