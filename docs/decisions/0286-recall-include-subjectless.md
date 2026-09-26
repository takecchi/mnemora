# ADR 0286: `recall()` に `includeSubjectless` を足し、「subject X、または主題なし」を1回で引けるようにする（Issue #608 項目③(b)）

- **状態**: 採用 (2026-09-24)
- **日付**: 2026-09-24

> **⚠ この ADR は、自動化された担い手（マネージャーのセッションからさらに切り出された
> worker セッション）が書いた。**投稿者名・コミット署名が `takecchi` になっていても、
> それはオーナー本人を意味しない
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR に書かれた設計判断は、マネージャーのセッションが Issue 本文・repo の規約を
> 読んで下したものであり、オーナー本人がこの文面を承認したものではない。**

**⚠ 各主張の出所を分ける**（ADR 0271/0282 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【実測】** — 実際に `vitest`/`tsc`/`node`/`psql` を走らせて確かめた。
- **【推論】** — 読解・設計判断から導いたが、実測ではない。

断りの無い【現物】は `origin/main` = `7c262da`（本作業の分岐点）の木で行った。

---

## 問い —— [Issue #608](https://github.com/takecchi/mnemora/issues/608) 項目③(b)

Issue #608 は4項目を並べ、[ADR 0271](./0271-extraction-candidate-subject-id-overrides-observation.md)
（PR #612）が項目①（抽出候補ごとに `subjectId` を持てるようにする）だけを実装した。
項目③は「`subjectId: null`（主題なし）の Memory の扱い」で、本文は3つの下位案を並べている:

> - (a) 「主題なし」を明示的に引ける指定
> - (b) **「subject X または主題なし」で引ける指定** ← いちばん効きます
> - (c) `consolidate` で `null` どうしを「一致」と見なさない（あるいは区別できる形で返す）

**マネージャーが (b) を選び、この ADR に切り出した。** (a)・(c) は選択肢のまま残す
（下の「採らなかった案」参照。**「ついでに直す」をしない**——`docs/autonomy.md`）。

Issue 本文はさらに、③の「いまどうなっているか」節で次の1文を残していた:

> ⚠ 同じファイルの `decayFloorSeq`（`:109-111`）は `IS NULL` を明示的に通しているので、
> **`subjectId` にその救済が無いのは意図的に見えます** —— そこの確認も含めて出しています

**本 ADR は、この問いに明示的に答える**（下の「`decayFloorSeq` の `IS NULL` 救済と
`subjectId` の等値フィルタは、そもそも別の種類の述語である」節）。

---

## 決めたこと

### 1. 欄の名前は `includeSubjectless?: boolean`。追加のみ

次の5箇所に、同じ名前・同じ意味の任意欄として足す（すべて optional、既定 `false`/`undefined`）:

- `RecallQuery.includeSubjectless`（`packages/core/src/recall.ts`) — 呼び出し側が渡す入力
- `RecallScope.includeSubjectless`（同ファイル） — `recall-runtime.ts` の段0が
  `RecallQuery.includeSubjectless` をそのまま写す
- `VectorFilter.includeSubjectless`（`packages/core/src/interfaces/vector-store.ts`）
- `LexicalFilter.includeSubjectless`（`packages/core/src/interfaces/lexical-store.ts`）
- `MemoryStore.aggregateScope` は `RecallScope` をそのまま受け取るので、型としての
  追加は不要——`scope.includeSubjectless` を読むだけ

**🔴 `RecallQuery` への追加は、依頼文が明示していなかった判断である。** 依頼は
「`RecallScope` に足し、adapter が受け取る絞りにも同じ意味の任意欄として渡す」とだけ書いて
おり、`RecallQuery` を名指ししていない。**しかし `subjectId` 自体が `RecallQuery` の欄では
なく `Ctx` の任意欄である**（`docs/recall.md`「⚠ `subjectId` を省略すると何が起きるか」
節、【現物】逐語「`subjectId` は `RecallQuery` の欄では**ない**。**`Ctx` の任意欄**である」）
——`includeSubjectless` を `RecallScope` へ運ぶ入口がどこにも無ければ、この欄は
永遠に `undefined` のままで機能しない。**`Ctx` に足す案は採らなかった**（`Ctx` は
`observe`/`tick`/`reextract` 等**すべての** interface メソッドが第一引数に取る汎用の
呼び出しコンテキストであり、`recall()` だけに意味を持つ欄を持たせると `Ctx` の
「テナント境界 + 整理の単位」という最小の役割を超える）。**`RecallQuery` に足すのが、
既存の `includeFullyDecayed`/`includeOutsideValidity`（どちらも `recall()` 専用の opt-out
を `RecallQuery` に持たせている）と同じ形であり、最も一貫している。**

### 2. `subjectId` は adapter に今までどおり渡す。`includeSubjectless: true` のときだけ `subject_id = X OR subject_id IS NULL` にする

postgres 側の実装（3箇所、後述）は、`opts.filter.subjectId !== undefined` のときだけ
述語を組み立て、`includeSubjectless === true` かどうかで二分岐する:

```ts
if (opts.filter.subjectId !== undefined) {
  conditions.push(
    opts.filter.includeSubjectless === true
      ? sql`(m.subject_id = ${opts.filter.subjectId} OR m.subject_id IS NULL)`
      : sql`m.subject_id = ${opts.filter.subjectId}`,
  );
}
```

**採る理由**: `subjectId` を adapter へ渡さず、core 側の後置フィルタ（`recall-runtime.ts`
の候補取得後のループ）だけで絞る案は、**ANN の窓（k'）を汚染する**——段1の
`VectorStore.search`/`LexicalStore.search` が `subjectId` で絞らずに候補を返すと、
無関係な別 subject の記憶が k' 件の枠を埋めてしまい、目当ての X・null の記憶が
段1の時点で落ちる（ADR 0023 が同じ形の問題を「subject の絞りを段1へ降ろす」ことで
解いた経緯そのもの）。この案は下の「採らなかった案」に載せる。

### 3. adapter がこの欄を無視しても安全——取りこぼしはあっても混入は無い

> **⚠ 2026-09-26 追記（本文は書き換えていない）。** 下の「既存の `FakeVectorStore`/
> `FakeLexicalStore`」は、この ADR を書いた時点の現物である。
> [Issue #948](https://github.com/takecchi/mnemora/issues/948) で、両 Fake は
> `includeSubjectless`（と `labels`）を適用するようになり、もうこの欄を知らない adapter の
> 例ではない。下の【実測】の describe は、素の `FakeVectorStore` の代わりに、
> `includeSubjectless` だけを剥がすラッパ（`IncludeSubjectlessIgnoringVectorStore`、
> `recall-subjectless-filter.test.ts` の中に閉じている）で同じ adapter の形を再現し、
> 同じ結論（取りこぼしはあるが、別 subject の混入は無い）を確かめ続けている。

`includeSubjectless` を実装していない adapter（既存の `FakeVectorStore`/
`FakeLexicalStore`・将来の第三社 adapter を含む）は、`subjectId` の厳密一致だけを見る。
⟹ **`subjectId: null` の Memory を取りこぼす**（本来なら返るはずのものが返らない）が、
**`subjectId` が別の値の Memory を混ぜて返すことは無い**——`opts.filter.subjectId` と
一致しない行を除外する既存のロジックは1バイトも変えていないので、安全側にしか壊れない。
これは【実測】で確認した（下の「測ったこと」の
`recall() — includeSubjectless を無視する adapter でも、別 subject が混ざることは無い`
describe を参照）。

### 4. 効かせた場所（揃えた経路）

**core（`packages/core/src/recall-runtime.ts`）**:

- 段0（スコープ確定）: `scope.includeSubjectless = validatedQuery.includeSubjectless`
- 段1・ANN チャンネル（`VectorStore.search` の filter）
- 段1・語彙チャンネル（`LexicalStore.search` の filter）
- 段3.5・連想枠（アンカーごとの `VectorStore.search` の filter。段1と同じ境界に揃える
  という Issue #347 / ADR 0172 の規律をそのまま踏襲）
- 段1の後置フィルタ・段3.5の後置フィルタ（全チャンネル共通の多層防御）—— 新設した
  `survivesSubjectFilter(memory)` に1箇所へまとめ、両方がこれを呼ぶ
  （`survivesDecayGate`/`survivesValidityGate` と同じ「1箇所に述語を置く」規律。
  ADR 0038 が測った「実装が2つあると食い違う」穴を避けるため）

**postgres（`packages/postgres/src`）**:

- `vector-store.ts`（段1の ANN 検索）
- `lexical-store.ts`（段1の語彙検索）
- `memory-store.ts`（`aggregateScope` の段5集計、`subjectFilter` の組み立て）

**testkit のインメモリ実装3つ（`packages/testkit/src/__fixtures__`）**:

- `in-memory-vector-store.ts`
- `in-memory-lexical-store.ts`
- `in-memory-memory-store.ts`（`aggregateScope`）

### 5. 自分で確かめた、他に `subjectId` で絞っている経路

- **段3（矛盾の解決・必須の同伴取得）**: `recall-runtime.ts` の `contestedNeedingCompanion`/
  `companions` の組み立ては `MemoryStore.getMany(ctx, companionIds)` を直接呼ぶだけで、
  **`subjectId` によるフィルタが元から無い**——対向する Memory を id 指定で強制的に
  同伴させる契約（`docs/memory-model.md` §5 機構3）であり、意図して subject を見ない。
  ⟹ **ここは変更不要**（`includeSubjectless` を持ち込む余地も無い）。
- **`gateVectorFilterFields`（Issue #347 / ADR 0172）の集約**: 忘却ゲート（`decayFloorAtAfter`/
  `decayFloorSeqAfter`/`decayFloorAnyAxis`）と `validAt` の4欄だけをまとめた断片であり、
  `subjectId` 自体はここに含まれていない（段1・段3.5 それぞれの filter オブジェクトへ
  直接書く）。**`includeSubjectless` も `subjectId` と同じ扱いにした**——
  `gateVectorFilterFields` へは足さず、`subjectId` の行のすぐ下に直接書く
  （`recall-runtime.ts` の該当2箇所）。
- **その他**: `packages/core/src/recall.ts`・`runtime.ts`・`extraction.ts` を
  `subjectId` で grep し、`observe()`/`tick()`/`reflect`/`consolidate` の各戦略が
  `subjectId` を読む箇所を洗ったが、recall の絞りとして使っているのは上に挙げた
  経路だけだった。`strategies/consolidate.ts` の
  `subjectIds = new Set(eligible.map((m) => m.subjectId ?? null))` は recall の絞りではなく
  統合後の `subjectId` を決めるロジックであり、③(c) の射程（下記「採らなかった案」）。

### 6. `subjectId` 無しで `includeSubjectless: true` は無視する（テナント全体と同じ）

`scope.subjectId === undefined` のとき、`survivesSubjectFilter`・postgres の3箇所・
testkit の3箇所は、いずれも `includeSubjectless` を見ない分岐（`if (subjectId !==
undefined)` の外側）に落ちる——**テナント全体は定義上すでに `subject_id IS NULL` の
Memory を含む上位集合であり、この欄が広げる余地が無い。** エラーにはしない。zod
スキーマ側も `includeSubjectless: z.boolean().optional()` に留め、`subjectId` との
相互依存を検証する規約は既存に無い（`RecallQuerySchema`/`RecallScopeSchema` はどちらも
フィールドごとに独立した `.optional()` の並びであり、`.refine()` 等の相互検証は
1件も無いことを grep で確認した——既存の規約が「エラーにすべき」と示唆している
箇所は見つからなかった）。この振る舞いは歯で固定した
（`recall-subjectless-filter.test.ts`「ctx.subjectId 無しで includeSubjectless: true を
渡しても、テナント全体（絞りなし）と同じになる」、testkit の3つの適合テスト
「subjectId 無しで true が渡っても、テナント全体（絞りなし）と同じになる」）。

---

## `decayFloorSeq` の `IS NULL` 救済と `subjectId` の等値フィルタは、そもそも別の種類の述語である

Issue 本文の指摘に逐語で答える。**【現物】** `ADR 0165`「決めたこと4」:

> **`NULL` は「この軸には床が無い＝活動時計では沈まない」を意味する。**
> 段1の述語は `'activity'` のとき `(m.decay_floor_seq IS NULL OR m.decay_floor_seq > $n)` と書く。
>
> - **緩い側（沈まない）へ倒すのは意図的である。** ADR 0153 が「黙って減らさない」を
>   選んだのと同じ向き——**列を足しただけで、今日返っていたものが明日返らなくなることが
>   あってはならない。**

`decayFloorSeq` は **Memory 1件ごとの、忘却ゲートという1つの機構の内部状態**である。
`decay_clock` を `'wall'` から `'activity'`/`'either'` へ切り替えたテナントの**既存行**は、
`decay_floor_seq` を書いた時点が無い（列を追加した時点で存在した行、または
`'wall'` のまま作られた行）ため `NULL` を持つ。この `NULL` を「沈まない」側へ倒すのは、
**「新しい忘却軸を足しただけで、昨日まで返っていた記憶が今日から返らなくなる」という
退行を防ぐ後方互換の安全弁**であり、ADR 0165 決めたこと4 が明言するとおり意図的である。

対して `subject_id` の等値フィルタ（`WHERE subject_id = X`）は、**忘却ゲートのような
「機構の内部状態」ではなく、「その Memory が何についてのものか」という一次的な意味論**
である。`subject_id` が `NULL` の Memory は、機構が計算し損ねた・まだ計算していない
値ではなく、**「主題を持たない記憶」という、それ自体が正しい・完結した値**である
（Issue #608 本文の例「明日台風が来る 主題 = なし」がまさにこれ）。**等値フィルタが
`NULL` を通さないのは、`WHERE x = X` という述語が SQL の3値論理として当然に持つ
振る舞いであり**（`NULL = X` は常に UNKNOWN であって TRUE にならない）、`decayFloorSeq`
の「NULL は緩い側」という個別の設計判断とは出どころが異なる——**`subjectId` に
同じ救済が最初から無かったのは、忘却ゲートの安全弁を作り忘れたからではなく、
そもそも「主題で絞る」ことと「忘却ゲートを適用する」ことが、別の種類の問いだからである。**

**この解釈が Issue 本文執筆時点で意図されていたか、記録から確かめられたか**:
【現物】`git log --all --oneline -- packages/postgres/src/vector-store.ts` と
関連 ADR（0004/0023/0056/0059/0153/0165）を読んだが、「`subjectId` の等値フィルタに
`decayFloorSeq` 型の `IS NULL` 救済を意図して持たせなかった」と明記した一次資料は
**見つからなかった**。⟹ **「意図的だった」と断定はできない**——見つかったのは
「`decayFloorSeq` の `NULL` 救済がなぜそうなっているか」を説明する記録だけであり、
「`subjectId` にそれが無いのはなぜか」を直接論じた記録ではない。**上の答えは、
両者の意味論の違いから導いた本 ADR の【推論】である。**

⟹ **本 ADR は、この違いを踏まえたうえで「既定は変えず、任意の口を足す」を選ぶ**
（次節）——`decayFloorSeq` のように「既定を緩い側へ倒す」設計を `subjectId` に
輸入すると、**`ctx.subjectId` を指定したすべての既存の呼び出しが、ある日から
主題なしの記憶まで受け取るようになる**——これは「列を足しただけで挙動が変わっては
ならない」という ADR 0165 決めたこと4 の教訓を、逆向きに破ることになる。

---

## なぜ「既定を変えずに任意の口を足す」を選んだか

**既定を変える（`subject_id = X` を常に `subject_id = X OR subject_id IS NULL` にする）
案は採らなかった。** 理由は2つ:

1. **既存の呼び出し側から見て破壊的である。** `ctx.subjectId` を指定して recall している
   すべての呼び出し（この repo 内では `examples/chat` を含む）が、ある日から主題なしの
   記憶まで受け取るようになる——型シグネチャは変わらない（`docs/migration-v1.md` の
   基準では検出されない）が、**実行時の挙動が変わる**。ADR 0178「引き受けた負債」4
   「型として書かれていない破壊（実行時の意味変更）は一切拾わない」が指す、まさに
   その種類の破壊であり、`api:check` の門も検出しない。
2. **`decayFloorSeq` の教訓と正反対になる。** ADR 0165 決めたこと4 が「列を足しただけで、
   今日返っていたものが明日返らなくなることがあってはならない」と定めたのと対称に、
   **「欄を足しただけで、今日返っていなかったものが明日から返るようになることも
   あってはならない**」——これも黙って挙動が変わる点では同じ種類の事故である。

⟹ **任意の口（opt-in）にすることで、この PR より前の挙動を1バイトも変えない。**
既定（省略・`false`）の recall は、今日までと同じ結果を返す——これは
`recall-subjectless-filter.test.ts`「includeSubjectless: 省略/false なら、主題なし（null）は
今日どおり返らない（回帰）」と、testkit の3つの適合テストの同名の歯で固定した。

---

## 採らなかった案

| 案                                                                                                   | 却下の理由                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`subjectId` を adapter に渡さず、core の後置フィルタだけで絞る**                                   | ANN の窓（k'）を汚染する——段1が subject で絞らずに候補を返すと、無関係な別 subject の記憶が k' 件の枠を埋め、目当ての X・null の記憶が段1の時点で落ちる。ADR 0023 が「subject の絞りを段1へ降ろす」ことで解いた問題を、この欄だけ後退させることになる                                                                                                                                                     |
| **既定を変える（`ctx.subjectId` を指定したすべての recall が、常に主題なしも含むようにする）**       | 上の「なぜ『既定を変えずに任意の口を足す』を選んだか」節のとおり、実行時の意味変更であり、型では検出されない破壊になる。`decayFloorSeq` の「既定は緩い側」という設計とは前提が違う（後方互換の安全弁 vs 一次的な意味論）                                                                                                                                                                                  |
| **(a) 主題なしだけを引く指定**（`subjectId: null` を明示的に渡すと `subject_id IS NULL` だけで絞る） | Issue 本文が「いちばん効く」と明記したのは (b) であり、(a) は (b) の下位互換ではない別の指定（X を条件から外す）。今回の依頼は (b) のみで、(a) は別の欄・別の設計判断（`ctx.subjectId` を `string \| null \| undefined` の3値に広げるか、`RecallQuery` に別の欄を足すか）を要る。`AGENTS.md`/`docs/autonomy.md`「ついでに直さない」に従い、この PR には含めない                                           |
| **(c) `consolidate` で `null` どうしを「一致」と見なさない（あるいは区別できる形で返す）**           | Issue 本文自身が「[#579](https://github.com/takecchi/mnemora/issues/579) と重なる。そちらに寄せても構わない」と明記している。#579 は `consolidate` が subject をまたぐと `subjectId` が `null` に畳まれ帰属が消える問題を別途扱っており、recall 側の絞り（本 ADR の射程）とは別の書き込み側の設計判断——同じ球を2つの PR が別々に動かすと食い違うおそれがある（Issue 本文の警告）ため、本 ADR では触らない |
| **`includeSubjectless` を `Ctx` に足す**                                                             | `Ctx` は `observe`/`tick`/`reextract`/`recall` 等すべての interface メソッドが第一引数に取る汎用の呼び出しコンテキスト（`docs/vision.md`「Tenant と Subject を混同しない」）。`recall()` だけに意味を持つ欄を持たせると、`Ctx` の最小の役割（テナント境界 + 整理の単位）を超える。既存の `includeFullyDecayed`/`includeOutsideValidity` と同じく `RecallQuery` に置くのが一貫している                     |

---

## 変異試験

`docs/autonomy.md`「⛔ 変異を戻すのに `git checkout` を使わない」に従い、各変異は `cp` で
退避してから変異を入れ、関係する歯を走らせ、`cp` で復元した。全8本の変異を1本ずつ
**実際に**当てて緑/赤を確認し（下に実測ログを貼る）、復元後は `git diff` で該当ファイルの
差分が無いことを都度確認した。

| #   | 変異                                                                                                                                                                    | 結果                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/postgres/src/vector-store.ts`: `includeSubjectless === true` 分岐を `false` に固定（常に厳密一致）                                                            | 🔴 赤: `conformance.postgres.test.ts`「`filter.includeSubjectless: true なら、一致する subject と主題なし（null）の両方が返る`」（VectorStore 版）1本のみ                                    |
| 2   | `packages/postgres/src/lexical-store.ts`: 同分岐を `false` に固定                                                                                                       | 🔴 赤: 同名の歯（LexicalStore 版）1本のみ                                                                                                                                                    |
| 3   | `packages/postgres/src/memory-store.ts`: `subjectFilter` の `includeSubjectless` 分岐を `false` に固定                                                                  | 🔴 赤: `conformance.postgres.test.ts`「`aggregateScope の scope.includeSubjectless: true なら...`」1本のみ                                                                                   |
| 4   | `packages/testkit/src/__fixtures__/in-memory-vector-store.ts`: `subjectMatches` の `includeSubjectless` 分岐を `false` に固定                                           | 🔴 赤: `in-memory-fixtures.conformance.test.ts`「同名の歯」（VectorStore 版）1本のみ                                                                                                         |
| 5   | `packages/core/src/recall-runtime.ts`: **段1の** post-filter 呼び出し（778行目）だけを、旧式の厳密一致（`includeSubjectless` を見ない）に差し替える。段3.5 側は手つかず | 🔴 赤: `recall-subjectless-filter.test.ts`「includeSubjectless: true なら、一致する subject と主題なし（null）の両方が返り、別 subject は返らない」1本のみ                                   |
| 6   | 同ファイル: **段3.5 の** post-filter 呼び出し（1269行目）だけを同様に差し替える。段1側は手つかず                                                                        | ⚠ **初回は全緑だった**（下の「見つけた穴」参照）。歯を1本足した後は 🔴 赤: 新設した「連想用 search() が subjectId/includeSubjectless を無視しても、段3.5 の後置フィルタが正しく絞る」1本のみ |
| 7   | `survivesSubjectFilter` を「`scope.includeSubjectless === true` なら別 subject も無条件に通す」形（混入方向）に変える                                                   | 🔴 赤: 段1・段3.5 それぞれの「別 subject は返らない」系の歯、計2本（`toContain(subjectBMemory)` 相当の assertion）                                                                           |
| 8   | `survivesSubjectFilter` を「`memory.subjectId === null` なら `includeSubjectless` を見ずに常に通す」形（既定破壊）に変える                                              | 🔴 赤: 段1・段3.5 それぞれの「includeSubjectless: 省略/false なら...返らない（回帰）」系の歯、計2本                                                                                          |

### 🔴 見つけた穴: 変異6が最初は全緑だった

**当初、`recall-subjectless-filter.test.ts` には段1（ANN 本線）の post-filter を検査する
歯しか無く、段3.5（連想枠）を専用に検査する歯が無かった。** そのため、変異6（段3.5の
post-filter だけを壊す）を当てても、既存の9本の歯はどれも赤くならなかった——**理由は
`recall-association-gates.test.ts` 冒頭のコメントが説明するのと同じ構造**: 既存の歯は
`association` クエリを渡していない（段3.5 自体を走らせていない）か、渡していても
`SubjectFilterStrippingVectorStore`（全 search() 呼び出しから subjectId/includeSubjectless
を剥がす）を使っており、**段1の post-filter が先に候補を絞り込んでしまうため、段3.5
固有の post-filter が実際に試される場面が無かった**。

**塞いだ方法**: `recall-association-gates.test.ts` の `AssociationGateStrippingVectorStore`
と同型の `AssociationSubjectFilterStrippingVectorStore`（**2本目以降の** search() 呼び出し
＝連想用の呼び出しからだけ subjectId/includeSubjectless を剥がす。段1の呼び出しはそのまま）
を新設し、アンカー + 連想候補（主題なし・別 subject）を仕込む歯を2本追加した
（`recall-subjectless-filter.test.ts` 末尾の describe）。追加後に変異6を再度当て、
新設した歯のうち1本が確実に赤くなることを確認した（上の表の#6）。

**⟹ 緑のまま残った変異は最終的に無かった**——ただし、それは最初の実装が偶然正しかった
からではなく、**変異試験そのものが歯の抜けを見つけ、その場で歯を足して塞いだ**という
経緯である。この経緯自体を記録として残す（`docs/autonomy.md` の変異試験の趣旨——
「歯があるはず」ではなく「実際に赤くなるか」を確かめること——にそのまま合致する）。

---

## 測ったこと

### 【実測】赤（実装前・抜粋）

`survivesSubjectFilter`/postgres の分岐を導入する前の状態から実装したため、
「赤→緑」の記録は次の1本にまとめる（新規テストはすべて実装後に書いたため、
実装前は「そもそも `includeSubjectless` という欄が存在せずコンパイルが通らない」
という形の赤になる。型を先に足してから振る舞いを実装する順序で進めたため、
「型は在るが分岐が無い」状態を経由していない）。

### 【実測】緑（実装後）

```
$ pnpm --filter @mnemora/core exec vitest run
 Test Files  68 passed (68)
      Tests  964 passed (964)

$ DATABASE_URL=postgres://postgres@/mnemora_test?host=/tmp/mgr-1e062424&port=55432 \
  pnpm --filter @mnemora/postgres exec vitest run src/__tests__/conformance.postgres.test.ts \
  src/__tests__/lexical-store-filter.test.ts src/__tests__/lexical-store-index.test.ts \
  src/__tests__/lexical-store-identifier.test.ts src/__tests__/recall.postgres.test.ts
 Test Files  5 passed (5)
      Tests  341 passed (341)
```

（964 は、変異6が見つけた穴を塞ぐために足した2本の歯を含む——実装直後は962本だった。）

### 【実測】変異試験（`cp` で退避・復元。`git checkout` は使っていない）

上の表の8本すべてについて、対応するファイルを `cp` で退避し、変異を入れ、関係する
テストファイルを再実行し、狙った歯だけが赤くなることを確認したうえで `cp` で復元し、
`pnpm --filter <package> exec vitest run`（core・postgres とも）が全緑に戻ることと
`git diff` が該当ファイルに差分を残していないことを再確認した。

### 【実測】公開 API スナップショット

`pnpm run build`（6パッケージ）の後、`node scripts/check-public-api-surface.mjs` は
`@mnemora/core` のみに差分を報告した——`VectorFilter`/`LexicalFilter`/`RecallQuery`/
`RecallQuerySchema`/`RecallScope`/`RecallScopeSchema` の6箇所に `includeSubjectless?:
boolean`（またはその zod 表現）が1行ずつ増えるだけで、**既存行の変更・削除は0**。
`node scripts/check-public-api-surface.mjs --write` で snapshot を更新し、
`git diff --stat scripts/__snapshots__/public-api/` は `core.d.ts | 6 ++++++`
（他5パッケージは差分なし）。

### 【実測】手元の型検査・ビルド

`pnpm --filter @mnemora/core run typecheck`・`run build`、
`pnpm --filter @mnemora/testkit run typecheck`・`run build`、
`pnpm --filter @mnemora/postgres run typecheck`・`run build` のいずれも exit 0。

---

## 確かめていないこと

1. **実運用で `recall()` が `includeSubjectless: true` を渡す割合、および渡された場合の
   `aggregateScope`（テナント全体集計）の性能影響。** `docs/recall.md`「`aggregateScope`
   の実測」節が測ったのは `subjectId` の有無（絞る/絞らない）による差だけであり、
   「`subjectId` あり + `includeSubjectless: true`」という第3の組み合わせの性能は
   測っていない——`subject_id = X OR subject_id IS NULL` は `idx_memories_by_subject
(tenant_id, subject_id, status)` の等値索引を1本のビットマップスキャンとしては
   使えない可能性がある（`OR` の両辺が別々の索引条件になりうる）。
2. **postgres の `EXPLAIN` で、この `OR` 述語がどんな実行計画になるかを確認していない。**
   `recall-gate-index.test.ts`/`lexical-store-index.test.ts` 等の既存の索引の歯は
   `includeSubjectless` を使わない経路しか検査しておらず、新しい分岐専用の `EXPLAIN` の
   歯は本 PR では追加していない。
3. **`decayFloorSeq` の `IS NULL` 救済が「意図的だったか」を、一次資料（PR レビュー・
   議論ログ等）まで遡って確認していない。** 上の節に書いたとおり、コードと関連 ADR を
   読んで導いた【推論】であり、断定はしていない。
4. **`examples/chat` 側の配線は変更していない・確認していない。** `mnemora-path.ts` 等が
   `includeSubjectless` を使う経路は無く、この PR の範囲にも含めていない。
5. **実 API（OpenAI/Anthropic）への影響は無い**——本 PR は `packages/openai`/
   `packages/anthropic` を1バイトも変えていない。念のため grep で確認したのみで、
   実 API を叩いた検証はしていない（そもそも該当しないため不要と判断した）。

---

## 引き受けた負債

1. **`includeSubjectless` を無視する adapter は、主題なしの記憶を常に取りこぼす。**
   これは意図した設計（安全側にしか壊れない）だが、独自 `VectorStore`/`LexicalStore`
   実装を持つ利用者が、この欄を知らないまま「動いているように見えて実は主題なしが
   1件も返っていない」状態に気づきにくい可能性がある——`packages/testkit` の適合
   テストに正の歯（この欄を実装すれば緑になる）はあるが、「実装していないことを
   自分で気づかせる」警告の仕組みは無い（ADR 0034 の一般的な限界と同じ）。
2. **`RecallQuery` への追加は依頼が明示していなかった判断である**（決めたこと1）。
   この解釈が違うとオーナー/マネージャーが判断した場合、`Ctx` 側への移設を含む
   再設計が必要になる。

## これが覆るとしたら

- **(a)（主題なしだけを引く指定）が別途必要になったとき** —— `ctx.subjectId` の型を
  3値化するか、別の欄を足すかの再検討が要る。本 ADR はその設計を先取りしない。
- **性能実測（確かめていないこと1・2）で、`OR` 述語が既存の索引を使えず全表走査に
  劣化することが分かったとき** —— 専用の部分索引（`WHERE subject_id IS NULL` 用と
  `WHERE subject_id = X` 用を `UNION` する、等）の追加を検討する。
- **`includeSubjectless` を無視する adapter が実運用で実害（主題なしの記憶が
  想定外に欠落し続ける）を出したとき** —— 警告や検出の仕組みを別途検討する
  （引き受けた負債1）。

## 参照

- [Issue #608](https://github.com/takecchi/mnemora/issues/608) — 本 ADR が実装する項目③(b)
- [ADR 0271](./0271-extraction-candidate-subject-id-overrides-observation.md) — 同じ Issue の項目①。本 ADR が前提にする「候補ごとの `subjectId`」を足した先行 PR
- [ADR 0165](./0165-decay-activity-clock.md) — `decayFloorSeq` の `IS NULL` 救済（決めたこと4）。本 ADR の中心的な比較対象
- [ADR 0023](./0023-subject-filter-in-ann-stage.md) — `subjectId` の絞りを段1へ降ろした先行決定。本 ADR が「後置フィルタだけで絞る案」を却下する根拠
- [ADR 0172](./0172-association-passes-decay-and-validity-gates.md) — 段1と段3.5の filter を同じ境界に揃える規律（`gateVectorFilterFields`）。本 ADR も `includeSubjectless` をこの規律に従わせた
- [ADR 0178](./0178-public-api-surface-gate.md) — 「新しい任意プロパティの追加」が semver 的に安全という基準。本 ADR の非破壊性の根拠
- [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) — 本 ADR の決定が自動化された担い手のものであることの根拠
- [Issue #579](https://github.com/takecchi/mnemora/issues/579) — ③(c)（`consolidate` の `null` 統合）が重なる、別に動かす Issue
- `docs/recall.md`「⚠ `subjectId` を省略すると何が起きるか」節 — `subjectId` が `RecallQuery` の欄ではなく `Ctx` の任意欄であることの一次資料
