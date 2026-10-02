# ADR 0561: 文書とコードのずれを横に掃く（第9弾）— `docs/recall.md`・`packages/testkit/README.md`・`docs/north-star-paths.md`・`docs/README.md` を、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

ADR 0560（#1670）の続き。0560 は公開の README 4つを掃いた。今回は文書単位で、次の4つを掃く。文書だけの PR で、コードの振る舞いは変えない。

**照合の基準は main `a43e1f64`。**

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

決まり（前回と同じ）: CHANGELOG の `[1.2.0]` 以前、採用済み ADR の本文、`docs/architecture.md`・`docs/conformance.md`・`docs/memory-model.md`・`docs/migration-v1.md`、`examples/chat/**`、他パッケージ、`packages/core/src/runtime.ts` ほかコードは触らない。「clock は outbox の `availableAt` に届かない」に関する主張は ADR 0559 が直すので触らない。ずれがあれば文書をコードに合わせ、コードの側が約束を破っていそうなら直さずに材料として残す。日付の付いた追記・訂正の節の本文は1字も変えず、誤りは直後に「（2026-10-02 訂正）」を足す。数（件数など）は文書に写さず、在りかを指す。公開 TSDoc は直していないので、CHANGELOG は触っていない。

## 掃いたもの

- `docs/recall.md`（全文）
- `packages/testkit/README.md`
- `docs/north-star-paths.md`
- `docs/README.md`

## 直したもの

- **`packages/testkit/README.md` の導入文**: 適合テストの対象として `MemoryStore`・`VectorStore`・`EventStore`・`OutboxStore`・`TenantSettingsStore` の5つしか挙げていなかった。`src/index.ts` は `describeLexicalStoreConformance`・`describeRelationStoreConformance` も export しており、同じ README の「動く最小の例」の段落は、その2つを名指しで挙げている。`LexicalStore`・`RelationStore` を足した。【現物】
- **`packages/testkit/README.md` のインストールと peer の段落**: `pnpm add -D @mnemora/testkit @mnemora/core vitest`（と npm 版）、「`vitest` は `peerDependencies` である」だけを書いていた。`packages/testkit/package.json` の `peerDependencies` は `vitest` と `zod`（`^4.5.4`）の2つで、CHANGELOG が `zod` を peer にした経緯（公開の型 `LLMProviderConformanceOptions` が d.ts に `zod` の型を持つ。実行時の import は無い）を書いている。コマンドに `zod` を足し、「`zod` も `peerDependencies` である」段落を足した。範囲の数字は `package.json` を指し、README には1か所（`^4.5.4`、`@mnemora/core` と同じ範囲という説明）だけ書いた。【現物】
- **`docs/north-star-paths.md` の項目1の注意書き**: 「活動時計（`decayClock: 'activity'`）のテナントでは破れうる（#338、未実測）」。#338 は閉じており、境界は本物の Postgres で実測済みである（ADR 0311。実測値は ADR と Issue に在る）。呼び出しの引数 `RecallQuery.activityCounting`（`"tenant"` | `"subject"`、既定 `"tenant"`）で活動を数える単位を選べる（ADR 0353）。「未実測」を消し、ADR 0311 と ADR 0353 を指すようにした。数は写していない。この行は日付の付いた節ではない。【現物】
- **`docs/recall.md` §4 の表の `unit_assembly_dropped` の行**: 「`markContested` を呼ぶ本番コードは今日ひとつも無い」（【実測】2026-09-16）。いまの `packages/core/src/runtime.ts` では、`applyCorrection`（ADR 0242）と claim key の衝突の検出（ADR 0378）が `markContested` を呼ぶ。追跡していた Issue #284 も閉じている。この行は「2026-09-16 訂正」と日付の付いた本文なので書き換えず、表の直後に「（2026-10-02 訂正）」の段落を足した。同じ行の「`Runtime` 経由で作られた `contested` ペアが一対一を破ることは無い」は変わらない、と段落に書いた。【現物】
- **`docs/recall.md` §9.7 の `compare` ベンチの箇条**: 「基準値の全12行」と、`examples/chat/compare-baseline.json` の行数を写していた（現物でも `factStatementSurvived` はすべて `true` で、行数も同じだが、数を文書に写さない）。「基準値（`examples/chat/compare-baseline.json`）のすべての行」に直した。この箇条は日付の付いた節ではない。【現物】

## 直さなかったもの（実装側を変えるべき食い違い・この範囲の外のもの）

- **実装を変えるべき食い違いは無かった。** 4つの文書のどこにも、文書が正しくコードが約束を破っている、という食い違いは見つからなかった。
- **範囲の外で見つけたもの（直していない。別の担い手か別の PR への材料）**: `scripts/north-star-default-probe.mjs` の冒頭のコメントが「7項目の充足判定は `docs/roadmap.md` が正であり続ける（ADR 0216 決定8）」と書いている。`docs/roadmap.md` の §7 は #762 で削除され、7項目の現在地は `docs/north-star-paths.md` が持つ（この文書の冒頭の追記）。コメントの指し先が古い。`scripts/` は今回の範囲ではないので触っていない。【現物】
- **`docs/README.md` の「読む順」の表**は、`docs/` に在る文書をすべて挙げてはいない（`autonomy.md`・`conformance.md`・`migration-v1.md`・`north-star-paths.md`・`release-v1.md`・`release-notes-*.md` が無い）。表は「読む順」であって網羅を名乗っていないので、ずれとは数えず、足していない。【判断】

## ずれなしと確かめたもの

- **`docs/README.md`**【現物】: 表の各文書の説明（`memory-model.md` の見出し群、`recall.md` の「無い」の分類・目次帯・量の計測と予算、`roadmap.md` の §1・§4・§5、`vision.md` の「外から見える API」）、`Runtime` の中核5動詞と `export interface Runtime`（`packages/core/src/runtime.ts`）、ADR 0171、`AGENTS.md` の「数を、道具と生成物に焼き込まない」の見出し、`roadmap.md` §2 が墓標であること。ずれなし。
- **`packages/testkit/README.md`**【現物】: 8つの `describe*Conformance` の名前、`DeterministicLLMProvider`・`DeterministicEmbeddingProvider`（既定 8 次元）、`Recorded*`・`Recording*`・`CassetteRecorder`・`Seeded*`・`assertCassette`・`CASSETTE_FORMAT_VERSION`・`llmCassetteKey`・`embeddingCassetteKey` と `buildNew*Fixture` 3つ・`buildProvenanceFixture` の export、壊れたカセットを読んだ時点で落とす検査の4項目（ADR 0452）、`CassetteRecorder` が違う空間・モデルを断ること、`RecordingEmbeddingProvider` の並列の呼びで delegate を1回だけ呼ぶこと、`Seeded*` の `expectedModel`・`expectedSpace`（必須）と `delegate.space` との照合、`buildNewMemoryFixture` の `recordedAt`・`decayFloorAt` の注意、`@mnemora/testkit/fixtures` の7つの `InMemory*` と `package.json` の `exports`、`vitest` が peer であること（ADR 0066）、Node >= 22、`"type": "module"`、例のコードが使う `EventStore` の3メソッド・`EventFilter` の欄・`NewMemoryEvent.at` の省略可・`assertWellFormedCtx` の export、参照先の ADR 0047・0051・0066・0423・0436・0452 と `packages/postgres/README.md` の「例外の見分け方」・`docs/architecture.md` §5 の実在。ずれなし（上の2つを除く）。
- **`docs/north-star-paths.md`**【現物・機械的に確かめた】: `実装:` のファイル、`テスト:` のファイルと「」の中の名前（逐語、`grep -F`）、`口:` の名前（`scripts/__snapshots__/public-api/<パッケージ>.d.ts` に語として在る）。いずれも欠けなし（`scripts/__tests__/north-star-paths.test.mjs` が同じ検査をする）。ほかに、`DEFAULT_RECALL_ASSOCIATION` を `recall-runtime.ts` が省略時に当てること、ADR 0188・0337 が採用であること、ADR 0337 の変更が `v1.0.2` に入っていること（`git tag --contains`）、#375・#337・#762 が閉じていること、`package.json` の `north-star:default-probe`・`north-star:tarball-probe`、`docs/recall.md` §9.7 の実在。
- **`docs/recall.md`**【現物】: 型の例と実装の突き合わせ（`RecallResult`・`RecalledMemory`・`IndexBand`・`GroupCount`・`RecallUsage`・`RecallBudget`・`TokenCounter` の欄、`Omission` の種類は日付の付いた追記が実装との差を挙げており、その追記の内容も確かめた）、`RecallStageName` の値、`DEFAULT_OVER_FETCH_FACTOR`（4）、`DEFAULT_SCORE_THRESHOLD`（0.1）、`DEFAULT_ASSOCIATION_MIN_SIMILARITY`（0.5）、`DEFAULT_ASSOCIATION_ANCHOR_COUNT`、`DEFAULT_DIGEST_BAND_LIMIT`・`DIGEST_BAND_MAX_CHARS`・`DIGEST_BAND_MAX_ENTRY_CHARS` の名前と置き場、`digestBandLimit` が正の整数であること、`packDigestBand`、`FILTERED_CONDITION_SCOPE_RELATION`、`partitionByThreshold` の三分割、`compareScoredCandidates` の順（`total` 降順・NaN は最後尾 → 実効時刻の降順 → id 昇順）、`withinLimit.slice(0, anchorCount)`、連想枠の過取得、`detail.companionsAdded`・`detail.anchors/hits/selected`、`RecallUsageSchema` から `.max(1)` を外してあること（ADR 0097）、`share`・`budgetExceeded`・`byTier.association`、`heuristicTokenCounter` の係数、`computeFreshness`・`MAX_FRESHNESS`・`DEFAULT_HALF_LIFE_HOURS`（720）、`Ctx` の形と `RecallScope.subjectId` の doc の逐語、`activityCounting`、`pnpm --filter @mnemora/postgres run bench:scale` と環境変数3つ、参照先の ADR（本文中のすべてのリンク）・テストファイル・`docs/memory-model.md`・`docs/vision.md`・`docs/roadmap.md`・`docs/autonomy.md`・`docs/architecture.md`・`docs/migration-v1.md` の節・項目（項目19・55）の実在。ずれなし（上の2つを除く）。
- **`docs/recall.md` の日付の付いた追記・訂正**: 本文は1字も変えていない。ADR 0098・0203・0393・0452・0384・0390 などが挙げる欄（`outputValidation`・`cause`・`scopeAggregate`・`annReachability` など）が実装に在ることを、名前で確かめた範囲で一致した。

## 照らした範囲

読んだもの: 4つの文書の全文。`packages/core/src` の `recall.ts`・`recall-runtime.ts`・`runtime.ts`（`markContested` の呼び出し元）・`ctx.ts`・`digest-band.ts`・`heuristic-token-counter.ts`・`strategies/scoring.ts`・`strategies/decay.ts`・`interfaces/token-counter.ts`・`interfaces/tenant-settings-store.ts`・`interfaces/event-store.ts`・`event.ts`、`packages/testkit/src` の `index.ts`・`fixtures.ts`・`__fixtures__/cassette.ts`・`cassette-recorder.ts`・`seeded-provider.ts`・`deterministic-embedding-provider.ts`・`test-data.ts`・`event-store-conformance.ts`、`packages/testkit/package.json`、`packages/postgres/package.json`・`src/bench/scale-bench.ts`・`src/pgvector-capability.ts`、`examples/chat` の `compare-baseline.json`・`src` の一部、`scripts/__tests__/north-star-paths.test.mjs`・`scripts/north-star-default-probe.mjs`、`CHANGELOG.md` の testkit の `zod` の項、Issue #284・#337・#338・#375・#387・#762（`gh issue view`）。grep の語は、各文書に出てくる識別子（`DEFAULT_*`・`markContested`・`activityCounting`・`companionsAdded`・`withinLimit`・`peerDependencies` ほか）。

## 【未確認】

- 走らせていないもの: ビルド・テスト・`ts check` の型検査・`scripts/__tests__` の vitest テスト（この clone に `node_modules` が無い）。`north-star-paths.test.mjs` と同じ検査は、シェルの `grep` で再現して通した。CI に任せる。
- 外部の実測を写した主張は再現していない: `docs/recall.md` の `aggregateScope` の実測表（GitHub Actions run、native Postgres）、digest 長ごとの占有率、連想枠のアンカー数の表、境界の実測（`Math.pow(0.5, 1075)` が Node.js v22.23.3 で 0 になること）、`testkit` README の TypeScript 5.0〜7.0 の `TS1479` の実測。
- `docs/north-star-paths.md` の「npm の `@mnemora/core` に 1.0.2 が在る」は、npm を見ていない（git の tag は見た）。
- `docs/recall.md` §4 の追記（上）は、`applyCorrection` と claim key の衝突の検出が `markContested` を呼ぶことをコードで確かめた。`applyCorrection` を実際に呼んで `contested` ペアが作られることは、走らせていない。
- 日付の付いた追記の中の数値（`main` の sha、run の id、ms の値など）の再現。
- `packages/testkit/README.md` の例のコード（`EventStore` の自作）が、いまの適合テストを通ること。型は読んで確かめたが、vitest で走らせていない。

## 引き受けた負債

- この ADR の結果は `main` の `a43e1f64` に対して測った記録で、`main` が進めば古くなる。
- `docs/recall.md` は日付の付いた追記を積み重ねた構造で、本文の古い記述は追記が直している。追記を読まずに本文だけ読むと誤読する、という構造そのものは直していない（0560 と同じ負債）。
- 範囲の外で見つけた `scripts/north-star-default-probe.mjs` のコメントは、直していない。

## これが覆るとしたら

- 探し方が拾わない種類（散文で既定値や挙動を言い換えた文）の古さが、`docs/recall.md` の長い本文のどこかに残っていたとき。今回は識別子・既定値・参照先・型の欄を軸に突き合わせた。
- 【未確認】に挙げた実測の主張のどれかが、再現で食い違ったとき。
