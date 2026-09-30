# ADR 0439: `MemoryStore` の書き込み口は、別の行を指す参照の参照先が `ctx` のテナントの行であることを、書く前に確かめる（複合外部キーの migration は入れない）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（担い手。マネージャーの指示による）が書いた。決めたのはクローンであり、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元（PostgreSQL 17 + pgvector、`initdb` で立てた自分専用のインスタンス）で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  `MemoryStore` の書き込み口のうち、別の行を指す値を受け取るものは、その参照先が `ctx.tenantId` の行かを確かめなかった。外部キー（`recalls(id)`・`memories(id)`・`observations(id)`）は `tenant_id` を含まないので、DB も止めなかった。
  A の `ctx` で B の id を指す行が、A の行として書けた。塞ぐ対象は次の口である。

  - `recordUsage`（`recordUsageAndReinforce?` の中の記録も同じ）の `recallId`・`memoryIds` → `recall_usages`。
  - `createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents?`・`supersedeWithNewMemories?` の `news[i].input` の `sourceObservationId`・`contestedWithId`・`supersededById` → `memories.source_observation_id`・`contested_with_id`・`superseded_by_id`。
  - `updateStatus`・`updateStatusWithEvent` の `opts.supersededById`、`resolveContestedPair?` の各側の `supersededById`、`resolveContestedGroup?` の `members[].supersededById` → `memories.superseded_by_id`。

  **経緯（2つの「検査は足さない」が、なぜ当て直しになったか）。**
  [Issue #854](https://github.com/takecchi/mnemora/issues/854)（`contestedWithId`・`supersededById`）と [Issue #1051](https://github.com/takecchi/mnemora/issues/1051)（`sourceObservationId`・`recordUsage`・`EventStore.append`・`VectorStore.upsert`）は、
  クローンが「`docs/memory-model.md` §5 に今の振る舞いを書いて閉じる。検査は足さない」と決めて閉じた（決めたのはクローンであり、オーナーではない）。根拠は「読み取りの漏洩も書き込みの漏洩も無い」だった
  （ほかのテナントの行は変わらず、読みの口はすべて `ctx.tenantId` で絞る）。
  この根拠は、`eraseTenant` と `purgeExpiredRecalls` を見落としていた。別テナントを指す行は、**指された側のテナントの消去の権利と保持期間の掃除を止める**。
  [ADR 0436](./0436-event-vector-write-checks-memory-belongs-to-ctx-tenant.md) が `EventStore.append`・`VectorStore.upsert` でこれを実測して塞ぎ、残りの口を「別の担当が同じ作法で塞ぐ予定」と書いた。この ADR がその残りである。
  v1.X.0 では破壊的変更が許される（オーナーの回答 ask_human `6911db12` 問6。ADR 0398・0436 と同じ根拠）。

  **測ったこと。**【実測】直す前の実装（この PR の最初の commit）に対して、A の `ctx` で B の id を参照する書き込みを1口ずつ行い、そのあとで B の `purgeExpiredRecalls`（`olderThan` を遠い未来にして全件）と B の `eraseTenant` を撃った。B には記憶1件・recall 1件・observation 1件がある。

  | A の ctx で撃った書き込み                                           | 書き込み | B の `purgeExpiredRecalls`                     | B の `eraseTenant`                        |
  | ------------------------------------------------------------------- | -------- | ---------------------------------------------- | ----------------------------------------- |
  | `recordUsage(A, Bのrecall, [Aのmemory])`                            | 通る     | **生の外部キー違反（SQLSTATE 23503）で落ちる** | `blocked_by_foreign_reference`（count=1） |
  | `recordUsage(A, Aのrecall, [Bのmemory])`                            | 通る     | 通る（1件消す）                                | `blocked_by_foreign_reference`（count=1） |
  | `createMemory` の `sourceObservationId: Bのobservation`             | 通る     | 通る                                           | `blocked_by_foreign_reference`（count=1） |
  | `createMemory` の `status: "contested", contestedWithId: Bのmemory` | 通る     | 通る                                           | `blocked_by_foreign_reference`（count=1） |
  | `createMemory` の `status: "superseded", supersededById: Bのmemory` | 通る     | 通る                                           | `blocked_by_foreign_reference`（count=1） |
  | `updateStatus(A, a1, "superseded", { supersededById: Bのmemory })`  | 通る     | 通る                                           | `blocked_by_foreign_reference`（count=1） |
  | `resolveContestedPair` の `supersededById: Bのmemory`               | 通る     | 通る                                           | `blocked_by_foreign_reference`（count=1） |

  同じ7本を直した実装に撃つと、書き込みはすべて `PostgresMemoryStore: <recall|memory|observation> not found for tenant: <id>` で拒まれ、B の `purgeExpiredRecalls` は通り、B の `eraseTenant` は `executed` になった。
  残りの口（`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories`・`updateStatusWithEvent`・`resolveContestedGroup`・`recordUsageAndReinforce`）は、上の口と同じ検査の部品を共有している。これらは上の表では撃たず、適合テストと個別の歯で、拒まれることを見た（下の「歯」）。

- **決めたこと**:

  （ADR 0398・0436 の決定1〜3・5・7 と同じ形。）

  1. **上の口は、参照先が `ctx.tenantId` の行であることを、書く前に確かめる。** 実在しない、または別のテナントの行なら、**何も書かずに** `Error` を投げる。「実在しない」と「別のテナントの行」は区別しない。
     message の主語は参照先の種類に合わせる: `PostgresMemoryStore: memory not found for tenant: <id>`（`contestedWithId`・`supersededById`・`recordUsage` の `memoryIds`）、
     `PostgresMemoryStore: observation not found for tenant: <id>`（`sourceObservationId`）、`PostgresMemoryStore: recall not found for tenant: <id>`（`recordUsage` の `recallId`）。
     testkit の `InMemoryMemoryStore` は接頭辞が `InMemoryMemoryStore:`、core の `FakeMemoryStore` は `FakeMemoryStore:` である。`null`・`undefined` は「参照しない」。
  2. **Postgres は、確かめと書き込みを1つの SQL 文にする。**
     - `memories` の INSERT は、`WITH chk AS (SELECT <EXISTS …> AS ref_source_ok, … ), ins AS (INSERT … SELECT … FROM chk WHERE chk.ref_source_ok AND … ON CONFLICT … DO NOTHING RETURNING *) SELECT chk.*, ins.* FROM chk LEFT JOIN ins ON TRUE`。
       `ON CONFLICT DO NOTHING` の「書かなかった」と検査の「拒んだ」は、どちらも挿入が0行になる。区別は戻り値の `ref_*_ok` で見る（ADR 0436 決定2と同じ）。
       4つの口のために3箇所に写されていた INSERT を、1つの関数（`insertMemoryRow`）にまとめた。
     - `recall_usages` の INSERT は、`recall_ok` と「`ctx` のテナントに無い最初の `memoryId`」を `chk` で出し、どちらかが満たされなければ0行にする。1件でも違えば全体を書かない。
     - `updateStatus`・`updateStatusWithEvent`・`resolveContestedPair` の UPDATE は、`WHERE` に同じ述語（`refExists`）を足す。`resolveContestedGroup` の `UPDATE … FROM unnest(…)` も同じ。
       0行だったときの切り分け（対象の行が無い・参照先が `ctx` の行でない・`expectedStatus` が違う）は、読み直しの SELECT で、この順に行う。
  3. **uuid の形でない id は、DB へ投げる前に弾く**（`isUuidLike`、message は上と同じ）。大文字の uuid は小文字にそろえ、自テナントの同じ行として通す（ADR 0436 決定3と同じ）。
     **空文字は参照として扱う**（uuid の形でないので弾く。`empty-string-references` の既存の契約どおり）。
  4. **冪等の衝突で既存の行を返す `createMemory*` にも、検査は当たる。** 検査が INSERT と同じ文の中にあるので、`ON CONFLICT` より前に見る。testkit の `InMemoryMemoryStore` も、冪等の判定より前に検査する位置へ動かした。
  5. **検査しない（NULL を書くだけ・自分の行だけを指す）文。** 下の表のとおり、`contested_with_id = NULL` などの NULL 書き、`markContestedPair` の相互参照（2件とも `tenant_id = ctx` で `FOR UPDATE` して存在を確かめてから書く）、`supersedeWithNewMemories` の `superseded_by_id = anchorId`（同じ呼び出しの `news` の結果の行の id で、呼び出し側の入力ではない）は、値が呼び出し側から来ないので検査を足さない。
  6. **testkit の `InMemoryMemoryStore` と core の `FakeMemoryStore` を揃えた。** 参照先の存在だけを見ていたものを、テナントも見る形にし、message を `… not found for tenant: <id>` にそろえた（以前は `source observation not found`・`superseded-by memory not found`・`contested-with memory not found`・`recall not found`・`memory not found`）。
     `FakeMemoryStore` は空文字を「参照しない」として扱う従来の非対称を残した（既存の core のテストがそれに依っている）。
  7. **TSDoc と `docs/memory-model.md` を直した。** `MemoryStore` の TSDoc の「テナント一致を検査しない」の注記（`isContestedWithoutCompanion`・`createMemory`・`createMemoryWithOutbox`・`updateStatus`・`updateStatusWithEvent`・`recordUsage`・`supersedeWithNewMemories`・`resolveContestedPair`・`resolveContestedGroup`・`purgeExpiredRecalls`・`eraseTenant`）を、今の振る舞いに合わせた。
     `docs/memory-model.md` §5 の 2026-09-26（#854）・2026-09-27（#1051）の節は、**当時の記録なので本文を書き換えず**、それぞれの後ろに「もう今の振る舞いではない」と書く追記を足した（既存の ADR 0436 の追記と同じ作法）。§2 に、`sourceObservationId` が同じテナントの Observation を指すことの追記を1つ足した。§6 の使用報告の節の「強化の段で memory not found」の文は、記録の段で拒まれる形に直した。
  8. **適合テストに別テナントのケースを足した**（ADR 0398 決定5・0436 決定7と同じ扱い）。`describeMemoryStoreConformance` に、別テナントの recall・memory・observation を指す呼び出しが拒まれ、何も書かれず、拒んだ後も自テナントの正しい参照なら書けること（断りすぎを防ぐ）を見る `it` を9本足した
     （`recordUsage`・`recordUsageAndReinforce?`・`createMemory`/`createMemoryWithOutbox`・`updateStatus`/`updateStatusWithEvent`・実在しない uuid と uuid でない id・`supersedeWithNewMemories?`・`createMemoriesWithOutboxAndEvents?`・`resolveContestedPair?`・`resolveContestedGroup?`）。
     任意メソッドの `it` は、既存の `supportsXxx` のフラグの下に置いた（新しいオプションは足していない）。別テナントの行は、既存の `prepareRecallId(ctx)` と `createMemory`・`createObservation` を別の `ctx` で呼んで用意する。
     **自前の adapter を適合テストに当てている利用者は、フラグ無しで走るこれらの `it` が新しく落ちうる**（破壊的変更として数える。`CHANGELOG.md` `[1.2.0]` の `### Breaking` と `docs/migration-v1.md` の項目51）。
  9. **既存の適合テスト2本の仕込みを変えた。** `restoreSupersededBy は別テナントの行を巻き込まない`・`previewRestoreSupersededBy は別テナントの行を巻き込まない` は、A の anchor を `supersededById` に持つ B の行を API で作っていた。その形は API で書けなくなったので、B 自身の anchor を指す行に変えた。
     **この2本の適合テストが縛る強さは下がった**（B の行が A の anchor を指さないので、`restoreSupersededBy` の `tenant_id` の絞りを外しても、適合テストは赤にならない）。代わりに、その形（B の行が A の anchor を指す）を生 SQL で仕込む歯を、`packages/postgres` の個別のテスト（下）に置いた。
     `foreign-key-violation.postgres.test.ts` は、実在しない `recallId` の `recordUsage` が、外部キー違反（23503）ではなく `recall not found for tenant` で拒まれるように変えた。外部キーが今も効いていることは、生 SQL の INSERT で 23503 を当てる形で残した。

- **複合外部キーの migration を入れない理由**: ADR 0398・0436 と同じ。

  1. **入口の検査は、複合外部キーと排他ではない。** 将来入れても、この変更は妨げない。
  2. **複合外部キーは DB を触る migration になる**（`memories` に `UNIQUE (tenant_id, id)`、`observations`・`recalls` にも同じ、4本の外部キーの張り替え）。既存の食い違う行があると張り替えは失敗する（下の検出 SQL）。この PR の大きさを超える。
  3. **1文の INSERT・UPDATE に窓が無い。** `memories.tenant_id`・`observations.tenant_id`・`recalls.tenant_id` を書き換える経路は無く、参照先が消えたときは外部キーが止める。

- **`packages/postgres/src/memory-store.ts` で、対象の列に値を書く文を全部数えた表**

  【現物】`grep -n "source_observation_id\|contested_with_id\|superseded_by_id\|recall_usages" packages/postgres/src/memory-store.ts` の全件（この PR の最終の commit。行番号は `main` が動けば変わる）を、書く文・読む文・消す文に分けた。**参照の値を書く文は8本**（うち6本は、この PR が検査する。1本は既存の検査、1本は検査が要らない）、NULL だけを書く文は4本、ほかは SELECT・DELETE・衝突時の検索である。

  | 口                                                                                                                                       | file:line                                                                | 書く欄                                                           | 入口で確かめているか                                                                                                                           |
  | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
  | `insertMemoryRow`（`createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の `news`） | `memory-store.ts:352-383`（INSERT の列、`chk` の述語は `:344-349` 付近） | `source_observation_id`・`superseded_by_id`・`contested_with_id` | **確かめる**（1文。`ref_source_ok`・`ref_superseded_ok`・`ref_contested_ok`）。以前は同じ INSERT が3箇所に写されていて、どれも確かめなかった   |
  | `updateStatus` の UPDATE                                                                                                                 | `:1062`                                                                  | `superseded_by_id`                                               | **確かめる**（`WHERE` に `refExists`）                                                                                                         |
  | `updateStatusWithEvent` の UPDATE                                                                                                        | `:1122`                                                                  | `superseded_by_id`                                               | **確かめる**（同上）                                                                                                                           |
  | `supersedeWithNewMemories` の `supersede` の UPDATE                                                                                      | `:1330`                                                                  | `superseded_by_id = anchorId`                                    | 確かめない。値は同じ呼び出しの `news` の結果の行の id（`ctx` のテナントの行）で、呼び出し側の入力ではない                                      |
  | `recordUsageOn` の INSERT（`recordUsage`・`recordUsageAndReinforce`）                                                                    | `:2076`                                                                  | `recall_usages.recall_id`・`memory_id`                           | **確かめる**（1文。`recall_ok`・`missing_memory_id`）                                                                                          |
  | `markContestedPair` の UPDATE                                                                                                            | `:3205`                                                                  | `contested_with_id = oppositeId`                                 | 既存の検査。2件とも `tenant_id = ctx` で `FOR UPDATE` して存在を確かめ、無ければ `memory not found` を投げてから書く（この PR で変えていない） |
  | `resolveContestedPair` の UPDATE                                                                                                         | `:3534`                                                                  | `superseded_by_id`（`contested_with_id = NULL` も）              | **確かめる**（`WHERE` に `refExists`）                                                                                                         |
  | `resolveContestedGroup` の UPDATE                                                                                                        | `:3908`（`:3916` が述語）                                                | `superseded_by_id`（`contested_with_id = NULL` も）              | **確かめる**（同上。0行のとき、ロック済みなので原因は参照先だけで、先に名指しする）                                                            |
  | `markContestedGroup`・`resolveOrphanedContested`・`restoreSupersededBy`・`eraseTenant` の UPDATE                                         | `:3616`・`:3728`・`:4061`・`:4390`                                       | `contested_with_id = NULL`・`superseded_by_id = NULL`            | 対象外（NULL を書くだけで、参照を作らない）                                                                                                    |

  ほかに `memory-store.ts` の外で対象の列に書く場所は無い（`grep` で `bench/` を含めて確かめた。`schema.ts`・`mapping.ts` は定義と読み取りだけ）。`memory_events` への INSERT 11箇所は、ADR 0436 が「1つずつは確かめていない」と書いた対象で、この PR の対象（`memory_events.memory_id`）ではない。

- **既に書かれてしまった別テナントの行は、遡って消さない。**

  修正前の口は、別テナントを指す行を書けた。**そのような行が、既に書かれているかどうかは確かめていない**（`Runtime` は同じ `ctx` で確かめた id しか渡さないので、通常の経路では作られない。利用者が `MemoryStore` を直接呼んだ場合にだけ、あり得る）。
  **データの書き換え（消す・付け替える）はオーナーの領分なので、この PR は行わない。** 次の4本の SELECT が、行の `tenant_id` と指す先の `tenant_id` が食い違う行を一覧にする（読み取りだけ。1行も出なければ、食い違う行は無い）:

  ```sql
  -- recall_usages（指す recall か memory のテナントが、行の tenant_id と違う）
  SELECT u.tenant_id, u.recall_id, u.memory_id, r.tenant_id AS recall_tenant_id, m.tenant_id AS memory_tenant_id
  FROM recall_usages u
  JOIN recalls r ON r.id = u.recall_id
  JOIN memories m ON m.id = u.memory_id
  WHERE u.tenant_id <> r.tenant_id OR u.tenant_id <> m.tenant_id;

  -- memories.source_observation_id
  SELECT m.id, m.tenant_id, m.source_observation_id, o.tenant_id AS observation_tenant_id
  FROM memories m
  JOIN observations o ON o.id = m.source_observation_id
  WHERE m.tenant_id <> o.tenant_id;

  -- memories.contested_with_id
  SELECT m.id, m.tenant_id, m.contested_with_id, t.tenant_id AS target_tenant_id
  FROM memories m
  JOIN memories t ON t.id = m.contested_with_id
  WHERE m.tenant_id <> t.tenant_id;

  -- memories.superseded_by_id
  SELECT m.id, m.tenant_id, m.superseded_by_id, t.tenant_id AS target_tenant_id
  FROM memories m
  JOIN memories t ON t.id = m.superseded_by_id
  WHERE m.tenant_id <> t.tenant_id;
  ```

  【実測】手元の使い捨ての Postgres で、正しい参照だけのデータで4本とも0行になること、生 SQL で別テナントを指す行を1本ずつ仕込んだときに、4本とも1行を数えることを確かめた。
  `cross-tenant-reference-check.postgres.test.ts` の最後の `describe` が、ADR の文面と同じ SELECT を実行して縛っている。

  **行が出た場合**: この ADR では決めない。**オーナーの判断が要る**（消す・残す・付け替える、のどれも、利用者のデータの書き換えである）。参考までに、食い違う行は2通りの害を持つ。
  (a) 指された側のテナントの `eraseTenant` を `blocked_by_foreign_reference` で止め、`recall_usages` が指す recall は、指された側の `purgeExpiredRecalls` を外部キー違反で落とす（上の表）。消去・掃除には、その行を先に消すしかない。
  (b) 書いたテナント側の行は、そのテナントの `eraseTenant` が**自分のテナントの行として**消す。

- **検討した代替案（採らなかった案）**:

  - **#854・#1051 の「検査しない」を据え置き、`eraseTenant`・`purgeExpiredRecalls` 側で別テナントの行を消す・無視する。** 採らない。ADR 0383 は「他テナントの行は書き換えない」と決めており、それを破る。根を断つほうが小さい。
  - **複合外部キーだけで守る（入口の検査を入れない）。** 採らない。生の DB エラー（23503）が利用者に見える。この PR が直す対象の1つは、まさにその生の 23503 である。
  - **入口の検査 + 複合外部キー。** 採らない（今回は。上の理由2）。
  - **検査を SELECT と書き込みの2文にする。** 採らない（ADR 0398・0436 と同じ。窓を自分で管理することになる）。
  - **口ごとに別の検査を書く。** 採らない。`memories` の INSERT は3箇所に写されていたものを1関数にまとめ、参照の述語（`refExists`）・形の検査（`checkedRef`）・0行のときの切り分け（`explainEmptyStatusUpdate`）を共有した。写しが口ごとにずれるのを避けるため。
  - **`recordUsage` が、別テナントのものを黙って飛ばして、自テナントの分だけ書く。** 採らない。`insertedMemoryIds` が「書いたもの」を名乗る契約なので、一部を黙って飛ばすと、報告した側は書かれなかったことに気づけない。全体を拒み、1件も書かない。
  - **`supersede` の `anchorId` にも検査を足す。** 採らない。値が呼び出し側の入力ではなく、同じ呼び出しの結果の行の id である（表の4行目）。二重にしても、守るものが増えない。
  - **適合テストを足さず、個別の歯だけにする（ADR 0438 の方針）。** 採らない。ADR 0438 が適合テストに足さなかった理由は「Postgres の SQL の絞りを縛る（生 SQL で負債の形を作る）もので、adapter 一般の契約ではない」だった。
    この ADR の検査は、adapter 一般の契約（別テナントの参照を拒む）そのもので、ADR 0398・0436 が適合テストに足したのと同じ種類である。生 SQL で形を作る歯は、個別のテストに置いた。

- **歯（先に赤を commit してから直した）**:

  歯は2層ある。(1) `describeMemoryStoreConformance` の9本（`-t "ADR 0439"`）。`@mnemora/postgres` と testkit の `InMemoryMemoryStore` の両方に当たる。(2) `packages/postgres/src/__tests__/cross-tenant-reference-check.postgres.test.ts`（10本）。生 SQL で行数を数え、
  B の `purgeExpiredRecalls`・`eraseTenant` が止まらないことを見る。自テナントの正しい参照・大文字の uuid・uuid でない id・検出 SQL の0行と1行も見る。`restoreSupersededBy`・`previewRestoreSupersededBy` の、B の行が A の anchor を指す形（生 SQL）も、ここが縛る。

  【実測】コマンドは `packages/postgres` で `DATABASE_URL=… pnpm exec vitest run src/__tests__/cross-tenant-reference-check.postgres.test.ts`、`… src/__tests__/conformance.postgres.test.ts -t "ADR 0439"`、`packages/testkit` で `pnpm exec vitest run src/__tests__/in-memory-fixtures.conformance.test.ts -t "ADR 0439"`。

  | 実装                                   | 個別の歯（10本）                                                           | Postgres の適合（`-t "ADR 0439"`） | InMemory の適合（同） |
  | -------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- | --------------------- |
  | 直す前（赤だけを commit した枝の先頭） | **7 failed** / 2 passed（検出 SQL の2本は検査に依らず通る）。当時の歯は9本 | **8 failed**（当時の8本）          | **8 failed**（同）    |
  | 直した実装                             | **10 passed**                                                              | **9 passed**                       | **9 passed**          |

  赤の出方: 別テナントを指す書き込みが `resolved instead of rejecting`、uuid でない recall id が生の `Failed query`（直す前の `recordUsage`）、A の usage 行が B の recall を指していて `purgeExpiredRecalls` が外部キー違反。
  適合テストの9本目（実在しない uuid・uuid でない id）と、個別の歯の10本目（`restoreSupersededBy` の生 SQL の形）は、赤の commit の後に足した。9本目の赤は変異 M9 で、10本目は「直す前の実装でも通る」（`restoreSupersededBy` の絞りを縛る歯で、この PR が変えた口ではない）。

  **変異**（`packages/postgres/src/memory-store.ts` に1つずつ当て、赤を見て、`cp` で戻し、`cmp` で元と同じになったことを確かめた。**変異を当てたまま commit していない**。M1〜M8 を撃った時点の適合テストは8本で、M9 以降は9本）。結果は「個別の歯 / Postgres の適合 `-t "ADR 0439"`」の失敗数:

  | 変異                                                                                                           | 個別の歯                                                | 適合                                                                                   |
  | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
  | M1 やりすぎ: 参照の述語の `tenant_id = ctx` を `tenant_id = 'nobody'` にする（自テナントの正しい参照まで断る） | 7 failed / 10                                           | 8 failed                                                                               |
  | M2 参照の述語から `tenant_id` の条件を外す（別テナントを通す）                                                 | 6 failed / 10                                           | 8 failed                                                                               |
  | M3 `recordUsage` の INSERT で検査の結果を無視する（`WHERE true`）                                              | 3 failed / 10                                           | 1 failed                                                                               |
  | M4 `memories` の INSERT で検査の結果を無視する（`WHERE true`）                                                 | 1 failed / 10（実在しない id で外部キー違反が先に出る） | 0 failed（**等価**。下記）                                                             |
  | M4b M4 に加え、INSERT の後の `ref_*_ok` の throw を無効にする                                                  | 3 failed / 10                                           | 3 failed                                                                               |
  | M5a `updateStatus` の UPDATE から参照の検査を外す                                                              | 3 failed / 10                                           | 1 failed                                                                               |
  | M5b `updateStatusWithEvent` の UPDATE から参照の検査を外す                                                     | 2 failed / 10                                           | 1 failed                                                                               |
  | M6 `resolveContestedPair` の UPDATE から参照の検査を外す                                                       | 1 failed / 10                                           | 1 failed                                                                               |
  | M7 `resolveContestedGroup` の UPDATE から参照の検査を外す                                                      | 1 failed / 10                                           | 1 failed                                                                               |
  | M8 `recordUsage` の memory の検査から `tenant_id` を外す                                                       | 2 failed / 10                                           | 1 failed                                                                               |
  | M9 `checkedRef` の uuid の形の検査を外す                                                                       | 1 failed / 10                                           | 0 failed → 実在しない uuid・uuid でない id の適合テスト（9本目）を足したあと、1 failed |
  | M10 testkit の `InMemoryMemoryStore` の `assertOwnMemoryRef` から `tenant_id` の比較を外す                     | —（Postgres ではない）                                  | InMemory の適合が 7 failed                                                             |

  M4 の「等価」: `createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` は、INSERT のあとの `ref_*_ok` の throw がトランザクションを巻き戻すので、INSERT の `WHERE` のゲートだけを外しても、別テナントの行は残らない。
  ゲートの役割は、実在しない id のときに外部キー違反（23503）ではなく明示の例外にすること（M4 の1 failed）で、検査の throw と `WHERE` のゲートが二重に守っている。片方だけなら外しても別テナントの行は書かれない。両方を外す M4b は赤になる。

  他の ADR の歯への影響: ADR 0438 の `tenant-boundary-teeth.postgres.test.ts`（生 SQL で負債の形を作る歯）、同じ系統の `tenant-boundary-teeth-2.postgres.test.ts`（#1547 が main に入れたもの）、`erase-tenant.postgres.test.ts`（`superseded_by_id` の `blocked_by_foreign_reference` を生 SQL で作る歯）は、**この PR では壊れない**
  （4ファイルとも緑。生 SQL は API の検査を通らないので、仕込んだ形がそのまま残る）。壊れたのは、形を **API で**作っていた既存の2つ（上の決定9）だけで、同じ PR で直した。

  走らせたもの（全テストは走らせていない）: `packages/postgres` の、対象の列か口を含む90本のテストファイル（`conformance.postgres.test.ts` を除く）と、`conformance.postgres.test.ts` 全体（626 → 627 件）、`packages/testkit` の該当22本、`packages/core` の該当138本。落ちたのは `foreign-key-violation.postgres.test.ts` の1本だけで、上のとおり直した。

- **引き受けた負債**:

  - **破壊的変更である。** これまで通っていた（別テナントの行・実在しない id を指す）書き込みが、Postgres では `… not found for tenant` を投げるようになる（実在しない uuid・uuid でない id は以前も落ちたが、生の DB エラー〔23503・`Failed query`〕から、明示の例外に変わる）。
    `recordUsage` は、実在しない `recallId` でも以前は外部キー違反だったが、message と型が変わる。冪等の衝突で既存の行を返していた `createMemory*` も、参照が壊れていれば拒むようになる。
    `CHANGELOG.md` の `[1.2.0]` 節 `### Breaking` と `docs/migration-v1.md` の項目51に書いた。番号は `main` の側を正とした（ADR 0437 が項目50を使っている）。自前の `MemoryStore` を適合テストに当てている利用者は、新しい `it` が落ちうる。
  - **既に書かれた食い違う行は、そのまま残る。** 検出 SQL は上にある。消すかどうかはオーナーの判断。
  - **適合テストの2本は、縛る強さが下がった**（決定9）。B の行が A の anchor を指す形は、適合テストでは作れない。生 SQL の歯は Postgres にだけある。**インメモリには、その形を作る口が無い**（テナントの絞りを外す変異を、インメモリの `restoreSupersededBy` に当てる歯は無い）。
  - **DB の制約としては、まだ守られていない。** 書き込み口が増えたとき、検査を忘れると破れる。特に `memory_events` への INSERT 11箇所は、ADR 0436 から変わらず、1つずつ確かめていない。
  - **検査と書き込みの間に並行して参照先が消えた場合**は、1文の中なので窓は小さいが、`eraseTenant` との同時実行は実測していない。外部キー違反の生のエラーになりうる（ADR 0436 と同じ）。
  - **`FakeMemoryStore`（core）には、この検査を縛る適合テストが無い。** `FakeMemoryStore` は `describeMemoryStoreConformance` に当てられていない。直したが、テナントを外す変異を当てる歯は足していない（core の既存のテストが緑のまま通ることだけを見た）。
  - **`createMemoriesWithOutboxAndEvents` は、検査で落ちた候補を `dropped` に積む。** 候補が1つだけで落ちれば、その例外が投げられる。ADR 0435 の `ClaimKeyIndexLimitError` と同じ扱いで、新しい振る舞いを足していない。
  - **ADR 0436 の「今回塞がない、同じ種類の残りの口」は、この PR で塞いだ。** ADR 0436 の末尾に追記した。

- **これが覆るとしたら**:

  - 書き込み口が増えたとき、または口ごとの検査を確かめる負担が大きくなったとき——複合外部キーを入れる（ADR 0398・0436 と同じ。`NOT VALID` で足してから `VALIDATE` する手順と、検出 SQL が全環境で0行であることの確認が要る）。
  - 検出 SQL が実データで行を返したとき——行の扱いを決める別の判断が要る（オーナーの判断）。
  - オーナーが、適合テストに別テナントのケースを足す方針を取り消したとき——個別の歯（`cross-tenant-reference-check.postgres.test.ts`）だけが残る。
  - `memory_events` の INSERT 11箇所に、別テナントの記憶 id を指す経路が見つかったとき——同じ作法で塞ぐ別の判断になる。
