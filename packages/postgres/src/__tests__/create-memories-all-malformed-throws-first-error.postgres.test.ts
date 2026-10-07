import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, NewMemory } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0630（「`createMemoriesWithOutboxAndEvents?`（3つの口の外）」）: 全候補が壊れていれば、**最初の例外**（この検査の `Error`）を
 * そのまま投げ、Memory は1件も書かない。既存の歯は、全候補が同じ形（同じ欄・同じ文面）で壊れていたので、最初の例外でなく最後の例外を
 * 投げる変異が緑のまま残った。候補ごとに壊れた欄を変え、どの候補の例外が出るかまで縛る（Postgres・fixture）。
 */
const ctx: Ctx = { tenantId: "create-memories-all-malformed" };

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

describe("createMemoriesWithOutboxAndEvents: 全候補が壊れていれば、最初の候補の例外を投げ、何も書かない", () => {
  it("1つ目は digest、2つ目は contentHash、3つ目は extractorVersion が壊れている", async () => {
    for (const impl of ["postgres", "fixture"] as const) {
      await resetTestDatabase();
      const store =
        impl === "postgres"
          ? new PostgresMemoryStore((await getTestClient()).db)
          : new InMemoryMemoryStore();
      const candidate = (over: Partial<NewMemory>) => ({
        input: buildNewMemoryFixture({ tenantId: ctx.tenantId, ...over } as Partial<NewMemory>),
        jobKinds: [] as never[],
      });
      const error = await store.createMemoriesWithOutboxAndEvents!(
        ctx,
        [
          candidate({ contentHash: "a", digest: "" }),
          candidate({ contentHash: "" }),
          candidate({ contentHash: "c", extractorVersion: "" }),
        ],
        (m) =>
          buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: m.id, kind: "created" }),
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(error), impl).toMatch(/digest is malformed/);
      if (store instanceof InMemoryMemoryStore) {
        expect(store.listByTenant(ctx), impl).toHaveLength(0);
      } else {
        const { pool } = await getTestClient();
        const r = await pool.query("SELECT count(*)::int AS n FROM memories");
        expect((r.rows[0] as { n: number }).n, impl).toBe(0);
      }
    }
  });
});
