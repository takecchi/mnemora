# ADR 0505: fixture の `S_x` の bigint 溢れ（`archiveDecayed`・`aggregateScope`・`VectorStore.search`）、Observation・Recall の NUL を名指しで断る、`EventStore.append`・`LexicalStore.search` の例外から params を落とす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定。担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元の Postgres 17（UTF8・`C.UTF-8`）で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 3つの負債を返す。
  1. [ADR 0500](./0500-testkit-fixture-alignment-claimkey-labels-timestamptz-seq-llm-float4.md) の「引き受けた負債・材料」: `reinforce` 以外の `S_x` を足す口は、Postgres が `22003` にするが fixture は通す。
  2. [ADR 0499](./0499-store-write-checks-nul-named-status-range-purged-cas-int4-days.md)（ADR 0456 の M4）の「変えなかったこと」: `createObservation`・`createRecall` の NUL は生の `DrizzleQueryError` のまま。
  3. [ADR 0504](./0504-vector-store-omits-params-from-thrown-errors.md) の表の負債: `PostgresEventStore.append`・`PostgresLexicalStore.search`。

- **見つけたこと**【現物】（依頼の記述と食い違う点は ⚠）:
  - ⚠ 依頼は「`append`（`meta` の孤立サロゲートで例外の message に値が載る）」だったが、土台の main には ADR 0499 が入っており、`meta`・`actor` の孤立サロゲートは入口の検査が名指しの例外（値を含まない）で先に断る。DB に届く入力で params が載るのは、`kind` の CHECK 違反など別の拒まれ方だった（歯の作り方）。
  - ⚠ 依頼の項目2は `createObservation` だったが、`runtime.observe` が使う `createObservationWithOutbox` も同じ生の例外だった。同じ検査を足した（`InMemoryMemoryStore` は両方に同じ検査を持つ）。
  - `externalId`・`subjectId` の NUL は、`assertWellFormedIdentifier`（ADR 0423）が先に断るので、新しい検査は見ない。

- **決めたこと**【判断】:
  1. **fixture の `S_x` の溢れ**（testkit のみ。🟡）。Postgres が溢れを見るのは、`nowSeq + S_x`（`archiveDecayed`）・`decayFloorSeqAfter + S_x`（`aggregateScope`・`VectorStore.search`）の式が**実際に評価される行**があるときだけ【実測】。fixture も同じ条件で `bigint` の言葉の `Error` を投げる。足すのは ADR 0500 と同じく `BigInt(String(nowSeq)) + BigInt(S_x) >= 2n ** 63n`（ドライバが文字にした値）。境界は `nowSeq = 2**63 - 1024` で `S_x = 807` が通り `808` が `22003`。
     - 評価される条件: カウンタを使う（`usesSubjectActivityCounters` / `decayFloorSeqUsesSubjectCounters`）、記憶が subject を持つ、`decay_floor_seq` が非 NULL（`IS NULL OR …`・`IS NOT NULL AND …` の短絡）。
     - 2軸のとき: `aggregateScope` は既定が `(NOT wall OR NOT activity)`、`decayFloorAnyAxis` が `(NOT wall AND NOT activity)` で、左（壁時計）で決まれば右は評価されない。`VectorStore.search` は既定が別々の条件（壁時計で落ちる行は活動時計まで行かない）、`decayFloorAnyAxis` が `(wall OR activity)`。`archiveDecayed` の `clock: 'either'` は AND で、壁時計が沈んでいない行は活動時計を評価しない。
     - ほかの条件（`status`・`attributes`・集計の「スコープ内」など）で先に落ちる行は評価されない。`search` の fixture は、活動時計の条件の結果で落ちる行も、ほかの条件を通っていれば投げる（Postgres は評価した時点で失敗するため）。
     - **`nowSeq`（`decayFloorSeqAfter`）そのものが `bigint` に収まらない**（2^63 以上）ときは、行が無くても Postgres は拒む【実測】ので、その検査も足した（`assertQueryBigint`）。ただし `archiveDecayed` は `clock: 'wall'` のとき `nowSeq` を SQL に入れないので見ない。
  2. **Observation・Recall の NUL を名指しの `Error` で断る**（`@mnemora/postgres`。🔴 60）。`createObservation`・`createObservationWithOutbox` は `kind`・`payload`・`attributes`（key も値も、入れ子の中も）、`createRecall` は `query`・`budget`・`omitted`・`usage`・`indexBand`・`explain`・`returnedMemories`。文面は testkit と同じ（`PostgresMemoryStore: <欄> must not contain NUL characters (U+0000)`、`createRecall: <欄> must not contain NUL characters (U+0000)`）。INSERT の前、活動時計を進める前に断る。断る入力は増えない（以前も落ちた）。新しい関数は `input-check.ts` の内部（`assertNoNulInNewObservation`・`assertNoNulInNewRecall`）。公開 API・新しい例外クラスは足していない。
  3. **`PostgresEventStore.append`・`PostgresLexicalStore.search` の例外から params を落とす**（ADR 0504 と同じ `omittingParams`。`append` は2つの INSERT の両方）。例外の種類・`code`・`cause` は変わらない。
  4. **既存の歯が「NUL で DB を落とす」ことに頼っていないかを grep で確かめた**: observation・recall の口で NUL に頼る歯は無かった（`store-boundary-diff.postgres.test.ts` の `createRecall(…:NUL)` は結果の種類（投げた）で2実装を比べるだけで、通る）。ADR 0499 のときの `outbox-last-error-omits-params` のような差し替えは要らなかった。

- **採らなかった案**:
  1. **`archiveDecayed` などで `nowSeq + S_x` が溢れる行をすべて断る（評価の条件を無視する）。** 採らなかった。`decay_floor_seq` が NULL の行や subject を持たない行、壁時計で決まる行では Postgres は通す。通す入力まで断る「やりすぎ」になる。
  2. **`assertQueryBigint` の下限を `-2^63` ちょうどを断る形に直す。** 採らなかった（下の負債）。依頼の範囲外で、core の `runtime-fakes.ts` の写しと対で直すもの。
  3. **`EventStore.get`・`list` も包む。** 採らなかった。依頼は `append` と `search`。

- **引き受けた負債**:
  - `assertQueryBigint` は `-2^63` ちょうどを通すが、Postgres はドライバが文字にした値（`"-9223372036854776000"`）で `22003` にする【実測: `archiveDecayed`・`aggregateScope`・`search` の `nowSeq = -(2**63)`】。`reinforce` の `nowSeq` も同じ判定を共有するので、同じ差が残る。到達しない入力。
  - `archiveDecayed` の `assertQueryInteger("nowSeq")` は `clock: 'wall'` でも非整数を断るが、Postgres は `wall` では `nowSeq` を見ない【現物。実測はしていない】。
  - `search` の評価順（活動時計の条件が最後）は、プランナの条件の並べ替え（コストの順）に依る【判断】。実測した行の数が少ない（1行）ので、大きなテーブルでプランが変わったときの差は確かめていない。
  - `PostgresEventStore.get`・`list`、`PostgresTrigramLexicalStore`・`PostgresOutboxStore`・`PostgresRelationStore`・`PostgresTenantSettingsStore` の直接呼びの params は、ADR 0504 の表のまま。

- **これが覆るとしたら**:
  - オーナーが fixture の新しい断りを 🔴 に数えると決めたとき（ADR 0461）。この ADR は項目1を 🟡 に置いた。
  - Postgres の式の評価順・短絡が変わったとき。歯 `testkit-fixture-seq-sum-overflow.postgres.test.ts` が落ちる。
  - オーナーが Observation・Recall の NUL を 🔴 に数えないと決めたとき（ADR 0499 の判断を覆すとき）。

- **測ったこと**（【実測】2026-10-02）:
  - **溢れ**: 3つの口とも、`nowSeq = 2**63 - 1024`・`S_x = 808` で `22003 bigint out of range`、`807` は通る。subject なし・`decay_floor_seq` が NULL・カウンタを使わない場合は `S_x = 5000` でも通る。`nowSeq = ±2**63` は行が無くても `22003`（`value "9223372036854776000" is out of range for type bigint`）。
  - **歯の赤→緑**: `packages/postgres/src/__tests__/testkit-fixture-seq-sum-overflow.postgres.test.ts`（44本中16本が、fixture が通すために赤。直した後は44本とも緑。Postgres 側は仮説どおりに全44本が通った）、`packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts`（39本中15本が赤 → 緑）。`store-write-nul-named.postgres.test.ts` に Observation・Recall の歯を足した（314本中20本が赤（Postgres 側のみ。InMemory は直す前から緑）→ 緑）。`error-message-omits-params.postgres.test.ts` に `append`・`search` の歯を足した（14本中3本が赤 → 緑）。
  - **変異**（歯が噛むこと）: testkit — 境界を下げる（やりすぎ）4本赤、上げる 13本赤、aggregate の2軸の左を見ない（やりすぎ）2本赤、floor NULL でも断る（やりすぎ）1本赤、`wall` でも `nowSeq` の範囲を断る（やりすぎ）1本赤、カウンタ無しでも断る（やりすぎ）2本赤、search の anyAxis／AND で評価しない 1本・4本赤、seq の条件で落ちる行は投げない 4本赤、search の範囲検査を外す 1本赤。postgres — payload 6・attributes 4・kind 2・recall の explain 1・budget 1 の検査を外すと赤、文字どおりの `\u0000` も断る（やりすぎ）1本赤、`U+0001` も断る（やりすぎ）2本赤、`createObservationWithOutbox`・`createObservation` に配線しない 6本赤、`createRecall` に配線しない 8本赤、`append` の2経路・`search` の包みを外す 1本ずつ赤、`omittingParams` が元の例外を捨てる（やりすぎ）5本赤。戻して緑。
