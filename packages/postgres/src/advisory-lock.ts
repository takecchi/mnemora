import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/**
 * `pg_advisory_lock` を使ったプロセス間排他の共通部品（ADR 0017・ADR 0018）。`runMigrations` と
 * `registerEmbeddingSpace` が共有する。
 *
 * 呼び出し元ごとに別のロックキーを使うこと。キー空間は DB 全体で共有されるので、同じキーを使うと
 * 無関係な処理同士が互いにブロックする。
 */
/** advisory lock を待つ既定の上限。呼び出し側が options で上書きできる（テストは短くする）。 */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** `pg_advisory_lock` が `lock_timeout` で中断されたときの SQLSTATE。 */
const PG_LOCK_TIMEOUT_SQLSTATE = "55P03";

/**
 * `pool.connect()` で借り切った client に付ける、何もしない `error` リスナー。
 *
 * モジュールで1つだけの同じ関数参照を、`on`/`removeListener` の両方に使うこと。呼び出しのたびに新しい
 * `() => {}` を作ると外せない。`pg-pool` は返却してもソケットを切らず使い回すので、外し忘れると同じ
 * 物理コネクションにリスナーが積み上がり、`MaxListenersExceededWarning` に達する。
 */
const NOOP_CLIENT_ERROR_HANDLER = (): void => {};

/**
 * advisory lock の取得が待ち時間切れで失敗したことを表す基底クラス。「待って取れた」「時間切れ」
 * 「ロック機構自体が使えなかった」の3つを呼び出し側が `instanceof` で区別できる（ADR 0017）。
 * 呼び出し元ごとに、メッセージへ関数名を埋め込んだサブクラスを作って使う。直接 throw しない。
 */
export class AdvisoryLockTimeoutError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "AdvisoryLockTimeoutError";
  }
}

/**
 * advisory lock を取得する操作自体が失敗したこと（権限不足・接続不可など、待ち時間切れとは別原因）を表す基底クラス。
 * `AdvisoryLockTimeoutError` と同様、呼び出し元ごとのサブクラスを作って使う。
 * 区別が無いと、権限設定の誤りを「混んでいるだけ」と誤診してリトライし続けてしまう。
 */
export class AdvisoryLockUnavailableError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "AdvisoryLockUnavailableError";
  }
}

/** 呼び出し元ごとのエラーの組み立て方。`acquireAdvisoryLock` はどの具象エラークラスを投げるか知らないので、ファクトリを渡してもらう。 */
export interface AdvisoryLockErrorFactories {
  /** 待つ上限を超えたときに投げるエラーを作る。`waitedMs` は実際に待った時間（ミリ秒）。 */
  timeout: (waitedMs: number, cause: unknown) => Error;
  /**
   * ロックの取得が `lock_timeout` 超過（SQLSTATE `55P03`）以外の理由で失敗したときに投げるエラーを作る
   * （`lock_timeout` の設定の失敗、`pg_advisory_lock` の呼び出しの権限不足・接続断など）。
   */
  unavailable: (cause: unknown) => Error;
}

/**
 * advisory lock を取得し、保持用の専用コネクションを返す。
 *
 * pool から専用のコネクションを1本借り切る。`pool.query` で都度別のコネクションを使うと、session レベルの
 * advisory lock がどの接続に紐付くか制御できない。`lock_timeout` もこの session に設定する。
 *
 * 失敗時は必ずコネクションを pool へ返してから投げる。`lock_timeout` の設定に失敗したとき・`55P03` 以外の失敗は
 * `errors.unavailable`、`pg_advisory_lock` が `55P03` で中断されたときは `errors.timeout`。
 * 成功時の `client` は、呼び出し側が `releaseAdvisoryLock` で解放・返却する。`waitedMs` は lock を待った時間。
 */
export async function acquireAdvisoryLock(
  pool: Pool,
  lockKey: bigint,
  lockTimeoutMs: number,
  errors: AdvisoryLockErrorFactories,
): Promise<{ client: PoolClient; waitedMs: number }> {
  const client = await pool.connect();
  // 借り切った client に `error` リスナーが無いと、アイドル中の接続断（DB の再起動・フェイルオーバー等）が
  // `EventEmitter` の既定動作で投げられ、プロセスが落ちる。この client は適用中ずっとアイドルで保持され、
  // 待っているクエリが無いので、拾わないと確実に落ちる。実際のエラー処理は後続のクエリの reject に委ねる。
  // `client.release()` するすべての経路で `removeListener` も対にすること。
  client.on("error", NOOP_CLIENT_ERROR_HANDLER);

  try {
    // `SET` はプレースホルダを使えないので `set_config()` 経由にする（文字列結合で SQL を組み立てない）。
    // false = セッションスコープ。後で必ず `RESET lock_timeout` で接続の既定値に戻す（ADR 0460）。
    await client.query("SELECT set_config('lock_timeout', $1, false)", [String(lockTimeoutMs)]);
  } catch (err) {
    client.removeListener("error", NOOP_CLIENT_ERROR_HANDLER);
    client.release();
    throw errors.unavailable(err);
  }

  let waitedMs: number;
  try {
    waitedMs = await acquireAdvisoryLockOnClient(client, lockKey, errors);
  } catch (err) {
    await client.query("RESET lock_timeout").catch(() => {});
    client.removeListener("error", NOOP_CLIENT_ERROR_HANDLER);
    client.release();
    throw err;
  }

  return { client, waitedMs };
}

/**
 * 既に接続済みの `client` の上で、`lockKey` の advisory lock を取得する。`pg_advisory_lock` を撃ち、`55P03`
 * （`lock_timeout` 超過）かそれ以外かで `errors.timeout`/`errors.unavailable` を投げ分ける。
 * 接続の確保・`lock_timeout` の設定・失敗時の解放は呼び出し側の責務。
 *
 * 新しい接続を借りないのは、他の advisory lock を保持したまま同じセッションでもう1本取りたい呼び出し元
 * （`migrate.ts` の `EXTENSION_LOCK_KEY`）のため。同一セッションは異なるキーの lock を重ねて持てる。
 * 2本目用に別の接続を借りると `runMigrations` が要る接続数が増え、`max: 2` の pool で3本目の
 * `pool.connect()` が待ち続けてデッドロックする。
 *
 * `.code` の直読みが効くのは、生の `PoolClient.query()` を使っているからである。drizzle の `db.execute()` は
 * pg のエラーを `Failed query: ...` で包み、`code` は `cause`（2段目）にある。`db.execute()` の失敗から
 * SQLSTATE を読むなら `cause` の連鎖を辿ること。この形をそのままコピーすると静かに `undefined` になり、
 * 「その SQLSTATE ではなかった」の向きに倒れる。
 *
 * SQLSTATE を読む共有 helper は意図して置いていない（本番でこれを読む箇所はここ1つだけ。
 * アダプタ間でエラーの種別を揃えることは ADR 0047 が採らず、不正な uuid の `22P02` は `isUuidLike` の事前検査で弾く）。
 */
export async function acquireAdvisoryLockOnClient(
  client: PoolClient,
  lockKey: bigint,
  errors: AdvisoryLockErrorFactories,
): Promise<number> {
  const startedAt = Date.now();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockKey.toString()]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === PG_LOCK_TIMEOUT_SQLSTATE) {
      throw errors.timeout(Date.now() - startedAt, err);
    }
    throw errors.unavailable(err);
  }
  return Date.now() - startedAt;
}

/**
 * 固定文字列から advisory lock のキーを導出する。固定文字列の SHA-256 先頭8バイトを符号付き64bit整数として解釈する。
 * `MIGRATION_LOCK_KEY`・`REGISTER_EMBEDDING_SPACE_LOCK_KEY` はこの関数を使わずハードコードしてある（既存の値を変えないため）。
 * スキーマごとに別のキーを導出する用途（`migrationLockKeyFor` / `registerEmbeddingSpaceLockKeyFor`）に使う。
 * 値そのものに意味は無く、衝突を避けるための値である。
 */
export function deriveAdvisoryLockKey(seed: string): bigint {
  return createHash("sha256").update(seed).digest().readBigInt64BE(0);
}

/**
 * 既に接続済みの `client` の上で、`lockKey` の advisory lock を解放するだけの操作（`lock_timeout` のリセットも
 * `release()` もしない）。他の advisory lock を保持したまま同じセッションで解放したい呼び出し元のために、
 * `acquireAdvisoryLockOnClient` と対で切り出してある。
 */
export async function releaseAdvisoryLockOnClient(
  client: PoolClient,
  lockKey: bigint,
): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1)", [lockKey.toString()]);
}

/** advisory lock を解放し、`lock_timeout` を元に戻してからコネクションを pool へ返す。 */
export async function releaseAdvisoryLock(client: PoolClient, lockKey: bigint): Promise<void> {
  try {
    await releaseAdvisoryLockOnClient(client, lockKey);
  } finally {
    await client.query("RESET lock_timeout").catch(() => {});
    // pool へ返す前に、`acquireAdvisoryLock` が付けたリスナーを外す（外し忘れるとリスナーが積み上がる）。
    client.removeListener("error", NOOP_CLIENT_ERROR_HANDLER);
    client.release();
  }
}
