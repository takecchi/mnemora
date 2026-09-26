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
 * リスナー（ADR 0340・{@link createDrizzleClientFacade} 参照）。
 *
 * 🔴 モジュールで1つだけの、同じ関数参照を使い回すこと（`migrate.ts`/`advisory-lock.ts`
 * の同名の定数と同じ理由——`on`/`removeListener` に別々の関数を使うと外せず、
 * `pg-pool` が使い回す物理コネクションにリスナーが積み上がる）。
 */
const NOOP_CLIENT_ERROR_HANDLER = (): void => {};

/**
 * `drizzle()` に渡す**専用の薄い包み**を作る（ADR 0340）。`createPostgresClient` が
 * 公開する `Pool`（`PostgresClient.pool`）そのものは、この関数の外で `new Pool(...)`
 * したまま**一切書き換えない**——利用者が自分で `client.pool.connect()` を呼んで
 * 借りるクライアントは、今日と同じ、無防備なままの素の `PoolClient` である。
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
 * ## なぜ「別の包み」であって「公開する pool の書き換え」ではないか
 *
 * 最初の実装（PR #863 の初稿）は、公開する `Pool` インスタンス自身の `connect` を
 * その場で差し替えていた。だがそれだと、**利用者が自分で `client.pool.connect()` を
 * 呼んで借りたクライアントにも、黙って mnemora の `error` リスナーが付く**——
 * `PostgresClient.pool` は公開している面であり、その `connect()` が何をするかは
 * mnemora が独自に決めてよい契約ではない。ADR 0339 が「`runMigrations`/
 * `acquireAdvisoryLock` **自身**が借りたものだけに付ける」という線を引いたのと
 * 同じ理由で、ここでも「mnemora 自身が内部で使うために借りたもの（drizzle の
 * `db.transaction()` が借りるもの）だけに付け、利用者が自分で借りたものには
 * 触らない」という線を保つ。⟹ **`drizzle()` に渡す先だけを、公開する `pool` とは
 * 別のオブジェクト（薄い包み）にする。**
 *
 * ## 包みの作り方——drizzle-orm が実際に触る3点だけを満たす
 *
 * `drizzle-orm` の node-postgres 経路が `this.client`（＝ここで渡す包み）に対して
 * 実際に呼ぶのは次の3つだけ（`node_modules/drizzle-orm/node-postgres/session.js` を
 * 読んで確認した）:
 *
 * 1. `client.query(...)`（`NodePgPreparedQuery.execute`/`all` — 通常のクエリ・
 *    トランザクション内のクエリのどちらも、最終的にこの形で呼ぶ）
 * 2. `client.connect()`（`NodePgSession.transaction` — `db.transaction()` の入口）
 * 3. `this.client instanceof Pool`（`Object.getPrototypeOf(this.client).constructor.name`
 *    による緩い代替判定もある）——`db.transaction()` が「専用コネクションを
 *    新しく借りるべきか」を見分ける判定
 *
 * 包みは `Object.create(Pool.prototype)` で作る——**`Pool.prototype` を
 * プロトタイプ鎖に直接持つ**ため、`instanceof Pool` は素直に真になる
 * （3番目の要求を満たす。`facade instanceof Pool → true` を実測で確認した——
 * ADR 0340「測ったこと」）。
 *
 * ⚠ **包みに `Pool.prototype` のメソッドを「継承させたまま」呼ばせてはいけない。**
 * `pg-pool` の `query()`/`connect()` の実装は `this.log`/`this.Promise`/
 * `this._clients` 等、**コンストラクタで実インスタンスにだけ設定される
 * プロパティ**を読む。包みの `[[Prototype]]` は `Pool.prototype`（クラスの
 * プロトタイプ）であって実インスタンスではないため、これらは無い——継承したままの
 * `query()` を包みの `this` で呼ぶと `this.log` が `undefined` になり壊れることを
 * 実測で確認した（ADR 0340「測ったこと」）。
 * ⟹ **`query`/`connect` は、包みの own property として、必ず元の `pool`
 * インスタンスの上で呼ぶ関数を明示的に置く。** `this` を経由した暗黙の委譲は
 * しない。⚠ **さらに、生成時に `pool.query.bind(pool)` のように1回だけ束縛
 * しない**——テストが `getTestClient()` で作った共有 client の `pool.query`
 * を後から一時的に差し替えて呼び出し回数を数える歯
 * （`recall.postgres.test.ts`「aggregateScope は単一の SQL 往復で完結する」）が
 * 実在し、生成時の束縛だとその差し替えを素通りしてしまうことを実測で確認した
 * （ADR 0340「測ったこと」）。⟹ **`query`/`connect` の呼び出し本体は、毎回
 * `pool.query(...)`/`pool.connect(...)`（メソッド呼び出し構文——都度 `pool` の
 * *現在の*プロパティを読み、`this = pool` で呼ぶ）を書く。**
 *
 * ## `connect` だけ、借りた client に `error` リスナーを付け外しする
 *
 * `query`（呼び出しのたびに現在の `pool.query` を読んで呼ぶ）はそのまま元の
 * `pool.query` を呼ぶ——`pg-pool` の `query()` は内部で `client.once('error',
 * onError)` を自前で付けて自衛する経路を持つため、素通しで安全（ADR 0339 の
 * 「見つけた別の穴」参照）。**`connect` だけ**、返す checked-out client へこの
 * no-op `error` リスナーを自動で付け外しするものに包む。
 *
 * ⚠ **このコードベースは `pool.connect()` の promise 形しか使わない**
 * （`migrate.ts`/`advisory-lock.ts`/drizzle-orm、いずれも）。callback 形
 * （`pool.connect((err, client, done) => ...)`）は使われていないため、渡ってきたら
 * 対策せずそのまま元の実装へ委譲する（呼ばれない経路のために作り込まない）。
 *
 * ⚠ **`migrate.ts`/`advisory-lock.ts` 自身が付ける `error` リスナーとは無関係。**
 * `runMigrations`/`acquireAdvisoryLock` は公開する `pool`（この包みではない）を
 * 受け取って呼ばれる（`test-db.ts` の `getTestClient()` が実際にそうしている）ため、
 * ADR 0339 の対策とは別の経路であり、互いに干渉しない。
 */
function createDrizzleClientFacade(pool: Pool): Pool {
  const facade = Object.create(Pool.prototype) as Pool;

  // ⚠ `pool.query.bind(pool)` のように生成時に1回だけ束縛しない——`pool.query`
  // そのものを呼ぶたびに読み直す（メソッド呼び出し構文 `pool.query(...)` は毎回
  // `this = pool` で束縛される）。既存の歯（`recall.postgres.test.ts` の
  // 「aggregateScope は単一の SQL 往復で完結する」）が、生成後に `pool.query` を
  // 一時的に差し替えて呼び出し回数を数えており、生成時の束縛だとその差し替えを
  // 素通りしてしまう（実測——下記「測ったこと」参照）。
  facade.query = ((...args: unknown[]) =>
    (pool.query as (...a: unknown[]) => unknown)(...args)) as Pool["query"];

  facade.connect = ((
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ) => {
    if (callback) {
      return pool.connect(callback);
    }
    return (async (): Promise<PoolClient> => {
      const client = await pool.connect();
      client.on("error", NOOP_CLIENT_ERROR_HANDLER);
      const originalRelease = client.release.bind(client);
      client.release = ((err?: Error | boolean) => {
        client.removeListener("error", NOOP_CLIENT_ERROR_HANDLER);
        return originalRelease(err);
      }) as PoolClient["release"];
      return client;
    })();
  }) as Pool["connect"];

  return facade;
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
 * **`drizzle()` に渡すのは、公開する `pool` そのものではなく
 * {@link createDrizzleClientFacade} が作る薄い包みである**（ADR 0340）——
 * 公開する `pool` の `connect()` は素の `Pool` のまま変えない。
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
  const db = drizzle(createDrizzleClientFacade(pool), { schema });
  return { pool, db };
}

export async function closePostgresClient(client: PostgresClient): Promise<void> {
  await client.pool.end();
}
