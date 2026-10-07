import { setTimeout as sleep } from "node:timers/promises";
import { Client, type Pool } from "pg";

/** `Client.prototype.query` を差し替え、`applicationName` が一致する接続が `matches` に当たる文を投げようとした瞬間に、別の接続（`admin`）から `pg_terminate_backend` でその接続を切ってから本物の `query` を呼ぶ（「Postgres の再起動の最中に `begin` を投げる」のと同じ形を決まった位置で作る）。戻り値の関数で元に戻す（`finally` で必ず呼ぶこと）。promise 形の `query` だけを扱う。 */
export function killConnectionBeforeStatement(options: {
  admin: Pool;
  applicationName: string;
  matches: (text: string) => boolean;
  /** 何回まで殺すか。既定は1回。 */
  times?: number;
}): () => void {
  const original = Client.prototype.query;
  let remaining = options.times ?? 1;
  (Client.prototype as unknown as { query: unknown }).query = function (
    this: Client & { processID: number; connectionParameters?: { application_name?: string } },
    ...args: unknown[]
  ) {
    const first = args[0];
    const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
    const promiseForm = typeof args[args.length - 1] !== "function";
    if (
      remaining > 0 &&
      promiseForm &&
      typeof text === "string" &&
      this.connectionParameters?.application_name === options.applicationName &&
      options.matches(text)
    ) {
      remaining -= 1;
      return (async () => {
        await options.admin.query("SELECT pg_terminate_backend($1)", [this.processID]);
        // 切断が client に伝わるのを待つ。
        await sleep(80);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      })();
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  return () => {
    (Client.prototype as unknown as { query: unknown }).query = original;
  };
}

/** `Client.prototype.query` を差し替え、`applicationName` が一致する接続が `matches` に当たる文を投げようとしたら、その文は送らずに `error` で reject する（接続は生きたまま）。「savepoint の `rollback to savepoint` だけが失敗し、接続もトランザクションも生きている」形を作るのに使う。戻り値の関数で元に戻す（`finally` で必ず呼ぶこと）。 */
export function rejectStatement(options: {
  applicationName: string;
  matches: (text: string) => boolean;
  error: Error;
  /** 何回まで reject するか。既定は無制限。 */
  times?: number;
}): () => void {
  const original = Client.prototype.query;
  let remaining = options.times ?? Number.POSITIVE_INFINITY;
  (Client.prototype as unknown as { query: unknown }).query = function (
    this: Client & { connectionParameters?: { application_name?: string } },
    ...args: unknown[]
  ) {
    const first = args[0];
    const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
    const promiseForm = typeof args[args.length - 1] !== "function";
    if (
      remaining > 0 &&
      promiseForm &&
      typeof text === "string" &&
      this.connectionParameters?.application_name === options.applicationName &&
      options.matches(text)
    ) {
      remaining -= 1;
      return Promise.reject(options.error);
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  return () => {
    (Client.prototype as unknown as { query: unknown }).query = original;
  };
}
