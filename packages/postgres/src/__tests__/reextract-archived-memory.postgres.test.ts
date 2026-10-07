import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
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
 * `archived` の記憶を持つ Observation を `reextract` したときの帰結を、今の振る舞いとして縛る（`archived` は退けた記憶に数えない）。
 *
 * - 抽出結果が今の記憶と同じ内容なら、何も起きない（新しい記憶は作られず、記憶は `archived` のまま。
 *   `memoryIds` は既存の記憶そのものを指す。`skipped` に `status_not_active`、`status: "archived"`）。
 * - 内容が違えば新しい版が `active` で作られる。古い `archived` は `superseded` にならず `archived` のまま残り、
 *   それを `restoreArchived` で戻すと、新旧の2件が `active` で並ぶ。
 *
 * Postgres と testkit の fixture で同じ。
 */

type Next = { content: string };

function shared(next: Next) {
  const llmProvider: LLMProvider = {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_ctx, req) => {
      const extracted = req.schema.safeParse({
        memories: [{ content: next.content, provenanceKind: "stated" }],
      });
      return extracted.success ? extracted.data : req.schema.parse({ content: next.content });
    },
  };
  return {
    llmProvider,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  };
}

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
}

const KITS: Array<[string, (next: Next) => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async (next) => {
      const memoryStore = new InMemoryMemoryStore();
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared(next),
          memoryStore,
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
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
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared(next),
          memoryStore,
          eventStore: new PostgresEventStore(db),
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "reextract-archived" };
const ORIGINAL = "猫は3匹";
const REPHRASED = "猫を3匹飼っている";
const FAR_FUTURE = new Date("2100-01-01T00:00:00.000Z");

afterAll(async () => {
  await closeTestClient();
});

async function observeAndArchive(makeKit: (next: Next) => Promise<Kit>) {
  const next: Next = { content: ORIGINAL };
  const kit = await makeKit(next);
  const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
  const x = first.memoryIds[0]!;
  const swept = await kit.runtime.sweepArchive(ctx, { now: FAR_FUTURE, limit: 10 });
  expect(swept).toMatchObject({ supported: true });
  expect((await kit.memoryStore.get(ctx, x))?.status).toBe("archived");
  return { kit, next, first, x };
}

for (const [name, makeKit] of KITS) {
  describe(`${name}: archived の記憶を持つ Observation の reextract（ADR 0432 AL-5）`, () => {
    it("内容が同じなら何も起きず、記憶は archived のまま（skipped に status_not_active）", async () => {
      const { kit, first, x } = await observeAndArchive(makeKit);

      const result = await kit.runtime.reextract(ctx, first.observationId);

      expect(result.memoryIds).toEqual([x]);
      expect(result.supersededMemoryIds).toEqual([]);
      expect(
        await kit.memoryStore.listBySourceObservationAllVersions(ctx, first.observationId),
      ).toHaveLength(1);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ kind: "status_not_active", memoryId: x, status: "archived" }),
      );
      expect((await kit.memoryStore.get(ctx, x))?.status).toBe("archived");
    });

    it("内容が違えば新しい版が作られ、古い版は archived のまま。restoreArchived で戻すと新旧が並ぶ", async () => {
      const { kit, next, first, x } = await observeAndArchive(makeKit);
      next.content = REPHRASED;

      const result = await kit.runtime.reextract(ctx, first.observationId);

      expect(result.memoryIds).toHaveLength(1);
      const y = result.memoryIds[0]!;
      expect(result.supersededMemoryIds).toEqual([]);
      expect((await kit.memoryStore.get(ctx, y))?.status).toBe("active");
      expect((await kit.memoryStore.get(ctx, x))?.status).toBe("archived");

      const restored = await kit.runtime.restoreArchived(ctx, { memoryId: x });
      expect(restored.outcomes[0]?.kind).toBe("restored");
      expect((await kit.memoryStore.get(ctx, x))?.status).toBe("active");
      expect((await kit.memoryStore.get(ctx, y))?.status).toBe("active");
    });
  });
}
