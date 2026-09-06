# ADR 0034: `VectorFilter` を「adapter が実際に適用しなければならない」契約にし、その契約を適合テストの歯として置く

- **状態**: 採用 (2026-09)

- **文脈**:

  マネージャーが現物で確認した事実として渡された、次の2点を直す。

  1. **`InMemoryVectorStore.search`（`packages/testkit/src/__fixtures__/in-memory-vector-store.ts`）
     が `filter` の3フィールドを完全に無視していた。** `opts.filter.status` /
     `opts.filter.subjectId` / `opts.filter.decayFloorAtAfter` への参照が1つも無く、
     見ていたのは space の prefix と `opts.filter.tenantId` だけだった。一方
     `PostgresVectorStore.search`（`packages/postgres/src/vector-store.ts`）は3つとも
     `memories` との `JOIN` で実際に効かせている。
  2. **適合テスト（`packages/testkit/src/vector-store-conformance.ts`）が、その契約を
     どの adapter に対しても検査していなかった。** `it()` は5本あり、`filter:` は
     5箇所すべて `{ tenantId: ... }` だけだった。`status` / `subjectId` /
     `decayFloorAtAfter` を渡すテストは1本も無かった。

  ⟹ **適合スイートを通した adapter が、`filter` を全部無視していても緑になっていた。**
  これは PR #29（ADR 0029 に至った経緯）で踏んだ「同じ歯が、片方の実装では契約を、
  もう片方では別のものを測っていた」と同じ族の失敗である。

  **この状況は ADR 0023 が既に一度言語化していた。** ADR 0023 の
  「`testkit` の適合テストに `subjectId` の契約を足すかどうか（今回は足さない）」節は
  こう書いている:

  > **`VectorFilter` は「絞る義務」を持つのか、持たないのか。**
  > いまは持たない（後段が正しさを担保する）という前提で全体が組まれているが、
  > それは `status` / `decayFloorAtAfter` / `subjectId` のすべてに同じく効く話であり、
  > **どこにも明文化されていない。**（……）**本 ADR ではこれを決めない。**

  本 ADR は、ADR 0023 が先送りしたこの問いに答える。**答えは「持つ」である。**

  [AGENTS.md](../../AGENTS.md)「正典と実装が食い違ったら」の規約どおり、バグなのは
  実装のほうである。`docs/decisions/README.md` の規約（ADR 0029）どおり、件数の欄は持たせない。

- **決定**:

  1. **`VectorFilter` の各フィールドは adapter が実際に適用しなければならない、と
     `packages/core/src/interfaces/vector-store.ts` の doc に明記する。**
     「絞ってもよいが絞らなくてもよい」という緩い契約ではないと doc に書く。
     `decayFloorAtAfter` は **狭義の `>`**（境界とちょうど同じ `decayFloorAt` は含まれない）
     であることも明記する——`PostgresVectorStore` の `m.decay_floor_at > ${decayFloorAtAfter}`
     が基準。

  2. **`InMemoryVectorStore` に `InMemoryMemoryStore` への参照を必須のコンストラクタ引数として
     持たせる。** `status` / `subjectId` / `decayFloorAt` は Memory の属性であって
     ベクトルの属性ではない——ADR 0003（`MemoryStore` が真実の源であり、`VectorStore` は
     再構築可能な派生索引であるという非対称）に従えば、in-memory 実装が Memory の属性を
     見るには「真実の源」への参照が要る。`PostgresVectorStore` はこれを `JOIN memories m` で
     得ており、外部キー（`memory_id → memories(id)`）でこの非対称を強制してもいる。
     in-memory 実装は `InMemoryOutboxStore` が `InMemoryMemoryStore.outboxJobs` を
     共有参照で受け取る前例（ADR 0005 に遡る `packages/testkit` の既存パターン）に倣い、
     `InMemoryVectorStore(memoryStore: InMemoryMemoryStore)` という形にした。
     `search` は `entry.tenantId`/`space` の一致を見たあと、`this.memoryStore.get(...)` で
     Memory を引き、`status`/`subjectId`/`decayFloorAt` を比較する。Memory が見つからない
     場合（真実の源に無い vector）は返さない——Postgres の外部キー制約に対応する扱い。

  3. **`VectorStoreConformanceOptions.prepareMemoryId` を拡張し、`attrs`
     （`status`/`subjectId`/`decayFloorAt`）を渡せるようにする。** 属性を指定しなかった
     ときの既定値は adapter の裁量（`PrepareMemoryIdAttrs` の doc コメントに明記）だが、
     この適合テストの `filter` の歯は指定した属性だけを見るため、既定値には依存しない。

  4. **`vector-store-conformance.ts` に `filter` の契約の歯を5本足す**（既存5本 + 新設5本 =
     10本の `it()` になる）:
     - `filter.status`: 配列に無い status の Memory は返らず、配列に在る status の
       Memory は返る（同じ検査の中で両方を押さえる非対称）。
     - `filter.subjectId`: 別 subject の Memory は返らず、一致する subject の Memory は返る。
     - `filter.decayFloorAtAfter`: 境界と*ちょうど同じ* `decayFloorAt` は除外され、
       境界より後は返る（狭義の `>` を境界値で固定する）。
     - `filter` の複合（AND）: `status` と `subjectId` を同時に渡し、片方だけ一致する
       Memory 2種類と両方一致する Memory 1種類を用意して、両方一致するものだけが
       返ることを検査する。

  5. **`packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts` の配線を
     直す。** `describeOutboxStoreConformance` の `seedJob`/`latestMemoryStoreForOutboxSeed`
     と同じ形——`createStore()` が作った `InMemoryMemoryStore` を
     `latestMemoryStoreForVectorFixtures` に保持し、`prepareMemoryId` がそこへ
     `createMemory` で実在の Memory を作る。`packages/postgres/src/__tests__/
conformance.postgres.test.ts` の `prepareMemoryId` も `attrs` を
     `buildNewMemoryFixture` に渡す形に直した。

- **採らなかった案**:

  - **in-memory 実装への `MemoryStore` 参照を省略可（optional）にする。** 却下。
    省略できると「filter を検査できる adapter」と「できない adapter」が同じ緑色の
    出力になる——このリポジトリが ADR 0011/0025/0027/0028 で4回破った「名乗れる
    以上の精度を主張する」族を、フックの省略という形で5回目・6回目として再現する
    ことになる（フックが2箇所——`InMemoryVectorStore` のコンストラクタと
    `VectorStoreConformanceOptions.prepareMemoryId`——あるため、片方でも妥協すれば
    同じ失敗が起きる）。

  - **歯を置かず、in-memory 実装だけ直す。** 却下。マネージャーの指示どおり、
    芯は「歯」のほうである。歯を置かずに実装だけ直すと、契約が検査されない状態が
    残ったままになり、次に別の adapter（あるいは今の実装への将来のリグレッション）が
    同じ穴を再現しても、適合テストは気づけない。ADR 0023 が既にこの問いを一度
    先送りしており、先送りしたまま実装だけ直すと同じ問いが3度目に持ち越される。

  - **`VectorFilter` を「絞ってもよいが絞らなくてもよい」という緩い契約として
    明文化する。** 却下。ADR 0023 が実際にこの前提で書かれていた
    （「後段フィルタは残す。二重に見えるが意図的——`VectorStore` は『絞ってもよいが
    絞らなくてもよい』派生索引であり、正しさの責任は常に後段にある」）。この前提を
    明文化として採用すると、次の問いが即座に立つ——**それなら `VectorFilter` の
    各フィールドは何を意味するのか。** 「絞ってもよいが絞らなくてもよい」ものに
    `subjectId`/`status`/`decayFloorAtAfter` という具体的な意味論（等値・配列包含・
    狭義の `>`）を持たせる理由が無くなる。`packages/postgres` は実際にこれらを厳密に
    実装しており（ADR 0023 の実測含む）、それを「たまたま絞っている adapter」の
    振る舞いとして扱うのは、正典（ADR 0003 の非対称・docs/recall.md の「無い」の
    分類）が求める説明可能性（north-star.md 問い3）とも整合しない。**「絞る」を
    契約にし、多層防御としての後段フィルタは残す**、という形を採った。

- **⚠ 訂正: 「多層防御が在るから最終結果は正しい」は、`status` には当てはまらない**:

  本 ADR の初稿は「`recall-runtime.ts` が段1のあとに同じ条件で後段フィルタを重ねている」と
  書いていた。**これは実測により誤りだった。** 後段が改めて見るのは `subjectId`・period・
  `excludeProvenanceKinds` であり、**`status` と `decayFloorAtAfter` は見ていない**。

  実測の出どころ: 後続 PR（`FakeVectorStore` に同じ契約を適用したもの）で変異を撃ったとき、
  **`status` の絞りを落とす変異では `recall-pipeline.test.ts` の既存の歯が実際に赤くなり、
  `subjectId` を落とす変異では赤くならなかった**——後段が `subjectId` だけを救っているため。

  ⟹ **`status` については、adapter がこの契約を守ることが唯一の防衛線である。**
  この非対称は `packages/core/src/interfaces/vector-store.ts` の `VectorFilter` の doc にも
  明記した。**推測を事実の顔で書かない**（AGENTS.md）ための訂正であり、初稿の記述は
  残していない——当時の記録として保存する価値のある観測ではなく、単に誤りだったため。

- **`packages/core/src/recall-runtime.ts` に残る古い記述（触っていない）**:

  `recall-runtime.ts:192-193` 付近には次の逐語コメントが残っている:

  > `InMemoryVectorStore`（testkit）は filter を無視するプレースホルダなので、
  > ここを削ると core の契約そのものが壊れる。

  **本 PR の変更により、この理由づけは事実でなくなる**——`InMemoryVectorStore` は
  もう filter を無視しない。コード自体（後段フィルタを残すこと）は防御として
  引き続き正しい（上記「採らなかった案」参照。多層防御は残す決定であるため）。
  `recall-runtime.ts` はマネージャーの指示により本 PR では触っていない
  （同時に別の担当がこのファイルを扱っている）。コメントの更新は別途必要。

- **引き受ける負債**:

  - **`InMemoryVectorStore` のコンストラクタ引数が増えた破壊的変更。** 呼び出し側は
    リポジトリ内に1箇所のみ（`in-memory-fixtures.conformance.test.ts`）で、
    本 PR で更新済み。リポジトリ外の利用者がいた場合は影響する。
  - **`VectorStoreConformanceOptions.prepareMemoryId` を省略不可の必須フィールドに
    した破壊的変更。** 呼び出し側はリポジトリ内に2箇所（`packages/testkit` の
    in-memory 登録・`packages/postgres` の postgres 登録）のみで、両方とも本 PR で
    `attrs` 対応済み。
  - **`period`（`occurredAfter`/`occurredBefore`）は `VectorFilter` に無く、本 ADR の
    範囲外のまま。** ADR 0023 が既に指摘した既存の負債であり、本 ADR はこれを
    解消しない。
  - **`packages/core/src/__tests__/runtime-fakes.ts` の `FakeVectorStore` は、本 ADR の
    範囲外のまま似た穴を残している（確認した事実）。** `FakeVectorStore` は
    `status`/`decayFloorAtAfter` を `this.backing`（`FakeBackingStore`）が
    **渡されている場合だけ** 適用し、`backing` はコンストラクタで
    `private readonly backing?: FakeBackingStore`（省略可）——`subjectId` に至っては
    参照が一つも無い。これは `packages/testkit` の適合テストが検査する対象では
    ない（`FakeVectorStore` は adapter 適合テストの対象ではなく、`packages/core` 自身の
    runtime テスト専用の二重、docs/architecture.md §4 の「core は testkit に依存しない」
    という制約から来る既存構造）ため、本 ADR が直した `InMemoryVectorStore`/
    `PostgresVectorStore` の対とは別の系統であり、同じ「省略可能な参照」というリスク
    ——ただし adapter 適合テストの外側にあるため「検査できる/できない adapter が
    同じ緑になる」問題は起きない（`FakeVectorStore` は conformance の対象外）。
    このリポジトリを触った以上の指示は受けていないため直していない。マネージャーへの
    報告に明記する。

- **確かめていないこと**:

  - **`packages/postgres` 側の適合テスト（`describeVectorStoreConformance` の
    postgres 版、新設した5本を含む）が実際に通ることは、この作業環境に
    PostgreSQL/`DATABASE_URL` が無いため未実測。** 型検査（`tsc`）が通ることのみ
    確認した。次の CI 実行が唯一の実測経路である。
  - **大規模データでの `InMemoryVectorStore.search` の性能**（`memoryStore.get` を
    エントリ数だけ呼ぶ線形操作が増えた）は測っていない。in-memory 実装はテスト専用の
    プレースホルダであり、本番規模を想定していない（クラス doc に既にその前提がある）。
  - `subjectId` に空文字列などの特殊値を渡した場合の挙動は検討していない
    （ADR 0023 が同じ理由で無検証と書いており、それに倣った）。

- **これが覆るとしたら**:

  - `VectorFilter` に `period` 相当のフィールドを足すことになったら、この適合テストの
    歯の形（`prepareMemoryId` に属性を渡す・in-memory 実装が `MemoryStore` を参照する）を
    そのまま拡張できるはずである。
  - `recall-runtime.ts` の後段フィルタ（多層防御）を「もう不要」として消す判断が
    将来下されたら、それは「`InMemoryVectorStore` を含むすべての `VectorStore` adapter が
    `filter` を正しく実装していることを、適合テストが継続して保証している」という
    前提の上でのみ成り立つ——本 ADR がその保証を作った。
