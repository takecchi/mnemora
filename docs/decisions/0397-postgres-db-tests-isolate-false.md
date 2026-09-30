# ADR 0397: `packages/postgres` の DB テストの並列 project を `isolate: false` にする（Issue #1276 案E）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30
- **PR**: Draft（Issue #1276。`Refs`、閉じない）

> **⚠ 本文はマネージャーから委譲された担い手が書いた。オーナー本人の執筆ではない。**
> 採ると決めたのは依頼元（オーナー本人ではない）で、オーナー本人の確認は取っていない。
> 数字はすべて CI の実測で、runner は共有の器である（下の「揺れ」）。

---

## 問い —— [Issue #1276](https://github.com/takecchi/mnemora/issues/1276)

[ADR 0371](./0371-db-tests-per-worker-database.md) でファイル並列になった `packages/postgres` の
`test:db`（= `vitest run`）は、CI（4 vCPU の `ubuntu-latest`）で約 250 s かかる。
並列の群の壁時計は、ファイルの時間の和の約 0.5 倍で、理想（worker 3 つで 1/3）に届かない。
**何が時間を食っていて、何を変えれば縮むか。**

## 測ったこと（原因）【実測】

main の CI（run 36652560295・36651133151・36650529152・36650272890 の postgres の各2脚、計8 job）の
ログから、各ファイルの完了行（`✓ <project> <file> (N tests) Xms`）を取り、「完了時刻 − X」で
開始を近似して区間を組んだ。

- **worker は 3 つで、ほぼ常に埋まっている。** 最大同時数は 8 job すべてで 3。
  `3 × 並列の壁時計 = ファイルの時間の和 + ファイル数 × o` を満たす `o`（ファイルごとの固定費）が
  UTF8 で 0.96〜1.04 s、SQL_ASCII で 0.60〜0.74 s。vitest の内訳
  （`tests 71% / import 22% / setup 5% / transform 2%`）から見積もった値（0.5〜0.8 s）と近い。
- **尾は無い。** 並列の群の最後の 8 ファイルは、どの job でも時間 0〜1.5 s の小さなファイルだった。
- **並び順は決まっていて、効かない。** 既定の `BaseSequencer` で、`results.json`
  （実行結果のキャッシュ）が無い CI では「ファイルサイズの大きい順」。
  順位相関 0.9999 以上（4 run）。長い順に並べ替えても、`recall-invariant-fuzz` を3つに分けても、
  シミュレーションで -0.4〜+0.7 s。worker が常に埋まっていて、尾が小さなファイルなので効かない。
- **直列の群が混雑していない状態の固定費を直接見せている。** worker が 1 つなので、
  ファイル間の隙間が 0.6〜0.75 s（UTF8）・0.37〜0.5 s（SQL_ASCII）で一定。並列の群の値との差が、
  3 worker と Postgres の service container が 4 vCPU を取り合う分と読める（推測）。
- 並列の群の 218 ファイルのうち 157 は、ファイルの時間が 1 s 未満（合計 47 s）で、固定費が
  約 157 s。**時間の大半は「テストを走らせる準備」である。**

## 試したこと【実測】——試走 PR #1471（閉じた）

基準・(i) worker を 4 つ（`--maxWorkers=4`）・(ii) 並列 project だけ `isolate: false` を、
同じ commit 系列で、2脚 × 3回（`gh run rerun --job` で postgres の job だけ再実行）走らせた。
run は基準 36656053781、(i) 36656065142、(ii) 36656093584。
`test:db` の段の秒数（`step`）と並列の群の壁時計（`並列`）:

| 脚 | 段 | 1回目 step / 並列 | 2回目 step / 並列 | 3回目 step / 並列 |
|---|---|---|---|---|
| UTF8 | 基準 | 260.6 / 225.0 | 232.7 / 200.8 | 240.3 / 205.5 |
| UTF8 | (i) w4 | 234.9 / 198.9 | 186.6 / 157.3 | 227.2 / 191.9 |
| UTF8 | (ii) isolate 無 | 183.1 / 147.6 | 152.5 / 122.6 | 190.6 / 154.1 |
| SQL_ASCII | 基準 | 254.0 / 218.7 | 258.1 / 222.7 | 240.2 / 206.3 |
| SQL_ASCII | (i) w4 | 232.1 / 197.3 | 229.1 / 194.8 | 235.1 / 200.1 |
| SQL_ASCII | (ii) isolate 無 | 183.2 / 147.6 | 212.5 / 175.4 | 149.5 / 119.1 |

job id（UTF8 / SQL_ASCII、1・2・3回目の順）:

- 基準: UTF8 109700537995・109705884955・109708714128、SQL_ASCII 109700538063・109707326869・109710209332
- (i): UTF8 109700570085・109705894102・109708721869、SQL_ASCII 109700570061・109707332234・109710213935
- (ii): UTF8 109700657381・109705901828・109708724853、SQL_ASCII 109700657573・109707337344・109710221150

同じ回どうしの差（基準との `step` の差）:

| 脚 | 段 | 差（s、3回） | 平均 | 比の平均 |
|---|---|---|---|---|
| UTF8 | (i) | -26, -46, -13 | -28 | 0.88 |
| SQL_ASCII | (i) | -22, -29, -5 | -19 | 0.93 |
| UTF8 | (ii) | -78, -80, -50 | -69 | 0.72 |
| SQL_ASCII | (ii) | -71, -46, -91 | -69 | 0.72 |

- **揺れ（runner）**: 基準の `step` が UTF8 で 232.7〜260.6 s。同じ時間帯の main の run
  （36654225957・36653802454）の postgres 4 job は 184.0〜263.5 s。単発の差は信用せず、
  同じ回どうしの比を見る。
- テストの件数・skip は全 18 job で一致（UTF8 2196、SQL_ASCII 2169 + 27 skipped）。赤は無かった。
- (ii) では、ファイルごとの固定費 `o` が約 1.0 s から約 0.07 s に落ち、`import` の割合が 22% から
  2〜3% になった（直列の群は `isolate: true` のままなので、約 30 s は残る）。

### 案C（worker を 4 つ）を採らなかった理由

`--maxWorkers=4` は最大同時数が 4 になり（緑）、平均 -19〜-28 s、比 0.88〜0.93 だったが、
3回中1回（SQL_ASCII の3回目）は -5 s で揺れと区別できない。ファイルの時間の和が
+5〜+22%、固定費 `o` が約 1.0 → 約 1.2 s に増えた——4 vCPU で Postgres と CPU を取り合う
遅れと読める（推測）。効きが小さく揺れの内に入りうるのに、CPU 競合による不安定の余地を
増やすので、見送った（依頼元の判断）。**`resolveDefaultMaxWorkers` の式と `maxWorkers` は
変えていない。**

## 決めたこと

1. **並列 project（`postgres-db-parallel`）だけ `isolate: false` にする。**
   直列 project（`postgres-db-serial`）は `isolate: true` のまま——接続切断・プール終了・
   `pg_locks` を見るテストが多く、状態の持ち越しが害になる。
2. **`isolate: false` の前に、静的に読んで見つけた3つの漏れへ手当てをする。**（下の節）
3. ジョブの名前・本数・required の宣言、2つの脚が走らせるファイル集合、`resolveDefaultMaxWorkers`
   の式と `maxWorkers` は変えない。

## 残る危険と手当て

並列 project のファイル（約 220 本）と setupFiles を、静的に読んだ。grep の式:
`vi\.(mock|doMock|hoisted)`、`vi\.(stubGlobal|stubEnv|useFakeTimers|setSystemTime|spyOn|unstubAll|useRealTimers|restoreAllMocks|resetModules)`、
`^(export )?(let|var) `、`^(export )?const X = (new (Map|Set|WeakMap|WeakSet|Array)|\[\]|\{\})`、
`process\.env(\.X|\[…\])\s*=`、`delete process\.env`、`console\.[a-z]+\s*=`、
`getTestClient` を含み `closeTestClient` を含まないファイル。見た場所は
`packages/postgres/src/__tests__/*.ts`・`packages/postgres/src/*.ts`（非テスト）・
`packages/core/src/__tests__/runtime-output-contract-harness.ts`。

| 危険 | 中身 | 手当て |
|---|---|---|
| (a) 書き込み累計の持ち越し | `memories-statistics.ts` の `memoriesWriteCounts` と `embedding-statistics.ts` の `upsertCountsByTable` は、プロセスローカルの累計で、閾値（初期 1,000、幾何的）で `ANALYZE` を撃つ。`isolate: false` では worker の全ファイルで累計が繋がり、`ANALYZE` を撃つ時点が、どのファイルがどの順で同じ worker に来たかで変わる。統計（`reltuples`）を使う EXPLAIN や、統計が無い状態を見るテスト（[ADR 0374](./0374-search-stats-presence-instance-cache.md) の追記）に効きうる。Issue #1419 が同じ形の疑いを別の場所で挙げていた。 | `setup-reset-process-counters.ts`（両 project の `setupFiles`）が、既存のテスト専用の口 `resetMemoriesWriteCounterForTesting()` と `resetEmbeddingUpsertCountersForTesting()` を、ファイルごとに呼ぶ（setupFiles は `isolate: false` でもファイルごとに走る）。公開 API の入口（`index.ts`）には出していない（`api:check` が通る）。 |
| (b) 共有クライアントの持ち越し | `test-db.ts` の `sharedClient` は、`closeTestClient()` が `undefined` に戻す。`getTestClient()` を使うのに `closeTestClient()` を呼ばないファイルが 12 本あった（うち1本は `getTestClient` をコメントで書いているだけで、実際は 11 本）。`isolate: true` ではファイルが終わると worker ごと捨てられて表に出なかったが、`isolate: false` ではプールが開いたまま次のファイルへ渡る。 | 11 本に `closeTestClient()` を足した（既存の `afterAll` があれば、その末尾）。直列の群の `restore-superseded-concurrent-forget` にも揃えて足した。 |
| (c) 出力の契約の検査が黙って効かなくなる | `setup-recall-output-contract.ts` は `vi.mock` で `createRuntime` の戻り値を検査に通す。`isolate: false` ではモジュールが共有されるので、2つ目以降のファイルで包みが効き続けるかは、検査の側から見えない。`DELIBERATELY_VIOLATING_TESTS` は空で、わざと破るテストが無いので、包みが消えても緑のまま。 | 陽性対照 `setup-recall-output-contract-positive-control.test.ts`（並列 project）。わざと契約を破る `recall()`（非整数のトークン数を返す `TokenCounter`）で、破れが溜まることを確かめる。取り出し口は harness に足したテスト専用の `takeRuntimeOutputContractProblemsForTesting()`。守る呼び出しでは何も溜まらない対も置いた。 |

**陽性対照を `DELIBERATELY_VIOLATING_TESTS`（名前で外す一覧）ではなく、別の取り出し口（`takeRuntimeOutputContractProblemsForTesting()`）で作った理由**: 一覧は溜まった破れを無視するだけで、検査が破れを捕まえたことを確かめられない。溜まった破れを取り出して `expect` する形のほうが、包みが効かなくなったときに赤になるので正しい。

### 確かめたこと【実測】

1. **陽性対照は、`isolate: false` の下で、包みを外すと赤になる。**
   試走用の枝で、`setup-recall-output-contract.ts` の `vi.mock` を `importOriginal` の素通しに変えた。
   run 36660411451（job 109713690350・109713690389）で、両脚とも
   `Test Files 1 failed | 239 passed`、赤は陽性対照の1本だけ
   （`AssertionError: expected 0 to be greater than 0`）。変異は本枝の履歴に残していない
   （試走用の枝は閉じて消した）。
2. **並びを変えた試走（`--sequence.shuffle --sequence.seed=<N>`）。**
   試走用の枝（PR #1473、閉じた）で、ci.yml の postgres ジョブの `test:db` にだけ足した。
   - **最初の試走（seed 11・4242・90210、run 36660426866・36660453786・36660483522）は、
     どの seed も両脚で1本だけ赤**——`embedding-space-table-enumeration-consistency.postgres.test.ts`
     の2本目の `it`（`found: 0`）。**`isolate: false` の漏れではなく、既存の `it` の順序依存**である:
     2本目が、1本目が登録した埋め込み空間（`registerEmbeddingSpace`）に頼っていて、
     `it` の順が入れ替わって2本目が先に走ると、テーブルが無い。**確認**: `isolate: true`（既定）のまま
     seed 11 で走らせた対照（run 36661832584、job 109718088447・109718088477）も、同じ1本だけ赤になった。
   - **直した**: 2本目が自分で `registerEmbeddingSpace`（冪等）を呼ぶ。
   - **直した後の試走（seed 11・4242・90210）は、すべて両脚で緑**:

| seed | run | UTF8 job | SQL_ASCII job | 件数 |
|---|---|---|---|---|
| 11 | 36662933199 | 109721391063（step 182.9 s / 並列 146.1 s） | 109721391052（183.4 s / 146.8 s） | UTF8 2216、SQL_ASCII 2189 + 27 skipped |
| 4242 | 36662959436 | 109721474329（173.3 s / 137.9 s） | 109721474313（211.6 s / 176.9 s） | 同上 |
| 90210 | 36662985613 | 109721552957（181.9 s / 144.2 s） | 109721552961（182.5 s / 146.4 s） | 同上 |

     件数・skip は shuffle 無しと一致する。陽性対照は全 job で走って緑だった。
     並列の壁時計は shuffle 無し（下）と同じ範囲に収まった（SQL_ASCII の seed 4242 だけ 176.9 s
     と長いが、その job はファイルの時間の和も 506 s と大きく、runner が遅かった回と読める）。
3. **本枝の CI（shuffle 無し）**: 手当てだけの commit（isolate: true、run 36660343624）は
   `step` が UTF8 265.4 s・SQL_ASCII 260.5 s（基準と同じ）。`isolate: false` を足した commit
   （run 36660381522）は 188.0 s・181.8 s、修正を足した commit（run 36661790857）は
   189.2 s・177.6 s。手当てのみの commit に対する `step` の比は、（UTF8・SQL_ASCII の順で）`isolate: false` の commit が 0.71・0.70、修正後の commit が 0.71・0.68。単発の値で、揺れ（上）の範囲を出ていない。
   件数は UTF8 2216、SQL_ASCII 2189 + 27 skipped。

## 手当てでも残るもの（確かめていない・見送ったもの）

- **`MNEMORA_SCALE_BENCH_SKIP_MAIN = "1"` の持ち越し。** `scale-bench-seed-vectors`・
  `scale-bench-capture-and-explain`（並列の群）と `scale-bench-close-on-throw`（直列の群）が、
  モジュール最上位で書いて戻さない。`process.env` は `isolate: true` のときも同じ worker
  プロセスで共有されていたので、`isolate: false` で新しく増える漏れではない。この変数が
  別のテストの挙動を変えるかは、読んでいない。
- **`setTimeout` を使うファイル（14 本）のタイマーの残り。** `setInterval` は 0 本。`setTimeout`
  の未解決が次のファイルに残るかは、確認していない。
- **`setup-pool-error-warning-guard.ts` の `console.warn` の包み**は、ファイルごとに重なる
  （worker あたり約 70 段）。各段は1つ前を呼ぶだけで、条件が同じなので結果は変わらない。
  実害が出る形ではないと読んだが、段数を数えて確かめてはいない。
- **`ANALYZE` の累計は、setup で戻すだけである。** 1つのファイルの中で閾値に達する書き込みが
  あれば、`isolate: true` のときと同じく、そのファイルの途中で `ANALYZE` が撃たれる。
  ファイルをまたぐ持ち越しは消したが、DB 側の統計（worker 専用 DB に残る）は、
  `isolate: true` のときも worker の中のファイル間で持ち越されていた（変わっていない）。
- **緑でも隠れうる、順序によってだけ出る漏れ**（推測）。worker への割り当ては実行時の空き次第で
  毎回変わる。3回の shuffle と数回の通常の run が緑でも、特定の並びでだけ出るものは、ここでは
  見えない。
- **`getTestClient()` の後始末を呼ばない書き方が、また増えうる。** 機械的な門は足していない
  （grep の式を上に書いた）。
- 直列の群への `isolate: false` は入れていない（測ってもいない）。
- 案C と (ii) の併用は測っていない。

## 検討した代替案

- **worker を 4 つ**: 上の「案C を採らなかった理由」。
- **長い順に並べる（`sequence.sequencer`）・長いファイルを分ける**: シミュレーションで
  -0.4〜+0.7 s。効かないので採らない。分けると、ファイル集合が増える。
- **直列の群を並列へ移す**: 直列の群は `pg_locks` / `pg_stat_activity` / `pg_terminate_backend` /
  `CREATE ROLE` などクラスタ全体に効くものを使う（ADR 0371・ADR 0374 の基準）。この Issue の範囲外。
- **ファイルを統合して数を減らす**: ファイル集合が変わるので採らない。

## これが覆るとしたら

- **`isolate: false` のファイル間の漏れが、CI か手元で赤として観測されたとき。** まず漏れの
  原因（上の表の (a)(b)(c) か、上の「残るもの」）を調べ、手当てで直せなければ `isolate: true`
  に戻す（`vitest.config.mts` の1行）。戻しても ADR 0371 の設計（専用 DB・`VITEST_POOL_ID`）は
  影響を受けない。
- **vitest のバージョンを上げたとき。** `isolate: false` の下での `vi.mock` の効き方と、
  setupFiles がファイルごとに走ることは、この ADR の手当て（a）（c）が前提にしている。
  陽性対照（c）が赤くならないことを確かめること。
- **runner の vCPU 数が変わったとき。** 固定費の大きさ（約 1.0 s と約 0.07 s）は、この4 vCPU の
  実測である。
