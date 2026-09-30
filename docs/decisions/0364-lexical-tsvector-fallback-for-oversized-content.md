# ADR 0364: `idx_memories_lexical` の式に、tsvector が1MBを超える本文だけ先頭150,000文字へ縮退するフォールバックを挟む

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-29

**⚠ 各主張の出所を分ける。**

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で本物の PostgreSQL 17.11（`packages/postgres`
  の手順で立てた、自分専用のインスタンス）に対して確かめた。

---

## 問い（[Issue #1222](https://github.com/takecchi/mnemora/issues/1222)）

`idx_memories_lexical`（`migrations/0008_memories_lexical_index.sql`）は
`gin (tenant_id, to_tsvector('simple', mnemora_lexical_normalize(content)))` という式索引で、
`memories` への `INSERT`/`UPDATE` のたびにこの式を評価する。PostgreSQL の `tsvector` は、
語彙（lexeme）テキストの総バイト数が 1,048,575 バイト（`MAXSTRPOS`、20ビットの符号無し整数の
最大値）を超えられない——超えると `string is too long for tsvector`
（SQLSTATE 54000 `program_limit_exceeded`）を投げる。

語の多い本文（識別子や乱数語が多く、重複が少ない本文）はこの上限に触れうる。**触れると
`memories` への書き込みそのものが失敗する**——`observe()` の LLM 呼び出し失敗時の全文
フォールバック（`packages/core/src/extraction.ts` の
`fallbackWholeObservationCandidate`、「本文は1文字も落ちずに1件の Memory として残る」という
約束）が、`@mnemora/postgres` だけ守れなくなる。Observation と extract の outbox ジョブは
残るが、Memory は1件も書けない（PR #1224、commit `23f0076` が2026-09-27にこの今の振る舞いを
`docs/memory-model.md` §4・`extraction.ts` に書き、
`whole-observation-fallback-size.postgres.test.ts` で縛った）。

**⟹ 直すかどうかではなく、どう直すかが問い。**委譲元（クローン miku）が方針をオーナーへ
確認済みで、本 ADR はその方針の実装を担う。

## 決めたこと

1. **plpgsql の IMMUTABLE 関数 `mnemora_lexical_tsvector(content text) RETURNS tsvector` を
   足す**（`migrations/0025_lexical_tsvector_fallback.sql`）。まず今までどおり
   `to_tsvector('simple', mnemora_lexical_normalize(content))` を試し、
   `program_limit_exceeded`（かつメッセージが `tsvector` 上限を指すとき）だけ、本文の
   **先頭150,000文字**（`left(content, 150000)`、文字数——バイト数ではない）で作り直す。
2. **`idx_memories_lexical` を `DROP` → 同じ列構成・同じ `WHERE` で
   `mnemora_lexical_tsvector(content)` を式にして `CREATE`。**（`CONCURRENTLY` 不可——
   `migrate.ts` がトランザクションで包むため。0008 と同じ立場。）
3. **recall 側の6箇所**（`lexical-store.ts:230,247,252` 相当、
   `trigram-lexical-store.ts:645,666,678` 相当）**とテストの書き写しを、すべて
   `mnemora_lexical_tsvector(content)` に揃える**——索引式とクエリ述語の左辺が
   ずれると索引が選ばれなくなる（0008「なぜ SQL 関数として切り出すか」と同じ理由）。
4. **`N = 150,000`。**理論上限と実測の両方で安全側であることを示す（下「N の実測」）。
5. **二段目（`left(content, 150000)` を通した後の `to_tsvector`）は、これ以上
   `EXCEPTION` で包まない。**理由は下「二段目を更に包まなかった理由」。

## N の実測

### 理論上限: 1文字あたり最大4バイト

**【実測】** この Postgres（17.11、`server_encoding=UTF8`、`datlocprovider=c`、
`datcollate=datctype=C.UTF-8`——`packages/postgres` の変異試験用インスタンスの既定と同じ
regime）で、`to_tsvector('simple', ...)` の大文字小文字畳み込みが、コードポイント全域
（BMP: `chr(1)`〜`chr(65535)`、サロゲートを除く。補助面: `chr(65536)`〜`chr(1114111)`
全域）でどれだけ1文字あたりのバイト数を変えるかを、`octet_length(chr(cp))` と
`octet_length(lower(chr(cp)))` の比で尽くした:

| 起源のバイト数 | 畳み込み後の最大バイト数 | 最大比 |
| --- | --- | --- |
| 1（ASCII） | 1 | 1.0（膨らまない） |
| 2 | 3 | **1.5**（`U+023A` Ⱥ→ⱥ・`U+023E` Ⱦ→ⱦ の2つだけ） |
| 3 | 3 | 1.0（膨らまない） |
| 4（補助面、全域） | 4 | 1.0（膨らまない。`chr(65536)`〜`chr(1114111)` の全域を
  総当たりし、比が1を超える例は無かった） |

`to_tsvector('simple', chr(570))`/`chr(574)` で、上表の2バイト起源の膨張が `to_tsvector`
自身（`lower()` と同じ表ではなく `to_tsvector` の内部畳み込み）でも同じ結果になることを
別途確認した（`'ⱥ':1`/`'ⱦ':1`、3バイト）。

⟹ **どんな1文字も、正規化・大文字小文字畳み込みを経て、高々4バイトしか tsvector の
語彙テキストへ寄与しない**（2バイト起源は最大1.5倍で3バイトに収まり、4バイト以下）。

これに、次の2つの事実を足すと、`LEFT(content, N)` を通した tsvector の語彙バイト総和は
**常に `4 × N` 以下**という無条件の上限になる:

- `mnemora_lexical_normalize`（`regexp_replace($1, '([[:ascii:]]+)', ' \1 ', 'g')`）は
  ASCII の連なりの前後に空白を足すだけで、**非空白文字を増減も複製もしない**（正規表現の
  置換先 `\1` は捕捉した文字列そのもの）。空白はトークナイザが捨てるので、tsvector の
  語彙バイトには寄与しない。
- `to_tsvector` のトークナイザ（同じ語の重複除去・2047バイトを超える語の破棄——
  【実測】「word is too long to be indexed / Words longer than 2047 characters are
  ignored」という NOTICE で確認済み）は、どちらも語彙バイト総和を**減らす方向にしか**
  働かない。

`N = 150,000` の理論上限は `600,000` バイト。1,048,575 バイトの上限の **57.2%**
（余裕 **42.8%**、448,575 バイト）に収まる。

### 実測: 混合した最悪本文

**【実測】** 大文字小文字畳み込みで膨らむ文字（`U+023A`/`U+023E`）・重複の無い補助面の
4バイト文字（CJK拡張B、`U+20000`台。実在する割り当て済みブロックを使い、割り当て未確定の
上位面は避けた——後者は `mnemora_lexical_normalize` を通した後段の挙動が本 PR の作業者の
手元で安定しなかったため測定対象から外した）・ASCII の数字（一意性のためだけに使う、
畳み込みで膨らまない）を混ぜ、**重複の無い語**からなる150,003文字の本文を組み立てて
`to_tsvector('simple', mnemora_lexical_normalize(...))` に通したところ、**例外にならず
成功し**、実際の語彙バイト総和（`tsvector_to_array` で語を展開し `octet_length` を合算、
`::text` のクォート等のオーバーヘッドを含まない生の値）は **257,148バイト**だった
（理論上限 600,000バイトの中に収まり、なお実際の上限より遥かに小さい——この本文の構造上
ASCII の数字部分が畳み込みで膨らまない分、理論上限まで届かない）。

### 【実測】文字数で切る素朴な案が実際に落ちた例

【実測】4バイト文字（CJK 統合漢字拡張B、`U+20000` 起点）2文字の語を ASCII 1文字で
区切って並べた、重複の無い語の本文は、**300,000文字**（900,000バイト）でも
`string is too long for tsvector (1216598 bytes, max 1048575 bytes)` で落ちる。
同じ本文を `mnemora_lexical_tsvector` に通すと例外にならず、先頭150,000文字での
作り直しに倒れる（`pg_column_size` 816,750バイト）。本文は次の式で組み立てた:

```sql
SELECT left(string_agg(chr(131072 + (i/20000)%20000) || chr(131072 + i%20000)
         || substr('abcdefghijklmnopqrstuvwxyz0123456789', i%36+1, 1), ''), 300000)
FROM generate_series(0, 99999) i;
```

⚠ 同じ構造を Plane 1（`U+10000`〜`U+1FFFF`）で組むと、846,082バイト（`::text`）で
例外にならなかった。Plane 1 には未割り当てのコードポイントや文字でないものが多く、
パーサがそれらを語として数えないため、語彙が小さくなったと見ている（確かめていない）。
**「文字数で切れば安全」は入力の作り方次第で破れる**——これが文字数で切る案を採らない
実測上の理由である。本 ADR が N=150,000 の安全性の根拠にしているのは、この例ではなく、
上の「理論上限: 1文字あたり最大4バイト」という、
コードポイント全域を尽くした無条件の上限である。

### 二段目を更に包まなかった理由

上の理論上限が示すとおり、`LEFT(content, 150000)` を通した2段目が
`program_limit_exceeded` を再び投げることは無い（本実装が正しく、この Postgres の
大文字小文字畳み込みの挙動が変わらない限り）。**それでも2段目を更に `EXCEPTION` で
包み、空の tsvector を返す形にはしなかった。**理由:

- 起こらないと証明した経路を握り潰すと、その証明が将来のどこかで崩れたとき
  （Postgres の大文字小文字畳み込みの変更・本 ADR が総当たりしていない前提——例えば
  ICU プロバイダでの `datlocprovider=i`——での新しい膨張文字の発見等）に、**静かに
  「語彙検索に一切引っかからない Memory」を作ってしまい、気づく手段が無くなる。**
- AGENTS.md「⚠ 機械には検出まで」の精神——機械（この関数）の役目は検出まで。想定外を
  黙って握り潰さず、例外として表に出す（＝ Issue #1222 の今の振る舞いへ戻り、INSERT が
  失敗する）ほうを選んだ。**これは「直っていない」ではなく「想定内の縮退はするが、
  想定外は今までどおり表に出す」という線引きである。**

## 実測: INSERT の遅延と索引の作り直し時間

**【実測】** 自分専用の Postgres（`bench_old`/`bench_new` という2つの最小テーブル
（`id`/`tenant_id`/`content`/`status` のみ）に、それぞれ旧式・新式の
`idx_memories_lexical` 相当の式索引を張り、同じ内容（日本語混じり・`PROJ-<n>` 識別子入り、
`i % 50 = 0` の行だけ英語の語を混ぜる——`lexical-store-index.test.ts` の
`seedManyMemories` と同じ考え方）を10万行 INSERT した所要時間を、`\timing` で3回ずつ
測った）:

| 測定 | 旧式（`to_tsvector('simple', mnemora_lexical_normalize(content))`） | 新式（`mnemora_lexical_tsvector(content)`） | 遅延 |
| --- | --- | --- | --- |
| INSERT 10万行（4回の平均） | 1381.6 ms | 1624.5 ms | **+17.6%** |
| 索引の作り直し（10万行、`CREATE INDEX`、3回の平均） | 978.1 ms | 1176.5 ms | **+20.3%** |

個々の生値（INSERT、ms）: 旧式 `1423.696, 1382.127, 1374.597, 1346.037` / 新式
`1627.003, 1571.243, 1656.306, 1643.555`。索引作り直し（ms）: 旧式
`963.056, 1027.032, 944.093` / 新式 `1190.522, 1158.332, 1180.679`。

⟹ **依頼文が見込んでいた「5〜15%遅くなる／10万行で約2.2秒」という目安とは、両方とも
実測値が異なる**（INSERT は目安の上限をやや超え、索引の作り直しは目安よりだいぶ速い
——この作業者の器のハードウェアに依存する測定であり、目安自体が別の器での実測または
推定だったと考えられる。**この ADR は実測値を正とする**）。plpgsql の関数呼び出し
オーバーヘッド（SQL 言語関数と違いインライン化されない、`EXCEPTION` ブロックの準備）が
主な要因と考えられるが、`EXPLAIN ANALYZE` でのプロファイルは取っていない
（確かめていないこと）。

## 検討した代替案

- **(a) 文字数で切る素朴な SQL 関数**（`LEFT(content, N)` を常に通す、`EXCEPTION` 無し）:
  却下。上の「【実測】文字数で切る素朴な案が実際に落ちた例」節のとおり、4バイト文字を使った入力では300,000文字でも
  tsvector が上限を超えうる——**文字数だけを基準にした固定の N は、入力の作り方
  次第で安全ではない。**本 ADR が採った案は「まず旧式のまま試し、*実際に例外が
  起きたときだけ*理論上限つきの N で作り直す」形であり、通常の本文（1MBに収まる
  本文）は1バイトも変えず、超えたときだけ**証明済みの安全域**（`4×150,000 ≤
  1,048,575`）へ縮退する——「文字数で切る」が却下された理由（安全性の根拠が無い）
  を、この ADR の案は理論上限で埋めている。
- **(a') 約690KB超なら先頭だけを入れる SQL 関数**（本文のバイト数を先に見積もり、
  閾値を超えたときだけ `LEFT` を通す）: 却下。**本文のバイト数と、その本文が生む
  tsvector のバイト数の関係は、圧縮率（重複語の割合・トークンの長さ）次第で大きく
  振れる**——依頼文にある「空白の無い日本語1.8MB」の例のように、極端に圧縮が効く
  本文（例えば同じ語が延々と繰り返される、あるいは2047バイトを超える巨大な1語が
  ほとんどを占める）は、入力バイト数が大きくても tsvector は上限内に収まりうる。
  入力バイト数だけを見て一律に閾値で切ると、**今は正しく全文が索引に入っている
  大きな本文の振る舞いを、根拠なく変えてしまう**（縮退させる必要が無いのに縮退
  させる）。本 ADR の案は「実際に tsvector を作ってみて、本当に上限を超えたときだけ」
  縮退するため、この過剰縮退が起きない。
- **strip()（識別子等の位置情報を捨てて縮める）**: 却下。`websearch_to_tsquery` の
  隣接演算子（`'proj' <-> '-1234'`、`migrations/0008`/`0009` の doc）に依存した識別子
  検索が、位置情報を落とすと成立しなくなる——「引ける」が「引けない」に変わる範囲を
  予測できない。
- **切り詰め（案1、無条件に本文自体を短くする）**: 却下。`memories.content` に保存する
  本文そのものを短くすると、「本文は1文字も落ちずに残る」という既存の約束
  （`extraction.ts` の doc）を破る。本 ADR は**索引だけ**を縮退させ、`memories.content`
  は無傷のまま全文を保存する。
- **入力拒否（案3、上限を超える本文を observe() の時点で拒む）**: 却下。全文フォールバックは
  「LLM が失敗しても Memory を1件は残す」という*安全弁*であり、その安全弁自体が
  「大きすぎる」という理由で入力を拒むと、安全弁が無かったことになる——今より
  悪い振る舞い（Observation すら受け付けない）になりかねない。

## 【実測】赤→緑

`origin/main`（`d7df706`）を別 worktree（`/tmp/mgr-fe127d54-red`、clone の外）に置き、
このブランチが新しく足した／書き換えたテストファイル5本
（`lexical-tsvector-fallback.postgres.test.ts`・
`whole-observation-fallback-size.postgres.test.ts`・`upgrade-from-released.postgres.test.ts`・
`lexical-store-identifier.test.ts`・`lexical-store-index.test.ts`）だけを写し、
同インスタンス内の別 DB（`mnemora_test_red`）に `origin/main` の migration（0025 無し）を
適用してから走らせた:

```
lexical-tsvector-fallback.postgres.test.ts        9 failed | 1 passed (10)
whole-observation-fallback-size.postgres.test.ts  2 failed（1.2MBの本文、observe()経由/createMemory直接の両方）
upgrade-from-released.postgres.test.ts            2 failed（v1.0.1/v1.0.2 いずれも「索引が0025の式」の歯）
lexical-store-index.test.ts                       ファイル全体が失敗（0025_*.sql が無くファイル読み込みで例外）
lexical-store-identifier.test.ts                  1 failed | 4 passed（書き換えた歯だけが失敗）
```

（`lexical-tsvector-fallback.postgres.test.ts` の残り1本——`PostgresLexicalStore.search`
の結果順位を旧式と比較する歯——は main でも緑になる。`PostgresLexicalStore` 自体を
main のまま写していないため、比較対象の「新関数側」も実質旧式のままで、この特定の
比較だけは赤緑を判別しない。ほかの9本が赤で示している。）

migration 0025 と `lexical-store.ts`/`trigram-lexical-store.ts` の変更を同じ worktree へ
コピーし、同 DB を作り直して migration を通し直すと、5ファイル・44本すべて緑になった。

## 【実測】変異試験

同じ worktree で、2つの変異を入れ、狙った歯だけが赤くなることを確認した（`cp` で退避・
`cp` で戻す。`git checkout` は使っていない）:

1. `mnemora_lexical_tsvector` の `EXCEPTION` 節を削除（フォールバックを外す）→
   DB を作り直すと、`whole-observation-fallback-size.postgres.test.ts` の1.2MBの本文の
   2本と、`lexical-tsvector-fallback.postgres.test.ts` の1本（トライグラム側の同種の歯）
   が赤くなった（3 failed | 15 passed）。`cp` で戻し、DB を作り直すと18本すべて緑に戻った。
2. `lexical-store.ts` の3箇所（`buildLexicalSearchSelect` の `WHERE`/`coverage`/`rank`）を
   旧式（`to_tsvector('simple', mnemora_lexical_normalize(content))`）へ戻す（索引は
   新式のまま）→ `lexical-store-index.test.ts` の EXPLAIN の歯が赤くなった
   （`idx_memories_lexical` を含むはずの実行計画に `Seq Scan on memories` が現れた——
   索引式とクエリ述語の左辺がずれ、索引が選ばれなくなったことを直接示す）。`cp` で
   戻すと緑に戻った。

## 引き受ける負債

- **`ACCESS EXCLUSIVE` での索引の作り直し。**`DROP INDEX` + 素の `CREATE INDEX`
  （`CONCURRENTLY` 不可）——0008 と同じ立場。行数が多い本番へ本 migration を当てるときは、
  上の実測（10万行で約1.2秒）を目安に、読み書きが止まる時間を見込むこと。
  行数に比例して伸びる（線形の想定——本 ADR は10万行の1点しか測っていない）。
- **`CONCURRENTLY` は使えない。**`migrate.ts` の1ファイル=1トランザクション設計に
  よる制約——0008 から変わっていない。
- **INSERT の恒常的な遅延（実測 +17.6%）。**すべての `memories` への書き込みが、
  この式索引の再評価コストを払い続ける。
- **1MBを超える本文は、先頭150,000文字しか語彙検索に効かない。**本文全体は
  `memories.content` に無傷で残るが、150,000文字より後ろにしか現れない語は、
  この語彙チャンネル（`LexicalStore`）からは引けない（ベクトル検索等、他の
  recall チャンネルには影響しない）。
- **二段目をこれ以上 `EXCEPTION` で包んでいない。**上の「二段目を更に包まなかった
  理由」のとおり意図的な選択だが、理論上限の前提（Postgres の大文字小文字畳み込みの
  挙動、この Postgres のビルド・ロケール）が崩れる将来があれば、Issue #1222 の
  症状（INSERT 失敗）へ戻る可能性を引き受けている。

## 確かめていないこと

- **ICU ロケールプロバイダ（`datlocprovider=i`）での大文字小文字畳み込みは
  総当たりしていない。**「N の実測」節の総当たりは `datlocprovider=c`（`C.UTF-8`）
  でのみ行った——CI の2脚（UTF8/SQL_ASCII、どちらも libc プロバイダ、ADR 0103）と
  同じ regime であり、これが対象範囲である。
  `packages/postgres/README.md`/CI の migration が ICU プロバイダの DB を対象に
  含めているかどうかは確認していない。
- **Plane 1 で組んだ同じ構造の本文が上限を超えなかった理由**（上の「【実測】文字数で切る素朴な案が実際に落ちた例」節）は、
  パーサが語として数えない文字が多いため、という見立てに留まり、確かめていない。
- **INSERT/索引作り直しの実測（「実測」節）は、この作業者の器の1回の測定条件
  （このプロセス専用の PostgreSQL、他の負荷が無い状態）でのみ行った。**本番相当の
  負荷・並行アクセスがある状態での遅延は測っていない。

## 追記（2026-09-30）: 「文字数」は DB のエンコーディングの文字であり、`SQL_ASCII` ではバイトになる

決定3・上の本文は `left(content, 150000)` を「文字数——バイト数ではない」と書いた。**これは
`server_encoding` が `UTF8` の DB についてだけ正しい。**

**【実測 2026-09-30】** `initdb --encoding=SQL_ASCII --locale=C` の cluster（PostgreSQL 17）で、
UTF-8 の3バイトの文字 `あ` を 200,000 個並べた文字列（600,000 バイト）に `left(…, 150000)` を掛けた。
`length` は 150000、`octet_length` も 150000 だった——**`SQL_ASCII` では1バイトが1文字として数えられる**ので、
`left` は先頭 150,000 **バイト**で切る（日本語なら約 50,000 文字ぶん。バイト列の途中で切れることもある）。
`UTF8` の DB では `left` は文字単位で切る（本文の実測どおり）。

- **安全性は変わらない（むしろ余裕が増える）。**バイトで切れば、切った後の長さは文字数で切った
  ときの理論上限（`4×150,000` バイト）以下に収まる。上の「N の実測」の結論は崩れない。
- **効く範囲が `SQL_ASCII` では狭くなる。**1MBを超える本文のうち、語彙チャンネルから引ける範囲は
  先頭 150,000 バイトまでである（UTF-8 の日本語では約 50,000 文字）。上の「引き受ける負債」の
  「先頭150,000文字」は、`SQL_ASCII` の DB では「先頭150,000バイト」と読むこと。
- migration の SQL（出荷済み）は変えていない。変えたのは現行の doc の言い方だけ
  （`docs/memory-model.md`・`packages/postgres/src/lexical-store.ts`・`packages/core/src/extraction.ts`）。
  migration ファイルの中のコメント（「文字数——バイト数ではない」）は出荷済みの版のまま残る。
