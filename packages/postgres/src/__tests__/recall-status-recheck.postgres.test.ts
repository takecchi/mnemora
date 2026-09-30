import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, Runtime, VectorStore } from "@mnemora/core";
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
 * ADR 0432 AL-1: recall の段1の後置の再検査・連想枠が `status ∈ {active, contested}` を見る歯を、
 * 両 adapter（testkit の InMemory と Postgres）で撃つ。`vectorStore.search` が返した直後に
 * `sweepArchive` / `forget` を割り込ませると、`VectorFilter.status`（検索の時点でしか効かない）を
 * すり抜けた archived / forgotten の記憶が `memories` に入っていた。core の fake 版は
 * `packages/core/src/__tests__/recall-status-recheck.test.ts`。
 */

const NOW = new Date("2026-09-27T00:00:00.000Z");
const ctx: Ctx = { tenantId: "recall-status-recheck" };
const ANCHOR = [0.70710678, 0.70710678, 0];
const ASSOCIATED = [0, 1, 0];

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
}

const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async () => {
      throw new Error("not used");
    },
  },
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  clock: { now: () => NOW },
};

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const vectorStore = new InMemoryVectorStore(memoryStore);
      return {
        memoryStore,
        vectorStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
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
      const vectorStore = new PostgresVectorStore(db);
      return {
        memoryStore,
        vectorStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore: new PostgresEventStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
          outboxStore: new PostgresOutboxStore(db),
        }),
      };
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

async function seed(kit: Kit, contentHash: string, vector: number[], decayed: boolean) {
  const memory = await kit.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash,
      embeddingStatus: "ready",
      // 新しく強い記憶にして、score を閾値の上に置く。sweep の対象にするか否かは decayFloorAt だけで
      // 決める（沈ませる側は 1 秒前、沈ませない側は遠い未来）。
      recordedAt: NOW,
      strength: 1,
      halfLifeHours: 24 * 365 * 10,
      decayFloorAt: decayed ? new Date(NOW.getTime() - 1_000) : new Date(NOW.getTime() + 1e12),
    }),
  );
  await kit.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
  return memory;
}

function interposeAfterSearch(kit: Kit, n: number, hook: () => Promise<unknown>): void {
  const original = kit.vectorStore.search.bind(kit.vectorStore);
  let calls = 0;
  kit.vectorStore.search = async (c, space, query, opts) => {
    const hits = await original(c, space, query, opts);
    calls += 1;
    if (calls === n) await hook();
    return hits;
  };
}

/**
 * 連想枠の `search` は、`searchMany` を実装した adapter（両 adapter とも実装している）では
 * `searchMany` 1回に束ねられる。その1回が返った直後に `hook` を走らせる。
 */
function interposeAfterSearchMany(kit: Kit, hook: () => Promise<unknown>): void {
  const original = kit.vectorStore.searchMany!.bind(kit.vectorStore);
  let fired = false;
  kit.vectorStore.searchMany = async (c, space, queries, opts) => {
    const hits = await original(c, space, queries, opts);
    if (!fired) {
      fired = true;
      await hook();
    }
    return hits;
  };
}

const QUERY = { vector: [1, 0, 0], limit: 10, includeFullyDecayed: true } as const;
const ASSOCIATION = { maxCount: 5, anchorCount: 1 } as const;

for (const [name, makeKit] of KITS) {
  describe(`${name}: recall の status 再検査（ADR 0432 AL-1）`, () => {
    it("段1: search のあとの sweepArchive で archived になった記憶は memories に入らず、filtered(archived) が1件だけ出る", async () => {
      const kit = await makeKit();
      const m = await seed(kit, "stage1", [1, 0, 0], true);
      interposeAfterSearch(kit, 1, () => kit.runtime.sweepArchive(ctx, { now: NOW, limit: 10 }));

      const result = await kit.runtime.recall(ctx, QUERY);

      expect((await kit.memoryStore.get(ctx, m.id))?.status).toBe("archived");
      expect(result.memories.map((x) => x.memoryId)).not.toContain(m.id);
      expect(
        result.omitted.filter((o) => o.kind === "filtered" && o.condition === "archived"),
      ).toEqual([
        {
          kind: "filtered",
          condition: "archived",
          scopeRelation: "outside_scope",
          count: 1,
          countKind: "exact",
        },
      ]);
    });

    it("段1: search のあとの forget で forgotten になった記憶は memories に入らない", async () => {
      const kit = await makeKit();
      const m = await seed(kit, "stage1-forget", [1, 0, 0], false);
      interposeAfterSearch(kit, 1, () => kit.runtime.forget(ctx, { memoryId: m.id }));

      const result = await kit.runtime.recall(ctx, QUERY);

      expect((await kit.memoryStore.get(ctx, m.id))?.status).toBe("forgotten");
      expect(result.memories.map((x) => x.memoryId)).not.toContain(m.id);
    });

    it("対照: 割り込ませなければ、同じ配置で連想枠から返る（歯が「連想が常に空」で通っていないことの検算）", async () => {
      const kit = await makeKit();
      await seed(kit, "anchor-c", ANCHOR, false);
      const associated = await seed(kit, "associated-c", ASSOCIATED, true);

      const result = await kit.runtime.recall(ctx, { ...QUERY, association: ASSOCIATION });

      expect(result.memories.find((x) => x.memoryId === associated.id)?.retrievedVia).toBe(
        "association",
      );
    });

    it("連想枠: 連想用 searchMany のあとの sweepArchive で archived になった記憶は入らない（対照: アンカーは返る）", async () => {
      const kit = await makeKit();
      const anchor = await seed(kit, "anchor", ANCHOR, false);
      const associated = await seed(kit, "associated", ASSOCIATED, true);
      interposeAfterSearchMany(kit, () => kit.runtime.sweepArchive(ctx, { now: NOW, limit: 10 }));

      const result = await kit.runtime.recall(ctx, { ...QUERY, association: ASSOCIATION });

      expect((await kit.memoryStore.get(ctx, associated.id))?.status).toBe("archived");
      const ids = result.memories.map((x) => x.memoryId);
      expect(ids).toContain(anchor.id);
      expect(ids).not.toContain(associated.id);
    });

    it("連想枠: 連想用 search のあとの forget で forgotten になった記憶は入らない", async () => {
      const kit = await makeKit();
      await seed(kit, "anchor-f", ANCHOR, false);
      const associated = await seed(kit, "associated-f", ASSOCIATED, false);
      interposeAfterSearchMany(kit, () => kit.runtime.forget(ctx, { memoryId: associated.id }));

      const result = await kit.runtime.recall(ctx, { ...QUERY, association: ASSOCIATION });

      expect(result.memories.map((x) => x.memoryId)).not.toContain(associated.id);
    });
  });
}
