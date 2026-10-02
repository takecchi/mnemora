# ADR 0516: `PostgresTrigramLexicalStore.search`・`PostgresOutboxStore`・`PostgresTenantSettingsStore` を直接呼んだときの例外からも、SQL の `params` の値を落とす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定。担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元の Postgres 17（UTF8・`C.UTF-8`、と SQL_ASCII・`C`）で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: [ADR 0504](./0504-vector-store-omits-params-from-thrown-errors.md) の表の「負債」の口のうち、[ADR 0505](./0505-seq-sum-overflow-fixture-observation-recall-nul-event-lexical-params.md) が `PostgresEventStore.append`・`PostgresLexicalStore.search` を返した。残りのうち、口が少ないものを返す。`Runtime` を通れば core の `omitParamsFromError`（ADR 0423）が落とすが、store を直接呼ぶ呼び出しでは落ちない。

- **見つけたこと**【現物】:
  - `packages/postgres/src` で `omittingParams`（`omit-params.ts`）を使うのは、この PR の前は `event-store.ts`・`lexical-store.ts`・`vector-store.ts` だけだった。
  - 残りの store は、DB の例外（drizzle の `DrizzleQueryError`。`message` が `Failed query: <SQL>\nparams: <値>`）をそのまま投げる。口の数は、`PostgresTrigramLexicalStore.search` が1（`db.transaction`）、`PostgresOutboxStore` が8つの呼び（`claimBatch`・`complete`・`fail`・`raiseIfLeaseConflict`・`eraseTenant` の dryRun と transaction・`purgeCompletedJobs` の dryRun と transaction）、`PostgresTenantSettingsStore` が14（`get*`・`set*`・`has*`・`eraseTenant` の2つ）。
  - `PostgresOutboxStore.fail` は `last_error` の列から NUL を落とす（ADR 0363・0499 の `outbox-fail-nul-last-error`）が、これは列の話で、例外の message とは別。

- **決めたこと**【判断】:
  1. **上の3つの store の、DB を呼ぶ全ての呼び（`this.db.execute(...)`・`this.db.transaction(...)`）を `omittingParams` で包む。** 形・印は ADR 0504 と同じ（SQL の文は残し、`params: (omitted by mnemora, N chars)` にする。例外そのものを返し、新しい例外は作らない。`code`・`name`・`cause` は残る。目印が無い例外は変えない）。
     - 包む位置は、`db.transaction` の外側（コールバックの中の `tx.execute` の例外も、`transaction` が投げ直すので、外側で1回掛かる）。
     - 例外の種類・SQLSTATE・`cause` の連鎖は変わらない。`OutboxLeaseConflictError`（DB の例外ではない）は、包みの外で投げるので変わらない。
  2. **新しい export は足さない。** `omit-params.ts` は内部のまま。
  3. **変えないもの**: `DrizzleQueryError` の `params` プロパティ（値の配列）と、`cause` の pg エラーの `message`・`detail`（ADR 0504・0423）。
  4. **`PostgresMemoryStore`・`PostgresRelationStore` は、このPRでは直さない**（口が多い。下の負債）。
  5. 断る入力は増えない。例外の種類・SQLSTATE も変わらず、変わるのは message の `params:` 以降の文字列だけ。🔴 ではない。

- **検討した代替案**:
  1. **`Db` を包んで全 store に一括で掛ける**（ADR 0504 の代替案2）。採らなかった。理由は ADR 0504 のとおり。
  2. **`PostgresTenantSettingsStore` を含めない。** 採らなかった。口は14だが、どれも `this.db.execute(...)` 1本の呼びで、機械的に包めて、歯も1本のループで全部を見られる。
  3. **`PostgresMemoryStore`・`PostgresRelationStore` まで一度に包む。** 採らなかった（依頼の範囲外。口が多く、差分の大半が機械的な包みになる）。

- **引き受けた負債**:
  - `PostgresMemoryStore`（書き込み・読み取りの全口）・`PostgresRelationStore`（`link`・`unlink`・`listRelated*`）・`PostgresEventStore.get`・`list` の直接呼びは、params 入りの message が残る（ADR 0504 の表のまま）。
  - 包みは口ごとの手作業で、**新しく足した口に包みを付け忘れても、型でも lint でも気づけない**。歯は今ある口を見るだけ（ADR 0504 の代替案2の一括が本命）。
  - `PostgresTenantSettingsStore` の歯は、入口の検査を通る入力では DB が拒まないため、トランザクションの中で `search_path` を空にして `tenant_settings` を見えなくする（42P01）形で例外を起こす。**実運用で起きる拒まれ方（タイムアウト・接続断など）そのものではない**。
  - `PostgresOutboxStore.raiseIfLeaseConflict`（読み直しの SELECT）は、本物の DB では単独で落とせないので、drizzle 形の例外を投げる db で見た。
  - ADR 0504 の負債のまま: core の `omitParamsFromError` と `omit-params.ts` は複製。`DrizzleQueryError.params` プロパティは残る。

- **これが覆るとしたら**:
  - 全 store を一括で直す方針（ADR 0504 の代替案2、または公開の export）に変わったとき。この PR の口ごとの包みは、その層に吸収されて不要になる。
  - `DrizzleQueryError` の `params` プロパティまで消す判断が出たとき。core と同時に変える。

- **測ったこと**（【実測】2026-10-02。歯を先に走らせて赤を見てから直した）:
  - 歯: `packages/postgres/src/__tests__/error-message-omits-params.postgres.test.ts` に3つの `describe` を足した（既存14本に24本）。
    - trigram `search`: `filter.attributes` の孤立サロゲート（22P02）。
    - outbox: `LIMIT` に負の数（2201W。`claimBatch`・`eraseTenant` の2経路・`purgeCompletedJobs` の2経路）、`attempts` に int4 を超える数（22003。`complete`・`fail`）、`raiseIfLeaseConflict`（drizzle 形の例外を投げる db）。
    - tenant settings: 14の口すべて（`search_path` を空にした tx の `tenant_settings` が見えない。42P01）。
    - どれも、例外の連鎖の message・stack に params の目印が無いこと、SQL の文と落とした印は残ること、SQLSTATE が残ることを見る。正常な呼び出しが結果を返すことも1本。
  - **直す前: 新しい24本のうち23本が赤**（正常な呼び出しの1本は緑）。**直した後: 38本（既存14本＋24本）とも緑**（UTF8）。
  - SQL_ASCII（`--encoding=SQL_ASCII --locale=C`）でも同じファイルは38本とも緑。ただし trigram の1本は、この leg では `create()` が拒む（ADR 0319）ので、本体を見ずに戻る。
  - 同じ store の既存の歯（`outbox-*`・`tenant-settings-*`・`trigram-lexical-store.postgres`・`trigram-lexical-store.conformance`）も緑（UTF8。`outbox-fail-nul-last-error`・`trigram-lexical-store.postgres` と、`outbox-*`・`tenant-settings-*`・`trigram-lexical-store.conformance` の名で束ねた11ファイル75本）。
  - **変異（足りない側）**: 包みを1つずつ外す（trigram 1、outbox 8、tenant settings の最初・9番目・最後）→ いずれも1本だけ赤。戻して緑。
  - **測っていないこと**: やりすぎ側の変異（`message` を空にする・`cause` を切る）は、同じ `omittingParams` を ADR 0504・0505 の歯が見ているので、今回は走らせていない。`complete`・`fail` の `OutboxLeaseConflictError` が包みの影響を受けないことの専用の歯は足していない（既存の `outbox-*` の歯が緑なのは確認）。
