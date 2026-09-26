# ADR 0284: 段1の `search()` に `hnsw.iterative_scan = relaxed_order` を採用する — 他テナントの near-duplicate が候補枠を独占して全滅する問題を塞ぐ（ADR 0063 決定1を覆す、Issue #671）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-24

**⚠ 各主張の出所を分ける**（ADR 0063 / 0179 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が自分の手で `psql`/`vitest`/`node` 等を走らせて確かめた。
- **【受】** — Issue #671・#363 に記録された、別の担い手による実測を報告として受け取り、
  自分では再導出していない箇所（明記する）。

> **クローン（miku）の依頼でマネージャーのセッションが書いた。**
> **投稿者名 `takecchi` はオーナー本人を意味しない**
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

---

## 文脈

[ADR 0063](./0063-hnsw-iterative-scan-not-adopted.md) 決定1は「`hnsw.iterative_scan` を
有効にしない（`off` のまま）」と決めた。理由は、ADR 0063 が測った条件
（home 単一テナント・`period` の狭い窓で HNSW 経由に落ちたとき）では、
`relaxed_order` が `LIMIT` を埋めても `recall@40` が 0.500 / 0.350 に留まり、
「正しさを買わない、遠い候補での水増し」に見えたためである。

**この決定1は、当時の担い手が独自に下した決定であり、オーナー決定ではない**
（本文冒頭に「本 ADR は測定と決定の記録だけである」とあるとおり、[ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md)
が委譲した「§5 級の判断」相当の技術判断として、担い手が独立に決めたもの）。
ADR 0156 により、この種の判断はオーナーの事前承認を待たずに担い手が下し・覆してよい
——本 ADR はその委譲の範囲内で、ADR 0063 決定1を実測に基づいて覆す。

### Issue #671 が見つけた、ADR 0063 とは別の故障モード

[Issue #671](https://github.com/takecchi/mnemora/issues/671)（元は
[#363](https://github.com/takecchi/mnemora/issues/363) の実測記録）は、ADR 0063 が
測っていなかった組み合わせを実測した：

- クエリ対象テナント（home）が10万行に育ち、プランナが GUC 無しで自然に HNSW を選ぶ。
- **他テナント**に、gold（正解）より近い near-duplicate を **40件（`ef_search` の既定値）
  以上**置く。

このとき HNSW が返す上位40件（`ef_search=40` の候補枠）が**すべて他テナントの行**で
埋まる。`tenant_id` の絞り込みは索引スキャンの**後**に効くフィルタなので、自テナントの
候補は1件も残らない。⟹ **`runtime.recall()` が0件を返す。** `omitted` は
`ann_unreached` だけで、これは正常時にも同じ形（`countKind: "unknown"`）で鳴るため、
「探して見つからなかった」（正常）と「そもそも自テナントの候補を1件も見ていない」
（全滅）が呼び出し側から区別できない
（`docs/north-star.md`「知らないことを、知らないと言える」に反する）。

境界も実測されている（home 100,000行固定）：near-dup N=31 から取りこぼしが始まり、
N=40（`= kPrime = ef_search`）で 0/10 に落ちる。`SET hnsw.iterative_scan=relaxed_order`
にすると N=60 まで 10/10 に戻る（詳細は Issue #671 本文、以下「一次実測」で本 ADR の
書き手が独立に再現した数字も示す）。

### ADR 0063 が測っていなかった理由——故障の層が違う

ADR 0063 が測ったのは「home 単一テナント・`period` の狭い窓で HNSW 候補が薄くなり、
窓の**内側**での再スコアの精度が落ちる」という状況だった。そこでの `relaxed_order` は
「本来なら候補に入らない、より遠い行を掘り出して `LIMIT` を埋める」という意味を持ち、
掘り出した行が正解ではないことが多かった（`recall@40` が低いまま）。

Issue #671 の故障は違う。**自テナントの正解候補は近傍に実在する**——ただし
`ef_search=40` という浅い探索窓が、他テナントの near-duplicate という「テナント条件を
知らない」候補で先に埋まってしまい、自テナントの行を1件も見ないまま探索が終わる。
`relaxed_order` はここでは「遠い候補で水増しする」のではなく、**そもそも見ていなかった
自テナントの近傍を初めて見る**ように働く。ADR 0063 自身の実測でも、10%窓・50%窓で
`relaxed_order` の `recall@40` は `off` を**下回ったことが一度も無い**
（10%窓: 0.500 対 0.075、50%窓: 0.350 対 0.125、0.1%/1%窓は両者 1.000 で同点）。
⟹ **ADR 0063 が測った範囲でも、`relaxed_order` が `off` より悪化した例は無い。**
本 ADR はこの構造（正しさが単調に非劣化）を、テナント越境の故障モードでも
自分の手で確かめ直す（下記「一次実測」）。

---

## 決定

1. **`packages/postgres/src/vector-store.ts` の `PostgresVectorStore.search()` を、
   1本のトランザクションで実行する形にする。** `db.transaction()`（drizzle-orm、
   `memory-store.ts` の既存の作法を踏襲）で `BEGIN` し、`SET LOCAL
hnsw.iterative_scan = relaxed_order` を発行してから、既存の `SELECT`
   （`WHERE`/`ORDER BY` は1文字も変えない）を実行する。
2. **`hnsw.max_scan_tuples` には触れない。** 既定値（20,000）のままとする——
   Issue #671 が実測した天井（下記「引き受けた負債」）は、本 ADR では塞がない。
   上げるかどうかは、その天井が実運用でどれだけ当たるかを測ってから別に決める。
3. **`strict_order` は採らない。** ADR 0063 の実測（`ef_search` をどの水準に振っても
   `recall@40` が `off` と一致する——正しさを何も足さない）が本 ADR の射程でも
   変わる理由が無い。
4. **ADR 0063 決定1を覆す。** ADR 0063 の本文は書き換えない
   （[docs/decisions/README.md](./README.md)「⛔ 採用済み ADR の本文は書き換えない」）。
   ADR 0063 には、[ADR 0026](./0026-ann-unreached-omission.md) の
   「## 追記（2026-09-17）: …は ADR 0193 で覆った」と同じ形式で、
   本 ADR が決定1を覆した旨を追記として積む。

---

## 一次実測（本 ADR の書き手が自分の手で測った）

**測定台**: `/tmp/mgr-1ffb2f82-pr1/pgdata` に自前で立てた PostgreSQL 17.11
（`initdb` + 手元ビルドの `postgres`/`vector` 拡張）。`SELECT version()` /
`pg_extension.extversion` で確認: **PostgreSQL 17.11、pgvector 0.8.0**
——Issue #671 が実測した組（`main`=`12764ea` 時点の実測環境）と同じ版。
`packages/postgres` の移行スクリプト（0001〜0018）を素通しで適用し、スキーマは
手書きしていない。埋め込み空間は本番と同じ `registerEmbeddingSpace()` で登録した
（256次元、`vector_cosine_ops`、m/ef_construction は指定なし=既定）。GUC は
`hnsw.ef_search=40` / `hnsw.max_scan_tuples=20000` を既定のまま変えていない。

測定に使ったスクリプトは scratch であり、この PR には含めていない
（`packages/postgres/src/__tests__/zz-scratch-*.postgres.test.ts` として一時的に
作り、数字を確認した後に削除した——commit していない）。

### 1. 陽性対照——Issue #671 のレシピをそのまま再現

home テナント 100,000行 + gold 10件（クエリ G から eps=0.02）+ 他3テナント
（t1/t2/t3）に near-duplicate 計60件（G から eps=0.001、gold より近い最悪設計）。
経路は `runtime.recall()`（`createRuntime` + `PostgresMemoryStore` +
`PostgresVectorStore`、`recall.postgres.test.ts` と同じ配線）。`EXPLAIN` で
home 側のプランが自然に HNSW（`Index Scan using idx_memory_embeddings_hnsw_*`
経由の Nested Loop）であることを確認済み。

| 状態                          | `memories` | gold      | `omitted`                                         |
| ----------------------------- | ---------- | --------- | ------------------------------------------------- |
| **変更前**（`off`、既定）     | **0件**    | **0/10**  | `ann_unreached` のみ                              |
| **変更後**（`relaxed_order`） | **10件**   | **10/10** | `over_limit(rescore, 30, exact)`、`ann_unreached` |

⟹ **Issue #671 が報告した全滅と、それが直ることの両方を、この書き手が独立に再現した。**
`omitted` の形も Issue #671 本文の表（近隣重複0件=正常時の形と一致）と一致する。

### 2. 退行の確認——ADR 0063 が測った条件を読んで再現する（`off` vs `relaxed_order`）

ADR 0063 の測定手順（home 単一テナント・100,000行・256次元・`period` の窓で
`recall@40` を測る）を読んで再現した。ADR 0063 と違い gold/near-dup 構造は無い
——ADR 0063 自身の測定もそうだった（`period` 窓の内と外という分割だけで、
テナント間の重複という交絡は無い）。occurred_at は80%の行に
`START + (行番号/100,000) × 1,000日` を割り当て、20%を NULL にして
`recorded_at`（全窓の外側の固定値）へ落とす。正解集合は
`enable_indexscan=off`/`enable_bitmapscan=off` で強制した厳密な上位40件。

| 窓   | 窓内行数 | `off` recall@40 | `relaxed_order` recall@40 | 退行の有無                         |
| ---- | -------: | --------------: | ------------------------: | ---------------------------------- |
| 0.1% |      100 |   40/40 (1.000) |             40/40 (1.000) | 無し（同点）                       |
| 1%   |      832 |   40/40 (1.000) |             40/40 (1.000) | 無し（同点）                       |
| 10%  |    8,080 |    4/40 (0.100) |             21/40 (0.525) | **無し（relaxed_order が上回る）** |
| 50%  |   39,920 |    1/40 (0.025) |              4/40 (0.100) | **無し（relaxed_order が上回る）** |

⟹ **4窓すべてで `relaxed_order` の `recall@40` は `off` 以上だった。下回った窓は無い。**
ADR 0063 自身の実測（10%窓 0.500 対 0.075、50%窓 0.350 対 0.125）と方向は一致する
（絶対値は seed・pgvector 版が違うため一致しない——**この書き手は ADR 0063 の生の数字を
再現しようとしたのではなく、「`relaxed_order` が `off` を下回る窓が無い」という構造を
別の pgvector 版・別の seed で確かめ直した**）。窓内行数（100 / 832 / 8,080 / 39,920）は
ADR 0063 の実測（92 / 832 / 8,089 / 39,933）に近い——狙った窓の大きさが意図通りに
出ていることの確認になる。

### 3. レイテンシ——`runtime.recall()` の p50/p95（N=30試行）

陽性対照と同じデータ（home 100,070行、他3テナント計60行）に対して、変更前後で
`runtime.recall()` を30回ずつ呼んだ（ウォームアップ無し、同一プロセス内で連続実行）。

|                           |   p50 |   p95 | 全30試行   |
| ------------------------- | ----: | ----: | ---------- |
| 変更前（`off`）           | 204ms | 240ms | 172〜264ms |
| 変更後（`relaxed_order`） | 236ms | 276ms | 204〜326ms |

⟹ **p50 で約+32ms（+16%）、p95 で約+36ms（+15%）。** 増分の内訳は測っていないが、
構造的に2つの要因がある——(a) `BEGIN`/`SET LOCAL`/`SELECT`/`COMMIT` で1往復増える
往復コスト、(b) `relaxed_order` 自体が HNSW をより深く掘る探索コスト。
**⚠ この数字はこの書き手の測定環境（他プロセスと共有する可能性のあるコンテナ）で
連続実行した1系列であり、ADR 0063 が時間の根拠の格を下げたのと同じ理由で、
絶対値の精度は高くない。** 増分の方向（悪化する、無視できるほど小さくはない）は
複数回の目視で安定していた。

---

## 順序の意味——段2が並べ直すので、最終順序の意味は変わらない

`relaxed_order` は段1の距離順を壊しうる（ADR 0063 が既に実測済み）。しかし
`packages/core/src/recall-runtime.ts` の `compareScoredCandidates`（:152-159）が
`score.total`（減衰 × 類似度 × タグ × 鮮度）で並べ直し（:803 の `scored.sort
(compareScoredCandidates)`）、これが最終提示順を決める。**⟹ 段1の順序が
`relaxed_order` で変わっても、最終順序の意味は変わらない**（ADR 0063「⚠『順序が壊れる』
の中身」節と同じ結論）。

**⚠ 例外は連想枠（recall-runtime.ts:1177 付近）の同点時の並びである。**
`associationHits.sort((a, b) => b.similarity - a.similarity)` は similarity の
同点を解かない——`Array.prototype.sort` が安定ソートであるため、同点の相対順序は
段1（adapter）が返した順序をそのまま引き継ぐ。**これは ADR 0063 が
`compareScoredCandidates` 側の安定ソート依存として既に指摘した限界と同じ性質**
であり、`relaxed_order` を採ることで新しく生まれる依存ではない
（既に adapter 順序に依存していた箇所が、段1の adapter 順序の出方を変える、という話）。

---

## 採らなかった案

- **b-1. 新しい `Omission` の kind を足す**（例: 「scope 内の候補をゼロ件しか見ていない」
  ことを明示的に名乗る）。**却下（この ADR の範囲では、というより「オーナーへ送る」）**
  ——`Omission.kind` の union を拡張することは、[Issue #541](https://github.com/takecchi/mnemora/issues/541)
  が指摘した「union 拡張が破壊的変更として数えられるかどうか」の線に直接依存する。
  この ADR の書き手はその線を独立に引く立場に無い——ADR 0156 が委譲したのは
  「§5 級の判断」と「破壊的変更の実装そのもの」であって、破壊的変更の**数え方**を
  決める権限ではない。⟹ **この案自体は否定していない**（Issue #671 が指摘した
  「全滅と正常が同じ顔」問題は、本 ADR の変更後も解決していない）。持ち帰ってオーナーへ送る。
- **c. テナントごとの部分索引・パーティショニング**。**却下（この ADR の範囲では）**
  ——`docs/roadmap.md` の技術上のリスク表「multi-tenant での ANN 索引の効き」の行が、
  この対処を「Phase 3 以降の課題として明示する」と既に位置づけている。テナント単位の
  索引分割は製品としての規模・運用コストの判断であり、本 ADR が独断で先取りする範囲を
  超える。
- **`strict_order` を採る**。**却下**——上の「文脈」節で引いた通り、ADR 0063 の実測
  （`ef_search` をどの水準に振っても `recall@40` が `off` と一致する）は、正しさを
  何も足さないことを示している。本 ADR の射程でこの結論が変わる理由も無い。
- **段1の `LIMIT`（`kPrime`）や `ef_search` を上げる**。**却下（この ADR の範囲では）**
  ——ADR 0063 が既に「別の腕であり、同じ ADR に混ぜると効いた要因を切り分けられなく
  なる」と判断した理由をそのまま踏襲する。Issue #671 の全滅は `ef_search=40` の
  候補枠が他テナントの行で埋まることが直接の原因であり、`relaxed_order` は
  その枠の「中身」を変えずに「探索の深さ」を変える、最小の修正である。

---

## 引き受けた負債

1. **`hnsw.max_scan_tuples`（既定20,000）の天井。** Issue #671 の実測では、
   他テナントの near-duplicate が20,000〜25,000件を超えると `relaxed_order` の回復も
   崩れる（N=20,000で13/10、N=25,000で2/1、N=30,000で1/1）。本 ADR はこの天井を
   塞がない——上げるかどうかは、実運用でこの天井にどれだけ当たるかを測ってから
   別に決める（採らなかった案とは別に、次に測るべき一点として残す）。
2. **往復が増える。** `search()` が単発の `SELECT` から `BEGIN`/`SET
LOCAL`/`SELECT`/`COMMIT` の1トランザクションに変わり、pool の同一コネクション上で
   往復が増える。上の「レイテンシ」節の実測値（p50 +32ms/+16%、p95 +36ms/+15%、
   N=30）を引き受ける。
3. **削除済み行が候補枠を食う交絡が残る。** Issue #671 が記録した通り、他テナントの
   near-duplicate を DELETE しても、`VACUUM (INDEX_CLEANUP ON, ANALYZE)` で索引から
   実際に掃除されるまで、死んだ行が候補枠を食い続ける。本 ADR はこの挙動を変えない
   （pgvector 側の性質であり、`vector-store.ts` の変更では解けない）。
4. **連想枠（:1177 付近）の同点時の並びが、段1の adapter 順序に依存し続ける。**
   上の「順序の意味」節で述べた通り、これは新しく生まれる負債ではなく、
   `relaxed_order` によって段1の adapter 順序の出方そのものが変わることの帰結である。

---

## これが覆るとしたら

- **`hnsw.max_scan_tuples` の天井が実運用で頻繁に当たると分かったとき。** その場合は
  `max_scan_tuples` を上げる、あるいは他の手（`ef_search` を上げる・段1の `kPrime` を
  上げる・テナントごとの部分索引）を、実測の上で別の ADR として検討する。
  「引き受けた負債」1番がそのまま引き金になる。
- **往復増加によるレイテンシの悪化が、実運用の SLO で許容できないと分かったとき。**
  本 ADR の実測（p50 +16%、N=30、共有環境での1系列）は「無視できるほど小さい」とは
  言っていない——実運用のトラフィック・同時実行下で測り直し、許容できないと分かれば、
  `SET LOCAL` を都度発行する代わりに ADR 0063「⭐ 有効化の口は既に在る」節が指摘した
  `PGOPTIONS`（libpq の startup parameter）経由でセッション単位に固定する案を検討する
  ——ただしその場合は「狭い窓のクエリにも同じ設定が掛かる」副作用を測り直す必要がある
  （ADR 0063 が同じ理由で保留した点）。
- **1,536次元・100万件規模で測り直したとき、`relaxed_order` が `off` を下回る窓が
  見つかったら。** 本 ADR の一次実測は 256次元・100,000行の1点のみである
  （ADR 0063 と同じ限界を引き継ぐ）。
- **`hnsw.iterative_scan` の実装そのものが pgvector の将来版で変わったとき**
  （ADR 0063「⭐⭐ 採否と独立に価値が在る発見」節が記録した、不正値が黙って `off` に
  落ちる挙動を含む）。

---

## 確かめていないこと

- **association-probes 等、実データでの near-duplicate 40件以上の発生頻度。**
  Issue #671 自身が「合成データであり、実データでどれだけ起きるかは分からない」と
  明記しており、本 ADR もそこを追加で確かめていない。
- **1,536次元・100万件規模。**
- **PostgreSQL 17 以外のバージョン。**
- **`hnsw.max_scan_tuples` を既定から動かした場合の recall@40 の変化。**
  「引き受けた負債」1番として残し、測っていない。
- **同時実行下でのレイテンシ増分。** 上の「レイテンシ」節の数字は単一プロセスの
  連続実行によるものであり、実運用の並行度での増分は測っていない。
- **公開 API の型面の互換性は確かめた**（下記「公開 API への影響」参照）が、
  drizzle-orm の `db.transaction()` が pool のコネクション断・再接続時にどう振る舞うかの
  異常系は、既存の `search()` の異常系検査の範囲を超えて追加検査していない。

---

## 公開 API への影響

`search()` のシグネチャ・戻り値の型（`Promise<VectorHit[]>`）・`VectorStore`
interface は変えていない。`packages/core/src/index.ts` と `packages/postgres/src/index.ts`
の export 一覧に差分は無い（`git diff` で確認）。`tsc --declaration` でビルドした
`packages/postgres/dist/vector-store.d.ts` を変更前後で比較し、シグネチャの差分が
無いことを確認した（詳細は本 PR の説明を参照）。

---

## 追記（2026-09-24）: 本 ADR が4ファイルへ寄せた `captureClientQuery` は、`SET LOCAL` を持ち帰らず、EXPLAIN が本番と違う文脈でプランを読んでいた

**この節から上は当時の決定・実測の記録のまま書き換えていない。** 以下は事後の訂正である。

**この節から上（「副次的な修正」節）は、`captureClientQuery` が捕まえた SELECT を
そのまま `pool.query("EXPLAIN (FORMAT TEXT) " + captured.text, captured.params)` で
EXPLAIN すれば十分だと前提していた。この前提は誤りだった**——`EXPLAIN` はそれ自体が
独立した1本のクエリであり、`pool.query()` は新しい接続（少なくとも新しいトランザクション）
の上で発行される。`search()` 本体が使う `SET LOCAL hnsw.iterative_scan = relaxed_order`
（この ADR の主題そのもの）は `SET LOCAL` である以上、そのトランザクションの外へは
一切漏れない。⟹ **本 ADR が「本番と同じクエリを EXPLAIN している」つもりで直した
4ファイル（`vector-search-hnsw.test.ts` / `vector-search-subject.test.ts` /
`recall.postgres.test.ts` / `memories-statistics.postgres.test.ts`、計5箇所）は、
実際には `hnsw.iterative_scan = off`（セッション既定値）の文脈でプランを読んでいた。**

マネージャーからの指摘で発覚し、`captureClientQuery` に
`precedingSetLocalStatements`（捕まえた SELECT と同じ接続・同じトランザクション内で、
それより前に発行された `SET LOCAL` 文の並び）を持ち帰らせ、新設した
`explainCaptured(pool, captured)` が専用の接続で `BEGIN` → それを発行順に再生 →
`EXPLAIN` → `ROLLBACK` する形に直した（`packages/postgres/src/__tests__/test-db.ts`）。
`SET LOCAL` の値をテスト側にハードコードしていない——`vector-store.ts` の実装が
`SET LOCAL` をやめる・値を変えるように直っても、この歯は自動的に追従する。

**実測（自前の PostgreSQL 17.11 + pgvector 0.8.0）**:

- 直した `explainCaptured` の中で `SHOW hnsw.iterative_scan` を実行すると `relaxed_order`
  が返り、再生しない別トランザクションでは既定値 `off` が返ることを、scratch の歯
  （このコミットには含めていない）で確認した。
- **変異（`vector-store.ts` から `SET LOCAL` を外す）**: `captureClientQuery` が観測する
  `precedingSetLocalStatements` は空になり、上の `SHOW` は `off` に変わった
  （scratch の歯がこれを検出して赤くなることを確認し、`cp` で復元した）。
- **同じ変異のもとで、直した4ファイル・24 test を実行しても全て green のままだった**
  ——今のデータ規模・分布では、これら4ファイルが assert しているプラン選択
  （HNSW を使うか／`idx_memories_by_subject` を使うか）は `hnsw.iterative_scan` の
  on/off に左右されない。**⟹ 今日の時点では、この修正は「今赤いものを緑にする」もの
  ではなく、将来の退行（EXPLAIN が読む文脈が本番と静かにずれること）を防ぐためのもの
  である。**プラン選択そのものが `iterative_scan` に依存する将来のデータ・歯が
  追加されたときに、初めてこの修正の有無が可視の差を生む。

変更したファイルは `packages/postgres/src/__tests__/test-db.ts`
（`captureClientQuery` の拡張・`explainCaptured` の新設）と、上に挙げた4ファイル。

---

## 追記（2026-09-26）: `searchMany`（Issue #377）が同じ `relaxed_order` を同じ形で使う

**この節から上は当時の決定・実測の記録のまま書き換えていない。** 以下は、連想枠
（段3.5）のアンカーごとの ANN 検索を1回の往復に束ねる `VectorStore.searchMany?`
（Issue #377）を `PostgresVectorStore` に足したときに、この ADR の射程内かどうかを
確かめた記録である。

### 何が起きたか

`searchMany()` は `search()` と同じ `SET LOCAL hnsw.iterative_scan = relaxed_order` を
発行してから、複数のクエリベクトルを `VALUES` + `LATERAL` で束ねた1本の `SELECT` を
実行する。実装した直後、`hnsw-ef-search-window-ceiling.test.ts` 検査2（この ADR が
「本番経路で `SET LOCAL hnsw.iterative_scan` を発行している箇所は `vector-store.ts` に
1箇所だけ」とソース走査で固定している歯）が赤くなった——`search()`/`searchMany()` が
それぞれ独立に `db.transaction()` を開いて `SET LOCAL` を発行しており、同じ文字列が
2箇所に複製されていたため。

### 採った案（案A）: `SET LOCAL` の発行を共通ヘルパーへ抽出する

`search()`/`searchMany()` の両方が呼ぶ `withRelaxedOrderScan(db, run)` を新設した
（`packages/postgres/src/vector-store.ts`）——`db.transaction()` で `BEGIN` し、
`SET LOCAL hnsw.iterative_scan = relaxed_order` を発行してから `run(tx)` を実行する。
`SET LOCAL` を書く箇所はこの関数の中の1行だけになり、`search()`/`searchMany()` は
どちらもこの関数を経由するだけで、`SET LOCAL` そのものを直接書かない。

**採らなかった案（案B）**: `hnsw-ef-search-window-ceiling.test.ts` の期待値に
`searchMany` を足す（「1箇所」を「2箇所（`search()`/`searchMany()`）」に広げる）。
**採らなかった理由**——この歯が縛っているのは「本番経路で `relaxed_order` を有効にする
コードパスが、増えるたびに際限なく複製されないこと」であり、`searchMany` の追加を機に
2箇所目を正式に認めると、次に3つ目の口（例: 将来のバッチ検索）が増えたときにも
「歯の期待値を書き換えるだけ」で通ってしまい、歯の抑止力が薄れる。共通ヘルパーへ
抽出するコストは小さく、歯の「1箇所」という意図（この ADR の決定1が指す唯一の
有効化ポイント）をそのまま保てるため、案Aを採った。

### この ADR の測定は `searchMany` にも及ぶか——見立て

**及ぶ、と見ている。** この ADR の一次実測（陽性対照・退行の確認・レイテンシ）は、
いずれも「`search()` が発行する1本の ANN `SELECT` に対して、`hnsw.iterative_scan` を
`off` から `relaxed_order` に変えたときの結果・レイテンシがどう変わるか」を測っている
——測定対象は SQL の実行そのものであり、その SQL を呼び出す TypeScript 側の口が
`search()` か `searchMany()` かには依存しない。`searchMany()` の `LATERAL` の中身
（`WHERE`/`ORDER BY`/`LIMIT`、`buildFilterConditions` を含む）は `search()` の
`SELECT` と一字一句同じであり、変わるのはクエリベクトルの出どころが1個の
プレースホルダから `VALUES` の列になっただけである（`vector-store.ts` の doc
コメント参照）。加えて、`vector-store-search-many.postgres.test.ts` の一致の歯
（歯1・歯2）が、`searchMany()` の結果が同じクエリを1本ずつ `search()` した場合と
集合・順序ともに完全一致することを実測している——`search()` の正しさに対する
`relaxed_order` の効果（この ADR の「一次実測」節）は、この一致を経由して
`searchMany()` の各クエリの結果にもそのまま伝わる、という見立てである。

**測り直していないもの**: レイテンシ（この ADR の「一次実測」3番、p50/p95）は
`search()` を単発で呼んだときの往復コストを測ったものであり、`searchMany()` が
複数クエリを1回の往復に束ねたときのレイテンシは測っていない——ただし Issue #377の
主題は往復**数**の削減であり、複数クエリを1トランザクションにまとめることで
「引き受けた負債」2番（`BEGIN`/`SET LOCAL`/`SELECT`/`COMMIT` の往復コスト）は
クエリ数ぶん複製されるのではなく1回に共有されるため、悪化ではなく改善の方向だと
考えられる（実測はしていない）。`hnsw.max_scan_tuples` の天井（「引き受けた負債」
1番）は `searchMany()` でも変えておらず、複数の `LATERAL` 分岐それぞれが独立に
この天井の対象になる——1回のクエリで束ねるアンカー数が増えるほど、天井に当たる
分岐が増える可能性はあるが、これも測っていない。

### 確かめていないこと

- `searchMany()` を複数クエリで呼んだときの `recall@40` 相当の正しさは、`search()`
  との一致の歯を経由した見立てであり、`searchMany()` 自身に対して ADR 0284 の
  「一次実測」と同じ形（陽性対照・退行の確認）を独立に測り直してはいない。
- `searchMany()` のレイテンシ（束ねるクエリ数を振ったときの p50/p95）は測っていない。
- 複数の `LATERAL` 分岐が同時に `hnsw.max_scan_tuples` の天井に当たったときの挙動は
  測っていない。
