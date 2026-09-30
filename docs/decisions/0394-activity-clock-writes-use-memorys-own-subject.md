# ADR 0394: 活動時計の書き込みは、`ctx` ではなく記憶自身の subject の `T + S_x` を使う（ADR 0353 の負債1の解消）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

> **⚠ 本文はクローンの委譲先が書いた。オーナー本人の執筆ではない。**方針（案A＋案B）はオーナー代理が承認済み。

---

## 問い —— [Issue #338](https://github.com/takecchi/mnemora/issues/338)、[ADR 0353](./0353-activity-counting-per-call.md) 引き受けた負債1

ADR 0353 は、ある記憶（subject `x`）の「有効ないま」を常に `T + S_x`（`T` = `tenant_activity.activity_seq`、`S_x` = `tenant_subject_activity.activity_seq`。
主題なしの記憶は `T` のみ）と決めた。**読む側**（段1 SQL `packages/postgres/src/activity-decay-sql.ts`・段2 `recall-runtime.ts` の `effectiveNowSeqFor`・掃引）は、
行ごとにその記憶自身の `S_x` を足しており、正しい。

**書く側**は違った。新しい記憶の起点（`decayBaseSeq`/`decayFloorSeq`）と、強化した記憶の起点を「いま」から作るとき、
`runtime.ts` の `resolveActivityClockInputs`・`resolveReinforceNowSeq` は `x` に **`ctx.subjectId`** を使っていた。
ADR 0353 決めたこと7 と引き受けた負債1 が「対象 Memory 自身の `subjectId` とは一致しない稀なケースがありうる」と書いて残した点である。

**稀ではなかった。** `ctx.subjectId` と、書かれる記憶の `subjectId` がずれる経路（現物で確かめた。行は `main` 145394c の `runtime.ts`）:

| 経路 | ずれる理由 |
| --- | --- |
| 抽出（sync・reextract） | LLM の `candidate.subjectId` が ctx と違う（`extraction.ts` の `candidate.subjectId ?? observation.subjectId`）。`observe` の `input.subjectId` が ctx と違う。`candidate.subjectId = null` で主題なしになる |
| 抽出（deferred。`tick` の `processExtractJob`） | `tick` の ctx には通常 `subjectId` が無い。記憶は観測の subject（alice 等）で作られる |
| 使用報告の強化（`recordUsage`／`recordUsageAndReinforce`） | `reinforceMany` は同じ `opts` を全件に適用する。1回の報告に subject の違う記憶が混ざる |
| `restoreArchived`・`restoreSuperseded` | 同上（`reinforce`／`reinforceMany`） |
| consolidate 手順6・reflect 手順7 | 結果の subject は eligible 全件が一致すればその値、割れれば `null`。ctx とは無関係に決まる（`{memoryIds}` 形も同じ） |

`tick` の `processConsolidateJob`・`processReflectJob` は、種の subject に ctx を合わせるので、この点では既に正しい（#851、Issue #820、ADR 0317）。

**実害の最大例**（前段の調査の実測。**本 PR では再現していない**）: `tick` の ctx が subjectless のとき、`S_alice = 3500` の alice の記憶が、
作成・強化の直後から強さ 0.034 で忘却ゲートの下にいた（起点が `T` のみで書かれ、読む側は `T + 3500` で読むため、床がとうに過ぎている）。
**取り違えが効くのは `tenant_subject_activity` に行があるテナント**（`activityCounting: "subject"` を使ったテナント）だけである。

## 決めたこと

### 決定1（案A）. 新しい記憶の起点は、**その記憶自身の subject** の `T + S_x` で計算する

- `resolveActivityClockInputs` を分けた。`resolveActivityClockBase`（`T` と `halfLifeRecalls`。`'wall'` なら何も読まず `undefined`）と、
  `readActivitySeqForSubjects`（**distinct な subject の `S_x` をまとめて1回で引く**。`hasSubjectActivityCounters` が `false` なら引かない。主題なしだけなら引かない）。
  Memory ごとに `activityClockInputsFor` が `T + S_x` を組んで build 系へ渡す。
- 各 Memory の `subjectId` が**決まった後で**引く。subject の決め方（候補 → observation、eligible の一致）は、内部の `packages/core/src/memory-subject.ts`
  1箇所にまとめ、build 系（`buildNewMemoryFromCandidate`・`buildConsolidatedMemory`・`buildReflectedMemory`）と runtime の両方がそれを使う（公開の面には出さない）。
  規則が2箇所にあると、起点が別の subject の値で書かれる食い違いがまた起きる。
- 対象: 抽出（sync／deferred／reextract。`buildNewMemoriesForCandidates` を通る全経路）、consolidate 手順6、reflect 手順7（`{memoryIds}` 形を含む）。

### 決定2（案B）. 強化は、store の UPDATE の中で行ごとに Memory 自身の `S_x` を足す（`ReinforceOptions.addOwnSubjectSeq`）

- 強化は、呼び出し側が対象の subject を知らない（強化の前に読み直さない）うえ、`reinforceMany` の契約は「`at`/`opts` は呼び出し全体で1つ」である。
  そこで **`ReinforceOptions` に任意項目 `addOwnSubjectSeq?: boolean` を足した**。`true` のとき `nowSeq` は `T` だけを意味し、
  store が**強化される行自身の subject の `S_x`** を足した `T + S_x` を `decay_base_seq` に、その起点からの床を `decay_floor_seq` に書く。
- **非破壊**: 任意項目を1つ足すだけ。省略・`false` のときは `nowSeq` をそのまま起点にする（今までと同じ）。
- **store が「読める」ことを宣言する（決定2b）**: `MemoryStore.supportsAddOwnSubjectSeq?(): boolean`（任意メソッド）を足した。**宣言が無い store（未実装・`false`）には、runtime は今までどおりの値**
  （`T + S_ctx` をそのまま `nowSeq` に入れ、`addOwnSubjectSeq` は付けない）**を渡す**。`true` を宣言する store にだけ、`T` と `addOwnSubjectSeq: true` を渡す。
  ⟹ この項目を知らない第三者の adapter は、この ADR の前より悪くならない。`PostgresMemoryStore` と testkit の `InMemoryMemoryStore` は `true` を宣言する。
  宣言の形は、runtime が「口が在るか／`true` を返すか」を見て分岐する既存の作法（`hasSubjectActivityCounters?`（`TenantSettingsStore`）、`reinforceMany?`・`recordUsageAndReinforce?`・`archiveDecayed?`（`MemoryStore`））に揃えた。
  `supportsXxx` の名前は testkit の適合テストの**オプション**（`supportsEraseTenant` 等。テスト側の、runtime からは見えない旗）にあるが、runtime が読む宣言は core の interface 上の任意メソッドなので、メソッドにした。
  **作成側（決定1）は runtime だけで完結し、宣言に依存しない**（build 系に `T + S_x` を渡すだけで、store の対応は要らない）。
- Postgres: `reinforce` は SET 句の中、`reinforceMany` は UPDATE の中で、**読む側（段1・`aggregateScope`・`archiveDecayed`）と同じ相関サブクエリ**を使う
  （`activity-decay-sql.ts` の `subjectActivitySeqOrZero` に切り出して共有した。書く側と読む側で引き方が食い違わないため）。
  床は `起点 + ceil(offset)`（`defaultActivityDecayStrategy.floorAt` の式。`baseSeq: 0` で相対だけを JS で取り、起点は SQL 側で足す。`Number.MAX_SAFE_INTEGER` で丸める規律も同じ）。
  **`reinforceMany` の定数2往復・「同じ `opts` を全件に適用」・`recordUsageAndReinforce` の1トランザクション（#961）の形は変えていない。**
- runtime の `resolveReinforceOptions` は、`hasSubjectActivityCounters` が `true` で**かつ store が宣言しているとき**だけ、`nowSeq` に `T` だけを入れて `addOwnSubjectSeq: true` を付ける。
  `false`（`tenant_subject_activity` に行が無いテナント）では付けない——`S_x` はどの行でも `0` で結果が同じであり、store は相関サブクエリを足さず、SQL は今日と同じままである（ADR 0353 決めたこと4）。
- testkit の in-memory fixture と core のテスト用 fake にも実装し、`describeMemoryStoreConformance` に適合テストを足した（宣言した store にだけ当てる。行ごとの解決、ctx の subject に依らないこと、`reinforceMany`・`recordUsageAndReinforce`、省略・`false` は `nowSeq` そのまま、`nowSeq` が無ければ何もしない）。

### 決定3. 変えないもの（オーナーに問い合わせ中。触らない）

- 保守の操作（consolidate・reflect・掃引）の中の `recall()` が活動時計を進めること。
- `tick` の自動ジョブに `activityCounting` を届けないこと。
- recall 側の前進が `T` か `S_ctx` か。

`runtime.ts` の 🔴 負債コメントは、解消した点（subject の取り違え）を書き換え、いま残っている上の3点と、下の負債1を書き直した。

## 採らなかった案

1. **強化の前に対象を読み直し、runtime が subject ごとに `reinforceMany` を分けて呼ぶ。** 往復が subject の数だけ増え、`reinforceMany` を束ねた目的（Issue #874、定数往復）と
   `recordUsageAndReinforce` の1トランザクション（#961）を崩す。ADR 0353 が採らなかった案4（対象ごとの個別解決を runtime でやる）と同じ理由で退けた。store の UPDATE の中で行ごとに解けば、往復は増えない。
2. **`ctx.subjectId` を対象に合わせて置き換える（`tick` の `processConsolidateJob` が種の subject に ctx を合わせたのと同じ）。** consolidate・reflect の種は1つだが、
   抽出の候補・使用報告の記憶は1回の呼び出しに複数の subject が混ざる。ctx は1つしか持てない。
3. **store が `tenant_activity`（`T`）も読んで、`nowSeq` を要らなくする。** ADR 0037「時刻は呼び出し側が渡す」・`ReinforceOptions.nowSeq` の doc が退けている（store が自分で読みに行かない）。
4. **読む側を `ctx.subjectId` に合わせる。** 読む側は正しい。向きが逆である。
5. **宣言なしで、常に `addOwnSubjectSeq: true` を渡す（この ADR の初稿の形）。** 項目を知らない第三者 adapter が、ctx と記憶の subject が一致する呼び出しでも `S_x` を足されず、以前より悪くなる。オーナー代理の決定で、宣言のある store にだけ渡す形（決定2b）にした。
6. **subject が一様なときだけ `T + S_ctx` を渡す互換の経路を runtime に足す。** 強化の前に対象を読み直す（採らなかった案1）ことになるので退けた。宣言の無い store は今までどおりの値で足りる。

## 引き受けた負債

1. **`addOwnSubjectSeq` を知らない第三者の `MemoryStore`** は、`supportsAddOwnSubjectSeq?()` を宣言しなければ、runtime が今までどおりの値（`T + S_ctx`・フラグなし）を渡すので、**この ADR の前より悪くならない**（決定2b。初稿の負債1を、store の宣言で解消した）。
   ただし、**宣言の無い store では、強化される記憶の subject が `ctx.subjectId` とずれる呼び出しで、この ADR 以前と同じ取り違えが残る**（作成側は直る）。直すには、その adapter が `reinforce`/`reinforceMany` に `addOwnSubjectSeq` を実装して宣言すること
   （TSDoc と適合テストに書いた）。型は壊れない（任意メソッドと任意項目）ので、公開 API の破壊的変更には当たらない。**`supportsAddOwnSubjectSeq` を `true` と宣言しながら項目を読まない adapter は、testkit の適合テストが赤にする**が、宣言しない adapter の歯は skip される（宣言が外れたことは、宣言の歯が捕まえる）。
2. `hasSubjectActivityCounters` の読みが、`'activity'`/`'either'` のテナントの書き込み（抽出・consolidate・reflect の各1回、強化の各1回）に1往復ぶん増えた（主題なしだけの書き込みでは読まない）。
   従来は `ctx.subjectId` があるときに `S_x` を1往復で読んでいたので、subject 付きの書き込みでの純増は「有無の確認」の1往復である。**実測していない。**
3. `hasSubjectActivityCounters` が `false` と読まれた直後に、別の呼び出しが最初の subject カウンタ行を作ると、その書き込みは `S_x` を `0` として起点を書く。誤差は `S_x` の最初の数回ぶんに限られる（ホット行の話ではなく、読みの一瞬のずれ）。
4. ADR 0353 の負債3（`tenant_subject_activity` のホット行）は、本 ADR では触れていない。答えは ADR 0353 の追記に書いた。

## これが覆るとしたら

- 宣言しない第三者 adapter の、ctx と記憶の subject のずれによる誤りが実際に困ったとき ⟹ 強化の前に対象の subject を読み直し、subject ごとに `nowSeq` を分けて呼ぶ経路（採らなかった案1・6）を、宣言の無い store 向けに足す。
- Postgres の `reinforceMany` の UPDATE の相関サブクエリが、大きな群・大きな subject 数で計画を悪くすると実測されたとき ⟹ VALUES に `S_x` を持ち込む形（SELECT で subject の `S_x` を先にまとめて引く。往復は増える）を検討する。

## 確かめたこと

**赤 → 緑**（コマンドは PR 本文）。歯を先に書き、`origin/main`（4b46a3f）から切った worktree に、追加・変更した歯だけを置いて赤を確かめた。

- core `decay-activity-clock-memory-own-subject.test.ts`: 25 本のうち 19 本が赤（ずれる入力。制御・`'wall'`・カウンタ未使用の6本は緑）。実装後は緑。
- postgres `activity-clock-memory-own-subject.postgres.test.ts`（実物の `decay_base_seq`/`decay_floor_seq`。作成＝deferred 抽出・同期抽出、強化＝使用報告・`restoreArchived`）: 4 本すべて赤 → 緑。
- testkit 適合テスト（in-memory と Postgres の両方）: `addOwnSubjectSeq` の歯が赤 → 緑。

**変異試験**（`AGENTS.md` の作法。`cp` で退避 → 変異 → 狙った歯が赤 → `cp` で復元 → 緑に戻ることまで確かめた）:

| # | 変異 | 結果 |
| --- | --- | --- |
| M1 | 抽出の subject を `ctx.subjectId` にする | core 6 本が赤 |
| M2 | consolidate の subject を `ctx.subjectId` にする | core 3 本が赤 |
| M2b | reflect の subject を `ctx.subjectId` にする | core 3 本が赤 |
| M3 | `resolveReinforceOptions` が `addOwnSubjectSeq` を渡さない | core 6 本が赤（`restoreSuperseded` の歯も赤） |
| M7 | `readActivitySeqForSubjects` が常に空を返す | core 12 本が赤 |
| M8 | `hasSubjectActivityCounters` の確認を外す（カウンタ未使用のテナントでも引く） | 「`getSubjectActivitySeqs` を呼ばない」の歯が赤 |
| M9 | `resolveReinforceOptions` が常に `addOwnSubjectSeq: true` を付ける | 「カウンタ未使用では付けない」の歯が赤 |
| P1 | Postgres `reinforce`: `S_x` を足さない | conformance と postgres の 2 本が赤 |
| P2 | Postgres `reinforceMany`: 行の subject を `NULL` にする | 3 本が赤 |
| P3 | Postgres `reinforceMany`: 床に起点を足さない | 2 本が赤 |
| P4 | Postgres `reinforce`: 相関サブクエリの `tenant_id` を別テナントにする | 2 本が赤 |
| P5 | Postgres `reinforceMany`: `addOwnSubjectSeq` を無視する | 3 本が赤 |
| F1 | testkit の in-memory: `S_x` を足さない | 4 本が赤 |
| D1 | Postgres の宣言を外す（`false`） | 宣言の歯と、runtime 経由の強化の実物の歯 2 本（計 3 本）が赤 |
| D2 | runtime が宣言を無視して常にフラグを付ける | 宣言の無い store の歯 4 本が赤 |
| D3 | testkit の in-memory の宣言を外す | 宣言の歯が赤 |
| D4 | 宣言の無い store への渡し方で `S_ctx` を足さない | 3 本が赤 |
| D5 | 宣言の無い store にもフラグを付ける | 4 本が赤 |

## 確かめていないこと

- **実運用の規模**での `reinforceMany` の UPDATE の計画・所要時間（相関サブクエリは主キー `(tenant_id, subject_id)` の1点引きだが、`EXPLAIN` は取っていない）。
- **実害の最大例**（`S_alice = 3500`、強さ 0.034）は前段の調査の実測であり、本 PR では再現していない。本 PR の歯は小さい数（`T=10`・`S_alice=7`・`S_bob=20`）で起点の値を確かめている。
- 宣言しない第三者 adapter の実物（負債1）。リポジトリの外の実装は見ていない。宣言の無い store の歯は、フラグを読まずに `nowSeq` だけを使う偽の store で確かめた。
- 既に書かれてしまった起点（この修正より前に、取り違えた値で書かれた `decay_base_seq`/`decay_floor_seq`）の**遡っての修正は、していない**。強化・再作成で新しい値に置き換わるだけである。
- `hasSubjectActivityCounters` の追加往復（負債2）の実測。
