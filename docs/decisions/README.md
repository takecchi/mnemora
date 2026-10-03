# Architecture Decision Records

mnemora の設計判断のうち、**後から見て「なぜそうしたか」を追える形で残す必要があるもの**を
ADR (Architecture Decision Record) として記録する。`docs/architecture.md` や
`docs/memory-model.md` 等の他の docs が「何がどう決まっているか」を記述するのに対し、
ここでは各決定について、検討した選択肢・却下した理由・引き受ける負債・覆る条件までを
1ファイルにまとめる。**決定そのものをやり直す場ではなく、決定を記録する場である。**

**⛔ 採用済み ADR の本文は書き換えない。訂正が要るなら、その場に追記する。**
**理由は上の1文である**——ここは記録の場であり、**間違え方それ自体が記録だからである。**
本文を直すと「何をどう判断して外したか」が消え、**訂正を積んだ経緯も追えなくなる。**
（**この作法は実際に繰り返し採られている**——根拠と反例は
[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定1。
⚠ **まだ採用されていない初稿はこの限りではない。**そして
**`docs/north-star.md` は別の規律で守られている**——`AGENTS.md` を見ること。）

**⚠ ADR 本文に現れる識別子名（関数名・ファイル名・型名）は、その ADR が書かれた時点のものである。現在の名前とは限らない。**
現在の名前は現物を引くこと。**⛔ 名前が変わるたびに、既存 ADR へ追記して回らないこと。**
[ADR 0213](./0213-live-docs-cite-adrs-by-anchor-not-line-number.md) 決定5 の 2026-09-17 の追記が、
**「いまの状態を指すポインタ」は直し、「当時の観測・当時の状態を書き留めた記録」は直さない**と
線を引いている——ADR 本文は後者である。**旧名から現在の名前へ辿れる形は、名前を変えた側の
ADR が持つ**（例: [ADR 0222](./0222-compare-gate-judges-only-when-turncount-sets-match.md)
決定1 と、同 ADR「引き受けた負債」節の逐語「**旧名を追う人は、この ADR の決定1へ辿り着くこと**」）。

alteroid (github.com/takecchi/alteroid) を根拠として引く箇所は、確認済み/未確認を分けた
一次調査の記録である [docs/alteroid-findings.md](../alteroid-findings.md) を参照する。

**ADR のファイル名は `NNNN-slug.md` の形にする**（`NNNN` は4桁の番号、`slug` は小文字の英数字とハイフンだけ。**ドット `.` や大文字・アンダースコアは使えない**）。4桁の番号で始まる `.md` がこの形から外れていると、`node scripts/generate-adr-index.mjs` と索引の歯は、無視せず例外で落ちる（[ADR 0537](./0537-adr-index-rejects-malformed-adr-filename.md)）。

**`docs/decisions/` の直下に置いてよい ADR ではない `.md` は `README.md` と `TEMPLATE.md` だけ**である。これ以外の `.md`（`adr-0538-x.md`・`538-x.md`・`0538_x.md`・`notes.md` など、ADR の形でないもの）は、番号で始まらなくても同じく例外で落ちる。`.md` 以外のファイルとサブディレクトリの中は対象外。`scripts/adr-renumber.mjs` も同じ規則で、書き換え・改名の前に落ちる（[ADR 0540](./0540-adr-filename-rule-shared-allowlist.md)）。許す一覧を増やすときは `scripts/generate-adr-index-lib.mjs` の `ALLOWED_NON_ADR_MARKDOWN` とここを一緒に直すこと。

## 一覧

**この表は手で編集しない。** `docs/decisions/*.md` の1行目の見出しと状態欄から `node scripts/generate-adr-index.mjs` が生成する（[ADR 0137](./0137-adr-index-generated-from-source.md)）。ADR を追加する PR の側で上のコマンドを実行して索引も一緒にコミットし、`adr-index-freshness` の歯を PR 上で緑にしてからマージする。ほかの ADR の PR と索引の行が衝突したら、`main` を merge で取り込み、生成器で作り直す（ADR 0137「決定」2番は「作成者は触らない」と読めるが、実際の運用はこちら。同 ADR 末尾の 2026-09-30 の追記）。

<!-- ADR-INDEX:GENERATED:START -->

| 番号 | 題 | 状態 |
| --- | --- | --- |
| [0001](./0001-orm-drizzle.md) | ORM は Drizzle | 採用 (2026-09) |
| [0002](./0002-embedding-space-tables.md) | pgvector の抽象と埋め込み空間ごとのテーブル分割 | 採用 (2026-09) |
| [0003](./0003-memorystore-vs-vectorstore.md) | MemoryStore と VectorStore を分けるか | 採用 (2026-09) |
| [0004](./0004-decay-at-query-time.md) | 忘却をクエリ時に算出しつつ ANN 索引を殺さない | 採用 (2026-09) |
| [0005](./0005-job-queue-abstraction.md) | Job Queue の抽象 | 採用 (2026-09) |
| [0006](./0006-memory-schema.md) | Memory schema の設計判断 | 採用 (2026-09) |
| [0007](./0007-tenant-scoping.md) | Tenant scoping | 採用 (2026-09) |
| [0008](./0008-absence-taxonomy.md) | 「無い」を分類して返す | 採用 (2026-09) |
| [0009](./0009-usage-feedback-via-observe.md) | 使用フィードバックを observe() で受ける | 採用 (2026-09) |
| [0010](./0010-decay-parameters.md) | 減衰の式とパラメータを固定する | 採用 (2026-09) |
| [0011](./0011-no-window-count-in-ann-stage.md) | 段1の ANN クエリに `count(*) OVER ()` を入れない | 採用 (2026-09) |
| [0012](./0012-ingest-pipeline-design.md) | 取り込みパイプライン（`observe()` / `runtime.tick()`）の実装方針 | 採用 (2026-09) |
| [0013](./0013-extraction-outcome-taxonomy.md) | 抽出の失敗を、成功と同じ顔で記録しない | 採用 (2026-09) |
| [0014](./0014-package-name-mnemora.md) | 名前を `mnemora` / `@mnemora/*` に確定する | 採用 (2026-09) |
| [0015](./0015-root-test-gate-reports-skipped-db-tests.md) | ルートの `test` 門は、DB テストを「走らせなかった」と明示する | 採用 (2026-09) |
| [0016](./0016-db-test-gate-explicit-exclusion.md) | DB テストの排他は依存グラフに頼らず、門のコード自身に載せる | 採用 (2026-09) |
| [0017](./0017-runmigrations-advisory-lock.md) | `runMigrations()` を advisory lock でプロセス間排他する | 採用 (2026-09) |
| [0018](./0018-register-embedding-space-advisory-lock.md) | `registerEmbeddingSpace()` を advisory lock でプロセス間排他する | 採用 (2026-09) |
| [0019](./0019-real-openai-measurement-cost.md) | 本物の OpenAI で北極星の物差しを測る — 費用・実測値・分かったこと | 採用 (2026-09) |
| [0020](./0020-temp-database-drain-before-drop.md) | 使い捨てテスト DB は「接続0本」を実測してから `DROP DATABASE`（`WITH (FORCE)` を使わない） | 採用 (2026-09) |
| [0021](./0021-drain-embed-ticks-in-ingest.md) | `examples/chat` の `ingestConversation` は `tick()` を干上がるまで回す | 採用 (2026-09) |
| [0022](./0022-fake-provider-compare-does-not-claim-recall-quality.md) | 北極星の「削っても目的の記憶が落ちない」を、擬似 provider の `compare` では主張しない | 採用 (2026-09) |
| [0023](./0023-subject-filter-in-ann-stage.md) | 段1の ANN クエリで `subject` を等値で絞る（`period` は降ろさない） | 採用 (2026-09) |
| [0024](./0024-remove-exact-counts-option.md) | 実装の無い `exactCounts` を、「予約」と書き残さずに削除する | 採用 (2026-09) |
| [0025](./0025-ann-underfill-is-not-reported-in-omitted.md) | 段1の ANN が窓を埋められなかったことが、`omitted` に出ていない（実測。**決定は保留**） | **未決 (2026-09)** |
| [0026](./0026-ann-unreached-omission.md) | 近似索引が scope に届かなかったことを `Omission { kind: 'ann_unreached' }` として出す | 採用 (2026-09) |
| [0027](./0027-split-superseded-forgotten-omission.md) | `filtered` omission の `condition: 'status'` を `'superseded'` と `'forgotten'` に分ける | 採用 (2026-09) |
| [0028](./0028-reextract-superseded-cleanup.md) | `reextract` は古い抽出結果を `superseded` にする（`forgotten` にしない） | 採用 (2026-09) |
| [0029](./0029-reextract-skip-visibility.md) | `reextract` が既存 Memory を supersede しなかった理由を `ReextractResult` に出す | 採用 (2026-09) |
| [0030](./0030-update-status-compare-and-swap.md) | `MemoryStore.updateStatus` を compare-and-swap にし、`reextract` の安全弁の TOCTOU を塞ぐ | 採用 (2026-09) |
| [0031](./0031-supersede-status-and-event-in-one-transaction.md) | `reextract` の supersede が status 更新とイベント追記を別々の2コミットで行っていたのを、1つのメソッド・1トランザクションにまとめる | 採用 (2026-09) |
| [0032](./0032-outbox-claim-lease.md) | `OutboxStore.claimBatch` に claim のリースを足し、「見えない停止」と「先頭詰まり」を塞ぐ | 採用 (2026-09) |
| [0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) | `retrieval` ベンチが順位の理由を捨てていたのをやめる — 実際に順位を決めていた項の実測 | 採用 (2026-09) |
| [0034](./0034-vector-store-filter-conformance.md) | `VectorFilter` を「adapter が実際に適用しなければならない」契約にし、その契約を適合テストの歯として置く | 採用 (2026-09) |
| [0035](./0035-recalled-memory-provenance-kind.md) | `recall()` の返り値に `provenanceKind` を載せる — 「区別して返す」を、返り値の側で満たす | 採用 (2026-09) |
| [0036](./0036-clamp-freshness-at-one.md) | `freshness` を 1 で頭打ちにする — 「まだ起きていない出来事は、最も古びていない」 | 採用 (2026-09) |
| [0037](./0037-callers-pass-occurred-at.md) | `observe()` の `occurredAt` を、実際に通す — 「いつの出来事か」を絞れるようにする | 採用 (2026-09) |
| [0038](./0038-vector-hit-distance-is-cosine.md) | `VectorHit.distance` はコサイン距離だと契約に明記し、適合テストの歯で adapter 非依存に検査する | 採用 (2026-09) |
| [0039](./0039-period-boundary-conformance.md) | `period` の判定規則が4箇所に在ることを、境界の歯で固定する | 採用 (2026-09) |
| [0040](./0040-zero-vector-never-returned.md) | ゼロベクトルが絡む候補は `recall()` の結果に出ない — 契約は振る舞いで揃える | 採用 (2026-09) |
| [0041](./0041-reinforce-does-not-change-strength.md) | `reinforce` は `strength` を動かさない — 「強化」の意味を確定させる | 採用 (2026-09) |
| [0042](./0042-event-store-list-order-and-limit.md) | `EventStore.list` の並び順・`limit`・`since`/`until` を契約に明記し、適合テストの歯で固定する | 採用 (2026-09) |
| [0043](./0043-unit-assembly-dropped-omission.md) | 一対一の対向関係が破れて候補が単位から漏れたら、`omitted` に出す（黙らない） | 採用 (2026-09) |
| [0044](./0044-score-not-comparable-omission.md) | 段2の閾値比較を網羅的な三分割にし、`score_not_comparable` を `omitted` に出す | 採用 (2026-09) |
| [0045](./0045-budget-dropped-count-kind.md) | `budget_dropped` の `countKind` を、単位の網羅性から引き継ぐ | 採用 (2026-09) |
| [0046](./0046-contested-pair-invariant-tooth.md) | `contested` の一対一を「測れる形」にする——振る舞いは決めない | 採用 (2026-09) |
| [0047](./0047-fake-referential-integrity-existence-only.md) | 擬似物（in-memory 実装・core の Fake）にも外部キー相当の「存在」検査を適用する（「整合」までは広げない） | 採用 (2026-09) |
| [0048](./0048-reinforce-does-not-move-decay-origin-backwards.md) | `reinforce` は減衰の起点を巻き戻さない——比較を DB の1文へ入れる | 採用 (2026-09) |
| [0049](./0049-reinforce-monotonicity-in-pseudo-implementations.md) | `reinforce` の単調性を擬似物にも揃える——新しい決定ではなく、ADR 0048 の追随 | 採用 (2026-09) |
| [0050](./0050-tenant-event-retention.md) | `TenantSettingsStore` に event retention の読み書きを足す | 採用 (2026-09) |
| [0051](./0051-recorded-provider-cassette.md) | 記録した実 API の応答を再生する provider を、物差しの経路にだけ入れる（二層にする） | 採用 (2026-09) |
| [0052](./0052-compare-cassette-and-provenance-survival.md) | `compare` を実 API で測ったら「答えが落ちる」は消えた — 擬似物の産物だったことの確認と、その代償 | 採用 (2026-09) |
| [0053](./0053-set-embedding-status-does-not-roll-back-ready.md) | `setEmbeddingStatus` は `ready` を `failed` へ巻き戻さない——禁じるのは1本だけ | 採用 (2026-09) |
| [0054](./0054-idempotent-create-from-the-insert-decision.md) | 擬似実装の `created` は挿入の決定そのものから出す——判定と挿入の間に `await` を挟まない | 採用 (2026-09) |
| [0055](./0055-extraction-prompt-subject-and-inference-not-added.md) | 抽出プロンプトに「主語を復元する1文」も「推論を生成する1文」も足さない — 実 API 18 run で測った結果と、その代償 | 採用 (2026-09) |
| [0056](./0056-exclude-provenance-kinds-in-ann-stage.md) | 段1の ANN クエリで `excludeProvenanceKinds` を絞る（`period` は今回も降ろさない） | 採用 (2026-09) |
| [0057](./0057-dedicated-schema-namespace.md) | mnemora のオブジェクトを置くスキーマを、使う側が指定できるようにする | 採用 (2026-09) |
| [0058](./0058-measure-the-time-term-in-a-separate-arm.md) | 時間項は、既存の probe set を書き換えずに、別 arm で分離して測る — `probe-set.ts` に `occurredAt` を書き込まない | 採用 (2026-09) |
| [0059](./0059-period-in-ann-stage.md) | 段1の ANN クエリで `period` を絞る（`COALESCE(occurred_at, recorded_at)` の式索引を1本足す） | 採用 (2026-09) |
| [0060](./0060-publish-with-pnpm-four-packages-at-0-1-0.md) | npm へ出すのは4パッケージだけ・初回は `0.1.0`・梱包の道具は pnpm に統一する | 採用 (2026-09) |
| [0061](./0061-license-mit.md) | ライセンスを MIT にする | 採用 (2026-09) |
| [0062](./0062-contested-with-id-fk-index.md) | `memories.contested_with_id` の自己参照 FK に索引を足す — `tenant_id` 先頭の複合索引は RI チェックを効率良く供給できないこと・索引名は中身を保証しないこと | 採用 (2026-09) |
| [0063](./0063-hnsw-iterative-scan-not-adopted.md) | `hnsw.iterative_scan` は採らない — 件数は直るが正しさは直らないことを測った | 採用 (2026-09) |
| [0064](./0064-exact-path-cost-vs-scale.md) | 厳密経路の費用倍率を規模で振って測った — 「約2.5倍」の訂正と、`relaxed_order` の recall が規模とともに悪化するという発見 | 採用 (2026-09) |
| [0065](./0065-vector-store-space-separation-conformance.md) | `VectorStore` の space 分離を適合テストの歯にする — `FakeVectorStore` に丸ごと空いていた一段と、監査の漏れの記録 | 採用 (2026-09) |
| [0066](./0066-start-publishing-with-oidc.md) | publish を始める。梱包は pnpm・アップロードは npm（Trusted Publishing / OIDC） | 採用 (2026-09) |
| [0067](./0067-dry-run-fail-open-and-does-not-verify-trusted-publisher.md) | 予行フラグの fail-open を安全側へ反転する — そして `--dry-run` は信頼発行元の設定を検証できないと実測した | 採用 (2026-09) |
| [0068](./0068-the-bench-must-not-lie-about-what-it-measured.md) | `retrieval` ベンチが「測っていないこと」を測ったかのように印字するのをやめる — 2回目の実行の嘘・arm を跨いで数字を拾える形・キーが在るだけで実 API へ倒れること | 採用 (2026-09) |
| [0069](./0069-ann-truncated-says-nothing-about-loss.md) | `ann_truncated` は「損したか」を一切言っていない — 正典が付けた条件が機能していないことの実測と、案A（安全余裕を札に載せる）の採用 | 採用 (2026-09) |
| [0070](./0070-version-comes-from-the-release-tag.md) | 版の権威は Release の tag に置く。`package.json` の `version` は権威ではなくなる | 採用 (2026-09) |
| [0071](./0071-delegate-phase-2-selection-to-autonomous-agents.md) | Phase 2 の作業選定を自律エージェントへ委譲する。境界は「取り消せるか」で引く | 採用 (2026-09) |
| [0072](./0072-anthropic-llm-provider.md) | `@mnemora/anthropic` を足す — `LLMProvider` だけを実装し、翻訳先はネイティブの構造化出力にする | 採用 (2026-09) |
| [0073](./0073-digest-band-bounded-without-taxonomy.md) | digest 帯を実装する — taxonomy は要らなかった。上限は3つ持つ | 採用 (2026-09) |
| [0074](./0074-impression-topic-growth-what-mnemora-cannot-hold.md) | 「印象」「話題」「成長」を mnemora は持てるか — 現物で当てた結果と、3つの案 | **提案 (2026-09)** |
| [0075](./0075-openai-refusal-and-truncation.md) | `@mnemora/openai` も、拒否・打ち切りを「空の成功」にしない — `kind` で区別する | 採用 (2026-09) |
| [0076](./0076-extraction-carries-failure-kind.md) | 抽出は例外を飲み続ける。ただし**中身は捨てない** — `kind` を `ObserveResult` まで運ぶ | 採用 (2026-09) |
| [0077](./0077-testkit-fixtures-subpath.md) | インメモリのストアを `@mnemora/testkit/fixtures` から出す — **`index` からは出さない** | 採用 (2026-09) |
| [0078](./0078-strength-value-range.md) | `Memory.strength` の値域を `(0, 1]` に塞ぐ — 口を開ける前に蓋を付ける | 採用 (2026-09) |
| [0079](./0079-requeue-embed-jobs.md) | 索引に載らなかった Memory を積み直す口を開ける — 「見えているのに直せない」を塞ぐ | 採用 (2026-09) |
| [0081](./0081-similarity-is-the-only-term-that-ranks.md) | 順位を決めているのは `similarity` ただ1項である — 項ごとの「何通りか」を数え、`(a)` を2つに割った実測 | 採用 (2026-09) |
| [0082](./0082-tick-names-unsupported-job-kinds.md) | `tick` が処理できない kind を、`failed` の中に埋めない — 「無い」の種類を潰さないを、outbox の側でも守る | 採用 (2026-09) |
| [0083](./0083-cjk-aware-heuristic-token-counter.md) | 既定 `TokenCounter` を文字種で重み付けする — 「4文字 ≒ 1トークン」は日本語で予算を静かに超えさせる | 採用 (2026-09) |
| [0084](./0084-lexical-recall-channel.md) | recall に語彙候補生成チャンネルを足す — 追加拡張を入れず、引けないものを引けないと名乗る | 採用 (2026-09) |
| [0085](./0085-local-embedding-provider.md) | 外部サービスに繋がない埋め込み provider を足す — 契約を変えず、対称 prefix を名前に焼き込む | 採用 (2026-09) |
| [0086](./0086-no-import-meta-in-published-artifacts.md) | 配布物から `import.meta` を消す — CommonJS のサイドカー1枚で、CJS へ変換する利用側に届ける | 採用 (2026-09) |
| [0087](./0087-runtime-forget-shape.md) | `Runtime.forget()` の形を決める — 決めるのは意味論ではなく「無い」の割り方 | 採用 (2026-09) |
| [0088](./0088-retrieval-quality-measured-in-ci.md) | 想起の質を CI で継続計測する — 記録の再生で鍵なしに測り、⛔ 門にはしない | 採用 (2026-09) |
| [0089](./0089-runtime-consolidate-shape.md) | `Runtime.consolidate()` の形を決める — 統合は3層のどれでもなく、`superseded` を使う | 採用 (2026-09) |
| [0090](./0090-embedding-input-token-limit.md) | 埋め込みの入力が上限を超えたことを名乗る — 8192 トークンの壁と、導かれる識別子の余裕 | 採用 (2026-09) |
| [0091](./0091-runtime-reflect-shape.md) | `Runtime.reflect()` の形を決める — 内省は「足す」操作であり、`superseded` を使わない | 採用 (2026-09) |
| [0092](./0092-lexical-or-coverage.md) | クエリ語彙を OR で結び、`lexicalMatch` を被覆率にする — ADR 0084 §10 が残した独立の変更 | 採用 (2026-09) |
| [0093](./0093-extension-verify-mode.md) | `CREATE EXTENSION` を発行できないロールのための口 — 「作らない」ではなく「検査する」 | 採用 (2026-09) |
| [0094](./0094-identifier-probes-local-embedding.md) | 識別子・固有名詞の probe を、鍵もカセットも要らないローカル埋め込みで測る — ゴールデンセットを増やす道を1本開ける | 採用 (2026-09) |
| [0095](./0095-embedding-provider-conformance.md) | `EmbeddingProvider` の適合テストを新設する — 順序の検査は決定性を前提にしているので、決定性を「宣言させる」 | 採用 (2026-09) |
| [0096](./0096-bootstrap-local-embedding-onto-npm.md) | `@mnemora/local-embedding` を npm へ載せる — 初版は OIDC で出せないので、tag 由来の中身を手元から1回だけ出す | 採用 (2026-09) |
| [0097](./0097-recall-usage-share-may-exceed-1.md) | `usage.share` は 1 を超えうる — `.max(1)` は保証ではなく、守られていない宣言だった | 採用 (2026-09) |
| [0098](./0098-validate-recall-output.md) | `recall()` の出力を zod で検証する — 既定では投げず、検証結果を呼び手に返す | 採用 (2026-09) |
| [0099](./0099-conformance-against-real-embedding-providers.md) | 適合テストを**本物の** `EmbeddingProvider` に当てる — 足場が素直だと、歯は緑のまま嘘をつく | 採用 (2026-09) |
| [0100](./0100-supersede-with-new-memories.md) | 統合パイプラインの「新 Memory の作成」と「旧行の supersede」を1トランザクションにする口を足す（任意メソッド） | 採用 (2026-09) |
| [0101](./0101-how-to-measure-whether-consolidate-moved-the-north-star.md) | 統合が北極星の物差しに効いたかを、どの数で測るか — 🔴 いちばん物差しに近い軸だけが、擬似 LLM では測れない | 採用 (2026-09) |
| [0102](./0102-bench-keeps-partial-measurements-on-abort.md) | ベンチが例外で死ぬとき、測れた分を捨てない — 包むことの増分は「例外」ではなく「文脈」である | 採用 (2026-09) |
| [0103](./0103-negative-tooth-declares-its-precondition.md) | 否定を主張する歯は、その否定が依存している前提を自分で測って名乗る — 揺れていたのは版でもビルドでもロケールでもなく `server_encoding` だった | 採用 (2026-09) |
| [0104](./0104-recall-gate-index-tooth-measures-applicability.md) | 索引の歯は「プランナが選んだ」ではなく「この述語に使える」を測る — 落ちたのは実装ではなく、同じ部分述語の索引が1本増えたからだった | 採用 (2026-09) |
| [0105](./0105-postgres-regime-matrix.md) | `postgres` ジョブを server_encoding の matrix にする — UTF8 と SQL_ASCII を両方走らせ、揃って走ったかを別ジョブで測る | 採用 (2026-09) |
| [0106](./0106-ci-declares-the-regime-it-measures.md) | CI が自分の測っている regime を宣言する — 6本のうち測るのは1本、宣言は6本すべて | 採用 (2026-09) |
| [0107](./0107-local-embedding-cache-warm-network-tooth.md) | cache が効いていることを実ふるまいで固定する — warm でも tokenizer_config.json への Range リクエストは残る | 採用 (2026-09) |
| [0108](./0108-retrieval-bench-does-not-exercise-lexical-channel.md) | `retrieval` ベンチは語彙チャンネルを一度も通していない — ADR 0092 の効果はまだ一度も測られていない | 採用 (2026-09) |
| [0109](./0109-which-score-terms-actually-rank.md) | 残りの4項も丸めずに測った — `total` の順位は `similarity` ただ1項で決まり、`total` は210行すべてで `similarity × decay²` にビット単位で一致する | 採用 (2026-09) |
| [0110](./0110-single-char-token-discriminator.md) | `org-b` が落ちる理由を切り分けた — 「日本語の1文字違い」ではない。弁別が**単独1文字のトークン1個**に載ったときだけ差が消える | 採用 (2026-09) |
| [0111](./0111-hnsw-window-shrinks-with-tenant-scale.md) | 本物の pgvector で確かめた — 順位は変わらない。ただし窓（`ef_search`）はテナントが育つと黙って縮む | 採用 (2026-09) |
| [0112](./0112-relax-zod-dependency-range.md) | 公開パッケージの `zod` 依存を完全固定から `^` 範囲へ緩める | 採用 (2026-09) |
| [0113](./0113-no-attribution-trailers.md) | コミット・PR に帰属トレーラ（`Co-Authored-By:` / `🤖 Generated with`）を付けない | 採用 (2026-09) |
| [0114](./0114-archive-sweep-for-decayed-memories.md) | 減衰しきった記憶をアーカイブへ掃く — `archiveDecayed`（掃引） | 採用 (2026-09) |
| [0115](./0115-event-retention-purge.md) | `MemoryStore.purgeExpiredEvents`（任意メソッド）— 設定できても効いていなかった保持期間の削除側を埋める | 採用 (2026-09) |
| [0117](./0117-unreachable-union-values-inventory.md) | 型に在って一度も生成されない union の値の棚卸し — 落とすのは提起までにする | 採用 (2026-09) |
| [0118](./0118-pr-merge-delegated-when-ci-green.md) | PR のマージを、CI 緑・差分健全を条件に担い手へ委譲する（`docs/autonomy.md` §3 の改定） | 採用 (2026-09) |
| [0119](./0119-archive-sweep-cost-bench.md) | 掃引（ADR 0114）を `examples/chat` のベンチへ配線する — `archive-sweep-cost` | 採用 (2026-09) |
| [0120](./0120-time-term-probes-in-ci.md) | 時間項 probe（8件）を継続計測の CI に配線する — 値は残すが門にはしない。#109 か別建てかは決めていない | 採用 (2026-09) |
| [0121](./0121-bench-baselines-from-ci-artifacts.md) | `archive-sweep-cost`/`time-term` の基準値を、CI 初回実測の artifact から作る（手元では書かない） | 採用 (2026-09) |
| [0122](./0122-restore-archived-memory.md) | `archived` から呼び戻す明示的な口 — `Runtime.restoreArchived` | 採用 (2026-09) |
| [0123](./0123-archive-sweep-before-usage-noise-excluded-from-diff.md) | `archive-sweep-cost` の `before` 段 `usage*` を、基準値との厳密等価の比較から外す(比較には数えない・表示は残す) | 採用 (2026-09) |
| [0124](./0124-purge-physical-delete.md) | `purge()`（物理削除）の入口を実装する — `forgotten` からのみ、`dryRun` 付き、`tick()`/`observe()` には配線しない | 採用 (2026-09) |
| [0125](./0125-half-life-hours-domain.md) | `halfLifeHours` の値域を `(0, ∞)`（有限の正の実数）に塞ぐ — ADR 0078 が「別 PR」と名指しした残債 | 採用 (2026-09) |
| [0126](./0126-migration-comment-tooth-strips-comments.md) | マイグレーションの説明 comment に語を書いても歯が反応しないよう、歯の側で comment を剥がしてから検査する | 採用 (2026-09) |
| [0127](./0127-pgvector-job-count-tooth-drops-absolute-total.md) | pgvector ジョブの本数固定を、絶対数ではなく不変条件で持つ — 「同じ regime を宣言しているか」だけを歯にし、「今何本あるか」は数えない | 採用 (2026-09) |
| [0128](./0128-adr-index-completeness-tooth.md) | ADR 索引（`docs/decisions/README.md`）の行数と `docs/decisions/*.md` の本数の一致を検査する歯を足す — 衝突は消さず、抜けだけを捕まえる | 採用 (2026-09) |
| [0130](./0130-postgres-auth-parity-docker-compose.md) | 手元の Postgres 認証方式を CI（scram）に揃える —— `docker-compose.yml` と、揃っていることを測る歯 | 採用 (2026-09) |
| [0132](./0132-ci-green-verdict-procedure.md) | 「CI が緑」の判定手順を自律作業の手引きに足す — head sha 明示・job 単位の conclusion・mergeStateStatus 不使用・安定性の再確認（Issue #228） | 採用 (2026-09) |
| [0133](./0133-compare-baseline-and-gate.md) | `compare`(北極星の物差し)に基準値ファイルを足す — 実測で揺れなかったため、他5本と異なり⭐門にする | 採用 (2026-09) |
| [0134](./0134-mark-contested-explicit-operation.md) | 矛盾の検出（第1弾）— `Runtime.markContested` という明示的操作で `contested_with_id` を初めて書く | 採用 (2026-09) |
| [0135](./0135-numeral-token-discriminator-probe-domain-design.md) | 主測定の被覆を広げる設計（第1弾）— 「単独トークンの数詞・記号インデックス」を弁別軸とする第4の probe 集合を置く。件数は行列から導き、margin の分布で読む | 採用 (2026-09) |
| [0136](./0136-contested-lone-dropped-not-returned-alone.md) | 片側だけの `contested`（`contestedWithId=null`）を、読み取り側で単独返却させない | 採用 (2026-09) |
| [0137](./0137-adr-index-generated-from-source.md) | ADR 索引（`docs/decisions/README.md`）を `docs/decisions/*.md` から生成する — 案A、行位置の衝突そのものを消す | 採用 (2026-09) |
| [0138](./0138-pack-check-in-ci.md) | 六つの門の `pack:check` を、毎PRの `ci.yml` でも走らせる | 採用 (2026-09) |
| [0139](./0139-consolidation-cost-huge-utterance-timeout.md) | `consolidation-cost` の「巨大な utterance」テストの間欠タイムアウトを直す — 支配的費用は `encode()` であり、同じ壁を kana 巡回文字列で越えると解消する（Issue #258） | 採用 (2026-09) |
| [0140](./0140-contested-write-side-companion-required.md) | `MemoryStore` の書き込み側で、対向（`contestedWithId`）の無い単独 `contested` を拒否する — ADR 0136 決定3の実装（生成経路も含む） | 採用 (2026-09) |
| [0141](./0141-local-embedding-load-retry.md) | `@mnemora/local-embedding` の読み込みに、種類の分かっていない失敗のリトライを足す — キャッシュが hit してもネットワークは0回にならない（Issue #261） | 採用 (2026-09) |
| [0142](./0142-outbox-complete-fail-compare-and-swap.md) | `OutboxStore.complete`/`fail` を compare-and-swap にする — `attempts` をフェンシングトークンに使う（Issue #233、ADR 0032 が残した named debt の実装） | 採用 (2026-09) |
| [0143](./0143-analyze-memories-after-seed.md) | 新規インストール後に `ANALYZE memories;` を明示的に実行できるようにする — `runMigrations`/migrate CLI 末尾での自動実行は構造的に効かないため、独立コマンドにする | 採用 (2026-09) |
| [0144](./0144-drop-unreachable-classification-3-union-values.md) | ADR 0117 分類3の4値を union から落とす — `retrievedVia`/`reason`/`axis` の破壊的変更（Issue #206） | 採用 (2026-09) |
| [0145](./0145-valid-from-until-storage.md) | `Memory.validFrom`/`validUntil` を配線する — 型・`packages/postgres` の読み書きだけを実装する（Issue #202 第1弾） | 採用 (2026-09) |
| [0146](./0146-compare-quality-claim-reason-replaced.md) | `compare` が想起の質を主張しない理由を「擬似だから」から「正解集合を持たない器だから」へ差し替える — ADR 0022 決定2 の結論は維持する（Issue #263） | 採用 (2026-09) |
| [0147](./0147-recall-footprint-estimator.md) | `recall()` が積む量を LLM 無しで見積もり、会話ログ全部と比較する純関数を入れる（Issue #276） | 採用 (2026-09) |
| [0148](./0148-bench-lexical-channel-selectable-default-unchanged.md) | `examples/chat` の `Runtime` に `LexicalStore` を配線する — ただし既定構成は変えず、語彙チャンネルは「選べるもの」として足す | 採用 (2026-09) |
| [0149](./0149-japanese-lexical-no-required-extension.md) | 日本語の語を語彙チャンネルで引けるようにするため `REQUIRED_EXTENSIONS` を増やさない — 「引けない」を明記する | 採用 (2026-09) |
| [0150](./0150-resolve-contested-explicit-operation.md) | 矛盾の解決 — `Runtime.resolveContested` で `contested → active \| superseded` を閉じ、段3の発火を変異試験で測る | 採用 (2026-09) |
| [0151](./0151-recall-association-unprompted.md) | 「聞かれていないことを、自分から思い出す」を recall の連想枠として実装する — mnemora の側から話しかける形は採らない（Issue #200） | 採用 (2026-09) |
| [0152](./0152-consolidate-seed-neighborhood.md) | `ConsolidateTarget` に `{ seedMemoryId }` を足す — 「似ている」は recall の `affinity` を流用し、対象の列挙はしない | 採用 (2026-09) |
| [0153](./0153-recall-decay-floor-gate.md) | recall の段1に忘却ゲート（`decay_floor_at`）を既定で通す — opt-in ではなく opt-out、黙って減らさない | 採用 (2026-09) |
| [0154](./0154-reflect-seed-neighborhood.md) | `ReflectTarget` に `{ seedMemoryId }` を足す — `consolidate` と対称の土台選定、ただし帯は逆向き | 採用 (2026-09) |
| [0155](./0155-recall-score-breakdown-persisted.md) | `recalls` にスコア内訳を永続化し、`MemoryStore.getRecall` で読み戻す | 採用 (2026-09) |
| [0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md) | 「§5 級の判断」と「公開 API の破壊的変更」の事前承認待ちを、担い手へ委譲する（`docs/autonomy.md` §3 の改定） | 採用 (2026-09) |
| [0157](./0157-tick-drives-consolidate-and-reflect.md) | `tick()` が `consolidate()`/`reflect()` を駆動する — 事象駆動（outbox）、既定 off の opt-in | 採用 (2026-09) |
| [0158](./0158-association-probes-bench.md) | 連想枠（ADR 0151）が想起の質を動かすかを測る `association-probes` ベンチを足す — この測定はまだ信頼できる状態にない（Issue #291 / #316 / #317） | 採用 (2026-09) |
| [0159](./0159-omission-kind-generation-registry.md) | `Omission.kind` の11値に「本番コードが実際に生成する」歯を置く — レジストリ＋駆動、grep でも型だけでもなく | 採用 (2026-09) |
| [0160](./0160-budget-demo-teeth-and-channel-registry.md) | `examples/chat` の「予算あり/なし」対比デモに歯を足し、`usage.byTier` の新チャンネル漏れを検査する「登録表」の歯を置く（Issue #306） | 採用 (2026-09) |
| [0161](./0161-runtime-get-recall.md) | `Runtime.getRecall` を足す — `recall()` の戻り値からは分からない「後から」を、`Runtime` だけを持つ採用側にも届かせる | 採用 (2026-09) |
| [0162](./0162-correction-scenario-example-chat.md) | `examples/chat` に訂正シナリオを足す — `contestedPair` は構造としての宣言、判定はしない | 採用 (2026-09) |
| [0163](./0163-memory-usage-reporting-example-chat.md) | `examples/chat` が `memory_usage` を報告する — `reinforce` を実アプリで発火させる（Issue #301） | 採用 (2026-09) |
| [0164](./0164-valid-from-until-recall.md) | recall に `validAt` ゲートを足す — 段1へ押し下げ、`expired`/`not_yet_valid` で名指しする（Issue #280、Issue #202 第2弾） | 採用 (2026-09) |
| [0165](./0165-decay-activity-clock.md) | 減衰の時計を2本にする — 壁時計（`decay_floor_at`）に加えて活動時計（`decay_floor_seq`）を持ち、テナントが選ぶ | 採用 (2026-09) |
| [0166](./0166-recall-footprint-association-term.md) | `recall-footprint` の見積もりに連想枠の項を足す — 新しい自由係数は増やさず、構造から導く（PR #336 / ADR 0168 の前提） | 採用 (2026-09) |
| [0167](./0167-association-getvectors-order-nondeterminism.md) | 連想枠（段3.5）の非決定性の原因は HNSW ではなく `getVectors()` の返却順依存だった — アンカー処理順をランク順に固定して直す（Issue #316） | 採用 (2026-09) |
| [0168](./0168-examples-chat-uses-association.md) | `examples/chat` が recall() の連想枠を既定で使う — `maxCount=10`、既定 on は別の判断として分離する（Issue #291） | 採用 (2026-09) |
| [0169](./0169-changelog-hand-curated.md) | CHANGELOG は手で書く。ADR 0070 は覆らない | 採用 (2026-09) |
| [0170](./0170-association-search-tiebreak-nondeterminism.md) | 連想枠の非決定性・第2段 — `search()` の完全一致タイと、`memory_id` tie-break が fresh ingest ごとに揺れる根本原因を直す（Issue #339） | 採用 (2026-09) |
| [0171](./0171-five-verbs-plus-three-layers.md) | 「5つの動詞」の記述を実態（14メソッド）に合わせる — 中核の5動詞 + 3つの層 | 採用 (2026-09) |
| [0172](./0172-association-passes-decay-and-validity-gates.md) | 連想枠（段3.5）にも忘却ゲートと `validAt` ゲートを通す — ゲートの欄を1箇所に集め、述語は段1と共有する（Issue #347） | 採用 (2026-09) |
| [0173](./0173-decayed-omission-counted-by-aggregate-scope.md) | 忘却ゲートで落ちた件数を `aggregateScope` で厳密に数える — 押し下げは外さず、`countKind` を `lower_bound` から `exact` へ上げる | 採用 (2026-09) |
| [0174](./0174-filtered-omission-scope-relation.md) | `FilteredOmission` に `scopeRelation` を足し、`decayed` の非対称を契約として確定させる | 採用 (2026-09) |
| [0175](./0175-lexical-search-tiebreak-nondeterminism.md) | 語彙チャンネルの `search()` に決定的な最終キーを足す — ANN 側（ADR 0170）と同じ形で、同族の欠陥を塞ぐ（Issue #345） | 採用 (2026-09) |
| [0177](./0177-fix-stage3-tooth-blind-asserts.md) | 段3の歯の「壊れても緑のままの assert」2件を直す — 変異試験で実測する（Issue #293） | 採用 (2026-09) |
| [0178](./0178-public-api-surface-gate.md) | 公開 API 表面の破壊的変更を検出する歯を CI に足す | 採用 (2026-09) |
| [0179](./0179-adr-number-assigned-at-merge.md) | ADR の番号は「マージ直前」に確定させる — 採番を、衝突しようがないタイミングまで遅らせる（Issue #295） | 採用 (2026-09) |
| [0181](./0181-schema-type-equals-parity.md) | `satisfies` の片方向性を `Equals`/`MutualAssignable` の型検査で塞ぐ — `schema-type-equals-parity.test.ts`（Issue #272） | 採用 (2026-09) |
| [0182](./0182-provenance-kind-matches-provenance-check.md) | `memories.provenance_kind` と `provenance->>'kind'` の一致を CHECK 制約で強制する — 生成列のほうが筋が良いが、いまは採らない | 採用 (2026-09) |
| [0183](./0183-local-postgres-makes-postgres-mutation-testing-possible.md) | `packages/postgres` の変異試験を、CI のトリガを変えずに手元で成立させる — `initdb` で自分専用のインスタンスを立てる手順を `AGENTS.md` に置く | 採用 (2026-09) |
| [0184](./0184-conformance-scope-documented-not-closed.md) | 適合テストが「何を保証していないか」を、塞ぐ前に名乗る — v1.0.0 は弱さを明示した状態で出す | 採用 (2026-09) |
| [0185](./0185-contradiction-detection-path.md) | 矛盾の検出経路 — 「誰が矛盾だと決めるか」と「誰が相手を探すか」を2軸に分け、段階で埋める（Issue #197 の設計） | **提案 (2026-09)** |
| [0186](./0186-sweep-archive-follows-decay-clock.md) | `sweepArchive` は `opts.clock` 省略時に `tenant_settings.decay_clock` へ従う — ADR 0165 決めたこと12 の数え漏れ（掃引）を埋める | 採用 (2026-09) |
| [0188](./0188-association-over-limit-omission.md) | 連想枠（段3.5）の `maxCount` 切り捨てを `omitted` に名乗らせる — `over_limit` に `stage` を足す（Issue #375） | 採用 (2026-09) |
| [0190](./0190-correction-cli-dispatch-ci-tooth.md) | `correction` サブコマンドを CI の歯にする — 既存ジョブへ相乗り・`deterministic` 層・`omitted` の `superseded` assert | 採用 (2026-09) |
| [0191](./0191-ci-green-verdict-bound-to-sha.md) | 「CI が緑」の判定を sha に縛る——`gh pr merge --match-head-commit` を道具側で強制する（Issue #294） | 採用 (2026-09) |
| [0192](./0192-adr-index-freshness-enforced-in-pull-request-ci.md) | ADR 索引の鮮度を、CI の `pull_request` でも強制する — 手順が守られたかを、注意力ではなく機構で確かめる（Issue #267） | 採用 (2026-09) |
| [0193](./0193-ann-unreached-covers-full-window.md) | `ann_unreached` を「窓が満杯でも鳴る」形に直す — `ann-truncation.ts` の約束をようやく果たす | 採用 (2026-09) |
| [0194](./0194-embedding-space-analyze-threshold.md) | `PostgresVectorStore.upsert` が閾値越えのときだけ埋め込み表を `ANALYZE` する — 新しい埋め込み空間の統計の窓を、プロセスローカルなカウンタと `pg_class.reltuples` の guard で閉じる | 採用 (2026-09) |
| [0195](./0195-six-gates-verified-in-ci.md) | 6つの門の緑は CI で確かめる——手元で全体を走らせることを止まる条件にしない（Issue #407） | 採用 (2026-09) |
| [0196](./0196-locale-c-is-encoding-agnostic.md) | `--locale=C` はどの encoding とも両立する — 表の誤りを実測で正し、`ANY_ENCODING` を入れる（Issue #395） | 採用 (2026-09) |
| [0197](./0197-set-default-half-life-recalls.md) | `TenantSettingsStore` に `setDefaultHalfLifeRecalls` を本番の経路として足す | 採用 (2026-09) |
| [0198](./0198-llm-provider-call-failure-tooth.md) | `LLMProvider` が逐語で約束していて一度も測られていなかった1行に、歯を置く — 適合 suite の設計判断には踏み込まない（Issue #389） | 採用 (2026-09) |
| [0199](./0199-identifier-probes-readme-freshness-tooth.md) | `examples/chat/README.md` の `identifier-probes` 節と基準値 JSON の一致を、既存 vitest に相乗りする歯で見張る | 採用 (2026-09) |
| [0200](./0200-adr-renumber-warns-when-titles-need-fixing.md) | `adr-renumber.mjs` は付け替えたときに PR タイトルの修正を促す警告を出す — 道具は `gh` を叩かない（Issue #405） | 採用 (2026-09) |
| [0201](./0201-recall-footprint-char-margin-canary.md) | `recall-footprint` の許容誤差の余白を字数で見る歯を足す — hold-out 5行に限定し、閾値は較正係数から導く（Issue #410） | 採用 (2026-09) |
| [0202](./0202-postgres-shared-db-object-names.md) | `packages/postgres` が作るオブジェクト名の一覧を README に置き、migrations と機械的に突き合わせる（Issue #168） | 採用 (2026-09) |
| [0203](./0203-memories-omitted-exclusivity.md) | `result.memories` と `result.omitted` の排他性を契約にする — 段3.5 が昇格させた記憶を `below_threshold` から取り下げる（Issue #421） | 採用 (2026-09) |
| [0204](./0204-postgres-object-names-cover-functions.md) | `packages/postgres` の共有オブジェクト名の歯を関数まで広げ、ADR 0202「引き受けた負債1」を解消する（Issue #168） | 採用 (2026-09) |
| [0205](./0205-local-embedding-pipeline-required-interface.md) | `LocalEmbeddingPipeline` を必須 interface にし、ADR 0090 決定4「引き受けた負債1」を塞ぐ（Issue #137 案 (a)） | 採用 (2026-09) |
| [0206](./0206-outbox-concurrent-claim-conformance.md) | 同時 claim の適合テストを `supportsRealConcurrency` で切り替える（Issue #205 の1本目） | 採用 (2026-09) |
| [0207](./0207-dry-run-reads-existence-and-coverage-degrades-silently.md) | 予行は registry の「既に在るか」を読む — そして予行の網羅性は、木の版と registry の関係で黙って落ちる | 採用 (2026-09) |
| [0208](./0208-outbox-skip-locked-non-blocking-tooth.md) | `SKIP LOCKED` が「詰まらないこと」を守っている、という主張に歯を足す（ADR 0206 の宿題） | 採用 (2026-09) |
| [0209](./0209-dry-run-short-circuit-predates-adr-0207-and-is-counted-by-machine.md) | 予行の短絡は 2026-09-08 に既に起きていた — ADR 0207 決定2 の【受】を訂正し、「何本が経路を通ったか」を機械に数えさせる | 採用 (2026-09) |
| [0210](./0210-root-test-gate-runs-all-stages-regardless-of-failure.md) | ルートの `test` 門は、前段が落ちても後段を必ず起動する（Issue #453） | 採用 (2026-09) |
| [0211](./0211-check-pr-adr-reference-catches-abandoned-numbers-in-title-and-body.md) | PR タイトル/本文が付け替え後の古い ADR 番号を名指ししていないかを CI が検査する — 本文は誰も警告していなかった | 採用 (2026-09) |
| [0212](./0212-local-embedding-size-noun-correspondence-tooth.md) | local-embedding のサイズ表記(36MB/42MB)が名詞と正しく対応していることを歯で縛る — 「値の一致」だけでなく「向き」を見る | 採用 (2026-09) |
| [0213](./0213-live-docs-cite-adrs-by-anchor-not-line-number.md) | 行番号での引用は、この repo 自身の「ADR は書き換えず追記する」作法によって腐る — 生きた文書はアンカーで指し、歯で止める | 採用 (2026-09) |
| [0214](./0214-release-candidates-lists-not-judges.md) | リリース当日に「載せるべき候補」をその場で出す道具 — ⛔ 判定ではなく一覧である | 採用 (2026-09) |
| [0215](./0215-ci-green-check-lower-bound-from-required-status-checks.md) | 「CI が緑」の下限を、branch protection の required status checks から取る（Issue #477 と同じ族） | 採用 (2026-09) |
| [0216](./0216-north-star-shipped-only-measurement.md) | 北極星の7項目を「出荷物だけ」でどう測るか — ⛔ 物差しは1本では作れない。文面の向きで3類に割り、1類は機械に載せない | 採用 (2026-09) |
| [0217](./0217-provenance-naming-lost-in-duplication-swept-from-the-population.md) | 「確かめていない主張が、名乗りを落としたまま複製されていないか」を `docs/` 220本の母集合から測った — 複製で名乗りが落ちた例は2件、うち1件は3文書に跨っていた | 採用 (2026-09) |
| [0218](./0218-shipping-security-claims-checked-against-primary-sources.md) | 出荷文書の「セキュリティの主張」に一次情報を当てた — CVE 番号は実在した（引く先が違っただけ）。ただし推奨下限は「既知の CVE が残らない下限」ではない | 採用 (2026-09) |
| [0219](./0219-adr-corpus-swept-for-unsourced-assertions.md) | ADR 208本を逆向きに掃いた — 母集合 59,554行から候補171件、残った未裏づけの断定は17件。その3/4は「外部の挙動」だった | 採用 (2026-09) |
| [0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) | OPEN な ISSUE のコメント投稿者名は、オーナーと担い手（エージェント）を見分けない — 見分けられるのは本文中の逐語の名乗りだけである | 採用 (2026-09) |
| [0221](./0221-memories-analyze-on-write.md) | `PostgresMemoryStore` の書き込み経路が閾値越えのときだけ `memories` を `ANALYZE` する — ADR 0194 と同じ設計を、JOIN の相手側にも入れる（Issue #269） | 採用 (2026-09) |
| [0222](./0222-compare-gate-judges-only-when-turncount-sets-match.md) | ⭐門 `compare` は、実測と基準値の `turnCount` 集合が一致したときだけ判定する（Issue #477） | 採用 (2026-09) |
| [0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) | 繰り返し採られているのに入口の文書に書かれていない判断の規律を、ADR 211本の母集合から抽出した — 残ったのは10。最頻出は「採用済み ADR の本文を書き換えない」で 46/211 | 採用 (2026-09) |
| [0224](./0224-quality-evaluation-and-acceptance-criteria.md) | 品質評価の証明範囲と合格基準の変更を、自律作業の条件にする | 採用 (2026-09) |
| [0225](./0225-supersede-with-new-memories-analyze-hook.md) | `supersedeWithNewMemories` にも ADR 0221 の書き込み時 `ANALYZE` フックを足す — 残っていた3本目の経路（Issue #269） | 採用 (2026-09) |
| [0226](./0226-compare-provenance-reached-vs-information-retained.md) | `compare` の `factStatementSurvived` が測るのは出典到達だけである — 欄名は⭐門の契約として据え置き、意味の是正はコメント・表示・文書で行う（Issue #496） | 採用 (2026-09) |
| [0227](./0227-fixed-retrieval-probe-gold-presence-gate.md) | 固定した probe ごとの gold 到達を、`example-chat` の必須 CI へ直接繋ぐ回帰ゲート（Issue #497） | 採用 (2026-09) |
| [0228](./0228-accept-the-extra-ci-round-for-adr-pull-requests.md) | ADR を持つ PR が CI をもう1周する費用を受容する — 方向4 を選び直す（Issue #267） | 採用 (2026-09) |
| [0229](./0229-answer-bench-compares-final-answers-with-a-ground-truth-bench-quality-not-yet-claimed.md) | 全文経路と記憶経路の最終回答を、正解集合を持つ器で比較する（品質の主張はまだしない、Issue #506 / 親 #498） | 採用 (2026-09) |
| [0230](./0230-restore-superseded-recovery-path.md) | `superseded → active` の復旧口を作る — オーナーの判定のうち、⛔ **復旧口だけ**を着地させる（Issue #369 / PR #464） | 採用 (2026-09) |
| [0231](./0231-compare-baseline-omitted-measured-update-and-freshness.md) | `compare-baseline.json` の `omitted` を CI の artifact で実測更新し、基準値の鮮度を毎 run 名乗らせる（⛔ 門にはしない）（Issue #403） | 採用 (2026-09) |
| [0232](./0232-correction-candidates-returned-not-chosen.md) | 訂正の相手は mnemora が選ばない — **候補を返し、採用者が選ぶ**（Issue #369 (C)） | 採用 (2026-09) |
| [0233](./0233-answer-quality-measured-once-against-the-real-api.md) | 回答品質を実 API で1回測り、記録で再生できる形にする — 記録器が同じ鍵を二度録っていた穴を塞ぐ（Issue #498 / #506） | 採用 (2026-09) |
| [0234](./0234-bake-no-numbers-into-tools-and-artifacts.md) | 「焼き込んだ数字は腐る」の道具・生成物版を `AGENTS.md` へ置く — ⛔ 射程だけを広げず、**線**と**対象外**を同時に書く | 採用 (2026-09) |
| [0235](./0235-correction-demo-explicit-choice.md) | 訂正の相手は `examples/chat` でも人が指名する — `findCorrectionCandidates` を本番コードの経路に立てる（Issue #369 (C) / 北極星 項目5） | 採用 (2026-09) |
| [0236](./0236-answer-retention-mutation-tested-not-recorded.md) | Issue #498 完了条件4を内容保持の側だけで満たす — 回答評価側の陽性対照は実 API での記録追加を要するため未達のまま残す | 採用 (2026-09) |
| [0237](./0237-restore-superseded-dry-run-preview.md) | `restoreSuperseded` に下見（`dryRun`）を足す — 方向3「戻す前に何が戻るかを返す」を実装する（Issue #515） | 採用 (2026-09) |
| [0238](./0238-correction-choice-rationale-in-events.md) | 訂正の相手を選んだ根拠を、イベントに残す — `meta.note` と `RecallResult.explain` の両方から辿れるようにする（Issue #369 チェックボックス / 北極星 問い3） | 採用 (2026-09) |
| [0239](./0239-live-doc-source-line-citations-no-machine-line.md) | 生きた文書のソース行番号引用は、**凍結記録と生きた散文を機械で見分けられない** — 射程を広げない（Issue #512） | 採用 (2026-09) |
| [0240](./0240-freshness-wiring-gate-corrects-issue-521.md) | Issue #521「時間項への検出力ゼロ」を訂正する — 穴は計算式ではなく `freshness`/`decay` の配線だった。`total` への配線を守る歯を1本足す | 採用 (2026-09) |
| [0241](./0241-migration-guide-is-a-live-doc-not-an-adr.md) | `docs/migration-v1.md` は ADR ではなく生きた文書である — 「本文を書き換えず訂正を積む」作法の対象外とする（Issue #532） | 採用 (2026-09) |
| [0242](./0242-runtime-apply-correction.md) | `Runtime.applyCorrection` — 北極星 項目5を「出荷される面」から駆動できるようにする（Issue #369） | 採用 (2026-09) |
| [0243](./0243-changelog-lists-publish-targets-only.md) | `CHANGELOG.md` が載せるのは publish 対象パッケージの変更だけである — `examples/chat` は出荷される面の外なので載せない（Issue #536） | 採用 (2026-09) |
| [0244](./0244-runtime-method-doc-correspondence-tooth.md) | `Runtime` のメソッドが3文書（README/vision/architecture）で名指しされていることを歯で縛る（Issue #518） | 採用 (2026-09) |
| [0245](./0245-publish-gate-shell-default-pinned.md) | `publish.yml` の門ステップが既定シェル（`bash -e`）で走るという前提を歯で縛る（Issue #476） | 採用 (2026-09) |
| [0246](./0246-association-rank-includes-decay.md) | 連想枠（段3.5）の席を、減衰を含む順位で埋める —— 正典項目4「使われない記憶が、静かに遠ざかる」の順位軸（Issue #402） | 採用 (2026-09) |
| [0247](./0247-local-embedding-repo-model-id-declaration-guard.md) | `repo` だけの差し替えが `modelId` を伴わないとき、コンストラクタで落とす（Issue #142） | 採用 (2026-09) |
| [0248](./0248-changelog-and-migration-guide-follow-the-release.md) | `v0.4.0` の出荷に `CHANGELOG.md` と `docs/migration-v1.md` が追随していなかった — 世代を閉じて pin を進める。⛔ 3回目を防ぐ仕掛けはここでは決めない | 採用 (2026-09) |
| [0249](./0249-release-day-procedure-holds-no-rotting-facts.md) | 当日の手順書は、腐る事実を本文に持たない — その場で引く手順と、抽出を持っている道具への一本化だけを持つ | 採用 (2026-09) |
| [0250](./0250-machines-detect-humans-confirm-and-write.md) | 機械には「検出」までを担わせる。「確定」と「書き込み」は人に残す — ADR 0223 決定2 の射程を `AGENTS.md` へ広げる（Issue #505） | 採用 (2026-09) |
| [0251](./0251-release-follow-up-notice-not-a-gate.md) | リリース後に「出した版の節が在るか」を通知する — ⛔ 門にはしない。⭐ 分けた線は「確実さ」ではなく「外したときに誰が巻き添えになるか」である | 採用 (2026-09) |
| [0252](./0252-release-changelog-section-is-a-publish-gate.md) | 出す版の節が `CHANGELOG.md` に無ければ `npm publish` を止める — 🔴 **門にする。⭐ 巻き添えを「確実さを下げる」ではなく「置き場所」で解いた** | 採用 (2026-09) |
| [0253](./0253-local-embedding-weights-fingerprint-gate.md) | 読み込んだ重みの指紋を、期待値を1つも焼き込まずに照合する門（Issue #142 ②） | 採用 (2026-09) |
| [0254](./0254-no-gate-without-a-false-positive-ceiling.md) | 偽陽性率に上限を置けない検査は門にしない — ADR 0223 決定3 の射程を `AGENTS.md` へ広げる。🔴 ただし線は引けない（Issue #505） | 採用 (2026-09) |
| [0255](./0255-tools-output-candidates-not-verdicts.md) | 名乗れないものを道具に名乗らせない — 判定ではなく候補の一覧として出す。ADR 0223 決定5 の射程を `AGENTS.md` へ広げる（Issue #505） | 採用 (2026-09) |
| [0256](./0256-positive-control-before-claiming-absence.md) | 「出なかった」は「無い」の証明にならない — 先に陽性対照を示す。ADR 0223 決定6 の射程を `AGENTS.md` へ広げる（Issue #505） | 採用 (2026-09) |
| [0257](./0257-searched-and-found-nothing-versus-did-not-search.md) | 「探したが無かった」と「探していない」を分ける —— 向きが逆の版を書き手自身の調査手続きへ当て直す。ADR 0223 決定10 の射程を `AGENTS.md` へ広げる（Issue #505） | 採用 (2026-09) |
| [0258](./0258-restore-superseded-operation-scope.md) | `restoreSuperseded` を「1回の操作」単位に絞る（方向①）—— 鍵は新設せず、既にある情報で絞る | 採用 (2026-09) |
| [0259](./0259-gate-runtime-output-names-its-blind-spot.md) | `check-publish-pack.mjs` / `check-pr-adr-reference.mjs` の実行時出力に、doc コメントにしか無かった断りを焼く（Issue #580） | 採用 (2026-09) |
| [0260](./0260-answer-names-what-it-actually-runs.md) | `answer` が「記録した応答を再生する」と名乗りながら擬似 provider で走るのをやめる —— 名乗る関数と実態を倒す関数を1つにし、使われなかったカセットを出力に焼く（Issue #577） | 採用 (2026-09) |
| [0261](./0261-answer-bench-tenant-keyed-by-embedding-space.md) | `answer` ベンチの tenant を埋め込み空間で分ける —— 「抽出の冪等スキップ」がモードを跨ぐと、記憶とベクトルの整合が壊れる（Issue #583） | 採用 (2026-09) |
| [0262](./0262-cli-names-the-plan-as-a-plan.md) | `examples/chat` の `[cassette]` 行は「予定」を予定として名乗る —— 測っていない予告を、実測と同じ口調で出さない（Issue #589） | 採用 (2026-09) |
| [0263](./0263-cache-key-carries-the-model-revision.md) | CI のモデルキャッシュ鍵に、HF の revision を入れる —— 手で版を振った固定文字列は、HF が動いても古い重みを配り続ける（Issue #564） | 採用 (2026-09) |
| [0264](./0264-cli-names-the-mismatch-between-plan-and-actual.md) | `examples/chat` は「予定」と「実測」が食い違ったとき、画面にそれを名指しさせる —— 読み手に2行の突き合わせを任せない（Issue #594） | 採用 (2026-09) |
| [0265](./0265-fingerprint-gate-shell-branches-pinned-by-execution.md) | `local-embedding` fingerprint 門の `case` 分岐を、`bash` で実際に実行して固定する（Issue #574 後半） | 採用 (2026-09) |
| [0266](./0266-llm-provider-conformance.md) | `LLMProvider` の適合 suite を新設し、`@mnemora/anthropic` と `@mnemora/openai` の両方に当てる（Issue #389） | 採用 (2026-09) |
| [0267](./0267-withdraw-the-release-changelog-publish-gate.md) | 出す版の節を要求する publish の門を撤回する —— 🔴 **門は正しく鳴っていた。外すのはオーナーの判断であって、門の欠陥ではない** | 採用 (2026-09) |
| [0268](./0268-living-doc-judgment-pointer-repointed-to-605.md) | 生きた文書3本の「判断の置き場」ポインタを #518 から #605 へ付け替え、その一致を歯で縛る（Issue #518） | 採用 (2026-09) |
| [0269](./0269-port-interface-doc-correspondence-sweep.md) | `Runtime` 以外の port interface（`MemoryStore` など）も、`docs/architecture.md` §5 の写しが実体とずれている — どちらが正本かは決めない（Issue #604） | **提案 (2026-09)** |
| [0270](./0270-runtime-method-count-bake-detection-tooth.md) | `Runtime` の非中核メソッド「件数」が生きた文書へ焼き込まれることを検出する歯を足す — 値ではなく形を見る（ADR 0269 引き受けた負債） | 採用 (2026-09) |
| [0271](./0271-extraction-candidate-subject-id-overrides-observation.md) | 抽出候補ごとに `subjectId` を持てるようにし、候補の値が observation の値より優先する（Issue #608 項目①） | **提案 (2026-09)** |
| [0272](./0272-runtime-method-count-notation-sweep.md) | `Runtime` の非中核メソッド件数を検出する歯を、表記の軸だけ広げる（漢数字・「N つ」等）——主語の錨は外さない（ADR 0270 引き受けた負債、Issue #606 の材料） | 採用 (2026-09) |
| [0273](./0273-architecture-section5-is-a-copy.md) | `docs/architecture.md` §5 は「写した側」である — ADR 0269 決定2 の保留に答える（Issue #604） | **提案 (2026-09)** |
| [0274](./0274-required-check-context-name-is-frozen-annotate-dont-rename.md) | required status check の文脈名は凍結する — 腐っていても改名せず、名指しで訂正を積む | 採用 (2026-09) |
| [0275](./0275-runtime-three-layer-assignment-recheck.md) | `Runtime` の3層振り分けが、いま正しいかを検算する — 棚卸しの範囲に限る（Issue #605） | **提案 (2026-09)** |
| [0276](./0276-retrieval-quality-shadow-verdict-stage1.md) | MRR/hit@1 の判定を「門ではなく並走」で足す — Issue #572 段1 | 採用 (2026-09) |
| [0277](./0277-adr-renumber-detects-unrewritten-chain-references.md) | `adr-renumber.mjs` は、`ADR NNNN / MMMM` という略記の連なりで書き換えられずに残った参照を検出する — 書き換えの射程は広げない | 採用 (2026-09) |
| [0278](./0278-architecture-section5-port-interface-correspondence-tooth.md) | `docs/architecture.md` §5 の port interface が実体とずれたら落ちる歯を置く（Issue #604、ADR 0269、ADR 0273） | 採用 (2026-09) |
| [0279](./0279-required-status-checks-declaration-and-check.md) | required status check の「正本＋突き合わせ」を足す — 宣言は `.github/required-status-checks.json`、判定は三値、CI には繋がない | 採用 (2026-09) |
| [0280](./0280-compare-omitted-stage-declaration-gate.md) | `compare` の `omitted` の `stage` 集合が動いたら、申告を要求する門を置く（Issue #403） | 採用 (2026-09) |
| [0281](./0281-ci-green-check-empty-check-runs-reason-dirty.md) | `total === 0` の *理由* を `mergeable_state` で切り分ける——緑の根拠は変えない（Issue #615） | 採用 (2026-09) |
| [0282](./0282-score-breakdown-affinity-measured.md) | `ScoreBreakdown` に `affinityMeasured?: boolean` を追加のみで足す —— Issue #548 方向1（非破壊）を採る | 採用 (2026-09) |
| [0283](./0283-adopt-merged-adrs-whose-decision-is-on-main.md) | 決定が main で現に採られているのに「草案」「提案」のまま残った ADR 18本を「採用」へ倒す——状態の語を定義する（Issue #641） | 採用 (2026-09) |
| [0284](./0284-hnsw-iterative-scan-relaxed-order-adopted.md) | 段1の `search()` に `hnsw.iterative_scan = relaxed_order` を採用する — 他テナントの near-duplicate が候補枠を独占して全滅する問題を塞ぐ（ADR 0063 決定1を覆す、Issue #671） | 採用 (2026-09) |
| [0285](./0285-ann-window-empty-of-in-scope-candidates-stage-detail.md) | ANN の候補枠が scope 内の候補を1件も拾えなかったことを stage detail に名乗らせる — `Omission` union は変えない（Issue #671） | 採用 (2026-09) |
| [0286](./0286-recall-include-subjectless.md) | `recall()` に `includeSubjectless` を足し、「subject X、または主題なし」を1回で引けるようにする（Issue #608 項目③(b)） | 採用 (2026-09) |
| [0287](./0287-extraction-subject-candidates-caller-supplied.md) | 呼び出し側が subject 候補一覧を渡し、抽出器に選ばせる口を足す（Issue #608 項目②(b)） | 採用 (2026-09) |
| [0288](./0288-ann-unreached-severity.md) | `AnnUnreachedOmission` に `severity?: AnnUnreachedSeverity` を追加のみで足す（Issue #361、ADR 0193 §7-1 の再検討） | 採用 (2026-09) |
| [0289](./0289-recalled-memory-speaker-subject.md) | `RecalledMemory` に `speaker`/`subjectId` を任意欄として足す —— Issue #579 案D を、型ではなく runtime の保証で守る（非破壊） | 採用 (2026-09) |
| [0290](./0290-activity-seq-read-path-documented-not-implemented.md) | Issue #338 案2（`activity_seq` の進みから recall 頻度を測る）の段0 — 読み口は既に在ったので、実装はせず文書化だけを足す | 採用 (2026-09) |
| [0291](./0291-primary-probe-coverage-map-correction-candidate-domain.md) | 主測定の被覆の地図（第2弾）— 北極星から見た被覆表と、次に作る領域として「訂正候補探索」を選ぶ | **提案 (2026-09)** |
| [0292](./0292-relation-graph-table-depth-omitted-design.md) | 関係グラフ本体（Issue #207）の段0 — テーブル形・探索の深さ上限・`omitted` への出し方を決める（設計のみ） | 採用 (2026-09) |
| [0293](./0293-remove-pr-text-checks-and-release-followup-notice.md) | PR タイトル/本文を見る CI ステップ3本と、リリース後の追随通知ワークフローを削除する | 採用 (2026-09) |
| [0294](./0294-lexical-tie-density-bench.md) | `retrieval` ベンチの語彙チャンネル構成（ADR 0148）でタイ密度を測るベンチを足す — 測るだけで、Issue #394 の取り扱いには何も答えない | 採用 (2026-09) |
| [0295](./0295-answer-prompt-provenance-rendering.md) | 回答プロンプトに由来・話者・主題・矛盾関係を描画する形式を決める（Issue #691、`examples/chat` 限定・非破壊） | 採用 (2026-09) |
| [0296](./0296-answer-content-preservation-layer2-indicator.md) | `answer` に層2（回答に必要な情報の保持）の決定的な指標を足す — 出典到達・回答正誤とは別欄、記録カセットの録り直しを要求しない（Issue #693、親 #498） | 採用 (2026-09) |
| [0297](./0297-answer-retention-judge-positive-control-recorded.md) | 完了条件4「回答評価」側の陽性対照を実 API で記録し、カセット再生の歯として固定する（Issue #498） | **提案 (2026-09)** |
| [0298](./0298-recalled-memory-recorded-occurred-at.md) | `RecalledMemory` に `recordedAt`/`occurredAt` を任意欄として足す —— Issue #691 の子（Issue #702）、「後で訂正された」を読むための時点（非破壊） | 採用 (2026-09) |
| [0299](./0299-extraction-context.md) | 抽出文脈を観測と保存し、相対日付の暦計算をモデルから分ける | **提案 (2026-09)** |
| [0300](./0300-time-weighting-policy-opt-in.md) | 既定スコアの時間二重減衰を分ける — `occurredAt` が無い記憶には `freshness` を掛けない明示的 opt-in を `RecallQuery` に足す（Issue #690） | **提案 (2026-09)** |
| [0301](./0301-answer-trials-same-memory-set.md) | `answer` の回答評価を同じ記憶集合での n 回試行・正答数で見る器を作る（Issue #705） | 採用 (2026-09) |
| [0302](./0302-recall-footprint-structural-terms.md) | `recall-footprint` の見積もりに、`indexBand` の実 JSON 構造から決まる4つの構造項を足す（Issue #340） | 採用 (2026-09) |
| [0303](./0303-superseded-contested-decay-floor-owner.md) | `superseded` / `contested` の `decay_floor_at` の持ち主を決める — 回収の経路（案C）は v1.x で入れない | 採用 (2026-09) |
| [0304](./0304-subject-candidates-string-null-literal.md) | `sanitizeCandidateSubjectId` は文字列 `"null"` を明示的な `null` として扱う（Issue #608 項目②(b) 追補、gpt-4o-mini 実測） | 採用 (2026-09) |
| [0305](./0305-embedding-provider-input-limit-contract.md) | `EmbeddingProvider` の契約に「上限超過は例外」を明記する — Issue #449 の経路は塞がず、契約と歯で名乗らせる | 採用 (2026-09) |
| [0306](./0306-recall-footprint-calibration-subtracts-structural-terms.md) | `calibrateRecallFootprint` は、較正の前に構造項を差し引く（Issue #340 フォローアップ） | 採用 (2026-09) |
| [0307](./0307-aggregate-scope-single-pass.md) | `aggregateScope` を単一パスの `GROUP BY` に書き換える — 同じ SQL 文・同じ返り値のまま、テナント全体の集計を約1.8倍速くする | 採用 (2026-09) |
| [0308](./0308-lexical-rank-length-normalization.md) | `ts_rank_cd` の normalization に文書長のビットを足す — 語彙チャンネルの `rank` に内容由来の分解能を持たせる（Issue #394 案2） | 採用 (2026-09) |
| [0309](./0309-answer-prompt-order-legend-and-cassette-migration.md) | `buildMnemoraPrompt` を `order-legend` 描画に確定し、`answer`/`answer-time-weighting` の再生カセットを新形式へ移行する（Issue #691 続き） | 採用 (2026-09) |
| [0310](./0310-subject-crossing-consolidate-frequency-measured.md) | Issue #579 の頻度を測った — subject をまたぐ統合は近傍を種の subject に絞れば 0%、絞らなければ使い方しだいで 0〜100%。案 B は採らない | 採用 (2026-09) |
| [0311](./0311-activity-clock-boundary-measured-soft-and-hard.md) | Issue #338 の境界を実測で確かめ直す。素の `recall()` では 3112回より先の 2392回で沈む。残るオーナー判断2点に、数値と推奨を添える | 採用 (2026-09) |
| [0312](./0312-observe-recall-caller-attributes.md) | `observe()`/`recall()` に呼び手専用の `attributes` を通す —— `tags`（LLM の推論）とは別の列で、段1へ AND 等値の絞り込みとして押し下げる（Issue #152/#153、非破壊） | 採用 (2026-09) |
| [0313](./0313-numeral-token-probes-ci-wiring-and-baseline-verification.md) | ADR 0135 §8 の残件1〜3を実装する — CI ジョブ・summary script・基準値ファイルを配線し、「sparse/dense が完全一致し margin の min が正」という基準値の見た目の不自然さを実測で検証する | 採用 (2026-09) |
| [0314](./0314-recall-footprint-calibration-samples-need-ci-sourcing.md) | recall-footprint 較正の補助標本は作れる(実 API 不要)が、compare-baseline.json への昇格には CI artifact が要る — 別ファイルに留めた | 採用 (2026-09) |
| [0315](./0315-claim-key-does-not-touch-extraction-cassettes.md) | 主張キー（(B) 第1段）は既定の抽出プロンプトを変えない — 候補群への別呼び出しで取り、カセットは書き換えず新規追加、⭐門は動かさない（Issue #370） | 採用 (2026-09) |
| [0316](./0316-openai-embedding-false-positive-ceiling.md) | OpenAI 実埋め込みの偽陽性率に上限を置けるかを実測する — Issue #109 後半（ADR 0094「これが覆るとしたら」第1項） | 採用 (2026-09) |
| [0317](./0317-auto-consolidate-scopes-neighbor-search-to-seed-subject.md) | 自動経路の `consolidate` ジョブは、近傍探索を種の subject に絞る — 案 S を採る | 採用 (2026-09) |
| [0318](./0318-taxonomy-labels.md) | taxonomy の語彙管理（labels / memory_labels）を任意の追加として実装する — PR-A: migration・書き込み経路・語彙 API（Issue #201） | 採用 (2026-09) |
| [0319](./0319-optional-trigram-lexical-store.md) | 日本語の語彙照合を、opt-in の `PostgresTrigramLexicalStore`（pg_trgm）として足す — Issue #278 への回答 | 採用 (2026-09) |
| [0320](./0320-claim-key-field-implementation.md) | 主張キー（(B) 第1段）の実装 — `{subject, predicate}` を2列+部分索引で持ち、opt-inの別呼び出しで埋める（Issue #371） | 採用 (2026-09) |
| [0321](./0321-correction-candidate-domain-implementation.md) | ADR 0291 §7 残件1〜4 を実装する — 訂正候補探索に30件のセルを追加し、margin/intrusionMargin を足し、CI ジョブを配線する | 採用 (2026-09) |
| [0322](./0322-local-embedding-synthetic-noise-false-positive-counterfactual.md) | `local` 埋め込み5+2群に合成ノイズを注入し、ADR 0316 判定の偽陽性率を反実仮想として測る — Issue #109（ADR 0316「引き受けた負債」1番） | 採用 (2026-09) |
| [0323](./0323-taxonomy-recall-filter.md) | taxonomy によるラベル絞り込みを recall に足す — PR-B（Issue #201、ADR 0318 の続き） | 採用 (2026-09) |
| [0324](./0324-claim-key-contested-detection.md) | 主張キー（(B) 第2段）の検出実装 — 列と索引だけで衝突を見つけ、`contested` までで止める（Issue #372） | 採用 (2026-09) |
| [0325](./0325-bullmq-tick-driver.md) | `@mnemora/bullmq` は `Scheduler` を実装せず、BullMQ で `runtime.tick()` を駆動する（Issue #205 の2本目） | 採用 (2026-09) |
| [0326](./0326-answer-path-claim-key-contested-opt-in-measurement.md) | examples/chat の answer 経路に claimKey/detectContested を評価用 opt-in する — `[矛盾候補:]` が0件だった理由を実測する（Issue #691 続き） | 採用 (2026-09) |
| [0327](./0327-relation-graph-contested-write-path-design.md) | 関係グラフ本体（Issue #207）の段1 — `memory_relations` へ何を移すか・既存列からの移行の形・多者間 `contested` の解き方（設計のみ） | 採用 (2026-09) |
| [0328](./0328-local-embedding-output-cross-runner-reproducibility-measured.md) | `local` 埋め込みの出力は、ランナーをまたいで同じになるか——x64 どうしはビット一致、x64 と arm64 は系統的に不一致（Issue #565、測っただけ。門にはしない） | **提案 (2026-09)** |
| [0329](./0329-claim-key-known-predicates-from-store.md) | `knownPredicates` を store の既存 predicate 一覧から動的に渡す — ADR 0326「採らなかった案B」を実装し、実測する（Issue #691 続き） | 採用 (2026-09) |
| [0330](./0330-openai-embedding-live-conformance-and-determinism-measured.md) | 実 API の `OpenAIEmbeddingProvider` に適合テストを当て、決定性を測った——無条件7本は緑、単独入力は一致、3件バッチは一致しない（Issue #142 ①、測っただけ。宣言は変えない） | **提案 (2026-09)** |
| [0331](./0331-extension-creation-shared-advisory-lock.md) | 拡張を作る段だけを、schema に依らない共有 advisory lock で直列化する | 採用 (2026-09) |
| [0332](./0332-association-default-100k-measurement.md) | 連想枠の既定 on を10万行級で測る — 62件/1万行/10万行の実測記録（Issue #337、判定はしない） | **提案 (2026-09)** |
| [0333](./0333-identifier-verdict-and-intrusion-margin-candidates.md) | Issue #109 残件 A・C — 識別子2群の判定候補と `intrusionMargin` の定義候補を実測で比較する（B は範囲外） | 採用 (2026-09) |
| [0334](./0334-claim-key-known-subjects-hint.md) | claim key の `subject` 誤帰属を、明示的な `knownSubjects` 語彙ヒントで減らす — store 自己蓄積版・`subjectCandidates` への暗黙の転用は、いずれも実測・設計検討の末に採らない（Issue #372負債6） | 採用 (2026-09) |
| [0335](./0335-recalled-memory-contested-with.md) | `RecalledMemory` に任意欄 `contestedWith?: MemoryId` を足す —— 矛盾する対が同伴取得を経由せず両方とも自然に候補に入った場合にも、対向の memoryId を返す（Issue #691 続き） | 採用 (2026-09) |
| [0336](./0336-embedding-input-opt-in-hook.md) | `RuntimeDeps.embeddingInput` — 上限超過で `failed` になった Memory を、既定を変えずに回復できる opt-in フック（Issue #753、#449 の残り） | **提案 (2026-09)** |
| [0337](./0337-recall-association-default-on.md) | 連想枠（`RecallQuery.association`）の既定を on にする（Issue #337） | 採用 (2026-09) |
| [0339](./0339-checked-out-client-error-listener.md) | `runMigrations`/`registerEmbeddingSpace` が `pool.connect()` で借り切るクライアントに、空の `error` リスナーを付ける | 採用 (2026-09) |
| [0341](./0341-quote-search-path-in-set-local.md) | `runMigrations` の `SET LOCAL search_path TO ...` で、スキーマ名を二重引用符で囲む | 採用 (2026-09) |
| [0342](./0342-recalled-memory-basis-lost.md) | `RecalledMemory` に任意欄 `basisLost?: true` を足す —— `inferred` の根拠が失われたことを、削除せずに印として返す（Issue #883） | **提案 (2026-09)** |
| [0343](./0343-vector-store-search-returns-zero-norm-candidates.md) | `PostgresVectorStore.search()`/`searchMany()` が、HNSW 索引に入らないゼロベクトルの候補を部分索引 + `UNION ALL` で拾う（Issue #956） | 採用 (2026-09) |
| [0344](./0344-upgrade-from-released-version-fixture.md) | 公開済みの版で作った DB の fixture を置き、今の migration で上げる経路を必須ジョブで検査する（Issue #1038） | 採用 (2026-09) |
| [0345](./0345-doc-snippets-typechecked-opt-in-gate.md) | 文書のコード片は、印（` ```ts check `）を付けたものだけを今の公開 API で型検査し、必須の門にする | 採用 (2026-09) |
| [0346](./0346-consumer-install-check-before-release.md) | 出荷6パッケージを repo の外に入れて確かめる道具を置き、既定の CI ではなくリリース前の手順で打つ | 採用 (2026-09) |
| [0347](./0347-extract-write-path-redelivery-and-unsaveable-candidates.md) | extract のジョブは再配達で既に記憶が在れば書かず、保存できない候補はその候補だけを落として残りを書く | 採用 (2026-09) |
| [0348](./0348-extraction-language-and-speaker-instruction-gated-on-subject-candidates.md) | 抽出の出力言語・話者取り違えの指示は `subjectCandidates` 併用時にのみ足す — デフォルト経路はオーナー判断待ち | **提案 (2026-09)** |
| [0349](./0349-drizzle-pool-proxy-checkout-error-listener.md) | drizzle に渡す Pool を、`connect` だけを包んだ Proxy にして、`db.transaction()` が借りる接続に `error` リスナーを付ける | 採用 (2026-09) |
| [0350](./0350-provider-client-type-decoupled-from-sdk-classes.md) | `@mnemora/openai` / `@mnemora/anthropic` の `client` の型を SDK のクラスから切り離す（Issue #1221） | 採用 (2026-09) |
| [0351](./0351-bullmq-publish-prep.md) | `@mnemora/bullmq` を npm 公開の準備状態にする — `PUBLISH_TARGETS` へ末尾で加え、初回 publish 前の version 検査を除外する仕掛けを足す（Issue #205） | 採用 (2026-09) |
| [0352](./0352-association-score-without-total.md) | 連想枠・必須の同伴取得が返す `score` を、`total` を持たない別の形にする —— Issue #548 方向2（破壊的変更） | 採用 (2026-09) |
| [0353](./0353-activity-counting-per-call.md) | 活動時計の数え方を、呼び出しごとの引数で選べるようにする | 採用 (2026-09) |
| [0354](./0354-atomic-event-retention-purge.md) | 保持期間の読みと `memory_events` の削除を1つの原子的な操作にする（新しい任意メソッド） | 採用 (2026-09) |
| [0355](./0355-inject-clock-into-store-writes.md) | 案1 — 時刻の欄を任意にし、runtime から注入した時計を store の書き込みへ渡す | 採用 (2026-09) |
| [0356](./0356-pool-default-error-listener-warns-by-default.md) | `createPostgresClient` の `pool` に既定の `error` リスナーを付け、名乗って続行する | 採用 (2026-09) |
| [0357](./0357-outbox-reclaim-requeues-to-tail.md) | `OutboxStore.claimBatch` の取り直しは `available_at` を進め、先頭詰まりを解消する | 採用 (2026-09) |
| [0358](./0358-local-embedding-provider-splits-large-batches.md) | `LocalEmbeddingProvider` は既定で128件を超えるバッチを分割する（Issue #1141） | 採用 (2026-09) |
| [0359](./0359-abort-signal-for-provider-calls.md) | provider（LLM・埋め込み）の呼び出しに `AbortSignal` による中断を足す | 採用 (2026-09) |
| [0360](./0360-schema-unsupported-thrown-before-send.md) | `completeStructured` は、送れない zod の形を送る前に `kind: "schema_unsupported"` で落とす | 採用 (2026-09) |
| [0361](./0361-local-embedding-cache-dir-env-swap.md) | `LocalEmbeddingProvider` の `cacheDir` を、読み込みの前段の確認にも反映させる（`env.cacheDir` の一時的な差し替え + 直列化。Issue #1239） | 採用 (2026-09) |
| [0362](./0362-searchmany-lateral-forces-memories-primary-key-lookup.md) | `PostgresVectorStore.searchMany` は、統計が無いときだけ `memories` を主キー（`memories_pkey`）で引く形に切り替える（Issue #1181） | 採用 (2026-09) |
| [0363](./0363-outbox-last-error-omit-params-and-cap-length.md) | `describeJobFailure`（outbox の `lastError`）は drizzle の `params:` を落とし、長さに上限を掛ける（Issue #1064） | 採用 (2026-09) |
| [0364](./0364-lexical-tsvector-fallback-for-oversized-content.md) | `idx_memories_lexical` の式に、tsvector が1MBを超える本文だけ先頭150,000文字へ縮退するフォールバックを挟む | 採用 (2026-09) |
| [0365](./0365-local-embedding-revision-in-remote-path-template.md) | `LocalEmbeddingProvider` に `revision` を渡したら、`env.remotePathTemplate` に埋め込み、キャッシュの根を revision ごとに分ける（Issue #1403） | 採用 (2026-09) |
| [0366](./0366-trigram-extension-follows-vector-schema.md) | `probeTrigramLexicalSupport` は `pg_trgm` を、`vector` が入っているスキーマへ合わせる（引数は増やさない。Issue #1256） | 採用 (2026-09) |
| [0367](./0367-pgvector-capability-check.md) | pgvector の `hnsw.iterative_scan` 対応を、版の文字列ではなく能力で検査する | 採用 (2026-09) |
| [0368](./0368-consolidate-reflect-validity-intersection.md) | `consolidate`/`reflect` の統合先・内省の記憶は、材料の有効期間の積を引き継ぐ（Issue #1188 残り） | 採用 (2026-09) |
| [0369](./0369-opt-in-extract-event-data-and-document-title.md) | `event.data`・`document.title` を抽出（LLM）へ渡す口を、opt-in の任意欄として足す | 採用 (2026-09) |
| [0371](./0371-db-tests-per-worker-database.md) | `packages/postgres` の DB テストをファイル並列にする——worker ごとに専用 DB を TEMPLATE で複製する | 採用 (2026-09) |
| [0372](./0372-conformance-suite-issue-1238-promises.md) | Issue #1238 の棚卸しのうち7件を conformance suite の `it` として足す | 採用 (2026-09) |
| [0373](./0373-conformance-suite-issue-1412-promises.md) | Issue #1412（Issue #1238 棚卸しの続き）のうち A8・A10・A11・コメント1・2 を conformance suite の `it` として足す | 採用 (2026-09) |
| [0374](./0374-search-stats-presence-instance-cache.md) | `search()`/`searchMany()` の統計あり・無し切り替えを、1本の SQL の中の One-Time Filter から、インスタンス単位の記憶（`StatsPresenceGate`）へ変える（Issue #1415） | 採用 (2026-09) |
| [0375](./0375-purge-scope-widened.md) | `purge()` が消す範囲を広げる——`tags`/`attributes`/claim key・label の紐付け・`recalls.index_band` の digest 帯 | 採用 (2026-09) |
| [0377](./0377-claim-key-contested-detection-excludes-same-observation-siblings.md) | claim key の衝突検出は、同じ observation（＝同じ発話）から抽出された兄弟 Memory どうしを一致から除く（Issue #835 候補1） | 採用 (2026-09) |
| [0378](./0378-claim-key-contested-detection-covers-contested-matches.md) | claim key の自動 contested 検出は、3件目以降も一致に数える —— `findContestedByClaimKey?`（PR1）と、多者間 `contested` を表へ束ねる書き込み経路の全体設計（PR2、Issue #933・#207・ADR 0327 の続き） | 採用 (2026-09) |
| [0379](./0379-contested-tag-asymmetric-wording.md) | 矛盾候補欄の文面を記録順で非対称にし（案1）、実際に非対称文面が出た回だけ system 文に読み方の一文を足す（案3）。C2（案1＋案3、既定オン）を採用する（Issue #1430） | **採用: (2026-09)** |
| [0380](./0380-reextract-withdrawn-across-extractor-versions.md) | `reextract` は、版を跨いで退けた記憶を見る——`MemoryStore.listBySourceObservationAllVersions` を新設する | 採用 (2026-09) |
| [0381](./0381-contested-group-write-path-implementation.md) | 多者間 `contested`（`memory_relations`）の書き込み経路の実装 —— Issue #207/#933 PR2 段階B の直しと設計判断 | 採用 (2026-09) |
| [0382](./0382-vector-store-delete-across-spaces.md) | `VectorStore` に `deleteAcrossSpaces`（必須メソッド）を足す——`purge` が全 space の embedding を消す | 採用 (2026-09) |
| [0383](./0383-erase-tenant.md) | テナント単位で全表から行を消す `eraseTenant` を足す | 採用 (2026-09) |
| [0384](./0384-digest-band-index-and-scope-aggregate-skip.md) | `aggregateScope` の重さに対して、目次帯へ部分索引を足す（案A）と、件数集計を止める明示的な opt-in を足す（案C） | 採用 (2026-09) |
| [0385](./0385-association-probes-baseline-from-ci-measurement.md) | association-probes の基準値を CI 実測（6回）から置き、基準値より悪化した arm を警告する節を足す — 許容幅は0、ADR 0158 が挙げた #316/#317 の前提は CI でも成立した（Issue #291） | 採用 (2026-09) |
| [0387](./0387-cjs-require-esm-smoke-in-default-ci.md) | README の「CommonJS からは require(esm) で読める」を、registry に出ない切り出し版で毎 PR の CI に入れる | 採用 (2026-09) |
| [0389](./0389-recalls-digest-band-index.md) | `recalls.index_band` の目次帯に式の GIN 索引を足す——`purgeMemory` が `recalls` を全部読まないようにする | 採用 (2026-09) |
| [0390](./0390-ann-unreached-aware-of-excluded-provenance-and-skip.md) | `ann_unreached` が `excludeProvenanceKinds` を分母から引く（除外行の索引済み件数を集約が返す）と、`scopeAggregate: "skip"` で到達を判定できないと名乗る | 採用 (2026-09) |
| [0391](./0391-language-mismatch-mark-on-created-event.md) | 抽出の言語の事後検査は「印を付けるだけ」にし、`created` イベントの `meta.languageMismatch` に出す | 採用 (2026-09) |
| [0393](./0393-core-checks-embedding-dimension.md) | core が、provider の返す埋め込みの次元（`space.dimensions`）と成分の有限性を確かめる | 採用 (2026-09) |
| [0394](./0394-activity-clock-writes-use-memorys-own-subject.md) | 活動時計の書き込みは、`ctx` ではなく記憶自身の subject の `T + S_x` を使う（ADR 0353 の負債1の解消） | 採用 (2026-09) |
| [0395](./0395-create-recall-activity-clock-single-statement.md) | `createRecall` の活動時計の加算を、`recalls` の INSERT と1つの SQL 文にする（ADR 0165 負債1 への案1） | 採用 (2026-09) |
| [0396](./0396-recall-relation-max-count.md) | 段3（多者間の同伴取得）の群ごとの上限を、`RecallQuery.relationMaxCount` で呼び出し側から変えられるようにする | 採用 (2026-09) |
| [0397](./0397-postgres-db-tests-isolate-false.md) | `packages/postgres` の DB テストの並列 project を `isolate: false` にする（Issue #1276 案E） | 採用 (2026-09) |
| [0398](./0398-relation-store-link-checks-both-ends-belong-to-ctx-tenant.md) | `RelationStore.link` は、入口で両端の記憶が `ctx` のテナントに属することを確かめる（複合外部キーの migration は入れない） | 採用 (2026-09) |
| [0399](./0399-purge-embedding-cleanup-outcome-field.md) | `Runtime.purge` の埋め込み削除の失敗を、outcome の任意欄 `embeddingCleanup` で知らせる | 採用 (2026-09) |
| [0400](./0400-general-fk-index-tooth.md) | 外部キーの索引は、固定表ではなく `pg_constraint` から数え上げる歯で縛る——`memory_labels.label_id` の漏れを足す | 採用 (2026-09) |
| [0401](./0401-mark-resolve-contested-group-constant-statements.md) | `markContestedGroup` / `resolveContestedGroup` の関係の行の INSERT を実表の N² 結合にせず、メンバーごとの UPDATE / events INSERT を定数個の文にまとめる | 採用 (2026-09) |
| [0402](./0402-relation-store-list-related-many.md) | `RelationStore.listRelatedMany?` を足し、幅優先探索の1段（frontier）を1往復で読む | 採用 (2026-09) |
| [0404](./0404-purge-expired-recalls-and-completed-outbox-jobs.md) | 古い `recalls` と完了済みの `outbox` 行を消す口 `purgeExpiredRecalls?` / `purgeCompletedJobs?` を足す | 採用 (2026-09) |
| [0405](./0405-roundtrip-count-confirms-stats-before-measuring.md) | `recall-roundtrip-count` は、往復を数える前に `StatsPresenceGate` を確認済みにする | 採用 (2026-09) |
| [0406](./0406-reextract-aborts-if-source-forgotten-while-waiting-for-llm.md) | `reextract` は、LLM を待つ間に元の記憶が forget されたら、何も書かずに打ち切る | 採用 (2026-09) |
| [0407](./0407-sync-observe-extract-job-lease.md) | `extract: "sync"` の observe は、積んだ extract ジョブを claim 済みの状態で作る（`createObservationWithOutbox` の `opts.claimedBy?`） | 採用 (2026-09) |
| [0410](./0410-extract-created-event-in-same-transaction.md) | 抽出の `created` イベントは、記憶と同じトランザクションで書く（任意メソッド `createMemoriesWithOutboxAndEvents?`） | 採用 (2026-09) |
| [0412](./0412-purge-target-select-indexes.md) | `purgeExpiredRecalls` と `purgeCompletedJobs` の対象選択に索引を足す（ADR 0404 決定7を改める） | 採用 (2026-09) |
| [0413](./0413-requeue-embed-zero-hit-scan-not-fixed.md) | `requeueEmbedJobs` の「全 status が0件」の走査は、測ったうえで直さない | 採用 (2026-09) |
| [0414](./0414-drop-database-checkpoint-wait-not-fixed.md) | `DROP DATABASE` の checkpoint 待ちで afterAll が時間切れになりうることは、測ったうえで直さない | 採用 (2026-09) |
| [0415](./0415-consolidate-reflect-skip-scope-aggregate.md) | consolidate / reflect の内部 recall に `scopeAggregate: "skip"` を渡し、使わない件数集計を払わない | 採用 (2026-09) |
| [0416](./0416-created-event-same-tx-remaining-paths.md) | `created` イベントを記憶と同じトランザクションで積む範囲を、reextract・consolidate の口あり経路と reflect へ広げる（穴 D-3 の続き） | 採用 (2026-09) |
| [0418](./0418-store-error-kind-guards.md) | store 例外は `instanceof` ではなく `kind`（無ければ `name`）で判定する | 採用 (2026-09) |
| [0419](./0419-local-embedding-provider-dispose.md) | `LocalEmbeddingProvider` に任意の `dispose()` を足す | 採用 (2026-09) |
| [0420](./0420-consolidate-reflect-abort-on-superseded-and-all-conflicted.md) | `consolidate`・`reflect` は、材料が superseded になったときと、統合元がすべて CAS に弾かれたときに打ち切る | 採用 (2026-09) |
| [0421](./0421-concurrent-write-and-audit-event-holes.md) | 同時の書き込みと監査イベントの小さな穴——直したもの（Q1）と、実測して縛って負債にしたもの（R4・R5） | 採用 (2026-09) |
| [0422](./0422-reextract-created-event-at-and-meta.md) | `reextract` の `created` イベントの `at` を同じ操作の `superseded` と揃え、meta に再抽出の印を足す。同じ `at` のイベントの並びは約束しない | 採用 (2026-09) |
| [0423](./0423-identifier-well-formed-and-error-message-without-params.md) | 識別子の文字の扱いを揃え、区別できない値を入口で断る。利用者へ伝わる例外の message から入力値を落とす | 採用 (2026-09) |
| [0424](./0424-normalized-content-comparison-and-boundary-conformance.md) | 「同じ内容」の比較を正規化し（NFC + trim、core で除く）、testkit と Postgres の入力の境界を揃える | 採用 (2026-09) |
| [0425](./0425-migrate-warns-on-ledger-drift.md) | `runMigrations` は、台帳と手元のファイルのずれを見つけたら警告を出して続行する | 採用 (2026-09) |
| [0426](./0426-in-memory-erase-tenant-postgres-alignment.md) | testkit のインメモリ `eraseTenant` を Postgres 実装に揃える（`tenant_subject_activity` の行数と、埋め込みの CASCADE） | 採用 (2026-09) |
| [0427](./0427-events-purged-at-millisecond.md) | `events_purged` の `at` を SQL の `now()` から JS 側の時刻（`toPgTimestamp`）へ替える | 採用 (2026-09) |
| [0428](./0428-provider-abort-reason-and-error-guards.md) | provider を直に呼んだときの abort の reject を `signal.reason` に揃え、openai・anthropic の例外に判定関数を足す | 採用 (2026-09) |
| [0429](./0429-exact-optional-property-types-input-types.md) | 入力側の公開型の任意欄を `?: T \| undefined` に広げ、`exactOptionalPropertyTypes: true` の利用者から `undefined` を渡せるようにする | 採用 (2026-09) |
| [0430](./0430-concurrent-create-erase-and-standalone-params.md) | 同時呼び出しで落ちる2つの口（trigram store の `create()`、同じテナントへの `eraseTenant`）を直列にし、公開の独立関数の例外からも `params` を落とす | 採用 (2026-09) |
| [0431](./0431-contested-group-event-growth-and-recall-cut.md) | 群（`markContestedGroup`）の監査イベントの増え方を N の線形にし、段4の `cut` の求め方を O(n²) から O(n) にする | 採用 (2026-10) |
| [0432](./0432-recall-status-recheck-and-archive-docs.md) | recall の段1・連想枠の後置に `status` の再検査を足し、`archiveDecayed` の `reachedLimit` を直し、archived まわりの文書を実装に揃える | 採用 (2026-10) |
| [0433](./0433-claim-key-length-space-error-reembed-limit.md) | claim key の長さに上限を置く・負の類似度の順位を文書に書く・未登録の埋め込み空間を型付きの例外にする・`reembed` の `limit` を入口で検査する | 採用 (2026-10) |
| [0434](./0434-testkit-fixtures-align-nul-int4-invalid-date-purged-at.md) | testkit のインメモリ実装を Postgres 実装に揃える（NUL の口の追加・`sizeBeforeBytes` の int4・`reinforce` の `nowSeq`・outbox の `now` の Invalid Date・`createMemory` の `purgedAt`） | 採用 (2026-10) |
| [0435](./0435-claim-key-index-limit-typed-error-and-helper-tests.md) | claim key の索引の上限（SQLSTATE 54000）を型付きの例外に包む・直接のテストが無かった4つの関数に TSDoc の約束の歯を足す | 採用 (2026-10) |
| [0436](./0436-event-vector-write-checks-memory-belongs-to-ctx-tenant.md) | `EventStore.append`・`VectorStore.upsert` は、入口で記憶が `ctx` のテナントに属することを確かめる（複合外部キーの migration は入れない） | 採用 (2026-10) |
| [0437](./0437-helpers-params-subject-ids-repurge.md) | 公開ヘルパー9本の例外から `params` を落とす・`subjectIds` と `advanceActivityClock.subjectId` を識別子の検査の内側に置く・v1.1.0 より前に purge した行の残骸を purge のかけ直しで消す | 採用 (2026-10) |
| [0438](./0438-tenant-boundary-teeth-and-purge-uuid-case.md) | 別テナントを混ぜた歯を足す・purgeMemory の大文字の id を直す・subject カウンタの相関サブクエリの修飾を直す | 採用 (2026-10) |
| [0439](./0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md) | `MemoryStore` の書き込み口は、別の行を指す参照の参照先が `ctx` のテナントの行であることを、書く前に確かめる（複合外部キーの migration は入れない） | 採用 (2026-10) |
| [0440](./0440-outbox-first-terminal-wins-extraction-local-date-years-bullmq-stalled.md) | 抽出の現地の暦日を年の範囲によらず組み直す・outbox の終端を先勝ちにする・BullMQ の stalled を README に書く | 採用 (2026-10) |
| [0441](./0441-changelog-migration-refs-consumer-smoke-names.md) | CHANGELOG と migration-v1 の参照の食い違いを直す・postgres の例外は `name` だけと訂正する・README に ES2022 を書く・consumer-install の実行検査に値の名前を足す | 採用 (2026-10) |
| [0442](./0442-migrate-deadlock-subject-injection-ddl-lock-wait-docs.md) | migration `0027` の deadlock・LLM が返す `subjectId` の注入・DDL のロック待ちを、文書に書く | 採用 (2026-10) |
| [0443](./0443-aux-field-drop-bind-limit-association-fetch.md) | LLM の補助の欄が保存できないときはその欄だけを落とす・id と検索クエリの件数によるバインド上限の崖を無くす・連想枠のアンカーごとの取得件数は絞らない | 採用 (2026-10) |
| [0444](./0444-pool-begin-release-rollback-error-preserved.md) | `db.transaction()` の `begin` が失敗した接続を pool へ戻す・`rollback` の失敗で元のエラーを消さない・`closePostgresClient` を `pool.end()` の直接呼びの後でも reject させない・文書の §11 との結び目を足す | 採用 (2026-10) |
| [0445](./0445-local-embedding-chunk-abort-chat-drain-provider-docs.md) | local-embedding の分割推論でチャンクの合間に abort を見る・`chat` が embed の失敗を言う・provider の再試行と timeout の文書を足す | 採用 (2026-10) |
| [0446](./0446-apply-correction-no-write-before-winner-check-case-insensitive-candidate-reason-winner.md) | applyCorrection は勝者の検査を書き込みの前に通す・大文字小文字だけ違う correctedId を store に従って候補にする・buildCorrectionReason の winner を大文字小文字だけ違う id でも実際の勝者に合わせる | 採用 (2026-10) |
| [0447](./0447-lifecycle-operation-state-matrix-round23.md) | lifecycle の「操作 × 状態」の行列を当てた（穴探し23巡目。直す線に当たる穴は0件） | 採用 (2026-10) |
| [0448](./0448-migrate-cli-pool-error-unreadable-dir-session-settings.md) | migrate の CLI の Pool に `error` のリスナーを付ける・`migrationsDir` が読めない／空のときの扱い・セッション設定（`statement_timeout` など）が本体に効くことを文書に書く | 採用 (2026-10) |
| [0449](./0449-bullmq-tick-driver-measured-against-real-redis.md) | bullmq の tick-driver を実 Redis（redis-server 7.4.7）に当てた——文書の「未実測」7件を測り、ずれた所だけ文書を直す・README の片に型検査の印を付ける | 採用 (2026-10) |
| [0450](./0450-contested-group-operation-state-matrix-round26.md) | contested の群（`markContestedGroup`・`resolveContestedGroup`）の「操作 × 状態」の行列を当てた（穴探し26巡目。直す線に当たる穴は0件） | 採用 (2026-10) |
| [0451](./0451-savepoint-rollback-failure-keeps-original-error.md) | `createMemoriesWithOutboxAndEvents` の候補ごとの savepoint の `rollback to savepoint` が失敗しても、元のエラーを消さない（`dropped` に積まず、続けず、元のエラーを投げる） | 採用 (2026-10) |
| [0452](./0452-testkit-provider-fakes-align-with-contract.md) | testkit の provider の fake・カセットを `EmbeddingProvider`・`LLMProvider` の約束と本物に揃える・`recall()` のクエリ埋め込みが数値の型付き配列も受ける | 採用 (2026-10) |
| [0453](./0453-embed-job-and-reinforce-state-matrix-round27.md) | embed ジョブと reinforce の「操作 × 状態」の行列を当てた（穴探し27巡目。直す線に当たる穴は0件） | 採用 (2026-10) |
| [0454](./0454-reextract-anchor-observe-consolidate-state-matrix-round30.md) | observe・consolidate・reextract の「操作 × 状態」の行列を当て、reextract の置き換えた側が active でない行になる穴を直した（穴探し30巡目） | 採用 (2026-10) |
| [0456](./0456-llm-returned-values-malformed-read-filter-nul-named.md) | LLM が返した値の保存できない形（NUL・孤立サロゲート）で observe・consolidate・reflect が落ちないようにする・読み取りの絞りの NUL を名指しの例外で断る（穴探し29巡目、前例の横展開） | 採用 (2026-10) |
| [0457](./0457-round29-precedent-sweep-confirmations-and-doc-measurements.md) | 29巡目（前例の横展開）の確認の結果を残す——当てた形・入力・コマンド・結果、陽性対照、文書の「実測していない」を1つ測る | 採用 (2026-10) |
| [0458](./0458-round31-memory-store-promise-teeth-outside-conformance.md) | 31巡目——MemoryStore の port の約束のうち、conformance suite にも既存の歯にも見当たらなかったものに、同じ本文の歯を2実装へ足す | 採用 (2026-10) |
| [0459](./0459-round32-doc-drift-after-1550-1563.md) | 穴探し32巡目 — 今日（2026-10-01）マージされた PR（#1550〜#1563）のあとの文書のずれを直す（文書だけ） | 採用 (2026-10) |
| [0460](./0460-multi-process-multi-pool-round33.md) | 「同じ Pool／別の Pool／別のプロセス」から 23・26・27・30 巡目の操作を同時に当て、`registerEmbeddingSpace` が `max: 1` で返らない穴と `lock_timeout` を 0 に書き換える穴を直した（穴探し33巡目） | 採用 (2026-10) |
| [0461](./0461-v1-2-0-release-prep-inspection.md) | 穴探し34巡目 — v1.2.0 を出すための準備の点検（更新経路の fixture・CHANGELOG・migration の順序・migration-v1 の 🔴） | 採用 (2026-10) |
| [0462](./0462-churn-test-tolerates-dead-idle-connection-after-terminate.md) | 全接続を切る反復の歯は、切った直後に死んだ待機中の接続を掴む `57P01` を、`max` 回まで受け入れてから「新しい transaction が通る」を縛る | 採用 (2026-10) |
| [0463](./0463-migration-v1-red-items-checked-against-code.md) | 穴探し35巡目 — `docs/migration-v1.md` の 🔴（v1.1.0 → 次の版）の各項目を、現物の実装と歯に突き合わせた記録 | 採用 (2026-10) |
| [0464](./0464-register-embedding-space-absorbs-migration-index-race.md) | `registerEmbeddingSpace` の索引作りが migration（0022・0027）と重なって `23505` で落ちるのを、1回の打ち直しで吸収する（穴探し36巡目、ADR 0460 の D1） | 採用 (2026-10) |
| [0465](./0465-gate-red-tooth-sees-db-test-file-not-vitest-summary.md) | 門が赤くなる歯は、「DB テストが本当に走って落ちた」を vitest の集計の行ではなく、落ちた DB テストのファイルの名前で見る | 採用 (2026-10) |
| [0466](./0466-inmemory-event-target-belongs-to-ctx-tenant.md) | `InMemoryMemoryStore` も、`NewMemoryEvent.memoryId` が `ctx` のテナントの記憶でなければ書かずに断る（ADR 0456 の H4 の InMemory 版） | 採用 (2026-10) |
| [0467](./0467-recall-footprint-nonfinite-inputs-fallback-digest-grapheme.md) | 穴探し38巡目 — recall footprint の見積もり関数が非有限の入力で結論を出さない・フォールバック digest を書記素の境界で切る | 採用 (2026-10) |
| [0468](./0468-openai-null-strip-copies-own-proto-key-as-own-property.md) | 穴探し39巡目 — provider の構造化出力の往復を当て、`@mnemora/openai` が応答の `"__proto__"` を継承された値として読ませていたのを直す | 採用 (2026-10) |
| [0469](./0469-fake-event-target-and-uuid-case.md) | core の `FakeMemoryStore` も、別テナントを指す `NewMemoryEvent.memoryId` を断る・大文字の uuid の扱いを3実装で測って揃える | 採用 (2026-10) |
| [0470](./0470-footprint-digits-failure-description-grapheme.md) | 穴探し41巡目 — ADR 0467 の材料のうち、線の内側のものを直す（footprint の桁の数え・失敗の説明の書記素切り）。`estimateRecallFootprint` の NaN は材料のまま | 採用 (2026-10) |
| [0471](./0471-structured-output-zod-shapes-recorded-in-readme.md) | 穴探し42巡目 — 構造化出力の、README の表に無い zod の形5つの今の振る舞いを、2つの provider の README と歯に記録する（文書の直し） | 採用 (2026-10) |
| [0472](./0472-subject-activity-seqs-object-prototype-keys.md) | 穴探し43巡目 — subjectId が `Object.prototype` のキー名（`constructor`・`valueOf`・`__proto__` など）のとき、subject 別の活動カウンタの読みが壊れるのを直す | 採用 (2026-10) |
| [0473](./0473-validity-empty-inverted-interval-no-overlap.md) | 空の区間・逆転した区間の記憶を、claim key の「有効期間が重なる」から外す・有効期間と見る口の境界を当てた記録（穴探し44巡目） | 採用 (2026-10) |
| [0474](./0474-recall-query-tags-duplicates-claim-key-normalize-idempotent.md) | 穴探し45巡目 — `RecallQuery.tags` の重複の数え方を文書と歯に書く・`normalizeClaimKeyPart` のべき等が破れる入力を記録して直さない | 採用 (2026-10) |
| [0475](./0475-eventstore-append-uuid-case.md) | `InMemoryEventStore.append`・`FakeEventStore.append` も、`event.memoryId` の大文字小文字を区別しない（ADR 0469 の残りを揃える） | 採用 (2026-10) |
| [0476](./0476-label-upsert-lock-order-and-taxonomy-probes.md) | 穴探し47巡目 — 同じ語彙を逆の並びで `tags` に持つ記憶を同時に作ると、`labels` の行ロックが循環待ちになる（40P01）のを直す。taxonomy の経路で当てた形の記録 | 採用 (2026-10) |
| [0477](./0477-bullmq-tick-driver-everyms-jobname-queuename-not-checked.md) | 穴探し48巡目 — `createBullmqTickDriver` の `everyMs`・`jobName`・`queueName` は検査されない。不正値で何が起きるかを実 Redis で測り、README と TSDoc に書く | 採用 (2026-10) |
| [0478](./0478-example-chat-readme-flags-env-coverage.md) | 穴探し49巡目 — `examples/chat/README.md` が載せていなかったフラグと環境変数を、利用者向けと内部用に分けて一覧にする。文書のコード片と散文の数値は突き合わせてずれなし | 採用 (2026-10) |
| [0479](./0479-tenant-settings-write-fake-alignment.md) | 穴探し50巡目 — `TenantSettingsStore` の書き込み口。core の `FakeTenantSettingsStore` だけが、他の2実装が拒む値を受けていたので揃える | 採用 (2026-10) |
| [0480](./0480-recall-record-createdat-invalid-date-fake-aliasing.md) | 穴探し51巡目 — 想起の記録の往復。`createRecall` の Invalid Date の `createdAt` を InMemory と Fake が受けていた。Fake の記録は呼び出し側と同じオブジェクトを共有していた | 採用 (2026-10) |
| [0481](./0481-recall-output-validation-on-real-postgres.md) | 穴探し52巡目 — 実 Postgres のテストが一度も渡していない `RecallQuery` の欄を、`outputValidation: "throw"` で当てる（ずれは見つからなかった） | 採用 (2026-10) |
| [0482](./0482-observe-input-kinds-event-data-roundtrip-table-tooth.md) | 穴探し53巡目 — `observe()` の入力の種類ごとの扱い。`event.data` の「JSON で往復しない値」の表に歯が無く、関数・`Symbol`・`toJSON` の3行も載っていなかった | 採用 (2026-10) |
| [0483](./0483-token-counter-broken-values.md) | 穴探し54巡目 — 差し替えた `TokenCounter` が約束を破る値を返すと、recall はトークン予算を黙って外す。今の振る舞いを文書に書き、歯で縛る | 採用 (2026-10) |
| [0484](./0484-recall-channel-merge-on-real-postgres.md) | 穴探し55巡目 — `recall` の `channels`（ANN・lexical）の候補の合流を、実 Postgres の2つの語彙 store で ADR 0084 の表に照らして縛る（ずれは見つからなかった） | 採用 (2026-10) |
| [0485](./0485-find-correction-candidates-exclude-ids.md) | 穴探し56巡目 — 訂正の候補を探す `findCorrectionCandidates`。`excludeMemoryIds` は大文字の uuid を除外せず、反復できない値では recall の記録を書いた後に落ちていた | 採用 (2026-10) |
| [0486](./0486-fixture-event-data-align-and-context-text-unit.md) | 穴探し53巡目の続き — testkit の fixture が関数・`Symbol`・`toJSON` を含む `event.data` を `DataCloneError` で断っていたのを Postgres に揃える。`extractionContext` の `text` の上限の単位を書く | 採用 (2026-10) |
| [0487](./0487-usage-counter-label.md) | `usage.counter` の印は連結の計測の印であり、段4の予算の判定に使った印とは食い違いうる。今の振る舞いを文書に書く | 採用 (2026-10) |
| [0488](./0488-relation-store-fake-alignment.md) | 穴探し57巡目 — `RelationStore`。core の `FakeRelationStore` だけが範囲外の kind を受け、`createdAt` を参照のまま返していた。`listRelated` の偽の kind は Postgres と fixture で割れていたので、fixture を Postgres に揃えた | 採用 (2026-10) |
| [0489](./0489-embedding-input-hook-return-values.md) | 穴探し58巡目 — `RuntimeDeps.embeddingInput`（利用者のフック）の戻り値が `string` でないとき・端の値のときの `processEmbedJob`（ずれは見つからなかった） | 採用 (2026-10) |
| [0490](./0490-language-mismatch-latin-letters-only.md) | 穴探し59巡目 — 言語の事後検査（ADR 0391）が「ラテン文字」にローマ数字を数えていた。文字だけを数える直しと、`created` の印を実 adapter で縛る歯 | 採用 (2026-10) |
| [0491](./0491-claim-key-relative-period-across-observations.md) | Issue #1436 — 別々の observation に分かれた、相対的な期間（去年／今年）だけが違う正しい2主張が contested になる限界を、今の振る舞いとして `detectContested` の TSDoc に書き、歯で縛る | 採用 (2026-10) |
| [0492](./0492-fuzz-profile-fields.md) | 穴探し — recall の不変条件 fuzz に、これまで一度も振っていない欄（`timeWeighting`・`digestBandLimit`・クエリの `tags`・`occurredAt`）を足す（割れは見つからなかった） | 採用 (2026-10) |
| [0493](./0493-fake-and-inmemory-input-checks-aligned-to-postgres.md) | 穴探し60巡目 — core の Fake と testkit の InMemory が、`@mnemora/postgres` の断る入力を通していた口を揃える（形 A〜E を横に掃いた） | 採用 (2026-10) |
| [0494](./0494-fuzz-relations-and-argument-mutation.md) | 穴探し — recall の fuzz に `relationStore`（多者間の群・`relationMaxCount`・`link`/`unlink`）と引数の変形（大文字の id・消した記憶の id）を足した。core の recall に 2 つの割れが出たので直した | 採用 (2026-10) |
| [0495](./0495-doc-code-drift-sweep.md) | 文書とコードのずれを横に掃く — パッケージの README・約束の文書・公開の型の TSDoc を、今の main の型と実装に照らす | 採用 (2026-10) |
| [0496](./0496-core-entry-rejections-adr-0446-0445-0472-0474-0485.md) | 型の外の入力を、新しく例外で断る5つの口 — `findCorrectionCandidates`・`resolveContested(Group)`・`tick`・`decayFloorOffset`/`floorAt`・`attributes` の `__proto__`（ADR 0446・0445・0472・0474・0485・0490 が「オーナーの領分」に残したもの） | 採用 (2026-10) |
| [0497](./0497-recall-rejects-broken-token-counter.md) | 差し替えた `TokenCounter` が有限で 0 以上でない `tokens` を返したら、`recall()` は `RangeError` で断る（ADR 0483 の材料を直す） | 採用 (2026-10) |
| [0498](./0498-constructor-config-checks.md) | 壊れた構成値を構築時に断る — `createBullmqTickDriver` の `everyMs`・`jobName`、provider のコンストラクタの数値オプション | 採用 (2026-10) |
| [0499](./0499-store-write-checks-nul-named-status-range-purged-cas-int4-days.md) | 書き込み口の NUL を名指しで断る・`resolveContested*` の型の外の `status` を断る・purge 済みの行を CAS に一致させない・`setEventRetention` の日数の上限を共有の検査へ | 採用 (2026-10) |
| [0500](./0500-testkit-fixture-alignment-claimkey-labels-timestamptz-seq-llm-float4.md) | testkit の fixture を Postgres に揃える（`findContestedByClaimKey`・検索の `labels` の NUL、`timestamptz` の下限、`reinforce` の bigint 溢れ、LLM 応答の参照、core Fake の float4 読み戻し） | 採用 (2026-10) |
| [0501](./0501-doc-debts-usage-env-analyze-per-process-reinforce-purged.md) | 文書の負債3件を返す — `--help` の環境変数（ADR 0478 負債1）・ANALYZE の数えがプロセスごと（ADR 0460 D5）・purged への強化の TSDoc（ADR 0453 負債3） | 採用 (2026-10) |
| [0502](./0502-observe-rejects-whitespace-only-input.md) | `observe()` が、本文が空白だけの入力（`utterance.text`・`event.name`・`document.content`）を入口で断る | 採用 (2026-10) |
| [0503](./0503-superseded-by-checks-resolve-contested-update-status.md) | `supersededById` の約束を壊す入力を断る（`resolveContestedPair`・`resolveContestedGroup`・`updateStatus`・`updateStatusWithEvent`） | 採用 (2026-10) |
| [0504](./0504-vector-store-omits-params-from-thrown-errors.md) | `PostgresVectorStore` を直接呼んだときの例外からも、SQL の `params` の値を落とす | 採用 (2026-10) |
| [0505](./0505-seq-sum-overflow-fixture-observation-recall-nul-event-lexical-params.md) | fixture の `S_x` の bigint 溢れ（`archiveDecayed`・`aggregateScope`・`VectorStore.search`）、Observation・Recall の NUL を名指しで断る、`EventStore.append`・`LexicalStore.search` の例外から params を落とす | 採用 (2026-10) |
| [0506](./0506-core-fake-ctx-and-recall-record-checks.md) | core の Fake の残りの入力検査を InMemory・Postgres に揃える（`createRecall` の書けない値、`subjectId` を取る読み口、`ctx` の表） | 採用 (2026-10) |
| [0507](./0507-language-mismatch-observation-counted-once-per-observation.md) | 言語の事後検査（ADR 0391）の観測側の数えを、観測ごとに1回へ畳む（判定は変えない） | 採用 (2026-10) |
| [0508](./0508-recall-channels-undecidable-japanese-labels-on-real-postgres.md) | `recall` の `channels` の合流のうち、`ann_truncated`（undecidable）・日本語の語彙・`labels` との組を、Fake と実 Postgres に同じ問いを当てて縛る（割れは見つからなかった。日本語だけ既知の非対称を歯にした） | 採用 (2026-10) |
| [0509](./0509-fuzz-uncovered-fields-channels-hnsw-recall-record.md) | 穴探し — recall の fuzz に `channels`（tsvector・trigram）・HNSW 上の `fields`・`getRecall` の読み戻しを足した（Fake と testkit の語彙検索の食い違いが 2 つ出た。直していない） | 採用 (2026-10) |
| [0510](./0510-doc-forms-not-yet-swept.md) | 文書とコードのずれの掃きが「見ていない形」として残した、表の中の数値・定数と、既定値・振る舞いの散文を、コードの定数に名指しで照らす | 採用 (2026-10) |
| [0511](./0511-label-upsert-cross-memory-and-purge-update-order-deadlocks.md) | 記憶をまたぐ `upsertProposedLabels` の順と、purge/scrub の `UPDATE labels … FROM counted` の更新順が、並行する書き込みと 40P01 になる（ADR 0476 の負債1・2）。再現と直し | 採用 (2026-10) |
| [0512](./0512-scrub-purged-index-band.md) | v1.0.x の purge が `recalls.index_band` に残した digest を、`scrubPurged`（purge のかけ直し）で伏せる | 採用 (2026-10) |
| [0513](./0513-lexical-match-fixtures-aligned-to-postgres.md) | 語彙検索の fixture を Postgres に揃える（core の Fake は部分一致をやめて語の一致に、testkit の InMemory は `PROJ-12` を空白区切りの 1 語として数える） | 採用 (2026-10) |
| [0514](./0514-tick-opts-kinds-limit-claimed-by-and-huge-lease-ms.md) | `Runtime.tick` の `opts.kinds`・`limit`・`claimedBy` と、保存できない巨大な `leaseMs` を、claim の前に名指しで断る（ADR 0496「引き受けた負債」の5と1） | 採用 (2026-10) |
| [0515](./0515-superseded-by-remaining-checks.md) | `supersededById` の残りの断り（`resolveContestedPair` の対の外の `forgotten`、`updateStatus*` の `superseded` 以外への付与） | 採用 (2026-10) |
| [0516](./0516-omit-params-trigram-outbox-tenant-settings-stores.md) | `PostgresTrigramLexicalStore.search`・`PostgresOutboxStore`・`PostgresTenantSettingsStore` を直接呼んだときの例外からも、SQL の `params` の値を落とす | 採用 (2026-10) |
| [0517](./0517-blank-title-is-not-prefixed-when-extract-title.md) | `extractTitle: true` のとき、空白だけの `document.title` を本文の前置きにしない（断らず、無視する） | 採用 (2026-10) |
| [0518](./0518-status-conflict-error-purged-row-doc.md) | `MemoryStatusConflictError` の TSDoc に、purge 済みの行では `expectedStatus` と `observedStatus` が両方とも `"forgotten"` になることを書く（文書だけ） | 採用 (2026-10) |
| [0519](./0519-inmemory-reinforce-purged-matches-postgres.md) | testkit の InMemory の `reinforce` が purge 済みの記憶をどう扱うかを実測した — Postgres と同じだった（割れなし。歯を足し、TSDoc の「測っていない」を書き換えた） | 採用 (2026-10) |
| [0520](./0520-doc-code-drift-sweep-0486-0488.md) | 文書とコードのずれを横に掃く（続き）— ADR 0486・0488 の分の文書を、今の main の型と実装に照らす | 採用 (2026-10) |
| [0521](./0521-fixtures-accept-uppercase-target-id-like-postgres.md) | 穴探し — testkit の InMemory と core の Fake が、操作の対象の id（記憶・observation・recall・outbox のジョブ）を大文字で渡されても、`@mnemora/postgres` と同じ記憶・同じ行として扱うようにした。fuzz の `argupper` を3実装の差分に載せた | 採用 (2026-10) |
| [0522](./0522-unmeasured-0493-runtime-lexical-seq-event-purge.md) | 穴探し — ADR 0493 §9「測っていないこと」の実測。Runtime 層の「消した後の参照」・`LexicalFilter` の seq 欄・`purgeExpiredEvents` の後の参照（割れは見つからなかった。歯を足した） | 採用 (2026-10) |
| [0523](./0523-doc-code-drift-sweep-0493-0494-0497-0498-0501.md) | 文書とコードのずれを横に掃く（続き）— ADR 0493・0494・0497・0498・0501 の分の文書を、今の main の型と実装に照らす | 採用 (2026-10) |
| [0524](./0524-uppercase-and-after-delete-llm-paths.md) | 穴探し — ADR 0522「測っていないこと」の実測。`observe`・`reextract`・`consolidate`・`reflect` の「大文字の id」と「消した後の参照」（小文字では3者一致。大文字は既知の形に加えて、Postgres の `created` イベントの `meta.sources` に呼び出し側の綴りが残る形を1つ見つけた） | 採用 (2026-10) |
| [0525](./0525-config-error-types-align-with-provider.md) | 構成値の検査の例外の型を揃える — `createBullmqTickDriver`・`registerEmbeddingSpace`・`DeterministicEmbeddingProvider` を、型の誤りは `TypeError`・範囲の誤りは `RangeError` にする | 採用 (2026-10) |
| [0526](./0526-tick-jobs-after-delete-and-reextract-after-correction.md) | 穴探し — ADR 0524「測っていないこと」の実測。`tick` 経由の `consolidate`・`reflect` ジョブの消した後の参照と、訂正の経路で負けた記憶がある状態での `reextract`（3者一致。割れは見つからなかった。歯を足した） | 採用 (2026-10) |
| [0527](./0527-consolidate-reflect-created-sources-lowercase.md) | 穴探し — `consolidate`・`reflect` が積む `created` イベントの `meta.sources` を、渡された綴りではなく store の行の id（小文字）で書く | 採用 (2026-10) |
| [0528](./0528-doc-code-drift-sweep-0496-0500-0522-0523.md) | 文書とコードのずれを横に掃く（第3弾）— ADR 0496・0500・0522・0523 と、追い足した 0504・0499・0502・0506・0525・0521・0524 の分の文書を、今の main の実装に照らす | 採用 (2026-10) |
| [0529](./0529-tick-mixed-kinds-concurrency-and-lease.md) | 穴探し — ADR 0526「測っていないこと」の実測。`tick` が種類を混ぜて回るとき・並行する複数の `tick`・リースが切れた後の再取得（Runtime の層。3者一致。割れは見つからなかった。決定的にできる部分だけ歯にした） | 採用 (2026-10) |
| [0530](./0530-batch-exceeds-lease-double-processing-per-kind.md) | 穴探し — 1回の `tick` の2件目の処理中にリースが切れたとき、別の `tick` が再 claim して二重に処理した結末を、種類ごとに3者で実測する（TSDoc どおりで一致。`consolidate` の結末だけ TSDoc に書いていなかったので書いた） | 採用 (2026-10) |
| [0531](./0531-multi-pool-tick-concurrency.md) | 穴探し — 別々の接続プール（複数のプロセスを模す）から同じ DB へ `tick` を撃っても、二重 claim は起きず、リースの CAS は接続をまたいで効く（ADR 0529 の「測っていないこと」の実測。割れは見つからなかった） | 採用 (2026-10) |
| [0532](./0532-tick-job-sources-lowercase.md) | 穴探し — ADR 0527「測っていないこと」の実測。`tick` 経由の `consolidate`・`reflect` ジョブでも、`created` の `meta.sources` は小文字（割れなし。大文字の id がジョブに入る入口は無い。歯を足した） | 採用 (2026-10) |
| [0533](./0533-doc-code-drift-sweep-0526-0527.md) | 文書とコードのずれを横に掃く（第4弾の1回目）— ADR 0526・0527 の分の文書を、今の main の実装に照らす | 採用 (2026-10) |
| [0534](./0534-changelog-reconcile-after-v1-2-0-tag.md) | CHANGELOG と migration-v1 の帳尻 — `v1.2.0` の tag より後に着地した #1615（ADR 0521）・#1616（ADR 0525）の項目を `[1.3.0]` 側へ移し、`[1.3.0]` の冒頭の「まだ何も棚卸ししていない」を直す | 採用 (2026-10) |
| [0535](./0535-doc-code-drift-sweep-0530.md) | 文書とコードのずれを横に掃く（第5弾の1回目）— ADR 0530 の分の文書を、今の main の実装に照らす | 採用 (2026-10) |
| [0536](./0536-parity-inventory-and-activity-clock.md) | 穴探し — 公開メソッドごとの「3者（Fake・InMemory・Postgres）を突き合わせる歯」の棚卸しと、その1つ目（活動時計 `decay_clock = "activity"` の経路。3者一致、割れは見つからなかった） | 採用 (2026-10) |
| [0537](./0537-adr-index-rejects-malformed-adr-filename.md) | ADR 索引の生成器は、番号で始まるのに ADR のファイル名の形から外れた `.md` を、無視せず例外で落とす | 採用 (2026-10) |
| [0538](./0538-retention-and-purge-parity.md) | 穴探し — 保持と掃除の口（`purgeExpiredEventsByRetention`・`purgeExpiredRecalls`・`purgeCompletedJobs`）を3者（Fake・InMemory・Postgres）で突き合わせる。Fake の `events_purged` の `meta` だけ、日時が `Date` のままで割れていた（直した） | 採用 (2026-10) |
| [0539](./0539-claim-key-read-parity.md) | 穴探し — claim key と矛盾の検出の読み口（`findActiveByClaimKey`・`findContestedByClaimKey`・`listActiveClaimPredicates`）と、`observe` の `claimKey` 有効経路を3者（Fake・InMemory・Postgres）に流す歯（3者一致、割れは見つからなかった） | 採用 (2026-10) |
| [0540](./0540-adr-filename-rule-shared-allowlist.md) | ADR のファイル名の規則を生成器と renumber で共有し、`docs/decisions/` の直下の ADR でない `.md` は許す一覧（README.md・TEMPLATE.md）だけにする | 採用 (2026-10) |
| [0541](./0541-embed-job-skips-withdrawn-memory.md) | 埋め込みジョブは、forget・purge した記憶の本文を外部の embedding provider に送らない（オーナーへの問28） | 採用 (2026-10) |
| [0542](./0542-reembed-already-skips-withdrawn-memory.md) | `reembed` は元から forgotten・purge 済みの記憶のジョブを積まない（ADR 0541 の材料1は現物の読み違いだった。割れなし。歯を足した） | 採用 (2026-10) |
| [0543](./0543-inmemory-lone-surrogate-replaced-with-fffd.md) | 孤立サロゲートは、InMemory・Fake も Postgres と同じく U+FFFD に置き換えて保存する（ADR 0423 決定5 の「インメモリは保持」・ADR 0458 の B3 の歯を置き換える） | 採用 (2026-10) |
| [0544](./0544-llm-wait-state-change-contested-skips-three-paths.md) | LLM を待つ間に元の記憶が contested（と訂正で負けた superseded）になったら、reextract・consolidate・reflect の3経路は書かずに打ち切る（ADR 0406 の負債1・ADR 0420 の部分成功・ADR 0454 の負債1・5 を置き換える。往復は変えない） | 採用 (2026-10) |
| [0545](./0545-doc-code-drift-sweep-0517.md) | 文書とコードのずれを横に掃く（第6弾）— ADR 0517・0511・0518 の分の文書を、今の main の実装に照らす | 採用 (2026-10) |
| [0546](./0546-conformance-suite-adds-round31-promises.md) | conformance suite に約束を足す——ADR 0458 の A2・A3・A10・PC6 と、`embed` の重複件数（オーナーの判断が出る前に用意した Draft） | 採用 (2026-10) |
| [0547](./0547-pg-out-of-range-date-reads-clamp-to-floor.md) | Postgres の読みの経路は、`timestamptz` の下限より前の日付を下限に寄せてから比べる（オーナーの推奨 (d)「日付は0件扱い」を「寄せてから比べる」と読み替えた。ADR 0456 の M2 と ADR 0500 の決めたこと2のうち、読みの口の部分を置き換える） | 採用 (2026-10) |
| [0548](./0548-bullmq-lock-duration-and-remove-on-complete-default.md) | `createBullmqTickDriver` に `lockDuration` の口と完了ジョブの保持の既定（`removeOnComplete: { count: 1000 }`）を足す — ADR 0440 の決定4、ADR 0449 の決定5・材料1・材料6 を置き換える | 採用 (2026-10) |
| [0549](./0549-core-fake-cas-rejects-purged-row.md) | core の Fake の CAS（`expectedStatus`）も、purge 済みの行を弾く（InMemory・Postgres と揃える） | 採用 (2026-10) |
| [0550](./0550-doc-code-drift-sweep-0515.md) | 文書とコードのずれを横に掃く（第7弾）— ADR 0515・0516 からの分の文書を、今の main の実装に照らす | 採用 (2026-10) |
| [0551](./0551-compare-counts-output-validation-issues.md) | `compare` の出力に、出力検査（`outputValidation`）の違反件数を集計する（問32 の (C)。ADR 0481 負債#1 の測定側の半分だけを閉じる） | **提案 (2026-10)** |
| [0552](./0552-owner-q7-q8-q16-docs-only.md) | オーナーへの問い 374f6f88 の問7・問8・問16 の推奨（どれも「文書に書くだけ」）を、先行して TSDoc・README に書く（コードは変えない） | 採用 (2026-10) |
| [0553](./0553-lexical-coverage-scale-across-stores.md) | `lexicalMatch`（`LexicalStore` の `coverage`）の尺度を3つの store で測り、式から決まる値と性質だけを歯で縛る（ADR 0484 の負債1。尺度は揃えていない） | 採用 (2026-10) |
| [0554](./0554-language-mismatch-false-positive-measured-by-replay-and-boundary-cases.md) | 言語の事後検査（0490）の偽陽性を、記録の再生と手で作った境界の入力で測る（問24「基準は測ってから」） | **提案 (2026-10)** |
| [0555](./0555-core-fake-outbox-rows-honor-opts-now.md) | core の Fake が積む outbox 行の時刻も、`opts.now` に従う（`availableAt`・`createdAt`。InMemory・Postgres と揃える） | 採用 (2026-10) |
| [0556](./0556-fixtures-uppercase-abort-if-superseded-and-event-get.md) | testkit の InMemory の `abortIfSuperseded` と、testkit・core の Fake の `EventStore.get` も、大文字の id を Postgres と同じに扱う | 採用 (2026-10) |
| [0557](./0557-core-fake-superseded-by-checks.md) | core の Fake も `supersededById` の断り（ADR 0503・0515）を持つ（InMemory・Postgres と揃える） | 採用 (2026-10) |
| [0558](./0558-inmemory-self-supersede-check-folds-both-sides.md) | testkit の InMemory の自己置換の検査は、`supersededById` と対象の id の両側を畳んで比べる | 採用 (2026-10) |
| [0559](./0559-clock-reaches-outbox-available-at.md) | 注入した時計は outbox の `available_at` と監査ログの `at` に届く——古い「届かない」「DB の `now()` で書かれる」記述を、いまの実装に合わせて直す（コメントと doc だけ） | 採用 (2026-10) |
| [0560](./0560-doc-code-drift-sweep-readmes.md) | 文書とコードのずれを横に掃く（第8弾）— README 4つ（ルート・core・openai・local-embedding）を、今の main の実装に照らす | 採用 (2026-10) |
| [0561](./0561-doc-code-drift-sweep-recall-testkit.md) | 文書とコードのずれを横に掃く（第9弾）— `docs/recall.md`・`packages/testkit/README.md`・`docs/north-star-paths.md`・`docs/README.md` を、今の main の実装に照らす | 採用 (2026-10) |
| [0562](./0562-core-fake-isolates-caller-mutation.md) | core の Fake も、呼び手の書き換えから自分の中身を守る（Issue #1412 A8 の9本と、同じ原因の1本） | 採用 (2026-10) |
| [0563](./0563-core-fake-event-time-nul-and-claim-predicates.md) | core の Fake の `archived`・`purgedAt` の時刻、識別子と `lastError` の NUL、片側だけの claim key を、InMemory・Postgres に揃える | 採用 (2026-10) |
| [0564](./0564-core-fake-supersede-atomic-and-new-row-retention-default.md) | core の Fake の `supersedeWithNewMemories` を原子的にし、新しいテナント行の保持期間の既定を Postgres に揃える | 採用 (2026-10) |
| [0566](./0566-fake-outbox-opts-now-controls.md) | ADR 0555 の歯の穴を塞ぐ——Fake の outbox 行の時刻を「やりすぎ」「外す」側からも縛り、0555 の文面のずれを訂正する | 採用 (2026-10) |
| [0567](./0567-doc-code-drift-sweep-scripts.md) | 文書とコードのずれを横に掃く（第10弾）— `scripts/` のコメント・`AGENTS.md`・`docs/autonomy.md` を、今の main の実装に照らす | 採用 (2026-10) |
| [0568](./0568-abort-if-superseded-controls-and-duplicate-id-changed.md) | ADR 0556 の歯が通した4つの変異を塞ぎ、`abortIfSuperseded` の綴り違いの同じ id を Postgres と同じ1件にし、0556 の「新しく断る入力は無い」を訂正する | 採用 (2026-10) |
| [0569](./0569-doc-code-drift-sweep-roadmap-vision-chat.md) | 文書とコードのずれを横に掃く（第11弾）— `docs/roadmap.md`・`docs/vision.md`・`docs/alteroid-findings.md` と `examples/chat` のデモ本体のコメントを、今の main の実装に照らす | 採用 (2026-10) |
| [0570](./0570-chat-cli-output-strings-match-implementation.md) | `examples/chat` の CLI の help と出力の文言を実装に合わせ、数の写しを外す | 採用 (2026-10) |
| [0571](./0571-doc-code-drift-sweep-public-tsdoc.md) | 文書とコードのずれを横に掃く（第12弾）— core を除く公開パッケージの TSDoc を、今の main の実装に照らす | 採用 (2026-10) |
| [0572](./0572-core-fake-supersede-atomic-controls.md) | ADR 0564 の歯の穴（O1・O3・O5・O6）を塞ぎ、ADR 0563 の範囲の記述を訂正する | 採用 (2026-10) |
| [0573](./0573-fake-event-time-nul-claim-controls.md) | ADR 0563 の歯が通した4つの変異（`updatedAt` の時刻・`extractorVersion` の NUL・claim predicate の並び）を塞ぐ | 採用 (2026-10) |
| [0574](./0574-adr-0557-superseded-by-controls.md) | ADR 0557 の歯の穴（やりすぎ・循環の走査・検査の位置）を塞ぐ | 採用 (2026-10) |
| [0575](./0575-outbox-negative-limit-teeth-independent-of-planner-stats.md) | outbox の `eraseTenant`・`claimBatch` の負の `limit` の歯を、プランナの統計によらず reject される入力にする | 採用 (2026-10) |
| [0576](./0576-doc-code-drift-sweep-core-public-tsdoc.md) | 文書とコードのずれを横に掃く（第13弾）— core の公開 TSDoc を、今の main の実装に照らす | 採用 (2026-10) |
| [0577](./0577-fake-supersede-idempotent-resend-skips-opts-checks.md) | Fake の `supersedeWithNewMemories` は、全部の news が既存の行に当たる冪等な再送で opts・jobKinds を断らない（ADR 0566 の未解決を解く） | 採用 (2026-10) |
| [0578](./0578-core-fake-returns-copies-for-remaining-writers.md) | core の Fake の残りの口も、store の行そのものではなく写しを返す（ADR 0562 の未確認の続き） | 採用 (2026-10) |
| [0579](./0579-gate-red-tooth-names-one-db-test-file-instead-of-bail.md) | 門が赤くなる歯は、`--bail=1` で打ち切らず、DB テストのファイルを1本だけ名指しして走らせる | 採用 (2026-10) |
| [0580](./0580-adr-0568-nonexistent-id-and-event-get-controls.md) | ADR 0568 の歯が通した「存在しない id」と「別のイベント id」の変異を塞ぐ | 採用 (2026-10) |
| [0581](./0581-adr-0572-index-underflow-getter-controls.md) | ADR 0572 の歯の穴（A4・B4・C6・B8）を塞ぐ——索引の巻き戻し・float4 アンダーフロー・読む側が行を作らない・setDecayClock の検査順 | 採用 (2026-10) |
| [0582](./0582-adr-0573-teeth-holes-controls.md) | ADR 0573 の歯の穴（updatedAt の同一 ms・UTF-16 順・updatedAt 並び・NUL の「何も書かない」）を塞ぐ | 採用 (2026-10) |
| [0583](./0583-core-fake-supersede-returns-copies-and-per-mouth-mutations.md) | core の Fake の `supersedeWithNewMemories` も写しを返し、ADR 0578 の【未確認】だった口ごとの変異を入れる | 採用 (2026-10) |
| [0584](./0584-adr-0574-teeth-holes-controls.md) | ADR 0574 の歯の穴（外の forgotten と CAS の順・壊れた id と形の違反の順・形の検査の位置）を塞ぐ | 採用 (2026-10) |
| [0585](./0585-digest-band-max-entry-chars-nan.md) | `packDigestBand` の `maxEntryChars: NaN` を、負数と同じ「digest を空に切る」へ倒す | 採用 (2026-10) |
| [0586](./0586-omit-params-cause-chain-and-preread-stack-teeth.md) | `omitParamsFromError` の doc が約束する「`cause` の連鎖にも掛ける」と「`stack` も書き換える」を、偽の例外の歯で縛る | 採用 (2026-10) |
| [0587](./0587-adr-0577-time-stub-mixed-resend-updatedat.md) | ADR 0577 の歯が通した「再送と新規の混在」と「古い記憶の updatedAt」の変異を塞ぎ、壁時計の歯を固定する | 採用 (2026-10) |
| [0588](./0588-adr-0578-teeth-holes-controls.md) | ADR 0578 の歯の穴（生き残り4本と「たまたま捕まった」2本）を、対照の歯で塞ぐ | 採用 (2026-10) |
| [0589](./0589-adr-0552-0553-teeth-holes-controls.md) | ADR 0553 の歯が通した閾値の頭打ち（TR2）と、ADR 0552 の歯が無かった runner の2つの振る舞い（P8・P9）を縛る | 採用 (2026-10) |
| [0590](./0590-adr-0554-language-mismatch-boundary-teeth.md) | 言語の事後検査の規則の境目（4字・20字・3語・直引用符の語）を、すぐ内側と外側の対で縛る（ADR 0554 の歯の穴） | 採用 (2026-10) |
| [0591](./0591-adr-0548-real-redis-teeth-holes.md) | ADR 0548 の実 Redis の歯の穴（頭打ちの件数・失敗したジョブの保持・`lockDuration` の期限）を塞ぐ | 採用 (2026-10) |
| [0592](./0592-adr-0583-0588-merged-pr-recheck-teeth.md) | マージ済みの PR（#1696〜#1699）を確かめ直して見つかった歯の穴を、試験だけで塞ぐ | 採用 (2026-10) |
| [0593](./0593-adr-0576-0580-0582-merged-pr-recheck-teeth.md) | マージ済みの #1688〜#1694 の確かめ直しで見つかった、やりすぎ側の穴4つを塞ぐ（ADR 0576 の TSDoc 2つ・ADR 0580・ADR 0582） | 採用 (2026-10) |

<!-- ADR-INDEX:GENERATED:END -->
