import { Pool, type PoolClient, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import {
  DEFAULT_EXTENSION_SCHEMA,
  type SchemaNamespaceOptions,
  assertSafeSchemaName,
  searchPathFor,
} from "./schema-namespace.js";
import { POOL_ERROR_WARNING_PREFIX } from "./pool-error-warning.js";

/** このパッケージの store が受け取る drizzle のデータベース（`NodePgDatabase`、このパッケージのスキーマ付き）。 */
export type Db = NodePgDatabase<typeof schema>;

/** {@link createPostgresClient} の戻り値。 */
export interface PostgresClient {
  /**
   * `pg` の接続プール。`runMigrations`・`registerEmbeddingSpace` に渡す。閉じるのは呼び出し側の責任
   * （`closePostgresClient`）。
   *
   * ⚠ **`error` のリスナーは常に1つ付いている**（Issue #1213。2026-09-29 に反転した——
   * 以前は付けず、利用者が付けることが前提だった）。**待機中**の接続が DB 側から切られると
   * （Postgres の再起動など）、既定では `console.warn` で名乗って続行する（プロセスは落ちない）。
   * `config.onPoolError` を渡すか、この `pool` に自分で `client.pool.on("error", …)` を付ければ、
   * 既定の警告は出なくなる（packages/postgres/README.md「pool の `error`」）。
   */
  pool: Pool;
  /**
   * 同じプールの上の drizzle。`PostgresMemoryStore` などの store に渡す。
   *
   * ⚠ drizzle に渡しているのは `pool` そのものではなく、`connect` だけを包んだ Proxy である
   * （Issue #868、ADR 0349、{@link createPostgresClient}）。そのため、drizzle が実行時に生やす `db.$client`
   * （型 {@link Db} には載っていない）は `pool` と同一ではない（`db.$client === pool` は `false`）。
   * `db.$client` の `instanceof Pool`・`totalCount`・`on`・`end()` などは、本物の `pool` に届く。
   */
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
 *
 * ## `pool` の `error`: 既定で名乗り、続行する（Issue #1213）
 *
 * pool の中で待機している接続が DB 側から切られる（Postgres の再起動など）と、`Pool` が `error` を出す。
 * **`createPostgresClient` は常に `pool.on("error", …)` を付けるので、リスナーが無くて Node のプロセスごと
 * 落ちることは無い。**
 *
 * - `config.onPoolError` を渡していれば、それだけを呼ぶ（既定の警告は出さない）。
 * - 渡していなければ、`${POOL_ERROR_WARNING_PREFIX} pool の待機中の接続が失われた。捨てて続行する: <message>`
 *   の形で `console.warn` する——**ただし、emit の時点で `pool.listenerCount("error") === 1`
 *   （自分しか聞いていない）ときだけ。** 利用者が自分で `client.pool.on("error", …)` を付けていれば
 *   （`onPoolError` を渡していなくても）、この既定の警告は出ない。付けた順番（`createPostgresClient` の
 *   呼び出しより先か後か）には依らない——判定を emit の時点で行うため。
 *
 * どちらの場合も、切れた接続は pool から捨てられ、次の呼び出しは新しい接続で通る
 * （`packages/postgres/README.md`「pool の `error`」）。`db.transaction()` の途中で切れる場合は別であり、
 * それは下の Proxy が受け持つ（Issue #868）。
 *
 * ⚠ **ADR 0339・ADR 0020 が却下したのは「黙って捨てる」形（空のリスナー）であり、この「名乗る」形は
 * その却下理由には当たらない**（[ADR 0356](../../../docs/decisions/0356-pool-default-error-listener-warns-by-default.md)）。
 *
 * ## drizzle に渡すのは、`connect` だけを包んだ Proxy（Issue #868、ADR 0349）
 *
 * drizzle-orm の `db.transaction()`（`NodePgSession.transaction`）は、渡された pool の
 * `connect()` で接続を借りるが、借りた接続に `error` リスナーを付けない。pg-pool は
 * 借りた接続を渡す直前に自分の idle 用リスナーを外すので、トランザクションの最中に接続が
 * 切れると、リスナーが1つも無いまま `error` が出て、Node のプロセスごと落ちる。
 *
 * そこで drizzle には `new Proxy(pool, …)` を渡し、`connect` だけを
 * {@link connectWithErrorListener} に差し替える。それ以外のプロパティは本物の `pool` から
 * その都度読み、関数なら本物の `pool` に束縛して返す。
 *
 * - **公開する `pool` は書き換えない。**利用者が `client.pool.connect()` で借りた接続には、
 *   mnemora のリスナーは付かない（ADR 0339 と同じく、自分たちが借りたものにだけ付ける）。
 * - 付けたリスナーは `release()` で外す。外さないと、同じ物理接続を借り直すたびに積み上がる。
 * - callback 形の `connect(cb)` は包まずに本物へ渡す（drizzle は promise 形しか使わない）。
 * - ⚠ `db.$client === pool` は `false` になる（`$client` は型 {@link Db} に載っていないので、型は変わらない）。
 */
export function createPostgresClient(
  connectionString: string,
  config?: PoolConfig & SchemaNamespaceOptions & { onPoolError?: (error: Error) => void },
): PostgresClient {
  const { schema: namespaceSchema, extensionSchema, onPoolError, ...poolConfig } = config ?? {};

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
  pool.on("error", (error: Error) => {
    if (onPoolError) {
      onPoolError(error);
      return;
    }
    // 二重の警告を抑える: 利用者が自分で `pool.on("error", …)` を付けていれば
    // （付けた順番に依らず）、emit の時点でリスナーは2つ以上になっている。
    if (pool.listenerCount("error") === 1) {
      console.warn(
        `${POOL_ERROR_WARNING_PREFIX} pool の待機中の接続が失われた。捨てて続行する: ${error.message}`,
        error,
      );
    }
  });
  const db = drizzle(poolWithCheckoutErrorListener(pool), { schema });
  return { pool, db };
}

/**
 * 借りた接続に付ける、何もしない `error` リスナー。
 *
 * 🔴 **同じ関数参照を `on` と `removeListener` の両方に使うこと**（`advisory-lock.ts` の
 * `NOOP_CLIENT_ERROR_HANDLER` と同じ理由）。呼ぶたびに `() => {}` を作ると外せなくなる。
 * 実際のエラーは、進行中のクエリの reject として呼び出し側に届く。
 */
const NOOP_CHECKOUT_ERROR_HANDLER = (): void => {};

/**
 * `pool.connect()`（promise 形）で借りた接続に {@link NOOP_CHECKOUT_ERROR_HANDLER} を付け、
 * `release()` のときに外す。pg-pool は借りるたびに `client.release` を付け直すので、
 * ここで差し替えた `release` は、この1回の貸し出しにしか効かない。
 */
async function connectWithErrorListener(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  client.on("error", NOOP_CHECKOUT_ERROR_HANDLER);
  const release = client.release;
  client.release = (err?: Error | boolean) => {
    client.removeListener("error", NOOP_CHECKOUT_ERROR_HANDLER);
    release.call(client, err);
  };
  return client;
}

/** drizzle に渡す Proxy を作る（{@link createPostgresClient} の「drizzle に渡すのは…」参照）。 */
function poolWithCheckoutErrorListener(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === "connect") {
        return (...args: unknown[]) =>
          args.length === 0
            ? connectWithErrorListener(target)
            : (target.connect as (...a: unknown[]) => unknown).apply(target, args);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
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
