# ADR 0510: 文書とコードのずれの掃きが「見ていない形」として残した、表の中の数値・定数と、既定値・振る舞いの散文を、コードの定数に名指しで照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-44ffeb19 の指示による）が書いた。文書の側もコードの側も直していない。**ずれは、直すべき形では見つからなかった**（下の「見つけたもの」）。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: ADR 0495（と、同じ掃きの 0520・0523）は、「見ていない形」として、散文の定性的な主張の全数・図・表の中の数値の全て・外部 SDK の実測値を残した。このうち、機械的に突き合わせられる**表の中の数値・定数**（文書の表や文に書かれた既定値・上限・閾値・件数が、コードの定数と一致するか）を、定数の側を名指しで引いて照らした。余力で、既定値・振る舞いを述べる散文を数件引いた。範囲の重なり: ADR 0526 以降にマージされた PR の差分は、別の担当（ADR 0533）が掃いている。【実測】`git log 33c070db^..origin/main` の PR（#1623・#1624）が触った文書は無く、触ったのは `packages/core/src/runtime.ts`・`recall-invariant-fuzz-harness.ts` とテストだけだった。**この掃きが見た文書の面と重ならない**。

- **照らした範囲**【現物】（`main` の `0bdc0e27`。ADR 0527 の merge の時点）:
  - 定数の側: `packages/*/src` の `export const` のうち数値・文字列・配列の定数（`DEFAULT_*`・`*_MAX_*`・`*_MIN_*`・`LEXICAL_QUERY_*`・`TRIGRAM_*`・`DIGEST_BAND_*`・`ATTRIBUTE*`・`LANGUAGE_MISMATCH_*`・`DEFAULT_LOCAL_EMBEDDING_*` ほか）の一覧を取り、文書がその名前または値を書いているかを逆に引いた。`examples/chat/src` の `DEFAULT_*`・probe の集合の定数。`.github/workflows/ci.yml` の `jobs` の鍵。
  - 文書の表（数値を含む行）: `docs/recall.md`・`docs/memory-model.md`・`docs/architecture.md`・`docs/conformance.md`・`docs/vision.md`・ルートの `README.md`・`packages/{core,postgres,openai,anthropic,bullmq,local-embedding}/README.md`・`examples/chat/README.md`（既定値の文）・`AGENTS.md`・`docs/{autonomy,north-star,north-star-paths,roadmap,release-v1}.md` の表。数値を含む表の行を取り出して読んだ。
  - 散文（既定値・振る舞い）: 上の文書の「既定」と数字が同じ文にある行、`検査しない`・`検査していない` の行。

- **照らして一致したもの**【実測】（文書の記述 → コードの出所。値は書かない）:
  1. `docs/recall.md` §3 の `k' = k × 4` → `DEFAULT_OVER_FETCH_FACTOR`。§9 の探索の安全弁「`maxCount` の10倍」→ `recall-runtime.ts` の `EXPLORATION_VISIT_LIMIT = relationMaxCount * 10`。目次帯の節（表の「既定 50」「`DIGEST_BAND_MAX_CHARS`」「`entry_limit`」「`char_budget`」）→ `DEFAULT_DIGEST_BAND_LIMIT`・`DIGEST_BAND_MAX_CHARS`・`DIGEST_BAND_MAX_ENTRY_CHARS`。実測の飽和件数の表（short 50件・medium 31〜32件・long 21件）は合成コーパスの実測で、定数の側が決める上限（50 と文字数の上限）の内側にある。`anchorCount` の表（`limit` と `anchorCount` の組）の「既定 3」→ `DEFAULT_ASSOCIATION_ANCHOR_COUNT`。`DEFAULT_SCORE_THRESHOLD`・`relationMaxCount` の範囲（1〜1000）・省略時の上限 → `DEFAULT_RECALL_ASSOCIATION`。
  2. `docs/recall.md`（omission の kind の表）の kind の集合 → `packages/core/src/recall.ts` の `Omission` の `kind` の一覧（**過不足なし**）。`stage_skipped` の `reason`（`recall.ts` の schema の enum の全部）→ 文書に全部在る。
  3. `docs/recall.md` §5・`docs/architecture.md` の「CJK 0.9・非CJK 0.25」→ `heuristic-token-counter.ts` の `CJK_WEIGHT_NUMERATOR`・`NON_CJK_WEIGHT_NUMERATOR`。`docs/memory-model.md` §9・`examples/chat/README.md` の「既定 720 で最大 2392 回」→ `DEFAULT_HALF_LIFE_RECALLS` と 0.1 の足切りから `720 × log2(10)` を手で計算して一致。
  4. `docs/architecture.md` §5.2 の語彙チャンネルの上限の値4つ（`LEXICAL_QUERY_MAX_DISTINCT_WORDS`・`_WORD_CHARS`・`_TOTAL_CHARS`・`TRIGRAM_JAPANESE_QUERY_MAX_CHARS`）と `packages/postgres/README.md` の同じ3つ → `lexical-query-cap.ts`。**文書は値を書き写している**（ほかの文書は名前だけを書く形が多い）ので、定数が動けばずれる。【判断】いまは一致で、直さない。
  5. `docs/memory-model.md` §11 の言語の取り違えの閾値（かな・漢字 4字以上・0.3）→ `LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_CHARS`・`_CJK_SHARE`。（`LANGUAGE_MISMATCH_MIN_LATIN_SHARE` ほかの値は文書に書いていない。）`docs/memory-model.md` の状態遷移の表の「統合元 2件以上」「群は3件以上」→ `runtime.ts` の `memberIdSet.size >= 3`・`markContestedGroup` の「at least 3 entries」。
  6. `packages/local-embedding/README.md` の「オプション」の表（`dimensions`・`numThreads`・`maxBatchSize`・`retry` の `attempts`）と、「256次元・1536 の 1/6」→ `DEFAULT_LOCAL_EMBEDDING_*`。`docs/conformance.md` §4 の「768成分」→ `live.local-embedding.test.ts` の TSDoc と `fixtures/real-ruri-embeddings.json` の `determinismCheck` に同じ文言。**256次元の3本分（3 × 256 = 768）であって、モデルの次元ではない**（紛らわしいが、書いた側は一貫している）。`maxInputTokens`・`countTokens` を `LocalEmbeddingProvider` が読まない（README の散文）→ `pipeline.ts` だけが使う。
  7. `packages/bullmq/README.md` の `everyMs`・`jobName`・`queueName` の表 → `tick-driver.ts` の `assertEveryMs`（1〜`Number.MAX_SAFE_INTEGER`）と `jobName` の検査（文字列でなければ `TypeError`・空なら `RangeError`）。`jobName` の既定。
  8. `packages/anthropic/README.md` の `max_tokens` の行 → `DEFAULT_MAX_TOKENS`（の名前。値は書いていない）。`packages/openai/README.md` の入力の境界の表（8192 トークン・2048 件・1536 次元）は外部 API の実測で、コードに定数が無い（【未確認】の側）。
  9. ルート `README.md` の probe の件数 → `PROBES`・`IDENTIFIER_PROBES`・`NUMERAL_TOKEN_PROBES`・`CORRECTION_HIT_CASE_SET_EVAL`・`CORRECTION_ABSTAIN_CASE_SET_EVAL` の要素数を、`id:` の行で数えて**一致**した（`examples/chat/src`）。表と追記のジョブ名（`retrieval-quality`・`identifier-probes`・`numeral-token-probes`・`correction-candidate-probes`・`consolidation-cost`・`association-probes`・`archive-sweep-cost`・`time-term`・`validity`）→ `ci.yml` の `jobs` の鍵に**全部在る**。`MNEMORA_OPENAI_FP_CEILING_ROUNDS` の既定 → `openai-embedding-fp-ceiling.ts`。
  10. `examples/chat/README.md` の `groupSize`・`DEFAULT_BUDGET_LADDER`（段の列）・`DEFAULT_MARGIN_HOURS`・`DEFAULT_HALF_LIFE_HOURS`・`MNEMORA_ANSWER_TRIALS_N`・probe の haystack →  各 `DEFAULT_*`。
  11. 実測の表（`docs/recall.md` の `aggregateScope` の表・目次帯の占有率・`packages/core/README.md` の同じ表）は、数が文書の間で一致した（`packages/core/README.md` と `docs/recall.md` の行数ごとの ms の列ほか）。`281.2ms → 156.0ms` の「約1.8倍（-44.5%）」は割り算で一致し、ADR 0307 の表に同じ値がある。`packages/postgres/README.md` の `261.0ms`・`167.8ms` も ADR 0307 の表に在る。

- **見つけたもの**: **直すべきずれは、上の範囲で見つからなかった。** 食い違いに見えた次の3件は、**本文の側が追記で自分の古さを書いている**ので、直す対象にしなかった（ADR README の「訂正は追記」の作法）:
  - `docs/conformance.md` §2.1 の「store 系6 suite」「6つの `describe*Conformance({`」は、いまの呼び出し（`RelationStore` を含む7つ、Postgres 側も7つ）と合わないが、同じ節の 2026-09-30 の追記が「上の表の2つの呼び出し元は…」と書いている。
  - `docs/memory-model.md` の行12・行13の「`tick()` はこの操作を駆動しない」は、`TICK_SUPPORTED_JOB_KINDS` に `consolidate`・`reflect` が在るので古いが、同じ節の追記が「もう成り立たない」と書いている。
  - `docs/release-v1.md` の「6本とも `0.1.1`」「13/13」は日付つきの当時の実測であり、現在の主張ではない。
  **コードの側を直すべき食い違い**: 見つからなかった。

- **陽性対照**【判断】: この掃きの「一致した」は、人が表を読んで定数を引いた結果であり、**機械の探り棒ではない**。したがって「一致」は「その行を引いた」までで、「全部の行を引いた」ではない。数を数える形（9 の probe の件数・omission の kind・`stage_skipped` の reason）は、わざとずらして拾えることを確かめていない（【未確認】）。道具にして門にはしない（ADR 0495 の代替案1・2と同じ理由。文書の「既定」の書き方が揺れていて、対応表が写しになる）。

- **走らせたコマンド**: `pnpm install --frozen-lockfile`（`pnpm run build` はしていない）・`node scripts/generate-adr-index.mjs`・文書の歯（`scripts/__tests__/markdown-link.test.mjs`・`doc-reference.test.mjs`・`living-doc-judgment-pointer-consistency.test.mjs`・`adr-index-freshness` ほか。結果は PR 本文）を名指しで。ローカルで全テストは走らせていない。

- **見ていない形**【未確認】:
  - 図（`docs/architecture.md` のアスキー図・状態遷移図）。
  - 散文の定性的な主張の全数。引いたのは「既定」と数字が同じ文と `検査しない` の行だけで、それ以外の文（「〜は〜しない」「〜のとき〜を投げる」の大半）は読んでいない。
  - 外部の実測値（`openai` の 8192 トークン・2048 件、`local-embedding` の peak RSS・文/秒・`cuda12` の 302MB、pnpm の挙動、Hugging Face の取得ファイルの大きさ）。コードに定数が無く、実 API・実ネットワーク・実機が要る。
  - Issue のコメントが出所の実測の表（`docs/recall.md` の `aggregateScope` の 9.0ms・45.8ms・408.0ms の行と、目次帯の占有率の表の各値）。出所が repo の外（GitHub Actions の run・Issue コメント）で、この器からは引いていない。
  - `docs/migration-v1.md`・`CHANGELOG.md`・`docs/release-notes-*.md`・`docs/alteroid-findings.md`・各 ADR。
  - ADR 0526 以降の PR の差分（ADR 0533 の担当）。

- **検討した代替案**:
  1. **表の数値と定数の対応を道具にして `scripts/` に入れる。** 採らなかった。文書の書き方が表ごとに違い（名前で書く・値で書く・実測の値）、定数名との対応表が写しになる（AGENTS.md「数を、道具と生成物に焼き込まない」）。
  2. **`docs/architecture.md`・`packages/postgres/README.md` が書き写している語彙の上限の値を、名前だけにする。** 採らなかった。いまは一致しており、直す理由が無い。ずれたときの直し先は、この ADR の 4 に書いた。

- **引き受けた負債**:
  - 上の【未確認】の全部。
  - 「一致」は `main` の `0bdc0e27` に対する記録で、`main` が進めば古くなる。
  - 値を書き写している文書（上の 4）は、定数が動くとずれる。歯は無い。

- **これが覆るとしたら**: 上の範囲に直すべきずれが在ったと、あとで分かったとき。とくに、人が表を引いて拾い漏らした行（「一致」の主張は全数ではない）か、見ていない形（図・外部の実測・散文の全数）から出た食い違い。そのときは、この ADR の「見つけたもの」は「当たった範囲の結果」だったことになる。
