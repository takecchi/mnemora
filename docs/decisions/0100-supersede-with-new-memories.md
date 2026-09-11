# ADR 0100: `MemoryStore.supersedeWithNewMemories`（任意メソッド）— 新 Memory の作成と supersede を1トランザクションにまとめる口を足す（`reextract`/`consolidate` への配線は未着手）

- **状態**: 提起（実装は部分的。文脈節・決定7・「未着手の範囲」を参照）

- **文脈**:

  Issue #134。`docs/memory-model.md` §11 行5（Memory lifecycle 遷移表、`active → superseded`）
  は逐語でこう要求している:

  > 判定ロジック自体は非同期でよいが、書き込み（旧行の `status`/`superseded_by_id` 更新と
  > **新 Memory の作成**）は1トランザクションで完結させる。

  [ADR 0031](./0031-supersede-status-and-event-in-one-transaction.md) は `updateStatusWithEvent`
  を足し、(a) 旧行の `status` 更新 ↔ (c) `memory_events` への追記、の対を1トランザクションに
  まとめた。しかし ADR 0031 自身の doc コメントが明記する通り、**(b) 新 Memory の作成は
  範囲外のままである**:

  > また、docs/memory-model.md §11 行5 が規定する「旧行の status 更新と*新 Memory の作成*も
  > 1トランザクション」は**このメソッドの範囲外**——新しい Memory の作成（`createMemory`/
  > `createMemoryWithOutbox`）は別の呼び出しのままであり、このメソッドは既存 Memory の
  > status 更新とイベント追記の対だけを扱う（ADR 0031「これが覆るとしたら」参照）。

  そして ADR 0031「これが覆るとしたら」は、この隙間を埋める作業を名指しで将来へ送っていた:

  > 「旧行の status 更新と新 Memory の作成を1トランザクションにする」という
  > docs/memory-model.md §11 行5 の要求を実際に満たす必要が生じたら、
  > `updateStatusWithEvent` をさらに拡張する（あるいは別のメソッドを足す）かどうかを
  > 検討する新しい ADR が要る。

  **本 ADR がその新しい ADR である。** ADR 0031 の改訂ではなく、その隣に足す新しい決定——
  `updateStatusWithEvent` は変更しない（既存2メソッド `createMemoryWithOutbox` /
  `updateStatusWithEvent` は本 ADR でも一切変更していない）。

  `updateStatusWithEvent` の production 呼び手は3つ: `reextract`（`runtime.ts`）・`forget`
  （`runtime.ts`）・`consolidate`（`runtime.ts`）。このうち `forget` は §11 行9
  （「任意 → forgotten」、同期・新 Memory を作らない）の対象であり、**§11 行5 の未達を
  抱えていない**——`forget` は新しい Memory を一切作らないため、埋めるべき隙間がそもそも
  無い。本 ADR は `forget` を1バイトも変更しない。

  [ADR 0089](./0089-runtime-consolidate-shape.md)「これが覆るとしたら」は、この隙間が
  埋まったときに何をすべきかも既に書いていた:

  > `MemoryStore` に「作成と supersede を1トランザクション」の口が入ったとき。そのとき
  > `reextract` と `consolidate` の両方を新しい口へ寄せる判断が要る。**先回りして片方だけを
  > 寄せない。**

  この「両方寄せる」の要求と、本 ADR が実際にできたことの間には差がある——「未着手の範囲」
  節で正直に書く。

- **決定**:

  ## 決定1: `MemoryStore` に任意メソッド `supersedeWithNewMemories` を足す

  `packages/core/src/interfaces/memory-store.ts`:

  ```ts
  supersedeWithNewMemories?(
    ctx: Ctx,
    news: ReadonlyArray<{ input: NewMemory; jobKinds: OutboxJobKind[] }>,
    supersede: ReadonlyArray<{
      id: MemoryId;
      supersededById: MemoryId;
      expectedStatus?: MemoryStatus;
      event: NewMemoryEvent;
    }>,
  ): Promise<{
    created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
    superseded: MemoryEvent[];
    conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }>;
  }>;
  ```

  🔴 **`?` の任意メソッドにした。** 必須にすると `MemoryStore` を実装する第三者の adapter が
  壊れる——`@mnemora/core` は npm に `0.1.4` で公開済みであり、これは公開 API の破壊的変更に
  当たる（`docs/autonomy.md` §3「公開 API の破壊的変更」は「提起までにする」と定めている）。
  この口を実装しない adapter は、今日どおり `updateStatusWithEvent` + 別呼び出しの
  `createMemoryWithOutbox` の2段のままでよい。

  `news` を配列にした理由: `consolidate` は N→1 だが、`reextract` は候補ごとに
  `createMemoryWithOutbox` をループで呼び M件作る（`runtime.ts` の
  `createMemoriesFromCandidates`）。1件しか受け取らない形にすると `reextract` を寄せられない。

  意味論:
  - `news` の各要素は `createMemoryWithOutbox` と**同じ冪等経路**（ON CONFLICT。
    `created: false` ならジョブを積まない）。
  - `supersede` の各要素は `updateStatusWithEvent` と**同じ CAS 意味論**——ただし `status` は
    常に `"superseded"` に固定される（このメソッドは supersede 専用であり、任意の status への
    更新は今日どおり `updateStatus`/`updateStatusWithEvent` を使う）。
  - 🔴 **CAS に弾かれた対象は例外にしない。** `conflicted` に `{ id, observedStatus }` として
    積み、**トランザクションは commit する**。ADR 0031「採らなかった案」（supersede ループ
    全体を1トランザクションにする案の却下——「1件の競合」を「全部やらなかった」に化けさせ
    ない、ADR 0030 安全弁3）を本メソッドは覆さない。**この却下を覆さずに §11 行5 を満たすのが
    この設計の要である**——「複数対象のトランザクション」と「1対象内の news+supersede の
    トランザクション」は別の粒度であり、後者だけを閉じる。
  - 🔴 **`supersede[].id` の行がそもそも存在しない場合は、今日の `updateStatusWithEvent` と
    同じ「memory not found」の `Error` を投げる。** このときトランザクション全体がロール
    バックされ、**`news` の作成も巻き戻る**。⛔ **`conflicted` には混ぜない**——「CAS で
    弾かれた」（行はあるが status が期待と違った）と「行が無い」は別の「無い」であり、
    潰すとこの設計の要が壊れる。
  - `supersededById` の外部キー相当は [ADR 0047](./0047-fake-referential-integrity-existence-only.md)
    の線どおり「存在」まで検査する（一対一等の整合までは踏み込まない）。

  ⚠ **これは振る舞いの変更である。** 今日（`updateStatusWithEvent` を単独で呼ぶ経路、
  `reextract`/`consolidate` の現行実装）は、対象が存在しない場合でも、直前に別途呼んでいた
  `createMemoryWithOutbox` の作成はすでに commit 済みで残る。このメソッドを経由すると、
  その作成も巻き戻る——「引き受ける負債」に明記する。

  🔴 **`atomicity` に相当する概念について**: マネージャーの元設計は `ReextractResult`/
  `ConsolidationResult` に `atomicity: 'store_supported' | 'store_unsupported'` を足すことを
  求めていたが、これは `reextract`/`consolidate` が実際にこの口を呼ぶ配線（決定3、下記）が
  無いと意味を持たない——**この PR ではその配線ができなかったため、`atomicity` フィールドは
  足していない。**理由は「未着手の範囲」節に書く。

  ## 決定2: 3つの実装

  - `packages/postgres/src/memory-store.ts`: `db.transaction()` で包む。中身は既存の
    `createMemoryWithOutbox` の INSERT/outbox と `updateStatusWithEvent` の条件付き UPDATE +
    `memory_events` INSERT と同じ形（コピペ。**既存2メソッドは1バイトも変更していない**）。
    `news` を先に処理し、`supersede` を後に処理する——書く順序で被害を最小にする
    （ADR 0089 決定5 と同じ理由: 途中で落ちても、統合先が無いのに旧行だけ `superseded_by_id`
    が指す先を失う、という最悪の状態を避ける）。`supersededById` の外部キーは
    `memories.superseded_by_id` の実 FK（`0001_init.sql`）がそのまま検査する——`news` の
    INSERT は同一トランザクション内で先に実行されているため、`supersededById` が同じ
    呼び出しの `news` を指していても FK 違反にはならない（Postgres は同一トランザクション内の
    自分の書き込みを見る）。
  - `packages/testkit/src/__fixtures__/in-memory-memory-store.ts`: `await` を挟まない同期区間で
    行う。in-memory にトランザクションは無いため、「まだ何も書いていない」ことでロール
    バックを模す——`supersede[].id`/`supersededById` の存在検査を、`news`/`supersede` の
    どちらにも1バイトも書き込む前に**すべて先に**済ませる。
  - `packages/core/src/__tests__/runtime-fakes.ts`: `FakeMemoryStore` にも同じ形で実装した
    （`backing` を共有する既存の形に揃える）。`beforeUpdateStatus`（PR #28 が TOCTOU を
    決定的に再現するために置いたテスト専用の差し込み口）は `supersede` の各要素について
    CAS 判定の直前に発火するようにした——`updateStatus`/`updateStatusWithEvent` と同じ位置
    （ADR 0031 決定8 と同じ理由: この口を経由しても TOCTOU 再現のフックが死なないようにする）。

  ⚠ **postgres と in-memory/Fake のあいだに、`supersededById` の検査タイミングについて
  非対称がある。** postgres は実 FK 制約により UPDATE 実行時に検査するため、`supersededById`
  が同じ呼び出しの `news` を指していても通る（トランザクション内で先に INSERT 済みだから）。
  in-memory/Fake は「ロールバックを模す」ために**すべての存在検査を `news` 作成より前に**
  行うため、`supersededById` が同じ呼び出しの `news`（まだ Map に無い）を指すケースを
  サポートしない。**この非対称は、現在どの呼び出し元もこの形を必要としていないために
  実害が無い**（決定3・「未着手の範囲」参照）——`reextract`/`consolidate` がこの口へ
  実際に寄せられたときに、初めて意味を持ちうる差である。

  ## 決定3: 適合テスト

  `packages/testkit/src/memory-store-conformance.ts` の `MemoryStoreConformanceOptions` に
  `supportsSupersedeWithNewMemories: boolean` を**必須**で足した。ADR 0031 決定9 /
  ADR 0047 決定9 と同じ判断——省略可にすると「検査した」adapter と「していない」adapter が
  同じ緑色になる。`true` なら原子性の歯（成功・`news` 複数件／CAS 競合が `conflicted` に出て
  他は commit される／対象不在で「memory not found」・`news` の作成ごとロールバック／
  `supersededById` の外部キー）を実行し、`false` なら
  `expect(store.supersedeWithNewMemories).toBeUndefined()` を積極的に assert する
  （`it.skip` にはしない）。`conformance.postgres.test.ts`・
  `in-memory-fixtures.conformance.test.ts` の両方に `supportsSupersedeWithNewMemories: true`
  を渡した——両実装ともこの口を実装しているため。

  `packages/core/src/__tests__/fake-memory-store-supersede-with-new-memories.test.ts` を
  新設した。`FakeMemoryStore` は `packages/testkit` の適合テストの対象ではない
  （`runtime-fakes.ts` 冒頭のコメント: core は testkit に依存しない）ため、
  ADR 0047「実装後に判明したこと」が踏んだ穴——ガードを実装しても、それを守る歯が
  `packages/core` 側に無ければ変異を入れても赤くならない——を、この新設ファイルで埋める。

  `packages/postgres/src/__tests__/memory-store-supersede-with-new-memories-transaction.test.ts`
  を新設した。`memory-store-update-status-with-event-transaction.test.ts`（ADR 0031）の
  構えに倣い、別々の `Pool` を4本立てて本物の並行を確認する。CI の postgres ジョブでしか
  走らない（「確かめていないこと」参照）。

  ## 決定4: postgres 実装は `supersede[].status` を持たない

  `updateStatus`/`updateStatusWithEvent` と違い、`supersede` の各要素は遷移先の `status` を
  引数に取らない——常に `"superseded"` に固定する。このメソッドの名前と目的
  （§11 行5 が名指しする `active → superseded` の遷移）を型でも表す。任意の status への
  遷移をこの口で行いたくなったら、それは別の口・別の判断である。

  ## 決定5: `MemoryEvent`/`NewMemoryEvent` の形は変えない

  `supersede[].event` は既存の `NewMemoryEvent` をそのまま使う。呼び出し側
  （将来 `reextract`/`consolidate` が寄せられたとき）が `kind: "superseded"` の
  イベントを組み立てて渡す——このメソッド自身は `kind` を検査・強制しない
  （`updateStatusWithEvent` も同様に検査していない）。

  ## 決定6: `news` の `created` イベント（`kind: "created"`）はこのメソッドの範囲外

  `createMemoriesFromCandidates`（`runtime.ts`）は、`createMemoryWithOutbox` の呼び出しの
  **あと**に、別途 `eventStore.append(..., { kind: "created" })` を呼んでいる——これは
  Memory の作成そのものと同一トランザクションではない、既存の非対称（本 ADR が作った
  ものではない）。`supersedeWithNewMemories` は `news` の作成（memories + outbox）だけを
  担い、`created` イベントの追記は呼び出し側の責務のまま据え置く。理由: `createMemoryWithOutbox`
  自身も `created` イベントを書かない契約であり（`memory-store.ts` の doc コメント参照）、
  `supersedeWithNewMemories` はその契約をそのまま踏襲するのが最小の変更である。
  `created` イベントまでこのメソッドに含めると、`MemoryStore` の責務がさらに1段広がり
  （「Memory 作成 + outbox + 任意個のイベント追記」）、かつ既存の非対称（作成とイベントは
  別コミット）を暗黙に是認することになる——本 ADR の範囲外の判断であり、埋めるなら
  別の ADR で決めるべきである。

  ## 決定7: 🔴 `reextract`/`consolidate` への配線はできなかった（未着手）

  ADR 0089「これが覆るとしたら」の要求——「`reextract` と `consolidate` の両方を新しい口へ
  寄せる。先回りして片方だけを寄せない」——に対して、**本 PR はどちらの呼び手も寄せていない。**
  「未着手の範囲」節に理由を書く。**これは設計判断ではなく、実装を進める前に見つかった
  ブロッキングな技術的ギャップの結果である。**

- **未着手の範囲、その理由（🔴 最重要）**:

  `runtime.ts` の `reextract`/`consolidate` の supersede ループを
  `deps.memoryStore.supersedeWithNewMemories` 経由へ寄せるには、呼び出し側が
  `supersede[].supersededById`（= 新しく作る統合先/代表 Memory の id）を、
  **`supersedeWithNewMemories` を呼ぶ前に**組み立てられる必要がある。

  しかし `NewMemory` 型（`packages/core/src/memory.ts`）は `id` を含まない
  （`Omit<Memory, "id" | ...>`）——Memory の id は常に store 側が採番する
  （postgres は `gen_random_uuid()` を INSERT 文の中で発行する、
  `packages/postgres/src/memory-store.ts` 実測）。`reextract`（`supersededById =
  memoryIds[0]`、今回作った最初の新 Memory の id）も `consolidate`
  （`supersededById: consolidatedMemory.id`、統合先の id）も、**その id は
  `createMemoryWithOutbox` が実際に行を作ったあとにしか手に入らない。**

  `supersedeWithNewMemories` は `news`（新 Memory の作成）を呼び出しの**内側**で行う設計
  であり、呼び出し側は `news` の要素がどんな id を得るか、呼ぶ**前**には知りようがない。
  ⟹ `reextract`/`consolidate` の実際の使われ方（supersede される旧行の `supersededById` が、
  同じ呼び出しで新しく作られる Memory の id を指す）を、この口の型シグネチャでは表現できない
  ——`supersede[].supersededById: MemoryId` は呼び出し前に確定した文字列を要求するが、
  その文字列の元になる Memory がまだ存在しないため作れない。

  この矛盾を埋める案はいくつか考えられるが、**どれも本 ADR が受け取った設計の変更を伴う**
  ため、実装せずにここへ書く（マネージャーの指示「迷ったら実装せずに報告してください」に従う）:

  - `RuntimeDeps` に client 側 id 生成器（例: `generateId: () => string`）を足し、
    `runtime.ts` が `news` の id を事前に生成して `NewMemory` に含める。
    ⟹ `NewMemory`/`Memory` の形を変える必要がある（`id` を任意の入力にする）。
  - `supersede[].supersededById` を `MemoryId` ではなく、「`news` の何番目か」を指す索引
    （例: `{ newsIndex: number } | { id: MemoryId }` のような判別可能ユニオン）に変える。
    ⟹ 本 ADR が受け取った型シグネチャ（マネージャー承認済み）を変えることになる。
  - `reextract`/`consolidate` の**アンカーとなる1件**（`reextract` の `memoryIds[0]`、
    `consolidate` の統合先）だけを先に `createMemoryWithOutbox` で作り、残りの `news`
    （`reextract` の場合、候補2件目以降）と `supersede` だけをこの口へ寄せる。
    ⟹ **アンカー自身の作成は §11 行5 の対象外のまま**（それが `supersededById` の指す先
    そのものであり、最も重要な1件）になる。`consolidate` は N→1（アンカーが常に1件）なので、
    この案では `consolidate` の `news` が常に空になり、**この口を呼ぶ意味が無くなる**。

  **本 ADR は上のどれも選ばない。**技術的に決められる範囲を超え、公開 API
  （`NewMemory`/`RuntimeDeps`/この口の型シグネチャ自体）の形に関わる判断であり、
  `docs/autonomy.md` §3「公開 API の破壊的変更」「提起までにする」に従い、
  **オーナーの判断を仰ぐ。**

  ⟹ **本 PR がここまでで足したのは、決定1〜6（`MemoryStore` への口の追加・3実装・
  適合テスト）だけである。** `reextract`/`consolidate` は今日の経路（`updateStatusWithEvent`
  を supersede ループの中で1件ずつ呼ぶ、`createMemoryWithOutbox` は別呼び出し）のまま、
  1行も変更していない。`ReextractResult`/`ConsolidationResult` に `atomicity` フィールドは
  足していない——足しても常に `'store_unsupported'`（呼んでいないので）になり、
  「口を実装している adapter の上でも実際には使われていない」という第三の状態を
  `'store_unsupported'` の意味（「口が無い」）に紛れ込ませることになるため。

- **守れないもの**:

  🔴 **任意メソッドである以上、サードパーティのアダプタの上では §11 行5 は恒久的に満たされ
  ない。** 将来 `store_unsupported`/`store_supported` のような値を実際に導入したとしても、
  それは未達を見えるようにするだけで、直さない。⟹「ADR 0100 が入ったから §11 行5 は
  守られている」と読まないこと——守られるのは口を実装したアダプタの上だけである。

  さらに本 PR の時点では、**口を実装した `packages/postgres`/`packages/testkit` の上でも
  §11 行5 は満たされていない**——`reextract`/`consolidate` がこの口を呼んでいないため
  （決定7・「未着手の範囲」）。今日の production 経路は ADR 0089 決定5・ADR 0031
  「引き受ける負債」がすでに認めている未達のままである。

- **未決の問い**:

  `docs/memory-model.md` §11 行5 は*すべての*アダプタに要求しているのか、それとも口を
  実装したアダプタにだけか。**これはオーナーの判断であり、この ADR では決めない**
  （⛔ 正典を書き換えないこと）。

  加えて本 ADR 固有の問い: 「未着手の範囲」に挙げた3案（client 側 id 生成器を足す／
  supersede の参照を索引に変える／アンカーだけ先に作る）のうち、どれを選ぶか
  （あるいは他の案があるか）は**オーナーの判断が要る**——`docs/autonomy.md` §3
  「公開 API の破壊的変更」に該当する。

- **採らなかった案**:

  - **`supersedeWithNewMemories` を必須メソッドにする。** 却下。`@mnemora/core` は npm に
    `0.1.4` で公開済みであり、必須にすると第三者の adapter 実装を壊す破壊的変更になる
    （`docs/autonomy.md` §3）。
  - **`updateStatusWithEvent` を拡張して `news` も受け取れるようにする。** 却下。
    `updateStatusWithEvent` は「既存1件の status 更新 + イベント1件」という単純な契約を
    持っており、`news`（複数件の新規作成）を混ぜると、CAS 意味論（1件の compare-and-swap）
    と「複数件の作成」という別の関心事が1つのメソッドに同居する。ADR 0012 D-ingest-1 の
    前例（「同一トランザクションで行う必要がある2つの書き込みを、その組み合わせに特化した
    メソッドとして持たせる」）に従い、**別のメソッドを新設する**ほうが、既存の呼び出し元
    （`forget` 等）への影響が無い。
  - **`news` を1件だけ受け取る形にする。** 却下。決定1に書いた通り、`reextract` は
    候補ごとに M件の Memory を作る——1件だけだと `reextract` を寄せられない。
  - **supersede ループ全体を「全部か無か」の1トランザクションにする。** 却下。
    ADR 0031「採らなかった案」がすでに同じ判断を下しており（CAS の意味を壊す。
    ADR 0030 安全弁3と正面衝突）、マネージャーの指示（🔴 外せない線）もこれを明示的に
    禁じている。
  - **`reextract`/`consolidate` のどちらか片方だけを寄せる。** 却下——ただし本 ADR は
    **どちらも寄せられなかった**（決定7）。「片方だけ寄せる」を意図的に選んだわけではなく、
    両方とも同じ技術的ギャップ（新 Memory の id を呼び出し前に知れない）に当たったため、
    両方とも寄せなかった。ADR 0089「これが覆るとしたら」の「先回りして片方だけを寄せない」
    は守られている（片方も寄せていない）が、両方寄せるという目標も達成できていない。
  - **返り値をより richer にするだけで済ませる。** 却下。ADR 0031 と同じ理由——
    永続化された不整合は返り値では消えない。
  - **`conflicted`（CAS で弾かれた）と「行が無い」を1つの語彙に潰す。** 却下。
    マネージャーの指示どおり、「CAS で弾かれた」と「行が無い」は別の「無い」であり、
    潰すとこの設計の要——「1件の競合を全部やらなかったに化けさせない」——が壊れる。
  - **`atomicity: 'transactional'` のような名前にする。** 却下（マネージャーの指示）。
    この値は原子性の証拠ではなく、口の有無の写しにすぎない——ただし本 PR では
    このフィールド自体を追加していない（決定1・決定7）。

- **引き受ける負債**:

  1. 🔴 **決定7の未着手**: `reextract`/`consolidate` がこの新しい口を呼んでいない。
     §11 行5 は production 経路上、**本 PR の後も満たされていない**——ADR 0089 決定5・
     ADR 0031「引き受ける負債」がすでに認めていた未達がそのまま残る。本 ADR が足したのは
     「口」だけであり、「口を実際に使う配線」はオーナーの判断（未決の問い）を待つ。
  2. **振る舞いの変更**: `supersedeWithNewMemories` を経由すると、supersede 対象が
     存在しない場合に `news` の作成も巻き戻る。今日（`updateStatusWithEvent` 単独呼び出し）
     は、直前に別途行った Memory 作成は commit 済みで残ったままだった。この口を将来
     `reextract`/`consolidate` に配線したとき、初めてこの振る舞いの変更が実際に効いてくる。
  3. **postgres と in-memory/Fake のあいだの `supersededById` 検査タイミングの非対称**
     （決定2）。postgres は `supersededById` が同じ呼び出しの `news` を指せる
     （FK がトランザクション内の自分の書き込みを見るため）が、in-memory/Fake はロール
     バックを模すために事前検査するので指せない。現在どの呼び出し元もこの形を必要と
     していないため実害は無いが、将来この口へ配線するときに顕在化しうる。
  4. **`created` イベント（`kind: "created"`）の追記はこのメソッドの範囲外のまま**
     （決定6）——既存の非対称（Memory 作成と `created` イベント追記が別コミット）を
     本 ADR は是正していない。

- **歯について**:

  基準線（`main` の head `59711d1` で実測）:

  ```
  root vitest      : Test Files 18 / Tests 314
  packages/core    : Test Files 36 / Tests 515
  packages/testkit : Test Files  3 / Tests 213
  packages/openai          : Test Files 7 (1 skipped) / Tests 54 (11 skipped)
  packages/anthropic       : Test Files 5 (1 skipped) / Tests 51 (2 skipped)
  packages/local-embedding : Test Files 6 (1 skipped) / Tests 88 (14 skipped)
  ```

  本 PR 後（実測。DB 不要な6パッケージすべてで `--maxWorkers=2` を指定し2回走らせ、
  両方とも同じ値であることを確認済み）:

  ```
  root vitest      : Test Files 18 / Tests 314   （変わらず）
  packages/core    : Test Files 37 / Tests 519   （+1 file / +4 tests:
                       fake-memory-store-supersede-with-new-memories.test.ts）
  packages/testkit : Test Files  3 / Tests 217   （+4 tests:
                       memory-store-conformance.ts の supersedeWithNewMemories 系）
  packages/openai          : Test Files 7 (1 skipped) / Tests 54 (11 skipped)   （変わらず）
  packages/anthropic       : Test Files 5 (1 skipped) / Tests 51 (2 skipped)    （変わらず）
  packages/local-embedding : Test Files 6 (1 skipped) / Tests 88 (14 skipped)   （変わらず）
  ```

  `packages/postgres` は `test:db`（`DATABASE_URL` 必須）しか持たず、この器では実行して
  いない——`conformance.postgres.test.ts` の追加分（`supportsSupersedeWithNewMemories:
  true` で走る4本）と、新設した
  `memory-store-supersede-with-new-memories-transaction.test.ts`（2本）は、CI の postgres
  ジョブが唯一の実行環境である。

  DB 不要な変異を6本撃った（すべて `cp` で退避したコピーから戻し、`diff` で byte 単位の
  一致を確認してから次に進んだ——`git checkout --` は使っていない。`docs/autonomy.md` §4
  「`git checkout <file>` で変異を戻すと未コミットの編集も一緒に消える」を避けるため）:

  | # | 変異 | 対象 | 当たったか | 赤くなった本数（総数） | 一意に捕まえた歯 | 赤の出どころ | `AssertionError` か |
  |---|---|---|---|---|---|---|---|
  | M1 | `supersede[].id` の not-found チェックを削除 | `InMemoryMemoryStore` | 当たった | testkit 217本中1本 | 「対象がそもそも存在しなければ throw…」の歯 | `expected [Function] to throw error matching /memory not found for tenant/ but got 'Cannot read properties of undefined (reading 'status')'` | Yes（`.rejects.toThrow()` の不一致） |
  | M2 | CAS 判定を `if (false && ...)` で無効化 | `InMemoryMemoryStore` | 当たった | testkit 217本中1本 | 「CAS に弾かれた対象を conflicted に積み…」の歯 | `expected [] to deeply equal [ { id: 'mem-96', … } ]`（`toEqual`） | Yes |
  | M3 | `supersededById` の外部キー検査を `if (false && ...)` で無効化 | `InMemoryMemoryStore` | 当たった | testkit 217本中1本 | 「実在しない supersededById に対して失敗し…」の歯 | `.rejects.toThrow()` が満たされず（resolve してしまった） | Yes |
  | M4 | CAS 競合を `conflicted.push` の代わりに `throw new MemoryStatusConflictError(...)` にする | `InMemoryMemoryStore` | 当たった | testkit 217本中1本 | 「CAS に弾かれた対象を conflicted に積み、他の news/supersede は commit される」の歯 | `MemoryStatusConflictError: MemoryStore.updateStatus: expected status "active" for memory mem-96, but observed "archived"` | **No**（`expect().rejects` で包んでいない箇所の素の例外伝播——テストが `await` した呼び出しそのものが reject し、アサーション不一致ではなく例外そのものでテストが落ちた） |
  | M5（赤くなってはいけない） | `for (const { input, jobKinds } of news)` を `for (const newsItem of news) { const { input, jobKinds } = newsItem; }` に書き換え（ふるまい不変） | `InMemoryMemoryStore` | ✅ 緑のまま（217本全部通過） | — | — | — | — |
  | M6 | `supersede[].id` の not-found チェックを削除 | `FakeMemoryStore` | 当たった | core 519本中1本 | `fake-memory-store-supersede-with-new-memories.test.ts` の「対象がそもそも存在しなければ throw…」の歯 | `expected [Function] to throw error matching /memory not found for tenant/ but got 'Cannot read properties of undefined (reading 'status')'` | Yes |

  各行について:
  - **⓪** 6本とも変異ごとに `git diff --stat`（実質は `diff` コマンドでの比較、後述）が
    非空であることを確認した。
  - **①** 6本とも「当たった」（M5 を除く。M5 は「赤くなってはいけない」変異であり、
    意図どおり緑のまま）。`SKIP` になったものは無い。
  - **②** 走ったテスト総数は基準線と一致したまま（testkit 217・core 519）で、赤くなった
    本数だけが変わった——変異以外の要因でテストの発見・実行自体が変わっていないことの確認。
  - **③** 各変異は、対応する新設の歯1本だけを一意に捕まえた（他の216本/518本は変異の
    影響を受けずに通り続けた）。
  - **④** M1・M2・M3・M6 は `AssertionError`（`expect().rejects.toThrow()`/`toEqual()`
    の不一致）。**M4 だけは違う**——`conflicted.push` を `throw` に変えたことで、
    テストコード（`expect(result.conflicted).toEqual(...)` で包む前）の `await
    store.supersedeWithNewMemories(...)` 自体が reject し、`MemoryStatusConflictError` が
    テストランナーへ直接伝播した。これも「歯が捕まえた」の一種だが、`AssertionError` では
    ない——表にそのまま記録する。
  - **⑤** M5（「赤くなってはいけない」変異）が緑のままであることは、M1〜M4・M6 が赤である
    ことと同じくらい重要である——歯が実装の*形*（分割代入の位置）ではなく*ふるまい*を
    測っていることの確認。

  🔴 **`atomicity` を常に `'store_supported'` にする変異、および「任意メソッドが投げた
  ときに今日の経路へフォールバックする」変異は、この PR では実行していない。** どちらも
  マネージャーが指定した必須の変異だが、対応するコード自体（`atomicity` フィールド・
  `runtime.ts` の配線）を本 PR は実装していない（決定7・「未着手の範囲」）ため、撃つ対象が
  存在しない。これは「変異試験を省いた」のではなく、**その前段の実装が完了していないために
  発生した構造的な欠落**であり、実装が完了した時点で必ず撃つべき変異として、ここに明記して
  引き継ぐ。

- **確かめていないこと**:

  - **`packages/postgres` の新設した歯**（`conformance.postgres.test.ts` の
    `supersedeWithNewMemories` 系4本、`memory-store-supersede-with-new-memories-
    transaction.test.ts` の2本）は、この作業環境に Docker/PostgreSQL/`DATABASE_URL` が無く、
    一度も実行していない。型検査（`tsc`）が通ることのみ確認した。**CI の postgres ジョブが
    唯一の実行環境である。**
  - **`db.transaction()` が本物のロールバックとして機能すること自体**（`supersede[].id`
    が存在しないときに `news` の INSERT を一切コミットしないこと）は、CI の postgres
    ジョブで初めて実測される。
  - **本物の並行**（複数プロセスが実際に同時にネットワーク越しで INSERT/UPDATE を撃つ
    ときのタイミング）で、「ちょうど1本だけ conflicted が空になる」という前提が崩れない
    ことも、CI 上で初めて実測される。
  - **決定2で触れた postgres と in-memory/Fake の非対称**（`supersededById` が同じ呼び出しの
    `news` を指せるかどうか）を実際に踏むテストは書いていない——現在どの呼び出し元も
    この形を必要としていないため（「未着手の範囲」）。
  - **`reextract`/`consolidate` を実際にこの口へ寄せた場合の振る舞い**は、決定7の技術的
    ギャップにより実装できておらず、当然ながら測っていない。
  - **本物の Postgres に対して `supersedeWithNewMemories` を1件も走らせていない**——
    型検査と in-memory/Fake の歯のみで検証した。

- **これが覆るとしたら**:

  - オーナーが「未決の問い」に答え、「未着手の範囲」の3案（またはそれ以外の案）のいずれかを
    選んだとき、`reextract`/`consolidate` の配線（決定7）と `atomicity` フィールドの追加
    （ADR 0031 の元の要求）を実装する新しい PR が要る。そのとき、本 ADR「歯について」に
    明記した2本の必須変異（`atomicity` を常に `'store_supported'` にする／任意メソッドが
    投げたときにフォールバックする）を必ず撃つこと。
  - CI の postgres ジョブで「確かめていないこと」に挙げた項目が実測され、前提が崩れる
    ことが分かったら、決定1〜2の設計を再検討する必要が生じる。
  - `docs/memory-model.md` §11 行5 が「口を実装したアダプタにだけ要求している」と
    オーナーが判断したら、「守れないもの」節の解釈が確定し、サードパーティ adapter
    向けの案内（例: README・移行ガイド）を別途書く判断が要る。
