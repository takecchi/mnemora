import type { Pool, PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { findCrossTenantReferences } from "../cross-tenant-reference-detection.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

const TA = "xdet-def-tenant-a";
const TB = "xdet-def-tenant-b";
const A: Ctx = { tenantId: TA };
const B: Ctx = { tenantId: TB };

async function seedMismatches(count: number) {
  const { db, pool } = await getTestClient();
  const mem = new PostgresMemoryStore(db);
  const make = (ctx: Ctx, name: string) =>
    mem.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: name,
        contentHash: `xdet-def-${ctx.tenantId}-${name}`,
      }),
    );
  const b1 = await make(B, "b1");
  for (let i = 0; i < count; i++) {
    const m = await make(A, `a${i}`);
    await pool.query("UPDATE memories SET superseded_by_id = $1 WHERE id = $2", [b1.id, m.id]);
  }
  return pool;
}

describe("findCrossTenantReferences: 既定のサンプル上限は20件", () => {
  it("21件の食い違いがあるとき、sampleLimit を省くと samples は20件で count は21", async () => {
    const pool = await seedMismatches(21);

    const r = await findCrossTenantReferences(pool);

    const f = r.findings.find((x) => x.kind === "memories.superseded_by_id")!;
    expect(f.count).toBe(21);
    expect(f.samples).toHaveLength(20);
    expect(r.total).toBe(21);
  });
});

describe("findCrossTenantReferences: ROLLBACK まで失敗した接続は pool へ戻さず捨てる", () => {
  it("ROLLBACK が失敗した接続には release(error) を渡し、結果は返す", async () => {
    const pool = await seedMismatches(1);
    const releases: unknown[] = [];
    const wrapped = {
      connect: async () => {
        const c = await pool.connect();
        const proxy = {
          query: (text: string, ...rest: unknown[]) => {
            if (typeof text === "string" && /^\s*ROLLBACK\b/i.test(text)) {
              return Promise.reject(new Error("ROLLBACK 自体の失敗（接続断など）"));
            }
            return (c.query as (...x: unknown[]) => unknown)(text, ...rest);
          },
          release: (arg?: unknown) => {
            releases.push(arg);
            // 本物の接続は、後始末のため必ず閉じる（捨てる指定でも返す指定でも）。
            c.query("ROLLBACK").then(
              () => c.release(arg as Error | undefined),
              () => c.release(arg as Error | undefined),
            );
          },
        } as unknown as PoolClient;
        return proxy;
      },
    } as unknown as Pool;

    const r = await findCrossTenantReferences(wrapped);

    expect(r.total).toBe(1);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeInstanceOf(Error);
  });
});
