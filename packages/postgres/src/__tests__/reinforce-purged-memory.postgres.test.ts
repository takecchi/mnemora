import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, RecallId } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { DeterministicEmbeddingProvider, DeterministicLLMProvider } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { sha256Hex } from "../content-hash.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * ADR 0501（ADR 0453 負債3）: purged（`forget` → `purge` 済み）の記憶に `reinforce`・`reinforceMany`・
 * `recordUsageAndReinforce`・`Runtime.observe({kind:'memory_usage'})` を当てると、4つの口とも
 * `lastReinforcedAt` を書き換える。`status`（forgotten）・`purgedAt`・`content` は動かず、
 * `recall()` の結果には影響しない。`MemoryStore.reinforce` の TSDoc が purged をこう書く根拠の歯。
 * 振る舞いを変える直しではない（purged を弾くなら、それは store 契約の変更でオーナーの領分）。
 */

const ctx: Ctx = { tenantId: "reinforce-purged" };
const HOUR = 3_600_000;

afterAll(async () => {
  await closeTestClient();
});

async function setup() {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const store = new PostgresMemoryStore(db);
  const runtime = createRuntime({
    memoryStore: store,
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: new DeterministicLLMProvider(),
    embeddingProvider: new DeterministicEmbeddingProvider(TEST_EMBEDDING_SPACE),
    hashContent: sha256Hex,
  });
  const observed = await runtime.observe(ctx, {
    kind: "utterance",
    text: "カバはとても重い",
    speaker: "u",
  });
  const memoryId: MemoryId = observed.memoryIds[0]!;
  await runtime.tick(ctx, { leaseMs: 60_000 });
  const recalled = await runtime.recall(ctx, { text: "カバはとても重い" });
  expect(recalled.memories.map((m) => m.memoryId)).toContain(memoryId);
  const recallId: RecallId = recalled.recallId;
  return { store, runtime, memoryId, recallId };
}

describe("purged の記憶への強化（ADR 0501 / ADR 0453 負債3、本物の Postgres）", () => {
  it("4つの口とも lastReinforcedAt を書き換える。status・purgedAt・content は不変で、recall には出ない", async () => {
    const { store, runtime, memoryId, recallId } = await setup();
    expect((await runtime.forget(ctx, { memoryId })).outcomes[0]?.kind).toBe("forgotten");
    expect((await runtime.purge(ctx, { memoryId })).outcomes[0]?.kind).toBe("purged");

    const purged = (await store.get(ctx, memoryId))!;
    expect(purged.status).toBe("forgotten");
    expect(purged.purgedAt).toBeInstanceOf(Date);
    expect(purged.content).toBe("[purged]");

    // 前提: 口ごとに「書き換わった」を見分けられるよう、at は単調に増やす。
    // observe は実時計（now）で書くので最初に撃ち、store 直の3口は未来の at を昇順に使う。
    let prev = purged.lastReinforcedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const expectAdvanced = async (label: string, expectedAt?: Date) => {
      const m = (await store.get(ctx, memoryId))!;
      expect(m.lastReinforcedAt?.getTime(), `${label}: lastReinforcedAt が進んでいない`).toBeGreaterThan(
        prev,
      );
      if (expectedAt !== undefined) expect(m.lastReinforcedAt?.getTime()).toBe(expectedAt.getTime());
      expect(m.status).toBe("forgotten");
      expect(m.purgedAt?.getTime()).toBe(purged.purgedAt?.getTime());
      expect(m.content).toBe("[purged]");
      prev = m.lastReinforcedAt!.getTime();
    };

    await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memoryId],
      externalId: "reinforce-purged-observe",
    });
    await expectAdvanced("observe(memory_usage)");

    const base = Date.now() + 10 * HOUR;
    const at1 = new Date(base + HOUR);
    await store.reinforce(ctx, memoryId, at1);
    await expectAdvanced("reinforce", at1);

    const at2 = new Date(base + 2 * HOUR);
    await store.reinforceMany!(ctx, [memoryId], at2);
    await expectAdvanced("reinforceMany", at2);

    const at3 = new Date(base + 3 * HOUR);
    // 同じ (recallId, memoryId) は observe が既に recall_usages に入れている。別の recall を取れないので、
    // ここは recordUsageAndReinforce が「新規挿入なし」を返す形になる。挿入される形は下の別の it で見る。
    await store.recordUsageAndReinforce!(ctx, recallId, [memoryId], at3);

    // recall には出ない（forgotten ゲート）。
    const after = await runtime.recall(ctx, { text: "カバはとても重い" });
    expect(after.memories.map((m) => m.memoryId)).not.toContain(memoryId);
  });

  it("recordUsageAndReinforce が新規に挿入する形でも、purged の lastReinforcedAt を書き換える", async () => {
    const { store, runtime, memoryId, recallId } = await setup();
    await runtime.forget(ctx, { memoryId });
    await runtime.purge(ctx, { memoryId });
    const before = (await store.get(ctx, memoryId))!;
    const at = new Date(Date.now() + 10 * HOUR);
    const r = await store.recordUsageAndReinforce!(ctx, recallId, [memoryId], at);
    expect(r.insertedMemoryIds).toEqual([memoryId]);
    const m = (await store.get(ctx, memoryId))!;
    expect(m.lastReinforcedAt?.getTime()).toBe(at.getTime());
    expect(before.lastReinforcedAt?.getTime() ?? Number.NEGATIVE_INFINITY).toBeLessThan(at.getTime());
    expect(m.status).toBe("forgotten");
    expect(m.content).toBe("[purged]");
  });
});
