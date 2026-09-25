# ADR 0304: `observe()`/`recall()` に呼び手専用の `attributes` を通す —— `tags`（LLM の推論）とは別の列で、段1へ AND 等値の絞り込みとして押し下げる（Issue #152/#153、非破壊）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから切り出された担い手）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が要るなら、
> オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0246 / ADR 0282 / ADR 0289 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `git` / `vitest` / `tsc` / `pnpm` / `psql` を走らせて確かめた。
- **【受】** — Issue コメントとして受け取り、再導出していない（出所を明記する）。

断りの無い【現物】は `origin/main` = `f3b3516`（本作業の分岐点）の木で、2026-09-25 に行った。

---

## 文脈

### Issue #152/#153 が報告した困りごと

[Issue #152](https://github.com/takecchi/mnemora/issues/152) は「移行元の属性（公開範囲・
区分など）が `observe()` を通ると失われる」ことを、[Issue #153](https://github.com/takecchi/mnemora/issues/153)
は「その属性で絞り込めないため recall 後にアプリ側で捨てるしかなく、捨てる分だけ `limit`
の予算が無駄に燃える」ことを報告した。両 issue は「同じ根から出ており、片方だけでは
採用側の困りごとは解けません」と明示している。

### issue コメント欄での判定の経緯（【受】、逐語ではなく要約）

複数の自動化された担い手（クローン）が、時系列順に issue のコメント欄で調査・判定を
重ねた。本 ADR は以下の到達点を引き継ぐ:

1. **案(3)（`tags` に混ぜて由来を問わない）は却下**——`Memory.provenance.kind` が
   既に `stated`/`inferred`/`consolidated`/`reflected`/`imported` の5値で由来を分けている
   repo が、属性だけ由来を捨てるのは一貫しない。北極星の問い4（「AI の推論と、
   ユーザーが言った事実を、区別しているか」）に正面から当たる。
2. **`metadata?: Record<string, unknown>` ではなく `attributes?: Record<string, string>`**
   ——[ADR 0006](./0006-memory-schema.md)（「単一の JSON カラムに全部入れる…recall の
   二段検索と正面から衝突する」として却下）の原理を継承し、値の型を `string` に絞って
   `jsonb` の `@>`（containment）に落ちる形にする。
3. **#152 単独では立たない**（[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
   決定8「その区別を受け取った側が、実行時に違う手を打てるか。打てないなら足さない」）。
   #152 + #153 を1つの設計として出すと、呼び出し側が実行時に打てる手が3つ立つ
   （母集合から外す／`limit` 予算が正しく効く／属性で n 件落ちたことを知る）。
4. **`RecalledMemory` にも `attributes` を載せる**——絞り込みに使った軸の値が返らないと、
   呼び出し側は絞り込みが効いたことを自分で検証できない（北極星の問い3）。
5. **`tags`/`attributes`/`labels`（Phase 2、#201）は3本立つが、「誰が値を決めるか」で
   役割が分かれている**——統合するほうが北極星の問い4に反する（下記「tags/attributes/labels
   の役割分担」参照）。

### 🔴 #541（union への値追加は破壊的か）が未決のため、`FilteredOmission.condition` には触れない

issue コメント欄の途中の判定は「`omitted` に `condition: "attribute"` を足す」としていたが、
これは `FilteredOmission.condition`（公開 union）に値を1つ足すことであり、それを破壊的
変更と数えるかは [Issue #541](https://github.com/takecchi/mnemora/issues/541) が OPEN の
まま問うている。**マネージャーはこの ADR の実装着手前に、#541 の答えを待たずに設計を
変える判断をした**——`condition` に値を足す代わりに、**`subjectId`/`tenant` と同じ
「スコープの外側の境界」**として `attributes` を扱う（下記決定6）。この形なら
`FilteredOmission.condition` にも他のどの公開 union（`MemoryEventKind`・`GroupCount.axis`・
`OutboxJobKind`・`ProvenanceKind` 等）にも値を足さず、#541 の答えを問わずに実装できる。
**v2 で `condition` に専用の値を足す案は「採らなかった案」として下に残す。**

---

## 決定

### 1. すべて任意欄・任意引数の純追加

`ObserveUtteranceInput`/`ObserveEventInput`/`ObserveDocumentInput` に
`attributes?: Record<string, string>` を足す。`ObserveMemoryUsageInput` には足さない
（記憶を作らない観測なので載せる先が無い——`docs/memory-model.md` の `validFrom`/
`validUntil` と同じ扱い）。`Observation`/`NewMemory`/`Memory`/`RecallQuery`/`RecallScope`/
`RecalledMemory`/`VectorFilter`/`LexicalFilter` にも同型で `attributes?` を足す。
**既存のどの公開型にも必須フィールドを足さない。どの公開 union にも値を足さない。**
`docs/migration-v1.md` の数え方（後述「非破壊の根拠」）で破壊的変更に当たるものは
一切無い。

### 2. 値の型を `string` に絞る。上限を定数で置く

`packages/core/src/attributes.ts` に `Attributes = Record<string, string>` と
`AttributesSchema`（zod）を新設する。上限（ADR 0006 の原理の延長——索引の効く等値比較に
絞り込む）:

| 項目 | 値 |
|---|---|
| キー数 | 最大16 |
| キー長 | 1〜64文字 |
| 値長 | 0〜256文字（空文字は許す） |
| キーの文字種 | `^[A-Za-z0-9_.:-]+$`（ASCII 英数字・`_`・`-`・`.`・`:`） |

⚠ **これらの数値・正規表現は実測していない。** 他の属性/タグ付け実務（Stripe の
`metadata`: 最大50キー・キー長40・値長500、DataDog のタグ: 値長200 程度）を参考にした
保守的な初期値であり、本番の `jsonb` サイズ・GIN 索引サイズを計測した結果ではない
（下記「確かめていないこと」参照）。**緩めるのは後からできるが、締めるのは破壊的
変更になる**——そのため最初から控えめに絞った。

**検査は `ObserveXxxInput.attributes`/`RecallQuery.attributes` を通す箇所でだけ走る**
（`AttributesSchema`）。格納・伝播側の型（`Observation`/`Memory`/`RecalledMemory`/
`RecallScope`/`VectorFilter`/`LexicalFilter`）は検査をしない `StoredAttributesSchema`
（`z.record(z.string(), z.string())`）を使う——`MemorySchema.strength` 等と同じ規律
（「この schema は書き込み経路では走らない」）。

### 3. 永続化: `observations`/`memories` 両方に列が要る

`extract: 'deferred'` を選んだ場合、抽出は outbox 経由で後から `processExtractJob` が拾い、
そこでは `MemoryStore.getObservation` で DB から読み直した `Observation` しか手元に無い
（元の `ObserveXxxInput` はとうに捨てられている）——`Observation.validFrom`/`validUntil`
（ADR 0145/0037）と同じ理由で `observations.attributes` が要る。`memories` 側は
`validFrom`/`validUntil` と違い Phase 1 の時点で列を持っていなかったため、こちらも
新規追加になる。

`packages/postgres/migrations/0019_observations_memories_attributes.sql`:
- `observations`/`memories` 両方に `attributes jsonb NOT NULL DEFAULT '{}'::jsonb`。
- `memories` に `CREATE INDEX idx_memories_attributes ON memories USING gin (tenant_id,
  attributes jsonb_path_ops)`——`idx_memories_tags`（`0001_init.sql`、`tenant_id` を
  btree_gin 経由で複合 GIN に含める形）と同じ構造。

**testkit の `InMemoryMemoryStore`/`InMemoryVectorStore`/`InMemoryLexicalStore` にも
同じ意味の絞り込みを実装した**（postgres と in-memory の両方で意味が揃うことを
conformance suite で検査する。下記「測ったこと」参照）。

### 4. 抽出・統合・その他の作成経路ごとの引き継ぎ方

**Memory を作る経路は3つしかない**（【実測】`grep -rn "): NewMemory\|NewMemory {"
packages/core/src` で確認——`buildNewMemoryFromCandidate`（`extraction.ts`）・
`buildConsolidatedMemory`（`strategies/consolidate.ts`）・`buildReflectedMemory`
（`strategies/reflect.ts`）の3関数のみ。`apply-correction.ts`/`correction-candidates.ts`
は `markContested`/`resolveContested` を呼ぶだけで新しい Memory を作らない
——`status` を動かすだけである）。

| 経路 | 扱い | 理由 |
|---|---|---|
| **抽出**（`buildNewMemoryFromCandidate`。sync・deferred・LLM 失敗時のフォールバック `fallbackWholeObservationCandidate` を含む全経路） | **観測の `attributes` をそのまま継承**（`Observation.attributes ?? {}`） | 「限定の出所から出た記憶は限定のまま」——attributes は内容ではなく取り扱い（公開範囲など）であり、落とす方向に倒す。1回の `observe()` から複数候補が抽出されても、全候補が同じ `attributes` を共有する（`occurredAt`/`validFrom` と同型の限界） |
| **統合**（`buildConsolidatedMemory`） | **積集合**（`intersectAttributes`）——`eligible` 全件に同じキー・同じ値で入っているものだけを残す | 迷ったら積集合／空の、落とす方向へ（`ADR 0223 決定8` の反例節「いまは決めない」ではなく、ここは決められる——「呼び手が申告していない値を統合の産物へ持ち込まない」という原則で決まる） |
| **反芻**（`buildReflectedMemory`） | **積集合**（`consolidate.ts` と同じ `intersectAttributes` を共有） | `consolidate`/`reflect` は「Observation に由来しない、複数の既存 Memory から新しい Memory を組み立てる」という同じ形の操作であり（`buildReflectedMemory` の doc コメントが `buildConsolidatedMemory` の「双子」と呼ぶ関係）、`attributes` の引き継ぎ方もこの2経路で意図的に揃えた——**これは本 ADR の判断であり、確認していない**（下記「確かめていないこと」参照）。積集合にした理由: `attributes` は取り扱いを表す軸であり、由来（stated/inferred と違い reflected/consolidated も同様に「推論の産物」ではあるが）に関わらず、元の記憶群が一致して持っていた制約は引き継ぐべきという判断。空集合ではなく積集合を選んだのは、「元の記憶全部が一致して internal だったのに、統合・反芻すると無制限公開に戻る」という退行を避けるため |
| **訂正**（`applyCorrection`/`markContested`/`resolveContested`） | **触れない**（新しい Memory を作らない） | `status` を動かすだけの orchestration。対象の `attributes` は動かない |

### 5. 絞り込み: `RecallQuery.attributes?: Record<string, string>`。AND 等値のみ

`RecallScope.attributes` を唯一の出所とし（`decayFloorAtAfter` 等と同じ「2箇所に式を
書くと食い違う」規律、ADR 0038）、段1（ANN・語彙の両チャンネル）と段3.5（連想枠）の
`VectorFilter.attributes`/`LexicalFilter.attributes` へ同じ値を撒く。postgres は
`m.attributes @> $1::jsonb` で絞る。`MemoryStore.aggregateScope` にも同じ述語を
`scoped` CTE の `WHERE` へ足す（`totalInScope`・群カウント・目次帯のすべてがこの
絞り込みの内側だけを数える）。

**連想枠（段3.5）を段1と独立した経路として扱う**——ADR 0172/Issue #347 が実際に踏んだ
見落とし（段1のゲートを更新しても連想枠の `search()` は自動追随しない）を繰り返さない
ため、`attributes` を ANN・語彙・連想の3箇所の filter 構築すべてに明示的に撒いた
（`subjectId` と同じパターン。`gateVectorFilterFields` には入れていない——`subjectId`
自身もそこに無く、各箇所で `scope.subjectId`/`scope.attributes` を個別に読む形に揃えた）。

**runtime でも adapter から返った候補に後から検査を掛ける**（`survivesAttributesFilter`、
`survivesSubjectFilter` と同じ「1箇所に述語を置く」規律）——`VectorFilter.attributes`/
`LexicalFilter.attributes` を無視する adapter（自作 adapter を含む）でも、混入は起きない
（取りこぼしはあっても、別の attributes を持つ Memory が紛れ込むことは無い）。

**意味論は AND 等値のみ。OR・キー不在の表現は、この版では提供しない**——「いまは決めない」
と明示する（ADR 0223 決定8 の反例節「『次の一手が決まらない』ときの選択肢は『足さない』
だけではない。『いまは決めない』と名乗って測れる形を先に置く、もある」、ADR 0046 の形）。
#153 が要求する「母集合を減らす」には AND 等値で足りるため、必要になってから足す。

**空オブジェクト（`{}`）は「絞り込み無し」**——省略したときと1バイトも挙動が変わらない
（`recall-runtime.ts` が `Object.keys(...).length > 0` のときだけ `scope.attributes` に
値を入れ、それ以外は `undefined` に正規化する）。

### 6. 落ちた記憶は `omitted` に出さない — `attributes` は「スコープの定義」の一部

`subjectId`/`tenant` と同じく、`attributes` による絞り込みは**スコープの外側の境界**
である。`FilteredOmission.condition` に専用の値を足さない（上記「文脈」の #541 節参照）
——落ちた分は `totalInScope` から静かに除かれ、`omitted` のどの kind にも現れない。

`docs/recall.md` §2 段0「スコープの外延」と `docs/memory-model.md` §8 に追記した
（書き換えではなく追記の形、下記「非破壊の根拠」参照）。

### 7. `RecalledMemory.attributes` — 「詳細は `get()` の問い」という設計原理の例外

`provenanceKind` の doc コメントは「recall は『何を返したか』の問い、詳細は `get()` の
問い」という設計原理を宣言しているが、本 ADR はこの原理の例外として `attributes` を
`RecalledMemory` に載せる。**線引き**: 絞り込みに使った軸の値は載せる（呼び出し側が
「なぜこれが返ったか」を自分で検証できるようにするため、北極星の問い3）。使えない詳細は
`get()` に残す。型の上では省略可能だが、`recall-runtime.ts` は常に `{}` 以上の値を書く
（ADR 0289 が `speaker`/`subjectId` に採った runtime 保証と同じ規律——`Memory.attributes`
が `undefined` の古い行・adapter でも `{}` に揃える）。

### 8. `tags`/`attributes`/`labels`（Phase 2、#201）の役割分担

3本の軸が並ぶことは欠陥ではない——「誰が値を決めるか」で役割が分かれている:

| 軸 | 何を入れるか | 誰が値を決めるか | 段1に参加するか |
|---|---|---|---|
| `tags` | 話題・内容の要約 | **100% LLM の推論**（`buildExtractionPrompt` は語彙・粒度を指示しない） | ⛔ しない（段2の加点のみ、`docs/memory-model.md` §8 2026-09 訂正） |
| `attributes`（本 ADR） | 公開範囲・区分などの**宣言された属性** | **100% 呼び手の申告** | ⭕ する（AND 等値、本 ADR 決定5） |
| `labels`/`memory_labels`（Phase 2、#201） | **統制語彙**（テナントが登録した語彙） | **repo（スキーマ）が決める語彙に、呼び手が当てる** | Phase 2 未着地（`docs/memory-model.md` §8） |

`attributes` が段1に参加するのに `tags` が参加しない理由: `tags` を段1に混ぜると
LLM の推論で母集合を削ることになり北極星の問い4に反するが、`attributes` は呼び手が
申告した事実そのものなので同じ懸念が当たらない。

`labels` が Phase 2 で着地しても `attributes` の代わりにはならない——`labels` は
「テナントが統制する語彙にどれだけ従っているか」を問い、`attributes` は「呼び手が
何を宣言したか」を問う。両方の doc（`docs/memory-model.md` §8）にこの表を置いた。

### 9. 2026-09-25 追記（レビュー指摘）: `RecallResult` に Memory の中身が乗る経路を全部洗い、
段3（必須の同伴取得）と段5（目次帯）にも同じ後置防御を足した

⭐ **これは決定5（「runtime でも adapter から返った候補に後から検査を掛ける」）の射程を
広げる追記であり、決定5自体を書き換えるものではない。** 実装当初、`survivesAttributesFilter`
は段1（ANN・語彙の後置フィルタ）と段3.5（連想枠の後置フィルタ）にしか掛けていなかった
——`RecallResult`（`memories`/`index.digestBand`）に Memory の中身（`digest`）が実際に
乗る経路は、この2つだけではなかった。

#### 監査: `RecallResult` に Memory の中身（digest・content・id）が入る経路

| 経路 | Memory の中身が乗るか | `attributes` の検査 | 備考 |
|---|---|---|---|
| 段1 候補生成（ANN・語彙、`withinLimit`） | ⭕ `digest`（`RecalledMemory.digest`） | ⭕ 検査あり | adapter への押し下げ（`VectorFilter.attributes`/`LexicalFilter.attributes`、決定5）＋後置フィルタ（`survivesAttributesFilter`、実装当初から） |
| **段3 必須の同伴取得（mandatory companion retrieval）** | ⭕ `digest` | 🔴 **当初は無し** → ✅ **本追記で追加** | `MemoryStore.getMany` の結果を検査せずそのまま同伴に使っていた。`subjectId`/`period`/`validAt`/`decayFloorAt` は元々検査していない（`docs/recall.md` §8「対向する Memory をスコアに関係なく候補集合へ追加する」という既存の設計——同伴取得はそれらの軸を最初から見ない。`attributes` だけをここで検査するのは、この軸が「内容の正しさ」ではなく「取り扱い（公開範囲など）の境界」だから。詳細は下記「なぜ attributes だけ検査するか」） |
| 単位組み立て（unit assembly） | ⭕ `digest`（候補を経由するだけ） | ⭕ 検査あり（間接） | `withinLimit`/`companions` から作るだけで、新しい Memory を取得しない。上流（段1・段3）の検査を継承する |
| 段3.5 連想枠（association） | ⭕ `digest` | ⭕ 検査あり | adapter への押し下げ（`VectorFilter.attributes`、決定5）＋後置フィルタ（`survivesAttributesFilter`、実装当初から。ADR 0172/Issue #347 の見落としを繰り返さないため元から掛けていた） |
| 段4 予算切り詰め（budget truncation） | — （落とすだけ） | 対象外 | 新しい Memory を取得しない。単位を落とすか残すかだけを決める |
| **段5 目次帯（`MemoryStore.aggregateScope` の `digests`）** | ⭕ `digest`（`DigestEntry.digest`） | 🔴 **当初は無し** → ✅ **本追記で追加** | `aggregate.digests` を検査せず `packDigestBand` にそのまま渡していた。`scope.attributes` を無視する自作 `MemoryStore` だと、絞り込みの外の `digest` が目次帯（LLM のプロンプトに載る帯）へ紛れ込む。`scope.attributes` が在るときだけ `getMany` で引き直して検査する（下記「決定9-b」） |
| `groups`（第3階の群カウント） | ⛔ 無し（`{ axis, key: subjectId \| null, count }` のみ） | 対象外（件数のみ） | `key` は `subjectId` であって Memory の中身ではない。`count` も中身を持たない |
| `totalInScope` | ⛔ 無し（数値のみ） | 対象外（件数のみ） | 決定6が既に「スコープの外側の境界」として扱っている対象 |
| `RecallRecordMemory`（`recalls.returned_memories`、永続化） | ⛔ 無し（`memoryId`/`score`/`retrievedVia`/`companionOf`/`associationOf` のみ、`digest` を持たない——ADR 0155 決定1） | 対象外（`finalMemories` から作るだけで新しい Memory を取得しない） | `finalMemories` は既に段1〜4の検査を経ている。永続化層が別の Memory を取得することは無い |
| `usage.byTier.association`（連想の digest 合計文字数） | ⛔ 無し（数値のみ、`finalMemories` から計算） | 対象外（件数のみ、かつ `finalMemories` を経由） | `finalMemories.filter(...).reduce((sum, m) => sum + m.digest.length, 0)`——中身ではなく長さの合計 |

⭐ **「件数だけが adapter 任せになる箇所（`totalInScope`・`groups` の件数）は、中身が
漏れないので許容する」**——決定6が `totalInScope` について既に取っている立場を、
`groups` にもそのまま広げる。`groups[].key` は `subjectId` の値であり、`attributes` が
守ろうとしている「内容（`digest`/`content`）の漏れ」には当たらない。

#### 9-a. 段3（必須の同伴取得）の修正 —— なぜ `attributes` だけを検査するか

`docs/recall.md` §8 は「対向する Memory（`contradicts` の相手）をスコアに関係なく候補集合へ
追加する」と明記しており、`recall-pipeline.test.ts`「同伴取得（mandatory_companion）でも
speaker/subjectId は対向の Memory 自身の値を名乗る」歯は、同伴が呼び出し側の
`ctx.subjectId` と**異なる** `subjectId` を持ちうることを前提にしている。つまり
**`subjectId`/`period`/`validAt`/`decayFloorAt` は、同伴取得の対象最初から見ない、
という既存の設計判断**——「争われている主張を、争われていない顔で出すくらいなら、
両方とも出さない」という原則1を実装するために、対向は無条件で取りに行く。

`attributes` はこれらと性質が違う——**「その事実がいつ・誰について・まだ真か」という
内容の軸ではなく、「この記憶をどう取り扱ってよいか」という境界の軸**である（決定8の表
「誰が値を決めるか」と同じ切り口）。呼び手が `recall({ attributes: { visibility:
"internal" } })` と明示した時点で、`visibility: "public"` の記憶は「この呼び出しの
取り扱い範囲の外」であり、争いの内容がどうあれ見せてはならない——`subjectId`/`period`
のような「この争いは誰・いつの話か」という内容の軸とは独立に効くべき境界である。
⟹ **`attributes` だけをここで検査し、他の軸は既存の設計のまま変えない。**

**落ちたときの振る舞い**: 対向が `attributes` の検査で落ちると、その `companionId` は
`companions` に一度も現れない——単位組み立ての段から見れば「対向が見つからなかった
`contested`」と区別が付かない。この場合、`contested` の候補自身も単位を組まずに
`consumed` のまま落ちる（既存の分岐、`docs/decisions/0046-contested-pair-invariant-tooth.md`
と同じ経路）。**新しい `Omission` の種類は発明していない**——既存の
`unit_assembly_dropped`（[ADR 0043](./0043-unit-assembly-dropped-omission.md)）が
自動的にこれを拾う（`unitAssemblyShortfall` は `allCandidates.length` から数えるため、
`companions` が縮んだ分だけ候補数自体が減り、被覆の計算は崩れない）。

#### 9-b. 段5（目次帯）の修正 —— `digestEligible.count`/`countKind` の扱い

`scope.attributes` が在るときだけ、`aggregate.digests` の `memoryId` を `MemoryStore.getMany`
で引き直し、`survivesAttributesFilter` を通らないもの・引けなかったもの（存在しない／
クロステナント）を落とす。**落とす方向に倒す**——`getMany` が返さなかった
（＝「存在しない」の一種として扱われる、`packages/postgres/src/mapping.ts` の
`isUuidLike` の doc と同じ規約）ものも、内容を確認できない以上、帯には出さない。

`digestEligible.count`（目次帯の資格件数、`ScopeAggregate.digestEligible`）は、この
後置検査で何か1件でも落ちたときだけ `count` から落とした件数を引き、`countKind` を
`'unknown'` に落とす。**理由**: `digestEligible.count` は adapter 自身の（もしかしたら
`attributes` を無視した）ロジックが計算した総数であり、いま見えている `digests`
（帯の候補ページ）の**外**にも同種の取りこぼしがあるかもしれない——引いた値は
「少なくともこれだけ多く見積もっていた」ことしか保証せず、真の資格件数はそれより
さらに小さい可能性がある。`'lower_bound'`（真の値はこれ以上、という意味で使われている
既存の語彙、`docs/recall.md` §4 参照）は向きが逆になるため使えない。⟹ **`'unknown'`
にして、正確さを僭称しない**（ADR 0008 の原則3）。

**落ちなかったとき（`droppedCount === 0`）は `digestEligible.count`/`countKind` を
一切触らない**——adapter が最初から正しく `attributes` を絞り込んでいれば、この後置
検査は何も検出しない no-op であり、既存の挙動（`'exact'` を名乗る等）を1バイトも
変えない。

---

## 北極星との整合（`docs/north-star.md`「迷ったときの問い」）

### 問い1（毎回渡す量を減らす方向に働くか）

**働く。** `RecallQuery.attributes` は段1（候補生成）で母集合を減らす——rescore
段階で捨てるのではなく、そもそも over-fetch の窓（k'）に入れない。Issue #153 の
本文がまさにこれを求めている（「rescore で捨てると『予算が食われる』が解けません」）。
`ObserveXxxInput.attributes` 自体は増える方向の変更だが、それは「思い出す」対象を
絞るための入力であり、想起の質と引き換えではない。

### 問い2（無効にしたとき Memory Framework として成立するか）

**成立する。** `attributes` はすべて任意——渡さない呼び出し（`observe()`/`recall()`
どちらも）は1バイトも挙動が変わらない。adapter がこの欄を実装しなくても
（`VectorFilter.attributes`/`LexicalFilter.attributes` を無視しても）recall は成立する
——取りこぼしはあるが機能は壊れない（決定5「runtime でも後から検査を掛ける」）。

### 問い3（この記憶が選ばれた理由を、後から説明できるか）

**説明できる。** `RecalledMemory.attributes` を載せたことで、`recall({ attributes:
{ visibility: "internal" } })` で絞った結果に対し、呼び出し側は「なぜこれが返ったか」
を自分で検証できる（決定7）。これが `RecalledMemory` に載せる決め手だった。

### 問い4（AI の推論と、ユーザーが言った事実を、区別しているか）

**本 ADR の出発点そのもの。** `tags`（100% LLM の推論）と `attributes`（100% 呼び手の
申告）を別の列に分けたのは、この問いに直接答えるためである。統合・反芻の積集合
（決定4）も同じ原則の延長——推論の産物（統合物・反芻物）へ、呼び手が申告していない
値を持ち込まない。

### 問い5（LLM を呼ばずに済ませられないか）

**済ませている。** `attributes` の絞り込みは列と索引（`jsonb` の `@>`、GIN 索引）で解く
——`recall()` のこの絞り込みは一度も LLM を呼ばない。抽出プロンプト
（`buildExtractionPrompt`）も `attributes` を一切見ない・渡さない（`observationPayloadText`
経由で LLM に渡る経路が無いことを、`extraction.ts` の `buildNewMemoryFromCandidate` が
`params.observation.attributes` を機械的にコピーするだけの実装であることで担保する）。

### 「目指す姿」との整合

- **「知らないことを知らないと言える」と `omitted` を出さないことの関係（決定6）**:
  一見矛盾するように見えるが、`attributes` による絞り込みは「探したが見つからなかった」
  ではなく「そもそも問うていない」に当たる——`tenant`/`subjectId` と同じ扱い。呼び手が
  `attributes: { visibility: "internal" }` を明示した時点で、`visibility: "public"` の
  記憶は「探索の対象外」であり、「探したのに見つからなかった記憶」ではない。この区別は
  `docs/recall.md` の「スコープの外延」が `tenant`/`subjectId` について既に確立していた
  ものを、そのまま `attributes` にも適用しただけである。

---

## 非破壊の根拠（`docs/migration-v1.md` の数え方）

`docs/migration-v1.md` が破壊的変更に数えている形（項目1〜18）のうち、本 ADR が
踏んでいないものを確認する:

- **項目3/9「`ScopeAggregate`/`FilteredOmission` に必須フィールドが増えた」**: 本 ADR は
  `ScopeAggregate`/`FilteredOmission` のどちらにも新しいフィールドを足していない
  （決定6——`attributes` はスコープの外側の境界として扱い、専用の集約フィールドも
  `condition` 値も足さない）。
- **項目4/17「union に値が増えた」**: `FilteredOmission.condition`・`MemoryEventKind`・
  `GroupCount.axis`・`ProvenanceKind`・`OutboxJobKind` のいずれにも値を足していない
  （【実測】`git diff origin/main... -- packages/core/src` を目視——union のリテラルを
  変更した行は無い）。
- **項目1/5/12/14/16「必須メソッドが増えた」**: `Runtime`/`MemoryStore`/`VectorStore`/
  `LexicalStore` のいずれにも新しい必須メソッドを足していない——`VectorFilter.attributes`/
  `LexicalFilter.attributes` は interface の**フィールド**であり、これらの interface
  自体は「実装すべきメソッド」の型ではなく「search() に渡すオプション」の型である
  （`VectorStore.search(ctx, space, query, opts: { limit; filter: VectorFilter })` の
  `filter` は呼び出し側が組み立てて渡すものであり、adapter が「新しいメソッドを実装する
  義務」を負うものではない——ADR 0034「adapter が実際に適用しなければならない」契約は
  既存の欄にも今日から効いており、新しい任意欄は「渡されたら見る」だけで足りる）。
- **項目6/13/15「conformance テストの必須オプションが増えた」**: `PrepareMemoryIdAttrs`/
  `PrepareLexicalMemoryAttrs` に `attributes?` を足したが、どちらも既存のオプション型に
  **任意**フィールドとして足した（`?`）。`VectorStoreConformanceOptions`/
  `LexicalStoreConformanceOptions` 自体の必須フィールドは増えていない。
- **項目7「入力側の必須フィールド追加」**: `ObserveXxxInput.attributes` は任意（`?`）。
  項目7自身が「入力側は省略可能フィールドとして追加されており、省略すれば0として扱われる
  （非破壊）」と明記する形と同じ。
- **項目11「関数型から必須 interface になった」**: 該当なし。

**⟹ 本 ADR は `docs/migration-v1.md` のどの既存の破壊的変更パターンにも当たらない。**
新しい行を `docs/migration-v1.md` に追加する必要は無い（追加すべき破壊的変更が無い）。

---

## 採らなかった案

| 案 | 却下の理由 |
|---|---|
| **(3) `tags` に混ぜて由来を問わない** | 北極星の問い4に反する。`ProvenanceKind` が既に由来を5値に分けている repo で属性だけ由来を捨てるのは一貫しない（「文脈」節） |
| **`metadata?: Record<string, unknown>`** | ADR 0006 の原理（単一 JSON カラムは索引が効くフィルタと衝突する）がそのまま当たる。値の型を `unknown` にすると等値比較の意味が定まらない |
| **v2 で `FilteredOmission.condition` に `"attribute"` を足し、`omitted` に出す** | #541（union への値追加が破壊的かどうか）が未決のまま踏まない。決定6（スコープの外側の境界として扱う）で同じ目的（「属性で絞り込んだ」ことを説明できる——ただし個別の件数としてではなく `totalInScope` が既にその絞り込みの内側であることで表現する）を、union を広げずに達成した。#541 が「数えない」に決着すれば、v1.x のうちに `condition` へ値を足す案を再検討してよい |
| **案E（いまは決めないと名乗って測る器だけ置く。ADR 0046 の形）** | issue コメント欄の判定を踏襲——A（別列）と B/C（`tags` へ混ぜる）の選択は ADR 0006 と北極星の問い4で測らなくても決まっており、案E が供給する材料（`tags` の語彙分布）は使い道が無い。かつ案E は採用側の困りごと（二重管理）を1つも解かない |
| **`attributes` を段1に押し下げず、段2（rescore）の後置フィルタだけにする** | Issue #153 の本文が明示的に退けている（「rescore で捨てると『予算が食われる』が解けません」）。段1で絞らないと over-fetch の窓が無駄に消費される |
| **OR・キー不在（`key が無いこと`）を表す意味論を同時に導入する** | 「いまは決めない」と明示する形を採った（決定5）。#153 が要求する「母集合を減らす」には AND 等値で足りる |
| **consolidate/reflect の `attributes` を積集合ではなく空にする（由来を問わず落とす）** | issue コメント欄の一部判定はこちらを推していた（「呼び手が申告していないものは推論の産物へ持ち込まない」を徹底する形）。本 ADR は積集合を採った——「元の記憶全部が一致して internal だったのに、統合・反芻すると無制限公開に戻る」という退行のほうを重く見た。**この選択は確認していない**（下記「確かめていないこと」）。オーナーが「空にすべき」と判断すれば、この決定は覆る |
| **`Memory.attributes` を必須フィールドにする** | `docs/migration-v1.md` の数え方（必須フィールド追加＝破壊的）に当たる。ADR 0289/0282 の先例（任意欄＋runtime 保証）を踏襲した |

---

## 引き受けた負債

1. **consolidate/reflect の積集合が正しい選択かは確認していない。** 空集合（由来を
   問わず落とす）との比較検証は行っていない——「採らなかった案」参照。
2. **型の上では `attributes` は依然 optional であり、`undefined` はコンパイルエラーに
   ならずに代入できる。** ADR 0289 が引き受けた負債と同じ形——独自の `Memory`/
   `RecalledMemory` 実装がこの欄を省略する可能性は型では塞がれていない。
3. **キー数・キー長・値長・文字種の上限は実測していない**（決定2）。
4. **GIN 索引（`jsonb_path_ops`）がプランナに実際に選ばれるかは、選択性・他の索引の
   有無に依存する。** 手元の実機検証（下記「測ったこと」）では、強制すれば使える
   ことは確認したが、既存の複数の `tenant_id` 先頭 btree 索引と競合する場面では、
   プランナがそちらを選び `attributes` の条件をヒープ上の `Filter` として後付けする
   ケースを実測した——`recall-gate-index.test.ts` が `idx_memories_recall_gate` に
   ついて既に文書化している「プランナが索引を選ぶかどうかはコスト見積りの問題であり、
   索引が適用可能かどうかとは別の主張である」という区別が、ここにもそのまま当たる。
   この ADR は「形」（索引が正しい列・正しい opclass で存在する）と「適用可能性」
   （強制すれば選ばれる）までは実機で確認したが、`recall-gate-index.test.ts` と
   同水準の3段構え（形・適用可能性・同値）の専用テストは書いていない。
5. **`RecalledMemory.attributes` の永続化（`RecallRecordMemory`）には足していない。**
   `speaker`/`subjectId`（ADR 0289 決定6）と同じ理由——`MemoryStore.get(memoryId)
   .attributes` から再現できるため。この判断自体は ADR 0289 の先例を踏襲しただけで、
   本 ADR 独自の検証は行っていない。
6. **段3（必須の同伴取得）は `subjectId`/`period`/`validAt`/`decayFloorAt` を今回も
   検査しない**（決定9-a）。この4軸は同伴取得がそもそも見ない既存の設計であり、
   本 ADR の射程は `attributes` だけに絞った——`attributes` 以外の軸で同種の穴が
   実際に問題になるかどうかは、確かめていない（そもそも既存の設計判断として意図的に
   検査しない、という立場だが、その立場自体を再検証してはいない）。
7. **段5の後置検査は `scope.attributes` が在るときだけ `MemoryStore.getMany` を
   追加で1回呼ぶ**（決定9-b）。adapter が最初から正しく `attributes` を絞り込んで
   いれば無駄な往復になる——**この往復が実際にどれだけの遅延を足すかは実測していない**。
   `aggregate.digests` は既定 `DEFAULT_DIGEST_BAND_LIMIT`（50件）が上限なので、
   最悪でも1回の `getMany` が最大50件を引くだけだが、体感レイテンシへの影響は
   未計測。

---

## 射程 —— 確かめていないこと

- **キー数・キー長・値長・文字種の上限の数値**（決定2、負債3）。
- **consolidate/reflect の積集合が正しい選択か**（負債1）。
- **GIN 索引がプランナに実際に選ばれる条件**（負債4）。
- **`examples/chat` への反映**。この PR の範囲に含めていない——呼び出し側が
  `attributes` を実際にどう使うか（例: テナント設定から `visibility` を渡す)は
  この ADR の射程外。
- **本物の OpenAI/Anthropic を使った実 API での検証はしていない**——`attributes` は
  LLM を一切経由しない設計（問い5）なので、この検証は本質的に不要だと判断したが、
  実際に確かめてはいない。
- **`#201`（labels、Phase 2）が着地したときの3本の役割分担の記述**（決定8の表）が、
  実際に `labels` が実装されたときも変わらず正しいかどうかは、実装されるまで
  確かめようがない。

---

## これが覆るとしたら

1. **#541 が「union への値追加は破壊的と数える」に決着したうえで、オーナーが
   「それでも `condition` に専用の値を足すべき」と判断したとき**——v2.0.0 での
   `FilteredOmission.condition: "attribute"` 追加を検討することになる（「採らなかった
   案」参照）。
2. **consolidate/reflect の積集合が実運用で問題を起こしたとき**——「呼び手が明示的に
   `internal` と申告した記憶が、統合を経て何の申告もしていない扱いになる」という
   逆方向の懸念（積集合ではなく和集合にすべきという意見）が出た場合、決定4を
   再検討する。
3. **GIN 索引のサイズ・選択率が実測され、`jsonb_path_ops` ではなく別の設計（複合
   GIN を諦めて `attributes` 単体の索引にする、キーごとの生成列にする等）のほうが
   良いと分かったとき**——マイグレーション0019は単純な `ADD COLUMN`/`CREATE INDEX`
   であり、置き換えの追加マイグレーションで対応できる。
4. **キー数・キー長・値長の上限が実運用に対して狭すぎる/緩すぎると分かったとき**
   ——緩めるのは非破壊、締めるのは破壊的変更になる（決定2）。

---

## 測ったこと

### 【実測】赤（実装前・`packages/core`）

`observe-attributes.test.ts`/`recall-attributes-filter.test.ts` を実装前の
`runtime-fakes.ts`（`attributes` を一切転記しない状態）に対して走らせると:

```
$ pnpm --filter @mnemora/core exec vitest run src/__tests__/observe-attributes.test.ts
 FAIL  ... observe({ kind: 'utterance', attributes }) が Memory.attributes に到達する
 FAIL  ... attributes を渡さない observe() は Memory.attributes が {} になる
 FAIL  ... ObserveEventInput / ObserveDocumentInput でも同じ経路で伝わる
 FAIL  ... LLM 呼び出しが失敗し全文フォールバックへ倒れた場合も attributes を継承する
      Tests  5 failed | 1 passed (6)
```

（`buildNewMemoryFromCandidate` に `attributes: params.observation.attributes ?? {}` を
実装する前、`runtime-fakes.ts` の `createObservationIdempotent`/`createMemoryIdempotent`
に転記を足す前の状態。）

`recall-attributes-filter.test.ts` も同様に、`survivesAttributesFilter`/
`VectorFilter.attributes`/`aggregateScope` の `attributes` 分岐を実装する前は
11本中2本が赤かった（`totalInScope` が絞り込みを反映しない・連想枠の filter に
`attributes` が渡らない）。

### 【実測】緑（実装後）

```
$ pnpm --filter @mnemora/core exec vitest run
 Test Files  76 passed (76)
      Tests  1130 passed | 4 expected fail (1134)
```

### 【実測】変異試験（`cp` で退避・復元。`git checkout` は使っていない）

| # | 変異 | 検出した歯 |
|---|---|---|
| (m1) | `strategies/consolidate.ts` の `attributes: intersectAttributes(eligible)` を `attributes: {}` に置き換え | `consolidate.test.ts` 1本が赤（「全件一致するキーだけが残る」） |
| (m2) | `extraction.ts` の `attributes: params.observation.attributes ?? {}` を `attributes: {}` に置き換え | `observe-attributes.test.ts` 4本が赤（sync・event/document・フォールバック・deferred の4経路すべて） |

復元後、`git diff` で各ファイルが変異前と完全に一致することを確認し、同じテストが
緑に戻ることも実測した。

### 【実測】postgres（実機、Postgres 17 + pgvector + btree_gin + pgcrypto、`initdb` で
自分専用インスタンスを起動。`AGENTS.md`「手元で Postgres を立てる」の手順どおり、
既定ポート5432は使わず、データ/ソケットディレクトリも作業ディレクトリ配下）

```
$ pnpm --filter @mnemora/postgres run migrate
適用したマイグレーション: ..., 0019_observations_memories_attributes.sql
```

```
$ pnpm --filter @mnemora/postgres exec vitest run src/__tests__/conformance.postgres.test.ts
 Test Files  1 passed (1)
      Tests  320 passed (320)
```

**この実機検証の過程で、本文に書いていなかった欠落を1件検出・修正した**——
`PostgresMemoryStore.createObservation`（`createObservationWithOutbox` とは別の、
単独の書き込み口）の INSERT 文に `attributes` 列が抜けていた。`createObservation は
attributes を書き込み、読み戻す` という conformance テストが実際にこれを検出した
（【実測】赤: `AssertionError: expected {} to deeply equal { visibility: 'internal' }`）。
修正後、同じテストを含む8本の attributes 関連 conformance テストが緑になった。

`idx_memories_attributes` の GIN 索引が実際に `@>` 述語に使えることを、20,000行の
擬似データ（`visibility` の値が20%で `internal`）に対する `EXPLAIN (ANALYZE, BUFFERS)`
で確認した——他の `tenant_id` 先頭索引をトランザクション内で一時的に `DROP` して
強制した状態では `Bitmap Index Scan on idx_memories_attributes` が選ばれ、
`Index Cond` に `tenant_id` と `attributes @>` の両方が乗った（複合 GIN として機能
している）。**ただし、他の索引をそのままにした自然な計画では、プランナは既存の
`tenant_id` 先頭 btree 索引を選び、`attributes` の条件をヒープ上の `Filter` として
後付けした**（この20,000行・選択性20%の擬似データでは、GIN 経由より安いとプランナが
見積もった）。この非対称の性質は `recall-gate-index.test.ts` が `idx_memories_recall_gate`
について既に文書化しているものと同型であり、「索引が使える」ことと「プランナが
選ぶ」ことは別の主張である。

### 【実測】6つの門

```
$ pnpm run typecheck    （8 workspace すべて。examples/chat 含む）→ exit=0
$ pnpm run lint          → exit=0
$ pnpm run format:check  → exit=0
$ pnpm run build         → exit=0
$ pnpm api:check → api:write → api:check  → 緑（core.d.ts / testkit.d.ts のみ差分、全部追加）
$ pnpm --filter @mnemora/postgres run test:db（実機、56ファイル・614件）→ 全緑（254.91秒）
```

（ルートの `pnpm run test`（3段ゲート）そのものは実行していない——`examples/chat` の
実 API 依存テストを含み、core/postgres/testkit を個別に走らせた内容と重複が大きいため。
下記「確かめていないこと」参照。）

### 【実測】2026-09-25 追記（レビュー指摘の赤→緑） —— 段3・段5の後置防御

レビュー（マネージャー経由）で、`survivesAttributesFilter` が段1・段3.5にしか
掛かっておらず、段3（必須の同伴取得）と段5（目次帯）が素通りしていることを指摘された
（上記「決定9」）。`packages/core/src/__tests__/recall-attributes-content-leak.test.ts`
（新規）に5本の歯を足し、`cp` で退避・復元して実装前後の赤→緑を実測した
（`git checkout` は使っていない）。

**赤（`recall-runtime.ts` を退避前の状態、companion の `.filter(survivesAttributesFilter)`
を除いた状態に戻して実行）**:

```
$ pnpm --filter @mnemora/core exec vitest run \
  src/__tests__/recall-attributes-content-leak.test.ts -t "必須の同伴取得"
 FAIL  ... 対向（companion）の attributes が絞り込みに一致しなければ、争っている側ごと結果から落ちる
   AssertionError: expected [ 'mem-1', 'mem-2' ] to not include 'mem-2'
 Tests  1 failed | 1 passed | 3 skipped (5)
```

**赤（目次帯の後置検査ブロックを丸ごと除いた状態で実行）**:

```
$ pnpm --filter @mnemora/core exec vitest run \
  src/__tests__/recall-attributes-content-leak.test.ts -t "目次帯"
 FAIL  ... scope.attributes を無視する MemoryStore.aggregateScope でも、digestBand に絞り込みの外の digest は乗らない
   AssertionError: expected [ 'mem-2', 'mem-1' ] to not include 'mem-2'
 FAIL  ... attributes で落ちた分だけ digestEligible.count を減らし、countKind を 'unknown' にする
   AssertionError: expected 2 to be 1
 Tests  2 failed | 1 passed | 2 skipped (5)
```

**緑（`cp` で復元後）**:

```
$ pnpm --filter @mnemora/core exec vitest run src/__tests__/recall-attributes-content-leak.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
$ pnpm --filter @mnemora/core exec vitest run
 Test Files  77 passed (77)
      Tests  1145 passed | 4 expected fail (1149)
```

**testkit 適合テスト（新規、postgres と in-memory の両方で緑を確認）**:

```
$ pnpm --filter @mnemora/testkit exec vitest run \
  src/__tests__/in-memory-fixtures.conformance.test.ts -t "digests（目次帯の候補）"
 Tests  1 passed | 321 skipped (322)

$ DATABASE_URL=postgresql://worker@127.0.0.1:<専用ポート>/mnemora_test \
  pnpm --filter @mnemora/postgres exec vitest run \
  src/__tests__/conformance.postgres.test.ts -t "digests（目次帯の候補）"
 Tests  1 passed | 321 skipped (322)
```

（`aggregateScope の digests（目次帯の候補）も scope.attributes で絞られる` を
`memory-store-conformance.ts` に追加——`InMemoryMemoryStore`/`PostgresMemoryStore` は
どちらも `aggregateScope` の実装そのもので `digests` を絞っているため、この歯は
実装当初から緑だった＝「adapter 側は最初から正しく、runtime 側の後置防御が
無かった」ことの裏付けでもある。）

---

## 参照

- [Issue #152](https://github.com/takecchi/mnemora/issues/152) — 書き込み側（呼び手の属性を渡す口）
- [Issue #153](https://github.com/takecchi/mnemora/issues/153) — 読み出し側（属性で絞り込む口）
- [Issue #541](https://github.com/takecchi/mnemora/issues/541) — union への値追加を破壊的と数えるか（未決）。本 ADR の決定6の直接の出自
- [Issue #201](https://github.com/takecchi/mnemora/issues/201) — `labels`/`memory_labels`（Phase 2）。決定8の表の対象
- [ADR 0006](./0006-memory-schema.md) — 「単一 JSON カラム」却下の原理。本 ADR の値の型選択の根拠
- [ADR 0037](./0037-callers-pass-occurred-at.md) — 「まず呼び出し側が渡す形を検討する」の先例
- [ADR 0145](./0145-valid-from-until-storage.md) / [ADR 0164](./0164-valid-from-until-recall.md) — `validFrom`/`validUntil` の書き込み・読み出し配線。本 ADR が踏襲した構造上の先例（2 PR に分かれた経緯を含む）
- [ADR 0172](./0172-association-passes-decay-and-validity-gates.md) — 連想枠（段3.5）が段1のゲート更新に自動追随しない、という見落としの先例。決定5がこれを繰り返さないための規律
- [ADR 0174](./0174-filtered-omission-scope-relation.md) — `ScopeRelation`（`within_scope`/`outside_scope`）と `totalInScope` の数え方。決定6の土台
- [ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定8 — 「区別を受け取った側が実行時に違う手を打てるか」。#152 単独では立たない、という判定の根拠
- [ADR 0046](./0046-contested-pair-invariant-tooth.md) — 「いまは決めない」と名乗って測れる形を残す先例
- [ADR 0043](./0043-unit-assembly-dropped-omission.md) — `unit_assembly_dropped`。決定9-a が段3の attributes 不一致をこの既存経路にそのまま乗せた
- [ADR 0155](./0155-recall-score-breakdown-persisted.md) — `RecallRecordMemory` が「後から再現できないもの」だけを持つ設計。決定9 の監査表がこれを根拠に永続化経路を「対象外」と判定した
- [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) — 本 ADR・issue コメントがいずれも自動化された担い手のものであり、オーナー本人の決定ではないことの根拠
- [ADR 0289](./0289-recalled-memory-speaker-subject.md) — `RecalledMemory` に任意欄＋runtime 保証で足す形の直接の先例。決定7・引き受けた負債2の形はこれを踏襲した
- `docs/migration-v1.md` — 破壊的変更の数え方。「非破壊の根拠」節
- `AGENTS.md`「手元で Postgres を立てる」— 本 ADR の実機検証の手順
