# ADR 0042: `EventStore.list` の並び順・`limit`・`since`/`until` を契約に明記し、適合テストの歯で固定する

- **状態**: 採用 (2026-09)

- **文脈**:

  マネージャーが現物で確認した事実として渡された、次の3点を直す。

  1. **`EventStore.list`（`packages/core/src/interfaces/event-store.ts`）に doc コメントが
     1行も無かった。** 一方 `EventFilter`（`packages/core/src/event.ts`）は `since` /
     `until` / `limit` を型として持っている——フィールドが在るのに意味がどこにも
     書かれていない。ADR 0034（`VectorFilter`）・ADR 0038（`VectorHit.distance`）で
     潰したのと同じ族の失敗である。

  2. **3つの実装が食い違っていた。**

     | | Postgres（`event-store.ts`） | testkit InMemory（`in-memory-event-store.ts`） | core Fake（`runtime-fakes.ts`） |
     |---|---|---|---|
     | 並び順 | `ORDER BY at ASC` | 挿入順（ソートしない） | 挿入順 |
     | `limit` | `LIMIT n` | `slice(0, n)` | 無視する |
     | `since` | `at >= since` | 同値 | 無視する |
     | `until` | `at <= until` | 同値 | 無視する |
     | `memoryId` / `kind` | ✓ | ✓ | ✓ |

     並び順と `limit` は相互作用して**返る集合そのもの**を変える——Postgres は
     `at` の小さい順に n 件、in-memory（直す前）は挿入順の先頭 n 件。`append` は
     `event.at ?? new Date()` なので、呼び出し側が任意の `at` を渡せる。⟹
     挿入順と `at` 順は一致するとは限らない。

  3. **適合テスト（`packages/testkit/src/event-store-conformance.ts`）の `it()` は
     6本で、測っていたのは `kind` / `memoryId` / クロステナントだけだった。**
     `limit` / `since` / `until` / 並び順を渡すテストは1本も無かった
     （`grep` で0件だったことを確認した）。

  **⚠ ただし、今日「誤った値が返る」経路は無い。** `EventStore.list` の呼び出しは
  repo 全体で `packages/core/src/__tests__/runtime.test.ts` の3箇所だけで、
  すべて `{ memoryId }` のみを渡しており、並び順も件数も見ていない。
  本番コード（`packages/core` / `packages/postgres` / `examples`）に呼び出しは
  1つも無い。⟹ **破れているのは「契約が何も言っていないので、どの adapter も
  違反にならない」ほうであり、「今日どこかで誤った値が返っている」ほうではない。**
  この区別を誇張しないことが本 ADR の前提である。

- **決定**:

  1. **`EventStore.list` に doc コメントを足し、次を契約として明記する**
     （`packages/core/src/interfaces/event-store.ts`）:
     - 並び順は `at` の昇順（`PostgresEventStore` の `ORDER BY at ASC` が基準）。
     - `limit` は並べ替えた**後**に適用する——「`at` が最も古い n 件」。
       挿入順の先頭 n 件ではない。
     - `since` / `until` は両端を含む（`at >= since` / `at <= until`）。
     - **`at` が同値の行同士の順序は規定しない。** Postgres の `ORDER BY at ASC` は
       同値の行の順序を保証しないため、規定しても守れない約束になる
       （名乗れる以上の精度を主張しない）。

  2. **`packages/testkit/src/event-store-conformance.ts` に歯を4本足す**
     （postgres と in-memory の両方に走る）:
     - 並び順の歯: `at = T3, T1, T2` の順で append し（T1 < T2 < T3）、
       `list` が `[T1, T2, T3]` を返すことを検査する。
     - `limit` の歯: 同じ挿入順で `limit: 1` を渡し、返るのが `T1` の1件で
       あることを検査する（挿入順の先頭 n 件なら `T3` になる——順序だけでなく
       *集合そのもの*が変わることを測る、いちばん強い歯）。
     - `since` の境界の歯: `since: T2` で `T2` と `T3` が返る（`>=` を検査）。
     - `until` の境界の歯: `until: T2` で `T1` と `T2` が返る（`<=` を検査）。

     フィクスチャは非対称にした——挿入順（T3, T1, T2）と `at` 順（T1, T2, T3）が
     一致しないように積んでいる。期待値はテスト内のリテラルな `Date` から作り、
     実装側の関数や定数からは導出していない。`at` が同値のケースは歯にしていない
     （決定1で規定しないと明記したため）。

  3. **`packages/testkit/src/__fixtures__/in-memory-event-store.ts` の `list` を、
     `at` 昇順にソートしてから `limit` を適用する形に直す。** `filter()` が返す
     新しい配列に対して `sort()` する——`this.events` を in-place で並べ替えると、
     `InMemoryMemoryStore.updateStatusWithEvent`（ADR 0031）と共有している配列の
     挿入順が壊れる。このことをコメントに明記した。

- **採らなかった案**:

  - **並び順を「実装が決めてよい」とする契約にする。** 却下。`limit` と組むと
    返る集合そのものが変わるため、`EventFilter.limit` の意味が実装ごとに
    変わってしまい、「`limit: n` で何が返るか」を呼び出し側が説明できなくなる。

  - **挿入順を契約にする。** 却下。Postgres は行の物理的な挿入順を保持する
    保証を持たない（`ORDER BY` を指定しない `SELECT` の順序は未定義）うえ、
    `at` は呼び出し側が任意に渡せる（`event.at ?? new Date()`）。挿入順を
    契約にすると Postgres 側がそもそも守れない。

  - **`at` が同値のときの順序も規定する。** 却下。Postgres の `ORDER BY at ASC`
    は同値の行の順序を保証しない（安定ソートである保証が無い）。規定しても
    実装が守れない約束になり、ADR 0011/0025/0027/0028 が既に破ってきた
    「名乗れる以上の精度を主張する」族を繰り返すことになる。

- **引き受ける負債**:

  - **`packages/core/src/__tests__/runtime-fakes.ts` の `FakeEventStore` は、
    `limit` / `since` / `until` を無視したままで、本 PR では直していない。**
    このファイルは別のマネージャーが同じ repo で作業中のため、オーナーの許可待ちで
    触っていない（読んだのみ）。`FakeEventStore` は本 ADR が固定した契約
    （`EventStore.list` の doc コメント）と食い違ったままである——`packages/core` の
    runtime テスト専用の二重実装であり `packages/testkit` の適合テストの対象外
    なので、「検査できる/できない adapter が同じ緑になる」問題は起きないが、
    契約と実装が食い違っている事実そのものは残る。マネージャーへの報告に明記する。

- **確かめていないこと**:

  - **`packages/postgres` 側の適合テスト（新設した4本を含む）が実際に通ることは、
    この作業環境に PostgreSQL/`DATABASE_URL` が無いため未実測。** 型検査（`tsc`）が
    通ることと、in-memory 側で同じ歯が通ることのみ確認した。次の CI 実行が
    唯一の実測経路。
  - `FakeEventStore` を今後直す場合に、`limit`/`since`/`until` を無視する既存の
    呼び出し側（`runtime.test.ts` の3箇所、すべて `{ memoryId }` のみ）が
    影響を受けるかどうかは確認していない——現状は影響を受けない（並び順も
    件数も見ていないため）が、`FakeEventStore` 側の修正そのものは本 PR の
    範囲外である。

- **これが覆るとしたら**:

  - `packages/testkit` が `packages/core` のテストユーティリティを参照できる
    構造に変わり、`FakeEventStore` と `InMemoryEventStore` を1つに統合できる
    ようになったら、「引き受ける負債」に書いた食い違いは解消できる。
  - Postgres 側で `at` に安定した decided tie-break（例えば `id` を第二キーにする）
    を導入する判断が下されたら、「`at` が同値の行の順序を規定しない」という
    決定は見直す余地がある。
