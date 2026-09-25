# ADR 0328: 連想枠の既定 on を10万行級で測る — 62件/1万行/10万行の実測記録（Issue #337、判定はしない）

- **状態**: 提案 (2026-09)
- **日付**: 2026-09-25

**⚠ 出所の凡例**（ADR 0308・0327 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分で読んで確かめた。
- **【実測】** — この書き手が自分の手で `psql`/`vitest`/`node`/本ベンチを走らせて確かめた。
- **【受】** — Issue #337・#377・#363・#671 のコメント、マネージャーの指示からの引用で、
  この書き手が再導出していない箇所（明記する）。

> **クローン（miku）の依頼で、委譲を受けたセッションが書いた。**
> **投稿者名は関係者の実名を意味しない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

⛔ **この ADR は「連想枠の既定を on にすべきか」を判定しない。** [Issue #337](https://github.com/takecchi/mnemora/issues/337)
のオーナー決定（2026-09-16、逐語「10万行級で測ってから既定 on をやるか判断してほしい」）
に対して、**判断するための材料だけを残す。** 連想枠の既定 off・`DEFAULT_ASSOCIATION_ANCHOR_COUNT`
の値は、この ADR では動かさない。

---

## 0. 依頼の要旨

[Issue #337](https://github.com/takecchi/mnemora/issues/337) 本文（オーナー決定、2026-09-16、逐語）:

> 10万行級で測ってから既定 on をやるか判断してほしいです。

同 Issue 本文が引く、小規模（62件、haystack）での既存の実測:

| arm | 連想でしか届かない gold の到達 | `memoryChars` |
|---|---|---|
| off | 0/12 | 基準 |
| on `maxCount=3` | 9/12 | +1.44% |
| on `maxCount=5` | 10/12 | +2.22% |
| on `maxCount=10` | 12/12 | +4.32% |

[Issue #377](https://github.com/takecchi/mnemora/issues/377) の最新コメント（2026-09-25T02:47:11Z、
`mgr-c4687378` の委譲セッションが書いたもの）が、1万行規模の実測を報告している——詳細は
§3・§7 で引く。

マネージャーからの追加方針（本セッションへの指示、逐語の要旨）:

> 段1（62件+1万行）→段2（10万行、配置(A)/(B)、独立 ingest 間の揺れの反復1回）まで測り、
> 到達・費用・EXPLAIN・ビット同一性を記録する。既定 on にすべきかの判定は書かない。

---

## 1. 測ったもの・測り方【現物・実測】

- **ベンチ**: `examples/chat/src/bench/association-scale-bench.ts`（配置 (A)/(B)/(R)）・
  `examples/chat/src/bench/association-scale-investigate.ts`（使い捨て診断、§4）。
  どちらも CI には載せていない手動ベンチ——**#377 の道具（`association-anchor-pool
  -scale-bench.ts`、閉じた PR #723 の枝）と同じ規律**（測定であり判定ではない、
  exit code は結果で変えない）。
- **器**: PostgreSQL 17.11 + pgvector 0.8.0（`initdb` で自前構築したクラスタ、
  `\dx`/`select version()` で確認）。`docker-compose.yml` の `pgvector/pgvector:pg17`
  と同じ主要バージョンだが、**ビルド・設定まで同一かは確認していない**（§9）。
- **embedding**: `local` / `ruri-v3-30m/sym` / 256次元（`@mnemora/local-embedding`、実 ONNX
  推論。ADR 0085）。**LLM は `deterministic` 固定**——この器は `OPENAI_API_KEY` が
  他用途で既に設定されており、明示しないと `observe()` の抽出が黙って実 OpenAI API を
  叩く落とし穴を実際に踏んだ（1呼び出し ~1.5〜2秒、実課金）。ベンチ側に
  `MNEMORA_LLM !== "deterministic"` なら起動時に例外で落とす歯を追加済み。
- **probe**: `ASSOCIATION_PROBES`（12件、`examples/chat/src/association-probe-set.ts`）。
  62件点は `ASSOCIATION_HAYSTACK`（手書き60文+2文）そのもの——CI の `association-probes`
  ジョブと同じ構成関数を使う、陽性対照。
- **filler**（62件超）: `buildDistinctFiller`——構成上ゼロ重複のログ風合成テキスト
  （`log entry ${i}: node-${i % 997} reported status code ${i % 53}...`）。10万件まで
  重複ゼロを実際に生成して確認済み（DB 接続なしのオフライン検査）。
- **埋め込みキャッシュ**: テキスト→ベクトルをファイルにキャッシュし、全 arm・全配置・
  全 DB で共有する（`embedding-cache.ts`）。詳細は §6。
- **arm**: `off` / `on-3` / `on-5` / `on-10`（`RecallAssociationQuery.maxCount` のみ振り、
  `anchorCount`・`limit` は `packages/core` の既定のまま）。
- **配置**:
  - **(A)** — scale ごとに arm の数だけ `TRUNCATE` → 独立 ingest → 測定。
  - **(B)** — `TRUNCATE` は1回だけ、4 arm を4テナントとして同じ物理テーブルへ ingest
    （計40万行、[#363](https://github.com/takecchi/mnemora/issues/363)/[#671](https://github.com/takecchi/mnemora/issues/671) の確認用）。
  - **(R)** — `TRUNCATE` は1回だけ、単一 ingest に対して4 arm 全部を測る（`maxCount` の
    純粋比較。段2で追加）。

---

## 2. 表: 到達・memoryChars・anchor位置（(a) raw / (c) withinLimit相当）・latency【実測】

**(a) raw** = probe自身の anchor が段1の生 ANN kPrime（既定40）件に入っていたか。
**(c) withinLimit相当** = 実際に返った `recall()` 結果（`retrievedVia: "ann"/"lexical"`）に
anchor が載っていたか。この2つは全測定で一致した（`recall-runtime.ts` の実装が
`(a) ⊇ (c)` を保証する構造そのものなので当然——`anchorCount` 既定3が `withinLimit`
（`limit` 既定10）より小さいここでは差が出ない）。

### 62件（陽性対照、配置(A)。ef 40/120 で値は同一）

| arm | 到達 | memoryChars(Δ%) | anchor位置(a)/(c) | latency中央値ms |
|---|---|---|---|---|
| off | 0/12 | 52037 (基準) | 12/12 | 8.5/7.6 |
| on-3 | 11/12 | 52814 (+1.49%) | 12/12 | 15.3/13.0 |
| on-5 | 12/12 | 53223 (+2.28%) | 12/12 | 14.4/13.4 |
| on-10 | 12/12 | 54340 (+4.43%) | 12/12 | 14.2/13.2 |

### 1万行（配置(A)、arm ごとに独立 ingest。ef=40/120）

| arm | 到達 | memoryChars(Δ%) | anchor位置(a)/(c) | latency中央値ms |
|---|---|---|---|---|
| off | 0/12 / 0/12 | 55548(基準) / 55321(基準) | 0/12 / 1/12 | 18.6 / 20.9 |
| on-3 | 4/12 / 4/12 | 54445(-1.99%) / 54445(-1.58%) | 9/12 / 9/12 | 26.8 / 28.4 |
| on-5 | 0/12 / 0/12 | 57651(+3.79%) / 57424(+3.80%) | 1/12 / 2/12 | 29.5 / 31.7 |
| on-10 | 0/12 / 0/12 | 60468(+8.86%) / 60241(+8.89%) | 0/12 / 1/12 | 28.4 / 31.1 |

### 10万行 配置(A)（arm ごとに独立 ingest。ef=40/120で同一値）

| arm | 到達 | memoryChars(Δ%) | anchor位置(a)/(c) | latency中央値ms |
|---|---|---|---|---|
| off | 0/12 | 55152 (基準) | 2/12 | 54.4/55.7 |
| on-3 | 0/12 | 56760 (+2.92%) | 1/12 | 70.3/69.8 |
| on-5 | 0/12 | 58044 (+5.24%) | 0/12 | 69.9/68.4 |
| on-10 | 0/12 | 60504 (+9.70%) | 0/12 | 71.7/70.5 |

### 10万行 配置(R)（反復、単一 ingest に maxCount だけ振る。ef=40/120）

| arm | 到達 | memoryChars(Δ%) | anchor位置(a)/(c) | latency中央値ms |
|---|---|---|---|---|
| off | 0/12 | 53059(基準) / 53059(基準) | 11/12 | 64.6/66.0 |
| on-3 | 5/12 | 53871(+1.53%) / 53863(+1.52%) | 11/12 | 73.8/79.8 |
| on-5 | 6/12 | 54419(+2.56%) / 54426(+2.58%) | 11/12 | 75.9/81.9 |
| on-10 | 6/12 | 56026(+5.59%) / 56030(+5.60%) | 11/12 | 76.8/88.4 |

**(R) は単一 ingest なので、(a)/(c) が4 arm で完全に一致する**（11/12、ef 40/120 とも）
——理論（`anchorCount` は `maxCount` に依存しない）どおり。

### 10万行×4テナント 配置(B)（同じ物理テーブル、計40万行。ef=40/120）

| arm | 到達 | memoryChars(Δ%) | anchor位置(a)/(c) | latency中央値ms |
|---|---|---|---|---|
| off | 0/12 | 55584(基準) / 55584(基準) | 0/12 | 59.0/58.4 |
| on-3 | 6/12 / 8/12 | 54383(-2.16%) / 53875(-3.07%) | 7/12 / 9/12 | 89.3/92.4 |
| on-5 | 6/12 / 8/12 | 54915(-1.20%) / 54365(-2.19%) | 7/12 / 9/12 | 100.7/106.7 |
| on-10 | 6/12 / 8/12 | 56305(+1.30%) / 55641(+0.10%) | 7/12 / 9/12 | 109.5/115.9 |

**全配置・全arm・全efでビット同一性ハッシュを確認した**（§6）——`off`/`on-3`/`on-5`/`on-10`
の埋め込み（DB へ実際に入った値、pgvector float4 丸め後）は、同じ配置内で常に一致した。

---

## 3. #377 の拘束との関係 — probe 自身の anchor が段1の ANN 窓（kPrime=40）から落ちる【実測・受】

【受、#377 2026-09-25T02:47:11Z コメントより逐語の要旨】:

> 実測: 拘束は `limit` の天井ではなく、段1 の ANN 窓（kPrime）から anchor が落ちることでした。
> …「anchor の位置」（probe 自身の anchor が生 ANN の kPrime 件・`passed`・`withinLimit` に
> 入っていた probe の数）はこの3つが全組で一致した。規模が伸びたとき（3000・10000）に
> 崩れていたのは、段1 の ANN 窓（kPrime = limit × 4 = 40）から anchor が落ちることだった。

【実測、本 ADR】この拘束は10万行でも同じ形で現れる——§2 の表の「anchor位置(a)/(c)」列が
それである。ただし **値は配置・arm（＝どの独立 ingest か）によって大きく揺れる**
（0/12〜12/12。§5 で詳しく扱う）。10万行 配置(A) の `off` では 2/12（ef 40/120 とも）、
配置(R) の `off` では 11/12——**同じ「10万行」でも一桁違う。**

---

## 4. 届いた gold は probe 自身の anchor ではなく filler 経由だった【実測】

`association-scale-investigate.ts`（別 DB `mnemora_investigate`、1万行、単一 ingest、
`TRUNCATE` を挟まず `maxCount` だけ振る）で、per-probe の `associationFrame`
（`retrievedVia: "association"` で実際に返った候補を役割分類したもの）と
`omitted`（`kind: "over_limit", stage: "association"`）を直接見た。分かったこと:

1. **この特定の ingest では、probe自身の anchor は一度も実際のアンカー（`getVectors`
   に渡った3件）に選ばれなかった。** 選ばれた3件は全12 probe で毎回すべて
   `scale-assoc-filler-*`（合成 filler）だった。
2. **連想枠に実際に着席した候補（全12 probe × maxCount=3/5/10）は、役割分類の結果
   100% が `filler`。** 自身の gold・anchor・distractor、他 probe の gold・anchor・
   distractor は1件も入っていなかった。
3. この ingest では goldReturned は全 arm 0/12（つまりこの特定の回では連想は1件も
   gold に届かなかった）。

**⟹「連想でしか届かない gold の到達」という指標が意味すること・意味しないこと**:

- **意味すること**: この指標が正の値（例: §2 の (A) 1万行 on-3 が 4/12）を示すとき、
  それは「probe が設計した `query≈anchor→anchor≈gold` の経路」を辿った結果とは
  **限らない**。実際、§2 の複数の実測（(A) 10万行の on-3 で aRaw=1/12、(R) の全 arm で
  aRaw=11/12 だが gold到達は5〜6/12）を見る限り、**probe 自身の anchor が生き残って
  いなくても、他の（fillerの）anchor経由で偶然 gold の近傍に届くことがある**——
  これは probe が意図した三角形設計の効果ではなく、**corpus 全体の中で filler 同士が
  作る偶発的な近さ**（`ASSOCIATION_HAYSTACK` の docstring が指摘する、テンプレ生成
  filler の密なクラスタ化と同じ構造）が理由である可能性が高い。**切り分けていない
  ——確かめていない。**
- **意味しないこと**: 到達数が高いことは「連想枠が設計どおりに機能している」ことの
  証明には**ならない**。§4の investigate 実測では、gold に届いた probe があっても、
  その経路が「probe自身のanchor→gold」ではなく別の filler 経由だった可能性がある
  （investigate では実際に届いた0件だったため、この点そのものは実測できていない
  ——次に届いた回で辿り直す必要がある。**確かめていないこと**として明記する）。

---

## 5. 独立 ingest 間の揺れ — 原因は切り分けていない【実測】

### 5.1 同じ「1万行 on-3」が、独立 ingest の有無で 4/12 と 0/12 に分かれた

- 配置(A)（arm ごとに独立 `TRUNCATE`+ingest）: on-3 = **4/12**（aRaw=9/12）。
- `association-scale-investigate.ts`（別DB、単一 ingest、maxCount だけ振る）:
  on-3/on-5/on-10 とも **0/12**（aRaw=0/12、全 probe で filler が anchor になった）。

### 5.2 同じ「10万行」でも、配置と反復回で到達が 0/12・5〜6/12・6〜8/12 に分かれた

| 配置 | ingest の独立性 | on-3到達 | on-5到達 | on-10到達 |
|---|---|---|---|---|
| (A) | arm ごとに独立(4回) | 0/12 | 0/12 | 0/12 |
| (R) | 単一(1回、maxCountのみ振る) | 5/12 | 6/12 | 6/12 |
| (B) | テナントごとに独立(4回、同じ表) | 6/12(ef40)/8/12(ef120) | 同左 | 同左 |

### 5.3 per-arm の anchor位置(a)も、独立 ingest ごとに大きく揺れる

同一の corpus・同一の埋め込みキャッシュ（§6でビット同一性を確認済み）にもかかわらず、
「probe自身の anchor が生ANNのkPrime=40件に入るか」(a) は、**独立 ingest ごとに
0〜12/12まで揺れた**:

- 1万行(A): off=0/12(ef40)〜1/12(ef120)、on-3=**9/12**、on-5=1〜2/12、on-10=0〜1/12
  ——同じ corpus の4回の独立 ingest で 0→9→1→0 と揺れる。
- 10万行(A): off=2/12、on-3=1/12、on-5=0/12、on-10=0/12。
- 10万行(B): off=0/12、on-3/5/10（それぞれ独立 ingest）=7/12(ef40)/9/12(ef120)。
- 10万行(R)（単一 ingest）: 全 arm で **11/12（完全一致）**——単一 ingest なら
  理論どおり arm 間で揺れない。

**⟹ 揺れているのは「独立に ingest したかどうか」に強く相関する。** 単一 ingest
（R）では arm 間で完璧に一致し、独立 ingest（A・B の各テナント）では大きく揺れる。

### 5.4 考えられる機構（切り分けていない）

1. **pgvector `PostgresVectorStore.search()` の同点 tie-break**（距離 → `recorded_at`
   DESC → `memory_id` ASC、`vector-store.ts` のクラス doc）。`memory_id` は
   `gen_random_uuid()` で ingest のたびにランダムに振られ、`recorded_at` は
   wall-clock で ingest のたびに違う。`buildDistinctFiller` のテンプレ生成 filler
   （10万行なら99.94%が filler）はコサイン類似度が近接しやすいと想定される
   （`ASSOCIATION_HAYSTACK` の docstring が、同種のテンプレ生成 haystack について
   実測で記録している近接傾向と同じ懸念）——**どの filler が上位に来るかが
   tie-break 次第で入れ替わりうる。**
2. **pgvector の HNSW 索引構築のレベル割り当てに乱数が使われる**——同じベクトル
   集合でも、挿入順・乱数の引きが変われば近似最近傍探索の結果自体が変わりうる。
3. **どちらが主要因かは切り分けていない。** 両方が同時に効きうる。real-fixture
   （合成 filler ではなく実運用に近い分布のテキスト）で再現するかも確かめていない。

---

## 6. HNSW・ANALYZE・relaxed_order・ビット同一性【実測・現物】

### 6.1 ANALYZE の必要性 — #337 の09-16コメントとの一致

【受、#337 の09-16コメント要旨】ANALYZE しないと10万行でも HNSW が選ばれない。

【実測】本 ADR の全測定は ingest 直後に `ANALYZE` を実行している
（`ingestCorpus()` の最終行）。**EXPLAIN (ANALYZE) で実際に `Index Scan using
idx_memory_embeddings_hnsw_...` を確認した**——62件では出ず（`Sort` ノード）、
1万行・10万行では出る（§6.2）。ANALYZE を外した対照実験はしていない
（#337 の09-16コメントの主張を上書き検証してはいない。それを前提として使った）。

### 6.2 EXPLAIN 実測の要点

- **62件**: 段1（query視点）・段3.5（anchor視点）とも `Sort` ノード。HNSW 未使用
  （テーブルが小さくプランナが選ばない——想定どおり）。
- **1万行・10万行**: 両方とも `Index Scan using idx_memory_embeddings_hnsw_
  local_ruri_v3_30m_sym_256`。実行時間は1〜6ms程度（規模・ef_search で変動）。
- **配置(B)（複数テナントが同じ表を共有）で `Rows Removed by Filter` を確認した**
  ——on-3で12〜37行、on-5で51〜76行、on-10で90〜115行（後発 arm ほど増える。
  ingest の順で他テナントの行が先に積まれていくため）。**それでも実行時間は
  1〜4ms、`LIMIT 40` は毎回満たされていた。**

### 6.3 relaxed_order（#363/#671 の申し送りへの回答）

【現物】`packages/postgres/src/vector-store.ts` の `PostgresVectorStore.search()`
は、[ADR 0284](./0284-hnsw-iterative-scan-relaxed-order-adopted.md) により
`SET LOCAL hnsw.iterative_scan = relaxed_order` を**無条件に**（テナント数や規模に
関わらず）トランザクション内で発行する（**採用済み**、状態: 採用 (2026-09)）。
本 ADR が実測した §6.2 の `Rows Removed by Filter`（配置(B)）は、**relaxed_order が
他テナントの行を飛び越えて自テナントの候補で `LIMIT` を埋めている**、という
ADR 0284 の設計どおりの挙動の実測である。

⚠ **本 ADR の EXPLAIN 診断コード自体に、当初 relaxed_order が抜けていた不備が
あった**——`captureExplain()` が素の `pool.query()` で EXPLAIN を撃っており、
ADR 0284 の `SET LOCAL`（トランザクション単位でしか効かない）を経由していなかった。
気づいた時点で `pool.connect()` から1接続を握り `BEGIN`/`SET LOCAL`/`EXPLAIN`/
`COMMIT` を揃える修正を入れた（`association-scale-bench.ts`）。

**⟹ ただし、実際の到達・memoryChars・latency の数値は、この不備の影響を受けていない。**
これらは全て `runtime.recall()`（本物の `PostgresVectorStore.search()` を経由する）
から得ており、`captureExplain()` は**診断専用の別クエリ**（recall() の結果には
一切影響しない）だからである——【現物】`association-scale-bench.ts` の
`measureProbeArm()`（実際の recall 呼び出し）と `captureExplain()`（診断）が
コード上完全に分離していることを確認した。

**§2 の「10万行 配置(A)」の EXPLAIN スナップショットだけが、この修正前のコード
（relaxed_order 無効）で撮られている。** ただし配置(A)は単一テナントであり、
`Rows Removed by Filter` が本来ゼロになる状況（フィルタで弾かれる他テナント行が
存在しない）——relaxed_order は「他テナント行に埋め尽くされたとき、さらに探索する」
ためのものなので、単一テナントでは介入する場面自体が無いと考えられる。**この
推測は実測で検算していない**（修正後のコードで配置(A)の EXPLAIN を撮り直せば
確認できるが、本 ADR ではやっていない）。配置(B)・配置(R)の EXPLAIN は修正後の
コードで撮っている。

### 6.4 ビット同一性

`hashArmEmbeddings()`——テナント内の全埋め込みを externalId ソート順に並べ、
pgvector のテキスト表現を Float64 として正規化して sha256。**配置(A)・(B)・(R) の
全ての scale で、arm 間のハッシュが完全に一致した**（§2表の各配置ブロック）。
62件と10万行（配置(A)/(B)/(R)すべて）で、**同じ埋め込みキャッシュを使った異なる
DB・異なる ingest 間でもハッシュ値自体が一致した**（10万行は `a3151f95...`、
配置(A)/(B)/(R) とも同一値）——これはキャッシュが空間ごとに決定的であることの
追加の確認である。

---

## 7. 基準線との照合【実測・受】

### 7.1 1万行は #377 と一致した

【受】#377 2026-09-25コメント: 「10000 | 40/120 | anchor の位置 0/12 | 既定 0/12」
（`anchorCount=40` の設定での実測）。

【実測】本 ADR の1万行 配置(A) は、`off` の anchor位置(a) が ef=40 で **0/12**
（一致）、ef=120 で 1/12（1件差、誤差範囲と見る）。「既定」に相当する `on-10`
（`maxCount=10`、`anchorCount` 既定3）の到達も **0/12**（両 ef、一致）。

### 7.2 62件の on-3/on-5 は #337 本文と一致しなかった——未解明

【受】#337 本文: on `maxCount=3` = 9/12、on `maxCount=5` = 10/12。

【実測】本 ADR: on-3 = **11/12**、on-5 = **12/12**。memoryChars の増分（+1.49%/
+2.28%/+4.43%）は #337 本文の値（+1.44%/+2.22%/+4.32%）とほぼ一致した
（0.05〜0.11ポイント差、丸め・corpus の微差の範囲と見られる）ので、**測定器自体は
同じものを見ている可能性が高い**が、**到達件数だけが food 12件中2件ずつ多い。**
原因は調べていない——コーディネーターの判断により「原因を追わずに再測定値として
扱い、差分として記録する」。**考えられる候補**（検証していない）: #337 本文の元測定が
`anchorCount` も一緒に振っていた可能性、corpus のバージョン差（main は ADR 0168
以降も変わっている——例: ADR 0246）、独立 ingest の tie-break/HNSW 非決定性
（§5と同じ機構）。

---

## 8. 費用【実測】

### 8.1 memoryChars

- **(A)・(R)**: `maxCount` が増えるほど単調に増加する（62件: +1.49/+2.28/+4.43%、
  10万行(A): +2.92/+5.24/+9.70%、10万行(R): +1.53/+2.56/+5.59%）——**おおむね
  比例**（maxCount=10 の増分が maxCount=3 の3倍強という関係が複数の測定点で
  近い形を保っている）。
- **(B)（例外）**: `off` 比で on-3/on-5 が**マイナス**になった（-2.16%/-1.20%(ef40)、
  -3.07%/-2.19%(ef120)）。on-10 でようやく正（+1.30%/+0.10%）。**「maxCount に
  ほぼ比例」は(A)/(R)のような単純比較設計でのみ成り立ち、(B)（複数テナント同居・
  独立ingest）では崩れる。** 原因は§5と同じ独立ingestの非決定性と推測されるが
  切り分けていない。

### 8.2 段3.5のレイテンシ

10万行 配置(A)での `off` 比の追加レイテンシ（`recall()` 全体の壁時計、中央値5回反復）:
on-3 = **+15.4/+14.2ms**（ef40/120）、on-5 = +15.1/+13.2ms、on-10 = +17.7/+14.8ms
——**おおよそ +13〜18ms** の範囲。配置(R)・(B)ではこれより大きい（(B)は
+30〜56ms——他テナント同居による `Rows Removed by Filter` 分のオーバーヘッドが
乗っている可能性がある。切り分けていない）。VectorStore の spy が計測した
「段3.5由来のDB呼び出し」だけの合計（段3.5**だけ**の時間の近似・下限）は
10万行(A)で約10〜11ms——全体増分の大半が段3.5のDB呼び出しで説明できる規模感。

---

## 9. 測れなかったこと・確かめていないこと【現物・実測】

- ⛔ **(b) passed（`limit` の外・kPrime の内、閾値を通った全候補）は測っていない。**
  main に `anchorPool`（ADR 0308 提案、閉じた PR #723 のみ）が無いため、この集合を
  公開 API から正確に取り出す経路が無い。(a) raw と (c) withinLimit相当の2段だけを
  測った。
- ⛔ **反復は1回だけ**（配置(R)）。独立 ingest 間の揺れ（§5）が本当に「揺れ」なのか
  （分布の広がりがどの程度か）は、複数回の反復が無いと統計的に言えない。
- ⛔ **filler は合成**（`buildDistinctFiller`、構成上ゼロ重複のログ風テンプレート）。
  実運用の文の分布とは違う——§5.4の tie-break/HNSW非決定性の仮説が実運用データでも
  同じように起きるかは確かめていない。
- ⛔ **[Issue #402](https://github.com/takecchi/mnemora/issues/402) の `rankFetchCount`
  の窓**（`max(maxCount, round(maxCount×overFetchFactor))`）自体の妥当性は測って
  いない——本 ADR は既定の overFetchFactor(4) を固定したまま `maxCount` だけを
  振っている。
- ⛔ **CI 外の手動ベンチである。** `.github/workflows/ci.yml` には載っていない
  ——再現するには本 ADR の「実行コマンド」節（§11）を手で叩く必要がある。
- ⛔ **`docker-compose.yml` の `pgvector/pgvector:pg17` と同一のビルド・設定かは
  確認していない。** 主要バージョン（PostgreSQL 17.11 + pgvector 0.8.0）は一致した
  （`select version()`/`\dx`）が、コンパイルオプション・GUC 既定値までは比較して
  いない。
- ⛔ **(A) 配置の10万行の EXPLAIN は、relaxed_order を修正する前のコードで撮った**
  （§6.3）。実際の到達・memoryChars・latency には影響しない（recall() 本体は
  常に本物の `PostgresVectorStore.search()` を経由するため）ことは現物で確認した
  が、**EXPLAIN のプラン自体を修正後のコードで撮り直してはいない。**
- ⛔ **§4（investigate）で「gold に届いた経路が filler 経由だったこと」は、
  到達が0件だった1万行の回でしか確認していない。** 到達がある回（例: (A) の
  on-3=4/12、(R) の on-3=5/12）で、実際にどの経路（own-anchor か filler か）から
  gold に届いたかは、本 ADR のための追加実測をしていない
  （`association-scale-bench.ts` は現状この役割分類を出力しない設計——
  `association-scale-investigate.ts` にしかない機能）。

---

## 10. 出典の注意 — #377 が引く「ADR 0308 §7」は main に無い【現物】

【現物】#377 の2026-09-25コメントが引く「[ADR 0308 §7](https://github.com/takecchi/mnemora/blob/2675576edb966cd9a1b05484ee12b8760fb3ab43/docs/decisions/0308-association-anchor-pool.md)」
は、**閉じた PR #723 の枝（commit `2675576edb966cd9a1b05484ee12b8760fb3ab43`）にしか
存在しない。** `main` の `docs/decisions/0308-*.md` は**別件**（`ts_rank_cd` の
normalization に文書長のビットを足す、語彙チャンネルの話——Issue #394 案2、状態:
採用）であり、連想枠・`anchorPool` とは無関係である。同様に「
[association-anchor-pool-scale-bench.ts](https://github.com/takecchi/mnemora/blob/2675576edb966cd9a1b05484ee12b8760fb3ab43/examples/chat/src/bench/association-anchor-pool-scale-bench.ts)」
も同じ枝にしか存在せず、`main` には無い。**この ADR（0328）が引く数字は、全て
`main` 上で実際に動く `association-scale-bench.ts`/`association-scale-investigate.ts`
で本 ADR の書き手が実測したものであり、閉じた PR の枝には依存していない。**

---

## 11. 所要時間・実行コマンド【実測】

| 測定 | precompute | ingest(1arm) | drain(1arm) | 総所要 |
|---|---|---|---|---|
| 62件(A) | <1s | <1s | <1s | 数秒 |
| 1万行(A) | 31.5s | 平均78s | 平均66s | 実測なし(段1報告参照) |
| 10万行(A) | 310.7s(5.2分) | 平均760s(12.7分) | 平均726s(12.1分) | 約108分 |
| 10万行(B・4テナント) | ほぼ0(キャッシュ温存) | 平均770s | 平均719s | 99分 |
| 10万行(R・単一ingest) | ほぼ0(キャッシュ温存) | 約800s(推定) | 約700s(推定) | 実測: 開始から完了まで約35分 |

```bash
export PATH=/usr/lib/postgresql/17/bin:$PATH
# DB は用途ごとに createdb 済み: mnemora_test(A/B) / mnemora_rep(R) / mnemora_modeb(B)

# 配置(A)
DATABASE_URL=postgresql://worker@127.0.0.1:55491/mnemora_test \
MNEMORA_EMBEDDING=local MNEMORA_LLM=deterministic \
MNEMORA_ASSOC_SCALE_SCALES=62,10000 MNEMORA_ASSOC_SCALE_EF_SEARCH=40,120 \
MNEMORA_ASSOC_SCALE_EMBED_CACHE_DIR=/tmp/mgr-fac332f3/embcache \
pnpm --filter @mnemora/example-chat run association-scale-bench

# 配置(A) 10万行
DATABASE_URL=postgresql://worker@127.0.0.1:55491/mnemora_test \
MNEMORA_EMBEDDING=local MNEMORA_LLM=deterministic \
MNEMORA_ASSOC_SCALE_SCALES=100000 MNEMORA_ASSOC_SCALE_EF_SEARCH=40,120 \
MNEMORA_ASSOC_SCALE_EMBED_CACHE_DIR=/tmp/mgr-fac332f3/embcache \
pnpm --filter @mnemora/example-chat run association-scale-bench

# 配置(B) 10万行×4テナント
DATABASE_URL=postgresql://worker@127.0.0.1:55491/mnemora_modeb \
MNEMORA_EMBEDDING=local MNEMORA_LLM=deterministic \
MNEMORA_ASSOC_SCALE_SCALES=100000 MNEMORA_ASSOC_SCALE_EF_SEARCH=40,120 \
MNEMORA_ASSOC_SCALE_EMBED_CACHE_DIR=/tmp/mgr-fac332f3/embcache \
MNEMORA_ASSOC_SCALE_MODE=B \
pnpm --filter @mnemora/example-chat run association-scale-bench

# 配置(R) 反復・10万行
DATABASE_URL=postgresql://worker@127.0.0.1:55491/mnemora_rep \
MNEMORA_EMBEDDING=local MNEMORA_LLM=deterministic \
MNEMORA_ASSOC_SCALE_SCALES=100000 MNEMORA_ASSOC_SCALE_EF_SEARCH=40,120 \
MNEMORA_ASSOC_SCALE_EMBED_CACHE_DIR=/tmp/mgr-fac332f3/embcache \
MNEMORA_ASSOC_SCALE_MODE=R \
pnpm --filter @mnemora/example-chat run association-scale-bench

# 切り分け診断（1万行、単一ingest、別DB）
DATABASE_URL=postgresql://worker@127.0.0.1:55491/mnemora_investigate \
MNEMORA_EMBEDDING=local MNEMORA_LLM=deterministic \
MNEMORA_ASSOC_INVESTIGATE_SCALE=10000 \
MNEMORA_ASSOC_SCALE_EMBED_CACHE_DIR=/tmp/mgr-fac332f3/embcache \
pnpm --filter @mnemora/example-chat run association-scale-investigate
```

---

## 12. これが覆るとしたら

1. **反復を複数回に増やし、§5の「揺れ」が統計的にどの程度の広がりを持つかが
   分かったとき**——現状は1サンプルの追加（(R)）に留まる。
2. **§5.4の機構（tie-break/HNSW非決定性）のどちらが主要因かが切り分けられたとき**
   ——それぞれ別の対処（tie-break を強化する・HNSW構築パラメータを固定する等）が
   考えられるが、本 ADR は着手していない。
3. **(b) passed の測定手段が見つかったとき**（`anchorPool` 相当の機能が main に
   入る、あるいは `defaultScoringStrategy`/`decayScoringExtras` 相当を外部から
   完全再現する手段が用意されたとき）。
4. **real-fixture（実運用に近い文の分布）での再測定が行われたとき**——本 ADR の
   filler は全て合成であり、§5.4の仮説の一般性を確認していない。
5. **§7.2（62件の on-3/on-5 が #337 本文と一致しない件）の原因が判明したとき。**

---

## 13. 確かめたこと・確かめていないこと（総括）

**確かめた【実測】**

- 62件・1万行・10万行（配置(A)/(B)/(R)）の到達・memoryChars・anchor位置・latency・
  段3.5DBms・EXPLAIN・ビット同一性ハッシュ（§2・§6）。
- 1万行を別DBで単一ingestに切り分け、gold到達経路が filler 経由だったこと（§4）。
- relaxed_order（ADR 0284）が配置(B)で他テナント混入を飛び越えて動作すること、
  ただし配置(A)の10万行EXPLAINだけは修正前のコードで撮ったこと（§6.3）。
- 独立ingestごとに anchor位置(a)が0〜12/12まで揺れること（§5.3）。
- 62件・1万行の一部の値が #377/#337 と一致・不一致すること（§7）。
- 10万行のfillerが重複ゼロで生成できること（オフライン検査）。

**確かめていない**

- §9に列挙した全項目（(b) passed・反復の統計的十分性・real-fixtureでの再現・
  CI外であること・docker版pgvectorとの完全一致・(A)10万行EXPLAINの撮り直し・
  到達がある回でのgold到達経路の役割分類）。
- §7.2の原因。
- §5.4のどちらの機構が主要因か。

---

## 参照

- [Issue #337](https://github.com/takecchi/mnemora/issues/337) — 本 ADR が答えようとしている依頼（オーナー決定 2026-09-16）
- [Issue #377](https://github.com/takecchi/mnemora/issues/377) — 1万行規模の先行実測（本 ADR §3・§7.1 が引く）
- [Issue #363](https://github.com/takecchi/mnemora/issues/363) / [Issue #671](https://github.com/takecchi/mnemora/issues/671) — 複数テナント同居時の HNSW 故障モードと `relaxed_order`（本 ADR §6.3・配置(B) の動機）
- [Issue #402](https://github.com/takecchi/mnemora/issues/402) — 連想枠の席の取り合い（`rankFetchCount`/`rankKey`）の設計。本 ADR は測っていない（§9）
- [ADR 0151](./0151-recall-association-unprompted.md) — 連想枠そのものの設計・既定 off の根拠
- [ADR 0168](./0168-examples-chat-uses-association.md) — `examples/chat` が連想枠を既定で使う
- [ADR 0284](./0284-hnsw-iterative-scan-relaxed-order-adopted.md) — `relaxed_order` の採用（本 ADR §6.3 が実測で裏取りした）
- `main` の [ADR 0308](./0308-lexical-rank-length-normalization.md) — **本 ADR とは無関係**（§10 参照。同番号の別件）
- `docs/decisions/0327-relation-graph-contested-write-path-design.md` — 本 ADR が体裁を踏襲した「提案」状態の先例
