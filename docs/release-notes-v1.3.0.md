# `v1.3.0` の Release 本文（草稿）

**担い手（Claude）が CHANGELOG から起こした草稿。オーナーが書いたものではない。載せ方の最終判断と Release の作成はオーナーが行う。**

⛔ **この文書は Release を作る手順ではない。「Release を作るときに GitHub の本文へ貼るテキスト」の草稿である。**

| | |
|---|---|
| **正はどれか** | ⛔ **この草稿ではない。**変更の一覧と根拠の PR/Issue/ADR は [`CHANGELOG.md`](../CHANGELOG.md) の `## [1.3.0] - 2026-10-07` 節（**`v1.2.0`（`d49c46c`）… `d811241f`** を数えたもの）が正。破壊的変更の定義と移行手順は [`migration-v1.md`](./migration-v1.md) の「🔴 破壊的変更（v1.2.0 → v1.3.0）」と「🟡 v1.2.0 → v1.3.0」の節が正 |
| **なぜ複製するか** | Release 本文を読むのは repo の外に居る採用者であり、リンクだけでは伝わらない。⟹ 複製を許す代わりに、この表を必ず添える |

🔴 **⛔ この草稿に、`v1.3.0` の変更の総件数を書かないこと**（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。本文に出る件数は、CHANGELOG / `migration-v1.md` の見出しが自分で名乗っている数だけである。

## 貼る前に確かめること

1. **CHANGELOG `[1.3.0]` 節が数えた範囲の末尾が、まだ `d811241f` か。**`grep -n '追記3' CHANGELOG.md` で当日引き直すこと。動いていたら、動いた分だけこの草稿に漏れがある。
2. **`v1.2.0` から migration が増えていないか。**`git diff --name-only v1.2.0 <tag を打つ sha> -- packages/postgres/migrations` が空であること。
3. **`v1.2.0` より新しい Release が切られていないか。**`gh release list --limit 5`・`git tag -l "v1.*"`。
4. **リンクが生きているか。**`grep -oE '(issues|pull)/[0-9]+' docs/release-notes-v1.3.0.md | sort -u` の各番号を `gh api repos/takecchi/mnemora/issues/<n> -q .number` で、ADR は `docs/decisions/<file>` の実在で確かめる（起こした時点では全部通った）。

## 草稿（ここから下を貼る）

> ## mnemora v1.3.0
>
> この版は **`v1.2.0`** からの差分です。変更の一覧とそれぞれの根拠 PR/Issue/ADR は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.3.0]` 節が正です。**`v1.1.x` 以前から直接この版へ上げる方は**、同じファイルの `[1.2.0]` 節（さらに前からなら、その前の節も）を合わせて読んでください。
>
> ### 🔴 まず
>
> - **DB マイグレーションはありません。**`v1.2.0` から `packages/postgres/migrations/` は増えていません。`v1.1.x` 以前から上げる場合は、`v1.2.0` の Release に書いたマイグレーション（`0026`〜`0032`）と、その注意（`0027` は書き込みを止めてから当てる等）がそのまま当てはまります。
> - **プライバシーに関わる修正があります。**forget・purge した記憶の本文を、それより前に積まれていた埋め込みジョブが外部の embedding provider へ送ることがありました。この版で止まります（[PR #1644](https://github.com/takecchi/mnemora/pull/1644)、[ADR 0541](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0541-embed-job-skips-withdrawn-memory.md)）。
> - **`subjectCandidates` を渡さずに `observe()` している方へ**: LLM が返す `subjectId` を既定で採らなくなりました（下の破壊的変更の先頭）。観察文の注入で、同じテナントの別の subject に記憶を書かせられる経路を閉じるための変更です。
>
> ### 🔴 破壊的変更
>
> CHANGELOG の `### Breaking` の項目ごとに1行で挙げます。多くは「自前の store・provider を実装して `@mnemora/testkit` の conformance suite に当てている方」か「型の外の値・壊れた値を渡していた方」にだけ当たります。
>
> - **`subjectCandidates` を渡さない抽出（`observe()`・`extract: 'deferred'` の `tick`・`reextract`）が、LLM が返した `subjectId` を既定で捨てるようになりました。**主題は `observation.subjectId`（無ければ主題なし）になります。`RuntimeConfig.acceptLlmSubjectIdWithoutCandidates: true` で従来どおり受け取れます（[PR #1737](https://github.com/takecchi/mnemora/pull/1737)、[ADR 0635](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0635-llm-subject-id-dropped-by-default-without-candidates.md)）。
> - **`@mnemora/bullmq` の `createBullmqTickDriver` が、完了したジョブを直近1000件だけ Redis に残すようになりました**（`removeOnComplete: { count: 1000 }` が既定）。完了ジョブの `returnvalue` を後から読んでいた方は、新しいオプション `completedJobsToKeep` で件数を変えられます（[PR #1657](https://github.com/takecchi/mnemora/pull/1657)、[ADR 0548](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0548-bullmq-lock-duration-and-remove-on-complete-default.md)）。
> - **`@mnemora/postgres` の書き込み口が NUL（U+0000）を名指しの `Error` で断り、`resolveContestedGroup?`・`resolveContestedPair?` が型の外の `status` を、purge 済みの記憶への `expectedStatus` 付きの更新を断るようになりました**（[PR #1610](https://github.com/takecchi/mnemora/pull/1610)、[ADR 0499](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0499-store-write-checks-nul-named-status-range-purged-cas-int4-days.md)）。`createObservation`・`createObservationWithOutbox`・`createRecall` の NUL も同様です（[PR #1625](https://github.com/takecchi/mnemora/pull/1625)、[ADR 0505](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0505-seq-sum-overflow-fixture-observation-recall-nul-event-lexical-params.md)）。
> - **`observe()` が、`utterance.text`・`event.name`・`document.content` が空白だけの入力を `ZodError` で断るようになりました**（[PR #1611](https://github.com/takecchi/mnemora/pull/1611)、[ADR 0502](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0502-observe-rejects-whitespace-only-input.md)）。
> - **`MemoryStore` の `resolveContestedPair?`・`resolveContestedGroup?`・`updateStatus`・`updateStatusWithEvent` が、`supersededById` の約束を壊す入力を、書く前に `RangeError` で断るようになりました**（[PR #1621](https://github.com/takecchi/mnemora/pull/1621)・[PR #1648](https://github.com/takecchi/mnemora/pull/1648)、[ADR 0503](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0503-superseded-by-checks-resolve-contested-update-status.md)・[ADR 0515](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0515-superseded-by-remaining-checks.md)）。
> - **`tick` が、`opts.kinds`・`limit`・`claimedBy` の型の外の値と、保存できない巨大な `leaseMs` を、claim する前に断るようになりました**（[PR #1650](https://github.com/takecchi/mnemora/pull/1650)、[ADR 0514](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0514-tick-opts-kinds-limit-claimed-by-and-huge-lease-ms.md)）。
> - **`PostgresOutboxStore.complete`・`fail` が、`opts.at` が Invalid Date か `timestamptz` の下限より前なら、`jobId` の形を見る前に断るようになりました**（[PR #1706](https://github.com/takecchi/mnemora/pull/1706)・[PR #1709](https://github.com/takecchi/mnemora/pull/1709)、[ADR 0594](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0594-postgres-outbox-complete-fail-check-at-before-job-id-shape.md)・[ADR 0597](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0597-outbox-complete-fail-at-below-floor-rejected-and-negative-limit-comment-measured.md)）。
> - **`MemoryStore` の `createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories` が、読み戻すと `MemorySchema` を通らなくなる値を入口で拒むようになりました**（[PR #1740](https://github.com/takecchi/mnemora/pull/1740)、[ADR 0630](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0630-store-rejects-new-memory-that-fails-memory-schema-on-read-back.md)）。
> - **`LocalEmbeddingProvider` が、`retry.attempts` の `Infinity`・`-Infinity` を構築時に `RangeError` で断るようになりました**（[PR #1802](https://github.com/takecchi/mnemora/pull/1802)、[Issue #1785](https://github.com/takecchi/mnemora/issues/1785)）。
> - **conformance suite に約束が増えました**——`abortIfSuperseded`・`abortIfAllConflicted`・`purgeExpiredEventsByRetention`・`findActiveByClaimKey` の半開区間・`EmbeddingProvider.embed` の重複件数（[PR #1658](https://github.com/takecchi/mnemora/pull/1658)、[ADR 0546](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0546-conformance-suite-adds-round31-promises.md)）、`listBySourceObservationAllVersions` が purge 済みの行も返すこと（[PR #1761](https://github.com/takecchi/mnemora/pull/1761)、[ADR 0639](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0639-observe-resend-breakdown.md)）、`eraseTenant`・`deleteAcrossSpaces`・`OutboxStore` の `opts.at`・`scopeAggregate: 'skip'`（[PR #1712](https://github.com/takecchi/mnemora/pull/1712)・[PR #1715](https://github.com/takecchi/mnemora/pull/1715)・[PR #1717](https://github.com/takecchi/mnemora/pull/1717)・[PR #1760](https://github.com/takecchi/mnemora/pull/1760)）。自前の adapter を当てている方だけが影響を受けます。
>
> 移行の手順は [docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) の「🔴 破壊的変更（v1.2.0 → v1.3.0）」の節（項目57〜71）を見てください。
>
> ### 新機能
>
> - **`Runtime.observe` の冪等な再送の戻り値に `resend`（`ObserveResend`）が増えました。**その Observation から作られた記憶の `memoryId`・`status`・`purged` が載ります（[PR #1761](https://github.com/takecchi/mnemora/pull/1761)、[ADR 0639](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0639-observe-resend-breakdown.md)）。
> - **`@mnemora/postgres` に `findCrossTenantReferences` が増えました。**参照先が別テナントの行になっている既存行を、種類ごとに数えて見本を返します。検出だけで、書き換えはしません（[PR #1743](https://github.com/takecchi/mnemora/pull/1743)、[ADR 0636](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0636-cross-tenant-reference-detection-is-read-only.md)）。
> - **`@mnemora/bullmq` の `createBullmqTickDriver` に `lockDuration` と `completedJobsToKeep` が増えました**（[PR #1657](https://github.com/takecchi/mnemora/pull/1657)、[ADR 0548](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0548-bullmq-lock-duration-and-remove-on-complete-default.md)）。
>
> ### 主な修正・挙動が変わるもの
>
> - **forget・purge した記憶の本文を、埋め込みジョブが provider に送らなくなりました**（上の「まず」を参照。[PR #1644](https://github.com/takecchi/mnemora/pull/1644)、[ADR 0541](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0541-embed-job-skips-withdrawn-memory.md)）。
> - **`@mnemora/postgres`：同じラベルを逆の順で触る並行の書き込み（`supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents`・`purgeMemory`・`scrubPurged`）が `deadlock detected`（40P01）で衝突しなくなりました**（[PR #1636](https://github.com/takecchi/mnemora/pull/1636)、[ADR 0511](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0511-label-upsert-cross-memory-and-purge-update-order-deadlocks.md)）。
> - **`@mnemora/postgres`：`runMigrations` に `public` 以外の `extensionSchema` を渡すと、pgvector の能力検査が落ちていたのを直しました**（[PR #1797](https://github.com/takecchi/mnemora/pull/1797)、[Issue #1780](https://github.com/takecchi/mnemora/issues/1780)）。`registerEmbeddingSpace` と同時に走って索引名が衝突したときも、1回だけ流し直すようになりました（[PR #1750](https://github.com/takecchi/mnemora/pull/1750)、[ADR 0638](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0638-run-migrations-reruns-file-once-on-embedding-index-name-race.md)）。
> - **`@mnemora/bullmq`：同じ `queueName` に複数の Worker が居るとき、1台の `stop()` が共有の scheduler を消して他の Worker の tick まで止めていたのを直しました。**消すのは最後の1台だけです（[PR #1741](https://github.com/takecchi/mnemora/pull/1741)、[ADR 0655](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0655-bullmq-stop-removes-scheduler-only-when-last-worker.md)）。
> - **`reextract`・`consolidate`・`reflect` が、LLM を待つ間に元の記憶が `contested` になっていたら、書かずに打ち切るようになりました**（[PR #1654](https://github.com/takecchi/mnemora/pull/1654)、[ADR 0544](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0544-llm-wait-state-change-contested-skips-three-paths.md)）。
> - **purge をかけ直したときの後始末（`scrubPurged`）が、`recalls` の目次帯に残っていた purge 済みの記憶の digest も伏せるようになりました**（[PR #1634](https://github.com/takecchi/mnemora/pull/1634)、[ADR 0512](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0512-scrub-purged-index-band.md)）。
> - **`@mnemora/postgres` の各 store を直接呼んだときの例外の message から、SQL に付けた値（params）を落とすようになりました**（[ADR 0504](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0504-vector-store-omits-params-from-thrown-errors.md)・[ADR 0516](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0516-omit-params-trigram-outbox-tenant-settings-stores.md)）。
>
> ほかの変更・修正の全体は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.3.0]` の `### Changed`・`### Fixed` を、手順は要らないが気づいておくとよい振る舞いの変化は [docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) の「🟡 v1.2.0 → v1.3.0」の節を見てください。`@mnemora/testkit/fixtures` の InMemory 実装は、多くの点で `@mnemora/postgres` の振る舞いに揃いました（テストの期待値が変わることがあります）。
>
> 上げる前に、[docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) で、自分に当たる項目と手順を確かめてください。
