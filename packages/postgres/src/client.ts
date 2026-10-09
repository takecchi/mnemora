import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import {
  DEFAULT_EXTENSION_SCHEMA,
  type SchemaNamespaceOptions,
  assertSafeSchemaName,
  searchPathFor,
} from "./schema-namespace.js";
import { POOL_ERROR_WARNING_HEAD } from "./pool-error-warning.js";

/** このパッケージの store が受け取る drizzle のデータベース。 */
export type Db = NodePgDatabase<typeof schema>;

/** {@link createPostgresClient} の戻り値。 */
export interface PostgresClient {
  /**
   * `pg` の接続プール。`runMigrations`・`registerEmbeddingSpace` に渡す。閉じるのは呼び出し側の責任（`closePostgresClient`）。
   *
   * `error` のリスナーは常に1つ付いている。待機中の接続が DB 側から切られると（Postgres の再起動など）、既定では
   * `console.warn` で名乗って続行する（プロセスは落ちない）。`config.onPoolError` を渡すか、この `pool` に
   * 自分で `client.pool.on("error", …)` を付ければ、既定の警告は出なくなる（packages/postgres/README.md「pool の `error`」）。
   */
  pool: Pool;
  /**
   * 同じプールの上の drizzle。`PostgresMemoryStore` などの store に渡す。
   *
   * drizzle に渡しているのは `pool` そのものではなく、`connect` だけを包んだ Proxy である（ADR 0349）。
   * そのため drizzle が実行時に生やす `db.$client`（型 {@link Db} には載っていない）は `pool` と同一ではない
   * （`db.$client === pool` は `false`）。`instanceof Pool`・`totalCount`・`on`・`end()` などは本物の `pool` に届く。
   */
  db: Db;
}

/**
 * `MemoryStore` / `VectorStore` / `EventStore` を1接続で実装するための唯一の入口（ADR 0001・ADR 0003）。
 *
 * ## DB エラーの `code` の在り処は3つの形に分かれる（ADR 0444 決定4、ADR 0552）
 *
 * 形は揃えていない（揃えるには例外の包み方を変える必要があり、公開の約束が動く）。
 * 判定するなら両方を見ること: `err.code ?? err.cause?.code`。
 *
 * - ① 包まれていない `pg` の例外（`err.code`）。`db.transaction()` が接続を借りる段と、
 *   `client.pool.query()`・`client.pool.connect()` を直接呼んだとき。
 * - ② `DrizzleQueryError`（`err.cause.code`、`err.code` は無い）。文を実行している最中と、`db.execute` が接続を借りる段。
 * - ③ `code` が無いもの。pool の枯渇（`timeout exceeded when trying to connect`）と、サーバーが応答しないときの
 *   接続タイムアウト（`Connection terminated due to connection timeout`）。借りる口が `db.transaction`・`pool.*` なら
 *   包まれず、`db.execute` なら `DrizzleQueryError` の `cause` の中に入る。文面でしか分からない（約束しない）。
 *
 * 表と場面は `packages/postgres/README.md` の「pool が枯れたとき・Postgres の再起動の最中に出る例外の形」節。
 *
 * ## `config.schema`
 *
 * `schema` 未指定なら `PoolConfig` に手を加えない。指定すると、libpq の startup parameter `options` に
 * `-c search_path=<searchPathFor(...)>` を載せる。呼び出し側が既に `config.options` を渡していれば、
 * その値の後ろに空白区切りで追記する。
 *
 * `schema` を指定したときは、`schema` と `extensionSchema`（省略時は {@link DEFAULT_EXTENSION_SCHEMA}）を、
 * 接続オプションへ入れる前に `assertSafeSchemaName` で検査する。通らなければ `Pool` を作らずに `Error` を投げる。
 *
 * 接続のたびに `SET search_path` を発行する形（`connect` イベントで `SET`）にしない。`options` は接続確立時に
 * サーバへ渡るので、pool が接続を張り直しても自動的に適用される。`connect` イベントで `SET` する形は、
 * 張り直しのたびに取りこぼしなく処理を挟む必要があり、余計な往復も要る。
 * `schema` / `extensionSchema` は `PoolConfig` のキーではないので、分割代入で取り除いてから `Pool` へ渡す。
 *
 * ## `pool` の `error`: 既定で名乗り、続行する
 *
 * 常に `pool.on("error", …)` を付けるので、リスナーが無くてプロセスごと落ちることは無い。
 *
 * - `config.onPoolError` を渡していれば、それだけを呼ぶ（既定の警告は出さない）。
 * - 渡していなければ `console.warn` する。ただし emit の時点で `pool.listenerCount("error") === 1`
 *   （自分しか聞いていない）ときだけ。利用者が自分で `client.pool.on("error", …)` を付けていれば、
 *   付けた順番に依らず警告は出ない。
 *
 * どちらの場合も切れた接続は pool から捨てられ、次の呼び出しは新しい接続で通る。`db.transaction()` の途中で
 * 切れる場合は別で、下の Proxy が受け持つ。「黙って捨てる」空のリスナーは ADR 0339・ADR 0020 が却下した形で、
 * 「名乗る」この形は当たらない（[ADR 0356](../../../docs/decisions/0356-pool-default-error-listener-warns-by-default.md)）。
 *
 * ## drizzle に渡すのは、`connect` だけを包んだ Proxy（ADR 0349）
 *
 * drizzle の `db.transaction()` は pool の `connect()` で接続を借りるが、借りた接続に `error` リスナーを付けない。
 * pg-pool は借りた接続を渡す直前に自分の idle 用リスナーを外すので、トランザクションの最中に接続が切れると
 * リスナーが1つも無いまま `error` が出て、プロセスごと落ちる。そこで `connect` だけを
 * {@link connectWithErrorListener} に差し替えた Proxy を渡す。
 *
 * - 公開する `pool` は書き換えない。利用者が `client.pool.connect()` で借りた接続には mnemora のリスナーは付かない。
 * - 付けたリスナーは `release()` で外す（外さないと、同じ物理接続を借り直すたびに積み上がる）。
 * - callback 形の `connect(cb)` は包まずに本物へ渡す（drizzle は promise 形しか使わない）。
 */
export function createPostgresClient(
  connectionString: string,
  config?: PoolConfig &
    SchemaNamespaceOptions & { onPoolError?: ((error: Error) => void) | undefined },
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
    // 二重の警告を抑える: 利用者が自分で `pool.on("error", …)` を付けていれば、emit の時点でリスナーは2つ以上になっている。
    if (pool.listenerCount("error") === 1) {
      console.warn(`${POOL_ERROR_WARNING_HEAD}: ${error.message}`, error);
    }
  });
  const db = drizzle(poolWithCheckoutErrorListener(pool), { schema });
  transactionPreservingOriginalError(db);
  return { pool, db };
}

/**
 * 借りた接続に付ける、何もしない `error` リスナー。同じ関数参照を `on` と `removeListener` の両方に使うこと
 * （`advisory-lock.ts` の `NOOP_CLIENT_ERROR_HANDLER` と同じ理由）。実際のエラーは、進行中のクエリの reject として届く。
 */
const NOOP_CHECKOUT_ERROR_HANDLER = (): void => {};

/**
 * `db.transaction()` 1回ぶんの記録。drizzle は `rollback` が投げると元のエラーを捨てるので、`rollback` の失敗を
 * ここへ退避し、`db.transaction()` を包んだ側が元のエラーへ添える（{@link transactionPreservingOriginalError}）。
 * `connect()` を呼んだ文脈から `AsyncLocalStorage` で引く（drizzle の内部には依らない）。
 */
interface TransactionRecord {
  rollbackError?: unknown;
}
const currentTransaction = new AsyncLocalStorage<TransactionRecord>();

function queryText(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  const text = (arg as { text?: unknown } | null | undefined)?.text;
  return typeof text === "string" ? text : undefined;
}

const BEGIN_STATEMENT = /^\s*begin\b/i;
const ROLLBACK_STATEMENT = /^\s*rollback\s*;?\s*$/i;

/**
 * `pool.connect()`（promise 形）で借りた接続に {@link NOOP_CHECKOUT_ERROR_HANDLER} を付け、`release()` のときに外す。
 *
 * drizzle-orm 0.45.2 の `NodePgSession.transaction` の2つの穴をここで包む（ADR 0444）。`begin` を `try`/`finally` の
 * 外で実行するため、`begin` が reject すると接続が pool へ戻らない（再起動を数回挟むと pool が枯れる）。また
 * `rollback` が投げると元のエラーを消す。
 *
 * - `begin` が reject したら `release(err)` する（接続は pool から捨てられる）。
 * - `release` は冪等にする。drizzle が `finally` でもう一度呼んでも、pg-pool の「Release called on client which has
 *   already been released」を出さない。
 * - `rollback` の失敗は握り、{@link TransactionRecord} へ退避して、接続は `release(err)` で捨てる。
 */
async function connectWithErrorListener(pool: Pool): Promise<PoolClient> {
  const record = currentTransaction.getStore();
  // callback 形で借りる（pg-pool は callback を同期で呼ぶ）。promise 形だと、借りた直後の microtask まで `error`
  // リスナーが1つも無い窓ができ、接続直後に切られると、リスナーを付ける前に `error` が出てプロセスごと落ちる（ADR 0444）。
  const client = await new Promise<PoolClient>((resolve, reject) => {
    pool.connect((error, borrowed) => {
      if (error !== undefined || borrowed === undefined) {
        reject(error ?? new Error("pool.connect() が接続を返さなかった"));
        return;
      }
      borrowed.on("error", NOOP_CHECKOUT_ERROR_HANDLER);
      resolve(borrowed);
    });
  });
  const release = client.release;
  const query = client.query as (...args: unknown[]) => unknown;
  let released = false;
  let discardWith: Error | undefined;
  client.query = ((...args: unknown[]) => {
    const text = queryText(args[0]);
    const result = query.apply(client, args);
    const isPromiseForm = typeof args[args.length - 1] !== "function";
    if (text === undefined || !isPromiseForm || !(result instanceof Promise)) return result;
    if (BEGIN_STATEMENT.test(text)) {
      return result.catch((error: unknown) => {
        client.release(error instanceof Error ? error : new Error(String(error)));
        throw error;
      });
    }
    if (record !== undefined && ROLLBACK_STATEMENT.test(text)) {
      return result.catch((error: unknown) => {
        record.rollbackError = error;
        discardWith = error instanceof Error ? error : new Error(String(error));
        return { command: "ROLLBACK", rowCount: null, oid: 0, rows: [], fields: [] };
      });
    }
    return result;
  }) as PoolClient["query"];
  client.release = (err?: Error | boolean) => {
    if (released) return;
    released = true;
    const discarding = err !== undefined && err !== false ? true : discardWith !== undefined;
    // 捨てる接続（`release(err)`）のリスナーは外さない。pool が捨てるとき、切断の `error`（57P01 など）が
    // release の後に届くことがあり、リスナーが無いとプロセスごと落ちる。二度と使い回さないので積み上がらない。
    if (!discarding) client.removeListener("error", NOOP_CHECKOUT_ERROR_HANDLER);
    // pool は接続を使い回すので、差し替えた `query` を次の貸し出しへ持ち越さない。
    delete (client as { query?: unknown }).query;
    release.call(client, err ?? discardWith);
  };
  return client;
}

/**
 * `db.transaction()` を包み、`rollback` が失敗しても元のエラーを優先して投げる。`rollback` の失敗は
 * 元のエラーの `cause`（空いていれば）か `rollbackError` に残す。新しい例外の型は作らない。
 */
function transactionPreservingOriginalError(db: Db): void {
  const transaction = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
  (db as { transaction: unknown }).transaction = async (...args: unknown[]) => {
    const record: TransactionRecord = {};
    try {
      return await currentTransaction.run(record, () => transaction(...args));
    } catch (error) {
      if (record.rollbackError !== undefined && error instanceof Error) {
        if ((error as { cause?: unknown }).cause === undefined) {
          (error as { cause?: unknown }).cause = record.rollbackError;
        } else {
          (error as { rollbackError?: unknown }).rollbackError = record.rollbackError;
        }
      }
      throw error;
    }
  };
}

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

/** `client` ごとに、進行中/完了済みの `closePostgresClient` の `Promise` を覚える。公開の型には触れず、`WeakMap` で冪等性を持たせる。 */
const closingPromises = new WeakMap<PostgresClient, Promise<void>>();

/**
 * `client.pool.end()` を呼ぶ。2回目以降の呼び出しは冪等で、最初の呼び出しが作った `Promise` を使い回す
 * （並行に呼ばれても reject しない）。`pg` の `Pool.end()` は、`end()` 済みの `Pool` に呼ぶと
 * `Called end on pool more than once` で reject する。
 *
 * この関数を通らずに `client.pool.end()`（`db.$client.end()` も）が既に呼ばれていても reject しない（ADR 0444）。
 * 覚えているのはこの関数の呼び出しだけなので、pool 自身の `ending`/`ended` も見る。`ended` なら何もせず resolve、
 * `ending` なら `ended` になるまで待つ。`pool.end()` は呼び直さない。
 *
 * `close()` 後にクエリを投げたときの振る舞いは変えていない。
 */
export async function closePostgresClient(client: PostgresClient): Promise<void> {
  const existing = closingPromises.get(client);
  if (existing !== undefined) {
    return existing;
  }
  // この関数を通らずに `pool.end()` が呼ばれていることがある。そのまま `end()` を呼ぶと reject するので、pool 自身の印を見る。
  const closing =
    client.pool.ending || client.pool.ended ? waitUntilPoolEnded(client.pool) : client.pool.end();
  closingPromises.set(client, closing);
  return closing;
}

async function waitUntilPoolEnded(pool: Pool): Promise<void> {
  while (!pool.ended) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
