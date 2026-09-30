# ADR 0393: core が、provider の返す埋め込みの次元（`space.dimensions`）と成分の有限性を確かめる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

- **文脈**:

  [Issue #860](https://github.com/takecchi/mnemora/issues/860)。`EmbeddingProvider` は、返すベクトルの長さが
  自分の `space.dimensions` と一致することを約束しているが、守るかどうかは実装ごとに違った
  （`@mnemora/local-embedding` は検査して throw、`@mnemora/openai` は [PR #1462](https://github.com/takecchi/mnemora/pull/1462)
  まで検査しなかった。第三者の実装は何も保証されない）。core はその出力を確かめずに使っていたので、次のように
  結果が store と provider の組で決まっていた。

  - **embed ジョブ**（`runtime.ts` の `processEmbedJob`）: 次元違いをそのまま `VectorStore.upsert` へ渡す。
    Postgres は pgvector の `expected N dimensions` で落ち、ジョブは `failed` になるが、原因が SQL の失敗に見える。
    testkit の `InMemoryVectorStore` と core の `FakeVectorStore` は黙って `'ready'` で保存する
    （`interfaces/vector-store.ts` の `upsert` の表、[Issue #1070](https://github.com/takecchi/mnemora/issues/1070)）。
  - **recall の問い合わせ埋め込み**（`recall-runtime.ts`）: provider が返したベクトルは `Array.isArray` だけを見て
    store へ渡す。Postgres は `toComparableQuery` で全 0 に差し替え、`score_not_comparable` と記録する。
    `local-embedding` は throw するので `embedding_provider_unavailable` になる。**同じ原因（provider が次元違いを返した）が、
    provider によって別の名前で記録されていた**（[ADR 0008](./0008-absence-taxonomy.md) の「同じ理由を2つの顔で返さない」に反する）。

  2026-09-27 に Issue #1070 で「core での検査は採らず、今の振る舞いを記録する」と判断した（クローン miku）。
  今回、その判断を覆す（長さは最初の版から、有限性は同日のうちに）。

- **決定**:

  1. **embed ジョブは、`VectorStore.upsert` の前に `vector.length === deps.embeddingProvider.space.dimensions` を確かめる。**
     違えば `upsert` を呼ばずに素の `Error`（メッセージに期待した次元と実際の次元を含む）を投げ、既存の失敗の経路
     （`embeddingStatus: 'failed'` を書いて投げ直す。`tick()` はジョブを `failed` にする）に乗せる。abort による reject は
     従来どおり `failed` にせず投げ直す（[ADR 0359](./0359-abort-signal-for-provider-calls.md)）。
  2. **recall は、provider が返した問い合わせベクトルを使う前に同じ検査をし、違えば「provider がベクトルを返さなかった」と
     同じ扱い**（`stage_skipped` / `candidate_generation` / `embedding_provider_unavailable`）に丸める。`score_not_comparable`
     にはならない。abort は従来どおり丸めずに投げ直す。
  3. **成分の有限性も同じ形で確かめる**（依頼元の決定で、最初の版の「長さだけ」から広げた）。embed ジョブは upsert の前に、
     recall は provider の問い合わせベクトルに対して、`NaN`・`Infinity`・`-Infinity` を1つでも含めば、次元違いと同じ
     失敗の経路（embed は `failed`、recall は `embedding_provider_unavailable`）に乗せる。メッセージは位置と値を含む。
  4. **`RecallQuery.vector`（呼び出し側が直接渡す問い合わせベクトル）には、長さの検査も有限性の検査も足さない。**
     [ADR 0040](./0040-zero-vector-never-returned.md) の 2026-09-26 の追記が、この経路を「比較不能」（`score_not_comparable`、
     新しい throw なし）として扱うと約束しているので、いまの約束を保つ。
  5. **Postgres の `toComparableQuery` は残す**（長さの差し替えも、有限性の差し替えも）。core の検査の後でも届く経路が在る:
     - `recall({ vector })` で呼び出し側が直接渡した問い合わせベクトル（`recall-runtime.ts` は `validatedQuery.vector` を
       そのまま `queryVector` に入れ、`recall.ts` の zod は `z.array(z.number())` で長さを見ない）。
     - `VectorStore.search`/`searchMany` を利用者が直接呼ぶ場合（`interfaces/vector-store.ts` の `search` の doc が
       「長さが違っても新しい例外を投げない」と約束している公開 adapter の契約）。
       消すと、これらが pgvector の未捕捉の `DrizzleQueryError` に戻る。

- **採らなかった案**:

  - **`VectorStore.upsert` を3実装とも throw に揃える**（Issue #1070 の案）: adapter の契約変更で、`InMemoryVectorStore` と
    Fake の既存の利用者にも波及する。core の1か所で守るほうが、adapter が増えても効く。
  - **有限性は検査しない**（最初の版の判断）: 同じ日のうちに覆した。次元だけ守ると、`NaN`/`Infinity` を返す provider では
    store によって結果が割れたまま（Postgres は失敗、InMemory・Fake は `'ready'`、recall の理由の名前も割れる）だった。
  - **`RecallQuery.vector` にも長さ・有限性の検査を足す**: 既存の契約（Issue #867 の案B、呼び出し側の責任＋比較不能）を変える。
    ADR 0040 の約束を保つため採らない。
  - **`toComparableQuery` を消す**: 上の決定5の経路が残るので採らない。

- **引き受けた負債**（破壊的変更として CHANGELOG `[1.2.0]` と `docs/migration-v1.md` の項目33に書いた）:

  - InMemory・Fake の経路で、次元違いの provider の出力が以前は `'ready'` だったものが `failed` になる。
  - recall の理由が、Postgres で次元違いを返す provider について `score_not_comparable` から
    `embedding_provider_unavailable` に変わる。
  - `NaN`/`Infinity` を返す provider も、InMemory・Fake の経路で `'ready'` だったものが `failed` になる（上の1点目に含む）。
  - `RecallQuery.vector` の直接指定と `VectorStore` の直接呼び出しは、長さも有限性も core が守らない（store ごとの
    振る舞いが残る）。
  - `EmbeddingProvider.space.dimensions` が provider の実際の出力と食い違っている（宣言の誤り）と、正しい出力まで
    失敗にする。以前は宣言と食い違っても Postgres 以外では通っていた。

- **これが覆るとしたら**: 次元の宣言（`space.dimensions`）を core が信用できない provider（例: 実行時に次元が変わるモデル）を
  正式に受けるとき。その場合は `EmbeddingSpaceId` の単位の側から見直すことになる（[ADR 0002](./0002-embedding-space-tables.md)）。

- **確かめていないこと**: 実 API・実 Postgres での再現（この判断は core の Fake を使う歯と、コードの読みで裏付けた。
  Postgres のテストは `DATABASE_URL` が無く走らせていない）。

- **歯**: `packages/core/src/__tests__/embed-job-dimension-mismatch.test.ts`・`embed-job-non-finite-vector.test.ts`・`recall-query-embedding-non-finite.test.ts`・
  `recall-query-embedding-dimension-mismatch.test.ts`。実装前は赤（次元の2本は main、有限性の2本は次元の検査だけが入った状態）、検査を1つずつ外すと対応する側だけが赤。

- **反映先**: `packages/core/src/runtime.ts`、`packages/core/src/recall-runtime.ts`、
  `packages/core/src/interfaces/vector-store.ts`・`embedding-provider.ts`、`packages/core/src/recall.ts`、
  `docs/recall.md`、`docs/architecture.md`、`docs/migration-v1.md`、`CHANGELOG.md`。
