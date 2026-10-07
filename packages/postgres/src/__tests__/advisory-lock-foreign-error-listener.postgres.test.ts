import { afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  acquireAdvisoryLock,
  releaseAdvisoryLock,
  type AdvisoryLockErrorFactories,
} from "../advisory-lock.js";
import { requireDatabaseUrl } from "./test-db.js";

/** 外すのは自分が付けた同じ関数参照の1つだけで、接続に別の持ち主が付けた `error` リスナーは外さない。 */

const errors: AdvisoryLockErrorFactories = {
  timeout: (waitedMs, cause) => Object.assign(new Error(`timeout after ${waitedMs}ms`), { cause }),
  unavailable: (cause) => Object.assign(new Error("unavailable"), { cause }),
};

const pools: Pool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe("releaseAdvisoryLock: 外すのは自分が付けた error リスナーだけ", () => {
  it("取得したあと別の持ち主が付けた error リスナーは、解放して pool へ返したあとも接続に残る", async () => {
    const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
    pools.push(pool);
    const foreign = (): void => {};

    const { client } = await acquireAdvisoryLock(pool, 9_859_001n, 5_000, errors);
    const ownListeners = client.listeners("error");
    expect(ownListeners).toHaveLength(1);
    client.on("error", foreign);
    await releaseAdvisoryLock(client, 9_859_001n);

    expect(client.listeners("error")).toContain(foreign);
    expect(client.listeners("error")).not.toContain(ownListeners[0]);
    client.removeListener("error", foreign);
  });
});
