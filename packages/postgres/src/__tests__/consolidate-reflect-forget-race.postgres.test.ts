import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
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

let release: () => void = () => {};
let reached: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
let lastRequest = "";
function holdNextCall(): { stopped: Promise<void>; resume: () => void } {
  gate = new Promise((resolve) => (release = resolve));
  const stopped = new Promise<void>((resolve) => (reached = resolve));
  return { stopped, resume: () => release() };
}

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    lastRequest = JSON.stringify(req);
    reached();
    await gate;
    const reflected = req.schema.safeParse({
      outcome: "reflected",
      content: "内省",
      digest: "内省",
    });
    return reflected.success
      ? reflected.data
      : req.schema.parse({ content: "統合", digest: "統合" });
  },
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
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore: new InMemoryVectorStore(memoryStore),
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
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
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore: new PostgresVectorStore(db),
          eventStore: new PostgresEventStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "consolidate-reflect-forget-race" };
let seq = 0;

async function createActive(kit: Kit, content: string) {
  seq += 1;
  return kit.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `race-${seq}`,
      content,
      digest: content,
    }),
  );
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: LLM を待つ間に元の記憶を forget・purge したとき（打ち切る、Issue #1226 の修正後）`, () => {
    for (const withPurge of [false, true]) {
      const label = withPurge ? "forget と purge" : "forget";

      it(`consolidate の途中で A を ${label} しても、統合先は作られず、A は forgotten_before_write、B は not_attempted になる`, async () => {
        const kit = await makeKit();
        const a = await createActive(kit, "A の秘密");
        const b = await createActive(kit, "B の話");
        const hold = holdNextCall();
        const pending = kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
        await hold.stopped;
        expect(lastRequest).toContain("A の秘密");
        expect((await kit.runtime.forget(ctx, { memoryId: a.id })).outcomes[0]?.kind).toBe(
          "forgotten",
        );
        if (withPurge) {
          expect((await kit.runtime.purge(ctx, { memoryId: a.id })).outcomes[0]?.kind).toBe(
            "purged",
          );
        }
        hold.resume();
        const result = await pending;

        expect(result.outcome).toBe("aborted_source_forgotten");
        expect(result.atomicity).toBe("not_attempted");
        expect(result.consolidatedMemoryId).toBeNull();
        expect(result.llmCalls).toBe(1);
        expect(result.sources.map((s) => ({ memoryId: s.memoryId, kind: s.kind }))).toEqual([
          { memoryId: a.id, kind: "forgotten_before_write" },
          { memoryId: b.id, kind: "not_attempted" },
        ]);

        const stillA = await kit.memoryStore.get(ctx, a.id);
        expect(stillA?.status).toBe("forgotten");
        expect(stillA?.purgedAt !== null).toBe(withPurge);
        const stillB = await kit.memoryStore.get(ctx, b.id);
        expect(stillB?.status).toBe("active");
        expect(stillB?.supersededById).toBeNull();
      });

      it(`reflect の途中で A を ${label} しても、内省の Memory は作られず、A は forgotten_before_write、B は eligible になる`, async () => {
        const kit = await makeKit();
        const a = await createActive(kit, "A の秘密");
        const b = await createActive(kit, "B の話");
        const hold = holdNextCall();
        const pending = kit.runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
        await hold.stopped;
        expect(lastRequest).toContain("A の秘密");
        await kit.runtime.forget(ctx, { memoryId: a.id });
        if (withPurge) await kit.runtime.purge(ctx, { memoryId: a.id });
        hold.resume();
        const result = await pending;

        expect(result.outcome).toBe("aborted_source_forgotten");
        expect(result.reflectedMemoryId).toBeNull();
        expect(result.llmCalls).toBe(1);
        expect(result.basis.map((s) => ({ memoryId: s.memoryId, kind: s.kind }))).toEqual([
          { memoryId: a.id, kind: "forgotten_before_write" },
          { memoryId: b.id, kind: "eligible" },
        ]);

        const stillB = await kit.memoryStore.get(ctx, b.id);
        expect(stillB?.status).toBe("active");
      });
    }
  });
}
