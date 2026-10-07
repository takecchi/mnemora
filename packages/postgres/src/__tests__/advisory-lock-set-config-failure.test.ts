import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { acquireAdvisoryLock, type AdvisoryLockErrorFactories } from "../advisory-lock.js";

/**
 * `set_config` を実際に失敗させる経路は DB の側には無いので、`pool.connect()` が返す接続の `query` が
 * `set_config` で reject する最小の偽の pool を渡す（DB には繋がない）。
 */

class SetConfigFailure extends Error {}

const errors: AdvisoryLockErrorFactories = {
  timeout: (waitedMs, cause) => Object.assign(new Error(`timeout:${waitedMs}`), { cause }),
  unavailable: (cause) => Object.assign(new Error("unavailable"), { cause }),
};

describe("acquireAdvisoryLock: lock_timeout の設定（set_config）に失敗したら unavailable（ADR 0571 の B1）", () => {
  it("unavailable を投げ（cause は元の失敗）、接続は返却し、pg_advisory_lock は撃たない", async () => {
    const failure = new SetConfigFailure("set_config failed");
    const queries: string[] = [];
    const release = vi.fn();
    const removeListener = vi.fn();
    const client = {
      on: vi.fn(),
      removeListener,
      release,
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes("set_config")) throw failure;
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;

    let thrown: unknown;
    await acquireAdvisoryLock(pool, 9_330_101n, 5_000, errors).catch((e: unknown) => {
      thrown = e;
    });

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("unavailable");
    expect((thrown as Error).cause).toBe(failure);
    expect(release).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("set_config");
  });
});
