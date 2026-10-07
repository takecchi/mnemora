import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, NewMemory } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "supersede-malformed-position" };
const MISSING = randomUUID();

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

describe("supersedeWithNewMemories: 壊れた news は、どの位置でも、存在しない対象の not found より先に断られる（Postgres・fixture）", () => {
  it.each([0, 1, 2])("壊れた news が %s 番目", async (broken) => {
    for (const impl of ["postgres", "fixture"] as const) {
      await resetTestDatabase();
      const store =
        impl === "postgres"
          ? new PostgresMemoryStore((await getTestClient()).db)
          : new InMemoryMemoryStore();
      const news = [0, 1, 2].map((i) => ({
        input: buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `n${i}`,
          ...(i === broken ? { digest: "" } : {}),
        } as Partial<NewMemory>),
        jobKinds: [] as never[],
      }));
      const error = await store
        .supersedeWithNewMemories(ctx, news, [
          {
            id: MISSING as never,
            supersededByIndex: 0,
            event: {
              tenantId: ctx.tenantId,
              memoryId: MISSING as never,
              kind: "superseded",
              actor: { type: "system" },
              digestSnapshot: "d",
              sizeBeforeBytes: null,
              meta: { reason: "test" },
            },
          },
        ])
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(String(error), impl).toMatch(/digest is malformed/);
      expect(String(error), impl).not.toMatch(/not found/);
    }
  });
});
