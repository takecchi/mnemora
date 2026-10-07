import { afterEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  acquireAdvisoryLock,
  releaseAdvisoryLock,
  releaseAdvisoryLockOnClient,
  type AdvisoryLockErrorFactories,
} from "../advisory-lock.js";
import { DEFAULT_LOCK_TIMEOUT_MS } from "../advisory-lock.js";
import { runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { requireDatabaseUrl, TEST_EMBEDDING_SPACE } from "./test-db.js";

const errors: AdvisoryLockErrorFactories = {
  timeout: (waitedMs, cause) => Object.assign(new Error(`timeout after ${waitedMs}ms`), { cause }),
  unavailable: (cause) => Object.assign(new Error("unavailable"), { cause }),
};

const pools: Pool[] = [];
function newPool(max: number): Pool {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), max });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

async function lockTimeoutOf(client: PoolClient): Promise<string> {
  return ((await client.query("SHOW lock_timeout")).rows[0] as { lock_timeout: string })
    .lock_timeout;
}

describe("acquireAdvisoryLock・releaseAdvisoryLock の後始末", () => {
  it("B1: 同じ物理接続で12回取って外しても、error リスナーは積み上がらず、lock_timeout は '0' に戻る", async () => {
    const pool = newPool(1);
    for (let i = 0; i < 12; i += 1) {
      const { client } = await acquireAdvisoryLock(pool, 9_330_001n, 5_000, errors);
      await releaseAdvisoryLock(client, 9_330_001n);
    }
    const client = await pool.connect();
    try {
      expect(client.listenerCount("error")).toBe(0);
      expect(await lockTimeoutOf(client)).toBe("0");
    } finally {
      client.release();
    }
  });

  it("B2: 待ち時間切れで失敗すると、接続を返してから投げ、リスナーも lock_timeout も片付ける", async () => {
    const pool = newPool(2);
    const held = await acquireAdvisoryLock(pool, 9_330_002n, 5_000, errors);
    await expect(acquireAdvisoryLock(pool, 9_330_002n, 100, errors)).rejects.toThrow(
      /^timeout after/,
    );
    await releaseAdvisoryLock(held.client, 9_330_002n);

    expect(pool.totalCount).toBe(2);
    expect(pool.idleCount).toBe(2);
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      for (const client of clients) {
        expect(client.listenerCount("error")).toBe(0);
        expect(await lockTimeoutOf(client)).toBe("0");
      }
    } finally {
      for (const client of clients) client.release();
    }
  });
});

describe("接続側で渡した lock_timeout は、待ち時間切れで失敗しても書き換えない（ADR 0460）", () => {
  it("options で lock_timeout=7s を渡した pool で、取得が時間切れになったあと、どの接続の lock_timeout も 7s のまま（0 にも取得時の値にもしない）", async () => {
    const pool = new Pool({
      connectionString: requireDatabaseUrl(),
      max: 2,
      options: "-c lock_timeout=7s",
    });
    pools.push(pool);
    const held = await acquireAdvisoryLock(pool, 9_330_003n, 5_000, errors);
    await expect(acquireAdvisoryLock(pool, 9_330_003n, 100, errors)).rejects.toThrow(
      /^timeout after/,
    );
    await releaseAdvisoryLock(held.client, 9_330_003n);

    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      expect(await Promise.all(clients.map((client) => lockTimeoutOf(client)))).toEqual([
        "7s",
        "7s",
      ]);
    } finally {
      for (const client of clients) client.release();
    }
  });
});

describe("B4: releaseAdvisoryLockOnClient はロックを外すだけ", () => {
  it("lock_timeout を戻さず、接続も返さない（呼び出し側が続けてその接続を使える）", async () => {
    const pool = newPool(1);
    const { client } = await acquireAdvisoryLock(pool, 9_330_004n, 4_321, errors);
    await releaseAdvisoryLockOnClient(client, 9_330_004n);
    try {
      expect(pool.idleCount).toBe(0);
      expect(await lockTimeoutOf(client)).toBe("4321ms");
      const held = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
      );
      expect(held.rows[0]?.n).toBe(0);
    } finally {
      await releaseAdvisoryLock(client, 9_330_004n);
    }
  });
});

/**
 * pool が貸し出す接続の `query` を覗き、`set_config('lock_timeout', $1, …)` の値を集める。
 * `pool.connect` そのものは差し替えない（`pool.query` が内部でコールバック形の `connect` を呼ぶため）。
 * 貸し出しのたびに出る `acquire` のイベントで、その接続の `query` を一度だけ包む。
 */
function spyLockTimeouts(pool: Pool): string[] {
  const seen: string[] = [];
  const wrapped = new WeakSet<PoolClient>();
  pool.on("acquire", (client: PoolClient) => {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args) => {
      const [text, values] = args as [unknown, unknown];
      if (
        typeof text === "string" &&
        text.includes("set_config('lock_timeout', $1") &&
        Array.isArray(values)
      ) {
        seen.push(String(values[0]));
      }
      return query(...args);
    };
  });
  return seen;
}

describe("B6: lockTimeoutMs を省くと DEFAULT_LOCK_TIMEOUT_MS で待つ", () => {
  it("runMigrations と registerEmbeddingSpace は、lock_timeout に DEFAULT_LOCK_TIMEOUT_MS（30000）を敷く", async () => {
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBe(30_000);
    const pool = newPool(3);
    const seen = spyLockTimeouts(pool);
    await runMigrations(pool);
    await registerEmbeddingSpace(pool, TEST_EMBEDDING_SPACE);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((value) => value === String(DEFAULT_LOCK_TIMEOUT_MS))).toBe(true);
  });
});
