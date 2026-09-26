import { Pool, type PoolClient, type PoolConfig } from "pg";
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
 * `pool.connect()` で借り切った checked-out client に付ける、何もしない `error`
 * リスナー（ADR 0339・{@link protectCheckedOutClientsFromUnhandledErrors} 参照）。
 *
 * 🔴 モジュールで1つだけの、同じ関数参照を使い回すこと（`migrate.ts`/`advisory-lock.ts`
 * の同名の定数と同じ理由——`on`/`removeListener` に別々の関数を使うと外せず、
 * `pg-pool` が使い回す物理コネクションにリスナーが積み上がる）。
 */
const NOOP_CLIENT_ERROR_HANDLER = (): void => {};

/**
 * `pool.connect()` それ自体を、返す checked-out client に空の `error` リスナーを
 * 自動で付け外しするものへその場で置き換える（ADR 0340）。
 *
 * ## なぜ要るか
 *
 * ADR 0339 は `migrate.ts`/`advisory-lock.ts` **自身**が呼ぶ `pool.connect()` に、
 * 借りたクライアントへの `error` リスナー欠如（`pg` は「checked-out client の
 * 接続断は呼び出し側が自分で拾うこと」を要求しており、拾わないと Node の
 * `EventEmitter` の既定動作でプロセス全体が uncaught exception で落ちる）を対策した。
 *
 * だが `db.transaction()`（drizzle-orm、`drizzle-orm/node-postgres/session.js` の
 * `NodePgSession.transaction`）も**同じ形で** `pool.connect()` を呼ぶ——
 * `await this.client.connect()` で checked-out client を借り、`finally` で
 * `release()` するが、`error` リスナーは一切付けない。`memory-store.ts`/
 * `vector-store.ts`/`trigram-lexical-store.ts` の全ての `db.transaction()` 呼び出しが
 * この経路を通るため、対策が無いとトランザクション実行中の接続断（DB の再起動・
 * フェイルオーバー・運用者による切断・OOM kill）でプロセスが丸ごと落ちる——
 * `db-transaction-connection-loss.test.ts` が `pg_terminate_backend` で実測。
 *
 * `drizzle-orm` は node_modules 内の依存であり直接編集できない。`createPostgresClient`
 * は `db.transaction()` が使う `Pool` インスタンスを作る唯一の入口（doc コメント参照）
 * なので、ここで作った直後にその `Pool` インスタンス自身の `connect` を、生成時にだけ
 * 差し替える——`drizzle()` にも呼び出し側にも、以後は今日と同じ `Pool` に見える。
 *
 * ⚠ **このコードベースは `pool.connect()` の promise 形しか使わない**
 * （`migrate.ts`/`advisory-lock.ts`/drizzle-orm、いずれも）。callback 形
 * （`pool.connect((err, client, done) => ...)`）は使われていないため、渡ってきたら
 * 対策せずそのまま元の実装へ委譲する（呼ばれない経路のために作り込まない）。
 *
 * ⚠ **`migrate.ts`/`advisory-lock.ts` 自身が付ける `error` リスナーと二重になる**——
 * `runMigrations`/`acquireAdvisoryLock` がこの `Pool` を受け取って呼ばれた場合
 * （`test-db.ts` の `getTestClient()` が実際にそうしている）、同じ checked-out
 * client に2つの no-op リスナー（別の関数参照）が付く。害は無い——`EventEmitter` は
 * 同じイベントに複数のリスナーを同時に持て、どちらも自分の `release()`/`removeListener`
 * の対で正しく外れる（積み上がらない）。
 */
function protectCheckedOutClientsFromUnhandledErrors(pool: Pool): void {
  const originalConnect = pool.connect.bind(pool);
  pool.connect = ((
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ) => {
    if (callback) {
      return originalConnect(callback);
    }
    return (async (): Promise<PoolClient> => {
      const client = await originalConnect();
      client.on("error", NOOP_CLIENT_ERROR_HANDLER);
      const originalRelease = client.release.bind(client);
      client.release = ((err?: Error | boolean) => {
        client.removeListener("error", NOOP_CLIENT_ERROR_HANDLER);
        return originalRelease(err);
      }) as PoolClient["release"];
      return client;
    })();
  }) as Pool["connect"];
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
  protectCheckedOutClientsFromUnhandledErrors(pool);
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export async function closePostgresClient(client: PostgresClient): Promise<void> {
  await client.pool.end();
}
