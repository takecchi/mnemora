# ADR 0354: 案1 — 時刻の欄を任意にし、runtime から注入した時計を store の書き込みへ渡す

- **状態**: 採用 (2026-09)

- **文脈**:

  [Issue #1237](https://github.com/takecchi/mnemora/issues/1237) は、`Clock`（`packages/core/src/interfaces/clock.ts`）
  の TSDoc が「runtime が『現在時刻』を取得する唯一の場所である」と約束していたにもかかわらず、
  実際には store が書き込みのときの壁時計（`new Date()`、Postgres では `now()`）で埋めている
  欄が複数在ることを実測で示した——監査ログ（`memory_events`）の `at`、`purgedAt`、recall の
  記録の `createdAt`、outbox の `createdAt`・`availableAt`・`completedAt`・`failedAt`。

  最も実害が大きい帰結は「**壁時計より過去の時計を注入すると、`tick()` は積んだジョブを1本も
  取らない**」——`available_at` が壁時計のまま、`claimBatch` は `available_at <= now`（注入した
  時計）でしか絞らないため、過去の時刻での取り込み直し・過去固定時刻でのテストでは extract も
  embed も走らなかった（`processed: 0`、何も名乗らない）。

  同 Issue は3つの直し方を挙げ、判断が要る理由（「どれも公開の口か保存データの意味を変える」）
  でオーナーへ止めた:

  1. **store の書き込みの口に runtime の時刻を渡す**（`MemoryStore` の宣言が変わる）。
  2. `tick` の claim の `now` を壁時計にする（リースの計算とテストの時刻固定の意味が変わる）。
  3. 何もせず、今の振る舞いを doc とテストで縛る（約束を狭める）。

  クローン miku の委譲先は、まず案3（[PR #1241](https://github.com/takecchi/mnemora/pull/1241)・
  [PR #1297](https://github.com/takecchi/mnemora/pull/1297)、マージ済み）で「今の振る舞い」を
  `Clock` の TSDoc と `injected-clock-reach.postgres.test.ts` に固定した。本 ADR は、その先の
  **案1**（store の口に runtime の時刻を任意で渡せるようにする）を実装した記録である。

- **決めたこと**:

  1. **すべての時刻の欄を任意（`opts?`/`?: Date`）にし、省略時は今日どおり壁時計に倒す。**
     ⭐ 型の上では追加のみであり、既存の3引数呼び出し・既存の `MemoryStore`/`OutboxStore`
     実装（第三者の adapter を含む）は1行も直さずに新しい interface をそのまま満たす——
     TypeScript の構造的部分型の下では「呼び出し側が省略可能な引数を渡さない」ことと
     「実装がその引数を最初から受け取らない」ことは区別されない（`ReinforceOptions`・
     ADR 0165 決めたこと13・ADR 0353 決めたこと9 と同じ理由・同じ判断）。

  2. **`MemoryStore.createObservationWithOutbox`/`createMemoryWithOutbox` に第4引数
     `opts?: { now?: Date }` を足す。** 積む outbox 行の `availableAt`・`createdAt` に使う
     （この2メソッドは監査ログのイベントを自分では積まないため、`opts.now` の使い道は
     outbox 行だけである——実装を読んで確認した。案の文言「同じ書き込みで作る監査ログ
     イベントの `at` にも使う」は、該当する書き込みが実際には無かった）。

  3. **`OutboxStore.complete`/`fail` に末尾の引数 `opts?: { at?: Date }` を足す。**
     `completedAt`/`failedAt` に使う。⚠ **`fail` は `available_at` を再計算しない**
     （今の振る舞いのまま——Phase 1 は失敗したジョブの自動リトライを行わない。
     `OutboxStore` interface 冒頭の doc 参照）。

  4. **`NewRecallRecord`（`packages/core/src/recall.ts`）に `createdAt?: Date` を足す。**
     `createRecall` が書く `recalls.created_at` に使う。

  5. **`purgeMemory` の実装（Postgres・testkit fixture）を直し、`purged_at` を
     `event.at`（省略時は壁時計）と**同じ値**にする。** 2箇所で `new Date()` を独立に
     呼ぶと、同じ操作なのに `purged_at` と `memory_events.at` が別の値になりうる
     ——これは interface の宣言を変えない実装だけの修正である（`purgeMemory` の
     シグネチャは既存のまま）。

  6. **`archiveDecayed` の実装（Postgres・testkit fixture）を直し、`archived` イベントの
     `at` を `opts.now`（既存必須引数、ADR 0114）にする。** 以前は Postgres が SQL の
     `now()`、fixture も壁時計だった。**掃引が「選ぶ基準」に使う時刻と「イベントに残す」
     時刻が一致するようになる**——これも interface の宣言は変えない実装だけの修正。

  7. **runtime（`runtime.ts`・`recall-runtime.ts`）は、上記の新しい任意引数すべてに
     `clock.now()` を渡し、`NewMemoryEvent` を組み立てているすべての箇所
     （`created`・`updated`（contested 系含む）・`superseded`・`forgotten`・`purged`・
     `restored`・`archived`（`sweepArchive` 経由、`opts.now` をそのまま使う））で
     `at` を明示する。** `restoreSupersededBy` に渡す `at: clock.now()`（既存）は
     変えていない。`sweepArchive` の `opts.now` は、以前から「呼び出し側
     （`Runtime.sweepArchive` の呼び出し元）が決めて渡す」設計だったため
     （`ArchiveDecayedOptions` の doc）、runtime 側の配線は変えていない——
     `archiveDecayed` の実装（決めたこと6）だけを直した。

  8. **`packages/testkit` の適合テスト（`memory-store-conformance.ts`・
     `outbox-store-conformance.ts`）に、「渡した時刻を守る」歯と「省略時は壁時計になる」
     歯を足す。** `OutboxStoreConformanceOptions` に任意フック `peekJob?`
     （`completed_at`/`failed_at` が付いた終端後の行を読む——`claimBatch` は終端行を
     対象から外すため使えない）を足した。省略した adapter ではこの歯が `it.skip` に
     なる——測っていないことが緑ではなく skip として見える（`supportsRealConcurrency`
     と同じ形の判断）。

- **検討した代替案**:

  1. **Issue 本文の案2（`tick` の claim の `now` を壁時計にする）。**
     ⛔ 採らなかった——ADR 0032 が確立した「時刻は呼び出し側が渡す」規律
     （テストで固定できるようにする境界）を`claimBatch` 側からわざわざ崩す方向であり、
     `Clock` の約束を狭めるだけで実害（過去の時計で `tick` が動かない）は直らない。

  2. **Issue 本文の案3のまま（doc とテストで縛るだけ）。**
     ⛔ 既に PR #1241・#1297 で実施済みであり、本 ADR はその先の直しである。

  3. **`purgeMemory`/`archiveDecayed` の interface 自体に新しい引数を足す。**
     ⛔ 不要と判断した——`purgeMemory` は既存の `event: NewMemoryEvent`（`event.at` は
     既に任意）がある。`archiveDecayed` は既存の `ArchiveDecayedOptions.now: Date`
     （既に必須）がある。どちらも「実装が壁時計を使わず、既存の引数をちゃんと使う」
     だけで直る——interface の破壊的変更どころか、宣言の変更すら不要だった。

  4. **`supersedeWithNewMemories?`（任意メソッド、`reextract`/`consolidate` が優先して
     使う経路）にも `opts.now` を足す。**
     🔴 **今回は採らなかった**（下記「引き受けた負債」参照）——この口が積む outbox 行
     （`news[].jobKinds`）の `availableAt`/`createdAt` は、本 ADR の後も壁時計のままである。
     この口が積む `superseded`/`created` イベントの `at` は、`event: NewMemoryEvent`
     （既に任意の `at`）を runtime 側が `clock.now()` で埋めるため、決めたこと7の対応で
     直っている——直っていないのは outbox 行の2欄だけである。

- **確かめたこと（変異試験、`AGENTS.md` の作法——`cp` で退避 → 変異 → 対象の歯が
  赤くなることを確認 → 復元）**:

  | # | 変異 | 結果 |
  |---|---|---|
  | 1 | `packages/postgres/src/memory-store.ts`・`outbox-store.ts` を本 ADR 以前（`git show HEAD:...`）へ戻す（`packages/core`・`packages/testkit` 側は直したまま） | `injected-clock-reach.postgres.test.ts` の Postgres kit で6件中5件が赤（PAST/FUTURE の tick 歯・created/recall の createdAt・forget/purge・復帰と掃引の歯）。「opts を省略すると壁時計になる」歯（store を直接呼ぶ歯）だけは緑のまま（この歯は実装を戻していない side を検査していないため、想定どおり） |
  | 2 | `packages/testkit/src/__fixtures__/in-memory-memory-store.ts`・`in-memory-outbox-store.ts` を本 ADR 以前へ戻す（他は直したまま） | 同テストの InMemory kit で同じ6件中5件が赤（変異1と対称の結果） |

  変異1・2とも、退避したファイルを `cp` で復元した後、同じ6件が緑に戻ることを実測した
  （`git status --porcelain` が空になることも確認）。

  `packages/testkit` の conformance suite（`memory-store-conformance.ts`・
  `outbox-store-conformance.ts`）に足した「渡した時刻を守る」歯・「省略時は壁時計」歯は、
  実装（Postgres・testkit fixture）に対して緑であることを確認した——変異試験は上記の2本
  （runtime 経由の統合的な歯）に絞り、conformance 側の個別の歯は「実装を直す前に赤かった
  こと」を実測していない（後述「確かめていないこと」）。

- **引き受けた負債**:

  1. **`supersedeWithNewMemories?` が積む outbox 行（`reextract`/`consolidate` の
     優先経路）の `availableAt`/`createdAt` は、本 ADR の後も壁時計のままである**
     （検討した代替案4）。この口を実装している adapter（`@mnemora/postgres`・
     testkit fixture の両方）に対して `reextract`/`consolidate` を壁時計より過去の
     時計で呼ぶと、その embed ジョブは Issue #1237 と同じ理由で `tick` に取られない
     ——`observe`（`createObservationWithOutbox`/`createMemoryWithOutbox` を直接使う
     経路）と `reflect`（`supersedeWithNewMemories` を使わない）は直っているが、
     `reextract`/`consolidate` の embed ジョブだけこの穴が残る。

  2. **`purgeExpiredEventsForTenant`（`packages/core/src/event-retention-purge.ts`）の
     `opts.now` は対象外のまま**（`RuntimeDeps.clock` を受け取らない部品であるため、
     Issue 本文コメントが既に記録している範囲外）。

  3. **conformance suite に足した歯自体の「赤→緑」の変異試験は、実装（Postgres・
     testkit fixture）に対する統合テスト（`injected-clock-reach.postgres.test.ts`）
     でしか確認していない**——conformance の個別の歯（例:
     `createObservationWithOutbox は opts.now を渡すと...`）を単独で意図的に壊して
     赤くする変異試験は行っていない。

- **これが覆るとしたら**:

  - `reextract`/`consolidate` の embed ジョブが壁時計より過去の時計で取られない
    ことが実運用で問題になったとき ⟹ `supersedeWithNewMemories?` にも
    `opts?: { now?: Date }`（または `news[].jobKinds` と対にした個別の `now`）を
    足す設計を検討する。
  - `purgeExpiredEventsForTenant` にも `RuntimeDeps.clock` を通したいという要求が
    出たとき ⟹ この部品のシグネチャ自体を見直す（`{ memoryStore,
    tenantSettingsStore }` だけを受け取る設計を変える）判断が要る。

- **確かめていないこと**:

  - `supersedeWithNewMemories?` を実装していない第三者 adapter での挙動（この口は
    任意メソッドであり、実装しない adapter では `reextract`/`consolidate` は
    フォールバック経路（`createMemoryWithOutbox` を直接呼ぶ、決めたこと2の対応が
    届く経路）を通るため、そちらは直っているはずだが、実測はしていない）。
  - 本番相当の規模・並行度での `opts.now`/`opts.at` 配線の性能影響（値を1つ追加で
    渡すだけであり、SQL の形は変えていないため影響は無いと考えているが、実測は
    していない）。
