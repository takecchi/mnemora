import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import type { NewRecallRecord } from "../recall.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

function newMemory(tenantId: string): NewMemory {
  return {
    tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `fake-erase-exact-${tenantId}`,
    digest: "要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  };
}

function subjectRecall(ctx: Ctx, subjectId: string): NewRecallRecord {
  return {
    tenantId: ctx.tenantId,
    subjectId,
    query: { text: "fixture" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
    advanceActivityClock: { scope: "subject", subjectId },
  };
}

describe("FakeMemoryStore.eraseTenant — recall_usages はテナントの完全一致で消す（ADR 0604）", () => {
  it("acme を消しても、acme:eu の recall_usages は残る", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const eu: Ctx = { tenantId: "acme:eu" };
    const acme: Ctx = { tenantId: "acme" };
    const memory = await memoryStore.createMemory(eu, newMemory(eu.tenantId));
    const recallId = await memoryStore.createRecall(eu, subjectRecall(eu, "s1"));
    await memoryStore.recordUsage(eu, recallId, [memory.id]);
    // 件数だけでは「usage を数えも消しもしない」実装と見分けられないので、usage の行そのものを見る。
    const usages = (memoryStore as unknown as { backing: { usages: Set<string> } }).backing.usages;
    const euUsageKey = `${eu.tenantId}:${recallId}:${memory.id}`;
    expect(usages.has(euUsageKey)).toBe(true);

    const erasedAcme = await memoryStore.eraseTenant(acme, { limit: 1000 });

    expect(erasedAcme).toMatchObject({ deleted: 0, reachedLimit: false });
    expect(usages.has(euUsageKey)).toBe(true);

    await memoryStore.eraseTenant(eu, { limit: 1000 });
    expect(usages.has(euUsageKey)).toBe(false);
  });
});

describe("FakeMemoryStore.eraseTenant — tenant_subject_activity を subject ごとの行で数える（ADR 0604）", () => {
  it("subject が3つなら、recalls 3行 + tenant_subject_activity 3行 = 6 を返す", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const ctx: Ctx = { tenantId: "fake-erase-subject-activity" };
    for (const subjectId of ["s1", "s2", "s3"]) {
      await memoryStore.createRecall(ctx, subjectRecall(ctx, subjectId));
    }

    const preview = await memoryStore.eraseTenant(ctx, { limit: 1000, dryRun: true });
    expect(preview).toMatchObject({ deleted: 6, reachedLimit: false });

    const result = await memoryStore.eraseTenant(ctx, { limit: 1000 });
    expect(result).toMatchObject({ deleted: 6, reachedLimit: false });
    const again = await memoryStore.eraseTenant(ctx, { limit: 1000, dryRun: true });
    expect(again).toMatchObject({ deleted: 0, reachedLimit: false });
  });

  it("limit が subject の行の途中で尽きたら、budget ぶんだけ消して残りを次の呼び出しへ回す", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const ctx: Ctx = { tenantId: "fake-erase-subject-activity-limit" };
    for (const subjectId of ["s1", "s2", "s3"]) {
      await memoryStore.createRecall(ctx, subjectRecall(ctx, subjectId));
    }

    const first = await memoryStore.eraseTenant(ctx, { limit: 5 });
    expect(first).toMatchObject({ deleted: 5, reachedLimit: true });
    const second = await memoryStore.eraseTenant(ctx, { limit: 1000 });
    expect(second).toMatchObject({ deleted: 1, reachedLimit: false });
  });
});
