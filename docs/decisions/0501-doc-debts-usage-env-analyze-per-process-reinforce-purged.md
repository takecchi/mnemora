# ADR 0501: 文書の負債3件を返す — `--help` の環境変数（ADR 0478 負債1）・ANALYZE の数えがプロセスごと（ADR 0460 D5）・purged への強化の TSDoc（ADR 0453 負債3）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定。担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 三つの ADR が「文書だけの直し」として残した負債を、まとめて返す。振る舞い・既定値・公開 API は変えない（CHANGELOG・migration-v1 に載せない理由は、利用者の呼ぶ API の意味が変わらないこと。`examples/chat` は CHANGELOG に載せない方針で、`--help` の文言と TSDoc の追記は利用者に見える変更ではない【判断】）。

## 決めたこと

### 1. `examples/chat` の usage（`--help`）に、README の一覧にある利用者向けの変数を足す（ADR 0478 負債1）

- **突き合わせ**【実測】: README の節「フラグと環境変数の一覧」に載るフラグ 3・環境変数 20 を、`cli.ts` の `printHelp` の本文と突き合わせた。usage に無かったのは環境変数 14 個: `MNEMORA_COMPARE_JSON`・`MNEMORA_RETRIEVAL_JSON`・`MNEMORA_BENCH_CHANNELS`・`MNEMORA_LEXICAL_STORE`・`MNEMORA_NUMERAL_TOKEN_OPENAI_JSON`・`MNEMORA_CONSOLIDATION_{GROUP_SIZE,BUDGET_LADDER,RECALL_LIMIT}`・`MNEMORA_ARCHIVE_SWEEP_{MARGIN_HOURS,LIMIT,BUDGET_LADDER,RECALL_LIMIT}`・`MNEMORA_ANSWER_CLAIM_KEY`・`MNEMORA_EMBEDDING_FINGERPRINT_NUM_THREADS`。フラグ 3 は既に usage にあった。
- **足した**: 各サブコマンドの行の下に1行（`MNEMORA_LEXICAL_STORE` は全サブコマンドに効くので、末尾の `MNEMORA_PROVIDER_SOURCE` の隣）。意味は README の表の言い回しに揃え、**既定値の数は書き写していない**（ADR 0234。どの定数が持つかは README が指す）。内部の測定スクリプト専用の変数は、ADR 0478 の基準どおり usage にも載せない。
- **歯**: ADR 0478 の歯 `scripts/__tests__/example-chat-readme-flags-env.test.mjs` に、「README の節に載せたフラグ・環境変数は、`cli.ts` の `printHelp` の本文にも出ている」を足した（`it.each` で 23 件）。`cli.ts` は import すると `main()` が走るので、ソースの文字列として `function printHelp(` から `const HELP_COMMANDS` までを切り出す。陽性対照として、切り出しが成功していること（既に usage にある `MNEMORA_ANSWER_TRIALS_N` とサブコマンド名が在る）と、内部用の `MEASURE_N` が usage に無いことを縛った。
- **赤→緑**【実測】: 足す前は新しい 23 件のうち 14 件が赤（上の 14 個。残りは既に usage にあった）。足した後は 50 件すべて緑。
- **変異**【実測】: (a) 足りない実装 — usage の `MNEMORA_LEXICAL_STORE` を1字削ると、その1件だけが赤。(b) やりすぎ — usage に `MEASURE_N` を書くと、陽性対照の1件が赤。どちらも `cp` で戻して緑。
- 関連の既存の歯 `examples/chat/src/__tests__/cli-help.test.ts`（`--help` の終了コードと出力先。DB 不要）も走らせて緑【実測】。

### 2. `packages/postgres/README.md` に、ANALYZE の数えがプロセスごとであることを書く（ADR 0460 D5）

- 【現物】`memoriesWriteCounts`（`memories-statistics.ts`）・`upsertCountsByTable`（`embedding-statistics.ts`）はモジュールスコープの `Map` で、`maybeAnalyzeTableAfterWrite`（`analyze-threshold.ts`）は「このプロセスが書いた累計」が等比の閾値（1,000 / 2,000 / 4,000 / …）に一致したときだけ `reltuples` を読む。TSDoc にはこの記述があるが README に無かった。
- 書いたのは、既存の「書き込み経路の自動 ANALYZE」の追記の続きの1段落: (1) 数えはプロセスごと、(2) N プロセスに散らすと累計が割れ、閾値に届かず自動の ANALYZE が打たれないことがある（寿命の短いプロセスは特に）、(3) 逆に複数プロセスが同じ頃に打ちうる、(4) 多プロセス運用では `--analyze-memories` を投入後・デプロイ後に打つこと。
- **これは【現物】を読んでの記述で、複数プロセスで実際に打たれる頻度は測っていない【未確認】**（ADR 0460 D5 と同じ）。README にもそう書いた。(3) は閾値の定義からの推論で、同時に打ったときの害（ロックの待ち合い）は README の既存の実測（`ShareUpdateExclusiveLock` どうしは待ち合う）を指すだけにとどめた。
- 歯は足していない【判断】: 散文の追記で、数も識別子も新たに焼き込んでいない（閾値の 1,000 / 2,000 / 4,000 は README の既存の記述と `INITIAL_ANALYZE_THRESHOLD` に既にある値で、定数が変わればこの README の他の箇所と同じくずれる——既存の扱いと同格）。多プロセスで頻度を測る歯は、材料（下の負債1）。

### 3. `MemoryStore.reinforce` の TSDoc に purged の扱いを書く（ADR 0453 負債3）

- **確かめた**【実測】: 既存の歯に purged × 強化の組は無かったので、歯 `packages/postgres/src/__tests__/reinforce-purged-memory.postgres.test.ts` を新しく足した（本物の Postgres）。記憶を `forget` → `purge` した後、4つの口（`runtime.observe({kind:'memory_usage'})`・`reinforce`・`reinforceMany`・`recordUsageAndReinforce`）を順に当て、(1) 毎回 `lastReinforcedAt` が進む（purge 直後は `null` からの書き込み）、(2) `status` は `forgotten`・`purgedAt`・`content`（`[purged]`）は不変、(3) 後の `recall()` に出ない、(4) `recordUsageAndReinforce` が新規挿入する形（別の it）でも書き換わる、を縛った。ADR 0453 の実測（24 セル）と同じ結果で、現物はその記述どおり。
- **赤→緑**: 新しい歯は、振る舞いを変えない直しの根拠なので、**既存の実装に対して初めから緑**（走らせた結果は 2 件緑）。「歯が噛む」ことは変異で示した。
- **変異**【実測】: (a) 足りない実装 — `reinforceManyOn` で purged の行を黙って飛ばすと 2 件とも赤（`memory not found`）。(b) やりすぎ — `reinforceManyOn` が purged を含む呼び出しを例外で断つと 2 件とも赤。どちらも `cp` で戻して緑。**単体の `reinforce` 口だけを変異させてはいない**【未確認】（`reinforceMany`・`recordUsageAndReinforce` 経由で撃つ変異のみ。単体口は歯が書き換えを見ているので、飛ばせば赤になるはずだが、確かめていない）。
- **書いた**: `memory-store.ts` の `reinforce` の TSDoc、`forgotten` の箇条の隣に `purged` の箇条を足した。振る舞いは変えない。**InMemory 側は測っていない**ので、そう書いた（testkit の fixture は 🟡 の扱い。conformance に it を足していない）。

## 採らなかった案

1. **usage を `README` の表から生成する。** 採らなかった。usage は人が読む文で、表の言い回しとは粒度が違う。生成器を足す大きさに見合わない。歯で「README の節に載せたものは usage にも在る」を縛るだけにした。
2. **usage に全部の環境変数（内部用も）を載せる。** 採らなかった。ADR 0478 の「内部用は載せない」の線を守る。
3. **purged への強化を弾く（store の約束にする）。** 採らなかった。ADR の決定を覆す・断る入力が増える変更で、オーナーの領分（ADR 0453 負債3の「覆る条件」）。
4. **ANALYZE のカウンタを DB に持たせる（プロセス間で共有する）。** 採らなかった。実装の変更で、頻度を測っていない段階では早い。

## 引き受けた負債（材料）

| # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
|---|---|---|---|---|---|
| 1 | 多プロセスでの ANALYZE の頻度を測っていない。README の(2)(3)は閾値の定義からの推論 | 複数プロセスから `memories` に書き、`pg_stat_user_tables.last_analyze` を見る | 推論と違えば README の段落を直す | 低 | 測ったとき |
| 2 | usage と README の言い回しは手で揃えている。歯が縛るのは「変数名が在る」ことだけで、意味の一致ではない | usage の説明文を変えても歯は緑 | 説明のずれは検出できない | 低 | 文の突き合わせが要るほど食い違いが出たとき |
| 3 | InMemory の `reinforce` が purged をどう扱うかを測っていない（TSDoc にそう書いた） | testkit の InMemory に同じ行列を当てる | Postgres と違えば fixture の差（🟡）として扱う | 低 | 測ったとき |

## これが覆るとしたら

オーナーが「purged には強化を書かない」を store の約束にしたとき（TSDoc の箇条と歯を書き換える）。ANALYZE の数えをプロセス間で共有する設計に変えたとき（README の段落を消す）。usage の環境変数の載せ方（全載せ・生成）を変えると決めたとき（歯を替える）。

## 測っていないこと

複数プロセスでの ANALYZE の実際の頻度。InMemory 側の purged への強化。`--help` の出力そのもの（歯は `cli.ts` のソースの文字列を見ている。出力は `cli-help.test.ts` が「使い方:」を含むことだけを見る）。`record*`・`verify*` 系のサブコマンドの環境変数（README の一覧に載せていないものは対象外）。
