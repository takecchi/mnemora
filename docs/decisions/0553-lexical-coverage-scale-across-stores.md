# ADR 0553: `lexicalMatch`（`LexicalStore` の `coverage`）の尺度を3つの store で測り、式から決まる値と性質だけを歯で縛る（ADR 0484 の負債1。尺度は揃えていない）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の委譲先（担い手。マネージャー mgr-c6db44c8 の指示による）が書いた。決めたのは依頼主で、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。**オーナーへの問い 374f6f88 の問23（小さな既知の限界5件）のうち、[ADR 0484](./0484-recall-channel-merge-on-real-postgres.md) の負債1だけを扱う。**ほかの4件（tagMatch の水増し・素のオブジェクトも競合扱い・消えた recallId で Observation が残る・embeddingInput の無検査）には触れていない。今のままである。**オーナーへの問いの回答を待つ間の先行の用意であり、10/03 01:00Z まではマージしない（Draft のまま）。**
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 経緯と、ADR 0484 の文面の訂正【現物】

- ADR 0484 の負債1は「`lexicalMatch` は値域 `(0, 1]` しか縛っていない」で、結果の欄は「store ごとの coverage の定義の違い（tsvector は一致した語彙数 ÷ 総数、trigram は word_similarity ベース）が順位にどう効くかは測っていない」。推奨は「両 store の対応を測り文書化」。
- **ADR 0484 の「2つの store」は、Postgres の中の tsvector 版（`PostgresLexicalStore`）と trigram 版（`PostgresTrigramLexicalStore`）である。testkit の `InMemoryLexicalStore` は入っていなかった。**この ADR は InMemory も測る（3つ）。core の `FakeLexicalStore`（`packages/core/src/__tests__/runtime-fakes.ts`）は InMemory と同じ式なので、測る対象に入れていない（注の1行のみ）。
- **負債の表の「trigram は word_similarity ベース」は、現物とずれている。**`packages/postgres/src/trigram-lexical-store.ts` の `search` の SQL では、`coverage = GREATEST(ASCII 側, 日本語側)`、日本語側は `CASE WHEN word_similarity(日本語の部分, content) >= threshold THEN 1 ELSE 0 END`。**`coverage` に効くのは閾値で 0/1 にした値だけで、`word_similarity` の値そのものは `rank`（`ts_rank_cd + word_similarity`）に入る。**coverage が word_similarity の連続値になっているわけではない。ADR 0484 本文は書き換えない（採用済みの ADR は追記で訂正する作法）。末尾の追記をこの ADR へ向けた。

## 契約と式【現物】

- core は adapter の `coverage` をそのまま `ScoreBreakdown.lexicalMatch` にする（`packages/core/src/recall-runtime.ts:1425-1428`）。`rank` はスコアに入らない。affinity は `max(similarity, lexicalMatch)`、`total = affinity × decay × tagMatch × freshness × strength`（`packages/core/src/strategies/scoring.ts`）。
- `PostgresLexicalStore`（`packages/postgres/src/lexical-store.ts`）: クエリを語に分け（DISTINCT）、各語を `websearch_to_tsquery('simple', '"語"')` にし、`coverage = 本文の tsvector に当たった語の数 / 語の数`（1/n 刻み。`count(*) FILTER (WHERE tsvector @@ tq)::float8 / NULLIF(count(*), 0)`）。クエリの非 ASCII は落とす。順位は `coverage DESC, rank DESC, recorded_at DESC, id`（`rank` は `ts_rank_cd`）。
- `PostgresTrigramLexicalStore`: ASCII 側は上と同じ式（`coalesce(..., 0)`）。日本語側は、クエリの非 ASCII の連なり（前後の ASCII は空白に落とし、ノイズ語尾〔`について` など〕を削ったもの）**全体を1つの項**として `word_similarity(項, content)` を取り、`>= threshold`（既定 `DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD` = 0.3、`create` の `opts.threshold` で変えられる）なら 1、そうでなければ 0。順位は同じ4段で、`rank = ts_rank_cd(ASCII) + word_similarity`。
- `InMemoryLexicalStore`（`packages/testkit/src/__fixtures__/in-memory-lexical-store.ts`）: クエリを空白で区切った語（重複は1語）のうち、本文の token の列にフレーズとして現れる数 ÷ 語の数。`rank` は一致の頻度の和（`ts_rank_cd` の近似ではない）。日本語の語は引かない。順位は `coverage → rank → recordedAt DESC → memoryId`。
- 【確かめた】`mnemora_lexical_coverage`（`migrations/0009`）と `mnemora_trigram_hybrid_coverage`（SQL 関数）は、`search` からは呼ばれず、同じ式が `search` の SQL に直接書いてある（Issue #878 の「計算は1回」）。この ADR の歯が縛っているのは `search` の SQL である。2つの SQL 関数の式は縛っていない。

## 測った表【実測】

環境: PostgreSQL 17.11（Debian 17.11-0+deb13u1）・`pg_trgm` 1.6・pgvector 0.8.0・`initdb --encoding=UTF8 --locale=C.UTF-8`・node v22.23.3、`@mnemora/postgres` の migration を全部適用した DB。各行は、記憶を表の「本文」の順に1件ずつ（`recordedAt` が1秒ずつ増える）入れて、同じクエリを3つの store の `search` に当てた結果。

**⚠ 下の `rank` と `word_similarity`（`ws`）の実数は、上の環境で測った値であり、歯では固定していない**（Postgres・pg_trgm の版や拡張の更新で揺れうる）。歯が縛っているのは、`coverage` の値と、並びの性質だけ（下の「歯」節）。表の `coverage` のうち、歯で固定したものは太字にしてある。

凡例: `c` = coverage、`r` = rank。tsvector は `PostgresLexicalStore`、trigram は `PostgresTrigramLexicalStore`（閾値は既定の 0.3。断りがあるときだけ変えた）、mem は `InMemoryLexicalStore`。順位は左が上位。

### ASCII

| 入力（クエリ） | 本文 | tsvector（c / r） | trigram（ASCII 側。tsvector と同じ） | mem（c / r） |
|---|---|---|---|---|
| `alpha`（1語） | `alpha`, `alpha beta`, `alpha beta gamma`, `alpha beta gamma delta` | 全部 **c=1**。r = 0.1261, 0.0834, 0.0673, 0.0585（短い本文が上） | tsvector と同じ | 全部 **c=1**。r はすべて 1.0。順位は `recordedAt DESC`（`alpha beta gamma delta` が上） |
| `alpha beta gamma`（3語） | 上の4件に `beta gamma`・`gamma` を足したもの | `alpha beta gamma` **1**（0.1779）, `alpha beta gamma delta` **1**（0.1571）, `beta gamma` **2/3**（0.1540）, `alpha beta` **2/3**（0.1540）, `gamma` **1/3**, `alpha` **1/3**（0.1261） | 同じ | `alpha beta gamma delta` **1** と `alpha beta gamma` **1**（r=3、新しい方が上）, `beta gamma` と `alpha beta` **2/3**（r=2）, `gamma` と `alpha` **1/3**（r=1） |
| `alpha beta gamma delta`（4語） | 上と同様 | `alpha beta gamma delta` **1**（0.1991）, `beta gamma delta` と `alpha beta gamma` **3/4**（0.1779）, `alpha beta` **1/2**（0.1540）, `delta` と `alpha` **1/4**（0.1261） | 同じ | 同じ coverage。r = 4, 3, 3, 2, 1, 1 |
| `cat`（部分一致） | `category`, `cats`, `concatenate`, `cat` | `cat` だけ **c=1** | 同じ | 同じ |
| `alpha alpha beta`（同じ語の繰り返し。分母は 2） | `alpha`, `alpha beta`, `alpha alpha alpha`, `beta` | `alpha beta` **1**（0.1540）, `alpha alpha alpha` **1/2**（0.1779）, `beta` **1/2**, `alpha` **1/2**（0.1261） | 同じ | 同じ coverage、同じ並び（r = 2, 3, 1, 1） |
| `ALPHA beta`（大文字小文字） | `alpha`, `ALPHA Beta`, `Alpha` | `ALPHA Beta` **1**, `Alpha` **1/2**, `alpha` **1/2** | 同じ | 同じ |

### 日本語・ASCII と日本語の混在

`ws` = `word_similarity(日本語の部分, 本文)` の測った値（歯では固定していない）。

| 入力（クエリ） | 本文 | tsvector | mem | trigram（c / r。r = ws + ASCII の ts_rank_cd） |
|---|---|---|---|---|
| `東京`（閾値 0.3） | `東京タワーに行った`, `大阪城を見た`, `東京`, `京都の東` | 0件 | 0件 | `東京` **1**（r=1.0000, ws=1.0000）, `東京タワーに行った` **1**（r=0.6667, ws=0.6667）。`大阪城を見た`・`京都の東` は ws=0 で返らない |
| `東京`（閾値 0.1） | 同上 | 0件 | 0件 | 同じ2件（c=1） |
| `東京`（閾値 0.9） | 同上 | 0件 | 0件 | `東京` **1** だけ（`東京タワーに行った` は ws=0.6667 < 0.9 で返らない） |
| `東京 大阪`（日本語は2語だが、1つの項） | `東京タワーに行った`, `東京と大阪`, `大阪城を見た`, `京都` | 0件 | 0件 | 閾値 0.3: 3件とも **c=1**（ws=0.3333、r=0.3333。0.3 を 0.03 上回るだけ）。閾値 0.9: 0件 |
| `東京タワー` | `東京タワーに行った`, `東京駅`, `東京` | 0件 | 0件 | `東京タワーに行った` **1**（ws=0.8333）, `東京駅` **1**・`東京` **1**（ws=0.3333。0.3 を 0.03 上回るだけ）。閾値 0.9: 0件 |
| `alpha 東京` | `alpha 東京`, `alpha`, `東京タワー`, `beta` | `alpha` **1**（0.1261）, `alpha 東京` **1**（0.0834）。`東京タワー` は返らない | `alpha` **1**, `alpha 東京` **1**。`東京タワー` は返らない | `alpha 東京` **1**（r=1.0834）, `東京タワー` **1**（0.6667）, `alpha` **1**（0.1261） |
| `alpha beta gamma 東京`（閾値 0.3） | `alpha 東京`, `alpha`, `東京タワー`, `alpha beta gamma`, `beta` | `alpha beta gamma` **1**（0.1779）, `beta` **1/3**, `alpha` **1/3**（0.1261）, `alpha 東京` **1/3**（0.0834）。`東京タワー` は返らない | `alpha beta gamma` **1**, `beta` **1/3**, `alpha` **1/3**, `alpha 東京` **1/3** | `alpha 東京` **1**（1.0834）, `東京タワー` **1**（0.6667）, `alpha beta gamma` **1**（0.1779）, `beta` **1/3**, `alpha` **1/3**（0.1261） |
| `alpha beta gamma 東京`（閾値 0.9） | 同上 | 同上 | 同上 | `alpha 東京` **1**（ws=1.0。1.0834）, `alpha beta gamma` **1**（0.1779）, `beta` **1/3**, `alpha` **1/3**。`東京タワー`（ws=0.6667）は返らない |

## 対応のまとめ【判断】

| 観点 | tsvector | InMemory | trigram |
|---|---|---|---|
| ASCII の coverage | 一致した語 / 語の総数（1/n 刻み） | tsvector と同じ式 | tsvector と同じ式（ASCII 側） |
| クエリの同じ語の繰り返し | 1語と数える | 1語と数える | 1語と数える |
| 本文での繰り返し・本文の長さ | coverage に効かない（rank に効く） | coverage に効かない（rank に効く） | coverage に効かない（rank に効く） |
| 部分一致・大文字小文字 | 部分一致は当たらない・大文字小文字は区別しない | 同じ | 同じ |
| 日本語 | 引かない（分母にも入らない） | 引かない（分母にも入らない） | 非 ASCII の連なり全体を1項として、`word_similarity >= threshold` なら 1、そうでなければ 0。複数語は語ごとに数えない。`GREATEST` で ASCII 側と合成 |
| coverage の値の取り方 | `{k/n}`（`k` は一致した語数） | 同じ | ASCII 側 `{k/n}` と日本語側 `{0, 1}` の大きい方 |
| `word_similarity` の値 | 無し | 無し | coverage に入らない。`rank` に入る |
| 同点（coverage が同じ）の並び | `rank`（`ts_rank_cd`。短い本文・語が近い本文が上）→ `recorded_at DESC` → `id` | `rank`（頻度の和）→ `recordedAt DESC` → `memoryId` | `rank`（`ts_rank_cd + ws`）→ `recorded_at DESC` → `id` |

- **単調か**: 同じクエリで、本文が当たる語を増やしても（本文の語の部分集合 → 上位集合）coverage は減らない。tsvector・InMemory・trigram の ASCII 側とも、式から `k/n` なので成り立つ（歯で縛った）。trigram の日本語側は、閾値を下げると `0 → 1` にだけ動く（上げると `1 → 0`）。閾値について単調。**`word_similarity` の大小は coverage に出ない**（閾値より上なら、1.0 でも 0.4 でも coverage は 1）。
- **順位が入れ替わる点**:
  - `rank` が逆の向きでも、`coverage` が先に効く（`limit` の窓を coverage の高い候補が先に取る）。例: `alpha alpha beta` で `alpha alpha alpha` は `rank` が最も高いが（tsvector 0.1779）、coverage 1/2 なので coverage 1 の `alpha beta` の後に並ぶ。
  - **同点（coverage が同じ）の並びは、store で違う**。単語1つのクエリで、tsvector は短い本文が上、InMemory は `rank` が全部 1 で、新しい本文が上。つまり**同じ入力で、tsvector と InMemory の同点の並びが逆になる**（InMemory は「頻度の和」、tsvector は `ts_rank_cd` の正規化。尺度が違うので、`LexicalHit.rank` の doc の通り比較できない）。
  - **日本語が絡むと、coverage の順位が変わる**。日本語側が当たった本文は、ASCII の語がいくつあっても coverage 1。`alpha beta gamma 東京` で、trigram は `alpha 東京` と `東京タワー` が `alpha beta gamma` と並んで coverage 1（`rank` で `alpha 東京` が先頭）。tsvector・InMemory では `alpha 東京` は 1/3 で、`alpha beta gamma` が先頭、`東京タワー` は返らない。
  - 閾値で入れ替わる。`alpha beta gamma 東京` の `alpha 東京タワー` は、閾値が ws=0.667 より下なら coverage 1、上なら ASCII 側の 1/3（歯で縛った）。
- **同点が出る所**: ①単語1つのクエリ（全部が 1）、②ASCII の語数 n のクエリで、一致した語数が同じ本文、③trigram の日本語側（閾値を超えた本文は全部 1。`ws` が 1.0 でも 0.4 でも同点で、順位は `rank` の `word_similarity` が決める）。同点の中の並びは、上の表のとおり store ごとの `rank` で決まる。

## 尺度を揃えるなら何が動くか（材料。揃える直しはしていない。オーナーの領分）【判断】

- **前提**: 揃える向きは、決まっていない。向きの案は2つある。(1) trigram の日本語側を tsvector と同じ「語ごとの 1/n」に寄せる（日本語を語に分ける必要があり、`word_similarity` の項は1つの連なりなので、分け方が要る）。(2) trigram の日本語側を連続値（`word_similarity` そのもの、または閾値で割ったもの）にする。**どれもオーナーの判断である。**
- **`score.total` への効き方**: `affinity = max(similarity, lexicalMatch)`、`total = affinity × decay × tagMatch × freshness × strength`。
  - **語彙だけが引いた候補**（`similarity` が無い）は `affinity = lexicalMatch`。trigram の日本語側が当たった候補は、`word_similarity` が 0.3 でも 1.0 でも `affinity = 1`。(2) にすると、この候補の `total` は `ws` の分だけ下がる（上の表の `東京タワーに行った` は 1 → 0.6667、`東京駅` は 1 → 0.3333）。**日本語の語彙だけの候補が、ANN の候補（`similarity` は 1 未満）を上回る場面が減る。**
  - **ANN も語彙も引いた候補**は `max(similarity, lexicalMatch)`。ANN の `similarity` が 0.6 の候補は、日本語側が当たると `affinity = 1` に押し上がる。(2) にすると `max(0.6, ws)` で、`ws` が 0.6 を超えたときだけ上がる。
  - tsvector・InMemory 側を動かす案（語が1つでも当たれば連続値にする、など）は、`k/n` の段階がなくなる。複数語クエリの順位への効きは測っていない。(1) の向きなら、日本語の複数語は 1/n 刻みになり、上の `東京 大阪` で `東京` だけの本文は 1/2 になる。
- **順位が動く入力**（上の表から。尺度を変えると変わる）: ①日本語を含む語彙クエリ（trigram の coverage 1 が段階になる）。②ASCII と日本語の混在（`alpha beta gamma 東京` で、日本語に当たるだけの本文が `alpha beta gamma` と並ぶ位置）。③同点の並び（store 間で逆になる単語1つのクエリ）は、coverage の尺度ではなく `rank` の尺度の違いなので、coverage を揃えても動かない。**`rank` を揃えるのは別の話**（`rank` はスコアに入らず、`limit` の窓と同点の並びにしか効かない）。
- **動かないもの**: ASCII の coverage（3つの store とも `k/n` で同じ）。`retrievedVia`・合流の規則・ADR 0084 の表。
- 【未確認】実際の `similarity`（埋め込み provider）の分布に対して、上の `total` の変化が recall の質をどう動かすかは測っていない（実 provider を使っていない）。

## 決定（線の内側＝歯・文書だけ。コードの振る舞いは変えていない）

1. **歯**: `packages/postgres/src/__tests__/lexical-coverage-scale-0553.postgres.test.ts`。3つの store（InMemory・tsvector・trigram）を同じ入力で当てる。InMemory を postgres のテストから使うのは、`lexical-query-inner-quote.postgres.test.ts` と同じ形（`@mnemora/testkit/fixtures`）。SQL_ASCII の leg では trigram の `create()` が拒まれるので（ADR 0319）、その組では拒否だけを確かめる。
2. **固定したもの**:
   - 式から決まる値: tsvector・InMemory・trigram の ASCII 側の `k/n`（3語中2語なら `2/3`、4語中3語なら `3/4`、語数 n = 1〜4 × 本文の語の部分集合15通り）、クエリの同じ語の繰り返しが1語と数えられること、本文の繰り返しが coverage に効かないこと、部分一致・大文字小文字、trigram の日本語側の 0/1、日本語の複数語が語ごとに数えられないこと、閾値の前後で 0 と 1 が入れ替わること（`alpha 東京タワー` が 1 ↔ 1/3、`東京タワーに行った` が返る ↔ 返らない）、閾値がちょうど 1 でも同じ文字列が coverage 1 であること（比較が `>=` であること）。tsvector・InMemory は日本語を引かず、混在クエリでは日本語が分母にも分子にも入らないこと。
   - 性質: 当たる語が増えても coverage は減らない、返り値は `(coverage DESC, rank DESC)` の順（`rank` の値は見ない）、値域 `(0, 1]`、同点が出る所（単語1つのクエリ、日本語側）、coverage が rank より先に効くこと。
3. **固定しなかったもの**: `rank` の実数、`word_similarity` の実数、同点の中の並び（`rank` が決める。store の版で揺れうる）、tsvector と InMemory の同点の並びが逆になること。閾値の前後の入力は `word_similarity` が閾値から 0.15 以上離れる本文を選び、その前提を測る it（「前提検査」）を置いた（揺れて前提が崩れたとき、coverage の食い違いより先にこの it が赤くなる）。**表の中で閾値に近い値（ws=0.3333 と 0.3）は、歯に入れていない**。
4. **TSDoc**: `PostgresLexicalStore`・`PostgresTrigramLexicalStore`・`InMemoryLexicalStore` のクラス doc と、core の `LexicalHit.coverage` に、尺度と ADR 0553 への参照を足した（コメントのみ）。`docs/architecture.md` の語彙チャンネルの節に1行足した。
5. **core の `FakeLexicalStore`**（`packages/core/src/__tests__/runtime-fakes.ts`）は InMemory と同じ式である。測る対象には入れていない。
6. **尺度を揃える直しはしていない**（オーナーの領分）。**コードの振る舞いは1行も変えていない**。足したのは新しいテスト・TSDoc のコメント・md だけ。

## 変異試験【実測】

`cp` で退避し、変異を入れ、`vitest run src/__tests__/lexical-coverage-scale-0553.postgres.test.ts` を走らせ、`cp` で戻した（戻した後は 38 本全部緑、`git status` はこの PR の差分だけ）。DB に入る SQL 関数は変えていない（`search` の SQL は TS ファイルの中。変異はすべて TS ファイルの編集）。

| # | 変異 | 結果 |
|---|---|---|
| a1 | `lexical-store.ts` の coverage の分母 `NULLIF(count(*), 0)` を `NULLIF(count(*) + 1, 0)` | 38 本中 11 本が赤（tsvector の ASCII の it 8 本〔語数 n = 1〜4 の部分集合、3語・4語の `k/n`、単語1つの同点、部分一致、繰り返し、本文の繰り返し、大文字小文字〕、tsvector の日本語混在 2 本、tsvector・InMemory・trigram の混在を回す「日本語側が当たれば…」）。trigram・InMemory の ASCII の it は緑のまま（別の式） |
| a2 | `lexical-store.ts` の `count(*) FILTER (` を `FILTER (WHERE true OR` に（`FILTER` を外した形。数えるのが全語になる） | 12 本が赤（上と同じ ASCII の it 8 本に、tsvector の「日本語だけのクエリは1件も返さない」、混在 2 本、「日本語側が当たれば…」） |
| b1 | `trigram-lexical-store.ts` の `search` の `THEN 1 ELSE 0 END` を `THEN word_similarity(…) ELSE 0 END` | 5 本が赤（「閾値を超えた本文は…coverage 1（同点）」「閾値を下げても coverage は 1 のまま」「日本語の複数語は語ごとに数えない」「ASCII と日本語の混在…入れ替わる点」「日本語側が当たれば…」。実際の失敗: 0.6667 や 0.5 が 1 でない） |
| b2 | 同じ比較 `>= ${opts.threshold}` を `>` に | 1 本が赤（「閾値がちょうど 1 でも、同じ文字列は coverage 1」）。**他の it は、閾値から離れた入力を使っているので緑のまま**（`>=` と `>` の差は、ちょうど等しい値でしか出ない。閾値が 1 で同じ文字列、という ws が厳密に 1.0 になる入力で、それだけを縛った） |
| b3 | 同じ比較を `<` に | 7 本が赤（日本語側の it のほとんど） |
| b4 | `trigram-lexical-store.ts` の ASCII 側 `FILTER (` を `FILTER (WHERE true OR` に | 15 本が赤（trigram の ASCII の it 8 本、日本語側・混在の it 7 本） |
| c | `in-memory-lexical-store.ts` の `matched / phrases.length` を `matched / (phrases.length + 1)` | 11 本が赤（InMemory の ASCII の it 8 本、InMemory の混在 2 本、「日本語側が当たれば…」） |

【確かめていないこと】`ORDER BY` の変異（`rank` を `coverage` より先にする）は入れていない。「coverage が rank より先に効く」の歯（`alpha alpha beta` の先頭が `alpha beta`）は、`rank` が逆向きの入力を使っているが、`rank` の値に依存する前提検査は置いていない（Postgres の版で `rank` の大小が変われば、この歯は「噛まない」だけで、赤にはならない）。

## 探した形の一覧

- 当てた形: ASCII の語数 1〜4 × 本文の語の部分集合（15 通り）、部分一致、同じ語の繰り返し（クエリ・本文）、大文字小文字、日本語（1語・複数語、閾値 0.1／0.3／0.9／1）、ASCII と日本語の混在（閾値の前後）、tsvector・InMemory が日本語を引かないこと。
- 当てていない形: `limit` を絞ったときの並び、`filter` との組み合わせ、`rank` の値の揃い方、非 ASCII でも日本語でない言語（ハングルなど）、日本語の文が長いときの `word_similarity` の振る舞い、`LEFT(…)` の文字数上限（ADR 0364・0367 の領分）、SQL_ASCII のクラスタでの trigram（`create()` が拒むので対象外。ADR 0319）、`PostgresTrigramLexicalStore` の `threshold` に 0 を渡したとき。

## 検討した代替案

1. **`rank`・`word_similarity` の実数を歯で固定する。** 採らなかった。Postgres・pg_trgm の版で揺れうる値であり、揺れで歯が割れる（割れた理由が coverage の食い違いではなくなる）。値は表に「測った値」として環境の版と共に残した。
2. **尺度を揃える直しも一緒にする。** 採らなかった。尺度を揃えるかどうか、どちらへ寄せるかは、`score.total` の順位が動く設計の変更で、オーナーの領分（ADR 0484 の覆る条件も、2つの store を同じ尺度に揃えると決めたとき）。
3. **core の `FakeLexicalStore` も測る。** 採らなかった。InMemory と同じ式で、同じ入力では同じ値になるはずだが、そう読めるのはコードを読んだ範囲である（測っていない）。

## 引き受けた負債（材料）

| # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
|---|---|---|---|---|---|
| 1 | trigram の日本語側は 0/1 の二値で、`word_similarity` の高さが `score.total` に出ない | 上の表（`東京`） | ws=0.6667 と 1.0 が同じ `lexicalMatch` = 1。ASCII の語数 n に依らず、日本語に当たるだけで coverage 1 | 低 | オーナーが尺度を揃えると決めたとき |
| 2 | tsvector と InMemory で、同点の並びが逆になる | 上の表（`alpha`） | `rank` の尺度が違う（`ts_rank_cd` と頻度の和） | 低 | InMemory を `ts_rank_cd` に近づけると決めたとき（`rank` の doc は「比較できない」としている） |
| 3 | 日本語の複数語を、語ごとに数えない | 上の表（`東京 大阪`） | 1つの項として扱うので、どちらか1語に当たるだけで 1 になりうる | 低 | 同上 |
| 4 | 閾値の近傍（ws が閾値の ±0.05 以内）の本文の coverage は、歯で縛っていない | 上の表（ws=0.3333） | pg_trgm の版で `word_similarity` が動くと、閾値付近の本文が返る・返らないが入れ替わる | 低 | pg_trgm の更新 |

## これが覆るとしたら

3つの store の coverage の式のどれかを変えると決まったとき（歯が赤くなる）。尺度を揃えると決まったとき（この ADR の表と対応のまとめを書き直す。ADR 0484 の負債1を閉じる）。

## 測っていないこと

PostgreSQL 17 以外、pg_trgm 1.6 以外、`C.UTF-8` 以外のロケール（SQL_ASCII では trigram が使えない。ADR 0319）、実際の埋め込み provider の `similarity` に対する `score.total` の変化、大きなデータでの `rank` の振る舞い。
