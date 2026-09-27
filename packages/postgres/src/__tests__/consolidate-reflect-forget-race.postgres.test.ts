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

/**
 * `consolidate`・`reflect` の LLM を待つ間に、eligible の1件が `forget`（と `purge`）されたときの今の振る舞いを
 * 縛る（Issue #1226。`Runtime.consolidate`・`Runtime.reflect` の doc の 2026-09-27 追記）。振る舞いは変えていない。
 *
 * 書き込みの前に eligible を見直さないので、新しい Memory は忘れさせた（消した）記憶の本文から作られ、
 * `active` で書かれる。`provenance.sources` にもその id が残る（#882）。Postgres と testkit の fixture で同じ。
 */

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
  describe(`${name}: LLM を待つ間に元の記憶を forget・purge したとき（今の振る舞い）`, () => {
    for (const withPurge of [false, true]) {
      const label = withPurge ? "forget と purge" : "forget";

      it(`consolidate の途中で A を ${label} しても、統合先は active で書かれ、sources に A が残る`, async () => {
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

        expect(result.outcome).toBe("consolidated");
        expect(result.sources.map((s) => s.kind)).toEqual([
          "status_changed_concurrently",
          "superseded",
        ]);
        const consolidated = await kit.memoryStore.get(ctx, result.consolidatedMemoryId!);
        expect(consolidated?.status).toBe("active");
        expect(consolidated?.provenance).toMatchObject({ sources: expect.arrayContaining([a.id]) });
        expect((await kit.memoryStore.get(ctx, a.id))?.status).toBe("forgotten");
      });

      it(`reflect の途中で A を ${label} しても、内省の Memory は active で書かれ、根拠に A が残る`, async () => {
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

        expect(result.outcome).toBe("reflected");
        const reflected = await kit.memoryStore.get(ctx, result.reflectedMemoryId!);
        expect(reflected?.status).toBe("active");
        expect(reflected?.provenance).toMatchObject({ sources: expect.arrayContaining([a.id]) });
      });
    }
  });
}
