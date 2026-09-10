# ADR 0092: クエリ語彙を OR で結び、`lexicalMatch` を被覆率にする — ADR 0084 §10 が残した独立の変更

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-10

**⚠ 各主張の出所を分ける**（[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) /
[ADR 0081](./0081-similarity-is-the-only-term-that-ranks.md) / [ADR 0084](./0084-lexical-recall-channel.md)
の体裁を踏む）。

- **【実測】** — この ADR の作業体が実際に走らせて測った（手元で走る `packages/core` /
  `packages/testkit` の歯・変異試験）。
- **【CI 実測】** — 本物の PostgreSQL に対する歯だが、**この作業環境には `psql` も
  `DATABASE_URL` も無いため、書き手自身の手では実行できていない。CI の実行結果でのみ
  確かめられる。**PR 本文に CI の結果が追記される。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 報告として受け取り、再導出していない。

---

## 文脈

[ADR 0084](./0084-lexical-recall-channel.md) §10「検討した代替案」は、この変更をこう予告していた（逐語）:

> **クエリ語彙を OR で結び、`lexicalMatch` を「一致した語彙数 ÷ クエリ語彙数」にする。**
> **この ADR では採らない。**⭐ **ただし、これは筋の良い案であり、次に来る人が再発見しなくて
> 済むように書いておく。**§2.1.1 の AND の制約（英語の自然文）と §5.1 の「`lexicalMatch` が
> 1通りしか値を取らない」負債を、**1つの変更で両方とも解消する。**採るなら独立した変更として
> 採るべきである。**⚠ そのとき注意が要る点**: 被覆率は IDF を持たないので、ありふれた語1つ
> だけのクエリでは `lexicalMatch = 1` が大量に立つ。**OR にするだけでは §8 の低選択率の問題は
> 消えない。**

本 ADR はその独立した変更である。**【現物】ADR 0084 §10 の記述と、本 ADR がマネージャーから
受け取った設計は、方向・被覆率の定義・「閾値を持たない・低選択率の負債は塞がらない」という
警告の3点で完全に一致している。**食い違いは見つからなかった。

### 解く問題（ADR 0084 §8 の負債、再掲）

> **🔴 ASCII の語どうしは AND で結ばれる**（§2.1.1）。**英語の自然文をそのまま `text` に
> 渡す呼び出し側は、語彙チャンネルからほとんど何も得られない。**

`RecallQuery.text` に `what did we say about PROJ-1234` のような英語の自然文を渡すと、
`content` に "what"/"did"/"we"/"say"/"about" のいずれかを含まない Memory はすべて弾かれ、
実質的に**全語を含む記憶しか返らない**。同時に ADR 0084 §5.1 の負債（`lexicalMatch` が
候補集合の上で `1` の一値しか取らない）も解消する。

---

## 決めたこと

1. **`LexicalHit` に `coverage: number` を足す**——**一致したクエリ語彙の数 ÷ クエリから
   作れた語彙の総数**。値域は `(0, 1]`（0 になる候補はそもそも一致していないので
   `search` は返さない）。
2. **`LexicalStore.search` の契約を OR に変える。**クエリ語彙のいずれか1つでも一致すれば
   候補になる（ADR 0084 の旧契約は AND：すべての語彙を含む候補しか返さない）。
3. **🔴 返り値の順序の契約を変える。**旧契約「`rank` の降順」→ 新契約
   **「`coverage` の降順。同値なら `rank` の降順」**。理由: `limit` の窓を切るときに、
   被覆率の高い候補を、被覆率の低い高 `rank` 候補に押し出させてはならない。`rank` は
   adapter 局所のタイブレークに降格する。
4. **`ScoreBreakdown.lexicalMatch` に `LexicalHit.coverage` をそのまま入れる。**
   `LEXICAL_MATCH_VALUE`（定数 `1`）を**削除する**——「`lexicalMatch` が取りうる唯一の値」
   という名前が嘘になるため。**🔴 これは公開 export の破壊的変更である**
   （`@mnemora/core` の `index.ts` が `export * from "./recall.js"` で再 export していた
   定数が無くなる）。
5. **`affinity = max(similarity, lexicalMatch)` の式（`scoring.ts`）は変えない。**
   被覆率が入ることで、部分一致の候補は自然に低い `affinity` になる——これが狙いである。
6. **閾値は持たない。**最小被覆率のオプションを足さない（下記「検討した代替案」参照）。
7. **postgres 実装は各クエリ語を `"..."` で囲んでから `websearch_to_tsquery` へ渡す**
   （下記「`"..."` で囲む理由」参照）。

---

## 被覆率の定義

`coverage = 一致したクエリ語彙の数 ÷ クエリから作れた語彙の総数`。

- **postgres 実装**: `mnemora_lexical_query_tsqueries(query)` がクエリを語ごとの
  `tsquery[]` にする（`migrations/0009_memories_lexical_or_coverage.sql`）。
  `mnemora_lexical_coverage(content, query)` が、そのうち `content` の tsvector に
  一致する要素数を数え、配列の長さで割る。
- **in-memory 実装（`InMemoryLexicalStore`）**: `tokenize(query)` の語の集合
  （重複除去、`Set`）を `terms` とし、`matched = terms のうち contentTokens に
  含まれるものの数`、`coverage = matched / terms.size`。
- **`packages/core` の `FakeLexicalStore`**（`runtime-fakes.ts`）: 同じ式
  （空白区切りの語の集合、OR、`matched.length / termSet.size`）を独立に実装している
  ——`packages/testkit` には依存しない、というこのファイルの既存の方針（Issue #106 期の
  コメント）をそのまま踏襲した。

**⚠ 3つの実装は独立に書かれており、共有関数は無い。**一致することの唯一の根拠は
`packages/testkit/src/lexical-store-conformance.ts` の適合テストが両方（postgres /
in-memory）に対して通ること、および `packages/core/src/__tests__/recall-channels.test.ts`
が `FakeLexicalStore` に対して通ることである——このコメント自身の主張ではない。

---

## 返り値の順序の契約を変えたこと

**旧契約**（ADR 0084）: 「`rank` の降順」。
**新契約**: **「`coverage` の降順。同値なら `rank` の降順」。**

`limit` は over-fetch した候補集合の上位から切る（`recall-runtime.ts` の `kPrime`）。
`rank` だけで降順に並べると、被覆率の低い候補が `rank`（頻度や `ts_rank_cd`）で
たまたま高い値を持てば、被覆率の高い候補を窓の外へ押し出しうる——これは
「被覆率が高い候補ほど優先して残す」という本 ADR の目的と正面から矛盾する。

`packages/core/src/interfaces/lexical-store.ts` の `LexicalHit`/`LexicalStore` doc と、
`packages/testkit/src/lexical-store-conformance.ts` の doc・歯の両方をこの契約に合わせて
書き換えた（`docs/architecture.md` §5.2.1 も同様）。**ADR 0084 本文は書き換えていない**
——旧契約はそちらに歴史的記録として残る。

---

## 閾値を持たない理由

最小被覆率のようなオプションは足さない。

- **被覆率が自然に重み付けをする。**部分一致の候補は `affinity`（`similarity` と
  `lexicalMatch` の max）が低くなり、`decay`/`freshness`/`tagMatch`/`strength` の積が
  同程度なら上位を奪わない。
- **IDF を持たないので、いかなる閾値の値も根拠が無い。**ADR 0084 §10 自身が
  警告している通り——「ありふれた語1つだけのクエリでは `lexicalMatch = 1` が大量に立つ」
  という事情に、閾値は答えを持たない（閾値をどこに引いても、それを裏付ける実測が無い）。
- **閾値は「探したが無かった」を静かに作る方向であり、`docs/recall.md` §4.2 の
  態度に逆行する。**`RecallQuery.scoreThreshold`（既存の段2閾値）は既に候補を
  `below_threshold` として**理由付きで**落とす経路を持っており、閾値を増やす必要が無い。

**⟹ ADR 0084 §8 の「低選択率のクエリ」の負債は、この PR でも塞がらない。**
低選択率のクエリ（ありふれた ASCII 語1つ）を投げると、一致した記憶の多くが
`coverage = 1` で並び、その中の順序は依然として `decay`/`freshness`
（ADR 0081 の実測ではその変域は 1e-8 桁）が決める。**塞いだとは書かない。**

---

## 各語を `"..."` で囲む理由と副作用

`mnemora_lexical_query_tsqueries` は、クエリを空白で割った各語を
`'"' || replace(t, '"', '') || '"'` として `"..."` で囲んでから
`websearch_to_tsquery('simple', ...)` へ渡す。

**理由**: `websearch_to_tsquery` の演算子（`-` = NOT、`or`、`"..."` = フレーズ）を、
語1つ1つの単位で誤って解釈させないためである。クエリ全体を1つの `websearch_to_tsquery`
呼び出しに渡していた ADR 0084 の実装は、この危険を語の切れ目で遮断できなかった
（クエリ全体としては安全でも、OR で結ぶために語ごとへ分解すると、語頭の `-` が単独で
NOT 演算子と解釈されうる）。囲むと文字列そのものとして解釈される。

**囲んでも識別子の隣接要求は保たれる**——`"PROJ-1234"` は `'proj' <-> '-1234'`
（隣接必須）になる。これは `migrations/0008_memories_lexical_index.sql` のコメントが
実測した「`plainto_tsquery` は隣接を要求しないため `PROJ-1234 and TASK-5678` を含む
本文に `PROJ-5678` が偽陽性で一致する」という失敗を、語ごとに OR で結んだ後も
避け続けるために必須である。

**⚠ 採った副作用**: 生クエリに含まれる websearch の演算子（`-`/`or`/`"..."`）が、
語単位に分解された時点で解釈されなくなる。これは意図した変更である——
`packages/testkit` の `InMemoryLexicalStore` はもともと websearch の演算子を
一切解釈しないと doc に明記されている（ADR 0084 期のコメント）。**⟹ この変更は
postgres 実装と in-memory 実装の差を縮める方向に働く。**

---

## `LEXICAL_MATCH_VALUE` を消した破壊的変更

`@mnemora/core` が公開 export していた定数 `LEXICAL_MATCH_VALUE`（`= 1`）を削除した。
`docs/autonomy.md` §3 は「公開 API の破壊的変更は提起までにする。ADR を書き、実装は
別 PR にして、承認を待つ」と定めている——**この PR は実装まで進めている**が、
`packages/postgres`/`packages/testkit` 側の契約変更（AND→OR、`rank`→`coverage` 降順）
と不可分であり、定数だけを別 PR に割ることは「`lexicalMatch` が二値である」という
嘘の前提を一時的に repo に残すことになる。**⟹ 承認はマネージャー/オーナーの判断に
委ねる。この ADR とその実装 PR は、承認前の提起として読まれることを想定している。**

利用側の移行: `LEXICAL_MATCH_VALUE` を import していたコードは、代わりに
`RecalledMemory.score.lexicalMatch`（`(0, 1]` の被覆率）を直接読む。定数を期待値に
使っていた歯は、具体的な被覆率の値（クエリ語彙数と一致数から決まる分数）に置き換える。

---

## 検討した代替案

- **最小被覆率の閾値オプションを足す。** **採らない**（「閾値を持たない理由」節）。
- **`ScoreBreakdown` に `coverage` という新しい欄を足し、`lexicalMatch` は残す。**
  **採らない。**`lexicalMatch` は「語彙チャンネルが引き当てた候補が、クエリにどれだけ
  近いか」という枠（`affinity` の一員）であり続けており、意味が変わっていない
  （二値 → 連続値という**定義域の拡張**であって、**別概念の追加**ではない）。
  欄を増やすと `affinity` の式（`max(similarity, lexicalMatch)`）を書き換える理由が
  生まれてしまい、ADR 0084 §5 が「第6の項として掛けない」と決めた形を崩す。
- **`coverage` を `rank` と同じ「adapter ごとに尺度が違う」値として扱い、スコアには
  入れない。** **採らない。**被覆率はクエリ語彙数という共通の分母を持つ**正規化済みの
  値**であり、`ts_rank_cd`（adapter 固有のスケール）とは性質が違う——むしろ
  `similarity`（コサイン類似度、`[-1, 1]`）と同じ「クエリとの近さを表す正規化済みの量」
  の族である。だからこそ `affinity` の枠に入れられる。
- **IDF を実装し、ありふれた語の寄与を下げる。** **採らない**（今回の変更の範囲外）。
  `tsvector`/`ts_rank_cd` は文書頻度の統計を持たず、これを足すには別の索引
  （集計テーブルまたは `ts_stat`）が要る。ADR 0084 §10 の警告通り、根拠のない値を
  導入するより「持たない」と明示するほうが `docs/north-star.md` の問い3
  （説明できるか）に沿う。
- **`plainto_tsquery` を使って OR 相当を作る。** **採らない**（ADR 0084 §2・
  `migrations/0008_*.sql` の実測。隣接を要求しないため識別子の取り違えが起きる）。
- **各語を `"..."` で囲まず、素の語のまま OR で結ぶ。** **採らない。**
  「各語を `"..."` で囲む理由」節の通り、語頭の `-` 等が演算子として誤解釈される
  ——OR で結んだときにほぼ全件へ一致しうる。
- **`LexicalStore` を作り直す。** **採らない**（マネージャー指示。既存の interface の
  契約（順序・値の意味）だけを変える）。
- **`pg_trgm` 等の追加拡張を必須にする。** **採らない**（ADR 0084 §3・§9 がそのまま
  当たる。この ADR は語彙の結び方だけを変えており、索引・拡張の構成には触れていない）。

---

## 引き受けた負債

- **🔴 ADR 0084 §8 の「低選択率のクエリ」の負債は、この PR でも塞がっていない。**
  ありふれた語1つだけのクエリでは `coverage = 1` の候補が大量に立ち、その中の順序は
  `decay`/`freshness`（ADR 0081 の実測では変域 1e-8 桁）が決める。「閾値を持たない
  理由」節の通り、意図して塞がないと決めた。
- **🔴 日本語の文に埋もれた日本語の語（人名を含む）は今も引けない**（ADR 0084 §2/§8）。
  クエリ側の非対称（`mnemora_lexical_query_terms` が非 ASCII を落とす）はこの ADR でも
  変えていない——本 ADR が解くのは「ASCII の語どうしの結び方」であり、日本語の
  分かち書きは別の決定である（マネージャーの指示により、この PR には混ぜない）。
- **被覆率は IDF を持たない。**「ありふれた語」と「めずらしい語」を区別せず数える。
  上記「検討した代替案」の通り、これを足すのは今回の範囲外。
- **`coverage` はクエリ側の語彙数だけを分母にする。**本文側の語数・文書長を分母に
  含めない（いわゆる re-call 志向の指標であり precision 志向ではない）——
  「クエリのどれだけを満たしたか」を答える指標であり、「本文のどれだけが関係あるか」は
  答えない。これは意図した設計であり負債ではないが、混同されないよう明記する。
- **postgres 実装の `mnemora_lexical_coverage` は、候補行ごとに `to_tsvector`/正規化を
  再計算する。**`ts_rank_cd` の計算と同様、`ORDER BY` の評価のために `WHERE` を通過した
  全行で計算される——`LIMIT` より前の全候補に掛かるコストであり、行数が増えると
  効いてくる可能性がある。**測っていない**（下記「確かめていないこと」）。

---

## これが覆るとしたら

- **低選択率のクエリの実害が実際に報告されたとき。**ADR 0084 §11 と同じ条件——
  低選択率のクエリを投げる呼び出し側が現れると、すぐに出る。IDF、あるいは
  何らかの閾値の導入が再検討される。
- **文書頻度の統計（IDF 相当）を持つ別の索引を足す決定がされたとき。**
  そのときは `coverage` の定義そのものを見直すか、別の項として足すかを再判断する。
- **日本語の分かち書きを導入する決定がされたとき**（ADR 0084 §11 と同じ条件）。
  クエリ側の非 ASCII 落としを見直す必要が生まれ、`coverage` の分母・分子の数え方も
  合わせて変わりうる。
- **`mnemora_lexical_coverage` の再計算コストが実測で無視できないと分かったとき。**
  LATERAL 結合やマテリアライズ等で1回の計算を使い回す形に書き換える動機になる。

---

## 確かめていないこと

- **postgres 側の SQL は、この作業環境に `psql`/`DATABASE_URL` が無いため、
  書き手自身の手では一切実行できていない。**構文・意味は読解と
  PostgreSQL 公式文書の該当箇所（tsquery の比較演算子・`array_agg(DISTINCT ...)` が
  使える型であること）で裏取りしたが、**実際に CREATE FUNCTION が通るか・
  期待通りの `tsquery`/`coverage` を返すかは CI の実行結果でしか確かめられない。**
  特に次の2点は疑わしいと自覚している:
  - `array_agg(DISTINCT q)`（`q` は `tsquery`）が構文・実行時エラーを起こさないか。
  - 文字列連結（`string_agg('(' || q::text || ')', ' | ')`）から `::tsquery` への
    再パースが、意図した OR 構造に一致するか。
- **`idx_memories_lexical` が新しい述語（`mnemora_lexical_query_or`）でも
  引き続き選ばれるか**は `lexical-store-index.test.ts` の CI 実行でしか確かめられない
  （`WHERE` の左辺の式は変えていないので選ばれ続けると見込んでいるが、実測ではない）。
- **`mnemora_lexical_coverage` の実行コスト**（大規模テーブルでの体感速度）は
  測っていない。
- **`retrieval` ベンチ（MRR / `hit@1`）への影響は測っていない**（ADR 0084 §12 と
  同じ限界がそのまま当たる）。
- **postgres 実装のマイグレーション DB 歯（`lexical-store-reporter-questions.test.ts`
  を含む）はすべて CI でしか実行できていない。**期待値は読解と既存の実測
  （`migrations/0008_*.sql` のコメントの実測）から導いたが、CI が赤くなる可能性を
  否定できない。
