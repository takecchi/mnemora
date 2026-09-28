# ADR 0348: 活動時計の数え方を、呼び出しごとの引数で選べるようにする

- **状態**: 採用 (2026-09)

- **文脈**:

  [Issue #338](https://github.com/takecchi/mnemora/issues/338) は、[ADR 0165](./0165-decay-activity-clock.md)
  が「1単位 = `recall()` 1回」をテナント1行の `tenant_activity.activity_seq`（以下 `T`）
  で数えると決めたことの帰結を指摘した——`decay_clock` が `'wall'` 以外のテナントでは、
  subject B に絞った recall（`ctx.subjectId = "bob"`）でも `T` が進み、subject A の記憶
  （一度も recall されていない）の忘却が進む。ADR 0165「これが覆るとしたら」1 は、この
  分岐を逐語で「オーナーの判断を要する種類の分岐である」と記録していた。

  [ADR 0311](./0311-activity-clock-boundary-measured-soft-and-hard.md) がこの Issue の実測を引き継ぎ、
  P（subject を絞った recall はその subject のカウンタだけを進める）/Q（既定
  `half_life_recalls` を実運用の頻度から逆算する）/R0（何もしない）の3案を並べて
  オーナーへ判断を返した。

  オーナーの回答（ask_human 61355570、逐語）:

  > **呼び出す際の引数で指定できるようにはできない？ これは使用者次第の内容だと
  > 思ったんだけど**

  ⟹ **P 案の「絞ったら自動で subject 側」という自動判定ではなく、呼び出し側が
  明示的に選べる引数として実装する**——本 ADR はこれを受けた設計判断である。

- **決めたこと**:

  1. **選択の置き場所は「呼び出しごとの引数」（`RecallQuery.activityCounting?:
     "tenant" | "subject"`、既定 `"tenant"`）にする。**

     検討した3案（下記「検討した代替案」）のうち、オーナーの逐語「呼び出す際の
     引数で指定できるように」に最も忠実であり、テナント単位の設定
     （`tenant_settings` 列）や `Runtime` 単位の設定と違って**呼び出しごとに
     選べる**——「このテナントは一律 subject 単位」ではなく「この recall だけ
     subject に絞って進めたい」という粒度の柔軟性を持つ。

  2. **意味論: テナント単位のカウンタ `T`（既存 `tenant_activity`）に加え、subject
     ごとのカウンタ `S_x`（新テーブル `tenant_subject_activity`、migration 0024）を
     持つ。ある Memory（subject `x`）の「有効ないま」は常に `T + S_x`
     （`x` が無い＝主題なしの記憶は `T` のみ）。**

     - `activityCounting: "tenant"`（既定）: 今と同じく `T` を `+1`（`S` には
       触れない）。
     - `activityCounting: "subject"` で `ctx.subjectId` あり: `S_{ctx.subjectId}`
       だけを `+1`（`T` には触れない）。
     - `activityCounting: "subject"` で `ctx.subjectId` 無し（テナント全体
       recall）: `T` を `+1`（"誰の" カウンタを進めるかという問いが無いので
       `"tenant"` と同じ扱いに倒す）。
     - `decay_clock === 'wall'` のテナントでは、`activityCounting` の値に関わらず
       何も進めない（ADR 0165 決めたこと5 のまま）。

  3. **⭐ 読み取り（忘却ゲート・段2の再スコア・掃引・作成/強化時の起点計算）は、
     `activityCounting` の値に関わらず常に「その Memory の subject の有効ないま」
     （`T + S_x`）を使う。** `activityCounting` が制御するのは前進（+1）の対象
     だけである——`"tenant"` を選んだ呼び出しでも、他の呼び出しが `"subject"` で
     進めた `S_x` は読み取りに反映される。

     この整理により、「絞らない recall・掃引で行ごとに『いま』が変わる」という
     問題（調査時に指摘された懸念）は、**「都度計算」で正しく解く**——読み取りの
     式が呼び出し引数に依存せず一意に定まるため、テナント全体を見る recall でも
     各行の `subject_id` に応じた `T + S_x` を都度評価すればよい。「テナント全体
     recall では `T` のみで判定する」という割り切りは採らなかった（下記
     「検討した代替案」参照）——同じ記憶がテナント全体 recall では見えるのに
     その subject に絞った recall では見えない、という逆転が起きるため。

  4. **性能: `TenantSettingsStore.hasSubjectActivityCounters?` が `false`
     （このテナントが一度も `activityCounting: "subject"` を使っていない）のとき、
     `@mnemora/postgres` の段1 SQL ゲート・`aggregateScope`・`archiveDecayed` は
     今日どおり `T` のみの単一パラメータ比較のままになる（`tenant_subject_activity`
     を相関サブクエリで引かない）。**

     `true` になった時点で初めて、行の `subject_id` に対応する
     `tenant_subject_activity.activity_seq` を相関サブクエリで足す
     （`packages/postgres/src/activity-decay-sql.ts` の
     `activityFloorSeqAliveCondition`/`activityFloorSeqDeadCondition` に1箇所へ
     まとめた——段1 ANN・`aggregateScope`・`archiveDecayed` の3箇所が同じ式を
     共有する。ADR 0038「実装が2つあると食い違う」を避けるため）。

     ⟹ **既定の呼び出し（`"tenant"`）だけを続けるテナントには、ビット単位で
     本 ADR 以前と同じ SQL が生成される。** `hasSubjectActivityCounters?` は
     テナントに1行増えるかどうかのフラグであり、`activityCounting` の呼び出し
     引数と1対1で連動する——「今日のすべてのテナント」を含め、一度も
     `"subject"` を使っていないテナントは EXPLAIN のプラン族が1つも変わらない
     （ADR 0165 決めたこと10-3 の教訓と同じ配慮）。

  5. **段1 SQL ゲートの相関サブクエリの形（`packages/postgres/src/activity-decay-sql.ts`）**:

     ```sql
     (decay_floor_seq IS NULL OR decay_floor_seq > (
       T + COALESCE((
         SELECT sa.activity_seq FROM tenant_subject_activity sa
         WHERE sa.tenant_id = <行の tenant_id> AND sa.subject_id = <行の subject_id>
       ), 0)
     ))
     ```

     `subject_id IS NULL` の行は相関サブクエリが0件になり `COALESCE(..., 0)` で
     `0` になる——結果として `T` のみと比較される。これにより「絞った recall に
     `includeSubjectless: true` を付けたときも、主題なし行は `T` で判定する」
     という要件を、CASE 文を書かずに統一的な式1本で満たせる。

     `MemoryStore.archiveDecayed`（掃引）は境界が `<=`（含む）の非対称
     （ADR 0165 決めたこと14）を、`activityFloorSeqDeadCondition` としてそのまま
     subject 単位のカウンタにも写した。

  6. **段2の再スコア・後置フィルタ（`recall-runtime.ts`）**: `effectiveNowSeqFor(memory)`
     という関数1つに、「T + S_{memory.subjectId}」の計算を集約した
     （`hasSubjectCounters` が false、または `memory.subjectId` が無ければ `T`
     のみ）。段1で候補になった Memory の `subjectId` 集合を `ensureSubjectSeqs`
     でバッチ読みしてキャッシュしてから、後置フィルタ・段2再スコア・連想枠
     （段3.5）・contested の同伴取得（段3）のすべてがこのキャッシュを参照する
     ——1回の recall で同じ `subjectId` を何度も個別に読みに行かない。

  7. **作成・強化・復元（`runtime.ts`）**: `resolveActivityClockInputs`
     （記憶作成、`observe`/`consolidate`/`reflect` が共有）・
     `resolveReinforceNowSeq`（使用報告・`restoreArchived` が共有）は、どちらも
     `ctx.subjectId` があれば `T + S_{ctx.subjectId}` を、無ければ `T` のみを返す。

     🔴 **引き受けた負債**: この解決は「対象 Memory 自身の `subjectId`」ではなく
     「呼び出しの `ctx.subjectId`」を基準にする。複数 subject の候補・Memory を
     一括で作成/強化する呼び出し（`buildNewMemoriesForCandidates` が1回の
     `observe` で複数候補を作る場合、使用報告ループが複数 Memory を強化する
     場合）では、対象がどの subject であっても同じ `ctx.subjectId` 基準の値を
     使うことになる。**通常の呼び出し（`ctx.subjectId` が書き込む/強化する
     Memory の subject と一致する）では正しく動くが、一致しない稀なケース
     （例: 他人の記憶を使用報告する）では、その Memory 自身の `subjectId` では
     なく `ctx.subjectId` の `S_x` が使われる。** 対象ごとに個別の値を計算する
     設計（`ids` の各要素の `subjectId` を都度引く）も検討したが、`reinforce`/
     `reinforceMany` は「同じ `opts` を全要素に適用する」という既存の契約
     （`MemoryStore.reinforceMany?` の doc）を破る変更になるため、本 ADR では
     採らなかった。

  8. **保守の操作への配線**:

     - **`findCorrectionCandidates`**: `FindCorrectionCandidatesInput.activityCounting?`
       を足し、内部の `recall(ctx, { text, activityCounting })` へそのまま渡す。
     - **`consolidate`/`reflect` の `{ seedMemoryId }` 形**: `ConsolidateTarget`/
       `ReflectTarget` の同バリアントに `activityCounting?` を足し、種の digest で
       内部的に呼ぶ `recall()` へ渡す。
     - **`consolidate`/`reflect` の `{ query }` 形**: 新しい欄は足さない——
       `target.query`（呼び出し側が渡す `RecallQuery` そのもの）に
       `activityCounting` を含められるので、そのまま伝播する。
     - **⛔ tick の自動 consolidate/reflect ジョブ（`processConsolidateJob`/
       `processReflectJob`）には届かない。** これらは `consolidate(scopedCtx,
       { target: { seedMemoryId } })` のように `activityCounting` を渡さずに
       呼ぶため、常に既定 `"tenant"` のまま——**これらの自動ジョブは、種の
       subject に絞った近傍探索（ADR 0317、`processConsolidateJob` のみ）を
       行っていても、活動時計の前進は `T` のままである。** `processReflectJob`
       は ADR 0317 の対応すらしていないため、この点は変えていない。

  9. **公開の型は破壊的変更を許容する（v1.X.0）**:

     - `NewRecallRecord.advanceActivityClock` の型を `boolean` から
       `boolean | { scope: "subject"; subjectId: string }` へ変更した。`boolean`
       はこの union にそのまま含まれるため、既存の `true`/`false`/省略はすべて
       型としても意味としても1バイトも変わらず通る——**構造的には非破壊**だが、
       `@mnemora/core` は npm 公開済みであり、型の変更自体はメジャーの判断が
       要るため、CHANGELOG には Changed として記載する。
     - `TenantSettingsStore` に `hasSubjectActivityCounters?`/
       `getSubjectActivitySeqs?` を追加（ADR 0165 決めたこと13 と同じ理由で
       省略可能——`@mnemora/core` は npm 公開済み、既定の挙動は「未実装なら
       `false`/`{}`」に倒す）。
     - `VectorFilter`/`RecallScope` に `decayFloorSeqUsesSubjectCounters?` を追加
       （同じく省略可能、既定 `false` で本 ADR 以前と同じ SQL）。
     - `ArchiveDecayedOptions` に `usesSubjectActivityCounters?` を追加（同上）。
     - `packages/testkit` の `TenantSettingsStoreConformanceOptions`/
       `MemoryStoreConformanceOptions` に対応する新しい適合フラグ・フィクスチャを
       追加した場合、ADR 0165 の 2026-09-16 訂正と同じ「`packages/testkit` の
       破壊的変更も見落とさない」規律に従う（本 ADR の実装 PR で具体的に確認する）。

- **検討した代替案**:

  1. **`tenant_settings` の列（例: `activity_counting_unit: 'tenant' | 'subject'`）。**
     ⛔ 落とした。理由は2つ: (a) オーナーが明示的に「呼び出す際の引数で」と
     書いており、テナント単位の設定は粒度が違う。(b) 呼び出しごとに選べない
     ——「保守操作はテナント単位、通常の recall は subject 単位」のような
     使い分けができない。ただし内部の保守呼び出し（tick 経由の自動ジョブ）に
     漏れなく伝播する利点はあり、テナント単位で一律の運用をしたい採用者には
     この案のほうが向く可能性がある——これは今回採らなかったというだけで、
     将来の拡張の余地として記録しておく。

  2. **`Runtime`（`createRuntime` の設定）単位。**
     ⛔ 落とした。1つの `Runtime` インスタンスは通常複数テナントを跨いで使われる
     （`ctx.tenantId` で切り替える設計）——テナントごとに数え方を変えられない。
     北極星「使う側が決められる」（目指す姿7）が指す「使う側」は呼び出し側の
     判断であり、インスタンス生成時に固定してしまうと、テナントごとの事情
     （recall 頻度・subject の数）に応じた柔軟性が失われる。3案の中で最も
     筋が悪いと判断した。

  3. **絞らない recall・掃引では `S_x` を無視して `T` のみで判定する（読み取りの
     割り切り）。**
     ⛔ 落とした。同じ記憶が「テナント全体 recall では見える」のに「その記憶の
     subject に絞った recall では見えない（`S_x` が大きいため）」という一貫性の
     ない意味論になる。「都度計算」（決めたこと3・5）で正しく解くほうが、
     `hasSubjectActivityCounters?` による最適化（決めたこと4）と組み合わせれば
     既定のテナントの代償を払わずに済む。

  4. **`reinforce`/`resolveActivityClockInputs` を対象ごとに個別解決する
     （引き受けた負債7 を解消する）。**
     ⛔ 今回は採らなかった。`MemoryStore.reinforceMany?` の契約（`at`/`opts` は
     呼び出し全体で1つ）を破る変更になり、本 ADR の範囲（呼び出し引数の追加）
     を超える設計変更になる。`ctx.subjectId` が対象と一致しない稀なケースの
     扱いは、今後の Issue で扱う。

- **確かめたこと（変異試験、`AGENTS.md` の作法——`cp` で退避 → 変異 → 対象の歯が
  赤くなることを確認 → 復元）**:

  | # | 変異 | 結果 |
  |---|---|---|
  | 1 | `'subject'` で `T` も進めてしまう（`advanceActivityClock` を常に `true` に） | `packages/core/src/__tests__/activity-counting-per-call.test.ts` の `'subject'` ケースが赤 |
  | 2 | `ctx.subjectId` が無い `'subject'` で何も進めない | 同ファイルの「`ctx.subjectId` が無い recall は `T` を進める」ケースが赤 |
  | 3 | 既定 `'tenant'` でも `S` を進める（`ctx.subjectId` があれば常に subject scope に） | 同ファイルの「既定 `'tenant'`」回帰確認ケースが赤 |
  | 4 | テナント全体の判定で `S_x` を無視する（`recall-runtime.ts` の `decayFloorSeqUsesSubjectCounters` を `false` 固定） | ⚠ **core 側の Fake テストは赤くならなかった**——後置フィルタ（`activityAxisAlive`）という多層防御が同じ判定を再現するため。段1 SQL 単体を直接叩く `packages/postgres/src/__tests__/activity-counting-per-call.postgres.test.ts` を新設し、そちらでは赤になることを確認した |
  | 5 | `S_x` を別 subject の記憶にも足す（相関サブクエリの `subject_id` 条件を外し `sum()` にする） | 上記 postgres テストが赤（A が B の `S_x` で沈む） |
  | 6 | 作成時の `base_seq` に `S_x` を足し忘れる（`resolveActivityClockInputs` が `tenantSeq` のみ返す） | `decay-activity-clock-writes.test.ts` の新設ケースが赤 |

  **変異4が core 側では検出できなかったことは、ADR 0165 が既に持っていた
  「多層防御（段1の押し下げが壊れても後置フィルタが拾う）」という設計の性質が、
  そのまま本 ADR にも当たることの実地の確認である**——欠陥ではなく、設計どおり。
  ただし「段1 SQL 自体が正しいか」は後置フィルタでは検証できないため、
  postgres 側の専用テストを本 ADR の一部として追加した。

- **引き受けた負債**:

  1. **決めたこと7 のとおり、`resolveActivityClockInputs`/`resolveReinforceNowSeq`
     は `ctx.subjectId` を基準にする**——対象 Memory 自身の `subjectId` とは
     一致しない稀なケースがありうる。
  2. **`processReflectJob`（tick の自動 reflect ジョブ）は ADR 0317 の
     `processConsolidateJob` 相当の対応（種の subject に scopedCtx を合わせる）を
     していない**——これは ADR 0317 自身が「範囲外」として引き継いだ負債であり、
     本 ADR もそれを追って直していない。
  3. **`tenant_subject_activity` は `activityCounting: "subject"` を使い始めた
     テナントで、subject の種類だけ recall ごとのホット行になりうる**——
     `tenant_activity`（ADR 0165 引き受けた負債1）と同じ性質。測っていない。

- **これが覆るとしたら**:

  - `resolveActivityClockInputs`/`resolveReinforceNowSeq` が `ctx.subjectId` と
    対象の不一致で誤った値を書いていることが実運用で問題になったとき
    ⟹ 対象ごとの個別解決（検討した代替案4）を実装する。
  - `tenant_subject_activity` のホット行が実測で問題になったとき ⟹ ADR 0165
    「これが覆るとしたら」3 と同じ対処（概算に緩める、`recalls` テーブルから
    導出する形へ動く）を subject 側にも適用する。
  - tick の自動ジョブにも `activityCounting` を伝播させたいという要求が実際に
    出たとき ⟹ `RuntimeConfig` にジョブ既定の `activityCounting` を持たせる
    設計を検討する（本 ADR では見送った——決めたこと1 が「呼び出しごと」に
    絞ったため、自動ジョブへの伝播は別の判断を要する）。

- **確かめていないこと**:

  - 実運用の recall 頻度・subject の数は測っていない（ADR 0311 と同じ限界が
    そのまま残る）。
  - `tenant_subject_activity` を使うテナントでの段1 SQL の EXPLAIN プラン
    （相関サブクエリを含む場合の性能）は、小規模なテストデータでしか確認して
    いない——大規模テナントでの実測は今後の課題。
