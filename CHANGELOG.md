# Changelog

このファイルは [Keep a Changelog](https://keepachangelog.com/) の形式に倣う。
**手で書く**（tag や commit ログからの自動生成ではない）。理由と、版の権威が
Release の tag にあるという既存の決定（[ADR 0070](./docs/decisions/0070-version-comes-from-the-release-tag.md)）
との関係は [ADR 0169](./docs/decisions/0169-changelog-hand-curated.md) を見ること。

## 過去のバージョンについて

**v0.1.0 〜 v0.1.9 の変更は、このファイルには書き起こしていない。**
[GitHub Releases](https://github.com/takecchi/mnemora/releases) の各 tag を参照すること
（理由: [ADR 0169](./docs/decisions/0169-changelog-hand-curated.md) 決定4）。

⚠ **このファイルの初版と ADR 0169 決定4 は「v1.0.0 以降を対象とする」と書いていた。**
そう書いた時点では、次に出る Release が `v1.0.0` になる見込みだった。**実際に出たのは
2026-09-16 の `v0.2.0` である**（tag が指すのは `c52be47`）。⟹ **このファイルが実際に
対象としているのは `0.2.0` 以降である。**書き起こさない範囲（v0.1.0 〜 v0.1.9）は
決定4 のまま変えていない。⛔ **ADR 0169 の本文は当時の記録なので書き換えていない**
（`AGENTS.md`）。

## 何を載せるか

**利用者に見える変更だけを載せる。** docs のみの PR・内部スクリプトの修正・ADR 索引の
再生成・テスト追加のみの PR は載せない——GitHub が自動生成する Release notes（全 PR を
無差別に列挙する）との意図的な違いである。各項目は1〜2行の要約と ADR/Issue へのリンクに
留め、詳細は複製しない（`AGENTS.md` の反重複規律）。

⭐ **`[0.3.0]` 以降は、publish 対象のパッケージの変更だけを載せる。**出所は
`scripts/publish-targets.mjs` の `PUBLISH_TARGETS` である（⛔ **本数も名前もここに写さない**
——`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。⟹ **`examples/chat` は `private` であり、
出荷される面の外なので載せない。**

⚠ **これは途中で変わった形である。**【現物】`[0.2.0]` 節は `### Added` に `examples/chat` の
項目を2つ持っている（`memory_usage` 報告の実践 / 想起経路が連想枠を既定で使うようになった）。
⛔ **その2項目は書き換えていない**——当時の記録である（`AGENTS.md`）。
⟹ ⭐ **`[0.3.0]` 以降で `examples/chat` の変更が載っていないのは、書き漏れではなく方針である。**
理由・採らなかった案・引き受けた負債は
[ADR 0243](./docs/decisions/0243-changelog-lists-publish-targets-only.md)。

---

## [1.2.0] - 未リリース

**この節は `v1.1.0`（tag が指す `5eb6e9d`、[PR #1443](https://github.com/takecchi/mnemora/pull/1443) がその commit の中身）… の差分である。**オーナーが 2026-09-30 に tag `v1.1.0` を `5eb6e9d` で publish し、npm にも `1.1.0` が出た。⟹ **これにより、下の `[1.1.0]` 節は出荷済みになった。**この節は、`5eb6e9d` より後に `main` へ入った PR を数える。

⭐ **数えた基準を明記する。**この節はまだ何も棚卸ししていない——起点は `v1.1.0`（tag が指す `5eb6e9d`）であり、それより後に `main` へ入った PR がこの節の対象になる。⛔ ここに件数を書かないこと（[ADR 0234](./docs/decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。

### v1.1.0 の記載の訂正

**この節は、出荷済みになった `[1.1.0]` 節を書き換えないための置き場である**——出荷済みの節は1バイトも書き換えない（`AGENTS.md`）。v1.1.0 について後から分かった訂正は、下の `[1.1.0]` 節ではなく、ここに置く。

(a) **`[1.1.0]` 節の「確定した破壊的変更は11件」は、[PR #1437](https://github.com/takecchi/mnemora/pull/1437)（[Issue #1425](https://github.com/takecchi/mnemora/issues/1425)、[ADR 0382](./docs/decisions/0382-vector-store-delete-across-spaces.md)、`VectorStore.deleteAcrossSpaces` の必須化）を数え落としている。**v1.1.0 で確定した破壊的変更は、実際には**12件**である：PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」、PR #1408・Issue #1301、PR #1413・Issue #1238、PR #1417・Issue #1412、PR #1427・Issue #994/#995/#1207、PR #1428・Issue #1226、PR #1431・Issue #933、PR #1435・Issue #1432、PR #1437・Issue #1425。

移行の手順は [docs/migration-v1.md](./docs/migration-v1.md) の項目30を見ること（見出しへの直接アンカーは、生成規則を確かめられなかったため付けていない。ファイル内を「30.」で検索すること）。

(b) [docs/release-notes-v1.1.0.md](./docs/release-notes-v1.1.0.md) の `### 🔴 破壊的変更` にも、同じ1件（PR #1437）が抜けていた。同ファイルは既存の本文を書き換えず、末尾に 2026-09-30 付けの訂正の追記を足した。

(c) `[1.1.0]` 節では「追記29」の名前が2か所（27回目の棚卸し自身の段落と、PR #1437 が着地時に足した段落）で使われているが、そのことは同じ節の中で開示されていない——追記28 には「⚠『追記28』がこの節に2か所ある」という注記があるのに対し、追記29 にはそれが無い。出荷済みの節はもう書き換えないので、この事実をここに記録するだけに留める。

### Breaking

- **識別子に孤立サロゲートか NUL（U+0000）を含む値を、入口で `MalformedIdentifierError`（`kind: "malformed_identifier"`）で断るようになった。`@mnemora/testkit` の conformance suite に、これを検査する `it` が増えた——自前の store 実装を conformance suite に当てている人へ**（[ADR 0423](./docs/decisions/0423-identifier-well-formed-and-error-message-without-params.md)、`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）。

  識別子（`tenantId`・`subjectId`・`observe` の `externalId`）の文字の扱いを揃えた。孤立サロゲート（対をなさない UTF-16 のサロゲートコードユニット）か NUL を含む識別子は、これまで実装によって扱いが違った（Postgres では U+FFFD に置き換わって保存される、または DB の生の例外、インメモリ実装では通る）。今は、**書き込みより前に**、明示の例外で断る。**正規化はしない**（書き換えて通さない。`Ctx` の「正規化せず完全一致で比べる」は変わらない）。対をなすサロゲート（絵文字など）は、これまでどおり通る。

  - **断る場所**: `createRuntime` が返す `Runtime` の全メソッドの入口（第1引数の `Ctx` の `tenantId`・`subjectId`、`observe` の入力の `subjectId`・`externalId`）。`@mnemora/postgres` とインメモリ実装（`@mnemora/testkit`）の store の、`ctx` を取る全メソッドの入口と、識別子を入力に持つ口（Observation・Memory の書き込みの `subjectId`・`externalId`、検索条件の `filter` など）。
  - **例外**: `MalformedIdentifierError`（`kind: "malformed_identifier"`、`field`・`reason`・`index`）。判定関数 `isMalformedIdentifierError`（ADR 0418 の作法。`instanceof` を使わない）。message に入力値は入らない。判定の関数 `assertWellFormedIdentifier`・`assertWellFormedCtx`・`assertWellFormedFilter`・`findMalformedIdentifierPart` も公開した（自前の store が同じ判定を使える）。
  - **破壊的と数える理由**: 型・シグネチャは変わらないが、**以前は通っていた入力（孤立サロゲートか NUL を含む識別子）が、新しく例外になる**。あわせて、conformance suite の判定が厳しくなり、入口で断らない自前の store は、新しく実行時に落ちる（項目21・23・24・27 と同じ扱い）。
  - **誰が影響を受けるか**: 識別子に外部の入力をそのまま渡している呼び出し側のうち、孤立サロゲートか NUL を含みうるもの。自前の store を `describeMemoryStoreConformance`・`describeOutboxStoreConformance`・`describeVectorStoreConformance`・`describeLexicalStoreConformance`・`describeEventStoreConformance`・`describeRelationStoreConformance`・`describeTenantSettingsStoreConformance` に当てている利用者。
  - **変えなかったこと**: 本文（`text`・`content`・`payload`・`attributes` の値）の扱い——`text` 列の孤立サロゲートを U+FFFD に置き換える今の扱い、`jsonb` 列が断る今の扱い。`tags` の要素・`claimKey` の主語と述語・ラベル名（今回は対象にしていない）。すでに保存された行。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目41。DB マイグレーションは無い。
  - 【確かめていないこと】本物の2つの版の core が並ぶ環境。過去に U+FFFD へ置き換わって保存された識別子がデータに在るか。

- **テナント単位で全表から行を消す独立関数 `eraseTenant` と、4つの port の任意メソッド
  `eraseTenant?` が増えた。`packages/testkit` の conformance suite に、省略できない
  フラグ `supportsEraseTenant: boolean` が増えた——conformance suite を呼んでいる人へ**
  （[Issue #1207](https://github.com/takecchi/mnemora/issues/1207)、
  [PR #1444](https://github.com/takecchi/mnemora/pull/1444)、
  [ADR 0383](./docs/decisions/0383-erase-tenant.md)）。

  利用者に「このテナントを消してほしい」と求められたとき、mnemora の中で完結して消せる
  口が無かった（`forget` → `purge` と保持期間の掃除を合わせても、`recalls`・
  `recall_usages`・完了した `outbox` の行・`observations`・`tenant_settings` などが残った。
  Issue #1207）。

  - `@mnemora/core`: 独立関数 `eraseTenant(ctx, deps, opts)` を足した
    （`purgeExpiredEventsForTenant` と同じく `Runtime` の外に置き、`tick()`/`observe()`
    からは呼ばれない。`Runtime` のメソッドは増えていない）。`MemoryStore`・
    `VectorStore`・`OutboxStore`・`TenantSettingsStore` に任意メソッド `eraseTenant?`
    を足した（`EventStore` には足していない）。4つのうち1つでも無ければ、何も消さずに
    `{ kind: "store_unsupported", missing }` を返す。他テナントの行がこのテナントの行を
    参照していれば、1行も消さずに `{ kind: "blocked_by_foreign_reference", count }` を返す。
    **いずれかの port が `reachedLimit: true` を返した回（`limit` で途中で止まった回）は、
    `memoryStore` → `vectorStore` → `outboxStore` の順に、そこで打ち切って後ろの port を
    呼ばない**（設定は最後、という [ADR 0383](./docs/decisions/0383-erase-tenant.md) の
    約束。呼ばなかった port の `deleted` は `0`、`dryRun` も同じ。追記は同 ADR の末尾、
    [PR #1526](https://github.com/takecchi/mnemora/pull/1526)）。設定が消えるのは、前の port が
    消し切った最後の回だけ。`deleted.memoryStore` は `memoryStore` が消す10表の合計、
    `deleted.vectorStore` は本番では CASCADE のため `0` になる（doc を直した）。
  - `@mnemora/postgres`: 4つの store に `eraseTenant` を実装した。
    **DB マイグレーション `0027_erase_tenant_fk_indexes.sql` が増えた**（外部キー検査の
    ための単一列の索引。埋め込み空間の表には `(memory_id)` の索引を遡って足す）。
  - `@mnemora/testkit`: in-memory fixture に `eraseTenant` を実装した。
    `describeMemoryStoreConformance`・`describeVectorStoreConformance`・
    `describeOutboxStoreConformance`・`describeTenantSettingsStoreConformance` の
    options に **`supportsEraseTenant: boolean`（省略不可）** が増えた。

  **移行の手順**:

  1. conformance suite を呼んでいる箇所に `supportsEraseTenant` を渡す。自前の store に
     `eraseTenant?` を実装していなければ `false`（型検査は、渡すまで通らない）。
  2. `@mnemora/postgres` を使っていれば、上げたあとに migrate を当てる（`0027` が入る）。
     ⚠ この migration の `CREATE INDEX` は `CONCURRENTLY` を使わないので、索引を作る
     あいだ対象の表への書き込みが止まる。止まる時間の目安と測り方は
     [docs/migration-v1.md](./docs/migration-v1.md) の項目31 を見ること。
  3. `eraseTenant` を使わないなら、ほかに直すことは無い。

- **`@mnemora/openai` の `OpenAIEmbeddingProvider.embed()` が、応答の件数・`index`・次元・成分の有限性を検査し、崩れていれば例外を投げるようになった——以前は素通りしていた食い違った応答が、新しく例外になる**
  （[Issue #860](https://github.com/takecchi/mnemora/issues/860)、
  [ADR 0305](./docs/decisions/0305-embedding-provider-input-limit-contract.md) の 2026-09-30 追記）。

  以前は `response.data` を `index` で並べ替えて返すだけで、応答が `texts` と食い違っていても検査しなかった
  （2026-09-26 に「検査しない・結果は未定義」と文書化した）。本物の SDK に偽の `fetch` を渡して確かめると、件数の過不足・
  次元違い・`index` の重複/欠落/範囲外・空の `data` のどれも、例外なしに素通りした。今回、次の4つを確かめ、
  崩れていれば素の `Error`（メッセージは `OpenAIEmbeddingProvider:` で始まり、期待値・実際の値・何番目かを含む。
  入力テキストの本文と API キーは含まない。専用のエラー型・`kind` は無い）を投げる。

  1. `response.data` の件数が `texts.length` と等しい。
  2. `index` が 0..n-1 をちょうど1回ずつ。
  3. 各ベクトルの長さが `space.dimensions` と等しい。
  4. 成分がすべて有限（`NaN`/`Infinity` が無い）。

  - **公開 API の型・シグネチャは変わらない**（`embed` の戻り値の型も同じ）。変わるのは、食い違った応答に対する振る舞い
    （返す → 投げる）だけである。
  - **誰が影響を受けるか**: OpenAI が `texts` と食い違う応答（件数違い・次元違い・`NaN`/`Infinity`・`index` の異常）を
    返したとき、以前は黙って通っていたものが `embed()` の例外になる。`Runtime.tick` の embed ジョブでは、その例外は
    ジョブの失敗（`embeddingStatus: 'failed'`）として扱われる。**正常な応答（件数一致・宣言どおりの次元・有限）を
    返す限り、何も変わらない。** `client` に自前の偽物を注入していて、件数や次元が宣言と合わないベクトルを返して
    いるテストがあれば、新しく落ちる。
  - **変えなかったこと**: `response.data` キー自体が無い応答は従来どおり生の `TypeError`。入力の上限超過は今もサーバの
    拒否に依存している。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目32。DB マイグレーションは無い。
  - 【確かめていないこと】実 API がこれらの食い違いを実際に返すか（実 API は使っていない）。

- **`@mnemora/core` が、provider の返す埋め込みの長さ（`space.dimensions`）と成分の有限性を確かめるようになった——embed ジョブは次元違い・`NaN`/`Infinity` を失敗にし、recall は同じ問い合わせベクトルを `embedding_provider_unavailable` に丸める**
  （[Issue #860](https://github.com/takecchi/mnemora/issues/860)、[ADR 0393](./docs/decisions/0393-core-checks-embedding-dimension.md)。
  provider の側で応答を検査する [PR #1462](https://github.com/takecchi/mnemora/pull/1462)（`@mnemora/openai`）の続きで、provider を問わず
  第三者の実装も含めて core が守る）。

  以前は、次元違いの出力をそのまま `VectorStore` へ渡していた。結果は store と provider の組で決まっていた
  （Postgres は pgvector の `expected N dimensions` で SQL の失敗に見える形で落ち、InMemory・Fake は黙って `'ready'` で保存した）。
  今は、`Runtime.tick` の embed ジョブが `VectorStore.upsert` の前に、`recall()` が provider の問い合わせベクトルを使う前に、
  `vector.length === embeddingProvider.space.dimensions` と、成分がすべて有限（`NaN`・`Infinity`・`-Infinity` が無い）ことを確かめる。

  **破壊的変更として名乗るのは次の2点**:

  1. **InMemory・Fake の経路で `'ready'` だったものが `failed` になる。** provider が `space.dimensions` と違う長さ、または `NaN`/`Infinity` を含むベクトルを返すと、
     `@mnemora/testkit` の `InMemoryVectorStore` や core の `FakeVectorStore` では以前は `embeddingStatus: 'ready'` で保存され、
     今は embed ジョブが失敗し `embeddingStatus: 'failed'`（`recall()` では `not_indexed`）になる。メッセージは期待した次元と実際の次元を含む。
     自前の偽の provider に宣言と違う長さのベクトルを返させているテストは、新しく落ちる。
  2. **recall の理由が `score_not_comparable` から `embedding_provider_unavailable` に変わる。** provider が返した問い合わせベクトルの長さが
     違うか `NaN`/`Infinity` を含むとき、Postgres では以前は全 0 に差し替えられて `omitted` の `score_not_comparable` と記録されていた。今は「provider がベクトルを
     返さなかった」と同じ `stage_skipped`（`candidate_generation`）の `embedding_provider_unavailable` になる。この理由の名前で分岐している
     呼び出し側は、扱いを見直すこと。

  - **公開 API の型・シグネチャは変わらない。**`Omission` の union も変わらない（既存の値の使われ方が変わるだけ）。
  - **正常な provider（宣言どおりの次元を返す）では何も変わらない。**
  - **変えなかったこと**: `RecallQuery.vector` を呼び出し側が直接渡した場合は検査しない（長さ違いは今も `score_not_comparable`）。
    `VectorStore.search`/`searchMany` の直接呼び出しも変わらず、`@mnemora/postgres` の `toComparableQuery` も残した。
    直接渡されたベクトルは、長さも有限性も検査しない。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目33。DB マイグレーションは無い。
  - 【確かめていないこと】Postgres での実機の再現（`DATABASE_URL` が無く、Postgres のテストは走らせていない）。実 API は使っていない。

- **`RelationStore.link` が、両端の記憶が `ctx` のテナントに属さない（または実在しない）ときに例外を投げるようになった**（[ADR 0398](./docs/decisions/0398-relation-store-link-checks-both-ends-belong-to-ctx-tenant.md)、`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）。

  これまで `link` は、`fromId`/`toId` が `ctx.tenantId` の記憶かどうかを確かめなかった。`PostgresRelationStore` は別テナントの記憶を端に取る行を受け付け、
  存在しない uuid は外部キー違反の生の DB エラー、uuid でない文字列は `Failed query` になった。`InMemoryRelationStore` は存在しない id も受け付けた。
  今は、書く前に両端が `ctx.tenantId` の記憶であることを確かめ、どちらかが実在しない・別のテナントの記憶なら、**行を書かずに** `memory not found for tenant: <id>` を含むメッセージの `Error` を投げる。
  Postgres は確かめと書き込みを1つの SQL 文にしている。uuid でない id は DB へ投げる前に弾く。

  - **破壊的と数える理由**: 型・シグネチャは変わらないが、**以前は通っていた `link`（別テナントの記憶・実在しない id を端に取るもの）が、新しく例外になる**。項目21・23・24・27 と同じく、以前は通っていたものが通らなくなる変更を破壊的と数える。
  - **誰が影響を受けるか**: `RelationStore.link` を直接呼ぶ利用者（`PostgresRelationStore` は公開 API）のうち、実在しない id・別テナントの id を渡しているもの。runtime は `link`/`unlink` を呼ばず、`MemoryStore.markContestedGroup?` は元から両端を `ctx` のテナントで確かめているので、`recall()` や `tick()` の挙動は変わらない。自前の `RelationStore` を `describeRelationStoreConformance` に当てている利用者は、新しい `it` が落ちうる（`prepareMemoryId` が返す記憶が、`createStore()` の store から見えること、渡した `ctx` のテナントの記憶であることを要する）。
  - **変えなかったこと**: `unlink`・`listRelated` の振る舞い（どちらも元から `ctx.tenantId` の行だけを見る）。DB のスキーマ・複合外部キーは変えない（理由は ADR 0398）。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目34。**DB マイグレーション**は無い。修正前に書かれた食い違う行が在るかを調べる SQL は ADR 0398 に在る。
  - 【確かめていないこと】検査と INSERT の間に、並行して記憶が消えた場合の Postgres のエラーの見え方（外部キー違反の生のエラーのまま）。手元以外の環境・既存データでの食い違う行の有無。

- **`@mnemora/anthropic` の `completeStructured` が、`z.record` を含むスキーマを、送る前に `kind: "schema_unsupported"` の `AnthropicLLMProviderError` で落とすようになった**（[ADR 0360](./docs/decisions/0360-schema-unsupported-thrown-before-send.md) の 2026-09-30 の追記、負債3、`@mnemora/anthropic`）。

  これまで Anthropic 側は `z.record` を翻訳して送っていた。SDK の翻訳は `additionalProperties: false` を強制し、record のキーと値の制約を `description` に降格するので、送る形は**空の object しか許さない**ものになり、record の欄は**例外が出ないまま常に空**になっていた。今は、object の欄・配列の要素・`optional`/`nullable`/`default` の内側・union や intersection の枝・`z.lazy` の先のどこに `z.record` があっても、`messages.create` を呼ぶ前に `kind: "schema_unsupported"` で投げる。`cause` の `Error` に理由が載る。`@mnemora/openai` は元から同じ形を落としており、2つの provider の振る舞いが揃った。
  - **破壊的と数える理由**: 型・シグネチャは変わらないが、**以前は例外なしに通っていた `z.record` を含むスキーマが、新しく例外になる**。
  - **誰が影響を受けるか**: `AnthropicLLMProvider.completeStructured` に `z.record` を含む zod スキーマを渡している利用者。core が渡す4つのスキーマ（抽出・claim key・統合・内省）に `z.record` は無く、`runtime` の経路は変わらない。
  - **変えなかったこと**: `z.lazy`（再帰そのもの）・`default`・根が union は、今までどおり送る（`z.record` を含めば落ちる）。`@mnemora/openai` の振る舞い、送る JSON の形（record を含まないスキーマ）。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目35。record を `z.array(z.object({ key: z.string(), value: … }))` に置き換える。DB マイグレーションは無い。
  - 【確かめていないこと】Anthropic の実 API には当てていない（鍵が無い）。

- **`@mnemora/testkit` の `describeRelationStoreConformance`・`describeOutboxStoreConformance`・`describeTenantSettingsStoreConformance` が、別テナントの ctx からの呼び出しがそのテナントの行に触れない・見えないことを、これまでより多くの口で検査するようになった**（[PR #1498](https://github.com/takecchi/mnemora/pull/1498)、`@mnemora/testkit`）。テナントの条件の一部の口に、対応する歯が無かった。`@mnemora/postgres` の実装に漏れは無く、実装の変更は無い。

  足した検査の対象は、`RelationStore` の `unlink` と kind を指定した `listRelated`、`OutboxStore` の `complete`・`fail`・`eraseTenant?`（`dryRun` を含む）・`purgeCompletedJobs?`、`TenantSettingsStore` の `getDefaultHalfLifeHours`・`hasSubjectActivityCounters?`・`eraseTenant?` の `dryRun`。`@mnemora/postgres` の各口について、条件を外した変異を入れると足した `it` が赤になり、戻すと緑に戻ることを確かめた。

  - **破壊的と数える理由**: 型・シグネチャは変わらないが、**conformance suite の判定が厳しくなり、テナントの条件を持たない自前の実装は、新しく実行時に落ちる**（[Issue #1412](https://github.com/takecchi/mnemora/issues/1412) の規律。オーナーの回答 `6911db12` により、`v1.X.0` で出してよい）。
  - **誰が影響を受けるか**: 自前の `RelationStore`・`OutboxStore`・`TenantSettingsStore` を上の suite に当てている利用者のうち、別テナントの行に触れる実装。`@mnemora/postgres` とインメモリの実装は、足した `it` に通る。
  - **変えなかったこと**: suite の引数（適合フラグ・フック）。公開 API の型。**移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目36。DB マイグレーションは無い。
  - 【確かめていないこと】インメモリ実装（`packages/testkit` の `__fixtures__`）の各口を1つずつ変えて調べる走査（足した `it` がインメモリ実装で緑であることだけを確かめた）。

- **`@mnemora/testkit` の `describeOutboxStoreConformance`・`describeRelationStoreConformance` が、adapter 間の食い違い4点を検査するようになった**（Issue なし・クローンの棚卸し R3・P2〜P5 の PR、`@mnemora/testkit`・`@mnemora/postgres`・`@mnemora/core` の doc）。足した `it` は、`OutboxStore` が4件（`complete`/`fail` の `opts.at` が Invalid Date なら例外、の2件。渡した `opts.at` を後から書き換えても `completedAt`/`failedAt` が変わらない、の1件。`fail` の `error` の NUL を6文字の `\u0000` に置き換えて `lastError` に残す、の1件。後ろの2件は `peekJob` を渡した adapter だけ）、`RelationStore` が2件（列挙の外の `kind` を渡す `link` が「`relation kind`」を含む例外で拒まれ行が書かれない、`listRelated` が返した `createdAt` を書き換えても store の行が変わらない）。

  - **破壊的と数える理由**: 型・シグネチャは変わらないが、**conformance suite の判定が厳しくなり、上の4点を満たさない自前の実装は、新しく実行時に落ちる**（Issue #1412 の規律。項目41）。
  - **誰が影響を受けるか**: 自前の `OutboxStore`・`RelationStore` を上の suite に当てている利用者。`@mnemora/postgres` は、`RelationStore.link` の列挙外 `kind` の `it` だけ、修正前は落ちた（次の `### Fixed`）。ほかの5件は修正前から通る。インメモリ実装（`@mnemora/testkit/fixtures`）は、6件とも足した修正で通る。
  - **`@mnemora/postgres` の `PostgresRelationStore.link` の変化（破壊的とは別に数えない）**: 列挙外の `kind` は、これまでも `memory_relations.kind` の CHECK 違反で例外になっていた。今は INSERT の前に `PostgresRelationStore: unknown relation kind: <kind>` の `Error` で断る。**以前通っていた入力が新しく落ちるわけではない**（例外になる入力は同じ）。変わるのは例外の中身だけで、DB の生のエラー（`23514`）を `cause` などから読んでいた呼び出し側は、その読み方が効かなくなる。
  - **`@mnemora/testkit/fixtures` の変化（数えない）**: `InMemoryOutboxStore.complete`/`fail` が Invalid Date の `opts.at` を拒み、`InMemoryRelationStore.link` が列挙外の `kind` を拒むようになった。fixture が新しく例外を投げる変更は、数えない（[docs/migration-v1.md](./docs/migration-v1.md) の「数え方の規律への追記（2026-09-28）」規律2）。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目43。DB マイグレーションは無い。
  - 【確かめていないこと】`complete`/`fail` の Invalid Date を、`jobId` が uuid の形でないときにどうするか: Postgres は先に何もせず返す（`at` を見ない）が、fixture は `jobId` を見る前に拒む。この差は `it` で縛っていない。
- **`@mnemora/testkit` の `describeMemoryStoreConformance` が、自前の `MemoryStore` 実装に4つの約束を新しく課すようになった——`reinforce`/`reinforceMany?` が `memory_events` を書かないこと、`aggregateScope` が `scopeAggregate: 'skip'` を守ること、`createObservationWithOutbox` が `opts.claimedBy` を守ること（この3つはフラグ無しの `it`）、`listActiveClaimPredicates?` の同着の並び**（[PR #1452](https://github.com/takecchi/mnemora/pull/1452)・[PR #1455](https://github.com/takecchi/mnemora/pull/1455)・[PR #1484](https://github.com/takecchi/mnemora/pull/1484)・[PR #1492](https://github.com/takecchi/mnemora/pull/1492)）。

  4つとも、下の `### Added`/`### Changed`/`### Fixed` に「非破壊」と書いて載せていたが、[docs/migration-v1.md](./docs/migration-v1.md) の「数え方の規律への追記（2026-09-28）」規律2 の ⛔（「conformance スイートの判定を厳しくする変更」は数える）に当たる。上の [PR #1498](https://github.com/takecchi/mnemora/pull/1498) と同じ読みで、ここに数え直した。型・シグネチャは変わらない。変わるのは、条件を満たさない自前の実装が、suite を当てると**実行時に新しく落ちる**ことである。`@mnemora/postgres` とインメモリの実装は、足した `it` に通る。

  1. **`reinforce`/`reinforceMany?` が `memory_events` に1行も書かない**（[Issue #871](https://github.com/takecchi/mnemora/issues/871)、PR #1452。`docs/memory-model.md` §11 行4 の約束）。フラグ無しで走る。`reinforce` の `it` は常に、`reinforceMany` の `it` は実装があるときだけ検査する。強化のたびにイベントを積む自前の実装は落ちる。
  2. **`aggregateScope` が `opts.scopeAggregate: 'skip'` を守る**（PR #1455、[ADR 0384](./docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md)）。フラグ無しの `it` が、`'skip'` のとき `groups` が空・`totalInScope` が `0`・`countKind` が `'unknown'`（`filtered*`・`notIndexed.*` も `{ count: 0, countKind: 'unknown' }`）であること、`'skip'` かつ `digestBand` 省略なら `digestEligible` が `{ count: 0, countKind: 'exact' }` であること、省略と `'exact'` の結果が同じであることを検査する。`scopeAggregate` を読まずに常に集計して `'exact'` を返す自前の実装は落ちる。
  3. **`listActiveClaimPredicates?` の同着の並び**（PR #1484、[Issue #1412](https://github.com/takecchi/mnemora/issues/1412) の続き）。`supportsListActiveClaimPredicates: true` の枝に、同着（代表行の `created_at` が同じ predicate が複数）を predicate のコードポイント順の昇順で返すこと、`limit` で切っても同じ先頭が残ること、照合順序（collation）に依らないことを検査する `it` が3本増えた。`true` を渡していて並びが違う実装は落ちる。フラグを渡さなければ何も変わらない。
  4. **`createObservationWithOutbox` が `opts.claimedBy` を守る**（PR #1492、[ADR 0407](./docs/decisions/0407-sync-observe-extract-job-lease.md)）。フラグ無しの `it` が、`claimedBy` を渡すと outbox 行が claim 済み（`claimedBy`・`attempts: 1`）で作られること、省略すると未 claim・`attempts: 0` であることを検査する。`claimedBy` を無視する自前の実装は落ちる。
  - **誰が影響を受けるか**: 自前の `MemoryStore` 実装を `describeMemoryStoreConformance` に当てている利用者。1・2・4 はフラグを渡していなくても当たる。3 は `supportsListActiveClaimPredicates: true` を渡している場合だけ当たる。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目37〜40。DB マイグレーションは無い。
  - 【確かめていないこと】自前の実装が実際にどれだけ落ちるか（`@mnemora/postgres` とインメモリの実装が通ることだけを確かめた）。
- **DB の生の例外で失敗していた3つの入力が、明示の扱いに変わった。conformance suite に `it` が3本増えた**（PR「fix/hunt-n-small-holes」の候補 N-3・N-4・N-5）。
  - **`@mnemora/postgres` は、float4（`real` 列）に収まらない `halfLifeHours`・`halfLifeRecalls`（例: `1e39`・`1e-50`）を、DB へ渡す前に、メッセージに `does not fit in a Postgres "real" (float4) column` を含む `Error` で断る**。対象は `createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の `NewMemory` と `PostgresTenantSettingsStore.setDefaultHalfLifeRecalls`。以前も例外にはなったが、DB の生の例外（`out of range for type real`）だった。testkit の fixture は既にこの判定・この文言で断っていた。core の doc に float4 の上限・下限を書いた。
  - **`@mnemora/openai` と `@mnemora/local-embedding` の `embed()` は、abort 済みの `signal` を渡されたら、空配列でも `[]` を返さず `signal.reason` で reject する**（以前は空配列だと signal を見ずに `[]` を返した）。
  - **`@mnemora/postgres` の `RelationStore.unlink` は、uuid の形でない id を何もせずに返し、`listRelated` は空配列を返す**（存在しない id と同じ扱い。以前は DB の型変換エラーで reject した）。testkit のインメモリは既にこの振る舞い。core の doc に書いた。
  - **conformance に `it` を足した**: `describeMemoryStoreConformance`（float4 の範囲外の `createMemory`）、`describeTenantSettingsStoreConformance`（`setDefaultHalfLifeRecalls` の float4 の範囲外。この口を渡した場合）、`describeRelationStoreConformance`（uuid の形でない id の `unlink`・`listRelated` 各1本）。フラグ無しで走る。
  - **誰が影響を受けるか**: 自前の `MemoryStore`/`TenantSettingsStore`/`RelationStore` 実装を conformance に当てている利用者。上の3つの adapter を、DB の生の例外の文言で捕まえていた呼び出し側。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目44・45。DB マイグレーションは無い。


- **`runtime.consolidate`・`runtime.reflect` が、材料が superseded になったときと、統合元がすべて CAS に弾かれたときに、統合先・内省を書かずに `outcome: 'aborted_source_status_changed'` で打ち切るようになった**（[ADR 0420](./docs/decisions/0420-consolidate-reflect-abort-on-superseded-and-all-conflicted.md)、[PR #1523](https://github.com/takecchi/mnemora/pull/1523)）。
  - **何が壊れていたか**:
    - 同じ ids の `consolidate` が2本同時に走ると、後から書く側は統合元がすべて CAS に弾かれる。それでも統合先が commit され、`"consolidated"` で返っていた（同じ内容の統合記憶が2件 active になる）。
    - `consolidate`/`reflect` が LLM を待つ間に `reextract` が材料を置き換えると、退けた古い本文から作った統合先・内省が active で残っていた。
    - forget に対しては打ち切ると決めていた（ADR 0375 決定7・ADR 0406）が、superseded には同じ扱いが無かった。
  - **何が変わったか**:
    - `ConsolidateOutcome`・`ReflectOutcome` に `"aborted_source_status_changed"` が、`ReflectBasisOutcome` に `"status_changed_before_write"` が増えた。
    - `MemoryStore` の3つの書き込みの口に任意の `opts.abortIfSuperseded` が、`supersedeWithNewMemories?` に任意の `opts.abortIfAllConflicted` が増えた。
    - store が投げる例外は、新しい `SourceMemoryStatusChangedError`（判定関数は `isSourceMemoryStatusChangedError`）である。
    - `@mnemora/postgres` は行ロックの下で見直し、トランザクションごと巻き戻す。`@mnemora/testkit` の `InMemoryMemoryStore` も実装する。
    - 1件でも `active` のまま残り、`superseded` になったものが無ければ、今までどおりの部分成功である。
  - **なぜ破壊的か**: 今まで `"consolidated"`/`"reflected"` で返り、統合先・内省が書かれていた入力が、書かれずに新しい値で返る。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目42。DB マイグレーションは無い。
  - 【確かめていないこと】`supersedeWithNewMemories?` を実装しない adapter の2段の経路では、LLM 直後の読み直しより後に全件が破れても打ち切れない（ADR 0420 の「引き受けた負債」）。

- **contested の検出が、NFC と NFD の違いや前後の空白だけが違う同じ `content` を矛盾と判定しなくなった**（[ADR 0424](./docs/decisions/0424-normalized-content-comparison-and-boundary-conformance.md)、[PR #1527](https://github.com/takecchi/mnemora/pull/1527)、探索の穴 O-3）。`Runtime.detectClaimKeyContested` が、store が返した行の `content` を NFC にして `trim()` した値が検出中の memory と等しいものを、件数を数える前に除く（`sourceObservationId` の除外と同じ場所）。
  - **直し方**: 比較の前だけの正規化で、`content_hash` の値・保存する `content`・`MemoryStore` の口の契約は変えない。SQL 側に入れないのは、Postgres の `normalize()` が `SQL_ASCII` で使えないため。
  - **振る舞いの変更**: `claimKey: { enabled: true, detectContested: true }` の `observe()` で、NFC/NFD や末尾の空白1つだけが違う同じ文は `contested`（または `unresolved_conflict`）にならない。誤検出が減る側にしか変わらない。
  - **正規化しないもの**: NFKC（全角と半角など）、大文字小文字、内部の空白、ゼロ幅文字。それらが違う文は今までどおり別の文として扱う。
  - **誰が影響を受けるか / 移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目46。DB マイグレーションは無い。
  - 【確かめていないこと】実際の LLM の抽出結果で、NFC/NFD の違いがどれだけ起きているか。

- **`packDigestBand` が、1件の digest を書記素の境界で切り詰めるようになった**（[ADR 0424](./docs/decisions/0424-normalized-content-comparison-and-boundary-conformance.md)、[PR #1527](https://github.com/takecchi/mnemora/pull/1527)、探索の穴 O-5）。以前は UTF-16 コードユニットで切り（サロゲートペアの内側だけ避けていた）、NFD の「が」が「か」に、ZWJ で繋いだ絵文字が ZWJ だけになっていた。`Intl.Segmenter`（Node 22 の組み込み。依存は増えない）で、`maxEntryChars`（UTF-16 コードユニット）以下に収まる最長の書記素の並びを残す。
  - **振る舞いの変更**: 単位は変わらない。書記素の途中に当たった digest は、以前より短く（書記素1つぶん）切れる。最初の書記素だけで上限を超えると空文字列になる。上限以下の digest は変わらない。
  - **直していないもの**: `sliceWithoutSplittingSurrogatePair` の他の呼び出し元（`extraction.ts` のフォールバック digest、`failure-description.ts`）は書記素の途中でまだ切る。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目47。DB マイグレーションは無い。

- **適合テストに入力の境界の `it` が増え、`@mnemora/postgres` は DB の生の例外の代わりに明示の例外を投げるようになった**（[ADR 0424](./docs/decisions/0424-normalized-content-comparison-and-boundary-conformance.md)、[PR #1527](https://github.com/takecchi/mnemora/pull/1527)、探索の穴 O-6）。testkit と Postgres で揃っていなかった3つの境界を揃えた。
  1. **検索語の NUL**（`describeLexicalStoreConformance`）: `PostgresLexicalStore`・`PostgresTrigramLexicalStore`・`InMemoryLexicalStore` の `search` が、`query` に NUL を含むと `Error` で断る。以前は Postgres が生の DB の例外、インメモリは0件だった。
  2. **float4 に収まらない `vector` の成分**（`describeVectorStoreConformance`）: `upsert` が `RangeError` で断り、何も保存しない（以前は Postgres が生の DB の例外、インメモリは `Math.fround` で Infinity にして保存していた）。**検索のクエリは投げない**——`NaN`・`Infinity` と同じ「比較不能」として扱う（以前は Postgres が生の例外、インメモリは距離が `NaN`）。
  3. **`contentHash` の NUL**（`describeMemoryStoreConformance`）: `createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents`（その候補だけが落ちる）が `Error` で断る。以前は Postgres が生の DB の例外、インメモリは保存していた。
  - **誰が影響を受けるか**: 自前の `LexicalStore`・`VectorStore`・`MemoryStore` 実装を suite に当てている利用者（フラグ無しで走る）。`@mnemora/postgres` の生の DB の例外を捕まえていたコード。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目48。DB マイグレーションは無い。
  - 【確かめていないこと】自前の実装が実際にどれだけ落ちるか（`@mnemora/postgres`〈UTF8・SQL_ASCII〉とインメモリの実装が通ることだけを確かめた）。識別子（tenantId など）の NUL は扱っていない。

- **`EventStore.append`・`VectorStore.upsert` が、記憶が `ctx` のテナントに属さない（または実在しない）ときに例外を投げるようになった**（[ADR 0436](./docs/decisions/0436-event-vector-write-checks-memory-belongs-to-ctx-tenant.md)、`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）。クローン miku の決定（オーナーの判断ではない。[ADR 0398](./docs/decisions/0398-relation-store-link-checks-both-ends-belong-to-ctx-tenant.md) と同じ作法）。

  これまで `PostgresEventStore.append`・`PostgresVectorStore.upsert` は、`memoryId` の記憶が `ctx.tenantId` のものかを確かめず、別テナントの記憶 id を指す行を
  `ctx.tenantId` の行として書いた（外部キーは `memories(id)` だけでテナントを含まない）。その行が1本在ると、指された記憶のテナントの `eraseTenant` が
  `blocked_by_foreign_reference` で止まり、そのテナントは自分の記憶を消せなくなった。インメモリは元から断っていた。
  今は、書く前に確かめ、実在しない・別のテナントの記憶なら、**行を書かずに** `memory not found for tenant: <id>` を含むメッセージの `Error` を投げる。
  Postgres は確かめと書き込みを1つの SQL 文にしている。uuid でない id は DB へ投げる前に弾く。`append` は `memoryId` が `null` のイベント（`events_purged`）を検査しない。

  - **破壊的と数える理由**: 型・シグネチャは変わらないが、**以前は通っていた `append`・`upsert`（別テナントの記憶を指すもの）が、新しく例外になる**（実在しない uuid・uuid でない id は以前も落ちたが、外部キー違反・`Failed query` の生の DB エラーから、明示の例外に変わる）。項目21・23・24・27・34 と同じく、以前は通っていたものが通らなくなる変更を破壊的と数える。
  - **誰が影響を受けるか**: `EventStore.append`・`VectorStore.upsert` を直接呼ぶ利用者のうち、別テナントの記憶 id を渡しているもの。`Runtime` は同じ `ctx` で確かめた id しか渡さないので、`observe()`・`recall()`・`tick()` の挙動は変わらない。自前の `EventStore`・`VectorStore` を `describeEventStoreConformance`・`describeVectorStoreConformance` に当てている利用者は、新しい `it` が落ちうる（`prepareMemoryId(ctx)` が、渡した `ctx` のテナントの記憶を、`createStore()` の store から見える形で返すこと）。
  - **変えなかったこと**: DB のスキーマ・複合外部キー（理由は ADR 0436）。`MemoryStore.createMemory`・`recordUsage` の別テナントの id の扱い（[Issue #1051](https://github.com/takecchi/mnemora/issues/1051) の表の残り2行）。**既に書かれた食い違う行は消さない**（データの書き換えはオーナーの領分）。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目49。**DB マイグレーションは無い。**修正前に書かれた食い違う行（`memory_events`・`memory_embeddings_<space>`）が在るかを調べる SQL は ADR 0436 に在る（読み取りだけ）。
  - 【確かめていないこと】`PostgresMemoryStore` の中の `memory_events` への INSERT 11箇所が、別テナントの記憶を指さないこと（1つずつは確かめていない）。検査と INSERT の間に並行して記憶が消えた場合の、外部キー違反の生のエラーの見え方。手元以外の環境・既存データでの食い違う行の有無。

- **`TenantSettingsStore.getSubjectActivitySeqs` の `subjectIds` の各要素と、`MemoryStore.createRecall` の `advanceActivityClock.subjectId` に孤立サロゲートか NUL（U+0000）を含む値を、入口で `MalformedIdentifierError` で断るようになった。conformance suite に、これを検査する `it` が増えた——自前の store 実装を conformance suite に当てている人へ**（[ADR 0437](./docs/decisions/0437-helpers-params-subject-ids-repurge.md)、[ADR 0423](./docs/decisions/0423-identifier-well-formed-and-error-message-without-params.md) 決定4(b) の一覧の漏れ、`@mnemora/postgres`・`@mnemora/testkit`）。

  ADR 0423 が識別子の検査を掛けた口の一覧から、この2つの欄が漏れていた。NUL は Postgres で生の DB の例外（message に値が載る）、孤立サロゲートは通り、インメモリ実装は断らず Postgres と食い違っていた。今は、**書く・読む前に**、`field` を `subjectIds[i]`・`record.advanceActivityClock.subjectId` とする `MalformedIdentifierError` で断る。対をなすサロゲート（絵文字など）は、これまでどおり通る。
  - **破壊的と数える理由**: 型・シグネチャは変わらないが、**以前は通っていた入力が、新しく例外になる**。あわせて、conformance suite（`describeTenantSettingsStoreConformance`・`describeMemoryStoreConformance`）の判定が厳しくなり、この2つの欄を断らない自前の store は、新しく実行時に落ちる（ADR 0423 と同じ扱い）。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目50。DB マイグレーションは無い。
  - 【確かめていないこと】他に識別子を入力に持つ口が無いこと（機械では確かめていない）。

- **`MemoryStore` の書き込み口が、別の行を指す参照（`recordUsage` の `recallId`・`memoryIds`、`createMemory` 系の `sourceObservationId`・`contestedWithId`・`supersededById`、`updateStatus`・`updateStatusWithEvent`・`resolveContestedPair`・`resolveContestedGroup` の `supersededById`）の参照先が `ctx` のテナントの行でないとき、行を書かずに例外を投げるようになった。適合テストに、これを検査する `it` が増えた——自前の `MemoryStore` を適合テストに当てている人へ**（[ADR 0439](./docs/decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md)、`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）。クローン miku の委譲先の担い手が書いた（決めたのはクローンで、オーナーの判断ではない。[ADR 0398](./docs/decisions/0398-relation-store-link-checks-both-ends-belong-to-ctx-tenant.md)・[ADR 0436](./docs/decisions/0436-event-vector-write-checks-memory-belongs-to-ctx-tenant.md) と同じ作法）。

  これまで `PostgresMemoryStore` は、これらの参照先が `ctx.tenantId` の行かを確かめず、別テナントの id を指す行を `ctx.tenantId` の行として書いた（外部キーは `recalls(id)`・`memories(id)`・`observations(id)` だけでテナントを含まない）。
  その行は、指された側のテナントの `eraseTenant` を `blocked_by_foreign_reference` で止め、`recall_usages` が別テナントの recall を指す行は、指された側の `purgeExpiredRecalls` を生の外部キー違反（SQLSTATE 23503）で落とした（実測は ADR 0439）。Issue #854・#1051 は「読み取りの漏洩は無い」として検査を足さずに閉じたが、この害を見落としていた。
  今は、書く前に確かめ、実在しない・別のテナントの行・uuid の形でない id は、**何も書かずに** `PostgresMemoryStore: <recall|memory|observation> not found for tenant: <id>` の `Error` を投げる（区別しない）。Postgres は確かめと書き込みを1つの SQL 文にしている。
  `recordUsage` は1件でも違えば全体を書かない。`createMemoriesWithOutboxAndEvents` は、落ちた候補を `dropped` に積む（既存の扱い）。testkit の `InMemoryMemoryStore`・core の `FakeMemoryStore` もテナントを見る形に揃えた（message は `… not found for tenant: <id>`）。

  - **破壊的と数える理由**: 型・シグネチャは変わらないが、**以前は通っていた書き込み（別テナントの行を指すもの）が、新しく例外になる**（実在しない uuid・uuid でない id は以前も落ちたが、外部キー違反・`Failed query` の生の DB エラーから、明示の例外に変わる）。項目21・23・24・27・34・49 と同じく、以前は通っていたものが通らなくなる変更を破壊的と数える。加えて、適合テストの判定が厳しくなる変更（項目36・49 と同じ）でもある。
  - **誰が影響を受けるか**: `MemoryStore` の上の口を直接呼び、別テナントの id を渡している利用者。`Runtime` は同じ `ctx` で確かめた id しか渡さないので、`observe()`・`recall()`・`tick()`・`consolidate()` などの挙動は変わらない。自前の `MemoryStore` を `describeMemoryStoreConformance` に当てている利用者は、新しい `it` が落ちうる（`prepareRecallId(ctx)` が、渡した `ctx` のテナントの recall を、`createStore()` の store から見える形で返すこと）。
  - **変えなかったこと**: DB のスキーマ・複合外部キー（理由は ADR 0439）。**既に書かれた別テナントを指す行は消さない**（データの書き換えはオーナーの領分）。適合テストの `restoreSupersededBy`・`previewRestoreSupersededBy` の別テナントの `it` は、別テナントの anchor を指す行を API で作れなくなったので、仕込みを変えた（生 SQL の歯は `@mnemora/postgres` の個別のテストに移した）。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目51。**DB マイグレーションは無い。**修正前に書かれた、別テナントを指す行（`recall_usages`・`memories.source_observation_id`・`contested_with_id`・`superseded_by_id`）が在るかを調べる SQL は ADR 0439 に在る（読み取りだけ）。
  - 【確かめていないこと】`memory_events` への INSERT 11箇所（ADR 0436 から変わらず、1つずつは確かめていない）。検査と書き込みの間に並行して参照先が消えた場合の、外部キー違反の生のエラーの見え方。`FakeMemoryStore`（core）の検査を縛る歯（適合テストに当てられていない）。手元以外の環境・既存データでの食い違う行の有無。

- **差し替えた `TokenCounter` が、有限で 0 以上でない `tokens`（`NaN`・負の数・`Infinity`）か、壊れた戻り値を返すと、`recall()` が `RangeError` で断るようになった。以前は予算が黙って外れていた——自前の `TokenCounter` を `createRuntime` に渡している人へ**（[ADR 0497](./docs/decisions/0497-recall-rejects-broken-token-counter.md)、`@mnemora/core`）。

  以前は、`NaN`・負の数を返す counter では段4のトークン予算（`maxMemoryTokens`・`promptBudgetTokens`）が**黙って外れて全件が返り**（`budget_dropped` も出ない）、`Infinity` では全件が落ちた（[ADR 0483](./docs/decisions/0483-token-counter-broken-values.md)）。`RuntimeDeps.outputValidation: "off"` では何も知らされなかった。今は、`count()` の戻り値の `tokens` が有限で 0 以上の number でなければ（`NaN`・負の数・`±Infinity`・number でない値・戻り値の欠落）、`recall()` は `RangeError` で断る。message は値の種類だけを載せ、入力テキストは載せない。最初の壊れた値で止まる。予算が無くても（`usage` の計測で `count()` が呼ばれる）、`outputValidation` の値にかかわらず断る。

  - **変わらないこと**: 小数（`0.5`）は通る。`count()` が投げた例外は、これまでどおり包まずそのまま `recall()` の失敗になる。`counter` の欄の欠落・範囲外は断らず、これまでどおり `usage.counter` に出て `outputValidation` が知らせる。既定の `heuristicTokenCounter` は必ず通り、既定の挙動は変わらない。型・シグネチャ・公開 API は変わらない。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目55。**DB マイグレーションは無い。**

- **provider のコンストラクタと `createBullmqTickDriver` が、壊れた数値オプションを構築時に例外で断るようになった（`@mnemora/bullmq`・`@mnemora/openai`・`@mnemora/anthropic`・`@mnemora/local-embedding`）**（[ADR 0498](./docs/decisions/0498-constructor-config-checks.md)。[ADR 0477](./docs/decisions/0477-bullmq-tick-driver-everyms-jobname-queuename-not-checked.md) の案1・[ADR 0467](./docs/decisions/0467-recall-footprint-nonfinite-inputs-fallback-digest-grapheme.md) の面C を、オーナーが v1.X.0 での破壊的変更を許したので採った）

  以前は壊れた値が黙って通り、API・BullMQ に渡ってから失敗する（または静かに止まる）か、`space.dimensions` に壊れた値が入った。今は構築時（`new`・`createBullmqTickDriver(...)`）に断る。型が違えば `TypeError`、数として不正なら `RangeError`（`@mnemora/bullmq` は `resolveConcurrency` と同じ素の `Error`）。message に値が入る（数値・名前で、秘密ではない）。**省略時の既定は変えない。**
  - **`@mnemora/bullmq`**: `everyMs` は数・有限・`1` 以上・`Number.MAX_SAFE_INTEGER` 以下でなければ投げる（小数 `1.5` は通す。数値の文字列 `"50"` は断る）。`jobName` は省略（既定 `"mnemora-tick"`）か空でない文字列でなければ投げる。**以前は、負・`1` 未満の小数・`1e21` 以上の `everyMs` と空文字の `jobName` で、`start()` が成功したまま tick が数回（1回）で黙って止まり、`onTickError` も鳴らなかった**（ADR 0477 の実測）。`queueName` は BullMQ が同期的に投げるので触らない。
  - **`@mnemora/openai`**: `OpenAIEmbeddingProvider` の `dimensions` は正の安全な整数、`OpenAILLMProvider` の `temperature`（渡すなら）は有限で `0` 以上でなければ投げる（上限は API ごとに違うので見ない）。
  - **`@mnemora/anthropic`**: `AnthropicLLMProvider` の `maxTokens`（渡すなら）は正の安全な整数でなければ投げる。この provider に `temperature` の欄は無い。
  - **`@mnemora/local-embedding`**: `LocalEmbeddingProvider` の `dimensions`・`numThreads`（渡すなら）は正の安全な整数でなければ投げる。`maxBatchSize`・`retry.attempts` は、今までどおり丸める（投げない）。
  - **破壊的と数える理由**: 型・シグネチャは変わらないが、**以前は構築できた入力が、新しく例外になる**。公開の型・export は増えない（検査は各パッケージの内部）。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目56。DB マイグレーションは無い。

### Added

- **recall の埋め込みが失敗したとき、`stage_skipped(candidate_generation, embedding_provider_unavailable)` に、原因の種類を返す任意の欄 `cause` を足した**（[PR #1504](https://github.com/takecchi/mnemora/pull/1504)）。`cause.kind` は `provider_threw`・`no_vector`・`dimension_mismatch`・`non_finite`。`provider_threw` のときだけ、投げられた値の文字列の `kind` を `providerErrorKind`、`Error` の `name` を `errorName` に載せる。**error の message・ベクトルの値は載せない。**既存の欄・値と、語彙検索へ劣化して続ける振る舞いは変えていない。
  ⭕ 非破壊と数える（任意欄の追加のみ）。
- **`RelationStore` に任意メソッド `listRelatedMany?(ctx, memoryIds, kind?)` を足した。`Runtime` の幅優先探索（recall 段3の群の同伴取得・`resolveContestedGroup` の部分解消の確認・claim key の群の検出）は、1段の起点をまるごとこれに渡して1往復で読む**（[Issue #1449](https://github.com/takecchi/mnemora/issues/1449) 案A、[ADR 0402](./docs/decisions/0402-relation-store-list-related-many.md)。案D・案E は [ADR 0401](./docs/decisions/0401-mark-resolve-contested-group-constant-statements.md)）。
  - `result[i]` は `listRelated(ctx, memoryIds[i], kind)` と同じ集合（位置で対応。重複した id は同じ内容、実在しない id は空配列）。`@mnemora/postgres`（`PostgresRelationStore`、`from_memory_id = ANY(...)` の1文）と `@mnemora/testkit`（`InMemoryRelationStore`）が実装する。**実装しない adapter では、`Runtime` は今までどおり `listRelated` を起点ごとに直列に呼ぶ**——結果（提示順・`companionOf`・`omitted`・resolve の outcome）は、あるときと無いときで完全に一致する（歯で縛っている）。
  - `@mnemora/testkit` の `describeRelationStoreConformance` に、任意フラグ `implementsListRelatedMany?: boolean` を足した。実装が有れば宣言に依らず契約の節がかかり、実装が無ければ skip、`true` を宣言して実装が無ければ赤。
  - 【実測】関係の行 112,080 行・Postgres 17・loopback・15回の中央値: recall 段3（幅60の群）は文が 75 → 17（関係の SELECT は 60 → 2）、31〜43 → 19 ms。resolve の部分解消の確認（幅316の群、先頭100件を渡す）は文が 318 → 4（関係の SELECT は 316 → 2）、235〜241 → 155〜163 ms。鎖のように1段が1件の形は往復が減らない。claim key の群の検出の時間と、往復の遅延が大きい構成は測っていない。
  ⭕ 非破壊と数える（任意メソッドと任意のフラグの追加のみ）。
- **古い `recalls` と完了済みの `outbox` 行を消す任意メソッド `MemoryStore.purgeExpiredRecalls?` と `OutboxStore.purgeCompletedJobs?` を足した**（[ADR 0404](./docs/decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md)、[PR #1479](https://github.com/takecchi/mnemora/pull/1479)）。`purgeExpiredEvents?` と同じ形で、`olderThan` と `limit` は呼び出し側が必ず渡す（**保持期間の既定値は無い**）。`purgeExpiredRecalls?` は `created_at < olderThan` の `recalls` をその `recall_usages` ごと同一トランザクションで消す（**消した `recallId` への `recordUsage` は例外になる**）。`purgeCompletedJobs?` は `completed_at < olderThan` の完了済みの行**だけ**を消し、claim 中・未処理・`failed` の行は消さない。**`recalls.query` を約束の範囲に入れるか、`failed` 行の扱い、既定の保持期間は決めていない**（オーナーに聞く事柄）。新しい型は `PurgeExpiredRecallsOptions`/`PurgeExpiredRecallsResult`/`PurgeCompletedJobsOptions`/`PurgeCompletedJobsResult`。`@mnemora/testkit` の `describeMemoryStoreConformance`/`describeOutboxStoreConformance` に任意フラグ `supportsPurgeExpiredRecalls?`/`supportsPurgeCompletedJobs?` が増えた（省略可・3状態。**非破壊**。省略すると「⚠ 未検査」の `it` が1本増える）。**DB マイグレーションは増えない**（索引を足さない判断と測った数字は ADR 0404）。

- **`RecallQuery.relationMaxCount?`（任意、正の整数 1〜1000）を足した**（[Issue #1449](https://github.com/takecchi/mnemora/issues/1449) 項目8、[PR #1470](https://github.com/takecchi/mnemora/pull/1470)、[ADR 0396](./docs/decisions/0396-recall-relation-max-count.md)）。段3（`contradiction_resolution`）の多者間の `contested` 群の同伴取得について、群ごとの上限件数を呼び出し側から変えられる。超えた分は従来どおり `over_limit { stage: "relation" }` に積まれる。探索の安全弁（群ごとに訪れた数の上限）はこの値の10倍に連動する。**省略すると従来の10（安全弁は100）のままで、`recall()` の結果は1バイトも変わらない。**型は任意の欄1つの追加のみで、DB マイグレーションは伴わない（`recalls.query` は jsonb にそのまま入る）。ADR 0381 §5.3・§6 の「専用のクエリ欄は作らない」を覆した。

- **`@mnemora/postgres` に、`listActiveClaimPredicates` 用の部分索引 `idx_memories_claim_predicates` を足す migration `0029_memories_claim_predicates_index.sql` を足した**（[PR #1457](https://github.com/takecchi/mnemora/pull/1457)、[ADR 0329](./docs/decisions/0329-claim-key-known-predicates-from-store.md) の2026-09-30追記）。`(tenant_id, subject_id, claim_key_predicate, created_at)` の部分索引（`WHERE status = 'active' AND claim_key_subject IS NOT NULL AND claim_key_predicate IS NOT NULL`）。SQL と振る舞いは変えない。**DB マイグレーション**: 要る（`mnemora-postgres-migrate` か `runMigrations`）。索引作成の間、`memories` への書き込みは止まる（素の `CREATE INDEX`）。100万行・visibility map が all-visible の測定で、`listActiveClaimPredicates` の中央値は 3.52ms から 1.63ms（10万行では差があるとは言えない）。数字と測っていないことは ADR に書いた。
- **`@mnemora/postgres` に `createOptionalTrigramIndexConcurrently(db)` を足した**（[PR #1457](https://github.com/takecchi/mnemora/pull/1457)、[ADR 0319](./docs/decisions/0319-optional-trigram-lexical-store.md) の2026-09-30追記）。`createOptionalTrigramIndex` と同じ形の索引 `idx_memories_trigram` を、`CREATE INDEX CONCURRENTLY` で（`memories` への書き込みを止めずに）張る。トランザクションの外で呼ぶこと。前回の失敗で `indisvalid = false` の同名索引が残っていれば、`DROP INDEX CONCURRENTLY` で消してから作り直す。既存の `createOptionalTrigramIndex` は変わらない（公開 API は追加のみ）。⚠ 複数の呼び出し元が同時に呼んだときの競合は防いでいない。
- **`@mnemora/testkit` の `describeMemoryStoreConformance` に、`reinforce`/`reinforceMany?` が `memory_events` を1行も書かないことを検査する `it` を足した**（[Issue #871](https://github.com/takecchi/mnemora/issues/871)、[PR #1452](https://github.com/takecchi/mnemora/pull/1452)。`docs/memory-model.md` §11 行4 が約束していた振る舞いに、対応する歯が無かった。クローン miku の委譲先の判断であり、オーナーの判断ではない）——自前の `MemoryStore` 実装を conformance suite に当てている外部 adapter 実装者にも、この約束が効くようになる。⚠ **この `it` はフラグ無しで走るので、破壊的変更として上の `### Breaking` に数えた**（移行は [docs/migration-v1.md](./docs/migration-v1.md) の項目37）。
- **多者間（3件以上）の `contested` を表す関係グラフ `memory_relations` と、それを書く・読む口を足した**（[Issue #207](https://github.com/takecchi/mnemora/issues/207)/[Issue #933](https://github.com/takecchi/mnemora/issues/933) PR2、[PR #1442](https://github.com/takecchi/mnemora/pull/1442)、[ADR 0292](./docs/decisions/0292-relation-graph-table-depth-omitted-design.md)、[ADR 0327](./docs/decisions/0327-relation-graph-contested-write-path-design.md)、[ADR 0378](./docs/decisions/0378-claim-key-contested-detection-covers-contested-matches.md)、[ADR 0381](./docs/decisions/0381-contested-group-write-path-implementation.md)。クローン miku の委譲先の判断であり、オーナーの判断ではない）——`markContested`/`resolveContested` は1対1の対にしか対応せず、1つの記憶が複数の記憶と同時に争われる場合を表せなかった。
  - **新しい migration `0026_memory_relations.sql`。** `memory_relations`（`kind` は当面 `'contradicts'` の1値。1組につき向きを変えて2行）を新設する。2者の対は今までどおり `contested_with_id` の列で持ち、既存のデータは動かさない。
  - **新しい interface `RelationStore`（`link`/`unlink`/`listRelated`）。** `@mnemora/postgres`（`PostgresRelationStore`）・`@mnemora/testkit`（`InMemoryRelationStore`）が実装する。配線は任意（`RuntimeDeps.relationStore?`）。
  - **`MemoryStore` と `Runtime` に任意メソッド `markContestedGroup?`/`resolveContestedGroup?`（`markContested`/`resolveContested` の N者版）。** 関係の行は、有効期間が重なる組の間にだけ張る。対に3件目が来たら、対の列を空にして群へ移す。群どうしが一致したら合併する。解消（`supersede` と `both_active`）では関係の行も消す。
  - **`Runtime.observe()` の claim key 衝突検出**: `detectContested` が on で `RelationStore` が配線されていれば、一致が2件以上（または `contested` の1件だけ）のとき、記録だけを積む代わりに群として書き込み、`ContestedDetectionOutcome.result` に `"contested_group"` を返す。`RelationStore` を配線しない呼び出しは、1バイトも変わらない。
  - **recall の段3（対立する記憶を必ず並べて出す）が、群にも効くようになった。** 関係の行でつながった全員を幅優先でたどり、群ごとに10件（`DEFAULT_RECALL_ASSOCIATION.maxCount`）まで、`validFrom` の新しい順・同じなら id の順に残して並べる。切った件数は群ごとに `over_limit { stage: "relation" }` に出す。`RelationStore` が配線されていなければ `stage_skipped { stage: "relation" }` を出す。
  - **conformance suite**: `describeMemoryStoreConformance` に、新しい任意メソッド `markContestedGroup?`/`resolveContestedGroup?` を検査する `it` と、任意フラグ `supportsMarkContestedGroup?`/`supportsResolveContestedGroup?`（既存の3状態フラグと同じ形）が増えた。群の一部だけを渡した `resolveContestedGroup?` を専用のエラー `ContestedGroupMembershipMismatchError`（新設）で拒む約束と、有効期間の重なりの境目（半開区間）の約束も検査する。新設の `describeRelationStoreConformance` が、`RelationStore` の実装を検査する。影響を受けうるのは、上の2つの任意フラグを `true` で渡しているのに口を実装していない自前の実装だけである。
  - ⭕ 次も非破壊と数える（union に値を足す変更。オーナーの回答 ask_human `d9364c91`）: `ContestedDetectionOutcome.result` の `"contested_group"`、`Omission` の `over_limit`/`stage_skipped` の `stage` の `"relation"`。網羅的な `switch` でこれらの型を扱っているコードは型検査が落ちうる。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目29。**DB マイグレーション**: 新しい migration `0026_memory_relations.sql` が1本増える（`mnemora-postgres-migrate` か `runMigrations` を打つこと）。
  - ⭕ 非破壊と数える（どれも省略可能）。⚠ 2026-10-01 に数え直した: conformance suite の分は、書いた当初は `### Breaking` に数えていた。足した `it` は新しい任意フラグの内側にだけあり、口もフラグも持たない adapter に新しい約束を課さないので、[PR #1516](https://github.com/takecchi/mnemora/pull/1516) が #1507 で採った判定と、同じ版の任意フラグの追加（`implementsListRelatedMany?`・`supportsPurgeExpiredRecalls?` など）に揃えて、ここへ移した。
- **`RecallQuery` に `scopeAggregate?: "exact" | "skip"` を足した**（[PR #1455](https://github.com/takecchi/mnemora/pull/1455)、[ADR 0384](./docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md) 案C）——`recall()` のたびに条件なしで呼ばれる `MemoryStore.aggregateScope` の件数集計（`GROUP BY subject_id`、100万行で約1.1〜1.3秒を占める支配項）を、呼び出し側が明示的に選んだときだけ止められるようにした。
  - **既定は省略時と同じ `"exact"`——1バイトも変わらない。** `"skip"` を渡すと `IndexBand.groups` は空・`totalInScope` は `0`・`countKind` は `'unknown'` になり、`omitted` の `filtered(archived/superseded/forgotten/period/expired/not_yet_valid/taxonomy/decayed)` は一切積まれなくなる——「スコープ内で何が落ちたか」の説明力を手放す代わりに集計の費用を払わない、という明示的な取引。**`ann_unreached` も判定されない**——判定の母数（`totalInScope` − 未索引）が `0` になるため、近似索引が取りこぼしていても鳴らない。`"skip"` で `ann_unreached` が無いことは「拾いきった」を意味しない（ADR 0384「決めたこと」7）。
  - **目次帯（`digestBand`）は `"skip"` でも今日どおり出る**（集計とは独立した経路で、同じ PR の案A の索引が支える）。`digestEligible`（帯の外にあと何件あるか）だけは件数の一種なので、`digestBand` を指定した呼び出しに限り `{ count: 0, countKind: 'unknown' }` になる。
  - **`AggregateScopeOptions.scopeAggregate` を読まない adapter は、`"skip"` を頼まれても `countKind: 'exact'` を返してしまう**（[ADR 0024](./docs/decisions/0024-remove-exact-counts-option.md) の「値を受け取って黙って無視する」事故の形）。⚠ **conformance suite は、この形を許さない。** `describeMemoryStoreConformance` は、フラグ無しの `it` で `aggregateScope(ctx, {}, { scopeAggregate: "skip" })` の結果が `groups` 空・`totalInScope` `0`・`countKind: 'unknown'` であることを検査する（`countScopeAggregateQueries` フックを渡したときだけ、集計クエリが実際に0本であることまで検査する）。したがって、`scopeAggregate` を実装しない自前の adapter は suite を当てると落ちる。`@mnemora/postgres`・`@mnemora/testkit` はこの版で対応済み。この suite の要件強化は上の `### Breaking` に数えた（移行は [docs/migration-v1.md](./docs/migration-v1.md) の項目38）。
  - 【実測】100万行・`max_parallel_workers_per_gather=0`・同時1・warm（12往復、1点ごとに別プロセス）: 案A の索引ありの `"exact"` は p50 627.7ms、`"skip"` は p50 1.5ms。往復ごとの差（skip − exact）の中央値は −644.6ms（IQR −671.1〜−541.9ms、最小〜最大 −681.3〜−504.6ms、12往復すべて負）。10万行は cold（Postgres 再起動直後）・warm-after とも `"skip"` は p50 6.6ms・1.2ms。器・手順・限界は ADR 0384「測ったこと」。
  ⭕ `RecallQuery` の型の側は非破壊と数える（新しい任意の欄1つの追加のみ。既存の呼び出しは1行も直さず通る）。⚠ **ただし conformance suite の側は、フラグ無しの `it` が `MemoryStore.aggregateScope` の実装に新しい約束を課すので、上の `### Breaking` に数えた。**
- **抽出の言語の事後検査を足した——日本語の観測から、かな・漢字の無い（ラテン文字の）本文が出たら、`created` イベントの `meta.languageMismatch` に印を付ける**（[Issue #1370](https://github.com/takecchi/mnemora/issues/1370)、[ADR 0391](./docs/decisions/0391-language-mismatch-mark-on-created-event.md)）。sync・deferred・`reextract` のすべての抽出経路で効く。
  - **印を付けるだけ**——再試行も全文フォールバックもしない。Memory の作り方、プロンプト、公開の型は変えない。疑いが無いときの `created` の `meta` は今までどおり。
  - ⚠ 閾値は推論で置いたもので、**実データでの偽陽性率は測っていない**。意図して英語で書かせる使い方では印が常に付きうる。
  ⭕ 非破壊と数える（既存のイベントの `meta`（自由形式）への任意のキーの追加のみ。型・DB は変えない）。

- **`runtime.purge` の `"purged"`／`"already_purged"` outcome に、任意の欄 `embeddingCleanup?: { status: "failed"; error: string }` を足した**（[ADR 0382](./docs/decisions/0382-vector-store-delete-across-spaces.md)「引き受けた負債」1、[PR #1475](https://github.com/takecchi/mnemora/pull/1475)、[ADR 0399](./docs/decisions/0399-purge-embedding-cleanup-outcome-field.md)）。埋め込み行の後始末（`deleteAcrossSpaces`）が失敗したときだけ付き、`kind` は変わらない。成功時はプロパティ自体が無く、出力は変わらない。⭕ 非破壊と数える（任意欄の追加のみ）。
  - 2026-09-30 追記: ADR 0399 は握りつぶしを2箇所と数えたが、競合の後に再読して `already_purged` になる枝にも3つ目が残っていた。そこも失敗したら同じ `embeddingCleanup` を付けるようにした（ADR 0399 の追記）。
- **`@mnemora/testkit` の `describeVectorStoreConformance` に、任意フラグ `supportsSearchMany?: boolean` を足した。`InMemoryVectorStore` に `searchMany` を実装した**（[Issue #1412](https://github.com/takecchi/mnemora/issues/1412) の続き）。
  - `VectorStore.searchMany?`（任意メソッド）の契約——各 key の結果が単独の `search()` と集合・順序とも一致する、同点の並び、`limit` を超えない、0件でも key が Map に在る、空 `queries` は空 Map、同じ key は後勝ち、NUL を含む key でも投げない、不正な `limit` は `search()` と同じく投げる、`filter`・テナント分離——を検査する歯が、これまで無かった。フラグは `supportsListActiveClaimPredicates?` と同じ3状態（`true` は歯を実行、`false` は `searchMany` が無いことを assert、省略は「⚠ 未検査」の named it を1本）。
  - ⚠ **自前の `VectorStore` に `searchMany` を実装していて `supportsSearchMany: true` を渡す人へ**: 契約に反していれば、この歯で新しく赤になりうる。フラグを渡さなければ何も変わらない（型も壊れない）。
  ⭕ 非破壊と数える（新しい任意の欄1つと、fixture への任意メソッドの追加のみ）。
- **`@mnemora/local-embedding` の `LocalEmbeddingProvider` に、任意メソッド `dispose(): Promise<void>` を足した**（[ADR 0419](./docs/decisions/0419-local-embedding-provider-dispose.md)）。読み込んだモデル（ONNX のセッション）を、上流 `@huggingface/transformers` の `dispose()` に委ねて手放す。読み込み中・推論中に呼ぶと、それらの完了を待ってから解放する。一度も読み込んでいなければ何もせず、2回呼んでも安全（上流の `dispose()` は1回）。**呼んだ後の `embed()` / `warmup()` は、入力に依らず（空配列でも）例外になる。**`EmbeddingProvider`（core の interface）には載せていない。`LocalEmbeddingPipeline`（`createPipeline` の注入口）にも任意の `dispose?()` を足した（持たなくてよい）。
  ⭕ 非破壊と数える（任意メソッド・任意欄の追加のみ）。

- **`MemoryStore` に任意メソッド `scrubPurged?(ctx, memoryIds)` を、`runtime.purge` の `"already_purged"` outcome に任意の欄 `residueCleanup?: { status: "failed"; error: string }` を、`@mnemora/testkit` の `describeMemoryStoreConformance` に任意の `supportsScrubPurged?`・`seedLegacyPurgedRow?` を足した**（[ADR 0437](./docs/decisions/0437-helpers-params-subject-ids-repurge.md) 決定3。下の Fixed の項目と対）。
  - `scrubPurged` は、既に purge 済みの行（`status = 'forgotten'` かつ `purgedAt` が非 `null`）だけを対象に、`tags`・`attributes`・claim key・label の紐付けを消し、`proposed` な label の `proposedCount` を外した本数だけ減らす（べき等。監査イベントは積まない）。`Runtime.purge` が `already_purged`（`dryRun` でないとき）に、`deleteAcrossSpaces` と並べてベストエフォートで呼ぶ。失敗しても `kind` は変わらず、`residueCleanup` だけが付く。`@mnemora/postgres` とインメモリ実装が実装した。
  ⭕ 非破壊と数える（任意メソッド・任意の欄・任意フラグの追加のみ。`supportsScrubPurged` を省略した既存の呼び出し側には「⚠ 未検査」の named it が1本増えるだけ）。

### Changed（後方互換だが挙動が変わりうるもの）

- **`@mnemora/core`・`@mnemora/postgres` の README に「TypeScript の `lib`・`target` は ES2022 以上」を書いた**（[ADR 0441](./docs/decisions/0441-changelog-migration-refs-consumer-smoke-names.md)）。公開の `.d.ts` が `ErrorOptions`（ES2022 の lib）を使うため、ES2021 以下だと `skipLibCheck: false` で `TS2304`、`skipLibCheck: true` で `cause` の型が失われる。コードは変えていない。
  ⭕ 非破壊と数える（文書の追記のみ）。
- **`Runtime` が投げ直す例外の message から、SQL に付けた値（params）を落とすようになった**（[ADR 0423](./docs/decisions/0423-identifier-well-formed-and-error-message-without-params.md)、`@mnemora/core`。[ADR 0363](./docs/decisions/0363-outbox-last-error-omit-params-and-cap-length.md)・[Issue #1064](https://github.com/takecchi/mnemora/issues/1064) と同じ作法）。

  drizzle が包んだ失敗（`Failed query: <SQL>\nparams: <値>`）の message には、SQL に渡した値（本文を含む）がそのまま入っていた。`Runtime` の全メソッド（`observe`・`recall` など）が、store などが投げた例外の message を、SQL の文を残したまま `params:` の値だけを落とした形（`(omitted by mnemora, N chars)`）にしてから投げ直す。**例外は新しく作らず、その場で書き換える**ので、`kind`・`name`・`cause`・独自の欄は残る。`stack` の先頭の message も同じく書き換える。

  - **破壊的と数えない理由**: 型・例外の種類は変わらない。変わるのは message の文字列の後半だけである。message の `params:` 以降を読んで処理している呼び出し側は、値を読めなくなる。
  - **変えなかったこと**: `DrizzleQueryError` の `params` プロパティ、`cause`（pg のエラー）の `message`・`detail`。store を `Runtime` を通さずに直接呼んだときの例外。

- **`PostgresMemoryStore.markContestedGroup` / `resolveContestedGroup` が、群の大きさ N に依らない定数個の SQL 文で書くようになった。関係の行の INSERT は、実表どうしの N² の結合をやめた**（[Issue #1449](https://github.com/takecchi/mnemora/issues/1449) 1-A の案D・案E、[ADR 0401](./docs/decisions/0401-mark-resolve-contested-group-constant-statements.md)）。
  - 【実測】鎖1000の mark は 2806 → 321 ms（文は 2005 → 7）、resolve は 1724 → 568 ms、`observe` 経由の検出は 5129 → 2770 ms。完全グラフ1000（作る行が999,000行）の mark は差が出ていない（約56秒のまま）。前後の表・測定の条件・器のノイズは ADR 0401。
  - **観測できる振る舞いは変えていない**: 作る関係の行の集合（有効期間の半開区間・マイクロ秒精度の境目を含む）、`MemoryStatusConflictError` が指す id（複数のメンバーが外れているときは入力順で最初）、返り値の並び。歯は ADR 0401。公開の型・port・DB マイグレーションは変えていない。

- **`PostgresMemoryStore.createRecall` が、活動時計を進めるとき（`decay_clock != 'wall'`）、`recalls` の INSERT とカウンタ（`tenant_activity`／`tenant_subject_activity`）の UPSERT を1つの SQL 文で撃つようになった**（[ADR 0395](./docs/decisions/0395-create-recall-activity-clock-single-statement.md)、[ADR 0165](./docs/decisions/0165-decay-activity-clock.md) 負債1）。意味（1 recall = 1 単位、recalls の行とカウンタが同じ原子性）・返り値・公開 API・スキーマは変わらない。狙いは、同じテナントへの同時 createRecall がカウンタの行で直列になる時間のうち、クライアントとの往復1回分を減らすこと。**「速くなった」とは言わない**——共有器での実測（各点3回・前後交互）は、器のノイズ（±20〜30%）に埋もれて効果を示せていない（subject 単位の行は3つの並列度すべてで中央値が後の側、activity_T の並列度16・32 は同等以下）。ホット行そのものは残る。カウンタを16行に分ける案は採らなかった。

- **活動時計（`decay_clock` が `'activity'`/`'either'`）で、新しく作る記憶・強化する記憶の起点（`decayBaseSeq`/`decayFloorSeq`）を、`ctx.subjectId` ではなく、その記憶自身の subject の `T + S_x` で書くようになった**（[ADR 0394](./docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md)、[ADR 0353](./docs/decisions/0353-activity-counting-per-call.md) 引き受けた負債1、[Issue #338](https://github.com/takecchi/mnemora/issues/338)）
  - **効くのは `tenant_subject_activity` に行があるテナント（`activityCounting: "subject"` を使ったテナント）だけ。**それ以外（`'wall'` のテナント、subject カウンタを一度も使っていないテナント）の書き込みは、値も SQL も変わらない。
  - 直った経路: 抽出（同期・deferred の `tick`・`reextract`。ctx と候補・観測の subject がずれるとき、`tick` の ctx に subject が無いとき）、consolidate・reflect、使用報告の強化、`restoreArchived`・`restoreSuperseded`。以前は、ずれると読む側（行ごとに自身の `S_x` を足す）より小さい起点が書かれ、作成・強化の直後から忘却ゲートの下にいることがあった。
  - **公開 API に、任意項目 `ReinforceOptions.addOwnSubjectSeq?: boolean` と、任意メソッド `MemoryStore.supportsAddOwnSubjectSeq?(): boolean`（store の宣言）が増えた。**`true` を宣言する store にだけ、runtime は `nowSeq` に `T` を入れて `addOwnSubjectSeq: true` を渡し、store が行ごとに Memory 自身の subject の `S_x` を足す。宣言の無い store には、今までどおり `T + S_ctx` をフラグなしの `nowSeq` で渡す。非破壊。`@mnemora/postgres` の `PostgresMemoryStore` と `@mnemora/testkit` の `InMemoryMemoryStore` は宣言している。
  - ⚠ **自前の `MemoryStore` を実装している人へ**: 何もしなくてよい（宣言が無ければ、強化は今までと同じ値で呼ばれる）。ただし、強化される記憶の subject が `ctx.subjectId` とずれる呼び出しの取り違え（強化側）は、宣言しない実装では直らない。直すには、`reinforce`/`reinforceMany`（と `recordUsageAndReinforce`）が `addOwnSubjectSeq: true` を読むようにし、`supportsAddOwnSubjectSeq() { return true; }` を足す。`describeMemoryStoreConformance` は、宣言した実装にだけ、この項目の歯を当てる。
  - 既に書かれた起点を遡って直してはいない（強化・再作成で置き換わる）。DB マイグレーションは足していない。

- **多者間の `contested` 群の recall で、`companionOf`（同じ段で複数の親から届く companion の発見元）が「id の小さい親」に決まるようになった。`Runtime.resolveContestedGroup` の `winnerId` が、`resolveContested`（2者版）と同じ規則で大文字小文字を救済するようになった**（[Issue #1449](https://github.com/takecchi/mnemora/issues/1449) 項目7・項目6、[ADR 0381](./docs/decisions/0381-contested-group-write-path-implementation.md) §7 負債3・負債1の解消）。
  - `companionOf` は説明可能性の欄だけが変わる（`memories`/`omitted` の中身・件数は変わらない）。以前は `RelationStore.listRelated`（契約が順を規定しない）の返す順に依存していた。
  - `resolveContestedGroup` は、`winnerId` が `memberIds` のどれとも完全一致しないとき、小文字にそろえた候補がちょうど1件で、`memoryStore.get` が同じ id の記憶を返す場合に限り、その `memberIds` の綴りを勝者として使う。以前はこの場合 `RangeError` だった。候補が2件以上・`get` が食い違う場合は今どおり `RangeError`。エラーだった呼び出しが通るようになるだけで、通っていた呼び出しの結果は変わらない。

- **`excludeProvenanceKinds` を指定した recall の `ann_unreached` の判定が、除外した kind の行を母数に数えなくなった。`scopeAggregate: "skip"` の recall は、ANN の到達を判定できないと名乗るようになった**（[PR #1458](https://github.com/takecchi/mnemora/pull/1458)、[ADR 0390](./docs/decisions/0390-ann-unreached-aware-of-excluded-provenance-and-skip.md)）——除外指定のとき、ANN が取りこぼしても `severity: "info"` のまま・診断キーも付かず（黙る）、除外しない候補を全部拾えても鳴る（鳴りすぎ）、という2つの誤りを直した。`AggregateScopeOptions.excludeProvenanceKinds?` と `ScopeAggregate.excludedProvenanceIndexedCount?`（除外される kind で、スコープ内の索引済みの行の数）を足し（どちらも任意の欄。`totalInScope`・`groups`・`filtered*` の意味は変えない）、`@mnemora/postgres`・`@mnemora/testkit` の `InMemoryMemoryStore` が実装した。
  - **既定は変わらない**: 除外指定なし・欄を返さない自作 adapter・`scopeAggregate: "exact"` の recall の出力は1バイトも変わらない。Postgres の SQL も、除外指定（非空）のときだけ列を足す。**除外指定のある recall の `omitted`（`ann_unreached` の有無・severity）と `explain.stages` の診断キーは、欄を返す adapter では変わる**（変わる向きは、取りこぼしを名乗る・鳴りすぎを止める）。
  - `scopeAggregate: "skip"` で ANN の段が走り、adapter が `countKind: 'unknown'` を返したときは、ANN の stage detail に `annReachability: "unknown"`（到達を判定できない）が付く。`ann_unreached` が鳴らないこと自体は変わらない——**キーが付いているときの「無い」は「拾いきった」ではない**（[ADR 0384](./docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md) 「決めたこと」7 の手当て）。
  - 非破壊（追加の任意欄のみ）。DB マイグレーションは足していない。`filteredDecayed` に除外行が混ざって下限が小さくなる側へずれるのは、偽陽性を出さない側として許容した（ADR 0390 決定6）。

- **抽出（`subjectCandidates` を渡し、`extractionContext` を渡さず、観測に `payload.speaker` がある呼び出しに限る）で、LLM への user 入力の本文の前に `話者（speaker）: <値>` と空行が足される**（[Issue #1370](https://github.com/takecchi/mnemora/issues/1370) PR1、[ADR 0348](./docs/decisions/0348-extraction-language-and-speaker-instruction-gated-on-subject-candidates.md) 末尾の 2026-09-30 追記）——[PR #1374](https://github.com/takecchi/mnemora/pull/1374) が候補経路の system に足した話者の一文は「本文の先頭の話者ラベル、または speaker」と言うが、この経路の入力には `speaker` が出ていなかった。一文を本当にするための変更。
  - **変えていない経路**: `subjectCandidates` 省略・空配列の呼び出し（既定経路）と、`extractionContext` を渡す呼び出し（候補の有無を問わない。JSON の `observation.speaker` に既に出ている）は、system・user とも1バイトも変わらない。録音（カセット、Issue #704）の鍵は動かない。
  - **`RuntimeConfig.promptVersion` を上げることを勧める**（[#1374](https://github.com/takecchi/mnemora/pull/1374) と同じ扱い。この経路の LLM への入力が変わるため、抽出結果が変わりうる）。上の経路に当たらない利用者は上げなくてよい。
  - 実 API での効果は未測定。

- **`@mnemora/postgres` の `aggregateScope` が、目次帯（`digestBand`）を組むときの内部の索引の使い方だけを変えた**（[PR #1455](https://github.com/takecchi/mnemora/pull/1455)、[ADR 0384](./docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md) 案A）——`ORDER BY COALESCE(occurred_at, recorded_at) DESC, id DESC LIMIT n` を支える部分索引 `idx_memories_digest_band`（新しい migration `0028_digest_band_index.sql`）を足した。**SQL 文・返り値の中身/順序/件数は1バイトも変えていない**——索引を追加しただけである。
  - 【実測】`main`（案A の前）とこの枝を、同じデータ・同じ器で12往復、1点ごとに別プロセスで交互に測った（`max_parallel_workers_per_gather=0`・同時1・digestBand込み）。往復ごとの差（後 − 前）の中央値: 100万行 warm の p50 は −284.0ms（IQR −308.0〜−250.3ms、最小〜最大 −353.3〜−221.8ms、12往復すべて負。p50 の絶対値は前 930.4ms・後 627.7ms）。10万行は cold（Postgres 再起動直後の1回目）で −31.4ms（IQR −36.0〜−25.1ms）、warm-after の p50 で −27.5ms（IQR −29.6〜−23.1ms）。器は共有で、絶対値は測る時刻の負荷で動く。EXPLAIN では `digestBand` 側の `Seq Scan` + top-N `Sort`（349.5ms）が `Index Scan`（0.104ms）に置き換わった。テナント全体を `GROUP BY subject_id` で束ねる本体（支配項）は変わっていない。cold は OS のページキャッシュが残る近似で、真の cold は測っていない（詳細は ADR 0384「測ったこと」）。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の「DB マイグレーション」節。**DB マイグレーション**: 新しい migration `0028_digest_band_index.sql` が1本増える（`mnemora-postgres-migrate` か `runMigrations` を打つこと）。索引の構築は素の `CREATE INDEX`（`CONCURRENTLY` 不可）で、対象テーブルに `SHARE` ロックを取る（書き込みは構築が終わるまで止まり、読み取りは通る。`ACCESS EXCLUSIVE` ではない）。100万行で構築を含む migration が約1.2秒（1回だけの測定）。
  ⭕ 非破壊と数える（SQL 文・返り値は変わらない。索引を1本追加しただけ）。

- **利用者に返るエラー文（`forget` / `purge` / `restoreArchived` / `restoreSuperseded` の `"failed"` の `error`、`reinforceError`、`purge` の `embeddingCleanup.error`）の整形を、outbox の `last_error` と同じにした**（[ADR 0363](./docs/decisions/0363-outbox-last-error-omit-params-and-cap-length.md) の 2026-09-30 追記）——利用者に返るエラー文が、SQL に付いた値（params）を含んでいたので、outbox 側の既存の整形に揃えた。他テナントの値は出ていなかった。
  - **文字列の形が変わる**: 例外の `message` そのままではなくなる。drizzle が包んだ失敗では `params:` 以降が `(omitted by mnemora, N chars)` に置き換わり、`cause` の連鎖（pg の理由）と SQLSTATE（`(code: 42501)` の形）が ` <- caused by: ` で続き、全体は4096字で切られる（SQL の文そのものは残る）。包まれていない単純な `Error("...")` は、`message` のまま変わらない。文字列を解析している呼び出し側は見直すこと。
  - outbox の `last_error` の出力は変わらない。公開の型は変えていない（`error` は `string` のまま）。
  ⭕ 非破壊と数える（型は同じ。文字列の中身だけが変わる）。

- **`purge()` の `recalls.index_band` の書き換えが、テナントの `recalls` を全部読まなくなった**（[ADR 0389](./docs/decisions/0389-recalls-digest-band-index.md)、[ADR 0375](./docs/decisions/0375-purge-scope-widened.md)「引き受けた負債」1 の解消）。
  - **新しい migration `0030_recalls_digest_band_index.sql`。** `recalls` に式の GIN 索引 `idx_recalls_digest_band`（`(index_band->'digestBand') jsonb_path_ops`）を1本足す。`@mnemora/postgres` を使っていれば、上げたあとに migrate を当てること（`mnemora-postgres-migrate` か `runMigrations`）。公開 API・purge の結果は変わらない。
  - ⚠ **`CREATE INDEX` は `CONCURRENTLY` を使わない**（`0027` などと同じ前例）。作るあいだ `recalls` への書き込みが止まる。作成時間・索引サイズ・`recalls` の INSERT への上乗せの実測は ADR 0389。
- **`RecallQuery.scopeAggregate` の TSDoc（`packages/core/src/recall.ts`）と `docs/recall.md` の「実装しない adapter は常に `countKind: 'exact'` を返し続ける契約」を訂正した。** conformance suite は、フラグ無しで `"skip"` を守ること（`groups` 空・`totalInScope` `0`・`countKind: 'unknown'`）を求め、`'exact'` を返し続ける実装は落ちる。コメントと文書だけの訂正で、振る舞い・公開の型は変えていない（上の `### Breaking` の同項を参照）。

- **`docs/migration-v1.md` の未リリースの節が `0029`・`0030` を知らなかったのを直し、CHANGELOG の未リリース節が名指す migration が同文書にも在ることの歯を足した**（`scripts/__tests__/migration-v1-changelog-migrations.test.mjs`）。同文書の本数の案内は `0028` で止まっていた（`v1.1.0` から3本・`v1.0.2` から6本と書いていたが、実際は5本・8本）。DB の動作は変わらない（`mnemora-postgres-migrate` は台帳をファイル名で見る）。文書の正確さだけの訂正で、出荷済みの節は触っていない。

- **`labels` の行を消す（`eraseTenant` など）ときの外部キー検査が、`memory_labels` を全走査しなくなった**（[ADR 0400](./docs/decisions/0400-general-fk-index-tooth.md)）。
  - **新しい migration `0031_memory_labels_label_id_index.sql`。** `memory_labels (label_id)` に索引 `idx_memory_labels_label_id` を1本足す。`@mnemora/postgres` を上げたあと migrate を当てる。列・型・SQL 文・返り値は変えない。⭕ 非破壊と数える。
  - ⚠ `CREATE INDEX` は `CONCURRENTLY` を使わない（`0027` などと同じ前例）。作るあいだ `memory_labels` への書き込みが止まる。
  - 調査担当の実測では、`memory_labels` 20万行で 46ms → 6.5ms（ADR 0400）。あわせて、全外部キーに先頭列一致の索引を要求する歯を足した（テストのみ、利用者には見えない）。

- **`purgeExpiredRecalls`・`purgeCompletedJobs`（Postgres）の1回の呼び出しが、表の行数に比例しなくなった**（[ADR 0412](./docs/decisions/0412-purge-target-select-indexes.md)、ADR 0404 決定7を改めた）。
  - **新しい migration `0032_purge_indexes.sql`。** `recalls (tenant_id, created_at, id)` の索引 `idx_recalls_by_created` と、`outbox (tenant_id, completed_at, id) WHERE completed_at IS NOT NULL` の部分索引 `idx_outbox_completed` を足す。`@mnemora/postgres` を上げたあと migrate を当てる。列・型・SQL 文・返り値は変えない。⭕ 非破壊と数える。
  - ⚠ `CREATE INDEX` は `CONCURRENTLY` を使わない（`0027` などと同じ前例）。作るあいだ `recalls` と `outbox` への書き込みが止まる。⚠ 全 recall の INSERT と全 outbox の `complete` に、purge を呼ばない利用者も含めてマイクロ秒の上乗せが乗る（10万行の実測で 1 回あたり約 2.7 µs・約 4 µs。ADR 0412）。
  - 10万行の実測で、対象選択の p50 は索引なし 6〜15 ms → 索引あり 0.3〜0.7 ms（前任の100万行の測りは 409 ms／312 ms が約 2 ms／約 0.4 ms）。
  - `@mnemora/postgres` から `buildPurgeCompletedJobsTargetSelect(ctx, opts, lock?)` を export した（`purgeCompletedJobs` の対象を選ぶ SELECT の組み立て。兄弟の `buildPurgeExpiredRecallsTargetSelect` と同じ扱い）。⭕ 公開 API への追加で、非破壊。

- **`MemoryStore.listActiveClaimPredicates?` の同着（代表行の `created_at` が同じ predicate が複数あるとき）の並びを、predicate のコードポイント順の昇順に固定した**（[Issue #1412](https://github.com/takecchi/mnemora/issues/1412) の続き）。以前は契約が同着の順を規定せず、`PostgresMemoryStore` は `ORDER BY MAX(created_at) DESC` だけ（同着は実行計画次第）、fixture は挿入順だった。
  - `@mnemora/postgres` は副キーに `claim_key_predicate COLLATE "C" ASC` を足した（DB の照合順序に依らない）。`@mnemora/testkit` の `InMemoryMemoryStore` は UTF-8 のバイト列の比較（コードポイント順）で揃えた。DB マイグレーションは足していない。
  - `describeMemoryStoreConformance` の `supportsListActiveClaimPredicates: true` の枝に、同着の並びの歯を3本足した。
  - ⚠ **自前の `MemoryStore` に `listActiveClaimPredicates` を実装していて `supportsListActiveClaimPredicates: true` を渡す人へ**: 同着の並びが上の規則と違えば、この歯で新しく赤になりうる。呼び出し側（`knownPredicatesFromStore`）が語彙ヒントの優先順位に順序をそのまま使うので、同着の順が呼び出しごとに変わる実装は、同じ入力に別のプロンプトを出しうる。
  - 型・API は変わらない。⚠ **ただし、同着の並びの歯は conformance suite の判定を厳しくするので、破壊的変更として上の `### Breaking` に数えた**（移行は [docs/migration-v1.md](./docs/migration-v1.md) の項目39）。同着の順は元から規定がなく、実装依存だった。

- **`@mnemora/testkit` が `zod` を `peerDependencies`（`^4.5.4`、`@mnemora/core` と同じ範囲）に宣言するようになった。** 公開の型 `LLMProviderConformanceOptions` が `import type { z } from "zod"` を d.ts に持つのに、`zod` は `devDependencies` にしか無かった。【実測】pnpm を `hoist=false`（厳格な配置）にした利用者の一時プロジェクトで testkit の tarball を入れて `tsc`（`skipLibCheck: false`）に掛けると `TS2307: Cannot find module 'zod'` で落ちた（既定の hoist では `.pnpm/node_modules` 経由で解決できてしまう。`skipLibCheck: true` では型が黙って `any` になる）。peer にしたあとは同じ手順で解決する。実行時の import は無い（型のみ）。`dependencies` にしなかったのは、利用者側の `zod` と二重に入ると `z.ZodType` の型が噛み合わなくなるため。

- **`@mnemora/testkit/fixtures` が型 `StoredRelation` を export するようになった。** `InMemoryRelationStore` のコンストラクタの第2引数（`memoryStore.relations` と共有する配列）の要素型だが、入口から名指せなかった。型の追加のみ（実行時は変わらない）。公開 API snapshot を更新した。

- **`@mnemora/bullmq` の tick driver が、`runtime.tick()` の失敗を `onTickError` に渡すようになった。** BullMQ の Worker は processor の throw を `'error'` ではなく `'failed'` として emit する（【実測】bullmq 6.3.8、Redis 互換サーバ Valkey 8.1.3 上の実 Worker で `'failed'` だけが1回 emit され、`'error'` は出なかった）。以前の driver は `'error'` しか聴いていなかったため、`tick()` が throw しても `onTickError` も `onTickResult` も呼ばれず、失敗が誰にも見えなかった。いまは `'failed'` を拾い、job ではなく error を渡す（`'error'` とは別の経路で、1回の失敗につき1回）。`onTickError` を渡していない人には見える変化は無い。渡している人は、これまで届かなかった tick の失敗が届くようになる（エラー通知の件数が増えうる）。再試行は足していない（繰り返しジョブは次の発火でまた tick する）。

- **`@mnemora/bullmq` の tick driver が、`Queue` 側の `'error'`（Redis 接続の失敗など）も `onTickError` に渡すようになった。** 以前は `Worker` にだけ listener を付けており、繰り返しジョブの登録に使う `Queue` の error は listener が無いため bullmq（6.3.8 の `QueueBase.emit`）が `console.error` へ固定で出すだけで、`onTickError` には届かなかった。いまは `onTickError` を渡していれば、`Queue` の error もそこへ届く。
  - ⚠ **`onTickError` を渡していない人には見える変化は無い。**渡していないときは `Queue` に listener を付けず、従来どおり bullmq の `console.error` に出る（付けるとその既定の出力が消え、`Queue` の異常が黙るため）。
  - ⚠ **`onTickError` を渡している人は、通知の件数が増えうる。**`Queue` と `Worker` は別々の Redis 接続を持ち、接続ごとに `'error'` を出す。Redis が落ちると、同じ障害について `Queue` 由来と `Worker` 由来の通知が別々に届く（【実測】Redis が居ないポートを指すと、両方が `ECONNREFUSED` を出した。bullmq 6.3.8）。driver は束ねない。`'failed'`（tick の失敗）は従来どおり1回の失敗につき1回。
  - 非破壊（型・公開 API は変えていない。`onTickError` の契約が、届く経路を1つ増やした）。【確かめていない】Redis が在る状態での `Queue` の error（実 Redis での再現）。歯は fake の `Queue` が emit する形で縛っている。

- **`runtime.reextract` が、LLM を待つ間に元の記憶が `forget`（`purge` を含む）されたとき、何も書かずに打ち切るようになった**（[ADR 0406](./docs/decisions/0406-reextract-aborts-if-source-forgotten-while-waiting-for-llm.md)、[Issue #1226](https://github.com/takecchi/mnemora/issues/1226) と同じ穴）。
  - **直した穴**: 以前は、`reextract` が LLM を待つ間にその Observation の記憶を `forget` すると、`forget` は `forgotten` を返すのに、LLM が返った後で言い換えが新しい `active` として書かれ、イベントが `created` → `forgotten` → `created` と積まれた（実測、Postgres）。`consolidate`/`reflect` が #1226 で塞いだのと同じ穴が `reextract` に残っていた。
  - **今の振る舞い**: LLM が返った直後に、LLM の前に読んだその Observation の記憶を読み直し、1件でも `forgotten` なら何も書かない。書き込み（`supersedeWithNewMemories`／口が無い adapter 向けの `createMemoryWithOutbox`）にも `opts.abortIfForgotten` を渡し、実装する adapter（`@mnemora/postgres`）は同一トランザクションでも見直す。戻り値は「退けた記憶を持つ Observation」の早期 return と同じ形（`extraction: "skipped"`・`atomicity: "not_attempted"`・`skipped` に `status_not_active`）。**例外は投げず、公開の型は増やしていない。**
  - ⚠ `abortIfForgotten` を実装しない自前の `MemoryStore` では、読み直しだけが保護になり、読み直しと書き込みの間の窓は残る（`consolidate`/`reflect` と同じ）。待つ間に `contested` になった記憶は見直さない。
  - 非破壊（型・DB は変えていない。forget された記憶を根拠に書き直していた挙動が、書かない挙動になった）。
- **`consolidate()` / `reflect()` の内部の `recall()`（`{ seedMemoryId }`・`{ query }` 形と、tick の consolidate / reflect ジョブ）が、使わない件数集計を撃たなくなった**（[ADR 0415](./docs/decisions/0415-consolidate-reflect-skip-scope-aggregate.md)、[ADR 0384](./docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md) 案C の `scopeAggregate: "skip"` を内部に使う）。両方とも recall の `memories` しか読まないのに、`MemoryStore.aggregateScope` の `GROUP BY subject_id` が毎回走っていた。
  - **`consolidate()` / `reflect()` の返り値は変わらない。変わるのは、内部の recall が書く `recalls` 行**（`getRecall` で読める）**の中身**: `query` に `scopeAggregate: "skip"` が付き、`index_band` の `groups` は空・`totalInScope` は `0`・`countKind` は `'unknown'`、`omitted` の `filtered(...)`・`not_indexed`・`ann_unreached` は積まれず、ANN の stage detail に `annReachability: "unknown"` が付く。目次帯の中身は同じ。`recallId` は返り値に載らないので、見えるのは `recalls` 表を直接読むとき。
  - `{ query }` 形で利用者が `query.scopeAggregate` を明示したときは、その値を尊重する。`findCorrectionCandidates()`・直接の `recall()` は変えていない（`"exact"` のまま）。公開の型・DB は変えていない。
  - 【実測】100万行・全件 active・単一テナント・並列0・同時1・単発の接続・10往復の p50（共有機、交互ではない）: `consolidate({ seedMemoryId })` は 742.9 ms → 6.4 ms（同じ器・設定で前後を続けて測った値。前の担当の測定は 893.1 ms）。条件・限界は ADR 0415。

- **`probeTrigramLexicalSupport`（と `PostgresTrigramLexicalStore.create()`）の `extension_create_denied` の判定が、英語の `message` の正規表現から、SQLSTATE `42501` かつ `routine = execute_extension_script` に変わった**（[PR #1511](https://github.com/takecchi/mnemora/pull/1511)）。drizzle が包んだ失敗では `code`/`routine` が `cause` 側にあるので、`cause` の連鎖も辿る（`migration-failure-message.ts` の判定と共有）。
  - **返る `reason` が変わる場合がある**: (a) `lc_messages` が英語以外で `CREATE EXTENSION` の権限不足が起きたとき、以前は `extension_create_failed` だったものが `extension_create_denied` になる（意図した修正）。(b) 英語の `message` が `permission denied`・`must be owner`/`superuser`・`insufficient privilege` に見えても、`code`/`routine` が違う失敗（PR #1511 の歯が使う例: SQLSTATE `42501` でも `routine = aclcheck_error`）は、以前の `extension_create_denied` から `extension_create_failed` になる。`reason` の名前で分岐している呼び出し側は、扱いを見直すこと。
  - `TrigramLexicalUnavailableReason` の union の値は増減しない。`detail`（`message`）と `cause` の内容も変えていない。
  - 非破壊と数える（型・公開 API・union は同じ。同じ入力で `reason` の値が、判定を直した側へ動く）。上の「利用者に返るエラー文…の整形を、outbox の `last_error` と同じにした」の項目（文字列の中身だけの変更を非破壊と数えた）が近い先例である。

- **入力側の公開型の任意欄が `?: T | undefined` になった。`exactOptionalPropertyTypes: true` の利用者が `{ limit: maybeLimit }` のように `undefined` を渡せる**（[ADR 0429](./docs/decisions/0429-exact-optional-property-types-input-types.md)）。各パッケージの `*Options`・`RecallQuery`・`observe`/`tick` などの入力・port のメソッド引数の `opts` の型が広がるだけで、その設定を有効にしていない利用者では同じ型であり、既存のコードは壊れない（非破壊）。出力にも使われる型（`Memory`・`MemoryEvent` など）は広げていない。

- **`observe({ claimKey: { detectContested: true } })` が3件以上の群を作るときの監査イベントが、群の大きさ N に対して線形にしか増えなくなった。あわせて、段4（予算による切り詰め）の `cut` の求め方を O(n²) から O(n) に替えた（挙動は変わらない）**（穴探し10巡目、[ADR 0431](./docs/decisions/0431-contested-group-event-growth-and-recall-cut.md)）。以前は、群の全メンバーに `updated`（`meta.reason: "contested"`）を1件ずつ積み（既に群の一員で状態が変わらないメンバーにも）、各イベントの `meta.note` に群の全員の id と一致の全員の要約が入っていたため、同じ claim key の発話を N 件積むとイベントが約 N²件・約 N³バイトになった（N=40 で 859 件・4.3MB、N=80 で 3319 件・32.8MB）。
  - **(a)** `MemoryStore.markContestedGroup` の `@mnemora/postgres` と `@mnemora/testkit`（InMemory）の実装は、呼び出し時点で既に `contested` かつ `contestedWithId` が無いメンバー（既存の群の一員）に `updated` を積まない。`active` から `contested` になるメンバーと、2者の対から群へ吸収されて `contestedWithId` が外れるメンバーには、従来どおり積む。戻り値の `events` は、その分だけ `members` より短くなりうる。自前の `MemoryStore` は、渡された `event` を全部積む実装のままでも壊れない（`Runtime` は `events` の長さに依らない）。
  - **(b)** `meta.note`（JSON 文字列）の `kind: "claim_key_conflict_group"` は、`memberIds` と `matches` に**先頭10件だけ**（id の昇順。`matches` は id 昇順の先頭）を入れ、全体の件数を `memberCount`（新設）・`matchCount` に、切ったかどうかを `memberIdsTruncated`・`matchesTruncated`（どちらも新設の真偽値）に持つ。`Runtime.observe` の戻り値の `contestedDetection[].result.memberIds` は全員のまま。**解消後の群の全メンバーを `note` から辿る手段は、11件以上の群では無くなる**（`memory_relations` の行は解消時に消える、[ADR 0381](./docs/decisions/0381-contested-group-write-path-implementation.md) 決定3）。
  - `kind: "claim_key_conflict_unresolved"` の `note` の `matches` も、同じく id の昇順の先頭10件に切り、`matchesTruncated`（新設）を付けた（全体の件数は既存の `matchCount`、全員の id は `observe()` の戻り値の `matchMemoryIds`）。
  - 公開の型・DB は変えていない。非破壊と数える（`meta.note` は型の付かない JSON 文字列で、中身のキーは契約の型ではない。理由は ADR 0431）。

### Fixed

- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore.createObservation`・`createObservationWithOutbox` が、関数・`Symbol` を欄の値に持つ値や `toJSON` を持つ値を含む `payload`（`observe({ kind: "event", data })` の `data`）を、`DataCloneError` で断らずに、`@mnemora/postgres` と同じ規則で保存するようになった。**（[ADR 0486](./docs/decisions/0486-fixture-event-data-align-and-context-text-unit.md)）関数・`Symbol` の欄は消え（配列の要素なら `null`）、`toJSON` はその戻り値で保存する。`NaN`・`-0`・`Date`・値が `undefined` の欄の扱いは変えていない。断る入力が減るだけで、非破壊。
- **`recall()` の多者間の群（`RelationStore`）まわりの 2 つの割れを直した。**(1) `relationMaxCount` を超えて切った群のメンバーを、連想の `unit_assembly_dropped`・`over_limit`、または段2の `below_threshold` などでもう一度数えていた（`omitted` の件数の和が `totalInScope` を超えた）。切ったメンバーは連想の候補から外し、段2の件数から取り下げる（連想の席が、どうせ落ちる群のメンバーに取られなくなる）。(2) `RelationStore.link` で `active` な記憶へ辺を張ると、その記憶が結果に 2 回返っていた。群のメンバー（`contested` で `contestedWithId` なし）でない候補は、辺があっても群に入れない。新しく断る入力は無い（[ADR 0494](./docs/decisions/0494-fuzz-relations-and-argument-mutation.md)）

- **`created` イベントの `meta.languageMismatch`（ADR 0391）の判定が、ローマ数字（`Ⅳ` など）を「ラテン文字」に数えていたのを、文字（`\p{L}`）だけを数えるように直した。**`contentLatinShare` が1を超える値（例: 2.5）になり、20字の下限もローマ数字ですり抜けていた。閾値と `rule` は変えていない。変わるのはローマ数字を含む本文・観測の判定だけで、保存済みの印は書き換えない（[PR #1597](https://github.com/takecchi/mnemora/pull/1597)）。

- **`Runtime.findCorrectionCandidates` の `excludeMemoryIds` が、大文字の uuid でも除外するようになった（`@mnemora/postgres` は小文字で返すので、大文字で渡した自己除外が黙って効かなかった）。反復できない値を渡したときは、`recall()` を呼ぶ前に `TypeError` になる（以前は recall の記録を1件書いた後に落ちた）。**（[ADR 0485](./docs/decisions/0485-find-correction-candidates-exclude-ids.md)）

- **`@mnemora/postgres`: 同じ語彙を逆の並びで `tags` に持つ記憶を同時に作ると `deadlock detected`（40P01）で片方が落ちたのを直した。**`upsertProposedLabels` が `labels` の行を触る順を、`tags` の並びではなく名前の順に固定した。`Memory.tags` の並び・重複と `proposedCount` は変わらない（[ADR 0476](./docs/decisions/0476-label-upsert-lock-order-and-taxonomy-probes.md)）

- **`@mnemora/testkit/fixtures` の `InMemoryEventStore.append` が、`event.memoryId` が大文字の uuid でも、`PostgresEventStore.append` と同じく小文字にそろえて受けるようになった**（[ADR 0475](./docs/decisions/0475-eventstore-append-uuid-case.md)。[ADR 0469](./docs/decisions/0469-fake-event-target-and-uuid-case.md) の続き）。自テナントの記憶の id を大文字にしたものは、以前は「記憶が無い」と断られた。積むイベントの `memoryId` は小文字の正規形になる。別テナントの記憶は、大文字でも断る。落ちる入力が減る変更で、新しく断る入力は無い。移行ガイドは [docs/migration-v1.md](./docs/migration-v1.md) の 🟡。
- **`@mnemora/testkit/fixtures` の `InMemoryRelationStore.listRelated` / `listRelatedMany` が、`kind` が偽の値（`""`・`null`・`0`）のとき、`PostgresRelationStore` と同じく絞り込まずに全件を返すようになった**（[ADR 0488](./docs/decisions/0488-relation-store-fake-alignment.md)）。以前は 0 件を返した。型の外の入力で、`undefined`（省略）と正しい `kind`（`"contradicts"`）の返りは変えていない。`@mnemora/postgres` の返りは変えていない。

- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` が、書き込み口に渡した `NewMemoryEvent.memoryId` が大文字の uuid でも、`@mnemora/postgres` と同じく小文字にそろえて受けるようになった**（[ADR 0469](./docs/decisions/0469-fake-event-target-and-uuid-case.md)。[ADR 0466](./docs/decisions/0466-inmemory-event-target-belongs-to-ctx-tenant.md) の続き）。自テナントの記憶の id を大文字にしたものは、以前は「記憶が無い」と断られた。積むイベントの `memoryId` も小文字の正規形になる。別テナントの記憶は、大文字でも断る。落ちる入力が減る変更で、操作の対象の `id` の大文字小文字は変えていない。移行ガイドは [docs/migration-v1.md](./docs/migration-v1.md) の 🟡。

- **`@mnemora/testkit/fixtures` の InMemory が、`@mnemora/postgres` が断る入力を3つ、新しく断るようになった**（[ADR 0493](./docs/decisions/0493-fake-and-inmemory-input-checks-aligned-to-postgres.md)）。(1) `InMemoryMemoryStore.createMemory`（とそれを通る `createMemoryWithOutbox` など）の `NewMemory.decayFloorAt`・`lastReinforcedAt` が Invalid Date（`timestamptz` 列。以前は Invalid Date のまま保持して成功した）。(2) `InMemoryMemoryStore.createObservationWithOutbox` の `opts.claimedBy` に NUL（`outbox.claimed_by` は `text` 列。行を実際に書くときだけ。`jobKinds` が空・冪等の既存の行に当たるときは今までどおり見ない）。(3) `InMemoryMemoryStore`・`InMemoryVectorStore`・`InMemoryOutboxStore` の `eraseTenant` を直接呼んだとき、`limit` が NaN・非整数・Infinity・2^63 以上（`bigint` の引数。以前は `reachedLimit: false` で成功した。`erase-tenant.ts` の独立関数 `eraseTenant` は元から `limit` を正の整数に限る）。落ちる入力が増える変更だが、Postgres は元から同じ入力で断るので、本物の adapter で動く呼び出しは影響を受けない。公開の fixture が新しく例外を投げる変更は破壊的と数えない（[docs/migration-v1.md](./docs/migration-v1.md) の数え方の規律）ので、移行ガイドの 🟡 に載せた。conformance suite は変えていない。

- **`@mnemora/openai`: `completeStructured` が、応答の余分な `"__proto__"` の欄を、継承された値として zod に読ませていたのを直した。**`null` を省略へ戻す写しが `JSON.parse` の `"__proto__"` をプロトタイプの差し替えにしていた（抽出の候補の `subjectId` が `{"__proto__":{"subjectId":"…"}}` で埋まった）。`@mnemora/anthropic` と同じく無視する。（[ADR 0468](./docs/decisions/0468-openai-null-strip-copies-own-proto-key-as-own-property.md)）
  - ⚠ **以前は通っていた応答が、新しく `ZodError` になる形がある**（必須の欄が `"__proto__"` の中にしか無い応答・利用者の `z.strictObject` に `"__proto__"` の欄がある応答。`@mnemora/anthropic` は以前から同じ応答を断っていた）。影響を受けるのは、strict モードを守らない OpenAI 互換サーバを `client` に差している利用者だけ。破壊的と数え、移行の手順は [docs/migration-v1.md](./docs/migration-v1.md) の項目53。

- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` が、書き込み口に渡した `NewMemoryEvent.memoryId` が別テナントの記憶（実在しない id も同じ）のとき、書かずに `memory not found for tenant` で断るようになった**（[ADR 0466](./docs/decisions/0466-inmemory-event-target-belongs-to-ctx-tenant.md)。`@mnemora/postgres` の H4（ADR 0456）と同じ口・同じ判定・同じ message の形で、接頭辞だけが `InMemoryMemoryStore:`）。以前は別テナントを指すイベントが積まれた。公開の fixture が新しく例外を投げる変更は破壊的と数えない（オーナーの回答 `3f3411c5`）。conformance suite は変えていない。移行ガイドは [docs/migration-v1.md](./docs/migration-v1.md) の 🟡 と項目52。

- **`@mnemora/postgres`: `registerEmbeddingSpace` が、migration（0022・0027）が同じ名前の索引を作っている最中と重なって `23505` で落ちるのを直した。**（[ADR 0464](./docs/decisions/0464-register-embedding-space-absorbs-migration-index-race.md)）。零ノルムの部分索引と `memory_id` の索引の `CREATE INDEX IF NOT EXISTS` が、自分の索引名の `23505`（`pg_class_relname_nsp_index`）で落ちたら、同じ文を1回だけ打ち直す（別の名前・別の制約の `23505` は今までどおり投げる）。**落ちる入力が減るだけで、断る入力は増えない。**逆向き（`registerEmbeddingSpace` の索引作りの最中に `runMigrations` が `23505` で落ち、そのファイルが巻き戻る。呼び直せば通る）は直していない（ADR 0464 の負債）。

- **`@mnemora/postgres`: `registerEmbeddingSpace` が `max: 1` の `Pool` で返らなかったのを直した。呼んだあと、`registerEmbeddingSpace`・`runMigrations` が接続の `lock_timeout` を `0` に書き換えるのもやめた。**（[ADR 0460](./docs/decisions/0460-multi-process-multi-pool-round33.md)）。advisory lock を握った接続の中で DDL を打つ形にした（`BEGIN` は開かない。文ごとの暗黙のトランザクションは以前と同じ）。以前は DDL に別の接続が要り、`max: 1` では借り切られた接続の返却を待って止まった（`lock_timeout` は効かず、`connectionTimeoutMillis` を渡していなければ返らない）。`lock_timeout` は advisory lock を取っている間だけ敷き、取れたら `RESET` する（`lockTimeoutMs` が DDL の表ロック待ちに効かないのは以前と同じ）。呼び終えたあとは `RESET lock_timeout` で、接続側（`options`・ロール・DB）で渡した値に戻る（以前は `0` を書いていて、その接続は以後ロック待ちに上限が無かった）。**断る入力は増えない。**

- **`@mnemora/testkit` の provider の fake・カセットを、interface の約束と本物の provider に揃えた。`recall()` は `Float32Array` などの数値の型付き配列のクエリ埋め込みも受ける。**（[ADR 0452](./docs/decisions/0452-testkit-provider-fakes-align-with-contract.md)）
  - **落ちる入力が増える**: `SeededEmbeddingProvider` は種と delegate の空間が違えば構築で落ちる。`CassetteRecorder` は違う空間・モデルの2回目以降の記録で落ちる。`assertCassette` は、成分が有限でない・`dimensions` が正の整数でない・鍵が入力と一致しないカセットを読んだ時点で落とす。`RecordedEmbeddingProvider` は有限でない記録を返さずに落ちる。`RecordingEmbeddingProvider` は delegate の壊れた戻り（次元違い・有限でない成分）を記録せずに落ちる。`DeterministicEmbeddingProvider` は `dimensions` が正の整数でなければ構築で落ちる（以前は `embed` で落ちるか、`0` は空のベクトルを返した）。
  - **直した振る舞い**: Seeded\*・Recording\* は `opts`（`AbortOptions`）を delegate へ渡す。Recording\* は同じ入力の並列の呼びでも delegate を1回だけ呼び、見た値と記録が一致する（失敗は memo に残さない）。返すベクトルと `space` は、記録・構築時の引数と参照を共有しない。
  - **`recall()`**: 型付き配列のクエリ埋め込みが、ingest（embed ジョブ）と同じく通る（以前は `embedding_provider_unavailable`）。
  - 触っていない: カセットの鍵の導出（孤立サロゲート・`system` の空文字）、conformance suite。
- **`runtime.reextract`: 置き換えた側（`supersededById`）が `active` でない行になり、循環・active 0件ができる穴を直した。あわせて `Runtime.observe` の TSDoc 2か所を実装に合わせた。**（穴探し30巡目、[ADR 0454](./docs/decisions/0454-reextract-anchor-observe-consolidate-state-matrix-round30.md)。`@mnemora/core` の `runtime.ts` だけの変更。store・migration・公開の型は変えていない）
  - **穴**: 抽出の冪等キーは status を問わないので、候補が同じ Observation・同じ版の `superseded`／`archived` な既存行にぶつかると、store がその行を返す。以前は候補列の先頭を置き換えた側にしたため、`reextract` の出力が X → Y → X と往復すると Y と X が互いを置き換えて active が0件になった（Postgres・testkit とも、口あり・口なしの両経路）。先頭が archived な行にぶつかると、別の active な記憶がその archived な行に置き換えられた。
  - **いまの振る舞い**: 置き換えた側は、候補列のうち非 active の既存行にぶつからない先頭。全候補がぶつかるときは何も supersede しない（`supersededMemoryIds: []`。ぶつかった行は `skipped` の `status_not_active` に載る）。**返り値が変わる入力は2つだけ**: (1) 全部の候補がぶつかる入力（例: 子 `[X, Z]` で X が archived、出力 `[X]`）は `supersededMemoryIds` が `[Z]` から `[]` になり、Z は active のまま残る。(2) 先頭の候補だけがぶつかる入力（出力 `[X, W]`）は `supersededById` が X から後ろの新しい W に変わる。例外は増えていない。
  - **文書だけの直し**: `Runtime.observe` の TSDoc が「abort した sync の observe の extract ジョブは claim もされていないまま残る」と書いていたのを、observe が claim したまま残る（`leaseMs` の内側の `tick` は拾わない）に直した（ADR 0407 以降の振る舞い）。
  - **冪等な再送の戻り値**: `subjectCandidates`・`claimKey` を渡した再送にも、`rejectedSubjectIds: []`・`claimKeyFailure: null`・`contestedDetection: []` が付くようにした（以前は欄が無く、TSDoc の「渡したら常に」と食い違っていた）。欄が増えるだけで、型・書き込みは変えていない。
  - **直していない点**: `reextract` の LLM を待つ間に記憶が contested になっても、新しい版は active で書かれる（ADR 0406 の負債、実測した）。ほか5件は ADR 0454 の負債の表。

- **`@mnemora/postgres`: `observe` の抽出で、候補ごとの savepoint の `rollback to savepoint` が失敗しても、元のエラーが消えなくなった。**接続が切れたときなどに、呼び出し側へ届くのが `Failed query: rollback to savepoint …` や 25P02 だったのを、元のエラー（22021 など）にした。巻き戻しの失敗は元のエラーの `cause`（空いていれば）か `rollbackError` に残る。新しい例外の型は作っていない。トランザクションの状態が分からないので、続けず、落とした候補（`dropped`）にも積まない。巻き戻しが成功する悪い候補は従来どおり落として他を書く。上流（drizzle-orm）の不具合で、ここで包んで直した（上流への報告はしていない）。（[ADR 0451](./docs/decisions/0451-savepoint-rollback-failure-keeps-original-error.md)、[ADR 0444](./docs/decisions/0444-pool-begin-release-rollback-error-preserved.md) の続き）

- **`@mnemora/bullmq`: README・TSDoc の「コードからの読み」を実 Redis（redis-server 7.4.7・bullmq 6.3.8）で測り、ずれていた所を直した。**（[ADR 0449](./docs/decisions/0449-bullmq-tick-driver-measured-against-real-redis.md)。コードの振る舞いは変えていない）
  - **文書に無かったこと（実測）**: Redis が落ちている間の `start()` は reject せず pending のまま／Redis が永続化なしで再起動すると scheduler が消え、tick は再開せず `onTickError` も鳴らない（永続化ありなら再開）／`everyMs` を変えて別の driver が `start()` すると共有の scheduler の間隔が置き換わる／ioredis のインスタンスを `connection` に渡すなら `maxRetriesPerRequest: null` が要り、無いと `createBullmqTickDriver` が同期的に throw する。
  - **裏づいたこと**: 1台の `stop()` が全プロセスの発火を止める（新を `start()` してから旧を `stop()` する rolling deploy でも。直していない。被害の形と回避は README・ADR 0449）／完了・失敗ジョブが Redis に残り続ける（数字を追記）／stalled で `onTickResult` の後に `onTickError` が2回届く（ADR 0440 の【未実測】が【実測】になった）。
  - README の `ts` の片（bullmq・openai・anthropic）を `ts check` の門に入れた。

- **`runtime.applyCorrection`: `supersede` の `winnerId` を取り違えると、`RangeError` で終わるのに対（両側 `contested`）が残っていたのを、書き込む前に落とすようにした。大文字の `correctedId` は、store が同じ記憶と言えば候補として扱う。`buildCorrectionReason` の `winner` は、大文字小文字だけ違う `winnerId` でも実際の勝者を指す。**（[ADR 0446](./docs/decisions/0446-apply-correction-no-write-before-winner-check-case-insensitive-candidate-reason-winner.md)）
  - **穴**: (1) `winnerId` がどちらの id でもないと、`markContested` が書いたあとに `resolveContested` が `RangeError` を投げ、対だけが残った。(2) `@mnemora/postgres` で候補の id を大文字にして `correctedId` に渡すと、`markContested` は受け付けるのに `not_a_candidate` になった。(3) 大文字の `winnerId` で訂正する側が勝っても、`buildCorrectionReason` は `winner=corrected` と書いた。
  - **いまの振る舞い**: (1) 例外の型と文言は同じで、何も書かれない。(2) 大文字小文字だけの違いは store に従う（大文字小文字を区別する store は今どおり `not_a_candidate`）。(3) これから書く `meta.note` だけが変わる（保存済みの `note` は書き換えない）。断る入力は増えていない。
  - **直していない点**: 未知の `resolution.kind`（型を外した呼び出し）は `supersede` として扱われ、両側が `superseded` になる。`reason` の NUL・孤立サロゲートは今までどおり例外（Postgres と fixture で例外の型が違う）。ADR 0446 の「引き受けた負債」。

- **v1.1.0 より前（v1.0.0〜v1.0.2）に purge した行に残っていた `tags`・`attributes`・claim key・`memory_labels` が、purge をかけ直すと消えるようになった。**（[ADR 0437](./docs/decisions/0437-helpers-params-subject-ids-repurge.md) 決定3・4、[ADR 0375](./docs/decisions/0375-purge-scope-widened.md)・[ADR 0382](./docs/decisions/0382-vector-store-delete-across-spaces.md) の続き）
  - **穴**: v1.0.x の `purgeMemory` は `content`・`digest`・`purged_at` しか書き換えなかった。v1.1.0（ADR 0375）からは、purge はそれらも消すが、**既に purge 済みの行には効かない**（migration は遡らない。purge をかけ直しても `already_purged` が返るだけだった）。
  - **いまの振る舞い**: **v1.1.0 より前に purge した行は、purge をかけ直すと消える。かけ直すまでは残る。** `runtime.purge` が `already_purged` を返すとき（`dryRun` でないとき）、`MemoryStore.scrubPurged` が呼ばれ、`tags`・`attributes`・claim key・`memory_labels` を消し、`proposed` な label の `proposedCount` を外した本数だけ減らす。今のコードで purge した行を、二重に数え減らさない（べき等）。**migration で遡って一括で消すことは、していない**（オーナーの領分）。
  - **残っている行の見つけ方**（現行の schema に移行したあと）:
    ```sql
    SELECT id, tenant_id FROM memories
    WHERE purged_at IS NOT NULL
      AND (
        cardinality(tags) > 0
        OR attributes <> '{}'::jsonb
        OR claim_key_subject IS NOT NULL
        OR claim_key_predicate IS NOT NULL
        OR EXISTS (SELECT 1 FROM memory_labels ml WHERE ml.memory_id = memories.id)
      );
    ```
    見つかった `id` を、その `tenant_id` の `ctx` で `runtime.purge(ctx, { memoryIds })` にかけ直す。
  - **直していないもの**: `recalls.index_band` の digest（Issue #994 の系統）は、v1.0.x の purge が残したものが今も残っているかを**確かめていない**（範囲外）。
  - **移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目50。DB マイグレーションは無い。
- **`readDecayClock`・`readActivitySeq`・`readDefaultHalfLifeRecalls`・`readHasSubjectActivityCounters`・`readSubjectActivitySeqs`・`readSubjectActivitySeq`・`writeDecayClock`・`readTaxonomyMode`・`writeTaxonomyMode`（`@mnemora/core` の公開ヘルパー9本）が投げる例外の message から、drizzle の `params:` より後ろを落とすようにした**（[ADR 0437](./docs/decisions/0437-helpers-params-subject-ids-repurge.md) 決定1、[ADR 0430](./docs/decisions/0430-concurrent-create-erase-and-standalone-params.md) 決定3の対象を広げた）。store が投げた例外の `message`（と `stack`・`cause`）の `params` を `(omitted by mnemora, N chars)` に落とす。例外そのものを返す（`kind`・`cause` は変わらない）。

- **`recall()` の段1と連想枠が、`search()` のあとに archived・forgotten になった記憶を `memories` に返すことがあった**（[ADR 0432](./docs/decisions/0432-recall-status-recheck-and-archive-docs.md) AL-1）。`VectorFilter.status` は検索の時点でしか効かず、後置の再検査が `status` を見ていなかった。今は後置でも `status ∈ {active, contested}` を見て落とす（返す件数が減る方向で、新しい throw は無い。落とした分の `omitted` は段5の `filtered(archived)` などが数える）。
- **`archiveDecayed`（`Runtime.sweepArchive`）の `reachedLimit` が、`limit: 0` のとき対象が0件でも `true` になっていた**（ADR 0432 AL-4）。`@mnemora/postgres` と `@mnemora/testkit` のインメモリで、`limit > 0` のときだけ `true` にした。`limit: 0` は断らず、何も掃かずに `reachedLimit: false` を返す。
- **`PostgresTrigramLexicalStore.create()`（と `probeTrigramLexicalSupport`・`ensureTrigramLexicalFunctions`）を別々の pool から同時に呼ぶと落ちていた**（[ADR 0430](./docs/decisions/0430-concurrent-create-erase-and-standalone-params.md) 決定1）。拡張が無い DB では `CREATE EXTENSION` が 23505 で `TrigramLexicalStoreUnavailableError(extension_create_failed)`、拡張も関数も在る DB では `CREATE OR REPLACE FUNCTION` が XX000（`tuple concurrently updated`）の素の `Error` になった。拡張の作成と関数のインストールを1つのトランザクションに入れ、`runMigrations` の拡張作成と同じ `pg_advisory_xact_lock` で直列にした。待ちに mnemora の上限は掛けず、新しい例外も足していない（利用者の `lock_timeout` / `statement_timeout` は効く）。
- **同じテナントへの `eraseTenant` の同時呼び出しが、相手が先に消した行を数えられず、行が残ったまま `memories` へ進んで 23503（外部キー違反）で reject していた**（ADR 0430 決定2）。`@mnemora/postgres` の `memoryStore`・`vectorStore`・`outboxStore` の `eraseTenant` が、トランザクションの先頭でテナントごとの advisory lock を取り、同じテナントへの呼び出しは port ごとに直列になる（別のテナントは待たない）。
- **公開の独立関数 `runRecall`・`eraseTenant`・`purgeExpiredEventsForTenant` が投げる例外の message に、drizzle の `params:`（問いの本文を含む）が残っていた**（ADR 0430 決定3）。`Runtime` の全メソッドと同じく、`params:` より後ろを `(omitted by mnemora, N chars)` に置き換える（SQL の文・`cause`・`kind` は変わらない）。
- **`runMigrations`（と `mnemora-postgres-migrate`）が、台帳から行が欠けたまま番号の小さい migration が当たり直されるとき、警告を出すようにした（穴探し6巡目 S-1、[ADR 0425](./docs/decisions/0425-migrate-warns-on-ledger-drift.md)）。**台帳から `0011` の行だけが欠けた DB で流すと、0011 が単独で当たり直り、0018 が足した `'unsuperseded'` が `memory_events_kind_check` から黙って消えていた。未適用のファイルのうち台帳の最大の番号より小さいものが在れば、`console.warn`（`[@mnemora/postgres] migrate: …`）で名指しして続行する。止めない・適用の順序と中身は変えない（そのファイルも当てる）。公開の型・オプションは変わらない。
- **`runMigrations`（と `mnemora-postgres-migrate`）が、台帳に手元の `migrations/` に無い名前があるとき、警告を出すようにした（穴探し6巡目 S-3、[ADR 0425](./docs/decisions/0425-migrate-warns-on-ledger-drift.md)）。**新しい版で上げた DB に古い版から流すと、何も言わずに「すべて適用済み」になっていた。手元の版が DB より古い可能性を警告する。止めない。公開の型・オプションは変わらない。
- **`mnemora-postgres-migrate` の接続プールに `error` のリスナーを付けた。待機中の接続が DB 側から切られても、プロセスは落ちず、名乗って続行する。**（[ADR 0448](./docs/decisions/0448-migrate-cli-pool-error-unreadable-dir-session-settings.md)）
  - **穴**: CLI は自前の `Pool` を作り、`error` のリスナーを付けていなかった。待機中の接続が切られる（DB の再起動・フェイルオーバー）と `Unhandled 'error' event` でプロセスごと落ちる。待機中の接続が在るのは、`runMigrations` が接続を返してから `runAnalyzeMemories`・`pool.end()` までの短い間だけなので、当たる窓は狭い。
  - **いまの振る舞い**: `[@mnemora/postgres] pool の待機中の接続が失われた。捨てて続行する: <message>` を `console.warn` に出して続行する。ロックを持つ接続の切断は別の経路で、今までどおり `migration <file> failed: …` として報告される。
  - ⭕ 非破壊と数える（落ちていたものが落ちなくなる）。
- **`runMigrations` の `migrationsDir` が読めないとき、DB に触れる前に `migrationsDir を読めない（<パス>）` で落ち、`.sql` が1本も無いときは警告を出す。**（[ADR 0448](./docs/decisions/0448-migrate-cli-pool-error-unreadable-dir-session-settings.md)）
  - **いままで**: 存在しないパスは、ロック・`CREATE SCHEMA`・`CREATE EXTENSION`・台帳の作成が済んだ後に、生の `ENOENT` で落ちていた。`.sql` が1本も無いと、何も言わずに `applied: []` で成功していた。
  - **いまの振る舞い**: 読めないときは、DB に触れる前に同じく `Error`（`cause` に元の例外、`code` は元のまま。新しい例外の型は作っていない）で落ちる。`.sql` が無いときは、成功のまま `[@mnemora/postgres] migrate: migrationsDir に .sql が1本も無い。` を `console.warn` に出す。CLI の終了コードは変えていない。
  - ⭕ 非破壊と数える（落ちる入力は増えていない。失敗の文言が変わり、失敗の前の副作用が減る）。`err.message` を正規表現で拾っている呼び手は、先頭が `runMigrations: migrationsDir を読めない` に変わる。
- **`packages/postgres/README.md` に、接続・ロール・DB の `statement_timeout` などが migration の本体にも効くことを書いた。**（[ADR 0448](./docs/decisions/0448-migrate-cli-pool-error-unreadable-dir-session-settings.md)）コードは変えていない。落ちたときに巻き戻り、台帳に載らないこと・migrate を流す接続だけ無効にする書き方（【実測】）を書いた。
- **`runtime.observe({ extract: "sync" })` が、LLM を待つ間に tick に同じ extract ジョブを取られる穴を塞いだ**（[ADR 0407](./docs/decisions/0407-sync-observe-extract-job-lease.md)）。以前は、sync の observe が積んだジョブは「すぐ claim できる」状態で、observe が LLM を待つ間に tick が claim できた。すると LLM が2回呼ばれ、内容の違う記憶が2件とも active で残り、observe 自身は `complete` が `OutboxLeaseConflictError` で負けて、書き込み済みなのに失敗し `memoryIds` が返らなかった（Postgres と InMemory の両方で再現）。
  - **直し方**: sync の observe は、extract ジョブを **observe が claim 済み**（`claimed_at` = now・`claimed_by` = `"runtime.observe:sync"`・`attempts` 1）の状態で積む。リースの内側では tick は取らない。observe が LLM の途中で死んだときは、リース切れの後に tick が拾う（transactional outbox の意味は保たれる）。deferred は今までどおり。
  - **LLM がリースより長くかかり tick に取り直されたとき**: observe は `OutboxLeaseConflictError` だけを握り、書き込み済みの結果（`memoryIds`）を返す。**この窓での二重抽出は塞いでいない**（`leaseMs` を LLM の最長時間より長くとる運用で狭める。ADR 0407 の「引き受けた負債」）。
  - **公開 API に、任意項目 `MemoryStore.createObservationWithOutbox` の `opts.claimedBy?: string` を足した。**渡すと積む行を claim 済み（`attempts: 1`）で作る。省略時は今までと同じ。`@mnemora/postgres`・`@mnemora/testkit` の `InMemoryMemoryStore` は対応済み。適合テスト（`describeMemoryStoreConformance`）に指定あり・なしの2件を足した。
  - ⚠ **自前の `MemoryStore` を実装している人へ**: 型は通るが、`claimedBy` を無視する実装では穴が塞がらない（従来の動きのまま）。塞ぎたければ、渡されたら `claimed_at` = `opts.now`・`claimed_by`・`attempts: 1` で行を作ること。
  - ⚠ **挙動の変化**: sync の observe が抽出中に**例外で終わった**とき、extract ジョブは observe の claim のまま残るため、リースが切れるまで tick は拾わない（以前は未 claim で残り、直後の tick が拾っていた）。拾った後の結果は変わらない。急ぐ運用は `tick` の `leaseMs` を短くとる。ADR 0407 の決めたこと4。
  - 型は任意の欄の追加のみ。⚠ **ただし `claimedBy` を守ることを検査する `it` はフラグ無しで走るので、破壊的変更として上の `### Breaking` に数えた**（移行は [docs/migration-v1.md](./docs/migration-v1.md) の項目40）。DB マイグレーションは足していない。

- **抽出（`observe` の sync と、`tick` の deferred の extract ジョブ）が、記憶を書いたのに `created` イベントが0件のまま残る取りこぼしを、`MemoryStore` の任意メソッド `createMemoriesWithOutboxAndEvents?` で塞いだ**（[ADR 0410](./docs/decisions/0410-extract-created-event-in-same-transaction.md)、穴 D-3。[ADR 0347](./docs/decisions/0347-extract-write-path-redelivery-and-unsaveable-candidates.md)・[ADR 0100](./docs/decisions/0100-supersede-with-new-memories.md) の「守れないもの」の一部）。
  - **直した穴**: 以前は候補ごとに `createMemoryWithOutbox` で記憶をコミットしたあと、`EventStore.append` を別の文で呼んでいた。`created` の append が失敗すると `observe`／`tick` は例外になるが記憶は残り、再送や tick は「もう在る」と見て素通りして、`created` が0件のまま残った（監査ログに記憶の誕生が載らない）。
  - **今の振る舞い**: store がこの口を持つとき、全候補の記憶・outbox・`created` を **1つのトランザクション**で書く。保存できない候補（本文の NUL など。ADR 0347 決定2〜4）は候補ごとの SAVEPOINT でその候補だけ巻き戻し、`meta.droppedCandidates` は書けた候補の `created` に今までどおり付く。`created` の書き込みが失敗したら記憶も残らないので、再送・再配達で全部書き直される。全候補が落ちたら最初の例外を投げて何も書かない（今までどおり）。冪等な再送（`created: false`）では `created` を積まない。claim key の衝突検出は、書いたあとに今までどおり走る。
  - **実装したのは `@mnemora/postgres` の `PostgresMemoryStore` と、`@mnemora/testkit` の `InMemoryMemoryStore`。** `@mnemora/testkit` の適合テストに、`MemoryStoreConformanceOptions.supportsCreateMemoriesWithOutboxAndEvents?: boolean`（任意の3状態フラグ）と2本の歯を足した（Postgres とインメモリで `true`）。
  - ⚠ **この口を持たない自前の `MemoryStore` では、この取りこぼしが残る**（今までどおりの経路に落ちる。口が在って投げたときに、古い経路で撃ち直すことはしない）。範囲外として残した経路: `reextract`（`supersedeWithNewMemories` を使う経路と使わない経路）・`consolidate`（同）・`reflect` の `created`。詳しくは ADR 0410 の「残り」。
  - ⚠ `@mnemora/testkit` の `InMemoryMemoryStore` はこの口で `created` を自分の `events` 配列に積む。`InMemoryEventStore` から読むには、第2引数に `memoryStore.events` を渡して配列を共有すること（`InMemoryEventStore` のクラス doc に元からある注意。共有しない組み立てでは `EventStore.list` に出ない）。
  - 公開 API（snapshot を更新した）: `MemoryStore` に任意メソッドを1つ足した（実装しない adapter は壊れない）。`ContestedWithoutCompanionError.method` の union に `"createMemoriesWithOutboxAndEvents"` を足した——⚠ この欄で網羅的に分岐（`never` 検査）している呼び出し側は、型検査で新しい値を指摘される。
  - 非破壊（型は任意の追加のみ。正常な入力で最後に残る状態は変わらず、失敗のあとに残る状態だけが「記憶だけ残る」から「全部残らない」に変わった）。

- **`reextract`・`consolidate`・`reflect` も、記憶を書いたのに `created` イベントが0件のまま残る取りこぼしを、口を持つ store の上では塞いだ**（[ADR 0416](./docs/decisions/0416-created-event-same-tx-remaining-paths.md)、穴 D-3 の続き。上の [ADR 0410](./docs/decisions/0410-extract-created-event-in-same-transaction.md) の「残り」のうち口ありの経路）。
  - **直した穴**: 以前の `reextract`・`consolidate`（`supersedeWithNewMemories` を使う経路）と `reflect` は、記憶をコミットしたあとに `created` を別の文で積んでいた。その append が失敗すると記憶だけが残り、再試行は素通りして（`reextract`: 同じ内容の記憶が「在る」／`consolidate`: 統合元が `superseded` で対象なし／`reflect`: 孤児の反映先が残る）、`created` が0件のまま残った。
  - **今の振る舞い**: `supersedeWithNewMemories` が任意の `opts.buildCreatedEvent(memory, index)` を受け取り、`created: true` の新しい Memory の `created` を **同じトランザクション**で積み、戻り値の `createdEventsWritten: true` で積んだことを名乗る。`created` の書き込みが失敗したら新しい Memory も `supersede` も残らない。**core は、名乗られたときだけ**別の append を省く——この引数を知らない（黙って無視する）既存の adapter では、今までどおり別の文で積まれ、`created` が消える退行は起きない。`reflect` は、store が `createMemoriesWithOutboxAndEvents?`（上の ADR 0410）を持つなら、内省の Memory と `created` をその口で1トランザクションに書く。**撃って投げられたときに旧経路で撃ち直さない**（ADR 0100）。`SourceMemoryForgottenError` の扱いは変えていない。
  - **`createMemoriesWithOutboxAndEvents?` に `opts.abortIfForgotten` を足した**（`reflect` がこの口を使うため。`@mnemora/postgres` は同じトランザクションの `SELECT … FOR UPDATE` で見直す。`InMemoryMemoryStore` は `createMemoryWithOutbox` と同じく実装しない）。このメソッドは 1.2.0 で未リリースなので、リリース済みの第三者の実装は壊れない。
  - **実装したのは `@mnemora/postgres` の `PostgresMemoryStore` と、`@mnemora/testkit` の `InMemoryMemoryStore`。** `@mnemora/testkit` の適合テストに、`MemoryStoreConformanceOptions.supportsSupersedeCreatedEvents?: boolean`（任意の3状態フラグ）と歯を足した（Postgres とインメモリで `true`）。`createMemoriesWithOutboxAndEvents` の `abortIfForgotten` の歯も足した。
  - ⚠ **直していないもの**: 口を持たない adapter の経路——`reextract`・`consolidate` の `createMemoryWithOutbox` のループ、`createMemoriesWithOutboxAndEvents?` を持たない adapter の `reflect` と抽出——は今までどおり別コミットで、取りこぼしが残る。`supersedeWithNewMemories` を実装しても名乗らない adapter も、`created` は別の文のまま。名乗るのにトランザクションを張らない adapter は、この機構では見抜けない。
  - 公開 API（snapshot を更新した）: `supersedeWithNewMemories` の `opts` に任意の `buildCreatedEvent`・戻り値に任意の `createdEventsWritten`、`createMemoriesWithOutboxAndEvents` の `opts` に任意の `abortIfForgotten`、`SourceMemoryForgottenError.method` の union に `"createMemoriesWithOutboxAndEvents"`——⚠ この欄で網羅的に分岐（`never` 検査）している呼び出し側は、型検査で新しい値を指摘される。
  - 非破壊（型は任意の追加のみ）。⚠ 口あり経路では `created` と `superseded` の挿入順が入れ替わった（`created` が先）。`PostgresEventStore.list` は `at` 昇順だけで並べ、同じ `at` の並びは仕様の外。

- **`reextract` が積む `created` イベントの `at` を同じ操作の `superseded` と揃え、meta に再抽出の印 `reextracted: true` を足した**（[ADR 0422](./docs/decisions/0422-reextract-created-event-at-and-meta.md)、上の [ADR 0416](./docs/decisions/0416-created-event-same-tx-remaining-paths.md) の続き）。
  - **直した穴**: (1) `reextract` の `created` の `at` は、組み立てるときの時計の読みで、LLM の待ちの分だけ同じ操作の `superseded`（入口の `now`）より後だった。(2) `created` の meta は observe と同じ形で、再抽出から来たことが読めなかった。
  - **今の振る舞い**: `reextract` の `created` の `at` は `superseded` と同じ入口の `now`（口あり・名乗らない adapter の別の追記・口なしの3経路とも）。meta には `reextracted: true` が**足される**——既存のキー（`reason: "extracted"`・`sourceObservationId`・`extractorVersion` など）の意味は変えていない。observe・抽出の `created` の `at` と meta は今までどおり。
  - ⚠ **同じ `at` のイベントどうしの並びは約束しない。当てにしないこと。** `consolidate`・`reextract` の `created` と `superseded` は同じ `at` を持ち、`EventStore.list`（`ORDER BY at ASC`）の並びは入れ替わりうる。順が要るときは `kind` と meta（`superseded` の `meta.supersededById` など）で関係を読むこと。
  - ⚠ この版より前に書かれた `reextract` の `created` は `at` も meta も直らない（印が無いことは observe 由来を意味しない）。
  - 公開 API に変更は無い（型は変わらない。snapshot は変わらない）。非破壊（meta にキーを足すだけ）。DB マイグレーションは足していない。

- **`@mnemora/core` が利用者の手元で2つの版に分かれたとき、adapter が投げる store 例外を runtime が見分けられず、`tick()` 全体が reject される穴を塞いだ**（[ADR 0418](./docs/decisions/0418-store-error-kind-guards.md)、[PR #1509](https://github.com/takecchi/mnemora/pull/1509)）。adapter は core を `dependencies` の `^` で持つので、利用者が core を範囲外の版に固定すると、adapter 側にもう1つの core が入る。そのとき adapter が投げる例外は、runtime 側の `instanceof` で false になっていた。
  - **【実測】** 本物の `@mnemora/postgres` 1.1.0 と `@mnemora/core` 1.0.2 の組で、`tick()` の complete 経路の `OutboxLeaseConflictError` が見分けられず、runtime は `fail()` へ進み、それも CAS で弾かれて `throw failErr` になった。**`tick()` 全体が reject され、同じバッチの後続ジョブは処理されず、`leaseConflicts` も返らなかった。** `restoreArchived` では `MemoryStatusConflictError` が `kind: "failed"` になっていた（本来は `status_not_archived`）。
  - **直し方**: store 例外5クラス（`OutboxLeaseConflictError`・`MemoryStatusConflictError`・`ContestedGroupMembershipMismatchError`・`SourceMemoryForgottenError`・`MemoryPurgeConflictError`）に値の判別子 `kind` を足し、判定関数 `isOutboxLeaseConflictError` など5つを公開した。runtime と `strategies/reextract.ts` の計20か所の `instanceof` をすべてこれに置き換えた。**判定は「`kind` を見て、`kind` が無ければ `name` を見る」**——判別子がまだ無い古い版の core を引いた adapter が投げた例外にも効く。
  - ⚠ **`name` は偽装できる**が、store は利用者が自分で配線する信頼された部品なので実害は無いと判断した（ADR 0418）。core を `peerDependencies` にする案（破壊的変更）と、2つの版を検知して警告する案は採らなかった。
  - 公開 API（snapshot を更新した）: 5クラスに `readonly kind` を足し、判定関数を5つ足した。**非破壊**（追加のみ）。DB マイグレーションは足していない。

- **残りの公開エラー2クラス（`ContestedWithoutCompanionError`・`RecallOutputValidationError`）にも、値の判別子 `kind` と、`instanceof` を使わない判定関数を付けた**（[ADR 0418](./docs/decisions/0418-store-error-kind-guards.md) の追記、直前の項目の続き）。core が公開する `Error` 継承のクラス7つのうち、`kind` を持たなかったのはこの2つだけだった。
  - **付けたもの**: `ContestedWithoutCompanionError.kind` は `"contested_without_companion"`、`RecallOutputValidationError.kind` は `"recall_output_validation"`。判定関数は `isContestedWithoutCompanionError`・`isRecallOutputValidationError`（「`kind`、無ければ `name`」）。
  - 公開 API（snapshot を更新した）: 2クラスに `readonly kind` を足し、判定関数を2つ足した。**非破壊**（追加のみ）。DB マイグレーションは足していない。
  - `packages/postgres` のテスト内の `instanceof` 6行を判定関数へ置き換えた（利用者への影響は無い）。`toBeInstanceOf` / `rejects.toThrow(<クラス>)` は置き換えていない（ADR 0418 の追記に件数と理由がある）。

- **`@mnemora/testkit` の適合テストが、core の例外を `instanceof` ではなく判定関数で見るようになった**（[ADR 0418](./docs/decisions/0418-store-error-kind-guards.md) の追記、直前の項目の続き）。`describeMemoryStoreConformance`（28か所）と `describeOutboxStoreConformance`（4か所）は、`toBeInstanceOf(<クラス>)` / `rejects.toThrow(<クラス>)`（中身は `instanceof`）で `MemoryStatusConflictError` などを見ていた。利用者の手元で `@mnemora/core` が2つの版に分かれると、正しい adapter が投げた例外も別のクラスになり、これらが誤って赤になった。
  - **振る舞いの変更**: 適合テストは、adapter が投げた例外を core の判定関数（`isMemoryStatusConflictError`・`isOutboxLeaseConflictError` など。「`kind`、無ければ `name`」）で見る。core が2つの版に分かれた環境でも、正しい adapter は緑になる。`memoryId` / `expectedAttempts` などの欄を読む検査は変えていない。**別のクラスの例外・素の `Error` を投げる adapter は、これまでどおり赤になる。**
  - ⚠ 適合テストは core の判定関数（この版の core が公開したもの）を import する。判定関数を持たない古い版の core と組み合わせた testkit は動かない。
  - 公開 API に変更は無い（判定用の道具 `error-guards.ts` は export していない。snapshot は変わらない）。非破壊。

- **`runtime.resolveContestedGroup` で負けた側の `superseded` イベントの `meta` に、勝った側の id を `supersededById` として持たせた**（[ADR 0421](./docs/decisions/0421-concurrent-write-and-audit-event-holes.md)、[ADR 0150](./docs/decisions/0150-resolve-contested-explicit-operation.md) の追記に揃えた）。2者版 `resolveContested` は最初から持っていたが、群版は持たず、`memory_events` の `meta` だけを読む人には「誰に負けたか」が分からなかった（記憶の行の `supersededById` 列は今までも入っていた）。
  - 値は store へ渡している `supersededById` と同じ（`memberIds` の綴りに寄せた `winnerId`）。勝者の `updated` と `both_active` の `updated` には足さない。
  - 欄を足すだけで、既存の欄は変えていない。**非破壊**。公開 API に変更は無い（JSDoc のみ）。DB マイグレーションは足していない。
- **`@mnemora/testkit` のインメモリ `eraseTenant` が、Postgres 実装と同じく `tenant_subject_activity` を subject ごとの行で数え、消した `memories` の埋め込みも一緒に消す（`ON DELETE CASCADE` に当たる動き）ようになった**（[ADR 0426](./docs/decisions/0426-in-memory-erase-tenant-postgres-alignment.md)）。`InMemoryMemoryStore` に public メソッド `onMemoriesDeleted` が増えた（非破壊）。conformance suite の要件は変わらない。

- **`@mnemora/postgres` の `purgeExpiredEvents` が積む `events_purged` の `at` を、読み戻した値のまま `EventStore.list` の `until` に渡すと、その行自身が返らなかった穴を塞いだ**（[ADR 0427](./docs/decisions/0427-events-purged-at-millisecond.md)）。`at` を SQL の `now()`（マイクロ秒）から、他の書き込みの口と同じ JS の時刻（`toPgTimestamp`、ミリ秒）へ替えた。`at` は DB サーバの時計ではなく adapter のプロセスの時計になる。公開 API の変更は無い。

- **`PostgresMemoryStore` の `opts.abortIfForgotten` の `SELECT … FOR UPDATE`（`assertNotForgottenForUpdate`）に `ORDER BY id ASC` を足し、行ロックを他の口と同じ id 昇順で取るようにした**。`markContestedPair`・`resolveContestedPair`・`markContestedGroup` は `ORDER BY id ASC FOR UPDATE` で揃えていたが、この文だけ `ORDER BY` が無く、掴む順が実行計画（ふつうは heap の並び）に依存していた。`consolidate`・`reflect` と `markContestedPair` が同じ行を逆順で掴み合うと、40P01（`deadlock detected`）が生のまま漏れうる。歯は `packages/postgres/src/__tests__/assert-not-forgotten-lock-order.postgres.test.ts`（実際に発行された文を別接続で流し、返る行の順が id 昇順であることを見る。タイミングに依存しない）。非破壊。DB マイグレーションは無い。
  - 【確かめていないこと】2接続で実際に 40P01 を起こして直ったことまでは見ていない（歯は「掴む順が id 昇順」までを縛る）。

- **`@mnemora/testkit/fixtures` が、Postgres の `real`（float4）の列の値を、Postgres が読み戻すのと同じ値で持つようになった**（`InMemoryMemoryStore` の `strength`・`halfLifeHours`・`halfLifeRecalls`、`InMemoryTenantSettingsStore` の既定の half-life 2つ。`InMemoryVectorStore` の Issue #1268 と同じ趣旨）。`0.1 + 0.2` を渡すと、Postgres は `0.3` を返す。fixture は `0.30000000000000004` を返していた。⚠ `Math.fround(x)` の値そのものではない: Postgres は float4 の最短の10進表記で返すので、`720.1` は `720.1` のまま返る（`Math.fround(720.1)` は `720.0999755859375`）。fixture は同じ最短表記を探して返す。歯は `in-memory-fixtures-float4-readback.test.ts`（fixture）と `float4-readback.postgres.test.ts`（本物の Postgres で同じ表を確かめる）。conformance には足していない（float4 は Postgres の列の性質で、adapter 一般の契約ではない）。fixture の返す値が変わるだけで、型・シグネチャは変わらず、数えない。
  - 【確かめていないこと】`real` の列の全部（migration の `grep`: `memories` の3列と `tenant_settings` の2列）のうち、`reinforce` などが書き換える経路は、`strength`・`halfLifeHours`・`halfLifeRecalls` を書き換えないことをコードで見た（更新の口は無い）。

- **`OutboxStore` の fixture が、`fail` の `error` の NUL を6文字の `\u0000` に置き換え、`complete`/`fail` の `opts.at` を複製して持つようになった。`RelationStore` の fixture が、`listRelated` の `createdAt` を複製して返すようになった**（Issue #1108 の方針、上の `### Breaking` の項目の fixture 側）。`@mnemora/core` の `OutboxStore`・`RelationStore` の doc にも約束を書いた。

- **文書だけの訂正（挙動は変えない）**: (1) `probeTrigramLexicalSupport` の doc の「この関数自身は投げない」を、実装に合わせた（先頭の `SHOW server_encoding` と `pg_available_extensions` の問い合わせは、接続の失敗・権限の不足で reject する）。(2) `ScoringInput.similarity` の doc の「0〜1」を、負になりうると直した。`MemoryStatusConflictError` の doc の `instanceof` を `isMemoryStatusConflictError` に追随させた。(3) `SQL_ASCII` の DB では、migration 0025 の `left(content, 150000)` が文字ではなくバイトで切ることを、現行の doc に書いた（ADR 0364 に追記。実測した。migration の SQL は出荷済みなので変えていない）。(4) `docs/recall.md` に `stage_skipped` の `stage: 'relation'`・`reason: 'relation_store_unavailable'` を足し、`docs/architecture.md` の 2つの片（`RelationKind` のドラフトの囲み、`OutboxLeaseConflictError` の宣言）を直した。

- **`@mnemora/openai`・`@mnemora/anthropic`・`@mnemora/local-embedding` を直に呼んで `signal` を abort したとき、reject の値を `signal.reason` に揃えた**（[ADR 0428](./docs/decisions/0428-provider-abort-reason-and-error-guards.md)。ADR 0359 決定4の約束に実装を合わせた）。
  - openai・anthropic: reject の値が SDK の `APIUserAbortError` から `signal.reason` に**変わる**（abort 済みなら SDK を呼ばずに reject。SDK の再試行待ち＝429 の `retry-after` の最中でも abort で即座に切れる。以前は約3秒待っていた）。local-embedding: モデルの読み込み中・再試行の待ちも `signal` ごとに切れる（読み込みそのものは止まらず、同じ読み込みを待つ別の呼び出しは巻き添えにならない）。
  - 足したもの: `isOpenAILLMProviderError`・`isAnthropicLLMProviderError`（`instanceof` を使わない判定関数。ADR 0418 の作法）。3つの provider の README に `signal` の振る舞いを追記し、openai README の `kind` の列挙に `schema_unsupported` を足した。公開 API は追加のみ。

- **`observe(... claimKey: { enabled: true })` で、LLM が長すぎる `subject`・`predicate` を返すと INSERT が落ちて、observation だけが残り memory が 0 件になる穴を塞いだ**（[ADR 0433](./docs/decisions/0433-claim-key-length-space-error-reembed-limit.md) 決定1）。`@mnemora/core` の `deriveClaimKeys` は、正規化のあとで 256 コードポイントを超えた要素を含む鍵を `null` にする（空白だけの要素と同じ扱い。`failure` の印は付けない）。以前は `@mnemora/postgres` の索引 `idx_memories_claim_key`（btree、1行 2704 バイトまで）を超える値で `index row size ... exceeds btree version 4 maximum 2704` になった。256 字以下の鍵は変わらない。

- **`@mnemora/postgres` の `PostgresVectorStore` が、登録していない埋め込み空間で引かれたとき、生の `relation "memory_embeddings_..." does not exist`（`kind` なしの `Error`）ではなく、`kind: "embedding_space_not_registered"` の `EmbeddingSpaceNotRegisteredError` を投げるようにした**（[ADR 0433](./docs/decisions/0433-claim-key-length-space-error-reembed-limit.md) 決定3）。対象は `upsert`・`search`・`searchMany`・`delete`・`getVectors`。原因の Error は `cause` に残る。判定関数 `isEmbeddingSpaceNotRegisteredError` を `@mnemora/core` から公開した（`instanceof` を使わない。ADR 0418 の作法）。これまで例外にならなかった入力（形式不正な id だけの `delete`・`getVectors`、空の `searchMany`、`deleteAcrossSpaces`・`eraseTenant`）は今も例外にならない。公開 API は追加のみ。

- **`Runtime.reembed` が、`limit` を省いたとき・数なのに 0 以上の整数でないとき（負・小数・`NaN`・±`Infinity`）に、store を呼ぶ前に `RangeError`（`Runtime.reembed: limit must be a non-negative integer`）を投げるようにした**（[ADR 0433](./docs/decisions/0433-claim-key-length-space-error-reembed-limit.md) 決定4）。以前は `limit` を省くと Postgres の `syntax error at or near "FOR"` など、SQL の側の分かりにくい例外だった。`0` と正の整数は今までどおり通る。

- **`@mnemora/testkit/fixtures` のインメモリ実装を、Postgres 実装に揃えた**（[ADR 0434](./docs/decisions/0434-testkit-fixtures-align-nul-int4-invalid-date-purged-at.md)）。Postgres が拒む入力を、インメモリも同じく拒む: NUL（U+0000）を `createMemory` 系の `claimKey`・`extractorVersion`・`jobKinds`、イベントの `digestSnapshot`、`purgeMemory` の墓石、読み取りの口（`findActiveByClaimKey`・`listBySourceObservation`・`aggregateScope`・`LexicalStore.search` の `filter.attributes`・`getSubjectActivitySeqs`）に含むとき、`MemoryEvent.sizeBeforeBytes` が整数でない・int4 の範囲の外のとき、`reinforce` の `nowSeq` が整数でない・範囲の外（書くときは負も）のとき、outbox の行を書くときの `opts.now` が Invalid Date のとき。以前は通して保存し、`reinforce` は `decayBaseSeq` に `NaN` を書いていた。`createMemory` に渡した `purgedAt` は、インメモリも保存しない（Postgres と同じ。断らない）。Postgres が通す入力（境界ちょうどの値、行を書かないときの `now`・`jobKinds` など）は通したまま。`@mnemora/testkit/fixtures` は fixture なので、新しく例外を投げる変更は破壊的変更として数えない（`docs/migration-v1.md` の規律2）。公開 API に差分は無い。適合テストには足していない。

- **`@mnemora/postgres` の `createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` に長い `claimKey` を直接渡して claim key の索引の上限（SQLSTATE 54000）で落ちたとき、生の `DrizzleQueryError`（message に `Failed query: INSERT …\nparams: …` で入力の値を含む）ではなく、`kind: "claim_key_index_limit"` の `ClaimKeyIndexLimitError` を投げるようにした**（[ADR 0435](./docs/decisions/0435-claim-key-index-limit-typed-error-and-helper-tests.md)）。判定関数 `isClaimKeyIndexLimitError` を `@mnemora/core` に足した（公開 API は追加のみ）。
  - **断る入力は変えていない**（長さの上限を入口に置いていない）。今通る入力（圧縮で通る `'a'` × 10万字など）は今も通り、今 54000 で落ちる入力だけが型付きの例外になる。`@mnemora/testkit` のインメモリ実装は今までどおりどの長さも通す。
  - 包むのは claim key の索引（`idx_memories_claim_key`・`idx_memories_claim_predicates`）の上限だけ。`tags`・`subjectId` など、ほかの索引の 54000 や別の SQLSTATE は包まない。message にも `cause` にも入力の値を残さない（`cause` は pg のエラーから `code`・`schema`・`table`・`constraint` だけを写した新しい `Error`）。
  - 書きかけの残り方は変えていない: `createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories` はトランザクションごと戻る（`supersedeWithNewMemories` は旧い行が `active` のまま）。`createMemoriesWithOutboxAndEvents` は正常な候補だけ書き、悪い候補は `dropped` に積む（その `error` が今回から `ClaimKeyIndexLimitError`）。
  - あわせて、直接のテストが無かった4つの関数（`isContestedWithoutCompanion`・`findMalformedIdentifierPart`・`assertWellFormedFilter`・`isAbort`）に、TSDoc の約束を縛る単体テストを足した（振る舞いは変えていない）。

- **`PostgresMemoryStore.purgeMemory` に大文字の uuid を渡すと、`memories` の行は purge されるのに、`recalls.index_band` の目次帯の digest が書き換わらなかった**（[ADR 0438](./docs/decisions/0438-tenant-boundary-teeth-and-purge-uuid-case.md)）。入口で uuid の大文字小文字をそろえるようにした。`Runtime` 経由（小文字の id）は影響なし。落ちる入力は増えない。

- **`decay_clock=activity` で subject 単位のカウンタ（`usesSubjectActivityCounters`）を使うとき、`archiveDecayed` と `aggregateScope`（忘却ゲートの件数）が、カウンタ行を別テナント・別 subject の行と区別していなかった**（ADR 0438）。`tenant_subject_activity` の行が2本以上あると「more than one row returned by a subquery」で落ち、1本だけのときは別テナント・別 subject のカウンタで判定していた。相関サブクエリに修飾した `tenant_id`/`subject_id` を渡すようにした。壁時計のゲート・テナント単位のカウンタ・`search`・`reinforce` は影響なし。

- **`observe` に `extractionContext: { timeZone }` と、年が 1000 未満・10000 以上・紀元前の `occurredAt` を渡すと、LLM を呼ばずに全文フォールバック（`extraction: "llm_failed_whole_observation"`、`failure.message` は `Invalid time value`）へ黙って倒れていたのを、約束どおり抽出するようにした**（[ADR 0440](./docs/decisions/0440-outbox-first-terminal-wins-extraction-local-date-years-bullmq-stalled.md) 決定1）。node の `Intl.DateTimeFormat("en-CA")` は年を4桁に0詰めせず（`"999-06-01"`・`"10000-01-01"`）、紀元前は符号を落とす（天文学年 0 が `"1"`）ため、その文字列を `Date.parse` に渡すと NaN になっていた。年月日を `formatToParts` で取り、`era` で紀元前を符号付きの天文学年に戻し、`setUTCFullYear` で組み直す。
  - **プロンプトに出す暦日（`observedLocalDate`・`relativeDates`）の書き方は `Date#toISOString` と同じ**（0〜9999 年は4桁に0詰め、範囲外は `+010000-01-01`・`-000100-06-01` の符号付き6桁）。**1000〜9999 年と `timeZone` 無しは、プロンプトの content を1バイトも変えていない**（直す前の出力を固定値で縛った）。ただし、現地の暦日が 9999-12-31 のとき、`relativeDates` の「明日」「明後日」は、以前は `"+010000-01"` と切れた文字列だったのが `"+010000-01-01"`・`"+010000-01-02"` になる。`Date` の範囲（±8.64e15 ms）の外へ出る日付は、落ちずに `null` になる。

- **`OutboxStore.complete`/`fail` を、同じリース（同じ `attempts`）での2回目の呼び出しで、1回目の終端の値を保つ（先勝ち）ようにした**（[ADR 0440](./docs/decisions/0440-outbox-first-terminal-wins-extraction-local-date-years-bullmq-stalled.md) 決定2）。以前は complete×2 で `completedAt` が2回目の `at` に、fail×2 で `failedAt`・`lastError` が2回目の値に上書きされ、`purgeCompletedJobs` の `olderThan` の境界も後ろにずれた。`@mnemora/postgres` は `UPDATE` の `WHERE` を `completed_at IS NULL AND failed_at IS NULL` の両方にし、`@mnemora/testkit/fixtures` のインメモリ実装も揃えた。**戻り値（`void`）と例外は変えていない**（`attempts` 不一致は `OutboxLeaseConflictError`、行が無ければ no-op、終端後の `claimBatch` は0件）。

- **LLM が返した `digest`・`tags`・claim key が保存できない値のとき、候補ごと捨てずに、その欄だけを落とすようにした**（[ADR 0443](./docs/decisions/0443-aux-field-drop-bind-limit-association-fetch.md) 決定1）。以前は、本文が正しくても NUL を含む `digest`・`tags` の要素が1つあるだけで、その候補が `createMemoryWithOutbox` に拒まれて捨てられた。いまは `digest` が NUL を含めば本文の先頭を切り出したフォールバックに、`tags` は NUL を含む要素だけを捨て、claim key は NUL を含めば `null` になる。`observe`（sync・deferred）と `reextract` が対象。落とした `digest`・`tags` は `created` イベントの `meta.droppedFields` に残る（値は写さない。落とさなければ `meta` は変わらない）。長さでは落とさない（既知の限界: 圧縮が効かない長い tag は、今までどおり GIN 索引 `idx_memories_tags` の上限で落ちうる）。本文の NUL は従来どおり候補ごと落ちる。`consolidate`・`reflect` は対象外。
- **`@mnemora/postgres` の `reinforceMany`（`observe({ kind: "memory_usage" })` の強化を含む）と `searchMany` が、id・クエリの件数が多いと PG のバインドパラメータの上限（65535）で落ちる崖を無くした**（ADR 0443 決定2）。以前は `reinforceMany`・`memory_usage` が 13107 件で、`searchMany` が 32767 件で、message が何 MB にもなる例外で落ちた。`reinforceMany` は列ごとの配列を `unnest` で渡す（1文のまま）、`searchMany` は 16384 件ずつの文に分けて同じトランザクションで撃つ。結果は変わらない。
- **連想枠（`anchorCount`）の計算量を文書に書いた**（ADR 0443 決定3。コードは変えていない）。アンカーごとに引く件数は `kPrime` のまま、O(`anchorCount` × `limit`)。絞ると `recall()` の結果（`memories` と `omitted` の件数）が変わることを差分試験で確かめたので、絞っていない。
- **`@mnemora/local-embedding` の `embed()` が、件数が `maxBatchSize`（既定128）を超えて分割されたとき、チャンクの合間で `signal` の abort を見るようになった**（[ADR 0445](./docs/decisions/0445-local-embedding-chunk-abort-chat-drain-provider-docs.md)）。以前は abort の後も残りのチャンクをすべて推論してから reject していた。動いている1チャンクは今までどおり止まらない。reject の値（`signal.reason`）は変わらない。件数が `maxBatchSize` 以下の呼び出しは1バイトも変わらない。
  - 文書: `@mnemora/anthropic` の README に、`maxTokens` を約21,333より上げると SDK が streaming を求めて素の例外で落ちること（`client` に `timeout` を明示すれば通る）を、openai・anthropic の README に、SDK の `timeout` が試行ごとに効くこと・本文が途中で切れた失敗は再送されないこと・再送に冪等キーが付かないことを、`@mnemora/local-embedding` の README に「`lib`・`target` は ES2022 以上」を足した。

- **`@mnemora/postgres`: Postgres の再起動を数回挟むと pool が枯れて全呼び出しが止まる穴を塞いだ。`db.transaction()` の `rollback` が失敗しても、元のエラーが消えなくなった。**（[ADR 0444](./docs/decisions/0444-pool-begin-release-rollback-error-preserved.md)）
  - **穴（pool の枯渇）**: drizzle-orm 0.45.2 の `NodePgSession.transaction` は `begin` を `try`/`finally` の外で実行するので、`begin` が reject すると借りた接続が pool へ戻らなかった。`pg_ctl restart -m fast` を繰り返すと pool が枯れ、全呼び出しが止まった（手元の実測では10回目の再起動の後）。上流の不具合で、`createPostgresClient` が drizzle へ渡す pool の `connect` の包みで直した（`begin` が失敗したら `release(err)` して接続を捨てる。`release` は冪等）。
  - **穴（エラーの消失）**: drizzle は `rollback` が投げると元のエラーを捨てるので、接続ごと切れたとき、呼び出し側に `Failed query: rollback` しか残らなかった（`forget`・`purge` の `outcomes[].error` も）。いまは **元のエラー（`57P01` など。`code` は `err.cause.code` か `err.code`）が投げられる**。`rollback` の失敗は、元のエラーの `cause`（空いていれば）か `rollbackError` に残る。新しい例外の型は無い。
  - `closePostgresClient` は、`client.pool.end()` が既に直接呼ばれていても reject しない（以前は `Called end on pool more than once`）。
  - 文書: `packages/postgres/README.md` の「例外の見分け方」に、pool の枯渇時と再起動の最中に出る例外の形（`err.code` と `err.cause?.code` の3つの形）を書いた。形は揃えていない。

- **LLM が返した値に、保存できない形（NUL・孤立サロゲート）が入っていても、`observe`・`consolidate`・`reflect` が例外で終わらないようにした**（[ADR 0456](./docs/decisions/0456-llm-returned-values-malformed-read-filter-nul-named.md)）。
  - 抽出の候補の `subjectId`（`subjectCandidates` を渡さない経路）が NUL・孤立サロゲートを含むと、保存の口が `MalformedIdentifierError` を投げて同期の `observe` が例外で終わり、observation だけが残って記憶は0件だった。その `subjectId` を弾き、observation の `subjectId` で記憶を作る（`sanitizeCandidateSubjectId`）。
  - 統合・内省の LLM が返した `digest`・`tags` が NUL を含むと、`DrizzleQueryError` で例外になった（統合元・材料は `active` のまま）。ADR 0443 が抽出にしたのと同じく、その欄だけを落として記憶を作る（落とした欄は `created` イベントの `meta.droppedFields`）。
- **`@mnemora/postgres`: 読み取りの絞り（`labels`・`attributes` の key と value）・claim key・`extractorVersion` に NUL を渡したとき、DB の生の例外（`Failed query: …`）ではなく、DB に触れる前の名指しの例外（`<口>: <欄> must not contain NUL characters (U+0000)`）で断る**（ADR 0456。ADR 0424 O-6-1 の続き）。対象は `aggregateScope`・`findActiveByClaimKey`・`findContestedByClaimKey`・`listBySourceObservation`・`PostgresLexicalStore`/`PostgresTrigramLexicalStore`/`PostgresVectorStore` の `search`（と `searchMany`）。断る入力は増えていない（以前も同じ入力で例外だった）。

- **`@mnemora/postgres`: `MemoryStore` の書き込み口に渡した `NewMemoryEvent.memoryId` が別テナントの記憶でも、イベントが書けた穴を塞いだ**（ADR 0456 の H4。ADR 0436・0439 の続き）。`updateStatusWithEvent`・`supersedeWithNewMemories`・`purgeMemory`・`markContestedPair`・`resolveContestedPair`・`resolveOrphanedContested`・`markContestedGroup`・`resolveContestedGroup`・`createMemoriesWithOutboxAndEvents` が、書く前に `event.memoryId` が `ctx` のテナントの記憶かを確かめ、違えば `memory not found for tenant` で断る（status の更新ごと戻る）。`Runtime` は常に自分の行を指すので、正規の呼び出しは影響を受けない。**破壊的か**: 型・シグネチャは変わらない。以前は通っていた、別テナントの記憶を指すイベントを新しく断る（自前の呼び出しでそのような `event.memoryId` を渡していた場合だけ）。**移行の手順**は [docs/migration-v1.md](./docs/migration-v1.md) の項目52（[ADR 0461](./docs/decisions/0461-v1-2-0-release-prep-inspection.md) で、🔴 の一覧に足した）。

- **`@mnemora/core`: `compareWithFullLog` が NaN の入力で結論を出さなくなり、`calibrateRecallFootprint` が非有限の標本・合計のオーバーフローで NaN・Infinity の係数を『較正済み』の顔で返さなくなり、標本が約12万件を超えても `RangeError` にならなくなった**（[ADR 0467](./docs/decisions/0467-recall-footprint-nonfinite-inputs-fallback-digest-grapheme.md)、穴探し38巡目）。
  - `compareWithFullLog`: `shape` の `memoryCountInScope`・`limit`・`digestBandLimit`・`associationCount`、または `fullLogChars` が NaN のとき、以前は `verdict: "full_log_smaller"`（`estimatedShare` は NaN か `Infinity`）を返していた。今は `verdict: "too_close_to_call"`・`estimatedShare: NaN`・`reasons` に `within_tolerance` なし。この状態を名乗る `reasons` の code は無い（足すと公開の型が変わる。ADR 0467 の材料）。有限な入力の結果は変わらない。
  - `calibrateRecallFootprint`: `totalChars`・`memoryCount` が有限でない標本は使える標本に数えない（`sampleCount` は使った分）。傾き・切片が有限にならないとき（合計のオーバーフロー）は、既定値から借りて `borrowedFromDefault` に名前で出す。標本の `memoryCount` の最小・最大の求め方を、スプレッド引数を使わない形に替えた。
  - 公開の型・既定値は変えていない。非破壊と数える（NaN・Infinity・巨大な標本という、以前は意味のある値を返さなかった入力の結果だけが変わる）。

- **`@mnemora/core`: LLM が digest を返さないとき（または抽出が失敗したとき）の機械的な digest（`digestFallbackLength` で切る先頭の文字列）が、書記素の途中で切れなくなった**（[ADR 0467](./docs/decisions/0467-recall-footprint-nonfinite-inputs-fallback-digest-grapheme.md)、ADR 0424 O-5 の続き）。
  - 長さの境界が NFD の結合文字（「が」を `か` + 結合濁点で書いた文字列）・ZWJ で繋いだ絵文字・国旗の途中に落ちると、以前はその途中で切って「か」や ZWJ の片割れが残った。今はその書記素の手前で止める。長さちょうどに収まるなら残す。NaN・0・負・小数・`Infinity` の長さの結果は変えていない。
  - **これから書く digest だけが変わる。保存済みの digest は書き換えない。** digest は `contentHash`・冪等キー・既定の埋め込み入力（`content`）に入らない。公開の型・既定値は変えていない。非破壊と数える。
    ⚠ 新旧の digest が混在する（区別する欄は無い。`reextract` で書き直された記憶から新しい形になる）。`embeddingInput` で digest を埋め込む構成では、これから書く記憶の埋め込み入力が数文字変わる。

- **`@mnemora/core`: recall footprint の見積もりの桁の数えが 1e21 以上の件数でも正しくなり（`estimateRecallFootprint` の `chars`）、失敗の説明（outbox の `last_error` などに入る文字列）を上限（4096字）で切るとき、書記素の途中で切れなくなった**（[ADR 0470](./docs/decisions/0470-footprint-digits-failure-description-grapheme.md)、ADR 0467 の材料の続き）。
  - 件数が 1e21 以上のとき、桁数を指数表記（`"1e+21"`）の文字数で数えていた。10進の桁数で数える。1e21 未満と、`Infinity`・`NaN` の結果は変えていない。
  - 失敗の説明は、境目が NFD の結合文字・ZWJ の絵文字・国旗の途中に落ちると、その途中で切っていた。今はその書記素の手前で止める。`… (truncated by mnemora, original length N chars)` の書き方、`N`（UTF-16 の長さ）、上限を超えないことは変えていない。⚠ **これから書く値だけが変わる。保存済みの `last_error` は書き換えない**——同じ失敗でも、直す前に書いた値と後に書いた値で、切り口が数文字違うことがある。
  - 公開の型・既定値は変えていない。非破壊と数える。

- **`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`: claim key の矛盾検出（`findActiveByClaimKey?`・`findContestedByClaimKey?`）が、空の区間（`validFrom === validUntil`）・逆転した区間（`validFrom > validUntil`）の記憶を、有効期間が重なるものとして返さなくなった**（[ADR 0473](./docs/decisions/0473-validity-empty-inverted-interval-no-overlap.md)）。どの時点でも真でない記憶が、同じ claim key の有効な記憶を `contested` にしていた。入力は拒まない。
  - 問い合わせ側が空・逆転した区間のときは何も返らない。保存済みの行がそうなら、どの問い合わせにも返らない（3実装とも）。`markContestedGroup?` の組の判定は変えていない。
  - 公開の型・既定値は変えていない。非破壊と数える（断る入力は増えない。`contested` になる組が減る）。

- **`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`: `subjectId` が `constructor`・`toString`・`valueOf`・`hasOwnProperty`・`__proto__` のとき、subject 別の活動カウンタの読みが壊れて、活動時計の起点（`decayBaseSeq`）に関数や `[object Object]` の混ざった文字列が書かれる（実 Postgres では `observe` が落ちる）のを直した**（[ADR 0472](./docs/decisions/0472-subject-activity-seqs-object-prototype-keys.md)、穴探し43巡目）
  - 原因: `readSubjectActivitySeqs` が store の結果を `result[id] ?? 0` で引いていた。行が無い subject（adapter はキーを省略する）では、`Object.prototype` 側の関数が返って `?? 0` が効かず、`T + S_x` が文字列連結になった。`__proto__` は、プレーンな `{}` への代入が黙って捨てられ、行があっても値が効かなかった。Postgres・InMemory・core のテスト用 fake の `getSubjectActivitySeqs` も同じ形で `__proto__` の行を落としていた。
  - 今は、store の結果を自前のキーだけ・有限の数だけ読み、組み立てる側は prototype の無いオブジェクトにする。`plain` な subjectId の結果は変わらない。公開の型（`SubjectActivitySeqs`・`getSubjectActivitySeqs?` の戻り型）は変えていない。
  - 同じ形の `intersectAttributes`（consolidate・reflect の `attributes` の積集合）も直した: 全件が持つ `__proto__` の属性が統合先の記憶から消えていた。
  - 非破壊と数える（以前は意味のある値を返さなかった入力だけが変わる）。⚠ `attributes` のキーが `__proto__` だと zod の record が黙って落とす件（recall の絞り込みが効かなくなる向き）は直していない（新しく断るか仕様を変える側。ADR 0472 の負債1）。

- **`@mnemora/core`: `RecallQuery.tags` の重複の数え方と、`normalizeClaimKeyPart` のべき等が破れる入力を文書にした。実装は変えていない**（[ADR 0474](./docs/decisions/0474-recall-query-tags-duplicates-claim-key-normalize-idempotent.md)、穴探し45巡目）
  - `RecallQuery.tags`（TSDoc と `docs/recall.md` §7）: `tagMatch = 1 + 0.1 × m` の `m` は、クエリの `tags` の要素ごとに記憶の `tags` との完全一致を数える。**クエリ側の重複は重複のまま数える**（`["a","a"]` は 1.2、`["a"]` は 1.1）。記憶側の重複は 1 回。以前から同じ挙動を、書いて歯（`tag-match-query-duplicates.test.ts`）で縛った。
  - `normalizeClaimKeyPart` の TSDoc は「べき等。常に成り立つ」と書いていたが、「大文字 + 結合文字」の一部の入力（ギリシャ文字の大文字 + U+0342、`H` + U+0331 など。総当たりで 253 組）では 1 回目と 2 回目の結果が変わる。TSDoc を「ほとんどの入力で」に改め、例外を `it.fails` の歯で記録した。**直していない**: 直すと保存済みの鍵と新しい鍵が食い違い、contested の検出を新しく逃す。直し案と選択肢は ADR 0474。
  - 非破壊と数える（文書と歯だけ）。

- **`@mnemora/bullmq`: `createBullmqTickDriver` の `everyMs`・`jobName`・`queueName` が検査されないこと、不正値で何が起きるかを、実 Redis（redis-server 7.4.7・bullmq 6.3.8）で測って README と TSDoc に書いた。実装は変えていない**（[ADR 0477](./docs/decisions/0477-bullmq-tick-driver-everyms-jobname-queuename-not-checked.md)、穴探し48巡目）
  - `everyMs` が `0`・`NaN`・`null`・`Infinity` なら `start()` が reject する。**負の値・`1` 未満の小数・`1e21` と、空文字の `jobName` では、`start()` が成功したまま tick が数回（1回）で黙って止まる**（`onTickError` にも届かない）。`queueName` の空文字・`:` は `createBullmqTickDriver(...)` が同期的に投げる。止まったことの見分け方は README の節に書いた。
  - 構築時に検査して断るのは新しく断る入力なので、直していない（ADR 0477 の材料）。「そのまま渡す」を縛る歯（`tick-driver.option-passthrough.test.ts`、Redis 不要）を足した。
  - 非破壊と数える（文書と歯だけ）。
  - ⚠ **後日の追記（ADR 0498）**: 上の「直していない」は、オーナーが v1.X.0 での破壊的変更を許したので、`everyMs`・`jobName` を構築時に断る形に替えた。`### Breaking` の「provider のコンストラクタと `createBullmqTickDriver`」の箇条を見ること。

- **`examples/chat`: README に、ソースが読むのに載っていなかったフラグと環境変数の一覧を足した。実装は変えていない**（[ADR 0478](./docs/decisions/0478-example-chat-readme-flags-env-coverage.md)、穴探し49巡目）
  - `answer-time-weighting` の `--trials=N`・`--temperature=N`、`MNEMORA_BENCH_CHANNELS`・`MNEMORA_LEXICAL_STORE`・各サブコマンドの `MNEMORA_*_JSON`・`consolidation-cost`／`archive-sweep-cost` の調整用変数など、`cli.ts` のサブコマンドが読む変数を、新しい節「フラグと環境変数の一覧」に表にした。既定値の数は書き写さず、持っている定数・関数を指した。`src/scripts/*`・`src/bench/*` の単発の測定スクリプト専用の変数は載せない基準を節の冒頭に書いた。
  - 載せると決めた名前が README に在り、ソースが読んでいることを縛る歯（`scripts/__tests__/example-chat-readme-flags-env.test.mjs`）を足した。`docs/` と README のコード片・散文の数値を型・定数と突き合わせた結果（ずれなし）は ADR 0478。
  - 非破壊と数える（文書と歯だけ）。

- **`@mnemora/core`: `RuntimeDeps.embeddingInput`（利用者のフック）の戻り値は検査も変換もされない、という今の振る舞いを TSDoc に書き、歯で縛った。実装は変えていない**（[ADR 0489](./docs/decisions/0489-embedding-input-hook-return-values.md)、穴探し58巡目）
  - 空文字・NUL・孤立サロゲート・巨大な文字列、型の外の値（`undefined`・数・オブジェクト・`null`）も、そのまま `embed()` に渡る。落ちれば `embeddingStatus: 'failed'`、受け入れれば `'ready'`。`reembed()` の後の `tick` でフックはもう一度呼ばれる。静かな破損も、TSDoc の約束との食い違いも見つからなかった。
  - 非破壊と数える（文書と歯だけ）。

- **`@mnemora/core`: `detectContested` の TSDoc に、別々の observation に分かれた、相対的な期間（去年／今年）だけが違う正しい 2 主張も contested になる、という今の限界を書き、歯で縛った。実装・プロンプトは変えていない**（[ADR 0491](./docs/decisions/0491-claim-key-relative-period-across-observations.md)、Issue #1436）
  - 相対的な期間は `validFrom`/`validUntil` に入らないので、有効期間の重なり判定が「重なる」と答える。同じ発話の兄弟は ADR 0377 で除かれるが、別 observation は除かれない。呼び出し側は `observe()` に期間を明示すれば、重ならない対は contested にならない。直し方（抽出で期間を入れる／claim key のプロンプトで別の predicate にする）は既定の経路の文言を変えるのでオーナーの判断待ち。
  - 非破壊と数える（文書と歯だけ）。

---

## [1.1.0] - 2026-09-30

**この節は `v1.0.2`（tag が指す `b981ecd`）… `v1.1.0` の差分である。**`v1.1.0` の tag が指す commit は、この見出しに日付を入れた PR より後の `main` であり、GitHub Release `v1.1.0` が正本である（⛔ ここに sha を写さない——`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。

⚠ **2026-09-30 追記**: 見出しの「未リリース」を、出す日付（日本時間）に起こした（別の節を足していない。`docs/release-v1.md` §0 の 0.10）。**下の前書きと追記は、未リリースの時点で書かれたものであり、書き換えていない**——その中の「tag はまだ切られていない」「数えた範囲」などの記述は、書いた時点の記録として読むこと。オーナーの指示（2026-09-30、この版を `v1.1.0` として出す）に基づく。

⚠ **2026-09-29 追記（[Issue #762](https://github.com/takecchi/mnemora/issues/762)、[PR #1387](https://github.com/takecchi/mnemora/pull/1387)）**: 下の出荷済みの節（`[1.0.2]` 以前）が参照している `docs/roadmap.md` の §7 などは、#762 で削除した。出荷済みの節は1バイトも書き換えていない。当時の本文は [`635c93d` の固定リンク](https://github.com/takecchi/mnemora/blob/635c93d/docs/roadmap.md) にある。7項目の現在地は [docs/north-star-paths.md](./docs/north-star-paths.md) を見ること。

**この節は `v1.0.2` からの差分を対象とする。**

⭐ **数えた基準を明記する。**この節は `v1.0.2`（tag が指す `b981ecd`、PR #1098）… **`62def34`**（PR #1434）の範囲を
数えたものである（2026-09-27 の4回目の棚卸しで `3a8448c` から、5回目の棚卸しで `9b6eca2` から、6回目の棚卸しで `4514cec` から、7回目の棚卸しで `9f58833` から、8回目の棚卸しで `ef03a8f` から、2026-09-28 の9回目の棚卸しで `23f0076` から、10回目の棚卸しで `c6ca5a4` から、11回目の棚卸しで `de8a160` から、12回目の棚卸しで `dcf6ccb` から、13回目の棚卸しで `7d5f944` から、15回目の棚卸しで `a2fb621` から、16回目の棚卸しで `9378719` から、2026-09-29 の17回目の棚卸しで `0d282c1` から、18回目の棚卸しで `86b42b1` から、19回目の棚卸しで `f5ad59f` から、20回目の棚卸しで `80c79df` から、21回目の棚卸しで `329bdb1` から、22回目の棚卸しで `fd20e14` から、23回目の棚卸しで `54b05bc` から、24回目の棚卸しで `c04ae5d` から、25回目の棚卸しで `1998b2b` から、26回目の棚卸しで `7e1c68a` から、2026-09-30 の27回目の棚卸しで `62def34` から広げた（14回目は直すものが無く、sha を進めなかった。⚠ 19回目の棚卸しの追記は**追記20**である——追記19 は #1376 が足した「保留の解消」に既に使われており、棚卸しの回ではない。下の追記20 に同じ注記がある。⚠ 同じ理由で、22回目の棚卸しの追記は**追記24**である——追記23 は PR #1393 が着地時に足した「破壊的変更の確定」に既に使われており、棚卸しの回ではない。下の追記24 に同じ注記がある。⚠ 「追記25」は2か所で使われている——23回目の棚卸し自身の段落と、PR #1408 が着地時に足した段落である。下の追記26 に同じ注記がある。⚠ 「追記28」も2か所で使われている——26回目の棚卸し自身の段落と、PR #1431 が着地時に足した段落である。下の追記28 に同じ注記がある）。下の追記4〜追記13 と追記15〜追記18・追記20・追記21・追記22・追記24・追記25・追記26・追記27・追記28・追記29。それより前の棚卸しの経緯は `## [1.0.2]` 節にある）。
⭐ **この sha が名乗るのは「この節がどこまで数えたか」であって、「ここで打ち切った」ではない。**
⟹ ⭕ **`origin/main` がこれより進んでいても、この節は腐っていない**——**まだ数えていない範囲が
増えただけである。**🔴 **この性質が成り立つのは、この節が件数を持たないからである。**
⛔ **ここに件数を書かないこと**（[ADR 0234](./docs/decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。

🔴 **2026-09-27 訂正: この節はこれまで「`v1.0.1` からの差分」を名乗っていたが、オーナーは 2026-09-27T01:58:27Z に Release `v1.0.2`（tag が指す commit は `b981ecd`、PR #1098）を作り、npm へも公開していた**（`@mnemora/core` の `dist-tags.latest` が `1.0.2`、2026-09-27T02:05:56Z 公開）。⟹ **この節は `v1.0.2` から数え直した。`v1.0.1`…`b981ecd` に入った項目と、その計上の経緯（前書きの `dce0f71` の判定・追記〜追記3）は、下の `## [1.0.2]` 節へ移した。**どの項目を移すかは、その変更を入れた PR のマージコミットが `v1.0.2` の祖先かどうか（`git merge-base --is-ancestor <マージコミット> v1.0.2`）で、項目ごとに決めた。Issue 番号でしか受けていない項目は、その Issue を直した PR で決めた。

**postgres 利用者へ**: `v1.0.2` から新しいマイグレーションが2本増えている
（`0023_lexical_query_inner_quote_as_space.sql`、語彙チャンネルのクエリの `"` の扱い、PR #1187。
`0024_tenant_subject_activity.sql`、活動時計の subject 単位のカウンタ、PR #1380。⚠ **2026-09-29 訂正（22回目の棚卸し）**:
この行はここまで「1本」のまま `0023` だけを数えており、`0024` を書き漏らしていた——`0024` は21回目の棚卸し（追記22）の
時点で既にこの節の範囲に入っていたが、この案内の行は直っていなかった。気づいた時点で直す。**クローン miku の判断であり、
オーナーの判断ではない**）。⟹ `v1.0.2` から
この節までの範囲へ上げる場合は `npx mnemora-postgres-migrate`（または `runMigrations`。このリポジトリの workspace 内なら
`pnpm --filter @mnemora/postgres run migrate`）が要る。（⚠ 2026-09-27 訂正: この行は workspace 内の形だけを書いていた。
利用者のプロジェクトではその形は打てない。`docs/migration-v1.md` の「v1.0.2 → 次の版」の実測を参照）
**`v1.0.1` 以前から直接この節までの範囲へ上げる場合は、下の `## [1.0.2]`・`## [1.0.1]` 節の migrate 案内も
合わせて読むこと**（`v1.0.1` からは `0022`〜`0024` の3本、`v1.0.0` からは `0019`〜`0024` の6本が要る）。

⚠ **2026-09-29 追記（Issue #1222、[PR #1406](https://github.com/takecchi/mnemora/pull/1406)、[ADR 0364](./docs/decisions/0364-lexical-tsvector-fallback-for-oversized-content.md)）**（⚠ 2026-09-29 訂正・23回目の棚卸し: この段落はここまで「PR 未定」のまま書いていた——`a53b2b7` #1406 として着地済みなので、PR 番号のリンクを足した。数値・本文は着地時点のまま書き換えていない）:
マイグレーションが1本増え、上の「2本」は**3本**（`0023`〜`0025`）になった——
`0025_lexical_tsvector_fallback.sql` は `idx_memories_lexical`（語彙チャンネルの式索引）を
`DROP INDEX` + `CREATE INDEX` で作り直す（`CONCURRENTLY` 不可）。**この migration の適用中、
`memories` への読み書きが `ACCESS EXCLUSIVE` ロックで止まる**——【実測】10万行で約1.2秒
（行数にほぼ比例して伸びる見込み）。あわせて、この索引式を通る `memories` への
INSERT/UPDATE が恒常的にわずかに遅くなる（【実測】10万行の INSERT で約+17.6%）。
実測の詳細は ADR 0364「実測」節、[docs/migration-v1.md](./docs/migration-v1.md) にも同じ数値を書く。
`v1.0.1` からは `0022`〜`0025` の4本、`v1.0.0` からは `0019`〜`0025` の7本が要る。

**保留と非破壊の数え方**は、下の `## [1.0.2]` 節の前書き（追記とその訂正）の基準をそのまま使う。公開の fixture が、これまで受け入れていた不正な入力に新しく例外を投げるものは、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。⚠ 2026-09-28 更新: 回答が出るまでは「計上を保留する（オーナーへの問い `3f3411c5`、未回答）」と書いていた。下の追記4〜18 の「保留」は、書いた時点の記録として書き換えていない。下の追記19 を参照）。例外を投げなくなった修正・例外を投げず結果だけが変わる修正・本物の adapter が一度も意図どおりに動いたことの無い入力を早めに拒む修正は、非破壊（⚠ 付き）と数える。**この後者の判定はクローン miku の判断であり、オーナーの判断ではない**（覆りうる）。

**PR #1187 の数え方**: `@mnemora/postgres` の語彙チャンネルが語の途中の `"` を空白として扱うようにした件も非破壊の Fixed と数える——例外を投げず、一致だけが変わる（**クローン miku の判断であり、オーナーの判断ではない**）。（⚠ 2026-09-27: PR #1187 はこの一文を、当時 `[1.1.0]` の前書きに在った追記2 の末尾に足していた。追記2 は `v1.0.1` の範囲の記録として `## [1.0.2]` 節へ移したので、`v1.0.2` より後の PR #1187 の一文だけをここへ移した）

**PR #1273 の数え方**: `@mnemora/testkit/fixtures` の `InMemoryVectorStore` がベクトルとクエリを float4 に丸めるようにした件も非破壊の Fixed と数える——例外を投げる入力の集合は変えず、距離の値と、距離が float4 で同点になる組の並びだけが変わる（**クローン miku の判断であり、オーナーの判断ではない**）。

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`（`v1.0.2` と同じ）。

**⚠ 2026-09-27 追記4（4回目の棚卸し。`9b6eca2` まで広げた）**: `3a8448c`…`9b6eca2` に `main` へ入った PR を全部当てた（3回目の棚卸しの PR #1107 と並行して入った PR #1100・#1102・#1104 も含む）。出荷される6パッケージの利用者に見える変更は、どれもこの節に載っている。docs だけ・テストだけ・scripts だけ・`examples/chat` だけの PR は載せていない（`docs` を名乗って出荷の `src` を触った PR は、差分がコメントだけであることを確かめた）。公開 API の型の差分は、`@mnemora/testkit` の `InMemoryMemoryStore` に private メンバ `rawGet` が1つ増えたことだけである（PR #1114。このクラスは以前から private メンバを持つので、型の互換の性質は変わらない）。実行時の変化の分け方は各項目の ⚠ のとおり——保留は PR #1135 の `registerLabel` の NUL と PR #1157 の `listActiveClaimPredicates` の `limit`（公開の fixture が不正な入力に新しく例外を投げる。問い `3f3411c5` の射程）、ほかは非破壊である。棚卸しで直したもの: PR #1135・#1143・#1146・#1150・#1152・#1155・#1157 の項目に PR 番号を足した（どの番号でも受けていなかった）。
⚠ **PR #1156（Issue #1151）の `registerEmbeddingSpace` が、同じテーブル名に潰れる別の埋め込み空間の登録を新しく拒むようになった件は、非破壊（⚠ 付き）の Fixed と数える**（**クローン miku の判断であり、オーナーの判断ではない**）。以前の「通る」は、2つの空間のベクトルが黙って混ざり、検索が別の空間の結果を返す状態だった。約束（1空間＝1テーブル）の上では一度も正しく動いておらず、例外を投げない代わりにデータを壊していたのを、壊す前に拒むように直したものである。ただし射程として、衝突する2空間を起動のたびに両方登録していたデプロイは、この版から2つ目の登録で落ちるようになる（項目の ⚠ に書いた）。

⟹ **この節の範囲（`v1.0.2`…`9b6eca2`）で、確定した破壊的変更は無い（上の保留を除く）。**（⚠ 2026-09-27 訂正: 書いた時点では `v1.0.1`…`9b6eca2` と名乗っていた。`v1.0.2` の出荷に伴い、この節の起点を `v1.0.2` に直した。`b981ecd`…`3a8448c` に入った PR #1100・#1102・#1103 は docs・テストだけで、この節の項目は無い）

**⚠ 2026-09-27 追記5（5回目の棚卸し。`4514cec` まで広げた）**: `9b6eca2`…`4514cec` に `main` へ入った PR を全部当てた（PR #1147・#1159・#1161〜#1163・#1165〜#1167・#1169〜#1178）。出荷される6パッケージの利用者に見える変更は、どれもこの節に載っている。docs だけ・テストだけ・scripts だけ・ADR だけの PR は載せていない（`docs` を名乗って出荷の `src` を触った PR #1163・#1166・#1167・#1172・#1174・#1178 は、差分がコメントだけであることを確かめた。README だけを変えた PR #1159・#1169 も載せていない）。PR #1176 は出荷の `src` のコードを変えたが、`pg_trgm.word_similarity_threshold` を `SET LOCAL` の文字列へ埋め込む形から `set_config` の引数で渡す形にしただけで、閾値は構築時に `[0, 1]` の有限の数に検査済みなので結果は変わらず、載せていない。公開 API の型の差分は追加だけである——`@mnemora/core` に `EVENT_RETENTION_KIND_INVALID_MESSAGE` と `assertValidEventRetentionKind` が増えた（PR #1171。上の Added）ことと、`@mnemora/openai` の宣言の `import { z } from "zod"` が `import type { z } from "zod"` になった（PR #1147。型だけの import に変わっただけで、公開する型は変わらない）こと。実行時の変化の分け方は各項目の ⚠ のとおり——保留は PR #1165（`InMemoryTenantSettingsStore` の半減期の口）と PR #1170（`MemoryEventKind` に無い kind のイベント）で、どちらも公開の fixture が不正な入力に新しく例外を投げる（問い `3f3411c5` の射程）。PR #1171 は fixture も新しく投げるが、core の共有の検査で Postgres と同時に変わるので、その項目1つで非破壊（⚠ 付き）と数えた（項目の注のとおり）。ほかは非破壊である。棚卸しで直したもの: PR #1162・#1170・#1171（Added の項目）・#1173 の項目に PR 番号を足した（Issue 番号でしか受けていなかった）。

⟹ **この節の範囲（`v1.0.2`…`4514cec`）で、確定した破壊的変更は無い（上の保留を除く）。**（⚠ 2026-09-27 訂正: 書いた時点では `v1.0.1`…`4514cec` と名乗っていた。上の追記4の訂正と同じ理由）

**⚠ 2026-09-27 追記6（6回目の棚卸し。`9f58833` まで広げた）**: `4514cec`…`9f58833` に `main` へ入った PR を全部当てた（PR #1179・#1180・#1182・#1183・#1186・#1187・#1189・#1190・#1191）。出荷される6パッケージの利用者に見える変更は、どれもこの節に載っている——PR #1183・#1187・#1190 は項目があり、PR 番号でも受けている。ほかは docs・テスト・README だけか、出荷の `src` を触っていても差分がコメントだけ（PR #1186・#1189・#1191）である。公開 API の型の差分は無い（`git diff 4514cec..9f58833 -- scripts/__snapshots__/public-api/` が空）。マイグレーションが1本増えた（`0023`、PR #1187。上の「postgres 利用者へ」）。実行時の変化の分け方は各項目の ⚠ のとおり——保留は PR #1183（`memories` の列挙の列に無い値）と PR #1190（冪等の既存行が在っても書けない値を拒む）で、どちらも公開の fixture が不正な入力に新しく例外を投げる（問い `3f3411c5` の射程）。PR #1187 は非破壊である（上の「PR #1187 の数え方」）。

⟹ **この節の範囲（`v1.0.2`…`9f58833`）で、確定した破壊的変更は無い（上の保留を除く）。**

**⚠ 2026-09-27 追記7（7回目の棚卸し。`ef03a8f` まで広げた）**: `9f58833`…`ef03a8f` に `main` へ入った PR を全部当てた（PR #1192〜#1195・#1197〜#1199）。出荷される6パッケージの利用者に見える振る舞いの変更は PR #1195（`restoreSuperseded` の `onlyMemoryIds` の形式不正な id）だけで、項目があり、PR 番号でも受けている（非破壊。項目の注のとおり）。ほかは次のとおりで、この節に足す項目は無い——PR #1192・#1198 は CHANGELOG・docs・テストの fixture だけ、PR #1199 は docs だけ、PR #1194 は README だけ、PR #1193（`RecallQuery.labels` の空配列の扱い）と PR #1197（`OutboxStore` の先頭詰まりと、claim の並びで約束しないもの）は出荷の `src` を触ったが、差分が今の振る舞いを書いたコメントだけであることを確かめた。公開 API の型の差分は無い（`git diff 9f58833..ef03a8f -- scripts/__snapshots__/public-api/` が空）。マイグレーションは増えていない。棚卸しで直したもの: この回は範囲の外まで、`v1.0.2`…`ef03a8f` で出荷の `src` のコード（コメント以外）を変えた PR を全部、この節の PR 番号と突き合わせ直した。その結果、PR #1104（Issue #1099）・#1128（Issue #1065）・#1145（Issue #1136）・#1156（Issue #1151）の項目が Issue 番号でしか受けていなかったので、PR 番号を足した（どれも追記4の範囲で、分類は変えていない。PR #1156 は追記4の本文では名指しされていた）。PR #1176 は追記5のとおり載せていない。

⟹ **この節の範囲（`v1.0.2`…`ef03a8f`）で、確定した破壊的変更は無い（上の保留を除く）。**

**⚠ 2026-09-27 追記8（8回目の棚卸し。`23f0076` まで広げた）**: `ef03a8f`…`23f0076` に `main` へ入った PR を全部当てた（PR #1201〜#1205・#1208〜#1210・#1214〜#1216・#1218〜#1220・#1223・#1224）。出荷される6パッケージの利用者に見える振る舞いの変更は PR #1220（`runMigrations` がロックを持つ接続そのもので本体を流す）と PR #1223（`@mnemora/local-embedding` の読み込み失敗のメッセージが、実際に解決されたキャッシュの場所を名指す）で、どちらも項目があり、PR 番号でも受けている（どちらも非破壊。項目の注のとおり）。ほかはこの節に項目として足していない——この節は docs・README だけの変更を項目にしない（追記5〜7と同じ慣例）。PR #1201・#1202・#1208・#1214・#1215・#1219・#1224 は出荷の `src` を触ったが、差分がコメント（TSDoc）だけであることを確かめた。どれも今の振る舞いを書いたもので、実装は変えていない（PR #1214 は `MemoryEvent.meta`・`actor` の値の中身を検査しないこと、JSON の値が同じ値で読み戻ることを TSDoc に書いた）。README だけを変えたのは PR #1216・#1218（PR #1215・#1220 も README を変えた）、CHANGELOG・docs だけは PR #1203・#1210、docs とテストだけは PR #1209、`examples/chat` だけは PR #1205、テストだけは PR #1204 である。公開 API の型の差分は無い（`git diff ef03a8f..23f0076 -- scripts/__snapshots__/public-api/` が空）。マイグレーションは増えていない。棚卸しで直したもの: PR #1220 の項目に PR 番号を足した（Issue #1212 の番号でしか受けていなかった）。

⟹ **この節の範囲（`v1.0.2`…`23f0076`）で、確定した破壊的変更は無い（上の保留を除く）。**

**⚠ 2026-09-28 追記9（9回目の棚卸し。`c6ca5a4` まで広げた）**: `23f0076`…`c6ca5a4` に `main` へ入った PR を全部当てた（PR #1225・#1227・#1230・#1231・#1233・#1235・#1236・#1240〜#1243・#1245〜#1247・#1249〜#1252・#1254・#1255・#1257〜#1259・#1261・#1263・#1265〜#1267・#1269〜#1275・#1278〜#1283・#1286〜#1291・#1293〜#1300。8回目の棚卸しの PR #1228 自身は除く）。出荷される6パッケージの利用者に見える振る舞いの変更は次の10本で、どれも項目があり、PR 番号でも受けている。`@mnemora/testkit/fixtures` の PR #1231（途中で投げたときに書いた分を残さない）・PR #1273（ベクトルを float4 に丸めて比べる）は非破壊、PR #1243・#1250・#1252・#1265・#1270・#1280（公開の fixture が Postgres の拒む値に新しく例外を投げる）は保留（問い `3f3411c5` の射程。PR #1252 の空文字の `externalId` の件だけは、例外を投げず結果だけが変わる）、`@mnemora/postgres` の PR #1289（`aggregateScope` の `excludeMemoryIds`）・PR #1299（`searchMany` の NUL を含む key）は例外を投げなくなる側の非破壊である。ほかはこの節に項目として足していない——この節は docs・README だけの変更を項目にしない（追記5〜8と同じ慣例）。PR #1227・#1233・#1235・#1240・#1241・#1245・#1247・#1249・#1254・#1257・#1261・#1263・#1266・#1269・#1279・#1283・#1286・#1288・#1296・#1297・#1298 は出荷の `src` を触ったが、変更の前後の各ファイルをコメントを除いて JS と TS に落として比べ、同じであることを確かめた（差分がコメント・TSDoc だけ。同じ比べ方で PR #1289・#1270 は差が出ることも確かめた）。README を変えたのは PR #1246（`@mnemora/local-embedding`：`cacheDir` を渡しても読み込みの前の確認は既定のキャッシュを見ること）・PR #1257（`@mnemora/postgres`：専用スキーマでの `pg_trgm` の置き場所）で、どちらも今の振る舞いを書いたもの。PR #1236 は CI・scripts と `examples/chat` だけ、PR #1282 は `packages/postgres/vitest.config.mts`（出荷しない）だけ、ほかはテスト・scripts・CI・docs だけである。公開 API の型の差分は無い（`git diff 23f0076..c6ca5a4 -- scripts/__snapshots__/public-api/` が空）。マイグレーションは増えていない。棚卸しで直したもの: PR #1289・#1299 の項目に PR 番号を足した（Issue #1262・#1285 の番号でしか受けていなかった）。
⟹ **この節の範囲（`v1.0.2`…`c6ca5a4`）で、確定した破壊的変更は無い（上の保留を除く）。**

**⚠ 2026-09-28 追記10（10回目の棚卸し。`de8a160` まで広げた）**: `c6ca5a4`…`de8a160` に `main` へ入った PR を全部当てた（PR #1302・#1303・#1305〜#1309。9回目の棚卸しの PR #1304 自身は除く）。出荷される6パッケージの利用者に見える振る舞いの変更は、`@mnemora/postgres` の PR #1308（`searchMany` に同じ key が2回以上あるときの結果）の1本だけで、項目がある。⚠ ただしその項目は Issue #1284 の番号でしか受けておらず、PR #1308 の番号が無い——この項目は別の担い手が文言を直す予定があるので、この棚卸しでは触っていない（分類の「非破壊」は、投げる入力が変わらず同じ key を含む入力の結果だけが変わる、という項目の注のとおりで正しい）。ほかはこの節に項目として足していない——この節は docs・README だけの変更を項目にしない（追記5〜9と同じ慣例）。PR #1303・#1305・#1306・#1309 と、PR #1308 の `packages/core/src/interfaces/vector-store.ts` は出荷の `src` を触ったが、変更の前後の各ファイルをコメントを除いて JS と TS に落として比べ、同じであることを確かめた（差分がコメント・TSDoc だけ。同じ比べ方で PR #1308 の `packages/postgres/src/vector-store.ts` は差が出ることも確かめた）。README を変えたのは PR #1307（`@mnemora/local-embedding`：壊れたキャッシュは再試行でも次のプロセスでも直らず、自動では消さないこと）で、今の振る舞いを書いたもの。PR #1302 はテストと ADR だけである。公開 API の型の差分は無い（`git diff c6ca5a4..de8a160 -- scripts/__snapshots__/public-api/` が空）。マイグレーションは増えておらず、出荷されるパッケージの `package.json` と `pnpm-lock.yaml` にも差分は無い。
⟹ **この節の範囲（`v1.0.2`…`de8a160`）で、確定した破壊的変更は無い（上の保留を除く）。**

**⚠ 2026-09-28 追記11（11回目の棚卸し。`dcf6ccb` まで広げた）**: `de8a160`…`dcf6ccb` に `main` へ入った PR を全部当てた（PR #1310〜#1312・#1314〜#1321。10回目の棚卸しの PR #1313 自身は除く）。出荷される6パッケージの利用者に見える振る舞いの変更は次の3本で、どれも項目があり、PR 番号でも受けている。`@mnemora/postgres` の PR #1310（拡張を作る権限が無くて migration が落ちたとき、文言の後ろに `extensionMode: "verify"` の案内が付く）は、例外の種類・投げる入力・文言の先頭が変わらない非破壊である。`@mnemora/core` の PR #1318（`observe()` と `tick()` の `extract` のジョブが、保存できない候補だけを落として残りを書く。逐次の再配達では、今の抽出器の版の Memory が在れば何も書かない）は2項目で、例外を投げる入力が減る側にだけ変わるものと、同じジョブの再配達のときだけ結果が変わるものであり、どちらも非破壊である。項目の中身（`meta.droppedCandidates` の欄、全件が落ちたら最初の例外を投げること、`reextract` と同期の `observe()` がこの確認を通らないこと）は、`packages/core/src/runtime.ts` の差分と合っている。`@mnemora/core` の PR #1319（`reextract()` が、利用者の意思で退けた記憶を持つ Observation では抽出をやり直さず、`extraction: "skipped"`・`atomicity: "not_attempted"` を返す）は Changed の項目で、非破壊である——公開の型は変わらず（`'skipped'`・`'not_attempted'` は元から型に在る値。`git diff` の公開 API の差分も空）、例外も増えず、結果だけが変わる（前書きの「例外を投げず結果だけが変わる修正」）。⚠ ただし `ReextractResult` の TSDoc が「`reextract` の `extraction` は `'skipped'` を取らない」と約束していた点は変わる。その約束に頼ったコードは実行時に想定外の値を受けうるので、この範囲で分類が覆りうるのはこの1本である（項目自身が「見直しが要る」と書いている。この判定もクローン miku の判断であり、オーナーの判断ではない）。項目の中身（数える退けた記憶の3形、`contested_resolved` の読み方、戻り値の各欄）は `packages/core/src/runtime.ts` の差分と合っている。ほかはこの節に項目として足していない——この節は docs・README だけの変更を項目にしない（追記5〜10と同じ慣例）。PR #1311・#1312・#1314 と、PR #1318 の `packages/core/src/interfaces/outbox-store.ts` は出荷の `src` を触ったが、変更の前後の各ファイルをコメントを除いて JS と TS に落として比べ、同じであることを確かめた（差分がコメント・TSDoc だけ。同じ比べ方で PR #1318 の `packages/core/src/runtime.ts` と PR #1310 の `packages/postgres/src/migrate.ts` は差が出ることも確かめた）。README を変えたのは PR #1310（`@mnemora/postgres`：上の案内）で、項目と同じ変更を書いたもの。PR #1317 は CI のジョブ（門ではない）と `examples/chat`（`private` で出荷しない）・scripts のテスト・ADR だけ、PR #1315 は ADR だけ、PR #1316 は `AGENTS.md`・docs・scripts のテストだけ、PR #1320・#1321 はテストと docs・ADR だけである。公開 API の型の差分は無い（`git diff de8a160..dcf6ccb -- scripts/__snapshots__/public-api/` が空）。マイグレーションは増えておらず、出荷されるパッケージの `package.json` と `pnpm-lock.yaml` にも差分は無い。棚卸しで直したもの: PR #1318 の2項目と PR #1319 の項目に PR 番号を足した（Issue #1063・#1092 と ADR 0347、Issue #1079・#1149 の番号でしか受けていなかった）。分類は変えていない。
⟹ **この節の範囲（`v1.0.2`…`dcf6ccb`）で、確定した破壊的変更は無い（上の保留を除く）。**

**⚠ 2026-09-28 追記12（12回目の棚卸し。`7d5f944` まで広げた）**: `dcf6ccb`…`7d5f944` に `main` へ入った PR を全部当てた（PR #1323〜#1327・#1329。11回目の棚卸しの PR #1322 自身は除く。PR #1323 は PR #1322 より先に `main` へ入ったので、11回目の範囲には入っていなかった。PR #1328 は `7d5f944` より後に `main` へ入ったので、範囲の外——次の棚卸しで数える）。出荷される6パッケージの利用者に見える振る舞いの変更は PR #1324・#1327・#1329 の3本で、どれも項目があり、PR 番号でも受けている。大文字の UUID の件（3本にまたがる）は、次のどれかに当たり、どれも非破壊である——例外が減るもの（`@mnemora/postgres` の `reinforceMany`・`markContestedPair`・`resolveContestedPair` の「memory not found」、`Runtime.resolveContested` の `RangeError`）、結果が store の `get` に揃うもの（Runtime の `forget`・`restoreArchived`・`purge`・`markContested`・`consolidate`・`reflect`・`resolveContested` の `not_found`・`pair_broken` と、`{ seedMemoryId }` の種の重複）、イベントの `meta` の id が列の値に揃うもの（`restoreSupersededBy` の `meta.supersededById`、`markContested`・`resolveContested` の `meta.contestedWithId`・`meta.supersededById`）。大文字小文字を区別する store での結果と、小文字で渡した呼び出しの結果は変わらない。3本の項目の言い回しを `packages/core/src/runtime.ts`・`packages/postgres/src/memory-store.ts`・`packages/postgres/src/mapping.ts` の差分と突き合わせ、互いに矛盾しないことを確かめた。ただし、後の PR が前の PR の書いた状態を変えた2か所は、前の項目だけを読むと今の振る舞いと読み違えうるので、後の項目への参照を足した（PR #1324 の store の項目の、同じ行を小文字と大文字で渡したときの例外。PR #1324 の Runtime の項目の「store へ渡す id は変えない」と、PR #1329 がイベントの `meta` に載せる相手の id を store の値にしたこと）。PR #1327 の store の項目には、大文字の UUID で今も例外になるときの例外の中身が変わることを ⚠ で足した（【実測】PR #1327 の前後の build を手元の Postgres 17 で比べた）。
⚠ **PR #1327 の「例外の種類が約束どおりになる」2項目は非破壊と数える**——`markContestedPair()`・`resolveContestedPair()` に同じ行を小文字と大文字で渡したときの「memory not found」（`Error`）が `RangeError` に、`resolveOrphanedContested()` に uuid の形でない `contestedWithId` を渡したときの DB の例外（drizzle が包んだ `Error`。`err.cause.code` は `22P02`）が `MemoryStatusConflictError`（行が無ければ「memory not found」）になる件である。どちらも TSDoc の約束の回復であり、投げる入力の集合は変わらない（以前も今も例外で、種類だけが変わる。どちらも `Error` の派生のまま）。⚠ **ただし、その約束に頼らず今の例外を捕まえていたコードは影響を受けうる**——「memory not found」の文面で分けていたコード、`err.cause.code === "22P02"` で分けていたコードは、この版から当たらなくなる。上の ⚠（大文字の UUID で今も例外になるときの、文面と `MemoryStatusConflictError.memoryId` の id が小文字になること）も同じ種類の余地である。どれも `@mnemora/postgres` の store を直接呼ぶ場合で、`Runtime.markContested()`・`resolveContested()` は、同じ記憶を小文字と大文字で渡すと store を呼ぶ前に `ineligible`（片側が `not_found`）を返すので変わらない（コードを読んで確かめた）。この範囲で分類が覆りうるのはこの2項目である（11回目の PR #1319 と同じ扱い。**この判定もクローン miku の判断であり、オーナーの判断ではない**）。
ほかはこの節に項目として足していない——この節は docs・README だけの変更を項目にしない（追記5〜11と同じ慣例）。PR #1323 は出荷の `src`（`packages/core/src/runtime.ts`）を触ったが、変更の前後をコメントを除いて JS と TS に落として比べ、同じであることを確かめた（差分が TSDoc だけ。`tick` の `leaseMs` を省略したときの例外は store が投げ、顔が store で違うことを書いたもの）。同じ比べ方で PR #1324・#1329 の `packages/core/src/runtime.ts`、PR #1324 の `packages/postgres/src/memory-store.ts`、PR #1327 の `packages/postgres/src/mapping.ts` は差が出ること、PR #1323 の後の `runtime.ts` のコードの1か所（`RangeError` を `TypeError` に）を書き換えた写しも差が出ることを確かめた。PR #1323 の残りと PR #1325・#1326 はテストだけである（`src/__tests__` は出荷物に入らない）。公開 API の型の差分は無い（`git diff dcf6ccb..7d5f944 -- scripts/__snapshots__/public-api/` が空）。マイグレーションは増えておらず、出荷されるパッケージの `package.json`・README と `pnpm-lock.yaml` にも差分は無い。
**⚠ 2026-09-28 追記13（13回目の棚卸し。`a2fb621` まで広げた）**: `7d5f944`…`a2fb621` に `main` へ入った PR を first-parent で全部当てた（PR #1328・#1330〜#1334・#1337。12回目の棚卸しの PR #1330 自身も範囲に入るが、`CHANGELOG.md` と docs だけである）。出荷される6パッケージの利用者に見える振る舞いの変更は PR #1331・#1337 の2本で、どれも項目があり、PR 番号でも受けている。PR #1331 の項目は3つ——`@mnemora/anthropic` の空の system（送る形だけが変わる）、`@mnemora/local-embedding` の試行回数の文面、同じく読み込み失敗・`unknown_input_limit` の文面の `modelId` の案内（例外の種類・投げる条件は変えず文面だけが変わる。追記の後ろの ⚠ を見ること）。PR #1337 の項目は1つ——`@mnemora/openai` の `completeStructured()` の戻りの `null`（今は `ZodError` になる入力の結果だけが変わる）。どれも非破壊である（**クローン miku の判断であり、オーナーの判断ではない**）。
⚠ **`modelId` の案内の項目は、この棚卸しで足した。**PR #1331 はその時点のクローン miku の指示で、振る舞いが変わる項目を空の system と試行回数の2つに限って載せていた。だが出荷の `src` の差分を比べると、`describeLoadFailure` と `buildLocalEmbeddingPipeline` の例外の文面も変わっており、この節は以前から local-embedding の読み込み失敗の文面だけの修正を Fixed の項目にしている（上の Fixed の、キャッシュのファイルの破損・`cacheDir` の置き場所の2項目）。⟹ 同じ慣例に揃えて項目にした。載せないと判断し直すなら、その項目1つを消せばよい。
ほかはこの節に項目として足していない——この節は docs・README・テストだけの変更を項目にしない（追記5〜12と同じ慣例）。PR #1328・#1333 は出荷の `src`（`packages/core/src/runtime.ts`）を触ったが、変更の前後を TypeScript の `transpileModule`（`removeComments: true`）で JS に落として比べ、同じであることを確かめた（差分が TSDoc とコメントだけ）。同じ比べ方で、PR #1331 の `packages/local-embedding/src/errors.ts`・`packages/openai/src/structured-root.ts` も同じ（コメントだけ）、PR #1331 の `packages/local-embedding/src/local-embedding-provider.ts`・`pipeline.ts`・`packages/anthropic/src/llm-provider.ts` と PR #1337 の `packages/openai/src/llm-provider.ts` は差が出ること、PR #1333 の後の `runtime.ts` の `new RangeError(` を `new TypeError(` に書き換えた写しも差が出ることを確かめた。PR #1332・#1334 はテストだけである（`src/__tests__` は出荷物に入らない）。公開 API の型の差分は無い（`git diff 7d5f944..a2fb621 -- scripts/__snapshots__/public-api/` が空）。マイグレーションは増えておらず、出荷されるパッケージの `package.json` と `pnpm-lock.yaml` にも差分は無い（README は PR #1331・#1337 が変えたが、docs として数えた）。
**⚠ 2026-09-28 追記15（15回目の棚卸し。`9378719` まで広げた）**: `a2fb621`…`9378719` に `main` へ入った PR を first-parent で全部当てた（PR #1338・#1336・#1339・#1340・#1342・#1341・#1343・#1345・#1335・#1344・#1346〜#1349・#1350・#1352・#1351・#1353・#1356）。⚠ **追記14 は無い**——14回目の棚卸し（`f334c73` まで。PR #1338〜#1345・#1335 の9本）は直すものが見つからず、PR を出さなかったので、この節の範囲の sha も進めなかった。この棚卸しはその9本も含めて `a2fb621` から当て直した（14回目の結果を使い、PR 番号と項目の対応はすべて引き直した）。出荷される6パッケージの利用者に見える振る舞いの変更は PR #1340・#1335・#1350・#1351 の4本で、どれも項目があり、PR 番号でも受けている（#1340 が1項目、#1335 が2項目、#1350 が4項目、#1351 が1項目）。どれも非破壊で、例外を投げる入力は増えない（**クローン miku の判断であり、オーナーの判断ではない**）。
ほかはこの節に項目として足していない——この節は docs・README・テスト・scripts だけの変更を項目にしない（追記5〜13と同じ慣例）。出荷の `src` を触ったのに項目の無い PR は、PR #1344（`packages/core/src/outbox.ts`）と、PR #1350 の `packages/postgres/src/migrate.ts`・`schema-namespace.ts` で、どれも変更の前後を TypeScript の `transpileModule`（`removeComments: true`）で JS に落として比べ、同じであることを確かめた（差分が TSDoc とコメントだけ）。同じ比べ方で、項目のある PR #1340・#1335・#1350（core の3ファイル）・#1351 の `src` は差が出ること、PR #1350 の後の `migrate.ts` の定数名を書き換えた写しも差が出ることを確かめた。PR #1346・#1352・#1353・#1356 と #1339・#1342・#1343 はテストだけ、#1336・#1341・#1345・#1347〜#1349 は docs・README・scripts だけ、#1338 は13回目の棚卸し（`CHANGELOG.md` と docs だけ）である（`examples/chat` は出荷物ではない）。公開 API の型の差分は無い（`git diff a2fb621..9378719 -- scripts/__snapshots__/public-api/` が空）。マイグレーションは増えておらず、出荷されるパッケージの `package.json` と `pnpm-lock.yaml` にも差分は無い。
**⚠ 2026-09-28 追記16（16回目の棚卸し。`0d282c1` まで広げた）**: `9378719`…`0d282c1` に `main` へ入った PR を first-parent で全部当てた（PR #1355・#1357・#1358・#1359・#1354・#1360。15回目の棚卸しの PR #1358 自身も範囲に入るが、`CHANGELOG.md` と docs だけである）。出荷される6パッケージの利用者に見える振る舞いの変更は `@mnemora/core` の PR #1355・#1354 の2本で、どれも `### Fixed` に項目があり、PR 番号でも受けている（#1355 が1項目、#1354 が2項目）。PR #1355 は `createRuntime()` の `llmModelId`・`promptVersion` の空文字を省略と同じに扱う（`??` を `||` にした。空白だけの値はそのまま書く）。PR #1354 は公開の `ReflectionLLMResultSchema` の `digest` と `tags` の要素から `min(1)` を外し、`reflect()` が空文字の digest をフォールバックし、空文字の tag を落とすようにした。どれも非破壊で、例外・`llm_failed` になる入力は減る側にしか変わらない（**クローン miku の判断であり、オーナーの判断ではない**）。項目の中身は `packages/core/src/runtime.ts`・`packages/core/src/strategies/reflect.ts` の差分と合っている。棚卸しで直したもの: PR #1354 の tag の項目が、何が応答を拒んでいたか（`ReflectionLLMResultSchema` の `tags` の要素の `min(1)`）と、公開の schema を直接使う呼び出しでも結果が変わることを書いていなかったので、足した（digest の項目は schema を名指していた）。分類は変えていない。
ほかはこの節に項目として足していない——この節は docs・README・テスト・scripts だけの変更を項目にしない（追記5〜15と同じ慣例）。出荷の `src` を触ったのに項目の無い変更は、PR #1355 の `packages/core/src/ctx.ts`・`interfaces/outbox-store.ts`・`outbox.ts`・`recall.ts` と、PR #1354 の `packages/core/src/event.ts`・`observation.ts` で、どれも変更の前後を TypeScript の `transpileModule`（`removeComments: true`）で JS に落として比べ、同じであることを確かめた（差分が TSDoc とコメントだけ）。同じ比べ方で、項目のある PR #1355 の `runtime.ts` と PR #1354 の `strategies/reflect.ts` は差が出ることを確かめた。PR #1357・#1359・#1360 はテスト（と各パッケージの `vitest.config.mts`）だけ、PR #1354 の `docs/decisions/0299-extraction-context.md` は ADR である。公開 API の型の差分は無い（`git diff 9378719..0d282c1 -- scripts/__snapshots__/public-api/` が空。PR #1354 の schema の変更は `z.string().min(1)` を `z.string()` にしたもので、宣言の型は変わらない）。マイグレーションは増えておらず、出荷されるパッケージの `package.json` と `pnpm-lock.yaml` にも差分は無い。
**⚠ 2026-09-29 追記17（17回目の棚卸し。`86b42b1` まで広げた）**: `0d282c1`…`86b42b1` に `main` へ入った PR を first-parent で全部当てた（PR #1361・#1362・#1365・#1364・#1366・#1363。16回目の棚卸しの PR #1361 自身も範囲に入るが、`CHANGELOG.md` と docs だけである）。出荷される6パッケージの利用者に見える振る舞いの変更は `@mnemora/postgres` の PR #1366 の1本で、`### Fixed` に項目があり、PR 番号でも受けている（1項目）。PR #1366 は `restoreSupersededBy()` の `event.at` が Invalid Date のとき、戻す対象が無ければ例外にせず `{ restored: [] }` を返す（testkit の fixture に揃えた。対象が在るときは今どおり同じ種類の例外で、1件も戻さない）。非破壊で、例外を投げる入力は減る側にしか変わらない（**クローン miku の判断であり、オーナーの判断ではない**）。項目の中身は `packages/postgres/src/memory-store.ts` の差分（`at` が Invalid Date のときだけ、同じ条件で対象の有無を先に見て、無ければ空で返す）と合っている。棚卸しで直したものは無い。分類は変えていない。
ほかはこの節に項目として足していない——この節は docs・README・テスト・scripts だけの変更を項目にしない（追記5〜16と同じ慣例）。出荷の `src` を触ったのに項目の無い変更は、PR #1362 の `packages/core/src/interfaces/memory-store.ts`・`memory.ts`、PR #1363 の `packages/core/src/runtime.ts`、PR #1366 の `packages/core/src/interfaces/memory-store.ts`・`packages/testkit/src/__fixtures__/in-memory-memory-store.ts`・`packages/testkit/src/fixtures.ts` で、どれも変更の前後を TypeScript の `transpileModule`（`removeComments: true`）で JS に落として比べ、同じであることを確かめた（差分が TSDoc とコメントだけ）。同じ比べ方で、項目のある PR #1366 の `packages/postgres/src/memory-store.ts` は差が出ることを確かめた。PR #1364・#1365 はテストだけである（PR #1365 の `packages/core/src/__tests__/runtime-fakes.ts` は差が出るが、`src/__tests__` は出荷物に入らない）。公開 API の型の差分は無い（`git diff 0d282c1..86b42b1 -- scripts/__snapshots__/public-api/` が空）。マイグレーションは増えておらず、出荷されるパッケージの `package.json` と `pnpm-lock.yaml` にも差分は無い。
**⚠ 2026-09-28 追記18（18回目の棚卸し。`f5ad59f` まで広げた）**: 日付は UTC である（追記17 の「2026-09-29」は日本時間の日付で、UTC では 2026-09-28）。`86b42b1`…`f5ad59f` に `main` へ入った PR を first-parent で全部当てた（PR #1367・#1369・#1368・#1371。17回目の棚卸しの PR #1369 自身も範囲に入るが、`CHANGELOG.md` と docs だけである）。出荷される6パッケージの利用者に見える振る舞いの変更は無く、この節に足した項目も、棚卸しで直した項目も無い。分類は変えていない。
この節は docs・README・テスト・scripts だけの変更を項目にしない（追記5〜17と同じ慣例）。出荷の `src` を触ったのは PR #1367 の `packages/core/src/event.ts`・`interfaces/event-store.ts`・`interfaces/memory-store.ts` だけで、どれも変更の前後を TypeScript の `transpileModule`（`removeComments: true`）で JS に落として比べ、同じであることを確かめた（差分が TSDoc だけ）。同じ比べ方で、コードの変わった PR #1366 の `packages/postgres/src/memory-store.ts` は差が出ることを確かめた（正の対照）。PR #1368・#1371 はテストとテストの道具（`packages/core/src/__tests__/runtime-fakes.ts` の core の Fake）だけで、`src/__tests__` は出荷物に入らない（`runtime-fakes.ts` は差が出るが、出荷されない）。公開 API の型の差分は無い（`git diff 86b42b1..f5ad59f -- scripts/__snapshots__/public-api/` が空）。マイグレーションは増えておらず、出荷されるパッケージの `package.json` と `pnpm-lock.yaml` にも差分は無い。
⟹ **この節の範囲（`v1.0.2`…`f5ad59f`）で、確定した破壊的変更は無い（上の保留を除く）。**
**⚠ 2026-09-28 追記19（保留の解消。範囲は広げていない）**: オーナーの回答（ask_human `3f3411c5`）で、公開の fixture（`@mnemora/testkit/fixtures`）が、これまで受け入れていた不正な入力に新しく例外を投げる変更は、破壊的変更として扱わないと決まった。上の追記4〜18 の ⟹ の「上の保留」は、この節ではどれもこの種類の変更を指していた——`### Fixed` の PR #1135・#1157・#1165・#1170・#1183・#1190・#1243・#1250・#1252・#1265・#1270・#1280 の12項目である（前書きの「保留と非破壊の数え方」）。この12項目の ⚠ を「破壊的変更として扱わない」に書き換え、`### Fixed` に置いたまま確定させた。分類の見出しは変えていない。PR #1171 の `setEventRetention` は、もともと保留に入れず非破壊と数えていたので変わらない。`## [1.0.2]`・`## [1.0.1]` 節が保留と書いている PR #811・#813・#815・#923・#928 などにもこの回答は当たるが、出荷済みの節なので書き換えていない（`docs/migration-v1.md` の数え方の規律に追記した）。追記4〜18 の本文と ⟹ の行も、書いた時点の記録として書き換えていない。
⟹ **この節の範囲（`v1.0.2`…`f5ad59f`）で、破壊的変更は無い。計上を保留しているものも無い。**

**2026-09-29 追記**: 上の18回の棚卸しの範囲（`f5ad59f` まで）の**外**——この節にまだ棚卸しで
取り込まれていない、作業中の1件——として、下の `### Breaking` に破壊的変更が1件在る
（[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)）。**この節の他の項目と違い、
棚卸しの「PR を全部当てた」手順を経て足したものではない**——変更を作った本人が、着地に
先立って自分でこの節に足した項目である。次回以降の棚卸しは、この項目が既に在ることを
前提に PR 番号の有無だけ確認すればよい。

**⚠ 2026-09-29 追記20（19回目の棚卸し。`80c79df` まで広げた。⚠ 追記19 は #1376 が足した「保留の解消」であり、棚卸しの回として数えていない——追記15 が追記14 について書いたのと同じ理由で、この回は「19回目の棚卸し」だが追記番号は20である）**: `f5ad59f`…`80c79df` に `main` へ入った PR を first-parent で全部当てた（PR #1372・#1373・#1375・#1374・#1376・#1383・#1381・#1377・#1379・#1382）。18回目の棚卸しの PR #1373 自身と、追記19 を足した PR #1376 自身も範囲に入るが、どちらも CHANGELOG.md・docs（と #1376 は ADR 3本）だけである。
出荷される6パッケージの利用者に見える振る舞いの変更は次の4本で、どれも各 PR の担当者自身が着地の時点でこの節に項目を足しており（この棚卸しの「PR を全部当てた」手順を経て新規に足したものではない）、この棚卸しではリンクと分類を検証した。棚卸しで直したもの: PR #1382・#1383 の項目に PR 番号を足した（Issue 番号でしか受けていなかった）。分類は変えていない。PR #1374（Issue #1370、`### Changed`）は抽出・consolidate・reflect の system プロンプトに出力言語・話者取り違えの指示を足すもので、Issue・PR 番号とも受けている（非破壊）。PR #1377（Issue #1221、ADR 0350、`### Breaking`）は `@mnemora/openai`・`@mnemora/anthropic` の `*ProviderOptions.client` の型を SDK のクラスから自前の構造型へ切り離すもので、Issue・PR・ADR とも受けている——**この節の範囲に入った、確定した破壊的変更**である（下を見よ）。PR #1379（Issue #1211、`### Changed`）は testkit の fixture が `reason`・`actor.id` の NUL・孤立サロゲートを拒むようにするもので、Issue・PR 番号とも受けている（オーナーの回答（ask_human `3f3411c5`）により非破壊と数える）。PR #1383（Issue #1188、ADR 0089 追記、`### Fixed`）は `consolidate()` が、いまの時点で有効期間の外にある記憶を統合元にしないもので、Issue 番号でしか受けていなかったので PR 番号を足した。公開 union `ConsolidateSourceOutcome` に `"expired"`・`"not_yet_valid"` の2値が増えるが、union に値を足す変更は破壊的と数えない（オーナーの回答（ask_human `d9364c91`）、`docs/migration-v1.md` の「数え方の規律への追記（2026-09-28）」）ので非破壊と数える。
PR #1382（Issue #205、ADR 0325 追記、ADR 0351、`### Added`）は `@mnemora/bullmq` を npm の公開対象（`PUBLISH_TARGETS`）に加えるもので、Issue・ADR で受けていた（PR 番号が無かったので足した）。⚠ **`@mnemora/bullmq` はこれで `PUBLISH_TARGETS` に入ったが、まだ一度も publish されておらず（version は `0.0.0` のまま）、この節の前書きの「対象パッケージの公開範囲」（6パッケージ、`v1.0.2` と同じ）はこの棚卸しでは変えていない。**bullmq 自身の `src` はこの範囲で変わっていない（`package.json` の publish 設定だけ）ので、この判断は今回の項目の有無には影響しないが、**bullmq の今後の振る舞いの変更を、この節の対象に含めるかどうかは、次回以降の棚卸しかオーナーの判断へ持ち越す**（このリポジトリでの初判断であり、覆りうる）。
ほかはこの節に項目として足していない——この節は docs・README・テスト・scripts だけの変更を項目にしない（追記5〜18と同じ慣例）。PR #1372（テストだけ、`local-noise-arm.postgres.test.ts` を群ごとの it に分ける）・PR #1373（18回目の棚卸し自身、`CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md`）・PR #1375（テスト基盤だけ、`runtime-return-contract.ts` ほか）・PR #1376（追記19 そのもの、`CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md`・ADR 3本）・PR #1381（docs のみ、出荷済み `v1.0.0` の release-notes 草稿の削除と参照の訂正）は、どれも出荷パッケージの `src` を触っていない。出荷の `src` を触ったのは上の4本（#1374・#1377・#1379・#1383）だけで、どれも項目がある——この回はコメントだけで `src` を触った出荷 PR が無かったので `transpileModule` の比較は要らない。正の対照として、`git diff --stat f5ad59f..80c79df -- 'packages/*/src/**' ':!**/__tests__/**'` が返す14ファイルすべてを上の4 PR の項目の記述と突き合わせ、すべて説明が付くことを確認した（`packages/core/src/event.ts`・`interfaces/event-store.ts`・`packages/testkit/src/__fixtures__/memory-event-check.ts` は PR #1379、`packages/core/src/extraction.ts`・`strategies/consolidate.ts`・`strategies/reflect.ts` は PR #1374、`packages/core/src/runtime.ts` は PR #1383、`packages/anthropic/src/client-types.ts`・`index.ts`・`llm-provider.ts`・`packages/openai/src/client-types.ts`・`index.ts`・`llm-provider.ts`・`embedding-provider.ts` は PR #1377）。
公開 API の型の差分（`git diff f5ad59f..80c79df -- scripts/__snapshots__/public-api/`）: `anthropic.d.ts`・`openai.d.ts` は PR #1377 の型置き換え（上の Breaking そのもの）。`core.d.ts` は PR #1383 の `ConsolidateSourceOutcome` への2値追加（非破壊、上のとおり）。`bullmq.d.ts` が新規に増えた——PR #1382 で bullmq が publish 対象へ加わったことで、公開 API の検査の対象に bullmq が初めて入ったためであり、既存の公開面の削除・狭小化ではない。マイグレーションは増えていない（`packages/postgres/migrations/` の差分は空）。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い——`packages/openai/package.json`・`packages/anthropic/package.json` の devDependencies（`openai-latest`・`anthropic-sdk-latest`、PR #1377 の型の互換テスト用）と `pnpm-lock.yaml` の対応する差分は devDependencies だけで、出荷される依存関係ではない。`packages/bullmq/package.json`（`private` を外す・`publishConfig`・`repository`・`prepack`・`ioredis` の range 変更ほか、PR #1382）は、bullmq がこの節の対象6パッケージに入っていないので、この「差分は無い」という言い方の対象外として扱った——変更自体は上の Added の項目に含まれている。
⟹ **この節の範囲（`v1.0.2`…`80c79df`）で、確定した破壊的変更は1件（PR #1377、Issue #1221）である。**上の「2026-09-29 追記」（`f5ad59f` までの範囲の**外**として書いたもの）と、追記19 の ⟹（「破壊的変更は無い」）は、どちらも書いた時点では正しかったが、この棚卸しで PR #1377 がこの節の範囲に入ったことで、いまの範囲にはもう当てはまらない——書いた時点の記録として書き換えていない。

**⚠ 2026-09-29 追記21（20回目の棚卸し。`329bdb1` まで広げた）**: `80c79df`…`329bdb1` に `main` へ入った PR を first-parent で全部当てた（9325b2c #1378、275ce25 #1386、635c93d #1385、329bdb1 #1388。19回目の棚卸しの PR #1386 自身も範囲に入るが、`CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけである）。
出荷される6パッケージの利用者に見える振る舞いの変更は次の3本で、どれも各 PR の担当者自身が着地の時点でこの節に項目を足しており（この棚卸しの「PR を全部当てた」手順を経て新規に足したものではない）、この棚卸しではリンクと分類を検証した。PR #1378（Issue #868、ADR 0349、`### Fixed`）は `db.transaction()` 実行中の接続断で Node のプロセスごと落ちていたのを、drizzle に渡す `Pool` を `connect` だけ包んだ `Proxy` にして直すもので、Issue・PR 番号とも既に受けていた（非破壊。リンク・分類とも直すものは無かった）。PR #1385（Issue #548 方向2、ADR 0352、`### Breaking`）は連想枠・必須の同伴取得が返す `score` から `total`/`similarity`/`lexicalMatch` を外すもので、Issue・ADR は受けていたが PR 番号が無かったので足した——**確定した破壊的変更**である（下を見よ）。PR #1388（Issue #1188、ADR 0091 追記、`### Fixed`）は `reflect()` が、いまの時点で有効期間の外にある記憶を材料にしないようにするもので（`consolidate()` を直した PR #1383 と対になる reflect 側）、Issue 番号でしか受けていなかったので PR 番号を足した（非破壊。公開 union `ReflectBasisOutcome` に `"expired"`・`"not_yet_valid"` の2値が増えるが、union に値を足す変更は破壊的と数えない——オーナーの回答（ask_human `d9364c91`）、`docs/migration-v1.md` の「数え方の規律への追記（2026-09-28）」）。棚卸しで直したもの: PR #1385・#1388 の項目に PR 番号を足した（どちらも Issue 番号でしか受けていなかった）。分類はどれも変えていない。
ほかはこの節に項目として足していない——この節は docs・README・テスト・scripts だけの変更を項目にしない（追記5〜20と同じ慣例）。19回目の棚卸し自身（PR #1386、275ce25）は `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけで、出荷パッケージの `src` を触っていない。出荷の `src` を触ったのは上の3本（#1378・#1385・#1388）だけで、どれも項目がある——この回はコメントだけで `src` を触った出荷 PR が無かったので `transpileModule` の比較は要らない。正の対照として、`git diff --stat 80c79df..329bdb1 -- 'packages/*/src/**' ':!**/__tests__/**'` が返す7ファイルすべてを上の3 PR の項目の記述と突き合わせ、すべて説明が付くことを確認した（`packages/postgres/src/client.ts` は PR #1378、`packages/core/src/correction-candidates.ts`・`recall.ts`・`strategies/consolidate.ts` は PR #1385、`packages/core/src/runtime.ts`・`validity.ts` は PR #1388、`packages/core/src/recall-runtime.ts` は PR #1385・#1388 の両方が触っている）。
公開 API の型の差分（`git diff 80c79df..329bdb1 -- scripts/__snapshots__/public-api/`）は `core.d.ts` だけである——`RecalledMemory.score`/`RecallRecordMemory.score`/`CorrectionCandidate.score`/`computeAffinity` の引数型が `ScoreBreakdown` から新設 union `RecalledScore`（`ScoreBreakdown | AffinityUnmeasuredScore`）へ変わった分（PR #1385。上の Breaking そのもの）と、`ReflectBasisOutcome` に `"expired"`・`"not_yet_valid"` の2値が増えた分（PR #1388。union への値の追加で非破壊、上のとおり）。`anthropic.d.ts`・`openai.d.ts`・`bullmq.d.ts`・`testkit.d.ts` に差分は無い。マイグレーションは増えていない（`packages/postgres/migrations/` の差分は空）。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い。
⚠ **上の「2026-09-29 追記20」（`f5ad59f` より後に着地した PR #1385 の破壊的変更を、着地に先立って本人が範囲の**外**として足した段落。上の追記20 のすぐ下、`### Breaking` の1件目と2件目の間にある）は、追記番号が19回目の棚卸し自身の追記20（この節の前書きが名指す追記20）と重複している——別の担い手が別の理由で同じ番号を使ったものと見られる。過去の追記の本文は書き換えないので番号はそのまま残すが、その段落が予告していた「次回の棚卸しで、`f5ad59f`…この変更の着地点を通しで数え直すこと」は、この追記21で行った（`80c79df`…`329bdb1` の棚卸しに PR #1385 自身が含まれる）。**
⟹ **この節の範囲（`v1.0.2`…`329bdb1`）で、確定した破壊的変更は2件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2）である。**上の追記20 の ⟹（「確定した破壊的変更は1件」）は書いた時点では正しかったが、この棚卸しで PR #1385 がこの節の範囲に入ったことで、いまの範囲にはもう当てはまらない——書いた時点の記録として書き換えていない。

**⚠ 2026-09-29 追記22（21回目の棚卸し。`94dafe0` まで広げた）**: `329bdb1`…`94dafe0` に `main` へ入った PR を first-parent で全部当てた（d8f4259 #1380、04f0eae #1387、94dafe0 #1390。20回目の棚卸し自身（PR #1390、94dafe0）も範囲に入るが、`CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけである）。
出荷される6パッケージの利用者に見える振る舞いの変更は PR #1380（[Issue #338](https://github.com/takecchi/mnemora/issues/338)、[ADR 0353](./docs/decisions/0353-activity-counting-per-call.md)、`### Added`）の1本で、担当者自身が着地の時点でこの節に項目を足しており（この棚卸しの「PR を全部当てた」手順を経て新規に足したものではない）、この棚卸しではリンクと分類を検証した——Issue・PR・ADR とも既に受けており、直すものは無かった。⚠ **非破壊と数える**（`docs/migration-v1.md`「数え方の規律への追記（2026-09-28）」規律1、オーナーの回答 ask_human `d9364c91`「公開の union 型に値を足す変更は破壊的と数えない」）——`NewRecallRecord.advanceActivityClock` の型を `boolean` から `boolean | { scope: "subject"; subjectId: string }` へ広げたもので、`boolean` はこの union にそのまま含まれるため既存の `true`/`false`/省略の呼び出しは1行も直さず通る。`docs/migration-v1.md` の「⭕ 非破壊と数えたもの」に、この判断と、`MemoryStore.createRecall` を自前実装している store 実装者向けの注記を足した（下記）。**ADR 0353 決定9 は「CHANGELOG には Changed として記載する」と書いているが、実物はこの節の `### Added` に置かれている——この食い違いは事実として記録するだけで、ADR 本文も CHANGELOG の区分も直していない。**
ほかはこの節に項目として足していない——この節は docs・README・テスト・scripts だけの変更を項目にしない（追記5〜21と同じ慣例）。PR #1387（[Issue #762](https://github.com/takecchi/mnemora/issues/762)、`docs(roadmap)`）は `docs/roadmap.md` ほか docs 中心の変更で項目は無いが、出荷の `packages/core/src/runtime.ts` を1箇所触っている（`reflect()` の TSDoc コメントが指す roadmap の節番号の訂正）。変更の前後を TypeScript の `transpileModule`（`removeComments: true`）で JS に落として比べ、同じであることを確かめた（差分ゼロ）。20回目の棚卸し自身（PR #1390）は `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけで、出荷パッケージの `src` を触っていない。正の対照として、`git diff --stat 329bdb1..94dafe0 -- 'packages/*/src/**' ':!**/__tests__/**'` が返す15ファイルすべてを PR #1380 の項目の記述と突き合わせ、すべて説明が付くことを確認した（`packages/core/src/correction-candidates.ts`・`interfaces/memory-store.ts`・`interfaces/tenant-settings-store.ts`・`interfaces/vector-store.ts`・`recall-runtime.ts`・`recall.ts`・`runtime.ts`、`packages/postgres/src/activity-decay-sql.ts`・`memory-store.ts`・`tenant-settings-store.ts`・`vector-store.ts`、`packages/testkit/src/__fixtures__/in-memory-memory-store.ts`・`in-memory-tenant-settings-store.ts`・`in-memory-vector-store.ts`・`tenant-settings-store-conformance.ts` の15ファイル、すべて PR #1380。この範囲でほかに出荷の `src` を触った PR は無い——PR #1387 の `runtime.ts` の1箇所は上のとおりコメントのみ）。
公開 API の型の差分（`git diff 329bdb1..94dafe0 -- scripts/__snapshots__/public-api/`）は `core.d.ts`・`postgres.d.ts`・`testkit.d.ts` の3ファイルで、どれも PR #1380（追加のみ）——`FindCorrectionCandidatesInput`・`ArchiveDecayedOptions`・`VectorFilter`・`RecallScope`・`RecallQuery`・`ConsolidateTarget`・`ReflectTarget` に `activityCounting?`/`decayFloorSeqUsesSubjectCounters?`/`usesSubjectActivityCounters?` を、`TenantSettingsStore`（と実装の `PostgresTenantSettingsStore`・`InMemoryTenantSettingsStore`）に `hasSubjectActivityCounters?`/`getSubjectActivitySeqs?` を、それぞれ省略可能な欄・メソッドとして足した。`NewRecallRecord.advanceActivityClock` は `boolean` から `boolean | { scope: "subject"; subjectId: string }` へ広がった（上の Added の項目そのもの）。`@mnemora/testkit` の `InMemoryTenantSettingsStore` のコンストラクタに省略可能な第2引数 `subjectActivitySeqBacking?: Map<string, Map<string, number>>` が増えた——既存の末尾に足した省略可能な引数で、0引数・1引数どちらの既存の呼び出しも1行も直さず通る非破壊の変更である。`anthropic.d.ts`・`openai.d.ts`・`bullmq.d.ts` に差分は無い。マイグレーションが1本増えた（`0024_tenant_subject_activity.sql`、PR #1380。上の Added の項目のとおり）。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い。
⟹ **この節の範囲（`v1.0.2`…`94dafe0`）で、確定した破壊的変更は2件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2）のままである。**この棚卸しで新しく確定した破壊的変更は無い。

**⚠ 2026-09-29 追記23**: 上の棚卸しとは別に、`94dafe0`（21回目の棚卸しが数えた末尾）より後に
`main` へ入る作業として、`@mnemora/core` に破壊的変更がもう1件確定した
（[Issue #1232](https://github.com/takecchi/mnemora/issues/1232)、
[ADR 0354](./docs/decisions/0354-atomic-event-retention-purge.md)、
[PR #1393](https://github.com/takecchi/mnemora/pull/1393)）。上の「2026-09-29 追記20」
（PR #1377の件）・追記21内の段落（PR #1385の件）と同じ扱い——着地に先立って変更を作った
本人がこの節に足した項目であり、棚卸しの「PR を全部当てた」手順を経て足したものではない。
上の `### Breaking` へ3件目の項目として足した。🔴 `94dafe0` からこの変更が着地するまでの間に
他の PR が `main` へ入っている可能性があるが、それらを1本ずつ洗って分類する棚卸しはまだ
行っていない。**次回の棚卸しで、この追記23が数えていない範囲（`94dafe0`…この変更の着地点）を
通しで数え直すこと。**
⟹ **この節の範囲で、確定した破壊的変更は3件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、
PR #1393・Issue #1232）になった。**

**⚠ 2026-09-29 追記24（22回目の棚卸し。`fd20e14` まで広げた）**: `94dafe0`…`fd20e14` に `main` へ入った PR を first-parent で全部当てた（a693f1a #1389、0690c4c #1391、db5373c #1392、c174953 #1393、3405cb0 #1394、ad643ce #1395、fd20e14 #1397）。これで、追記23 が予告していた「次回の棚卸しで `94dafe0`…この変更（PR #1393）の着地点を通しで数え直すこと」を行った。21回目の棚卸し自身（PR #1391、0690c4c）も範囲に入るが、`CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけである。PR #1393 は上の追記23 のとおり、着地の時点で本人が `### Breaking` へ3件目として足しており、この棚卸しの「PR を全部当てた」手順を経て新規に足したものではない——この棚卸しではリンクと分類を検証し、直すものは無かった。PR #1389（[Issue #1384](https://github.com/takecchi/mnemora/issues/1384)、`### Fixed`、非破壊）・PR #1392（[Issue #865](https://github.com/takecchi/mnemora/issues/865)、`### Added`、非破壊）・PR #1395（[Issue #1213](https://github.com/takecchi/mnemora/issues/1213)、`### Fixed`、非破壊）・PR #1397（[Issue #1141](https://github.com/takecchi/mnemora/issues/1141)、`### Added`、非破壊）は、どれも着地の時点で本人がこの節に項目を足しており、この棚卸しではリンクと分類を検証した——PR #1392・PR #1397 の項目は PR 番号へのリンクが欠けていたので足した（Issue 番号でしか受けていなかった）。PR #1389・PR #1395 の項目は PR 番号でも既に受けており、直すものは無かった。

⚠ **PR #1394（[Issue #1237](https://github.com/takecchi/mnemora/issues/1237)「案1」、[ADR 0355](./docs/decisions/0355-inject-clock-into-store-writes.md)）の数え直し。この判断はクローン miku の判断であり、オーナーの判断ではない。** PR #1394 も着地の時点で本人が2箇所に項目を足している——`### Breaking` の「`MemoryStore`/`OutboxStore` を自前で実装している人へ」の項目（時刻を渡す欄が任意の欄として増えた。型としては追加のみ）と、`### Fixed` の「`Runtime`（`@mnemora/core`）は…渡していなかった」の項目（Runtime 自身が渡す値が壁時計から注入した時計に変わった。⭕ 非破壊と数える、と明記されている）。`docs/migration-v1.md` も、着地の時点で本人がこれを「⭕ 非破壊と数えたもの」の一覧に置いていた。だが `### Breaking` の項目自体は、この棚卸しまで確定した破壊的変更の ⟹ の集計（上の追記23 の3件）に**含まれていなかった**——見出しの下に項目としては在るのに、件数には数えられていない食い違いがあった。この棚卸しで、`docs/migration-v1.md`「数え方の規律への追記（2026-09-28）」規律2 の ⛔（「conformance スイートの判定を厳しくする変更…は、これまでどおり上の定義と各世代の分け方で数える」）に照らして数え直した——`MemoryStore.createObservationWithOutbox`/`createMemoryWithOutbox`/`supersedeWithNewMemories?`/`requeueEmbedJobs`/`OutboxStore.complete`/`fail`/`NewRecallRecord.createdAt` の**型**は追加だけだが、`packages/testkit` の `describeMemoryStoreConformance`/`describeOutboxStoreConformance` が本 PR で足した「渡した時刻を守る」歯（`opts.now`/`opts.at`/`createdAt` を渡すと、書く行がその値になることを検査する）は、この欄を無視する既存の自前実装に対して新しく落ちる——**型検査は壊れないが、conformance スイートを当てると実行時に壊れる**。規律2 が「fixture 以外の公開の場所…と、conformance スイートの判定を厳しくする変更」を「破壊的変更として扱わない」対象から明示的に外している以上、これは上の定義（公開契約について、既存の利用者のコードが型検査または実行時に壊れる変更）で数えるのが規律に沿う。⟹ **この節の範囲で、確定した破壊的変更は4件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」）になった。**`### Breaking` の PR #1394 の項目の本文は書いた時点の記録として書き換えていない（PR 番号のリンクだけをこの棚卸しで足した、上記）。`### Fixed` 側の「⭕ 非破壊と数える」の項目も書き換えていない——あちらは `Runtime` 自身が渡す値の変化（壁時計→注入した時計、追加のみで非破壊）を書いたもので、今回 Breaking と数え直したのは別の軸（自前の store 実装者が conformance スイートに対して負う義務）である。`docs/migration-v1.md` 側の訂正は同文書に書く（ここには複製しない）。

⚠ **正の対照**: `git diff --stat 94dafe0..fd20e14 -- 'packages/*/src/**' ':!**/__tests__/**'` が返す21ファイルすべてを、上の6 PR の記述と突き合わせ、すべて説明が付くことを確認した——`packages/core/src/event.ts`・`interfaces/event-store.ts`（PR #1389、コメントのみ）、`packages/core/src/interfaces/clock.ts`（PR #1394、コメントのみ）、`packages/core/src/event-retention-purge.ts`・`interfaces/memory-store.ts`（PR #1393 と PR #1394 の両方が触れており、行数の内訳もそれぞれの diff と一致する）・`interfaces/tenant-settings-store.ts`（PR #1393）・`interfaces/outbox-store.ts`・`recall-runtime.ts`・`recall.ts`（PR #1392 と PR #1394 の両方。`recall-runtime.ts`/`recall.ts` は #1392 が段3.5 の trace を、#1394 が `createdAt` の受け渡しをそれぞれ足しており、行数の内訳が一致する）・`runtime.ts`（PR #1394）、`packages/local-embedding/src/local-embedding-provider.ts`（PR #1397）、`packages/postgres/src/client.ts`・`pool-error-warning.ts`（PR #1395）・`memory-store.ts`（PR #1393 と PR #1394 の両方、行数の内訳が一致）・`outbox-store.ts`（PR #1394）、`packages/testkit/src/__fixtures__/in-memory-memory-store.ts`（PR #1393 と PR #1394 の両方、行数の内訳が一致）・`in-memory-outbox-store.ts`（PR #1394）・`in-memory-tenant-settings-store.ts`（PR #1393）・`memory-event-check.ts`（PR #1389）・`memory-store-conformance.ts`・`outbox-store-conformance.ts`（PR #1394。上の「渡した時刻を守る」歯そのもの）。`packages/core/src/event.ts`・`interfaces/event-store.ts`（PR #1389）と `packages/core/src/interfaces/clock.ts`（PR #1394）は、変更の前後を TypeScript の `transpileModule`（`removeComments: true`）で JS に落として比べ、差分ゼロであることを確かめた（コメント・TSDoc だけの変更）。ほかの13ファイルはどれも実装が変わっており、差が出ることも確かめた。

**型の上**: `git diff 94dafe0..fd20e14 -- scripts/__snapshots__/public-api/` は `core.d.ts`・`postgres.d.ts`・`testkit.d.ts`・`local-embedding.d.ts` の4ファイルに新しい差分が在り、どれも追加のみ（削除・必須化・狭小化は無い——シグネチャに引数が増えた箇所で `-`/`+` の両方が出るのは、既存の引数の並びの書き換えであり削除ではない）。`core.d.ts`: `computeEventRetentionCutoff(now, days)`・`MemoryStore.purgeExpiredEventsByRetention?`・`PurgeExpiredEventsByRetentionOptions`・`PurgeExpiredEventsByRetentionOutcome`（PR #1393）、`MemoryStore.createObservationWithOutbox`/`createMemoryWithOutbox`/`supersedeWithNewMemories?` の `opts?: { now?: Date }`・`requeueEmbedJobs` の `writeOpts?: { now?: Date }`・`OutboxStore.complete`/`fail` の `opts?: { at?: Date }`・`NewRecallRecord.createdAt?: Date`（PR #1394、上の Breaking で数え直した項目）、`RecallStageName` に `"association"` が増え `StageTraceSchema`/`RecallResultSchema` にも反映（PR #1392）。`postgres.d.ts`: `createPostgresClient` の設定に `onPoolError?: (error: Error) => void`（PR #1395）、`PostgresMemoryStore` に `purgeExpiredEventsByRetention`（PR #1393）と上記 `opts?`/`writeOpts?` の各引数（PR #1394）。`testkit.d.ts`: `InMemoryMemoryStore.eventRetentionDays`・`InMemoryTenantSettingsStore` のコンストラクタに `eventRetentionDaysBacking?: Map<string, number | null>`（PR #1393）、`OutboxStoreConformanceOptions.peekJob?`（PR #1394。適合テストが新しい歯を検査するために増やした口）と上記 `opts?`/`writeOpts?` の各引数（PR #1394）。`local-embedding.d.ts`: `DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE = 128`・`LocalEmbeddingProviderOptions.maxBatchSize?: number`（PR #1397）。`anthropic.d.ts`・`openai.d.ts`・`bullmq.d.ts` に、この範囲で新たに増えた差分は無い。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い。

**⚠ 2026-09-29 追記25（23回目の棚卸し。`54b05bc` まで広げた）**: `fd20e14`…`54b05bc` に `main` へ入った PR を first-parent で全部当てた（44480a5 #1396、1618694 #1399、00321e1 #1398、ca27946 #1400、cd5b1d5 #1401、d7df706 #1402、f312c4d #1404、8e467c6 #1405、a53b2b7 #1406、54b05bc #1407）。**このうち ca27946 #1400 は22回目の棚卸し自身であり、範囲には入るが `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけである**（追記24 が21回目の棚卸し自身（PR #1391）について書いたのと同じ扱い）。残り9 PR は、どれも着地の時点で本人がこの節に項目を足しており（この棚卸しの「PR を全部当てた」手順を経て新規に足したものではない）、この棚卸しではリンクと分類を検証した——PR #1396（[Issue #1196](https://github.com/takecchi/mnemora/issues/1196)、`### Fixed`、非破壊）・PR #1398（[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、`### Added`、非破壊）・PR #1399（[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)、`### Fixed`、非破壊）・PR #1401（[Issue #1239](https://github.com/takecchi/mnemora/issues/1239)、`### Fixed`、非破壊）・PR #1402（Issue #1064、`### Fixed`、非破壊。**本文に先例が明記されている**——`OutboxJob.lastError` の文字列の中身を変えた過去の変更（Issue #969「cause の連鎖を足す」・PR #1060「NUL を `\u0000` に置き換える」・Issue #1080「API キーを含まない例外にする」）はいずれも `### Fixed` に置かれ破壊的とは数えられておらず、今回も同じ扱いとする、と本文の ⭕ の注に書かれている）・PR #1404（[Issue #1403](https://github.com/takecchi/mnemora/issues/1403)、`### Changed`、非破壊 ⚠ 付き）・PR #1405（[Issue #1256](https://github.com/takecchi/mnemora/issues/1256)、`### Fixed`、非破壊 ⚠ 付き）・PR #1406（Issue #1222、`### Fixed`、非破壊 ⚠ 付き）・PR #1407（Issue #1188 残り、`### Fixed`、非破壊）は、どれも分類・本文とも直すものが無かった。**PR #1396・PR #1398・PR #1402・PR #1405・PR #1406・PR #1407 の6項目は、Issue 番号でしか受けておらず PR 番号へのリンクが欠けていたので、この棚卸しで足した**（先例: 追記24 が PR #1392・PR #1397 に足した形と同じ）。あわせて、上の「postgres 利用者へ」の PR #1406（Issue #1222、migration 0025）の案内も、着地前に書いた「PR 未定」のままだったので、この棚卸しで PR 番号のリンクを足した（本文・数値は書き換えていない）。**分類・リンク以外に直すものは無かった**（見出しの食い違い・分類の誤りは見つからなかった）。

⚠ **正の対照**: `git diff --stat fd20e14..54b05bc -- 'packages/*/src/**' ':!**/__tests__/**'` が返す27ファイルすべてを、上の9 PR の記述と突き合わせ、すべて説明が付くことを確認した——`packages/anthropic/src/errors.ts`（PR #1399）・`llm-provider.ts`（PR #1399・PR #1398、行数の内訳がそれぞれの diff と一致する）、`packages/core/src/abort.ts`（新規ファイル、PR #1398）・`claim-key.ts`（PR #1398）・`extraction.ts`（PR #1398・PR #1406、行数の内訳がそれぞれの diff と一致する）・`index.ts`（PR #1398）・`interfaces/embedding-provider.ts`・`interfaces/llm-provider.ts`（PR #1398、コメントのみ）・`interfaces/outbox-store.ts`（PR #1396、コメントのみ）・`outbox.ts`（PR #1402、コメントのみ）・`recall-runtime.ts`（PR #1398）・`runtime.ts`（PR #1398・PR #1402・PR #1406・PR #1407、行数の内訳がそれぞれの diff と一致する）・`strategies/consolidate.ts`・`strategies/reflect.ts`・`validity.ts`（すべて PR #1407）、`packages/local-embedding/src/local-embedding-provider.ts`（PR #1398・PR #1404）・`pipeline.ts`（PR #1401・PR #1404。両 PR とも同じ関数群を触っており、コミット単位の `--numstat` の和が範囲の `--numstat` と一致しない——重なる hunk を挟んで直列に変更したためで、diff アルゴリズムの通常の挙動であり、取りこぼしではない。`git log --first-parent -- packages/local-embedding/src/pipeline.ts` で、この範囲を触った commit が cd5b1d5 #1401・f312c4d #1404 の2本だけであることを確認した）・`transformers-cache-place.ts`（PR #1404）、`packages/openai/src/embedding-provider.ts`（PR #1398）・`errors.ts`（PR #1399）・`llm-provider.ts`（PR #1399・PR #1398）・`structured-root.ts`（PR #1399）、`packages/postgres/src/lexical-store.ts`（PR #1406）・`outbox-store.ts`（PR #1396）・`trigram-lexical-store.ts`（PR #1405・PR #1406）、`packages/testkit/src/__fixtures__/in-memory-outbox-store.ts`（PR #1396）・`fixtures.ts`（PR #1406、コメントのみ）の27ファイル。コメントのみと判定した5ファイル（`core/interfaces/embedding-provider.ts`・`interfaces/llm-provider.ts`・`interfaces/outbox-store.ts`・`outbox.ts`・`testkit/src/fixtures.ts`）は、変更の前後を TypeScript の `transpileModule`（`removeComments: true`）で JS に落として比べ、差分ゼロであることを確かめた（追記24 と同じ手法）。ほかの22ファイルはどれも実装が変わっており、差が出ることも確かめた。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い。マイグレーションが1本増えた（`0025_lexical_tsvector_fallback.sql`、156行、PR #1406。上の「postgres 利用者へ」の案内のとおり）。

**型の上**: `git diff fd20e14..54b05bc -- scripts/__snapshots__/public-api/` は `anthropic.d.ts`・`core.d.ts`・`local-embedding.d.ts`・`openai.d.ts`・`postgres.d.ts` の5ファイルに新しい差分が在り、どれも追加のみ（削除・必須化・狭小化は無い）。`core.d.ts`: 新設の `abort.ts` が export する `AbortOptions`・`abortReason`・`isAbort`・`runAbortable`、`deriveClaimKeys`/`extractCandidates`/`runRecall` の末尾に `signal?: AbortSignal`、`EmbeddingProvider.embed`/`LLMProvider.complete`/`completeStructured`/`Runtime.observe`/`recall`/`findCorrectionCandidates`/`reextract` に `opts?: AbortOptions`、`ConsolidateOptions`/`ReflectOptions`/`TickOptions` に `signal?: AbortSignal`（すべて PR #1398）。`anthropic.d.ts`・`openai.d.ts`: 上と同じ `AbortOptions` の追加（PR #1398）に加え、`AnthropicLLMFailureKind`/`OpenAILLMFailureKind` に `"schema_unsupported"` が増え、`*ProviderErrorOptions` に `cause?: unknown` が増えた（PR #1399）。`local-embedding.d.ts`: `LocalEmbeddingProvider.embed` に `opts?: AbortOptions`（PR #1398）——PR #1401・PR #1404 は `cacheDir`/`revision` の既存の欄の**挙動**だけを直しており、公開の型は1バイトも変えていない。`postgres.d.ts`: `TrigramLexicalUnavailableReason` に `"extension_not_visible"` が増えた（PR #1405、union への値の追加で破壊的と数えない——オーナーの回答（ask_human `d9364c91`）と同じ理由）——PR #1396・PR #1402・PR #1406・PR #1407 は、どれも公開の型を変えていない（`testkit.d.ts` にこの範囲で新しい差分は無い。`bullmq.d.ts` も同様）。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い（再掲）。

⟹ **この節の範囲（`v1.0.2`…`54b05bc`）で、確定した破壊的変更は4件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」）のままである。**この棚卸しで新しく確定した破壊的変更は無い——PR #1401・PR #1404・PR #1405・PR #1406・PR #1407 はいずれも ⚠ 付きで非破壊と数えている（本文の ⚠ のとおり）。この判断はクローン miku の判断であり、オーナーの判断ではない。
**⚠ 2026-09-29 追記25**: 上の棚卸しの範囲（`fd20e14` まで）の**外**——着地に先立って変更を作った本人がこの節に足した1件——として、`@mnemora/postgres` の pgvector 版検査が確定した破壊的変更である（[Issue #1301](https://github.com/takecchi/mnemora/issues/1301)、[ADR 0367](./docs/decisions/0367-pgvector-capability-check.md)）。中身は下の `### Breaking` を見ること——ここには複製しない。🔴 `fd20e14` からこの変更が着地するまでの間に他の PR が `main` へ入っている可能性があるが、それらを1本ずつ洗って分類する棚卸しはまだ行っていない。**次回の棚卸しで、この追記25が数えていない範囲（`fd20e14`…この変更の着地点）を通しで数え直すこと。**

**⚠ 2026-09-29 追記26（24回目の棚卸し。`c04ae5d` まで広げた）**: `54b05bc`…`c04ae5d` に `main` へ入った PR を first-parent で全部当てた（2884eed #1408、3f6c9b1 #1409、9091e1f #1411、c1f2456 #1413、6321dbe #1410、c04ae5d #1414）。**このうち 3f6c9b1 #1409 は23回目の棚卸し自身であり、範囲には入るが `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけである**（追記25 が22回目の棚卸し自身（PR #1400）について書いたのと同じ扱い）。**c04ae5d #1414 は `packages/postgres/src/__tests__/`（`global-setup-worker-databases.ts`・`setup-worker-database.ts`・`worker-database.ts`ほか）・`packages/postgres/vitest.config.mts`・[ADR 0371](./docs/decisions/0371-db-tests-per-worker-database.md) だけを変えるテスト専用の PR であり、この節は docs・README・テストだけの変更を項目にしない慣例（追記5以降と同じ）により項目を足さない**（下の「正の対照」でも、この PR が出荷の `src` を1行も触っていないことを確かめた）。残り3 PR（#1408・#1411・#1413）は、どれも着地の時点で本人がこの節に項目を足しており、この棚卸しの「PR を全部当てた」手順を経て新規に足したものではない——この棚卸しではリンクと分類を検証した。PR #1408（[Issue #1301](https://github.com/takecchi/mnemora/issues/1301)、`### Breaking`、[ADR 0367](./docs/decisions/0367-pgvector-capability-check.md)）・PR #1411（[Issue #1185](https://github.com/takecchi/mnemora/issues/1185)、`### Added`、非破壊）・PR #1413（[Issue #1238](https://github.com/takecchi/mnemora/issues/1238)、`### Breaking`、[ADR 0372](./docs/decisions/0372-conformance-suite-issue-1238-promises.md)）は、どれも既に PR 番号へのリンクを持ち、分類・本文とも直すものが無かった。**PR #1410（[Issue #1181](https://github.com/takecchi/mnemora/issues/1181)、`### Fixed`、非破壊）の項目だけは、着地の時点で PR 番号へのリンクが欠けており（ADR 0362 へのリンクも欠けていた）、この棚卸しで両方のリンクを足した**（本文・分類は書き換えていない）。

⚠ **「追記25」という番号は、この節に2か所ある。**1つ目は23回目の棚卸し自身の段落（上、「**⚠ 2026-09-29 追記25（23回目の棚卸し。`54b05bc` まで広げた）**: `fd20e14`…`54b05bc` に `main` へ入った PR を…」で始まる段落。正の対照・型の上を伴う）。2つ目は、PR #1408 が着地時にこの節へ足した段落（すぐ上、「**⚠ 2026-09-29 追記25**: 上の棚卸しの範囲（`fd20e14` まで）の**外**……」で始まる段落。`### Breaking` の直前に置かれていた）である。先例（追記19・追記23 の注、上の前書き）と同じ理由の重複——別の担い手が別の理由で同じ次の番号を使ったものと見られる。**過去の追記の本文は書き換えないので、どちらの番号もそのまま残す。**

⚠ **2つ目の「追記25」（PR #1408 の着地時の段落）が予告していた数え直しについて**: その段落は「次回の棚卸しで、この追記25が数えていない範囲（`fd20e14`…この変更の着地点）を通しで数え直すこと」と書いているが、**`fd20e14` は PR #1408 の著者がその変更を書いた時点でまだ知らなかった、当時の最新の棚卸し境界である**——実測（`git log --first-parent`）では、PR #1408 の着地（`2884eed`）は `54b05bc`（23回目の棚卸しの終点、PR #1407）の直後・`3f6c9b1`（23回目の棚卸し自身、PR #1409）の直前に起きている。つまり `fd20e14`…`54b05bc` は、PR #1408 が着地する前に23回目の棚卸し（1つ目の追記25）が既に数え終えていた範囲であり、実際に数え直しが要るのは `54b05bc`…`2884eed`（この変更の着地点）だけだった。**この24回目の棚卸しの範囲（`54b05bc`…`c04ae5d`）はこの部分を含めて全部当てているので、予告はこの棚卸しで片付いた。**

⚠ **正の対照**: `git diff --stat 54b05bc..c04ae5d -- 'packages/*/src/**' ':!**/__tests__/**'` が返す10ファイルすべてを、上の4 PR（#1408・#1410・#1411・#1413）の記述と突き合わせ、すべて説明が付くことを確認した——`packages/core/src/extraction.ts`・`observation.ts`・`runtime.ts`（すべて PR #1411）、`packages/postgres/src/index.ts`・`migrate.ts`・`pgvector-capability.ts`（新規ファイル。すべて PR #1408）・`vector-store.ts`（PR #1408・PR #1410 の両方）、`packages/testkit/src/event-store-conformance.ts`・`memory-store-conformance.ts`・`vector-store-conformance.ts`（すべて PR #1413、上の Breaking の7つの約束の `it`）の10ファイル。**`vector-store.ts` は、各コミットの diff の hunk を実際に見分けた**——PR #1408 は `parseVectorLiteral` 直後の import・pgvector 能力ゲート（`pgvectorCapabilityGate`）のフィールドとその呼び出しを `search()`/`searchMany()`/`buildFilterConditions` の数箇所へ挟むだけで、PR #1410 は `withRelaxedOrderScan` 周辺と `buildFilterConditions` の SQL 生成部・`search()`/`searchMany()` の本体に、統計の有無で分岐する `LATERAL` 版のクエリを足しており、触っている行が別である。`git diff --numstat 54b05bc..c04ae5d -- packages/postgres/src/vector-store.ts` は `+225/-28`、`git show --numstat 2884eed -- 同ファイル` は `+51/-2`、`git show --numstat 6321dbe -- 同ファイル` は `+174/-26` で、和（`+225/-28`）が範囲の numstat と一致する——前回（追記25）の `pipeline.ts` と違い、この2本の間に重なる hunk による取りこぼしは無い。どのファイルもコメントのみの変更ではなく実装が変わっている（`transpileModule` による突き合わせは要らなかった）。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い。マイグレーションは増えていない（`packages/postgres/migrations/` の最後尾は `0025_lexical_tsvector_fallback.sql` のまま）。

**型の上**: `git diff 54b05bc..c04ae5d -- scripts/__snapshots__/public-api/` は `core.d.ts`・`postgres.d.ts` の2ファイルに新しい差分が在り、どちらも追加のみ（削除・必須化・狭小化は無い）。`core.d.ts`: `ObserveEventInput.extractData?: boolean`・`ObserveDocumentInput.extractTitle?: boolean`と、`ObserveInputSchema` の対応する zod の欄（PR #1411。省略時の既定は変えていない）。`postgres.d.ts`: 新設の `pgvector-capability.ts` が export する `PGVECTOR_CAPABILITY_QUERY`・`PgvectorCapabilityRow`・`PGVECTOR_REQUIRED_VERSION`・`PgvectorMissingCapability`・`PgvectorVersionUnsupportedError`・`assertPgvectorCapabilityRow`・`assertPgvectorCapabilityViaQuery`（PR #1408。上の Breaking そのもの）と、`PostgresVectorStore` に private フィールド `pgvectorCapabilityGate` が増えた分（PR #1408。`private` なので公開の契約は変わらない）。PR #1410・PR #1413 は、どちらも公開の型を1バイトも変えていない（PR #1410 はクエリの実行計画だけ、PR #1413 は conformance suite の `it` だけ）。`anthropic.d.ts`・`openai.d.ts`・`local-embedding.d.ts`・`testkit.d.ts`・`bullmq.d.ts` に、この範囲で新たに増えた差分は無い。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い（再掲）。

⟹ **この節の範囲（`v1.0.2`…`c04ae5d`）で、確定した破壊的変更は6件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」、PR #1408・Issue #1301、PR #1413・Issue #1238）になった。**この棚卸しで新しく確定した破壊的変更は無い——PR #1408・PR #1413 は、どちらも着地の時点で本人が `### Breaking` に項目を足していたものを、この棚卸しでこの節の ⟹ の集計へ正式に足しただけである（上の追記24 が PR #1394 について行った「見出しの下には在るが集計に含まれていない食い違い」の解消と同じ扱い）。`docs/migration-v1.md` 側の集計は、PR #1408 の着地時に既に5件、PR #1413 の着地時に既に6件へ更新済みだった——`CHANGELOG.md` 側の ⟹ の集計だけが、この棚卸しまで4件のまま遅れていた。PR #1410 は ⭕ 非破壊と数えている（本文のとおり）。この判断はクローン miku の判断であり、オーナーの判断ではない。

**⚠ 2026-09-29 追記27（25回目の棚卸し。`1998b2b` まで広げた）**: `c04ae5d`…`1998b2b` に `main` へ入った PR を first-parent で全部当てた（94f8e17 #1417、7f596dc #1418、82a6785 #1420、1cfd3fd #1422、1998b2b #1421）。**このうち 82a6785 #1420 は24回目の棚卸し自身であり、範囲には入るが `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけである**（追記25・追記26 が前々回・前回の棚卸し自身について書いたのと同じ扱い）。**7f596dc #1418・1cfd3fd #1422 はテスト専用の PR であり、この節は docs・README・テストだけの変更を項目にしない慣例（追記5以降と同じ）により項目を足さない**——#1418 は `packages/postgres/src/__tests__/upgrade-from-released.postgres.test.ts` だけを変え、#1422 は `packages/postgres/src/memories-statistics.ts` にテスト専用関数 `peekMemoriesWriteCounterForTesting()` を足しているが、`packages/postgres/src/index.ts` からは export されておらず、public-api スナップショット（`postgres.d.ts`）にも現れない（下の「型の上」で確かめた）。残り2 PR は、どちらも着地の時点で本人がこの節に項目を足しており、この棚卸しの「PR を全部当てた」手順を経て新規に足したものではない——この棚卸しではリンクと分類を検証した。94f8e17 #1417（[Issue #1412](https://github.com/takecchi/mnemora/issues/1412)、`### Breaking`、[ADR 0373](./docs/decisions/0373-conformance-suite-issue-1412-promises.md)）は、既に PR 番号へのリンクを持ち、分類・本文とも直すものが無かった。**1998b2b #1421（[Issue #1415](https://github.com/takecchi/mnemora/issues/1415)、`### Fixed`、非破壊）の項目だけは、着地の時点で PR 番号と ADR へのリンクが欠けていたので、この棚卸しで両方のリンクを足した**（本文・分類は書き換えていない、上を見よ）。

⚠ **直前の棚卸し（追記26）が数えた PR #1410（Issue #1181、ADR 0362）への注記**: PR #1421（ADR 0374）は、PR #1410（ADR 0362）が採った「統計あり・無しの2形を1本の SQL の中に並べ、`pg_class.reltuples` の One-Time Filter で切り替える」仕組みそのものを、`search()`/`searchMany()` の両方から撤去し、`PostgresVectorStore` インスタンスが表ごとに確認結果を覚える `StatsPresenceGate` へ置き換えた（ADR 0374 決定1・決定4）。この `[1.1.0]` 節は出荷済みでない節であり、PR #1421 が PR #1410 の仕組みを置き換えたため、PR #1410 の項目の本文はもう今の実装と合わなくなった——本文は当時の記録として残し、上の PR #1410 の項目の末尾に注記で正した（詳細は上を見よ。ここには複製しない）。

⚠ **正の対照**: `git diff --stat c04ae5d..1998b2b -- 'packages/*/src/**' ':!**/__tests__/**'` が返す6ファイルすべてを、上の3 PR（#1417・#1421・#1422）の記述と突き合わせ、すべて説明が付くことを確認した——`packages/testkit/src/event-store-conformance.ts`・`memory-store-conformance.ts`・`outbox-store-conformance.ts`・`vector-store-conformance.ts`（すべて PR #1417、上の Breaking の5つの約束の `it`）、`packages/postgres/src/memories-statistics.ts`（PR #1422、テスト専用関数のみ）、`packages/postgres/src/vector-store.ts`（PR #1421）の6ファイル。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い。マイグレーションは増えていない（`packages/postgres/migrations/` の最後尾は `0025_lexical_tsvector_fallback.sql` のまま）。

**型の上**: `git diff c04ae5d..1998b2b -- scripts/__snapshots__/public-api/` は `testkit.d.ts`・`postgres.d.ts` の2ファイルに新しい差分が在り、どちらも追加のみ（削除・必須化・狭小化は無い）。`testkit.d.ts`: `MemoryStoreConformanceOptions` に任意フィールド `supportsResolveOrphanedContested?: boolean` が増えた（PR #1417）。`postgres.d.ts`: `PostgresVectorStore` に private フィールド `statsPresenceGate` が増えた分（PR #1421。`private` なので公開の契約は変わらない）。PR #1422 が足した `peekMemoriesWriteCounterForTesting` は `packages/postgres/src/index.ts` から export されておらず、`postgres.d.ts` には現れない。`core.d.ts`・`anthropic.d.ts`・`openai.d.ts`・`local-embedding.d.ts`・`bullmq.d.ts` に、この範囲で新たに増えた差分は無い。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い（再掲）。

⟹ **この節の範囲（`v1.0.2`…`1998b2b`）で、確定した破壊的変更は7件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」、PR #1408・Issue #1301、PR #1413・Issue #1238、PR #1417・Issue #1412）になった。**この棚卸しで新しく確定した破壊的変更は無い——PR #1417 は、着地の時点で本人が `### Breaking` に項目を足していたものを、この棚卸しでこの節の ⟹ の集計へ正式に足しただけである（上の追記26 が PR #1408・PR #1413 について行った「見出しの下には在るが集計に含まれていない食い違い」の解消と同じ扱い）。`docs/migration-v1.md` 側の集計は、PR #1417 の着地時に既に7件へ更新済みだった——`CHANGELOG.md` 側の ⟹ の集計だけが、この棚卸しまで6件のまま遅れていた。PR #1421 は ⭕ 非破壊と数えている（本文のとおり）。この判断はクローン miku の判断であり、オーナーの判断ではない。

**⚠ 2026-09-30 追記28（26回目の棚卸し。`7e1c68a` まで広げた）**: `1998b2b`…`7e1c68a` に `main` へ入った PR を first-parent で全部当てた（c8f82c5 #1423、1e7bda7 #1426、b84586b #1424、3d84c22 #1427、ecc1782 #1429、9150d4c #1428、7e1c68a #1431）。**このうち 1e7bda7 #1426 は25回目の棚卸し自身であり、範囲には入るが `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけである**（追記25・追記26・追記27 が前々々回・前々回・前回の棚卸し自身について書いたのと同じ扱い）。**c8f82c5 #1423・ecc1782 #1429 は、この節に項目を足さない**——#1423 は `docs/decisions/0059-*.md`・`0062-*.md`・`0343-*.md` への日付付き追記と `packages/postgres/src/__tests__/create-index-lock-mode.postgres.test.ts`・`packages/postgres/vitest.config.mts` だけを変える doc・テスト専用の PR であり、この節は docs・README・テストだけの変更を項目にしない慣例（追記5以降と同じ）による。#1429 は `examples/chat/src/scripts/*.ts`・カセット一式と `docs/decisions/0329-*.md`・`0377-*.md` への追記だけを変える PR で、`examples/chat` は `"private": true` であり出荷される面の外（[ADR 0243](./docs/decisions/0243-changelog-lists-publish-targets-only.md)、上の前書きと同じ理由）、`packages/*/src` にも触れていない。残り4 PR（#1424・#1427・#1428・#1431）は、どれも着地の時点で本人がこの節に項目を足しており、この棚卸しの「PR を全部当てた」手順を経て新規に足したものではない——この棚卸しではリンクと分類を検証した。**b84586b #1424（[Issue #835](https://github.com/takecchi/mnemora/issues/835)、`### Fixed`、⭕ 非破壊）の項目だけは、着地の時点で PR 番号へのリンクが欠けていたので、この棚卸しで [PR #1424](https://github.com/takecchi/mnemora/pull/1424) のリンクを足した**（Issue #835 と ADR 0377 の間、他の項目と同じ並び。本文・分類は書き換えていない）。3d84c22 #1427（`### Breaking`、項目25）は、既に PR 番号・ADR へのリンクを持ち、分類・本文とも直すものが無かった。**9150d4c #1428（`### Breaking`、項目26）の項目だけは、着地の時点で PR 番号へのリンクが欠けていたので、この棚卸しで [PR #1428](https://github.com/takecchi/mnemora/pull/1428) のリンクを足した**（Issue #1226 と ADR 0375 の間。本文・分類は書き換えていない）。7e1c68a #1431（[Issue #933](https://github.com/takecchi/mnemora/issues/933) PR1、`### Breaking`、[ADR 0378](./docs/decisions/0378-claim-key-contested-detection-covers-contested-matches.md)）は、既に PR 番号・ADR へのリンクを持ち、`docs/migration-v1.md` にも項目27として足しており、この棚卸しでは分類・本文とも直すものが無かった——`findContestedByClaimKey?` という新しい任意メソッドと、それを検査する conformance suite の歯・新しい任意フラグ `supportsFindContestedByClaimKey?` の追加であることを、`git diff 1998b2b..7e1c68a -- scripts/__snapshots__/public-api/`（下の「型の上」）で確かめた。

⚠ **「追記28」がこの節に2か所ある**: 1つ目はこの段落（26回目の棚卸し自身）。2つ目は、PR #1431 が着地時にこの節へ足した段落（上、`consolidate`/`reflect` の項目の直後、「**⚠ 2026-09-30 追記28**: 上の25回分の棚卸しとは別に、着地に先立って変更を作った本人がこの節へ足した項目……」で始まる段落）である。先例（追記19・追記23・追記25 の注、上の前書き）と同じ理由の重複——別の担い手が別の理由で同じ次の番号を使ったものと見られる。**過去の追記の本文は書き換えないので、どちらの番号もそのまま残す。**

⚠ **注記(i) 見出しの件数と番号付き項目の数の食い違い**: `docs/migration-v1.md`「🔴 破壊的変更」の見出しの件数は PR の数で数えており、番号付き項目は9つ（項目19〜27）しか無い。差の1件は PR #1377（Issue #1221）で、番号付き項目を持たず、同ファイル1069行目付近の段落（「上の棚卸しの範囲の外……ここには複製しない」）だけに載っている——その段落自身の方針による**意図した形**であり、見落としではない。

⚠ **注記(ii) 見出しの件数が8件のまま進んでいなかったこと**: `docs/migration-v1.md` の見出し「未リリース。確定は8件」は、9150d4c #1428 が項目26を足したとき（項目26末尾の ⟹ の集計は9件へ更新済みだった）に、**見出しの数字だけ 8→9 へ上げ忘れていた**。その後 7e1c68a #1431 が項目27（⟹ の集計は10件）を足したときも、見出しの数字は直っていなかった（8件のまま）——この棚卸しで10件に直した。

⚠ **正の対照**: `git diff --stat 1998b2b..7e1c68a -- 'packages/*/src/**' ':!**/__tests__/**'` が返す6ファイルすべてを、上の4 PR（#1424・#1427・#1428・#1431）の記述と突き合わせた。すべて複数 PR にまたがっており、各コミットの `git show --numstat` の和が範囲の `git diff --numstat` と一致するかで確かめた——`packages/core/src/claim-key.ts`（範囲 +42/-16 = #1424 の +34/-11 + #1431 の +8/-5。#1427・#1428 はこのファイルに触れていない）、`packages/core/src/interfaces/memory-store.ts`（範囲 +192/-12 = #1424 の +11/-0 + #1427 の +39/-10 + #1428 の +80/-2 + #1431 の +62/-0）、`packages/postgres/src/memory-store.ts`（範囲 +177/-7 = #1427 の +73/-5 + #1428 の +59/-2 + #1431 の +45/-0。#1424 はこのファイルに触れていない）は、いずれも和が範囲の numstat と一致した。**`packages/core/src/runtime.ts`・`packages/testkit/src/memory-store-conformance.ts` の2ファイルだけは、和が範囲と一致しない**（`runtime.ts`: 和 +423/-92 に対し範囲は +407/-76。`memory-store-conformance.ts`: 和 +940/-0 に対し範囲は +978/-38）——#1424・#1428・#1431（`runtime.ts`）、#1427・#1428・#1431（`memory-store-conformance.ts`）が同じ関数群・同じ conformance の節を直列に重ねて変更したための、diff アルゴリズムの通常の挙動であり、取りこぼしではない（前々回・追記26 の `vector-store.ts` と違い、今回は重なる hunk が実際にある——前回・追記27 の `pipeline.ts` の扱いと同じ）。`git log --first-parent 1998b2b..7e1c68a -- packages/core/src/runtime.ts` は b84586b #1424・9150d4c #1428・7e1c68a #1431 の3本だけ、`git log --first-parent 1998b2b..7e1c68a -- packages/testkit/src/memory-store-conformance.ts` は 3d84c22 #1427・9150d4c #1428・7e1c68a #1431 の3本だけであることを確認し、この範囲を触った commit がこの3本以外に無いことを確かめた——取りこぼしは無い。`packages/testkit/src/__fixtures__/in-memory-memory-store.ts`（範囲 +122/-4 = #1427 の +79/-4 + #1431 の +43/-0）も一致した。どのファイルもコメントだけの変更ではなく実装が変わっている。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い。マイグレーションは増えていない（`packages/postgres/migrations/` の最後尾は `0025_lexical_tsvector_fallback.sql` のまま）。

**型の上**: `git diff 1998b2b..7e1c68a -- scripts/__snapshots__/public-api/` は `core.d.ts`・`postgres.d.ts`・`testkit.d.ts` の3ファイルに新しい差分が在り、どれも追加のみ（削除・必須化・狭小化は無い）。`core.d.ts`（+25/-2）: 新しい公開クラス `SourceMemoryForgottenError`、`createMemoryWithOutbox`/`supersedeWithNewMemories?` の `opts` に追加された `abortIfForgotten?: ReadonlyArray<MemoryId>`（2箇所）、`ConsolidateOutcome`/`ReflectOutcome`・`ConsolidateSourceOutcome`/`ReflectBasisOutcome` の union への値の追加（以上 #1428）、新しい任意メソッド `MemoryStore.findContestedByClaimKey?`（#1431）。`postgres.d.ts`（+10/-0）: `PostgresMemoryStore.createMemoryWithOutbox`/`supersedeWithNewMemories?` の `opts` に同じ `abortIfForgotten?` が2箇所（#1428）、`findContestedByClaimKey` の実装（#1431）。`testkit.d.ts`（+12/-0）: `InMemoryMemoryStore` の private フィールド `memoryLabels`・`memoryLabelKey`（#1427）、`MemoryStoreConformanceOptions.supportsAbortIfForgotten?: boolean`（#1428）、`InMemoryMemoryStore.findContestedByClaimKey` の実装と `MemoryStoreConformanceOptions.supportsFindContestedByClaimKey?: boolean`（#1431）。各 PR の単独 diff（`git diff --stat <parent>..<sha> -- scripts/__snapshots__/public-api/`）の和がファイルごとの範囲の差分と一致することを確かめた（`core.d.ts`: 0+17+8=25／-0-2-0=-2、`postgres.d.ts`: 0+2+8=10、`testkit.d.ts`: 2+1+9=12）。`anthropic.d.ts`・`openai.d.ts`・`local-embedding.d.ts`・`bullmq.d.ts` に、この範囲で新たに増えた差分は無い。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い（再掲）。

⟹ **この節の範囲（`v1.0.2`…`7e1c68a`）で、確定した破壊的変更は10件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」、PR #1408・Issue #1301、PR #1413・Issue #1238、PR #1417・Issue #1412、PR #1427・Issue #994/#995/#1207、PR #1428・Issue #1226、PR #1431・Issue #933）になった。**この棚卸しで新しく確定した破壊的変更は無い——PR #1427・PR #1428・PR #1431 は、どれも着地の時点で本人が `### Breaking` に項目を足しており、`docs/migration-v1.md` 側の ⟹ の集計もそれぞれの着地時（8件・9件・10件）に更新済みだった——`CHANGELOG.md` 側の ⟹ の集計だけが、この棚卸しまで7件のまま遅れていた（上の追記26・追記27 が PR #1408・PR #1413・PR #1417 について行ったのと同じ食い違いの解消）。PR #1424 は ⭕ 非破壊と数えている（本文のとおり）。この判断はクローン miku の判断であり、オーナーの判断ではない。

**⚠ 2026-09-30 追記29（27回目の棚卸し。`62def34` まで広げた）**: この節が数える範囲の起点は `8b434bb`（PR #1433、26回目の棚卸し自身。前回・追記28 が数えた終点は `7e1c68a` であり、`8b434bb` はその直後に着地した1本目である）。`8b434bb`…`62def34` に `main` へ入った PR を first-parent で全部当てた（8b434bb #1433、b33ae0b #1435、62def34 #1434）。**8b434bb #1433 は26回目の棚卸し自身であり、範囲には入るが `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけである**（追記25〜追記28 が前々回までの棚卸し自身について書いたのと同じ扱い）。**62def34 #1434 は、この節に項目を足さない**——`examples/chat` の矛盾候補の印の付け方を記録順で非対称にする変更と、[ADR 0379](./docs/decisions/0379-contested-tag-asymmetric-wording.md) の新設・ADR 0295 への追記・`docs/decisions/README.md` の追記だけを変える PR で、`examples/chat` は `"private": true` であり出荷される面の外（[ADR 0243](./docs/decisions/0243-changelog-lists-publish-targets-only.md)、上の前書きと同じ理由）、`packages/*/src` にも触れていない。残り1 PR（b33ae0b #1435、[Issue #1432](https://github.com/takecchi/mnemora/issues/1432)、`### Breaking`、[ADR 0380](./docs/decisions/0380-reextract-withdrawn-across-extractor-versions.md)）は、着地の時点で本人が既にこの節へ項目を足しており（上の `listBySourceObservationAllVersions` の項目）、この棚卸しの「PR を全部当てた」手順を経て新規に足したものではない——この棚卸しではリンクと分類を検証した。**PR 番号へのリンクだけが着地の時点で欠けていたので、この棚卸しで [PR #1435](https://github.com/takecchi/mnemora/pull/1435) のリンクを足した**（Issue #1432 と ADR 0380 の間、他の項目と同じ並び。本文・分類は書き換えていない）。`docs/migration-v1.md` にも項目28として既に足しており、この棚卸しでは分類・本文とも直すものが無かった。

⚠ **範囲外の直し**: `docs/migration-v1.md` の項目24（PR #1417、Issue #1412）・項目26（PR #1428、Issue #1226）は、`CHANGELOG.md` 側には既に PR 番号へのリンクが在る（上の `### Breaking` の該当項目、それぞれ25回目・26回目の棚卸しで足した）のに、`docs/migration-v1.md` 側だけリンクが欠けていた——この棚卸しの範囲（`8b434bb`…`62def34`）の外だが、気づいたのでついでに [PR #1417](https://github.com/takecchi/mnemora/pull/1417)・[PR #1428](https://github.com/takecchi/mnemora/pull/1428) のリンクを足した（本文・分類は書き換えていない）。

⚠ **正の対照**: `git diff --stat 7e1c68a..62def34 -- 'packages/*/src/**' ':!**/__tests__/**'` が返す5ファイルは、すべて b33ae0b #1435 だけの変更である（`git log --first-parent 7e1c68a..62def34 -- 'packages/*/src/**'` は b33ae0b の1本だけ。62def34 #1434 は `packages/*/src` に触れていない）——`packages/core/src/interfaces/memory-store.ts`（+33/-0）、`packages/core/src/runtime.ts`（+64/-10）、`packages/postgres/src/memory-store.ts`（+24/-0）、`packages/testkit/src/__fixtures__/in-memory-memory-store.ts`（+17/-0）、`packages/testkit/src/memory-store-conformance.ts`（+144/-0）は、いずれも `git diff --numstat b33ae0b^..b33ae0b` の値と一致し、重なる hunk による取りこぼしの心配は無い（範囲に含まれる `packages/*/src` の変更が1 PR だけのため）。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い。マイグレーションは増えていない（`packages/postgres/migrations/` の最後尾は `0025_lexical_tsvector_fallback.sql` のまま）。

**型の上**: `git diff 7e1c68a..62def34 -- scripts/__snapshots__/public-api/` は `core.d.ts`・`postgres.d.ts`・`testkit.d.ts` の3ファイルに新しい差分が在り、どれも `listBySourceObservationAllVersions` の宣言1行の追加だけ（削除・必須化・狭小化は無い）。`anthropic.d.ts`・`openai.d.ts`・`local-embedding.d.ts`・`bullmq.d.ts` に、この範囲で新たに増えた差分は無い。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い（再掲）。

⟹ **この節の範囲（`v1.0.2`…`62def34`）で、確定した破壊的変更は11件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」、PR #1408・Issue #1301、PR #1413・Issue #1238、PR #1417・Issue #1412、PR #1427・Issue #994/#995/#1207、PR #1428・Issue #1226、PR #1431・Issue #933、PR #1435・Issue #1432）になった。**この棚卸しで新しく確定した破壊的変更は無い——PR #1435 は、着地の時点で本人が `### Breaking` に項目を足しており、`docs/migration-v1.md` 側の ⟹ の集計も着地時に既に11件へ更新済みだった——`CHANGELOG.md` 側の ⟹ の集計だけが、この棚卸しまで10件のまま遅れていた（上の追記26・追記27・追記28 が PR #1408・PR #1413・PR #1417・PR #1427・PR #1428・PR #1431 について行ったのと同じ食い違いの解消）。この判断はクローン miku の判断であり、オーナーの判断ではない。

### Breaking

- **`@mnemora/openai`・`@mnemora/anthropic` の `*ProviderOptions.client` の型が、SDK の
  クラスから切り出した型から、SDK のクラスを名指ししない自前の構造型へ変わった**
  （[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)、
  [PR #1377](https://github.com/takecchi/mnemora/pull/1377)、
  [ADR 0350](./docs/decisions/0350-provider-client-type-decoupled-from-sdk-classes.md)）。
  オーナーの回答（ask_human `f259eeb8`、逐語「型を SDK のクラスから切り離すってのは
  だめですか？」）に基づく。

  | パッケージ | 欄 | 以前の型 | 新しい型 |
  |---|---|---|---|
  | `@mnemora/openai` | `OpenAILLMProviderOptions.client` | `Pick<OpenAI, "chat">` | `OpenAIChatClient` |
  | `@mnemora/openai` | `OpenAIEmbeddingProviderOptions.client` | `Pick<OpenAI, "embeddings">` | `OpenAIEmbeddingsClient` |
  | `@mnemora/anthropic` | `AnthropicLLMProviderOptions.client` | `Pick<Anthropic, "messages">` | `AnthropicMessagesClient` |

  **誰が影響を受けるか**:
  - 🔴 **`Pick<OpenAI, "chat">`・`Pick<OpenAI, "embeddings">`・`Pick<Anthropic, "messages">`
    を、自分のコードの型注釈にそのまま書いている利用者**（例: 独自の偽 client の型を
    宣言している場合）は、新しい型名（`OpenAIChatClient`・`OpenAIEmbeddingsClient`・
    `AnthropicMessagesClient`。どちらも `@mnemora/openai`/`@mnemora/anthropic` から
    export される）へ書き換える必要がある。
  - ⭕ **SDK の client インスタンス（`new OpenAI(...)`・`new Anthropic(...)`）をそのまま
    `client` に渡しているだけの利用者は、型検査・実行時のどちらも影響を受けない**——
    構造的に代入できる。**むしろ、以前は `@mnemora/openai`/`@mnemora/anthropic` が
    固定している版と違う版の SDK を入れると型検査が壊れていたのが、この変更で
    通るようになる**（今まで型で落ちていた組み合わせが緑になる。既存の README の
    回避策「同じ版を `-E` で入れる」はもう要らない——`packages/openai/README.md`・
    `packages/anthropic/README.md` から該当の案内を削除し、訂正を追記した）。
  - ⭕ `client` を渡さない利用者（`apiKey` だけ、または環境変数）は影響を受けない。

  `openai`・`@anthropic-ai/sdk` は引き続き `dependencies` に版を固定して持つ
  （`peerDependencies` にはしない。理由は ADR 0350「決定」3）。

**⚠ 2026-09-29 追記20**: 上の18回分の棚卸しとは別に、`f5ad59f`（18回目が数えた末尾）より後に
`main` へ入った作業として、`@mnemora/core` に破壊的変更がもう1件確定した（[Issue #548](https://github.com/takecchi/mnemora/issues/548)
方向2、[ADR 0352](./docs/decisions/0352-association-score-without-total.md)）。上の
`2026-09-29 追記`（PR #1377、`@mnemora/openai`/`@mnemora/anthropic` の件）と同じ扱い
——着地に先立って変更を作った本人がこの節に足した項目であり、棚卸しの「PR を全部当てた」
手順を経て足したものではない。上の `### Breaking` へ2件目の項目として足した（追記19 と番号が
続けて見えるが、追記19（保留の解消）とは別件である——追記19 は既存12項目の再分類、
この追記20 は新しい確定1件）。🔴 `f5ad59f` からこの変更が着地するまでの間に他の PR
（例: PR #1375・#1376・#1379・#1381・#1383）が `main` へ入っているが、それらを1本ずつ
洗って分類する棚卸しはまだ行っていない。**次回の棚卸しで、この追記20が数えていない
範囲（`f5ad59f`…この変更の着地点）を通しで数え直すこと。**

- **`@mnemora/core` の `RecalledMemory.score`/`RecallRecordMemory.score`/`CorrectionCandidate.score`
  の型が `ScoreBreakdown` から `ScoreBreakdown | AffinityUnmeasuredScore`（新設のUnion型、
  エクスポート名 `RecalledScore`）に変わった**（[Issue #548](https://github.com/takecchi/mnemora/issues/548)
  方向2、[PR #1385](https://github.com/takecchi/mnemora/pull/1385)、
  [ADR 0352](./docs/decisions/0352-association-score-without-total.md)）——
  **`affinityMeasured` が `false` の記憶（連想枠 `retrievedVia: "association"`、および
  必須の同伴取得 `retrievedVia: "mandatory_companion"`。どちらも段3・段3.5 のどちらの
  経由でも該当する）の `score` は、`total`/`similarity`/`lexicalMatch` という欄を
  持たなくなった**（`undefined` になるのではなく、欄自体が無い）。これらの欄を無条件に
  読んでいる呼び出し側（例: `memory.score.total`）は、この版から型検査に落ちる
  （実行時は今までも `association`/`mandatory_companion` の `total` は「比較可能ではない」
  値だった——ADR 0282／Issue #548 の核心。今回は、その事実を型でも表すようにしただけで、
  順位・既定値・どの記憶が返るかは1ビットも変えていない）。
  - **`strategies/consolidate.ts` の `computeAffinity(score)` の引数型も
    `ScoreBreakdown` → `RecalledScore` に変わった**（`RecalledMemory.score` を経由する
    公開関数のため連鎖する）。**戻り値は1バイトも変わらない**——`affinityMeasured === false`
    のときに `-Infinity` を返す分岐を早期 return にしただけで、以前も
    `similarity`/`lexicalMatch` がどちらも無い候補には同じ `-Infinity` を返していた。
  - **移行の手順（`m.score.affinityMeasured !== false` で絞り込む）**:
    ```ts
    const total = m.score.affinityMeasured !== false ? m.score.total : null;
    ```
    `affinityMeasured` が `true`/`undefined`（独自の `ScoringStrategy` を実装していて
    この欄を埋めていない場合を含む——ADR 0282「設計問2」と同じ区別できない `undefined`
    の扱いを、安全側＝`ScoreBreakdown` へ倒す）なら `m.score.total` が読める。`false`
    （連想枠・必須の同伴取得）なら `total`/`similarity`/`lexicalMatch` は存在しない
    ——その `score` は `decay`/`tagMatch`/`freshness`/`strength` だけを持つ。
  - **`ScoringStrategy`（`strategies/scoring.ts` の公開の拡張点）自体は変えていない**——
    独自の採点関数を実装している利用者のコードはこの変更の影響を受けない。
  - **永続化済みの過去の `recalls` 行は影響を受けない**——`getRecall` で読み戻すと、
    本 ADR より前に書かれた `association`/`mandatory_companion` の行は、書かれた
    当時の形（`total` を持つ場合はそのまま）で返る。マイグレーションは無い（決定・理由は
    ADR 0352 決定5）。
  - **版の付け方について**: `README.md`「版の付け方」は `v1.0.0` 以降の破壊的変更は
    major を上げるとしているが、この変更は `v1.1.0`（minor）に破壊的変更として入っている。
    これはオーナーの回答（ask_human 6911db12）（問6、2026-09-28）——逐語
    「v1.X.0とかで破壊的変更しちゃっていいよ僕しか使ってないし」——を根拠にした運用であり、
    詳細は ADR 0352「文脈」節と `README.md`「版の付け方」の追記を見ること。

- **`MemoryStore`/`OutboxStore` を自前で実装している人へ**: 時刻を渡す欄が、任意の欄として増えた
  （[Issue #1237](https://github.com/takecchi/mnemora/issues/1237)「案1」、
  [PR #1394](https://github.com/takecchi/mnemora/pull/1394)、
  [ADR 0355](./docs/decisions/0355-inject-clock-into-store-writes.md)）——
  `MemoryStore.createObservationWithOutbox`/`createMemoryWithOutbox` の第4引数
  `opts?: { now?: Date }`（積む outbox 行の `availableAt`/`createdAt`）、
  `MemoryStore.supersedeWithNewMemories?` の末尾の引数 `opts?: { now?: Date }`（同じ）、
  `MemoryStore.requeueEmbedJobs` の第3引数 `writeOpts?: { now?: Date }`（積み直す embed
  ジョブの `availableAt`/`createdAt`）、
  `OutboxStore.complete`/`fail` の末尾の引数 `opts?: { at?: Date }`
  （`completedAt`/`failedAt`）、`NewRecallRecord.createdAt?: Date`（`recalls` 行の
  `createdAt`）。**型の上では追加だけである**——構造的部分型の下では、既存の実装（この
  引数を受け取らない・この欄を書かない）も、TypeScript の型検査はそのまま通る
  （ADR 0165 決めたこと13 と同じ理由）。
  - ⚠ **型検査を通ることは、正しく動くことを意味しない。** この欄を無視する（省略時に
    実装が壁時計 `new Date()` を使うのではなく、渡された値を無視し続ける）実装は、
    `packages/testkit` の `describeMemoryStoreConformance`/`describeOutboxStoreConformance`
    が本 PR で足した「渡した時刻を守る」歯（`opts.now`/`opts.at`/`createdAt` を渡すと、
    書く行がその値になることを検査する）に落ちる。同じ歯は、既存の欄の使い方も2つ検査する
    ——`purgeMemory` の `purgedAt` が `event.at`（省略時は1つの壁時計の値を両方に使う）と
    同じ値になること、`archiveDecayed` が積む `archived` イベントの `at` が `opts.now` に
    なること。
  - ⚠ **この欄を実装しないままだと、Issue #1237 が指摘した壊れ方が自分の実装にだけ残る**
    ——`RuntimeDeps.clock` に壁時計より過去の時刻を注入すると、`tick()` は積んだジョブを
    1本も取れない（`available_at` が壁時計のまま、claim は `available_at <= now`
    ＝注入した時計のジョブしか取らないため）。`@mnemora/postgres`・
    `@mnemora/testkit/fixtures` の2実装は、本 PR でこの欄を守るよう直した
    （`packages/postgres/src/__tests__/injected-clock-reach.postgres.test.ts`）。
  - **移行の手順**:
    1. 自分の `MemoryStore`/`OutboxStore` 実装で、上に挙げた口の書き込みが
       `opts.now`/`writeOpts.now`/`opts.at`/`record.createdAt`（省略時は `new Date()`）を実際に使うよう直す。
    2. `purgeMemory` の `purgedAt` を `event.at` に、`archiveDecayed` の `archived` の `at` を
       `opts.now` に揃える。
    3. `packages/testkit` の適合テストを実装に対して走らせ、緑になることを確認する
       （`docs/conformance.md`）。
    直さない間も、`Runtime` からの呼び出しは今までどおり動く（これらの欄は壁時計のまま）。
    直して初めて、注入した時計がこれらの欄にも届く。
- **`@mnemora/core` の `purgeExpiredEventsForTenant`（保持期間の掃除の呼び出し口）は、
  `MemoryStore.purgeExpiredEventsByRetention?` を実装していない adapter に対して
  `{ kind: "store_unsupported" }` を返すようになった——`MemoryStore.purgeExpiredEvents?`
  （既存の任意メソッド）を実装しているだけでは、もう「対応している」と扱われない**
  （[Issue #1232](https://github.com/takecchi/mnemora/issues/1232)、
  [PR #1393](https://github.com/takecchi/mnemora/pull/1393)、
  [ADR 0354](./docs/decisions/0354-atomic-event-retention-purge.md)）。

  **何が起きていたか**: `purgeExpiredEventsForTenant` は保持期間（`TenantSettingsStore.getEventRetention`）を
  読んでから `MemoryStore.purgeExpiredEvents` を呼んでいたが、読んでから呼ぶまでの間に
  `setEventRetention` で保持期間を変えても（無期限にしても、延ばしても）、読んだときの
  古い期間で `memory_events` を削除してしまっていた——削除は物理削除であり戻せない
  （Issue #1232 本文の実測）。

  **何を足したか**: 保持期間を読むことと実際に削除することを1つの原子的な操作にする新しい
  任意メソッド `MemoryStore.purgeExpiredEventsByRetention?(ctx, { now, limit, dryRun? })`。
  `@mnemora/postgres` は同一トランザクションの中で `tenant_settings.event_retention_days` を
  `SELECT ... FOR SHARE` で読み直し、その値で削除まで行う。

  **誰が影響を受けるか**: 自前の `MemoryStore` 実装を `purgeExpiredEventsForTenant` に渡している
  利用者のうち、`purgeExpiredEventsByRetention?` をまだ実装していない場合。

  **移行の手順**:
  1. 自分の `MemoryStore` に `purgeExpiredEventsByRetention?` を実装する。契約は
     `packages/core/src/interfaces/memory-store.ts` の interface doc（`MemoryStore.purgeExpiredEventsByRetention`）を
     見ること——cutoff の計算は `@mnemora/core` が export する `computeEventRetentionCutoff(now, days)`
     を使う（自前で計算し直さない）。
  2. **`TenantSettingsStore` と `MemoryStore` を別々の DB・別々のプロセスに持つ adapter**
     （このリポジトリの参照実装のように同一 DB・同一トランザクションで両方を実装していない場合）は、
     この口を完全な原子性で実装できない——選べる案は2つ:
     - 実装しない（`purgeExpiredEventsForTenant` は `store_unsupported` を返す。保持期間の掃除は
       運用側が別の手段で行う）。
     - ベストエフォートで実装する（自分の `TenantSettingsStore` 相当を読んでから削除するが、
       読みと削除の間に他の書き込みが割り込む窓が残ることを引き受ける——ADR 0354「引き受けた負債」参照）。
  3. **途中で保持期間を短くした場合は、その回から短い期間で消すようになった**（今までは、その回は
     読んだときの長い期間で消していた）。消すのは `setEventRetention` が返った後の値である——
     掃除が設定の行を読んでいる最中の `setEventRetention` は、Postgres では掃除の commit まで待たされる。
     ⚠ 残る非対称は消し過ぎない側だけにある: `purgeExpiredEventsForTenant` が最初に `unset`/`unlimited` を
     読んだ回は、その後に有限の日数へ変えても、その回は消さない（次の回で消える）。

  **公開の型としては非破壊**（新しい任意メソッドを足しただけ、既存の `purgeExpiredEvents?`/
  `PurgeExpiredEventsOptions`/`PurgeExpiredEventsResult` の宣言は変えていない）——**実行時の
  振る舞いが変わる**という意味での Breaking である（`purgeExpiredEvents?` だけを実装している
  adapter の呼び出し結果が `executed` から `store_unsupported` に変わる）。

- **`@mnemora/postgres` は、pgvector が `hnsw.iterative_scan` の `relaxed_order`
  （[ADR 0284](./docs/decisions/0284-hnsw-iterative-scan-relaxed-order-adopted.md)）に
  対応しているかを起動時に検査するようになった——対応していなければ新しい
  `PgvectorVersionUnsupportedError` を投げる**（[Issue #1301](https://github.com/takecchi/mnemora/issues/1301)、
  [PR #1408](https://github.com/takecchi/mnemora/pull/1408)、
  [ADR 0367](./docs/decisions/0367-pgvector-capability-check.md)）。

  **どこで検査するか**: `PostgresVectorStore.search()`/`searchMany()`（インスタンスごとに
  初回の呼び出しでだけ。以降はキャッシュされ、追加の往復は生まない）と、
  `runMigrations`（`extensionMode` の `create`/`verify` 両方——`mnemora-postgres-migrate`
  も同じ経路を通る）。

  **誰が影響を受けるか**: pgvector が 0.8.0 未満（または `ALTER EXTENSION vector
  UPDATE;` をまだ実行していないために `hnsw.iterative_scan` が使えないまま）の環境。
  **今までは、その組み合わせによって「2回目の `recall()` から ERROR」（pgvector
  0.6.0〜0.7.x × PostgreSQL 15 以上）か「黙って iterative scan が効かないまま動き続ける」
  （pgvector 0.5.x、または PostgreSQL 15 未満）のどちらかだった**（Issue #1301 本文の表）。
  この版からは、`mnemora-postgres-migrate` の実行時、または `search()`/`searchMany()` の
  初回呼び出し時に、はっきりした型のエラー（`PgvectorVersionUnsupportedError`。
  `installed`/`required`/`missingCapability` を持つ）で落ちる。

  **判定は `pg_extension.extversion` の文字列比較ではなく、能力で行う**——`pg_settings` の
  `hnsw.iterative_scan` 行が実際に `relaxed_order` を解釈できるかを、同じ接続で読む
  （実測・placeholder の穴の扱いは ADR 0367）。⟹ **ライブラリが実際に 0.8.0 以上なら、
  何らかの理由で `extversion` が古いまま報告されていても落ちない**——落ちるのは
  「実際に iterative scan が効かない構成」だけである。

  **移行の手順**: pgvector を 0.8.0 以上へ上げるか、`ALTER EXTENSION vector UPDATE;` を
  実行する。**検査を外すオプションは無い。**

- **`@mnemora/testkit` の conformance suite が、自前の `MemoryStore`/`VectorStore`/
  `EventStore` 実装に7つの約束を新しく課すようになった——これらを自前で実装している
  人へ**（[Issue #1238](https://github.com/takecchi/mnemora/issues/1238)、
  [PR #1413](https://github.com/takecchi/mnemora/pull/1413)、
  [ADR 0372](./docs/decisions/0372-conformance-suite-issue-1238-promises.md)）。

  Issue #1238 は「2026-09-27 にマージした歯のうち、外部 adapter にも課しうる約束」を
  棚卸ししていた（足すかどうかは決めていなかった）。その候補のうち7件を、
  `describeMemoryStoreConformance`・`describeVectorStoreConformance`・
  `describeEventStoreConformance` に `it` として足した——どれも今回の PR まで、
  この repo の2実装（`@mnemora/postgres`・testkit の in-memory fixture）では既に
  成り立っていた約束であり、実装は変えていない。

  | 約束 | 内容 |
  |---|---|
  | `supersedeWithNewMemories` のロールバック | news の2件目が書けずに投げたら、1件目・outbox・ラベルも旧行も一切残さない |
  | 区切り文字の非衝突 | `:`・`::` を含む tenantId・contentHash・extractorVersion・space の model でも、別の対象・別テナント・別 space と衝突しない |
  | テナント分離 × 並行 | 2テナントで同じ口を並行に撃っても、テナントをまたいで created・行を取り違えない |
  | `onlyMemoryIds` の形式不正 id | `restoreSupersededBy`/`previewRestoreSupersededBy` の `onlyMemoryIds` に形式不正な id が混ざっても例外にせず、形の正しい id だけが戻る |
  | reinforce の起点（未強化） | `lastReinforcedAt: null` の記憶に、作成時刻より前の `at` で reinforce しても起点を巻き戻さない（no-op） |
  | claim key の片方欠落 | `listActiveClaimPredicates` は subject か predicate の片方しか無い claim key を数えない |
  | EventStore の meta/actor 往復 | `append` の `meta`・`actor` が、core が入れる形（文字列・id・id の配列）だけのまま読み戻る |

  **なぜ破壊的と数えるか**: `docs/migration-v1.md`「数え方の規律への追記
  （2026-09-28）」規律2 の ⛔ が「conformance スイートの判定を厳しくする変更は、
  これまでどおり上の定義と各世代の分け方で数える」と明記しており、
  [PR #1394](https://github.com/takecchi/mnemora/pull/1394)（Issue #1237）が
  同じ理由で先に破壊的変更と数えている。型検査は壊れないが、上の7つの約束を
  満たしていない自前実装は、この版から conformance suite を当てると新しく落ちる。

  **誰が影響を受けるか**: 自前の `MemoryStore`/`VectorStore`/`EventStore` 実装を
  `describeMemoryStoreConformance`/`describeVectorStoreConformance`/
  `describeEventStoreConformance` に対して走らせている利用者のうち、上の7つの
  約束のどれかを満たしていない場合。**適合テストを走らせていない・自前実装を
  持たない利用者は影響を受けない。**

  **移行の手順**: 各約束の内容に沿って実装を直し、conformance suite を再度走らせて
  緑になることを確認する。詳細（契約の正確な文言）は各 `*-conformance.ts` の
  該当する `it` とその前後のコメントを見ること。

  **DB マイグレーション**: 不要（スキーマは変えていない。テストのみの変更）。

  **範囲の外**（Issue #1238 が棚卸しした残りの候補。足すかどうかは決めていない）:
  A2（イベントを書く口の「投げるなら、呼ぶ前と同じ」——共通に使える入力が
  見つかっていない）・A8（返り値・渡した入力の切り離し）・A10〜A15
  （`events_purged` の meta の型・`getRecall` の `query` の JSON 往復・
  `LLMProvider.completeStructured` の4スキーマ・`LexicalStore` の語の分け方・
  adapter 間の差分ファズ・`purgeExpiredEvents` の並行）・PR #1296 の棚卸しコメント
  1・2（`resolveOrphanedContested` の CAS 例外・例外の欄の値）。理由は
  ADR 0372「決めたこと」3を見ること。

- **`@mnemora/testkit` の conformance suite が、自前の `MemoryStore`/`VectorStore`/
  `EventStore`/`OutboxStore` 実装にさらに約束を新しく課すようになった——これらを
  自前で実装している人へ**（[Issue #1412](https://github.com/takecchi/mnemora/issues/1412)
  （Issue #1238 棚卸しの続き）、[PR #1417](https://github.com/takecchi/mnemora/pull/1417)、
  [ADR 0373](./docs/decisions/0373-conformance-suite-issue-1412-promises.md)）。

  Issue #1412 は、PR #1413（項目23）が切り出さなかった Issue #1238 の残りの候補のうち、
  A8・A10・A11 と PR #1296 棚卸しのコメント1・2 を挙げていた。今回、実装は変えず
  次の約束を `it` として足した——どれも今回の PR まで、この repo の2実装
  （`@mnemora/postgres`・testkit の in-memory fixture）では既に成り立っていた。

  | 約束 | suite | 内容 |
  |---|---|---|
  | A8: 入力・返り値の切り離し | `MemoryStore`・`VectorStore`・`EventStore`・`OutboxStore` | `createMemory`/`upsert`/`append` に渡した配列・オブジェクト・Date を呼び手が後から書き換えても保存した値は変わらない。`get`/`getMany`/`getVectors`/`claimBatch`（の `payload`）/任意メソッド `supersedeWithNewMemories` が返した値を書き換えても、store 側・次の読みは影響を受けない |
  | A10: `events_purged` の meta の型 | `MemoryStore`（`purgeExpiredEvents?`） | `oldestPurgedAt`/`newestPurgedAt`/`olderThan` が ISO 8601 の文字列である（値そのものは既存の歯に任せ、型と形だけを縛る） |
  | A11: `getRecall` の `query` 往復 | `MemoryStore` | JSON を通る欄（text・tags・attributes・labels・limit・association）だけで組んだ `query` が、渡した値のまま読み戻る（日付3欄と `vector` は対象外、#1206） |
  | コメント1: `resolveOrphanedContested` の CAS | `MemoryStore`（`resolveOrphanedContested?`、新しい任意フラグ `supportsResolveOrphanedContested?`） | 生存側が呼び出し時点で `status !== 'contested'`、または `contestedWithId` が食い違うと `MemoryStatusConflictError`（`expectedStatus: 'contested'`）を投げ、無傷のまま |
  | コメント2: 型付き例外の欄の値 | `MemoryStore` | `ContestedWithoutCompanionError` の `method`/`memoryId`（`updateStatus`/`updateStatusWithEvent` は対象の id、`createMemory`/`createMemoryWithOutbox`/`supersedeWithNewMemories` は `null`）。`markContestedPair`/`resolveContestedPair`/`updateStatusWithEvent` の `MemoryStatusConflictError` の3欄（`memoryId`/`expectedStatus`/`observedStatus`）。`purgeMemory` の `MemoryPurgeConflictError` の `observedStatus`/`observedPurgedAt`——**逐次の呼び出しに限った約束**（並行の下では保証しない） |

  **A8 は `LexicalStore`・`TenantSettingsStore` を対象にしていない**——Issue #1412 の
  下調べどおり、この2つの fixture は複合値を受け取って保存する口をほぼ持たず
  （`InMemoryLexicalStore`/`InMemoryTenantSettingsStore` はプリミティブか、毎回
  新しく組み立てた値だけを返す）、切り離すべき参照が無いため歯の中身が無い
  （ADR 0373「決めたこと」2）。**A12 は足していない**（`purgeExpiredEvents` の
  並行の正しさ——Issue #1412 のコメントが「conformance suite の外から adapter の
  中へ遅延を差し込めず、赤くなりうる歯を書けない」と明記している）。

  **`MemoryStoreConformanceOptions` に新しい任意フィールドが1つ増えた**:
  `supportsResolveOrphanedContested?: boolean`——既存の `supportsOnlyMemoryIdsFilter`/
  `supportsListActiveClaimPredicates` と同じ3状態（`true`/`false`/省略）。**この
  フィールドの追加自体は非破壊**（省略すれば「未検査」の named it が1本登録される
  だけで、既存の呼び出しは型検査・実行時のどちらも壊れない）。

  **なぜ破壊的と数えるか**: `docs/migration-v1.md`「数え方の規律への追記
  （2026-09-28）」規律2 の ⛔ が「conformance スイートの判定を厳しくする変更は、
  これまでどおり上の定義と各世代の分け方で数える」と明記しており、項目23
  （PR #1413）が同じ理由で先に破壊的変更と数えている。型検査は壊れないが、
  上の約束を満たしていない自前実装は、この版から conformance suite を当てると
  新しく落ちる。

  **誰が影響を受けるか**: 自前の `MemoryStore`/`VectorStore`/`EventStore`/
  `OutboxStore` 実装を、対応する `describe*Conformance` に対して走らせている
  利用者のうち、上の約束のどれかを満たしていない場合。**適合テストを走らせて
  いない・自前実装を持たない利用者は影響を受けない。**

  **移行の手順**: 各約束の内容に沿って実装を直し、conformance suite を再度走らせて
  緑になることを確認する。詳細（契約の正確な文言）は各 `*-conformance.ts` の
  該当する `it` とその前後のコメントを見ること。

  **DB マイグレーション**: 不要（スキーマは変えていない。テストのみの変更）。

- **`MemoryStore.purgeMemory?` が消す範囲を広げた——自前実装している人へ**
  （[Issue #994](https://github.com/takecchi/mnemora/issues/994)・
  [Issue #995](https://github.com/takecchi/mnemora/issues/995)・
  [Issue #1207](https://github.com/takecchi/mnemora/issues/1207)、
  [PR #1427](https://github.com/takecchi/mnemora/pull/1427)、
  [ADR 0375](./docs/decisions/0375-purge-scope-widened.md)）。
  purge の約束（オーナー代理・クローン miku の決定）を「その記憶の本文と、本文から
  直接たどれる派生物（digest を含む記録・埋め込み・tags などの付帯情報）を消す」と
  具体化し、`purgeMemory?` の同じ書き込みに次を追加した。

  | 何を | どうなるか |
  |---|---|
  | `memories.tags` | `[]`（空配列）へ上書き |
  | `memories.attributes` | `{}`（空オブジェクト）へ上書き |
  | `memories.claim_key_subject`/`claim_key_predicate` | `NULL` へ上書き |
  | `memory_labels`（この Memory の紐付け） | 削除。`status: 'proposed'` のまま残る `labels.proposed_count` を外した本数だけ減らす（床0。`registered` は触らない。近似値のまま——ADR 0318 が既に引き受けている近似の延長） |
  | `recalls.index_band.digestBand`（このテナントの全 recall 記録のうち、この `memoryId` を含むエントリ） | `digest` をトゥームストーン（`purgeMemory` に渡された値。既定 `"[purged]"`）へ書き換える。`truncated` は落とす |

  いずれも `content`/`digest`/`purgedAt` と同じトランザクションで行う——CAS が
  弾かれれば（対象が `forgotten` でない・既に purge 済み）、これらの書き込みも
  一切起きない。**型は変えていない**（`purgeMemory?` のシグネチャは同じ）。
  公開 API の型の差分は、`@mnemora/testkit` の `InMemoryMemoryStore` に private メンバ
  `memoryLabels`・`memoryLabelKey` の2つが増えたことだけである（Fake が Memory ごとの
  label の紐付けを持つようになったため。このクラスは以前から private メンバを持つので、
  型の互換の性質は変わらない——PR #1114 の `rawGet` と同じ扱い）。

  **残ると決めたもの（(b)、これまでどおり）**: `recalls.query`（`memoryId` で
  特定できないため対象外）、`memories.content_hash`、`memories.provenance.speaker`・
  `subject_id`（`basisLost` の解決・呼び手の識別子という性質）、
  `observations.payload`（Observation は追記専用、purge の経路が無い）、
  `memory_events.digest_snapshot`（監査ログの目的上、意図的に残す）、
  `recall_usages`・完了した `outbox` の行、**今の `embeddingProvider.space` 以外の
  embedding**（`VectorStore` に全 space を列挙・削除する口が無いため。新しい
  [Issue #1425](https://github.com/takecchi/mnemora/issues/1425) に切り出した——
  `VectorStore` への義務追加は別判断）。

  **なぜ破壊的と数えるか**: `packages/testkit` の conformance suite に、この広げた
  範囲（tags/attributes/claim key が消える・label の紐付けが外れる・
  `recalls.index_band` の digest が伏せられる）を縛る `it` を3本足した——上の
  「数え方の規律への追記（2026-09-28）」規律2 の ⛔ が挙げる「conformance
  スイートの判定を厳しくする変更」に当たる。`purgeMemory?` を自前実装している
  第三者 adapter が「purge は `content`/`digest`/`purgedAt` 以外を変えない」という
  前提でテストを書いていた場合、この版から conformance suite を当てると新しく
  落ちうる。

  **誰が影響を受けるか**: 自前の `MemoryStore` 実装（`purgeMemory?` を持つもの）を、
  conformance suite に対して走らせている利用者のうち、上の3点のどれかを満たして
  いない場合。**`purgeMemory?` を実装していない adapter は影響を受けない。**
  **適合テストを走らせていない利用者も、`@mnemora/postgres`・`@mnemora/testkit`
  を使っていれば実行時の振る舞いが変わる**——purge の後、これまで残っていた
  `tags`/`attributes`/claim key・label の紐付け・`recalls.index_band` の元の
  digest が消える／伏せられるようになる。

  **移行の手順**: 自前の `MemoryStore` 実装を持つ場合、`purgeMemory?` に上の5点の
  書き込みを足す。足さなければ、conformance suite が新しく赤くなる（実装しない
  という選択も可能——`purgeMemory?` 自体が任意メソッドであることは変わらない）。

  **DB マイグレーション**: 不要（新しい列・表は追加していない）。

- **`consolidate`/`reflect` が、LLM を待つ間に forget/purge された材料から新しい記憶を
  書かなくなった**（[Issue #1226](https://github.com/takecchi/mnemora/issues/1226)、
  [PR #1428](https://github.com/takecchi/mnemora/pull/1428)、
  [ADR 0375](./docs/decisions/0375-purge-scope-widened.md) 決定7・2026-09-30 追記）。
  `consolidate`/`reflect` は、材料（統合元・内省の材料）を読んでから LLM を呼び、
  その結果から新しい Memory を書く。LLM を待っている間に材料の1件が `forget`
  （さらに `purge`）されても、これまでは書き込みの前に見直さず、統合先・内省の
  Memory はその本文を入れた LLM の出力から作られ `active` で書かれていた
  （`purge()` が `"purged"` を返した後でも）。**今は、LLM が返った直後・書き込みの
  直前に材料を読み直し、1件でも forgotten なら統合先・内省の Memory を一切作らずに
  打ち切る**（新しい `outcome: 'aborted_source_forgotten'`）。

  - `MemoryStore.createMemoryWithOutbox`/`supersedeWithNewMemories?` の `opts` に
    `abortIfForgotten?: ReadonlyArray<MemoryId>` を足した。渡すと、書き込みの直前に
    その id の現在の `status` を見直し、1件でも `"forgotten"` なら何も書かずに
    新しい公開クラス `SourceMemoryForgottenError` を投げる。
  - `@mnemora/postgres` は、この見直しを書き込みと同一トランザクションの中で
    `SELECT … FOR UPDATE` として行う（`embed` ジョブの同種のレースを閉じた
    [Issue #1035](https://github.com/takecchi/mnemora/issues/1035) と同じ
    「書く前に見直す」形）——見直しと書き込みの間に窓が無い。
  - `@mnemora/testkit` の `InMemoryMemoryStore` と `@mnemora/core` のテスト用
    `FakeMemoryStore` は `opts.abortIfForgotten` を実装しない（渡しても無視される）。
    これらの adapter では、`consolidate`/`reflect` 自身が LLM 呼び出しの直後に行う
    「書く直前の読み直し」だけが保護になり、読み直しと書き込みの間に小さな窓が残る。
  - `ConsolidateOutcome`/`ReflectOutcome` の union に `"aborted_source_forgotten"` を、
    `ConsolidateSourceOutcome`/`ReflectBasisOutcome` の union に
    `{ kind: "forgotten_before_write" }` を足した。**型としては追加のみ**
    （union に値を足す変更・opts への省略可能フィールドの追加は非破壊——
    「数え方の規律への追記（2026-09-28）」）。

  **なぜ破壊的と数えるか**: `packages/testkit` の conformance suite に、任意フラグ
  `supportsAbortIfForgotten?`（3状態、`supportsOnlyMemoryIdsFilter?` と同じ形）を
  新設し、`true` を宣言した adapter に対して `opts.abortIfForgotten` の契約の歯
  （forgotten な id を含めると `SourceMemoryForgottenError` を投げて何も書かない、
  forgotten でなければ今日どおり書く）を実行するようにした——上の
  「数え方の規律への追記（2026-09-28）」規律2 の ⛔ が挙げる「conformance スイートの
  判定を厳しくする変更」に当たる。**`supportsAbortIfForgotten` は任意
  （`?: boolean`）であり、渡さない・`false` を渡す既存の呼び出し元はこの新しい歯を
  1本も実行しない**（PR #524/PR #526、ADR 0237 の前例に倣い、新しい独立した能力の
  フラグを必須にはしなかった）。

  **誰が影響を受けるか**: `opts.abortIfForgotten` を自分で渡している呼び出し側
  だけ、実行時の振る舞いが変わりうる。`runtime.consolidate`/`runtime.reflect` を
  直接呼ぶだけの利用者は、`ConsolidateOutcome`/`ReflectOutcome` を網羅的に分岐
  している場合だけ型検査で気づく（union に値が増えたため）——今日どおりの分岐
  ならコンパイルは壊れない。`packages/testkit` の conformance suite を自分の
  `MemoryStore` 実装に対して走らせている利用者は、`supportsAbortIfForgotten` を
  渡さなければ影響を受けない。

  **移行の手順**: `opts.abortIfForgotten` の見直し・打ち切りを自前実装したい場合、
  `createMemoryWithOutbox`/`supersedeWithNewMemories?` にこの欄を実装し、
  conformance suite に `supportsAbortIfForgotten: true` を渡す。実装しない場合は
  何もする必要が無い（`abortIfForgotten` を渡しても無視されるだけで、今日どおり動く
  ——ただし `consolidate`/`reflect` 自身の「書く直前の読み直し」による保護は、
  adapter の実装によらず全アダプタで効く）。

  **DB マイグレーション**: 不要（新しい列・表は追加していない）。

  **陽性対照（実測）**: `packages/postgres/src/__tests__/consolidate-reflect-source-forgotten-for-update-race.postgres.test.ts`。
  書き込みの入口（読み直しの直後・書き込み直前）で障壁を置き、その間に forget/purge を
  割り込ませる変異試験——`consolidate`（`supersedeWithNewMemories`）・`reflect`
  （`createMemoryWithOutbox`）の両方で、新実装は10/10緑、対応する
  `SELECT … FOR UPDATE` の見直しを外すと10/10赤。

  **⚠ union に値を足す変更が型検査に影響しうる実例**: `examples/chat/src/consolidation-cost.ts`
  は `outcomes[result.outcome] += 1` という形で `ConsolidateOutcome` を index に使っており、
  `"aborted_source_forgotten"` を足したことで CI の typecheck が `TS7053` で落ちた（`examples/chat`
  側の `ConsolidationOutcomeCountsJson`/`emptyOutcomeCounts` に同名の欄を足して直した）。
  **「union に値を足す変更は破壊的と数えない」という判定は変えていない**——網羅的な
  `Record`/`switch` で `ConsolidateOutcome`/`ReflectOutcome`/`ConsolidateSourceOutcome`/
  `ReflectBasisOutcome` を扱っている利用者は、この種の追加でも型検査が落ちうる、という
  影響の実例として記録する。
- **`MemoryStore` に必須メソッド `listBySourceObservationAllVersions` が増えた**（[Issue #1432](https://github.com/takecchi/mnemora/issues/1432)、[PR #1435](https://github.com/takecchi/mnemora/pull/1435)、[ADR 0380](./docs/decisions/0380-reextract-withdrawn-across-extractor-versions.md)。クローン miku の委譲先の判断であり、オーナーの判断ではない）——`extractorVersion` を上げた runtime インスタンスで `reextract()` を呼ぶと、前の版で `forget`（purge を含む）・`contested` にした記憶を見落とし、退けたはずの内容と同じ意味の Memory が印の無い新しい `active` として書き直されうる欠陥があった。`Runtime.reextract` の「利用者の意思で退けた記憶を持つ Observation では抽出をやり直さない」という判定（上の Issue #1079・#1149 の項目）が、`extractorVersion` を跨ぐと効かなくなっていた。
  - **`MemoryStore` に `listBySourceObservationAllVersions(ctx, observationId): Promise<Memory[]>` を追加した。** ある Observation から作られた Memory を、`extractorVersion`・`status` のどちらでも絞らずに列挙する（**SELECT のみ**。マイグレーション・索引は追加しない——既存の一意索引 `uq_memories_extraction (tenant_id, source_observation_id, extractor_version, content_hash)` が `(tenant_id, source_observation_id)` の前方一致でも Index Scan に使える）。**既存の `listBySourceObservation` は1行も変えていない。**
  - **`Runtime.reextract` の「退けた記憶」の判定は、いまは `extractorVersion` を問わない。** 版を跨いでも、1件でも `forgotten`（purge を含む）・`contested`・訂正の解決で負けた `superseded` があれば、その Observation の抽出全体を打ち切る（同じ版のときと同じ規律。`extraction: "skipped"`・`atomicity: "not_attempted"`・`memoryIds: []`、`skipped` に退けた記憶ごとの `status_not_active`）。同じ Observation の、退けていない他の `active` な事実も作り直さない。
  - **帰結**: 版を上げても、退けたものを含む Observation は新しい版の記憶を1件も作らない。⟹ 運用側が旧い版の記憶を forget すると、その Observation のほかの（退けていない）事実も、以後の reextract では想起から作られなくなる。`skipped` に `status_not_active` が出た Observation では、旧い版の記憶を残すことが運用側の手がかりになる。
  - **版を跨いだ `active` の扱い（上の Issue #873 の項目「運用側の責務」）は変えていない**——supersede 対象の判定は今どおり今の `extractorVersion` 限定のままで、退けたものが無い Observation では、今どおり新しい版で抽出され、旧い版の `active` は supersede されない。
  - **`@mnemora/postgres`（`PostgresMemoryStore`）・`@mnemora/testkit/fixtures`（`InMemoryMemoryStore`）はこの口を実装済み。** 自前で `MemoryStore` を実装している場合は、このメソッドを実装しないと型検査が落ちる——実装は `tenant_id`・`source_observation_id` が一致する行を返すだけでよい（`extractor_version` の絞り込みを外した形）。詳細・移行の手順は [docs/migration-v1.md](./docs/migration-v1.md) 項目28。

**⚠ 2026-09-30 追記28**: 上の25回分の棚卸しとは別に、着地に先立って変更を作った本人が
この節へ足した項目（上の追記19・20 と同じ扱い）。[Issue #933](https://github.com/takecchi/mnemora/issues/933)
（claim key の自動 contested 検出が、同じ鍵の主張が1件ずつ届く経路で3件目以降を検出できず
痕跡も残さない）の PR1、[ADR 0378](./docs/decisions/0378-claim-key-contested-detection-covers-contested-matches.md)。

- **`@mnemora/core` の `MemoryStore` に、新しい任意メソッド `findContestedByClaimKey?` が
  増えた。`packages/testkit` の conformance suite に、これを検査する約束が新しく課された
  ——自前で `MemoryStore` を実装している人へ**（[Issue #933](https://github.com/takecchi/mnemora/issues/933)、
  [PR #1431](https://github.com/takecchi/mnemora/pull/1431)、
  [ADR 0378](./docs/decisions/0378-claim-key-contested-detection-covers-contested-matches.md)）。

  claim key の自動 contested 検出（[ADR 0324](./docs/decisions/0324-claim-key-contested-detection.md)）は、
  同じ鍵の主張が1件ずつ届く自然な運用シーケンスで、3件目以降を検出できず、`memory_events`
  にも痕跡を残さなかった——`MemoryStore.findActiveByClaimKey?` が `status = 'active'` の
  行しか見ないため、既に対になった1件目・2件目は候補から構造的に外れていた（Issue #933）。

  この PR（Issue #933 の PR1、案2）は、新しい任意メソッド `MemoryStore.
  findContestedByClaimKey?`（`findActiveByClaimKey?` と同じ絞り込みで、`status = 'active'`
  の代わりに `status = 'contested'` を見る）を足し、`Runtime.detectClaimKeyContested` が
  これを実装している store でだけ、`findActiveByClaimKey?` の一致と合わせて数えるように
  した。合わせた一致が2件以上のときは、今までどおり `markContested` を呼ばず
  （[#207](https://github.com/takecchi/mnemora/issues/207)/`memory_relations` が無いと
  1対1では表現できない、ADR 0324 決定5・決定6）、状態を一切動かさずに `memory_events` へ
  `claim_key_conflict_unresolved` の evidence を積むだけに留める——3件目以降の検出漏れが
  直り、少なくとも痕跡が残るようになった。**多者間のグループを実際に `contested` として
  束ねる書き込み（`RelationStore` が要る）は、この PR の範囲外**（PR2、ADR 0378・
  [ADR 0327](./docs/decisions/0327-relation-graph-contested-write-path-design.md)）。

  `packages/testkit` の conformance suite（`describeMemoryStoreConformance`）に、
  `findContestedByClaimKey?` を検査する新しい任意フラグ
  `MemoryStoreConformanceOptions.supportsFindContestedByClaimKey?: boolean` が増えた
  ——`supportsFindActiveByClaimKey?` と同じ3状態（`true`/`false`/省略）。

  **誰が影響を受けるか**:
  - 自前の `MemoryStore` を実装していて、`findContestedByClaimKey?` を実装しない場合は、
    今までどおり `findActiveByClaimKey?`（`active` のみ）の一致だけで判定される
    ——**後方互換。振る舞いは1バイトも変わらない。**
  - `describeMemoryStoreConformance` を自前実装に対して走らせている場合、
    `supportsFindContestedByClaimKey` を渡さないと「未検査」の named it が1本登録される
    （他の任意フラグと同じ、実行は失敗しない）。`true`/`false` を渡す場合は、実装の有無に
    合わせて正しい方を渡すこと。

  **なぜ破壊的と数えるか**: `docs/migration-v1.md`「数え方の規律への追記
  （2026-09-28）」規律2 の ⛔ が「conformance スイートの判定を厳しくする変更は、
  これまでどおり上の定義と各世代の分け方で数える」と明記しており、項目23・24 と同じ
  理由——型検査は壊れないが、`supportsFindContestedByClaimKey: true` を渡して
  `findContestedByClaimKey` を実装していない自前実装は、conformance suite を当てると
  新しく落ちる。

  **移行の手順**: `findContestedByClaimKey?` を実装する場合は、`findActiveByClaimKey?`
  と同じ絞り込みで `status = 'contested'` の行を返すように書き、conformance suite に
  `supportsFindContestedByClaimKey: true` を渡す。実装しない場合は何もしなくてよい
  （省略時は「未検査」のまま、後方互換の振る舞いが保たれる）。

  **DB マイグレーション**: 不要（既存の索引 `idx_memories_claim_key` は `status` を条件に
  含めない汎用索引であり、そのまま使える——新しい migration は追加していない）。

**⚠ 2026-09-30 追記29**: 上の棚卸しとは別に、着地に先立って変更を作った本人がこの節へ
足した項目（上の追記19・20・28 と同じ扱い）。[Issue #1425](https://github.com/takecchi/mnemora/issues/1425)、
[ADR 0382](./docs/decisions/0382-vector-store-delete-across-spaces.md)。

- **`@mnemora/core` の `VectorStore` interface に、新しい**必須**メソッド
  `deleteAcrossSpaces` が増えた——自前で `VectorStore` を実装している人へ**
  （[Issue #1425](https://github.com/takecchi/mnemora/issues/1425)、
  [ADR 0382](./docs/decisions/0382-vector-store-delete-across-spaces.md)）。

  `Runtime.purge` は、`purgeMemory` の成功後・および既に purge 済み（`already_purged`）
  だった場合のベストエフォートの埋め込み削除を、これまで
  `deps.vectorStore.delete(ctx, deps.embeddingProvider.space, id)`（**今の**
  `embeddingProvider.space` という**1つの空間**だけ）に対して行っていた。埋め込み
  モデルを移した（`EmbeddingSpaceId` の `provider`/`model`/`dimensions` の組を変えた）
  後、旧 space に残っている embedding 行は purge の対象外のまま残っていた——本文から
  作ったベクトルが、purge の後も残る欠陥（[Issue #995](https://github.com/takecchi/mnemora/issues/995)
  が最初に指摘、[ADR 0375](./docs/decisions/0375-purge-scope-widened.md) 決定5が
  「口が無い」として Issue #1425 に切り出していた）。

  **`VectorStore` に新しい必須メソッドを足した**:

  ```ts
  deleteAcrossSpaces(ctx: Ctx, memoryIds: readonly MemoryId[]): Promise<void>;
  ```

  `ctx.tenantId` に属する `memoryIds` の行を、その adapter が持つ**全 space**
  （`upsert`/`search`/`delete` が `space` 引数で区切る単位のすべて）から消す——
  `delete` と違い `space` 引数を受け取らない。契約: 対象の行が無ければ何もしない
  （べき等）、形式不正な `memoryId` も例外を投げない（`delete` と同じ規律）、
  `ctx.tenantId` に属さない行は消さない、`memoryIds` が空配列なら何もしない。

  `Runtime.purge` は、`vectorStore.delete(...)` を呼んでいた2箇所（`"purged"` に
  なった直後、および `MemoryPurgeConflictError` の再読で `"already_purged"` と
  分かった直後）を `vectorStore.deleteAcrossSpaces(ctx, [id])` に置き換えた。
  **加えて、CAS の初回チェックで `"already_purged"` と分かった場合（再読を経ない
  経路）でも、`opts.dryRun` が `false`（省略時を含む）ならベストエフォートで
  `deleteAcrossSpaces` を呼ぶようになった**——既に purge 済みの記憶を、埋め込み
  モデルを移した後に再実行すると、旧 space に残った embedding をその再実行で
  後始末できる。`dryRun: true` のときは呼ばない。`PurgeOutcome`/`PurgeResult` の
  型・`kind` の意味は変えていない——埋め込みの削除はベストエフォートの副作用のまま。

  **`runtime.ts` の embed ジョブが purge と競合したときの後始末**
  （[Issue #1035](https://github.com/takecchi/mnemora/issues/1035) / ADR 0124 決定5）
  **は変えていない**——このジョブは常に今の `embeddingProvider.space` にしか
  書いておらず、消すべきものも「そのジョブが今の space に書いたばかりの1行」
  だけなので、全 space を対象にした `deleteAcrossSpaces` に広げる理由が無い。

  **`@mnemora/postgres` の実装**（`PostgresVectorStore.deleteAcrossSpaces`）は、
  1つのトランザクションの中で、カタログ（`pg_class`/`pg_constraint`/`pg_attribute`）
  から対象テーブルを列挙し、テーブルごとに `DELETE FROM <t> WHERE tenant_id = $1
  AND memory_id = ANY($2)` を打つ——`packages/postgres` は space ごとに別テーブル
  という設計（[ADR 0002](./docs/decisions/0002-embedding-space-tables.md)）なので、
  「このテナントが使った space の一覧」を別の台帳として持たない。列挙の条件は3つ:
  (1) `current_schema()` の中のテーブルだけ（スキーマを跨がない）、(2) テーブル名が
  `memory_embeddings_` で始まる、(3) `memory_id` 列が同じスキーマの `memories(id)`
  を外部キーで参照している——利用者が同じ命名慣習で作った無関係なテーブルを
  巻き込まない。`registerEmbeddingSpace` が作るテーブルは、この3条件をすべて満たす。

  **`@mnemora/testkit` の `InMemoryVectorStore`・`@mnemora/core` のテスト用
  `FakeVectorStore`** は、保持している全エントリを `tenantId`/`memoryId` の一致だけで
  フィルタして消す（space を問わない）。

  **なぜ破壊的か**: `VectorStore` interface に必須メソッドが増えたため、自前で
  `VectorStore` を実装している第三者 adapter は、この新しいメソッドを実装しなければ
  型検査に落ちる。**必須メソッドにした理由**: 任意メソッドにすると、対応していない
  adapter では別 space の embedding が結局消えないという、Issue #1425 が指摘した
  欠陥そのものが残ってしまうため（ADR 0382「決定」1参照）。**v1.X.0 での破壊的変更は
  オーナーが許可済み**（ask_human `6911db12`）。

  `packages/testkit` の `describeVectorStoreConformance` にも、`deleteAcrossSpaces`
  の契約（複数 space から消える・他テナントの行は消えない・存在しない/形式不正な
  id・空配列は no-op）を検査する歯を足した——`VectorStoreConformanceOptions` 自体は
  増やしていない（space をまたぐ歯に必要な2つ目の space は、ADR 0065 から既に在る
  `prepareEmbeddingSpace` フックをそのまま使えたため）。

  **誰が影響を受けるか**:
  - 🔴 **自前の `VectorStore` 実装（第三者 adapter）を持つ利用者は、
    `deleteAcrossSpaces` を実装しない限り型検査に落ちる**——必ず対応が要る
    （任意メソッドの追加とは異なる）。
  - `packages/testkit` の conformance suite を自分の `VectorStore` 実装に対して
    走らせている利用者は、この新しいメソッドの契約を満たさなければ conformance
    suite が新しく落ちる。
  - ⭕ `@mnemora/postgres`・`@mnemora/testkit` の `InMemoryVectorStore`・
    `Runtime.purge` をそのまま使っているだけの利用者は、型・実行時のどちらも
    変える必要はない（参照実装が既に対応済み）——purge の埋め込み削除の対象が
    「今の space だけ」から「全 space」に広がるという**実行時の振る舞いの変化**
    だけを受ける。

  **移行の手順**: 自前の `VectorStore` 実装に `deleteAcrossSpaces` を足す。`upsert`/
  `search`/`delete` が管理している「space ごとの区切り」を、adapter 自身の内部
  データ構造から辿れる形で実装すること。`packages/postgres/src/vector-store.ts` の
  `deleteAcrossSpaces` の doc コメント（列挙の3条件とその理由）を実装の参考にできる。

  **DB マイグレーション**: 不要（新しい列・表は追加していない）。

  **陽性対照（実測）**: `packages/postgres/src/__tests__/purge-across-spaces.postgres.test.ts`。
  列挙の条件3（外部キー）を確かめる JOIN・WHERE 句を外す変異で、`memories(id)` を
  参照していない利用者のテーブルの行まで消えてしまい対応する歯が赤くなることを
  確認した。列挙の条件1（`current_schema()`）の絞りを外す変異で、別スキーマにしか
  無い space のテーブル名まで列挙してしまい、`DELETE` が「relation does not exist」
  で例外になって対応する歯が赤くなることを確認した（2つのスキーマに**同じ名前**の
  embedding テーブルがあるだけの構成では、`DELETE` 文が未修飾の識別子で
  `search_path` 任せに解決されるため、この変異は赤くならなかった——別スキーマに
  **しか無い**名前のテーブルを使う歯だけが、実際にこの条件の効果を検査できる。
  詳細は ADR 0382「確かめたこと」参照）。`InMemoryVectorStore.deleteAcrossSpaces` を
  「今の space だけを消す」ように壊す変異で、testkit の conformance の歯が赤くなる
  ことも確認した。いずれも戻すと緑に戻った。

### Added

- **`@mnemora/core` に `EVENT_RETENTION_KIND_INVALID_MESSAGE` と `assertValidEventRetentionKind(value: string)` を足した**（[Issue #1168](https://github.com/takecchi/mnemora/issues/1168)、[PR #1171](https://github.com/takecchi/mnemora/pull/1171)）——`setEventRetention` の `kind` を検査する口で、`DECAY_CLOCK_INVALID_MESSAGE`/`assertValidDecayClock`・`TAXONOMY_MODE_INVALID_MESSAGE`/`assertValidTaxonomyMode` と同じ形。`@mnemora/postgres` と `@mnemora/testkit/fixtures` の `setEventRetention` がこの関数を呼ぶ（下の Fixed の項目）。公開の名前の追加だけで、既存の宣言は変えていない。
- **`decay_clock` が `'wall'` 以外のテナントで、活動時計の数え方（recall のたびに進むカウンタ）を、呼び出しごとに選べるようになった**（[Issue #338](https://github.com/takecchi/mnemora/issues/338)、オーナーの回答（ask_human 61355570）「呼び出す際の引数で指定できるようにはできない？ これは使用者次第の内容だと思ったんだけど」、[PR #1380](https://github.com/takecchi/mnemora/pull/1380)、[ADR 0353](./docs/decisions/0353-activity-counting-per-call.md)）——以前は、`subject` を絞った recall でもテナント全体のカウンタ（`tenant_activity.activity_seq`）だけが進み、絞っていない別 subject の記憶の忘却も一緒に進んでいた。
  - **`RecallQuery.activityCounting?: "tenant" | "subject"`（既定 `"tenant"`）を足した。** `"subject"` を選び、かつ `ctx.subjectId` を指定した recall は、テナント全体のカウンタではなく、その subject 専用のカウンタ（新テーブル `tenant_subject_activity`）だけを進める。`ctx.subjectId` を指定していない recall では `"tenant"` と同じ扱いになる。**既定 `"tenant"` の呼び出しは、本項目の前後でビット単位で挙動が変わらない**（`tenant_subject_activity` を一度も参照しない）。
  - 忘却ゲート・段2の再スコア・掃引・作成/強化時の起点は、`activityCounting` の値に関わらず、常にその Memory の subject が持つ実際のカウンタ（テナント全体 + subject 単位）を使う。
  - `findCorrectionCandidates`・`consolidate`/`reflect` の `{ seedMemoryId }` 形にも同じ `activityCounting` を足し、内部で呼ぶ `recall()` へ伝播させた。`{ query }` 形は `RecallQuery` 自体に含められるのでそのまま伝播する。**`tick()` が駆動する自動 consolidate/reflect ジョブには届かない**（既定 `"tenant"` のまま——範囲外とした理由は ADR 0353「範囲外」節）。
  - `TenantSettingsStore` に `hasSubjectActivityCounters?`/`getSubjectActivitySeqs?` を、`VectorFilter`/`RecallScope` に `decayFloorSeqUsesSubjectCounters?` を、`ArchiveDecayedOptions` に `usesSubjectActivityCounters?` を、それぞれ省略可能な欄として足した——このテナントが一度も `"subject"` を使っていなければ、これらは常に既定へ倒れ、`@mnemora/postgres` の段1 SQL・`aggregateScope`・`archiveDecayed` は今日どおり単一パラメータの比較のままになる（プラン族を変えない）。
  - **`NewRecallRecord.advanceActivityClock` の型を `boolean` から `boolean | { scope: "subject"; subjectId: string }` に広げた。** `boolean` はこの union にそのまま含まれるため、既存の `true`/`false`/省略の呼び出しは1行も直さずに通る。
  - **新しい migration が1本増える**（`0024_tenant_subject_activity.sql`、`tenant_subject_activity` テーブルを新設するだけ）——利用者は `mnemora-postgres-migrate`（または `runMigrations`）を打つこと。
- **`@mnemora/bullmq` を npm の公開対象に加えた**（[Issue #205](https://github.com/takecchi/mnemora/issues/205)、[PR #1382](https://github.com/takecchi/mnemora/pull/1382)、[ADR 0325](./docs/decisions/0325-bullmq-tick-driver.md) 追記、[ADR 0351](./docs/decisions/0351-bullmq-publish-prep.md)）——`private: true` を外し `scripts/publish-targets.mjs` の `PUBLISH_TARGETS` 末尾に加えた。⚠ **初回 publish（段0のオーナー手元 bootstrap）はまだ済んでいない**——`npm install @mnemora/bullmq` はまだ 404 になる（手順は `docs/release-v1.md` §1.7）。version は `0.0.0` のまま（ADR 0070。version bump・publish・Release はオーナーの手）。
- **`recall()` の `explain.stages` が、段3.5（連想枠）の実行も記録するようになった**（[Issue #865](https://github.com/takecchi/mnemora/issues/865)、[PR #1392](https://github.com/takecchi/mnemora/pull/1392)、ADR 0151 2026-09-29追記）——以前は `usage.byTier.association`・`retrievedVia === "association"`・`omitted` の `stage: "association"` にだけ印が残り、`explain.stages` にはこの段に当たる名前が無かった。`RecallStageName` に `"association"` を足し、他の段と同じ形（`stage`/`executed`/`detail`）で trace を積む。`detail` は `{ anchors, hits, selected }`。**`query.association: null`（明示 off）のときは trace 自体を積まない**——`candidate_generation` のチャンネルがそもそも要求されていないときに trace を積まないのと同じ形。`vector_store_lacks_get_vectors`/`no_anchor` で段が飛んだときは `executed: false`（`omitted` の `stage_skipped` と対）、探して0件だったときは `rescore` と同じく `executed: true` のまま区別する。**`RecallStageName` への値の追加は破壊的変更に数えない**（オーナー回答 ask_human d9364c91）。
- **LLM・埋め込みの provider 呼び出しに `AbortSignal` による中断を足した**（[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、[PR #1398](https://github.com/takecchi/mnemora/pull/1398)、[ADR 0359](./docs/decisions/0359-abort-signal-for-provider-calls.md)。クローン miku の判断であり、オーナーの判断ではない）——以前は runtime が LLM・埋め込みの呼び出しに時間の上限も中断の口も持たず、provider が返るまで呼んだ口が返らなかった。**既定の時間の上限は今回も無い**——`signal` を渡さない既存の呼び出しは1バイトも変わらない。
  - **`@mnemora/core` から新しく `AbortOptions { signal?: AbortSignal }` を export した。** `LLMProvider.complete`/`completeStructured`・`EmbeddingProvider.embed` に任意の第3引数 `opts?: AbortOptions` を足した——**既存の2引数の実装（自作の provider を含む）は、そのままこの interface に適合する**（TypeScript の構造的部分型により、宣言した引数より少ない実装は代入できる。実測済み）。
  - **`Runtime.observe`/`recall`/`reextract`/`findCorrectionCandidates` に任意の第3引数 `opts?: AbortOptions` を足した。** `TickOptions`/`ConsolidateOptions`/`ReflectOptions` には `signal?: AbortSignal` を足した。どちらも省略時の挙動は変わらない。
  - **abort されると、その口は reject する**（reject の値は `signal.reason`。無ければ `AbortError` 相当）。中断は、既存の失敗経路（`observe()` の全文フォールバック・`consolidate`/`reflect` の `outcome: "llm_failed"`・recall の `embedding_provider_unavailable`・`processEmbedJob` の `embeddingStatus: 'failed'`）のどれにも倒さない——中断と「provider が壊れた」を同じ顔にしないため。
  - **`tick()` は abort されても、どのジョブも `fail()` にしない。** claim 済みのジョブは claim されたまま残り、リースが切れれば次の `tick` が取る。abort までに `complete()` した分の完了は残る。`tick()` 自体は reject する。
  - provider が `signal` を見ない実装であっても、runtime 自身が provider の Promise と abort を競わせるため、呼んだ Runtime の口は返る（`packages/core` 内部の `runAbortable`。公開 API ではない）。
  - **`@mnemora/openai`・`@mnemora/anthropic`**: `opts.signal` を SDK 呼び出しの request options（`{ signal }`）へそのまま渡すようになった。
  - **`@mnemora/local-embedding`**: 推論（`pipeline.embed`）の前後で abort 済みかどうかを確認するだけで、**推論の途中では中断できない**（`@huggingface/transformers` のパイプライン呼び出し自体に中断の口が無いため）。
  - **`@mnemora/testkit` の conformance suite（`describeLLMProviderConformance`/`describeEmbeddingProviderConformance`）には、abort の検査を足していない**——signal を無視する実装を壊す破壊的な必須検査になりうるため見送った（ADR 0359「採らなかった案」）。
- **`@mnemora/local-embedding` の `LocalEmbeddingProvider` に `maxBatchSize?: number`（既定 `DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE` = `128`）を足した**（[Issue #1141](https://github.com/takecchi/mnemora/issues/1141)、[PR #1397](https://github.com/takecchi/mnemora/pull/1397)、[ADR 0358](./docs/decisions/0358-local-embedding-provider-splits-large-batches.md)）——`embed(ctx, texts)` は今まで、受け取った配列を分割せず常に1回で推論しており、件数が増えるほど peak RSS が伸びていた（実測: 128件で630MB・512件で1.7GB、README「良くなること」節）。
  - **既定値以下の件数は、今までどおり1回の推論のまま——ビット単位で変わらない。**mnemora の runtime の本番経路（embed ジョブ・recall のクエリ、`packages/core/src/runtime.ts`・`recall-runtime.ts`）は常に1件ずつ渡すため、この変更の影響を受けない。
  - **128件を超える件数を直接 `embed()` に渡す呼び出しだけ**、先頭から `maxBatchSize` 件ずつに分けて直列に推論し、結果を順番どおりに連結するようになる。分割すると、q8 の量子化特性によりベクトルがわずかに動きうる（ADR 0095 決定5・ADR 0099 追記・ADR 0110 §4——いずれもバッチ不変性を契約から外している既存の決定であり、本項目が新しく持ち込んだ性質ではない）。
  - 既存の CI の門・測定（ADR 0253 の重み指紋の門、Issue #565 の出力ベクトルの指紋測定、`identifier-probes` 等の基準値）はどれも128件を大きく下回る件数でしか `embed()` を呼んでおらず、この変更で値は動かない（確認範囲・根拠は ADR 0358）。
  - 不正な `maxBatchSize`（`NaN`・0以下）は `retry.attempts` と同じ流儀で1に丸め、投げない。非整数は切り捨てて使う。`Infinity` は「分割しない」を表す有効な値として扱う。
  ⭕ 非破壊と数える（新しい省略可能な option を足しただけで、既存の宣言・呼び出しは変わらない。**クローン miku の委譲先の判断であり、オーナーの判断ではない**）。
- **`observe()` の `event.data`・`document.title` を抽出（LLM）へ渡すかどうかを、呼び出し側が選べるようになった**（[Issue #1185](https://github.com/takecchi/mnemora/issues/1185)、[PR #1411](https://github.com/takecchi/mnemora/pull/1411)、[ADR 0369](./docs/decisions/0369-opt-in-extract-event-data-and-document-title.md)。クローン miku の委譲先の判断であり、オーナーの判断ではない）——以前は `event.data`・`document.title` は Observation の `payload` に保存されるだけで、抽出のプロンプトにも LLM 失敗時の全文フォールバックの本文にも入らなかった（PR #1346。この既定は変えていない）。
  - **`ObserveEventInput.extractData?: boolean`・`ObserveDocumentInput.extractTitle?: boolean` を足した（既定 `false`）。** `true` を渡すと、抽出のプロンプトと全文フォールバックの本文の両方に、`data` がキーを1つ以上持つオブジェクトなら `${name}\n\n${JSON.stringify(data)}`、`title` が空でない文字列なら `${title}\n\n${content}` の形で入る。`data` が空・`title` が空なら、`true` を渡しても既定（`name`/`content` だけ）と同じになる。
  - **`false`・省略の呼び出しは、payload・プロンプト・フォールバック本文がバイト単位で今と同じ**——`payload` に `extractData`/`extractTitle` キー自体が増えない。記録済みカセット（`llmCassetteKey`、ADR 0051）の鍵も動かない。
  - **この opt-in は Observation の `payload` に印として永続化されるため、`extract: 'deferred'`・`reextract` でも同じ形で再現される。** `subjectCandidates`/`claimKey`（どちらも `extract: 'deferred'` と同時に渡すと例外になる）とは異なり、`extractData`/`extractTitle` は deferred と同時に指定しても例外にならない。
  - **上限は設けていない**（`content`/`name` が今も上限を持たないのと同じ。詳細は ADR 0369）。
  ⭕ 非破壊と数える（新しい省略可能な欄を足しただけで、既存の宣言・呼び出しは変わらない。既定の振る舞いは1バイトも変えていない）。

### Changed（後方互換だが挙動が変わりうるもの）

- **`@mnemora/core` の `runtime.reextract()` は、利用者の意思で退けた記憶を持つ Observation では、抽出をやり直さなくなった**（[Issue #1079](https://github.com/takecchi/mnemora/issues/1079)・[Issue #1149](https://github.com/takecchi/mnemora/issues/1149)、[PR #1319](https://github.com/takecchi/mnemora/pull/1319)）——以前は退けたことを知らずにやり直し、LLM が言い換えると、forget・purge・訂正で退けた事実が印の無い新しい `active` な Memory として戻っていた。`observe()` の再送が forget・purge した記憶について抽出をやり直さない規律（#897）に揃えた。
  - 退けた記憶として数えるもの（同じ Observation・今の `extractorVersion` の記憶のうち、1件でも在れば）: `forgotten`（purge を含む）、`contested`（利用者の訂正でも claimKey の自動検出でも）、訂正の解決で負けた `superseded`（最新の `superseded` イベントの `meta.reason` が `"contested_resolved"`）。機構（reextract・consolidate）で置き換えた `superseded` と、理由を読めない `superseded`（イベントが無い・保持期間の掃除で消えた）は数えず、今どおりやり直す。
  - やり直さないときは LLM を呼ばず、何も書かない。**`reextract` が `extraction: "skipped"` と `atomicity: "not_attempted"` を返しうるようになった**（`memoryIds: []`、`skipped` には退けた記憶ごとに `status_not_active`）。以前の TSDoc は「`reextract` の `extraction` は `'skipped'` を取らない」と約束していた。
  - `ExtractionOutcome`・`WriteAtomicity`・`ReextractSkip` の型は変わらない（`'skipped'` と `'not_attempted'` は元から在る値）。⟹ 型で exhaustive に分岐している呼び手には影響しない。ただし「`reextract` からは `'skipped'` が来ない」と仮定したコードは見直しが要る。
  ⭕ 非破壊と数える（公開の宣言は変わらず、例外も増えない。作られる記憶が減る側の変化で、「忘れさせた事実が戻らない」という上位の約束を守る側にある。**クローン miku の判断であり、オーナーの判断ではない**）。
- **`@mnemora/testkit/fixtures` は、`EventStore.append` と、イベントを積む `MemoryStore` の口（`updateStatusWithEvent`・`supersedeWithNewMemories`・`markContestedPair`・`resolveContestedPair`・`resolveOrphanedContested` 等）に渡す `actor`・`meta` に、NUL（U+0000）か孤立サロゲート（対をなさない UTF-16 サロゲートコードユニット）を含む文字列（キーも値も、入れ子の中も）が在ると、状態を書き換える前に拒むようになった**（[Issue #1211](https://github.com/takecchi/mnemora/issues/1211)、[PR #1379](https://github.com/takecchi/mnemora/pull/1379)）——以前は書き換えを通し、文字列をそのまま監査ログに残していた。`@mnemora/postgres` は `JSON.stringify(actor)`/`JSON.stringify(meta)` を `::jsonb` に渡す時点で同じ入力を拒んでいた（状態の書き換えとイベントの追記が同じトランザクションにあるので、途中まで書かれたものは残らない）ので、fixture も同じ形（状態を書き換える前に拒み、何も書かない）に揃えた。`Runtime` の口では、`reason`（`meta.reason`/`meta.note` に入る）と `actor.id` に呼び出し側の文字列がそのまま入るため、そこに NUL・孤立サロゲートがあると当たる——`forget` は `{ kind: "failed" }` を返し、`markContested` は例外を投げる（どちらも `@mnemora/postgres` と同じ外へ見える形）。対になったサロゲートペア（絵文字など）・結合文字・U+FFFD・空文字などは、Postgres が受け入れる文字列のまま引き続き通る。
  ⭕ 非破壊と数える（根拠: オーナーの回答、ask_human `3f3411c5`、2026-09-28、回答「(あ) 破壊的とは扱わない」）。
- **`@mnemora/testkit/fixtures` は、同じ `actor`・`meta` を受け取る口（`EventStore.append` と、上の PR #1379 が挙げた `MemoryStore` の各口）に渡す値に BigInt（入れ子・配列の要素も）が在ると、状態を書き換える前に `TypeError`（`Do not know how to serialize a BigInt`）を投げるようになった**（[Issue #1384](https://github.com/takecchi/mnemora/issues/1384)、[PR #1389](https://github.com/takecchi/mnemora/pull/1389)）——以前は書き換えを通し、BigInt をそのまま保持して返していた。`@mnemora/postgres` は `JSON.stringify(actor)`/`JSON.stringify(meta)` が BigInt を渡されると同じ `TypeError`・同じ文言を投げるので、fixture も同じ型・同じ文言に揃えた。**この検査は他のどの検査よりも先に働く**——`@mnemora/postgres` の `EventStore.append` は `INSERT` の引数を全部 JS 側で評価してから問い合わせを送るため、`actor`/`meta` に BigInt があると、`kind` の列挙・`memoryId` の実在・`at` の Invalid Date・NUL/孤立サロゲートの検査を Postgres 自身が行う機会が無いまま `TypeError` になる（実測: `kind` 不正・`at` Invalid Date・`memoryId` 実在しない、のそれぞれと BigInt を同時に渡し、いずれも同じ `TypeError` になることを確認した）。fixture 側もこの優先順位に合わせている。number（`123`）・数字に見える文字列（`"123n"`）は引き続き通る（陽性対照）。
  ⭕ 非破壊と数える（根拠: オーナーの回答、ask_human `3f3411c5`、2026-09-28、回答「(あ) 破壊的とは扱わない」——PR #1379 と同じ根拠）。
- **抽出（`subjectCandidates` を渡す呼び出しに限る）・`consolidate`・`reflect` の system プロンプトに、出力言語と話者取り違えの指示を足した**（[Issue #1370](https://github.com/takecchi/mnemora/issues/1370)、[PR #1374](https://github.com/takecchi/mnemora/pull/1374)、オーナーの求めによる対応）——観測が日本語なのに記憶の本文・要旨の一部が英語になる、話者自身の発言が別の人物（利用者など）の発言・意見として記録される、の2件への対応。
  - **適用条件**: `buildExtractionPrompt` の2文（言語・話者）は、`subjectCandidates` を渡した呼び出しにだけ足す（`extractionContext` を同時に渡す場合も含む）。`extractionContext` だけを渡す呼び出し・どちらも渡さない呼び出し（デフォルト経路）には**足さない**——`EXTRACTION_PROMPT_SYSTEM_BASE` 自体にも `extractionContext` 分岐にも1バイトも触れていない。理由: どちらかの文面を変えると、記録済みカセット（`examples/chat/cassettes/`、ADR 0051 の `llmCassetteKey`）と Issue #704 の評価用録音の鍵が動き、録り直しが要る。`consolidate`・`reflect` の system プロンプトには、この条件を付けず無条件で言語の一文を足す（録音の鍵に使われていないため）。
  - **デフォルト経路（`subjectCandidates` を渡さない抽出呼び出し）へ同じ指示を広げるかは未決——オーナーの判断待ち**（[ADR 0348](./docs/decisions/0348-extraction-language-and-speaker-instruction-gated-on-subject-candidates.md)）。広げれば上の録音がすべて動く。
  - 抽出（条件に当たる呼び出し）・`consolidate`・`reflect` の結果（LLM に送る文面と、それに応じた出力）が変わりうる。**`RuntimeConfig.promptVersion` を上げることを勧める**（TSDoc の「抽出プロンプトを変えたら上げる」どおり）。
  - **実測**（90件の合成日本語対話・`subjectCandidates: ["user","character"]`・`extractionContext` 無し・`gpt-5.4-mini` 実 API、before/after 各3 run、90×2×3=540 回の抽出。詳細・判定方法は ADR 0348）: この条件下で、話者取り違え（構造的信号——候補の `subjectId` が実際の話者と逆）は character 発話由来のうち **46/176（26.1%、Wilson 95% CI 20.2–33.1%）→ 0/168（CI 上限 2.2%）**——CI が重ならず明確な差。**英語混入（content/digest のラテン文字比率ルールで判定）は、件数が少なく（before 1/318・3/316）、before/after の 95% CI が重なるため、差は主張できない。**
  ⚠ **上の構造的信号は `subjectCandidates` を渡す呼び出しに限った指標であり（`subjectId` はそのときしか返らない）、デフォルト経路の取り違え発生率・改善効果については何も示していない。**
  ⭕ 非破壊と数える（公開の宣言・型は変わらず、例外も増えない。変わるのは LLM に送る system の文面と、それに応じて LLM が返す本文・要旨だけである）。
- **`@mnemora/postgres` の `createPostgresClient` は、pool の中で待機中の接続が DB 側から切られても（Postgres の再起動・フェイルオーバー・運用者の手動切断など）、既定でプロセスごと落ちなくなった**（[Issue #1213](https://github.com/takecchi/mnemora/issues/1213)、[PR #1395](https://github.com/takecchi/mnemora/pull/1395)、[ADR 0356](./docs/decisions/0356-pool-default-error-listener-warns-by-default.md)）——以前（`[1.1.0]` 節 Fixed の PR #1378 の項目、当時は Issue #1213 を「未決のまま」としていた）は `Pool` に `error` リスナーを一切付けず、利用者が `client.pool.on("error", …)` を付けることが前提だった。いまは `createPostgresClient` が常にリスナーを1つ付け、既定では `console.warn`（固定の接頭辞 `[@mnemora/postgres]`）で名乗って続行する——切れた接続は pool から捨てられ、次の呼び出しは新しい接続で通る。
  - **`createPostgresClient` の設定に任意の欄 `onPoolError?: (error: Error) => void` を足した。** 渡せばそれだけが呼ばれ、既定の警告は出ない。渡さなくても、利用者が自分で `client.pool.on("error", …)` を付けていれば（`createPostgresClient` の呼び出しより先でも後でも）既定の警告は出ない——二重に名乗らない。
  - **ADR 0339・ADR 0020 が却下したのは「黙って捨てる」形（空のリスナー）であり、本項目の既定の振る舞い（名乗って続行する）はその却下理由に当たらない**（詳細・区別は ADR 0356）。
  - **非破壊である根拠**: `docs/migration-v1.md`「破壊的変更」の定義（公開の型の削除・必須化・狭小化）に照らすと、公開の型（`createPostgresClient` の設定）に増えたのは任意の欄 `onPoolError?` 1つだけで、既存の呼び出しは1行も直さずに通る。実行時の振る舞いが変わる側面（プロセスが落ちなくなる・既定で `console.warn` が増える）は、Issue #859・#868（同節 Fixed）と同じ並びで ⭕ 非破壊と数える——例外を投げる／プロセスが落ちる入力が減る側にだけ変わり、既存の正常系の結果は変わらない（クローン miku の委譲先の判断であり、オーナーの判断ではない）。
- **`@mnemora/core` に `MemoryStore.purgeExpiredEventsByRetention?`（任意メソッド）・
  `PurgeExpiredEventsByRetentionOptions`・`PurgeExpiredEventsByRetentionOutcome`・
  `computeEventRetentionCutoff(now, days)` を足した**（[Issue #1232](https://github.com/takecchi/mnemora/issues/1232)、
  [PR #1393](https://github.com/takecchi/mnemora/pull/1393)、
  [ADR 0354](./docs/decisions/0354-atomic-event-retention-purge.md)）——保持期間を読むことと
  実際に削除することを1つの原子的な操作にする新しい口（上の `### Breaking` の項目参照）。
  `@mnemora/postgres`（`PostgresMemoryStore`）・`@mnemora/testkit/fixtures`
  （`InMemoryMemoryStore`）はこの口を実装済み。`InMemoryTenantSettingsStore` のコンストラクタに
  省略可能な第3引数 `eventRetentionDaysBacking?: Map<string, number | null>` が増えた
  ——既存の末尾に足した省略可能な引数で、0〜2引数の既存の呼び出しは1行も直さず通る非破壊の変更
  （`InMemoryMemoryStore.eventRetentionDays` と共有する場合に渡す。ADR 0165 決めたこと13の
  `subjectActivitySeqBacking?` と同じ形）。
- **`@mnemora/local-embedding` の `LocalEmbeddingProvider` に `revision` を渡すと、キャッシュの置き場所が `<根>/<encodeURIComponent(revision)>/<repo>/<file>` に変わり、温めたキャッシュだけでオフラインで読めるようになった**（[Issue #1403](https://github.com/takecchi/mnemora/issues/1403)、[PR #1404](https://github.com/takecchi/mnemora/pull/1404)、[ADR 0365](./docs/decisions/0365-local-embedding-revision-in-remote-path-template.md)）——以前は `revision` を transformers.js の `pipeline()` にそのまま渡しており、置き場所は `<根>/<repo>/<revision>/<file>` だった。読み込みの前段の確認は `revision` を運ばず `main` の鍵を探すので、温めていても `resolve/main/config.json` へ出て、ネットワークが無いと読めなかった（Issue #1239 の直し方も、ここには届いていなかった）。いまは既定の `createPipeline` が、`revision` を `pipeline()` に渡さず、`pipeline()` を呼んでいる間だけ `env.remotePathTemplate` に埋め込み、キャッシュの根を revision ごとに分ける（成功でも失敗でも元へ戻す）。根は `cacheDir` を渡していればそれ、渡していなければ既定のキャッシュで、`cacheDir` の有無で振る舞いは分かれない。ネットワークがあるときに、前段の確認が `main` の `config.json` を見ることもなくなった。`revision` を渡さない使い方は変わらない。
  - ⚠ **`revision` を渡している人は、既存のキャッシュが1回外れて、モデル一式（約42MB）を取り直す。**古い置き場所（`<根>/<repo>/<revision>/`）は自動では消さない。
  - ⚠ **ネットワークがない場所では、先に新しい根へ温め直す必要がある**（`revision` を渡して一度読み込めばよい）。
  - ⚠ `env.remotePathTemplate` も `env.cacheDir` と同じくプロセス全体で共有される大域であり、このパッケージを経由しない transformers.js の利用が差し替えの最中に読み込むと、差し替え後の値を見うる（README・ADR 0365）。
  ⭕ 非破壊と数える（⚠ 付き。公開の型も API も変わらない。取り直しは1回で済み、ネットワークがあれば自然に直る。**クローン miku の判断であり、オーナーの判断ではない**）。

### Fixed

- **`@mnemora/openai`・`@mnemora/anthropic` の `completeStructured` は、利用者が渡す zod スキーマのうち送れない形（`z.record`・`z.tuple`・`z.date`・`transform`）を、provider ごとに違う形で・違う時点で落としていた**（[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)、[PR #1399](https://github.com/takecchi/mnemora/pull/1399)、[ADR 0360](./docs/decisions/0360-schema-unsupported-thrown-before-send.md)）——`@mnemora/openai` は送ってからベンダーに拒ませ（HTTP 400、`kind` の外）、`@mnemora/anthropic` は送る前に落ちるが素の `Error`（`kind` の外）だった。いまはどちらの provider も、`chat.completions.create`/`messages.create` を呼ぶ前に、送れない形を検査して `OpenAILLMProviderError`/`AnthropicLLMProviderError` の新しい `kind: "schema_unsupported"` で落とす。元の例外は `cause`（ES2022 の `Error.cause`）に載る。`@mnemora/openai` は zod 自身の既定（throw）と、`openai` SDK 自身の strict 変換 `toStrictJsonSchema` を実際に送る JSON Schema に通す検査（戻り値は使わず、送るのは今までどおり mnemora 自身の翻訳結果）の両方で捕まえる。core が渡す4つのスキーマ（抽出・claim key・統合・内省）が送る JSON は1バイトも変わらない（実測済み）。ネットワーク失敗・応答側の失敗（`ZodError` 等）・拒否/切り詰め/空応答（`kind: "refusal"`/`"truncated"`/`"no_content"`）の扱いは変えていない。`z.lazy`・`default`・根が union の包み（PR #1147）・Anthropic 側の `z.record`（翻訳自体は失敗しないため対象外）は今までどおり通る。
  ⭕ 非破壊と数える（`OpenAILLMFailureKind`/`AnthropicLLMFailureKind` という公開の union に値を1つ足しただけ——union に値を足す変更は破壊的変更として数えない、オーナーの回答（ask_human `d9364c91`）、`docs/migration-v1.md`「数え方の規律への追記（2026-09-28）」。`*ProviderErrorOptions` に足した `cause?: unknown` も省略可能な追加のみ）。
- **`@mnemora/postgres` と `@mnemora/testkit/fixtures` の `OutboxStore.claimBatch` は、終端に達しないまま止まり続ける job（毎回ワーカーを止めてしまう job）が `limit` 本以上あると、リースが切れるたびに古い順の先頭で同じ job を取り続け、後ろの job に永久に届かなかった（先頭詰まり）**（[Issue #1196](https://github.com/takecchi/mnemora/issues/1196)、[PR #1396](https://github.com/takecchi/mnemora/pull/1396)、[ADR 0357](./docs/decisions/0357-outbox-reclaim-requeues-to-tail.md)）——取る順（`available_at` の古い順）はそのままに、**取り直し**（claim 時点で `claimed_at` が既に非 NULL＝リースが切れた行を再び claim する場合）だけ `available_at` を `opts.now` へ書き直すようにした。初めての claim では `available_at` を変えない。止まり続ける job が何本あっても、後ろの job はいつか claim される（飢餓しない）。
  - **取り直された job は、先頭で2回 claim されてから後ろへ回る**（1回目は初めての claim なので `available_at` を動かさず、2回目＝最初の取り直しで初めて `now` へ進む）——正直に書くとゼロ回で後ろへ回るわけではない。
  - **`OutboxStore` を自作している第三者実装者への影響**: 契約 doc（`packages/core/src/interfaces/outbox-store.ts`）の記述が増えた。型（`ClaimOutboxJobsOptions`・`OutboxJobRecord`・`OutboxStore` のシグネチャ）は1バイトも変わっていない（`pnpm run api:check` で確認済み）ため独自実装のコンパイルは通り続けるが、この契約（取り直しで `available_at` を進める）を満たさない実装は、今後もこの先頭詰まりを起こしうる。
  - **観測できる値の変化**: `claimBatch` が返す `OutboxJobRecord.availableAt` は、取り直された job では呼び出し時の `now` になる（以前は積んだときの値のまま不変だった）。
  - 上限（`attempts` が N を超えたら `fail` にする等）で終端にする設計は入れていない（ADR 0032「これが覆るとしたら」が範囲外として残した論点のまま、Issue #1196 が挙げた「決めていないこと」のうち今回答えたのは「後回しにする」の1点だけ）。`TickResult` に「この tick で取り直した件数」を出す観測の追加は見送った——理由は ADR 0357「引き受けた負債」参照。
  ⭕ 非破壊と数える（型は変わらず、例外の増減もない。変わるのは `available_at` の観測値と、リース切れの繰り返しに対する取る順の実質的な帰結だけである。**クローン miku の判断であり、オーナーの判断ではない**）。
- **`Runtime`（`@mnemora/core`）は、`RuntimeDeps.clock` に注入した時計を、監査ログ（`memory_events.at`）・
  `purgedAt`・recall の記録の `createdAt`・outbox の `availableAt`/`createdAt`/`completedAt`/`failedAt`
  には渡していなかった**（[Issue #1237](https://github.com/takecchi/mnemora/issues/1237)「案1」、
  [PR #1394](https://github.com/takecchi/mnemora/pull/1394)、
  [ADR 0355](./docs/decisions/0355-inject-clock-into-store-writes.md)）——これらは store が
  書き込みのときに埋める壁時計（`new Date()`/`now()`）のままだった。**壁時計より過去の時計を
  注入すると、`tick()` は積んだジョブを1本も取れなかった**（`available_at` が壁時計、claim は
  `available_at <= now`＝注入した時計のジョブしか取らないため。`processed: 0` で、何も名乗らない）
  ——過去の会話を当時の時刻で取り込み直す用途や、固定時刻でのテストで、extract・embed が
  一切走らなかった。いまは `Runtime` が書き込むすべての口に `clock.now()`（`sweepArchive` は
  呼び出し側が渡す `opts.now`）を渡すので、注入した時計が壁時計より過去でも `tick()` はジョブを
  取れる。新しい欄（上の `### Breaking` の項目）は全部省略可能——`opts`/`createdAt` を渡さない
  呼び出しは今までどおり壁時計になる。
  ⭕ 非破壊と数える（型は追加のみ。既存の呼び出し（`Runtime` 経由・store を直接呼ぶ経路の
  どちらも）は、今までと同じ壁時計の値を書き続ける。変わるのは `Runtime` 自身が渡す値だけである）。
- **`@mnemora/postgres` のストアが `db.transaction()` を実行している最中に DB の接続が切れると（DB の再起動・フェイルオーバー・`pg_terminate_backend` など）、呼び出しが reject するだけで済まずに、Node のプロセスごと `Error: Connection terminated unexpectedly` の uncaught exception で落ちていた**（[Issue #868](https://github.com/takecchi/mnemora/issues/868)、[PR #1378](https://github.com/takecchi/mnemora/pull/1378)、ADR 0349）——drizzle-orm の `db.transaction()` は pool から借りた接続に `error` リスナーを付けず、pg-pool は貸し出す直前に自分のリスナーを外すため、トランザクションの最中はリスナーが1つも無かった。`MemoryStore`・`VectorStore`・語彙ストアの、トランザクションを張るすべての口が当たっていた。いまは `createPostgresClient` が drizzle に、`connect` だけを包んだ `Proxy` を渡し、借りた接続に何もしない `error` リスナーを付けて、返すときに外す。切れた呼び出しは今までどおり reject し、次の呼び出しは新しい接続で通る。直し方（Proxy で包む）は**オーナーの回答（ask_human 7844da4c）**である。
  - **振る舞いが1つ変わる: `client.db.$client === client.pool` が `true` から `false` になる。**`$client` は drizzle が実行時に生やす欄で、公開の型 `Db` には載っていないため、型（`.d.ts`）は変わらない。`client.db.$client` の `instanceof Pool`・`totalCount`・`on`・`end()` などは、今までどおり本物の `client.pool` に届く。
  - **公開する `client.pool` は書き換えない。**利用者が `client.pool.connect()` で借りた接続にはリスナーは付かず、待機中の接続が切れたときに備えて `client.pool.on("error", …)` を付けるのは今までどおり利用者である（[Issue #1213](https://github.com/takecchi/mnemora/issues/1213) は未決のまま）。
  ⭕ 非破壊と数える（プロセスが落ちなくなる側の修正で、公開の型は変わらない。変わるのは上の `db.$client` の同一性だけである）。
- **`Runtime.observe()`（同期の抽出）と `tick()` の `extract` のジョブは、LLM の抽出結果に store が保存できない候補（本文の NUL など。`@mnemora/postgres` の tsvector の上限を超える本文も当たったが、下の Issue #1222 の項で保存できるようになった）が在ると、手前の候補だけを書いたまま例外で止まっていた**（[Issue #1063](https://github.com/takecchi/mnemora/issues/1063)、[PR #1318](https://github.com/takecchi/mnemora/pull/1318)、[ADR 0347](./docs/decisions/0347-extract-write-path-redelivery-and-unsaveable-candidates.md)）——候補は1件ずつ書かれ、1つのトランザクションではない。いまはその候補だけを落とし、残りの候補は書いて、投げない。落とした候補は、残った候補の `created` イベントの `meta.droppedCandidates`（`index`・`contentHash`・最も内側の原因の `code`・`message`。本文は写さない）に残り、`observe()` の戻り値には出ない。全件が保存できなければ、今どおり最初の例外を投げ、何も書かない。候補は全件を書いてから `created` を積む順になった。
  ⭕ 非破壊と数える（例外を投げる入力は減る側にだけ変わる。結果が変わるのは保存できない候補を含む抽出結果のときだけで、正常な入力の結果と `created` の `meta` の形は変わらない。公開の型も変わらない。根拠: `observe-unsaveable-candidate.postgres.test.ts` の歯を、`@mnemora/postgres` と testkit の fixture の2実装で先に赤にしてから緑にした。クローン miku の判断であり、オーナーの判断ではない）。
- **`tick()` の `extract` のジョブは、1回目が Memory を書いた後・`complete` の前に止まり、リースが切れて逐次に再配達されると、LLM の出力が変われば2回分の Memory を両方 `active` で残していた**（[Issue #1092](https://github.com/takecchi/mnemora/issues/1092)、[PR #1318](https://github.com/takecchi/mnemora/pull/1318)、[ADR 0347](./docs/decisions/0347-extract-write-path-redelivery-and-unsaveable-candidates.md)）——違う本文なら2件、1回目の LLM が落ちていれば全文フォールバックと候補の2件。いまは LLM を呼ぶ前に、その Observation から今の抽出器の版で作られた Memory（status を問わない）が在るかを見て、在れば何も書かずにジョブを完了にする（再配達のたびに LLM を呼ぶこともなくなる）。旧い版の Memory しか無ければ今どおり抽出する。`Runtime.reextract` と同期の `observe()` は、この確認を通らない。⚠ 並行の2本は塞げない。1回目が候補の一部だけを書いて止まった場合、残りの候補は作られなくなった（`reextract` で回復する）。
  ⭕ 非破壊と数える（例外を投げる入力は変わらない。結果が変わるのは同じジョブの再配達のときだけで、1回目の配達の結果は変わらない。公開の型も変わらない。根拠: `tick-sequential-redelivery.postgres.test.ts` の歯を、2実装で先に赤にしてから緑にした。クローン miku の判断であり、オーナーの判断ではない）。
- **`@mnemora/postgres` の `aggregateScope()` は、`digestBand.excludeMemoryIds` に uuid の形をしていない id（空文字を含む）が混ざると、`invalid input syntax for type uuid` の DB の例外を投げていた**（[Issue #1262](https://github.com/takecchi/mnemora/issues/1262)、[PR #1289](https://github.com/takecchi/mnemora/pull/1289)）——除外の id をそのまま `::uuid[]` に渡していた。`get`・`getMany` など、ほかの読みの口の「形の崩れた id は無いもの」の扱い（`restoreSuperseded` の `onlyMemoryIds` を揃えた PR #1195 と同じ線）に揃え、形式不正な id は除外の対象から外すだけにした（ほかの id の除外はそのまま効く。`@mnemora/testkit/fixtures` の InMemory は、もともとそう返していた）。`Runtime.recall` は実在する id だけを渡すので、この形になるのは `aggregateScope` を直接呼ぶ経路だけである。
  ⭕ 非破壊と数える（例外を投げなくなる側の修正で、形の正しい id の結果は変わらない。クローン miku の判断であり、オーナーの判断ではない）。
- **`@mnemora/postgres` の `PostgresVectorStore.searchMany()` は、`queries` の `key` に NUL（U+0000）を含む文字列が在ると、DB の例外を投げていた**（[Issue #1285](https://github.com/takecchi/mnemora/issues/1285)、[PR #1299](https://github.com/takecchi/mnemora/pull/1299)）——key を `text` のパラメータとして SQL に送っていたので、Postgres が NUL を拒んでいた。同じベクトルの `search()` は投げない。key を SQL に送らず、`queries` の添字を送って、戻ってから key に引き直すようにした。`VectorStore.searchMany?` の TSDoc に「`search()` が投げない入力では `searchMany` も投げない」を書いた。`Runtime` の段3.5 は key にアンカーの `memoryId` を使うので、この差が出ていたのは `VectorStore` を直接呼ぶ経路だけである。同じ key が2回以上あるときの振る舞い（[Issue #1284](https://github.com/takecchi/mnemora/issues/1284)、未決）は変えていない。
  ⭕ 非破壊と数える（例外を投げなくなる側の修正で、NUL を含まない key の結果は変わらない。公開の型も変わらない。クローン miku の判断であり、オーナーの判断ではない）。
- **`@mnemora/postgres` の `PostgresVectorStore.searchMany()` は、`queries` に同じ `key` が2回以上あると、その key のクエリすべての結果を1つの配列に続けて積み、`limit` を超えうる結果を返していた**（[Issue #1284](https://github.com/takecchi/mnemora/issues/1284)、[PR #1308](https://github.com/takecchi/mnemora/pull/1308)）——同じ key では最後のクエリの結果だけを返し、`Map` の並びをその key が最初に現れた位置にした（`new Map(queries.map((q) => [q.key, search(q)]))` と同じ）。`VectorStore.searchMany?` の TSDoc にこの契約を書いた。`Runtime` の段3.5 は key にアンカーの `memoryId` を使うので同じ key を渡さず、この差が出るのは `VectorStore` を直接呼ぶ経路だけである。⭕ 非破壊と数える（投げる入力は減る側にしか変わらない——同じ key のうち前のクエリは SQL に送らなくなったので、前のクエリのベクトルだけが DB に拒まれる値（float4 の範囲を超える有限の値。例: `1e39`）だった入力は、以前は投げ、今は投げない。NaN・Infinity・次元違いは以前から比較不能として扱い、投げない。ほかは、同じ key を含む入力の結果だけが変わる。同じ key を含まない入力の結果は変わらない。公開の型も変わらない。クローン miku の委譲先の判断であり、オーナーの判断ではない）。
- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` は、いくつかの口で、書き始めた後に投げて、書いた分を残していた**（[PR #1231](https://github.com/takecchi/mnemora/pull/1231)）——Postgres は1トランザクションで巻き戻るので何も残らない。`supersedeWithNewMemories` は `news` の2件目以降が書けない（本文に NUL・元の Observation が無い など）と、先に作った Memory・outbox・ラベルを残していた。`updateStatusWithEvent`・`supersedeWithNewMemories`・`markContestedPair`・`resolveContestedPair`・`resolveOrphanedContested`・`purgeMemory` は、イベントの `meta`・`actor` が `structuredClone` できない（関数・Symbol を含む）と、状態を書き換えた後に `DataCloneError` を投げていた。`restoreSupersededBy` は `at` が Invalid Date か `actor` が写せないと、1件目だけを戻してイベントを残さずに投げていた。いまはどれも書く前に投げる（または、書いた分を取り消してから投げる）。
  ⭕ 非破壊と数える（投げる入力は変わらない——今まで投げた入力で今までどおり投げ、状態が呼ぶ前のまま残るだけである。今まで投げなかった入力では投げない。クローン miku の判断であり、オーナーの判断ではない）。
- **`@mnemora/postgres` の `runMigrations()`（と `mnemora-postgres-migrate`）は、advisory lock を持つ接続だけが切れると、ロックの無いまま適用を続け、別の実行と重なりえた**（[Issue #1212](https://github.com/takecchi/mnemora/issues/1212)、[PR #1220](https://github.com/takecchi/mnemora/pull/1220)）——ロックは専用の接続で持ち、ファイルの本体は別の接続で流していたので、ロックの接続が DB 側の切断・フェイルオーバーなどで切れてサーバーがロックを手放しても、本体は流れ続けてコミットされ、その間に始まった別の実行が同じ migration を同時に流しえた（ADR 0017 の「ロックで直列化する」から外れていた）。いまはロックの下で流すものをすべてロックを持つ接続そのもので流すので、ロックの接続が切れると当てている途中のファイルも一緒に止まって巻き戻り、`migration <file> failed: ...` として報告される（最後のロックの返却の失敗では上書きしない）。ロックを待つための `lock_timeout` は本体には効かせない（今までどおり）。`runMigrations` が使う接続は2本から1本になる。
  ⭕ 非破壊と数える（公開型は変わらない。ロックの接続が切れた場合だけ、コミットされていた途中のファイルが巻き戻り、失敗の文言が `migration <file> failed: ...` になる。クローン miku の判断であり、オーナーの判断ではない）。
- **`@mnemora/postgres` の `runMigrations()`（と `mnemora-postgres-migrate`）は、既定の `extensionMode: "create"` で拡張を作る権限の無いロールが流すと、`migration 0001_init.sql failed: permission denied to create extension "vector"` とだけ言い、どうすればよいかを言わなかった**（[Issue #1212](https://github.com/takecchi/mnemora/issues/1212)、[PR #1310](https://github.com/takecchi/mnemora/pull/1310)）——いまは `CREATE EXTENSION` が権限不足で失敗したとき（pg のエラーの `code` が `42501`、`routine` が `execute_extension_script`）だけ、文言の次の行に「DBA 側で拡張を作ってから `extensionMode: "verify"`（CLI では `--extension-mode verify`）で流す」案内を足す。
  ⭕ 非破壊と数える（例外の種類・投げる入力・文言の先頭は変わらず、権限不足のときに文言の後ろが増えるだけである。クローン miku の判断であり、オーナーの判断ではない）。
- **`@mnemora/postgres` の `restoreSuperseded()`（`dryRun` を含む）は、`onlyMemoryIds` に uuid の形をしていない id が混ざると、`invalid input syntax for type uuid` の例外を投げていた**（[PR #1195](https://github.com/takecchi/mnemora/pull/1195)）——`PostgresMemoryStore.restoreSupersededBy`・`previewRestoreSupersededBy` が `onlyMemoryIds` をそのまま `::uuid[]` に渡していた。`supersededById` の形式不正は例外にしない（`Runtime.restoreSuperseded` の doc）、`getMany` は形式不正な id を無いものとして扱う、と同じ規律に揃え、形式不正な id は群に居ないのと同じに扱う（`@mnemora/testkit/fixtures` の InMemory は、もともとそう返していた）。
  ⭕ 非破壊と数える（例外を投げなくなる側の修正で、形の正しい id の結果は変わらない。クローン miku の判断であり、オーナーの判断ではない）。
- **`@mnemora/postgres` の語彙チャンネルは、クエリの語の途中の `"` を詰めて取り除いていたので、本文と同じ文字列で探しても当たらなかった**——`x"y` は1語 `xy` になり、本文側（`x` と `y` に分ける）と噛み合わず、0件だった（testkit の `InMemoryLexicalStore` は一致する）。`PostgresTrigramLexicalStore` の ASCII 側も同じ関数を使うので同じだった。`mnemora_lexical_query_tsqueries` の `"` を空白に置き換えた（語の端の `"` は今までどおり。[PR #1187](https://github.com/takecchi/mnemora/pull/1187)）。**新しい migration が1本増える**（`0023_lexical_query_inner_quote_as_space.sql`、関数を `CREATE OR REPLACE FUNCTION` で置き換えるだけで、索引は作り直さない）——利用者は `mnemora-postgres-migrate`（または `runMigrations`）を打つこと。
  ⚠ 例外を投げず、語彙チャンネルの一致だけが変わる修正であり、非破壊と数える（クローン miku の判断、上の前書き）。
- **`TenantSettingsStore.setEventRetention` は、型の外の `kind`（`{ kind: "bogus" }` や綴りの誤り `{ kind: "Days", days: 30 }` など）を、例外にせずに保持期間を無期限（`event_retention_days = NULL`）として書いていた**（[Issue #1168](https://github.com/takecchi/mnemora/issues/1168)）——`@mnemora/postgres` と `@mnemora/testkit/fixtures` の両方で同じ。短くしたつもりの呼び出しが、黙って「消さない」に倒れていた。`kind` が `"unlimited"`・`"days"` のどちらでもなければ、`EVENT_RETENTION_KIND_INVALID_MESSAGE` を含む `Error` を投げ、何も書かない（[PR #1171](https://github.com/takecchi/mnemora/pull/1171)。`assertValidEventRetentionKind`、上の Added。`setDecayClock`・`setTaxonomyMode` が型の外の文字列を実行時に拒むのと同じ形）。
  ⚠ 新しく例外を投げるが、型の外の `kind` は一度も意図どおりに動いたことの無い入力であり、それを本物の adapter が早めに拒むものなので、非破壊と数える（#1080・#1099・#1156 と同じ扱い。**クローン miku の判断であり、オーナーの判断ではない**）。testkit の fixture も新しく投げるが、core の共有の検査で Postgres と同時に変わるので、問い `3f3411c5` の保留には入れず、この項目1つで数える。
- **`@mnemora/testkit/fixtures` の `InMemoryTenantSettingsStore` は、半減期の2つの口で、Postgres の `real`（float4）列が拒む値を受け付けていた**——`setDefaultHalfLifeRecalls` は float4 で 0 に丸まる値（例: `1e-46`）を、fixture だけの口 `setDefaultHalfLifeHours` は float4 で溢れる値（`1e39`・`Number.MAX_VALUE`）と 0 に丸まる値を受け付けて、そのまま返していた（Postgres は `"…" is out of range for type real` や CHECK で拒む）。`createMemory` の `halfLifeHours`（PR #1095）と同じく「`Math.fround(x)` が `Infinity` か 0 になるか」で拒む。非正規数に収まる値（`1e-40`）は受け付ける（[PR #1165](https://github.com/takecchi/mnemora/pull/1165)）。
  ⚠ 公開の fixture が不正な入力に新しく例外を投げるが、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。上の前書きの「保留と非破壊の数え方」を参照）。
- **`@mnemora/openai` の `OpenAILLMProvider.completeStructured` は、根が object でないスキーマ（core の `ReflectionLLMResultSchema` のような判別可能ユニオン）を、OpenAI の strict な Structured Outputs が受け付けない形で送っていた**——根が `oneOf` のままで、`openai` SDK 自身の strict 変換（`toStrictJsonSchema`）は `Root schema must have type: 'object'` で拒み、実 API も HTTP 400（`'oneOf' is not permitted`）で拒んだ。⟹ `runtime.reflect()` を OpenAI の provider で呼ぶと、毎回 `llm_failed` になっていた。根が object でないスキーマは1つの欄 `result` を持つ object に包んで送り、返った値をその欄から取り出してから検査する。あわせて `oneOf` を `anyOf` にする（SDK が「strict は `oneOf` を受け付けない」とする。[PR #1147](https://github.com/takecchi/mnemora/pull/1147)）。根が object のスキーマは、送る形も読む形も変わらない（`translateForOpenAIStructuredOutput` の返り値も同じ）。
  ⚠ 例外を新しく投げず、根が object でないスキーマの送る形・読む形だけが変わる修正であり、非破壊と数える（クローン miku の判断、上の前書き）。偽の `client` で、根が union のスキーマに包まない JSON を返していたテストは、`ZodError` になる。
- **`InMemoryMemoryStore.listActiveClaimPredicates`（`@mnemora/testkit` の擬似 `MemoryStore`）は、`query.limit` に負数・`NaN`・`Infinity`・非整数・bigint に収まらない値（2^63 以上）を渡されると例外を投げず、`slice(0, limit)` の丸めに従って違う件数を返していた**（[PR #1157](https://github.com/takecchi/mnemora/pull/1157)）（実測: 述語3つで `-1` は2件、`1.5` は1件、`NaN` は0件）——`PostgresMemoryStore.listActiveClaimPredicates` は生 SQL の `LIMIT`（bigint パラメータ）でこれらを拒む。`requeueEmbedJobs`（PR #1058）ほかと同じく、クエリの前に弾く Postgres 側に揃えた（正常系の挙動は変えていない）。
  ⚠ 公開の fixture が不正な入力に新しく例外を投げるが、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。上の前書きの「保留と非破壊の数え方」を参照）。
- **`recall()` の `omitted` の `ann_truncated.assumptions` に出る `strength <= 1` の前提の文言が、「型（number）も DB 列（real）も保証していない」のままだった**（[PR #1152](https://github.com/takecchi/mnemora/pull/1152)）——ADR 0078 の後、同梱の実装（Postgres の CHECK 制約、testkit の fixture と core の Fake の書き込み時の検査）は値域 `(0, 1]` を守っている。文言を実態に合わせた（前提であることは変えていない。[ADR 0069](./docs/decisions/0069-ann-truncated-says-nothing-about-loss.md) の追記）。
  ⚠ 返り値の説明の文字列だけが変わる修正であり、非破壊と数える（クローン miku の判断、上の前書き）。
- **`runtime.consolidate()` / `runtime.reflect()` の `{ seedMemoryId }` 形は、種が forget・purge された記憶でも、その `digest` を検索語にして近傍を集め、近傍どうしを統合・内省していた**（自動 job の `tick()` 経由も同じ。[Issue #1136](https://github.com/takecchi/mnemora/issues/1136)、[PR #1145](https://github.com/takecchi/mnemora/pull/1145)）——利用者が「使わないでほしい」と言った記憶が、束ねる相手を決め続けていた。種が forget・purge された記憶なら近傍を集めず、種1件だけを見て `nothing_to_consolidate`/`no_eligible_sources`（reflect は `nothing_to_reflect`/`no_eligible_basis`）を返す。種が `contested` / `superseded` の場合は今どおり近傍を集める。
  ⚠ 例外を投げず、結果だけが変わる修正であり、非破壊と数える（クローン miku の判断、上の前書き）。
- **`@mnemora/local-embedding` のモデルの読み込みに失敗したときのメッセージが、キャッシュのファイルの破損に届いていなかった**——キャッシュのファイルが壊れていると（取得の中断など）、再試行を使い切っても、次のプロセスでも同じように落ち続けるのに、メッセージはネットワーク断・repo の消滅・dtype 名の誤りしか挙げず、`cacheDir` を省いたときは「既定の場所」としか言わなかった。キャッシュの破損を原因の候補に挙げ、消せば次の読み込みで取り直す場所（`<cacheDir>/<repo>`、省いたときは `node_modules/@huggingface/transformers/.cache/<repo>`）を名指す（[PR #1134](https://github.com/takecchi/mnemora/pull/1134)）。
  ⚠ 例外の種類も投げる条件も変えず、メッセージの文面だけが変わる修正であり、非破壊と数える（クローン miku の判断、上の前書き）。
- **`@mnemora/local-embedding` のモデルの読み込みに失敗したときのメッセージは、`cacheDir` を省いたときの置き場所を、npm の配置（`node_modules/@huggingface/transformers/.cache/`）で決め打ちに名指していた**——pnpm で入れた利用者の実際の場所は `node_modules/.pnpm/@huggingface+transformers@<版>/node_modules/@huggingface/transformers/.cache/` であり、メッセージは無い場所を「消せば次の読み込みで取り直す」と指していた（2026-09-27、`pnpm pack` した tarball を repo の外の pnpm のプロジェクトに入れて見つけた。PR #1218 の README の実測、[PR #1223](https://github.com/takecchi/mnemora/pull/1223)）。既定の `createPipeline` のときは、transformers.js が解決した `env.cacheDir`（絶対パス）を名指す。`createPipeline` を注入したとき・`env.cacheDir` が読めないときは、特定の場所を断言せず「transformers.js の `env.cacheDir`（実際の場所はパッケージマネージャの配置による）」と言う。`cacheDir` を渡したときは今までどおり。
  ⚠ 例外の種類・`kind`・投げる条件と公開の型は変えず、メッセージの文面だけが変わる修正であり、非破壊と数える（クローン miku の判断、上の前書き）。
- **`@mnemora/postgres` の `PostgresMemoryStore.purgeExpiredEvents` は、同時に走った掃除が同じ行を選ぶと、後の側が実際には消していない行まで `purged` と `events_purged` の `meta.purgedCount` に数えていた**（実測: 8本同時・対象400件・`limit` 300 で、名乗りの合計 2400、実際の削除 300、[PR #1129](https://github.com/takecchi/mnemora/pull/1129)）——実際に消した行（`DELETE … RETURNING`）から件数・期間を取るようにした。1行も消さなかった呼び出しは `events_purged` を積まない。また、保持日数が大きく（約247万日から）cutoff が timestamptz の下限より前になると、`purgeExpiredEventsForTenant` が例外で落ちていた——0件の削除として返す（`@mnemora/core` の cutoff の計算も、`Date` の範囲を越える日数で Invalid Date にならないようにした）。どれを消すか（古い順）は変えていない。
  ⚠ doc が約束していた振る舞い（`purged` は実際に削除された行数）へ実装を合わせた修正であり、非破壊と数える（クローン miku の判断、上の前書き）。

- **LLM が返した tags の空文字・空白だけの要素（`""`・`" "`・全角空白など）が、そのまま `Memory.tags` に書かれ、その名前の proposed ラベルが `listLabels` に出ていた**——`@mnemora/postgres` と `@mnemora/testkit/fixtures` の両方で、extract（inline / deferred）・`consolidate`・`reflect` の全経路で起きていた（`reflect` はスキーマが `""` を拒むが `" "` は通していた）。LLM が返した tags を Memory に書く前に、空白だけの要素を捨てる（`@mnemora/core`、[PR #1122](https://github.com/takecchi/mnemora/pull/1122)）。空白でない要素は、並び・重複も含めてそのまま残す。digest の空白（`resolveDigest`）・claim key の空白（`deriveClaimKeys`）を「与えられなかった」として扱うのと同じ扱いである。LLM の tags が全部空白だけなら、LLM が `tags: []` を返したのと同じ空配列になる。
  ⚠ 例外を投げず、書かれる tags とラベルだけが変わる修正であり、非破壊と数える（クローン miku の判断、上の前書き）。既に書かれた空白だけの tags・ラベルは変えない。
- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` は、`::` を含むテナントのラベルを別テナントと混ぜていた**（[PR #1135](https://github.com/takecchi/mnemora/pull/1135)）——ラベルのキーを `${tenantId}::${name}` で作り、`listLabels` を `${tenantId}::` の前方一致で絞っていたため、テナント `a` の `listLabels` にテナント `a::b` のラベルが出た。テナント `a::b` のタグ `x` とテナント `a` のタグ `b::x` は1つのラベルに潰れ、テナント `a` の `registerLabel("b::x")` が `a::b` の `x` を昇格させた。`tenantId` は不透明な文字列で `::` を含んでよく（`Ctx` の doc）、`PostgresMemoryStore` は分かれていた。キーを `(tenantId, name)` の組にして、テナントを完全一致で比べる。
  ⚠ 例外を投げず、公開の fixture の結果だけが変わる修正であり、非破壊と数える（クローン miku の判断。オーナーの判断ではない）。
- **`@mnemora/testkit/fixtures` の InMemory 一式は、区切り文字 `:` で繋いだキーを使っていたため、`:` を含む値で別の対象と衝突していた**（[PR #1146](https://github.com/takecchi/mnemora/pull/1146)）（上のラベルの項目と同じ形の残り）——`InMemoryMemoryStore` の抽出の冪等キー（`${tenantId}:${sourceObservationId}:${extractorVersion}:${contentHash}`）では、同じ Observation で版 `v:x`・hash `h` と版 `v`・hash `x:h` が同じキーになり、2件目の `createMemory` が1件目の Memory を返した。`:` を含むテナント（例: `t:<Observation の id>`）の `createMemory` が、**別テナントの Memory を返す**組み合わせもあった。`InMemoryVectorStore` は空間を `${provider}:${model}:${dimensions}:` の前方一致で絞っていたため、空間 `{p, m, 3}` の `search` が空間 `{p, m:3, 3}` のベクトルを返した。`tenantId`・`extractorVersion`・`contentHash`・空間の `model` は呼び手の値で `:` を含んでよく、`PostgresMemoryStore`・`PostgresVectorStore` は分かれていた（冪等は4列の UNIQUE、空間は別テーブル）。キーを組にして、各欄を完全一致で比べる。
  ⚠ 例外を投げず、公開の fixture の結果だけが変わる修正であり、非破壊と数える（クローン miku の判断。オーナーの判断ではない）。
- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore.registerLabel` は、NUL（U+0000）を含む名前を受け入れていた**（[PR #1135](https://github.com/takecchi/mnemora/pull/1135)）——`PostgresMemoryStore.registerLabel` は `labels.name`（`text` 列）が NUL を拒んで例外になる。ラベルの名前は `tags` の要素と同じ語彙で、`tags` の NUL はこの fixture の `createMemory` がすでに拒んでいる（Issue #816）。`registerLabel` も NUL を含む名前で例外を投げ、ラベルを作らない。
  ⚠ 公開の fixture が不正な入力に新しく例外を投げるが、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。上の前書きの「保留と非破壊の数え方」を参照）。
- **`@mnemora/postgres` の `registerEmbeddingSpace` は、同じテーブル名に潰れる別の埋め込み空間の登録を黙って通し、2つの空間のベクトルが混ざっていた**（[Issue #1151](https://github.com/takecchi/mnemora/issues/1151)、[PR #1156](https://github.com/takecchi/mnemora/pull/1156)）——テーブル名（`embeddingSpaceTableName`）は provider・model を小文字にし英数字以外を `_` にしてから繋ぐので、`{a_b, c}` と `{a, b_c}`、`{openai, text-embedding-3-small}` と `{OpenAI, text_embedding_3_small}`、ASCII 以外の文字だけが違う model 名などは、次元が同じなら同じテーブルになる。テーブル名の導出は変えず、`registerEmbeddingSpace` がテーブルのコメントに空間の組（provider・model・dimensions の元の値）を記録し、別の組が記録されたテーブルへの登録を、何も書かずに `name` が `"EmbeddingSpaceTableConflictError"` の `Error` で拒むようにした（新しい export は無い）。同じ組の再登録はこれまでどおり通る。
  ⚠ 本物のアダプタが「黙ってベクトルが混ざる」入力を早めに拒む変更であり、破壊的とは数えない（Issue #1080 と同じ扱い。クローン miku の判断で、オーナーの判断ではない）。⚠ **射程**: この版より前に作られたテーブルにはコメントが無いので、この版で**最初に登録した組**を記録して通す——既に2つの空間が1つのテーブルを使っていた場合は、先に登録した側が持ち主になり、もう片方の登録が拒まれる——**衝突する2空間を起動のたびに両方登録していたデプロイは、この版から2つ目の登録（`EmbeddingSpaceTableConflictError`）で落ちるようになる。**混ざった行は分けない。利用者が自分で付けたテーブルのコメント（mnemora の形ではないもの）は上書きせず、そのテーブルは見張らない。コメントを書くにはテーブルの所有者の権限が要るが、登録は以前から `CREATE INDEX IF NOT EXISTS` で同じ権限を要していたので、登録できるロールの範囲は変わらない。
- **`@mnemora/testkit/fixtures` の InMemory 一式は、Memory 以外の値でも内部の実体や呼び手の入力をそのまま持ち回っていた**（Issue #1108 の続き、[PR #1120](https://github.com/takecchi/mnemora/pull/1120)。Memory を返す口は下の項目）——`InMemoryMemoryStore.createObservationWithOutbox` が返した outbox ジョブが後の `claimBatch`・`complete` で遡って書き換わり、受け取った Observation・イベント・ラベル・recall 記録・ベクトル・`claimBatch` のジョブ（入れ子の `payload`・Date を含む）や、`createObservation`・`createRecall`・`EventStore.append`・`VectorStore.upsert`・`reinforce` の `at`・`claimBatch` の `now` に渡した入力を呼び手が後から書き換えると、store の中身まで変わった（`claimBatch` の `now` を書き換えるとリースが切れた扱いになった）。Postgres と同じく、返す時点・書き込む時点の複製でやり取りする。
  ⚠ 例外を投げず、公開の fixture の結果だけが変わる修正であり、非破壊と数える（クローン miku の判断、上の前書き）。返った値を書き換えて store の状態を作っていたテスト（このリポジトリでは OutboxStore の適合スイートの `seedJob` がそうしていた）は、書き換えが store に届かなくなる。
- **LLM が空白だけの本文（`content`）を返すと、その本文の Memory が書かれていた**（[Issue #1065](https://github.com/takecchi/mnemora/issues/1065)、[PR #1128](https://github.com/takecchi/mnemora/pull/1128)）——`consolidate` は元の2件を `superseded` にして空白の Memory に置き換え、`reextract` は全文フォールバックの Memory を空白の Memory に置き換えていた。`@mnemora/postgres` と `@mnemora/testkit/fixtures` の両方で起きていた。3スキーマとも `""` の本文はスキーマ不一致（LLM の失敗）として拒んでおり、空白だけの本文もそれと同じ扱いにした（`@mnemora/core`）: 抽出（inline / deferred / `reextract`）は全文フォールバック（`llm_failed_whole_observation`）へ、`consolidate`・`reflect` は `outcome: "llm_failed"`（1件も書かない）へ倒れる。抽出の候補のうち1件でも空白だけなら、`""` が1件あるときと同じく全体が倒れる。前後に空白があっても中身のある本文は、削らずにそのまま書く。
  ⚠ 例外を投げず、結果だけが変わる修正であり、非破壊と数える（クローン miku の判断。オーナーの判断ではない）。既に書かれた空白だけの本文の Memory は変えない。
- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` は、内部に持つ Memory の実体そのものを返していたため、呼び手が受け取った値が後の別の操作で遡って書き換わっていた**（Issue #1108、[PR #1114](https://github.com/takecchi/mnemora/pull/1114)）——`runtime.applyCorrection` の返り値の「contested にした」結果の Memory が、同じ呼び出しの後の resolve で `superseded` と名乗っていた（`PostgresMemoryStore` は印を付けた時点の `contested` を返す）。逆に、受け取った値（入れ子の `tags` など）や `createMemory` に渡した入力を呼び手が書き換えると、store の中身まで変わった。Memory を返す口（`createMemory`・`get`・`getMany`・`updateStatus`・`reinforce`・`markContestedPair` など17口）は返す時点の複製を返し、`createMemory` は入力を複製して保存する。Postgres と同じく「時点の値」になる。
  ⚠ 例外を投げず、公開の fixture の結果だけが変わる修正であり、非破壊と数える（クローン miku の判断、上の前書き）。
- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore.listActiveClaimPredicates` は、主語か述語の片方が欠けた claim key を持つ Memory から `undefined` を一覧に混ぜていた**（戻り値の型 `string[]` に反する）——`PostgresMemoryStore` の SQL（`claim_key_subject IS NOT NULL AND claim_key_predicate IS NOT NULL`）と同じく、両方そろった鍵だけを数えるようにした（[PR #1106](https://github.com/takecchi/mnemora/pull/1106)）。
  ⚠ 例外を投げず、公開の fixture の結果だけが変わる修正であり、非破壊と数える（クローン miku の判断、上の前書き）。
- **`mnemora-postgres-migrate`（`@mnemora/postgres` の migrate の CLI）に `--` がそのまま渡ると（`pnpm --filter @mnemora/postgres run migrate -- --analyze-memories` のように書いたとき）、`unknown option: --` だけを出して止まり、正しい書き方が分からなかった**——受け付ける入力は変えず（`--` は未知のオプションのまま）、エラー文の2行目に `--` を付けない書き方の例（渡された残りの引数を使う）を足した（PR #1116）。
  ⭕ 非破壊と数える（エラー文だけの変更。クローン miku の判断であり、オーナーの判断ではない）。
- **`Runtime.reextract` に使用報告の Observation（`kind: "usage"`、`observe({ kind: "memory_usage" })` が作る）を渡すと、payload の JSON（`recallId` と memoryId の並び）を LLM に送り、それを本文とする `stated` の記憶を作っていた**（[Issue #1099](https://github.com/takecchi/mnemora/issues/1099)、[PR #1104](https://github.com/takecchi/mnemora/pull/1104)）——使用報告は抽出器を通らない約束（`docs/memory-model.md` §2・§6）に反していた。存在しない Observation と同じ種類の `Error` を、LLM も書き込みも試みる前に投げるようにした。書き込み側の差分ファズで見つけた。
  ⭕ 非破壊と数える（上の前書きの追記2を参照。クローン miku の判断であり、オーナーの判断ではない）。
- **いくつかの例外の文面が、起きたことと違う・直し方が分からない・本文を丸ごと載せる形だった**（[PR #1143](https://github.com/takecchi/mnemora/pull/1143)）——例外の種類・
  受け付ける入力・公開の定数（`*_MESSAGE`・`*_ERROR_PREFIX`）は変えず、文面だけを直した。
  `MemoryStatusConflictError` はどの口から投げても `MemoryStore.updateStatus:` と名乗っていた（今は `MemoryStore:`
  と、読み直して判断し直す旨）。`@mnemora/openai` の切り詰めは設定の無い `max_tokens` を上げるよう勧めていた
  （`@mnemora/anthropic` は `stop_reason` ごとの直し方を書いた）。`@mnemora/postgres` の埋め込み空間の次元・SQL 識別子の
  拒否に、受け付ける値を書いた。`@mnemora/testkit` の `RecordedEmbeddingProvider`/`RecordedLLMProvider` は記録に無い
  入力の本文を丸ごと載せていた（今は先頭 80 文字と全体の長さ）。`InMemoryEventStore`/`InMemoryVectorStore` の
  「対象なし」は、同じ失敗の他の文面と同じく `memory not found for tenant:` と名乗る。
  ⭕ 非破壊と数える（エラー文だけの変更。クローン miku の判断であり、オーナーの判断ではない）。
- **`Runtime.consolidate()` に `actor`・`reason` を渡しても、統合先の `created` イベントだけは `actor` が
  `{ type: "system" }` のままで、`meta.note` も無かった**（[PR #1150](https://github.com/takecchi/mnemora/pull/1150)）——`ConsolidateOptions.actor`/`reason` の TSDoc は
  `memory_events` の欄として書いており、統合元の `superseded` イベントと `reflect()` の `created` イベントには
  入っていた。今は統合先の `created` にも同じ `actor` と `meta.note` が入る（`tick()` 経由の自動ジョブは `actor` を
  渡さないので変わらない）。
  ⭕ 非破壊と数える（例外を投げず、書かれるイベントの欄だけが約束どおりになる。上の前書きの訂正で狭めた基準に当てた）。
- **`Runtime.resolveContested()`（`supersede`）で負けた側の `superseded` イベントに、置き換えた側の id が無かった**（[PR #1155](https://github.com/takecchi/mnemora/pull/1155)）——
  `consolidate`・`reextract` の `superseded` は `meta.supersededById` を持つのに、この経路だけ持たず、監査ログだけでは
  「負けた側を何が置き換えたか」を追えなかった。今は `meta.supersededById` に勝った側の id が入る（勝った側・
  `both_active` の `updated` には足さない。[ADR 0150](./docs/decisions/0150-resolve-contested-explicit-operation.md) 追記 2026-09-27）。
  ⭕ 非破壊と数える（`meta` に欄を1つ足すだけで、型も既存の欄の意味も変えない。クローン miku の判断であり、オーナーの判断ではない）。
- **`Runtime.markContested()`・`resolveContested()`・`resolveOrphanedContested()` のイベントに、対向の id が無かった**（Issue #1160、[PR #1162](https://github.com/takecchi/mnemora/pull/1162)）——
  解決は `contested_with_id` をクリアするので、`both_active` で解いた対は、状態からも監査ログからも「誰と対だったか」が消えていた
  （`supersede` の対も、勝った側のイベントからは相手が分からなかった）。今は対にまつわるイベントがどれも、役割（勝った側・負けた側）
  にも決着の種類にもよらず `meta.contestedWithId` に相手の id を持つ（負けた側の `superseded` は上の `meta.supersededById` も
  そのまま持つ。`resolveOrphanedContested` は forget された相手の id。[ADR 0134](./docs/decisions/0134-mark-contested-explicit-operation.md)・
  [ADR 0150](./docs/decisions/0150-resolve-contested-explicit-operation.md) 追記 2026-09-27、`docs/memory-model.md` §11 の同日付追記）。
  ⭕ 非破壊と数える（上の項目と同じく、`meta` に欄を足すだけで、型も既存の欄の意味も変えない。クローン miku の判断であり、オーナーの判断ではない）。
  ⚠ この版より前に積まれたイベントには `contestedWithId` が無く、後から足すこともできない（監査ログは追記専用）。
- **`@mnemora/testkit` の `InMemoryMemoryStore.purgeExpiredEvents` が積む `events_purged` の meta の日時
  （`oldestPurgedAt`・`newestPurgedAt`・`olderThan`）が `Date` のままで、`@mnemora/postgres`（JSON で保存するので ISO 8601 の
  文字列で読み戻る）と型が違っていた**（[PR #1155](https://github.com/takecchi/mnemora/pull/1155)）——今は fixture も ISO 8601 の文字列で持つ。戻り値の `oldestPurgedAt` などは
  今までどおり `Date` である。
  ⭕ 非破壊と数える（例外を投げず、公開の fixture の結果だけが変わる。上の前書きの訂正で狭めた基準に当てた。クローン miku の判断であり、オーナーの判断ではない）。
- **`@mnemora/testkit/fixtures` の `InMemoryEventStore.append` と、イベントを受け取る `InMemoryMemoryStore` の口は、`MemoryEventKind` に無い kind（型を外した呼び出し）のイベントを受け付けて記録していた**（[Issue #1096](https://github.com/takecchi/mnemora/issues/1096)、[PR #1170](https://github.com/takecchi/mnemora/pull/1170)）——`@mnemora/postgres` は CHECK 制約 `memory_events_kind_check` で拒み、1トランザクションで何も書かない。fixture も `Error`（`memory_events.kind must be one of … (got "…")`。イベントの `at` の検査と同じ形）で拒む。対象は `append` と `updateStatusWithEvent`・`supersedeWithNewMemories`・`purgeMemory`・`markContestedPair`・`resolveContestedPair`・`resolveOrphanedContested` で、状態を書き換える前に確かめるので、拒んだときは何も書かない（イベントの `at` の Invalid Date の検査も、同じ位置で先に確かめるようにした。以前はこれらの口で、状態を書き換えた後に拒んでいた）。
  ⚠ 公開の fixture が不正な入力に新しく例外を投げるが、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。上の前書きの「保留と非破壊の数え方」を参照）。
- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` は、`memories` の列挙の列に型の列挙に無い値（型を外した呼び出し）を受け付けて記録していた**（[PR #1183](https://github.com/takecchi/mnemora/pull/1183)）——`@mnemora/postgres` は CHECK 制約（`memories_status_check`・`memories_digest_source_check`・`memories_embedding_status_check`・`memories_provenance_kind_check`）で拒み、何も書かない。fixture も `Error`（`memories.<列> must be one of … (got "…")`。上の `memory_events.kind` の検査と同じ形）で拒む。対象は `createMemory` 系の `status`・`digestSource`・`embeddingStatus`・`provenance.kind` と、`updateStatus`・`updateStatusWithEvent`・`setEmbeddingStatus`・`resolveContestedPair` で、見つからない id・CAS の食い違いの検査の後、状態を書き換える前に確かめる。
  ⚠ 公開の fixture が不正な入力に新しく例外を投げるが、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。上の前書きの「保留と非破壊の数え方」を参照）。
- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` の `createMemory` 系は、冪等の鍵（観測・抽出器の版・contentHash）が同じ既存の行が在るとき、書けない値（列挙に無い値・NUL・Invalid Date・値域の外の数）を確かめずに既存の行を返していた**（[PR #1190](https://github.com/takecchi/mnemora/pull/1190)）——`@mnemora/postgres` は `INSERT ... ON CONFLICT DO NOTHING` が衝突を見る前に値を検査するので、既存の行が在っても拒む。fixture も同じく、既存の行を返さずに拒む（文面は新しい行を作るときの検査と同じ）。対象は `createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories` の新しい行。
  ⚠ 公開の fixture が不正な入力に新しく例外を投げるが、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。上の前書きの「保留と非破壊の数え方」を参照）。
- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` の `createObservation`・`createObservationWithOutbox` は、日時の欄（`occurredAt`・`recordedAt`・`validFrom`・`validUntil`）に Invalid Date を受け付けていた**（[PR #1243](https://github.com/takecchi/mnemora/pull/1243)）——新しい行ならそのまま保存し、`externalId` が同じ既存の行が在ればそれを返していた。`@mnemora/postgres` は `timestamptz` への変換で拒む（既存の行が在っても拒む）。fixture も `Error`（`<欄> must be a valid Date (got Invalid Date)`。Memory 側と同じ文面）で拒み、何も書かない。
  ⚠ 公開の fixture が不正な入力に新しく例外を投げるが、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。上の前書きの「保留と非破壊の数え方」を参照）。
- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` は、#1096・#1183 の外側に残っていた Postgres の CHECK 制約と型の変換に当たる入力を受け付けて記録していた**（[PR #1250](https://github.com/takecchi/mnemora/pull/1250)）——`provenance.kind` が `stated`/`inferred` で `sourceObservationId` が無い（`memories_check`）、`decayBaseSeq`・`decayFloorSeq` が整数でない・負・2^63 以上（`memories_decay_seq_non_negative` と `bigint`）、`halfLifeRecalls` が `(0, ∞)` の外・float4 に収まらない（`memories_half_life_recalls_range` と `real`）、`kind: "events_purged"` で `memoryId` が null でないイベント（`memory_events_check`）。fixture も `Error` で拒み、何も書かない。省略（`null`）は検査しない。
  ⚠ 公開の fixture が不正な入力に新しく例外を投げるが、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。上の前書きの「保留と非破壊の数え方」を参照）。
- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` は、参照・冪等の鍵が空文字 `""` のとき、それを「無い」として扱っていた**（[PR #1252](https://github.com/takecchi/mnemora/pull/1252)）——`createMemory` 系の `sourceObservationId`・`supersededById`・`contestedWithId` が `""` なら検査せずにそのまま保存し、`createObservation` 系の `externalId` が `""` なら毎回新しい行を作っていた。`@mnemora/postgres` は `null` だけを「無い」とする（空文字の参照は uuid として読めずに拒み、空文字の `externalId` は一意制約の鍵になる）。fixture も同じく、空文字の参照は参照先が無いとして `Error`（`… not found: `）で拒み、空文字の `externalId` の2回目は既存の行を返す。
  ⚠ 空文字の参照で公開の fixture が新しく例外を投げるが、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。上の前書きの「保留と非破壊の数え方」を参照）。空文字の `externalId` の件は、例外を投げず結果だけが変わるので、非破壊と数える基準に当たる（上の前書きの訂正の基準）。
- **`@mnemora/testkit/fixtures` の読みの口は、条件の Invalid Date と整数でない通し番号を受け付けていた**（[PR #1265](https://github.com/takecchi/mnemora/pull/1265)）——`InMemoryMemoryStore` の `purgeExpiredEvents`（`olderThan`）・`archiveDecayed`（`now`・`nowSeq`）・`aggregateScope`（日時の条件・`decayFloorSeqAfter`）・`findActiveByClaimKey`（`validFrom`・`validUntil`）、`InMemoryEventStore.list`（`since`・`until`）、`InMemoryVectorStore.search`・`InMemoryLexicalStore.search`（filter の日時・`decayFloorSeqAfter`）。`@mnemora/postgres` はクエリの時点で `timestamptz`・`bigint` への変換に失敗して拒む。fixture も `Error`（`<口>: <欄> must be a valid Date` / `must be an integer`）で拒む。省略は検査しない。
  ⚠ 公開の fixture が不正な入力に新しく例外を投げるが、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。上の前書きの「保留と非破壊の数え方」を参照）。
- **`@mnemora/testkit/fixtures` の `InMemoryTenantSettingsStore.setEventRetention` は、`days` が Postgres の `integer`（int4）に収まらない値（2^31 以上）も保存していた**（[PR #1270](https://github.com/takecchi/mnemora/pull/1270)）——`@mnemora/postgres` は `tenant_settings.event_retention_days` に書けずに拒む。fixture も `Error`（`setEventRetention: days does not fit in a Postgres "integer" (int4) column`）で拒み、前の設定を変えない。
  ⚠ 公開の fixture が不正な入力に新しく例外を投げるが、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。上の前書きの「保留と非破壊の数え方」を参照）。
- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore.createRecall` と `InMemoryOutboxStore.claimBatch` は、Postgres が行を書けずに拒む値も保存していた**（[PR #1280](https://github.com/takecchi/mnemora/pull/1280)）——`createRecall` の `subjectId`（`text`）と `query`・`budget`・`omitted`・`usage`・`indexBand`・`explain`・`returnedMemories`（`jsonb`）に NUL（U+0000）を含む値、`budget` 以外の欄が JSON にならない値（`query: undefined` など。`NOT NULL` の列）、`claimBatch` の `claimedBy`（`text`）に NUL を含む値。fixture も `Error` で拒み、記録・活動時計・claim のどれも進めない。
  ⚠ 公開の fixture が不正な入力に新しく例外を投げるが、**破壊的変更として扱わない**（オーナーの回答（ask_human `3f3411c5`）。上の前書きの「保留と非破壊の数え方」を参照）。
- **`MemoryStore.reinforce`（と `reinforceMany`・`recordUsageAndReinforce`）は、未強化の記憶に作成時刻（`recordedAt`）より前の `at` を渡すと、減衰の起点を作成時刻より前へ戻していた**（[Issue #1093](https://github.com/takecchi/mnemora/issues/1093)、[PR #1173](https://github.com/takecchi/mnemora/pull/1173)）——`lastReinforcedAt` が `null` なら `at` によらず書いていたため、`lastReinforcedAt` が作成時刻より前になり、`decayFloorAt` が早まって忘却ゲートから早く消えた。活動時計の `decayBaseSeq`/`decayFloorSeq` も進んでいた。`@mnemora/postgres`・`@mnemora/testkit/fixtures` とも同じだった。規則を1つにした: **`at` が起点（`lastReinforcedAt ?? recordedAt`）より新しいときだけ書き、そうでなければ活動時計の欄も含めて何も書かない**（強化済みの記憶に古い `at` を渡したときの既存の規則と同じ）。作成時刻ちょうどの `at` も、既存の `lastReinforcedAt` の比較と同じく書かない。
  ⚠ 約束の見出し（`MemoryStore.reinforce` の TSDoc と [ADR 0048](./docs/decisions/0048-reinforce-does-not-move-decay-origin-backwards.md)「減衰の起点を巻き戻さない」）に振る舞いを合わせた修正であり、例外を新しく投げないので、非破壊と数える（**クローン miku の判断であり、オーナーの判断ではない**）。⚠ **射程**: 活動時計のテナントで、`recordedAt` を書いた時計が runtime の時計より進んでいる使用報告は、この版から強化にならない（壁時計・活動時計のどちらでも）。作成と同じミリ秒の中の強化（固定の時計で、作成と使用報告・`restoreArchived` を同じ時刻に打つ形など）も書かれなくなる。既に作成時刻より前の起点を持っている記憶は変えない。
- **`@mnemora/testkit/fixtures` の `InMemoryVectorStore` は、ベクトルを丸めずに（float64 のまま）比べていた**（[PR #1273](https://github.com/takecchi/mnemora/pull/1273)）——`@mnemora/postgres`（pgvector の `vector` 型）は成分を float4 で持つので、クエリとの距離の差が float4 の桁より小さい2件は、Postgres では同点になって `recorded_at` の新しい順で並び、fixture では距離の近い順に並んでいた（`limit` で切ったときに返る集合も割れた）。いまは fixture も、保存するベクトルとクエリを `Math.fround` で float4 に丸めてから比べ、何が同点になるかが Postgres と同じになる。`VectorHit.distance` と `getVectors` が返す `VectorEntry.vector` の値の下の桁が変わる（距離の値そのものは、pgvector が float4 で積算するぶん、なお Postgres と揃わない）。
  ⚠ 例外を投げる入力は変えていない（float4 の範囲を超える有限の値は `Infinity` に丸まるが、fixture はもともと `Infinity` を例外にしない）。
- **`@mnemora/postgres` の `reinforceMany()`・`markContestedPair()` は、大文字の UUID を渡すと、`reinforce()`・`get()` が同じ記憶を返すのに「memory not found」を投げていた**（[PR #1324](https://github.com/takecchi/mnemora/pull/1324)）——DB が返す小文字の id と渡された id をそのまま突き合わせていた。小文字にそろえて突き合わせる。⭕ 非破壊（例外が減る）。クローン miku の判断であり、オーナーの判断ではない。（2026-09-28 の12回目の棚卸しで追記: `markContestedPair()` に同じ行を小文字と大文字で渡したときは、この PR では「memory not found」のまま残し、下の [PR #1327](https://github.com/takecchi/mnemora/pull/1327) の項目で `RangeError` になった）
- **`Runtime.forget()`・`restoreArchived()`・`purge()`・`markContested()` は、`@mnemora/postgres` で大文字の UUID を渡すと、記憶が在るのに `not_found` を返していた**（[PR #1324](https://github.com/takecchi/mnemora/pull/1324)）——store が返した id と渡された id を小文字にそろえて突き合わせる（store へ渡す id は変えない。大文字小文字を区別する store では今どおり `not_found`。大文字小文字だけが違う id を同じ呼び出しに混ぜたときは渡された文字列どおり）。⭕ 非破壊（結果が store の `get` に揃う）。クローン miku の判断であり、オーナーの判断ではない。（2026-09-28 の12回目の棚卸しで追記: ここの「store へ渡す id」は、store の口の引数の id のことである。`markContested()` がイベントの `meta.contestedWithId` に載せる相手の id は、下の [PR #1329](https://github.com/takecchi/mnemora/pull/1329) の項目で、渡された id から store が返した id に変わった）
- **`@mnemora/postgres` の `resolveContestedPair()` は大文字の UUID で「memory not found」か `MemoryStatusConflictError` を投げ、`restoreSupersededBy()` は大文字の UUID をそのまま `unsuperseded` イベントの `meta.supersededById` に写して列の値（小文字）と食い違っていた**（[PR #1327](https://github.com/takecchi/mnemora/pull/1327)）——store の入口で uuid の形の id を小文字にそろえる（store の中の正規化。呼び出し側が組んだイベントの `meta` の中身はそろえない）。⭕ 非破壊（例外が減る／`meta` が列の値に揃う）。クローン miku の判断であり、オーナーの判断ではない。（2026-09-28 の12回目の棚卸しで追記: Runtime の `markContested()`・`resolveContested()` が組む `meta` の id は、store ではなく Runtime の側で、下の [PR #1329](https://github.com/takecchi/mnemora/pull/1329) の項目のとおり store の値になった）
  ⚠ 大文字の UUID を渡して今も例外になる場合（行が無い・状態が違う）、例外は小文字で渡したときと同じものになる——例外の文面と `MemoryStatusConflictError.memoryId` に載る id は、渡した文字列ではなく小文字になり、対になっていない組を大文字で渡した `resolveContestedPair()` は「memory not found」ではなく `MemoryStatusConflictError` を投げる。`reinforceMany()`・`markContestedPair()`・`resolveContestedPair()`・`resolveOrphanedContested()` が当たる（12回目の棚卸しで追記。【実測 2026-09-28】この PR の前の `24ffac3` と `7d5f944` の build を手元の Postgres 17 で比べた）。
- **`@mnemora/postgres` の `markContestedPair()`・`resolveContestedPair()` は、同じ行を小文字と大文字で渡すと、TSDoc が約束する `RangeError`（同じ id）ではなく「memory not found」（`Error`）を投げていた**（[PR #1327](https://github.com/takecchi/mnemora/pull/1327)）——上の入口の正規化で `RangeError` になる。[PR #1324](https://github.com/takecchi/mnemora/pull/1324) の歯はこの入力を `Error` のまま縛っていたので、意図して書き換えた。⭕ 例外の種類が約束どおりになる。投げる入力の集合は変わらない。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/postgres` の `resolveOrphanedContested()` は、uuid の形でない `contestedWithId` で DB の例外（uuid への型変換）を漏らしていた**（[PR #1327](https://github.com/takecchi/mnemora/pull/1327)）——TSDoc どおり `MemoryStatusConflictError`（行が無ければ「memory not found」）を投げる。core の Fake と同じ。⭕ 漏れていた例外の種類が約束どおりになる。クローン miku の判断であり、オーナーの判断ではない。
- **`Runtime.consolidate()`・`reflect()` は、`@mnemora/postgres` で大文字の UUID を渡すと、`{ memoryIds }` では記憶が在るのに `not_found` にし、`{ seedMemoryId }` では種を近傍にも入れて同じ記憶を大文字と小文字で2回並べていた**（[PR #1327](https://github.com/takecchi/mnemora/pull/1327)）——`forget` と同じ形で突き合わせ、種は store が返した種の id で除く（大文字小文字を区別する store では今どおり `not_found`。大文字小文字だけが違う id を同じ呼び出しに混ぜたときは渡された文字列どおり）。⭕ 非破壊（結果が store の `get` に揃う）。クローン miku の判断であり、オーナーの判断ではない。
- **`Runtime.resolveContested()` は、`@mnemora/postgres` で大文字の UUID を渡すと、在る対を `not_found`・`pair_broken` にし、片側と大文字小文字だけ違う `winnerId` で `RangeError` を投げていた**（[PR #1329](https://github.com/takecchi/mnemora/pull/1329)）——`markContested` と同じ形で突き合わせ、相互参照は store が返した相手の id と比べる。`winnerId` が片側と大文字小文字だけ違うときは store の `get` で同じ記憶かを確かめ、同じなら勝者として扱う（大文字小文字を区別する store では今どおり `not_found`・`RangeError`。大文字小文字だけが違う id を同じ呼び出しに混ぜたときは渡された文字列どおり）。⭕ 非破壊（例外が減る／結果が store の `get` に揃う）。クローン miku の判断であり、オーナーの判断ではない。
- **`Runtime.markContested()`・`resolveContested()` は、イベントの `meta.contestedWithId`（と敗者の `meta.supersededById`）に渡された id をそのまま載せていたので、`@mnemora/postgres` に大文字の UUID を渡すと列の値（小文字）と食い違っていた**（[PR #1329](https://github.com/takecchi/mnemora/pull/1329)）——store が返した id を載せる。⭕ 非破壊（`meta` が列の値に揃う。小文字で渡したときの `meta` は変わらない）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/anthropic` の `complete()`・`completeStructured()`（と `toAnthropicRequest()`）は、`content` が空文字の `role: "system"` のメッセージを渡すと `system: ""` を送っていた**（[PR #1331](https://github.com/takecchi/mnemora/pull/1331)）——`AnthropicRequest.system` の doc（無ければ鍵ごと無い）どおり、空文字の system は連結に入れず、どれも空なら `system` の鍵を持たない（`prompt.system` の空文字は以前から落としていた）。⭕ 非破壊（送る形だけが変わる。例外を投げる入力は変わらない）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/local-embedding` の読み込み失敗のメッセージは、`retry.attempts` に整数でない値（例: `2.5`）を渡すと、実際には2回しか試していないのに「2.5 回試した」と書いていた**（[PR #1331](https://github.com/takecchi/mnemora/pull/1331)）——実際に試した回数を書く。⭕ 非破壊（例外の文面だけが変わる。投げる入力・試す回数は変わらない）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/local-embedding` の読み込み失敗と `unknown_input_limit` のメッセージは、再変換したモデルを「`options.repo` に指せば使える」とだけ案内していたが、`repo` だけを差し替えると構築時に例外になる**（[PR #1331](https://github.com/takecchi/mnemora/pull/1331)）——`options.modelId` にそのモデルを名乗る id も渡すよう案内する（メッセージの先頭の形は変えていない）。⭕ 非破壊（例外の種類・`kind`・投げる条件は変えず、文面だけが変わる）。クローン miku の判断であり、オーナーの判断ではない（13回目の棚卸しで足した。上の追記13）。
- **`@mnemora/openai` の `completeStructured()` は、スキーマがもともと `null` を許す位置（必須の `.nullable()` の欄・`.nullable()` の配列の要素・根の `.nullable()`）にモデルが `null` を返すと、その `null` まで消して `ZodError` を投げていた**（[PR #1337](https://github.com/takecchi/mnemora/pull/1337)）——`null` を消して検査して落ちたときだけ、元のスキーマが許す位置の `null` を残して検査し直す（それでも落ちれば最初の `ZodError` を投げる）。`.optional()` と `.nullable().optional()`（[Issue #1082](https://github.com/takecchi/mnemora/issues/1082)）の欄の `null` は今どおり省略になり、1段目で通る入力の結果は変わらない。⭕ 非破壊（例外が減る側。公開の型は変わらない）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/local-embedding` の読み込みの再試行は、`retry.attempts` に整数でない値（例: `2.5`）を渡すと、最後の試行の後にも1回余分に待っていた**（[PR #1340](https://github.com/takecchi/mnemora/pull/1340)）——次の試行があるときだけ待つ。⭕ 非破壊（試行の回数と投げる例外は変わらず、待ち時間だけが短くなる。整数の `attempts` では変わらない）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/postgres` の `findActiveByClaimKey()` は、`excludeMemoryId` を大文字の UUID で渡すと、除くはずの自分自身を返していた**（[PR #1335](https://github.com/takecchi/mnemora/pull/1335)）——`excludeMemoryId` も入口で小文字にそろえる（[PR #1327](https://github.com/takecchi/mnemora/pull/1327) と同じ `normalizeUuidCase`）。`Runtime` の claim key の検出は store が返した小文字の id を渡すので、踏むのは store を直接呼ぶ側だけである。小文字の id を渡したときの結果は変わらない。⭕ 非破壊（結果が store の `get` に揃う）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/postgres` の `aggregateScope()` の `axis: 'taxonomy'` の群（`RecallQuery.taxonomyGroups: true`）は、`tags` に同じ名前が重なる記憶を、その名前の群に重なった回数だけ数えていた**（[PR #1335](https://github.com/takecchi/mnemora/pull/1335)）——`GroupCount.count` の TSDoc（Memory の件数）と testkit の fixture に揃え、1件の記憶は1つのラベル群に1回だけ数える。`tags` は重複を除かずに保存されるので（LLM が返した `tags` を含む）、`recall()` の `index.groups` にも出ていた。重複の無い `tags` では件数は変わらない。⭕ 非破壊（件数が約束どおりになる。例外は増えない）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/core` の `truncateForFallbackDigest()` は、本文が空のとき、負の `maxLength` で `"…"` を返していた（`0` なら `"（内容なし）"`）**（[PR #1350](https://github.com/takecchi/mnemora/pull/1350)）——負の `maxLength` を `0` と同じに扱う。⭕ 非破壊（結果だけが変わる。例外は変わらない）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/core` の `computeAffinity()` は、`similarity` が `NaN` だと、`lexicalMatch` があっても `NaN` を返していた**（[PR #1350](https://github.com/takecchi/mnemora/pull/1350)）——`NaN` の `similarity` を無いものとして扱い、`lexicalMatch` を使う。⭕ 非破壊（結果だけが変わる）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/core` の `countKindForUnits()`・`unitAssemblyShortfall()` は、件数の和だけで数えていたので、1件が二重に入り別の1件が抜けると `exact`・`0` を返していた**（[PR #1350](https://github.com/takecchi/mnemora/pull/1350)）——候補の `memory.id` の集合で数える（二重計上だけなら今どおり `unknown`・`0`）。⭕ 非破壊（結果だけが変わる。型は変わらない）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/core` の `compareScoredCandidates()` は、実効時刻が Invalid Date だと `NaN` を返し、`memory.id` のタイブレークに届かなかった**（[PR #1350](https://github.com/takecchi/mnemora/pull/1350)）——時刻のどちらかが Invalid Date なら同点として扱い、`memory.id` で決める。⭕ 非破壊（結果だけが変わる）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/core` の `calibrateRecallFootprint()` は、`memoryCount` が2種類以上ある標本で最小二乗の傾きが0以下になると、`charsPerDigest` に0以下の値を `borrowedFromDefault` に名前を出さずに返していた**（[PR #1351](https://github.com/takecchi/mnemora/pull/1351)）——その係数で `estimateRecallFootprint()` を呼ぶと `chars` が負になった。`memoryCount` が1種類の枝と同じく、傾きが0以下なら既定値から借りて `borrowedFromDefault` に `"charsPerDigest"` を出し、切片は借りた傾きのもとで標本の平均を通るように決める。傾きが正の標本の結果は変わらない。⭕ 非破壊（結果が変わるのは傾きが0以下の標本だけで、例外は増えない）。クローン miku の判断であり、オーナーの判断ではない。
- **`createRuntime()` の `RuntimeConfig.llmModelId`・`promptVersion` は、空文字を渡すと、抽出した推論の記憶の `provenance` に空文字のまま書いていた**（[PR #1355](https://github.com/takecchi/mnemora/pull/1355)）——その `provenance` は `ProvenanceSchema`（`model`・`promptVersion` は空文字を拒む）を通らなかった。TSDoc の「省略時は `"unknown"`・`"v1"`」どおり、空文字は省略と同じに扱い、既定値を書く。空白だけの値と、空でない値は、これまでどおりそのまま書く。⭕ 非破壊（結果が変わるのは空文字を渡したときだけで、例外は増えない）。クローン miku の判断であり、オーナーの判断ではない。
- **`Runtime.reflect()` は、LLM が `digest: ""`（空文字）を返すと、TSDoc が約束する機械的な切り出しへのフォールバックをせず、応答ごと拒んで `outcome: "llm_failed"` にしていた**（[PR #1354](https://github.com/takecchi/mnemora/pull/1354)）——`ReflectionLLMResultSchema` の `digest` が空文字を拒んでいた。抽出・`consolidate` と同じく空文字を受け付け、`resolveDigest` で `digestSource: "fallback"` の要旨にする。⭕ 非破壊（例外・`llm_failed` になる応答が減る）。クローン miku の判断であり、オーナーの判断ではない。
- **`Runtime.reflect()` は、LLM の `tags` に空文字の要素が1つでもあると、その tag だけを落とさず、応答ごと拒んで `outcome: "llm_failed"` にしていた**（[PR #1354](https://github.com/takecchi/mnemora/pull/1354)）——`ReflectionLLMResultSchema` の `tags` の要素が空文字を拒んでいた。抽出・`consolidate` と同じく空文字の要素を受け付け、`dropBlankTags` で落とす（空白だけの要素はもともと落としていた）。公開の `ReflectionLLMResultSchema` を直接使う呼び出しでも、空文字の `digest`・`tags` の要素を含む応答を受け付けるようになる。⭕ 非破壊（例外・`llm_failed` になる応答が減る）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/postgres` の `restoreSupersededBy()` は、`event.at` が Invalid Date だと、戻す対象が無くても例外を投げていた**（[PR #1366](https://github.com/takecchi/mnemora/pull/1366)、[Issue #1229](https://github.com/takecchi/mnemora/issues/1229)）——対象が無ければ testkit の fixture と同じく `{ restored: [] }` を返す。対象が在るときは今どおり例外で、1件も戻さない（例外の種類も変えていない）。`Runtime.restoreSuperseded()` は時計の値を渡すので、踏むのは store を直接呼ぶ側だけである。⭕ 非破壊（例外を投げる入力が減る）。クローン miku の判断であり、オーナーの判断ではない。
- **`Runtime.consolidate()` は、いまの時点で有効期間（`validFrom`/`validUntil`）の外にある `active` な記憶も統合元にしていた。統合先は有効期間を持たないので、期限切れ・未到来の事実が、期限の無い `active` な記憶として `recall()` に戻っていた**（[Issue #1188](https://github.com/takecchi/mnemora/issues/1188)、[PR #1383](https://github.com/takecchi/mnemora/pull/1383)）——`{ memoryIds }`、`{ seedMemoryId }` の種、`includeOutsideValidity: true` を渡した `{ query }` で起きていた。有効期間の外にある記憶は統合元にせず、動かさず、LLM にも渡さない。`sources` では新しい `kind` の `"expired"`（`validUntil` を運ぶ）・`"not_yet_valid"`（`validFrom` を運ぶ）で名指しする。判定は `recall()` の期間のゲートと同じ（[ADR 0089](./docs/decisions/0089-runtime-consolidate-shape.md) の 2026-09-29 追記）。統合先の有効期間は今までどおり持たない。⚠ 非破壊と数える（公開の union `ConsolidateSourceOutcome` に値を2つ足した——網羅的に分岐している呼び出し側は扱いを足す必要があるが、union に値を足す変更は破壊的と数えない（オーナーの回答（ask_human `d9364c91`）、[`docs/migration-v1.md`](./docs/migration-v1.md) の「数え方の規律への追記（2026-09-28）」）。例外を投げる入力は変わらない。期限切れ・未到来の記憶を含めて呼ぶと結果が変わり、統合されずに `nothing_to_consolidate` で返ることもある）。`reflect()` の材料の選び方は変えていない。クローン miku の判断であり、オーナーの判断ではない。
- **`Runtime.reflect()` は、いまの時点で有効期間（`validFrom`/`validUntil`）の外にある `active` な記憶も材料にしていた。内省の記憶は有効期間を持たないので、期限切れ・未到来の事実が、期限の無い `active` な記憶として `recall()` に戻っていた**（[Issue #1188](https://github.com/takecchi/mnemora/issues/1188)、[PR #1388](https://github.com/takecchi/mnemora/pull/1388)）——`consolidate()` が PR #1383 で直したのと同じ穴が `reflect()` にも残っていた。`{ memoryIds }`、`{ seedMemoryId }` の種、`includeOutsideValidity: true` を渡した `{ query }` で起きていた。有効期間の外にある記憶は材料にせず、LLM にも渡さない。`basis` では新しい `kind` の `"expired"`（`validUntil` を運ぶ）・`"not_yet_valid"`（`validFrom` を運ぶ）で名指しする。判定は `status` の判定の後・`provenance.kind === 'reflected'`（`basis_is_reflected`）の判定の前に行い、述語は `consolidate()`・`recall()` の期間のゲートと同じ（[ADR 0091](./docs/decisions/0091-runtime-reflect-shape.md) の 2026-09-29 追記）。内省の記憶の有効期間は今までどおり持たない。⚠ 非破壊と数える（公開の union `ReflectBasisOutcome` に値を2つ足した——網羅的に分岐している呼び出し側は扱いを足す必要があるが、union に値を足す変更は破壊的と数えない（オーナーの回答（ask_human `d9364c91`）、[`docs/migration-v1.md`](./docs/migration-v1.md) の「数え方の規律への追記（2026-09-28）」）。例外を投げる入力は変わらない。期限切れ・未到来の記憶を含めて呼ぶと結果が変わり、材料にならず `nothing_to_reflect` で返ることもある）。`consolidate()` の判定は変えていない（既に ADR 0089 で直っている）。期間の述語自体は `classifyValidity`（`packages/core/src/validity.ts`、非公開）に1箇所へまとめ、`recall()`・`consolidate()`・`reflect()` の3箇所が同じ関数を呼ぶ（振る舞いは変えていない）。
- **`@mnemora/postgres` は、LLM 呼び出し失敗時の全文フォールバック（`observe()` の安全弁）で、語の多い大きな本文だと `memories.content` の語彙索引（`idx_memories_lexical`）の tsvector が1MB（1,048,575バイト）を超え、DB の例外（`string is too long for tsvector`）を投げて Memory を1件も書けなかった**（[Issue #1222](https://github.com/takecchi/mnemora/issues/1222)、[PR #1406](https://github.com/takecchi/mnemora/pull/1406)、[migrations/0025](./packages/postgres/migrations/0025_lexical_tsvector_fallback.sql)、[ADR 0364](./docs/decisions/0364-lexical-tsvector-fallback-for-oversized-content.md)）——索引式に `mnemora_lexical_tsvector(content)`（新しい plpgsql 関数）を挟み、tsvector が1MBを超える本文だけ、本文の先頭150,000文字で作り直す。1MBに収まる本文（ほぼ全部）は今までと1バイトも違わない tsvector になる（ADR 0364「N の実測」で理論上限・実測の両方を確かめた）。1MBを超える本文は、`memories.content` には全文が無傷で残るが、先頭150,000文字より後ろにしか現れない語は語彙チャンネルからは引けなくなる（ベクトル検索等、他の recall チャンネルには影響しない）。LLM が成功し、抽出結果にこの大きさの候補が在る場合（Issue #1063 の項）も、その候補は落とされず書かれるようになった。
  ⚠ **`idx_memories_lexical` の作り直し（migration 0025）は `DROP INDEX` + 素の `CREATE INDEX`（`CONCURRENTLY` 不可）であり、索引の再構築が終わるまで `memories` への読み書きを `ACCESS EXCLUSIVE` ロックで止める。**【実測】10万行で約1.2秒（旧式の索引作り直し約1.0秒に対し+20.3%。行数にほぼ比例して伸びる見込み——ADR 0364「実測」節）。あわせて、この索引式を通る**すべての** `memories` への INSERT/UPDATE が恒常的にわずかに遅くなる（【実測】10万行の INSERT で約+17.6%、ADR 0364「実測」節）。
  ⭕ 非破壊と数える（これまで例外を投げていた入力が成功するようになる修正であり、破壊的変更として扱わない——オーナーの回答（ask_human `3f3411c5`）の基準を、方向を反転した同種の修正として適用した。**クローン miku の判断であり、オーナーの判断ではない**）。
- **`tick()` がジョブの失敗を記録する outbox 行の `lastError` は、`@mnemora/postgres` で DB への書き込みが失敗すると、drizzle が包んだエラー文の `params:` 以降（失敗したクエリに渡した値そのもの——Memory の本文などの利用者データ）を、削らずにそのまま含んでいた（実測で1.49MBに達した例が [Issue #1064](https://github.com/takecchi/mnemora/issues/1064) に在る）**（[PR #1402](https://github.com/takecchi/mnemora/pull/1402)、[ADR 0363](./docs/decisions/0363-outbox-last-error-omit-params-and-cap-length.md)）——`describeJobFailure`（`@mnemora/core`）が、cause の連鎖の各段の `message` から drizzle の `params:` 以降を `(omitted by mnemora, N chars)` という印に置き換えるようにした。SQL の文そのもの（テーブル名・列名・クエリの形）と、cause の連鎖・SQLSTATE は今までどおり残る。さらに、戻り値全体の長さに上限（4096文字。根拠は ADR 0363「決定2」の実測）を掛け、超えた分は `sliceWithoutSplittingSurrogatePair` で切り詰め、末尾に「切ったこと」と「元の長さ」が読める印を付ける。
  - **`@mnemora/openai` の拒否の文面（`OpenAILLMProviderError`、ADR 0075）や pg の型変換エラーの生メッセージ（`invalid input syntax for type ... : "<値>"`）は、`params:` という目印を持たないため今回は塞がっていない**——長さの上限（4096文字）だけがこれを抑える（ADR 0363「引き受けた負債」）。
  - **既存行（この変更より前に書き込まれた `last_error`）の掃除はしていない**——今後も本文を含んだまま残る（ADR 0363「決定5」）。
  - ⭕ 非破壊と数える（`OutboxJob.lastError` の型は変わらない。例外は増減しない。変わるのは、この欄の**文字列の中身**——`params:` 以降が印に置き換わり、長さに上限が掛かる——だけである。同種の前例として、この欄の中身を変えた過去の変更（Issue #969「cause の連鎖を足す」・PR #1060「NUL を `\u0000` に置き換える」・Issue #1080「API キーを含まない例外にする」）は、いずれも `### Fixed` に置かれ、破壊的とは数えられていない。クローン miku の判断であり、オーナーの判断ではない）。
- **`@mnemora/local-embedding` の `LocalEmbeddingProvider` に `cacheDir` を渡して温めても、ネットワークが無いと読み込めなかった**（[Issue #1239](https://github.com/takecchi/mnemora/issues/1239)、[PR #1401](https://github.com/takecchi/mnemora/pull/1401)、[ADR 0361](./docs/decisions/0361-local-embedding-cache-dir-env-swap.md)）——以前は、`cacheDir` にモデルの4ファイルが揃っていても、`@huggingface/transformers@4.2.0` の `pipeline()` の前段の確認が既定のキャッシュ（`env.cacheDir`）だけを見て、そこが空なら Hugging Face へ取りに出ていた（PR #1246 が README に今の振る舞いとして書いていたもの）。いまは既定の `createPipeline` が、`cacheDir` を渡されたときに限り `pipeline()` を呼んでいる間だけ `env.cacheDir` を `cacheDir` に向け、成功でも失敗でも元へ戻す。`cacheDir` が温まっていれば、既定のキャッシュが空でもネットワークへの要求は0回になる。このパッケージの読み込みどうしはプロセス内で直列化するので、`cacheDir` の違う provider が並行して読み込んでも、互いの差し替えの最中の値を見ない（そのぶん、インスタンスをまたいだ読み込みは並行しなくなった）。⚠ このパッケージを経由しない同じプロセスの transformers.js の利用は、差し替えの最中に読み込むと `cacheDir` を見うる（README・ADR 0361）。`cacheDir` を渡さない使い方は変わらない。🔴 `revision` を `main` 以外にすると、前段の確認が `main` の鍵を探すので、この直し方は届かず、オフラインでは今も読めない（README に書いただけで、実装は変えていない）。
  ⭕ 非破壊と数える（公開の宣言・型は変わらない。例外で失敗していた読み込みが成功する側にだけ変わる。クローン miku の判断であり、オーナーの判断ではない）。
- **`@mnemora/postgres` の `PostgresVectorStore.searchMany()` は、`memories`・埋め込み表のどちらかに統計が無い（`ANALYZE` 前の）小さいテナントで、`memories` を主キーで引かないプランになり、連想枠（段3.5）の `recall()` が数倍〜数十倍遅くなることがあった**（[Issue #1181](https://github.com/takecchi/mnemora/issues/1181)、[PR #1410](https://github.com/takecchi/mnemora/pull/1410)、[ADR 0362](./docs/decisions/0362-searchmany-lateral-forces-memories-primary-key-lookup.md)）——統計の有無で2つの形を1本の SQL の中に並べ、`pg_class.reltuples`（`memories`・埋め込み表のどちらかが `< 0`＝一度も `ANALYZE`/`VACUUM` されていない）で実行時にどちらか一方だけを動かす（往復は増えない、Postgres の「One-Time Filter」で切り替える）。**統計が無いときだけ**、`JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id` の代わりに `CROSS JOIN LATERAL (SELECT * FROM memories WHERE id = e.memory_id OFFSET 0) m` を使う（`OFFSET 0` は副問い合わせを外側へ引き上げさせない柵、`id` は `memories` の主キー。テナント境界は柵の外の `WHERE` に残す）。**統計があるときは、今の main の SQL が1バイトも変わらずに走る**（`search()` と同じ素の `JOIN`）——歯（`search-many-primary-key-lookup.postgres.test.ts`）で、統計なしでは候補の枝が、統計ありでは今の枝がそれぞれ実行されることを縛った。`search()` は変えていない。結果（返る記憶・順位・同点の決着）は変えない——既存の契約・歯（`__tests__/vector-search-many-diff.postgres.test.ts`）をそのまま満たす。統計ありの `recall()` 全体を、前後を12往復以上交互に（同じDB・同じデータに対してビルドだけ差し替え、各点は warmup5回を捨てた後の25回の中央値）測り直し、既定のアンカー数（3）・アンカー10のどちらも、N=200・N=3000 で前後差の中央値が2ms以内（-0.64ms〜+1.19ms）に収まり、N とともに伸びないことを確認した（詳細・生データは ADR 0362）。⭕ 非破壊（クエリの実行計画だけが変わる。結果・型は変わらない）。クローン miku の判断であり、オーナーの判断ではない。⚠ **2026-09-29 追記（25回目の棚卸し）**: この節はまだ出荷されていないが、この仕組み自体は [PR #1421](https://github.com/takecchi/mnemora/pull/1421)（[ADR 0374](./docs/decisions/0374-search-stats-presence-instance-cache.md)）で置き換わったため、上の本文はもう今の実装と合わない——本文は当時の記録として書き換えず、この注記で正す。置き換わった3点: (a) 往復は、統計を確かめる前（未確認の間）だけ1回増える（上の「往復は増えない」はもう当たらない）。(b) 切り替えは1本の SQL の中の One-Time Filter ではなく、`PostgresVectorStore` インスタンスが表ごとに確認結果を覚える形（`StatsPresenceGate`）に変わった。(c) `search()` も同じ仕組みを使う（上の「`search()` は変えていない」はもう当たらない）。詳細は直後の `search()`（段1）の項目（Issue #1415）を見ること。
- **`@mnemora/postgres` の `PostgresVectorStore.search()`（段1）にも、直前の項目（Issue #1181）と同じ欠陥が実測された**（[Issue #1415](https://github.com/takecchi/mnemora/issues/1415)、[PR #1421](https://github.com/takecchi/mnemora/pull/1421)、[ADR 0374](./docs/decisions/0374-search-stats-presence-instance-cache.md)）——`memories`・埋め込み表のどちらかに統計が無い小さいテナントで、`memories` を主キーで引かないプランになっていた。**この直しに合わせて、`searchMany()` も含めた切り替えの仕組み自体を変えた**: ADR 0362 が採った「統計あり・無しの2形を1本の SQL の中に並べ、`pg_class.reltuples` の One-Time Filter で切り替える」やり方は、`search()` に同じやり方を適用して固く測り直したところ、統計がある場面（N=200・アンカー3）で `recall()` の前後差の中央値が **+5.06ms** となり、許容線（2ms）を大きく超えた。代わりに、`PostgresVectorStore` インスタンスが表ごとに「統計あり（`reltuples >= 0`）を一度確認した」ことを覚え（`PgvectorCapabilityGate`（ADR 0367）と同じ形の仕組み、`StatsPresenceGate`）、確認済みになったあとは**今の main の SQL を1バイトも変えずに**送るようにした——未確認の間だけ `reltuples` を読む往復が1回余分に掛かる。`search()`/`searchMany()` はこの1つの仕組みを共有する。状態はインスタンス・表ごとで、テナントごとには持たない（テナントを変えても確認済みの状態は共有される）。統計が後で消えても（`TRUNCATE`・表の作り直し）確認し直さない——結果は変わらず、遅くなりうるだけ（引き受けた負債、詳細は ADR 0374）。統計ありの `recall()` 全体を、`search()`/`searchMany()` の両方について前後12往復以上交互に測り直し、N=200・N=3000 のどちらも前後差の中央値が2ms以内に収まり、N とともに伸びないことを確認した（詳細・生データは ADR 0374）。⭕ 非破壊（クエリの実行計画だけが変わる。結果・型は変わらない）。クローン miku の判断であり、オーナーの判断ではない。
- **`@mnemora/postgres` の `probeTrigramLexicalSupport`（`PostgresTrigramLexicalStore.create` が内部で呼ぶ）は、`pg_trgm` を `CREATE EXTENSION` するとき `SCHEMA` を指定していなかった**（[Issue #1256](https://github.com/takecchi/mnemora/issues/1256)、[PR #1405](https://github.com/takecchi/mnemora/pull/1405)、[ADR 0366](./docs/decisions/0366-trigram-extension-follows-vector-schema.md)）——`pg_trgm` は接続の `search_path` の先頭（専用スキーマの構成では、最初に probe した名前空間）に入り、`runMigrations` が必須の拡張を入れる `extensionSchema`（既定 `public`）には入らなかった。⚠ **新しく作る DB では挙動が変わる**: `vector` 拡張（`runMigrations` が `extensionSchema` に入れたもの）のスキーマを読み、そこへ `WITH SCHEMA` で合わせて `pg_trgm` を入れるようにした——専用スキーマの構成では、どの名前空間から probe しても `pg_trgm` は `extensionSchema` に入り、全ての名前空間から見える。`schema` を渡さない既定の構成では、`vector` が `search_path` の先頭のスキーマに在る限り、発行する `CREATE EXTENSION` の SQL 文字列は1バイトも変わらない（⚠ 既定の構成でも `vector` を先頭以外のスキーマ——拡張専用のスキーマなど——に置いていれば、`pg_trgm` は今までの先頭のスキーマではなく `vector` と同じスキーマに入る）。⚠ **既に別の名前空間へ `pg_trgm` が入ってしまっている DB（このバグが直る前に作られた DB）では、2つ目以降の名前空間は、今まで `word_similarity` が見えない素の DB の例外（`42883`）で落ちていたのが、新しい理由 `"extension_not_visible"` を持つ `{ ok: false, reason, detail }`（`detail` は拡張が実際に入っているスキーマ名。`create()` は `TrigramLexicalStoreUnavailableError`）に変わる**——落ちること自体は変わらないが、分類できる形になる。⚠ **直すには、拡張の権限を持つロールで `ALTER EXTENSION pg_trgm SET SCHEMA <extensionSchema>` を実行する**（`pg_trgm` は自動では移さない）。
  ⚠ 非破壊と数える（公開の union `TrigramLexicalUnavailableReason` に値を1つ足しただけ——union に値を足す変更は破壊的変更として数えない、オーナーの回答（ask_human `d9364c91`）、[`docs/migration-v1.md`](./docs/migration-v1.md)「数え方の規律への追記（2026-09-28）」。既に `pg_trgm` が `extensionSchema`（または共有スキーマ）に入っている DB は影響を受けない。クローン miku の判断であり、オーナーの判断ではない）。
- **`Runtime.consolidate()`・`reflect()` は、統合先・内省の記憶に材料（eligible）の有効期間（`validFrom`/`validUntil`）を引き継がず、常に両方 `null`（「いつでも真」）で作っていた**（[Issue #1188](https://github.com/takecchi/mnemora/issues/1188) 残り、[PR #1407](https://github.com/takecchi/mnemora/pull/1407)、[ADR 0368](./docs/decisions/0368-consolidate-reflect-validity-intersection.md)）——`consolidate()`・`reflect()` とも、有効期間の外にある記憶を材料にしない側は PR #1383/#1388 で先に直っていたが（上の2項目）、統合先・内省の記憶自体が期限の無い `active` な記憶として `recall()` に残り続ける側は Issue #1188 のコメントで「残っているもの」2として開いたままだった。統合先・内省の記憶は、材料の区間の**積**（`validFrom` は材料の `validFrom` の最大値、`validUntil` は材料の `validUntil` の最小値）を持つようになった——統合・反芻した本文は材料すべての主張を含むので、どれか1つの元の記憶の期限が切れた時点で本文の一部が偽になるため。材料が全部両方 `null` なら、結果も両方 `null`（今までの振る舞いのまま）。**窓（受け入れる。ADR 0368 決定2）**: 材料を選ぶ時刻と、統合先・内省の記憶を記録する時刻（`recordedAt`）は別の `clock.now()` 呼び出しで、間に LLM 呼び出しが挟まる。その間に材料の `validUntil` の最小値を過ぎると、新しい記憶は**作った時点で既に期限切れの `active` な記憶**になる——正しい状態として受け入れる。**代償（`consolidate` 側だけ。ADR 0368 決定3）**: 期限の無い記憶 F と将来の期限を持つ記憶 E を統合すると、統合先は E の期限を持ち、F は他の統合元と同じく `superseded` になるので、期限後は F 由来の内容も `recall()` に出なくなる（F 自身の行は superseded として残り、消えはしない）。今の「期限切れの主張が期限の無い記憶として永久に recall へ戻り続ける」より害が小さいと判断した——`reflect()` は材料を `superseded` にしないので、この代償は無い。
  ⭕ 非破壊と数える（`Memory.validFrom`/`validUntil` は既に公開されている `Date | null` の省略可能な欄であり、型は1バイトも変わらない。`buildConsolidatedMemory`/`buildReflectedMemory`（`BuildConsolidatedMemoryParams`/`BuildReflectedMemoryParams` を含む）は `@mnemora/core` の公開 API（`index.ts` の `export * from "./strategies/consolidate.js"`/`"./strategies/reflect.js"`）に出ているが、シグネチャ（引数の型・返り値の型 `NewMemory`）は1バイトも変えていない——積を計算する関数 `intersectValidity` は `index.ts` から出さない内部のファイル（`validity.ts`）に置いたので、公開 API の差分は無い（`pnpm run api:check` の snapshot は main と同じ）。変わるのは、統合先・内省の記憶が `validFrom`/`validUntil` に持つ値だけである。クローン miku の委譲先の判断であり、オーナーの判断ではない）。
- **`Runtime.observe()` の claim key の衝突検出（opt-in、`ClaimKeyOptions.detectContested`）は、1回の `observe()` が同じ claim key の複数候補を生んだとき、その兄弟どうしを互いの検出時点で `MemoryStore.findActiveByClaimKey?` の一致に混入させていた**（[Issue #835](https://github.com/takecchi/mnemora/issues/835)、[PR #1424](https://github.com/takecchi/mnemora/pull/1424)、[ADR 0377](./docs/decisions/0377-claim-key-contested-detection-excludes-same-observation-siblings.md)。原因は ADR 0347（PR #1318）が抽出の書き込みを「全件書く→全件について検出」の2ループへ分けた副作用）——(a) 1回の `observe()` が同じ claim key の2件を生むと、互いが誤って `contested` になっていた（例: 「去年は札幌で働いていた。今年は福岡で働いている。」）。(b) 先行 observe が作った Memory M1 が在るとき、後続の1回の `observe()` が同じ claim key の2件（訂正の新値と旧値の言い直し）を生むと、一致が2件に膨らんで `markContested` が一度も呼ばれず、M1 が訂正されたことを検出できなかった（退行。記録の再生で訂正 4/4 → 2/4 に落ちていた）。`Runtime.detectClaimKeyContested`（`@mnemora/core`）は、`findActiveByClaimKey?` が返した一致から、検出中の Memory と同じ `sourceObservationId`（`null` は除外しない）を持つものを、件数を数える前に除くようになった。`MemoryStore` の型・`@mnemora/postgres`・`@mnemora/testkit` の実装は変えていない。
  ⚠ **失うもの**: 1つの発話の中の言い直し（例:「金曜じゃなくて水曜」）が抽出で2件の候補に分かれ、たまたま同じ claim key に当たる場合も、今後は互いに `contested` にならない（意図して受け入れた——ADR 0377「失うもの」。測定対象14件では実際に該当するケースは無いことを確認した）。**語彙ヒントの吸い寄せによる誤検出（`unknown-favorite-number` のような、別 observation どうしの対）は今回は塞いでいない**（ADR 0377「効かないもの」、語彙ヒントに下限を置く案は訂正と誤検出を分けられず見送った）。
  ⭕ 非破壊と数える（`ContestedDetectionOutcome`・`ObserveResult` の型は変わらない。既定経路（`detectContested` を渡さない・`false`）の振る舞いは1バイトも変わらない。opt-in の検出結果——`matchCount`・`contested`/`no_conflict`/`unresolved_conflict` の分岐——だけが変わる。クローン miku の委譲先の判断であり、オーナーの判断ではない）。

---

## [1.0.2] - 2026-09-27

**この節は `v1.0.1`（tag が指す `cf11cd6`）… `v1.0.2`（tag が指す `b981ecd`、PR #1098）の差分である。**オーナーは 2026-09-27T01:58:27Z に Release `v1.0.2` を作り、npm へも公開した（`@mnemora/core` の `dist-tags.latest` が `1.0.2`、2026-09-27T02:05:56Z 公開）。**両端が tag で閉じたので、この節の範囲はもう動かない。**

⚠ **2026-09-27 に、`## [1.1.0]` 節（当時は「`v1.0.1` からの未リリースの差分」を名乗っていた）から移した。**下の項目の本文と計上の経緯（`dce0f71` の判定・追記〜追記3）は、`v1.0.2` の出荷より前に、未リリースの差分として書かれたものであり、移すときに書き換えていない。どの項目がこの版に入ったかは、その変更を入れた PR のマージコミットが `v1.0.2` の祖先かどうかで、項目ごとに決めた。追記3の範囲（`e15033a`…`3a8448c`）は `v1.0.2` を跨ぐが、`b981ecd` より後の PR #1100・#1102・#1103 は docs・テストだけで、この節の項目は無い。

**計上を保留していた項目も、この版に入って出荷された**——公開の fixture が不正な入力に新しく例外を投げるもの（オーナーへの問い `3f3411c5` の射程。下の各項目に ⚠ で印がある）: PR #923・#928（Issue #880・#807・#817・#816）・PR #1058・PR #1059・PR #1061・PR #1073・PR #1095。⛔ **オーナーがこれらを破壊的変更と数えたかどうかは、ここには書かない**——どう判断してこの版を出したかは、記録から分からない。問い `3f3411c5` は未回答のままである。

**postgres 利用者へ**: `v1.0.1` から新しいマイグレーションが1本増えている
（`0022_embedding_zero_norm_index.sql`、Issue #956 / ADR 0343）。⟹ `v1.0.1` から
この節までの範囲へ上げる場合は `pnpm --filter @mnemora/postgres run migrate` が要る。
**`v1.0.0` から直接この節までの範囲へ上げる場合は、下の `## [1.0.1]` 節の migrate 案内も
合わせて読むこと**（`0019`〜`0022` の4本が要る）。

**この節が数えた範囲（`v1.0.1`…`dce0f71`）に破壊的変更は無い。**【実測 2026-09-26】
`git diff v1.0.1..dce0f71 -- scripts/__snapshots__/public-api/` の削除行は、`RecallQuery.association`
の型を `| null` へ広げたこと（PR #838）と、`TrigramLexicalStoreUnavailableError` の constructor に
任意の第3引数 `options?: ErrorOptions` を足したこと（PR #908）に伴う再フォーマットのみであり、削除・必須化・型の
狭小化は無い。`### Breaking` の節は無い。

**⚠ 2026-09-27 追記（破壊的変更の判定を `951ad44` まで広げた）**: 上の「破壊的変更は無い」は `dce0f71` までを、公開 API の型の差分だけで判定したものである。`docs/migration-v1.md` の定義は「型検査**または実行時**に壊れる変更」なので、`951ad44` まで広げて実行時の変化も当てた。型の差分は追加だけで、削除・必須化・型の狭小化は無い。実行時の変化は次の2種類に分かれる。

- 🔴 **計上を保留しているもの**（下の各項目に ⚠ で印を付けた）: 公開の fixture が、これまで受け入れていた不正な入力に新しく例外を投げるもの（オーナーへの問い `3f3411c5` の射程）——`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` が Postgres の拒む入力を拒むようになった件（Issue #880・#807・#817・#816、PR #923・#928）。下の `[1.0.1]` 節が保留にしている PR #811/#813/#815 と同じ論点であり（[Issue #809](https://github.com/takecchi/mnemora/issues/809)）、破壊的変更として扱うかはオーナーへの問い（ask_human `3f3411c5`「testkit の擬似ストアが不正な引数で新しくエラーを投げるようになった件を、破壊的変更として扱うか」、未回答）として未決である。**どの見出しからも外さず、保留の注記を付けて置く。**
  ⚠ **2026-09-27 訂正（クローン miku の判断。オーナーの判断ではない）**: この基準は当初「公開の場所が、これまで受け入れていた不正な入力に新しく例外を投げる、または公開の fixture の結果が変わるもの」と書いていた。問い `3f3411c5` が問うているのは PR #811/#813/#815 の「新しくエラーを投げるようになった」件だけであり、「結果が変わる」は判断（新しく投げるものは保留、投げなくなるものは非破壊）を写すときに広がった言い回しだったので、上のとおり狭めた。⟹ 例外を投げず結果だけが変わる fixture の変更（`InMemoryLexicalStore` の一致判定を Postgres に揃えた件、Issue #951 ほか。下の追記2）は、非破壊の Fixed として数える。`LocalEmbeddingProvider.embed()` の有限性の検査（Issue #992）は非破壊と数える（クローン miku の判断。オーナーの判断ではない）——有限でないベクトルを返すのはもともと `EmbeddingProvider` の約束（有限のベクトルを返す）に反した出力であり、それを黙って返すのをやめてその場で失敗として伝える修正で、公開の振る舞いの約束は変えていない。問い `3f3411c5` の射程（testkit の fixture が、それまで受け入れていた不正な入力を拒むようになった件）とも別物である。
- ⭕ **非破壊と数えたもの**（下の各項目に ⚠ で注意を添えた）: `LocalEmbeddingProvider.embed()` の有限性の検査（Issue #992。上の訂正、クローン miku の判断。オーナーの判断ではない）と、例外を投げなくなった修正——forget/restoreArchived/purge（Issue #964、PR #960）、接続断でプロセスが落ちなくなった件（Issue #859）、空ベクトル・次元違いのベクトルで reject しなくなった件（Issue #862・#915）、`closePostgresClient` の2回目を reject しなくなった件（Issue #935）。どれも doc が約束していた振る舞いへ実装を合わせたもので、約束の範囲内の利用者は壊れない。**この判定はクローン miku の判断であり、オーナーの判断ではない**（覆りうる）。

⟹ **この節の範囲（`v1.0.1`…`951ad44`）で、確定した破壊的変更は無い（上の保留を除く）。**

**⚠ 2026-09-27 追記2（2回目の棚卸し。`e15033a` まで広げた）**: `951ad44`…`e15033a` に `main` へ入った PR を全部当てた。出荷される6パッケージの利用者に見える変更は、どれもこの節に載っている（PR 番号か、その PR が閉じた Issue 番号で受けている）。型の差分は追加だけで、`@mnemora/postgres` の公開関数 `buildLexicalSearchSelect`/`buildTrigramLexicalSearchSelect` に任意の `ctxTenantId?` が増えたことと、引数名の変更（`_ctx` → `ctx`）だけである。実行時の変化は次のとおり分けた。

- 🔴 **計上を保留しているもの**: `@mnemora/testkit/fixtures` の `InMemoryMemoryStore.requeueEmbedJobs` が、Postgres の拒む `limit`（負数・`NaN`・`Infinity`・非整数・2^63 以上）で例外を投げるようになった件（PR #1058）、`InMemoryOutboxStore.claimBatch` がリースの境界時刻が `Date` にならない `leaseMs`（`NaN`・`±Infinity`・範囲外）で例外を投げるようになった件（PR #1059）、擬似 store が bigint に収まらない `limit`（2^63 以上）で例外を投げるようになった件（PR #1061）、擬似 `MemoryStore` が Observation の欄（`subjectId`・`externalId`・`kind`・`payload`・`attributes`）と `createMemory` の `attributes`・`provenance` の NUL で例外を投げるようになった件（PR #1073。この棚卸しの範囲 `e15033a` より後に入るが、同じ基準「公開の fixture が不正な入力に新しく例外を投げるもの」に当たるので加えた）、`InMemoryMemoryStore` が float4 で 0 に丸まる `halfLifeHours`・`strength` で例外を投げるようになった件（PR #1095。同じく範囲の後に入るが、同じ基準に当たるので加えた）、`InMemoryTenantSettingsStore` の `setDefaultHalfLifeRecalls` が float4 で 0 に丸まる値で、`setDefaultHalfLifeHours` が float4 に収まらない値で例外を投げるようになった件（PR #1165。同じく範囲の後に入るが、同じ基準に当たるので加えた）。上の前書きの保留と同じ問い `3f3411c5` の答えを待つ。
- ⭕ **非破壊と数えたもの**: 例外を投げず、公開の fixture の結果だけが変わるもの——`search` の3口が `ctx.tenantId` でも絞るようになった件（Issue #1050、PR #1056。`ctx` と `filter.tenantId` が食い違う呼び出しは空を返す）。上の訂正で狭めた基準により、この節のそれより前の範囲にある同じ種類の変更（`InMemoryLexicalStore` の一致判定 Issue #951・同点の並び順 PR #875・クエリの上限 PR #919、`InMemoryMemoryStore.listLabels?` の並び順 PR #906、`InMemoryVectorStore` の次元違いの距離 PR #915・距離 `NaN` の候補の位置 PR #985、`InMemoryOutboxStore` の終端の付いた行への `complete`/`fail` PR #830）も非破壊の Fixed として数える（クローン miku の判断）。ほかに、`PostgresVectorStore.search`/`searchMany` が有限でない成分を含むクエリで例外を投げず比較不能として扱うようになった修正（PR #1069。例外を投げなくなった側）、`recall()` のクエリ埋め込みが `[]` のとき `embedding_provider_unavailable` を積むようになった修正（PR #1068）、`PostgresOutboxStore.fail` が `error` の NUL で例外を投げなくなった修正（PR #1060。例外を投げなくなった側）、`timestamptz` の読み（Issue #1039）と書き（Issue #1040）のずれの修正、purge 後に埋め込みを残さない修正（Issue #1035）、`recall()` の `omitted` の二重計上の修正（Issue #1019・#1020・#1026）、`0022` がビューで止まらなくなった修正（Issue #1038）。どれも誤った値・誤った件数を返していたものを直したもので、公開の fixture の結果も、新しい例外も伴わない。 あわせて、`@mnemora/openai`・`@mnemora/anthropic` の adapter が、HTTP ヘッダに載せられない API キー（途中に CR・LF・NUL など）を構築時にキーを含まない例外で拒むようになった件（Issue #1080。この棚卸しの範囲 `e15033a` より後に入る）も非破壊と数える——新しく例外を投げるが、fixture ではなく本物の adapter で、もともと一度も送れない値を送る前に拒むだけであり、正しく動いていた利用者の振る舞いは変わらない（Issue #992 と同じ扱い。**クローン miku の判断であり、オーナーの判断ではない**）。 あわせて、`Runtime.reextract` が使用報告の Observation（`kind: "usage"`）に、存在しない Observation と同じ種類の `Error` を投げるようになった件（Issue #1099。この棚卸しの範囲 `e15033a` より後に入る）も非破壊と数える——新しく例外を投げるが、以前の振る舞い（使用報告の payload の JSON を本文とする `stated` の記憶を作る）は一度も正しく動いたことが無い（Issue #992・#1080 と同じ扱い。**クローン miku の判断であり、オーナーの判断ではない**）。 あわせて、`@mnemora/testkit/fixtures` の `InMemoryMemoryStore.listActiveClaimPredicates` が主語か述語の片方が欠けた claim key を数えなくなった件（PR #1106。この棚卸しの範囲 `e15033a` より後に入る）も非破壊の Fixed と数える——例外を投げず、公開の fixture の結果（一覧に `undefined` が混ざらない）だけが変わる（**クローン miku の判断であり、オーナーの判断ではない**）。 あわせて、`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` が返す Memory を返す時点の複製にした件（Issue #1108。この棚卸しの範囲 `e15033a` より後に入る）も非破壊の Fixed と数える——例外を投げず、公開の fixture の結果（受け取った値が後から書き換わらない）だけが変わる（**クローン miku の判断であり、オーナーの判断ではない**）。 同じく、`@mnemora/testkit/fixtures` の InMemory 一式が Memory 以外の値（Observation・イベント・outbox ジョブ・ラベル・recall 記録・ベクトル・Date）も返す時点・書き込む時点の複製でやり取りするようにした件（Issue #1108 の続き）も非破壊の Fixed と数える（**クローン miku の判断であり、オーナーの判断ではない**）。 あわせて、LLM が返した tags の空白だけの要素を捨てるようにした件も非破壊の Fixed と数える——例外を投げず、書かれる tags と proposed ラベルだけが変わる（**クローン miku の判断であり、オーナーの判断ではない**）。 同じく、`@mnemora/local-embedding` の読み込み失敗のメッセージがキャッシュの破損と消す場所を名指すようにした件も非破壊の Fixed と数える——例外の種類も投げる条件も変えず、文面だけが変わる（**クローン miku の判断であり、オーナーの判断ではない**）。 同じく、`@mnemora/openai` が根が object でないスキーマを包んで送る・`oneOf` を `anyOf` にするようにした件も非破壊の Fixed と数える——例外を新しく投げず、根が object でないスキーマの送る形・読む形だけが変わる（**クローン miku の判断であり、オーナーの判断ではない**）。

⟹ **この節の範囲（`v1.0.1`…`e15033a`）で、確定した破壊的変更は無い（上の保留を除く）。**

**⚠ 2026-09-27 追記3（3回目の棚卸し。`3a8448c` まで広げた）**: `e15033a`…`3a8448c` に `main` へ入った PR を全部当てた。出荷される6パッケージの利用者に見える変更は、どれもこの節に載っている（PR 番号か、その PR が閉じた Issue 番号で受けている）。公開 API の型の差分は無い。実行時の変化の分け方は上の追記2の一覧に入っている——保留は PR #1073・#1095（公開の fixture が不正な入力に新しく例外を投げる）、非破壊は Issue #1080（PR #1083。一度も正しく送れなかった API キーを、本物の adapter が構築時にキーを含まない例外で早く拒む）。PR #1086・#1087 は結果を変えない往復数の修正である。棚卸しで直したもの: PR #1061 の項目が PR #923 の項目の文の途中に割り込んでいたのを、PR #923 の項目の後ろへ移した。PR #1058・#1059・#1061・#1073 の項目に PR 番号を足した。

⟹ **この節の範囲（`v1.0.1`…`3a8448c`）で、確定した破壊的変更は無い（上の保留を除く）。**

### Added

- **`RecalledMemory` に任意欄 `contestedWith?: MemoryId` を足した**——矛盾する2件が
  同伴取得（`retrievedVia: 'mandatory_companion'`、`companionOf`）を経由せず、
  `"ann"`/`"lexical"` で両方とも自然に候補に入った場合にも、相手の memoryId を返す
  （`companionOf` の意味は無変更）。相手が budget 切り詰め後の最終的な結果集合に
  含まれるときだけ付く（オーナーの決定、ask_human 327fd89b /
  [Issue #691](https://github.com/takecchi/mnemora/issues/691) /
  [ADR 0335](./docs/decisions/0335-recalled-memory-contested-with.md)、PR #832）。
  ⭕ `RecallRecordMemory`（`recalls.returned_memories` への永続化）は変更していない
  （ADR 0335「引き受けた負債」参照）。
- **`RuntimeDeps` に任意欄 `embeddingInput?: (memory: Memory) => string` を足した**——
  埋め込み入力の上限超過で `embeddingStatus: 'failed'` になった Memory を、`reembed()`
  （ADR 0079）だけでは回復できなかった問題に、opt-in の回復手段を用意する。省略時は
  `memory.content` をそのまま送る従来どおりの挙動（`Memory.content` 自体はどちらの場合も
  無変更）（[Issue #753](https://github.com/takecchi/mnemora/issues/753) /
  [ADR 0336](./docs/decisions/0336-embedding-input-opt-in-hook.md)、PR #834）。
- **`Runtime.resolveOrphanedContested?(ctx, survivorId, opts?)` を足した**（任意メソッド。
  `createRuntime()` が返す実装には必ず在る）——`markContested` で対にした2件の片側を
  `forget()` すると、生存側が `contested`・`contestedWithId` が対向を指したまま残り、
  既存の `resolveContested`（ADR 0150）では解消できなくなっていた（対向がもう `contested`
  ではないため、決定3の CAS を満たせない）。この口は生存側1件だけを対象にした別の任意
  メソッドで、`resolveContested`/`MemoryStore.resolveContestedPair` の挙動は変えていない。
  `MemoryStore.resolveOrphanedContested?` も任意メソッド
  （フォールバック無し）として3実装（`@mnemora/postgres`/`@mnemora/testkit`/
  `@mnemora/core` の Fake）に揃えた（[Issue #825](https://github.com/takecchi/mnemora/issues/825) /
  [ADR 0150](./docs/decisions/0150-resolve-contested-explicit-operation.md) 追記 /
  [ADR 0087](./docs/decisions/0087-runtime-forget-shape.md) 追記、PR #914）。
- **`RecallResult.explain.stages` の `budget_truncation` の任意 `detail` に
  `droppedFitsWhenConcatenated?: boolean` を足した**——`omitted.kind: 'budget_dropped'`
  が発生したときだけ現れ、落ちた分も含めた全候補の digest を連結して1回だけ数えた量
  （`usage.share` の分子と同じ数え方）が実は予算に収まっていたかどうかを表す。段4の
  切り詰め判定は digest ごとに `Math.ceil` するため、件数が多い digest ほど丸めの
  積み重ねで「予算に余りがあるのに落とす」ことがある——**切り詰めの判定・落とす件数・
  `omitted` は変えていない**（ふるまいは無変更、`detail` は `Record<string, unknown>` の
  任意欄なので公開の型も変えていない）（[Issue #829](https://github.com/takecchi/mnemora/issues/829)、
  [ADR 0097](./docs/decisions/0097-recall-usage-share-may-exceed-1.md) 追記 2026-09-26、PR #915）。
- **`ObserveMemoryUsageInput`（`observe({ kind: 'memory_usage', ... })`）に他3種
  （utterance/event/document）と同じ任意欄 `externalId?: string` を足した**——
  `observations` 行の冪等化（テナント内一意、再送は同じ Observation を返す）が
  `memory_usage` にも構造的に効くようになった（以前は `handleMemoryUsage` が
  `externalId: null` を固定で渡しており、同じ使用報告を再送するたびに `observations`
  行が増え続けていた。`recall_usages`/`reinforce` 自体は元から冪等）。省略時の挙動は
  無変更。マイグレーションは無し——`0001_init.sql` の `uq_observations_external_id` は
  元から kind を問わない一意制約だった（[Issue #870](https://github.com/takecchi/mnemora/issues/870) /
  [ADR 0009](./docs/decisions/0009-usage-feedback-via-observe.md) 追記、PR #913）。
- **`MemoryStore` に任意メソッド `reinforceMany?` を足した**——`observe({kind:
  'memory_usage'})` の `recordUsage → reinforce` ループが使用報告1件ごとに直列に往復し
  （N+1）、報告件数に比例して往復数が増えていた問題（1回の呼び出しで `1 + 2N` 往復）を、
  この口があるときだけ1回の呼び出しに束ねる。`runtime.ts` の `handleMemoryUsage` は
  `reinforceMany` が在ればそれを使い、無ければ従来どおり `reinforce` を1件ずつ呼ぶ
  ——既存の `MemoryStore` 実装（第三者 adapter を含む）の挙動は1バイトも変えない。
  `PostgresMemoryStore.reinforceMany` は件数によらず定数2往復（[Issue #874](https://github.com/takecchi/mnemora/issues/874) /
  [ADR 0303](./docs/decisions/0303-superseded-contested-decay-floor-owner.md) 追記節、PR #917）。
- **`RecalledMemory` に任意欄 `basisLost?: true` を足した**——`provenanceKind === 'inferred'`
  で、かつその根拠（`basis.memoryIds`）の少なくとも1件が失われている（存在しない・
  `status === 'forgotten'`・`purgedAt` が非 `null`）ときだけ `true` を返す
  （docs/memory-model.md §2 が約束していた「根拠を失った推論に印を付けて返す」の実装）。
  `basis` の中身（`memoryIds`/`observationIds`）は返さない——それ以外はキー自体を出さない。
  `MemoryStore` の interface は変えていない（既存の `getMany` だけを使う。recall 1回あたり
  最大+1往復）（[Issue #883](https://github.com/takecchi/mnemora/issues/883) /
  [ADR 0342](./docs/decisions/0342-recalled-memory-basis-lost.md)）。

- **`VectorStore` に任意メソッド `searchMany?` を足した**——連想枠（段3.5）がアンカーごとに
  `search()` を1回ずつ呼んでいた往復（`anchorCount` に比例して増えていた）を、実装した
  adapter では1回の往復に束ねられるようにする。`PostgresVectorStore` に実装済み。
  未実装の adapter では従来どおりアンカーごとの `search()` 呼び出しに戻り、結果（集合・
  順序）は変わらない。**破壊的変更ではない**——公開 API の実 diff は `searchMany?` の
  追加のみ（Refs [Issue #377](https://github.com/takecchi/mnemora/issues/377) /
  [ADR 0151](./docs/decisions/0151-recall-association-unprompted.md) 追記）。

### Changed（後方互換だが挙動が変わりうるもの）

- 🔴 **既定の挙動の変更: 連想枠（`RecallQuery.association`、段3.5）の既定が off から on に
  変わった。** `association` を省略した呼び出しは、`DEFAULT_RECALL_ASSOCIATION`
  （`{ maxCount: 10 }`、新設 export）を使って連想が走るようになる——**クエリに直接は
  当たらなかったが、クエリで引けた記憶（アンカー）の近傍として引いた候補
  （`retrievedVia: "association"`）が、`association` を渡さない呼び出しでも
  `RecallResult.memories` に混ざりうる。**`RecallUsage.byTier.association` も、
  `association` を渡したかどうかに関わらず、連想が実際に走った呼び出しには現れる
  ようになる（[0.5.0] の逐語「**既定 off なので、`association` を渡していない呼び手は
  1バイトも影響を受けない。**」との対比——この節ではもう成り立たない）。
  **従来どおり連想を一切走らせたい呼び出しは `association: null` を明示的に渡す**
  （`undefined` ＝省略＝既定値適用、`null` ＝明示 off、という新しい区別。型は
  `RecallQuery.association?: RecallAssociationQuery | null` に広がった）。
  **破壊的変更ではない**——公開 API の実 diff は、この入力型が `| null` に広がったことと
  `DEFAULT_RECALL_ASSOCIATION` が1つ増えたことだけで、既存の呼び出しは型検査上そのまま
  通る（[docs/migration-v1.md](./docs/migration-v1.md) の破壊的変更の定義「公開契約について、
  既存の利用者のコードが型検査または実行時に壊れる変更」に照らした判定。前例として
  `RecallQuery.validAt` ゲートを既定で有効にした際も同様に非破壊と判定している）。
  （Issue #337 のオーナー決定（ask_human ac5953d1、2026-09-25T21:11Z、選択肢「あ」）／
  [ADR 0337](./docs/decisions/0337-recall-association-default-on.md)、PR #838）。
- ロケールが `C` ではない Postgres（既定の照合順序が `C` 以外の DB、例: `en_US.utf8`）を
  使っている場合、`MemoryStore.listLabels?`（`PostgresMemoryStore`）が返す配列の並び順が
  変わりうる——`name` の**コードポイント順**（`COLLATE "C"` と同じ、バイト順）を明示する
  ように直した（修正前は DB の既定の照合順序に従っていた）。`FakeMemoryStore`/
  `InMemoryMemoryStore` も同じ順序（`localeCompare` ではなくコードポイント比較）に揃えた
  （Closes [Issue #881](https://github.com/takecchi/mnemora/issues/881) /
  [ADR 0318](./docs/decisions/0318-taxonomy-labels.md) 追記、PR #906）。
- **語彙検索（`PostgresLexicalStore`/`PostgresTrigramLexicalStore`、`InMemoryLexicalStore`、
  `FakeLexicalStore`）で使うクエリの、異なる語の数（`LEXICAL_QUERY_MAX_DISTINCT_WORDS` = 32）・
  1語あたりの文字数（`LEXICAL_QUERY_MAX_WORD_CHARS` = 64、trigram の日本語側は
  `TRIGRAM_JAPANESE_QUERY_MAX_CHARS` = 100）・クエリ全体の文字数
  （`LEXICAL_QUERY_MAX_TOTAL_CHARS` = 600）に上限を設けた**
  （[Issue #878](https://github.com/takecchi/mnemora/issues/878)、
  [ADR 0092](./docs/decisions/0092-lexical-or-coverage.md) 追記節）。

### Fixed

- **`runtime.restoreSuperseded()` は、戻した群の強化を1件ずつ呼んでいたため、群が1件増えるごとに DB の往復が増えていた**（Postgres で群 2 / 6 / 21 件に 6 / 14 / 44 往復）——群の復帰そのものは SQL 1本である。`MemoryStore.reinforceMany?` が在れば1回に束ねる（使用報告を Issue #874 で束ねたのと同じ形）。束ねた強化が失敗したら1件ずつに戻るので、強化の失敗が失敗した要素の `reinforceError` にだけ入る約束は変わらない（[PR #1087](https://github.com/takecchi/mnemora/pull/1087)）。
- **`@mnemora/postgres` の claimKey の2つの SQL が `idx_memories_claim_key` を `subject_id` まで使えていなかった**——`listActiveClaimPredicates` は Seq Scan（別テナントを含む表全体の走査）で、`knownPredicatesFromStore` を有効にすると observe のたびに呼ばれていた。`findActiveByClaimKey` は `subject_id` を索引の条件に使えず、同じ claim key を持つ全 subject の行を読んでいた。`subject_id IS NOT DISTINCT FROM` を同じ意味の `subject_id = $n` / `subject_id IS NULL` に分け、部分索引の述語 `claim_key_subject IS NOT NULL` を WHERE に足した（結果は変わらない）（[PR #1086](https://github.com/takecchi/mnemora/pull/1086)）。
- **`@mnemora/postgres` の `PostgresVectorStore.search` / `searchMany` は、クエリベクトルに有限でない成分（`NaN`・`Infinity`）があると、pgvector の拒否で未捕捉の `DrizzleQueryError` を投げていた**——埋め込み provider がクエリ埋め込みにそうした値を返すと、`runtime.recall()` 自体が reject された。次元違いのクエリ（Issue #867 の案B）と同じく「比較不能」として扱い、`score_not_comparable` に数えるようにした。core の Fake と testkit の `InMemoryVectorStore` は以前からこの振る舞いである（[PR #1069](https://github.com/takecchi/mnemora/pull/1069)）。
  ⚠ doc が約束していた振る舞い（`search` は比較不能なクエリで例外を投げない）へ実装を合わせた修正であり、非破壊と数える（クローン miku の判断、上の前書き）。
- **`runtime.recall()` のクエリ埋め込みで、`EmbeddingProvider.embed` がベクトルを1件も返さない（`[]`）と、ANN の段を黙って飛ばしていた**——例外のときは `stage_skipped`（`candidate_generation` / `embedding_provider_unavailable`）を積むが、`[]` のときは omission に何も出ず、「ベクトル検索だけが止まった」ことが見えなかった。`docs/recall.md` の約束どおり、`[]` でも `embedding_provider_unavailable` を積むようにした（公開型は無変更）（[PR #1068](https://github.com/takecchi/mnemora/pull/1068)）。
- **`@mnemora/postgres` の `PostgresOutboxStore.fail` は、`error` に NUL（U+0000）が含まれていると `last_error` を書けずに例外を投げていた**——LLM の抽出結果の本文に NUL が入ると、失敗したクエリの params を含むエラー文が `lastError` に渡るため、`tick()` がその場で打ち切られ、そのジョブは終端に落ちないまま、リースが切れるたびに再び claim されて同じ所で落ちていた。NUL を目に見える `\u0000` に置き換えて書くようにした（[PR #1060](https://github.com/takecchi/mnemora/pull/1060)）。
  ⚠ doc が約束していた振る舞い（`tick()` は失敗を `failed` に数え、ジョブを終端に落とす）へ実装を合わせた修正であり、非破壊と数える（クローン miku の判断、上の前書き）。
- **`VectorStore.search` / `searchMany` と `LexicalStore.search`（`@mnemora/postgres` の vector・語彙・trigram の3実装と、`@mnemora/testkit/fixtures` の `InMemoryVectorStore` / `InMemoryLexicalStore`）は、テナントを `filter.tenantId` だけで絞り、`ctx.tenantId` を見ていなかった**——`ctx` と `filter.tenantId` に違うテナントを渡すと、`filter` 側のテナントの memoryId とスコアが返った（本文は返らない。runtime は常に同じ値を渡すので、runtime 経由では起きない）。隔離の境界は `ctx.tenantId` なので（ADR 0007）、両方で絞るようにした。食い違えば空を返し、例外は投げない。公開関数 `buildLexicalSearchSelect`/`buildTrigramLexicalSearchSelect` に、そのための任意の `ctxTenantId?` を足した（[Issue #1050](https://github.com/takecchi/mnemora/issues/1050)、PR #1056）。
- **`@mnemora/local-embedding` の `LocalEmbeddingProvider.embed()` は、返すベクトルの成分が有限かを確かめず、NaN / Infinity をそのまま返していた**（Issue #992）——pgvector への書き込みで初めて失敗していた。次元の検査と同じ位置で、有限でない成分があれば何番目かを名指しして例外にする。
  ⚠ 約束に反した出力（有限でない成分）を黙って返すのをやめた修正であり、非破壊と数える（クローン miku の判断。オーナーの判断ではない、上の前書きの訂正）。
- **`PostgresTrigramLexicalStore.search`（語彙の trigram 経路、opt-in、ADR 0319）が `filter.labels` を適用していなかった**——`recall({ labels })` の語彙チャンネルで、絞りの外の候補が over-fetch の窓を占め、絞りの内側の候補が窓から押し出されることがあった（最終結果からは後置フィルタで落ちるので、絞りの外の記憶が返ることは無い）。`PostgresLexicalStore`・`PostgresVectorStore` と同じ述語（`tags && labels`）を足した（ADR 0323 の追記、[PR #991](https://github.com/takecchi/mnemora/pull/991)）。
- **`tick()` がジョブの失敗を記録する outbox 行の `lastError` は `err.message` だけで、drizzle が包んだ DB の失敗では理由（pg のエラー文・SQLSTATE）が残らなかった**（Issue #969）——`cause` の連鎖を辿り、各段の `message` と `code` を連結して載せる。pg エラーの `detail` など利用者のデータが入りうる欄は載せない。
- **`tick()` の embed ジョブで、埋め込みの失敗を受けて `embeddingStatus: "failed"` を書く処理そのものが失敗すると、元の例外（なぜ埋め込めなかったか）が失われ、outbox 行の `lastError` には二次的な失敗しか残らなかった**（Issue #962 の前半）——元の例外を `cause` に残し、`lastError` にも両方を載せる。
- **`tick()` の embed ジョブが provider の応答を待っている間に `forget()` → `purge()` が完了すると、ジョブが purge 前の内容から作った埋め込みを purge の削除の後に書き、`"purged"` を返した記憶の埋め込みが残っていた**（Issue #1035）——埋め込みを書いた後に記憶を読み直し、purge 済みなら書いた埋め込みを消す（ADR 0124 の追記）。
- **`@mnemora/postgres` は、`timestamptz` の値によっては `Date` として読めず、`get()` などが Invalid Date を返していた**（Issue #1039）——対象は、秒を含む時差（サーバの `TimeZone` が Asia/Tokyo なら1888年より前）・紀元前・1万年以降の日時。これらの形も読めるようにした。書き込み側のずれ（Issue #1040）と表現できる範囲の違い（Issue #1041）は、この修正の外である。
- **`@mnemora/postgres` は、プロセスの TZ が Asia/Tokyo などのとき、古い日時を数秒ずらして保存していた**（Issue #1040）——node-postgres が `Date` をプロセスのローカル時刻で送り、時差の秒を切り捨てるため。Asia/Tokyo では1888年より前の日時が59秒後へ、America/New_York では1883年11月より前が2秒前へずれていた。`occurredAt` / `validFrom` / `validUntil` などの書き込みも、`occurredAfter` / `validAt` / `since` などの条件も、`Date` を UTC の文字列にしてから渡すようにした（紀元前・1万年以降も同じ形で送る）。プロセス全体の `pg` の既定は変えていない。すでにずれて保存された値は直さない。
- **`observe({kind:'memory_usage'})` が使用の記録（`recall_usages`）の後・強化の前で落ちると、同じ `externalId` で再送しても強化されなかった**（Issue #961）——`MemoryStore` に任意メソッド `recordUsageAndReinforce?` を足し（`PostgresMemoryStore` と testkit の `InMemoryMemoryStore` が実装）、在れば記録と強化を1トランザクションで撃つ。口を持たない adapter は従来の2段のまま（ADR 0009 の追記）。
- **`runtime.forget()` / `runtime.restoreArchived()` / `runtime.purge()` は、ループ前の読み（`MemoryStore.getMany`、`restoreArchived` では活動時計の読みも）が失敗すると例外をそのまま外へ投げていた**（Issue #964）——doc コメントの「例外はこのメソッドの外へは投げない」どおり、1件目を `failed`、残りを `not_attempted` にして返すようにした（まだ1件も書いていない）。
  ⚠ doc が約束していた振る舞いへ実装を合わせた修正であり、非破壊と数える（クローン miku の判断、上の前書き）。約束に反して例外（reject）を catch することに頼っていたコードは、例外が来なくなるぶん挙動が変わる。
- **`runtime.forget()` / `runtime.restoreArchived()` / `runtime.purge()` は、compare-and-swap が破れた後の1回だけの再読（`MemoryStore.get`）が失敗すると、その例外をそのまま外へ投げていた**——doc コメントの「例外はこのメソッドの外へは投げない」に反し、同じ呼び出しで先に確定した要素（`forgotten`/`restored`/`purged`）の outcome まで呼び出し側から見えなくなっていた。再読の失敗も他の「競合以外の例外」と同じく、その要素を `failed`、残りを `not_attempted` にして返すようにした（[PR #960](https://github.com/takecchi/mnemora/pull/960)）。
  ⚠ doc が約束していた振る舞いへ実装を合わせた修正であり、非破壊と数える（クローン miku の判断、上の前書き）。約束に反して例外（reject）を catch することに頼っていたコードは、例外が来なくなるぶん挙動が変わる。
- **`runtime.recall()` が、段2で `limit` を超えて `omitted`（`over_limit(stage:"rescore")`）
  へ落とした記憶を、段3.5（連想、既定 on、ADR 0337）が `RecallResult.memories` へ
  `retrievedVia: "association"` として昇格させた場合でも、同じ記憶を `over_limit` の
  `count` にそのまま数え続けていた**（PR #922 が段3の必須同伴取得経由について塞いだのと
  同型の矛盾。段3.5 経由はそのとき意図的に対象外にしていた）。差し引く対象を「`overLimit`
  に居て、かつ段3の必須同伴取得または段3.5の連想のどちらかで実際に `finalMemories` に
  返った id」へ広げ、0件になった Omission は既存の作法どおり配列から取り除くようにした
  （`memories` の中身・公開型はどちらも無変更）
  （[Issue #925](https://github.com/takecchi/mnemora/issues/925)、
  [ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md) 追記2 2026-09-26）。
- **上と同じ `over_limit(stage:"rescore")` の取り下げ処理が、段3/段3.5 で候補集合に戻った
  記憶が段4の予算切り詰めで改めて落ちた場合には発火せず、同じ記憶が `over_limit` と
  `budget_dropped` の両方に数えられていた**（取り下げの条件が「戻った先で実際に
  `memories` へ返ったか」を課していたため）。判定を「`companions`/段3.5が席を埋めた
  候補に居るか」だけに絞り、戻った先の最終的な去就は問わないようにした——1件の記憶は
  `omitted` の中で最後に落とした段でだけ数えられる（`memories`・公開型はどちらも無変更）
  （[Issue #940](https://github.com/takecchi/mnemora/issues/940)、
  [ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md) 追記3 2026-09-26）。
- **`over_limit(stage:"rescore")` の候補が段3.5（連想）の候補プールに入ったが席に
  着けなかった（過取得の窓の外、または `rankedCandidates` には居たが `maxCount` の
  席を他候補に取られた）場合、その候補は `over_limit(stage:"rescore")` からも
  差し引かれず、段3.5 自身が積む `over_limit(stage:"association")` にも数えられ、
  同じ1件が両方に計上されていた**（上の Issue #940 の取り下げは、候補集合に
  実際に戻った——`companions`/`associationUnits` に入った——場合だけを対象にしており、
  席に着けなかった場合は対象外だった）。差し引く対象に (c)
  「`over_limit(stage:"association")` に実際に数えられたか」を OR で足した——
  `over_limit(stage:"association")` は段2より後の段なので、この経路は
  `over_limit(stage:"rescore")` から差し引かれ `over_limit(stage:"association")` に
  1回だけ残る。`over_limit(stage:"association")` 自身の count・`memories`・公開型は
  どれも無変更
  （[Issue #949](https://github.com/takecchi/mnemora/issues/949)、
  [ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md) 追記4 2026-09-26）。
- **`runtime.recall()` で、段2で `score_not_comparable` に数えた候補（ゼロベクトルの埋め込みなど）が段3（必須の同伴取得）か段3.5（連想）で戻ると、`memories`（または `budget_dropped`）と `score_not_comparable` の両方に数えられていた**——戻った先でだけ数え、`score_not_comparable` の件数からは外すようにした（公開型は無変更）（[Issue #1019](https://github.com/takecchi/mnemora/issues/1019)、[ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md) 追記7 2026-09-27）。
- **`runtime.recall()` で、段2で `over_limit(stage:"rescore")`（または `below_threshold`・`score_not_comparable`）に数えた contested の候補を段3.5（連想枠）が席に着け、対向が取れずに Unit ごと落ちると、段2の札と `unit_assembly_dropped` の両方に数えられていた**——`unit_assembly_dropped` でだけ数えるようにした（公開型は無変更）（[Issue #1026](https://github.com/takecchi/mnemora/issues/1026)、[ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md) 追記8 の補足 2026-09-27）。
- **`runtime.recall()` の段3.5（連想枠）で、席を競り負けて `over_limit(stage:"association")` に数えた候補が、同じ段3.5 の必須の同伴取得（Issue #959）で対向として取られると、`memories`（または `budget_dropped`）と `over_limit(stage:"association")` の両方に数えられていた**——戻った先でだけ数えるようにした（公開型は無変更）（[Issue #1020](https://github.com/takecchi/mnemora/issues/1020)、[ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md) 追記8 2026-09-27）。
- **`runtime.recall()` で、段2の `below_threshold` の候補が段3.5（連想）の候補プールで席に着けなかったとき、`below_threshold` と `over_limit(stage:"association")` の両方に数えられていた**——`over_limit(stage:"association")` 側だけに数え、`below_threshold` の `count`・`nearMisses` からは外すようにした（公開型は無変更）（[Issue #984](https://github.com/takecchi/mnemora/issues/984)、[ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md) 追記6 2026-09-27）。
- **`runtime.recall()` で、段2の `below_threshold` の候補が段3（必須の同伴取得）か段3.5（連想）で戻り、段4の予算で落ちると、`below_threshold` と `budget_dropped` の両方に数えられていた**——`budget_dropped` 側だけに数え、`below_threshold` の `count`・`nearMisses` からは外すようにした（公開型は無変更）（[Issue #950](https://github.com/takecchi/mnemora/issues/950)、[ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md) 追記5 2026-09-27）。
- **`PostgresLexicalStore.search`（語彙検索）の、大きな入力での性能を改善した。**
  検索結果（順位・スコア）は変えていない（[Issue #878](https://github.com/takecchi/mnemora/issues/878)）。
- **`runMigrations`/`registerEmbeddingSpace` が、マイグレーション実行中に DB 側の接続を
  失う（DB の再起動・フェイルオーバー・運用者による手動切断・OOM kill 等）と、Node
  プロセス全体が uncaught exception で落ちていた。** `pool.connect()` で借り切った
  checked-out client に `error` リスナーを付けていなかったため——`pg` はこれを要求して
  いる（付けないと Node の `EventEmitter` の既定動作でそのまま投げる）。捕まった場合も、
  `catch` 節の `ROLLBACK` 自体が失敗し、`migrate.ts` が約束する
  `'migration <file> failed: ...'` ではなく素の接続断メッセージへ上書きされていた。
  空の `error` リスナーを付け、`ROLLBACK` の二次失敗で一次失敗を上書きしないようにした
  ——利用者が既存 DB を抱えたまま `mnemora-postgres-migrate` を実行する運用（v1.0.0/
  v1.0.1 の利用者がまさにこれに当たる）で、途中の接続断がプロセスのクラッシュではなく
  catchable な `Error` として観測できるようになる（[ADR 0339](./docs/decisions/0339-checked-out-client-error-listener.md)、
  [ADR 0020](./docs/decisions/0020-temp-database-drain-before-drop.md) とは別の話——
  自傷ではなく外部要因による接続断であり、握り潰す対象は無い。PR #859）。
  ⚠ doc が約束していた振る舞いへ実装を合わせた修正であり、非破壊と数える（クローン miku の判断、上の前書き）。約束に反して例外（reject）を catch することに頼っていたコードは、例外が来なくなるぶん挙動が変わる。
- **`runtime.tick()` が、`consolidate`/`reflect` の自動ジョブで LLM 呼び出しが失敗しても、
  そのジョブを「処理成功」として数えていた。** `processConsolidateJob`/`processReflectJob`
  は `consolidate()`/`reflect()` の戻り値（LLM 失敗時は `outcome: "llm_failed"` を返す——
  例外は投げない、ADR 0089 の公開の約束）を見ずに `complete()` を呼んでいたため、LLM が
  完全に落ちたジョブも `TickResult.processed` に数えられ、outbox 行も完了のまま残っていた。
  戻り値を見て `llm_failed` を例外に変え、`tick()` の既存の `fail()` 経路に乗せるようにした
  ——**LLM が失敗したとき、`TickResult` で `processed` ではなく `failed` に数えられるように
  なり、outbox の行は完了ではなく終端の失敗で残る。監視で `failed` を数えている利用者には
  数が増えて見える。** 終端後の自動リトライは足していない（Phase 1 の `OutboxStore` 契約
  どおり）。`consolidate()`/`reflect()` を直接呼ぶ同期 API の契約は無変更
  （[Issue #849](https://github.com/takecchi/mnemora/issues/849) /
  [ADR 0157](./docs/decisions/0157-tick-drives-consolidate-and-reflect.md) 決定2 追記、PR #852）。
- **`@mnemora/core` の `decay.ts`（`defaultDecayStrategy.floorAt`/`defaultActivityDecayStrategy.floorAt`）が、
  ADR 0125/`isHalfLifeRecallsInRange` の値域 `(0, ∞)`（`Infinity` のみ拒む）の内側にある、
  有限だが巨大な `halfLifeHours`/`halfLifeRecalls` で壊れていた。** 壁時計側は `new Date` の
  表現可能域（`±8.64e15ms`）を超えて Invalid Date を返し、`decayFloorAt > now` が常に
  `false` になるため「ほぼ永久に減衰しない」つもりの設定が「作成直後から忘却済み」に
  逆転していた。活動時計側は `decay_floor_seq`（Postgres `bigint`）へ `Number.MAX_SAFE_INTEGER`
  を超える精度の無い値を静かに書いていた。どちらも表現可能な上限へ丸めるようにした
  （新しい例外は投げない）（PR #845）。
- **`@mnemora/core` の `deriveClaimKeys`（`claim-key.ts`）が、LLM の壊れた出力
  （`subject`/`predicate` が空白だけ）を空文字列の claim key としてそのまま返していた。**
  `ClaimKeySchema` の `min(1)` は空白だけの値を素通りするため、正規化（NFKC→trim→小文字化）
  後に空文字列へ潰れることがあり、無関係な複数の Memory が同じ「空の鍵」で誤って一致し、
  `detectClaimKeyContested` が的外れに `contested` を立てていた。正規化後に `subject`/
  `predicate` のどちらかが空文字列になった要素は、鍵が取れなかったもの（`null`）として
  扱うようにした（新しい例外は投げない）（PR #846）。
- **`@mnemora/postgres` で、2つの接続から同時に呼んだときに壊れる3件を直した**（PR #839）。①`restoreSupersededBy` と `forget` が同じ記憶に並行して走ると、forget 済みの行が active に戻り、`unsuperseded` イベントも積まれていた。UPDATE の条件に `status='superseded'` を足し、interface の約束どおりにした。②③`markContestedPair`／`resolveContestedPair` を (A,B) と (B,A) で並行して呼ぶとデッドロックになり、生の Postgres 例外（40P01）が出ていた。行を id 順にロックするようにしたので、後から来た側は約束どおり `MemoryStatusConflictError` になる。
- **`OutboxStore.complete`/`fail` の CAS（ADR 0142）が `attempts` の一致しか見ておらず、
  相手側の終端列（`completed_at`/`failed_at`）を見ていなかった。** 同じ `attempts` のまま
  complete → fail を呼ぶと（逐次でも、本物の Postgres の2接続からの並行でも）、両方の
  終端が付く矛盾した状態を作れた。先に付いた終端を勝たせるようにした——相手側の終端が
  既に付いていれば、後から来た `complete`/`fail` は行を変えず例外も投げない
  （[Issue #826](https://github.com/takecchi/mnemora/issues/826)、PR #830）。
  ⭕ **公開型は変えていない**——`attempts` 不一致の `OutboxLeaseConflictError` と行が
  無い場合の no-op、同種の再呼び出し（complete+complete、fail+fail）の冪等な挙動は
  すべて既存どおり。
- **自動経路（`RuntimeConfig.autoQueueConsolidateReflectOnExtract: true` のときに `tick()` が
  処理する `reflect` ジョブ、`processReflectJob`）が、`consolidate` 側の同種の修正
  （下の `[1.0.1]` 節の PR #733 の項目）と違い直っておらず、subject をまたいで反映し、反映結果の
  `Memory.subjectId` が `null` に畳まれることがあった。** `tick()` は `reflect` ジョブを
  subject で絞って claim できないため、`tick()` に渡した `ctx.subjectId` と種の `subjectId`
  が食い違うと、近傍探索が種と別の subject から候補を拾っていた。`processReflectJob` は、
  `processConsolidateJob` と同じ形に直した——種の Memory の `subjectId` を `ctx.subjectId` に
  置いてから `reflect()` を呼ぶ。種が見つからない、または種の `subjectId` が `null` の場合は
  今日どおり（[Issue #820](https://github.com/takecchi/mnemora/issues/820) /
  [ADR 0317](./docs/decisions/0317-auto-consolidate-scopes-neighbor-search-to-seed-subject.md)
  追記、PR #851）。
  ⭕ **公開型は変えていない**——`autoQueueConsolidateReflectOnExtract` の既定（`false`）の
  利用者には何も起きない。migration も不要。
  ⚠ **フラグを有効にしている利用者から見ると挙動が変わる**——subject をまたぐ反映が
  構造的に起きなくなる。
  明示的な `runtime.reflect(ctx, { target: { seedMemoryId } })` の呼び出しは変えていない。
- **`packDigestBand`（`packages/core/src/digest-band.ts`）に `limit`/`maxChars` として `NaN` を
  渡すと、`NaN` を含む比較が常に false になるため打ち切り条件が一度も成立せず、件数・
  文字数の上限が黙って無制限に化けていた**（負数を渡すと逆に安全側へ倒れるのと対照的）。
  `NaN` だけを負数と同じ安全側（既に上限に達している扱い）に倒した。`+Infinity` は
  「上限なし」として意味が通るため今の挙動のまま（新しい例外は投げない）
  （[Issue #803](https://github.com/takecchi/mnemora/issues/803)、PR #853）。
- **`truncateForFallbackDigest`（`observe()` の digest フォールバック、`extraction.ts`）と
  `packDigestBand`（`recall()` の目次帯、`digest-band.ts`）が、切り詰め位置が UTF-16
  サロゲートペア（絵文字等、2コードユニットの文字）の内側に落ちたとき、対になる片方を
  失った孤立サロゲートを残していた。** 孤立サロゲートは JS の文字列としては保持できるが、
  UTF-8 へエンコードする経路（`packages/postgres` が `content`/`digest` 列へ書き込む際の
  node-postgres のエンコード）で静かに U+FFFD（置換文字）へ壊れる——切り詰めという安全弁
  自身が、切り詰めていない部分よりも先にデータを壊していた。共通の
  `sliceWithoutSplittingSurrogatePair`（`text-truncation.ts`。`@mnemora/core` の公開 API には出さない内部関数）へ切り出し、
  切り詰め位置がペアの内側なら1文字手前に丸めるようにした（新しい例外は投げない。
  ペアの外側で切れる場合は1バイトも挙動が変わらない）（PR #858）。
- **`@mnemora/postgres` の `PostgresVectorStore.search` が、`RecallQuery.vector: []`
  （空配列）を渡すと未捕捉の `DrizzleQueryError`（`vector must have at least 1
  dimension`）で `runtime.recall()` ごと reject していた。** Fake（`@mnemora/testkit`
  の `InMemoryVectorStore`）は短い方の配列を0で zero-pad する実装の副作用で空配列を
  ゼロベクトルとして扱い、ADR 0040 の経路で正常完走していたため、同じ入力に対して
  adapter ごとに別の答えが出ていた。空配列のときだけ embedding space の次元数ぶんの
  全0ベクトルに置き換え、Postgres を Fake の実際の挙動に揃えた（新しい例外は投げない。
  次元数が0以外だが空間の次元数と食い違う `vector` は今回の修正範囲外・未検証）
  （[Issue #857](https://github.com/takecchi/mnemora/issues/857)、PR #862）。
  ⚠ doc が約束していた振る舞いへ実装を合わせた修正であり、非破壊と数える（クローン miku の判断、上の前書き）。約束に反して例外（reject）を catch することに頼っていたコードは、例外が来なくなるぶん挙動が変わる。
- **`runMigrations`（専用スキーマ、feat/dedicated-schema・ADR 0057）が、PostgreSQL の
  完全予約語と一致するスキーマ名（`user` 等——`assertSafeSchemaName` は文字種と長さしか
  見ないため、これも通ってしまう）で構文エラーになっていた。** `SET LOCAL search_path
  TO ...` にスキーマ名を引用符無しで埋め込んでいたのが原因——`CREATE SCHEMA
  IF NOT EXISTS "<schema>"` 側は既に引用符を付けており無事だった。該当箇所だけ
  スキーマ名を二重引用符で囲むようにした（新しい例外は投げない。予約語ではない
  スキーマ名の挙動は無変更、`searchPathFor` 自体の公開契約も無変更）
  （[ADR 0341](./docs/decisions/0341-quote-search-path-in-set-local.md)、PR #877）。
- **`@mnemora/testkit` の `InMemoryLexicalStore.search`（擬似 `LexicalStore`）で、
  `coverage`/`rank` が完全一致したヒットの順序を、挿入順から Postgres と同じ4段
  tie-break（`coverage` → `rank` → `recordedAt` DESC → `memoryId` 昇順）に揃えた。**
  `LexicalStore.search` の interface doc（Issue #345 / ADR 0175）は、同点でも決定的な
  順序を返すことを adapter の責務として明記し、`PostgresLexicalStore`/
  `PostgresTrigramLexicalStore` の4段 tie-break を模範として名指ししているが、擬似物は
  これまで `coverage`/`rank` の2段止まりで、同点の中身は `Array.prototype.sort` の
  安定性により挿入順（通常の呼び出し順では `recordedAt` の古い方が先）に落ちており、
  Postgres の「新しい方が先」とは逆向きだった——`InMemoryVectorStore.search` に
  Issue #339 / ADR 0170 で入れた tie-break（下の `[1.0.1]` 節の項目）と同じ形の食い違いが、語彙チャンネル側
  にだけ残っていた。返す形（`{ memoryId, coverage, rank }`）は変えていない
  （PR #875）。
- **`mnemora-postgres-migrate` の `--help`/`-h` が、同じ argv に壊れた引数（値の無い
  `--schema`・未知のオプション等）が混じっていると、help を表示せず `ok: false`（終了コード
  1・エラーメッセージ）で止まっていた。** `parseMigrateCliOptions`（`src/bin/cli-options.ts`）
  自身の doc コメントは「`--help` はどんな組み合わせでも他の解釈をせず即座に返す（ヘルプ
  表示に徹する）」と明記しており、実装がその約束を守っていなかった——`--help`/`-h` を
  ループの中で見つけて `continue` する形だったため、それより後ろに置かれた壊れた引数の
  解析が先に `ok: false` を返してしまっていた。argv 全体を他の一切の解析より前に走査し、
  `--help`/`-h` が1つでもあれば即座に `{ help: true }` を返すようにした（新しい例外は
  投げない。`--help`/`-h` を含まない argv の既存の解決順序・エラーメッセージは無変更）
  （PR #887）。
- **`PostgresTrigramLexicalStore.create()` が投げる `TrigramLexicalStoreUnavailableError`
  が、`CREATE EXTENSION IF NOT EXISTS pg_trgm` の失敗（`reason: "extension_create_denied"`/
  `"extension_create_failed"`）で元の Postgres エラーオブジェクトを一切保持しておらず、
  `.cause` を辿って元の `.stack`・`.code`（SQLSTATE）を調べる手段が無かった。**
  `probeTrigramLexicalSupport` の内部実体が元のエラーを持ち回り、`create()` がそれを
  `TrigramLexicalStoreUnavailableError` の新しい第3引数 `options?: ErrorOptions` へ渡す
  ようにした（既存の2引数の呼び出しは無変更で動く）。公開の `probeTrigramLexicalSupport`
  の戻り値の形は変えていない（`cause` は漏れない）。他の3つの reason
  （`server_encoding_not_utf8`/`extension_unavailable`/`locale_no_japanese_trigrams`）は
  そもそも Postgres のエラーオブジェクトを持たない値ベースの判定であり対象外
  （[Issue #892](https://github.com/takecchi/mnemora/issues/892)、PR #908）。
- **`RecallQuery.vector` の長さが対象の空間の `dimensions` と違う（かつ空配列でもない）
  とき、`@mnemora/postgres` は未捕捉の `DrizzleQueryError`（`different vector dimensions`）
  で `runtime.recall()` ごと reject し、`@mnemora/testkit`/`@mnemora/core` の Fake は
  足りない側を0で埋めて計算を続け、意味の無い実数の距離を普通のヒットとして返していた
  （`omitted` にも何も残らない）。** 長さの不一致を「比較不能」として扱うようにした——
  Postgres は次元不一致のクエリを embedding space の次元数ぶんの全0ベクトルへ置き換え
  （[Issue #857](https://github.com/takecchi/mnemora/issues/857) / PR #862 が空配列に
  対して足した経路の拡張）、Fake の `cosineDistance` は比較する2本の長さが違う時点で
  `NaN` を返すようにした。どちらも ADR 0040 の既存の経路（`NaN` は候補を落とさず、
  `recall()` の段2が `omitted.score_not_comparable` に数える）にそのまま乗る
  （新しい例外は投げない。`VectorStore.upsert` に長さの違うベクトルを渡したときの
  扱いは今回の修正範囲外・未検証）（[Issue #867](https://github.com/takecchi/mnemora/issues/867)、
  [ADR 0040](./docs/decisions/0040-zero-vector-never-returned.md) 追記 2026-09-26、PR #915）。
  ⚠ doc が約束していた振る舞いへ実装を合わせた修正であり、非破壊と数える（クローン miku の判断、上の前書き）。約束に反して例外（reject）を catch することに頼っていたコードは、例外が来なくなるぶん挙動が変わる。
- **`runtime.recall()` が、段2で `limit` を超えて `omitted`（`over_limit(stage:"rescore")`）
  へ落とした記憶を、段3（必須の同伴取得）が `RecallResult.memories` へ昇格させた場合でも、
  同じ記憶を `over_limit` の `count` にそのまま数え続けていた**（below_threshold で
  ADR 0203 が塞いだのと同型の矛盾、「返したのに落ちたと名乗る」）。段3で実際に昇格した分
  だけ `count` から差し引き、0件になった Omission は below_threshold と同じ作法で配列
  から取り除くようにした（`memories` の中身・公開型はどちらも無変更）
  （[Issue #823](https://github.com/takecchi/mnemora/issues/823)、
  [ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md) 追記 2026-09-26）。
- **`runMigrations`/`registerEmbeddingSpace` の `schema` オプション省略時、接続ロール名と
  同じ名前のスキーマが DB に在ると（PostgreSQL の既定 `search_path` `"$user", public` により
  `"$user"` がそちらへ解決される）、advisory lock のキーが `schema: "<ロール名>"` を明示
  指定した別の呼び出しと食い違い、互いを待たなかった。** ロック取得より前に同じ接続で
  `SELECT current_schema()` を読み、その結果を既存の `migrationLockKeyFor`/
  `registerEmbeddingSpaceLockKeyFor` へ渡すようにした——両関数のシグネチャ・戻り値・
  `schema` が `public` のときの既定キーは無変更（新しい例外は投げない。データの
  読み書き先は search_path の意味どおりで変えていない）
  （[Issue #779](https://github.com/takecchi/mnemora/issues/779)、
  [ADR 0331](./docs/decisions/0331-extension-creation-shared-advisory-lock.md) 追記
  2026-09-26）。
- **`InMemoryMemoryStore.archiveDecayed`（`@mnemora/testkit` の擬似 `MemoryStore`）が
  `opts.limit` に負数・`NaN`・`Infinity`・非整数を渡されても例外を投げず、`.slice(0,
  Math.max(0, opts.limit))` の丸めに従って実際に書き込みまで行っていた。** `limit:
  Infinity` は対象を無条件に全件 `archived` にし、`limit: 1.5` は1件だけ `archived` に
  していた——このメソッドは書き込みの副作用（`status` を `archived` にし、`archived`
  イベントを積む）を持つ口であるため、他の口（`OutboxStore.claimBatch`・
  `VectorStore.search`・`LexicalStore.search`・`EventStore.list`・
  `MemoryStore.purgeExpiredEvents`・`aggregateScope` の `digestBand.limit`、下の
  `[1.0.1]` 節の PR #811/#813 相当）より実害が大きかった。`PostgresMemoryStore.archiveDecayed`
  と同じく、生 SQL の `LIMIT`（bigint パラメータ）が拒む入力をクエリの前に弾くように
  した（新しい正常系の挙動は変えていない）（[Issue #880](https://github.com/takecchi/mnemora/issues/880)、PR #923）。
  ⚠ **破壊的変更として扱うかは保留**（公開の fixture が不正な入力に新しく例外を投げる件。判断待ちの問いは上の前書きの保留の注記を参照）。
- **`@mnemora/testkit` の擬似 store が、bigint に収まらない `limit`（2^63 以上）を受け入れていた**——`claimBatch`・`VectorStore.search`・`LexicalStore.search`・`EventStore.list`・`purgeExpiredEvents`・`aggregateScope` の `digestBand.limit`・`archiveDecayed`。Postgres は同じ値を `LIMIT` の bigint パラメータとして拒む（`2 ** 63` は `out of range for type bigint`、`1e21` 以上は指数表記になり `invalid input syntax for type bigint`）。`Number.isInteger` を通るため、負数・`NaN`・`Infinity`・非整数のガード（PR #811/#813/#923）をすり抜けていた。書き込みを持つ `claimBatch`・`archiveDecayed` では対象を全件書き換えていた。同じ値をクエリの前に弾くようにした（2^63 未満の値の挙動は変えていない）（PR #1061）。
  ⚠ **破壊的変更として扱うかは保留**（公開の fixture が不正な入力に新しく例外を投げる件。判断待ちの問いは上の前書きの保留の注記を参照）。
- **`InMemoryOutboxStore.claimBatch`（`@mnemora/testkit` の擬似 `OutboxStore`）が、`leaseMs` に `NaN`・`±Infinity`・`Date` の範囲を超える値を渡されても例外を投げず、未 claim のジョブを claim していた**——`PostgresOutboxStore.claimBatch` は `now` と `new Date(now - leaseMs)` を `timestamptz` として送るため、どちらかが Invalid Date になると例外になる。同じ入力をクエリの前に弾くようにした（有限の `leaseMs` の挙動は変えていない）。`Date` としては有効でも Postgres の範囲を外れる値は揃えていない（Issue #1041）（PR #1059）。
  ⚠ **破壊的変更として扱うかは保留**（公開の fixture が不正な入力に新しく例外を投げる件。判断待ちの問いは上の前書きの保留の注記を参照）。
- **`InMemoryMemoryStore.requeueEmbedJobs`（`@mnemora/testkit` の擬似 `MemoryStore`）も、`opts.limit` に負数・`NaN`・`Infinity`・非整数・bigint に収まらない値（2^63 以上）を渡されると例外を投げず、`.slice(0, Math.max(0, opts.limit))` の丸めに従って積み直していた**——`archiveDecayed`（Issue #880）と同じ形が、この口に残っていた。`limit: Infinity` は対象を全件、`limit: 1.5` は1件、`embeddingStatus` を `pending` に戻して embed ジョブを積んでいた。`PostgresMemoryStore.requeueEmbedJobs` と同じく、生 SQL の `LIMIT`（bigint パラメータ）が拒む入力をクエリの前に弾くようにした（正常系の挙動は変えていない）（PR #1058）。
  ⚠ **破壊的変更として扱うかは保留**（公開の fixture が不正な入力に新しく例外を投げる件。判断待ちの問いは上の前書きの保留の注記を参照）。
- **`InMemoryMemoryStore`（`@mnemora/testkit` の擬似 `MemoryStore`）が、Observation を書く口（`createObservation`・`createObservationWithOutbox`）で NUL（U+0000）を含む値を受け入れていた**——`subjectId`・`externalId`・`kind`（Postgres の `text` 列）、`payload`（入れ子の値・キーも含む）・`attributes`（`jsonb` 列）。`createMemory` の `attributes`・`provenance`（`jsonb` 列）も同じだった。Postgres はどれも例外にする（Issue #816 の NUL 側のうち、PR #923/#928 が扱っていなかった欄）。同じ値を書き込みの前に弾くようにした。孤立サロゲートは扱っていない（PR #1073）。
  ⚠ **破壊的変更として扱うかは保留**（公開の fixture が不正な入力に新しく例外を投げる件。判断待ちの問いは上の前書きの保留の注記を参照）。
- **`InMemoryMemoryStore`（`@mnemora/testkit` の擬似 `MemoryStore`）が、float4 で 0 に丸まる `halfLifeHours`・`strength`（例: `1e-300`・`strength: 1e-46`）を受け付けていた**——`memories.half_life_hours`・`strength` は Postgres の `real`（float4）列であり、`PostgresMemoryStore` は 0 でない値が 0 に丸まるとき `out of range for type real` で拒む。Issue #817（PR #923）が塞いだのは float4 の上側（`Infinity` へ丸まる）だけで、下側が残っていた。`createMemory`・`createMemoryWithOutbox` で同じく拒むようにした（境界は `Math.fround(x)` が 0 になるか。float4 の非正規数に収まる `1e-45` は受け付ける）（PR #1095）。
  ⚠ **破壊的変更として扱うかは保留**（公開の fixture が不正な入力に新しく例外を投げる件。判断待ちの問いは上の前書きの保留の注記を参照）。
- **`@mnemora/openai`・`@mnemora/anthropic` の adapter は、API キーの途中に CR・LF・NUL が入っていると、キー全体を含む例外をそのまま伝播していた**（Issue #1080）——Node の `fetch` がヘッダを組む段階で投げる例外文にキーが入り、`observe` の `extractionFailure.message` と outbox の `lastError`（Postgres では DB に保存される）に残っていた。adapter が SDK のクライアントを自分で作るとき（`client` を注入しないとき）、SDK が送るのと同じヘッダの値を構築時に確かめ、送れない値なら**キーを含まない**例外を投げるようにした。`fetch` が受け付ける値（末尾の空白・改行など）はこれまでどおり受け付ける。core 側で例外文を伏せ字にすることはしていない（#1064 と同じく方針の問い）。
  ⭕ 非破壊と数える（上の前書きの追記2を参照。クローン miku の判断であり、オーナーの判断ではない）。
- **`InMemoryMemoryStore.reinforce`（`@mnemora/testkit` の擬似 `MemoryStore`）に Invalid
  Date（`new Date(NaN)`）を渡すと、例外を投げず `lastReinforcedAt`/`decayFloorAt` に
  Invalid Date をそのまま書き込んで成功していた——以後その Memory の減衰計算が `NaN`
  を返し続ける。** `PostgresMemoryStore.reinforce` は同じ `at` を `timestamptz` 列へ
  そのまま書き込むため、Invalid Date は例外になる。同じ根本原因が及ぶ範囲を実測し、
  `createMemory` の `recordedAt`/`occurredAt`/`validFrom`/`validUntil` と、
  `EventStore.append`/`updateStatusWithEvent` 等イベントを積む口が共有する
  `at`（Postgres の `timestamptz` 列）もまとめて塞いだ（新しい正常系の挙動は変えて
  いない）（[Issue #807](https://github.com/takecchi/mnemora/issues/807)、PR #923）。
  ⚠ **破壊的変更として扱うかは保留**（公開の fixture が不正な入力に新しく例外を投げる件。判断待ちの問いは上の前書きの保留の注記を参照）。
- **`InMemoryMemoryStore.createMemory`（`@mnemora/testkit` の擬似 `MemoryStore`）が、
  `halfLifeHours` に float64 では有限だが Postgres の `real`（IEEE 754 単精度・float4、
  値域は約 `±3.4028235e38`）の範囲を超える値（例: `1e300`）を渡されても例外を投げず
  静かに受け入れていた。** `memories.half_life_hours` の `CHECK` 制約（値が `real` へ
  変換される際に `Infinity` へ丸まる、下の `[1.0.1]` 節の
  `setDefaultHalfLifeRecalls`（PR #815）と同根）と同じ `Math.fround` ベースの判定を
  足した（新しい正常系の挙動は変えていない。`strength` は値域 `(0, MAX_STRENGTH]` が
  float4 の範囲へ届かないため、既存の値域検査で既に拒まれており対象外）
  （[Issue #817](https://github.com/takecchi/mnemora/issues/817)、PR #923）。
  ⚠ **破壊的変更として扱うかは保留**（公開の fixture が不正な入力に新しく例外を投げる件。判断待ちの問いは上の前書きの保留の注記を参照）。
- **`InMemoryMemoryStore.createMemory`（`@mnemora/testkit` の擬似 `MemoryStore`）が、
  `content` に NUL 文字（`\u0000`）を含む文字列を渡されても例外を投げず静かに受け入れて
  いた。** Postgres の `text` 型は NUL バイトを構造的に拒む（C 文字列表現に由来する
  制約）ため、`PostgresMemoryStore.createMemory` は同じ入力に例外を投げる。この PR で
  塞ぐのは `content` のみ——`tenantId`（`ctx` を通じてほぼ全メソッドが共有する横断的な
  値）・`subjectId`・`tags`・`digest` 等の他の text 型フィールドにも同じ制約が及ぶことを
  実測したが、どこまで範囲を広げるかは製品判断が要ると判断し対象外にした。孤立サロゲート
  （`\uD800` 等）も対象外——Postgres 側（node-postgres が U+FFFD へ静かに置換する）の
  挙動に Fake をどちらへ寄せるかは別途の製品判断が要る
  （新しい正常系の挙動は変えていない）（[Issue #816](https://github.com/takecchi/mnemora/issues/816) NUL 側のみ、PR #923）。
  ⚠ **破壊的変更として扱うかは保留**（公開の fixture が不正な入力に新しく例外を投げる件。判断待ちの問いは上の前書きの保留の注記を参照）。
- **`InMemoryMemoryStore.createMemory`（`@mnemora/testkit`）/`FakeMemoryStore.createMemory`
  （`@mnemora/core`）が、上の PR #923 で塞ぎ残した `subjectId`・`tags`（各要素）・
  `digest` に NUL 文字（`\u0000`）を含む文字列を渡されても例外を投げず静かに受け入れて
  いた。** 実測すると `PostgresMemoryStore.createMemory` はこの3欄も `content` と同じ
  理由（Postgres の `text` 型が NUL バイトを構造的に拒む）・同じメッセージで例外を
  投げる対称な入力面だったため、`content` と揃えた。`tenantId` は引き続き対象外
  ——`ctx.tenantId` は `createMemory` 以外のほぼ全メソッドが個別に直接読む横断的な値で
  あり、両 Fake とも `ctx` を受ける共通の入口を持たないため、検査を足すには全メソッドへ
  の横展開が要る。孤立サロゲート（`\uD800` 等）も引き続き対象外——今の挙動（Postgres は
  node-postgres 経由で静かに U+FFFD へ置換、Fake はそのまま保持）を変えず、契約として
  `MemoryStore.createMemory` の doc コメントに記録した
  （新しい正常系の挙動は変えていない）（[Issue #816](https://github.com/takecchi/mnemora/issues/816)）。
  ⚠ **破壊的変更として扱うかは保留**（公開の fixture が不正な入力に新しく例外を投げる件。判断待ちの問いは上の前書きの保留の注記を参照）。
- **`@mnemora/postgres` の `closePostgresClient` を冪等にした**——2回目以降の呼び出しは `Called end on pool more than once` で reject せず、何もせずに resolve する（[Issue #935](https://github.com/takecchi/mnemora/issues/935)）。
  ⚠ doc が約束していた振る舞いへ実装を合わせた修正であり、非破壊と数える（クローン miku の判断、上の前書き）。約束に反して例外（reject）を catch することに頼っていたコードは、例外が来なくなるぶん挙動が変わる。
- **`runtime.recall()` の段2（`compareScoredCandidates`）と段3.5（連想）の2つの並べ替え
  （`associationHits.sort`・`rankedCandidates.sort`）が、候補の `total`/`similarity`/
  `rankKey` のいずれかが `NaN`（ADR 0040——ゼロベクトルの cosine 距離に由来）になると、
  その `NaN` な候補とは無関係な、他の有限な候補どうしの相対順序まで崩していた。**
  `b.field - a.field` を比較値にする素朴な降順比較は、`NaN` が混ざると比較関数の一貫性
  （推移律）を満たさなくなるため。`NaN` を必ず最後尾へ送る比較 helper に揃え、有限値
  どうしの大小関係・同点時の安定ソートの性質は変えていない（公開 API 無変更）
  （[Issue #938](https://github.com/takecchi/mnemora/issues/938)、
  [ADR 0040](./docs/decisions/0040-zero-vector-never-returned.md) 追記 2026-09-26）。
- **`@mnemora/testkit` の `InMemoryLexicalStore` の語の一致判定を `PostgresLexicalStore` に揃えた**——非 ASCII だけのクエリは0件になり、本文は ASCII の境界で分割してから小文字化する（[Issue #951](https://github.com/takecchi/mnemora/issues/951)、[ADR 0084](./docs/decisions/0084-lexical-recall-channel.md)）。
- **`@mnemora/testkit` の `InMemoryVectorStore.search` が、距離が `NaN` の候補（ゼロベクトル、ADR 0040）を `PostgresVectorStore` と同じく常に最後尾へ置くようにした**——以前は並べ替えの比較関数が `NaN` で一貫せず、その候補の位置が挿入順しだいで揺れ、limit 内の集合が Postgres と食い違うことがあった（[Issue #983](https://github.com/takecchi/mnemora/issues/983)、PR #985）。
- **`runtime.recall()` の段3.5（連想枠）が拾った `status: "contested"` の記憶が、対向（`contestedWithId`）を伴わない単独のまま `memories` に返り、`omitted` にも何も出ないことがあった**——段3（必須の同伴取得）と同じ規則を段3.5にも適用し、対向が取得できれば1つの Unit として一緒に返し、できなければ Unit ごと落として `unit_assembly_dropped` を積むようにした（`memories`/`omitted` の公開型は無変更）（[Issue #959](https://github.com/takecchi/mnemora/issues/959)、[ADR 0151](./docs/decisions/0151-recall-association-unprompted.md) 追記 2026-09-27）。
- **`PostgresVectorStore.search()`/`searchMany()` が、pgvector の HNSW（cosine）索引に
  そもそも入らないゼロベクトルの候補（ADR 0040）を取りこぼしていた。** 埋め込み
  テーブルに専用の部分索引を足し、別枝として `UNION ALL` で拾うようにした（往復数・
  通常の検索結果は無変更）（[Issue #956](https://github.com/takecchi/mnemora/issues/956)、
  [ADR 0343](./docs/decisions/0343-vector-store-search-returns-zero-norm-candidates.md)）。
  既存の空間にこの索引を作る `0022_embedding_zero_norm_index.sql` は、実テーブルだけを
  対象にする——同じスキーマに `memory_embeddings_` で始まるビューが在っても migration は
  止まらない（[Issue #1038](https://github.com/takecchi/mnemora/issues/1038)、ADR 0343 追記 2026-09-27）。

---

## [1.0.1] - 2026-09-25

**`v1.0.1` の tag（`cf11cd6`）は 2026-09-25T21:16:41Z に Release として切られ、npm へ公開されている**
（6パッケージとも `dist-tags.latest` が `1.0.1`。publish の CI run は success）。**この節は元々
`## [1.1.0] - 未リリース` に「`v1.0.0` からの未リリースの差分」として書かれていた項目のうち、
`v1.0.0` から `cf11cd6` までの分——既に `v1.0.1` として出荷済みだった分——を切り出したものである。**

**この節は `v1.0.0`…`v1.0.1`（`cf11cd6`）の差分を対象とする（両端とも tag で閉じている）。**

🔴 **この範囲は以前、`## [1.1.0]` 節が `v1.0.0` … `8cf82b1` を数えたと名乗っていたが、それは
偽だった。** `8cf82b1`（PR #728）へ pin を進めたのは PR #733 だったが、#733 は自分が足す
Fixed 1項目のために sha を書き換えただけで、`v1.0.0..8cf82b1` の間を実際には数え直していなかった
——`#684`/`#694`/`#703`/`#711`/`#724`/`#728` など、publish 対象パッケージに触れる PR が
未計上のまま残っていた。`v1.0.0` から `7987de4` までの PR を1本ずつ見て数え直したものが最初の
全数表である（載せる／載せないの理由は [PR #747](https://github.com/takecchi/mnemora/pull/747)
の本文）。2026-09-26 に `v1.0.0` … `747acaf` を改めて1本ずつ数え直し、計上漏れ（PR #792）を
足した（全数表は [PR #844](https://github.com/takecchi/mnemora/pull/844) の本文）。**その後、
`v1.0.1` が既にオーナーによって切られ npm へ公開されていたことが分かり、`v1.0.0` から
`cf11cd6`（`747acaf` より前）までの分をこの節として独立させた。**

🔴 **`v1.0.1` として出荷済みの範囲に、計上を保留しているものが在る。**PR #811 / #813 / #815
（`@mnemora/testkit/fixtures` の Fake が、これまで黙って受け入れていた不正な入力——負数・NaN・
Infinity・非整数の `limit`、float4 の範囲外の値——に対して例外を投げるようになった）。
型には現れないが、公開の Fake を直接使う外部の実装者には実行時に壊れうる。**破壊的変更として
扱うかは、この3件が `v1.0.1` として出荷された後もなお未決**なので
（[Issue #809](https://github.com/takecchi/mnemora/issues/809)）、**どの見出しにもまだ載せていない。**
⟹ **下の「破壊的変更は無い」は、この3件を除いた主張である。**

**この節が数えた範囲に破壊的変更は無い（上の保留3件を除く）。**【実測】`git diff v1.0.0..7987de4 --
scripts/__snapshots__/public-api/` の削除行は、すべて（a）zod スキーマの欄の並べ替え、
（b）`import type` 一覧への新しい型名の追加、（c）任意の末尾引数を足したことによる関数
シグネチャの再フォーマット、のいずれかであり、削除・必須化・型の狭小化は無かった
（`buildExtractionPrompt`/`extractCandidates`/`previewRestoreSupersededBy` はいずれも任意引数の
追加のみ）。⟹ **公開 API への影響は、任意の欄・任意の引数・任意のメソッド・新しい export の
追加のみである。**
【実測 2026-09-26】`git diff 7987de4..cf11cd6 -- scripts/__snapshots__/public-api/` の削除行も、
（c）に加えて、型を広げる変更（`supportsLabels`・`supportsFindActiveByClaimKey`・
`supportsTaxonomyMode` を必須から任意へ戻した、PR #827）だけであった。`### Breaking` の節は無い。

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。

**postgres 利用者へ**: 新しいマイグレーションが3本増えている
（`0019_observations_memories_attributes.sql` / `0020_taxonomy_labels.sql` /
`0021_memories_claim_key.sql`）。⟹ `v1.0.0` から上げるなら
`pnpm --filter @mnemora/postgres run migrate` が要る。

### Added

- **`restoreSuperseded`/`previewRestoreSupersededBy` に任意の `filter?: { onlyMemoryIds?:
  MemoryId[] }` を足し、1回の統合・訂正操作の単位まで戻す範囲を絞れるようにした**
  （`MemoryStoreConformanceOptions.supportsOnlyMemoryIdsFilter?` は既存必須8本と違い**任意**）。
  ⭕ 省略時は従来どおり群全体を戻す（[Issue #515](https://github.com/takecchi/mnemora/issues/515) /
  [ADR 0258](./docs/decisions/0258-restore-superseded-operation-scope.md)、PR #573）。
- **`@mnemora/testkit` に `describeLLMProviderConformance`（`LLMProvider` の適合テスト一式）を
  新設し、`@mnemora/openai`・`@mnemora/anthropic` の両方に当てた**——`@mnemora/anthropic` は
  publish 対象でありながらこれまで適合テストに1本も当たっていなかった
  （[Issue #389](https://github.com/takecchi/mnemora/issues/389) /
  [ADR 0266](./docs/decisions/0266-llm-provider-conformance.md)、PR #603）。
- **抽出候補（`ExtractedMemoryCandidateSchema`）に任意欄 `subjectId?: string | null` を足した**——
  1回の `observe()` から出る複数の Memory に、それぞれ違う主題を持たせられる。`undefined`
  （省略）＝未指定（従来どおり observation の主題へ）、明示的な `null`＝主題なしの明示
  （[Issue #608](https://github.com/takecchi/mnemora/issues/608) 項目① /
  [ADR 0271](./docs/decisions/0271-extraction-candidate-subject-id-overrides-observation.md)、
  PR #612）。
- **`ScoreBreakdown` に任意欄 `affinityMeasured?: boolean` を足した**——連想枠（段3.5）が
  affinity を測っていない状態で返した記憶かどうかを、`score.total` を比較する前に呼び手が
  見分けられるようにする（[Issue #548](https://github.com/takecchi/mnemora/issues/548) 方向1 /
  [ADR 0282](./docs/decisions/0282-score-breakdown-affinity-measured.md)、PR #642）。
  ⭕ 既存欄は型・名前・必須性とも無変更。
- **`@mnemora/local-embedding` の `LocalEmbeddingProviderOptions`/`LocalEmbeddingModelSpec` に
  任意欄 `revision?: string` を足し、`pipeline()` へ素通しするようにした**——モデルの repo・
  ミラーの汚染を固定の revision で予防できる
  （[Issue #597](https://github.com/takecchi/mnemora/issues/597)、PR #664）。
  ⭕ 省略時は既定（transformers.js の `"main"`）のまま。
- **`RecallQuery`/`RecallScope`/`VectorFilter`/`LexicalFilter` に任意欄
  `includeSubjectless?: boolean` を足した**——「subject X、または主題なし」を1回の `recall()`
  で引けるようにする（[Issue #608](https://github.com/takecchi/mnemora/issues/608) ③(b) /
  [ADR 0286](./docs/decisions/0286-recall-include-subjectless.md)、PR #679）。
  ⭕ 既定（省略・`false`）の挙動は無変更。
- **`observe` の入力に任意欄 `subjectCandidates?: string[]` を足し、抽出器に主題を候補一覧から
  選ばせられるようにした**——一覧に無い値は runtime が弾き、弾いた値を
  `ObserveResult.rejectedSubjectIds?` に返す
  （[Issue #608](https://github.com/takecchi/mnemora/issues/608) 項目②(b) /
  [ADR 0287](./docs/decisions/0287-extraction-subject-candidates-caller-supplied.md)、PR #680）。
  ⭕ 候補を渡さない呼び出しはプロンプト（カセット鍵）も挙動も無変更。
- **`AnnUnreachedOmission` に任意欄 `severity?: "info" | "warning"` を足した**——同じ `recall()`
  で ANN 窓が実際に到達可能な下限に届かなかったときだけ `"warning"`、構造的に鳴っているだけなら
  `"info"`。呼び手が構造的発火と実損の兆候を濾せるようにする
  （[Issue #361](https://github.com/takecchi/mnemora/issues/361) /
  [ADR 0288](./docs/decisions/0288-ann-unreached-severity.md)、PR #682）。
- **`RecalledMemory` に任意欄 `speaker?: string | null`・`subjectId?: string | null` を足した**——
  recall の場で誰が言ったか・誰との会話かが見えるようにする
  （Issue #579 案D /
  [ADR 0289](./docs/decisions/0289-recalled-memory-speaker-subject.md)、PR #684）。
- **観測（`observe`）に呼び手が渡す任意の `extractionContext`（保存した文脈と日時）を抽出へ
  渡せるようにした**——単独発話では失われる同意の対象・話者・相対日付を、同期・非同期・
  再抽出の経路すべてで同じ入力として使う。省略時は既存プロンプトのまま
  （Refs #689 /
  [ADR 0299](./docs/decisions/0299-extraction-context.md)、PR #694）。
  ⚠ 曖昧な参照・複雑な日時表現は未評価。既定経路の置換ではない。
- **`RecallQuery`/`ScoringInput` に任意欄 `timeWeighting?: "legacy" | "eventAwareFreshness"` を
  足した**——`"eventAwareFreshness"` を明示すると、`occurredAt` を持たない記憶（恒常的な事実・
  好み）の `freshness` を、記録時刻の古さで二重に減衰させなくなる。**省略時は `"legacy"` で
  既定の挙動は無変更**（[Issue #690](https://github.com/takecchi/mnemora/issues/690) /
  [ADR 0300](./docs/decisions/0300-time-weighting-policy-opt-in.md)、PR #697）。
  併せて `@mnemora/openai` の `OpenAILLMProviderOptions` に任意欄 `temperature?: number` を
  足した（純追加、既定は渡さない——既存呼び出しの挙動は無変更、PR #697）。
- **`RecalledMemory` に任意欄 `recordedAt?: Date`・`occurredAt?: Date | null` を足した**——
  回答生成側で「後で訂正された」を時点から読めるようにする下地
  （[Issue #702](https://github.com/takecchi/mnemora/issues/702) /
  [ADR 0298](./docs/decisions/0298-recalled-memory-recorded-occurred-at.md)、PR #703）。
- **`EmbeddingProvider` の契約に「上限超過は例外。黙って切り詰めたベクトルを返さない」を
  明記し、testkit 適合 suite に任意欄 `overLimitText?: string` を足した**——省略時は
  「測っていない」と `it.skip` で名乗る
  （[Issue #449](https://github.com/takecchi/mnemora/issues/449) /
  [ADR 0305](./docs/decisions/0305-embedding-provider-input-limit-contract.md)、PR #715）。
- **`@mnemora/testkit` に `SeededLLMProvider`/`SeededEmbeddingProvider` を足した**——「種
  カセット」から実 API を呼ばずに再生し、種に無い入力だけ実 API（delegate）へ渡す provider
  （記録そのものは別層が担う）
  （Issue #691 /
  [ADR 0309](./docs/decisions/0309-answer-prompt-order-legend-and-cassette-migration.md)、
  PR #716）。
- **`@mnemora/postgres` に taxonomy（`labels`/`memory_labels`）の保存・語彙側を足した（PR-A）**
  ——`tags` の書き込みから `proposed` ラベルを同一トランザクションで自動生成し、
  `MemoryStore.listLabels?`/`registerLabel?`（いずれも**任意**メソッド）・
  `TenantSettingsStore.getTaxonomyMode?`/`setTaxonomyMode?` で語彙を管理する。新しい migration
  `0020_taxonomy_labels.sql` を含む（[Issue #201](https://github.com/takecchi/mnemora/issues/201) /
  [ADR 0318](./docs/decisions/0318-taxonomy-labels.md)、PR #717）。
  ⭕ 既存の `tagMatch` 加点・`taxonomy_mode` に関わらないスコアリングは無変更。
- **`observe`/`recall` に呼び手専用の `attributes?: Record<string,string>` を足した**——
  公開範囲・区分などの、mnemora が解釈しない申告された属性を、段1（ANN・語彙）・段3.5から
  絞り込める。新しい migration `0019_observations_memories_attributes.sql` を含む
  （[Issue #152](https://github.com/takecchi/mnemora/issues/152)/
  [Issue #153](https://github.com/takecchi/mnemora/issues/153) /
  [ADR 0312](./docs/decisions/0312-observe-recall-caller-attributes.md)、PR #724）。
  ⭕ 絞り込みの挙動・既定値は無変更。⚠ **訂正**（初出時の記述は不正確だった）:
  `recall()` の返り値には常に `RecalledMemory.attributes` が載るようになる——`attributes`
  を渡さない呼び出しでも、対象の Memory が `attributes` を持たなくても欄自体は省略されない
  （詳細は下の `### Changed`）。
- **抽出に主張キー `claimKey: { subject, predicate }` を持たせた（(B) 第1段。既定 off・検出は
  まだしない）**——「この記憶は何についての主張か」を LLM に分類させて構造化された鍵として
  持たせるだけで、同じ鍵を持つ記憶どうしの衝突検出はこの段では行わない。新しい migration
  `0021_memories_claim_key.sql` を含む
  （[Issue #371](https://github.com/takecchi/mnemora/issues/371) /
  [ADR 0320](./docs/decisions/0320-claim-key-field-implementation.md)、PR #736）。
  ⚠ **訂正**（初出時の「既定 off」は値の導出だけを指しており、欄そのものの挙動を書いて
  いなかった）: 「既定 off」は LLM を呼んで値を導出する opt-in（`observe` の
  `claimKey?: ClaimKeyOptions`）についてであり、抽出で作られる `Memory` 自体には
  opt-in の有無に関わらず常に `claimKey` 欄（値が無ければ `null`）が入る（詳細は下の
  `### Changed`）。
- **`@mnemora/postgres` に opt-in の語彙ストア `PostgresTrigramLexicalStore` を足した**——
  `pg_trgm` で日本語（非 ASCII）部分を照合する。`PostgresTrigramLexicalStore.create()` が拡張と
  ロケール（`server_encoding`・日本語トライグラムの自己一致）を検査し、満たせなければ投げる
  （黙って0件にしない）（[Issue #278](https://github.com/takecchi/mnemora/issues/278) /
  [ADR 0319](./docs/decisions/0319-optional-trigram-lexical-store.md)、PR #738）。
  ⭕ **既定は変えていない**——`PostgresLexicalStore`・`REQUIRED_EXTENSIONS`・migration は無変更で、
  導入側が差し替えたときだけ効く。
  ⚠ 選定に使っていない質問文での精度・閾値は測っていない（ADR 0319）。
- **taxonomy の recall 側絞り込みを実装した（PR-B。Closes #201）**——`RecallQuery.labels?:
  string[]`（OR の集合絞り込み）・`taxonomyGroups?: boolean`（既定 `false`）を新設し、
  `taxonomy_mode`（open/strict）に応じた参加資格で段1・段3.5・`aggregateScope` を絞る。
  `GroupCount.axis: 'taxonomy'`・`FilteredOmission.condition: 'taxonomy'` も新設
  （[Issue #201](https://github.com/takecchi/mnemora/issues/201) /
  [ADR 0323](./docs/decisions/0323-taxonomy-recall-filter.md)、PR #743）。
- **主張キーの衝突を列と索引で検出し `contested` にする（(B) 第2段、既定 off）**——同じ
  `claimKey`（正規化済み）を持つ複数の Memory を検出する。既定では発火しない
  （[Issue #372](https://github.com/takecchi/mnemora/issues/372) /
  [ADR 0324](./docs/decisions/0324-claim-key-contested-detection.md)、PR #745）。
- **`MemoryStore` に任意メソッド `listActiveClaimPredicates?` を足し、`ClaimKeyOptions.
  knownPredicatesFromStore?`（既定 off）で claim key 派生の語彙ヒントを店の既存 predicate
  一覧から動的に集められるようにした**——ADR 0326「採らなかった案B」の実装。real データ
  （`examples/chat` の `answer` 経路、n=3）で訂正の predicate 一致・`contested` 成立を
  0/4→4/4 に改善したが、誤検出も1/14→3〜4/14 に増える副作用が実測された
  （[Issue #691](https://github.com/takecchi/mnemora/issues/691) /
  [ADR 0329](./docs/decisions/0329-claim-key-known-predicates-from-store.md)、PR #750）。
- **`ClaimKeyOptions` に任意欄 `knownSubjects?: string[]` を足した**——`knownPredicates` と
  同型の語彙ヒントを `subject` 側にも用意し、claim key の subject 誤帰属（real-fixture 実測で
  誤検出30%のほぼ全量の原因、ADR 0324 負債6）を減らす。実測（gpt-4o-mini、6話題×3回）:
  off 1,1,2/6 → 正解の第三者名を渡すと 0,0,0/6。省略・空配列＝渡していないと同じで、
  `subjectCandidates`（Issue #608）への暗黙の転用は行わない——`knownSubjects` を省いた
  呼び出しのプロンプトは1バイトも変わらない
  （[Issue #372](https://github.com/takecchi/mnemora/issues/372) 負債6 /
  [ADR 0334](./docs/decisions/0334-claim-key-known-subjects-hint.md)、PR #792）。
  ⭕ `knownPredicatesFromStore` に対応する「store から動的に集める」版は、汎用語彙が
  無関係な話題へ誤って使い回される汚染が実測されたため意図的に実装していない
  （ADR 0334「採らなかった案」）。

### Changed（後方互換だが挙動が変わりうるもの）

- **`@mnemora/postgres` の `aggregateScope` を1回の `GROUP BY` に書き換えた**（PR #721、Issue #355）。公開の型と返り値は変えていない。手元の実測では約1.8倍速い。挙動の変化は無いが、実行計画が変わるので記す。

- **`@mnemora/postgres` の語彙チャンネルで `ts_rank_cd` の normalization ビットに文書長
  （`1 + ln(length)`）の項を足した（`TS_RANK_CD_NORMALIZATION` を `32` から `32 | 1` = `33`
  へ）**——被覆率が同じでも内容量が違う候補の `rank` が完全同点になる問題を減らす。`rank` は
  段2のスコア（`LexicalHit.coverage`/`ScoreBreakdown.lexicalMatch`）には入らないが、段1の
  `PostgresLexicalStore.search()` の `ORDER BY`/`LIMIT` による切り詰めには効く——**そのため
  段1の窓境界に近い候補の並びが変わりうる**（日本語本文に埋もれた単一 ASCII 識別子では効果は
  限定的、とADRに明記）。
  （[Issue #394](https://github.com/takecchi/mnemora/issues/394) /
  [ADR 0308](./docs/decisions/0308-lexical-rank-length-normalization.md)、PR #711）。
- **`estimateRecallFootprint`/`calibrateRecallFootprint`（想起の想定文字数の見積もり）の精度を
  直し、既定の係数が変わった。**`indexBand` の実 JSON 構造から決まる帯のカンマ・桁上がり・`limitedBy` などの
  構造項が推定式から欠落しており、`calibrateRecallFootprint` はその構造項を較正の前に
  差し引けず二重計上していた。較正標本も CI artifact から7点→15点に増やし、hold-in/hold-out の
  分け方を「帯が空であること」そのものに揃えた。**この結果、既定プロファイル
  `BUILTIN_RECALL_FOOTPRINT_PROFILE` の値が変わった**——`charsPerDigest` は
  `15.458` → **`16.175`**、`fixedIndexChars` は `170.881` → **`168.503`**（【実測】
  `git diff v1.0.0..7987de4 -- packages/core/src/recall-footprint.ts`）。既定プロファイルで
  見積もりを使っている呼び手が受け取る数値は変わるが、公開の型・関数シグネチャは無変更
  （[Issue #340](https://github.com/takecchi/mnemora/issues/340) /
  [ADR 0302](./docs/decisions/0302-recall-footprint-structural-terms.md) /
  [ADR 0306](./docs/decisions/0306-recall-footprint-calibration-subtracts-structural-terms.md) /
  [ADR 0314](./docs/decisions/0314-recall-footprint-calibration-samples-need-ci-sourcing.md)、
  PR #710 / #722 / #728）。
- **`recall()` の既定の呼び出し（`attributes` によるフィルタを渡さない呼び出しを含む）でも、
  返ってくる `RecalledMemory` には `attributes` 欄が常に載るようになった**——対象の Memory が
  `attributes` を持たない場合は `{}`（`packages/core/src/recall-runtime.ts` の
  `attributes: member.memory.attributes ?? {}`）。絞り込みの挙動そのものは無変更だが、
  `RecalledMemory` の形（返り値の欄の有無）は変わる——欄の有無を見る比較・スナップショットは
  影響を受けうる
  （[Issue #152](https://github.com/takecchi/mnemora/issues/152) /
  [Issue #153](https://github.com/takecchi/mnemora/issues/153) /
  [ADR 0312](./docs/decisions/0312-observe-recall-caller-attributes.md)、PR #724）。
- **抽出（`observe` → 抽出）で作られる `Memory` には、claim key opt-in を使っていない
  呼び出しでも `claimKey: null` が常に入るようになった（欄が省略されることは無い）**——
  `buildNewMemoryFromCandidate`（`packages/core/src/extraction.ts`）が
  `claimKey: params.claimKey ?? null` を常に書く。`@mnemora/postgres` から読み出した
  `Memory`（`rowToMemory`、`packages/postgres/src/mapping.ts`）も同様に、値が無ければ
  `claimKey: null` を返す——読み出し側でも欄自体は省略されない。**LLM を呼んで値を導出する
  opt-in（`observe` の `claimKey?: ClaimKeyOptions`）は引き続き既定 off**——変わるのは
  欄の有無であって、値が付く条件ではない
  （[Issue #371](https://github.com/takecchi/mnemora/issues/371) /
  [ADR 0320](./docs/decisions/0320-claim-key-field-implementation.md)、PR #736）。
- **`@mnemora/testkit` の `InMemoryVectorStore.search`（擬似 `VectorStore`）で、距離が完全
  一致したヒットの順序を、挿入順から Postgres と同じ3段 tie-break（距離 → `recordedAt`
  DESC → `memoryId` 昇順）に揃えた。** `VectorStore.search` の interface（ADR 0170）は
  同点でも決定的な順序を返すことを約束しているが、擬似物はこれまで
  `Array.prototype.sort` の安定性により挿入順（通常の呼び出し順では `recordedAt` の
  古い方が先）に落ちており、Postgres の「新しい方が先」とは逆向きだった。返す形
  （`{ memoryId, distance }`）は変えていない
  （[Issue #339](https://github.com/takecchi/mnemora/issues/339) /
  [ADR 0049](./docs/decisions/0049-reinforce-monotonicity-in-pseudo-implementations.md) /
  [ADR 0170](./docs/decisions/0170-association-search-tiebreak-nondeterminism.md)、
  PR #828）。
  ⚠ 擬似物の同点順序に依存する呼び出し側（自前のテスト・スナップショット等）があれば、
  結果が変わりうる。

### Fixed

- **`@mnemora/postgres` の段1 `search()` で、他テナントの near-duplicate が HNSW の候補窓
  （既定 `hnsw.ef_search`=40）を埋め尽くすと、自テナントの候補を1件も見ないまま `recall()` が
  0件を返すことがあった。** `PostgresVectorStore.search()` に
  `SET LOCAL hnsw.iterative_scan = relaxed_order` を採用して塞いだ（ADR 0063 決定1 を、
  当時測っていなかった条件の新しい実測で覆す）。併せて、ANN 窓が実際に到達可能な下限に
  届かなかったことを `RecallResult.explain.stages` の型無し診断欄
  （`annReturnedFewerThanReachable`）に名乗らせるようにした——「探して見つからなかった」と
  「探していない」を同じ顔で返さないため
  （[Issue #671](https://github.com/takecchi/mnemora/issues/671) /
  [ADR 0284](./docs/decisions/0284-hnsw-iterative-scan-relaxed-order-adopted.md) /
  [ADR 0285](./docs/decisions/0285-ann-window-empty-of-in-scope-candidates-stage-detail.md)、
  PR #673 / #672 / #676）。
  ⭕ **公開型は変えていない**——診断欄は `explain.stages[...].detail` の型無し欄に条件成立時
  だけ足す形で、既定の出力は変わらない。SQL の `WHERE`/`ORDER BY` も変えていない。
- **`sanitizeCandidateSubjectId` が、LLM が「主題なし」のつもりで返す文字列 `"null"`（JSON の
  `null` リテラルではない）を、候補一覧に無い値として弾いていた。**弾かれた値は
  `undefined`（未指定）へ戻り、意図せず observation の主題へフォールバックしていた
  （実 API で `gpt-4o-mini` に対し5/5回再現）。候補一覧に文字列 `"null"` 自体が含まれていない
  場合に限り、明示的な主題なしとして扱う特例を追加した
  （[Issue #608](https://github.com/takecchi/mnemora/issues/608) /
  [ADR 0304](./docs/decisions/0304-subject-candidates-string-null-literal.md)、PR #712）。
- **自動経路（`RuntimeConfig.autoQueueConsolidateReflectOnExtract: true` のときに `tick()` が
  処理する `consolidate` ジョブ、`processConsolidateJob`）が、subject をまたいで統合し、
  統合後の `Memory.subjectId` が `null` に畳まれることがあった。** `tick()` は `consolidate`
  ジョブを subject で絞って claim できないため、`tick()` に渡した `ctx.subjectId` と種の
  `subjectId` が食い違うと、近傍探索が種と別の subject から候補を拾っていた。
  `processConsolidateJob` は、種の Memory の `subjectId` を `ctx.subjectId` に置いてから
  `consolidate()` を呼ぶように直した——種が見つからない、または種の `subjectId` が `null` の
  場合は今日どおり（[Issue #579](https://github.com/takecchi/mnemora/issues/579) /
  [ADR 0310](./docs/decisions/0310-subject-crossing-consolidate-frequency-measured.md) /
  [ADR 0317](./docs/decisions/0317-auto-consolidate-scopes-neighbor-search-to-seed-subject.md)、
  PR #733）。
  ⭕ **公開型は変えていない**——`autoQueueConsolidateReflectOnExtract` の既定（`false`）の
  利用者には何も起きない。migration も不要。
  ⚠ **フラグを有効にしている利用者から見ると挙動が変わる**——subject をまたぐ統合が
  構造的に起きなくなる（実測は ADR 0310/0317）。
  明示的な `runtime.consolidate(ctx, { target: { seedMemoryId } })` の呼び出しは変えていない。
- **`@mnemora/postgres` の `runMigrations()` に、`schema` の違う呼び出しを同じ（まっさらな）
  DB へ同時に流すと `CREATE EXTENSION IF NOT EXISTS` が `pg_extension_name_index`（拡張は
  DB 全体に1つしか置けない）で衝突し、決定的にどちらかが落ちることがあった。** 拡張を
  作る段だけを、schema に依らない共有の advisory lock（新設の `EXTENSION_LOCK_KEY`）で
  追加に直列化した——schema ごとのロック（ADR 0057 決定6）はそのまま残し、取得順は常に
  「schema ごとのロック → 共有の拡張ロック」に固定してある（逆順は無い）
  （[Issue #757](https://github.com/takecchi/mnemora/issues/757) /
  [ADR 0331](./docs/decisions/0331-extension-creation-shared-advisory-lock.md)、PR #780）。
  ⭕ **公開型・既定値は変えていない**——`extensionMode: "verify"` はこの共有ロックも
  一切参照しない。⚠ `schema` 未指定の経路は、初回適用時だけ advisory lock の制御用
  クエリが2回増える（DDL・DML は1文字も変わらない。ADR 0057 決定2との関係は ADR 0331
  参照）。
- **`@mnemora/postgres` の `registerEmbeddingSpace()` に `dimensions > 2000` を渡すと、
  `CREATE TABLE IF NOT EXISTS` は成功するが続く HNSW 索引の作成が pgvector の `54000`
  （"column cannot have more than 2000 dimensions for hnsw index"）で失敗し、**テーブルだけが
  DB に残っていた**（ADR 0018 が「C-2」として実測・記録していたが、当時は直さない方針だった）。
  テーブルを作る前（advisory lock を取る前の既存バリデーションと同じ場所）で
  `dimensions > 2000` を拒否するようにした。上限値 2000 は pgvector の README（`vector` 型に
  対する HNSW 索引: "up to 2,000 dimensions"）と、手元の pgvector 0.8.0 に対する実測の
  両方で裏取りしている
  （[Issue #776](https://github.com/takecchi/mnemora/issues/776) /
  ADR 0018 追記、PR #777）。
  ⭕ **公開型は変えていない**——新しいエラークラスは足さず、既存の dimensions バリデーション
  （`Number.isInteger(dimensions) && dimensions > 0`）と同じ流儀（`Error`）で拒否する。
  `dimensions <= 2000` の既存呼び出しの挙動は無変更。
- **`@mnemora/testkit` の `TenantSettingsStoreConformanceOptions.supportsTaxonomyMode`・
  `MemoryStoreConformanceOptions.supportsLabels`/`supportsFindActiveByClaimKey` が、
  v1.0.0 には無かったにもかかわらず必須の `boolean` として足され、v1.0.0 時点の
  `describeTenantSettingsStoreConformance(...)`/`describeMemoryStoreConformance(...)`
  呼び出しをコンパイルできなくしていた。** 3つとも `?: boolean` へ戻し、省略時は
  該当する適合項目を実行しない（`false` 相当）
  （[Issue #818](https://github.com/takecchi/mnemora/issues/818) /
  [ADR 0318](./docs/decisions/0318-taxonomy-labels.md) 追記 /
  [ADR 0324](./docs/decisions/0324-claim-key-contested-detection.md) 追記、PR #827）。
  ⭕ **この repo に同梱の実装（`packages/postgres`/`packages/testkit`）の呼び出しは
  引き続き明示で `true` を渡しており、挙動は無変更。**
- **`packDigestBand`（`packages/core/src/digest-band.ts`）に負数の `maxEntryChars` を渡すと、
  `String.prototype.slice` の「末尾から除く」意味に化けて切り詰めが効かず、ほぼ全文が
  残っていた。** `Math.max(0, maxEntryChars)` で下限0にクランプした。正の値の既存呼び出しの
  挙動は無変更（PR #801）。
- **`truncateForFallbackDigest`（`packages/core/src/extraction.ts`、digest 生成の安全弁）にも
  同じ形の不具合があった**——負数の `maxLength` で同じく切り詰めが効かなかった。同様に
  `Math.max(0, maxLength)` でクランプした。正の値の既存呼び出しの挙動は無変更（PR #802）。
- **`@mnemora/openai` の strict モード向け JSON Schema 変換（`makeNullable`）で、省略可能な
  `z.enum`/`z.literal` が `null` を選べず実質必須になっていた。** `const` を持つ形は
  `anyOf` で包み、`enum` を持つ形は `enum` にも `null` を足すよう直した。core が現に渡す
  3スキーマ（`ExtractionResultSchema`/`ClaimKeyBatchResultSchema`/`ConsolidationLLMResultSchema`）
  の翻訳結果はバイト単位で不変——既存カセットに影響しない（PR #808）。
  ⚠ 独自のスキーマで `completeStructured()` を呼ぶ呼び出し側には、出力が変わりうる。
- **`@mnemora/local-embedding` の `LocalEmbeddingProvider` に `retry: { attempts: NaN }` を
  渡すと、`Math.max(1, NaN)` が `NaN` になり、モデルを一度も読み込もうとせず（読み込みの
  `for` ループが一度も回らず）原因不明のエラーになっていた。** `NaN` は0以下と同じ扱いに
  倒し、1回は試みるよう直した。既定値・正の値の挙動は無変更（PR #810）。
- **`@mnemora/testkit` の `InMemoryMemoryStore.getMany`・`InMemoryVectorStore.getVectors`
  （擬似実装）が、重複した id を渡されると重複したまま返していた。** Postgres 実装と同じく
  1件に畳むよう直した。適合テストには触れていない（Issue #809）
  （PR #812 / #814）。
- **`recall()` の段3（必須の同伴取得）が、forget 済み（または `contested` でなくなった）
  対向を companion として返すことがあった。** `contested` の組の片方を `forget()`（または
  直接の status 書き換え）した後も、生き残った側が recall に当たると forget 済みの相手が
  `retrievedVia: "mandatory_companion"` として結果に混ざり、「forget した記憶は recall に
  出ない」（[ADR 0087](./docs/decisions/0087-runtime-forget-shape.md) 決定6）に違反していた。
  段3の companion フィルタに `status === "contested"` を足した——弾かれた対向は「対向が
  見つからない contested」と同じ扱いに倒れ、既存の `unit_assembly_dropped`（ADR 0043）に
  合流する。新しい Omission 種別も公開 API の変更も無い（PR #824）。
  ⚠ **既定の recall 結果が変わりうる**——`contested` の組の片方を forget した状態で、
  もう片方が recall に当たる呼び出し。

---

## [1.0.0] - 2026-09-23

**Release**: [v1.0.0](https://github.com/takecchi/mnemora/releases/tag/v1.0.0)（pre-release ではない）。
**tag が指すのは `c27ca959`**、**前の版は `v0.5.0`**（`509f4e7`）。⟹ **この節は
`v0.5.0` → `v1.0.0` の差分である**（【実測】`git rev-list --count v0.5.0..v1.0.0` = 29）。
⚠ **published は `2026-09-22T23:54:08Z`（UTC）である**——**見出しの日付は JST**（この repo の
commit の日付と同じ `+0900`）。🔴 **この版も UTC と JST で日付が1日ずれる**——UTC では 9/22、
JST では 9/23（08:54）である。⚠ **tag が指す commit 自体の日付は `2026-09-23 05:31 +0900` で、
出荷の3時間あまり前である**——**commit の時と出荷の時は別物である**（この版では JST の日付は揃った）。

⭐ **この節は Release を作る *前* に起こしてあった**（[docs/release-v1.md](./docs/release-v1.md) §0.10 /
[ADR 0252](./docs/decisions/0252-release-changelog-section-is-a-publish-gate.md)）。⟹ **上の段落がいま埋まっているのは、
同 §0.10 が「後からしか分からない事実（`published` の時刻・Release へのリンク）は後から埋めてよい」と
定めているのに従って、公開後にその時点の現物で埋めたからである。**

🔴 **この版の Release 本文は、前の版と違って自動生成ではない。**【実測】
`gh release view v1.0.0 --json body -q .body | grep -c '^\* '` は **0** を返す（`v0.5.0` は 8 だった）。
⟹ **本文は [docs/release-notes-v1.0.0.md](./docs/release-notes-v1.0.0.md) の草稿を起こしたもので、
commit を無差別に並べた一覧ではない。**⟹ ⭐ **「分類も除外もこの節が初めて与える」という前の版での
関係は、この版には当てはまらない。**

**この節は `v0.5.0` からの差分を対象とする。**⭐ **`v0.4.0` → `v0.5.0` の分は、下の `[0.5.0]` 節に在る**
——⛔ **この節へ混ぜない。**

🔴 **出荷される面は、`v0.5.0` から1バイトも動かなかった。**【実測、⭐ **両端が tag なので範囲は閉じている**】:

```
$ git diff --stat v0.5.0..v1.0.0 -- packages/                              → （差分なし）
$ git diff --stat v0.5.0..v1.0.0 -- scripts/__snapshots__/public-api/      → （差分なし）
```

⟹ **この節に項目が1件も並んでいないのは、書き漏れではない。**
⭐ **そしてこの2本は、節を起こした時点の `v0.5.0..origin/main` と違って、もう腐らない**
——**両端が tag に固定されているからである。**

⭐ **数えた基準を明記する。**この節は `v0.5.0` … **`509f4e7`** の範囲を数えたものである。
⭐ **この sha が名乗るのは「この節がどこまで数えたか」であって、「ここで打ち切った」ではない。**
⟹ ⭕ **`origin/main` がこれより進んでいても、この節は腐っていない**——**まだ数えていない範囲が
増えただけである。**読む人は `git log --oneline 509f4e7..origin/main` で、その増分を自分で見られる。
🔴 **この性質が成り立つのは、この節が件数を持たないからである。**
⛔ **ここに件数を書かないこと**——書いた瞬間、次の1件が着地した時点で腐る
（[#433](https://github.com/takecchi/mnemora/issues/433) /
[ADR 0234](./docs/decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。
**数えるなら、下の項目そのものを数えること。**
⚠ **この pin は `scripts/release-candidates.mjs` の入力でもある**
（[ADR 0214](./docs/decisions/0214-release-candidates-lists-not-judges.md) 決定5。⛔ 道具は書き換えない）。

### 🔴 この pin を置いた時点で、`v0.5.0` と `origin/main` は同じ commit だった

**【実測 2026-09-21】**pin を置いた時点では `git rev-parse origin/main v0.5.0^{commit}` が
2行とも `509f4e739ca1ad017876a5b661062d23c2ead773` を返し、
`git rev-list --count v0.5.0..origin/main` は **0** だった。
⟹ **この節が空なのは、まだ数えていないからではなく、数える範囲そのものが空だったからである。**

🔴 **⛔ ただし、その2つのコマンドを「この節が今も空か」の検査に使わないこと。**
**どちらも docs だけの commit で動く**——**実際、この節を書いた commit 自身が `main` を1本進めた。**
⟹ ⭐ **「利用者に届く変更が在るか」を見たいなら、出荷される面を直接当てること:**

```
$ git diff --stat v0.5.0..origin/main -- packages/                      → （差分なし）
$ git diff --stat v0.5.0..origin/main -- scripts/__snapshots__/public-api/  → （差分なし）
```

⚠ **この2本も「利用者に見える変更が無い」の証明ではない**——**publish 対象の外の `scripts/` や
`examples/` は当たらないし、`packages/` の差分がテストだけのこともある。**
⟹ ⭐ **下の「数え直すこと」に従って、その場で一覧を出すこと。**
⚠ **上の2本は、節を起こした時点では `v0.5.0..origin/main` を当てた予告だった**
——⛔ **「何も載らない」の証明ではなかった。**⟹ ⭐ **出荷された今は `v0.5.0..v1.0.0` で引き直してあり**
（この節の冒頭）、**予告ではなく閉じた範囲の実測になっている。**
⚠ **次の版を切る側は、この pin ではなく `v1.0.0` から数え直すこと**
（道具は `node scripts/release-candidates.mjs --since v1.0.0`。
⚠ **`--since` を省くと最新リリースの tag が入る**——**いまは `v1.0.0` なので一致するが、
次の Release が出れば一致しなくなる。**⟹ 明示して撃つこと）。

⟹ ⭐ **`v0.5.0` の利用者に届く変更は、結果として1件も無かった。**
**`v1.0.0` が節目なのは、コードが変わったからではない。**理由は
[docs/roadmap.md](./docs/roadmap.md) の §7 と
[docs/release-notes-v1.0.0.md](./docs/release-notes-v1.0.0.md) に在る。

⭐ **「`v1.0.0` へ上げるときに何が壊れるか」の正本は
[docs/migration-v1.md](./docs/migration-v1.md) である**——**あちらは世代ごとに分けてある。**
🔴 **`v0.4.0` からの利用者が受ける破壊的変更は、この節ではなく下の `[0.5.0]` 節に在る**
——**`v0.5.0` で出荷済みだからである。**

⚠ **`v1.0.0` をいつ切るかは、この節を書いた時点では決まっていなかった。**
⟹ **出たのは `2026-09-22T23:54:08Z`（UTC）である**（上の冒頭）。7項目の現在地は
[docs/roadmap.md](./docs/roadmap.md) の **§7 の末尾の節**に在る
（⛔ **節番号を固定で信じないこと**——同文書は前の節を書き換えず、後から決まったことを
新しい節として積む。⟹ `grep -nE '^### 7\.[0-9]+ ' docs/roadmap.md` の末尾を見ること）。
**Release 本文の草稿は [docs/release-notes-v1.0.0.md](./docs/release-notes-v1.0.0.md) に在る。**
⛔ **どちらも件数をここへ写さない**——正は各文書である。

---

## [0.5.0] - 2026-09-21

**Release**: [v0.5.0](https://github.com/takecchi/mnemora/releases/tag/v0.5.0)（pre-release ではない）。
**tag が指すのは `509f4e7`**、**前の版は `v0.4.0`**（`3cf2663`）。⟹ **この節は
`v0.4.0` → `v0.5.0` の差分である**（【実測】`git rev-list --count v0.4.0..v0.5.0` = 8）。
⚠ **published は `2026-09-20T15:25:56Z`（UTC）である**——**見出しの日付は JST**（この repo の
commit の日付と同じ `+0900`）。🔴 **この版は UTC と JST で日付が1日ずれる**
——UTC では 9/20、JST では 9/21（00:25）である。⚠ **tag が指す commit 自体の日付は
`2026-09-19 13:42 +0900` で、さらに前である**——**commit の日と出荷の日は別物である。**

⚠ **GitHub の Release `v0.5.0` の本文は自動生成であり、8 commit を無差別に1行ずつ
並べたものである**【実測】（`gh release view v0.5.0 --json body -q .body | grep -c '^\* '` = 8）。
⟹ ⭐ **分類も、docs のみ・テストのみの除外も、この節が初めて与える。**

🔴 **この節も、出荷に遅れて起こしたものである。これで3回目である。**
`v0.5.0` が published された時点では、`[1.0.0]`（未リリース）の節が逐語で
「**この節に並ぶものは、1件も出荷されていない**」と名乗り、pin を `v0.4.0 … 420e0f4` に置いていた
——**どちらも、その時点で既に偽だった。**
⚠ **同じ形は `v0.3.0`（[Issue #536](https://github.com/takecchi/mnemora/issues/536)）と
`v0.4.0`（[ADR 0248](./docs/decisions/0248-changelog-and-migration-guide-follow-the-release.md)）でも起きている。**
⭐ **ただし今回は、リリース直後に機械が名指しで知らせていた**——
[ADR 0251](./docs/decisions/0251-release-follow-up-notice-not-a-gate.md) の
「Release follow-up notice」が `v0.5.0` の tag で走り、逐語で
「**🔴 CHANGELOG.md に `## [0.5.0]` の節が無い。**」と出力して終わっている（⛔ **門ではないので、何も止めていない**）。
🔴 **⟹ 3回目は「気づけなかった」ではなく「知らされたが、追随が遅れた」である。**

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更は `@mnemora/local-embedding` の1本だけに在る**
（`@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` / `@mnemora/openai` /
`@mnemora/anthropic` に破壊的変更は無い）。

**postgres 利用者へ**: ⭕ **新しいマイグレーションは無い。**
【実測】`git diff --stat v0.4.0..v0.5.0 -- packages/postgres/migrations/` は**差分を返さない**。
⟹ **`v0.4.0` から `v0.5.0` へ上げるのに `migrate` は要らない**
（⚠ **`v0.3.0` 以前から上げるなら要る**——`0018` が `v0.4.0` に在る。
[docs/migration-v1.md](./docs/migration-v1.md) を見ること）。

### ⭐ この節が数えた範囲の全体（⛔ 見落としが無いことを、後から検算できる形で残す）

**【実測 2026-09-21】出荷される面のソースを触ったのは、次の2ファイルだけである。**

```
$ git diff --name-only v0.4.0..v0.5.0 \
    | grep -E '^(packages|examples|scripts)/' \
    | grep -vE '__tests__|\.test\.ts|__fixtures__'
packages/core/src/recall-runtime.ts
packages/local-embedding/README.md
packages/local-embedding/src/local-embedding-provider.ts
scripts/check-release-changelog-section.mjs
scripts/release-changelog-section-lib.mjs

$ git diff --stat v0.4.0..v0.5.0 -- scripts/__snapshots__/public-api/   → （差分なし）
$ git diff --stat v0.4.0..v0.5.0 -- packages/postgres/migrations/       → （差分なし）
```

⟹ **`scripts/` の2本は publish 対象の外**（出所は `scripts/publish-targets.mjs` の
`PUBLISH_TARGETS`。⛔ **本数も名前もここに写さない**——`AGENTS.md`）、
**`README.md` は挙動ではない** ⟹ ⭐ **残る2ファイルが、下に載せた2件に1対1で対応する。**
🔴 **そして公開 API の型スナップショットは1バイトも動いていない**
⟹ ⭐ **「型が変わったのに載っていない」形の見落としは、この世代には無い。**
⛔ **これは「利用者に見える変更が2件しか在りえない」の証明ではない**——
**型に現れない挙動の変更は、この2つのコマンドでは捕まらない。**上の一覧を人が読んで分類した。

### Breaking

⭐ **1件である。**⭕ **`v0.4.0` と `v0.5.0` の両端が tag で閉じているので、`main` が動いてもこの数は変わらない。**
⚠ **正本は [docs/migration-v1.md](./docs/migration-v1.md) の番号付き一覧の 18 であり、
下の表はその写しである**——**`#` 欄はあちらの通し番号で、この表の中での連番ではない。**

🔴 **この世代は、`[0.4.0]` までと壊れ方の種類が違う**——**型ではなく実行時に壊れる。**
【実測 2026-09-21】`git diff --stat v0.4.0..v0.5.0 -- scripts/__snapshots__/public-api/` は
**差分を返さない** ⟹ ⭕ **公開 API の型は1バイトも動いていない。**
⚠ それでも破壊的として数えるのは、移行ガイドの定義が逐語で
「**既存の利用者のコードが型検査 *または実行時* に壊れる変更**」だからである。

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 18 | `LocalEmbeddingProvider` のコンストラクタが、**既定と異なる `repo` を `modelId` 無しで渡された宣言**を `throw` で落とすようになった（`@mnemora/local-embedding`） | 🔴 **`repo` を既定以外にし、かつ `modelId` を渡していなかった人だけ。**⭕ `repo` を渡していないなら影響なし。⚠ **該当していた人は元から壊れていた側である**——`repo` は `space.model` に反映されず、別モデルのベクトルが同じ space へ静かに混ざっていた | [ADR 0247](./docs/decisions/0247-local-embedding-repo-model-id-declaration-guard.md) / [#142](https://github.com/takecchi/mnemora/issues/142)（PR #550） |

⚠ **移行手順は複製しない**——直し方は [docs/migration-v1.md](./docs/migration-v1.md) の項目 **18** を見ること。
⛔ **これを「#142 が解決した」と読まないこと**——#142 は2件を名指ししており、
**「実 API に一度も当てていない」ほうは手つかずで残っている**（同 Issue はいまも OPEN）。

### Changed（後方互換だが挙動が変わりうるもの）

- **連想枠（段3.5）の席が、減衰を含む順位で埋まるようになった**（`@mnemora/core`）。
  順位キーは `hit.similarity * score.total`（＝ `anchorSimilarity × decay × tagMatch × freshness × strength`）で、
  `maxCount` を超える候補が在るときに**席に座る記憶が変わる**
  （[ADR 0246](./docs/decisions/0246-association-rank-includes-decay.md) /
  [#402](https://github.com/takecchi/mnemora/issues/402)、PR #549）。

  ⚠ **以下は [ADR 0246](./docs/decisions/0246-association-rank-includes-decay.md)「誰が壊れうるか」からの逐語である**
  ——**この節の書き手はこの変更を作っておらず、自分で測り直してもいない**【受】:

  > **`RecallQuery.association` を渡している呼び手の、返る記憶の顔ぶれが変わりうる。**
  > … **型は1バイトも変わらない。**新しい欄も新しいつまみも無い ⟹ **破壊的変更ではない。**
  > … **既定 off なので、`association` を渡していない呼び手は1バイトも影響を受けない。**

  🔴 **この変更は、正典項目4 の判定にも効いている**——経緯は
  [docs/roadmap.md](./docs/roadmap.md) §7.17 と §7.18 に在る。

---

## [0.4.0] - 2026-09-19

**Release**: [v0.4.0](https://github.com/takecchi/mnemora/releases/tag/v0.4.0)（pre-release ではない）。
**tag が指すのは `3cf2663`**、**前の版は `v0.3.0`**（`6851629`）。⟹ **この節は
`v0.3.0` → `v0.4.0` の差分である**（【実測】`git rev-list --count v0.3.0..v0.4.0` = 27）。
⚠ **published は `2026-09-18T20:36:04Z`（UTC）である**——**見出しの日付は JST**（この repo の
commit の日付と同じ `+0900`）。⟹ **UTC で読むと1日ずれる。**

⚠ **GitHub の Release `v0.4.0` の本文は自動生成であり、27 commit を無差別に1行ずつ
並べたものである**【実測】（`gh release view v0.4.0 --json body -q .body | grep -c '^\* '` = 27）。
⟹ ⭐ **分類も、docs のみ・テストのみの除外も、この節が初めて与える。**

🔴 **この節は、出荷に遅れて起こしたものである。**`v0.4.0` が published された時点では、
中身は `[1.0.0]`（未リリース）の節に置かれたままで、同節は逐語で「**この節に並ぶものは、
1件も出荷されていない**」と名乗っていた。⚠ **同じ形の遅れは `v0.3.0` でも起きている**
（[Issue #536](https://github.com/takecchi/mnemora/issues/536) /
[ADR 0243](./docs/decisions/0243-changelog-lists-publish-targets-only.md)）⟹ **2回目である。**
経緯と、3回目を防ぐ手の検討は
[ADR 0248](./docs/decisions/0248-changelog-and-migration-guide-follow-the-release.md)。

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更は `@mnemora/core` / `@mnemora/testkit` の2本に在る**
（`@mnemora/postgres` / `@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding` に
破壊的変更は無い）。

**postgres 利用者へ**: 新しいマイグレーション（`0018`）が増えている。
⟹ **`v0.3.0` から上げるなら `pnpm --filter @mnemora/postgres run migrate` が要る。**
🔴 **「新機能を使うときだけ要る」ものではない**——理由と適用手順は
[docs/migration-v1.md](./docs/migration-v1.md) を見ること。このファイルには複製しない。

### Breaking

⭐ **6件である。**⭕ **`v0.3.0` と `v0.4.0` の両端が tag で閉じているので、`main` が動いてもこの数は変わらない。**
⚠ **正本は [docs/migration-v1.md](./docs/migration-v1.md) の番号付き一覧の 12〜17 であり、
下の表はその写しである**——**`#` 欄はあちらの通し番号で、この表の中での連番ではない。**

⚠ **壊れ方は2つの形に分かれる。**

**1つ目は「`interface` に必須メンバが増えた」形**（項目 **12**〜**16**）。
⟹ ⭕ **`createRuntime()` が返すものを使っているだけなら、何もしなくてよい。**
壊れるのは、**自分で `Runtime` を実装している側**と、**`@mnemora/testkit` の適合テストを
呼んでいる側**だけである。⚠ これは新しい判定基準ではない——`[0.2.0]` の Breaking 表
**1**・**5**・**6** が同じ理由で破壊的と数えられている。

🔴 **2つ目は「union に値が増えた」形**（項目 **17**）。⟹ **壊れるのは実装する側ではなく、消費する側である。**
⭕ **値を読むだけ・比較するだけなら非破壊**——`never` で網羅性を検査しているコードだけが壊れる。
⚠ これも新しい判定基準ではない——`[0.2.0]` の Breaking 表 **4** が同じ形で数えられている。

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 12 | `Runtime` に必須メソッド `restoreSuperseded` が増えた（`@mnemora/core`） | `Runtime` を自分で実装している側だけ。`createRuntime()` が返すものを使っているなら影響なし | [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md) / [#369](https://github.com/takecchi/mnemora/issues/369)（PR #464）。⚠ **ADR 0230 の本文だけを読むと、これが破壊的であることに気づけない**——2026-09-18 に冒頭への追記で名指しされた |
| 13 | `MemoryStoreConformanceOptions.supportsRestoreSupersededBy` が必須フィールドになった（`@mnemora/testkit`）。**12 と同じ PR #464 で入っている** | `describeMemoryStoreConformance` を呼んでいる側だけ | [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md)（PR #464）。🔴 **この項目は 2026-09-18 まで、CHANGELOG にも ADR にも一度も書かれていなかった** |
| 14 | `Runtime` に必須メソッド `findCorrectionCandidates` が増えた（`@mnemora/core`） | **12 と同じ** | [ADR 0232](./docs/decisions/0232-correction-candidates-returned-not-chosen.md) / [#369](https://github.com/takecchi/mnemora/issues/369)（PR #517） |
| 15 | `MemoryStoreConformanceOptions.supportsPreviewRestoreSupersededBy` が必須フィールドになった（`@mnemora/testkit`） | **13 と同じ** | [ADR 0237](./docs/decisions/0237-restore-superseded-dry-run-preview.md) / [#515](https://github.com/takecchi/mnemora/issues/515)（PR #524） |
| 16 | `Runtime` に必須メソッド `applyCorrection` が増えた（`@mnemora/core`）。`findCorrectionCandidates` が返した候補の中から**人が選んだ1件**を受け取り、`markContested` → `resolveContested` の書き込みまでを1つの口にまとめる | **12 と同じ** | [ADR 0242](./docs/decisions/0242-runtime-apply-correction.md) / [#369](https://github.com/takecchi/mnemora/issues/369)（PR #537） |
| 17 | 🔴 `MemoryEventKind` の union に `"unsuperseded"` が増えた（`@mnemora/core`）。**12・13 と同じ PR #464 で入っている** | ⚠ **届く経路は `EventStore` である**——`MemoryEvent.kind` は必須フィールドで、`EventStore.append`/`.get`/`.list` が返す。⟹ ⭕ **`Runtime` の口からは届かない**ので、**5つの動詞だけを使う利用者には影響しない。**⚠ **同じ形に対する扱いがこの repo に2つ在り、線は引かれていない**——[#541](https://github.com/takecchi/mnemora/issues/541) を見ること | [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md)（PR #464） |

⚠ **移行手順は複製しない**——直し方は
[docs/migration-v1.md](./docs/migration-v1.md) の同じ番号の項目を見ること。

### Added

- **`Runtime.restoreSuperseded`**（および `MemoryStore.restoreSupersededBy` — **任意**メソッド）。
  `superseded` になった Memory を `active` へ戻す**復旧口**。粒度は群単位で、
  `target: { supersededById }`（置き換えた側の id）で指定する
  （[#369](https://github.com/takecchi/mnemora/issues/369) /
  [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md)、PR #464）。
  ⚠ **これは北極星 項目5（間違いを正すと、古いほうが先に出てこなくなる）を満たすものではない**——
  訂正の口そのものは入っていない
- **`restoreSuperseded` の dry-run**（および `MemoryStore.previewRestoreSupersededBy` — **任意**メソッド）。
  **戻す前に、何が戻るかを返す**（[#515](https://github.com/takecchi/mnemora/issues/515) /
  [ADR 0237](./docs/decisions/0237-restore-superseded-dry-run-preview.md)、PR #524）
- **`Runtime.findCorrectionCandidates`** — 訂正の相手の**候補を返す**口。
  ⛔ **mnemora は選ばない。書き込みを1件もせず、LLM を1回も呼ばない**
  （[ADR 0232](./docs/decisions/0232-correction-candidates-returned-not-chosen.md)、PR #517）
- **`Runtime.applyCorrection`** — 訂正の**選択**の段を、出荷される面へ持ち上げた口。
  ⭐ **選ぶのは人である**——候補を返す `findCorrectionCandidates` と、書き込む
  `markContested`/`resolveContested` のあいだを繋ぐ
  （[ADR 0242](./docs/decisions/0242-runtime-apply-correction.md)、PR #537）
- **`CassetteRecorder.lookupLLM` / `lookupEmbedding`**（`@mnemora/testkit`）— 記録した
  カセットを照会する口。⭕ **追加のみで後方互換**
  （[ADR 0233](./docs/decisions/0233-answer-quality-measured-once-against-the-real-api.md)、PR #514）

---

## [0.3.0] - 2026-09-17

**Release**: [v0.3.0](https://github.com/takecchi/mnemora/releases/tag/v0.3.0)（pre-release ではない）。
**tag が指すのは `6851629`**、**前の版は `v0.2.0`**（`c52be47`）。⟹ **この節は
`v0.2.0` → `v0.3.0` の差分である**（【実測】`git rev-list --count v0.2.0..v0.3.0` = 101）。

⚠ **GitHub の Release `v0.3.0` の本文は自動生成であり、101 commit を無差別に1行ずつ
並べたものである**【実測】（`gh release view v0.3.0 --json body -q .body | grep -c '^\* '` = 101）。
⟹ ⭐ **分類も、docs のみ・テストのみの除外も、この節が初めて与える。**

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更は `@mnemora/core` / `@mnemora/testkit` / `@mnemora/local-embedding` の3本に在る**
（`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/postgres` に破壊的変更は無い）。
🔴 **⚠ `@mnemora/local-embedding` を落とさないこと**——この repo は 2026-09-18 まで
「`@mnemora/local-embedding` に破壊的変更は無い」と書いており、**それは誤りだった**
（[Issue #532](https://github.com/takecchi/mnemora/issues/532)）。

**postgres 利用者へ**: 新しいマイグレーション（`0016`/`0017`）が増えている。
⟹ **`v0.2.0` から上げるなら `pnpm --filter @mnemora/postgres run migrate` が要る。**
適用手順・破壊的変更ごとの対応方法は [docs/migration-v1.md](./docs/migration-v1.md) を見ること
——このファイルには詳細を複製しない。

### Breaking

⭐ **4件である。**⭕ **`v0.2.0` と `v0.3.0` の両端が tag で閉じているので、`main` が動いてもこの数は変わらない。**
⚠ **正本は [docs/migration-v1.md](./docs/migration-v1.md) の番号付き一覧の 8〜11 であり、
下の表はその写しである**——**`#` 欄はあちらの通し番号で、この表の中での連番ではない。**

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 8 | `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls`（`@mnemora/testkit`）の署名が `(tenantId: string, recalls: number): void` → `(ctx: Ctx, recalls: number): Promise<void>` へ変わった。ADR 0197 が `TenantSettingsStore` に同名の**本番**メソッドを足して名前が衝突したため、テスト専用フックのほうを消した | 🔴 **旧署名で呼んでいた側。⛔ 引数を直すだけでは足りない**——同期から `Promise` へ変わったので `await` が要る。構築して渡すだけなら影響なし | [ADR 0197](./docs/decisions/0197-set-default-half-life-recalls.md)（PR #416） |
| 9 | `FilteredOmission` に必須フィールド `scopeRelation` が増えた（`@mnemora/core`）。`decayed` だけが `totalInScope` の**内側**を数えるという非対称を、契約として明示するもの | **返り値の型なので、読むだけの利用者には非破壊。** `FilteredOmission` を自分で組み立てている側（独自 adapter の `aggregateScope` 実装・テストダブル）だけ | [ADR 0174](./docs/decisions/0174-filtered-omission-scope-relation.md) / [#352](https://github.com/takecchi/mnemora/issues/352)（PR #376） |
| 10 | `Omission` の `over_limit` に必須フィールド `stage` が増えた（`@mnemora/core`）。連想枠（段3.5）の `maxCount` 切り捨てを段1 の打ち切りと区別して名乗るため | **9 と同じ形**——`omission.count` を読むだけなら非破壊。`OverLimitOmission` を自分で組み立てている側だけ | [ADR 0188](./docs/decisions/0188-association-over-limit-omission.md) / [#375](https://github.com/takecchi/mnemora/issues/375)（PR #391） |
| 11 | 🔴 `LocalEmbeddingPipeline`（`@mnemora/local-embedding`）が呼び出し可能な関数型から、`countTokens` / `embed` / `maxInputTokens` を要求する必須 `interface` になった | 🔴 **呼んでいる側と、自前で渡していた側の両方**——この4件で唯一「呼ぶだけの側も壊れる」形である。⛔ **渡すものの形そのものが変わっている** | [ADR 0205](./docs/decisions/0205-local-embedding-pipeline-required-interface.md) / [#137](https://github.com/takecchi/mnemora/issues/137)（PR #446） |

⚠ **`@mnemora/core` だけを見て数えると、8 と 11 が落ちる**——`@mnemora/testkit` と
`@mnemora/local-embedding` も publish 対象である。
⚠ **移行手順は複製しない**——直し方は [docs/migration-v1.md](./docs/migration-v1.md) の
同じ番号の項目を見ること。

### Changed（後方互換だが挙動が変わりうる）

- **`ann_unreached` が「窓が満杯のときにも」鳴るようになった。**従来は
  `annHits.length < kPrime` のときだけ鳴っていたため、**近似索引が取りこぼしたのに窓は満杯**
  という場合に沈黙していた（[ADR 0193](./docs/decisions/0193-ann-unreached-covers-full-window.md)、PR #399）。
  ⟹ 北極星「知らないことを、知らないと言える」の穴を1つ塞いだ
- **`sweepArchive` が `opts.clock` 省略時に `tenant_settings.decay_clock` へ従うようになった。**
  従来は掃引だけが常に壁時計で動いていたため、`decay_clock = activity`/`either` を選んだ
  テナントで「想起では生きている記憶が archive される」ことがあった
  （[#364](https://github.com/takecchi/mnemora/issues/364) /
  [ADR 0186](./docs/decisions/0186-sweep-archive-follows-decay-clock.md)、PR #379）
- **語彙チャンネルの `search()` に決定的な最終キーが入った。**同点の候補の順序が
  呼び出しごとに変わりうる状態を解消（[#345](https://github.com/takecchi/mnemora/issues/345) /
  [ADR 0175](./docs/decisions/0175-lexical-search-tiebreak-nondeterminism.md)、PR #390）
- **`PostgresVectorStore.upsert` が、閾値を越えたときだけ埋め込み表を `ANALYZE` するようになった。**
  新しい埋め込み空間へ大量投入した直後は統計が無く、**HNSW 索引が選ばれない窓**が在った
  （[#360](https://github.com/takecchi/mnemora/issues/360) /
  [ADR 0194](./docs/decisions/0194-embedding-space-analyze-threshold.md)、PR #406）。
  ⭕ **公開 API は変わっていない**——変わるのは実行計画である
- **`memories` への書き込み経路にも、同じ閾値つき `ANALYZE` のフックが入った**
  （[#269](https://github.com/takecchi/mnemora/issues/269) /
  [ADR 0221](./docs/decisions/0221-memories-analyze-on-write.md)、PR #492）。
  ⚠ **`supersedeWithNewMemories` だけが取り残されていたので、後から塞いだ**
  （[ADR 0225](./docs/decisions/0225-supersede-with-new-memories-analyze-hook.md)、PR #502）

### Added

- **`TenantSettingsStore.setDefaultHalfLifeRecalls`**（**任意**メソッド）。テナント既定の
  半減期を「recall 回数」で設定する本番の経路
  （[ADR 0197](./docs/decisions/0197-set-default-half-life-recalls.md)、PR #416）。
  ⭕ **任意メソッドなので、この追加そのものは後方互換**——実装していない adapter は従来どおり動く。
  ⚠ **ただし同じ PR #416 は破壊的変更も1件持っている**（上の表の **8**）。
  ⟹ **「任意メソッドだから丸ごと後方互換」と読まないこと。**
- **`OutboxStoreConformanceOptions.supportsRealConcurrency`**（`@mnemora/testkit`、**任意**フィールド）。
  adapter 作者が「同時 `claimBatch` を本物の並行で検査してよいか」を自己申告できる
  （[ADR 0206](./docs/decisions/0206-outbox-concurrent-claim-conformance.md)、PR #450）

### Fixed

- **`recall()` の返り値で `memories` と `omitted` が排他であることを、契約として明示して直した。**
  同じ Memory が両方に現れうる状態を塞いだ（[#421](https://github.com/takecchi/mnemora/issues/421) /
  [ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md)、PR #435）。
  ⭕ **公開型は変えていない**——変わったのは返る中身である

---

## [0.2.0] - 2026-09-16

**Release**: [v0.2.0](https://github.com/takecchi/mnemora/releases/tag/v0.2.0)（pre-release ではない）。
**tag が指すのは `c52be47`**、**前の版は `v0.1.9`**（`6c9d101`）。⟹ **この節は
`v0.1.9` → `v0.2.0` の差分である**（【実測】`git rev-list --count v0.1.9..v0.2.0` = 30）。

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更はすべて `@mnemora/core` と `@mnemora/testkit` に限られる**
（`openai`/`anthropic`/`local-embedding` の `src` に v0.1.9 からの差分は無い。【実測】
`git diff --stat v0.1.9..v0.2.0 -- packages/openai/src packages/anthropic/src packages/local-embedding/src`
が空を返す）。

**postgres 利用者へ**: 新しいマイグレーション（`0013`/`0014`/`0015`）が増えている。
適用手順・破壊的変更ごとの対応方法は [docs/migration-v1.md](./docs/migration-v1.md) を見ること
——このファイルには詳細を複製しない。

### Breaking

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 1 | `MemoryStore.getRecall` が必須メソッドとして追加された。 | `MemoryStore` を自前実装している adapter 作者 | [ADR 0155](./docs/decisions/0155-recall-score-breakdown-persisted.md) |
| 2 | `NewRecallRecord.returnedMemoryIds: MemoryId[]` を削除し、`returnedMemories: RecallRecordMemory[]` に置き換えた。 | `createRecall` を呼ぶ側・実装する側の両方 | [ADR 0155](./docs/decisions/0155-recall-score-breakdown-persisted.md) |
| 3 | `ScopeAggregate` に必須フィールド `filteredExpired`/`filteredNotYetValid` が増えた。 | `aggregateScope` を自前実装している adapter 作者 | [ADR 0164](./docs/decisions/0164-valid-from-until-recall.md) |
| 4 | `FilteredOmission.condition` の union に `"expired"`/`"not_yet_valid"` が増えた。 | 消費するだけなら非破壊。**`never` で網羅性を検査しているコードは壊れる** | [ADR 0164](./docs/decisions/0164-valid-from-until-recall.md) |
| 5 | `Runtime.getRecall` が必須メソッドとして追加された。 | `Runtime` を自前実装している側。⚠ 根拠 ADR に破壊性の言及が無い——[移行ガイド](./docs/migration-v1.md)を必ず見ること | [ADR 0161](./docs/decisions/0161-runtime-get-recall.md) |
| 6 | `TenantSettingsStoreConformanceOptions.supportsDecayClock`（`@mnemora/testkit`）が必須フィールドとして追加された。 | `describeTenantSettingsStoreConformance(...)` を呼んでいる adapter 作者。⚠ 根拠 ADR は当初「非破壊」と誤記載していたが訂正済み | [ADR 0165](./docs/decisions/0165-decay-activity-clock.md) |
| 7 | `RecallFootprintEstimate.associationCount`（`@mnemora/core`）が必須フィールドとして追加された。 | **返り値の型なので、読むだけ・呼ぶだけの利用者には非破壊。** `RecallFootprintEstimate` を自前で構築している側だけが影響を受ける。入力側（`estimateRecallFootprint`）は省略可能フィールドとして追加されており非破壊（省略時は `?? 0`）。（【実測】`packages/core/src/recall-footprint.ts:392` が必須、入力側の `RecallFootprintShape.associationCount` は `:368` で省略可能、既定は `:463` の `?? 0`） | ADR 0166 |

### Changed（後方互換だが挙動が変わりうる）

- **`RecallQuery.validAt` ゲートが既定で有効になった**（opt-out は `includeOutsideValidity: true`）。
  **影響を受けるのは、v0.1.9 で `MemoryStore.createMemory` を直接呼んで `validFrom`/`validUntil`
  に non-null を書いていた利用者だけ**——`Runtime.observe` 経由ではこれらの列に値を
  書く経路が v0.1.9 には無かったため、通常の利用者には影響しない。
  ([ADR 0164](./docs/decisions/0164-valid-from-until-recall.md))
- **`TICK_SUPPORTED_JOB_KINDS` が2値から4値へ増えた**（`consolidate`/`reflect` を追加）。
  値を消費するだけなら非破壊だが、**網羅性検査（`never`）をしているコードは壊れる。**
  ([ADR 0157](./docs/decisions/0157-tick-drives-consolidate-and-reflect.md))
- **`PostgresVectorStore.search` の `ORDER BY` に `memory_id` の tie-break が追加された。**
  距離が完全一致した候補の順序が決定的になった（以前は未定義）。
  ([ADR 0167](./docs/decisions/0167-association-getvectors-order-nondeterminism.md))
- **連想枠の非決定性は、上の修正だけでは消えていなかった（第2段）。** `search()` が返す
  候補に距離の完全一致タイが在ると、`memory_id` による tie-break が取り込みのたびに
  揺れていた。段1と段2の両方で順序を決定的にして直した（Issue #339）。
  ([ADR 0170](./docs/decisions/0170-association-search-tiebreak-nondeterminism.md))

### Added

- **`Runtime.getRecall(ctx, recallId)`** — `recall()` を離れた後でも、`recallId` から
  スコア内訳・`retrievedVia`・`companionOf`/`associationOf` を読み戻せる。
  ([ADR 0161](./docs/decisions/0161-runtime-get-recall.md))
- **`memory_usage` 報告の実践**（`examples/chat`）— プロンプトへ積んだ Memory を
  `observe({ kind: 'memory_usage' })` で伝え返し、`reinforce` を実アプリで発火させる。
  ([ADR 0163](./docs/decisions/0163-memory-usage-reporting-example-chat.md))
- **`validAt` ゲート** — 「この時刻において真だった記憶」を問える。`expired`/`not_yet_valid`
  を `omitted` で名指しする。([ADR 0164](./docs/decisions/0164-valid-from-until-recall.md))
- **減衰の時計を2本持てる（`decay_clock`）** — 壁時計（`wall`、既定）に加え、活動時計
  （`activity`）・両方（`either`）をテナントごとに選べる。低頻度利用のテナントが
  一律に沈むのを避けられる。([ADR 0165](./docs/decisions/0165-decay-activity-clock.md))
- **`estimateRecallFootprint` が連想枠の分も見積もれる** — 入力
  `RecallFootprintShape.associationCount?`（**省略可能**）を渡すと、返り値に
  `associationCount` が出る。**渡さなければ従来と同じ値が返る**（`?? 0`）。
  ([ADR 0166](./docs/decisions/0166-recall-footprint-association-term.md))
- **`examples/chat` の想起経路が連想枠を既定で使うようになった**（`maxCount=10`）。
  ⚠ **`@mnemora/core` の `recall()` の既定は off のままである**——連想枠は
  `query.association` を渡したときだけ走る（`packages/core/src/recall.ts:1132`
  「省略時は連想を一切走らせない」）。**変わったのは採用側が明示して使うようになったこと**であって、
  ライブラリの既定ではない。
  ([ADR 0168](./docs/decisions/0168-examples-chat-uses-association.md))
- **`tick()` が `consolidate()`/`reflect()` を駆動できる**（既定 off の opt-in、
  `RuntimeConfig.autoQueueConsolidateReflectOnExtract`）。
  ([ADR 0157](./docs/decisions/0157-tick-drives-consolidate-and-reflect.md))

### Fixed

- **連想枠（段3.5）の結果が、同一データに対して実行のたびに変わることがあった。**
  原因は `VectorStore.getVectors()` の返却順（adapter が保証しない順序）にそのまま
  依存していたことで、HNSW の近似性とは無関係だった。アンカーの処理順をランク順に
  固定して直した（Issue #316）。
  ([ADR 0167](./docs/decisions/0167-association-getvectors-order-nondeterminism.md))
