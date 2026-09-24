# ADR 0294: `retrieval` ベンチの語彙チャンネル構成（ADR 0148）でタイ密度を測るベンチを足す — 測るだけで、Issue #394 の取り扱いには何も答えない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-25

**⚠ 各主張の出所を分ける**（ADR 0108 / ADR 0148 の体裁を踏む）。

- **【実測】** — この ADR の作業者（クローンのマネージャーのセッション）が自分の手で
  走らせて確かめた。この PR は手元に本物の Postgres 17 + pgvector（`initdb` で自前に
  立てたインスタンス、AGENTS.md の手順）があった環境で書かれており、下記の測定は
  すべて実際に実行した結果である。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — Issue #394 のコメントが実測条件・判断を報告として残しており、
  この ADR はそれを出典として引く。

---

## 文脈

[Issue #394](https://github.com/takecchi/mnemora/issues/394) は、`packages/postgres/src/__tests__/lexical-store-index.test.ts` の
20,000行の合成 fixture（`seedManyMemories`）に対して `buildLexicalSearchSelect` を直接
引いたところ、クエリ `obsidian shards` にヒットする400行が全部
`coverage = 1`、`rank = 0.16666667` で完全に同点になり、`LIMIT 50` がその400件のタイ
から50件を選んでいた、という実測を報告した。

Issue 本文はこれを「合成 seed である」と明記した上で、**確かめていないこと**として
次を挙げている（逐語）:

> 実際に語彙チャンネルを使う経路（`retrieval` ベンチの語彙構成、[ADR 0148](./0148-bench-lexical-channel-selectable-default-unchanged.md)）でタイがどれだけ起きるかは測っていない。
> まずここを測るのが安い一手だと思われる（が、これも見立てである）。

Issue のコメント（2026-09-17、クローンによる区分の整理）は、**取り扱い**（v1.0 を止めるか・
「次に測るべきこと」案1〜4のどれを採るか）は repo の外（オーナー判断）だが、
**案1（タイ密度を測る）自体は「測る」ものとして repo の中で発注できる**、と切り分けた。

**この ADR はその測る作業だけを行う。**案2（`ts_rank_cd` のパラメータ調整）・案3（rank 以外の
分解能項を足す）・案4（何もしない）のどれを採るかには、一切踏み込まない。

---

## 決めたこと

### 決定1: `examples/chat` に `lexical-tie-density-bench` を足す — 手動実行、CI に配線しない

`packages/postgres/src/bench/scale-bench.ts`（規模を振るベンチ。CI に配線されておらず、
`DATABASE_URL=... pnpm --filter @mnemora/postgres run bench:scale` で手動実行する）と
**同じ形**を採る。理由:

- この測定が使う corpus（`examples/chat/src/probe-set.ts` の `buildProbeSetConversation()`）
  は、`retrieval` ベンチの CI ジョブが実際に使っている corpus・probe と**厳密には同じでは
  ない**（下記「corpus について」）。CI の既定ジョブへ紛れ込ませると、「CI が実際に測って
  いるもの」の説明が1つ増える。
- ADR 0148 決定4・決定3 が既に「語彙構成の非門ジョブを CI に足すかは、揺れを実測して
  から決める」という態度を採っている。この ADR もその態度を引き継ぐ——**まず手元で
  測れることを示し、CI 配線は follow-up に残す**（下記「引き受けた負債」）。
- `scale-bench.ts` 自身が「手元では一切実行できていない」まま採用されている前例が
  あり（作業環境に DB が無かったため）、**この repo は「実行できないベンチをコードとして
  先に置く」ことを許容している**。この ADR はその逆——**実際に実行できたので、実測値を
  この ADR に残す**（下記「測定」）。

新設ファイル:

- `examples/chat/src/lexical-tie-density-lib.ts`: DB を要さない純関数
  （`groupTiesByScore` / `measureTieDensityFromRows` / `renderTieDensityReport`）。
  歯は `examples/chat/src/__tests__/lexical-tie-density-lib.test.ts`（11件、DB 無しで走る）。
- `examples/chat/src/bench/lexical-tie-density-bench.ts`: DB に接続し、corpus を投入して
  `buildLexicalSearchSelect`（`@mnemora/postgres`、既存の公開 export。変更していない）を
  実行する側。`pnpm --filter @mnemora/example-chat run lexical-tie-density-bench`。

⛔ **これは門ではない。** 何が出力されても `process.exitCode` を変えない
（内部エラー時を除く。`embedding-fingerprint.ts`/`scale-bench.ts` と同じ規律）。

### 決定2: corpus は `retrieval` ベンチの実発話。ただし LLM 抽出は経由しない（プロクシ）

`buildProbeSetConversation()`（gold 7件・distractor 7件・haystack 60件、計74件）が組む
**発話**を、そのまま `memories.content` へ直接 INSERT する
（`lexical-store-index.test.ts` の `seedManyMemories` / `scale-bench.ts` の `seedMemories` と
同じ生 SQL の作法）。

**これは実際の `retrieval` ベンチと同一ではない。** 実際のベンチは `observe()` → LLM 抽出
（記録済みカセット `examples/chat/cassettes/retrieval.json` の再生）→ `tick()` を経由し、
`memories.content` は発話そのものではなく LLM が抽出した fact になる。この ADR の作業者は
実 API 鍵を持たず、カセットの録り直しもできない（マネージャーの指示で実 API を叩くこと
自体が禁じられている）。⟹ **corpus は「retrieval ベンチが使う発話の内容」に対する
プロクシであり、「retrieval ベンチが実際に格納する content」の直接測定ではない**
（下記「確かめていないこと」）。

`buildLexicalSearchSelect` の SQL・正規化関数はどちらもこのファイルに書き写していない
——`@mnemora/postgres` からそのまま import する（`lexical-store.ts` の docstring
「正規表現をこのファイルに書き写さないこと」の適用）。

### 決定3: `limit` は `packages/core` の既定値から算出する（書き写さない）

`recall-runtime.ts` の語彙チャンネル呼び出しは `limit: kPrime`
（`kPrime = round(limit * overFetchFactor)`、既定 `10 * 4 = 40`）を渡す。この値を
定数として書き写すのではなく、`@mnemora/core` が公開する `DEFAULT_RECALL_LIMIT` /
`DEFAULT_OVER_FETCH_FACTOR` を import して同じ式で計算する
（AGENTS.md「数を、道具と生成物に焼き込まない」の適用。`main` が既定値を動かせば、
この計算も自動的に追随する）。

### 決定4: 陽性対照を別テナントに用意する

実 corpus（74行）は ASCII の連なりが `TypeScript`/`Rust`/`Go` の3語のみで、どの2文書間でも
重複しない（`buildHaystackUtterance` の語彙はすべて日本語）。⟹ 実 corpus には「タイが
実際に起きる」実例が1つも無い。**「タイが0件」が「道具がタイを検出できない」ことを
意味しないことを示すため**、別テナント（`lexical-tie-density-bench-control`）に
意図的な重複コンテンツ（`quartz lantern echoes near meridian gate marker <n>`、5行、
末尾の番号だけが違う——Issue #394 本文の `obsidian shards` fixture と同じ構造）を仕込み、
`LIMIT 3` で実際に「5件同点・LIMIT がタイの途中で切る」ことを検出できるかを先に確認する
（AGENTS.md「『出なかった』を、事象が無いことの証明にしない — 先に陽性対照を示す」の適用）。

---

## 測定 — 【実測】(PostgreSQL 17.11 + pgvector 0.8.0、`initdb` で自前に立てたインスタンス、

非特権ユーザ、2026-09-25)

```
DATABASE_URL=postgresql://worker@127.0.0.1:55432/mnemora_test \
  pnpm --filter @mnemora/example-chat run lexical-tie-density-bench
```

### 陽性対照（先に見る）

| label                  | query            | 総候補数 | タイ集団数 | 最大タイ集団 | LIMIT境界で分断 |
| ---------------------- | ---------------- | -------: | ---------: | -----------: | --------------- |
| control:quartz-lantern | `quartz lantern` |        5 |          1 |            5 | 🔴 はい         |

**✅ 道具は生きている。** 意図的に仕込んだ5件同点が、`LIMIT 3` によって実際に途中で
切られることを検出した——Issue #394 本文が報告した現象（母集団がタイのまま LIMIT を
超える）と、構造として同じものを、この道具は正しく検出する。

### 実コーパス（`retrieval` ベンチの語彙構成。probe 7件 + ASCII 語彙4件）

| label            | query                                               | 総候補数 | タイ集団数 | 最大タイ集団 | LIMIT境界で分断 |
| ---------------- | --------------------------------------------------- | -------: | ---------: | -----------: | --------------- |
| probe:color      | ところで、わたしの好きな色を覚えていますか?         |        0 |          0 |            0 | n/a             |
| probe:pet        | うちのペットについて何か知っていますか?             |        0 |          0 |            0 | n/a             |
| probe:exercise   | 私の運動の習慣はどんなものでしたか?                 |        0 |          0 |            0 | n/a             |
| probe:diet       | 私が避けたほうがいい食べ物はありますか?             |        0 |          0 |            0 | n/a             |
| probe:family     | 私の家族はどこで暮らしていますか?                   |        0 |          0 |            0 | n/a             |
| probe:language   | 私が一番気に入っているプログラミング言語は何ですか? |        0 |          0 |            0 | n/a             |
| probe:travel     | 次の遠出の行き先はどこでしたか?                     |        0 |          0 |            0 | n/a             |
| ascii:TypeScript | `TypeScript`                                        |        1 |          1 |            1 | n/a             |
| ascii:Rust       | `Rust`                                              |        1 |          1 |            1 | n/a             |
| ascii:Go         | `Go`                                                |        1 |          1 |            1 | n/a             |
| ascii:combined   | `TypeScript Rust Go`                                |        2 |          2 |            1 | n/a             |

**probe 7件の総候補数（合計）: 0。**

### 分かったこと（測定結果の記述。⛔ 取り扱いの判断ではない）

1. **`retrieval` ベンチの実際の probe 集合（7件、全件日本語自然文）は、語彙チャンネルの
   タイ密度を測る材料を1つも生まない——0件しか返らないため、タイが起きるかどうか
   以前の段階で止まる。** これは ADR 0148 が静的に記述していた内容（日本語のみの
   クエリは `mnemora_lexical_query_terms` の非ASCII除去で空の tsquery になる）と、
   実際に実行して一致することを確認した。
2. **実 corpus（発話74件）に含まれる ASCII 語彙は `TypeScript`/`Rust`/`Go` の3語のみで、
   どの語も1文書にしか出現しない。** ⟹ この corpus 自身の内容だけでは、タイが起きる
   条件（複数文書が同じ語彙集合に当たる）を満たすクエリを1つも構成できない。
3. **⟹ Issue #394 の「次に測るべきこと」1番（`retrieval` ベンチの語彙構成でタイ密度を
   測る）は、実行できたが、測定対象そのものが小さすぎて/日本語に寄りすぎていて、
   「タイが起きるか起きないか」のどちらの答えも出せなかった。** 0件（probe）と
   1〜2件・非タイ（ASCII）のどちらも、Issue 本文が実際に心配している現象
   （「同点の母集団が `limit` を超える」）を再現も反証もしていない。
4. **陽性対照が示す通り、これは道具の欠陥ではない。** 道具は人工的に仕込んだタイを
   正しく検出した。**測定対象（`retrieval` ベンチの corpus・probe 集合）の側に、
   タイ現象を観測するための材料が無いだけである。**

**⟹ この ADR が答えたのは「`retrieval` ベンチの現状の構成でタイは測れるか」という
問いであり、答えは「測れるところまでは行ったが、母集団が小さすぎて有意な数字が出ない」
である。** 「実データ寄りのコーパスでタイが起きるか」という Issue #394 の本来の関心
（ADR 0170 が指摘する「重複・定型文の多いコーパスでは語彙側でも同じことが起こると考える
理由はある」という推論）には、依然として答えていない——`retrieval` ベンチの corpus は
「重複・定型文の多いコーパス」ではなく、むしろ語彙的にほぼ重複の無いコーパスだった。

---

## 北極星の5つの問いに当てた結果

- **問い3（選ばれた理由を後から説明できるか）**: この ADR が足すのは測定手段であり、
  「選んだ」何かは無い。ただし、この測定によって「`retrieval` ベンチの既定 probe 集合では
  語彙チャンネルのタイ密度について何も言えない」という**既存の限界**が、初めて実行を
  通じて確認できるようになった——これまでは ADR 0148 の静的な記述に頼るしかなかった。
- 他の4問い（1・2・4・5）は、この ADR が recall の挙動・既定構成・LLM 呼び出しの
  有無のいずれも変えていないため、該当しない（ADR 0148 と同じ整理）。

---

## 検討した代替案

- **既存の `retrieval-quality.postgres.test.ts` の歯に、タイ密度の assertion を足す。**
  **採らない。** 歯は「壊れたら CI が赤くなる」ものであり、この測定は判定を持たない
  （測っただけで良し悪しを言わない）——歯にすると、それ自体が「良い/悪いタイ密度が
  ある」という主張になってしまう。AGENTS.md「偽陽性率に上限を置けない検査は門にしない」
  の適用でもある——タイ密度に許容範囲があるという実測が無い以上、閾値を持つ歯は書けない。
- **`MNEMORA_BENCH_CHANNELS=ann,lexical` で実際の `retrieval` コマンドを走らせ、その
  出力からタイ密度を読む。** **この ADR では採らない。** ADR 0148 が実測した通り、
  既定 probe 集合はどのみち0件になるため、実行しても本 ADR の測定と同じ「0件」しか
  得られない——`retrieval` コマンド全体（LLM 抽出のカセット再生を含む）を走らせる
  追加コストに見合う新しい情報が無い。この ADR の測定（LLM 抽出を経由しない発話直接
  投入）のほうが速く、同じ結論（0件）に達する。
- **probe 集合に ASCII の自然文を足し、タイが起きるかを直接測る。** **この ADR では
  採らない。** これは「次に測るべきこと」の範囲を超え、`retrieval` ベンチの probe 集合
  そのものを変える設計判断になる（ADR 0148「引き受けた負債」がすでに follow-up として
  挙げている課題であり、実 API 鍵でのカセット録り直しが要る）。マネージャーの指示は
  「測るだけで、何も決めない」であり、probe 集合を変えることは「決める」側に属する。
- **haystack と同じ構造（時間文脈×対象×述語の直積）を ASCII に翻訳した合成 corpus を
  作り、そちらでタイ密度を測る。** **この ADR では採らない。** 検討はしたが、これは
  `probe-set.ts` が持つ実際の corpus ではなく**新しい合成 corpus の設計**になり、
  「retrieval ベンチの語彙構成でタイ密度を測る」という Issue 本文の字義から離れる。
  Issue #394 自身が「次に測るべきこと」2〜4番として案を分けている構造を踏まえると、
  新しい合成 corpus の設計は案3寄りの意思決定（分解能を上げる項を探る前段の実験
  設計）に踏み込みかねない。**この ADR は案1だけを実行する**という指示の範囲を守り、
  ここでは採らない——ただし follow-up として記録する(下記)。

---

## 引き受けた負債

- **🔴 この測定は「実データ寄りのコーパスでタイが起きるか」という Issue #394 の
  本来の問いに答えていない。** 答えたのは「`retrieval` ベンチの現状の構成では、
  タイの有無を判定できるだけの候補が返らない」という、一段手前の事実である。
- **corpus は LLM 抽出を経由しないプロクシである。** 実際の `retrieval` ベンチが
  格納する `content`（LLM が抽出した fact）に対する測定ではない。fact の言い回しが
  発話そのものと異なることで、タイの有無が変わる可能性は検証していない。
- **CI に配線していない。** `scale-bench.ts` と同じ「手動実行、非門」の形に留めた。
  n が溜まらない・実行を忘れられるという `scale-bench.ts` と同じ負債を、この ADR も
  引き継ぐ。
- **ASCII の positive control（`TypeScript`/`Rust`/`Go`）は、いずれも1文書にしか
  出現しないため、「実コーパスの実在する語彙でタイが起きるか」を直接示す例には
  なっていない。** 陽性対照は別テナントの人工データで確認した。

### follow-up として残すこと(次に拾う人へ)

1. **probe 集合または独立の合成 corpus に、意図的に重複するベクトル/語彙を持つ
   ASCII コンテンツを足し、「実データ寄りでタイが起きるか」を直接測る。** 実 API 鍵
   でのカセット録り直しが要る場合と要らない場合がある(このベンチと同じ「LLM 抽出を
   経由しないプロクシ」の形を取れば鍵は要らない)。
2. **`ts_rank_cd` の正規化パラメータ・weight を変えたときに分解能が上がるかを測る**
   (Issue #394「次に測るべきこと」2番。この ADR は手を付けていない)。
3. **この bench を CI に配線するかどうかは、1番の follow-up で実際に非0件の測定が
   得られてから再検討する**(ADR 0148 決定4と同じ「まず揺れるかどうかを実測してから
   決める」態度)。

---

## これが覆るとしたら

- **probe 集合または合成 corpus に、実際にタイを起こす ASCII コンテンツが足されたとき。**
  そのときこの bench（`lexical-tie-density-lib.ts` の純関数部分はそのまま再利用できる）
  で、初めて意味のあるタイ密度の数字が測れる。
- **語彙チャンネルの既定構成（`DEFAULT_RECALL_CHANNELS`）が変わったとき。** `kPrime`
  の算出元が変われば、この bench の `PRODUCTION_LIMIT` も自動的に追随する
  (決定3の import に基づく計算のため、この ADR 自体の書き換えは不要)。

---

## 確かめていないこと

- **実際の `retrieval` ベンチが格納する `content`（LLM 抽出後の fact）に対するタイ密度は
  測っていない。** この bench は発話をそのまま `content` に入れるプロクシである
  (決定2参照)。
- **`ts_rank_cd` の正規化パラメータ・weight を変えたときに分解能が上がるかは測っていない**
  (Issue #394「次に測るべきこと」2番。この ADR の範囲外)。
- **段2の再スコアが `rank` 以外にどんな分解能を持つ項を既に持っているかは読んでいない**
  (Issue #394「次に測るべきこと」3番の前提確認。この ADR の範囲外)。
- **「実データ寄りのコーパスでタイが起きるかどうか」という Issue #394 の中心的な問いには、
  この ADR は依然として答えていない。** 測定結果が「0件」だったのは、コーパスに
  タイを起こす材料が無かったからであり、「タイが起きない」ことの実証ではない
  (AGENTS.md「『出なかった』を、事象が無いことの証明にしない」を、この ADR 自身の
  結論にも適用する——この ADR は「retrieval ベンチの現状の構成では判定できない」
  としか言っていない)。
- **他の Postgres バージョン・pgvector バージョンでの再現性は確認していない。**
  この ADR の測定は PostgreSQL 17.11 + pgvector 0.8.0 の1環境のみで行った。
- **v1.0 を止めるか、Issue #394「次に測るべきこと」案1〜4のどれを採るかは、
  この ADR の範囲外である。** オーナーの判断に委ねる(Issue #394 本文・コメントの
  区分をそのまま引き継ぐ)。
