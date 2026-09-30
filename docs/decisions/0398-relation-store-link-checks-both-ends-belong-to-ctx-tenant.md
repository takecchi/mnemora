# ADR 0398: `RelationStore.link` は、入口で両端の記憶が `ctx` のテナントに属することを確かめる（複合外部キーの migration は入れない）

- **状態**: 採用 (2026-09)

- **文脈**:

  `RelationStore.link(ctx, kind, fromId, toId)` は、これまで `fromId`・`toId` が `ctx.tenantId` の記憶かどうかを
  確かめなかった。実装ごとの振る舞いは次のとおりで、どれも `link` の契約（interface の doc）には書かれていなかった。

  | 実装                    | 別テナントの記憶を端に取る                | 存在しない uuid              | uuid でない文字列              |
  | ----------------------- | ----------------------------------------- | ---------------------------- | ------------------------------ |
  | `PostgresRelationStore` | 受け付けて、`ctx.tenantId` の行として書く | 外部キー違反の生の DB エラー | 型変換エラー（`Failed query`） |
  | `InMemoryRelationStore` | 受け付ける                                | 黙って受け付ける             | 黙って受け付ける               |

  `memory_relations`（`0026_memory_relations.sql`）の外部キーは `memories(id)` だけで、`tenant_id` を含まない。
  つまり「行の `tenant_id` と、指す記憶の `tenant_id` が一致する」ことは、スキーマでは守られていなかった。
  runtime は `relationStore.link`/`unlink` を呼ばない（群の書き込みは `MemoryStore.markContestedGroup?` が
  自分のトランザクションの中で直接 SQL を書く）が、`PostgresRelationStore` は公開 API であり、利用者が直接呼べる。

  オーナー代理は、入口で確かめる方針を決めた。`v1.X.0` では破壊的変更が許される（オーナーの回答 ask_human `6911db12` 問6）。

- **決めたこと**:

  1. **`link` は、両端の記憶が `ctx.tenantId` の記憶であることを、書く前に確かめる。** どちらかが実在しない、または
     別のテナントの記憶なら、**行を書かずに** `memory not found for tenant: <id>` を含むメッセージの `Error` を投げる
     （`PostgresMemoryStore` の同種の例外と同じ形。クラス名の接頭辞は `PostgresRelationStore:`／`InMemoryRelationStore:`）。
     「実在しない」と「別のテナントの記憶」は区別しない。
  2. **Postgres は確かめと書き込みを1つの SQL 文にする。** `WITH ends AS (SELECT EXISTS(...) AS from_ok, EXISTS(...) AS to_ok),
ins AS (INSERT ... SELECT ... FROM ends WHERE from_ok AND to_ok ON CONFLICT ... DO NOTHING) SELECT from_ok, to_ok FROM ends`。
     検査と書き込みの間に別の文が挟まらない。**戻り値は「書いた行数」ではなく `from_ok`/`to_ok` で見る**——
     既に同じ行が在って `ON CONFLICT DO NOTHING` が0行になる場合（冪等）と、検査で落ちた場合を、行数では区別できないため。
  3. **uuid の形でない id は、DB へ投げる前に弾く**（`isUuidLike`、`packages/postgres/src/mapping.ts` の doc の作法）。
     DB 由来のエラー（`Failed query`・外部キー違反）を利用者に見せない。
  4. **`InMemoryRelationStore` は、渡された `InMemoryMemoryStore.get(ctx, id)` で確かめる。**
     core の `FakeRelationStore`（テスト用）も、同じ振る舞いに揃える。
  5. **`RelationStore.link` の TSDoc に、投げる場合を書く。** `testkit` の適合テスト（`describeRelationStoreConformance`）が
     この契約を縛る。適合テストは、`prepareMemoryId` が返す記憶を `createStore()` の store から見えるようにすることを求める
     （InMemory の配線は、両者で同じ `InMemoryMemoryStore` を共有する形に変えた）。
  6. **`unlink`・`listRelated` は変えない。** 両方とも `WHERE tenant_id = ctx.tenantId` で絞るので、別のテナントの行は
     読めも消せもしない。「テナントの扱い」としての穴は見つからなかった（次の「確かめたこと」）。
     ただし、uuid でない id を渡したときに生の DB エラーになる点は残っている（下の「引き受けた負債」）。

- **複合外部キーの migration を入れない理由（入口の検査で足りるか）**:

  「行の `tenant_id` と、指す記憶の `tenant_id` の一致」を DB に持たせるなら、`memories` に `UNIQUE (tenant_id, id)` を足し、
  `memory_relations` の外部キーを `(tenant_id, from_memory_id)`/`(tenant_id, to_memory_id)` → `memories(tenant_id, id)` に
  張り替える形になる。今回は入れない。理由は次のとおり。

  1. **書き込みの入口は2つしかなく、どちらも検査を持つ。**
     - `PostgresRelationStore.link`: 上の決定2。
     - `PostgresMemoryStore.markContestedGroup?`: 同じトランザクションの中で、`WHERE tenant_id = ctx.tenantId AND id = ANY(ids) FOR UPDATE`
       で全員を読み、1人でも欠ければ書く前に `memory not found for tenant` を投げる。関係行の INSERT も
       `memories a JOIN memories b ON b.tenant_id = a.tenant_id`、`a.tenant_id = ctx.tenantId` から作る——
       検査済みの ids と `ctx.tenantId` の記憶の組からしか行が出ない。
     - `memory_relations` へ INSERT する箇所は、この2つだけである（`grep -n "INSERT INTO memory_relations" packages/postgres/src`
       で確かめた）。他の書き込み口が増えたときは、このADRの「覆る条件」に当たる。
  2. **1文の INSERT に窓が無い。** 確かめと書き込みは同じ文の中にあり、検査の後に記憶の側が変わっても、記憶の `tenant_id` は
     変わらない（`memories.tenant_id` を書き換える経路が無い）。記憶の行が消えることは、外部キー（`memories(id)`）が
     引き続き INSERT 時に検査する。**確かめの後で記憶が消える**場合も、外部キーが INSERT を止めるので、行は宙に浮かない。
     ⚠ 確かめていないこと: 検査と INSERT のあいだで並行して記憶が消えた場合の、外部キー違反の生のエラーを利用者に
     見せない形にはしていない（`eraseTenant` と `link` の同時実行の実測はしていない）。
  3. **複合外部キーは、DB を触る migration になる。** `memories` に `UNIQUE (tenant_id, id)` を足す（`id` は既に主キーなので、
     索引が1本増える）ことと、`memory_relations` の外部キーの張り替えを要する。張り替えは、既存の行が全部条件を満たす
     ことを前提にするが、**満たさない行が本番に在るかどうかを、この PR は確かめられない**（下の検出 SQL）。
     入れるなら、検出 SQL が0行であることを利用者が確かめてから走らせる手順まで含めて設計する話になり、
     この PR の大きさを超える。
  4. **入口の検査は、複合外部キーと排他ではない。** 今回の変更は、DB の制約を足す将来の migration を妨げない
     （入口で投げるので、制約違反を利用者が見ることも無くなる）。

- **既存のデータに、テナントを跨ぐ行が残っている可能性と、その検出方法**:

  修正前の `PostgresRelationStore.link` は、別テナントの記憶を端に取る行を書けた。**そのような行が、既に書かれているかどうかは
  確かめていない**（runtime は `link` を呼ばず、`markContestedGroup?` は検査済みなので、通常の経路では作られない。
  利用者が `PostgresRelationStore.link` を直接呼んだ場合にだけ、あり得る）。次の SQL が、行の `tenant_id` と端の記憶の
  `tenant_id` が食い違う行を一覧にする（読み取りだけ。1行も出なければ、食い違う行は無い）:

  ```sql
  SELECT r.id, r.tenant_id, r.from_memory_id, r.to_memory_id, r.kind,
         f.tenant_id AS from_tenant_id, t.tenant_id AS to_tenant_id
  FROM memory_relations r
  LEFT JOIN memories f ON f.id = r.from_memory_id
  LEFT JOIN memories t ON t.id = r.to_memory_id
  WHERE f.tenant_id IS DISTINCT FROM r.tenant_id
     OR t.tenant_id IS DISTINCT FROM r.tenant_id;
  ```

  行が出た場合にどうするか（消す・残す）は、この ADR では決めない——利用者のデータの扱いなので、
  検出までをこの PR の範囲とする。この SQL は手元の使い捨ての Postgres で、食い違う行を1本作って検出できること、
  食い違いが無ければ0行になることを確かめた（使い捨ての DB は確認後に消した）。

- **確かめたこと（`unlink`・`listRelated`）**:

  - `unlink`: `DELETE ... WHERE tenant_id = ctx.tenantId AND from = .. AND to = .. AND kind = ..`。別のテナントの行には触れない。
  - `listRelated`: `SELECT ... WHERE tenant_id = ctx.tenantId AND from_memory_id = ..`。別のテナントの行は返さない
    （適合テスト「listRelated は別テナントの ctx では、同じ id を起点にしても関係を返さない」）。
  - 上の検出 SQL に当たる行が既に在っても、この2つの口は `ctx.tenantId` の行しか見ない。

- **検討した代替案**:

  - **複合外部キーだけで守る（入口の検査を入れない）。** 採らない。制約違反は生の DB エラーになり、利用者に見せない
    方針（決定3）と両立しない。InMemory・Fake の振る舞いも揃えられない。
  - **入口の検査 + 複合外部キー。** 採らない（今回は）。上の理由3。
  - **検査を SELECT と INSERT の2文にする。** 採らない。トランザクションを張る必要が出て、`link` が今トランザクション外で
    1文なのに対し、窓を自分で管理することになる。
  - **`link` の戻り値で成否を返す（投げない）。** 採らない。既存の `MemoryStore` の口は「無ければ投げる」で揃っており、
    それに揃える（オーナー代理の決定）。

- **引き受けた負債**:

  - **破壊的変更である。** これまで通っていた（別のテナントの記憶・実在しない id を端に取る）`link` が、投げるようになる。
    `CHANGELOG.md` の `[1.2.0]` 節 `### Breaking` と `docs/migration-v1.md` の項目34に書いた。
    自前の `RelationStore` を conformance suite に当てている利用者は、新しいテストが落ちうる。
  - **`unlink`・`listRelated` に uuid でない id を渡すと、Postgres は生の DB エラーを返す。** `link` の入口の検査は
    足したが、この2つには足していない（テナントの扱いの穴ではなく、エラーの見え方の問題であり、この PR の範囲を広げない）。
    `MemoryStore.get` の「無い == null」の作法に揃えるなら、`listRelated` は空配列、`unlink` は何もしない、になる。
  - **DB の制約としては、まだ守られていない。** 書き込み口が3つ目になったとき、検査を忘れると破れる。

- **これが覆るとしたら**:

  - `memory_relations` へ書く口が3つ目に増えたとき、または書き込み口の検査を1つずつ確かめる負担が大きくなったとき——複合外部キーを入れる。
    そのときの条件: 検出 SQL が全環境で0行であることを利用者が確かめられる手順（migration の前段の検査、または
    `NOT VALID` で外部キーを足してから `VALIDATE`）を用意する。
  - 検出 SQL が実データで行を返したとき——行の扱いを決める別の判断が要る。
