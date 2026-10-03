# ADR 0547: Postgres の読みの経路は、`timestamptz` の下限より前の日付を下限に寄せてから比べる（オーナーの推奨 (d)「日付は0件扱い」を「寄せてから比べる」と読み替えた。ADR 0456 の M2 と ADR 0500 の決めたこと2のうち、読みの口の部分を置き換える）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

担い手が書いた（マネージャー mgr-903746bd の指示。出所はオーナーへの問い 374f6f88 の問5）。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector、自分専用のポートで）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 日時の条件（`since`・`occurredAfter`・`validAt` など）に、`timestamptz` の下限（4714-11-24 BC 00:00:00 UTC。JS では `Date.UTC(-4713, 10, 24)`）より前の日付を渡すと、`@mnemora/postgres` は生の `DrizzleQueryError`（SQLSTATE `22008 timestamp out of range`）で落ちる。[ADR 0456](./0456-llm-returned-values-malformed-read-filter-nul-named.md) の M2 がこれを見つけ、「検索の絞りの日付も purge と同じ扱い（0件）にするのは、今は例外で終わる入力を成功にする——結果が『黙って成功』に変わる」ので直さず、材料にした。[ADR 0500](./0500-testkit-fixture-alignment-claimkey-labels-timestamptz-seq-llm-float4.md) は testkit の InMemory を Postgres に揃える向きで、読みの口にも `RangeError` を足した。オーナーへの問い 374f6f88 の問5 に対し、推奨 (d)「日付は0件扱い」が出た。この ADR はそれを実装する。

## オーナーの推奨 (d) の読み替え

**(d)「日付は0件扱い」を、そのまま「日付が下限より前なら、どの口も0件を返す」とは読まなかった。「下限に寄せてから、いつもどおり比べる」と読んだ。**【判断】

理由:

1. **`since` 系は、0件にすると意味が逆になる。** `since: 紀元前5001年`（`occurredAfter`・`decayFloorAtAfter`・`validFrom` も同じ向き）は、「その日以後」であり、列の値はすべて下限以後なので、**答えは全件**である。0件を返すと、「全部」が「何も無い」に化ける。`Runtime.recall` は絞りで落ちた件を `omitted`（`filtered`）に積む設計なので、全件が「期間の絞りで落ちた」と報告されることになる【未確認: 下限より前の入力での `omitted` の実出力は見ていない】。
2. **寄せてから比べれば、(d) の元になった purge の0件も同じ規則で出る。** purge の口は `at < olderThan` を使う。`olderThan` を下限に寄せると `at < 下限` は誰にも当たらず、0件になる。つまり (d) の「0件」は、寄せて比べたときの purge 側の答えであり、`since` 系には当てはまらない。**1つの規則（寄せて比べる）が、purge の0件と `since` 系の全件の両方を説明する。**
3. **`validAt` は、0件でも全件でもない。** `validAt` が下限より前のとき、開始が無く（`valid_from` が NULL）終了が将来か無い記憶だけが有効になる。0件扱いにするとこれも誤る。
4. **`claimBatch` は、`now - leaseMs` だけが下限より前になりうる。** `now` は下限より後で、リースが長いと境界が下限を割る。0件扱いにすると、まだ claim されていない job まで取れなくなる。

**`until`・`occurredBefore` など上限の側は、寄せた結果が0件に近くなる**（列の値はすべて下限以後）。(d) の言う「0件」は、この側では結果としてそのまま出る。

## 現物【現物】と、直す前の赤【実測】

- 下限より前で落ちる読みの口（`main` 0cfe277c）: `EventStore.list`（`since`・`until`）、`VectorStore.search`・`searchMany`（`occurredAfter`・`occurredBefore`・`validAt`・`decayFloorAtAfter`）、`LexicalStore.search`（tsvector 版・trigram 版。`occurredAfter`・`occurredBefore`・`validAt`）、`MemoryStore.aggregateScope`（同じ4欄）、`findActiveByClaimKey`・`findContestedByClaimKey`（`validFrom`・`validUntil`）、`OutboxStore.claimBatch`（`opts.now` と `now - leaseMs`）、これらを通る `Runtime.recall`。
- 今「0件」で返す口は、purge の3口（`purgeExpiredEvents`・`purgeExpiredRecalls`・`OutboxStore.purgeCompletedJobs`。`olderThan` の早い return）だけ。
- InMemory（testkit）は、読みの口で `RangeError`（ADR 0500）。core の Fake は検査せず、意味どおりに答える。
- **直す前の赤**: 3実装の突き合わせの歯 `packages/postgres/src/__tests__/date-below-floor-read-parity.postgres.test.ts` を先に commit した（`748ce7c3`）。**56本すべて赤**。Postgres は `22008`、InMemory は `RangeError`（`… must not be earlier than 4714-11-24 BC …`）で落ち、Fake の側は期待どおりだった（差分に出ない）。紀元前5001年と下限の1ms 前の2通りで、`EventStore.list` の `since`・`until`、`VectorStore.search`・`searchMany` と `aggregateScope` の4欄、`LexicalStore.search`（tsvector 版・trigram 版）の3欄、`findActiveByClaimKey`・`findContestedByClaimKey`、`claimBatch`、`Runtime.recall` が赤になった。

## 決めたこと【判断】

1. **読みの口の日時を、下限（`PG_TIMESTAMPTZ_MIN_MS`）に寄せてから比べる。** `packages/postgres/src/mapping.ts` に `toPgTimestampClamped`（寄せてから `toPgTimestamp` にする）を足し、上の口の条件で使う。`NaN`（Invalid Date）は寄せない（`22007` のまま。下の「材料」）。下限ちょうどは寄せなくても同じ値。
2. **`claimBatch` は、読みの条件（`available_at <= now`、`claimed_at <= now - leaseMs`）だけでなく、同じ文の書き込み（`claimed_at`・`available_at` の SET）も寄せた値にする。** 寄せずに書くと、比べる側が通した行の UPDATE が `22008` になる。
3. **claim key の「空の区間は何とも重ならない」（ADR 0473）の判定は、寄せる前の値で JS が決める。** 両端が下限より前で `from < until` のとき、寄せた値は等しくなり、SQL の `from < until` では空の区間に見える。空でない区間（開始も終了も無い記憶と重なる）を空と取り違える。判定を `emptyInterval`（`from >= until` を元の値で）にして SQL へ渡す。
4. **purge の3口の早い return を、1つの補助関数 `isBeforePgTimestamptzMin`（`mapping.ts`）に集めた。** 下限の定数もそこへ移し（`memory-store.ts` と `outbox-store.ts` に1つずつあった）、`toPgTimestampClamped` と共有する。purge の結果は変わらない。
5. **InMemory は、読みの口の `RangeError` をやめ、寄せずに意味どおりに比べる。** 列の値は下限以後しか無いので、寄せなくても答えは同じ（`since` 系は全件、`until` 系は0件）。Invalid Date だけ断る（`assertQueryDate`）。**書く口（`opts.now`・`opts.at` など、行の値になる日時）の `RangeError` は残す**（Postgres が `22008` にするため）。`assertQueryTimestamptz` の doc に、読みの口には使わないと書いた。
6. **3実装の突き合わせの歯を置いた**: `date-below-floor-read-parity.postgres.test.ts`。同じデータ・同じ入力を Postgres・InMemory・core の Fake に流し、(1) 3者が一致すること、(2) 答えが意味どおり（全件・0件・`validAt` の部分集合）であることを縛る。Fake は `searchMany` を持たないので、そこだけ `search` で答える。
7. **対象は読みの経路だけ。** 書き込みの口と `NaN`（`22007`）は変えない。数と場所は「材料」。
8. 公開 API は増えない（`mapping.ts` は公開されない）。新しい例外クラスは作らない。conformance suite には `it` を足していない。DB マイグレーションは無い。

## 置き換えるもの

| 置き換えられる決定 | どこ | 何に置き換わるか |
|---|---|---|
| 検索の絞りの日付の範囲外は、「黙って成功」になるので**直さず材料にした** | [ADR 0456](./0456-llm-returned-values-malformed-read-filter-nul-named.md) 材料 M2 | 読みの口は成功する。ただし (d) の「0件」ではなく、「下限に寄せてから比べる」答え。型付きの例外に包む案は、M2 が述べた理由（公開 API の snapshot が変わる）のまま採らない |
| 下限より前を断るのは、**Postgres が `22008` にする口にだけ**。読みの口の日時の条件にも `RangeError`（fixture） | [ADR 0500](./0500-testkit-fixture-alignment-claimkey-labels-timestamptz-seq-llm-float4.md) 決めたこと2、「測ったこと」の口ごとの表の読みの口の行（`22008`）、見つけたこと4 | **読みの口の部分だけ**: Postgres は通し、InMemory も断らない。**書く口の `RangeError`（`opts.now`・`opts.at`・outbox の行を書く口）は ADR 0500 のまま** |
| purge の `olderThan` が下限より前なら、問い合わせず0件で返す | これを**定めた ADR は見つからなかった**（`grep -rn "247万\|PG_TIMESTAMPTZ\|olderThan.*下限" docs/decisions` で、現物の記述と前提として出るのは ADR 0456 M2・ADR 0500 だけ。コードは #1129〔`f663a6c6`〕・#1479〔`70cb68b0`、ADR 0404〕で入った） | 結果は置き換えない（0件のまま）。「寄せて比べた purge 側の答え」として規則を1つにした（決めたこと4） |

## 採らなかった案

1. **(d) をそのまま実装する（日付が下限より前なら、読みの口はどれも0件）。** 採らなかった。上の「読み替え」の1〜4。
2. **型付きの例外に包む（`RangeError` を Postgres 側でも投げる）。** 採らなかった。ADR 0456 M2 のとおり公開の例外クラスが増える。呼び出し側は、正当な問い（「紀元前5001年以降」）に例外を受け取る。
3. **寄せる先を `-infinity` にする（下限ちょうどの行まで意味どおりに答えられる）。** 採らなかった（【判断】。迷った点）。マネージャーの指示は下限の値（`PG_TIMESTAMPTZ_MIN_MS`）へ寄せることだった。さらに `claimBatch` は寄せた値を行に書くので、`-infinity` を列に書けない。代わりに引き受けた限界を下に書き、歯で縛った。
4. **InMemory も下限へ寄せる。** 採らなかった。寄せなくても答えは同じ（列の値は下限以後）で、寄せると claim key の空の区間（決めたこと3）を InMemory でも別に直す必要が出る。
5. **core の Fake に検査を足す。** 採らなかった。Fake は検査をせず意味どおりに答える参照実装で、読みの口はすでに正しい。

## 引き受けた負債

| # | 負債 | 緊急度 |
|---|---|---|
| 1 | **下限ちょうどの時刻に行があるとき、`until`・`occurredBefore` を下限より前にすると、Postgres はその行を返す**（寄せた値 `<=` 下限）。意味どおりなら0件で、InMemory と Fake は0件。`validAt`（`valid_from <= T`）・`decayFloorAtAfter`（`>`）・claim key の重なりにも同じ形の食い違いがありうる【未確認。実測していない】。【実測】`occurredBefore`・`EventStore.list` の `until` は歯で縛った（既知の限界の it）。下限ちょうどに行を書けるのは、書く口が下限ちょうどを通すため。実在する値かは【未確認】 | 低（行が下限ちょうどに無ければ起きない） |
| 2 | **`claimBatch`**: `now` が下限より前で、`available_at` が下限ちょうどの job が claim でき、`claimed_at` は下限になる（【実測】歯あり）。リースの切れ目の判定も、寄せた境界で行う | 低 |
| 3 | **読みは通るが書きは通らない。** 同じ日付を、読みの口は受け入れ、書く口（下の材料）は `22008` で落とす。呼び出し側から見て非対称 | 中（オーナーの領分） |
| 4 | `NaN`（`22007`）は読みの口でも生の例外のまま。InMemory は `Error`（`… must be a valid Date`）。型が違う | 低 |

## これが覆るとしたら

- オーナーが「下限より前の日付は、読みの口でも拒む（型付きの例外にする）」と決めたとき（採らなかった案2）。
- 「`since` 系も0件にする」と決めたとき（(d) の字義どおり。採らなかった案1）。`since` 系の歯（`EventStore.list since` ほか）が落ちる。
- PostgreSQL が `timestamptz` の下限より前を受け入れるようになったとき。寄せる処理は要らなくなる（歯は前提が崩れて落ちる）。
- 負債1を直したいとき（下限ちょうどの行を意味どおりに扱う）。`-infinity` に寄せ（読みの条件だけ）、`claimBatch` の書き込みは別の値にする必要がある（採らなかった案3）。

## 材料（直していない。オーナーの領分）

### 書き込みの口（変えていない）

行の値になる日時を `toPgTimestamp` で渡す口は、下限より前なら `22008` のまま。**`main` 0cfe277c の現物の数え方**（`packages/postgres/src` のテスト以外で、コメントを除く `toPgTimestamp(` の呼び出し。読みの口の `toPgTimestampClamped` と、purge の `olderThan` の3か所、`events_purged` の `new Date()` は除く）で、**42か所・22関数**:

| ファイル | 関数（呼び出しの数） |
|---|---|
| `memory-store.ts`（38） | `createObservation`（4）、`createObservationWithOutbox`（7）、`insertMemoryRow`（3。`createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` が共有）、`insertMemoryWithOutboxRows`（2）、`insertMemoryEventsBatch`（1）、イベントを書く補助（1。`updateStatus` ほかが共有）、`updateStatusWithEvent`（1）、`supersedeWithNewMemories`（3）、`reinforce`（2）、`reinforceMany`（3）、`createRecall`（1）、`requeueEmbedJobs`（2）、`archiveDecayed`（1）と対象選びの `wallCondition`（1）、`purgeMemory`（2）、`markContestedPair`（1）、`resolveContestedPair`（1）、`resolveOrphanedContested`（1）、`restoreSupersededBy`（1） |
| `event-store.ts`（2） | `append`（2） |
| `outbox-store.ts`（2） | `complete`（1）、`fail`（1） |

- マネージャーの指示にあった「約35口」と一致する数え方は取っていない。上は**呼び出し箇所**（関数内の `toPgTimestamp(` の行数）であり、公開の口に数え直すと共有の補助が重なる。【未確認】公開の口ごとの `22008` の実測（ADR 0500 は `complete`・`fail`・`requeueEmbedJobs`・`archiveDecayed`・`*WithOutbox` の `now` だけ実測した）。
- 書く口を寄せると、**別の日時が保存される**。寄せる案は取らなかった。拒むか、保存できる範囲を契約にするかはオーナーの領分。

### `NaN`（Invalid Date、`22007`）（変えていない）

- 読みの口でも書く口でも、`toPgTimestamp` は `NaN` の日時を Postgres が拒む文字列にし、`22007 invalid input syntax for type timestamp with time zone` になる（寄せる判定は `NaN < x` が偽なので素通りし、`isBeforePgTimestamptzMin` も `NaN` を「前」と数えない）。
- InMemory は読みの口で `assertQueryDate`（`… must be a valid Date (got Invalid Date)`）。Fake の読みの口の `NaN` は【未確認】。

## 歯と変異試験

**直した後**: `date-below-floor-read-parity.postgres.test.ts` 66本が緑。`testkit-fixture-alignment.postgres.test.ts`（読みの口は「2実装とも断らない」、書く口は従来どおり「断る」に直した）と `packages/testkit/src/__tests__/in-memory-fixtures-timestamptz-floor.test.ts`（同じく読みの口を「断らない」に直し、`since` 系の全件・`until` 系の0件を足した）も緑。

**変異試験**【実測】（寄せる処理を1口ずつ外す・境界を1msずらす。1つずつ入れ、歯が赤くなることを見て、`cp` で戻して緑に戻ることを確かめた）:

| # | 変異 | 結果 |
|---|---|---|
| M01 | EventStore.list since を寄せない | 赤 4本 |
| M02 | EventStore.list until を寄せない | 赤 3本 |
| M03 | vector-store の occurredAfter を寄せない | 赤 9本 |
| M04 | vector-store の occurredBefore を寄せない | 赤 8本 |
| M05 | vector-store の validAt を寄せない | 赤 8本 |
| M06 | vector-store の decayFloorAtAfter を寄せない | 赤 8本 |
| M07 | lexical-store の occurredAfter を寄せない | 赤 2本 |
| M08 | lexical-store の occurredBefore を寄せない | 赤 2本 |
| M09 | lexical-store の validAt を寄せない | 赤 2本 |
| M10 | trigram-lexical-store の occurredAfter を寄せない | 赤 2本 |
| M11 | trigram-lexical-store の occurredBefore を寄せない | 赤 2本 |
| M12 | trigram-lexical-store の validAt を寄せない | 赤 2本 |
| M13 | aggregateScope occurredAfter を寄せない | 赤 4本 |
| M14 | aggregateScope occurredBefore を寄せない | 赤 4本 |
| M15 | aggregateScope validAt を寄せない | 赤 2本 |
| M16 | aggregateScope decayFloorAtAfter を寄せない | 赤 2本 |
| M17 | findActiveByClaimKey validFrom を寄せない | 赤 6本 |
| M18 | findActiveByClaimKey validUntil を寄せない | 赤 6本 |
| M19 | findContestedByClaimKey validFrom を寄せない | 赤 2本 |
| M20 | findContestedByClaimKey validUntil を寄せない | 赤 2本 |
| M21 | claim key の空の区間を、寄せた後の値で決める（findActive） | 赤 2本 |
| M22 | claim key の空の区間を決めない（findActive。逆転した区間が空にならない） | 赤 2本 |
| M23 | claimBatch now（読みと書き）を寄せない | 赤 3本 |
| M24 | claimBatch の now - leaseMs を寄せない | 赤 4本 |
| M25 | claimBatch の書き込み（SET claimed_at）だけ寄せない | 赤 3本 |
| M26 | 寄せる先を下限 + 1ms にする | 赤 2本 |
| M27 | 寄せる先を下限 - 1ms にする | 赤 63本 |
| M28 | 下限の定数を +1ms ずらす（寄せる判定の境界） | 赤 3本 |
| M29 | 下限の定数を -1ms ずらす（寄せる判定の境界） | 赤 63本 |
| M30 | 寄せる判定を `<` から `<=` にする | **緑（生き残り）**（同値変異: 下限ちょうどは寄せても同じ値なので、答えが変わらない） |
| M31 | purge の早い return を外す（purgeExpiredEvents） | 赤 2本（purge の3口。M32・M33 は最初の版では生き残ったので、purge の歯を足した。足した版で再実測。赤はその版の本数） |
| M32 | purge の早い return を外す（purgeCompletedJobs） | 赤 2本（purge の3口。M32・M33 は最初の版では生き残ったので、purge の歯を足した。足した版で再実測。赤はその版の本数） |
| M33 | purge の早い return を外す（purgeExpiredRecalls） | 赤 2本（purge の3口。M32・M33 は最初の版では生き残ったので、purge の歯を足した。足した版で再実測。赤はその版の本数） |
| M34 | InMemory EventStore.list が since で RangeError に戻る | 赤 4本 |
| M35 | InMemory VectorStore.search が occurredBefore で RangeError に戻る | 赤 7本 |
| M36 | InMemory LexicalStore.search が validAt で RangeError に戻る | 赤 4本 |
| M37 | InMemory aggregateScope が decayFloorAtAfter で RangeError に戻る | 赤 2本 |
| M38 | InMemory findContestedByClaimKey が validUntil で RangeError に戻る | 赤 2本 |

- 最初の版（64本）で生き残ったのは M30（同値）と M32・M33（purge の早い return を外す変異。既存の purge の歯は `purgeExpiredEvents` だけを見ていた）。M32・M33 のために purge 3口の突き合わせを足して（66本）、M31〜M33 は再実測で赤になった。
- M26・M28 は、下限ちょうどに行がある歯（寄せる先・判定の境界を1ms ずらす）を足して初めて赤になった。M27・M29 は下限の1ms 前（`EARLY`）の歯が、寄せる先・判定を1ms 手前にずらすと全滅する。
- M34〜M38 は InMemory の読みの口に `RangeError` を戻す変異（testkit を build し直して実行）。
- 戻した後は `git status` が変異前と同じで、3ファイルが緑に戻ることを確かめた。
- **追記（別の担い手による独立の変異試験。2026-10-03）**: 次の4件が、上の歯をすり抜けた。`date-below-floor-read-parity.postgres.test.ts` に歯を足して（66本→73本）、いずれも赤になることを3回ずつ確かめた。
  - findContestedByClaimKey の空の区間の判定を、寄せた後の値で行う変異（findActive にだけ歯があった）: 両端とも下限より前の contested の歯を足した。
  - 寄せる判定を「下限+2ms 未満」「下限+1日 未満」へ広げる変異: 下限+1ms・下限+1日-1ms を境にした `EventStore.list`・`VectorStore.search` の歯を足した（下限の直後の行を寄せずに比べる）。
  - purge（`purgeCompletedJobs`）の早い return を、下限以後（1990年未満）まで広げる変異: 既存の purge の歯（retention-purge-parity・outbox-first-terminal-wins・store-boundary-diff・conformance）はどれも緑のまま通ったので、紀元1000年に完了した job を紀元1500年の olderThan で消せる歯を足した。
  - 足していない: 寄せる処理を上限側（2100年超）にも掛ける変異。ADR は上限側の約束を持たない。InMemory の `until` を下限へ寄せる変異（Postgres の負債1を InMemory に写す形）は、Postgres との突き合わせの歯でだけ赤になり、testkit 単体の歯では緑のまま。

