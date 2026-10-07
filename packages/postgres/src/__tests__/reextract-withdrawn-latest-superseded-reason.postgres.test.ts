import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryEvent, MemoryId, MemoryStore, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

type Next = { content: string; calls: number };

function makeLlm(next: Next): LLMProvider {
  return {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_ctx, req) => {
      next.calls += 1;
      const extracted = req.schema.safeParse({
        memories: [{ content: next.content, provenanceKind: "stated" }],
      });
      return extracted.success ? extracted.data : req.schema.parse({ content: next.content });
    },
  };
}

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  events(memoryId: MemoryId): Promise<MemoryEvent[]>;
}

function shared(next: Next) {
  return {
    llmProvider: makeLlm(next),
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  };
}

const KITS: Array<[string, (next: Next) => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async (next) => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        events: (memoryId) => eventStore.list(ctx, { memoryId }),
        runtime: createRuntime({
          ...shared(next),
          memoryStore,
          eventStore,
          vectorStore: new InMemoryVectorStore(memoryStore),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async (next) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const eventStore = new PostgresEventStore(db);
      return {
        memoryStore,
        events: (memoryId) => eventStore.list(ctx, { memoryId }),
        runtime: createRuntime({
          ...shared(next),
          memoryStore,
          eventStore,
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "reextract-withdrawn-latest-reason" };

afterAll(async () => {
  await closeTestClient();
});

async function supersededReasons(kit: Kit, memoryId: MemoryId): Promise<unknown[]> {
  return (await kit.events(memoryId))
    .filter((e) => e.kind === "superseded")
    .map((e) => e.meta?.reason);
}

for (const [name, makeKit] of KITS) {
  describe(`${name}: reextract が数える superseded は、最新の superseded イベントの理由で決まる`, () => {
    it("統合で superseded → 戻す → 訂正の解決で superseded: 最新は contested_resolved なので、やり直さない", async () => {
      const next: Next = { content: "猫は3匹", calls: 0 };
      const kit = await makeKit(next);
      const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
      const x = first.memoryIds[0]!;
      next.content = "犬は1匹";
      const other = (await kit.runtime.observe(ctx, { kind: "utterance", text: "犬は1匹" }))
        .memoryIds[0]!;
      next.content = "猫は3匹、犬は1匹";
      const f = (await kit.runtime.consolidate(ctx, { target: { memoryIds: [x, other] } }))
        .consolidatedMemoryId!;
      await kit.runtime.forget(ctx, { memoryId: f });
      const restored = await kit.runtime.restoreSuperseded(ctx, { supersededById: f });
      expect(restored.outcomes.map((o) => o.kind)).toEqual(["restored", "restored"]);
      expect((await kit.memoryStore.get(ctx, x))!.status).toBe("active");
      next.content = "猫は2匹";
      const y = (await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は2匹だった" }))
        .memoryIds[0]!;
      await kit.runtime.markContested(ctx, x, y);
      await kit.runtime.resolveContested(ctx, x, y, { kind: "supersede", winnerId: y });
      expect((await kit.memoryStore.get(ctx, x))!.status).toBe("superseded");
      const reasons = await supersededReasons(kit, x);
      expect(reasons).toHaveLength(2);
      expect(reasons[0]).not.toBe("contested_resolved");
      expect(reasons[1]).toBe("contested_resolved");

      next.content = "猫を3匹飼っている";
      const callsBefore = next.calls;
      const result = await kit.runtime.reextract(ctx, first.observationId);

      expect(next.calls - callsBefore).toBe(0);
      expect(result).toMatchObject({
        extraction: "skipped",
        atomicity: "not_attempted",
        memoryIds: [],
        supersededMemoryIds: [],
      });
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ kind: "status_not_active", memoryId: x, status: "superseded" }),
      );
    });

    it("訂正の解決で superseded → 戻す → reextract で superseded（機構）: 最新は機構なので、次の reextract は今どおりやり直す", async () => {
      const next: Next = { content: "猫は3匹", calls: 0 };
      const kit = await makeKit(next);
      const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
      const x = first.memoryIds[0]!;
      next.content = "猫は2匹";
      const y = (await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は2匹だった" }))
        .memoryIds[0]!;
      await kit.runtime.markContested(ctx, x, y);
      await kit.runtime.resolveContested(ctx, x, y, { kind: "supersede", winnerId: y });
      expect((await kit.memoryStore.get(ctx, x))!.status).toBe("superseded");
      const restored = await kit.runtime.restoreSuperseded(ctx, { supersededById: y });
      expect(restored.outcomes.map((o) => o.kind)).toEqual(["restored"]);
      expect((await kit.memoryStore.get(ctx, x))!.status).toBe("active");
      next.content = "猫が3匹いる";
      const replaced = await kit.runtime.reextract(ctx, first.observationId);
      expect(replaced.supersededMemoryIds).toEqual([x]);
      const reasons = await supersededReasons(kit, x);
      expect(reasons).toHaveLength(2);
      expect(reasons[0]).toBe("contested_resolved");
      expect(reasons[1]).not.toBe("contested_resolved");

      next.content = "猫を3匹飼っている";
      const callsBefore = next.calls;
      const again = await kit.runtime.reextract(ctx, first.observationId);

      expect(next.calls - callsBefore).toBe(1);
      expect(again.extraction).toBe("ok");
    });

    it("退けた記憶が2件あれば、skipped は退けた記憶ごとに1件ずつ名乗る（先頭だけではない）", async () => {
      const next: Next = { content: "猫は3匹", calls: 0 };
      const kit = await makeKit(next);
      const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
      const x = first.memoryIds[0]!;
      next.content = "猫は白い";
      const second = await kit.runtime.reextract(ctx, first.observationId);
      const x2 = second.memoryIds[0]!;
      expect(x2).not.toBe(x);
      await kit.runtime.forget(ctx, { memoryIds: [x, x2] });

      next.content = "猫を飼っている";
      const callsBefore = next.calls;
      const result = await kit.runtime.reextract(ctx, first.observationId);

      expect(next.calls - callsBefore).toBe(0);
      expect(result.extraction).toBe("skipped");
      const named = result.skipped
        .filter((s) => s.kind === "status_not_active")
        .map((s) => (s as { memoryId: MemoryId }).memoryId)
        .sort();
      expect(named).toEqual([x, x2].sort());
    });
  });
}
