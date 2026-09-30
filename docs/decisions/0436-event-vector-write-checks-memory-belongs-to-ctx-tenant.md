# ADR 0436: `EventStore.append`・`VectorStore.upsert` は、入口で記憶が `ctx` のテナントに属することを確かめる（複合外部キーの migration は入れない）

- **状態**: 採用 (2026-10)

- **文脈**:

  `PostgresEventStore.append` と `PostgresVectorStore.upsert` は、`memoryId` の記憶が `ctx.tenantId` のものかを確かめなかった。
  `memory_events.memory_id`・`memory_embeddings_<space>.memory_id` の外部キーは `memories(id)` だけで `tenant_id` を含まないので、
  **別テナントの記憶 id を指す行が、`ctx.tenantId` の行として書けた**（[Issue #1051](https://github.com/takecchi/mnemora/issues/1051) が
  「今の振る舞い」として `docs/memory-model.md` §5 に書いて閉じた穴）。実装ごとの振る舞いは次のとおりだった。

  | 実装                                       | 別テナントの記憶を指す                    | 存在しない uuid              | uuid でない文字列              |
  | ------------------------------------------ | ----------------------------------------- | ---------------------------- | ------------------------------ |
  | `PostgresEventStore`/`PostgresVectorStore` | 受け付けて、`ctx.tenantId` の行として書く | 外部キー違反の生の DB エラー | 型変換エラー（`Failed query`） |
  | `InMemoryEventStore`/`InMemoryVectorStore` | `memory not found for tenant` で拒む      | 同じ                         | 同じ                           |

  #1051 の時点では「読み取り漏洩・書き込み漏洩には繋がらない」と判断していた（読みの口は `ctx.tenantId` で絞り、`Runtime` は
  同じ `ctx` で確かめた id しか渡さない）。**この判断は、`eraseTenant` を見落としていた**。実測したこと（2026-10、手元の Postgres）:

  - tb の ctx で ta の記憶 id を指定して `append` / `upsert` すると、Postgres は成功する（インメモリは `memory not found for tenant` で断る）。
  - tb が ta の記憶 id でイベントを1件積むと、`core.eraseTenant(ta)` は `{ kind: "blocked_by_foreign_reference", count: 1 }` になり、
    **ta は自分の記憶を消せなくなる**（[ADR 0383](./0383-erase-tenant.md)。他テナントの行は書き換えない方針なので、止まる）。
    別のテナントの書き込み1件で、消去の約束が破れる。つまり、公開 API（`EventStore`・`VectorStore`）を直接呼べる利用者が、
    別テナントの消去を妨げられる。

  クローン miku は、[ADR 0398](./0398-relation-store-link-checks-both-ends-belong-to-ctx-tenant.md)（`RelationStore.link`）と
  同じ作法で、入口で確かめる方針を決めた（**クローン miku の決定**。オーナーの判断ではない）。`v1.X.0` では破壊的変更が許される
  （オーナーの回答 ask_human `6911db12` 問6。0398 と同じ根拠）。

- **決めたこと**:

  （ADR 0398 の決定1〜3・5 と同じ形。）

  1. **`append`・`upsert` は、記憶が `ctx.tenantId` の記憶であることを、書く前に確かめる。** 実在しない、または別のテナントの記憶なら、
     **行を書かずに** `memory not found for tenant: <id>` を含むメッセージの `Error` を投げる（接頭辞は `PostgresEventStore:`／
     `PostgresVectorStore:`／`InMemoryEventStore:`／`InMemoryVectorStore:`。`PostgresMemoryStore`・`PostgresRelationStore` の同種の
     例外と同じ形）。「実在しない」と「別のテナントの記憶」は区別しない。
  2. **Postgres は、決定1の確かめと書き込みを1つの SQL 文にする。** `WITH mem AS (SELECT EXISTS (SELECT 1 FROM memories WHERE tenant_id = $ctx AND id = $id) AS ok),
ins AS (INSERT … SELECT … FROM mem WHERE ok [ON CONFLICT …]) SELECT …`。検査と書き込みの間に別の文が挟まらない。
     **戻り値は「書いた行数」ではなく `ok` で見る**——`upsert` は `ON CONFLICT DO UPDATE` で上書きでも1行になり、
     行数と検査の成否が一対一にならないため（`append` は `RETURNING` の行に `ok` を添えて返す）。
  3. **uuid の形でない id は、DB へ投げる前に弾く**（`isUuidLike`、`packages/postgres/src/mapping.ts`）。DB 由来のエラー
     （`Failed query`・外部キー違反）を利用者に見せない。あわせて、入口で小文字にそろえる（`normalizeUuidCase`。大文字の uuid は
     自テナントの同じ記憶として通る）。
  4. **`append` は `memoryId` が `null` のイベント（`events_purged`）を決定1の検査の対象にしない。** 記憶を指さないので、確かめる対象が無い
     （`NewMemoryEvent.memoryId` の型と `0001_init.sql` の CHECK、既存の契約どおり）。SQL も従来の単文の INSERT のまま。
  5. **インメモリは、既に断っていた。** `InMemoryEventStore`・`InMemoryVectorStore` は `ctx` のテナントで記憶を引いて断っており、
     message の形も `…: memory not found for tenant: <id>` で Postgres と揃っている（変更なし）。core の `FakeEventStore`・
     `FakeVectorStore` は、存在だけを見ていた（`memory not found: <id>`）ので、テナントも見て、message を揃えた。
  6. **`EventStore.append`・`VectorStore.upsert` の TSDoc に、投げる場合を書いた。** Issue #1051 の「検査しない」の節は、
     「ADR 0436 より前は違った」という履歴の形に書き換えた。`docs/memory-model.md` §5 の 2026-09-27 追記（#1051 の表）は
     **当時の記録なので本文を書き換えず**、2行が変わったことを追記した。
  7. **適合テストに別テナントのケースを足した**（ADR 0398 の決定5と同じ扱い）。`describeEventStoreConformance`・
     `describeVectorStoreConformance` に、別テナントの記憶・存在しない uuid・uuid でない id を指す呼び出しが
     `memory not found for tenant` で拒まれ、行が書かれないこと、拒んだ後も自テナントの正しい記憶になら積める（断りすぎない）ことを見る `it` を足した。
     別テナントの記憶は、既存の `prepareMemoryId(ctx)` を別の `ctx` で呼んで用意する（新しい option は足していない）。
     **自前の adapter を適合テストに当てている利用者は、フラグ無しで走るこれらの `it` が新しく落ちうる**（破壊的変更として数える。下記）。
     ⚠ 適合テストの側から見えるのは、store の口（`list`・`search`）までである。**別テナントの行が実際に書かれていないこと**と、
     `eraseTenant` が止められないことは、`packages/postgres/src/__tests__/event-vector-tenant-check.postgres.test.ts` が生 SQL で数えて縛る。

- **複合外部キーの migration を入れない理由**: 0398 と同じ。入口の検査で足りるかは、書き込み口の数で決まる。

  1. **⚠ 0398 と違い、書き込み口は「入口の2つだけ」と言い切れない。** `memory_events` への INSERT は、`PostgresEventStore.append` のほかに
     `PostgresMemoryStore` の中に複数在る（`grep -n "INSERT INTO memory_events" packages/postgres/src` で、この PR の時点で
     `memory-store.ts` に11箇所。`updateStatusWithEvent`・`supersedeWithNewMemories`・`purgeMemory`・`markContested*` などが、自分の
     トランザクションの中で書く）。これらは記憶の更新と同じトランザクションの中で書くので、対象の記憶は `ctx` のテナントで引いた
     ものであるはずだが、**この PR は11箇所を1つずつは確かめていない**（`EventStore.append` と `VectorStore.upsert` の2つの公開の口だけを直した。
     `MemoryStore` の口は別テナントの id を「memory not found」で断る契約が既に在り、適合テストが縛っている）。
     `memory_embeddings_<space>` へ書く利用者向けの口は `PostgresVectorStore.upsert` だけである（`scale-bench` などの計測用の一括投入は
     利用者の経路ではない）。
  2. **1文の INSERT に窓が無い**（0398 の理由2と同じ。`memories.tenant_id` を書き換える経路は無く、記憶が消えたときは外部キーが止める）。
  3. **複合外部キーは DB を触る migration になる**（`memories` に `UNIQUE (tenant_id, id)`、2種の表の外部キーの張り替え。
     空間ごとの表は利用者が `registerEmbeddingSpace` で作るので、既存の全空間へ遡る必要がある）。既存の食い違う行があると
     張り替えは失敗する（下の検出 SQL）。この PR の大きさを超える。
  4. **入口の検査は、複合外部キーと排他ではない。** 将来入れても、この変更は妨げない。

- **既に書かれてしまった別テナントの行は、遡って消さない。**

  修正前の `append`・`upsert` は、別テナントの記憶を指す行を書けた。**そのような行が、既に書かれているかどうかは確かめていない**
  （`Runtime` は同じ `ctx` で確かめた id しか渡さないので、通常の経路では作られない。利用者が `EventStore.append`・`VectorStore.upsert`
  を直接呼んだ場合にだけ、あり得る）。**データの書き換え（消す・付け替える）はオーナーの領分なので、この PR は行わない。**
  次の SQL が、行の `tenant_id` と指す記憶の `tenant_id` が食い違う行を一覧にする（読み取りだけ。1行も出なければ、食い違う行は無い）:

  ```sql
  -- memory_events（memory_id が NULL の行は、記憶を指さないので対象外）
  SELECT e.id, e.tenant_id, e.memory_id, m.tenant_id AS memory_tenant_id
  FROM memory_events e
  JOIN memories m ON m.id = e.memory_id
  WHERE e.tenant_id <> m.tenant_id;

  -- memory_embeddings_<space>（空間ごとに1本の表。表の名前を列挙して、上と同じ形の SELECT を組み立てる）
  SELECT string_agg(
    format('SELECT %L AS embedding_table, e.tenant_id, e.memory_id, m.tenant_id AS memory_tenant_id FROM %I e JOIN memories m ON m.id = e.memory_id WHERE e.tenant_id <> m.tenant_id', c.relname, c.relname),
    E'\nUNION ALL\n')
  FROM pg_class c
  WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace AND starts_with(c.relname, 'memory_embeddings_');
  -- ↑ 出力された文を実行する。1つの空間に絞るなら、表の名前を直接書いた SELECT でよい。
  ```

  手元の使い捨ての Postgres で、食い違いが無いときに各 SELECT が0行になること、`memory_events` と `memory_embeddings_<space>` に
  食い違う行を1本ずつ仕込んだときに、それぞれ1行を数えることを確かめた（2026-10。使い捨ての DB は確認後に消した）。
  `event-vector-tenant-check.postgres.test.ts` の最後の `describe` も、同じ SELECT（表名を直接書く形）を実行して縛っている。

  **行が出た場合**: この ADR では決めない。**オーナーの判断が要る**（消す・残す・付け替える、のどれも、利用者のデータの書き換えである）。
  参考までに、食い違う行は2通りの害を持つ。(a) 指された記憶のテナントの `eraseTenant` を `blocked_by_foreign_reference` で止める
  （消去には、その行を先に消すしか無い）。(b) 書いたテナント側の行は、`memories` と突き合わせる読みの口（`search` など）には出ないが、
  書いたテナントの `eraseTenant` は、その行を**自分のテナントの行として**消す。

- **検討した代替案**:

  - **複合外部キーだけで守る（入口の検査を入れない）。** 採らない（0398 と同じ。生の DB エラーが利用者に見える）。
  - **入口の検査 + 複合外部キー。** 採らない（今回は。上の理由3）。
  - **検査を SELECT と INSERT の2文にする。** 採らない（0398 と同じ。窓を自分で管理することになる）。
  - **#1051 の「検査しない」を据え置き、`eraseTenant` 側で別テナントの行を消す。** 採らない。ADR 0383 は「他テナントの行は書き換えない」と
    決めており、それを破る。根を断つほうが小さい。
  - **`append`・`upsert` が投げず、別テナントなら黙って何もしない。** 採らない。`MemoryStore` の口は「無ければ投げる」で揃っており、
    0398 もそれに揃えた。黙って捨てると、書いたつもりのイベント（監査ログ）が無いことに気づけない。

- **引き受けた負債**:

  - **破壊的変更である。** これまで通っていた（別テナントの記憶・実在しない id を指す）`append`・`upsert` が、Postgres では投げるようになる
    （実在しない uuid は以前も外部キー違反で落ちたので、message と型だけが変わる）。`CHANGELOG.md` の `[1.2.0]` 節 `### Breaking` と
    `docs/migration-v1.md` の項目49に書いた。自前の `EventStore`・`VectorStore` を適合テストに当てている利用者は、新しい `it` が落ちうる。
  - **既に書かれた食い違う行は、そのまま残る。** 検出 SQL は上にある。消すかどうかはオーナーの判断。
  - **DB の制約としては、まだ守られていない。** 書き込み口が増えたとき、検査を忘れると破れる。特に `PostgresMemoryStore` の中の
    `memory_events` への INSERT 11箇所は、この PR で1つずつ確かめていない（上の「複合外部キーの migration を入れない理由」の1）。
  - **検査と INSERT の間に、並行して記憶が消えた場合**は、外部キー違反の生のエラーのまま（0398 と同じ。`eraseTenant` との同時実行は実測していない）。
  - **`VectorStore.upsert` の `memoryId` は、未登録の埋め込み空間では、uuid の形でなければ先に `memory not found for tenant` になる**
    （空間の引きより前に id を弾くため。`EmbeddingSpaceNotRegisteredError` になるのは、id が uuid の形のときだけ）。
  - **今回塞がない、同じ種類の残りの口**（記憶や観測の id が `ctx` のテナントに属するかを確かめていない疑いがある口）。
    **この PR では直していない**。コードを読んだ事実だけを書く（この PR の時点の `packages/postgres/src/memory-store.ts`。実行して確かめたものではない）:
    - `MemoryStore.recordUsage`（`recordUsageAndReinforce` の中の記録も同じ）の `memoryIds`・`recallId`: `recall_usages` へ
      `tenant_id = ctx.tenantId` で INSERT するが、`recallId`・`memoryIds` が `ctx` のテナントのものかは INSERT では確かめていない
      （外部キーは `recalls(id)`・`memories(id)` だけ）。`recordUsageAndReinforce` は、強化の段で `memoryIds` を `ctx` のテナントで引いて
      「memory not found」になり、記録ごとロールバックする（`docs/memory-model.md` の使用報告の節）。**`recordUsage` 単独の口は確かめていない。**
    - `sourceObservationId`（`createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`）: 入力の値をそのまま
      `source_observation_id` に書く。観測が `ctx` のテナントのものかは確かめていない（外部キーは `observations(id)` だけ）。
    - `contestedWithId`・`supersededById`（閉じた [Issue #854](https://github.com/takecchi/mnemora/issues/854) で一度扱われた。
      記録は `docs/memory-model.md` §5 の 2026-09-26 追記で、**「検査しない。ただし読み書きの漏洩には繋がらない」と書いて閉じた**）:
      - `createMemory` 系・`supersedeWithNewMemories` の新しい行の `supersededById`・`contestedWithId`: 入力の値をそのまま書く。
        `status: "contested"` で `contestedWithId` が無いことは `ContestedWithoutCompanionError` で断るが、id が `ctx` のテナントかは確かめない。
      - `updateStatus`・`updateStatusWithEvent` の `opts.supersededById`: `WHERE tenant_id = ctx.tenantId AND id = <対象>` で**対象の行**は絞るが、
        `supersededById` の値（`COALESCE` でそのまま書く）は確かめない。`resolveContestedPair` の各側の `supersededById` も同じ。
      - `markContestedPair`・`resolveContestedPair`: 対の2件は、書く前に `tenant_id = ctx.tenantId` で引いて存在を確かめる（無ければ
        「memory not found」）。つまり、**対の相互参照（`contested_with_id`）は `ctx` のテナントの2件の間でしか書かれない**。
      - `markContestedGroup?`: ADR 0398 が書いたとおり、全員を `ctx.tenantId` で読んでから書く。
    - これらは **PR-1（この ADR）のマージ後に、別の担当が同じ作法（[ADR 0398](./0398-relation-store-link-checks-both-ends-belong-to-ctx-tenant.md)・この ADR。
      入口の検査と書き込みを1つの SQL 文にし、uuid でない id を弾き、適合テストと TSDoc と破壊的変更の記載をそろえる）で塞ぐ予定**である
      （塞ぐ担当・PR 番号は、この ADR を書いた時点では決まっていない）。**塞いだら、この節に追記すること**（口ごとに、PR 番号と ADR 番号を添える）。
      それまでは、`eraseTenant` が `blocked_by_foreign_reference` で止まる経路は、この ADR が塞いだ2つの口（`memory_events`・`memory_embeddings_<space>`）に
      限っては起きないが、**上の口から書かれた別テナントを指す行（`superseded_by_id`・`contested_with_id`・`recall_usages`・`source_observation_id`）では、
      起こりうる**（`superseded_by_id` 以外は、止まるかを確かめていない。ADR 0383 の検査がどの参照を数えるかは、この PR では確かめ直していない。確かめたのは `erase-tenant.postgres.test.ts` の `superseded_by_id` の歯で、
      `blocked_by_foreign_reference` の1例を、生 SQL で作って縛っている）。

- **これが覆るとしたら**:

  - 0398 の「覆る条件」と同じく、書き込み口が増えたとき、または口ごとの検査を確かめる負担が大きくなったとき——複合外部キーを入れる。
    **この ADR で `memory_events`・`memory_embeddings_<space>` の2種の表の書き込み口にも、同じ検査を足した**
    （0398 の末尾に追記した）。複合外部キーを入れるときは、検出 SQL が全環境で0行であることを確かめる手順
    （`NOT VALID` で足してから `VALIDATE` など）を用意する。
  - 検出 SQL が実データで行を返したとき——行の扱いを決める別の判断が要る。
  - **上の「今回塞がない、同じ種類の残りの口」を別の担当が塞いだとき**——塞いだ口ごとに、この ADR の「引き受けた負債」の該当の箇条書きへ追記する。
    口が全部塞がったら、`docs/memory-model.md` §5 の 2026-09-26（#854）・2026-09-27（#1051）の「検査しない」の表の残りの行も、
    この ADR の書き方（当時の記録は書き換えず、追記で「もう成り立たない」と書く）で直す。

- **追記（2026-10、[ADR 0439](./0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md)）: 上の「今回塞がない、同じ種類の残りの口」は、ADR 0439 で塞いだ。**
  `MemoryStore.recordUsage`（`recordUsageAndReinforce?` を含む）の `recallId`・`memoryIds`、`createMemory` 系の `sourceObservationId`・`contestedWithId`・`supersededById`、`updateStatus`・`updateStatusWithEvent`・`resolveContestedPair`・`resolveContestedGroup` の `supersededById` が、
  この ADR と同じ作法（入口の検査と書き込みを1つの SQL 文にする、uuid でない id を弾く、適合テスト・TSDoc・破壊的変更の記載をそろえる）で、参照先が `ctx` のテナントの行であることを確かめるようになった。
  上の「`eraseTenant` が `blocked_by_foreign_reference` で止まる経路は、〜起こりうる」の見込みは、ADR 0439 の【実測】で確かめた（`superseded_by_id`・`contested_with_id`・`recall_usages`（memory 側）・`source_observation_id` のどれでも止まった。`recall_usages` が別テナントの recall を指す場合は、さらに指された側の `purgeExpiredRecalls` が外部キー違反で落ちた）。本文は書き換えていない。
