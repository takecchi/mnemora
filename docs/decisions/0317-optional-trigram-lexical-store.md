# ADR 0317: 日本語の語彙照合を、opt-in の `PostgresTrigramLexicalStore`（pg_trgm）として足す — Issue #278 への回答

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この ADR を書いているのは、マネージャー（クローンのセッション）から切り出された
> 作業者（クローン miku）である。⛔ オーナー本人（takecchi）の決定ではない。**
> 投稿者欄・commit の著者欄が誰であっても、それだけでは人間かクローンかを区別しない
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
>
> **Issue #278 の棚卸しコメントは、この Issue を「E: 判断が要る」——製品・事業判断
> （日本語の想起にどこまで投資するか）を含みうる——に分類している。**この ADR が答えるのは
> **「opt-in の形（在れば効く／無ければ機能が縮むだけ）でなら、技術的に足せるか」だけ**
> であり、「日本語の想起にどこまで投資すべきか」という E 分類そのものへの答えではない。
> **opt-in にした理由そのものが、この境界線を守るための設計判断である**（下記「文脈」）。

**⚠ 各主張の出所を分ける**（ADR 0084 / ADR 0149 / ADR 0316 の体裁を踏む）。

- **【実測】** — この作業者が自分の手で、`docs/autonomy.md` §2 の `initdb` 手順で
  自分専用に立てた PostgreSQL 17（UTF8/`C.UTF-8` の1系統、SQL_ASCII/`C` の1系統。
  ポート 55701/55702、`/tmp` 配下、port 5432 は使っていない）に対して実際に走らせた。
  **本番ではない。**
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — マネージャーの指示・Issue 本文・過去の ADR の記述を、報告として受け取り、
  この ADR の作業者は再導出していない。

---

## 文脈

[Issue #139](https://github.com/takecchi/mnemora/issues/139) → [ADR 0084](./0084-lexical-recall-channel.md) →
[ADR 0149](./0149-japanese-lexical-no-required-extension.md) の系譜が、「日本語の語
（人名を含む）は語彙チャンネルで引けない」という負債を明示のまま残し、
「`REQUIRED_EXTENSIONS` を増やさない」という決定と引き換えに follow-up
[Issue #278](https://github.com/takecchi/mnemora/issues/278) を立てた。

**Issue #278 が「採るなら必ず同時に要る」と明示した条件は2つ**:

1. 任意の拡張として使えるようにする(必須にしない)。
2. **`pg_trgm` が `C` ロケールのクラスタで日本語のトライグラムを黙って空にする**
   （[ADR 0084](./0084-lexical-recall-channel.md) §3.2）という「静かな0件」を潰す機構を
   同時に持たせる。

この ADR は、この2条件を満たす形で `packages/postgres` に
**`PostgresTrigramLexicalStore`** を追加した記録である。

---

## 決めたこと

1. **`packages/postgres/src/trigram-lexical-store.ts` に新規クラス
   `PostgresTrigramLexicalStore` を足す。**`LexicalStore`（`@mnemora/core`）を実装する
   **別クラス**であり、`PostgresLexicalStore`（既定の実装）は**1バイトも変更していない**
   （`git diff` で確認可能。`lexical-store.ts` は触っていない）。
2. **生成は非同期ファクトリ `PostgresTrigramLexicalStore.create(db, opts?)` を経由する。**
   `pg_trgm` が (i) 拡張として使えるか、(ii) 現在の DB のロケール／エンコーディングで
   日本語のトライグラムを実際に作れるかを実行時に検査し、どちらかがダメなら
   `TrigramLexicalStoreUnavailableError`（接頭辞定数
   `TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX`。ADR 0084 §4.2 の
   `LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX` と同じ作法だが、**別の失敗の族**なので
   別の定数にした——詳細は `trigram-lexical-store.ts` のクラス doc）を投げる。
   判定は `probeTrigramLexicalSupport(db)` という純粋な値返却関数としても公開する
   （「なぜ使えないか」を `reason` として分類する。§測定の表を見ること)。
3. **ASCII の識別子は既定経路と同じ意味を保つ**——`migrations/0008`/`0009` の SQL 関数
   （`mnemora_lexical_normalize`/`mnemora_lexical_query_or`/`mnemora_lexical_coverage`）を
   **1文字も書き換えず、そのまま呼ぶ**。日本語（非 ASCII）部分は pg_trgm の
   `word_similarity` で照合し、ASCII 側の coverage と `GREATEST`（max）で合成する
   （§照合方式の設計を見ること——最初は「分子/分母を足す」形にしたが、これは ASCII の
   coverage を薄める実バグを生み、パリティの歯自身が検出した）。
4. **決定的な全順序のタイブレークを保つ**——`coverage DESC, rank DESC, recorded_at DESC, id`
   の4段（[ADR 0175](./0175-lexical-search-tiebreak-nondeterminism.md)）。
5. **番号付き migration を足していない。**`pg_trgm` の `CREATE EXTENSION` は
   `probeTrigramLexicalSupport`（`.create()` の内部）が呼ばれたとき、つまり**導入側が
   明示的に opt-in したときだけ**発行される。`REQUIRED_EXTENSIONS`
   （`packages/postgres/src/migrate.ts`）は変更していない。索引（性能向上のためだけの
   `gin_trgm_ops` GIN 索引）は `createOptionalTrigramIndex(db)` という**別の口**に分けた
   ——`.create()` は呼ばない。
6. **`examples/chat` に `MNEMORA_LEXICAL_STORE=trigram` を足した**
   （`runtime-factory.ts` の `selectLexicalStoreMode`）。**未設定・空文字は今日どおり
   `PostgresLexicalStore`。**

---

## 照合方式の設計 — 実測して選んだ

### 1. 【実測】pg_trgm はロケール／`server_encoding` に強く依存する

自分専用の2クラスタ（`initdb --locale=C.UTF-8 --encoding=UTF8` と
`initdb --locale=C --encoding=SQL_ASCII`、PostgreSQL 17）で:

| server_encoding / locale | `CREATE EXTENSION pg_trgm` | `word_similarity('田中さんが会議に参加します', 同一文字列)` |
|---|---|---|
| UTF8 / `C.UTF-8` | 通る | **1**（自己一致が成立） |
| SQL_ASCII / `C` | **通る**(拡張自体は入る) | **0**（トライグラムが1つも作れない） |
| UTF8 / `C`（同一クラスタに `CREATE DATABASE ... ENCODING=UTF8 LOCALE=C` で追加検証） | 通る | **0** |

**⟹ `CREATE EXTENSION` が通ることは、日本語のトライグラムが作れることを何も保証しない。**
3行目([ADR 0084](./0084-lexical-recall-channel.md) §3.2 が最初に見つけた「`C` ロケールで
黙って0件になる」の再現)は `server_encoding` の1軸検査だけでは捕まえられない
——**この ADR が `probeTrigramLexicalSupport` に自己一致検査（同一の日本語リテラル同士の
`word_similarity` が1になるか）を持たせた理由そのものである。**

⚠ **追加で分かったこと**: 手元の `C.UTF-8`（Debian の合成ロケール）では、
`show_trgm('田中さん')` が `{0x8cb508, ...}` のような16進表示になる——
[ADR 0084](./0084-lexical-recall-channel.md) §3 が conda-forge の `C.utf8` で見た読める
表示（引用形式）とは異なる。**この ADR はこの違いの原因を特定していない**
（グリフ単位かバイト単位かの違いだと推測しているが、確かめていない）。
**ただし、自己一致検査（同一文字列同士の `word_similarity` が1になるか）と、実際の
人名マッチ（下記§3）は、どちらもこの環境で正しく機能した**——表示形式の違いは
機能の違いを意味しない、という以上のことは主張しない。

### 2. 🔴 【実測】自然文の質問では、機能語のトライグラムが雑音になる

自然文の問い「田中さんについて何か言ってましたか」を素の `word_similarity(query, content)`
に渡すと、「田中さん」を**含まない**文にも高いスコアが付く:

| content | 素の word_similarity |
|---|---|
| target: `田中さんが来週から新しいプロジェクトに参加します`(田中さんを**含む**) | 0.222 |
| noise: `来週の予定について何も聞いていません`(**含まない**) | 0.167 |
| noise: `先月のミーティングについて詳しく説明しました`(**含まない**) | 0.115 |

**⟹ target と noise の差はわずか 0.055〜0.107 で、固定閾値で安全に切り分けられない。**
「について」「ました」のような機能語が、自然文の質問のトライグラムの大半を占めるためである。

### 3. ⟹ 緩和策: 小さく非網羅的な語尾リストで機能語を削る

`TRIGRAM_NOISE_STOPWORD_PATTERN`（`trigram-lexical-store.ts`)——「について」「ましたか」
「でしょうか」等、質問文に頻出する語尾・助詞を正規表現の選言で削るだけの、
**キュレーションした固定リスト。形態素解析器ではない。**

削った後、同じ4文で測ると:

| content | 語尾を削った後 |
|---|---|
| target(田中さんを含む) | **0.400** |
| noise(田中さんを含まない、2件とも) | **0.000** |

**⟹ この実測4件では、閾値 0.3(`DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD`)が
target を通し noise を通さない。** サンプル数は小さい(人手で作った4文)。
**一般化を主張しない**——「良く出る質問の型」から外れた言い回しでは、この閾値が
同じように機能する保証はない(下記「確かめていないこと」)。

### 4. 🔴 【実測】最初の実装は「分子/分母を足す」形にしていたが、ASCII パリティを壊した

最初の `mnemora_trigram_hybrid_coverage` は、ADR 0092 の「一致した語彙数 ÷ クエリ語彙の
総数」を、日本語側の1項をそのまま足す形で拡張していた。これは
`trigram-lexical-store.postgres.test.ts` の「ASCII 部分の意味論は既存経路と一致する」歯
**そのもの**が赤くなって発覚した——「`PROJ-1234について前に何か言ってたはず`」
(Issue #106 の報告者の逐語)に対し、`PostgresLexicalStore` は `coverage = 1`
(ASCII 語1つが一致、分母1)を返すが、最初の実装は日本語側の残り
「前に何か言ってたはず」を分母に**追加してしまい** `coverage = 0.5` になった。

**⟹ 採用した式は [ADR 0084](./0084-lexical-recall-channel.md) §5 が
`similarity`/`lexicalMatch` を合成するのに使った `affinity = max(...)` と同じ形
(`GREATEST`)である。**ASCII 側は `mnemora_lexical_coverage`(migrations/0009 の関数)を
**そのまま呼ぶ**(独自に書き直さない)——ASCII クエリのとき、日本語側の項は存在しない
(`NULL`)ので `GREATEST(ascii側, 0) = ascii側` となり、`PostgresLexicalStore` と
**完全に同じ値**になる。この設計変更は
`packages/postgres/src/__tests__/trigram-lexical-store.postgres.test.ts` の
「UTF8 leg: ASCII 部分の意味論は既存経路(`PostgresLexicalStore`)と一致する」歯で
固定してある。

### 5. 【実測】GIN 索引は演算子形(`%>`)でだけプランナに選ばれる、関数呼び出し形では選ばれない

20,000行(うち1行だけが日本語人名を含む)の表に `USING gin (tenant_id, content
gin_trgm_ops)` を張り、`SET pg_trgm.word_similarity_threshold = 0.3` の下で
`... WHERE tenant_id = $1 AND status IN (...) AND content %> $2` を `EXPLAIN` すると
`Bitmap Index Scan`(`tenant_id`/`content` の両方が `Index Cond`)が選ばれた。
**⟹ 実装の `WHERE` 句は演算子形(`content %> $ja`)にしてある**——`word_similarity(...)
>= threshold` という関数呼び出し形では、この索引は選ばれない(pg_trgm のドキュメント通り)。

`SET`/`SET LOCAL` は PostgreSQL の文法上バインドパラメータを取れない(構文エラーになる。
この作業で実際に踏んだ)ため、`threshold` は `create()` で `[0, 1]` へ検証済みの値を
リテラルとして埋め込んでいる。`SET LOCAL` はトランザクション内でしか効かないため、
`search()` は `db.transaction()` で同一接続を保証してから発行する。

**⚠ EXPLAIN ANALYZE(秒単位の実行時間差)は測っていない**——プランがビットマップ索引
スキャンに変わることまでは実測したが、索引の有無による実際の速度差は確かめていない。

---

## `retrieval` ベンチでの実測 — 既定 vs trigram

**測定方法**: `examples/chat` の `retrieval` サブコマンドを、`MNEMORA_PROVIDER_SOURCE=recorded`
(記録済みカセット `examples/chat/cassettes/retrieval.json` を再生。**書き換えていない**、
**実 API を叩いていない**)、`MNEMORA_BENCH_CHANNELS=ann,lexical` で2回走らせた
——1回は `MNEMORA_LEXICAL_STORE` 未設定(既定)、もう1回は `MNEMORA_LEXICAL_STORE=trigram`。
自分専用の PostgreSQL(UTF8/`C.UTF-8`、上記と同じインスタンス)に対して実行した。
**この2回の実行は本 ADR の作業者が自分の手で行った(【実測】)。**

### 結果: 既定は3 arm とも `lexicalMatchRows = 0`(ADR 0294 の再確認)

| arm | lexicalMatchRows(既定) | lexicalMatchRows(trigram) | MRR(既定) | MRR(trigram) |
|---|---|---|---|---|
| A(擬似LLM+擬似埋め込み) | 0 | 0 | 0.018 | 0.018 |
| B(擬似LLM+本物埋め込みの再生) | 0 | 0 | 0.714 | 0.714 |
| C(本物LLM+本物埋め込みの再生) | 0 | **1** | 0.738 | **0.738**(変化なし) |

**⟹ [ADR 0294](./0294-lexical-tie-density-bench.md) が「`retrieval` ベンチの probe 7件
(全件日本語自然文)は語彙チャンネルにとって候補数0件」と測った状態は、既定の
`PostgresLexicalStore` では今も変わらない。** `PROBES`(`examples/chat/src/probe-set.ts`)は
**意図的に** fact と query が内容語を共有しないよう設計されている
(`lexicalControl: true` の `color` 1件を除く)——そのため語彙的照合(ASCII/pg_trgm を
問わず)がそもそも効く余地がほとんど無い。**これはこの実装の欠陥ではなく、この bench の
設計そのものが語彙的重なりを排除しているためである。**

### 🔴 arm C だけ `lexicalMatchRows` が 0 → 1 に動いた — 具体的に何が起きたか

**arm C は本物の LLM(記録の再生)による抽出を経るため、保存される `content` が
台本のままではなく LLM のパラフレーズになる**(例: `私の好きな色は青です。誕生日は
4月3日です。` → `好きな色は青である。`)。この短い文に対し:

```
mnemora_trigram_hybrid_coverage('好きな色は青である。',
  'ところで、わたしの好きな色を覚えていますか?', 0.3) = 1   -- gold
mnemora_trigram_hybrid_coverage('妹の好きな色は緑',
  'ところで、わたしの好きな色を覚えていますか?', 0.3) = 0   -- distractor
```

**gold は一致し、distractor は一致しない**——雑音削り(§緩和策)が意図どおり機能した
具体例である。console 出力でも `total` が `0.674350`(既定、ANN の similarity のみ)から
`0.999999`(trigram、`affinity = max(similarity 0.674, lexicalMatch 1)` で decay がほぼ1)
に上がったことを確認した。

**⚠ ただし最終順位(`goldRank`)は既定でも trigram でも `1`(不変)である**——この probe は
ANN だけで既に gold が1位だったため、trigram の寄与は「同じ結論を、別の経路でも支持した」
にとどまる。**「ANN が僅差で distractor を上に置くケースで trigram が逆転を救うか」は
確かめていない**——この実測の中ではそのような状況が1件も起きなかった。

### 悪化は観測されなかったが、確かめた範囲は狭い

7 probe × 3 arm の全21通りで `goldRank`/`hit@1`/`hit@10`/`distractorBeatsGold` を
既定と trigram で突き合わせ、**1件も変化していない**(`color` の arm C だけスコアの内訳が
変わったが、順位は変わらない)。**⟹ 悪化は無かった、と言える範囲はこの21通りに限られる。**
より広いコーパス・より多様な自然文の質問での悪化の有無は測っていない。

---

## 採らなかった代替案

- **`word_similarity` の閾値を0(何でも通す)にする。** **採らない**——
  `DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD` を0にした変異試験
  ([歯]/`trigram-lexical-store.postgres.test.ts` の「閾値を上げると…減る」歯)で、
  閾値0だと機能語ノイズだけを共有する記憶まで拾ってしまうことを確認済み。
- **ASCII 側と日本語側の被覆率を「分子/分母を足す」形で合成する。** **採らない**
  (§照合方式の設計4番)——ASCII パリティを壊す実バグを生んだ。`GREATEST`(max)を採用。
- **`buildLexicalSearchSelect`(`lexical-store.ts`)を共有ヘルパーへ切り出して再利用する。**
  **採らない。**切り出すと `lexical-store.ts` の diff が増え、「既定を変えない」ことを
  確認するレビュー面積が広がる。**フィルタ条件の組み立てを独立に複製した**——
  複製の負債(両者が将来ずれる可能性)は引き受けた(下記「引き受けた負債」)。
  ⭐ **これは筋の良い将来のリファクタだと考える**——両者が安定したら、いつか
  `buildLexicalWhereConditions`(仮)のような形に括り出す価値があるかもしれない。
  この PR では見送った。
- **`.create()` の中で `createOptionalTrigramIndex` も自動的に呼ぶ。** **採らない**——
  `memories` は行数が大きくなりうるため(`docs/roadmap.md` §5)、索引作成
  (`ACCESS EXCLUSIVE` ロックを伴いうる)を「store を使い始める」という操作に
  強制的に紐付けない。呼び出し側が別途、自分のタイミングで呼ぶ。
- **SQL_ASCII/C ロケールでも ASCII 部分だけは動かす。** **採らない**——`.create()` は
  regime 全体を弾く(all-or-nothing)。理由: SQL_ASCII 運用者は base
  `PostgresLexicalStore` で ASCII を既に(regime に依らず、ADR 0103)使えるため、
  この opt-in store をわざわざ選ぶ理由が無い。分岐を複雑にするだけの価値が無いと判断した。
- **形態素解析器・辞書ベースの分かち書きを追加する。** **検討していない**——
  ADR 0149「これが覆るとしたら」が指す「拡張なしで分かち書きを持てるようになったとき」
  の条件が今回変わったわけではなく、この PR の射程外(pg_trgm という既存拡張の
  opt-in 化)に留めた。

---

## 引き受けた負債

- **`buildTrigramLexicalSearchSelect` のフィルタ条件が `buildLexicalSearchSelect`
  (`lexical-store.ts`)の複製である。** 片方に新しいフィルタ欄(`LexicalFilter`)が
  増えたとき、もう片方への反映を機械が強制しない——歯(ASCII パリティ歯)は「既存の
  欄が同じ意味を持つこと」までしか検査せず、「新しい欄が増えたことに気づく」ことは
  検査していない。
- **`TRIGRAM_NOISE_STOPWORD_PATTERN` は非網羅的なキュレーションリストである。**
  この PR が測った質問の型(「〜について何か言ってましたか」「〜はどんなものでしたか」
  等)から外れた言い回しでは、機能語が削り切れずに残り、§2 の雑音問題がそのまま
  再発する可能性がある。
- **`word_similarity` の閾値 0.3 は、4文+7 probe という小さいサンプルから選んだ。**
  一般のコーパスでの精度・再現率は測っていない。
- **`show_trgm` の表示形式の違い(バイト単位風の16進表示)の原因を特定していない。**
  機能はこの環境で正しく動いたが、原因不明のまま残った観察である。
- **索引の実際の速度差(EXPLAIN ANALYZE)を測っていない。**プランが変わることだけを
  確認した。

---

## これが覆るとしたら

- **`TRIGRAM_NOISE_STOPWORD_PATTERN` が実運用の質問の型を十分にカバーしないと分かったとき。**
  リストを増やす・別の方式(例: ストップワード除去済みの tsvector 'japanese' 設定を
  組み合わせる)に切り替えるかを再検討する。
- **`DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD = 0.3` が、実際のコーパスで
  偽陽性/偽陰性のどちらかに寄りすぎると分かったとき。**この ADR の値は4文+7 probe の
  実測に基づく暫定値であり、[ADR 0254](./0254-no-gate-without-a-false-positive-ceiling.md)
  が求める「偽陽性率に上限を置ける」水準の実測ではない。
- **`buildTrigramLexicalSearchSelect` と `buildLexicalSearchSelect` が実際にずれて
  実害を出したとき。**共有ヘルパーへ切り出す判断を再考する。
- **PostgreSQL 本体または拡張の追加なしで日本語の分かち書きが手に入ったとき。**
  ADR 0149「これが覆るとしたら」と同じ条件——この ADR の前提(拡張ベースの照合)
  そのものが変わる。
- **Issue #278 の E 判定(製品・事業判断)について、オーナーが方向を示したとき。**
  この ADR は opt-in という形でその判断を必要としない範囲に留めたが、
  「日本語の想起にどう投資するか」自体の答えではない——オーナーの判断が
  この opt-in の扱い(標準に格上げする/このままにする/別方式に置き換える)を変えうる。

---

## 測ったこと

- **【実測】** 上記の全ての表・数字は、この作業者が自分の手で自分専用の PostgreSQL に
  対して実行して得た(`docs/autonomy.md` §2 の `initdb` 手順、port 55701/55702、
  `/tmp/mgr-e8f4/pgwork` 配下。**共有ポート 5432 は使っていない**)。
- **【実測】** `packages/postgres/src/__tests__/trigram-lexical-store.postgres.test.ts`
  (新規)を、UTF8 leg・SQL_ASCII+C leg の両方の DATABASE_URL に対して実行し、
  4 tests × 2 leg = 8 とも通ることを確認した。
- **【実測】** 変異試験(`docs/autonomy.md` §2)——(a) coverage の合成式を「分子/分母を
  足す」形に戻すと、UTF8 leg の一部の歯が赤くなること、(b) 日本語側の `WHERE` 条件を
  `AND false` で無効化すると、UTF8 leg の該当する歯が赤くなること、(c)
  `server_encoding_not_utf8` の早期判定を無効化すると、SQL_ASCII+C leg の全4 tests が
  (期待する `reason` の値が変わるため)赤くなり、かつ `locale_no_japanese_trigrams` で
  正しく弾かれ続けること(2段目の検査が効いていることの確認)——をそれぞれ確認し、
  元に戻して緑に戻ることまで確認した(`cp` での退避・復元、`git checkout` は使っていない)。
- **【実測】** `lexical-store-reporter-questions.test.ts`(歯6を含む8本)を UTF8 leg で
  実行し、全8本が変わらず通ることを確認した——`PostgresLexicalStore` の挙動(歯6を含む)
  は1バイトも変わっていない。
- **【実測】** `examples/chat` の `retrieval` を、既定/`trigram` の2条件 ×
  `MNEMORA_PROVIDER_SOURCE=recorded` で実行し、`MNEMORA_RETRIEVAL_JSON` で書き出した
  JSON(リポジトリには含めていない、`/tmp` 配下の一時ファイル)を突き合わせた。

## 確かめていないこと

- **一般のコーパスでの精度・再現率**(§引き受けた負債)。
- **索引の有無による実際の実行時間差**(EXPLAIN の計画が変わることだけを確認した)。
- **`show_trgm` の表示形式が環境ごとに変わる原因**。
- **`ANN が僅差で distractor を上に置くケースで trigram が逆転を救うか」**——
  この実測の中ではそのような状況が1件も起きなかった。
- **マネージド Postgres(RDS 等)で `pg_trgm` の `CREATE EXTENSION` 権限がどう扱われるか**
  ——`extension_create_denied` という reason は用意したが、実際にそのような環境で
  検査していない。
- **`examples/chat/src/identifier-probe-set.ts`/`japanese-name-probe-set.ts` 等、
  `retrieval` 以外の probe set への影響**——この ADR は `retrieval`(`probe-set.ts` の
  7 probe)だけを測った。
