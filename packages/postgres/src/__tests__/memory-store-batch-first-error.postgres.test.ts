import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "batch-first-error" };
const now = new Date("2026-01-01T00:00:00.000Z");

afterAll(async () => {
  await closeTestClient();
});

const KITS: Array<[string, () => Promise<MemoryStore>]> = [
  ["testkit の InMemory", async () => new InMemoryMemoryStore()],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return new PostgresMemoryStore(db);
    },
  ],
];

const createdEventFor = (memory: { id: string; digest: string }): NewMemoryEvent =>
  ({
    tenantId: ctx.tenantId,
    memoryId: memory.id,
    kind: "created",
    at: now,
    actor: { type: "system" },
    digestSnapshot: memory.digest,
    sizeBeforeBytes: null,
    meta: { reason: "extracted" },
  }) as NewMemoryEvent;

for (const [name, makeStore] of KITS) {
  describe(`${name}: createMemoriesWithOutboxAndEvents で全候補が保存できないとき`, () => {
    it("落ちた理由が候補ごとに違うとき、最初の候補の例外を投げ、何も書かない", async () => {
      const store = await makeStore();
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
      );
      const candidate = (contentHash: string, over: Record<string, unknown>) => ({
        input: buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          sourceObservationId: observation.id,
          extractorVersion: "v1",
          contentHash,
          ...over,
        }),
        jobKinds: ["embed" as const],
      });
      const first = candidate("first-bad", { content: "一件目\u0000" });
      const second = candidate("second\u0000-bad", { content: "二件目の事実" });

      const outcome = await store.createMemoriesWithOutboxAndEvents!(
        ctx,
        [first, second],
        (memory) => createdEventFor(memory),
        {
          now,
        },
      ).then(
        () => "returned" as const,
        (error: unknown) => error as Error,
      );

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/content must not contain NUL/);
      expect((outcome as Error).message).not.toMatch(/contentHash/);
      expect(await store.listBySourceObservation(ctx, observation.id, "v1")).toEqual([]);
    });
  });
}
