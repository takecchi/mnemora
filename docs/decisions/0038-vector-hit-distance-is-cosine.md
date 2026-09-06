# ADR 0038: `VectorHit.distance` はコサイン距離だと契約に明記し、適合テストの歯で adapter 非依存に検査する

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-06

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ」を混ぜない
（[AGENTS.md](../../AGENTS.md)）。

---

- **文脈**:

  マネージャーが現物で確認した事実として渡された、次の2点を直す。

  1. **`InMemoryVectorStore.search`（`packages/testkit/src/__fixtures__/in-memory-vector-store.ts`）
     がユークリッド距離（`euclideanDistance`）を使っていた。** 一方
     `PostgresVectorStore`（`packages/postgres/src/vector-store.ts`）はコサイン距離
     （pgvector の `<=>`）を使う。`packages/postgres/src/vector-space.ts:163` の HNSW 索引は
     `USING hnsw (embedding vector_cosine_ops)` と operator class を明示しており、
     [ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) §5.2 は「距離はコサイン
     （`FakeVectorStore` は `cosineDistance` を使う＝pgvector の `<=>` と同じ）」と実測を記録し、
     [ADR 0036](./0036-clamp-freshness-at-one.md) は `similarity = 1 - distance` がコサイン距離
     ゆえに −1 まで負になりうることを記録している。`packages/core/src/__tests__/
     runtime-fakes.ts` の `FakeVectorStore` も `cosineDistance` を使う。`recall-runtime.ts` の
     下流は `1 - distance` を similarity として扱っており、コサインを前提にしている。
     **⟹ コサインを採ること自体は本 ADR が新しく決めることではない。**
     `vector_cosine_ops`・ADR 0033・ADR 0036 の時点で既に決まっている。
     **本 ADR が決めるのは、それを `VectorHit.distance` の契約として明文化し、
     適合テストの歯で adapter 非依存に検査すること**である——この区別は本 ADR の芯であり、
     以降の節すべてがこの区別を前提にしている。

  2. **契約（`packages/core/src/interfaces/vector-store.ts` の `VectorHit`）が
     距離関数について何も言っていなかった。** `distance: number;` に doc コメントが
     1行も無く、「distance が何の距離か」がどこにも書かれていなかった。
     adapter がユークリッド・コサイン・その他どれを使っても契約違反にならない状態だった。

  3. **適合テスト（`packages/testkit/src/vector-store-conformance.ts`）の距離に関する
     assertion が1つだけで、しかも2つの距離関数を区別できなかった。**
     `expect(matches[0]?.distance).toBeCloseTo(0, 5)`（同一ベクトルなら距離0）は
     ユークリッドでもコサインでも成立する。**フィクスチャ側にも「2つの距離が同じ順序を
     出すベクトル」しか無かった**（既存の `it()` はどれも単位ベクトル同士・長さ1の
     ベクトルしか使っておらず、長さの違いを突く組が無かった）ため、
     ユークリッドとコサインを撃ち分けるどんな変異を撃っても等価変異になり、
     このリポジトリの適合スイートを通した adapter が実はユークリッドを使っていても
     緑のままになっていた。**実際にそうなっていた**（`InMemoryVectorStore` がその実例）。

  ⟹ これは ADR 0034（`VectorFilter` の契約が検査されていなかった）と同じ族の失敗——
  「契約が明文化されておらず、適合テストもそれを検査していない」——を、`distance` という
  別のフィールドに対して繰り返したものである。

  **段1として、「in-memory がユークリッドであると意図的に決めた記述」が repo のどこかに
  無いかを自分で探した。** 探した場所: `docs/` 全体・`docs/decisions/` 全ADR・
  `git log -S euclideanDistance` / `git log -S Euclidean`・`in-memory-vector-store.ts` の
  git blame 相当（該当コミットのメッセージ全文）。**見つからなかった。**
  `euclideanDistance` は最初の scaffold コミット（PR #2、`1eee055`）から存在するが、
  そのコミットメッセージは monorepo の骨組み・型・適合テストの雛形を作ったことしか
  述べておらず、距離関数の選択についての言及が無い。`docs/roadmap.md` にも
  「testkit の距離関数は何を使うか」という判断待ちの項目は無い。**⟹ ユークリッドは
  意図された選択ではなく、コメントの無い未検討の初期値だったと判断した。**

- **決定**:

  1. **`VectorHit.distance` に doc コメントを足し、コサイン距離であることを明記する**
     （`packages/core/src/interfaces/vector-store.ts`）。根拠として `vector_cosine_ops`・
     ADR 0033・ADR 0036・`recall-runtime.ts` が `1 - distance` を similarity として扱うことを
     引用する。**コサイン距離は 0〜2 の範囲を取りうる**（0〜1 ではない）ことも明記する
     ——ADR 0036 が「`similarity` は −1 まで負になりうる」と実測として既に書いている。

  2. **適合テスト（`vector-store-conformance.ts`）に、距離関数を区別できる歯を1本足す。**
     クエリ `q = [1,0,0]`、`A = [10,0,0]`（向きは同じ、長さ10倍）、`B = [1,1,0]` という組を使う。
     この組はコサイン距離とユークリッド距離で**逆の順序**を出す
     （コサイン: `A=0, B≈0.2928932` → A→B。ユークリッド: `A=9, B=1` → B→A）。
     全成分0のベクトルは使わない——コサインが未定義になり、pgvector の `<=>` はエラーになる
     （`packages/postgres/src/bench/scale-bench.ts:667` に同じ注意が実測としてある）。
     - **順序の歯**: `A` が `B` より先に返ることを検査する。
     - **値の歯**: `A` の `distance` が `0`、`B` の `distance` が `1 - 1/√2 ≈ 0.2928932`
       であることを `toBeCloseTo` で検査する。期待値は独立した式（`1 - 1 / Math.sqrt(2)`）
       またはリテラルで書き、実装側の距離関数を呼んで作らない——検査対象と期待値が
       同じ関数を共有すると、両方が一緒に壊れて変異が素通りする。
     この適合テストは postgres と in-memory の両方に対して走るので、
     **Postgres の `<=>` が本当にコサインであることも、今回はじめて測られることになる。**
     既存の `toBeCloseTo(0, 5)`（同一ベクトルなら距離0）の歯は消さない
     ——同一ベクトルで距離0はコサインでも成立する、別の検査である。

  3. **`InMemoryVectorStore.search` の `euclideanDistance` をコサイン距離に置き換える。**
     `packages/core/src/__tests__/runtime-fakes.ts` の `FakeVectorStore.cosineDistance` と
     同じ式にする。ただし `packages/testkit` は `packages/core` の**テストファイル**を
     import できない（`packages/core` の実行時依存が zod のみであることを壊すことになる）ため、
     実装は `packages/testkit` 側に独立して書き、意図した重複であることをコメントに残す。
     **ゼロベクトルの扱いを明示する**: コサインは 0/0 で未定義。pgvector の `<=>` は
     エラーを返す実測がある一方、この in-memory 実装は `FakeVectorStore.cosineDistance` に
     揃えて「無関係（類似度0＝距離1）」を返す——エラーにする案も検討したが、
     既存の適合テストにゼロベクトルを渡すものは無く、揃えても既存の歯は落ちなかった
     （実行して確認した）。in-memory がここでエラーを投げるべきかどうかは決めておらず、
     「確かめていないこと」に残す。

- **採らなかった案**:

  - **契約を「距離関数は adapter が選んでよい」とする。** 却下。
    `recall-runtime.ts` の下流は `1 - distance` を similarity として扱っており、
    これはコサイン距離の場合にのみ「同一なら1に近く、無関係なら0付近」という
    意味を持つ。distance が adapter ごとに違う関数だと、adapter を差し替えるだけで
    similarity・ひいてはスコアリング全体の意味が変わってしまい、成り立たなくなる。

  - **in-memory はプレースホルダだから、postgres と揃えなくてよいとする。** 却下。
    これは ADR 0034 で一度潰した形と同じ——「filter を検査できる adapter」と
    「検査できない adapter」が同じ緑色の出力になる、という失敗を、`distance` という
    別のフィールドで再現することになる。適合テストは adapter 間の一致を検査するための
    ものであり、片方が「プレースホルダだから」で免除されると、その適合テストは
    もう「適合」を検査していない。

- **引き受ける負債**:

  - **`packages/testkit` と `packages/core/src/__tests__/runtime-fakes.ts` に、
    ほぼ同じ `cosineDistance` の実装が2箇所存在する。** `packages/testkit` が
    `packages/core` のテストファイルを import できないという既存の構造的制約
    （docs/architecture.md §4「core は testkit に依存しない」の裏返し）から来ており、
    本 ADR の範囲では解消しない。どちらかを一方に寄せる共通化は、テストユーティリティを
    どのパッケージに置くかという別の設計判断を要するため見送った。
  - **`packages/core/src/__tests__/runtime-fakes.ts` の `FakeVectorStore` は、本 ADR の
    範囲外。** マネージャーの指示により、このファイルは別のマネージャーが同じ repo で
    作業中のため触っていない（読んだのみ）。すでにコサイン距離を使っているため、
    本 ADR の決定と矛盾はしていない。
  - **ゼロベクトルを in-memory に渡したときの「無関係（距離1）」という扱いが、
    postgres の「エラーになる」という挙動と異なる。** 決定3に書いた通り、
    揃えるべきかどうかは確かめていない。

- **確かめていないこと**:

  - **`packages/postgres` 側の適合テスト（新設した順序・値の歯を含む）が実際に通ることは、
    この作業環境に PostgreSQL/`DATABASE_URL` が無いため未実測。** 型検査（`tsc`）が
    通ることと、in-memory 側で同じ歯が通ることのみ確認した。次の CI 実行が唯一の実測経路。
  - **in-memory のゼロベクトルの扱い（「無関係」として距離1を返す）が、実際の利用
    パターンとして正しいかどうか。** 既存の適合テストにゼロベクトルを渡すものが無く、
    落ちないことしか確認していない。
  - **大規模データでの `cosineDistance` の性能**は測っていない。in-memory 実装はテスト専用の
    プレースホルダであり、本番規模を想定していない。

- **これが覆るとしたら**:

  - pgvector の `<=>` の意味が変わる（別の operator class に載せ替える）ことになったら、
    `VectorHit.distance` の契約・`vector-store-conformance.ts` の歯・
    `InMemoryVectorStore`/`FakeVectorStore` の実装、3箇所すべてを同時に見直す必要がある
    ——本 ADR がこの3箇所を「同じ距離関数を指す」という前提で結び付けたため。
  - `packages/testkit` が `packages/core` のテストユーティリティを参照できる構造に
    変わったら（決定3の「引き受ける負債」参照）、`cosineDistance` の重複は解消できる。
