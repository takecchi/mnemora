# ADR 0429: 入力側の公開型の任意欄を `?: T | undefined` に広げ、`exactOptionalPropertyTypes: true` の利用者から `undefined` を渡せるようにする

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローンの委譲先（マネージャー mgr-0629e6a2）が書いた。直し方（下の決めたこと）はクローンが決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  穴探し8巡目 AA が、`exactOptionalPropertyTypes: true`・`skipLibCheck: false` の一時 tsconfig で、build 済みの dist を参照して確かめた。
  `new OpenAIEmbeddingProvider({ model, dimensions, apiKey: undefined })`、`rt.tick(ctx, { leaseMs, signal, limit: lim })`、`rt.recall(ctx, { text, limit: lim })`（`lim: number | undefined`）は、どれも TS2379 で落ちた。
  公開の `.d.ts` に `?:` は464行あったが、`| undefined` を持つのは3か所だけだった。
  一方、実装は `{ k: undefined }` と欄の省略を同じに扱う（`RecallQuery` の全欄で比較済み）。型が実装より狭かった。

  この設定を有効にしている利用者は、`limit: maybeLimit` のように `number | undefined` の値をそのまま渡せず、条件付きスプレッドで欄ごと省くことを強いられていた。
  設定を有効にしていない利用者（`tsconfig.base.json` を含むこのリポジトリ自身）では、`?: T` は `T | undefined` と同じ型なので、この変更は型として何も変えない。

- **決めたこと**:

  1. **入力側の公開型の任意欄を `?: T | undefined` に広げた。** 入力側とは、利用者が値を組み立てて渡す型である。
     - `@mnemora/core`: `AbortOptions`・`RecallQuery`・`RecallScope`・`ObserveUtteranceInput`/`ObserveEventInput`/`ObserveDocumentInput`/`ObserveMemoryUsageInput`・`ClaimKeyOptions`（入れ子の `knownPredicatesFromStore.limit` も）・`TickOptions`・`ForgetOptions`・`PurgeOptions`・`RestoreArchivedOptions`・`RestoreSupersededOptions`・`RestoreSupersededTarget`・`ConsolidateOptions`/`ConsolidateTarget`・`ReflectOptions`/`ReflectTarget`・`Mark/Resolve` 系の各 Options（5つ）・`ApplyCorrectionInput`・`FindCorrectionCandidatesInput`・`EraseTenantOptions`・`PurgeExpiredEventsForTenantOptions`・`RuntimeConfig`・`RuntimeDeps`・`RecallRuntimeDeps`・`EventFilter`・`LexicalFilter`・`VectorFilter`・`AggregateScopeOptions`（`digestBand` も）・`EraseTenantStoreOptions`・`ReinforceOptions`・`ArchiveDecayedOptions`・`PurgeExpiredEventsOptions`/`PurgeExpiredRecallsOptions`/`PurgeExpiredEventsByRetentionOptions`/`PurgeCompletedJobsOptions`・`RequeueEmbedJobsOptions`・`ClaimOutboxJobsOptions`・`NewRecallRecord`・`Build*MemoryParams`（3つ）・`DecayParams`・`ScoringInput`・`RecallFootprintShape`・`FullLogComparisonInput`。`NewMemoryEvent` の `at?`・`NewObservation` の `recordedAt?`（`Omit<…> & { … }` の右側の、自分の欄だけ）。
     - port（`MemoryStore`・`OutboxStore`）のメソッド引数の `opts` の型リテラル（`now`・`claimedBy`・`abortIfForgotten`・`buildCreatedEvent`・`supersededById`・`expectedStatus`・`onlyMemoryIds`・`at` など）。`PostgresMemoryStore`・`PostgresOutboxStore`・`InMemoryMemoryStore`・`InMemoryOutboxStore` の同じメソッドも揃えた。
     - `@mnemora/openai`: `OpenAIEmbeddingProviderOptions`・`OpenAILLMProviderOptions`。`@mnemora/anthropic`: `AnthropicLLMProviderOptions`。`@mnemora/local-embedding`: `LocalEmbeddingProviderOptions`・`LocalEmbeddingRetryOptions`。`@mnemora/bullmq`: `CreateBullmqTickDriverOptions`。
     - `@mnemora/postgres`: `SchemaNamespaceOptions`・`RunMigrationsOptions`・`RegisterEmbeddingSpaceOptions`・`AnalyzeMemoriesOptions`・`createPostgresClient` の設定の `onPoolError`・`PostgresTrigramLexicalStore.create` の `opts.threshold`・`buildLexicalSearchSelect`/`buildTrigramLexicalSearchSelect` の `ctxTenantId`。
     - `@mnemora/testkit`: 適合テストの `*ConformanceOptions`（`Embedding`・`LLM`・`MemoryStore`・`OutboxStore`・`RelationStore`・`TenantSettingsStore`・`VectorStore`）・`RecordedEmbeddingProviderOptions`・`RecordedLLMProviderOptions`。適合テスト本体（`*-conformance.ts`）の検査や要件は変えていない。
  2. **広げなかった型（出力にも使われる型）。** 広げると返り値や利用者が読む型も広がるので、触っていない。
     - `Memory`・`Observation`・`MemoryEvent`・`OutboxJobRecord`・`EventActor`（`MemoryEvent.actor` でもある）・`RecallBudget`（`RecallRecord.budget` でもある）・`RecallAssociationQuery`（定数 `DEFAULT_RECALL_ASSOCIATION` の型でもある）・`RecallFootprintSample`（`footprintSampleFromRecall` の返り値でもある）・`PromptSpec`（`buildExtractionPrompt` などの返り値でもある）・`StatedProvenance`・`ReflectedProvenance`・`RecalledMemory`・`RecallResult` とその部品（`ScoreBreakdown`・`RecallUsage`・各 `*Omission`・`IndexBand` など）・`ObserveResult`・各 `*Outcome`・`RecallRecordMemory`。
     - このため、`NewMemoryEvent`/`NewObservation` の `Omit<MemoryEvent|Observation, …>` の部分の欄（`digestSnapshot?`・`subjectId?`・`occurredAt?` など）と、`NewMemory` の `Partial<Pick<Memory, …>>` の3欄は、`exactOptionalPropertyTypes` の利用者から `undefined` を渡せないまま残る。
     - `Partial<NewMemory>` などを受ける testkit の `buildNew*Fixture(overrides)` も触っていない。実装が `{ ...base, ...overrides }` で、`undefined` が既定値を上書きする（省略とは扱いが違う）。型を広げると、この上書きを許すことになる。
     - 適合テストが利用者の callback へ渡す `PrepareMemoryIdAttrs`・`PrepareLexicalMemoryAttrs`・`SeedOutboxJobInput` は、testkit が組み立てて利用者が読む側（出力）なので触っていない。
     - 利用者の自前の adapter が受け取る側でもある型は、入力として組み立てる口があっても広げなかった。例は `Ctx`（store の各メソッドが第1引数で受け取る）と `OutboxJob`（自前の `Scheduler` が受け取る）である。`exactOptionalPropertyTypes: true` の利用者では、受け取った値を狭い型（`{ subjectId?: string }` など）へ代入するコードが壊れうるので、非破壊と言い切れない。上の callback が受け取る型と同じ線に揃えた。いったん広げたが、同じ PR の中で戻した。
     - `Anthropic*`/`OpenAI*` のクライアント境界の型（`AnthropicMessageCreateParams`・`AnthropicMessageResult`・`OpenAIChatCompletionCreateParams` など）は、SDK の形を写した構造の型であり、利用者が渡す options ではないので触っていない。
     - `cause?: unknown`（`AnthropicLLMProviderErrorOptions`・`OpenAILLMProviderErrorOptions`）は、`unknown` がすでに `undefined` を含むので触っていない。
  3. **`undefined` と省略の扱いが同じかを確かめた。** `"x" in opts`・`Object.keys`・`hasOwnProperty`・オプションの spread は、入力型を受け取る側に見つからなかった（`grep`）。
     入力の欄は、`opts?.x ?? 既定`・`opts.x !== undefined`・zod の `.optional()` のどれかで読まれている。エラーの `cause` は、渡す側が `!== undefined` で分けている。
     扱いが違うと分かった欄は、広げた側には無かった。違いがあったのは上の `buildNew*Fixture(overrides)` だけで、広げていない。
  4. **利用者の自前 adapter が壊れないことを確かめた。** `MemoryStore`・`OutboxStore` などのメソッドはメソッド記法で宣言されており、引数の型は双変で比べられる。狭い型で実装している既存の自前 adapter は、型エラーにならない（`pnpm run typecheck` で `InMemory*`・`Postgres*` の実装と適合テストが通った）。
     `exactOptionalPropertyTypes` を有効にしていない利用者では、`?: T` と `?: T | undefined` は同じ型で、何も変わらない。
  5. **歯を足した。** `scripts/__tests__/exact-optional-input-types.test.mjs` が、`scripts/__fixtures__/exact-optional-input-types.probe.ts` を `exactOptionalPropertyTypes: true` で型検査し、診断が0件であることを見る。
     - probe は、上の入力型の任意欄のすべてについて `{ 欄: undefined }` が代入できることを型で確かめる（`BadKeys<T>` が `never`）。加えて、穴探し AA で落ちた3つの呼び出しの形を書いている。
     - 各パッケージの **src** を `paths` で指すので、`pnpm run build` より前に走るルートの `pnpm run test`（CI の `build` ジョブ）で動く。probe 以外の診断は数えない（src 自身は `exactOptionalPropertyTypes: false` で書かれている）。
     - 陽性対照として、既知の赤い行を含む一時ソースが同じ設定で TS2375 を出すことも見る。設定が黙って効かなくなったときに、0件の緑が偽にならない。
     - `.github/workflows/*` は変えていない。
  6. `scripts/__snapshots__/public-api/*.d.ts` を更新した。差分は `| undefined` の追加だけである（関数型の欄は、括弧を足して `((…) => …) | undefined` にした）。
     `docs/architecture.md` §5 の port 署名の写しも、同じ形に揃えた（`architecture-section5-port-signature-correspondence.test.mjs` が写しと実体の一致を見ている）。

- **検討した代替案**:

  1. **`tsconfig.base.json` で `exactOptionalPropertyTypes: true` にして、リポジトリ自身も同じ厳しさで書く。** 採らなかった。src 全体の書き直しになり、今回の穴（利用者が渡す型が狭い）に対して大きすぎる。歯は probe の1ファイルだけを厳しい設定で検査する形で足りる。
  2. **出力兼用の型も含めて、公開の `?:` をすべて広げる。** 採らなかった。返り値や利用者が読む型が `T | undefined` へ広がり、利用者の読み取りの側の型が変わる。
  3. **利用者に、条件付きスプレッドで欄を省くよう文書で案内する。** 採らなかった。実装は `undefined` と省略を同じに扱うので、型のほうを実装に合わせるほうが小さい。
  4. **probe を dist に向けて `pnpm run build` の後に走らせる。** 採らなかった。ルートの `pnpm run test` は build より前に走るので、dist を要る歯は順序に縛られる。src を指せば順序に依らない。

- **引き受けた負債**:

  - 出力兼用の型に由来する欄（`MemoryEvent`・`Memory`・`EventActor` など）は、`exactOptionalPropertyTypes` の利用者から `undefined` を渡せないまま残る。完全な解消には、入力用と出力用の型を分ける変更（公開型の追加）が要る。
  - probe の型リストは手で持っている。新しい入力型を足したときに probe へ足し忘れても、この歯は赤くならない（`?: T` のままの新しい入力型を検出する歯ではない）。
  - probe の型検査は TypeScript のコンパイラ API を使う。約2秒で終わったが、`typescript` のバージョンを上げると診断の文言や範囲が変わりうる（歯は診断の件数だけを見ている）。

- **これが覆るとしたら**:

  出力兼用の型を入力用と出力用に分けると決めたら、「広げなかった型」も広げられる。
  リポジトリ自身を `exactOptionalPropertyTypes: true` で書くと決めたら、probe は tsconfig の検査に置き換わる。
  `undefined` を渡したときに省略と違う動きをさせたい欄が生まれたら、その欄は `?: T`（`| undefined` なし）に戻し、この ADR の一覧から外す。

- **測ったこと**:

  - 直す前の src（`git stash` で公開型の変更だけを外した状態）で probe を検査すると、診断は85件だった。TS2379 が5件（probe の `_callSites` の5つの呼び出し）、TS2322 が80件（任意欄の型検査の代入）。直した後は0件。`Ctx`・`OutboxJob` を戻して probe から外した後は、広げる前の src（main の版）で83件（TS2379 が5件、TS2322 が78件）、直した後は0件。
  - `undefined` と省略の同値を、testkit のインメモリ実装＋ `createRuntime` で、前者は欄を省いた入力、後者は同じ入力に全欄を `undefined` で足した入力にして、`observe`（3種の kind）・`tick`・`recall`・`forget`・`purge`・`restoreArchived`・`restoreSuperseded`・`markContested`・`resolveContested`・`sweepArchive`・`reembed`・`consolidate`・`reflect`・`findCorrectionCandidates`・`reinforce`・`aggregateScope`・`updateStatus`・`EventStore.list`・`VectorStore.search` の返り値と、保存された記憶・イベント・ジョブを、`undefined` を印に変えた JSON で比べた。id と壁時計の `createdAt`/`updatedAt` の差を除いて、すべて一致した（使い捨てのテストで、コミットしていない）。
  - 狭い型（`opts?: { at?: Date }`）のまま `OutboxStore` の `complete`/`fail` を実装した自前 adapter のクラスを、`exactOptionalPropertyTypes: true` で `OutboxStore` へ代入すると、診断は0件だった（使い捨ての確認で、コミットしていない）。
  - `@mnemora/postgres` の実装は、DB に繋いでは確かめていない。opts の読み方をコードで確かめた（`?? 既定`・`!== undefined`）。
  - `pnpm run typecheck`（全パッケージと `examples/chat`）・eslint・prettier・`api:check` が通った。`schema-type-equals-parity`・`dependency-boundary`・`fixtures-entry-public-types`・両 provider の `client-type-compat`・`architecture-section5-*`・`check-public-api-surface` のテストも通った。
