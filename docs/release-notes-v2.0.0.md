# `v2.0.0` の Release 本文（草稿）

**担い手（Claude Code）が CHANGELOG から起こした草稿。オーナーが書いたものではない。載せ方の最終判断と Release の作成はオーナーが行う。**

⛔ **この文書は Release を作る手順ではない。「Release を作るときに GitHub の本文へ貼るテキスト」の草稿である。**

| | |
|---|---|
| **正はどれか** | ⛔ **この草稿ではない。**変更の一覧と根拠の PR/Issue/ADR は [`CHANGELOG.md`](../CHANGELOG.md) の `## [2.0.0]` 節（**`v1.3.0`（`d811241f`）… `07a35b80`** を数えたもの）が正。破壊的変更の定義と移行手順は [`migration-v1.md`](./migration-v1.md) の「🔴 破壊的変更（v1.3.0 → v2.0.0）」「🟡 v1.3.0 → v2.0.0」が正。 |
| **なぜ複製するか** | Release 本文を読むのは repo の外に居る採用者であり、リンクだけでは伝わらない。⟹ 複製を許す代わりに、この表を必ず添える |

🔴 **⛔ この草稿に、`v2.0.0` の変更の総件数を書かないこと**（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。

## 貼る前に確かめること

1. **CHANGELOG `[2.0.0]` 節が数えた範囲の末尾が、まだ `07a35b80` か。**`git log --oneline 07a35b80..origin/main` で当日引き直すこと。この草稿の PR より後に出荷される PR が入っていたら、その分だけ漏れがある。
2. **migration が `0033`・`0034`・`0035` の3本か。**`git diff --name-only v1.3.0 <tag を打つ sha> -- packages/postgres/migrations` で確かめる。
3. **`v1.3.0` より新しい Release が切られていないか。**`gh release list --limit 5`・`git tag -l "v*"`。
4. **CHANGELOG の見出しの日付が、Release を作る日と同じか。**違えば `## [2.0.0] - YYYY-MM-DD` を直してから出す。

## 草稿（ここから下を貼る）

> ## mnemora v2.0.0
>
> この版は **`v1.3.0`** からの差分です。変更の一覧とそれぞれの根拠 PR/Issue/ADR は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[2.0.0]` 節が正です。上げる前に [docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) の「🔴 破壊的変更（v1.3.0 → v2.0.0）」と「🟡 v1.3.0 → v2.0.0」で、自分に当たる項目を確かめてください。
>
> ### 🔴 まず
>
> - **DB マイグレーションが3本あります（`0033`・`0034`・`0035`）。**
>   - `0033`・`0034`: `memories.provenance` の jsonb に `kind` が無い行を拒みます。そういう行が既にある DB では `0034` が失敗します（移行ガイドの項目72）。
>   - `0035`: `memory_events` に列 `seq` を足します（列の追加だけ）。
> - **`recall()` の既定の順位付けが変わります。**型は変わりませんが、同じ問いでも返る記憶が変わりえます。下の「既定が変わったもの」を見てください。
>
> ### ⭐ 既定が変わったもの——使われない記憶は「消える」のではなく「薄れる」
>
> 半年分の時間軸の測定で、既定の `recall()` は、一度も話題に出ない事実を約90日で、その記憶をまっすぐ指す問いにも返さなくなっていました。この版で次のように変えました。
>
> - **時間の方針の既定が `eventAwareFreshness` になりました**（[ADR 0700](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0700-default-time-weighting-event-aware-freshness.md)）。`occurredAt` を持たない恒常的な事実が、記録した時刻の古さで沈まなくなります。従来どおりにするには `timeWeighting: "legacy"`。
> - **時間の重みに下限 0.5 が掛かります**（`RecallQuery.timeWeightFloor`、[ADR 0704](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0704-recall-time-weight-floor.md)）。古い記憶も、関連が強ければ返ります。新しい記憶との競争で、少しずつ上位から外れていきます。従来どおりにするには `timeWeightFloor: 0`。
> - **忘却ゲートを既定では掛けません**（`includeFullyDecayed` の既定が `true`、[ADR 0707](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0707-recall-decay-gate-default-off.md)）。時間だけで記憶を候補から外さなくなります。従来どおりにするには `includeFullyDecayed: false`。掃引（`sweepArchive`）は変わりません。
> - **`claimKey: { detectContested: true }` のとき、既存の述語を claim key の語彙ヒントに渡します**（[ADR 0708](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0708-claim-key-known-predicates-default-with-detect-contested.md)）。実際の LLM で、述語の名前がターンごとに揃わず訂正を見逃していたのが減ります。従来どおりにするには `knownPredicatesFromStore: false`。
>
> ⚠ **`@mnemora/local-embedding` では、時間の重みの下限がほとんど効きません。**無関係な文どうしの類似度も高いためです。何か月も続く会話の記憶を呼び戻したいなら、類似度の差がはっきり出る埋め込み（OpenAI など）を使うか、使った記憶の報告（`observe({ kind: "memory_usage" })`）を配線してください（[`packages/local-embedding/README.md`](https://github.com/takecchi/mnemora/blob/main/packages/local-embedding/README.md)）。
>
> ### 🔴 破壊的変更
>
> - **`@mnemora/postgres` の migration `0033`・`0034` が、`memories.provenance` の jsonb に `kind` が無い行を拒むようになりました**（[ADR 0693](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0693-provenance-kind-must-be-present-in-jsonb.md)）。`PostgresMemoryStore` 経由の書き込みには影響しません。生 SQL で書いていた方だけが当たります。
> - **conformance suite に約束が増えました。**自前の store を実装して `@mnemora/testkit` の suite に当てている方だけが当たります。
>   - 主なもの: 大文字小文字・空白・前方一致・Unicode の正規化形・全角半角だけが違う `tenantId` を別のテナントとして扱うこと、UUID 形式の id の大文字小文字、`claimBatch` の取り直しの `availableAt`、`listLabels` の並び。
>   - どれも TSDoc・ADR に既にあった約束です。同梱の `@mnemora/postgres` と testkit の fixture は、どれも緑です。
>
> 移行の手順は [docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) の「🔴 破壊的変更（v1.3.0 → v2.0.0）」の節を見てください。
>
> ### 新機能
>
> - **応答を実際に返したモデルを、provenance に残すようになりました**（`respondedModel`、[ADR 0701](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0701-provenance-records-responded-model.md)・[ADR 0705](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0705-consolidated-reflected-provenance-model.md)）。`model` は設定した値のまま、確かめられないときは書きません。`LLMProvider` に任意のメソッド `completeStructuredWithMeta` が増えました。`@mnemora/openai`・`@mnemora/anthropic` は応答の `model` を返します。
> - **`MemoryEvent` に記録した順の番号 `seq` が増えました**（[ADR 0702](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0702-memory-event-seq.md)）。複数のプロセスで時計がずれていても、同じ記憶の履歴を `seq` で並べれば遷移の順になります。`forget` のイベントは直前の状態（`meta.previousStatus`）を持ちます。
> - **`TenantSettingsStore` に `setDefaultHalfLifeHours` が増えました**（[ADR 0706](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0706-set-default-half-life-hours.md)）。テナントの既定の半減期を本番の口で設定できます。効くのは呼び出し後に作られる記憶だけです。
>
> ### 修正
>
> - **`@mnemora/postgres` の語彙検索で、クエリ全体の上限（600）の切り口を、書記素の境界に揃えました**（[Issue #1798](https://github.com/takecchi/mnemora/issues/1798)）。境目で孤立サロゲートや割れた書記素が残ることがありました。
>
> ほかの変更の全体は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[2.0.0]` 節を見てください。
