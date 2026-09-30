# ADR 0390: `ann_unreached` が `excludeProvenanceKinds` を分母から引く（除外行の索引済み件数を集約が返す）と、`scopeAggregate: "skip"` で到達を判定できないと名乗る

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

- **文脈**:

  `packages/core/src/recall-runtime.ts` の `ann_unreached`（ADR 0025 の実測、ADR 0026 の決定、
  ADR 0193 が発火条件を拡張、ADR 0288 が `severity` を追加）と、診断キー
  `annReturnedFewerThanReachable` / `annReachableLowerBound`（ADR 0285）は、母数
  `eligible = aggregate.totalInScope − notIndexed（pending+failed+skipped）` を使う。
  この母数は、`RecallQuery.excludeProvenanceKinds` で**段1の ANN から除外した kind の行も数える**
  （`MemoryStore.aggregateScope` に除外が渡らない）。core 単体のインメモリ fake で、次の2つを再現した。

  1. **問い1「黙る」**: 除外 kind `consolidated` 4件をクエリに最も近く、除外しない3件を少し遠くに置き、
     「索引は近傍 reach=4 件しか見ず、除外は後段で落とす」`VectorStore` スタブで recall すると、
     ANN は除外しない3件を1件も返せていない（取りこぼしている）のに、`lowerBoundUsable = false`
     （除外指定のとき下限を使わない、ADR 0285 の引き受けた負債7）により severity は `"info"` のまま、
     診断キーも付かない。
  2. **問い2「鳴りすぎ」**: 除外しない3件と除外4件を全部同じ位置に置き、素の fake で recall すると、
     ANN は除外しない3件を全部返す（取りこぼしていない）のに、`annHits.length(3) < eligible(7、除外行込み)`
     で `ann_unreached` が鳴る。
  3. **問い3（実測。コーディネーターの手元の測定であり、本 ADR の作業では再測定していない）**:
     近傍に scope 外の行が約2万件を超えると、ANN（HNSW の候補枠）は scope 内の候補を0件しか返さなくなる。
     除外指定の recall では、この全滅が `info` の `ann_unreached` に紛れていた（問い1と同じ経路）。

  ADR 0384 の「決めたこと」7は、もう1つの穴を名乗っていた: `scopeAggregate: "skip"` では `totalInScope`・
  `notIndexed` が0になり `eligible` が0になるので、`ann_unreached` も `annReturnedFewerThanReachable` も
  立たない。しかも「判定していない」と名乗る診断も出ない（`ann_unreached` が無いことが「拾いきった」と
  読める）。ADR 0384 はこの手当てを本 ADR（案2の続き）へ送っていた。

- **北極星の5つの問いに実際に当てた結果**:

  | 問い                                      | 結果                                                                                                                                                                                        |
  | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | **1**（毎回渡す量を減らす方向に働くか）   | 渡す量は変えない。診断の偽陽性（問い2）を減らし、偽陰性（問い1）を減らす。                                                                                                                  |
  | **2**（無効にしても成立するか）           | 成立する。除外指定なし・欄を返さない adapter・`"exact"` の呼び出しは今日と1バイトも変わらない。                                                                                             |
  | **3**（選ばれた理由を後から説明できるか） | **これが眼目。** 「鳴らない」が「拾いきった」と「判定できていない」のどちらなのかを、診断が名乗るようにする（北極星33行目「『見つからなかった』と『探していない』を、同じ顔で返さない」）。 |
  | **4**（推論と事実を区別しているか）       | 除外件数は集約が数えた事実。下限は算術で導いた推論で、下限であることをキー名が名乗る（ADR 0285）。                                                                                          |
  | **5**（LLM を呼ばずに済ませられないか）   | 元から LLM を呼ばない。同じ集約クエリの `count(*) FILTER` 1列で解く。                                                                                                                       |

- **決めたこと**:

  1. **案2（非破壊）を採る。** `AggregateScopeOptions` に任意の `excludeProvenanceKinds?: readonly ProvenanceKind[]`
     を足し、`ScopeAggregate` に任意の `excludedProvenanceIndexedCount?: number`
     （除外される kind で、スコープ内の**索引済み**の行の数）を足す。`undefined` と空配列 `[]` は
     どちらも no-op（欄を返さない）——`VectorFilter.excludeProvenanceKinds`（ADR 0056）と同じ作法。
     `totalInScope`・`groups`・`filtered*`・`digests` の意味は変えない（除外行もそれらには数えたまま）。
  2. **「索引済み」の定義は `notIndexed` と揃える**: `embeddingStatus = 'ready'`（= スコープ内で
     `pending`/`failed`/`skipped` でない）かつ `totalInScope` と同じ絞りの内側。`eligible`
     （= `totalInScope − notIndexed` 合計）は「スコープ内の索引済みの行数」であり、そこから除外 kind の
     索引済みの行数を引くと、ANN が本来返しうる除外**しない**行の数になる。引く量と引かれる母数が
     同じ定義で数えられているので、ずれない。
  3. **core**: 除外指定が非空で、欄が在るときは `eligible` から欄の値を引き、`lowerBoundUsable` を真にする
     （`reachableLowerBound = max(0, eligible − filteredDecayed)`、式は ADR 0285 のまま）。欄が無いとき
     （欄を返さない adapter）は `eligible` も `lowerBoundUsable` も今日のまま（除外指定では判定しない）。
     除外指定なしの呼び出しでは、`aggregateScope` の呼び出しの形も含めて今日と同じ。
  4. **Postgres**: 除外指定が非空のときだけ、同じ集約クエリ（`scoped`/`flags`/`agg`）に
     `provenance_kind` の列と `count(*) FILTER (...)` を足す。未指定・空配列のときは SQL テキストにも
     返り値にも何も足さない（`digestBandColumns` と同じ「条件が真のときだけ載せる」パターン）。
     `"skip"` のときは SQL を発行する前に戻る（ADR 0384 案C）ので、欄は返さない。
  5. **インメモリ2つ**（`packages/core` の `FakeMemoryStore`、`packages/testkit` の `InMemoryMemoryStore`）
     にも同じ意味で実装する。`"skip"` のとき `InMemoryMemoryStore` は欄を返さない。
  6. **`filteredDecayed` に除外行が混ざって下限が小さくなる側へずれるのは、健全で許容する。**
     `filteredDecayed` は除外 kind の decayed 行も数える。除外行は `eligible` から（本 ADR で）引かれ、
     さらに `filteredDecayed` からも引かれるので、除外行のうち decayed のものは二重に引かれる。
     下限は真の値より小さくなる（= 警告が減る）だけで、偽陽性は出ない（ADR 0285 が守った健全性は保たれる）。
     この見逃しは ADR 0285 の「見逃しの対照」と同じ種類の、引き受けた負債である。
  7. **`scopeAggregate: "skip"` で ANN の段が走ったとき、ANN の stage detail に
     `annReachability: "unknown"` を足す**（ADR 0384「決めたこと」7の手当て）。条件は次の全部:
     ANN の段が実際に走った（`candidateGenerationExecuted`・`kPrime > 0`・`annStageTrace` が在る）、
     `scopeAggregate === "skip"` を要求した、**かつ adapter が `countKind: 'unknown'` を返した**。
     - 診断キーは条件が真のときだけ足す（ADR 0084 §6 の歯②と同じ作法）。既定 `"exact"` の
       `explain.stages` は1バイトも変わらない（`recall-channels.test.ts` の全体一致の歯）。
     - `skip` を頼んだのに `exact` が返る adapter（`scopeAggregate` を実装しない adapter）では、
       従来どおりの判定になり、キーは付かない。
     - `ann_unreached` は `skip` では鳴らないまま（母数が無い）。`annReturnedFewerThanReachable` も立たない。
       **名乗るのは `annReachability: "unknown"` だけ**——「届かなかった」と断言するのではなく、
       「判定できない」と名乗る。
  8. **適合テスト（`memory-store-conformance.ts`）には足さない。** 既存の方針（Issue #809）に合わせる——
     この欄は任意であり、適合テストに足すと欄を返さない外部 adapter に要求を増やしてしまう。歯は
     `fake-aggregate-scope-exclude-provenance.test.ts`（core の Fake）・
     `in-memory-fixtures-aggregate-scope-exclude-provenance.test.ts`（testkit）・
     `aggregate-scope-exclude-provenance.postgres.test.ts`（Postgres）に置いた。
  9. **診断の形（決定7）の選び方**: 既存の作法から、型を変えない `StageTrace.detail` の診断キーを選んだ
     （ADR 0285 §2.2 が `Omission` union を増やさず `detail` に足した判断と同じ）。採らなかった形は
     「採らなかった案」に書く。

  **公開 API**: `AggregateScopeOptions.excludeProvenanceKinds?` と `ScopeAggregate.excludedProvenanceIndexedCount?`
  の追加のみ（任意の欄）。`scripts/__snapshots__/public-api/core.d.ts` を更新した。**破壊的変更ではない**
  （欄を返さない・受け取らない既存の adapter・呼び出し元は今までどおりコンパイルでき、動く）。

- **採らなかった案**:

  1. **案1: `eligible` を `provenance` 込みで core が算術だけで補正する。** 除外 kind の件数は
     集約に現れないので、算術では導けない（ADR 0285 の 2.）。
  2. **案3: 除外指定のときは `ann_unreached` を常に鳴らさない。** 問い2の鳴りすぎは止まるが、問い1・3の
     取りこぼしを名乗れないままになる。
  3. **`skip` のとき `ann_unreached` を `countKind: 'unknown'` で出す。** 「届かなかった」と断言する顔に
     なり、`skip` の呼び出しの大半（取りこぼしていない recall）で誤って鳴る。`severity` の意味
     （ADR 0288）も崩れる。
  4. **`Omission` union に新しい `kind` を足す。** 公開型の変更（ADR 0285 §2.2、Issue #541 の判断待ち）。
  5. **`RecallQuery` の除外指定を `aggregateScope` の `scope` に載せる。** `scope` は全チャンネル・
     `archiveDecayed` 等が共有する境界で、除外は ANN の段だけの絞り（後段にも残る後置フィルタ）であり、
     `totalInScope` の意味を変えてしまう（決定1で意味を変えないと決めた）。

- **引き受けた負債**:

  1. 決定6の見逃し（除外行のうち decayed のものが二重に引かれ、下限が小さくなる）。
  2. `"skip"` では取りこぼしの有無そのものは分からない。決定7は「分からない」と名乗るだけで、
     判定を復活させてはいない。件数を数えずに到達を判定する手段は本 ADR の範囲外。
  3. 欄を返さない（自作の）adapter では、除外指定の recall で ANN の取りこぼしを引き続き判定できない
     （ADR 0285 の負債7がそのまま残る）。

- **これが覆るとしたら**:

  1. 除外指定を段1へ押し下げるのをやめ（後段だけで落とす）、ANN の窓が除外行で埋まる状況自体が
     なくなるなら、問い1の状況は消える。
  2. `"skip"` でも安価に母数の下限を出せる手段（例: 索引済みの行数のカウンタ）が入れば、決定7の
     `unknown` を下限の判定に置き換えられる。

- **確かめていないこと**:

  - 問い3（近傍に scope 外の行が約2万件を超えると0件になる）は、コーディネーターの手元の実測に
    よるもので、本 ADR の作業では再現していない。
  - Postgres の集約に足した `FILTER` 列の**レイテンシへの影響は測っていない**（除外指定のときだけ
    足す列で、除外なし・`"skip"` の SQL は変わらない）。
  - 大規模テナント（10万行超）で、除外指定つきの `aggregateScope` が既存の実測（ADR 0307）と同程度かは
    見ていない。
  - 除外指定と `taxonomyGroups`・`subjectId` 絞り・`includeSubjectless` を同時に指定した Postgres の
    組み合わせは、歯で個別に固定していない（`in_scope` と同じ絞りの上で数える設計であり、
    `aggregate-scope-single-pass.postgres.test.ts` の等価性の歯は除外指定なしの経路を見ている）。
  - `excludeProvenanceKinds` に `stated`・`inferred` を含む呼び出しの、Postgres での個別の確認。
