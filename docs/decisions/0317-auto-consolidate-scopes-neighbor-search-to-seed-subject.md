# ADR 0317: 自動経路の `consolidate` ジョブは、近傍探索を種の subject に絞る — 案 S を採る

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-25

> **⚠ この ADR は、クローンの委譲で動くセッション（`mgr-4bf05114` 配下の作業者）が書いた。
> ⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> 判断の出自: [ADR 0310](./0310-subject-crossing-consolidate-frequency-measured.md)
> 「オーナーへ返すもの」が案 S・T・B の3択を並べて保留した点について、クローン
> （オーナーの価値観の写し）が S を選んだ。理由は下の「決定」に書く。

**⚠ 各主張の出所を分ける**（ADR 0290 / 0302 / 0310 の体裁を踏む）。

- **【実測】** — この作業で、`packages/core` の単体テスト（testkit 相当の私的な in-memory
  実装 `runtime-fakes.ts`、`docs/architecture.md` §4「core は testkit に依存しない」）と、
  自分専用の Postgres（`initdb`）に対して実際に確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【算出】** — 実測値や式から導いただけ。走らせていない。

---

## 文脈

[Issue #579](https://github.com/takecchi/mnemora/issues/579) 困りごと1（`consolidate` が
subject をまたぐと、統合後の `Memory.subjectId` が `null` に畳まれる）について、案 D は
着地済み（PR #684、ADR 0289）、案 A・C は不採用、案 B は
[ADR 0310](./0310-subject-crossing-consolidate-frequency-measured.md) が測定の上で不採用
と決めた。

ADR 0310 は同時に、**自動経路（`RuntimeConfig.autoQueueConsolidateReflectOnExtract: true`
のときに `tick()` が処理する `consolidate` ジョブ、`packages/core/src/runtime.ts` の
`processConsolidateJob`）だけは、呼び手が塞げない**ことを実測した——`tick()` は
`ClaimOutboxJobsOptions` に `subjectId` が無いためジョブを subject で絞って claim できず、
`ctx.subjectId`（呼び手が `tick()` に渡した値）と種の `subjectId` の食い違いが、subject を
またぐ統合の主な経路だった。ADR 0310 はこの扱いを3案（S・T・B）並べて**オーナーへ返し、
決めなかった**。

本 ADR は、オーナーが 2026-09-24 に「決められるものは判断で進めてよい」と述べたことを受けた
クローンの判断として、**S を採る**ことを決める。

## 決定

1. **案 S を採る。** `processConsolidateJob` は、種の Memory の `subjectId` を
   `ctx.subjectId` に置いてから `consolidate(ctx', { target: { seedMemoryId } })` を呼ぶ。
   種の `subjectId` が `null`、または種そのものが見つからない場合は、**今日どおり**
   `tick()` に渡された `ctx` のまま呼ぶ——新しい判定は発明しない。
   - 実装は `packages/core/src/runtime.ts` の `processConsolidateJob` の中だけ:

     ```ts
     async function processConsolidateJob(ctx: Ctx, job: OutboxJobRecord): Promise<void> {
       const seedMemoryId = readSeedMemoryIdFromPayload(job);
       const seed = await deps.memoryStore.get(ctx, seedMemoryId);
       const scopedCtx: Ctx =
         seed !== null && typeof seed.subjectId === "string"
           ? { ...ctx, subjectId: seed.subjectId }
           : ctx;
       await consolidate(scopedCtx, { target: { seedMemoryId } });
     }
     ```

   - **公開型は1つも変えていない。** `RuntimeConfig`・`ConsolidateOptions`・
     `ConsolidateTarget`・`ConsolidationResult` のどれも変更していない
     （`node scripts/check-public-api-surface.mjs` が緑、下の「歯」参照）。
   - **`tick()` に渡された `ctx.subjectId` が種と違っても、種の subject を優先する。**
     ADR 0310 §3・§4 が実測したとおり、ジョブは subject で絞って claim できないため、
     `ctx.subjectId` と種の不一致こそが混在の主経路だった——`ctx.subjectId` を信じる側に
     倒すと、この主経路がそのまま残る。

2. **明示的な `runtime.consolidate(ctx, { target: { seedMemoryId } })` の挙動は変えない。**
   この変更は `processConsolidateJob`（`tick()` 経由の自動経路）だけに閉じている。
   `consolidate()` 本体・`{ memoryIds }`/`{ query }` 分岐は1行も変更していない。
   呼び手は自分の `ctx.subjectId` で完全に制御できる（ADR 0310 決定2、変わらず）。

3. **`reflect()` の自動経路（`processReflectJob`）は、今回は変えない。** ADR 0310
   「確かめていないこと」が「`reflect()` の `{ seedMemoryId }` 形の混在は、土台の選び方が
   同じなので同じ形になると推測しているが、測っていない」としていた点を、本 ADR も検算
   していない。範囲外——`docs/autonomy.md` §2「ついでに直さない」の適用。下の「確かめて
   いないこと」に引き継ぐ。

4. **既定値・公開 API・スキーマは変えない。** `RuntimeConfig.autoQueueConsolidateReflectOnExtract`
   の既定は `false` のまま。**フラグを有効にしていない利用者には何も起きない**——
   `processConsolidateJob` はそのフラグが `true` のときにだけ積まれたジョブを処理する
   経路であり、フラグを渡さない呼び出し（`main` 上の既定の姿）はこの分岐を一度も通らない。
   migration も不要——`packages/postgres` は無変更。

5. **CHANGELOG は Fixed に書く。** 1.x の minor（`autoQueueConsolidateReflectOnExtract: true`
   を有効にしている利用者から見て、subject をまたぐ統合が起きなくなるという挙動の変更だが、
   これは ADR 0310 が「Issue #579 が守りたい帰属に沿う」と判定した不具合の修正である
   ——新機能でも破壊的変更でもない）。

## なぜ S か（ADR 0310 の3択のうち）

ADR 0310 の表を引く:

| 案 | 中身 | 混在率 | 代償 |
|---|---|---|---|
| **S（採用）** | 種の `subjectId` を `ctx.subjectId` に置いてから consolidate を呼ぶ | **0%**（構造的） | opt-in 利用者から見て挙動が変わる（後述）。ADR 0152 却下案4 と緊張する（後述） |
| T | 現状維持。文書で警知するだけ | 使い方しだいで 0〜100%（shared 極では 100%） | Issue #579 の用途では、自動経路を有効にすると帰属が消える |
| B | `subjectId` を集合にする | 帰属は消えない | migration、索引の再設計、不変式の再設計 |

- **T は採らない。** Issue #579 が守りたいのは「A が言った X」と「B が言った X」を1つに
  畳まないという帰属である。自動経路（opt-in だが、有効にした瞬間に mnemora が自分から
  種を積む——ADR 0157 決定4）がこの帰属を構造的に壊せる状態を、文書の警告だけで放置する
  選択は、**opt-in を選んだ利用者が「有効にしても北極星の Memory Framework としての
  性質（帰属を保つ）が保たれる」と期待できない**——ADR 0157 決定4 自身が「これを無効に
  したとき Memory Framework として成立する」を検討した同じ基準を、有効にした側にも
  当てるべきだと判断した。
- **B は採らない。** ADR 0310 決めたこと1がすでに不採用と決めている。schema を変えずに
  0% にできる経路（S）がある以上、この判断は本 ADR でも覆らない。
- **S を採る。** 既定（フラグ `false`）の利用者には何も起きない。migration も要らない。
  帰属を守るという Issue #579 の要求を、自動経路でも構造的に満たせる——ADR 0310 が実測した
  「近傍探索を種の subject に絞れば、189 セルすべてで 0%」という構造的事実（埋め込みの質に
  依らない）を、そのまま自動経路にも適用するだけであり、**新しい類似度判定・新しい設計を
  発明していない**。

## ADR 0152 却下案4 との関係——緊張はあるが、破っていない

[ADR 0152](./0152-consolidate-seed-neighborhood.md) 却下案4は、「似ている」の定義に
**同一 `subjectId` を含める案を明示的に却下している**——逐語:

> **「似ている」を新しく定義する**（同一 `subjectId`・`occurredAt` の時間的近接・LLM に
> 判定させる、等）。却下。`recall()` が既に使っている `affinity` と別の定義を持つと、recall
> が近いと言うものと consolidate が近いと言うものが食い違う。

本 ADR はこの却下を覆さない。**S は「似ている」の定義（`computeAffinity`、
`strategies/consolidate.ts`）を1行も変更していない。** S が変えるのは、
`recall(ctx, { text: seed.digest })` に渡す **`ctx`（scope）** であり、`recall()` が
返した候補を「似ているかどうか」で判定する式ではない。これは ADR 0310 §3・§4 が
「`ctx.subjectId` に種の `subjectId` を渡せば、混在は起きない」と、既に呼び手向けの
回避策として書いていたのと**同じ機構**である——S は、その機構を自動経路（`ctx` を
呼び手が制御できない場所）にも適用しただけであり、`affinity` の定義に手を入れていない。

⟹ **緊張はある**（`ctx.subjectId` で絞ることは、結果として「同じ subject にいる」ことを
近傍候補の絞り込み条件に使っており、却下案4が拒んだ「似ている」の定義とは別の軸で
候補集合を狭める）。ただし ADR 0152 の決定3・4が固定した「`affinity` の式」そのものは
変わっていないため、**`recall()` が近いと言うものと `consolidate()` が近いと言うものは
依然として一致する**（S を適用した後の `consolidate()` は、`recall()` の scope を
`ctx'` に変えて呼ぶだけで、`recall()` 自身のランキング・閾値判定は1行も変えていない）。
ADR 0152 決定3 が守った不変条件（recall と consolidate の「似ている」の一致）は保たれる。

## `reflect()` を変えない理由（再掲、ADR 0152/0157 の先例に揃える）

[ADR 0152](./0152-consolidate-seed-neighborhood.md)「検討して採らなかった案」5・
[ADR 0157](./0157-tick-drives-consolidate-and-reflect.md)「採らなかった案」3 は、
`consolidate`/`reflect` を同じ PR で同時に変更しないという先例をすでに持っている
（`consolidate`/`reflect` は対称の土台選定だが、独立に変える理由が無い限り分けない、
ではなく——ここでは逆に、独立に変える理由が無い限り**両方に広げない**）。本 ADR は
Issue #579 が名指ししているのが `consolidate()`（統合による帰属の畳み込み）であり、
`reflect()`（内省による「足す」操作、supersede しない）には同じ帰属の畳み込みという
問題が存在するかどうかを検算していない。`docs/autonomy.md` §2「ついでに直さない」に従い、
`processReflectJob` は一切変更していない。

## 歯（変異試験で分かったこと）

`packages/core/src/__tests__/consolidate.test.ts` に describe
「`runtime.tick — consolidate ジョブは種の subjectId に近傍探索を絞る（Issue #579 / ADR 0317）」」
を3本足した:

1. `ctx.subjectId` 無しで `tick` を呼んでも、別 subject の高affinity近傍は混ざらない
   （混在 0%）。
2. `tick` に渡した `ctx.subjectId` が種と別でも、種の subject を優先する。
3. 種の `subjectId` が `null` なら、今日どおり `ctx` のまま呼ぶ（変えていないことの固定）。

**修正前に実際に赤くなることを確かめた**（`processConsolidateJob` を一時的に
`await consolidate(ctx, { target: { seedMemoryId } })` へ戻し、上の1・2番を実行）:

```
✗ ctx.subjectId 無しで tick を呼んでも…（混在 0%）
  AssertionError: expected null to be 'subject-a'
✗ tick に渡した ctx.subjectId が種と別でも…
  AssertionError: expected null to be 'subject-a'
```

（3番は修正前も修正後も緑——種の `subjectId` が `null` の分岐は変更していないため。
これは陽性対照ではなく、「変えていない」ことを固定する歯であり、赤くならないことが
正しい。）

修正を戻すと（`cp` で退避・復元。`git checkout` は使っていない——`docs/autonomy.md`
§4「未コミットの編集も一緒に消える」を踏まないため）、3本とも緑に戻ることを確認した。

同じ形の歯を、本物の Postgres + pgvector に対しても1本置いた
（`examples/chat/src/__tests__/subject-crossing-auto-consolidate.postgres.test.ts`、
`MNEMORA_EMBEDDING=deterministic`）。`packages/core` の単体テストは
`FakeMemoryStore`/`FakeVectorStore`（testkit ではなく `packages/core` 自身の私的な
偽物）を使うため、`MemoryStore.get` が subject で絞らないこと
（`packages/postgres/src/memory-store.ts`）・`VectorStore`/`recall()` の後置フィルタが
実際に SQL/JS の両方を通して subject を落とすことは、擬似物だけでは検査できない。
このテストも、修正を一時的に戻すと同じ形で赤くなることを確認した
（`expected null to be 'subject-a'`）。

## 測定 — 小さな格子での修正前後の混在率

ADR 0310 がすでに、`ctx.subjectId` の3変種（`none`／`own`／`mismatched`）を軸に
含む格子（S∈{2,5,10}、N∈{1,2,5,10,20,50,100}、pole∈{disjoint,shared}、
minAffinity∈{0.7,0.8,0.9}、real ONNX local embedding、26,028 dryRun 呼び出し）を
測定済みである。

**この3変種は、`processConsolidateJob` の修正前後の挙動と、`consolidate()` を呼ぶ
ときの引数の対応関係として、そのまま一致する**（新しく走らせなくても導ける対応）:

- **修正前**の `processConsolidateJob` は `consolidate(ctx, { target: { seedMemoryId } })`
  を、`tick()` に渡された `ctx` のまま呼ぶ。⟹ `tick()` の呼び手が `ctx` に subjectId を
  付けなければ ADR 0310 の `none` 列と同じ呼び出しに、種と別の subject を付ければ
  `mismatched` 列と同じ呼び出しになる。
- **修正後**は `consolidate({ ...ctx, subjectId: seed.subjectId }, { target: { seedMemoryId } })`
  を呼ぶ——`ctx` に何を渡していたかに関わらず、常に ADR 0310 の `own` 列と同じ呼び出しに
  一致する。
- ADR 0310 自身が「dryRun の `eligible` 集合は、同じ target で dryRun 無しで呼んだときの
  `superseded` 集合と完全に一致する」ことを別途確認済みとしており（同 ADR「測ったこと」）、
  `eligible`/`subjectId` の集合という観点では dryRun と実書き込みは同じ結論になる。

⟹ ADR 0310 の表から、**S∈{2,5}、N∈{1,5,20}、pole=shared（話題が重なる使い方、
Issue #579 の用途）、minAffinity=0.8（既定）** を抜いた表がそのまま
修正前後の対応表になる:

| N（subject あたり） | S=2 修正前（`none`/`mismatched`） | S=2 修正後（`own`） | S=5 修正前 | S=5 修正後 |
|---:|---:|---:|---:|---:|
| 1 | 100% | n/a（eligible < 2） | 100% | n/a（eligible < 2） |
| 5 | 100% | 0% | 100% | 0% |
| 20 | 100% | 0% | 100% | 0% |

（`n/a` は eligible が2件未満の試行しか無かったセル——ADR 0310 の生表と同じ表記。
「0%」ではなく「まだ2件揃わない」という意味であり、混ざりようがなかったことを言って
いるのではない点に注意——ADR 0310 の凡例に揃える。）

**⛔ この表は、`subject-crossing-measure.ts` に新しい腕を足して再実行したものではない。**
理由: `processConsolidateJob`（`dryRun` を持たない）を大規模格子で直接測ると、
1回ごとに実際に `superseded`/新規 Memory が書き込まれ、同じコーパス内の後続の種の
候補集合を汚染する——ADR 0310 の測定が `dryRun: true` を選んだのはこの汚染を避ける
ためであり（同 ADR「測ったこと」）、tick 駆動の腕を安全に足すには、格子の1セルごとに
使い捨てのテナント/コーパスを新しく作り直す必要がある。今回はその追加実装をせず、
上の対応関係（修正前=`none`/`mismatched`、修正後=`own`）を使って既存の測定を読み替えた。
**この読み替えが妥当である根拠は、`processConsolidateJob` の変更が `consolidate()` に
渡す `ctx` の1点だけであり、`consolidate()` 本体・`recall()` は1行も変更していないこと**
——両者は文字どおり同じ関数を同じ引数（`ctx` だけが違う）で呼んでいる。

## 検討した代替案

1. **案 T（現状維持・文書で警告するだけ）。** 却下（上の「なぜ S か」参照）。
2. **案 B（`subjectId` を集合にする）。** ADR 0310 決めたこと1がすでに不採用——
   本 ADR で再検討していない。
3. **`processConsolidateJob` 内で種を2回 `get` する代わりに、`consolidate()` の内部
   関数に「既に読んだ種」を渡す形にして、二重読みを避ける。** 却下——`consolidate()`
   本体の手順1（`{ seedMemoryId }` 分岐内で `deps.memoryStore.get` を呼ぶ箇所）を、
   `{ memoryIds }`/`{ query }` 分岐と分けて外から差し込める形に割り直す変更が必要になる。
   `MemoryStore.get` は主キー1件の索引読みで安価であり、この経路はそもそも opt-in
   （既定 `false`）の内側だけで、かつ同じジョブが既に払っている代償（近傍探索の
   `recall()` 1回・再埋め込み1回、条件により LLM 呼び出し1回、ADR 0152/0157 の負債）に
   比べて小さい。⟹ 1回の自動ジョブにつき `get()` が2回になることを引き受ける
   （下の「引き受ける負債」1）。
4. **`ctx.subjectId` が既に付いていればそれを優先し、種の `subjectId` は無視する。**
   却下——ADR 0310 §3・§4 が実測したとおり、`tick()` は subject で絞って claim
   できないため、`ctx.subjectId` を信じる側に倒すと「種と別の subject」の混在
   （ADR 0310 の `mismatched` 列、ほぼ100%）がそのまま残る。「決定」1 参照。

## 引き受ける負債・覆えていない範囲

1. **1回の自動 `consolidate` ジョブにつき `MemoryStore.get` が2回になる**
   （`processConsolidateJob` が1回・`consolidate()` 内部の `{ seedMemoryId }` 分岐が
   もう1回）。上の「検討した代替案」3で理由を書いた——主キー1件の索引読みで安価であり、
   opt-in の内側だけの代償である。
2. **`reflect()` の自動経路（`processReflectJob`）は変更していない。** ADR 0310
   「確かめていないこと」が推測にとどめていた「`reflect()` も同じ形の混在になるはず」を、
   本 ADR も検算していない——`consolidate` の帰属の畳み込みほど明確な「Issue #579 が
   守りたいものへの違反」として `reflect()` 側に同じ問題があるかどうかは未検討。
3. **測定の表（上の「測定」節）は、`processConsolidateJob` を実際に大規模格子で
   走らせたものではなく、ADR 0310 の既存測定からの読み替えである。** 対応関係の妥当性は
   コード上の等価性（`ctx` だけが違う同一呼び出し）に基づくが、**tick() 経由の実際の
   ジョブ処理（claim・リース・payload 検証を含む完全な経路）を大規模格子で走らせて
   確かめてはいない**——`packages/core` の単体テスト3本と Postgres の DB テスト1本
   （小規模、S=2 相当の3件のみ）が、この経路自体が動くことの実測である。

## これが覆るとしたら

- **「subject をまたいで統合し、両方の帰属を持たせたい」用途が実名で来たとき**
  （ADR 0310 が既に書いていた条件、B を採り直す）。
- **`reflect()` 側で同じ形の帰属の畳み込みが問題として実名で報告されたとき**
  （上の負債2、`processReflectJob` への S の適用を検討する）。
- **`tick()` に `ClaimOutboxJobsOptions.subjectId` のような subject 絞り込みの口が
  足されたとき。** そのときは「claim 自体を種の subject に絞る」という、S とは別の
  形（案の系譜としては ADR 0310 のオーナーへ返す節には無かった第4の案）が成立する
  可能性がある——本 ADR はその可能性を検討していない。

## 確かめていないこと

- **`reflect()` の `{ seedMemoryId }` 形の混在**（ADR 0310 から引き継ぎ、上の負債2）。
- **`processConsolidateJob` を大規模格子で tick() 経由で直接走らせた実測**
  （上の負債3。読み替えの表で代替している）。
- **`minAffinity` の既定値（0.8）が実運用で妥当かどうか**（ADR 0152 決定4から
  引き続き未実測——本 ADR の範囲外）。
- **本 ADR の変更が、`autoQueueConsolidateReflectOnExtract: true` を実際に有効にしている
  利用者が居るかどうか、居るとして何人か**——ADR 0310 §6と同じく確かめていない。
