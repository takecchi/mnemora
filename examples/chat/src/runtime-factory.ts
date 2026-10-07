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

const LEXICAL_STORE_MODES = ["default", "trigram"] as const;
export type LexicalStoreMode = (typeof LEXICAL_STORE_MODES)[number];

/** 空文字・未指定は `"default"`。設定しない既存の呼び出しは今日どおり `PostgresLexicalStore` のまま（既定は変えない）。 */
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
  mode: ProviderMode;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  lexicalStoreMode: LexicalStoreMode;
  usageMeter?: UsageMeter;
  cassetteIgnored: boolean;
  memoryStore: PostgresMemoryStore;
  embeddingProvider: EmbeddingProvider;
  pool: PostgresClient["pool"];
  tenantSettingsStore: PostgresTenantSettingsStore;
  eventStore: PostgresEventStore;
  /** 冪等: 2回目以降は何もせず resolve する。 */
  close(): Promise<void>;
}

/**
 * `runMigrations`・`registerEmbeddingSpace` の並行安全は advisory lock による。`IF NOT EXISTS` 系は並行では非アトミックなので頼らない。
 * `"trigram"` を選んだのに拡張・ロケールの前提を満たせないときは例外にする（黙って `PostgresLexicalStore` に戻さない）。
 */
export async function createExampleRuntime(
  databaseUrl: string,
  env: EnvLike = process.env,
  providerOptions: CreateProvidersOptions = {},
  clock?: Clock,
): Promise<ExampleRuntimeHandle> {
  const client = createPostgresClient(databaseUrl);
  // `client` を作った後に失敗しうる処理が続く。呼び出し側は `await createExampleRuntime(...)` を `try` の外に置くので、
  // ここで reject すると `close()` を呼ばれず `Pool` が開いたまま残る。だからここで閉じる。
  try {
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
  } catch (err) {
    // 元の失敗（`err`）を `close()` 自体の失敗で上書きしない。
    await closePostgresClient(client).catch(() => {});
    throw err;
  }
}
