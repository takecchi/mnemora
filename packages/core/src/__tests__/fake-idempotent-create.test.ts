import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0052: 擬似実装の `created` は、**この呼び出し自身が行を作ったか**を表す。
 *
 * `packages/testkit` の適合スイートは `InMemoryMemoryStore` と（CI では）
 * `PostgresMemoryStore` に対して同じ契約を測るが、`FakeMemoryStore`
 * （`packages/core/src/__tests__/runtime-fakes.ts`）は適合スイートの対象に入っていない
 * ——`packages/testkit` は `packages/core` に依存しており、逆向きに参照できないためである。
 * 3つ目の実装がこの契約から外れるのを防ぐのがこのファイルの役目
 * （ADR 0049「割れていたのは3実装のうち2つ」と同じ形の歯）。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

function observationInput(externalId: string) {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    externalId,
    kind: "utterance" as const,
    payload: { text: externalId },
    occurredAt: null,
    recordedAt: new Date(),
  };
}

describe("FakeMemoryStore の created は自分が作った行だけを指す（ADR 0052）", () => {
  it("createObservationWithOutbox は、別の行の作成が同時に起きても created を取り違えない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const dupInput = observationInput("ext-existing");

    const seed = await memoryStore.createObservationWithOutbox(ctx, dupInput, ["extract"]);
    expect(seed.created).toBe(true);

    const [dup, fresh] = await Promise.all([
      memoryStore.createObservationWithOutbox(ctx, dupInput, ["extract"]),
      memoryStore.createObservationWithOutbox(ctx, observationInput("ext-fresh"), ["extract"]),
    ]);

    expect({
      dupCreated: dup.created,
      dupJobs: dup.jobs.length,
      dupIsSeedRow: dup.observation.id === seed.observation.id,
      freshCreated: fresh.created,
      freshJobTargets: fresh.jobs.map((job) => job.payload.observationId),
      freshIsDistinctRow: fresh.observation.id !== seed.observation.id,
    }).toEqual({
      dupCreated: false,
      dupJobs: 0,
      dupIsSeedRow: true,
      freshCreated: true,
      freshJobTargets: [fresh.observation.id],
      freshIsDistinctRow: true,
    });
  });

  it("createMemoryWithOutbox は、別の行の作成が同時に起きても created を取り違えない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const observation = await memoryStore.createObservation(ctx, observationInput("ext-for-mem"));

    const base = {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: observation.id,
      extractorVersion: "v1",
      content: "本文",
      digest: "要約",
      digestSource: "llm" as const,
      provenance: { kind: "stated" as const, observationId: observation.id },
      tags: [],
      occurredAt: null,
      recordedAt: new Date(),
      strength: 1,
      halfLifeHours: 24,
      decayFloorAt: new Date(),
      embeddingStatus: "pending" as const,
    };
    const dupInput = { ...base, contentHash: "hash-existing" };

    const seed = await memoryStore.createMemoryWithOutbox(ctx, dupInput, ["embed"]);
    expect(seed.created).toBe(true);

    const [dup, fresh] = await Promise.all([
      memoryStore.createMemoryWithOutbox(ctx, dupInput, ["embed"]),
      memoryStore.createMemoryWithOutbox(ctx, { ...base, contentHash: "hash-fresh" }, ["embed"]),
    ]);

    expect({
      dupCreated: dup.created,
      dupJobs: dup.jobs.length,
      dupIsSeedRow: dup.memory.id === seed.memory.id,
      freshCreated: fresh.created,
      freshJobTargets: fresh.jobs.map((job) => job.payload.memoryId),
      freshIsDistinctRow: fresh.memory.id !== seed.memory.id,
    }).toEqual({
      dupCreated: false,
      dupJobs: 0,
      dupIsSeedRow: true,
      freshCreated: true,
      freshJobTargets: [fresh.memory.id],
      freshIsDistinctRow: true,
    });
  });
});
