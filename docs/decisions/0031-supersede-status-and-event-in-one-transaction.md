# ADR 0031: `reextract` の supersede が status 更新とイベント追記を別々の2コミットで行っていたのを、1つのメソッド・1トランザクションにまとめる

- **状態**: 採用 (2026-09)

- **文脈**:

  マネージャーが現物で確認した事実として渡された、次の1点を直す。

  `packages/core/src/runtime.ts` の `reextract` の supersede ループは、対象 Memory 1件ごとに

  ```
  updateStatus(ctx, existing.id, "superseded", { supersededById, expectedStatus: "active" })  // コミット1
  eventStore.append(ctx, { kind: "superseded", ... })                                          // コミット2
  ```

  という**2つの別コミット**を呼んでいた。ADR 0030 が `updateStatus` を compare-and-swap に
  したことで「読んでから書くまでの間の TOCTOU」は塞がれたが、それとは別の穴——
  **コミット1が成功しコミット2が失敗した場合、行は永久に `superseded` のまま、対応する
  `superseded` イベントは永久に存在しない**——は残ったままだった。これは返り値
  （`ReextractResult`）をいくら richer にしても消えない、*永続化された*不整合である。

  正典はこれを既に禁じている:
  - [docs/memory-model.md](../memory-model.md) §11 の Memory lifecycle 遷移表、行5
    （`active → superseded`）: 「書き込み（旧行の `status`/`superseded_by_id` 更新と
    新 Memory の作成）は1トランザクションで完結させる」。
  - [docs/architecture.md](../architecture.md) §3.2「破棄系 — `forget(ctx, target)`」・
    §5.8: 「`forget()` は `MemoryStore.updateStatus` と `EventStore.append` を同一
    トランザクションで行う。リポジトリ層を通らない削除経路を作らない」。

  [AGENTS.md](../../AGENTS.md)「正典と実装が食い違ったら」の規約どおり、バグなのは
  実装のほうである。

  **この PR で直すのは `reextract` の supersede ループのこの1点だけ。** 他の
  「読んでから書く」箇所・他の状態遷移（`archived`・`contested` 解決等）の同種の穴は
  範囲外——マネージャーが別途住所を作る。

- **決定**:

  1. **ADR 0012 D-ingest-1 の前例に厳密に従う。** D-ingest-1 は「同一トランザクションで
     行う必要がある2つの書き込みを、その組み合わせに特化したメソッドとして
     `MemoryStore` に持たせる」（`createObservationWithOutbox`・`createMemoryWithOutbox`）
     と決め、「`Ctx` に加えて明示的な『トランザクションハンドル』を core の型として持つ」
     案を**却下済み**——トランザクションハンドルの型は adapter ごとに異なり、core に
     置くと adapter 固有の型が core に漏れる。本 ADR はこの決定を覆さない。
     `MemoryStore` に `updateStatusWithEvent` を追加する。命名は
     `createObservationWithOutbox`/`createMemoryWithOutbox` に揃えた。

     ```ts
     updateStatusWithEvent(
       ctx: Ctx,
       id: MemoryId,
       status: MemoryStatus,
       opts: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
       event: NewMemoryEvent,
     ): Promise<{ memory: Memory; event: MemoryEvent }>;
     ```

  2. 🔴 **守る不変条件**: **`memories.status` の更新が永続化されたことと、対応する
     イベントが永続化されたことは、同値である。** 契約（既存の `updateStatus` と共通の
     部分は同じ意味論）:
     - `opts.expectedStatus` を渡すと compare-and-swap になる。弾かれたら
       `MemoryStatusConflictError` を投げ、**status の更新もイベントの追記も一切起きない**。
     - `opts.expectedStatus` を省略すると、`updateStatus` の省略時と同じく無条件に更新し、
       イベントも追記する。
     - 対象の Memory が存在しなければ、`expectedStatus` の有無に関わらず今日と同じ
       「memory not found」の `Error`（イベントは積まれない）。
     - **既存の `updateStatus` は変更していない。** status だけを更新したい呼び出し元
       （`archived`/`forgotten` への遷移等）はそのまま使える。

  3. 🔴 **買わない不変条件**を明示する:
     - **「N 件の supersede を全部やるか全部やらないか」は買わない。** トランザクションは
       **対象1件ごと**に閉じる。`reextract` のループが k 件目で CAS に弾かれても、
       1..k-1 件目の supersede は巻き戻らない——これは本 PR が作った負債ではなく、
       ADR 0030 の時点から存在する構造（ADR 0030「引き受ける負債」に既述）。
     - **docs/memory-model.md §11 行5 が規定する「旧行の status 更新と*新 Memory の作成*も
       1トランザクション」は覆っていない。** `updateStatusWithEvent` は既存 Memory の
       status 更新とイベント追記の対だけを扱う。新しい Memory の作成
       （`createMemory`/`createMemoryWithOutbox`）は `reextract` の中で別の呼び出しの
       ままである。この住所はマネージャーが別途作る。

  4. `packages/core/src/runtime.ts` の `reextract` supersede ループ: `updateStatus` +
     `eventStore.append` の対を `updateStatusWithEvent` の1呼び出しに置き換える。
     **`try/catch` / `classifySupersedeFailure` / `continue` / `supersededMemoryIds.push`
     という既存の構造は一切変えていない**——最初の競合で throw して全体を止めることは
     しない。競合は `ReextractSkip.status_changed_concurrently` という正常な結果のまま
     （ADR 0030 の安全弁3をそのまま継ぐ）。イベントの中身（`kind`・`actor`・
     `digestSnapshot`・`meta` の各フィールド）もミリも変えていない。

  5. **原子性と CAS の干渉を避ける。** トランザクションが対象1件ごとに閉じるため、
     k 件目が競合しても 1..k-1 は巻き戻らない。`supersededMemoryIds` と `superseded`
     イベントは、**実際に永続化されたものと厳密に一致する**——CAS に弾かれた対象は
     `updateStatusWithEvent` 自身が「status もイベントも一切変えない」ことを保証する
     ため、`skipped` に積んで `supersededMemoryIds`/イベント追記から除外する既存の
     ロジックがそのまま正しく機能する。

  6. `packages/postgres/src/memory-store.ts`: `db.transaction()`
     （`createObservationWithOutbox`/`createMemoryWithOutbox` と同じ形、ADR 0012）で
     包む。中身は既存 `updateStatus` の条件付き UPDATE（0行時の読み直しによる
     「対象が無い」/`MemoryStatusConflictError` の切り分けを含む）と、
     `packages/postgres/src/event-store.ts` の `append` と同じ形の `memory_events` への
     INSERT。トランザクション内で throw すればロールバックされる。

  7. `packages/testkit/src/__fixtures__/in-memory-memory-store.ts`: `events: MemoryEvent[]`
     を公開した。`outboxJobs`（`InMemoryOutboxStore` と共有する既存の前例）と同じ形で、
     `InMemoryEventStore`（コンストラクタで既存配列を受け取れるようにした）と共有する。
     意味論: **先に CAS を判定し、弾かれるなら何も書き換えず・何も積まない。通るなら
     両方やる。** `NewMemoryEvent → MemoryEvent` の組み立てロジックは
     `buildStoredMemoryEvent`（`in-memory-event-store.ts`）に切り出し、
     `InMemoryEventStore.append` と `InMemoryMemoryStore.updateStatusWithEvent` の両方が
     使う——複製すると片方だけ直してもう片方を直し忘れる食い違いを作るため。

  8. `packages/core/src/__tests__/runtime-fakes.ts`: `FakeEventStore` が独立した配列を
     持っていた（`FakeBackingStore` に載っていなかった）のを、`outboxJobs` と同じ形に
     揃えた——`FakeBackingStore.events` を新設し、`FakeEventStore`/
     `FakeMemoryStore.updateStatusWithEvent` の両方がこれを共有する。
     `stores.eventStore.events` という既存のテストからの参照の仕方
     （`runtime.test.ts`）を壊さないよう、`FakeEventStore.events` は
     `backing.events` を指す getter にした。**`beforeUpdateStatus`（PR #28 が TOCTOU を
     決定的に再現するために置いたテスト専用の差し込み口）は `updateStatusWithEvent` でも
     同じ位置（CAS 判定の直前）で発火する**——さもないと `reextract` が `updateStatus`
     を呼ばなくなった時点で、この歯が黙って意味を失う（見た目は緑のまま、実際には
     何も検査していない、という一番危険な壊れ方）。

  9. `packages/testkit/src/memory-store-conformance.ts` に `updateStatusWithEvent` の
     適合テストを4本追加した（成功/CAS 競合/対象が無い/`expectedStatus` 省略）。
     「CAS に弾かれたときイベントが1件も積まれていないこと」を検査するために
     `MemoryStoreConformanceOptions` へ `listEventsForMemory` フックを**必須**として
     追加した（`prepareRecallId`/`outbox-store-conformance.ts` の `seedJob` が前例）。
     **省略可のオプションにしなかった**——省略できると「検査した」adapter と
     「検査していない」adapter が同じ緑色の出力になり、ADR 0011/0025/0027/0028 が
     繰り返した「名乗れる以上の精度を主張する」族の失敗を、フックの省略という形で
     再現することになる。新設の「対象が無い」検査は、既存の `"does-not-exist"` を
     使っている検査（別 PR が直す予定）には触らず、well-formed だが実在しない UUID
     （`randomUUID()`）を使い、`.rejects.toThrow(/memory not found for tenant/)` で
     何が投げられたかまで固定した（引数無しの `.rejects.toThrow()` は `TypeError` でも
     通ってしまうため）。

  10. `packages/postgres/src/__tests__/memory-store-update-status-with-event-transaction.test.ts`
      を新設した（`memory-store-update-status-concurrency.test.ts` の構えに倣う、
      **CI の postgres ジョブでしか走らない**）。本物の並行（別々の `Pool` を4本）で、
      同じ1行に対して4本が同時に `updateStatusWithEvent(..., { expectedStatus: 'active'
      })` を撃つと、ちょうど1本だけ成功し、`memory_events` に `superseded` イベントが
      **ちょうど1件**だけ残ることを実測する。加えて、単一接続・逐次実行で
      「CAS に弾かれたトランザクションでは status もイベントも一切変わらない」ことを
      実データ（`memory_events` を直接 SELECT）で確認する歯も足した。

- **採らなかった案**:

  - **トランザクションハンドルを core の型として持つ**: 却下（ADR 0012 D-ingest-1 が
    既に却下済み。本 ADR はこれを覆さない）。理由は文脈節・決定1参照。

  - **supersede ループ全体を1トランザクションにする**: 却下。ADR 0030「採らなかった案」が
    既に同種の判断（advisory lock での直列化）を却下しているのと同じ理由に加え、
    ループ全体を1トランザクションにすると「1件の競合」が「全部やらなかった」に
    化ける——CAS の意味（「衝突した1件だけを弾き、他は普通に進める」、ADR 0030の
    安全弁3の設計そのもの）と正面から衝突する。マネージャーの指示（🔴 外せない線1・2）
    もこれを明示的に禁じている。

  - **返り値をより richer にするだけで済ませる**（例えば `ReextractResult` に
    「イベント追記に失敗した対象」の欄を足す）: 却下。**永続化された不整合は返り値では
    消えない。** `reextract` の呼び出し元が返り値をどれだけ丁寧に読んでも、DB に残った
    「status は superseded・イベントは無い」という行そのものは直らない。問題は
    「呼び出し側に何を伝えるか」ではなく「何が実際に書き込まれるか」であり、後者を
    直すには書き込みの単位を変える以外にない。

- **歯について**:

  基準線（`main` の head、ADR 0030 の PR で実測済みの値と一致することを確認済み）:
  root 7 / `packages/core` 203 / `packages/testkit` 68 / `packages/openai` 20。
  本 PR 後: root 7（変わらず）/ `packages/core` 203（変わらず——`updateStatus` を
  呼んでいた既存の TOCTOU の歯を `updateStatusWithEvent` に向け直しただけで、新設の
  テストファイルは足していない）/ `packages/testkit` 72（+4:
  `memory-store-conformance.ts` の `updateStatusWithEvent` の歯）/ `packages/openai`
  20（変わらず）。手元で走らせたのはこの4パッケージ（DB 不要）のみ。

  DB 不要な変異を4本撃った（すべて `git checkout --` で戻し、`git status --short` が
  空であることを確認してから次に進んだ）:

  | # | 変異 | 当たったか | 赤くなったテスト数（走った総数の変化） | 一意に捕まえた歯 | 赤の出どころ |
  |---|---|---|---|---|---|
  | M1 | `FakeMemoryStore.updateStatusWithEvent` から `beforeUpdateStatus` の発火を落とす | 当たった | `packages/core` 203本中1本（総数は不変） | PR #28 の ⭐ 決定的な TOCTOU 再現の歯（`compare-and-swap（ADR 0030: ...）`） | `AssertionError: expected 'superseded' to be 'forgotten'`（`toBe` assertion、`TypeError` ではない） |
  | M2 | `runtime.ts` の `updateStatusWithEvent` 呼び出しから `expectedStatus: "active"` を落とす | 当たった | `packages/core` 203本中1本（総数は不変） | 同上（M1 と同一の歯） | 同上と同一の `AssertionError`（`expected 'superseded' to be 'forgotten'`） |
  | M3 | in-memory 実装（`InMemoryMemoryStore.updateStatusWithEvent`）で、CAS 判定より前にイベントを積んでしまう | 当たった | `packages/testkit` 72本中1本（総数は不変） | 新設の「CAS に弾かれたら…イベントも1件も積まれない」の歯 | `AssertionError: expected [ {...} ] to deeply equal []`（`toEqual` assertion） |
  | M4 | in-memory 実装で、CAS 判定の順序を逆にする（先に書き換えてから判定する） | 当たった | `packages/testkit` 72本中1本（総数は不変） | 同上の歯のうち「行が一切変わっていない」の assertion | `AssertionError: expected 'superseded' to be 'archived'`（`toBe` assertion） |

  各行について:
  - **⓪** 4本とも `git diff --stat` が変異ごとに非空であることを確認した（差分行数は
    それぞれ本文中の該当箇所を参照）。
  - **①** 4本とも「当たった」——`SKIP` になったものは無い。
  - **②** 走ったテスト総数は基準線と一致したまま（`packages/core` 203・`packages/testkit`
    72）で、赤くなった本数だけが変わった。総数がずれていない＝変異以外の要因で
    テストの発見・実行自体が変わっていないことの確認。
  - **③** M1・M2 はどちらも同じ1本（PR #28 の TOCTOU 再現の歯）だけが赤くなった——
    これは意図どおりである。M1（フックが発火しない）と M2（CAS 条件が無い）は
    どちらも「この歯が期待する割り込みが検知されない」という同じ結果に落ちるため、
    同じ歯が両方を捕まえる。M3・M4 は新設の CAS 競合の歯（1本）が捕まえた。
  - **④** 4本とも `AssertionError`（`expect().toBe()`/`toEqual()`）であり、型検査や
    フレームワークの番犬（`TypeError`・unhandled rejection 等）ではない。失敗メッセージは
    表の「赤の出どころ」列に逐語で記載した。
  - **⑤** M1・M2 が撃った ⭐ の歯（`runtime.test.ts`）は、フィクスチャを非対称にして
    ある（対象 M は割り込みを受け forgotten になる、対象 N は介入を受けず普通に
    supersede される）——歯自体がこの非対称性を1本で assert する構造になっている
    （変異を当てた今回は M の assertion で止まったため N 側の assert には到達して
    いないが、非対称フィクスチャであることは歯の設計として維持されている。
    変異を当てていない通常実行では N が supersede されることまで同じ歯が確認する）。
    M3・M4 は単一対象の歯であり、同じ `describe` 内の「成功時は Memory 更新・イベント
    1件」「`expectedStatus` 省略時は無条件更新」の別の it() が変異の影響を受けずに
    通り続けたことを、これらの変異が対象外の振る舞いまで壊していないことの確認として
    使った。

- **引き受ける負債**:

  - **`MemoryStore` の責務が「Memory の永続化」から「Memory の永続化 + イベント追記」に
    さらに広がった。** ADR 0012 D-ingest-1 が「Memory の永続化 + outbox への書き込み」に
    広げた負債の延長線上にある——`MemoryStore` は既に「複数の書き込み先にまたがる
    トランザクションを内側に持つ」という形の責務を持っており、本 PR はその形の
    書き込み先をもう1つ（`memory_events`）増やした。
  - **新しい Memory の作成は同じトランザクションに入っていない。** 「採らなかった案」
    ではなく「買わない不変条件」として文脈節・決定3に既述——`docs/memory-model.md` §11
    行5 のもう一方の要求（旧行の更新と新 Memory の作成の同時性）は覆っていない。
  - **supersede ループの原子性はそのまま**（ADR 0030 からの既存負債の継続）。

- **確かめていないこと**:

  - **この器に Docker/PostgreSQL/`DATABASE_URL` が無い。** `packages/postgres` の
    新設テスト（`memory-store-update-status-with-event-transaction.test.ts`、および
    `memory-store-conformance.ts` の `updateStatusWithEvent` の歯の postgres 版）は
    CI の postgres ジョブが唯一の実行環境であり、本 PR の作業では実行していない。
    手元で確認できたのは (a) 型検査・lint・format が通ること、(b) `packages/core`/
    `packages/testkit` の DB 不要な歯がすべて通ること、(c) `pnpm run build` が通ること
    ——のみである。
  - **`db.transaction()` が本物のロールバックとして機能すること自体**（CAS に弾かれた
    ときに `memory_events` への INSERT コマンドを一切発行しない設計だが、万一発行して
    いたとしても本物のトランザクションが正しく巻き戻すかどうか）は、CI の postgres
    ジョブで初めて実測される。
  - **本物の並行**（複数プロセスが実際に同時にネットワーク越しで UPDATE/INSERT を
    撃つときのタイミング）で「ちょうど1本だけ成功し、イベントもちょうど1件」という
    前提が崩れないことも、CI 上で初めて実測される。

- **これが覆るとしたら**:

  - supersede ループ全体の原子性（複数 Memory にまたがる操作をトランザクションで包む）が
    実際に必要になったら、それは本 ADR の範囲外の新しい ADR になる（ADR 0030 の同項目を
    継ぐ）。
  - 「旧行の status 更新と新 Memory の作成を1トランザクションにする」という
    docs/memory-model.md §11 行5 の要求を実際に満たす必要が生じたら、
    `updateStatusWithEvent` をさらに拡張する（あるいは別のメソッドを足す）かどうかを
    検討する新しい ADR が要る。
  - CI の postgres ジョブで実測した結果、「ちょうど1本だけ成功」という前提が崩れる
    （例えばデッドロックで複数本が失敗する）ことが分かったら、リトライ戦略や
    ロック待ちの扱いを再検討する必要が生じる（ADR 0030 と同じ留保）。
