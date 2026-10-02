# ADR 0509: 穴探し — recall の fuzz に `channels`（tsvector・trigram）・HNSW 上の `fields`・`getRecall` の読み戻しを足した（Fake と testkit の語彙検索の食い違いが 2 つ出た。直していない）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-44ffeb19 の指示による）が書いた。直す線は依頼主が決めた（この PR は歯を足すだけで、実装は変えていない）。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 要点

- **前提**【現物】: [ADR 0492](./0492-fuzz-profile-fields.md) が「今回の欄で拾えなかったもの」と「測っていないこと」を挙げ、[ADR 0494](./0494-fuzz-relations-and-argument-mutation.md) が `relations`・`argdead`・`argupper` を足した。残っていた穴 (a)〜(e) のうち (a)(b)(c) を足した。
- **足したもの**（`default`／`wide`／`fields`／`relations`／`argdead`／`argupper` の同じシードの操作列は変えていない。追加の乱数は `r2` から引く）:
  - (a) profile `channels`: recall の `channels` を `["ann","lexical"]`・`["lexical"]` だけ・`["lexical","ann"]`・`["ann"]` だけから乱択し、`text` と記憶の content に語（ASCII の語・識別子、日本語）を足す。Postgres は tsvector の `PostgresLexicalStore` と `PostgresTrigramLexicalStore` の両方で回す。
  - (b) profile `fieldswide`: `wide`（`bulk`）と `fields` の欄を合わせ、`seqscan_off` の接続で回す。
  - (c) 不変条件 I16 と差分の `record`: `getRecall(recallId)` が読み戻した `RecallRecord` の `returnedMemories`（`memoryId`・`retrievedVia`・`score`・`companionOf`・`associationOf`）・`omitted`・`usage` が、その recall の戻り値と一致する。さらに差分検査の snapshot に `record` を載せ、Fake・testkit と Postgres の読み戻しを突き合わせる（全 profile）。
- **割れ**: Fake・testkit・Postgres の語彙検索の食い違いが **2 つ**見つかった（下の「割れ」）。直さず、固定の操作列で「いま食い違う」ことを留めた。**不変条件の違反は無かった**（I16 を含む）。
- 実装（`packages/*/src` の本体）は 1 バイトも変えていない。`memory-store.ts` に触れていない。CHANGELOG・migration-v1 は不要。

## 決定

### 1. `channels`

- 操作 `create` に `w`（足す語）、`recall` に `ch`（`channels` と `text`）を足した。`ch` があれば既存の `lex` より優先する。`channels` では全 recall が `ch` を持つ。
- **I10 の下限は `channels` に `"ann"` を含む recall にだけ当てる**【判断】。`["lexical"]` だけの recall の候補は語彙に当たった記憶だけで、当たらなかったスコープ内の記憶はどの札にも数えられない（最初に下限を当てたところ、`channels` の core の 20 シードのうち多数が `I10-lower` で落ちた。最小化した操作列は「記憶 1 件 + `ch.c = ["lexical"]` の recall 1 回」）。下限の根拠は「ann が eligible を全部候補にする」ことなので、ann を含まない recall には前提が無い。これは割れではなく不変条件の適用範囲の線引きである。上限は全 recall に当てる。
- **語彙**: Fake・testkit が Postgres と食い違う語を `channels` の語に入れていない（下の割れ 1・2。`CHANNEL_WORDS` の doc に条件を書いた）。入れると、見つけた割れが毎回 fuzz を赤くするだけで、ほかの割れを覆い隠す。
- 脚: core（Fake）20 シード、Postgres は tsvector 10 シード・trigram 10 シード（`planner`）、Fake・testkit との差分 10 シード（`indexscan_off`、tsvector）。環境変数 `RECALL_FUZZ_CHANNELS_SEEDS`・`RECALL_FUZZ_PG_CHANNELS_SEEDS`・`RECALL_FUZZ_PG_CHANNELS_DIFF_SEEDS`。

### 2. `fieldswide`（HNSW の経路の `fields`）

- 【実測】`auto_explain`（`log_min_duration = 0`）で、段 1 の `Index Scan using idx_memory_embeddings_hnsw_*` の数を数えた。**`fields`（記憶が高々二十数件）は `seqscan_off` でも HNSW を 0 回しか通らない**（`idx_memories_period_ann_stage` と埋め込み表の pkey を選ぶ）。**`fieldswide`（5 シード）は 95 回、既存の `wide`（10 シード）は 140 回**通る。
- ⟹ 依頼の「`fields` を `seqscan_off` に載せる」は、小さい `fields` をそのまま載せても HNSW を通らず意味が無い。**規模を `wide` に揃えた `fieldswide`** を足し、`seqscan_off` の脚にした（5 シード。`wide` の半分にしたのは 1 シードあたりの時間が同程度のため）。`RECALL_FUZZ_PG_FIELDS_WIDE_SEEDS`。
- 差分は当てない（ADR 0492 と同じ理由。HNSW は近似で、`ann_unreached` の揺れが約束の内にある）。

### 3. `getRecall`（I16 と差分の `record`）

- 差分の snapshot の `record` から、backend の違いで値が変わる欄を落とした: `query.vector`（Fake は 2 次元、Postgres は 3 次元に 0 を足す）、`usage.chars`・`estimatedTokens`・`indexChars`・`byTier.index`（`JSON.stringify(indexBand)` の長さから出る。memoryId を含むので、Fake の `mem-N` と Postgres の uuid で長さが違う）。ほかの欄（`createdAt`・`explain`・`omitted`・`indexBand`・`budget`・`byTier.digest` ほか）は比べる。
- 【実測】この比較で出た食い違いは、上の 2 欄が落ちていなかったことだけだった。実装の食い違いではない。

### 4. (d)(e) は手を付けない【判断】

- (d) `observe()` を通して `event.data` の往復を見る: `observe()` は抽出（LLM）と `tick()` を通る。いまの harness は `createMemory` を直接呼び、LLM を使わない（`consolidate` の固定応答だけ）。往復の不変条件（入力 `data` を JSON にして読み戻した値と、`event.data` が等しい。往復できない値は断る）を決めるには、`data` の値の生成器（`undefined`・`NaN`・`Date`・巨大な数・循環など）と、`observe` が書く行と断る行の仕様の整理が要る。**設計が要るので、不変条件の定義を先に書く別の仕事にする。**
- (e) スコープを絞る欄（`validAt`・`labels`・`attributes`・`excludeProvenanceKinds`）: I11 の前提を壊す。必要な不変条件の骨子だけ書く: 検査器が各記憶に `validFrom/Until`・`labels`・`attributes`・`provenance.kind` を持たせ、クエリの絞りから期待の集合（`totalInScope` = 絞りに合う active/contested の数、`filtered` の `outside_scope` の内訳）を独立に数え、I11・I12 をその期待と突き合わせる。記憶側の欄を create に足す必要があり、既存 profile の create の乱数列を変えないよう `r2` から引く。**まだ書いていない**。

## 割れ（直していない）

どちらも `docs/decisions/0493` が揃えた「入力の断り」ではなく、語彙検索の一致の意味の食い違いである。固定の操作列を `recall-invariant-fuzz.postgres.test.ts` の「既知の割れ（ADR 0509）」2 本に留めた（直ったら期待を反転させる）。

1. **Fake の `FakeLexicalStore` は部分一致、Postgres（tsvector）は語（token）一致**【実測】。content に `alpha`、query の `text` が `a`（`channels: ["lexical"]`）。Fake は `normalizedContent.includes("a")` で当たり（`runtime-fakes.ts`）、Postgres は当たらない。testkit の `InMemoryLexicalStore` は語で数えるので Postgres と一致する。
   - 再現: 固定の操作列（`create` の `w: "alpha"` 1 件 + `recall` の `ch: {c:["lexical"], text:"a"}`）。見つけたシード: `channels` の 40 シード差分で seed 38（`PROJ-12` を `PROJ12` にして他の割れを外した状態。recall #15 の `$.memories[0].score.lexicalMatch`）。【判断】これまで見つからなかったのは、既存の `lex`（text `a b`）の content が語を持たず、`content`・数字・単独の `a`/`b`/`c` だけだったから。
2. **testkit の `InMemoryLexicalStore` はハイフンで語を割り、Postgres は `PROJ-12` を 1 語と数える**【実測】。query `gamma PROJ-12`、content `gamma`。Postgres の coverage は 1/2、testkit は `gamma`・`proj`・`12` の 3 語で 1/3。Fake は空白で割るので Postgres と一致する。
   - 再現: 固定の操作列（`w: "gamma"` + `text: "gamma PROJ-12"`）。見つけたシード: `channels` の差分で seed 4（recall #7、`$.index.digestBand.length`: 閾値 0.3 に対し lexicalMatch が 0.333 対 0.25 で、返る・返らないが分かれた）、seed 6（recall #4、nearMiss の score 0.0228 対 0.0152。比が 1.5 = 1/2 対 1/3）。
- 【判断】直す先は fixture（Fake／InMemory）を Postgres に揃える向きと思うが、`ADR 0493`・`0500` の「fixture を Postgres に揃える」の線に載るかはオーナー側の判断。**この PR では直さない**（依頼）。

## 陽性対照（変異。前景で 1 本ずつ、`cp` で戻して `cmp` で確かめた）

足した profile が実際に効いていることを、core の `src`（postgres の vitest は core を src に alias している）と postgres の `src` を変異させて確かめた。

| 変異 | 見る脚 | 結果 |
|---|---|---|
| `strategies/scoring.ts` の `total` を、`timeWeighting === "eventAwareFreshness"` のとき `freshness` の代わりに 1 で計算する | core 全体 | `default`（40 シード）は緑、**`fields` だけ赤**（I5）。ほかの profile も緑 |
| 同上 | Postgres `fieldswide（seqscan_off）` | **赤**: seed 1・2・3・5 が `I5-product`。⚠ seed 1・2・5 は掛け算の順が変わったことによる浮動小数の末尾の差、seed 3 だけ実質の食い違い（`0.995… vs 1.2`）。この変異は I5 を小さく揺らすものでもあり、強い対照ではない |
| `mapping.ts` の `rowToRecallRecord` が `omitted: []` を返す（Postgres の `getRecall` の読み戻し） | Postgres `channels（planner）` | **赤**: seed 1〜6 … が `I16-record-omitted`（差分の `record` も食い違う） |
| `recall-runtime.ts` の語彙ヒットの合流で、ann にもあった id を `candidateIds` に二重に積む | core 全体 | **赤**: `default` を含む全 profile が `I10-upper`（`channels` も）。`channels` だけに効く変異ではない |

- **やりすぎの側の変異は持っていない**（【未確認】）。I16 は「読み戻しが戻り値と等しい」だけを見るので、正当な入力を断る形の変異には当たらない。
- **`channels` にだけ効く変異は作れなかった**【未確認】。`["lexical"]` だけの recall が ann を走らせる変異（`wantsAnn = true`）や、trigram の日本語側の一致を壊す変異を、いまの不変条件は見ない（構造の不変条件で、「その語が本当に当たったか」の oracle が無い）。ASCII の語彙の意味は Fake・testkit との差分が見る（割れ 1・2 はそれで出た）が、**trigram の日本語側には差分の相手が無い**。
- HNSW の `iterative_scan = off`・`ef_search = 1` に変えた変異（`vector-store.ts`）は、`wide` を含めてどの脚でも赤にならなかった【実測】。HNSW の取りこぼしは不変条件の外（ADR 0193）。`fieldswide` が HNSW を「通る」ことは上の EXPLAIN で示し、「取りこぼしを見つける」ことは主張しない。

## 足した分の実行時間【実測】

手元の PostgreSQL 17（`initdb`、UTF8 + C.UTF-8）+ pgvector、node v22.23.3。

| ファイル | 足した leg | 全体 |
|---|---|---|
| `recall-invariant-fuzz.test.ts`（core） | `channels` 20 シード 数秒 | 約 12 秒 |
| `recall-invariant-fuzz.postgres.test.ts` | `channels` 6.2 秒 + trigram 7.7 秒 + `fieldswide` 12.4 秒 + `channels` 差分 約 8 秒（+ 固定の割れ 2 本 0.2 秒） | 約 192 秒（20 本） |

差分に `record` を載せたことによる既存の差分の時間の増えは測っていない（【未確認】）。

## 検討した代替案

1. **`channels` の語彙に割れる語を入れたまま、赤で出す。** 採らなかった。CI が赤のまま残り、ほかの割れが覆い隠される。固定の操作列で留めた。
2. **割れを `it.fails` にする。** 採らなかった。シードの範囲全体が「失敗してよい」になり、別の割れも黙って飲む。固定の最小列だけ「食い違うこと」を期待する形にした。
3. **`fields` をそのまま `seqscan_off` に載せる。** 採らなかった（上の EXPLAIN）。
4. **I10 の下限を `["lexical"]` にも当てるため、「語彙に当たらなかった」記憶を `omitted` に数える。** 採らなかった。新しい札の追加は実装の変更で、この PR の線の外。

## 引き受けた負債（材料）

| # | 負債 | 緊急度 | 覆る条件 |
|---|---|---|---|
| 1 | Fake の部分一致・testkit のハイフン分割（割れ 1・2）。固定の操作列が留めている | 中（fixture を使って検査する外部 adapter の作り手に届く） | fixture を揃える直しが入ったとき（期待を反転させる） |
| 2 | trigram の日本語側に差分の相手が無い。不変条件も構造だけ | 低 | 日本語の語彙の oracle（期待の一致集合）を決めたとき |
| 3 | (d)(e) の不変条件が未定義 | 低 | 上の骨子から ADR を書くとき |
| 4 | HNSW を通る脚に差分を当てられない（ADR 0193） | 低 | 近似を許す差分の比較（集合の包含など）を決めたとき |

## これが覆るとしたら

`RecallQuery.channels` に値が増えたとき（`CHANNEL_SETS` に足す）。`RecallRecord` に欄が増えたとき（I16 の突き合わせの対象に足すか決める）。`default`／`wide`／`fields` の乱数の引き方を変えたとき。

## 測っていないこと

`fieldswide` のシード数を増やしたときの割れ。trigram の store と Fake・testkit との差分（日本語を含む語彙）。`["lexical"]` だけの recall の候補の完全性（oracle が無い）。`observe()` 経由の往復と、スコープを絞る欄（上の (d)(e)）。差分に `record` を載せたことによる既存の差分の時間の増え。
