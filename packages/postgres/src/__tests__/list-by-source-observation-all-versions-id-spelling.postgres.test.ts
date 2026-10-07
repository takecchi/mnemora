import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

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

afterAll(async () => {
  await closeTestClient();
});

describe.each(KITS)("listBySourceObservationAllVersions の id の綴り: %s", (_name, build) => {
  it("observationId を大文字で渡しても、小文字で渡したときと同じ記憶を返す", async () => {
    const store = await build();
    const ctx: Ctx = { tenantId: "all-versions-id-spelling" };
    const observation = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
    );
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        sourceObservationId: observation.id,
        extractorVersion: "v1",
        contentHash: "all-versions-id-spelling",
      }),
    );

    const lower = await store.listBySourceObservationAllVersions(ctx, observation.id);
    const upper = await store.listBySourceObservationAllVersions(
      ctx,
      observation.id.toUpperCase() as typeof observation.id,
    );

    expect(lower.map((m) => m.id)).toEqual([memory.id]);
    expect(upper.map((m) => m.id)).toEqual([memory.id]);
  });
});
