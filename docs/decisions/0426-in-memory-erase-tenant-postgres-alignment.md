# ADR 0426: testkit のインメモリ `eraseTenant` を Postgres 実装に揃える（`tenant_subject_activity` の行数と、埋め込みの CASCADE）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローンの委譲先（マネージャー mgr-0629e6a2）が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  [ADR 0383](./0383-erase-tenant.md) の `eraseTenant` について、`@mnemora/testkit` のインメモリ実装が `@mnemora/postgres` の実装と2点ずれていた。
  [PR #1526](https://github.com/takecchi/mnemora/pull/1526) の作業中に別の担当（mgr-de7135da）が見つけ、同 PR の ADR 0383 追記の「報告に留めたこと」に記録していた。

  1. `InMemoryMemoryStore.eraseTenant` は `tenant_subject_activity` を、テナントあたり1行として数えていた（`Map<tenantId, Map<subjectId, seq>>` の外側のキー1つを1行とする単純化）。
     Postgres の `tenant_subject_activity` は `(tenant_id, subject_id)` が主キーで、`eraseTenantBody` の手順9は subject ごとの行を `LIMIT` の budget の範囲で消し、その行数を数える。
     subject が3つあるテナントで、インメモリは `deleted` を2少なく返し、`limit` の途中で止まる回でも subject のカウンタを全部まとめて消していた。
  2. Postgres の `memory_embeddings_<space>.memory_id` は `memories(id) ON DELETE CASCADE`（`packages/postgres/src/vector-space.ts`）で、`memories` の行を消すと埋め込みも同じ文で消える。
     `InMemoryVectorStore` にはこれに当たる動きが無く、`InMemoryMemoryStore.eraseTenant` が `memories` を消しても埋め込みが残った。
     そのため core の `eraseTenant` を通したとき、インメモリの組では本番でも `deleted.vectorStore` が実数になり、Postgres（本番では `0`）と違っていた。
     Postgres が `memories` の行を消す経路は `eraseTenant` だけである（`purgeMemory` は行を消さず墓石に更新する）。

  Postgres 実装を正とし、インメモリ実装の側を直した。

- **決めたこと**:

  1. **`tenant_subject_activity` は、内側の `Map<subjectId, seq>` の1エントリを1行として数える。**他の表と同じ `drainMap` で budget の範囲だけ消し、内側の `Map` が空になったら外側のキーも消す。
  2. **`InMemoryMemoryStore` に、`memories` の行が消えたことを知らせる `onMemoriesDeleted(listener)` を足した。**`InMemoryVectorStore` はコンストラクタでここに登録し、知らされた memory の埋め込みを全 space から消す。
     `eraseTenant` は `memories` を消した後（`dryRun` ではないときだけ）、実際に消えた id を渡して listener を呼ぶ。
     CASCADE で消えた Postgres の行と同じく、消えた埋め込みは budget にも `deleted` にも数えない。
     `InMemoryVectorStore` はもともと `InMemoryMemoryStore` を必須のコンストラクタ引数に取っている（ADR 0034）ので、組の作り方は変わらない。
  3. **歯は testkit のインメモリ実装自身のテスト（`packages/testkit/src/__tests__/in-memory-erase-tenant-postgres-alignment.test.ts`）に置いた。**`*-conformance.ts` には要件を足していない（自前の adapter に課す約束は増えていない）。
  4. **公開 API の変化は、`InMemoryMemoryStore` への public メソッド `onMemoriesDeleted` の追加1つである。**既存の呼び出しは壊れないので、非破壊と数えた（`scripts/__snapshots__/public-api/testkit.d.ts` を更新した）。

- **検討した代替案**:

  1. **`InMemoryVectorStore` が、読むたびに「対応する memory が無い埋め込み」を捨てる（遅延の掃除）。** 採らなかった。`search`・`getVectors`・`eraseTenant`・`delete` など、埋め込みを読むすべての口に掃除を入れる必要があり、入れ忘れた口だけ古い埋め込みが見える。消えた時点で消すほうが CASCADE に近く、漏れる口が無い。
  2. **埋め込みの `Map` を `InMemoryMemoryStore` に持たせ、`InMemoryVectorStore` と参照を共有する（`outboxJobs` と同じ形）。** 採らなかった。埋め込みの持ち主が `InMemoryVectorStore` から移るので、変更がこの2点のずれより大きくなる。
  3. **conformance suite に「`memories` を消したら埋め込みも消える」要件を足す。** 採らなかった。自前の adapter に新しい約束を課すことになり、オーナーの判断に当たる。今回の目的はインメモリ実装を Postgres に揃えることだけである。

- **引き受けた負債**:

  - `onMemoriesDeleted` は `eraseTenant` の中からしか呼ばれない。今後インメモリ実装に `memories` の行を消す経路が増えたら、そこでも呼ぶ必要がある。今のところ、消し忘れを検出する歯は無い。
  - `eraseTenant` の `memories` の手順が `limit` で途中に止まっても、冪等キー（`extractionIndex`）はそのテナントの分がすべて消える（前からの振る舞い）。今回は直していない。

- **これが覆るとしたら**:

  オーナーが「埋め込みも memories と一緒に消える」ことを conformance の約束にすると決めたら、その要件は conformance suite に移り、インメモリ実装はその一例として検査されることになる。

- **測ったこと**:

  - 歯（5本）を直す前の main（`e5c5be0`）に当てると、5本中4本が赤だった。subject 3つで `deleted` が期待の 6 ではなく 4、`limit: 5` で期待の 5 ではなく 4、`limit: 2` で memories を2行消したのに埋め込みが3件残った、core の `eraseTenant` で本番の `deleted.vectorStore` が 0 ではなく 2。`dryRun` の1本は直す前から緑。
  - 直した後は5本とも緑。`packages/testkit/src/__tests__/` の74ファイル（ファイル名を指定して実行）もすべて緑。
  - **測っていないこと**: Postgres 側の数え方は、コード（`eraseTenantBody` の手順9と `vector-space.ts` の DDL）と、PR #1526 の ADR 0383 追記にある実測で確かめただけで、この PR では Postgres を立てて走らせていない。
