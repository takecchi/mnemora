import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, LLMProvider, MemoryId, MemoryStore, Runtime } from "@mnemora/core";
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

/**
 * 1件目を書いた直後を門で止め、止めている間に forget → purge してから門を外す。監査ログには `forgotten`・`purged` の後に `created` が積まれ、戻り値の `memoryIds` にも purge した id が入る。
 * ⚠ この形は `createMemoriesWithOutboxAndEvents`（全候補と `created` を1トランザクションで書く任意メソッド）を持たない adapter の振る舞いである。2つの store はどちらもその口を持ち、持つ store では
 * 書いた記憶は `created` と一緒にコミットされるまでほかから見えないので、この窓が無い。この歯は今の経路の振る舞いを縛り続けるため、store の口を外して（持たない adapter のふり）走らせる。
 */

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({
      memories: [
        { content: "1件目の事実", provenanceKind: "stated" },
        { content: "2件目の事実", provenanceKind: "stated" },
      ],
    }),
};

const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        eventStore,
        runtime: createRuntime({
          ...shared,
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
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const eventStore = new PostgresEventStore(db);
      return {
        memoryStore,
        eventStore,
        runtime: createRuntime({
          ...shared,
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

const ctx: Ctx = { tenantId: "observe-created-event-after-purge" };

/** `memoryStore.createMemoryWithOutbox` の最初の1回を、返った直後で止める。 */
function holdAfterFirstCreate(memoryStore: MemoryStore): {
  stopped: Promise<MemoryId>;
  resume: () => void;
} {
  const original = memoryStore.createMemoryWithOutbox.bind(memoryStore);
  let release: () => void = () => {};
  let reached: (id: MemoryId) => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stopped = new Promise<MemoryId>((resolve) => (reached = resolve));
  memoryStore.createMemoryWithOutbox = async (c, newMemory, kinds) => {
    const result = await original(c, newMemory, kinds);
    memoryStore.createMemoryWithOutbox = original;
    reached(result.memory.id);
    await gate;
    return result;
  };
  return { stopped, resume: () => release() };
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: observe の書き込みの途中で、書いた1件を forget・purge したとき（今の振る舞い）`, () => {
    it("監査ログには purged の後に created が積まれ、戻り値の memoryIds にも purge した id が入る", async () => {
      const kit = await makeKit();
      // 口を持たない adapter のふり。runtime は口が無ければ、候補ごとの `createMemoryWithOutbox` の経路を使う。
      kit.memoryStore.createMemoriesWithOutboxAndEvents = undefined;
      const hold = holdAfterFirstCreate(kit.memoryStore);
      const pending = kit.runtime.observe(ctx, { kind: "utterance", text: "二つの事実" });
      const firstId = await hold.stopped;
      expect((await kit.runtime.forget(ctx, { memoryId: firstId })).outcomes[0]?.kind).toBe(
        "forgotten",
      );
      expect((await kit.runtime.purge(ctx, { memoryId: firstId })).outcomes[0]?.kind).toBe(
        "purged",
      );
      hold.resume();
      const result = await pending;

      expect(result.extraction).toBe("ok");
      expect(result.memoryIds).toHaveLength(2);
      expect(result.memoryIds).toContain(firstId);
      const first = await kit.memoryStore.get(ctx, firstId);
      expect(first?.status).toBe("forgotten");
      expect(first?.purgedAt).not.toBeNull();

      const events = await kit.eventStore.list(ctx, { memoryId: firstId });
      expect(events.map((e) => e.kind).sort()).toEqual(["created", "forgotten", "purged"]);
      const at = (kind: string) => events.find((e) => e.kind === kind)!.at.getTime();
      expect(at("purged")).toBeGreaterThanOrEqual(at("forgotten"));
      expect(at("created")).toBeGreaterThanOrEqual(at("purged"));
      expect(events.find((e) => e.kind === "created")!.digestSnapshot).not.toBe(first?.digest);
    });
  });
}
