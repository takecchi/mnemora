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
 * ## DB エラーの `code` の在り処は3つの形に分かれる（ADR 0444 決定4・BG-3、ADR 0552）
 *
 * **形は揃えていない**（揃えるには例外の包み方を変える必要があり、公開の約束が動く）。
 * **判定するなら、両方を見ること: `err.code ?? err.cause?.code`**。
 *
 * - ① **包まれていない `pg` の例外**（`err.code`）。`db.transaction()` が接続を借りる段と、
 *   `client.pool.query()`・`client.pool.connect()` を直接呼んだとき。
 * - ② **`DrizzleQueryError`**（`err.cause.code`、`err.code` は無い）。文を実行している最中と、
 *   `db.execute` が接続を借りる段。
 * - ③ **`code` が無いもの**。pool の枯渇（`timeout exceeded when trying to connect`）と、サーバーが応答しないときの
 *   接続タイムアウト（`Connection terminated due to connection timeout`）。借りる口が `db.transaction`・`pool.*` なら
 *   包まれず、`db.execute` なら `DrizzleQueryError` の `cause` の中に入る。どちらも `code` が無く、文面でしか分からない（約束しない）。
 *
 * 根拠は drizzle-orm 0.45.2 の `node-postgres/session.js`（`transaction` が `this.client.connect()` を `try` の外で呼ぶ）・
 * `pg-core/session.js`（`queryWithCache` が `DrizzleQueryError` に包む）と、下の `connectWithErrorListener`。
 * 【実測】接続拒否（`127.0.0.1:1`）と、応答しない TCP サーバー（`max: 1`・`connectionTimeoutMillis: 300`）で確かめた。
 * 【記録に頼ったもの】`57P01`・`57P03` は、ADR 0444 の実測の記録に頼る（今回は再現していない）。
 * 表と場面は `packages/postgres/README.md` の「pool が枯れたとき・Postgres の再起動の最中に出る例外の形」節。
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
    // 二重の警告を抑える: 利用者が自分で `pool.on("error", …)` を付けていれば
    // （付けた順番に依らず）、emit の時点でリスナーは2つ以上になっている。
    if (pool.listenerCount("error") === 1) {
      console.warn(`${POOL_ERROR_WARNING_HEAD}: ${error.message}`, error);
    }
  });
  const db = drizzle(poolWithCheckoutErrorListener(pool), { schema });
  transactionPreservingOriginalError(db);
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
 * `db.transaction()` 1回ぶんの記録。drizzle は `rollback` が投げると元のエラーを捨てるので
 * （BG-2）、`rollback` の失敗をここへ退避し、`db.transaction()` を包んだ側が元のエラーへ添える
 * （{@link transactionPreservingOriginalError}）。`AsyncLocalStorage` で、`connect()` を呼んだ
 * 文脈から引く（drizzle の内部（`session.client` など）には依らない）。
 */
interface TransactionRecord {
  rollbackError?: unknown;
}
const currentTransaction = new AsyncLocalStorage<TransactionRecord>();

/** `client.query` の第1引数（文字列か `{ text }`）から SQL 文を読む。読めなければ `undefined`。 */
function queryText(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  const text = (arg as { text?: unknown } | null | undefined)?.text;
  return typeof text === "string" ? text : undefined;
}

const BEGIN_STATEMENT = /^\s*begin\b/i;
const ROLLBACK_STATEMENT = /^\s*rollback\s*;?\s*$/i;

/**
 * `pool.connect()`（promise 形）で借りた接続に {@link NOOP_CHECKOUT_ERROR_HANDLER} を付け、
 * `release()` のときに外す。pg-pool は借りるたびに `client.release` を付け直すので、
 * ここで差し替えた `release` は、この1回の貸し出しにしか効かない。
 *
 * ## drizzle-orm 0.45.2 の `NodePgSession.transaction` の2つの穴をここで包む（ADR 0444）
 *
 * drizzle のこの関数は `begin` を `try`/`finally` の**外**で実行するため、`begin` が reject
 * すると `finally` の `release()` に届かず、借りた接続が pool へ戻らない（BG-1。Postgres の
 * 再起動を数回挟むと pool が枯れて全呼び出しが止まる）。また `catch { await rollback; throw error }`
 * は、`rollback` が投げると元のエラーを消す（BG-2）。上流の不具合だが、ここで包んで直す。
 *
 * - **`begin` が reject したら `release(err)` する**（接続は pool から捨てられる）。
 * - **`release` は冪等にする**——`begin` の失敗で返したあと、drizzle が `finally` で
 *   もう一度呼んでも、pg-pool の「Release called on client which has already been released」を
 *   出さない（2回目以降は何もしない）。
 * - **`rollback` の失敗は握る**。drizzle は元のエラーをそのまま投げ直す。握った失敗は
 *   {@link TransactionRecord} へ退避し、接続は `release(err)` で捨てる（壊れた接続を pool へ戻さない）。
 */
async function connectWithErrorListener(pool: Pool): Promise<PoolClient> {
  const record = currentTransaction.getStore();
  // 🔴 callback 形で借りる（pg-pool は callback を同期で呼ぶ）。promise 形だと、借りた直後の
  // microtask まで `error` リスナーが1つも無い窓ができる: 接続を張った直後に切られると、
  // 「接続完了」と「切断の `error`」が同じ socket の読み出しで続けて届き、リスナーを付ける前に
  // 後者が出て、プロセスごと落ちる（ADR 0444。全接続を切る反復の歯で実測した）。
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
    // 捨てる接続（`release(err)`）のリスナーは外さない。pool が捨てるとき、切断の `error`
    // （57P01 など）が release の後に届くことがあり、リスナーが無いとプロセスごと落ちる。
    // 二度と使い回さない接続なので、積み上がる心配も無い。
    if (!discarding) client.removeListener("error", NOOP_CHECKOUT_ERROR_HANDLER);
    // pool は接続を使い回す。差し替えた `query` を次の貸し出しへ持ち越さない。
    delete (client as { query?: unknown }).query;
    release.call(client, err ?? discardWith);
  };
  return client;
}

/**
 * `db.transaction()` を包み、`rollback` が失敗しても**元のエラーを優先して投げる**（BG-2）。
 * `rollback` の失敗は握り（{@link connectWithErrorListener}）、元のエラーの `cause`（空いていれば）
 * か `rollbackError` に残す。新しい例外の型は作らない。
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
 * ⚠ **`client.pool.end()`（`db.$client.end()` も）が、この関数を通らずに既に呼ばれていても reject しない**
 * （ADR 0444 BH(c)）。覚えているのはこの関数の呼び出しだけなので、pool 自身の `ending`/`ended` も見る:
 * `ended` なら何もせず resolve、`ending`（終わる途中）なら `ended` になるまで待つ。`pool.end()` は呼び直さない。
 *
 * `close()` 後にクエリを投げたときの振る舞い（`pg` 側がどう reject するか）は
 * 変えていない——冪等にしたのは「閉じる」という操作そのものだけである。
 */
export async function closePostgresClient(client: PostgresClient): Promise<void> {
  const existing = closingPromises.get(client);
  if (existing !== undefined) {
    return existing;
  }
  // pool.end() が、この関数を通らずに（直接）既に呼ばれていることがある（BH(c)）。そのまま
  // end() を呼ぶと `Called end on pool more than once` で reject するので、pool 自身の印を見る。
  // `ended`: 終わっている。`ending`: 終わるのを待っている最中（終わるまで待ってから resolve する）。
  const closing =
    client.pool.ending || client.pool.ended ? waitUntilPoolEnded(client.pool) : client.pool.end();
  closingPromises.set(client, closing);
  return closing;
}

/** 既に `end()` が呼ばれた pool が、終わる（`ended`）のを待つ。`end()` は二度と呼ばない。 */
async function waitUntilPoolEnded(pool: Pool): Promise<void> {
  while (!pool.ended) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
