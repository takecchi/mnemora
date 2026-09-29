import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import type { Db } from "../client.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PgvectorVersionUnsupportedError } from "../pgvector-capability.js";

/**
 * `PostgresVectorStore` の pgvector 能力検査（`PgvectorCapabilityGate`、Issue #1301 /
 * ADR 0367）を **DB 無しで**検査する歯。`vector-store.ts` の `withRelaxedOrderScan` が、
 * `hnsw.iterative_scan` を `relaxed_order` に変える `SET LOCAL` 文を発行する**前**に
 * 検査すること・インスタンスごとに成功をキャッシュすること・失敗はキャッシュしないことを、
 * `db.execute`/`db.transaction` を差し替えた偽の `Db` で固定する。
 *
 * 本物の Postgres + pgvector 0.8.0 に対する実測は
 * `search-hnsw` 系・`recall-roundtrip-count.postgres.test.ts` 等の `*.postgres.test.ts`
 * が担う（このファイルは判定ロジックと呼び出し順序だけを見る）。
 */

const SPACE: EmbeddingSpaceId = { provider: "testkit", model: "fake", dimensions: 1 };
const CTX: Ctx = { tenantId: "tenant-pgvector-capability" };

const SUPPORTED_ROW = { extversion: "0.8.0", vartype: "enum", enumvals: ["off", "relaxed_order"] };
const UNSUPPORTED_ROW = { extversion: "0.7.4", vartype: null, enumvals: null };

/**
 * `db.execute`（能力検査専用——`PostgresVectorStore` は `search`/`searchMany` の中で、
 * トランザクション**外**の `db.execute` を能力検査以外に一度も呼ばない）と
 * `db.transaction`（`SET LOCAL` + 本体 SELECT）を差し替えた偽の `Db`。
 */
function createFakeDb(capabilityRows: readonly (Record<string, unknown> | undefined)[]) {
  let executeCallCount = 0;
  let transactionCallCount = 0;

  const db = {
    execute: async (_query: unknown) => {
      const row = capabilityRows[executeCallCount];
      executeCallCount += 1;
      return { rows: row === undefined ? [] : [row] };
    },
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      transactionCallCount += 1;
      const tx = {
        execute: async (_q: unknown) => ({ rows: [] }),
      };
      return cb(tx);
    },
  };

  return {
    db: db as unknown as Db,
    getExecuteCallCount: () => executeCallCount,
    getTransactionCallCount: () => transactionCallCount,
  };
}

describe("PostgresVectorStore: pgvector 能力検査は SET LOCAL より前に決着する", () => {
  it("対応していない: search() は PgvectorVersionUnsupportedError で reject し、db.transaction（SET LOCAL を含む）は一度も呼ばれない", async () => {
    const { db, getTransactionCallCount } = createFakeDb([UNSUPPORTED_ROW]);
    const store = new PostgresVectorStore(db);

    await expect(
      store.search(CTX, SPACE, [1], { limit: 1, filter: { tenantId: CTX.tenantId } }),
    ).rejects.toBeInstanceOf(PgvectorVersionUnsupportedError);

    expect(getTransactionCallCount()).toBe(0);
  });

  it("対応していない: searchMany() も同じく PgvectorVersionUnsupportedError で reject し、db.transaction は呼ばれない", async () => {
    const { db, getTransactionCallCount } = createFakeDb([UNSUPPORTED_ROW]);
    const store = new PostgresVectorStore(db);

    await expect(
      store.searchMany(CTX, SPACE, [{ key: "k1", vector: [1] }], {
        limit: 1,
        filter: { tenantId: CTX.tenantId },
      }),
    ).rejects.toBeInstanceOf(PgvectorVersionUnsupportedError);

    expect(getTransactionCallCount()).toBe(0);
  });

  it("対応している: search() は通り、db.transaction が呼ばれる（本体の SET LOCAL + SELECT はそちら側の責務）", async () => {
    const { db, getTransactionCallCount } = createFakeDb([SUPPORTED_ROW]);
    const store = new PostgresVectorStore(db);

    await expect(
      store.search(CTX, SPACE, [1], { limit: 1, filter: { tenantId: CTX.tenantId } }),
    ).resolves.toEqual([]);

    expect(getTransactionCallCount()).toBe(1);
  });

  it("成功はインスタンスごとにキャッシュされる: 2回目の search() は能力検査を再発行しない", async () => {
    // capabilityRows に1行しか用意しない——2回目に db.execute が呼ばれたら
    // undefined を返し、判定は「対応していない」に倒れる。それでも2回目の
    // search() が成功することが、検査が再発行されていない証拠になる。
    const { db, getExecuteCallCount, getTransactionCallCount } = createFakeDb([SUPPORTED_ROW]);
    const store = new PostgresVectorStore(db);

    await store.search(CTX, SPACE, [1], { limit: 1, filter: { tenantId: CTX.tenantId } });
    await store.search(CTX, SPACE, [1], { limit: 1, filter: { tenantId: CTX.tenantId } });

    expect(getExecuteCallCount()).toBe(1); // 能力検査は1回だけ。
    expect(getTransactionCallCount()).toBe(2); // 本体の search() 自体は2回とも実行されている。
  });

  it("成功のキャッシュは search()/searchMany() の間で共有される（インスタンス単位、メソッド単位ではない）", async () => {
    const { db, getExecuteCallCount } = createFakeDb([SUPPORTED_ROW]);
    const store = new PostgresVectorStore(db);

    await store.search(CTX, SPACE, [1], { limit: 1, filter: { tenantId: CTX.tenantId } });
    await store.searchMany(CTX, SPACE, [{ key: "k1", vector: [1] }], {
      limit: 1,
      filter: { tenantId: CTX.tenantId },
    });

    expect(getExecuteCallCount()).toBe(1);
  });

  it("失敗はキャッシュされない: 1回目が失敗しても、2回目に対応した行が返れば通る", async () => {
    const { db, getExecuteCallCount, getTransactionCallCount } = createFakeDb([
      UNSUPPORTED_ROW,
      SUPPORTED_ROW,
    ]);
    const store = new PostgresVectorStore(db);

    await expect(
      store.search(CTX, SPACE, [1], { limit: 1, filter: { tenantId: CTX.tenantId } }),
    ).rejects.toBeInstanceOf(PgvectorVersionUnsupportedError);
    await expect(
      store.search(CTX, SPACE, [1], { limit: 1, filter: { tenantId: CTX.tenantId } }),
    ).resolves.toEqual([]);

    // 2回とも能力検査を発行している（キャッシュしていない）ことの直接の裏付け。
    expect(getExecuteCallCount()).toBe(2);
    expect(getTransactionCallCount()).toBe(1);
  });

  it("異なる PostgresVectorStore インスタンスは、キャッシュを共有しない", async () => {
    const dbA = createFakeDb([SUPPORTED_ROW]);
    const dbB = createFakeDb([SUPPORTED_ROW]);
    const storeA = new PostgresVectorStore(dbA.db);
    const storeB = new PostgresVectorStore(dbB.db);

    await storeA.search(CTX, SPACE, [1], { limit: 1, filter: { tenantId: CTX.tenantId } });
    await storeB.search(CTX, SPACE, [1], { limit: 1, filter: { tenantId: CTX.tenantId } });

    expect(dbA.getExecuteCallCount()).toBe(1);
    expect(dbB.getExecuteCallCount()).toBe(1);
  });
});
