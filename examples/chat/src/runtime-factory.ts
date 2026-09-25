import type { Clock, EmbeddingProvider, LexicalStore, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import type { PostgresClient } from "@mnemora/postgres";
import {
  PostgresEventStore,
  PostgresLexicalStore,
  PostgresMemoryStore,
  PostgresOutboxStore,
  PostgresTenantSettingsStore,
  PostgresTrigramLexicalStore,
  PostgresVectorStore,
  closePostgresClient,
  createPostgresClient,
  registerEmbeddingSpace,
  runMigrations,
  sha256Hex,
} from "@mnemora/postgres";
import type { CreateProvidersOptions, EnvLike, ProviderMode } from "./providers.js";
import { createProviders } from "./providers.js";
import type { UsageMeter } from "./usage-meter.js";

/** `MNEMORA_LEXICAL_STORE` が受け付ける値。`"default"` が今日どおり（`PostgresLexicalStore`）。 */
const LEXICAL_STORE_MODES = ["default", "trigram"] as const;
export type LexicalStoreMode = (typeof LEXICAL_STORE_MODES)[number];

/**
 * `MNEMORA_LEXICAL_STORE` を読む（Issue #278, ADR 0319）。**空文字・未指定は `"default"`**
 * （`selectLLMMode`/`selectEmbeddingMode`「空文字は未指定」と同じ作法、`providers.ts`）。
 *
 * ⛔ **既定を変えない**: この環境変数を一切設定しない既存の呼び出しは
 * `"default"` になり、`createExampleRuntime` は今日どおり `PostgresLexicalStore` を
 * 配線する——1バイトも挙動が変わらない。`"trigram"` を明示したときだけ
 * `PostgresTrigramLexicalStore`（opt-in、pg_trgm）に差し替わる。
 */
export function selectLexicalStoreMode(env: EnvLike): LexicalStoreMode {
  const value = env.MNEMORA_LEXICAL_STORE;
  if (value === undefined || value === "") {
    return "default";
  }
  if ((LEXICAL_STORE_MODES as readonly string[]).includes(value)) {
    return value as LexicalStoreMode;
  }
  throw new Error(
    `MNEMORA_LEXICAL_STORE には ${LEXICAL_STORE_MODES.map((m) => `"${m}"`).join(" / ")} の` +
      `いずれかを指定すること（実際: "${value}"）。`,
  );
}

export interface ExampleRuntimeHandle {
  runtime: Runtime;
  /** 後方互換のために残す単一ラベル（`providers.ts` の `Providers.mode` と同じ注記）。 */
  mode: ProviderMode;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** `selectLexicalStoreMode(env)` の結果（Issue #278, ADR 0319）。既定は `"default"`。 */
  lexicalStoreMode: LexicalStoreMode;
  /** `llmMode`/`embeddingMode` のどちらかが `"openai"` のときだけ存在する。 */
  usageMeter?: UsageMeter;
  /** `createProviders` が計算した値をそのまま通す（`providers.ts` の `Providers.cassetteIgnored` docstring参照）。 */
  cassetteIgnored: boolean;
  /**
   * retrieval-quality（PR 本文 (D)）が memory → observation の系譜を辿るために公開する。
   * `packages/core`/`packages/postgres` は変更していない——`MemoryStore` は元から
   * 公開 interface であり（`get`/`getObservation` は roadmap.md 段階3から存在する）、
   * これまで `createExampleRuntime` の返り値に含めていなかっただけ。
   */
  memoryStore: PostgresMemoryStore;
  /**
   * Issue #109 が公開する。`@mnemora/local-embedding` は `embed()` を初回まで遅延ロードする
   * （README「モデルは最初の `embed()` まで読み込まれない」）ため、「重みを取得できなかった」
   * と「測ったが値が悪かった」を区別したい呼び出し側（`identifier-probes` サブコマンド、
   * `local-embedding-warmup.ts`）は、`recall()`/`observe()` を呼ぶ前に明示的に
   * `embeddingProvider.warmup()` を呼んで先に失敗させる必要がある。**`packages/core`/
   * `packages/postgres` は変更していない**——`EmbeddingProvider` は元から
   * `createProviders` が返す公開の値であり、これまで `createExampleRuntime` の
   * 返り値に含めていなかっただけ（`memoryStore` を足したときと同じ理由）。
   */
  embeddingProvider: EmbeddingProvider;
  /**
   * `consolidation-cost`（Issue #136）が公開する。ADR 0090 の
   * `LocalEmbeddingProviderError.kind`（`"input_too_long"` 等）は `Memory`/`MemoryStore`
   * の列に残らない——`packages/core`/`packages/postgres` を変更しない制約の中でこれを
   * 読む唯一の手段は、`outbox.last_error` に残った文字列を読むことである
   * （`embed-failure-kind.ts` 参照）。`memoryStore`/`embeddingProvider` を足したときと
   * 同じ理由：`client.pool` は元から `createPostgresClient` の公開の返り値であり、
   * これまで `createExampleRuntime` の返り値に含めていなかっただけ。
   */
  pool: PostgresClient["pool"];
  /**
   * `--decay-clock`（ADR 0165 決めたこと11）が実際に `tenant_settings.decay_clock` へ
   * 書き込むために公開する。**`packages/core`/`packages/postgres` は変更していない**
   * ——`PostgresTenantSettingsStore` は元から公開の class であり、これまで
   * `createExampleRuntime` の返り値に含めていなかっただけ（`memoryStore` を
   * 足したときと同じ理由）。書き込みは公開 interface の `writeDecayClock`
   * （`@mnemora/core`）を通してのみ行う——生 SQL の UPSERT は増やさない。
   */
  tenantSettingsStore: PostgresTenantSettingsStore;
  /**
   * Issue #369 チェックボックス（選んだ根拠を `memory_events.meta.note` から辿れるように
   * する）の歯が公開する。**`packages/core`/`packages/postgres` は変更していない**——
   * `PostgresEventStore` は元から公開の class であり、これまで `createExampleRuntime`
   * の返り値に含めていなかっただけ（`memoryStore`/`tenantSettingsStore` を足したときと
   * 同じ理由）。`correction-demo.postgres.test.ts` が `memory_events` を読み戻して
   * `meta.note` に選んだ根拠が実際に届いているかを検査するために使う。
   */
  eventStore: PostgresEventStore;
  close(): Promise<void>;
}

/**
 * サンプルアプリの `Runtime` を組み立てる（roadmap.md 段階7）。
 *
 * - `packages/postgres` に対してマイグレーションと埋め込み空間登録を行う。
 *   `runMigrations`（ADR 0017）・`registerEmbeddingSpace`（ADR 0018）は**どちらも**
 *   advisory lock でプロセス間排他される——複数のレプリカが同時にこの関数を呼んでも安全。
 *   **「`IF NOT EXISTS` 系だから安全」ではない**（段階1の実測で、`CREATE TABLE
 *   IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` はいずれも並行では非アトミックで、
 *   複数プロセスが同時に呼ぶと決定的にどちらか一方が落ちることを確認済み。
 *   `runMigrations` は ADR 0017、`registerEmbeddingSpace` は ADR 0018 を参照）。
 *   2つの関数は別々の advisory lock キーを使う（`MIGRATION_LOCK_KEY` /
 *   `REGISTER_EMBEDDING_SPACE_LOCK_KEY`）ため、互いをブロックしない。
 * - `packages/testkit` の擬似 provider か、本物の `packages/openai` かは
 *   `createProviders`（`OPENAI_API_KEY` の有無）が決める。
 * - `clock` は省略可能（既定は `packages/core` 側の `systemClock`、`RuntimeDeps.clock` が
 *   `undefined` のときの既定動作）。既存の呼び出し（1〜3引数）はそのまま通る——
 *   `decay` を `freshness` から分離して測る `time-term` arm（`mutable-clock.ts` の
 *   `MutableClock`）だけがこの4番目の引数を渡す。**`packages/*` は変更していない**
 *   （`RuntimeDeps.clock` は元から公開 interface の省略可能な欄である）。
 * - **`lexicalStore` を常に配線する**（ADR 0148、Issue #179）。`RuntimeDeps.lexicalStore`
 *   に `PostgresLexicalStore` を渡す——`packages/core` の `recall()` は `channels` に
 *   `"lexical"` を含めたときだけこの store を呼ぶため、**配線そのものは既定の挙動を
 *   1バイトも変えない**（`RecallQuery.channels` の既定は `DEFAULT_RECALL_CHANNELS`
 *   = `["ann"]` のまま、`packages/core` 側も変更していない）。**`channels` を明示して
 *   `"lexical"` を含めた呼び出し側だけが、この配線の効果を受け取る。**
 * - **`MNEMORA_LEXICAL_STORE=trigram`（Issue #278、ADR 0319）で opt-in の
 *   `PostgresTrigramLexicalStore` に差し替えられる**（{@link selectLexicalStoreMode}）。
 *   **未設定・空文字は今日どおり `PostgresLexicalStore`**——既定は1バイトも変わらない。
 *   `"trigram"` を指定すると `PostgresTrigramLexicalStore.create()` を呼ぶ——拡張・ロケール
 *   の前提を満たせない環境（`server_encoding` が `UTF8` でない等）では、ここで
 *   `TrigramLexicalStoreUnavailableError` が投げられ `createExampleRuntime` 自体が失敗する
 *   （黙って `PostgresLexicalStore` にフォールバックしない——「trigram を選んだのに
 *   実は既定のままだった」という静かな取り違えを避けるため）。
 */
export async function createExampleRuntime(
  databaseUrl: string,
  env: EnvLike = process.env,
  providerOptions: CreateProvidersOptions = {},
  clock?: Clock,
): Promise<ExampleRuntimeHandle> {
  const client = createPostgresClient(databaseUrl);
  await runMigrations(client.pool);

  const {
    llmProvider,
    embeddingProvider,
    mode,
    llmMode,
    embeddingMode,
    usageMeter,
    cassetteIgnored,
  } = createProviders(env, providerOptions);
  await registerEmbeddingSpace(client.pool, embeddingProvider.space);

  const lexicalStoreMode = selectLexicalStoreMode(env);
  const lexicalStore: LexicalStore =
    lexicalStoreMode === "trigram"
      ? await PostgresTrigramLexicalStore.create(client.db)
      : new PostgresLexicalStore(client.db);

  const memoryStore = new PostgresMemoryStore(client.db);
  const tenantSettingsStore = new PostgresTenantSettingsStore(client.db);
  const eventStore = new PostgresEventStore(client.db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(client.db),
    vectorStore: new PostgresVectorStore(client.db),
    lexicalStore,
    eventStore,
    tenantSettingsStore,
    llmProvider,
    embeddingProvider,
    hashContent: sha256Hex,
    ...(clock !== undefined ? { clock } : {}),
  });

  return {
    runtime,
    mode,
    llmMode,
    embeddingMode,
    lexicalStoreMode,
    cassetteIgnored,
    ...(usageMeter !== undefined ? { usageMeter } : {}),
    memoryStore,
    tenantSettingsStore,
    eventStore,
    embeddingProvider,
    pool: client.pool,
    close: () => closePostgresClient(client),
  };
}
