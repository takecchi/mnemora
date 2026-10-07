import {
  type PostgresClient,
  createPostgresClient,
  embeddingSpaceTableName,
  registerEmbeddingSpace,
  runMigrations,
} from "@mnemora/postgres";
import { DETERMINISTIC_EMBEDDING_SPACE } from "../providers.js";

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL が設定されていません。examples/chat のテストは本物の Postgres + " +
        "pgvector が必要（擬似物では代替しない）。examples/chat/README.md を参照。",
    );
  }
  return url;
}

let sharedClient: PostgresClient | undefined;
let ready: Promise<void> | undefined;

export async function getTestClient(): Promise<PostgresClient> {
  if (!sharedClient) {
    sharedClient = createPostgresClient(requireDatabaseUrl());
  }
  if (!ready) {
    ready = (async () => {
      await runMigrations(sharedClient!.pool);
      await registerEmbeddingSpace(sharedClient!.pool, DETERMINISTIC_EMBEDDING_SPACE);
    })();
  }
  await ready;
  return sharedClient;
}

const DOMAIN_TABLES = [
  "recall_usages",
  "recalls",
  "memory_events",
  "outbox",
  embeddingSpaceTableName(DETERMINISTIC_EMBEDDING_SPACE),
  "memories",
  "observations",
  "tenant_settings",
];

export async function resetTestDatabase(): Promise<void> {
  const { pool } = await getTestClient();
  await pool.query(`TRUNCATE TABLE ${DOMAIN_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

export async function closeTestClient(): Promise<void> {
  if (sharedClient) {
    await sharedClient.pool.end();
    sharedClient = undefined;
    ready = undefined;
  }
}
