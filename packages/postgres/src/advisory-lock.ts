import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/**
 * `pg_advisory_lock` を使ったプロセス間排他の共通部品（ADR 0017・ADR 0018）。
 *
 * 元は `migrate.ts` の `runMigrations()` 専用として書かれた（ADR 0017）。段階1の実測で
 * `registerEmbeddingSpace`（`./vector-space.ts`）にも同じ形の非アトミック性（`CREATE TABLE
 * IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` はどちらも並行では非アトミック）が実在する
 * ことを確認したため（ADR 0018）、「学ぶことが1つで済む」よう、ロックの取得・解放という
 * 機構そのものをここへ切り出し、`migrate.ts` と `vector-space.ts` の両方から使う。
 *
 * **切り出したのは機構だけ**——「待って取れた／時間切れ／ロック機構自体が使えなかった」の
 * 3状態を呼び出し側が `instanceof` で見分けられるという性質、専用コネクションを
 * pool から借り切る・`set_config('lock_timeout', ...)` を session に敷く・失敗時は必ず
 * release してから投げる・終了時に `lock_timeout` を `'0'` へ戻す、という個々の理由は
 * `migrate.ts` の元のコメントからそのまま運んである。
 *
 * **呼び出し元ごとに別のロックキーを使うこと。** `pg_advisory_lock` のキー空間は
 * **データベース全体で共有**される——`runMigrations` と `registerEmbeddingSpace` が
 * 同じキーを使うと、互いに無関係な処理同士が意図せずブロックし合う
 * （`MIGRATION_LOCK_KEY` と `REGISTER_EMBEDDING_SPACE_LOCK_KEY` を参照）。
 */

/** advisory lock を待つ既定の上限。呼び出し側が options で上書きできる（テストは短くする）。 */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** `pg_advisory_lock` が `lock_timeout` で中断されたときの SQLSTATE。 */
const PG_LOCK_TIMEOUT_SQLSTATE = "55P03";

/**
 * `pool.connect()` で借り切った checked-out client に付ける、何もしない `error`
 * リスナー（下記 {@link acquireAdvisoryLock} 参照）。
 *
 * 🔴 **モジュールで1つだけの、同じ関数参照を使い回すこと。** 呼び出しのたびに
 * `() => {}` を新しく作ると、`client.on("error", ...)` で付けたのと**同じ関数参照**を
 * `client.removeListener("error", ...)` で外せなくなる——`pg-pool` は接続を pool へ
 * 返却してもソケットは切らずに次の `pool.connect()` で使い回すため、外し忘れると
 * 同じ物理コネクションに付け外しのたびリスナーが積み上がり、
 * `MaxListenersExceededWarning`（既定上限10）に達する。**必ずこの定数を `on`/
 * `removeListener` の両方に使うこと。**
 */
const NOOP_CLIENT_ERROR_HANDLER = (): void => {};

/**
 * advisory lock の取得が「待ち時間切れで失敗した」ことを表す汎用の基底クラス。
 *
 * **「待って取れた」「待ったが時間切れ」「ロック機構自体が使えなかった」の3つを
 * 呼び出し側が区別できること**が段階2の要求（オーナーが引いた線1、ADR 0017）。
 * 呼び出し元（`runMigrations` / `registerEmbeddingSpace`）ごとに、メッセージへ
 * 関数名を埋め込んだサブクラス（`MigrationLockTimeoutError` /
 * `RegisterEmbeddingSpaceLockTimeoutError`）を作って使うこと——このクラスを
 * 直接 throw するのは想定していない。
 */
export class AdvisoryLockTimeoutError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "AdvisoryLockTimeoutError";
  }
}

/**
 * advisory lock を取得する**操作自体**が失敗したことを表す汎用の基底クラス
 * （権限不足・接続不可など、待ち時間切れとは別原因）。
 *
 * `AdvisoryLockTimeoutError` と同様、呼び出し元ごとのサブクラスを作って使うこと。
 * **この区別が無いと、権限設定の誤りを「混んでいるだけ」と誤診してリトライし続けてしまう。**
 */
export class AdvisoryLockUnavailableError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "AdvisoryLockUnavailableError";
  }
}

/**
 * 呼び出し元ごとに用意する、エラーの組み立て方。
 *
 * `acquireAdvisoryLock` はどの具象エラークラスを投げるべきか知らない
 * （それは呼び出し元——`migrate.ts` なら `MigrationLock*Error`、`vector-space.ts` なら
 * `RegisterEmbeddingSpaceLock*Error`——の役目）。そのためファクトリを渡してもらう。
 */
export interface AdvisoryLockErrorFactories {
  timeout: (waitedMs: number, cause: unknown) => Error;
  unavailable: (cause: unknown) => Error;
}

/**
 * advisory lock を取得し、保持用の専用コネクションを返す。
 *
 * **専用のコネクションを1本 pool から借り切って使う**（`pool.query` で都度別の
 * コネクションを使うと、session レベルの advisory lock がどの接続に紐付いているか
 * 制御できなくなるため）。`lock_timeout` もこのコネクションの session に対して設定する。
 *
 * 失敗時は必ずこのコネクションを pool へ返却してから例外を投げる
 * （呼び出し元がコネクションリークを心配しなくてよいように）。
 */
export async function acquireAdvisoryLock(
  pool: Pool,
  lockKey: bigint,
  lockTimeoutMs: number,
  errors: AdvisoryLockErrorFactories,
): Promise<{ client: PoolClient; waitedMs: number }> {
  const client = await pool.connect();
  // pg の仕様: `pool.connect()` で借り切ったクライアント（checked-out client）は、
  // 呼び出し側が自分で `error` リスナーを付けない限り、接続断（DB の再起動・
  // フェイルオーバー・運用者による切断・OOM kill 等、外部要因によるものを含む）が
  // Node の `EventEmitter` の既定動作でそのまま投げられ、プロセス全体が uncaught
  // exception で落ちる。**このクライアントは呼び出し元（`runMigrations` /
  // `registerEmbeddingSpace`）に返され、マイグレーション本体の適用中ずっとアイドル状態で
  // 保持され続ける**——アイドルの間に接続が失われると、待っている進行中のクエリが
  // 1つも無いため、これを拾わないと確実にプロセスが落ちる
  // （`migrate-connection-loss.test.ts` が実測）。実際のエラー処理は、この後に
  // 続く各クエリの `await` が reject することに委ねるので、ここでは黙って拾うだけで足りる。
  // ⚠ `client.release()` するすべての経路で `removeListener` も対にすること
  // （{@link NOOP_CLIENT_ERROR_HANDLER} のコメント参照——外し忘れるとリスナーが積み上がる）。
  client.on("error", NOOP_CLIENT_ERROR_HANDLER);

  try {
    // SET だとプレースホルダを使えないため set_config() 経由にする
    // （文字列結合で SQL を組み立てない）。false = セッションスコープ
    // （このコネクションが pool へ戻った後に他の用途で再利用されても
    // 悪影響が残らないよう、後で必ず '0' に戻す）。
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
    await client.query("SELECT set_config('lock_timeout', '0', false)").catch(() => {});
    client.removeListener("error", NOOP_CLIENT_ERROR_HANDLER);
    client.release();
    throw err;
  }

  return { client, waitedMs };
}

/**
 * **既に接続済みの `client`** の上で、`lockKey` の advisory lock を取得しようと試みる
 * （feat/dedicated-schema・Issue #757）。
 *
 * `acquireAdvisoryLock`（pool から専用コネクションを借り切る版）から、
 * 「`pg_advisory_lock` を撃ち、`55P03`（`lock_timeout` 超過）かそれ以外かで
 * `errors.timeout`/`errors.unavailable` を投げ分ける」核だけを切り出したもの。
 * **接続の確保・`lock_timeout` の設定・失敗時の解放は呼び出し側の責務**——
 * これらを持たないのは、**既に他の advisory lock を保持したまま、同じセッションで
 * もう1本ロックを取りたい**呼び出し元（`migrate.ts` の `EXTENSION_LOCK_KEY`、
 * Issue #757）のためである。同一セッションが異なるキーの advisory lock を複数
 * 同時に保持することは PostgreSQL の仕様上問題ない（`pg_advisory_lock` はキーごとに
 * 独立したロックであり、セッション単位で重ねて持てる）——**新しい接続を pool から
 * 借りる必要は無い**。実際、最初の実装は2本目の advisory lock 用に新しい接続を
 * 借りていたが、`runMigrations` が同時に必要とする接続数が2本から3本に増え、
 * `max: 2` で書かれた既存の並行テスト（`migrate-concurrency.test.ts` 等）が
 * 接続を使い切ってデッドロック（3本目の `pool.connect()` が誰にも解決されない
 * まま待ち続ける）することを実測して差し戻した。
 *
 * 🔴 `.code` の直読みが効く理由・drizzle では効かない理由・共有 helper を置かない
 * 理由の注記は、元は `acquireAdvisoryLock` の catch 節にあったものをそのままここへ運んだ
 * （中身は変えていない）。
 *
 * ⚠ **この `.code` の直読みが効くのは、生の `PoolClient.query()` を使っているからである。**
 * 実測（PostgreSQL 17.9）: 生 query の例外は最初の1段目にそのまま `code` を持つ。
 *
 * ⚠ **drizzle の `db.execute()` では効かない。**あちらは pg のエラーを
 * `Error: Failed query: ...` で包むので、`.code` の直読みは `undefined` になる。
 * 実測では、1段目が包んだ `Error`、その `cause`（2段目）が pg のエラーで、
 * `code` はそちらに在る。**⟹ `db.execute()` の失敗から SQLSTATE を読むなら、
 * `cause` の連鎖を辿ること。**この形をそのままコピーすると静かに `undefined` になり、
 * **誤りは必ず「その SQLSTATE ではなかった」の向きに倒れる**——つまり黙って通る。
 * 辿る例は `foreign-key-violation.postgres.test.ts` の `sqlStateOf`。
 *
 * ⚠ **共有の helper は意図的に置いていない。**本番でこれを読む箇所はここ1つだけで、
 * 候補として挙がった2つはどちらも repo の決定が需要を消している——アダプタ間で
 * エラーの種別を揃えることは ADR 0047 が採らないと決めており（`memory-store-conformance.ts`
 * の `.rejects.toThrow()` の doc を参照）、不正な uuid（`22P02`）は例外を分類せず
 * `isUuidLike` の事前検査で弾く設計になっている。**必要になったら、そのとき作ればよい。**
 * ⟹ これは「helper が抜けている」ではなく「置かないと決めた」である。
 *
 * ⚠ **この注意書きには歯を置いていない。**これは警告であって安全性の主張ではなく、
 * drizzle が包み方を変えたら**この記述が古くなるだけで何も壊れない**。歯で固定すると
 * 「drizzle の挙動を変えてはいけない」を意味してしまう。
 * （なお `55P03` の側は歯が在る——定数が違えば `migrate-concurrency.test.ts` の
 * `MigrationLockTimeoutError` 検査が赤くなる。あちらは事故で変わる前提なので固定してよい。）
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
 * 固定文字列から advisory lock のキーを導出する（feat/dedicated-schema）。
 *
 * `MIGRATION_LOCK_KEY`（`./migrate.ts`）・`REGISTER_EMBEDDING_SPACE_LOCK_KEY`
 * （`./vector-space.ts`）の doc に書いてある導出手順——固定文字列の SHA-256 先頭8バイトを
 * 符号付き64bit整数として解釈する——と**同一**の計算をここへ切り出したもの。
 * 両定数はこの関数を使わずハードコードされたままにしてある（既存の値を変えないため）。
 * このリポジトリの規律の実測（`node -e 'const c=require("crypto");
 * console.log(c.createHash("sha256").update("mnemora:runMigrations:advisory-lock")
 * .digest().readBigInt64BE(0).toString())'` 等）で、この関数が両定数を再現することを
 * 確認済み——`schema-namespace.test.ts` の歯がそれを固定する。
 *
 * スキーマごとに別のロックキーを導出する用途（`migrationLockKeyFor` /
 * `registerEmbeddingSpaceLockKeyFor`、いずれも呼び出し元のファイルに置く）のために
 * ここへ切り出した。`deriveAdvisoryLockKey` 自体は「seed 文字列 → キー」という
 * 純粋な計算だけを担う——衝突回避のための値であり、値そのものに意味は無い。
 */
export function deriveAdvisoryLockKey(seed: string): bigint {
  return createHash("sha256").update(seed).digest().readBigInt64BE(0);
}

/**
 * **既に接続済みの `client`** の上で、`lockKey` の advisory lock を解放するだけの操作
 * （`lock_timeout` のリセットもコネクションの `release()` もしない。feat/dedicated-schema・
 * Issue #757）。`releaseAdvisoryLock`（下）の核であり、`acquireAdvisoryLockOnClient` と
 * 対で、**他の advisory lock を保持したまま同じセッションで解放したい**呼び出し元
 * （`migrate.ts` の `EXTENSION_LOCK_KEY`）のために切り出してある。
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
    await client.query("SELECT set_config('lock_timeout', '0', false)").catch(() => {});
    // `acquireAdvisoryLock` が付けた {@link NOOP_CLIENT_ERROR_HANDLER} を、pool へ返す前に
    // 外す（外し忘れるとリスナーが積み上がる。同コメント参照）。
    client.removeListener("error", NOOP_CLIENT_ERROR_HANDLER);
    client.release();
  }
}
