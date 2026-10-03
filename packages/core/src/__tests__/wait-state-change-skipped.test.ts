import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0544: LLM を待つ間に元の記憶が `contested`（と、訂正の解決で負けた `superseded`）になったら、
 * `reextract`・`consolidate`・`reflect` は書かずに打ち切る。core の `FakeMemoryStore`（3つ目の実装）での確認。
 * testkit の InMemory と Postgres は `packages/postgres/src/__tests__/wait-state-change-skipped.postgres.test.ts`。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
let seq = 0;

function newMemory(content: string): NewMemory {
  seq += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash: `wait-state-${seq}`,
    digest: content,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365 * 10,
    }),
    embeddingStatus: "pending",
  };
}

type Phase = { extract: string[]; beforeReturn?: () => Promise<void> };

function setup(hidePort: boolean) {
  const stores = createFakeRuntimeStores();
  if (hidePort) {
    (
      stores.memoryStore as { supersedeWithNewMemories?: MemoryStore["supersedeWithNewMemories"] }
    ).supersedeWithNewMemories = undefined;
  }
  const phase: Phase = { extract: [] };
  const llm: LLMProvider = {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      const hook = phase.beforeReturn;
      phase.beforeReturn = undefined;
      if (hook) await hook();
      const extraction = req.schema.safeParse({
        memories: phase.extract.map((content) => ({ content, provenanceKind: "stated" as const })),
      });
      if (extraction.success) return extraction.data as T;
      const reflected = req.schema.safeParse({
        outcome: "reflected",
        content: "内省",
        digest: "内省",
      });
      if (reflected.success) return reflected.data as T;
      return req.schema.parse({ content: "統合", digest: "統合" }) as T;
    },
  };
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => new Date() },
  });
  return { stores, runtime, phase };
}

for (const hidePort of [false, true]) {
  const layer = hidePort ? "（supersedeWithNewMemories の口なし）" : "";
  describe(`Fake${layer}: LLM を待つ間の状態変化（ADR 0544）`, () => {
    it("reextract: X が contested になったら、言い換えは書かれず status: contested の skipped が載る", async () => {
      const { stores, runtime, phase } = setup(hidePort);
      phase.extract = ["猫は3匹"];
      const first = await runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
      const x = first.memoryIds[0]!;
      const y = (await stores.memoryStore.createMemory(ctx, newMemory("猫は2匹"))).id;
      phase.extract = ["猫を3匹飼っている"];
      phase.beforeReturn = async () => {
        await runtime.markContested(ctx, x, y);
      };
      const result = await runtime.reextract(ctx, first.observationId);

      expect(result).toMatchObject({
        memoryIds: [],
        supersededMemoryIds: [],
        atomicity: "not_attempted",
        extraction: "skipped",
      });
      expect(result.skipped).toEqual([
        { kind: "status_not_active", memoryId: x, status: "contested" },
      ]);
      const all = await stores.memoryStore.listBySourceObservationAllVersions(
        ctx,
        first.observationId,
      );
      expect(all.map((m) => m.status)).toEqual(["contested"]);
    });

    it("reextract: X が訂正の解決で負けて superseded になったら、言い換えは書かれない", async () => {
      const { stores, runtime, phase } = setup(hidePort);
      phase.extract = ["猫は3匹"];
      const first = await runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
      const x = first.memoryIds[0]!;
      const y = (await stores.memoryStore.createMemory(ctx, newMemory("猫は2匹"))).id;
      phase.extract = ["猫を3匹飼っている"];
      phase.beforeReturn = async () => {
        await runtime.markContested(ctx, x, y);
        await runtime.resolveContested(ctx, x, y, { kind: "supersede", winnerId: y });
      };
      const result = await runtime.reextract(ctx, first.observationId);

      expect(result).toMatchObject({
        memoryIds: [],
        supersededMemoryIds: [],
        extraction: "skipped",
      });
      expect(result.skipped).toEqual([
        { kind: "status_not_active", memoryId: x, status: "superseded" },
      ]);
    });

    it("対照 reextract: 待つ間に何も変わらなければ従来どおり書かれる／archived でも従来どおり", async () => {
      for (const archive of [false, true]) {
        const { stores, runtime, phase } = setup(hidePort);
        phase.extract = ["猫は3匹"];
        const first = await runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
        const x = first.memoryIds[0]!;
        phase.extract = ["猫を3匹飼っている"];
        if (archive) {
          phase.beforeReturn = async () => {
            await stores.memoryStore.updateStatus(ctx, x, "archived", { expectedStatus: "active" });
          };
        }
        const result = await runtime.reextract(ctx, first.observationId);
        expect(result.extraction).toBe("ok");
        expect(result.memoryIds).toHaveLength(1);
      }
    });

    it("対照 reextract: 待つ間に X が機構で置き換えた superseded（contested_resolved ではない）になっても止めず、従来どおり書かれる", async () => {
      const { runtime, stores, phase } = setup(hidePort);
      phase.extract = ["猫は3匹"];
      const first = await runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
      const x = first.memoryIds[0]!;
      const y = (await stores.memoryStore.createMemory(ctx, newMemory("猫は3匹（別）"))).id;
      phase.extract = ["猫を3匹飼っている"];
      phase.beforeReturn = async () => {
        await stores.memoryStore.updateStatus(ctx, x, "superseded", {
          expectedStatus: "active",
          supersededById: y,
        });
      };
      const result = await runtime.reextract(ctx, first.observationId);
      expect(result.extraction).toBe("ok");
      expect(result.memoryIds).toHaveLength(1);
    });

    it("reextract: 待つ間に X と Z の2件が退けられたら、skipped に止めた記憶ごと（実際の status）が並ぶ", async () => {
      const { stores, runtime, phase } = setup(hidePort);
      phase.extract = ["猫は3匹", "犬は1匹"];
      const first = await runtime.observe(ctx, { kind: "utterance", text: "猫は3匹、犬は1匹" });
      const [x, z] = first.memoryIds as [string, string];
      const y = (await stores.memoryStore.createMemory(ctx, newMemory("猫は2匹"))).id;
      const w = (await stores.memoryStore.createMemory(ctx, newMemory("犬は2匹"))).id;
      phase.extract = ["猫を3匹飼っている", "犬を1匹飼っている"];
      phase.beforeReturn = async () => {
        await runtime.markContested(ctx, x, y);
        await runtime.markContested(ctx, z, w);
        await runtime.resolveContested(ctx, z, w, { kind: "supersede", winnerId: w });
      };
      const result = await runtime.reextract(ctx, first.observationId);
      expect(result).toMatchObject({
        memoryIds: [],
        supersededMemoryIds: [],
        extraction: "skipped",
      });
      expect(result.skipped).toHaveLength(2);
      expect(result.skipped).toEqual(
        expect.arrayContaining([
          { kind: "status_not_active", memoryId: x, status: "contested" },
          { kind: "status_not_active", memoryId: z, status: "superseded" },
        ]),
      );
    });

    it("consolidate: A が contested になったら aborted_source_status_changed。対照: 変化なしなら統合される", async () => {
      const { stores, runtime, phase } = setup(hidePort);
      const a = await stores.memoryStore.createMemory(ctx, newMemory("A"));
      const b = await stores.memoryStore.createMemory(ctx, newMemory("B"));
      const other = await stores.memoryStore.createMemory(ctx, newMemory("A'"));
      phase.beforeReturn = async () => {
        await runtime.markContested(ctx, a.id, other.id);
      };
      const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
      expect(result.outcome).toBe("aborted_source_status_changed");
      expect(result.consolidatedMemoryId).toBeNull();
      expect(result.sources).toEqual([
        { memoryId: a.id, kind: "status_changed_concurrently", observedStatus: "contested" },
        { memoryId: b.id, kind: "not_attempted" },
      ]);

      const c = await stores.memoryStore.createMemory(ctx, newMemory("C"));
      const d = await stores.memoryStore.createMemory(ctx, newMemory("D"));
      const control = await runtime.consolidate(ctx, { target: { memoryIds: [c.id, d.id] } });
      expect(control.outcome).toBe("consolidated");
    });

    it("reflect: 材料の A が contested になったら aborted_source_status_changed。対照: 変化なしなら内省される", async () => {
      const { stores, runtime, phase } = setup(hidePort);
      const a = await stores.memoryStore.createMemory(ctx, newMemory("A"));
      const b = await stores.memoryStore.createMemory(ctx, newMemory("B"));
      const other = await stores.memoryStore.createMemory(ctx, newMemory("A'"));
      phase.beforeReturn = async () => {
        await runtime.markContested(ctx, a.id, other.id);
      };
      const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
      expect(result.outcome).toBe("aborted_source_status_changed");
      expect(result.reflectedMemoryId).toBeNull();
      expect(result.basis).toEqual([
        { memoryId: a.id, kind: "status_changed_before_write", observedStatus: "contested" },
        { memoryId: b.id, kind: "eligible" },
      ]);

      const c = await stores.memoryStore.createMemory(ctx, newMemory("C"));
      const d = await stores.memoryStore.createMemory(ctx, newMemory("D"));
      const control = await runtime.reflect(ctx, { target: { memoryIds: [c.id, d.id] } });
      expect(control.outcome).toBe("reflected");
    });
  });
}
