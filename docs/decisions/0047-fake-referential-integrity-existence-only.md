# ADR 0047: 擬似物（in-memory 実装・core の Fake）にも外部キー相当の「存在」検査を適用する（「整合」までは広げない）

- **状態**: 採用 (2026-09)

- **文脈**:

  マネージャーが現物で確認した事実として渡された、次の一点が決め手になっている。

  `packages/core/src/__tests__/runtime.test.ts:277`/`:311`
  （「使用報告は抽出器を通らず、recall_usages への挿入と reinforce だけを行う」・
  「同じ (recallId, memoryId) の再送では reinforce が二重に走らない」）は
  **本番経路**——`runtime.observe(ctx, { kind: 'memory_usage', recallId: "recall-1",
  usedMemoryIds: [memory.id] })`——を通って `MemoryStore.recordUsage` を呼ぶ。

  `recall_usages.recall_id` は `packages/postgres/migrations/0001_init.sql` で
  `NOT NULL REFERENCES recalls(id)` である。`"recall-1"` という recallId は、この2本の
  テストのどちらにおいても `recalls` へ実際に1行も作られていない——⟹ **同じ呼び出しは
  Postgres に対しては*今日でも*外部キー違反で落ちるはずである。**

  擬似物（`packages/testkit` の in-memory 実装・`packages/core/src/__tests__/
  runtime-fakes.ts` の Fake）の存在理由は「DB 無しで測れること」——本番と同じ振る舞いを、
  DB を立てずに確かめるための代役である。**本番では起こりえない書き込み
  （実在しない recallId で `recordUsage` が黙って成功する）を、擬似物の上だけで緑にする
  ことは、その存在理由そのものを裏切る**（＝「手元で緑・本番で赤」という、歯が嘘をつく
  状態）。

  この食い違いは PR #49 が既に発見し、**意図的に保留していた**（本文「族Bの残り3つは
  意図的に保留している」節）。PR #49 が挙げた3口（`recordUsage`・`createMemory` の
  `sourceObservationId`・`VectorStore.upsert`）はすべて外部キーを持つ書き込みであり、
  「in-memory も参照整合性を見るべきか」「契約として『参照整合性は adapter の裁量』と
  明文化すべきか」という設計判断をオーナーへ上げていた。**本 ADR はその判断に答える。
  答えは前者——in-memory も見る、である。**

  `packages/postgres/migrations/0001_init.sql` と `packages/postgres/src/vector-space.ts:155`
  を数えると、外部キーは以下の7本である:

  | # | FK | 対応する擬似物の入口 |
  |---|---|---|
  | 1 | `memories.source_observation_id → observations(id)` | `createMemory` / `createMemoryWithOutbox` |
  | 2 | `memories.superseded_by_id → memories(id)` | `createMemory`、`updateStatus` / `updateStatusWithEvent` の `opts.supersededById` |
  | 3 | `memories.contested_with_id → memories(id)` | `createMemory` |
  | 4 | `recall_usages.recall_id → recalls(id)` | `recordUsage` |
  | 5 | `recall_usages.memory_id → memories(id)` | `recordUsage` |
  | 6 | `memory_embeddings_*.memory_id → memories(id)` | `VectorStore.upsert` |
  | 7 | `memory_events.memory_id → memories(id)`（nullable。`kind='events_purged'` のみ NULL） | `EventStore.append` |

  マネージャーの判断（本 PR で明記）: **7本すべてに適用する。** PR #49 が扱ったのは
  4（`recordUsage.recallId`）と 7（`EventStore.append`）だけだが、7本のうち2本だけに
  適用すると「7本のうち2本にしか適用されていない」という新しい非対称を作る——これは
  #47（「形式不正な id は『存在しない』と同じ扱い」という既定の規約が、基準を満たす
  口の3/9にしか適用されていなかった）と同じ形の失敗である。

  **⚠ ADR 0042 の前例（`EventStore.list` の `at` 同値の順序は「規定しない」）とは形が
  違う。** あちらは Postgres が保証できない（`ORDER BY` の同値タイブレークは安定ソートで
  ある保証が無い）ので「守れない約束だった」。**こちらは Postgres が既に外部キーとして
  保証しており、弱いのは擬似物のほうである。** ⟹ 「規定しない」で済ませる選択肢は無く、
  揃える側（擬似物を強くする側）が正しい。

- **決定**:

  1. **`InMemoryMemoryStore`（`packages/testkit`）と `FakeMemoryStore`
     （`packages/core/src/__tests__/runtime-fakes.ts`）の `createMemory` に、
     `sourceObservationId`/`supersededById`/`contestedWithId` が非 null のとき実在する
     行を指すことを検査するガードを足す（FK 1・2・3）。実在しなければ `Error` を投げる。
     `updateStatus`/`updateStatusWithEvent` の `opts.supersededById` にも同じガードを足す
     （FK 2 の残り2口）。

  2. **`InMemoryMemoryStore.recordUsage`/`FakeMemoryStore.recordUsage` に、`recallId`
     と `memoryIds` の各要素が実在することを検査するガードを足す（FK 4・5）。**
     Postgres 実装（`PostgresMemoryStore.recordUsage`）は単一の
     `INSERT ... SELECT ... FROM unnest(...)` で全件を書くため、どれか1件でも外部キーに
     違反すれば文全体が失敗し部分挿入は起きない——擬似物でも「全件の存在を先に確認して
     から挿入する」ことで同じ全体原子性を再現する。**ただし `memoryIds` が空配列のときは
     Postgres 実装がクエリを一切発行せず即座に空の結果を返す（`recallId` の実在を問わ
     ない）ため、その早期リターンより後ろで検査し、同じ非対称を保つ。**

  3. **`InMemoryVectorStore.upsert`/`FakeVectorStore.upsert` に、`memoryId` が実在する
     ことを検査するガードを足す（FK 6）。** 両実装とも `search` は既に「真実の源
     （`MemoryStore`）に無い vector は返さない」という形でこの非対称を扱っていた
     （ADR 0034）——書き込み側（`upsert`）でも同じ非対称を強制する。

  4. **`InMemoryEventStore.append`/`FakeEventStore.append` に、`memoryId` が非 null の
     とき実在することを検査するガードを足す（FK 7）。`memoryId` が null（
     `kind = 'events_purged'` 等）の場合は検査しない——NULL を拒まない。**

  5. **`InMemoryEventStore`（`packages/testkit`）のコンストラクタに
     `InMemoryMemoryStore` を必須引数として足す。** `InMemoryEventStore` は
     `events` 配列しか持っておらず、`InMemoryMemoryStore` への参照が無かった——
     PR #33 が `InMemoryVectorStore` に対して通した形（`memoryStore` を必須の
     コンストラクタ引数にする）と同じ配線を、外部キーを検査するために足す。
     **`FakeEventStore` は元から `FakeBackingStore`（`FakeMemoryStore` と共有）を
     持っているため、新しい配線は不要。**

  6. **線は「存在まで」に引く。「整合」（一対一等）までは広げない。**
     `contested_with_id` が双方向の対になっているか、`packages/core/src/__tests__/
     recall-pipeline.test.ts:373` 付近が意図的に作っている「一対一が破れた `contested`
     の鎖」のようなケースをここで拒むかどうかは、本 ADR の範囲外——それは ADR 0043
     （`unit_assembly_dropped`）が recall() の出力側で「黙らない」ことを担当している
     別の関心事であり、書き込み側で一対一を強制すると `recall-pipeline.test.ts` が
     意図的に作っている壊れたデータのテストと衝突する。**存在だけを見る理由は費用が
     段違いだから**——一対一・双方向の整合を書き込み時に強制するには、
     `contested_with_id` を持つすべての書き込み経路で対向側も同時に更新する必要があり、
     それは「本番で起きない振る舞いを緑にしない」という本 ADR の目的（存在確認）を
     大きく超える設計変更になる。

  7. **`MemoryStoreConformanceOptions.prepareRecallId`（`packages/testkit/src/
     memory-store-conformance.ts`）と `EventStoreConformanceOptions.prepareMemoryId`
     （`packages/testkit/src/event-store-conformance.ts`）を、省略可から必須に変える。**
     ADR 0034 が `VectorStoreConformanceOptions.prepareMemoryId` に対して通した形と
     揃える——省略時の既定値（固定文字列 `"recall-1"` / `mem-fixture-N`）は「実体を
     作らない」ことを前提にしていたが、その前提を本 ADR が壊した。省略可のオプションの
     ままにすると、「外部キーを実際に検査できる adapter 登録」と「検査できない adapter
     登録」が同じ緑色の出力になる——ADR 0011/0025/0027/0028/0034 が繰り返し破った
     「名乗れる以上の精度を主張する」族を、フックの省略という形で再現することになる。

  8. **`packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts` の配線を
     直す。** `describeMemoryStoreConformance` に `prepareRecallId`
     （`InMemoryMemoryStore.createRecall` で実在の recall を作る）を、
     `describeEventStoreConformance` に `prepareMemoryId`
     （新しい `InMemoryMemoryStore` を作り、実在の Memory を作ってその id を返す）を
     それぞれ足す。

  9. **各適合テストに「存在」の歯を足す（postgres と in-memory の両方に走る）。**
     `memory-store-conformance.ts`（createMemory の FK 1/2/3 × 2 口、updateStatus/
     updateStatusWithEvent の FK 2、recordUsage の FK 4/5 = 7本）、
     `event-store-conformance.ts`（append の FK 7、`memoryId: null` を拒まないことの
     確認 = 2本）、`vector-store-conformance.ts`（upsert の FK 6 = 1本）。**すべて
     非対称**——「実在しない参照では失敗する」と「実在する参照では成功する」を同じ
     検査の中で見る（片方だけだと「常に失敗する」実装／「常に無視する」実装のどちらかを
     緑にしてしまう）。

     **⚠ `.rejects.toThrow()` を引数無しで使っている。** これはこのリポジトリの通常の
     規約（#29/#33/#49 が確立した「メッセージまで固定する」）からの意図的な逸脱である。
     理由: Postgres 側の失敗はドライバの外部キー違反（`code: '23503'`、Postgres 自身の
     文言をそのまま漏らす）、in-memory 側の失敗はこのリポジトリが書いた `Error` であり、
     **両者のメッセージを1つの正規表現に揃える理由も方法も無い**（#49 の「族Bの残り3つ」
     節が既に指摘した通り、寄せ先の例外が存在しない）。ここで測りたいのは「実在しない
     参照を渡すと必ず失敗し、実在する参照では必ず成功する」という一点であり、メッセージの
     一致ではない。

  10. **`packages/postgres/src/__tests__/foreign-key-violation.postgres.test.ts` を新設し、
      本 ADR の決め手そのものを実測する歯を1本置く。** `PostgresMemoryStore.recordUsage`
      に実在しない `recallId` を渡すと `code: '23503'`（外部キー違反）で失敗し、
      `store.createRecall` で発行した実在の `recallId` では成功することを、同じ検査の
      中で見る。**この歯は本 PR に残す**——「なぜ擬似物も揃えるのか」という本 ADR の
      根拠が repo に残る形にするため。

- **採らなかった案**:

  - **「規定しない」で済ませる（ADR 0042 の形を踏襲する）。** 却下。文脈節に書いた通り、
    ADR 0042 は Postgres が保証できないことを「規定しない」と書いた——**Postgres が
    既に外部キーとして保証している**本件にこの形を持ち込むと、「Postgres は守っているが
    契約上は守らなくてよい」という逆方向に弱い契約を作ってしまう。

  - **フックを省略可のまま残す（`prepareRecallId`/`prepareMemoryId` の既定値を残す）。**
    却下。#33/ADR 0034 が同じ族の失敗として既に潰した形——省略できると「外部キーを
    実際に検査できる adapter 登録」と「検査できない adapter 登録」が同じ緑色になる。

  - **`contested_with_id` の一対一整合まで書き込み時に強制する。** 却下。決定6に書いた
    通り、費用が段違い（対向側も同時に更新する必要がある設計変更）であり、
    `recall-pipeline.test.ts` が意図的に作っている壊れたデータのテスト（ADR 0043 の
    対象）と衝突する。「存在」と「整合」は別の問題であり、本 ADR は前者だけを扱う。

  - **7本のうち PR #49 が既に触れた2本（4・7）だけに適用する。** 却下。マネージャーの
    判断として本文に明記した通り、2本だけに適用すると「7本のうち2本にしか適用されて
    いない」という新しい非対称を作る——#47 が直した族（規約が基準を満たす口の3/9にしか
    適用されていなかった）と同じ形になる。

- **引き受ける負債**:

  - **擬似物のエラーメッセージと Postgres の外部キー違反のメッセージが揃っていない。**
    #29/#33/#49 が族A・族Bで確立した「メッセージまで固定する」規約からの意図的な逸脱
    （理由は決定9参照）。将来、型付きの `ForeignKeyViolationError` のような共通の例外
    型を作る判断が下されたら、この負債は解消できる——ただしそれは「既存規約の適用」では
    なく「新しい契約の設計」であり、#49 が族Bを保留した理由（本 ADR の文脈節）と同じ
    重さの判断になる。

  - **`InMemoryVectorStore.upsert`/`InMemoryEventStore.append`
    が `memoryStore.get(ctx, id)`（テナントでも絞る）で存在を確認しているのに対し、
    `FakeVectorStore.upsert`/`FakeEventStore.append` は `backing.memories.has(id)`
    （テナントを見ない）で確認しており、2系統の間で「存在」の定義が微妙に食い違う。**
    Postgres の外部キー自体はテナントを見ない（`memories.id` だけが PK）ため、
    `Fake*` 系列のほうが実際の制約に忠実——`InMemory*` 系列との差はこの PR が新規に
    作ったものではなく、`search`/既存コードが元々どちらの形を取っていたかを踏襲した
    結果である。実務上の影響は無いはず（すべての呼び出しが同一テナントの ctx を使う）だが、
    確かめていない。

- **確かめていないこと**:

  - **`packages/postgres` 側の適合テスト（新設した10本の存在検査の歯、および決め手の
    歯 `foreign-key-violation.postgres.test.ts` を含む）は、この作業環境に
    PostgreSQL/Docker/`DATABASE_URL` が無いため一度も実行していない。** 型検査
    （`tsc`）が通ることと、in-memory・Fake 側で同じ歯が通ることのみ確認した。
    **CI の `postgres` ジョブが唯一の実行環境である。**
  - Postgres 側の変異（本 PR が Postgres のコードに足したガードは無いため、正確には
    「Postgres の外部キー制約そのものを外す変異」）は、同じ理由で撃てていない。
    予測は PR 本文に記載し、予測であると明記する。
  - `recordUsage` が「実在する id と実在しない id を混ぜたとき、実在するほうも巻き添えで
    未挿入になるか」までは検査していない（`memory-store-conformance.ts` の当該テストの
    コメントに明記）——「存在」だけを見る本 ADR の線からは一歩踏み込んだ整合の話であり、
    範囲外とした。

- **これが覆るとしたら**:

  - `contested_with_id` の一対一整合を書き込み時に強制する設計判断が将来下されたら
    （ADR 0043 とは別に、書き込み経路そのものを締める判断）、本 ADR が引いた「存在まで」
    の線は「整合まで」に広げ直すことになる。
  - 型付きの共通例外（`ForeignKeyViolationError` 等）を導入する判断が下されたら、
    「引き受ける負債」に書いたメッセージの不一致は解消できる。
  - `MemoryStore` の公開 interface を締める（`recordUsage`/`createMemory` のシグネチャ
    自体に制約を持たせる）かどうかは別の判断として保留中——本 ADR はその判断を先取り
    していない。
