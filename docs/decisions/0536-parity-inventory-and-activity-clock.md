# ADR 0536: 穴探し — 公開メソッドごとの「3者（Fake・InMemory・Postgres）を突き合わせる歯」の棚卸しと、その1つ目（活動時計 `decay_clock = "activity"` の経路。3者一致、割れは見つからなかった）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-2c9f30d0 の指示による）が書いた。第1段で読むだけの棚卸しを作り、第2段で「割れていそうな上位3つ」の1つ目に歯を足した。直す線（約束に実装を戻す）の中だけを直す方針だったが、**直す割れは見つからなかった**。実装・公開 API・既定値・CHANGELOG・`docs/migration-v1.md` は変えていない。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（Node.js v22、PostgreSQL 17 + pgvector を自分専用のポートで）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: ADR 0493〜0531 で、Fake（core の `runtime-fakes.ts`）・InMemory（testkit の fixture）・Postgres の食い違いを、見つかった口ごとに歯にしてきた。口を思いついた順に当てているので、**どの公開メソッドに3者の歯があり、どれに無いか**を一度並べて、次に当てる口を選ぶ。

## 1. 棚卸し（第1段。読むだけ）

### 凡例と確かめ方

- **3者**: Fake・InMemory・Postgres に同じ入力を流して突き合わせている。(直) は歯がそのメソッドを直接呼ぶ。(R) は Runtime の操作の中で呼ばれ、操作後の状態を比べる。
- **IM+PG**: InMemory と Postgres だけ。conformance は Fake を走らせない（確かめたのは `conformance.postgres.test.ts` と `in-memory-fixtures.conformance.test.ts` の2本）。この場合 Fake は `core/src/__tests__/fake-*.test.ts` の単独の歯（Fake を実測値に合わせたもの）だけ。
- **無し**: 3者の突き合わせが無い。
- **grep の形**: 公開メソッドは `export interface <Store|Runtime>` の本体から、2スペース字下げの `name(` と `name?(` を機械的に抜いた（95 個）。歯の候補は `grep -rlE "[.\s]M\(" ...` と `\bM\b` を、カテゴリ別のファイル集合（conformance〔`packages/testkit/src/*-conformance.ts`〕、3者の歯、2者の歯〔`*-parity*`・`*-alignment*`・`store-boundary-diff`〕、`fake-*.test.ts`）ごとに当てた。(R) の判定は、`runtime.ts`・`recall-runtime.ts` の `memoryStore.X` などの呼び出し表（grep）から。
- **開いて確かめた範囲**: write-diff-fuzz（ハーネスの操作一覧と pg の `it` 一覧）、recall-invariant-fuzz（ヘッダと `it` 一覧）、lifecycle-transition-table（共有の表を core の Fake・testkit の InMemory・Postgres の3本が走らせる）、uppercase-target-id-parity（口の一覧）、store-boundary-diff（約 117 場面の名前一覧。InMemory↔PG）、conformance の `supports*` フラグ、ADR 0522〜0531 の6組。**名前の一致までの範囲**: 個々の `it` の中身。(R) の判定は呼び出し表というコード読みの根拠で、そのメソッド由来の差を実際に検出できるかは未確認。
- **Fake が実装していない任意メソッド**: `createMemoriesWithOutboxAndEvents`・`scrubPurged`・`searchMany`・`listRelatedMany`。Runtime は Fake では別経路で動く（write-diff-fuzz が Runtime 経由で最終状態を比べるので、間接的な突き合わせにはなる）。
- 範囲外: `EmbeddingProvider`・`LLMProvider`・`Scheduler`・`Clock`・`TokenCounter` は Postgres 実装が無く、3者の比較が成り立たない。「3者」と数えたものにも深さの差がある（uppercase-target-id-parity は大文字の id の違いだけ。write-diff-fuzz は減衰の時計が既定の壁時計・claim key が無効）。

### MemoryStore（42）

| メソッド | 分類 | 根拠の歯 |
|---|---|---|
| createObservation / getObservation | 3者(直) | uppercase-target-id-parity.postgres.test.ts |
| createObservationWithOutbox | 3者(R: observe) | write-diff-fuzz.postgres.test.ts |
| createMemory / get / getMany | 3者(直) | uppercase-target-id-parity.postgres.test.ts |
| createMemoryWithOutbox | 3者(直) | tick-mixed-kinds-concurrency-lease-parity.postgres.test.ts |
| listBySourceObservation | 3者(直) | uppercase-target-id-parity.postgres.test.ts |
| listBySourceObservationAllVersions | 3者(R: reextract) | write-diff-fuzz.postgres.test.ts |
| updateStatus / setEmbeddingStatus | 3者(直) | uppercase-target-id-parity.postgres.test.ts |
| updateStatusWithEvent | 3者(R: forget・restore・consolidate) | lifecycle-transition-table.postgres.test.ts |
| reinforce / reinforceMany / recordUsage | 3者(直) | write-diff-fuzz.postgres.test.ts |
| recordUsageAndReinforce | 3者(R: observe の memory_usage) | write-diff-fuzz.postgres.test.ts |
| aggregateScope | 3者(直) | recall-invariant-fuzz.postgres.test.ts |
| createRecall | 3者(R: recall) | recall-invariant-fuzz.postgres.test.ts |
| getRecall | 3者(直) | uppercase-target-id-parity.postgres.test.ts |
| requeueEmbedJobs | 3者(直) | uppercase-target-id-parity.postgres.test.ts |
| supersedeWithNewMemories | 3者(R: consolidate・reextract) | write-diff-fuzz.postgres.test.ts |
| purgeExpiredEvents | 3者(直) | runtime-after-delete-parity.postgres.test.ts（ADR 0522） |
| archiveDecayed | 3者(R: sweepArchive)。壁時計だけ。**活動時計は、この ADR の歯で3者に入った** | write-diff-fuzz.postgres.test.ts／decay-activity-clock-parity.postgres.test.ts |
| purgeMemory | 3者(R: purge) | write-diff-fuzz.postgres.test.ts |
| markContestedPair / resolveContestedPair | 3者(R) | lifecycle-transition-table.postgres.test.ts |
| markContestedGroup / resolveContestedGroup | 3者(R) | uppercase-target-id-parity.postgres.test.ts |
| restoreSupersededBy / previewRestoreSupersededBy | 3者(直) | uppercase-target-id-parity.postgres.test.ts |
| eraseTenant | 3者(R) | runtime-tick-jobs-and-correction-reextract-parity.postgres.test.ts（ADR 0526） |
| findActiveByClaimKey / findContestedByClaimKey | 3者は `excludeMemoryId` の大文字だけ。本体は IM+PG | uppercase-target-id-parity.postgres.test.ts（3者）／ conformance（本体）。Fake 単独は `claim-key-*.test.ts` |
| supportsAddOwnSubjectSeq | IM+PG（conformance のフラグ）。**この ADR の歯の `reinforce` の経路で3者に入った** | memory-store-conformance.ts |
| createMemoriesWithOutboxAndEvents | IM+PG（Fake 未実装） | event-target-parity.postgres.test.ts |
| purgeExpiredRecalls | IM+PG | store-boundary-diff.postgres.test.ts。Fake 単独は fake-purge-expired-recalls-and-completed-jobs.test.ts |
| purgeExpiredEventsByRetention | IM+PG（testkit の round31 teeth と PG の並行・設定変更の歯） | memory-store-round31-teeth.ts。Fake 単独は event-retention-purge.test.ts |
| scrubPurged | IM+PG（Fake 未実装） | memory-store-conformance.ts |
| resolveOrphanedContested | IM+PG | store-boundary-diff.postgres.test.ts |
| listActiveClaimPredicates | IM+PG（limit・subjectId の境界だけ） | store-boundary-diff.postgres.test.ts |
| listLabels / registerLabel | IM+PG | store-boundary-diff.postgres.test.ts。Fake 単独は fake-labels-tenant-key.test.ts |

### VectorStore・LexicalStore・EventStore・OutboxStore・RelationStore

| メソッド | 分類 | 根拠の歯 |
|---|---|---|
| VectorStore.upsert / search / delete / deleteAcrossSpaces / getVectors | 3者(直)。`search` の `decayFloorSeqAfter` は、この ADR の歯で3者に入った | uppercase-target-id-parity.postgres.test.ts、runtime-after-delete-parity.postgres.test.ts |
| VectorStore.eraseTenant | 3者(R) | runtime-tick-jobs-and-correction-reextract-parity.postgres.test.ts |
| VectorStore.searchMany | IM+PG（Fake 未実装） | testkit-fixture-alignment.postgres.test.ts、vector-search-many-diff（PG 内） |
| LexicalStore.search | 3者(直)。ただし Fake の語彙一致は近似（ADR 0493 の E14） | runtime-after-delete-parity.postgres.test.ts |
| EventStore.append | 3者(R) | lifecycle-transition-table.postgres.test.ts |
| EventStore.get / list | 3者(直) | uppercase-target-id-parity.postgres.test.ts |
| OutboxStore.claimBatch / complete / fail | 3者(直) | tick-batch-exceeds-lease-parity.postgres.test.ts、tick-mixed-kinds-concurrency-lease-parity.postgres.test.ts |
| OutboxStore.eraseTenant | 3者(R) | runtime-tick-jobs-and-correction-reextract-parity.postgres.test.ts |
| OutboxStore.purgeCompletedJobs | IM+PG | store-boundary-diff.postgres.test.ts。Fake 単独は fake-purge-expired-recalls-and-completed-jobs.test.ts |
| RelationStore.link / unlink / listRelated | 3者(直) | uppercase-target-id-parity.postgres.test.ts。IM↔PG は relation-store-parity.postgres.test.ts |
| RelationStore.listRelatedMany | IM+PG（Fake 未実装） | relation-store-conformance.ts |

### TenantSettingsStore（13）

| メソッド | 分類 | 根拠の歯 |
|---|---|---|
| getDefaultHalfLifeHours | 3者(R。既定値のまま使うだけ) | write-diff-fuzz.postgres.test.ts |
| getEventRetention / setEventRetention | IM+PG | store-boundary-diff.postgres.test.ts。Fake 単独は fake-tenant-settings-write-validation.test.ts（ADR 0479） |
| getDecayClock / setDecayClock | IM+PG。**Runtime の操作列では、この ADR の歯で3者に入った** | store-boundary-diff.postgres.test.ts／decay-activity-clock-parity.postgres.test.ts |
| getDefaultHalfLifeRecalls / setDefaultHalfLifeRecalls | IM+PG。**同上** | store-boundary-diff.postgres.test.ts |
| getActivitySeq / hasSubjectActivityCounters / getSubjectActivitySeqs | IM+PG。**同上** | tenant-settings-store-conformance.ts |
| getTaxonomyMode / setTaxonomyMode | IM+PG | store-boundary-diff.postgres.test.ts |
| eraseTenant | 3者(R) | runtime-tick-jobs-and-correction-reextract-parity.postgres.test.ts |

### Runtime（20）

| メソッド | 分類 | 根拠の歯 |
|---|---|---|
| observe / tick / recall / getRecall / reextract / consolidate / reflect | 3者 | write-diff-fuzz.postgres.test.ts、recall-invariant-fuzz.postgres.test.ts、ADR 0522〜0531 の6組 |
| forget / purge / restoreArchived / restoreSuperseded / markContested / resolveContested | 3者 | lifecycle-transition-table.postgres.test.ts |
| markContestedGroup / resolveContestedGroup | 3者 | uppercase-target-id-parity.postgres.test.ts |
| findCorrectionCandidates / applyCorrection | 3者 | runtime-after-delete-parity.postgres.test.ts、runtime-tick-jobs-and-correction-reextract-parity.postgres.test.ts |
| sweepArchive | 3者（壁時計。**活動時計・either は、この ADR の歯で入った**） | write-diff-fuzz.postgres.test.ts／decay-activity-clock-parity.postgres.test.ts |
| reembed | 無し。Fake は runtime.test.ts・reembed-limit-validation.test.ts、PG は ingest-roundtrip.postgres.test.ts の単独 | — |
| resolveOrphanedContested | 3者は無し。store 層は IM+PG | store-boundary-diff.postgres.test.ts |

### 割れていそうな上位3つ（第1段で選んだ）

1. **活動時計（`decay_clock = "activity"`）の経路全体**: 根拠は、write-diff-fuzz と recall-invariant-fuzz のハーネスが `activity`・`decayClock`・`setDecayClock` を1度も使っていない（grep で 0 件）。Fake は core の `decay-activity-clock-*.test.ts` の単独、PG は `wall-to-activity-switch.postgres.test.ts` などの単独。理由は、実装が複雑（ADR 0165・0353・0394 の subject 単位のカウンタと T+S_x）で、Fake が `FakeBackingStore` を共有する別実装であり、過去の割れの形 A・E（ADR 0493 の E5・E6、ADR 0479）に当たりそうだったこと。→ **この ADR の第2段で歯を足した（下の「2.」）。**
2. **保持・掃除の口（`purgeExpiredEventsByRetention`・`purgeExpiredRecalls`・`purgeCompletedJobs`・`scrubPurged`）**: `purgeExpiredEventsByRetention` は conformance にも store-boundary-diff にも無く、Fake 単独と PG の並行・設定変更のテストだけ（ADR 0522 の測定では3者一致だったが、使い捨てのスクリプトで歯は無い）。残りは IM+PG。Fake は `scrubPurged` を実装していない。日時の境界・`limit`・`dryRun`・`events_purged` の記録・テナントごとの保持設定が絡む。→ **次の候補。**
3. **claim key・矛盾検出の読み口と、`observe` の `claimKey` 有効経路**: 本体の突き合わせは IM+PG の conformance だけ。Fake の `findActiveByClaimKey`（`runtime-fakes.ts` 2850 行付近）は `m.claimKey.subject !== query.claimKey.subject` の素の文字列比較と、有効期間の重なり判定を自前で持つ。InMemory・Postgres と同じ比較・正規化か、3者で同じ入力を流して確かめていない。ADR 0473・0474・0491 の領域。→ **次の候補。**

## 2. 1つ目: 活動時計の経路（3者一致。割れは見つからなかった）

### 測り方【実測】

Runtime の操作列を3者に流し、各段で次を平らなデータにして比べた（子 ID は別名に置き換える）。
- 記憶ごとの `status`・`decayBaseSeq`・`decayFloorSeq`・`halfLifeRecalls`。
- `TenantSettingsStore` の活動の数: `getActivitySeq`（T）・`hasSubjectActivityCounters`・`getSubjectActivitySeqs`（subject ごとの S_x）。
- `recall` の結果: 返った記憶の別名、`omitted` の種類と件数（`aggregateScope` の忘却ゲートの結果）、`index.totalInScope`、目次帯。
- `sweepArchive` の結果（選ばれた記憶・`reachedLimit`・その後の status）。

操作列（`packages/core/src/__tests__/fake-decay-activity-clock-parity.test.ts` と `packages/postgres/src/__tests__/decay-activity-clock-parity.postgres.test.ts` が同じ `EXPECTED`〔17 項目〕を持つ）:
1. `setDecayClock("activity")`・`setDefaultHalfLifeRecalls(3)` のテナントで、subject なし・alice・bob の記憶を `observe`（活動時計の3つ組が起点 0・床 13・半減期 3 で作られる）。
2. カウンタを進めてから（tenant の recall と alice の subject の recall）、半減期 1 の記憶を subject なしと alice で足す（起点は T + S_x。`reinforce` 以外の書き込みで subject 単位の起点が入ること）。
3. recall を 18 回（tenant・alice の subject・bob の subject の順）。各回の結果とカウンタを比べる（`activityCounting: "subject"` が S_x だけを進め、T に触れないこと。読み取りは常に T + S_x で、忘却ゲートが沈んだ記憶を落とすこと）。
4. usage による強化（`observe({ kind: "memory_usage" })`）: 起点が今の活動の数に進む（subject ありは T + S_x、なしは T）。
5. `consolidate`・`reflect` が書く記憶の3つ組（子の subject は alice）。
6. `sweepArchive` を、`clock: "activity"`・`"either"`・`"wall"`、テナントの既定、`now` が今日／遠い未来、で順に。壁時計の軸が生きている間は `either` と `wall` は何も選ばないこと、`either` は両方の軸が沈んだ記憶だけを選ぶこと、`wall` は活動時計が沈んでいても選ばないこと。
7. 壁時計から活動時計への切り替え（Issue #1014）: `wall` の間の記憶は3つ組が `null` のまま、切り替え後に活動時計が進んでも掃引に選ばれず、recall のゲートにも落とされない。切り替え後の記憶は選ばれる。
8. **境界**: 床とちょうど同じ値（`床 = 今`）で、掃引は選ぶ（`床 <= 今`）、recall のゲートは落とす（`床 > 今` でなくなる）。subject あり（今 = T + S_x）・なしの両方。

### 結果【実測。決定的】

- **3者が全項目で一致した。** Fake・InMemory・Postgres で、status・seq 欄・活動の数・recall の結果（忘却ゲートの件数まで）・掃引の結果が同じ。
- 決定的: 時計は活動の数（recall の回数）で進めるので、実時間に依らない（`sweepArchive` の `now` は壁時計の軸が生きている／死んでいる時刻を固定で渡す）。使い捨ての測定を4回繰り返して出力が同じで、歯は Postgres を5回、Fake を3回走らせて、すべて緑。
- 測定の途中で見かけの割れが1つ出た（実装の差ではない）: `recall` の `omitted` に載る `below_threshold` の `nearMisses` は、記憶の id と float4 の丸めを含む score を持ち、3者で綴り・下位の桁が違う。種類と件数だけを比べることにした。

## 3. 決定したこと

1. 割れが無かったので、実装・公開 API・既定値・CHANGELOG・`docs/migration-v1.md` は変えていない。
2. 一致している今の振る舞いを歯で縛った（conformance suite には足さない。ADR 0434 決定5）:
   - `packages/core/src/__tests__/fake-decay-activity-clock-parity.test.ts`（Fake）
   - `packages/postgres/src/__tests__/decay-activity-clock-parity.postgres.test.ts`（InMemory と実 Postgres）
3. 棚卸しの表を、次に当てる口を選ぶ起点として残す。2つ目・3つ目は「次の候補」。

## 4. 変異試験【実測】

実装を1つずつ曲げ、歯が噛むかを確かめた。戻した後は `git status` に歯の2ファイル以外が無い。**11 件すべて赤**。
- Fake: `archiveDecayed` の境界を `<=` から `<` に／`archiveDecayed` で subject の S_x を足さない／VectorStore の忘却ゲートの境界を `>` から `>=` に／`reinforce` の `addOwnSubjectSeq` の S_x を足さない／`createRecall` が subject カウンタを進めない／`aggregateScope` の忘却ゲートで S_x を足さない。
- InMemory: `archiveDecayed` の境界・S_x、VectorStore の忘却ゲートの境界。
- Postgres: `activity-decay-sql.ts` の掃引の `<=` を `<` に、recall のゲートの `>` を `>=` に。
- 最初の版の歯（境界・`aggregateScope` の S_x を見ない版）は、11 件中 6 件が緑のまま通った（もう1件は変異の当て方の誤りで未実施だった）。そこで「8. 境界」の段と、recall の `omitted`・`totalInScope` の比較を足して、すべて赤になるようにした。

## 5. 検討した代替案

1. **store の口ごとに、活動時計の入力を直接流す。** 採らなかった。口が多く、Runtime が組む入力（`nowSeq`・`addOwnSubjectSeq`・`usesSubjectActivityCounters`）の組み合わせの誤りは、Runtime の操作列でないと出ない。
2. **歯を足さず、結果だけ書く。** 採らなかった。

## 6. オーナーの領分の材料

なし（新しい形の割れも、既定値・公開 API・決定を覆す材料も見つからなかった）。

## 7. これが覆るとしたら

- 活動時計の計算（`defaultActivityDecayStrategy`・T + S_x の足し方・掃引と recall のゲートの境界）を変えるとき（歯の `EXPECTED` を意図して書き換える）。

## 8. 測っていないこと

- `decay_clock` を `activity` から `wall` へ戻す操作（ADR 0165 の追記が「戻せる」とどう書くか）。
- 並行する recall が同じ活動カウンタを進めるときの扱い（`activity-counting-per-call`・`create-recall-activity-clock-single-statement` の Postgres 単独の歯の面）。
- `usesSubjectActivityCounters` が `false` のテナント（subject カウンタを1度も使わない）の読み取りの SQL の形（性能の面）。
