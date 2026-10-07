import { afterAll, describe, expect, it } from "vitest";
import {
  isContestedWithoutCompanionError,
  type Ctx,
  type MemoryId,
  type MemoryStore,
  type NewMemoryEvent,
} from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const A: Ctx = { tenantId: "batch-contested-companion" };

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

let seq = 0;
const input = (overrides: Parameters<typeof buildNewMemoryFixture>[0] = {}) => {
  seq += 1;
  return buildNewMemoryFixture({
    tenantId: A.tenantId,
    content: `body-${seq}`,
    digest: `digest-${seq}`,
    contentHash: `hash-${seq}`,
    ...overrides,
  });
};

const createdEvent = (memory: { id: MemoryId }): NewMemoryEvent => ({
  tenantId: A.tenantId,
  memoryId: memory.id,
  kind: "created",
  actor: { type: "system" },
  meta: {},
});

for (const [kitName, makeStore] of KITS) {
  describe(`${kitName}: createMemoriesWithOutboxAndEvents の contested の対向`, () => {
    it("対向の無い contested の候補だけを落とし、active と対向のある contested は書く", async () => {
      const store = await makeStore();
      const partner = await store.createMemory(A, input());

      const result = await store.createMemoriesWithOutboxAndEvents!(
        A,
        [
          { input: input({ status: "contested" }), jobKinds: [] },
          { input: input(), jobKinds: [] },
          { input: input({ status: "contested", contestedWithId: partner.id }), jobKinds: [] },
        ],
        createdEvent,
      );

      expect(result.written.map((w) => w.index)).toEqual([1, 2]);
      expect(result.written[1]!.memory.status).toBe("contested");
      expect(result.written[1]!.memory.contestedWithId).toBe(partner.id);
      expect(result.dropped.map((d) => d.index)).toEqual([0]);
      expect(isContestedWithoutCompanionError(result.dropped[0]!.error)).toBe(true);
    });

    it("全候補が対向の無い contested なら ContestedWithoutCompanionError を投げ、何も書かない", async () => {
      const store = await makeStore();

      const error = await store.createMemoriesWithOutboxAndEvents!(
        A,
        [{ input: input({ status: "contested" }), jobKinds: [] }],
        createdEvent,
      ).catch((e: unknown) => e);

      expect(isContestedWithoutCompanionError(error)).toBe(true);
    });
  });
}
