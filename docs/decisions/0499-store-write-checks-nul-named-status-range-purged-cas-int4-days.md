# ADR 0499: 書き込み口の NUL を名指しで断る・`resolveContested*` の型の外の `status` を断る・purge 済みの行を CAS に一致させない・`setEventRetention` の日数の上限を共有の検査へ

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-44ffeb19 の指示による）が書いた。直す線はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**前提**: オーナーが v1.X.0 で破壊的変更を許した。そのうえで、「型の外の入力を新しく断る」「約束に実装を戻す」直しは、クローンが決めてよい、と読んだ。**この読みがずれていれば、「これが覆るとしたら」から戻せる。**
出所の区別: 【現物】は読んだコード、【実測】は手元（PostgreSQL 17）や名指しのテストで走らせた結果、【判断】は担い手の判定。

- **文脈**: 4つの穴が、同じ形——「型の外・約束に反する入力が、DB の生の例外になる、または黙って通る」——をしていた。各穴は別々の ADR が材料として挙げたまま、直されていなかった。

  1. [ADR 0456](./0456-llm-returned-values-malformed-read-filter-nul-named.md) の M4・[ADR 0446](./0446-apply-correction-no-write-before-winner-check-case-insensitive-candidate-reason-winner.md) の材料: 書き込み口の NUL は、`@mnemora/postgres` で生の `DrizzleQueryError`（message に `Failed query: … params: …`）になる【現物・実測】。読み取りの口は ADR 0456 が名指しの `Error` に直した（`packages/postgres/src/input-check.ts`）。
  2. [ADR 0450](./0450-contested-group-operation-state-matrix-round26.md) の材料: `resolveContestedGroup` の `status` は型が `"active" | "superseded"` だが、`"forgotten"`・`"contested"` などを渡すと通り、行をその status にした【実測】。`resolveContestedPair` も同じ。
  3. [ADR 0447](./0447-lifecycle-operation-state-matrix-round23.md) の材料: `updateStatusWithEvent(T, "active", { expectedStatus: "forgotten" })` を purge 済みの `T` に呼ぶと、墓石が `active` に戻る【実測】。`purge` は `status` を動かさず `purged_at` を入れるだけなので、CAS の条件 `status = 'forgotten'` は purge 済みの行にも当たる。`Runtime.purge` の「不可逆」の約束の外だった。
  4. [ADR 0479](./0479-tenant-settings-write-fake-alignment.md) の材料: `setEventRetention` の `days` が `2^31 - 1` を超えると、`PostgresTenantSettingsStore` だけが DB の生の例外（22003）。testkit の fixture だけが、同じ上限の検査を共有の `assertValidEventRetentionDays` の外に別に持っていた。

- **決めたこと**:

  1. **書き込み口の NUL を、DB に触れる前に名指しの `Error` で断る。**
     - 新しい関数は `packages/postgres/src/input-check.ts` の内部（`assertNoNulInNewMemory`・`assertNoNulInNewMemoryEvent`）。**公開 API・新しい例外クラスは足していない**。素の `Error`、message は読み取りの口と同じ `<口>: <欄> must not contain NUL characters (U+0000)`。
     - 欄名・検査の順・文面は testkit の `InMemoryMemoryStore`（ADR 0434 が揃えた）と同じ。`memory_events` の欄は `memory_events.digestSnapshot`・`memory_events.actor`・`memory_events.meta`。`actor`・`meta` は、対をなさない UTF-16 サロゲートも同じ文面で断る（`jsonb` が以前から拒んでいた入力。fixture の文面がそう書いている）。
     - 対象（`memories`）: `content`・`tags` の各要素・`digest`・`contentHash`・`extractorVersion`・claim key（subject・predicate）・`attributes`（key も value も、入れ子の中も）・`provenance`。口: `createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の `news`。`purgeMemory` の墓石の `content`・`digest`。
     - 対象（`memory_events`）: `EventStore.append`（`memoryId` が `null` の枝も、非 null の枝も）、`createdEvent` を書く2経路（`insertCreatedEventRow`）、`insertMemoryEventsBatch`（群の2口）、`updateStatusWithEvent`・`supersedeWithNewMemories` の `supersede[i].event`・`purgeMemory`・`markContestedPair`・`resolveContestedPair`・`resolveOrphanedContested`・`restoreSupersededBy`（`reason`・`actor`）。**書く文の直前で検査する**——ほかの理由で先に落ちる入力（status の CAS 違反・対象が無い・形の壊れた `memoryId`）は、今までどおりその例外が先になる（断る入力が増えず、優先順位も変えない）。システムが自分で作るイベント（`archiveDecayed`・`purgeExpiredEvents*`）は、利用者の値を含まないので検査しない。
     - **型を外れた値（文字列でない欄・欠けた欄）は見ない**。以前と同じ経路（DB の検査）に任せる。`claimKey` の片方しか無い入力が通る約束（conformance にある）を壊さないため。断るのは「文字列で、NUL を含む」ものだけ。
     - **BigInt は NUL より先に `TypeError`（`Do not know how to serialize a BigInt`）**。以前は `JSON.stringify` が INSERT の引数を組む時点で投げていて、`event-meta-roundtrip.postgres.test.ts` が縛っている。NUL の検査が先に当たらないようにした。
  2. **`content` も検査する。そのため、落とした候補の説明が変わる。**【判断。決めた点の中で最も覆りやすい】
     - 指示の列挙には `content` が無かった。しかし、抽出の候補の `digest` は、LLM が返さないとき**本文から作られる**（本文に NUL があれば `digest` にも入る）。`digest` だけ検査すると、本文の NUL を「`digest` が悪い」と説明してしまう【実測: 最初の実装で、`observe-unsaveable-candidate.postgres.test.ts` が `code: null`・digest の message になって赤くなった】。LLM の返す `digest`・`tags`・claim key の NUL は、core が先に落とす（ADR 0443）ので、Runtime 経由で store に届く NUL は、事実上、本文（とそこから作る `digest`）だけである。
     - ⟹ `content` を、fixture と同じ順（`content` が先）で検査する。保存できない候補を落とすとき（ADR 0347。`describeDroppedCandidate`）、落とした候補の説明は、`cause` の連鎖の最も内側の `code`・`message` から作られる。**本文に NUL を含む候補の説明が、`code: "22021"`・pg の文面から、`code: null`・`PostgresMemoryStore: content must not contain NUL characters (U+0000)` に変わる**（`created` イベントの `meta.droppedCandidates[]`）。落とす候補の集合・残りを書くこと・全件が落ちたときに最初の例外を投げることは変わらない。fixture は以前から `code: null`・`InMemoryMemoryStore: content must not …`（接頭辞だけが違う）で、2実装の説明が揃った。`observe-unsaveable-candidate.postgres.test.ts` の「Postgres は 22021、fixture は code を名乗らない」の食い違いの記述を、揃った形に直した。
     - 副作用: `savepoint-rollback-error.postgres.test.ts`（ADR 0451）は、「DB が失敗してトランザクションが aborted になる候補」の作り方として本文の NUL を使っていた。NUL は DB に触れる前の名指しの例外になり、トランザクションは aborted にならないので、その歯の意味（`rollback to savepoint` が失敗したときに元のエラーが残る）が弱まる。**同じ意味を保つために、候補を CHECK 制約違反（`strength: 2`、SQLSTATE 23514）に変えた**。期待する `code` も `22021` から `23514` に変えた（歯の主題は NUL ではなく savepoint の rollback）。
  3. **`resolveContestedGroup`・`resolveContestedPair` の `status` が `"active"`・`"superseded"` 以外なら、書く前に `RangeError`。**
     - message: `resolveContestedGroup: members[<i>].status must be "active" or "superseded"`・`resolveContestedPair: first.status must be …`（`second` も）。値は message に入れない。2実装（Postgres・testkit の InMemory）で同じ文面・同じ位置（重複 id・同じ id の検査のあと、id の存在確認より前）。`undefined`・`null`・`""`・列挙に無い値（以前は DB の CHECK で生の例外、fixture は `assertStorableMemoryColumn` の例外）も同じ `RangeError` に揃った。
     - 他の口（`markContested*` は status を渡さない、`updateStatus` は `MemoryStatus` 全体が正当な引数）には、同じ穴が無い。
  4. **purge 済みの行は、`expectedStatus` に一致しない行として扱う。** `expectedStatus` が渡されたとき、CAS の条件に `AND purged_at IS NULL` を足す（Postgres の `expectedStatusCondition`）。0行だったときの切り分け（`explainEmptyStatusUpdate`）は、既存のまま `MemoryStatusConflictError` を投げる。
     - 対象: `updateStatus`・`updateStatusWithEvent`・`supersedeWithNewMemories` の `supersede[].expectedStatus`（弾かれた対象は、既存の扱いで `conflicted` に載る）。ほかの status を書く口（`markContested*`・`resolveContested*`・`resolveOrphanedContested`・`restoreSupersededBy`・`archiveDecayed`）は、条件に `status = 'active' | 'contested' | 'superseded'` を含むので、`forgotten` の purge 済みの行には当たらず、同じ穴は無い【現物】。
     - testkit の InMemory も同じ（`purgedAt` が非 `null` なら一致しない）。`MemoryStore` の TSDoc（`updateStatus`・`updateStatusWithEvent`）に、purge 済みの扱いを書いた。
  5. **`setEventRetention` の日数の上限（`2^31 - 1`）を、共有の `assertValidEventRetentionDays`（`@mnemora/core`）へ移す。** 2実装は、この関数だけで日数を検査する。message は fixture にあったもの（`setEventRetention: days does not fit in a Postgres "integer" (int4) column (got <days>)`）をそのまま移した（既存の歯が縛っていた）。受け入れる値は変わらない（`2^31 - 1` ちょうどは通る）。`TenantSettingsStore` の TSDoc に書いた。
  6. **歯は各パッケージの `__tests__` に置き、conformance suite には足さない。**
     - `packages/postgres/src/__tests__/store-write-nul-named.postgres.test.ts`: 口 × 欄の全組み合わせで、同じ入力を testkit の InMemory と Postgres に流す。断る（名指し・生の例外でない・値を写さない）・何も書かれない（イベント数・記憶数・status が変わらない）・陽性対照（NUL を含まない・対になったサロゲートは通る）・やりすぎ対照（型を外れた欄は NUL の検査で断らない）。
     - `packages/postgres/src/__tests__/store-status-write-checks.postgres.test.ts`: 型の外の `status` の `RangeError`（両実装）、purge 済みの CAS（両実装）、陽性対照（purge 前の `forgotten` は戻せる、型の中の `status` は通る、`expectedStatus` なしの更新は purge 済みでも通る）。
     - `packages/postgres/src/__tests__/event-retention-days-int4.postgres.test.ts`・`packages/core/src/__tests__/event-retention-days-int4.test.ts`。
     - 既存の歯の更新: `observe-unsaveable-candidate.postgres.test.ts`（落とした候補の説明）、`savepoint-rollback-error.postgres.test.ts`（候補の作り方）。

- **採らなかった案**:
  - **`content` を検査せず、`digest` だけを名指しにする**: 本文の NUL を「digest が悪い」と説明する。または、本文由来の `digest` の検査を外すと、`digest` の NUL を指示どおりに名指しにする目的が崩れる。却下。
  - **名指しの `Error` に `code: "22021"` を持たせて、落とした候補の説明の `code` を保つ**: 偽の SQLSTATE を名乗ることになり、fixture（`code: null`）とも揃わない。却下。
  - **`content` の NUL だけ生の DB の例外のまま残す**: 候補の説明が「`digest` が悪い」になる（上）。却下。
  - **purge 済みの行の `expectedStatus` なしの更新も拒む**: 無条件の書き込みに、拒む理由の例外を新しく決めることになる（`MemoryStatusConflictError` は `expectedStatus` を持つので使えない。`MemoryPurgeConflictError` は `purge` の CAS 専用）。「`expectedStatus` に一致しない」という指示の外。**手を付けていない**（「引き受けた負債」）。
  - **purge 済みの行の CAS 違反を `MemoryPurgeConflictError` で投げる**: 指示は「既存の CAS 失敗と同じ `MemoryStatusConflictError`」。`expectedStatus: "forgotten"` のとき、`observedStatus` も `"forgotten"` になる点が読みにくい（`MemoryPurgeConflictError` の TSDoc が、`purge` ではその理由で別の型にしている）。型を足す・選ぶのはオーナーの領分と読み、指示どおりにした。
  - **日数の上限を `Postgres` の中に残す**: testkit が別に持つ二重の検査が残り、ずれる余地が残る（ADR 0479 の指摘）。却下。
  - **システムが作るイベント（`archiveDecayed` の `digest_snapshot`）の NUL も検査する**: `digest` は、書き込みの時点で `memories.digest` に入った値（検査済み）である。却下（入口は1つで足りる）。

- **引き受けた負債**:
  - **`expectedStatus` なしの更新は、purge 済みの行を `active` などに動かせる**（上）。`Runtime` は常に `expectedStatus` を付けるので、通常経路には現れない。拒むなら、どの例外を使うかをオーナーが決めること。
  - **`createObservation`・`createObservationWithOutbox` の `payload`・`attributes`・`kind`・`externalId`、`createRecall` の `query` などの NUL は、生の `DrizzleQueryError` のまま**（ADR 0456 の M4 のうち、この ADR で触れなかった口）。fixture は名指しで断っている（ADR 0434）。`Runtime.observe` の `text` に NUL を入れる経路はこの口に届くので、次に直す価値が高い。
  - **`MemoryStatusConflictError` の `expectedStatus` と `observedStatus` が、purge 済みの行でどちらも `"forgotten"` になる。** 例外を見ただけでは「purge 済みだから」と分からない。`purgedAt` を読み直すこと。
  - **core の `FakeMemoryStore`（`packages/core/src/__tests__/runtime-fakes.ts`）は揃えていない。**
  - **検査の優先順位**: testkit の InMemory は、イベントの検査を先頭（状態を変える前）に置く。Postgres は書く文の直前（status の CAS 違反・対象が無い、が先）。両方断る入力で、どちらの例外が出るかが違う（以前から）。

- **直す前に書かれた行が在るかを調べる SQL**（読み取りだけ。**既存の行は書き換えない**——データの書き換えはオーナーの判断が要る）。purge 済みの行（`purged_at` が入った行）が、直す前の `updateStatusWithEvent(…, "active", { expectedStatus: "forgotten" })` で `active` などに戻されていれば、`status` が `forgotten` でないのに `purged_at` が入っている:

  ```sql
  SELECT tenant_id, id, status, purged_at FROM memories
  WHERE purged_at IS NOT NULL AND status <> 'forgotten';
  ```

  【確かめていないこと】この SQL を、実際に戻された行がある DB では走らせていない（直す前の実装で戻した行を、手元で作って数えてはいない。構文と、行が無い DB で0行になることだけを見た）。

- **これが覆るとしたら**:
  - 決定2（`content` も名指しにして、落とした候補の説明を変える）は、`droppedCandidates[].code` を読んでいる人がいると分かれば覆る。そのとき `code` を保つには、名指しの `Error` に `code` を持たせる（偽の SQLSTATE）か、`content` を除外して `digest` の検査を本文由来のときだけ外す（本文由来かを store は知らない）必要がある。
  - 決定4の「`expectedStatus` なしは拒まない」は、オーナーが「purge は不可逆」を全口に及ぼすと決めれば覆る。
  - 「型の外の入力を新しく断る」をクローンが決めてよい、という前提が撤回されれば、決定3・4は戻す対象になる（NUL の名指しと日数の上限は、例外の形が変わるだけなので残してよい）。

- **測ったこと**（【実測】。手元の PostgreSQL 17。件数は書かない）:
  - 歯を書いてから直した。直す前: NUL の歯は **Postgres が全部赤・InMemory が全部緑**（陽性対照は両方緑）。status の歯・purge 済みの CAS の歯は **両実装とも赤**（fixture も同じ穴を持っていた）。日数の歯は Postgres と core の共有の検査が赤。直した後: すべて緑。
  - 影響を受けうる既存の歯を名指しで走らせた（全部は走らせていない）: `create-memory-idempotent-rejects`・`observe-aux-field-drop`・`observe-unsaveable-candidate`・`savepoint-rollback-error`・`store-write-atomicity`・`event-meta-roundtrip`・`testkit-fixtures-nul-numeric-purged-at-alignment`・`event-target-parity`・`empty-string-references`・`store-boundary-diff`・`error-message-omits-params`・`apply-correction-case-and-no-partial-write`・`conformance.postgres`・`event-retention-kind-validation`・testkit の `in-memory-event-retention-days-range`。最初の実装で赤くなったのは3つ（型を外れた `claimKey` を `undefined.includes` で落とした、BigInt との優先順位、落とした候補の説明）で、いずれも直した。
  - **変異試験**（実装を1か所ずつ壊して、名指しで走らせた歯が赤くなるかを見た。戻すのは cp）。**全部の組み合わせではなく代表に絞った**（1本ごとに歯のファイルを走らせるので時間がかかる）。
    - **足りない実装（検査を外す）で赤になった**: `EventStore.append` の両枝、`insertCreatedEventRow`、`insertMemoryEventsBatch`、`updateStatusWithEvent`・`purgeMemory`・`markContestedPair`・`resolveContestedPair`・`resolveOrphanedContested`・`supersede` の `target.event`・`restoreSupersededBy` の各イベント検査、墓石の `content`、イベントの `actor`・`digestSnapshot`、`memories` の `content`・`digest`・`claimKey.subject`・`attributes`、`createMemory`・`supersede` の `news` の呼び出し箇所、status の検査（Postgres の group・InMemory の pair の first）、`purged_at` の条件（Postgres）・`casMismatch` の purged（InMemory）、日数の上限（core の歯・Postgres の歯の両方）。
    - **やりすぎの実装で赤になった**: 対になったサロゲートまで断る（イベント側・memories 側の両方）、型を外れた欄まで断る、`"superseded"` まで断る（Postgres・InMemory 両方に同じ検査があるのは Postgres のみ測った）、`expectedStatus` なしの更新まで purge 済みを拒む、`forgotten` の `expectedStatus` を全部拒む、InMemory の CAS が常に不一致、日数の上限が1つずれる。
    - **最初は生き残った変異**: InMemory の `supersedeWithNewMemories` の事前判定（`wouldConflict`）から purged を外したもの。あとの CAS が同じ結果を出すので `conflicted` では見えず、`abortIfAllConflicted` のときだけ差が出る。その歯（purge 済みの対象だけなら断る）を足し、赤になることを確かめた。
    - **測っていない変異**: 各イベント箇所のうち `markContestedGroup`・`resolveContestedGroup` は `insertMemoryEventsBatch` を通るので、その1つの変異で代表した。`pair` の second 側の status、InMemory の group の status、`provenance`・`tags`・`extractorVersion`・`claimKey.predicate` の欄ごとの除去は測っていない。
