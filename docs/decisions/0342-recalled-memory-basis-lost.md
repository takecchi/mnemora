# ADR 0342: `RecalledMemory` に任意欄 `basisLost?: true` を足す —— `inferred` の根拠が失われたことを、削除せずに印として返す（Issue #883）

- **状態**: 提案 (2026-09-26)
- **日付**: 2026-09-26

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**
> この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が要るなら、
> オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0246 / ADR 0282 / ADR 0289 / ADR 0298 / ADR 0335 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `git` / `vitest` / `tsc` / `pnpm` / `psql` を走らせて確かめた。
- **【受】** — 報告・Issue コメントとして受け取り、再導出していない（出所を明記する）。

断りの無い【現物】【実測】は、本作業の分岐点 `origin/main` = `efbf44d`（PR #928 のマージ）の
木で、2026-09-26 に行った。

---

## 文脈

### docs/memory-model.md §2 の約束と、その未実装の注記

[docs/memory-model.md](../memory-model.md) §2（69〜85行、本 PR の直前時点）は次を約束していた
（【現物】逐語）:

> **規律: 推論は根拠なしに提示しない。** `inferred` の Memory は `basis`（どの Memory /
> Observation から導いたか）を持つ。しかし `basis` が指す先が消えている場合がある——参照先が
> `forgotten` になった、あるいは `purge()` で本文が失われた（§9・§11）。この状態を隠さない。
> `basis` が解決できない `inferred` は、提示時に「根拠を失った推論」として印を付けて返す
> （削除はしない。推論という事実自体は消えていないため）。

同じ原則は [docs/vision.md](../vision.md):44 にも現れる。しかし §2 はその直後に
「⚠ 未実装（[Issue #883](https://github.com/takecchi/mnemora/issues/883)）」と注記していた
（この注記自体は PR #905——クローン miku の委譲先による docs-only PR——が足したもので、
コードは変えず「約束はあるが実装が無い」という状態を明記しただけだった）——
**約束はあるが、印を付ける経路がコードのどこにも無い**、という状態だった。【現物】
Issue #883 は次を確認済みとして開けてある: `Memory`（`packages/core/src/memory.ts`）・
`MemoryStore.get()` の戻り値・`recall()` が返す記憶のいずれにも「`basis` が解決できるか」を
運ぶ欄が無く、`packages/core` 全体を `根拠を失った|basisLost|orphanedBasis|lostBasis` で
grep して0件だった。

### `RecalledMemory` は今日も `provenanceKind` だけを返す（ADR 0035）

`RecalledMemory`（`packages/core/src/recall.ts:1196`〜）は `provenanceKind` だけを返し、
`provenance` 全体（`basis`/`confidence`/`model`/`promptVersion` を含む）は返さない。
この設計は [ADR 0035](./0035-recalled-memory-provenance-kind.md)（以下 §3・§5 で詳述）が
決めたもので、理由は「オーナーが求めているのは**区別**であって中身の追加ではない」——
`kind` だけを平らに持てば「そのうち `basis` や `confidence` も足そう」という圧力が
構造的に掛からない（`provenanceKind` の doc コメント、逐語。ADR 0035 自身は
`provenanceKind` の doc コメントから番号で引かれてはいないが、テスト
（`recall-pipeline.test.ts` の `usage.chars` 系の歯）が明示的に ADR 0035 §2 を名指ししている）。

**この設計と、Issue #883 の要求は表面上ぶつかる。** Issue #883 が求めるのは「`basis` が
解決できるか」という**`basis` の中身に依存する判定**であり、これを愚直に実装すると
「`basis` の一部を返す」ことになりかねない。本 ADR の決定1〜3（下）は、この緊張を
「**`basis` そのものは返さず、派生した1bitの印だけを返す**」という線で解く——ADR 0035 が
その後 ADR 0289/0298/0312/0335 で「判別に効く軸を欄として追加する」形で拡張されてきた
前例（下記「ADR 0035 との関係」）に、同じ形で1つ加える。

### `basis` を失う経路の現状（現物確認）

- 本番で `inferred` な Memory を作る経路は `extraction.ts:487` の1箇所だけであり
  （【現物】grep で確認）、そこは常に `basis: { memoryIds: [], observationIds: [observation.id] }`
  ——**`memoryIds` は常に空配列**で、`observationIds` だけを持つ。つまり今日の抽出パイプラインが
  作る `inferred` は、`basis.memoryIds` を根拠に失うことがそもそも無い（下記「引き受けた負債」）。
- Observation は**追記専用**——forget/purge/削除の経路がコードに無い
  （docs/memory-model.md §11 行1）。一括取得口（`getObservation` の複数版）も存在しない
  （`getObservation` は単件のみ）。
- Memory 側は forget（論理削除、`status: 'forgotten'`）と purge（物理的にトゥームストーン化、
  `purgedAt` を設定。`forgotten` からしか遷移できない——docs/memory-model.md §11 行10）の
  2段階を持つ。`purgedAt` は `Memory` の任意欄（`memory.ts` 215行付近）。

---

## 決定

### 1. `RecalledMemory` に任意欄 `basisLost?: true` を足す

型は `true` リテラル（`boolean` ではない）。zod は `z.literal(true).optional()` を
`RecalledMemorySchema` に足す。`provenanceKind === "inferred"` で、かつ `basis.memoryIds` の
少なくとも1件が「失われている」ときだけ `true` を書き、それ以外は**キー自体を出さない**
（`false` を返す設計にはしない）——`companionOf`/`contestedWith`/`associationOf` と同じ
`?: true` の作法。**basis の id そのもの（どの memoryId が失われたか）は返さない。**

### 2. 「失われている」の定義

次の3つのうち、どれか1つでも当たれば、その `memoryId` は失われている:

1. `MemoryStore.getMany` の結果に無い（存在しない・他テナント・adapter が期待する形式でない
   ——`getMany` の doc コメントが定める「静かに落とす」契約そのまま）。
2. `status === "forgotten"`。
3. `purgedAt` が非 `null`。

`archived`・`superseded`・`contested` は**失われていない扱い**——本文が残り、復帰する経路が
ある（docs/memory-model.md §11 行7・14・15）。「本文が読めるかどうか」を基準線に置いた
（「もう存在を主張していない」＝forgotten と「本文自体が消えた」＝purge だけを対象にする）。

### 3. `basis.observationIds` は確かめない

Observation は追記専用で forget/purge/削除の経路がコードに無く（§11 行1）、一括取得口も無い
（文脈節）。この限界は「探したが無かった」ではなく「そもそも探していない」——両者を混ぜない
という [ADR 0257](./0257-searched-and-found-nothing-versus-did-not-search.md) の区別を
この欄に当てる。`basisLost` は `basis.memoryIds` だけを見て決まる。`basis.observationIds` が
実際に失われていても（今日は失われる経路が無いはずだが、将来 Observation に削除経路が
入れば話が変わる——「これが覆るとしたら」参照）、この欄には一切反映されない。

### 4. 解決は recall のとき、budget 切り詰め後の最終結果に対して、`getMany` を1回だけ

**書き込み時の事前計算はしない。** `recall-runtime.ts` が `RecalledMemory[]` を組み立てる
唯一の箇所（下記「確かめたこと」参照）で、段4（予算による切り詰め）の後に確定した
`keptUnits` を対象に:

1. `provenanceKind === "inferred"` な記憶の `basis.memoryIds` を、重複を除いて集める。
2. 集めた id が1件以上あれば、`deps.memoryStore.getMany(ctx, [...集めたid])` を**1回だけ**呼ぶ。
   0件なら呼ばない。
3. 返ってきた `Memory[]` と、上の「失われている」の定義を使って `lostBasisMemoryIds: Set` を
   確定する。
4. `RecalledMemory` を組み立てる既存のループで、`inferred` かつ `basis.memoryIds` のいずれかが
   `lostBasisMemoryIds` に含まれる記憶にだけ `basisLost: true` を付ける。

**なぜ切り詰め後か**: `contestedWith`（ADR 0335）と同じ理由——まだ落ちるかもしれない候補を
対象に含めると、実際には返さない記憶の basis まで `getMany` してしまい、往復が「返した量」
ではなく「候補に上がった量」に比例してしまう。

### 5. `usage.chars` には数えない

`basisLost` はブール値の印であり、プロンプトへ積む文字量（`usage.chars`・`usage.byTier`）の
計算対象ではない。実装上も自然にそうなる——`usage.chars` は `digest` の連結長から計算され、
`basisLost` の有無はその計算に一切関与しない（[ADR 0035](./0035-recalled-memory-provenance-kind.md)
§2.1 が `provenanceKind` の文字を数えないのと同じ歯）。

### 6. `consolidated`/`reflected` の `provenance.sources` は扱わない

`ConsolidatedProvenance.sources`・`ReflectedProvenance.sources`（どちらも `memoryIds` の配列）
は、`basis` と似た「参照先」の欄だが、本 ADR の範囲には入れない——Issue #883・
docs/memory-model.md §2 の約束が名指ししているのは `inferred` の `basis` だけであり、
`sources` について同じ約束は無い。**扱わなかった、というだけであり、「`sources` は失われない」
という主張ではない。**

---

## ADR 0035 との関係

[ADR 0035](./0035-recalled-memory-provenance-kind.md) §3・§5 が定めた「`provenance`
全体ではなく判別に使う軸だけを返す」という設計原理を、この欄でも保つ:

- `basis` の**中身**（`memoryIds`・`observationIds` の実際の値）は一切返さない。返すのは
  「`inferred` の根拠が失われているか」という**派生した1bitの印**だけ。
- 中身が要る呼び出し側は `MemoryStore.get()` を引く——ADR 0035 が既に敷いている線
  （`provenanceKind` の doc コメント: 「そちらは『1件を詳しく見る』問いであり、recall の
  『何を返したか』とは別の問い」）をそのまま使う。
- [ADR 0312](./0312-observe-recall-caller-attributes.md) が引いた線「絞り込みに使える軸は載せる。
  使えない詳細は `get()` に残す」とは**異なる理由**でこの欄を載せている——`basisLost` は
  `RecallQuery` の絞り込み条件ではない（`attributes` のように呼び出し側が指定した軸ではなく、
  記憶自身の状態から導かれる）。載せる理由は ADR 0312 ではなく、docs/memory-model.md §2 の
  「提示時の約束」そのものである。
- digest 帯（目次帯、§5）には載らない——`basisLost` は `memories` に実際に入った記憶にだけ
  付く欄であり、目次帯の集約（`aggregateScope`）はこの欄を一切運ばない。
- `usage` にも入らない（決定5）。

---

## 採らなかった案

### 案A: `basisLost` を件数の欄にする（例: `basisLostCount: number`）

**却下。**「失われた basis の総数」を返す設計は、`basis.memoryIds` の総数自体を返さない以上
（ADR 0035 の原理をここで破らない限り）、部分喪失（「3件のうち1件だけ失われた」)を読み取る
意味が薄い——分母が無い分子は「何割が失われたか」に答えられない。`true`/キー無し の2値で
十分に「約束は守られているか」という問いに答えられる。

### 案B: `lostBasisMemoryIds: string[]` として、失われた id の一覧を返す

**却下。**ADR 0035 §3・§5 に反する——`basis` の中身（どの記憶を指していたか）を明示的に
返してしまう。「根拠が失われた」という事実を提示することと、「どの根拠を失ったか」を
提示することは別の問いであり、docs/memory-model.md §2 の約束が要求しているのは前者だけ。

### 案C: 書き込み時（`createMemory`/forget/purge のたび）に事前計算する

**却下。**forget/purge が起きるたびに、その Memory を basis として参照している **すべての**
`inferred` Memory を逆引きして印を更新する必要があり、逆引き索引（`basis.memoryIds` から
参照元への逆引き）を新設することになる——`MemoryStore` interface の変更・マイグレーションを
要し、「recall のたびに1往復増える」という軽い代償と比べて割に合わない。加えて、
逆引き更新を forget/purge の同一トランザクションに含めない限り、更新漏れ（forget したのに
印が古いまま）の窓が生まれる。決定4（recall 時点の解決）はこの窓を構造的に持たない
——常に「今」の `status`/`purgedAt` を読む。

### 案D: Observation の一括取得口を足し、`basis.observationIds` も確かめる

**却下（この PR の範囲外として）。**`MemoryStore`/`getObservation` 相当の一括版
（`getManyObservations` のような口）を新設すると、interface に新しいメソッドを追加すること
になり、「公開 API の変更は、この任意の欄の追加だけ」という本 PR の前提（マネージャーの
決定）を超える。加えて Observation には forget/purge/削除の経路自体が無いため（§11 行1）、
今日この口を足しても「失われる」が実際に起きない——今のところ実利が無いまま interface の
表面積だけが増える。

---

## 引き受けた負債

### 負債1: 本番の抽出パイプラインが作る `inferred` は、今日この印が立たない

`extraction.ts:487` が作る `inferred` の `basis.memoryIds` は常に空配列であり
（`basis.observationIds` だけを持つ）、決定3（`observationIds` は確かめない）と組み合わさると、
**今日の抽出パイプライン経由で作られた `inferred` は、`basisLost` が立つ経路を持たない。**
この欄が効くのは、`basis.memoryIds` を実際に書く生成経路（`MemoryStore.createMemory` を
直接叩く・将来 `memoryIds` を書く抽出/統合の経路が入る等）に限られる。docs/memory-model.md
§2 の約束（「`inferred` は `basis`（どの Memory / Observation から導いたか）を持つ」）は
`basis` が Memory も指しうることを前提にしているが、**今日それを実際に書く経路が無い**、
という Issue #883 が既に指摘していたギャップは、本 ADR の実装後もそのまま残る。

### 負債2: `basis.observationIds` の喪失は確認できない

決定3のとおり。Observation に削除経路が入れば、この負債はそのまま「見えない喪失」になる
（「これが覆るとしたら」参照）。

### 負債3: `consolidated`/`reflected` の `sources` は対象外

決定6のとおり。`sources` が指す Memory が forgotten/purge されても、この ADR の実装は
一切関知しない。

### 負債4: recall 1回あたり最大+1往復

決定4の代償——`inferred` を1件でも含む recall は、`basisLost` の解決のために
`MemoryStore.getMany` を追加で1回呼ぶ（往復数は `basis.memoryIds` の総数に依存しない。
「測ったこと」参照）。`inferred` を含まない recall には一切の追加往復が無い。

---

## これが覆るとしたら

- **Observation に forget/purge/削除の経路が入ったとき**——決定3（`observationIds` は
  確かめない）を見直す必要がある。一括取得口の新設（案D）も再検討の対象になる。
- **`inferred` の生成経路が `basis.memoryIds` を実際に書くようになったとき**
  （負債1）——本 ADR の実装はそのまま効くはずだが、「今日は滅多に発火しない」という
  前提（下記「確かめていないこと」）が崩れ、往復増加（負債4）が実運用の recall の
  多くで発生するようになる。そのときは、案C（書き込み時の事前計算）のコストが
  相対的に下がる可能性があり、再検討の価値が出る。
- **`consolidated`/`reflected` の `sources` についても同じ約束を課す決定が入ったとき**
  ——決定6を見直し、`sources` にも同様の喪失検出を広げる設計が必要になる。
- **`RecalledMemory` の欄を減らす方向の決定（ADR 0035 の原理そのものを変える決定）が
  入ったとき**——この欄も含めて再考が要る。

---

## 確かめたこと・確かめていないこと

### 【現物】確かめたこと

- `RecalledMemory` を組み立てる箇所は `packages/core/src/recall-runtime.ts` の1箇所
  （`finalMemories: RecalledMemory[] = keptUnits.flatMap(...)`）だけであること
  ——`grep -n "RecalledMemory" packages/core/src` で確認。`recall.ts` の
  `RecallRecordMemory`（`createRecall` 永続化用の別型、`docs/recall.md` の「後から
  再現できないものだけを持つ」型）は `RecalledMemory` とは別の型であり、この ADR の
  対象外（ADR 0298「6. 永続化には足さない」と同じ理由・同じ線）。
- `recall-output-validation.ts` は `RecallResultSchema.safeParse(draft)` を呼ぶだけで、
  `RecalledMemorySchema` を個別に import・特別扱いしていない——`RecallResultSchema` の
  `memories: z.array(RecalledMemorySchema)` を経由して自動的に検証される。この欄の
  追加に伴う変更は不要だった。
- `packages/testkit/src/__fixtures__/in-memory-memory-store.ts` の `getMany` は
  クロステナント・不在の id を静かに落とし、`purgeMemory`/`updateStatus` は `status`/
  `purgedAt` をそのまま `Memory` オブジェクトへ書く——決定2の定義がそのまま実装できる
  ことを確認した。
- `packages/postgres/src/memory-store.ts` の `getMany` は `SELECT * FROM memories WHERE
  tenant_id = ... AND id = ANY(...)` で、`rowToMemory`（`mapping.ts`）が `status`/
  `purged_at` を両方マッピングしていること。
- `memories_check`（`0001_init.sql` 68行）が `provenance_kind IN ('stated','inferred')`
  のとき `source_observation_id IS NOT NULL` を要求すること——Postgres 向けテストで
  `inferred` を作るには、先に本物の `Observation` を作る必要がある（テスト実装時に
  実際に制約違反で落ちて判明した）。

### 【実測】赤（実装前）

`packages/core/src/__tests__/recall-basis-lost.test.ts` を先に書き、`RecalledMemory` に
`basisLost` が無い状態で走らせた結果、次が赤になった（該当行のエラー、逐語）:

```
FAIL src/__tests__/recall-basis-lost.test.ts > recall() — RecalledMemory.basisLost（Issue #883、ADR 0342） > (a) basis の相手を forget した後、inferred の記憶には basisLost: true が付く
AssertionError: expected undefined to be true // Object.is equality

FAIL src/__tests__/recall-basis-lost.test.ts > recall() — RecalledMemory.basisLost（Issue #883、ADR 0342） > (b) basis の相手を forget してから purge した後も、inferred の記憶には basisLost: true が付く
AssertionError: expected undefined to be true // Object.is equality

FAIL src/__tests__/recall-basis-lost.test.ts > recall() — RecalledMemory.basisLost（Issue #883、ADR 0342） > 存在しない memoryId を basis に持つ inferred にも basisLost: true が付く（getMany が静かに落とす契約）
AssertionError: expected undefined to be true // Object.is equality

FAIL src/__tests__/recall-basis-lost.test.ts > recall() — RecalledMemory.basisLost の往復数（Issue #883、ADR 0342 決定4） > inferred が無ければ getMany は候補フェッチの1回のみ、1件の basis でも多数の basis でも+1回のまま増えない
AssertionError: expected 1 to be 2
```

（「基準が付かない」側の3件——basis が生きている・stated・archived/superseded——は、
`basisLost` キーが最初から存在しないので実装前から緑だった。これは「壊れていないことを
示す歯」なので赤くならないのが正しい。）

### 【実測】緑（実装後）

`packages/core/src/__tests__/recall-basis-lost.test.ts`（core、Fake、8 tests）・
`packages/postgres/src/__tests__/recall.postgres.test.ts` の新設 `describe`（Postgres、
2 tests）・`packages/postgres/src/__tests__/recall-roundtrip-count.postgres.test.ts` の
「歯4」（Postgres、往復数）を含め、全て緑。回帰確認として
`recall-pipeline.test.ts`・`recall-output-validation.test.ts`・`recall-association.test.ts`・
`recall-exclude-provenance-filter.test.ts`・`recall-companion-status-gate.test.ts`・
`recall.test.ts`・`recall-over-limit-promotion.test.ts`・`extraction.test.ts`・
`provenance.test.ts`・`schema-type-equals-parity.test.ts`（core、計298 tests）も実行し、
全て緑（テストの総数（298件等）は `main` が動けば変わる数であり、AGENTS.md「数を、道具と
生成物に焼き込まない」の対象——ここでは参考として書くが、正本はテストファイル自身である。
一方、上の「赤（実装前）」節に貼ったエラー文字列は、実装前に実際に走らせて観測した記録
そのもの——AGENTS.md が区別する「複製」ではなく「測った記録」であり、対象外）。

### 【実測】変異試験（`cp` で退避・復元。`git checkout` は使っていない）

`recall-runtime.ts` を `cp` で退避した上で、実装の判定を3種類に分けて緩め、狙った歯だけが
赤くなり、他は緑のままであることを確認した:

1. **forgotten 判定を外す**（`basisMemory.status === "forgotten"` の分岐を削除）——
   (a) forget のみの歯が赤、(b)（forget→purge）は purgedAt 判定が残っているため緑のまま
   （purgedAt が非nullなら依然 lost と判定される）。
2. **存在判定を外す**（`!basisMemory` の分岐を削除）——「存在しない memoryId」の歯が赤、
   他は緑。
3. **purgedAt 判定だけを外す**（forgotten・存在判定は残す）——「status が active のまま
   purgedAt だけが設定されている」専用の歯（この歯は `runtime.forget`→`runtime.purge` の
   公開経路では作れない状態を、`FakeMemoryStore.createMemory` へ直接 `purgedAt` を渡して
   作る——`purge()` は `forgotten` からしか遷移できないため、この状態は公開 API 単体では
   到達できない）だけが赤、他7件は緑のまま——**purgedAt 判定は独立に噛む歯を持てた**
   （事前の見込みでは「独立には噛まない可能性がある」としていたが、`FakeMemoryStore` が
   `input.purgedAt` を検証なしに書き込む口を持っていたため、実際には独立に噛ませられた）。

3種類とも、`cp` で退避したファイルへ復元後、同じ歯が緑に戻ることを実測した。

`packages/postgres` 側は実装を共有しているため（`recall-runtime.ts` は `packages/core`
にしか無く、`packages/postgres` はそれを import するだけ）、上と同じ「forgotten 判定を
外す」変異を1本、Postgres 向けの歯（`recall.postgres.test.ts` の新設 `describe`）に対して
再実行し、狙った歯が赤くなること・復元後に緑へ戻ることを確認した。

### 【実測】往復数

`packages/postgres/src/__tests__/recall-roundtrip-count.postgres.test.ts` の「歯4」で、
本物の Postgres（pg クライアントへのパッチで文の発行数を数える、既存の歯1〜3と同じ手法）
に対して次を確認した:

- `inferred` を含まない recall の往復数を基準値とする。
- `inferred` を1件（`basis.memoryIds` 1件）含む recall は、基準値 **+1**。
- `inferred` を5件（それぞれ `basis.memoryIds` 5件、のべ25件以上のユニークな id）含む
  recall も、同じ **+1**（基準値+1のまま増えない）。

`packages/core` 側（Fake）でも同じ関係を `recall-basis-lost.test.ts` の往復数の歯で確認
済み（基準値・+1件・+多数件の3パターンを比較）。絶対値そのものは本 ADR に焼き込まない
（AGENTS.md「数を、道具と生成物に焼き込まない」）——固定するのは歯自身が持つ相対関係
（比較）であり、絶対値は PR 本文に控える。

### 確かめていないこと

- **実運用（`examples/chat` 等）で `basisLost` が実際に立つ場面を、本物の LLM で再現する
  ところまでは確かめていない。**負債1のとおり、今日の抽出パイプラインは `basis.memoryIds`
  を書かないため、`createMemory` を直接叩く経路以外では発火しない——この ADR の歯は
  すべて `MemoryStore` を直接叩いて `basis.memoryIds` を持つ `inferred` を作っている。
- **`examples/chat` の回答プロンプト（`buildMnemoraPrompt` 等）が `basisLost` を実際に
  読んで何かを描画するかどうかは確かめていない・変更していない。**本 PR の範囲は
  `@mnemora/core` の型・runtime・ADR・docs までであり、`examples/chat` 側の消費は
  対象外（Issue #883 自体も `packages/core` の実装を求めていた）。
- **`RecallRecordMemory`（`createRecall` の永続化用の型）に `basisLost` を持たせるかどうか
  は検討していない。**ADR 0298「6. 永続化には足さない」と同じ判断を踏襲した（明示的な
  再検討はしていない——単に同じ前例に倣った）。
- **`purgedAt` が非 `null` で `status` が `forgotten` 以外という状態が Postgres の
  `purgeMemory` 経路で実際に作れるか**は確かめていない——`packages/postgres` の
  `purgeMemory` も `forgotten` からの CAS を課しているはずだが、この ADR の Postgres 向け
  変異試験は forgotten 判定の変異だけを再実行し、purgedAt 判定の独立性は core（Fake）側
  でのみ確認した。

---

## 参照

- Issue #883
- docs/memory-model.md §2・§9・§11
- docs/vision.md:44
- PR #905（docs/memory-model.md §2 に「⚠ 未実装（Issue #883）」の注記を足した、
  クローン miku の委譲先による先行 docs-only PR。マージ済み。本 ADR が置き換える
  注記そのものの出所）
- [ADR 0035](./0035-recalled-memory-provenance-kind.md)
- [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)
- [ADR 0257](./0257-searched-and-found-nothing-versus-did-not-search.md)
- [ADR 0289](./0289-recalled-memory-speaker-subject.md)
- [ADR 0298](./0298-recalled-memory-recorded-occurred-at.md)
- [ADR 0312](./0312-observe-recall-caller-attributes.md)
- [ADR 0335](./0335-recalled-memory-contested-with.md)
