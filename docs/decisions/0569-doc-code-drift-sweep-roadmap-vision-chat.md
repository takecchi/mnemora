# ADR 0569: 文書とコードのずれを横に掃く（第11弾）— `docs/roadmap.md`・`docs/vision.md`・`docs/alteroid-findings.md` と `examples/chat` のデモ本体のコメントを、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

ADR 0567（#1677）の続き。これまでの弾が触っていない文書から、次のものを掃く。文書とコメントだけの PR で、コードの振る舞いは変えない。

**照合の基準は main `09fbd68b`（その後 `355879fa` を merge で取り込み済み）。**

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

決まり（前回と同じ）: CHANGELOG の `[1.2.0]` 以前、採用済み ADR の本文、開いている PR・期限待ちの Draft PR が触るファイル（`docs/architecture.md`・`docs/memory-model.md`・`docs/conformance.md`・`docs/migration-v1.md`・`examples/chat/README.md`・`examples/chat/src/compare*.ts`・`examples/chat/src/scripts/**` ほか）、`runtime-fakes.ts` と core の `__tests__` は触らない。`docs/north-star.md` は正典なので触らない。ずれがあれば文書をコードに合わせ、コードの側を変えるべきものは直さずに材料として残す。日付の付いた追記・訂正の節の本文は1字も変えず、誤りは直後に「（2026-10-03 訂正）」を足す。数は写さず、在りかを指す。公開 TSDoc は直していないので、CHANGELOG は触っていない。

## 掃いたもの

- `docs/roadmap.md`・`docs/vision.md`・`docs/alteroid-findings.md`（全文）
- `examples/chat/src/cli.ts`・`providers.ts`・`mnemora-path.ts`・`correction-demo.ts` のコメント（`@mnemora/example-chat` は `private: true` で、公開 TSDoc ではない）

## 直したもの

### `docs/roadmap.md`

- **§1.3 の bullmq の 2026-09-29 追記**: 「PR が出ている」「version は `0.0.0` のまま」は成り立たない。`packages/bullmq/package.json` に `private` は無く、`scripts/publish-targets.mjs` の `PUBLISH_TARGETS` に入っている。直後に「（2026-10-03 訂正）」を足し、version は `package.json` を指した。Phase 3 の同日追記が「直前の節の同日追記」と指している先がこの追記であることも書いた。【現物】
- **Phase 2 の 2026-09-16 追記**: 「前倒しされていないのは関係グラフ本体の1行だけ」は成り立たない。`contradicts` の多者間の群は前倒しで実装済み（`memory_relations`・`RelationStore`・recall の段3の同伴取得、ADR 0378・0381）。`supersedes` を辿る探索は無く、`RelationKind` は `contradicts` だけ。注記群の末尾に訂正を足した。【現物】
- **§4 の表「監査ログの量」**: 期限切れ削除を記録する仕組みを「Phase 3 で実装する」と書いていた。すでに実装済みで、積まれるイベントは `events_purged`（`packages/core/src/event.ts`）。セルの末尾に訂正を足した。【現物】
- **§5.8**: 「Issue #204 がまだ着地しておらず」は古い。#204 は閉じており、`tick()` は `consolidate`/`reflect` を処理する（ADR 0157、`TICK_SUPPORTED_JOB_KINDS`）。§5.8 の問い（起点の選定）そのものは開いたままであることも書いた。【現物】

### `docs/vision.md`

- **2026-09-28 追記の「先頭が `tenant_id` でない索引」の一覧**: 後から入った索引（`0026`・`0027`・`0030`・`0031` の migration）が足りない。一覧は再掲せず、正本は `packages/postgres/migrations/` の `CREATE INDEX` だと指す訂正を足した。結論（テナントで絞るのは述語）は変わらない。【現物】

### `examples/chat/src` のコメント

- **`providers.ts`**: `MNEMORA_LLM`/`MNEMORA_EMBEDDING` の値の列挙が実装（`LLM_MODES`/`EMBEDDING_MODES`）より少なかった。列挙をやめて定数を指した。`git log -S 'anthropic'` が「1件もヒットしない」は `examples/chat/` 全体では偽で、`package.json` に絞れば成り立つ。そう直した。ADR 0072 の逐語の引用の中の `docs/roadmap.md` 段階6は削除済み（#762）と、引用の後に注記した。【現物・実測】
- **`mnemora-path.ts`**: 削除済みの roadmap 段階3を根拠に挙げていたのを、`observe()` の `externalId` による冪等性に直した。`tick()` の既定 limit の数の写しを `DEFAULT_TICK_LIMIT` を指す形にした。【現物】
- **`correction-demo.ts`**: recall の既定 limit の数の写しを `DEFAULT_RECALL_LIMIT` に。「`docs/recall.md` §2「無い」の分類」を §4 に。【現物】
- **`cli.ts`**:
  - 数の写しを除いた: correction の欄数、`CALIBRATION_SAMPLE_DESIGN` の点数、ADR 0019 §3 の回数・時間・費用の見積もり（§7.8 が実測で外れを記録している。§3 と §7.8 を指した）、`answer` のケース数（写しが現物と合っていなかった）、numeral・identifier の probe の件数、association の arm の行数。
  - 現物と合わない記述を直した: `describeMode` の「3層すべて」（`ProviderMode` は4値、ADR 0085）、`runIdentifierProbes` の「3群」（コードは5群）、retrieval を「CI には載せていない」（CI の `retrieval-quality` ジョブが recorded で走る、ADR 0088）、存在しないファイル名 `answer-time-weighting-bench.ts`（`time-weighting-bench.ts`）、存在しない README の節名、ずれた file:line 参照（シンボル名・節名・ジョブ名で指す形に）、`AGENTS.md` の存在しない節（冒頭・§5）の引用、`docs/autonomy.md` §2.2 の「決定3・5」（番号付きリストの3番・5番）。【現物】

## 直さなかったもの

- **実装を変えるべき食い違い**: 約束を破っているコードは無かった。ただし `cli.ts` の実行時の文字列（コメントではなくコード）に、上でコメントを直したのと同じ種類のずれが残っている。コードを変えることになるので触っていない。【現物】
  - `printHelp`: association-probes を「3arm」と書く（実装は maxCount=10 を足した4arm）。identifier-probes の説明に群4・5（日本語固有名詞）が無い。点数・ケース数・ADR 0019 §3 の見積もりの数を写している。`MNEMORA_PROVIDER_SOURCE` の効く先を「retrieval/compare」とだけ書く（`answer`・`answer-time-weighting` も `resolveRecordedRun` を使う）。
  - 実行時の出力の中の probe の件数・欄数・点数の写し。
  - 「ADR 0051 の「引き受ける負債」」（ADR の見出しは「引き受けた負債」）。「examples/chat/README.md「正直に書くべき限界」参照」（その見出しは README に無い。README は #1661 が触るので、どの節を指すかは別の PR で決める）。
- **出所の分からない参照**: `cli.ts` のコメント「仕様書「使う provider 層」節」の「仕様書」が repo の中に見つからない。直していない。【未確認】
- **測った記録として残したもの**: `mnemora-path.ts` の ADR 0168 の実測値、`correction-demo.ts` の ADR 0232 の実測値、`cli.ts` の当時の実測（コサインの最小値など）。当時の記録であり、写しの除去の対象にしていない。【判断】
- **`docs/roadmap.md` §4 の pgvector の行**（「要件を明文化する」）: 計画の時点の見立てとして読めるので、訂正を足していない（今は `@mnemora/postgres` が版を検査する。`docs/memory-model.md` §10）。【判断】
- **`docs/alteroid-findings.md`**: ずれなし。【現物】

## 【未確認】

- ビルド・テスト・リンク検査（この clone に node_modules が無い）。CI に任せる。
- 外部の実測を写した主張（pgvector の CVE と版の表、alteroid 側の事実、CI run 番号）の再現。
- 本文中の Issue の開閉は #204・#135・#291・#205 だけ見た。
- `vision.md` の NOT NULL の網羅は、`schema.ts` と migration を読んだだけで、実 DB では見ていない。
- 突き合わせは下請けの作業者が行った。担い手は差分がコメントと文書の行だけであること、CI の `retrieval-quality` ジョブ、`time-weighting-bench.ts` の実在、ADR 番号の空きを自分で確かめた。
