# ADR 0478: 穴探し49巡目 — `examples/chat/README.md` が載せていなかったフラグと環境変数を、利用者向けと内部用に分けて一覧にする。文書のコード片と散文の数値は突き合わせてずれなし

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・文書の直し。新しく断る入力・既定値や公開 API の変更は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 49巡目は、今日の ADR 0441〜0477 が見ていない「種類」の面として、文書と実装のずれを選んだ。避けた面: 46巡目 `EventStore.append`（ADR 0475）、47巡目 taxonomy の deadlock（0476）、48巡目 bullmq（0477）、50巡目 テナント設定（`--decay-clock` の節、保持期間・decayClock・半減期の行・`CREATE TABLE tenant_settings`・`interface TenantSettingsStore` は対象から外した）。

## 面B（主）: `examples/chat/README.md` のフラグ・環境変数の書き漏らし

- **突き合わせの方法**【実測】: `examples/chat/src`（`__tests__` を除く）が読む環境変数を `process.env.X`／`env.X` の形で集め（63 個）、README に出てくる回数と、`cli.ts` の usage（`--help`）に出てくる回数を数えた。argv のフラグは `"--…"` の文字列を集めた（`--dev`・`--help`・`--temperature=`・`--trials=`・`--decay-clock`。最後は外す）。逆向き（README にあって src に無い）も見た。
- **見つかったずれ**【実測】:
  - **README に 0 回出てくるのに、サブコマンドが読むフラグ・環境変数**（利用者が `pnpm run <サブコマンド>` で渡す想定）: フラグ `--trials=N`・`--temperature=N`（`answer-time-weighting`。`cli.ts` の `parseTimeWeightingTrials`・`parseTimeWeightingTemperature`）、環境変数 20 個（`MNEMORA_TIME_WEIGHTING_JSON`・`MNEMORA_COMPARE_JSON`・`MNEMORA_RETRIEVAL_JSON`・`MNEMORA_BENCH_CHANNELS`・`MNEMORA_LEXICAL_STORE`・`MNEMORA_NUMERAL_TOKEN_OPENAI_JSON`・`MNEMORA_ASSOCIATION_JSON`・`MNEMORA_CONSOLIDATION_{JSON,GROUP_SIZE,BUDGET_LADDER,RECALL_LIMIT}`・`MNEMORA_ARCHIVE_SWEEP_{JSON,MARGIN_HOURS,LIMIT,BUDGET_LADDER,RECALL_LIMIT}`・`MNEMORA_ANSWER_CLAIM_KEY`・`MNEMORA_ANSWER_TRIALS_RENDERS`・`MNEMORA_EMBEDDING_FINGERPRINT_{RAW_JSON,NUM_THREADS}`）。うち usage（`--help`）には出ているもの（JSON の書き先のいくつかと `--trials`・`--temperature`）と、usage にも README にも無いもの（`MNEMORA_LEXICAL_STORE`・`MNEMORA_BENCH_CHANNELS`・consolidation／archive-sweep の 7 つ・`MNEMORA_ANSWER_CLAIM_KEY`・`MNEMORA_COMPARE_JSON`・`MNEMORA_RETRIEVAL_JSON` など）がある。これらを決めた ADR（0148・0319・0326 など）には書いてあるが、README の読者は辿れない。
  - **README に無く、内部の測定スクリプトだけが読む**: `src/scripts/*`・`src/bench/*` だけが読む `MEASURE_*`・`MNEMORA_ASSOC_*`・`MNEMORA_ASSOCIATION_DEFAULT_ON_MEASURE_*`・`MNEMORA_OPENAI_FP_CEILING_*`・`MNEMORA_MARGIN_CANDIDATE_ROUNDS`・`MNEMORA_1430_CONDITION`・`MNEMORA_CANDIDATE4_CONDITION`・`MNEMORA_RECORD_CASSETTE_PATH`・`MNEMORA_RECORD_CONDITION`・`MNEMORA_ANSWER_CASE_SET`・`MNEMORA_RANK_LISTING_JSON`。
  - **逆向き（README にあって src に無い）**: 見つからなかった。`MNEMORA_PROVIDER_SOURCE`・`MNEMORA_LIVE_OPENAI`・`MNEMORA_ARCHIVE_SWEEP_HALF_LIFE_HOURS`・`MNEMORA_ANSWER_TRIALS_N` は別ファイルで読まれている。
  - `pnpm run <script>` の名前は、既存の歯 `scripts/__tests__/example-chat-readme-run-scripts.test.mjs` が `package.json` と突き合わせている（ずれなし）。
- **決定**（線の内側＝文書の直しと歯だけ。実装は変えていない）:
  1. README に節「フラグと環境変数の一覧（サブコマンドごと。`--help` が正）」を足した。利用者向けのフラグ 3（`--trials`・`--temperature`・`--dev`）と環境変数 20 を、対象のサブコマンド・渡し方・意味・既定の出所で表にした。**既定値の数は書き写さず**、どの定数・関数が持つかを指した（AGENTS.md「数を、道具と生成物に焼き込まない」。ADR 0234）。
  2. **載せない基準**を節の冒頭に書いた: 「`src/scripts/*`・`src/bench/*` の単発の測定スクリプトだけが読む変数」は、その ADR・スクリプトの冒頭のコメントが説明するもので、README は網羅しない。一覧の出し方（`rg 'process\.env\.' examples/chat/src/scripts examples/chat/src/bench`）を書いた。利用者向けか内部用かの境は【判断】で、「`cli.ts` のサブコマンドが読む」か否か。`MNEMORA_ANSWER_CASE_SET`・`MNEMORA_RECORD_CONDITION` は `answer` 系の周辺に見えるが、読むのは記録スクリプト（`scripts/record-answer-claim-key.ts` ほか）なので内部用にした。
  3. 歯 `scripts/__tests__/example-chat-readme-flags-env.test.mjs`: 載せると決めたフラグ 3・環境変数 20 が、(1) README の節に在り、(2) `examples/chat/src` が実際に読んでいる、ことを縛る。**全集合の一致は縛らない**（内部用まで載せることになる）。陽性対照として、節が見つかること、別の節に既にある変数（`MNEMORA_ANSWER_TRIALS_N`）が README に在ること、内部用の変数（`MEASURE_N`）が節に載っていないのにソースには在ることを縛った。

## 面A（従）: `packages/postgres/README.md` の印の無い 3 片

- **方法**【実測】: 3 片（L336 付近の最小の例、L783 の `onPoolError`、L795 の `client.pool.on("error")`）を `.hunt-r49/snip/` に抜き出し、`@mnemora/*` を `packages/*/src` に向ける paths で `tsc --noEmit`（`packages/postgres` から、strict）。
- **結果**: 3 片とも通った（L783・L795 の 2 片は `createPostgresClient` の import が前の例にあるため、import を足して検査した）。陽性対照として、同じ README の `ts check` の 1 片が通ること、最小の例に存在しない export を足した片が `TS2305` で落ちることを確かめた。
- **README の注記（印を付けない理由）**: 「`packages/postgres` は `@mnemora/openai` に依存していないので、印を付けると見つからずに落ちる」は今も正しい（`packages/postgres/package.json` の依存に `@mnemora/openai` は無い）。直す所は見つからなかった。
- 同様に `packages/local-embedding/README.md` の印の無い 1 片は、`memoryStore` 等を省略した抜粋（本文に「省略」と書いてある）で、そのままは型検査に通らない。設計どおり。

## 面E（余力）: 散文の数値と定数

- `docs/recall.md`・`docs/architecture.md`・`docs/memory-model.md`・ルートと `packages/core` の README の散文の数値を、定数と突き合わせた【実測。grep】: `limit` 既定 10（`DEFAULT_RECALL_LIMIT`）、`k' = k × 4`（`DEFAULT_OVER_FETCH_FACTOR`）、`DEFAULT_SCORE_THRESHOLD` 0.1、`digestBandLimit` 既定 50（`DEFAULT_DIGEST_BAND_LIMIT`）、`DEFAULT_RECALL_ASSOCIATION.maxCount` 10、`DEFAULT_ASSOCIATION_ANCHOR_COUNT` 3。すべて一致した。保持期間・decayClock・半減期の行は対象から外した。
- 前の巡目が既に直していた形（追記で訂正する）が多く、元の散文が古いまま残っている所は見つからなかった。

## ほかに突き合わせてずれが無かったもの（記録）

- `docs/architecture.md` の印の無い interface 16 片 vs 公開 API の snapshot: メンバー名が全一致（既存の歯 2 本もある）。
- `docs/recall.md` の型の片 vs d.ts: 欄の名前・省略可否・型の違いは、本文に追記のあるものだけ。
- `docs/memory-model.md` の `CREATE TABLE`（tenant_settings を除く）vs `packages/postgres/src/schema.ts`: 列の型・NOT NULL が一致。`Provenance` の片も一致。
- `examples/chat/README.md` の `scope`・`explain`・`backfill`・`correction` の節の識別子 68 個: すべて実在。

## 検討した代替案

1. **全集合（63 個）を README に載せ、歯で一致を縛る。** 採らなかった。内部の測定スクリプト専用の変数まで利用者向けの README に載り、スクリプトを足すたびに README と歯の更新が要る。載せないものの基準を書くほうが、読者に正直である。
2. **README には載せず、usage（`--help`）にだけ足す。** 採らなかった。usage は実装の変更（`cli.ts`）で、依頼主の線では内側ではあるが、README が「正は `--help`」と指す構図を保つには、README 側の一覧のほうが先に要る。usage の追記は材料。
3. **`MNEMORA_*_JSON` を 1 つの節にまとめる。** 採らなかった。サブコマンドごとに表に出したほうが、`pnpm run <サブコマンド>` を打つ人が自分の命令の所で見つけられる。

## 引き受けた負債（材料）

| # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
|---|---|---|---|---|---|
| 1 | usage（`--help`）にも README にも無い利用者向けの変数がある（`MNEMORA_LEXICAL_STORE` など） | `rg MNEMORA_LEXICAL_STORE examples/chat/src/cli.ts` が 0 件 | `--help` だけを読む人は見つけられない | 低 | usage に足すとオーナーが決めたとき（実装の変更） |
| 2 | 内部用と利用者向けの境が【判断】である | 上 | 境を引き直すと README と歯の表を直す | 低 | 内部用の変数を載せると決めたとき |

## これが覆るとしたら

内部の測定スクリプトの変数も README に載せると決まったとき（歯を全集合の一致に替える）。`MNEMORA_*_JSON` の書き先を 1 つの環境変数にまとめるなど、フラグ・変数の体系が変わったとき。

## 測っていないこと

README の出力例（実行結果の貼り付け）と実際の出力の一致（走らせていない）。`examples/chat/README.md` の `--decay-clock` の節（50巡目の面）。`docs/migration-v1.md`・`CHANGELOG.md` の印の無い片（今日の面）。
