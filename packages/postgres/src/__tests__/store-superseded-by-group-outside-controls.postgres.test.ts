// 確かめ直し（Issue #1759、B 群 #1621 / ADR 0503）の歯。やりすぎ側の対照。
//
// ADR 0503 決定5: 「群の外の `archived`・`superseded`・`contested` を指すのは、断らない」。断るのは群の外の
// `forgotten` だけ。既存の歯は、群版では「群の外の active」を指す対照しか持たず、断る条件を
// 「active 以外」へ広げる変異（`status === "forgotten"` → `status !== "active"`）が赤にならなかった。
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, Memory, MemoryId, MemoryStore, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const A: Ctx = { tenantId: "superseded-by-group-outside" };

afterAll(async () => {
  await closeTestClient();
});

const KITS: Array<[string, () => Promise<MemoryStore>]> = [
  ["testkit の InMemory", async () => new InMemoryMemoryStore()],
  ["core の Fake", async () => createFakeRuntimeStores().memoryStore],
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
const mem = (store: MemoryStore): Promise<Memory> => {
  seq += 1;
  return store.createMemory(
    A,
    buildNewMemoryFixture({
      tenantId: A.tenantId,
      content: `body-${seq}`,
      digest: `digest-${seq}`,
      contentHash: `hash-${seq}`,
    }),
  );
};
const ev = (memoryId: string): NewMemoryEvent => ({
  tenantId: A.tenantId,
  memoryId: memoryId as MemoryId,
  kind: "updated",
  actor: { type: "system" },
  meta: { probe: true },
});

describe.each(KITS)(
  "resolveContestedGroup: 群の外の forgotten 以外を指す superseded は通る（ADR 0503 決定5）: %s",
  (_n, build) => {
    it.each(["archived", "superseded", "active"] as const)(
      "群の外の %s な記憶を指す",
      async (outsideStatus) => {
        const store = await build();
        const ms = [await mem(store), await mem(store), await mem(store)];
        const winner = await mem(store);
        await store.markContestedGroup!(
          A,
          ms.map((m) => ({ id: m.id, event: ev(m.id) })),
        );
        if (outsideStatus === "archived") {
          await store.updateStatus(A, winner.id, "archived");
        } else if (outsideStatus === "superseded") {
          const other = await mem(store);
          await store.updateStatus(A, winner.id, "superseded", { supersededById: other.id });
        }
        const r = await store.resolveContestedGroup!(A, [
          { id: ms[0]!.id, status: "active", event: ev(ms[0]!.id) },
          { id: ms[1]!.id, status: "superseded", supersededById: winner.id, event: ev(ms[1]!.id) },
          { id: ms[2]!.id, status: "superseded", supersededById: ms[0]!.id, event: ev(ms[2]!.id) },
        ]);
        expect(r.members[1]!.supersededById).toBe(winner.id);
      },
    );
  },
);
