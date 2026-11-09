import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, Provenance } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

// inferred の provenance の `respondedModel`（ADR 0701）が jsonb を往復して保たれ、省いた記憶ではキーが現れないこと。

const ctx: Ctx = { tenantId: "provenance-responded-model" };

function inferred(
  observationId: string,
  over: Partial<Extract<Provenance, { kind: "inferred" }>>,
): Provenance {
  return {
    kind: "inferred",
    model: "configured-model",
    promptVersion: "v1",
    basis: { memoryIds: [], observationIds: [observationId] },
    confidence: 0.5,
    ...over,
  };
}

describe("PostgresMemoryStore: inferred の respondedModel を往復で保つ（本物の Postgres）", () => {
  let memoryStore: PostgresMemoryStore;

  beforeEach(async () => {
    const client = await getTestClient();
    memoryStore = new PostgresMemoryStore(client.db);
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  /** inferred は出所の Observation を要る（`memories` の CHECK）。 */
  async function putInferred(contentHash: string, provenanceOf: (obs: string) => Provenance) {
    const observation = await memoryStore.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
    );
    const provenance = provenanceOf(observation.id);
    const created = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash,
        sourceObservationId: observation.id,
        provenance,
      }),
    );
    return { created, provenance };
  }

  it("書いた respondedModel を get でそのまま読める", async () => {
    const { created, provenance } = await putInferred("h-with", (obs) =>
      inferred(obs, { respondedModel: "responded-model-2026-01-01" }),
    );

    expect((await memoryStore.get(ctx, created.id))!.provenance).toEqual(provenance);
  });

  it("respondedModel を省いた記憶では、読んでもキーが現れない（確かめていないことが保たれる）", async () => {
    const { created } = await putInferred("h-without", (obs) => inferred(obs, {}));

    expect("respondedModel" in (await memoryStore.get(ctx, created.id))!.provenance).toBe(false);
  });
});
