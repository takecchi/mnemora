import { setTimeout as sleep } from "node:timers/promises";
import { Client, type Pool } from "pg";

/**
 * 「ある文の直前に、その接続を殺す」ための注入（ADR 0444）。`Client.prototype.query` を差し替え、
 * `applicationName` が一致する接続が `matches` に当たる文を投げようとした瞬間に、別の接続
 * （`admin`）から `pg_terminate_backend` でその接続を切ってから、本物の `query` を呼ぶ。
 * 切れた接続への `query` は reject する——実運用で「Postgres の再起動の最中に `begin` を投げる」
 * のと同じ形を、決まった位置で作る。
 *
 * 戻り値の関数で元に戻す（`finally` で必ず呼ぶこと）。promise 形の `query` だけを扱う。
 */
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
