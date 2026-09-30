# 適合テストが何を検証し、何を検証していないか

**この文書は、`@mnemora/testkit` の適合テスト（conformance suite）の
「保証の範囲」と「範囲の外」を1箇所に集める。**

**⭐ 何のために在るか。**適合テストは緑になる。**しかし「何が緑になったのか」は、
suite ごと・呼び出し元ごとに違う。**この文書が無いと、採用する側も次の担い手も、
**緑を実際より広く読む。**

**⚠ この文書は provider の4層（`deterministic` / `recorded` / `openai` / `local`）を
説明しない。**それは [AGENTS.md](../AGENTS.md)「いまの状態」の表が正文である。
**複製した瞬間から、正文と要約はずれ始める**——ここでは**指すだけ**にする。

**根拠の種別**: **【現物】** = `main` = `18a8a09`（2026-09-17）のコードを読んで数えた。
**【実測】** = 書き手がこの器で実際に走らせた、または取得した。

**⚠ 2026-09-25 追記（Issue #449 / ADR 0305）**: `EmbeddingProvider` suite に
`overLimitText`（任意。省略時 `it.skip`）に依存する歯を1本足した。**この節の数のうち
`EmbeddingProvider` に関わるものだけを、その分だけ更新してある**（下の該当箇所に
逐語で印を付けた）。**他の6 suite の数はこの追記の対象外**——数えていない。

**⚠ 2026-09-26 追記（`v1.0.1`、Issue #389 /
[ADR 0266](./decisions/0266-llm-provider-conformance.md)）**: 下の「`LLMProvider` の適合
suite は、存在しない」はもう成り立たない。`describeLLMProviderConformance` を新設し、
`@mnemora/openai`・`@mnemora/anthropic` の両方に当てた。**この節の数のうち `LLMProvider` に
関わるものだけを、その分だけ更新してある**（§1・§2.3・§8）。**他の6 suite・他の節の数は
この追記の対象外**——2026-09-17（または2026-09-25）時点の値のままである。

**⚠ 2026-09-29 追記（Issue #1238 /
[ADR 0372](./decisions/0372-conformance-suite-issue-1238-promises.md)）**:
`MemoryStore`・`VectorStore`・`EventStore` の3 suite に、次の7つの約束を検査する歯を
足した——`supersedeWithNewMemories` の途中失敗のロールバック・区切り文字（`:`・`::`）を
含む値の非衝突（冪等キー・ベクトルのキー・ラベル）・2テナント並行での取り違え・
`onlyMemoryIds`/preview の形式不正 id・未強化の記憶への reinforce の起点・
`listActiveClaimPredicates` の片方欠落 claim key・`EventStore.append` の `meta`/`actor`
（core が入れる形だけ）の往復。**住所・呼び出し元の一覧（§1・§2.1）に変更は無い**
（新しい suite・新しい呼び出し元を足したのではなく、既存3 suite の中身が増えただけ）。
**この節の数（it の宣言数）はどこにも書いていないので、この追記でも数えていない**
（§1 の数え方の式で数えること）。Issue #1238 が棚卸しした残りの候補（A2・A8・A10〜A15、
PR #1296 のコメント1・2）は、この追記の対象外——足すかどうかは決めていない
（ADR 0372「決めたこと」3）。

**⚠ 2026-09-29 追記（Issue #1412（Issue #1238 棚卸しの続き）/
[ADR 0373](./decisions/0373-conformance-suite-issue-1412-promises.md)）**:
直前の追記が「対象外」とした残りの候補のうち、A8（渡した入力・返した値が store の中と
切り離されていること。`MemoryStore`・`VectorStore`・`EventStore`・`OutboxStore` の
4 suite だけ——`LexicalStore`・`TenantSettingsStore` は切り離すべき参照そのものを
持たないため外した）・A10（`events_purged` の `meta` の日時3欄が ISO 8601 の文字列で
あること）・A11（`getRecall` の `query` が JSON を通る欄のまま読み戻ること）と、
PR #1296 棚卸しのコメント1（`resolveOrphanedContested?` の CAS 違反で
`MemoryStatusConflictError`）・コメント2（`ContestedWithoutCompanionError`/
`MemoryStatusConflictError`/`MemoryPurgeConflictError` の型付きフィールドの値）を
`MemoryStore`・`VectorStore`・`EventStore`・`OutboxStore` に足した。**住所・呼び出し元の
一覧（§1・§2.1）に変更は無い**（既存4 suite の中身が増えただけ）。**新しい任意の
適合フラグが1本増えた**（`MemoryStoreConformanceOptions.supportsResolveOrphanedContested?`
——§9 参照）。**この節の数（it の宣言数）はどこにも書いていないので、この追記でも
数えていない。**A12（`purgeExpiredEvents` の並行の正しさ）は、この追記の対象外——
conformance suite の外から adapter の中に遅延を差し込めず、赤くなりうる歯を書けない
（Issue #1412 のコメント）。

---

## 1. 何が在るか — 8 suite（⚠ 2026-09-30 追記で9になった。下の追記を見ること）

| suite                 | 住所                                                        |
| --------------------- | ----------------------------------------------------------- |
| `EmbeddingProvider`   | `packages/testkit/src/embedding-provider-conformance.ts`    |
| `EventStore`          | `packages/testkit/src/event-store-conformance.ts`           |
| `LexicalStore`        | `packages/testkit/src/lexical-store-conformance.ts`         |
| `LLMProvider`         | `packages/testkit/src/llm-provider-conformance.ts`          |
| `MemoryStore`         | `packages/testkit/src/memory-store-conformance.ts`          |
| `OutboxStore`         | `packages/testkit/src/outbox-store-conformance.ts`          |
| `TenantSettingsStore` | `packages/testkit/src/tenant-settings-store-conformance.ts` |
| `VectorStore`         | `packages/testkit/src/vector-store-conformance.ts`          |

### `RelationStore` の適合 suite —— 2026-09-30 追記（Issue #207/#933 PR2、[ADR 0381](./decisions/0381-contested-group-write-path-implementation.md)）: 新設された（旧: 存在しなかった）

`packages/testkit/src/relation-store-conformance.ts` に `describeRelationStoreConformance` が
新設された（`link`/`unlink`/`listRelated` の基本契約・冪等性・双方向・テナント
分離を検査する）。

**⚠ 2026-09-30 追記**: この節には、以前は it の数（9）を手で書いていた。現物は12本で食い違っていたので、数を消して出所（`packages/testkit/src/relation-store-conformance.ts`）を指す形にした。数えるなら上の§1の式を当てること（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。
`packages/testkit`
（`in-memory-fixtures.conformance.test.ts`）・`@mnemora/postgres`
（`conformance.postgres.test.ts`）の両方が当てている——**8 suite → 9 suite になった。**

同じ PR で、既存の `MemoryStore` suite（`describeMemoryStoreConformance`）にも、
`markContestedGroup?`/`resolveContestedGroup?`（任意メソッド、`supportsMarkContestedGroup?`/
`supportsResolveContestedGroup?` の3態フラグで「検査した」「検査していない」を区別する、
§9 と同じ形）の it を追加した——**新設 suite ではなく既存 suite の it 数が増えただけ**
（この節の「新設された suite」の一覧には含めない、上の §1 「`it` の数はここに書かない」の
規律どおり）。

**⚠ マイクロ秒精度の境目は、この suite の外（Postgres 専用の別ファイル）で確かめている。**
JS の `Date` はミリ秒までしか精度を持たず、アプリの書き込み経路（`createMemory` 等）は
すべてミリ秒精度に丸めるため、InMemory/Fake fixture はマイクロ秒だけ異なる `validFrom`/
`validUntil` を原理的に表現できない——**適合テストとして両実装を同じ入力で当てることが
できない範囲である。**
`packages/postgres/src/__tests__/mark-contested-group-microsecond-boundary.postgres.test.ts`
が、生の SQL で Postgres だけにマイクロ秒精度の境目を作り、Postgres 単独でその正しさ
（**Postgres が正**）を確かめる——`describeMemoryStoreConformance`/`describeRelationStoreConformance`
のどちらの呼び出し元にも数えない、Postgres 専用の歯である。

**各 suite の `it` の数は、ここに書かない**（`main` が動けば変わる数である——
[AGENTS.md](../AGENTS.md)「⚠ 数を、道具と生成物に焼き込まない」・
[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。repo の根で次を打って数える:

```sh
grep -cE '^\s*(it|maybe[A-Za-z]*It)(\.[a-zA-Z]+(\([^)]*\))?)?\(' packages/testkit/src/*-conformance.ts
```

- 数えるのは、行の頭で始まる `it(`・`it.skip(`・`it.skipIf(…)(`・`it.each(…)(` と、`it`/`it.skip` を選んで
  置いた別名（`maybeIt`・`maybeDeterministicIt`・`maybeFailingIt`・`maybeConcurrentIt`・`maybeOverLimitIt`）の呼び出しである。
- ⚠ **宣言の行の数であって、走る歯の数ではない。**`it.each` の1行は渡した値の数だけ歯を生む。別名は
  呼び出し元の設定で skip になる。呼び出し元ごとに実際に走った数は、その呼び出し元のテストを走らせて見る（§2）。
- 別名が増えたら、この式の `maybe[A-Za-z]*It` に当たらない名前でないかを確かめること。

**⚠ 2026-09-27 追記**: この節の表には、以前は suite ごとの `it` の数と合計（297）を手で書いていた。
上の 2026-09-25・2026-09-26 の追記が更新した `EmbeddingProvider`（10）・`LLMProvider`（8）の2行を除く6行は、
2026-09-17 の値のまま腐っていた——上の式で main `6df673d` に当てると、`LexicalStore` 21→27・`MemoryStore` 177→262・
`OutboxStore` 15→16・`TenantSettingsStore` 17→23・`VectorStore` 33→40（`EventStore` は16のまま）、合計は402だった。
門で生成・照合している数ではなかったので、数を消して数え方の式に置き換えた。上の追記が「印を付けた」と書く
表の中の箇所は、もう無い（元の値は git の履歴に在る）。

### `LLMProvider` の適合 suite —— 2026-09-26 追記: 新設された（旧: 存在しなかった）

**⚠ 以前この節は「`describeLLMProviderConformance` は0件、`llm-provider-conformance.ts` は
無い」と書いていた。それは `v1.0.0` 時点では正しかったが、`v1.0.1`（Issue #389 /
[ADR 0266](./decisions/0266-llm-provider-conformance.md)、PR #603）でもう成り立たなくなった。**

`packages/testkit/src/llm-provider-conformance.ts` に `describeLLMProviderConformance` が在り、
it を持つ（本数と内訳はここに書かない——出所は `packages/testkit/src/llm-provider-conformance.ts`。数えるなら §1 と同じ式で数えること。下の「⚠ 2026-09-30 追記」を見ること）。
`@mnemora/openai`（`packages/openai/src/__tests__/llm-provider.conformance.test.ts`）・
`@mnemora/anthropic`（`packages/anthropic/src/__tests__/llm-provider.conformance.test.ts`）の
両方が当てている——**詳細と「何を測っていないか」は §2.3**。

**⚠ 2026-09-30 追記**: この節には、以前は it の数と内訳（「8 it（条項1: ベンダー型が漏れない検査2本／決定性2本／失敗伝播とリトライ非内蔵4本）」）を手で書いていた。数え直すと一致していた（素の `it(` 2 ＋ `maybeDeterministicIt(`/`maybeFailingIt(` 6 の宣言の行の合計）が、門で照合している数ではないので、数と内訳を消して出所（`packages/testkit/src/llm-provider-conformance.ts`）を指す形にした（元の値は git の履歴に在る）。§2.3 の「8 it は skip なく全部走る」も同じ理由で本数を外した（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。

両実装が同じ契約に従うことは `packages/anthropic/src/__tests__/provider-parity.test.ts`
も見ているが、**それは2実装を突き合わせる歯であって、契約そのものの歯ではない**——
こちらは今も有効な区別である。

---

## 2. どの実装に、実際に当たっているか【現物】

### 2.1 store 系6 suite

**当たっている先は2つだけである。**

| 呼び出し元                                                                                                                                                                                                                                                                                                                                   | 当たる実装                                          | CI で走るか                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts` の6つの `describe*Conformance({` 呼び出し（`describeMemoryStoreConformance` / `describeVectorStoreConformance` / `describeLexicalStoreConformance` / `describeEventStoreConformance` / `describeOutboxStoreConformance` / `describeTenantSettingsStoreConformance`） | in-memory の擬似物（`__fixtures__/in-memory-*.ts`） | **走る**（常時）                                                          |
| `packages/postgres/src/__tests__/conformance.postgres.test.ts` の6つの `describe*Conformance({` 呼び出し（`describeMemoryStoreConformance` / `describeEventStoreConformance` / `describeVectorStoreConformance` / `describeLexicalStoreConformance` / `describeOutboxStoreConformance` / `describeTenantSettingsStoreConformance`）          | **本物の Postgres + pgvector**                      | **走る**（`DATABASE_URL` 必須。無いと fail する——擬似物へ黙って倒れない） |

**⚠ 2026-09-28 追記（文書と実装の照合、main c80b1a2）**: 上の「当たっている先は2つだけ」は、もう成り立たない。上の表の2つのほかに、次の呼び出し元が store 系の suite を呼んでいる。

- `packages/postgres/src/__tests__/trigram-lexical-store.conformance.postgres.test.ts` の `describeLexicalStoreConformance({`——**本物の Postgres** 上の `PostgresTrigramLexicalStore`（opt-in の語彙 store）に当たる。`DATABASE_URL` 必須。
- `packages/testkit/src/__tests__/memory-store-conformance.supports-labels-and-claim-key-optional.test.ts` の2つと `tenant-settings-store-conformance.supports-taxonomy-mode-optional.test.ts` の2つ——任意フラグを省略した呼び出しの形を確かめるための、テストの中で組み立てた store に当たる。
- `packages/testkit/src/__tests__/migration-guide-tenant-settings-example.test.ts`——`docs/migration-v1.md` §6 の片をそのまま実行し、必須の3口だけを持つ最小の `TenantSettingsStore` に当たる。

⟹ **本物の DB に当たるのは Postgres の2つのファイル（上の表の2行目と trigram の1つ）である。**それ以外は in-memory の擬似物か、テストの中で組み立てた store である。上の本文は当時の記録として残す。

**⚠ 2026-09-30 追記（Issue #207/#933 PR2、[ADR 0381](./decisions/0381-contested-group-write-path-implementation.md)）**: 上の表の2つの呼び出し元（`in-memory-fixtures.conformance.test.ts`・`conformance.postgres.test.ts`）は、`describeRelationStoreConformance({` も1つずつ追加で呼ぶようになった——「6つの `describe*Conformance({` 呼び出し」はどちらの行も7つになった。当たる実装・CI で走るかは変わらない（in-memory の擬似物／本物の Postgres、どちらも常時走る）。

### 2.2 `EmbeddingProvider` suite — 呼び出し元（下の表と、その後の 2026-09-28 追記。表は 2026-09-25 追記で6→7）

| #   | 呼び出し元                                                                                                                        | 当たる実装                                                                                                                                               | CI で走るか     |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | `packages/testkit/src/__tests__/embedding-provider-fixtures.conformance.test.ts` の1つ目の `describeEmbeddingProviderConformance({` | `DeterministicEmbeddingProvider`                                                                                                                         | **走る**        |
| 2   | 同上の2つ目                                                                                                                       | `RecordedEmbeddingProvider`（**テスト内で合成したカセット**。実 API の記録ではない）                                                                     | **走る**        |
| 3   | `packages/local-embedding/src/__tests__/local-embedding-provider.conformance.test.ts` の `describeEmbeddingProviderConformance({` | `LocalEmbeddingProvider` ＋ 注入した replay pipeline（`fixtures/real-ruri-embeddings.json` = **本物の推論を1回録ったもの**。重みは落とさない）           | **走る**        |
| 4   | `packages/local-embedding/src/__tests__/live.local-embedding.test.ts` の `describeEmbeddingProviderConformance({`                 | **本物の `LocalEmbeddingProvider`**（実際に ONNX の重みを落としてプロセス内推論）                                                                        | 🔴 **走らない** |
| 5   | `packages/openai/src/__tests__/embedding-provider.conformance.test.ts` の `describeEmbeddingProviderConformance({`                | `OpenAIEmbeddingProvider` ＋ 注入 client（`fixtures/recorded-openai-embeddings.json` の再生）                                                            | **走る**        |
| 6   | `packages/openai/src/__tests__/live.openai.test.ts` の `describeEmbeddingProviderConformance({`                                   | **実 API**                                                                                                                                               | 🔴 **走らない** |
| 7   | `packages/testkit/src/__tests__/embedding-provider-conformance-over-limit.test.ts`（2026-09-25 追記、Issue #449 / ADR 0305）      | この歯専用の最小 provider（`RejectsOverLimitEmbeddingProvider`。**本物のモデルではない**——`overLimitText` の歯が実際に何かを検出することを示す陽性対照） | **走る**        |

⚠ **#1・#2・#7 はどれも `overLimitText` を渡していない/渡している、が食い違う——** #1・#2 は
省略（上限の概念を持たない実装のため `it.skip`）、**#7 だけが渡している**（この歯専用の
provider だから）。**#3・#5（replay/fixture 系）と #4・#6（live 系）も、この追記の時点では
`overLimitText` を渡していない**（省略。理由は各ファイルのコメントを見ること——
replay/fixture 系は上限を無効化した表引きであり、渡しても「記録に無い入力」という別の
理由で reject するだけで上限検査そのものを測ったことにならない。live 系は本物の上限判定に
当たるが、正しい「上限を超える文字列」を実測なしに用意するリスクを取らなかった、
`docs/decisions/`（Issue #449 対応 ADR）参照）。

⟹ **7箇所のうち「本物に当たる」のは #4 と #6 の2つだけで、その2つが走っていない。**
（#7 は「本物に当たる」ではなく、この歯専用の擬似 provider に当たる——上の注記参照。）

**⚠ 2026-09-28 追記（文書と実装の照合）**: 上の表は、その後に足された呼び出し元を写していない。
次の4つも `describeEmbeddingProviderConformance` を呼んでいる。どれも env の gate を持たず、
`deterministic: true` を渡し、`overLimitText` は渡していない。包まれる側はどれも
`DeterministicEmbeddingProvider` である。

- `packages/testkit/src/__tests__/wrapper-providers.conformance.test.ts` の2つ（`SeededEmbeddingProvider`・`RecordingEmbeddingProvider`）
- `examples/chat/src/__tests__/wrapper-providers.conformance.test.ts` の2つ（`CountingEmbeddingProvider`・`CachingEmbeddingProvider`）

⟹ **どれも本物には当たらない。**「本物に当たるのは #4 と #6 だけで、その2つが走っていない」は変わらない。

### 2.3 `LLMProvider` suite — 呼び出し元（下の表と、その後の 2026-09-28 追記）【2026-09-26 追記、新設】

| # | 呼び出し元 | 当たる実装 | CI で走るか |
| - | --- | --- | --- |
| 1 | `packages/openai/src/__tests__/llm-provider.conformance.test.ts` | `OpenAILLMProvider` ＋ 注入した偽 client（固定応答。**本物の `openai` SDK ではない**） | **走る**（常時） |
| 2 | `packages/anthropic/src/__tests__/llm-provider.conformance.test.ts` | `AnthropicLLMProvider` ＋ 注入した偽 client（固定応答。**本物の `@anthropic-ai/sdk` ではない**） | **走る**（常時） |

**両方とも `deterministic: true`・`createFailing` を渡しており、この suite の it は skip なく全部走る**
【現物: 両ファイルの `describeLLMProviderConformance({` 呼び出し】。⟹ **本物の実 API に
当たる `LLMProvider` 適合テストは、この suite にも無い**——測っているのは「core の契約
（ベンダー型を漏らさない・例外を同一性のまま伝播する・リトライを内蔵しない）を、
各 provider の変換ロジックが守っているか」であって、HTTP・認証・レート制限・実 API
自身の決定性ではない（各テストファイル冒頭のコメントが逐語で同じ限界を書いている）。
`deterministic: true` を支えているのは偽 client の固定応答であって、実 API の決定性を
実測した結果ではない——§4 の区別と同じ形。

**⚠ 2026-09-28 追記（文書と実装の照合）**: 上の表の2つのほかにも、`describeLLMProviderConformance` の
呼び出し元がある。どれも env の gate を持たず、`deterministic: true` を渡している。

- `packages/testkit/src/__tests__/llm-provider-conformance.test.ts` の2つ（`DeterministicLLMProvider`・`RecordedLLMProvider`）。
  **`createFailing: null` を渡すので、失敗系の歯は `it.skip` になる**（名前は残る。同ファイル冒頭のコメント）。
  上の「この suite の it は skip なく全部走る」は、表の2つについての記述である。
- `packages/testkit/src/__tests__/wrapper-providers.conformance.test.ts` の2つ（`SeededLLMProvider`・`RecordingLLMProvider`）と、
  `examples/chat/src/__tests__/wrapper-providers.conformance.test.ts` の1つ（`CountingLLMProvider`）。
  包まれる側は `DeterministicLLMProvider`、`createFailing` は必ず失敗する包まれる側を渡している。

⟹ **どれも実 API には当たらない。**「本物の実 API に当たる `LLMProvider` 適合テストは、この suite にも無い」は変わらない。

---

## 3. 🔴 構造的に一度も走らない歯 — ファイルは下の表【現物】

**数え方**: 「CI のいまの構成では、どんな入力でも通過しない `it`」を **it 単位**で数える。

| ファイル                                                                           | 必要な env                                            | it                                                     |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `packages/anthropic/src/__tests__/live.anthropic.test.ts`                          | `ANTHROPIC_API_KEY` **かつ** `MNEMORA_LIVE_ANTHROPIC` | 直下の it                                              |
| `packages/openai/src/__tests__/live.openai.test.ts`                                | `OPENAI_API_KEY` **かつ** `MNEMORA_LIVE_OPENAI`       | 直下の it ＋ `EmbeddingProvider` suite の it           |
| `packages/local-embedding/src/__tests__/live.local-embedding.test.ts`              | `MNEMORA_LIVE_LOCAL_EMBEDDING`                        | 直下の it ＋ `EmbeddingProvider` suite の it           |
| `packages/local-embedding/src/__tests__/live.cache-warm-network-behaviour.test.ts` | `MNEMORA_LIVE_LOCAL_EMBEDDING`                        | 直下の it                                              |

**本数はここに書かない**（`main` が動けば変わる数である——[AGENTS.md](../AGENTS.md)「⚠ 数を、道具と生成物に焼き込まない」）。repo の根で、§1 と同じ式で数える:

```sh
# 直下の it（ファイルごと）
grep -cE '^\s*(it|maybe[A-Za-z]*It)(\.[a-zA-Z]+(\([^)]*\))?)?\(' packages/anthropic/src/__tests__/live.anthropic.test.ts packages/openai/src/__tests__/live.openai.test.ts packages/local-embedding/src/__tests__/live.local-embedding.test.ts packages/local-embedding/src/__tests__/live.cache-warm-network-behaviour.test.ts
# openai と local-embedding の live が1回ずつ呼ぶ EmbeddingProvider suite の it
grep -cE '^\s*(it|maybe[A-Za-z]*It)(\.[a-zA-Z]+(\([^)]*\))?)?\(' packages/testkit/src/embedding-provider-conformance.ts
```

⚠ §1 と同じく**宣言の行の数**である。suite の側の `maybe*It` は、gate が開いた後でも呼び出し元の設定で skip になりうる（下の「無条件7本」）。

**⚠ 2026-09-28 追記**: この表には、以前は it の数（2・12・15・1、合計30）を手で書いていた。main `c80b1a2` で上の式を打つと同じ数だったが、門で照合している数ではないので、数を消して数え方に置き換えた（元の値は git の履歴に在る）。

**`.github/workflows/ci.yml` に、この4つの env は設定値として1つも無い**【現物】
（`grep` で出るのはコメント中の言及だけである）。

**⚠ これは「意図された設計」である。**鍵が在る環境で全体の門を走らせると黙って課金される
（[ADR 0019](./decisions/0019-real-openai-measurement-cost.md) §5c は、**その事故が
実際に踏まれた**ことを記録している）。二重 opt-in は、その再発を防ぐためにある。
**⟹ 直すべき欠陥ではない。読み違えるべきでない事実である。**

### ⚠ 読み違えやすいところ — 「無条件7本」は無条件ではない

[Issue #142](https://github.com/takecchi/mnemora/issues/142) は
「**無条件7本**が緑かを見る」と書いている。**これは「env が無くても走る7本」ではない。**

`packages/openai/src/__tests__/live.openai.test.ts` の **it はすべて `live` gate の下に在る**
【現物: 直下の it はどれも `it.skipIf(!live)`、適合テストは `describe.skipIf(!live)` の中。
`live` の定義は同ファイルの `const live =`】。

**「無条件7本」の正しい意味**: _gate が開いた後_、適合テスト10本のうち
**決定性に依存する2本**（`maybeIt`。`deterministic: false` のとき自動で `it.skip` になる）と
**`overLimitText` に依存する1本**（2026-09-25 追記。この呼び出しは `overLimitText` を
渡していないので自動で `it.skip` になる——理由は §2.2 の注記参照）を
除いた7本、という意味である。⟹ **数そのもの（7）は変わらない**——3本を除く形に
変わっただけである。**gate 自体は一度も開いていない。**

---

## 4. 🔴 `deterministic: false` は「測って非決定的だった」ではない

| 呼び出し口                                     | `deterministic` | 根拠                                                                                                                                        |
| ---------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `LocalEmbeddingProvider`（本物のモデル、live） | `true`          | ⭐ **実測**（768成分を要素ごとに比較して不一致0件・最大絶対差0）                                                                            |
| `OpenAIEmbeddingProvider`（**実 API**、live）  | `false`         | ❌ **実測ではない。**「実 API の再現性の保証を持っていない」という*理由*で `false` にしただけで、**実際に非決定的かどうかは測っていない。** |

> **追記（2026-09-25、Issue #142 ①）—— 上の表の2行目は、実 API で測った**
> （[ADR 0330](./decisions/0330-openai-embedding-live-conformance-and-determinism-measured.md)）。
> **単独入力は測った範囲でずれなかったが、3件バッチ `[a,b,c]`（決定性の歯が使う形）は
> 同じ入力で別のベクトルが返った**（最大絶対差 2.44e-4）。⟹ live の `false` は、
> 3件バッチについては「測って非決定的だった」と書ける。宣言値は変えていない。
> 同じ run で、無条件7本は緑だった。

⟹ **この2つの `false` を同じものとして読まないこと。**
ADR 0095 §7 が逐語でこう書いている:

> **実 API の埋め込みが決定的かを測っていない**（3.1 の根拠は「保証を持っていない」であり、
> 「非決定的だと実測した」ではない）。

---

## 5. ⭐ 適合テストは「実際にどのモデルを読み込んでいるか」を見ていない

**`space` は `(provider, model, dimensions)` という宣言であって、読み込んだ重みの素性ではない。**
`LocalEmbeddingProvider` のコンストラクタは
`model: options.modelId ?? DEFAULT_LOCAL_EMBEDDING_MODEL_ID` を `space` に入れるだけで、
**実際に読み込んだモデルから導出していない**【現物:
`packages/local-embedding/src/local-embedding-provider.ts` の `DEFAULT_LOCAL_EMBEDDING_REPO`・
`DEFAULT_LOCAL_EMBEDDING_MODEL_ID`】。

**ADR 0099 の変異試験の陰性対照がこれを名指しした**（逐語）:

> 🔴 **適合テストは「どのモデルを実際に読み込んでいるか」を見ていない。**変異試験の
> 陰性対照でこれを確認した——`DEFAULT_LOCAL_EMBEDDING_REPO` をまったく別の repo 文字列に
> 変えても、適合テスト11本は**全部緑のまま**だった。（中略）**この穴は塞いでいない。**

### なぜ効くか

`EmbeddingSpaceId` は**テーブル名スラグの導出元**である（`docs/memory-model.md`）。
`space.model` が同じまま実際のモデルだけが入れ替わると、
**別のモデルのベクトルが同じ space のテーブルへ混ざる。**
混ざったことは検索結果が少し悪くなる形でしか現れず、**後から分けられない。**

### 🔴 ⭐ config のメタデータを照合する「弱い版」では塞げない【実測】2026-09-17

**「読み込んだモデルの `config.json` を見て素性を assert すればよい」は、効かない。**

`sirasagi62/ruri-v3-30m-ONNX` の `config.json` を実際に取得して確かめた:

```json
{
  "_name_or_path": "cl-nagoya/ruri-v3-30m",
  "architectures": ["ModernBertModel"],
  "model_type": "modernbert",
  "hidden_size": 256
}
```

⟹ 🔴 **`_name_or_path` は ONNX の変換「元」（`cl-nagoya/ruri-v3-30m`）を指しており、
実際に読み込んだ repo id（`sirasagi62/ruri-v3-30m-ONNX`）ではない。**
⟹ **同じ変換元から作られた別の ONNX repo に差し替えられても、この値では区別できない。**

⚠ **これは Issue #142 の本文にも、コード内のコメントにも書かれていなかった。**
**この文書が初出である。**⟹ **次に「config を見れば済むのでは」と考えた人が、
同じ調査を繰り返さずに済むように、ここに残す。**

**補足**【現物】: `@huggingface/transformers` の実装は `config.json` の全フィールドを
実行時にそのまま載せるが（`src/configs.js`）、**「実際に渡した repo 引数」を
明示的に設定してはいない。**そして `packages/local-embedding/src/pipeline.ts` の
`LocalEmbeddingExtractor` interface は `.model` を**意図的に含めていない**
（`@huggingface/transformers` の型を公開の型に出さないため。同ファイルの `LocalEmbeddingTokenizer` の doc コメント、逐語「**`@huggingface/transformers` の型をそのまま公開の型に出さない**」）。
⟹ **ライブラリ層には手段が在るが、このパッケージの抽象境界がそれを捨てている。**

### ⭐ 「強い版」の材料は、既に揃っている

`packages/local-embedding/src/__tests__/fixtures/real-ruri-embeddings.json` に
**本物の推論値が既に在る**（`provenance.determinismCheck` 付き）。
**しかしこれを使っているのは replay の適合テスト（上の #3、重みを落とさない）だけで、
本物の onnxruntime を通す唯一のテスト（`live.local-embedding.test.ts`）は、
次元数と類似度の大小しか見ておらず、値そのものを照合していない**【現物】。

⟹ **「同じ入力 → 同じ成分」の突合を足せば、repo / 量子化 / 変換の違いをほぼ確実に検出できる。
材料の追加は要らない。**

**⛔ ただし、いまは足していない。**Issue #142 自身がこう書いている（逐語）:

> ⛔ **どれを採るかは、まず「この穴が実際に踏まれうるか」を測ってから決めるべきである**
> （`repo` を差し替える運用が実在するのか）。⛔ 測る前に歯を足さないこと。

**⟹ この文書は穴を記録するところまでで止める**（Issue #142 の案(う)）。

### ⚠ 2026-09-27 追記: テキストとベクトルの対応も見ていない（[Issue #1000](https://github.com/takecchi/mnemora/issues/1000)）

`describeEmbeddingProviderConformance` の項目は、形（space・件数・次元・有限）、同じ入力なら同じ値、
1回の呼び出しの中の順序の対応、上限を超える入力を見る。**「別のテキストには別のベクトルが返る」
「どのテキストにどのベクトルが返るか」を見る項目は無い。**
⟹ **テキストとベクトルの対応を一貫して壊す実装は、全項目を通る。**Issue #1000 は変異試験で次の2つを実測した。

- `examples/chat` の `CachingEmbeddingProvider` が、取り逃した全テキストに1本目のベクトルを返す変異: 全項目が緑
- testkit の `RecordingEmbeddingProvider` が、下層の返したベクトルの並びを反転して記録する変異: 全項目が緑

この2つの包み型は、専用テストで対応を見ている（PR #1007。
`packages/testkit/src/__tests__/recording-embedding-provider-mapping.test.ts`、
`examples/chat/src/__tests__/caching-embedding-provider-mapping.test.ts`）。**外部の adapter には、この歯は当たらない。**

**suite に要件を足すかは決めていない。**足すと、外部の adapter が通らなければならない要件が増える（#809 の方針と
関係する）。また「異なるテキストなら異なるベクトル」は本物のモデルでも厳密には保証されない（衝突がありうる）ので、
どの強さで要求するかも決める必要がある。

---

## 6. ⭐ 後から決められるように — `local` の live 15本は、CI で走らせる形が可能である

**判断材料をここに置く。⛔ いまは採っていない。**

**走らせられる根拠**【現物】:

- `packages/local-embedding` の live の歯と cache-warm の歯（§3 の表の下2行。本数は §3 の式で数える）は、**鍵を必要としない。**
  `MNEMORA_LIVE_LOCAL_EMBEDDING` を立てるだけで走る。**課金は発生しない。**
- 要るのは**モデル一式4ファイル計42MB（うち重み本体36MB）のダウンロード**だけである。
- **CI は既に、その重みを落としている**——CI の測定ジョブのいくつかが `MNEMORA_EMBEDDING=local` を固定で使う
  （どのジョブかは `.github/workflows/ci.yml` を見ること。⛔ ここに数と名前を写さない。[AGENTS.md](../AGENTS.md) の4層の表）。

⟹ **§3 の歯のうち `local-embedding` の2ファイルの分は、「鍵が無いから走らない」のではない。**

**いま採らなかった理由**:

- **CI のジョブが1本増える**。1周は壁時計 **4〜9分**である
  （[ADR 0183](./decisions/0183-local-postgres-makes-postgres-mutation-testing-possible.md) の実測）。
- [Issue #267](https://github.com/takecchi/mnemora/issues/267) が、**CI の1周の費用を
  既に問題として挙げている**（ADR を持つ PR は索引再生成でもう1周する）。
- **多数の担い手が並行して CI の緑を待っている。**増分は全員に掛かる。

⟹ **費用の理由で退けたのであって、成立しないから退けたのではない。**
**この費用の釣り合いが変わったら、ここへ戻ること。**

---

## 7. 実 API に当てる手順（鍵を持つ人向け）

**⛔ CI で実 API を叩く形は採らない。**鍵の管理と課金の判断が要るためである。

### ⚠ 先に読むこと

**鍵が在る環境でルートの `pnpm run test` を走らせると、黙って課金される。**
[ADR 0019](./decisions/0019-real-openai-measurement-cost.md) §5c が、**その事故が
実際に踏まれた**ことを逐語で記録している:

> `OPENAI_API_KEY` を持つ環境で `pnpm run test` を走らせると、黙って課金される（中略）
> 本作業中に実際にこれを踏んだ（門を繰り返し走らせる過程で、意図せず本物の API を複数回叩いた）。

⟹ **パッケージを絞って走らせること。**

### 打つコマンド

```bash
# OpenAI（live の it は §3 の表。1回あたり embeddings.create が5回増える。ADR 0019 §5c）
OPENAI_API_KEY=sk-... MNEMORA_LIVE_OPENAI=1 pnpm --filter @mnemora/openai test

# Anthropic（live の it は §3 の表）
ANTHROPIC_API_KEY=sk-... MNEMORA_LIVE_ANTHROPIC=1 pnpm --filter @mnemora/anthropic test

# local-embedding（live の it は §3 の表。鍵は要らない。4ファイル計42MB（うち重み36MB）を落とす）
MNEMORA_LIVE_LOCAL_EMBEDDING=1 pnpm --filter @mnemora/local-embedding test
```

### 測ったら、どこに記録するか

**ADR に記録する**（`docs/decisions/`）。少なくとも次の3つを書くこと:

1. **無条件7本が緑だったか。**落ちたら、「実装が間違っている」のか
   「契約が測れないものを要求している」のかを**分けて**判断すること。
   ⛔ **赤を消すために契約を書き換えないこと**（Issue #142 の逐語）。
2. **決定性を実測したか**（同じ入力を2回、要素ごとに厳密一致するか）。
   一致するなら `deterministic: true` へ**測定の記録と一緒に**変えること。
   ⛔ 「たぶん決定的だから」で変えないこと。
3. **測った器・日付・モデルの版。**上の §4 の表を、実測で置き換えること。

---

## 8. 確かめていないこと

- **実 API（OpenAI / Anthropic）には、いまも一度も当てていない。**この文書は手順を
  書いただけで、**測っていない。**`LLMProvider` の適合 suite（§2.3、`v1.0.1` で新設）も
  同様——偽 client の固定応答に当てているだけで、実 API には当てていない。
- **`_name_or_path` 以外の経路で repo id を同定できるかを、網羅的に調べていない。**
  実測したのは `config.json` の中身だけである。
- **「`repo` を差し替える運用が実在するか」を測っていない。**⟹ §5 の穴が実際に
  踏まれうるかは、分かっていない。
- **`packages/testkit` 以外の場所に在る歯（各パッケージ固有の unit テスト）は、
  この文書の対象外である。**数えていない。

---

## 9. 任意の適合フラグ — 「検査した」「検査していない」を区別する（Issue #515 方向①、ADR 0258）

**この文書の冒頭が掲げる問い**（「何が緑になったのか」は suite ごと・呼び出し元ごとに違う）
に対する、`MemoryStoreConformanceOptions` 側からの答えの1つ。

`supportsSupersedeWithNewMemories` 〜 `supportsPreviewRestoreSupersededBy` の8本は
**すべて必須**（`: boolean`、`?` 無し）——省略できないので、呼び出し元は必ずどちらかを
明示する。**`false` を選ぶと、`it.skip` ではなく「メソッド自体が無いことを積極的に
assert する」歯が走る**（例: `expect(store.restoreSupersededBy).toBeUndefined()`）。

**⚠ `supportsOnlyMemoryIdsFilter?`（`onlyMemoryIds` フィルタ、ADR 0258）だけは違う。**
[PR #524](https://github.com/takecchi/mnemora/pull/524) が
`supportsPreviewRestoreSupersededBy` を必須にしたことが「`@mnemora/testkit` を使う側に
対して破壊的だった」と訂正された前例（[ADR 0237](./decisions/0237-restore-superseded-dry-run-preview.md)
冒頭の訂正、[PR #526](https://github.com/takecchi/mnemora/pull/526)）と同じ轍を踏まない
ため、**この1本だけ任意にした。**⟹ 3状態になる:

| 値                      | 走る歯                                                                                                                                                                                                                                                    | 意味                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `true`                  | 契約の歯本体（積集合・省略時は群全体・両口の一致・テナント分離・対象0件）                                                                                                                                                                                 | **検査した緑**                                                                                                                          |
| `false`                 | 「フィルタを渡しても無視される」ことを積極的に assert する歯                                                                                                                                                                                              | **検査した緑**（「実装していない」ことを確認した）                                                                                      |
| **省略（`undefined`）** | ⛔ `it.skip` ではなく、**常に実行され常に緑で終わる named it を1本**——テスト名の文字列そのもの（`"⚠ 未検査: supportsOnlyMemoryIdsFilter が指定されていない — adapter \"<name>\" に対して onlyMemoryIds フィルタの歯は検査していない"`）が唯一の情報を運ぶ | **検査していない**——`it.skip` にすると、他の理由での skip（`maybeIt` の自動 skip・§3 の live gate）と出力上区別が付かなくなるため避けた |

【実測 2026-09-21】`packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts`・
`packages/postgres/src/__tests__/conformance.postgres.test.ts` はどちらも `true` を渡している
——この2つの adapter は「検査した緑」である。`supportsOnlyMemoryIdsFilter` を渡さない
第三者の `MemoryStoreConformanceOptions` 呼び出し（`@mnemora/testkit` を使う側、外部の
adapter 実装者を含む）は、コンパイルエラーにならずそのまま動き続け（型が壊れない）、
実行すると上表の「省略」行の named it が1本増えるだけである——**これが型を必須にせずに
「検査していない」を可視化する形**。

**⚠ 2026-09-28 追記（文書と実装の照合、main c80b1a2）**: 上の「この1本だけ任意にした」は、もう成り立たない。いまは次のフラグも任意である（上の本文は当時の記録として残す）。

- `MemoryStoreConformanceOptions` の `supportsLabels?`・`supportsFindActiveByClaimKey?`・`supportsListActiveClaimPredicates?`——どれも `supportsOnlyMemoryIdsFilter?` と同じ3状態で、省略すると「⚠ 未検査: <フラグ名> が指定されていない — adapter "<name>" に対して …の歯は検査していない」という named it が1本登録される。
- `TenantSettingsStoreConformanceOptions` の `supportsTaxonomyMode?`——⚠ **これだけは形が違う。**省略すると `false` と同じに扱われ、taxonomy mode の歯は**何も登録されない**（named it も無い）。⟹ 出力からは「検査していない」が読めない（今の振る舞い。Issue #818 で必須から任意へ戻した経緯は `docs/migration-v1.md` の **6** の末尾）。

**⚠ 2026-09-29 追記（Issue #1412 コメント1、[ADR 0373](./decisions/0373-conformance-suite-issue-1412-promises.md)）**: `MemoryStoreConformanceOptions` に `supportsResolveOrphanedContested?` が増えた——`resolveOrphanedContested?`（任意メソッド、CAS 違反で `MemoryStatusConflictError` を投げること）を検査する。上の `supportsLabels?` 等と同じ3状態。`packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts`・`packages/postgres/src/__tests__/conformance.postgres.test.ts` はどちらも `true` を渡している。

**⚠ 2026-09-30 追記（Issue #933 の PR1、[ADR 0378](./decisions/0378-claim-key-contested-detection-covers-contested-matches.md)）**: `MemoryStoreConformanceOptions` に `supportsFindContestedByClaimKey?` が増えた——`findContestedByClaimKey?`（新設の任意メソッド、`findActiveByClaimKey?` と同じ絞り込みで `status = 'contested'` の行を返すこと）を検査する。上の `supportsFindActiveByClaimKey?` 等と同じ3状態。`packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts`・`packages/postgres/src/__tests__/conformance.postgres.test.ts` はどちらも `true` を渡している。`packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts` が縛る「任意フラグを省略したときの named it」の一覧も、5つから6つに増えた。

**⚠ 2026-09-30 追記（Issue #1226、[ADR 0375](./decisions/0375-purge-scope-widened.md) 決定7、クローン miku の判断）**: `MemoryStoreConformanceOptions` に `supportsAbortIfForgotten?` が増えた——`createMemoryWithOutbox`/`supersedeWithNewMemories?` という**既存の任意メソッド**に足した**新しいパラメータ** `opts.abortIfForgotten`（`SourceMemoryForgottenError` を投げて書き込みを打ち切る、書き込みと同一トランザクションの `SELECT … FOR UPDATE` による見直し）を検査する。上の `supportsLabels?` 等と同じ3状態。`packages/postgres/src/__tests__/conformance.postgres.test.ts` は `true` を渡す（`PostgresMemoryStore` が実装している）。`packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts` は `false` を渡す（`InMemoryMemoryStore` は `opts.abortIfForgotten` を実装しない——渡しても無視される。`Runtime.consolidate`/`Runtime.reflect` は、この能力が無い adapter に対しては自前の「書く直前の読み直し」だけで保護する。`docs/memory-model.md` の該当箇所参照）。**破壊的変更として数える**——`packages/testkit` の conformance suite の判定を厳しくする変更であり（`opts.abortIfForgotten: true` を宣言した adapter は新しい歯を通す必要がある）、`docs/migration-v1.md` 項目26に登録した。「任意フラグを省略したときの named it」の一覧は、上の追記の6つとあわせて7つになった。

**⚠ 2026-09-30 追記（[ADR 0404](./decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md)）**: `MemoryStoreConformanceOptions` に `supportsPurgeExpiredRecalls?`、`OutboxStoreConformanceOptions` に `supportsPurgeCompletedJobs?` が増えた——それぞれ `MemoryStore.purgeExpiredRecalls?`・`OutboxStore.purgeCompletedJobs?` を検査する。上の `supportsAbortIfForgotten?` 等と同じ3状態（`true` は歯を走らせ、各 `it` の冒頭で口の存在を要求する／`false` は口が無いことを assert する／省略は「⚠ 未検査」の named it を1本だけ登録する）。**任意なので、既存の呼び出し側は壊れない（非破壊）。**`purgeCompletedJobs?` の歯のうち終端後の行を読むものは `peekJob` を要り、`peekJob` の無い adapter では `it.skip` になる。`packages/postgres` と `packages/testkit` の fixture は `true` を渡す。

**⚠ 2026-09-30 追記（Issue #1412 の続き）**: `VectorStoreConformanceOptions` に `supportsSearchMany?` が増えた——`VectorStore.searchMany?`（任意メソッド、Issue #377）の歯（各 key の結果が単独の `search()` と一致する・同点の並び・`limit`・0件でも key が Map に在る・空 `queries`・同じ key は後勝ち・NUL を含む key・不正な `limit`・`filter`/テナント分離）を `true` で実行し、`false` で `expect(store.searchMany).toBeUndefined()` を assert し、省略で「⚠ 未検査: supportsSearchMany が指定されていない — …」の named it を1本登録する（`supportsListActiveClaimPredicates?` と同じ3状態）。`in-memory-fixtures.conformance.test.ts`・`conformance.postgres.test.ts` はどちらも `true` を渡す。⚠ 省略時の named it を検査する `conformance-omitted-flags-named-it.test.ts` は `VectorStore` を対象にしていないので、この named it の登録そのものを縛る歯は無い。`supportsListActiveClaimPredicates: true` の枝には、同着の並び（predicate のコードポイント順の昇順）の歯が3本増えた。

**⚠ 2026-09-30 追記（省略時の named it を縛る歯の対象拡張）**: 上の追記が挙げる「省略したときの named it の一覧」の件数（「5つから6つ」「7つ」）と、直前の追記の「`VectorStore` を対象にしていないので、この named it の登録そのものを縛る歯は無い」は、当時の記録であり、いまは成り立たない。`conformance-omitted-flags-named-it.test.ts` は `VectorStoreConformanceOptions.supportsSearchMany?` と `OutboxStoreConformanceOptions.supportsPurgeCompletedJobs?` の省略時の named it も縛るようになった。⛔ 一覧の件数はここに書かない——数えるなら、そのテストファイルと各 `*-conformance.ts` の Options 型が出所である（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。省略で named it が登録される `MemoryStoreConformanceOptions.countScopeAggregateQueries?`（フラグではなく関数フックの2状態）は、この歯の対象外のままである。

**⚠ 2026-09-30 追記（`countScopeAggregateQueries?` を縛った）**: 直前の追記が「この歯の対象外のまま」とした `MemoryStoreConformanceOptions.countScopeAggregateQueries?`（関数フックの2状態）も、`conformance-omitted-flags-named-it.test.ts` が縛るようになった。省略すると「⚠ 未検査: countScopeAggregateQueries が指定されていない — …」の named it が1本登録されること（`it.skip` ではなく常に実行される it であること）を検査する。2状態でも「省いたら named it が出る」という約束はフラグの3状態と同じ、というオーナーの判断による。上の「対象外のまま」は当時の記録であり、いまは成り立たない。`supportsRealConcurrency?`（省略で `it.skip`）と `supportsTaxonomyMode?`（省略で何も登録されない）は、形が違うので対象外のままである。

---

## 出所について

- **§1・§2・§3・§5 の住所と本数**は `main` = `18a8a09` を読んで数えた【現物】。
- **§5 の `config.json` の中身**は 2026-09-17 に実際に取得した【実測】。
- **§4 の表**は [Issue #142](https://github.com/takecchi/mnemora/issues/142) 本文からの引用である。
- **判断（何を採り、何を採らなかったか）**は
  [ADR 0184](./decisions/0184-conformance-scope-documented-not-closed.md) に在る。
- **2026-09-25 追記**（Issue #449 / ADR 0305）: `EmbeddingProvider` suite に
  `overLimitText` の歯を1本足したことに伴い、**その1本が数え方に効く箇所だけ**を
  この作業者が読んで更新した（§1・§2.2・§3・§6）。**他の6 suite・他の節の数は
  この追記の対象外**——2026-09-17 時点の値のままである。
- **2026-09-26 追記**（`v1.0.1`、Issue #389 / [ADR 0266](./decisions/0266-llm-provider-conformance.md)）:
  `LLMProvider` の適合 suite が新設されたことに伴い、**それが数え方・記述に効く箇所だけ**を
  この作業者が読んで更新した（§1・§2.3・§8。§1・§2.3 の住所と本数は `packages/testkit/src/llm-provider-conformance.ts`・
  `packages/openai/src/__tests__/llm-provider.conformance.test.ts`・
  `packages/anthropic/src/__tests__/llm-provider.conformance.test.ts` を読んで数えた【現物】）。
  **他の7 suite・他の節の数はこの追記の対象外**——それぞれ直前の更新時点の値のままである。
- **2026-09-29 追記**（Issue #1238 / [ADR 0372](./decisions/0372-conformance-suite-issue-1238-promises.md)）:
  `MemoryStore`・`VectorStore`・`EventStore` の3 suite に7つの約束の歯を足したことに伴い、
  冒頭に追記した。**住所・呼び出し元の一覧（§1・§2.1）は変わっていない**ので、そこは
  更新していない。**it の数はどこにも書いていないので、更新の対象自体が無い。**
  他の節・他の追記が数えた範囲はこの追記の対象外。
- **2026-09-29 追記**（Issue #1412（Issue #1238 棚卸しの続き）/
  [ADR 0373](./decisions/0373-conformance-suite-issue-1412-promises.md)）:
  `MemoryStore`・`VectorStore`・`EventStore`・`OutboxStore` の4 suite に A8・A10・A11・
  PR #1296 棚卸しコメント1・2 の約束の歯を足したことに伴い、冒頭と §9 に追記した。
  **住所・呼び出し元の一覧（§1・§2.1）は変わっていない**ので、そこは更新していない。
  **it の数はどこにも書いていないので、更新の対象自体が無い。**
  他の節・他の追記が数えた範囲はこの追記の対象外。
