# ADR 0576: 文書とコードのずれを横に掃く（第13弾）— core の公開 TSDoc を、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

ADR 0571（#1683）の続き。今回は `packages/core` の公開 TSDoc（入口 `index.ts` から再 export される型・関数・クラス・メソッド・オプション）を、実装と突き合わせる。コメントだけの PR で、型・振る舞い・公開 API の表面は変えない。

**照合の基準は main `d4306501`。**

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

決まり（前回と同じ）: CHANGELOG の `[1.2.0]` 以前、採用済み ADR の本文、開いている PR・期限待ちの Draft PR が触るファイル、`__tests__` は触らない。TSDoc を実装に合わせて直し、実装のほうを変えるべきものは直さずに材料として残す。日付の付いた追記・訂正の本文は変えず、後ろに訂正を足す。数は写さず、在りかを指す。公開 TSDoc を直したので、CHANGELOG の `[1.3.0]` の Fixed に1項目足した。

## 掃いたもの

「公開」は、`packages/core/src/index.ts` から再 export されるファイルとした。そこから、開いている PR が触るファイルを除いた。

- **interfaces**: `clock`・`embedding-provider`・`event-store`・`llm-provider`・`outbox-store`・`relation-store`・`scheduler`・`tenant-settings-store`・`token-counter`・`vector-store`
- **recall**: `recall`・`recall-runtime`・`recall-footprint`・`recall-output-validation`
- **モデル・抽出・訂正**: `observation`・`memory`・`event`・`extraction`・`claim-key`・`correction-candidates`・`apply-correction`・`digest-band`・`ann-truncation`
- **strategies**: `decay`・`scoring`・`reextract`・`consolidate`・`reflect`
- **その他**: `erase-tenant`・`event-retention-purge`・`heuristic-token-counter`・`clock`・`inline-scheduler`・`ctx`・`identifier`・`abort`・`ids`・`attributes`・`provenance`・`embedding`・`outbox`・`idempotent-create`

除いたもの:

- 開いている PR が触る: `runtime.ts`（#1644・#1654。`RuntimeDeps.clock` の TSDoc は ADR 0559 で直し済み）、`interfaces/memory-store.ts`（#1655）、`interfaces/lexical-store.ts`（#1663）。
- `index.ts` から再 export されない内部のファイル（`attributes-guard`・`validity`・`recall-budget-cut` など）。

観点: 何を返すか、いつ何を投げるか（例外の型）、既定値、時刻の扱い、大文字小文字の扱い、テナントの扱い、参照先（ADR・ファイル・節）の実在、写された数、PR の文脈の文言（「本 PR」など）の残り。

## 直したもの

### interfaces

- **`EventStore.get`・`list`**: UUID 形式の `id`・`filter.memoryId` は大文字小文字を区別しないこと、別のテナントのイベントの `id` は `null` を返すことを足した。【現物】
- **`ClaimOutboxJobsOptions.limit`・`PurgeCompletedJobsOptions.limit`**: 負数・非整数の扱いを「未定義」としていた。Postgres・testkit の fixture の実際の扱い（何も claim せずに例外になる、など）を書いた。`purgeCompletedJobs` で adapter の扱いが割れる点は下の「直さなかったもの」に置いた。【現物】
- **`OutboxStore.complete`**: `opts.at` が Invalid Date のときの例外は、Postgres では `jobId` が UUID の形でないと先に return するので起きない、と注記した。【現物】
- **`Scheduler`**: `@mnemora/bullmq` を「npm には未公開」と書いていた。今は公開済みなので、AGENTS.md の表を指した。【現物】
- **`TaxonomyMode`・`getTaxonomyMode?`**: 「`taxonomy_mode` を読む経路はまだ実装されていない」と書いていた。今は、`labels` か `taxonomyGroups` を指定した `recall()` が読む。本文は変えず、後ろに訂正を足した。interface の doc の追記が指す「上の段落」が今の本文に無いことにも、訂正を足した。migration の行番号の参照は外した。【現物】
- **`TenantSettingsStore.setEventRetention`**: 「`days` の上限は約束しない・testkit は上限なく受け付ける」と書いていた。ADR 0499 で、上限は postgres・testkit が同じ文面の `Error` で断る形になっている。そう直し、`retention.kind` の検査も足した。【現物】
- **`isHalfLifeHoursInRange`**: これを呼ぶ adapter に `packages/postgres` を足した。【現物】
- **`Clock` の doc**: `registered_at` は `labels.registered_at`（`MemoryStore.registerLabel?` が書く）であること、`updated_at` を `TenantSettingsStore` が SQL の `now()` で書くことを、正しい在りかに直した。【現物】
- **`VectorFilter` のクラス doc**: 「後段は `status` と `decayFloorAtAfter` を見ないので、adapter の契約が唯一の防衛線」と書いていた。今は、後段の `survivesStatusGate`（ADR 0432）と `survivesDecayGate`（ADR 0153）がどちらも見る。そう直し、後ろに訂正を足した。【現物】
- **写された数**: 「束ねて呼ぶ4つの口」「4メソッド」「公開ヘルパー9本」「`ProvenanceKind` は5値」「5箇所目」「3実装」などを外した。誤字（「テナット」）も直した。【現物】

### recall

- **`RecallUsage.share`**: 分子を「`digests.join` を1回数えたトークン数」とだけ書いていた。トークン予算が無く `maxMemoryChars` だけのときは文字数で数え、分母も変わる。その場合分けを書いた。`byTier.full`・`digest`・`index` に説明を足した（`full` は今は常に `0`）。【現物】
- **`RecallQuery.text`**: 空白だけの文字列は ZodError にならず、`stage_skipped`（`empty_query_content`）になることを足した。【現物】
- **`RecallQuery.channels`**: 空配列は ZodError になり、省略とは違うことを足した。【現物】
- **`RecallQuery.overFetchFactor`**: k' の式に、`Math.max(1, …)` の下限を足した。【現物】
- **`RecallQuery.relationMaxCount`・`OverLimitOmission`・`RecallResult.omitted`・`DEFAULT_OVER_FETCH_FACTOR`・`DIGEST_BAND_MAX_ENTRY_CHARS`**: 既定値や kind の数の写しを外し、定数を指した。`RecallResult.omitted` では、件数を持たない kind（`ann_truncated` など）の記述漏れを埋めた。`OmissionSchema` の日付付き追記には、本数の数え方についての訂正を後ろに足した。【現物】
- **`RecalledMemory.occurredAt`**: ずれた行番号の参照を外した。【現物】
- **`runRecall`**: `outputValidation: "throw"` で `RecallOutputValidationError` を投げること（記録は済んでいる）、既定が `"report"` であること、「今」は `deps.clock.now()` を1回読んだ値であることを足した。【現物】
- **`recall-footprint.ts`**: モジュールの doc が古い値（`compare` の 162 ターンの割合、`charsPerDigest`）を写していた。数を外し、正本（`compare-baseline.json`・定数）を指した。`FullLogComparison.estimatedShare` の、`fullLogChars <= 0` と NaN の入力のときの値を足した。【現物】

### モデル・抽出・訂正

- **`ExtractedMemoryCandidateSchema.digest`**: 空白だけの digest もフォールバックすることを足した。`confidence` の既定値（省略なら `0.5`）を足した。【現物】
- **`ExtractionOutcome` の `skipped`**: `reextract` が、利用者が退けた記憶を持つ Observation で `skipped` を返す場合を足した。【現物】
- **`DeriveClaimKeysResult.claimKeys`**: 要素が `null` になる条件に NUL を含む場合（ADR 0443）を足した。上限の数の写しは、定数を指す形にした。【現物】
- **`DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT`**: 「ADR 0329 決定2」を決定5に直し、ADR から写していた測定値を外した。【現物】
- **`ApplyCorrectionInput.resolution`**: `supersede` の `winnerId` が両端のどちらとも合わないと、書き込む前に `RangeError` を投げることを足した。【現物】
- **`ApplyCorrectionResult` の `not_a_candidate`**: 照合は大文字小文字を無視し、store の `get` が同じ記憶と言えば候補として扱うことを足した。【現物】
- **写された数・PR の文脈の文言**: `buildKnownSubjectInstruction` などの測定値、`DEFAULT_CORRECTION_CANDIDATE_LIMIT`・`DEFAULT_RECALL_LIMIT` の値の写し、ADR 0232 の測定値、`Memory.decayBaseSeq` のフィクスチャの本数を外した。`MemoryEventKind`・`digest-band.ts`・`Observation.attributes` の「本 PR」などを今の形に直した。【現物】

### strategies・その他

- **`defaultScoringStrategy` の上界の表**: `strength` を「型も DB 列も保証していない」と書いていた。同じファイルの `DEFAULT_STRATEGY_BOUND_ASSUMPTIONS` の doc に揃えた（同梱の実装は書き込み時に拒む。ADR 0078）。`tagMatch` の一致の判定（完全一致で、大文字小文字を区別する。重複は重複して数える）を足した。【現物】
- **`consolidate`・`reflect`**: `digest` の空白だけの扱い、`tags` の空白要素を捨てて重複を除くこと、並びに従う欄を足した（`occurredAt`・`subjectId` は並びに依らない）。`reflect` では「`decayFloorAt` は呼び出し側が渡す」を、`buildReflectedMemory` 自身が計算する、に直した。【現物】
- **`eraseTenant`**: テーブル数の写しを外した。見出しにつながっていた行を分けた。関数と `EraseTenantOutcome` に、`confirmTenantId` の完全一致と `limit` の検査（どちらも書き込む前に `RangeError`）、例外の `params:` 以降を落とすこと、を短く足した。【現物】
- **`PurgeExpiredEventsForTenantOutcome`**: 最初の読みが `days` でも、読み直した結果の `unset`・`unlimited` が返りうることを足した。日付付きの追記の本文は変えず、後ろに訂正を足した。【現物】

## 直さなかったもの

### 実装を変える材料

- **`purgeCompletedJobs` の `limit` が負数のとき、adapter で結果が割れる**: Postgres は `LIMIT limit+1` で渡すので、`-1` は例外にならずに0件、`-2` 以下は Postgres が断る。testkit の fixture は負数をいつも `Error` で断る。Postgres の側で、書く前に検査するのが筋と見る。【現物・判断】
- **`OutboxStore.complete`・`fail` の検査の順**: `jobId` が UUID の形でないとき、Postgres は `opts.at` の Invalid Date の検査より先に return し、fixture は先に例外にする。TSDoc には今の振る舞いを注記した。順を揃えるのはコードの変更である。【現物】
- **`isAbort` の doc の「catch した時点で `signal.aborted` なら、その例外は必ず `abortReason`」**: provider 自身のエラーで reject した後、catch までの間に abort されると成り立たない。狭い競合なので、実装もコメントも変えていない。【現物・判断】
- **`PackDigestBandOptions.maxEntryChars` が NaN**: 切り詰めが起きない（`length > NaN` が偽）。`limit`・`maxChars` の NaN は doc に書いてあるが、これは書いていない。意図かどうかが分からないので残した。【現物】

### doc の付き先

- **`observation.ts` の Issue #280 の `validFrom`/`validUntil` の doc ブロック**: どの宣言にも付いていない（すぐ下の `SubjectCandidatesInput` の前に浮いている）。付け替えは別の回で行う。【現物】
- **`erase-tenant.ts` の大きな doc ブロック**: `eraseTenant` 関数ではなく `EraseTenantMissingStore` 型に付いている。今回は関数に短い TSDoc を足すだけにした。【現物】

### その他

- **範囲の外で見つけたもの**: `interfaces/memory-store.ts` の「計10表」（開いている PR が触る）、非 export の `heuristic-token-counter.ts` の `CJK_RANGES` のコメント、`extraction.ts` の非 export の関数の doc の数、`recall-runtime.ts` の非 export の doc の付き先。触っていない。【現物】
- **出所つきの実測値・日付付きの節の中の数**（`ann-truncation.ts` の ADR 0069 の実測、`BUILTIN_RECALL_FOOTPRINT_PROFILE.origin.measuredFrom`、`DEFAULT_FOOTPRINT_TOLERANCE` の訂正の中の数など）: 当時の測定の記録なので残した。`measuredFrom` は実行時に見える文字列でもある。【判断】
- **`scoring.ts` の版数 `0.1.1`**: 今の `packages/core/package.json` と一致しているので残した。【現物】

## 走らせたもの

- `pnpm --filter @mnemora/core run typecheck`、`pnpm --filter @mnemora/core test`（全件通過）、触ったファイルの eslint と `prettier --check`。【実測】
- `scripts/__tests__/release-candidates-lib.test.mjs`・`check-public-api-surface.test.mjs`（vitest）。通った。【実測】

## 【未確認】

- Postgres を要するテスト、testkit の適合テストは手元で走らせていない。CI に任せる。
- 参照先の ADR・Issue の本文との突き合わせは、実在と見出しまで。
- 突き合わせは下請けの作業者4体が行った。担い手は、差分がコメントの行だけであることを確かめた。

## 残り

- `runtime.ts`・`interfaces/memory-store.ts`・`interfaces/lexical-store.ts` の TSDoc は、それぞれの PR が片づいたあとに掃く。
