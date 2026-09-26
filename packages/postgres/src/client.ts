import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import {
  DEFAULT_EXTENSION_SCHEMA,
  type SchemaNamespaceOptions,
  assertSafeSchemaName,
  searchPathFor,
} from "./schema-namespace.js";

export type Db = NodePgDatabase<typeof schema>;

export interface PostgresClient {
  pool: Pool;
  db: Db;
}

/**
 * `MemoryStore` / `VectorStore` / `EventStore` を1接続で実装するための唯一の入口
 * （ADR 0001・ADR 0003: リファレンス実装は同一 DB・同一トランザクション）。
 *
 * ## `config.schema`（feat/dedicated-schema）
 *
 * **`schema` 未指定なら、`PoolConfig` に手を加えない**——`options` に一切触らないため、
 * 今日と同じ `Pool` が作られる。
 *
 * `schema` を指定すると、libpq の startup parameter `options` に
 * `-c search_path=<searchPathFor(...)>` を載せる。
 *
 * **なぜ毎接続で `SET search_path` を発行する（`connect` イベントで `SET` する）
 * 形にせず、startup parameter `options` を使うのか**: `options` は接続確立時に
 * サーバへ渡るパラメータなので、**pool が新しいコネクションを張り直しても
 * 自動的に適用される**。`connect` イベントで `SET` する形は、張り直しのたびに
 * 取りこぼしなく処理を挟む必要があり（イベント購読の順序・エラー処理が絡む）、
 * 余計な往復も要る。`pg@8.23.0` が `options` を startup parameter として実際に
 * 送ることは `node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/connection-parameters.js`
 * の `add(params, this, 'options')`（`getLibpqConnectionString`）と、
 * `node_modules/.pnpm/pg@8.23.0/node_modules/pg/lib/client.js` の
 * `if (params.options) { data.options = params.options }`（`connect` 内、
 * 生 socket 経路の startup message 組み立て）で確認した。
 *
 * `schema` / `extensionSchema` は `SchemaNamespaceOptions` のプロパティであり、
 * pg の `PoolConfig` が知っているキーではない——**分割代入で明示的に取り除いて**から
 * 残りを `Pool` へ渡す（pg は知らないキーを無視するはずだが、その挙動に依存しない）。
 *
 * 呼び出し側が既に `config.options` を渡していた場合は、**その値の後ろに空白区切りで
 * 追記する**（上書きして黙って捨てない）。
 */
export function createPostgresClient(
  connectionString: string,
  config?: PoolConfig & SchemaNamespaceOptions,
): PostgresClient {
  const { schema: namespaceSchema, extensionSchema, ...poolConfig } = config ?? {};

  if (namespaceSchema !== undefined) {
    assertSafeSchemaName(namespaceSchema);
    const resolvedExtensionSchema = extensionSchema ?? DEFAULT_EXTENSION_SCHEMA;
    assertSafeSchemaName(resolvedExtensionSchema);
    const searchPath = searchPathFor(namespaceSchema, resolvedExtensionSchema);
    poolConfig.options = poolConfig.options
      ? `${poolConfig.options} -c search_path=${searchPath}`
      : `-c search_path=${searchPath}`;
  }

  const pool = new Pool({ connectionString, ...poolConfig });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

/**
 * `client` ごとに、進行中/完了済みの `closePostgresClient` の `Promise` を覚える
 * （Issue #935）。`PostgresClient` という公開の型そのものには手を触れず、
 * `WeakMap` の外側から冪等性を持たせる。
 */
const closingPromises = new WeakMap<PostgresClient, Promise<void>>();

/**
 * `client.pool.end()` を呼ぶ。**2回目以降の呼び出しは冪等**——`node-postgres`
 * （`pg`）の `Pool.end()` は、既に `end()` 済みの `Pool` にもう一度呼ぶと
 * `Called end on pool more than once` で reject するが、この関数は同じ `client`
 * に対して呼ばれるたびに、その `client` の最初の呼び出しが作った `Promise` を
 * 使い回す——**2回目以降は `pool.end()` を呼び直さず、何もせずに resolve する**
 * （並行に2回呼ばれた場合も、どちらも同じ `Promise` を待つだけで reject しない）。
 *
 * `close()` 後にクエリを投げたときの振る舞い（`pg` 側がどう reject するか）は
 * 変えていない——冪等にしたのは「閉じる」という操作そのものだけである。
 */
export async function closePostgresClient(client: PostgresClient): Promise<void> {
  const existing = closingPromises.get(client);
  if (existing !== undefined) {
    return existing;
  }
  const closing = client.pool.end();
  closingPromises.set(client, closing);
  return closing;
}
