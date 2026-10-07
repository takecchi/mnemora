# ADR 0692: 09/16 にマージされた G4（postgres の tie-break・provenance の CHECK・埋め込みの ANALYZE）3本の確かめ直しで見つかった穴に歯を足す（Issue #1815）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1815](https://github.com/takecchi/mnemora/issues/1815) の G4。
これは試験だけの変更で、実装・migration・`*-conformance.ts`・`__fixtures__/` は触らない。変異は一時的に当てただけで、控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた。

## 経緯【実測】

#390（語彙チャンネルの tie-break、[ADR 0175](./0175-lexical-search-tiebreak-nondeterminism.md)）・#396（`provenance_kind` の CHECK、[ADR 0182](./0182-provenance-kind-matches-provenance-check.md)）・#406（埋め込み表の閾値 ANALYZE、[ADR 0194](./0194-embedding-space-analyze-threshold.md)）に、変異を当てた。Postgres 17 + pgvector（`initdb` で `/tmp` に自前で立てた別ポートのインスタンス。migration の変異は DB を作り直す必要があるため、変異ごとに DB を作り直した）。「前」は既存の試験だけ、「後」は歯を足した後。

| PR   | 変異                                                                                         | 穴  | 等価・約束外   |
| ---- | -------------------------------------------------------------------------------------------- | --- | -------------- |
| #390 | 25（`PostgresLexicalStore` 13・`PostgresTrigramLexicalStore` 12）                            | 2   | 等価2          |
| #396 | 14（migration 0016・0017）                                                                   | 6   | 等価1・約束外1 |
| #406 | 18（`upsert` の呼び出し側 5・`embedding-statistics.ts` 2・共有の `analyze-threshold.ts` 11） | 4   | 無し           |

合計57本、穴12本。

## 今の約束に当てたもの（後の ADR での変化）

- #390: [ADR 0319](./0319-optional-trigram-lexical-store.md)・[ADR 0553](./0553-trigram-lexical-coverage-scale-and-word-similarity-rank.md) が、trigram の store も同じ4段（`coverage`・`rank`・`recorded_at` 降順・`id`）にした。今の約束は2つの store に掛かるので、両方に当てた。[ADR 0308](./0308-lexical-rank-length-normalization.md) が `rank` に文書長の正規化を足したので、`rank` が違う組は長さの違う本文で作った。撤回された約束は無い。
- #396: ADR 0182 のとおり（制約は `NOT VALID` を足す 0016 と `VALIDATE` する 0017 に分ける）。狭まった約束は見つからなかった。
- #406: [ADR 0221](./0221-memories-analyze-on-write.md) が核を `analyze-threshold.ts` に切り出して `memories` にも使い、[ADR 0683](./0683-merged-0917-g3-write-time-analyze-recheck-teeth.md) が共有部分（閾値・guard・対象の表・数える経路）に歯を足した。共有部分の変異11本は、その歯と既存の歯で全部赤だった（歯を重ねていない）。埋め込み側に固有の部分だけに歯を足した。

## すり抜けと足した歯【実測】

- #390: `ORDER BY` の `recorded_at` を実効時刻 `COALESCE(occurred_at, recorded_at)` に替える変異が、2つの store で緑だった。既存の歯は `occurred_at` を持たない行だけで並びを見ていた。`id` を落とす・降順にする変異は既存の歯でも赤だったが、`createMemory` の `id` は乱数なので、`id` の落とし方によっては偶然通る賭けだった。歯は行を生 SQL で入れて `id`・`created_at`・`occurred_at` の順を `recorded_at` と食い違わせ、挿入順も両方向で見る。`lexical-search-tiebreak-recheck-0916.postgres.test.ts`（2つの store で7本ずつ）。
- #396: 大文字小文字を無視する・前後の空白を無視する変異、正しい `reflected` の行まで拒む変異、`NOT VALID` を外す・`VALIDATE` を 0016 に同居させて 0017 を空にする・0017 が検証しない変異が緑だった。既存の歯は終わりの状態で、`consolidated`・`imported` の不一致だけを見ていた。歯は、5種の kind の正しい行が書けること、kind の取り違え・大文字小文字・前後の空白の違いが拒まれること、制約が検証済みであること、既存行にずれがあるとき 0016 が台帳に残って新しい書き込みを守り 0017 だけが失敗すること（直して再実行すると 0017 だけが走る）を見る。`provenance-kind-check-recheck-0916.postgres.test.ts`（20本。途中まで当てた状態を作るため専用の使い捨てデータベース）。
- #406: `upsert` の判定を書き込みの前へ移す（ANALYZE が1行少ない統計を見る）、記憶が無くて断られた `upsert` も数える、`search`・`delete` も数える変異が緑だった。歯は、閾値の1つ手前では撃たず閾値ちょうどの後の行数（`reltuples`）で撃つこと、累計は空間ごとで撃つのは届いた空間の表だけであること、断られた `upsert` と `search`・`delete` は数えないことを見る。`embedding-statistics-recheck-0916.postgres.test.ts`（4本。専用の使い捨てデータベース、空間名は毎回新しい）。

穴の変異はすべて、足した歯で赤・戻して緑・`cmp` 一致を確かめた。新しい3ファイルは並列群（`isolate: false`、[ADR 0397](./0397-postgres-db-tests-isolate-false.md)）に置き、他のファイルを import して登録を読む形ではないので、直列群の一覧は変えていない。ファイル順のシャッフル（seed 1〜3）で、既存の関連ファイルと一緒に走らせて緑だった。

## 等価と判断した根拠【判断】

- `id` を `id::text` にする変異（2つの store）: `uuid` の昇順はバイト順で、小文字 16 進の文字列の昇順と一致する。
- #396 の制約に `NO INHERIT` を付ける変異: `memories` は継承されない。

約束に無いので歯にしない: `provenance` の jsonb に `kind` が無い行は、元の CHECK では `NULL` になって通る（`IS NOT DISTINCT FROM` なら拒まれる）。ADR 0182 はこの端を書いていない。必要ならオーナーの判断で ADR に決める。

## 決定【判断】

1. 実装・migration・`*-conformance.ts`・`__fixtures__/` は変えない。足すのは試験3ファイルと、この ADR だけである。
2. 歯は今の約束より強い縛りにしない。`occurred_at` を見ない並びは ADR 0175 が `recorded_at` と書いた約束で、「`search`・`delete` は数えない」「断られた `upsert` は数えない」は ADR 0194 の「`upsert` で書いた行数」である。
3. 実バグは見つからなかった。

## 確かめていないこと

- 本番規模（HNSW が選ばれる規模、数百万行の `VALIDATE`）での挙動。
- 複数プロセスが数える形（ADR 0460・0501）。
- 専用スキーマ（`schema` オプション）での 0016・0017 の適用。
- core の `LexicalStore` の doc と testkit の `InMemoryLexicalStore` の並びには変異を当てていない。
- 全テストは流していない。関係するファイルを名指しして走らせた。CI の結果はこの時点では見ていない。
