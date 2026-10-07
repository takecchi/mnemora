import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type {
  Ctx,
  EventStore,
  MemoryId,
  MemoryStore,
  NewMemory,
  Runtime,
  StructuredRequest,
  VectorStore,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  TEST_EMBEDDING_SPACE,
  closeTestClient,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
  eventStore: EventStore;
  jobKindsOf: (tenantId: string, memoryId: MemoryId) => Promise<string[]>;
}

const ctxA: Ctx = { tenantId: "seed-jobs-tenant-a" };
const ctxB: Ctx = { tenantId: "seed-jobs-tenant-b" };

const llm = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx: Ctx, req: StructuredRequest<unknown>) => {
    for (const value of [
      { memories: [{ content: "抽出された事実", digest: "要旨", provenanceKind: "stated" }] },
      { outcome: "reflected", content: "内省の本文" },
      { content: "統合後の本文" },
    ]) {
      const parsed = req.schema.safeParse(value);
      if (parsed.success) return parsed.data as never;
    }
    throw new Error("unexpected schema");
  },
};

const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  config: { autoQueueConsolidateReflectOnExtract: true },
};

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const vectorStore = new InMemoryVectorStore(memoryStore);
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        vectorStore,
        eventStore,
        jobKindsOf: async (tenantId, memoryId) =>
          memoryStore.outboxJobs
            .filter((job) => job.tenantId === tenantId && job.payload.memoryId === memoryId)
            .map((job) => job.kind)
            .sort(),
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore,
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        } as never),
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
      const eventStore = new PostgresEventStore(db);
      return {
        memoryStore,
        vectorStore,
        eventStore,
        jobKindsOf: async (tenantId, memoryId) => {
          const result = await db.execute(sql`
            SELECT kind FROM outbox
            WHERE tenant_id = ${tenantId} AND payload->>'memoryId' = ${memoryId}
            ORDER BY kind
          `);
          return result.rows.map((row) => (row as { kind: string }).kind);
        },
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore,
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        } as never),
      };
    },
  ],
];

let seq = 0;

async function add(kit: Kit, ctx: Ctx, overrides: Partial<NewMemory> = {}): Promise<MemoryId> {
  seq += 1;
  const memory = await kit.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `seed-jobs-${seq}`,
      content: `本文 ${seq}`,
      digest: `要旨 ${seq}`,
      embeddingStatus: "ready",
      recordedAt: new Date(),
      decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
      ...overrides,
    }),
  );
  await kit.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, [1, 0, 0]);
  return memory.id;
}

afterAll(async () => {
  await closeTestClient();
});

for (const [kitName, makeKit] of KITS) {
  describe(kitName, () => {
    it("autoQueueConsolidateReflectOnExtract: 抽出した記憶には embed・consolidate・reflect のジョブが積まれ、consolidate・reflect が作った記憶には embed だけが積まれる", async () => {
      const kit = await makeKit();
      const observed = await kit.runtime.observe(ctxA, { kind: "utterance", text: "発話" });
      const seedId = observed.memoryIds[0]!;
      await add(kit, ctxA);
      expect(await kit.jobKindsOf(ctxA.tenantId, seedId)).toEqual([
        "consolidate",
        "embed",
        "reflect",
      ]);

      const reflectTick = await kit.runtime.tick(ctxA, { kinds: ["reflect"], leaseMs: 60_000 });
      const consolidateTick = await kit.runtime.tick(ctxA, {
        kinds: ["consolidate"],
        leaseMs: 60_000,
      });
      expect(reflectTick.processed).toBe(1);
      expect(consolidateTick.processed).toBe(1);

      const derivedIds = (await kit.eventStore.list(ctxA, {}))
        .filter((e) => e.kind === "created" && e.memoryId !== seedId)
        .map((e) => e.memoryId!);
      expect(derivedIds).toHaveLength(2);
      for (const derivedId of derivedIds) {
        expect(await kit.jobKindsOf(ctxA.tenantId, derivedId)).toEqual(["embed"]);
      }
    });

    it("同じ記憶をもう一度書いても、consolidate・reflect のジョブは増えない", async () => {
      const kit = await makeKit();
      const jobKinds = ["embed", "consolidate", "reflect"];
      const { observation } = await kit.memoryStore.createObservationWithOutbox(
        ctxA,
        {
          tenantId: ctxA.tenantId,
          subjectId: null,
          externalId: null,
          kind: "utterance",
          payload: {},
        },
        [],
      );
      const input = buildNewMemoryFixture({
        tenantId: ctxA.tenantId,
        sourceObservationId: observation.id,
        extractorVersion: "v1",
        contentHash: "seed-jobs-resend",
        embeddingStatus: "pending",
      });
      const first = await kit.memoryStore.createMemoriesWithOutboxAndEvents!(
        ctxA,
        [{ input, jobKinds }],
        () => ({
          tenantId: ctxA.tenantId,
          memoryId: null,
          kind: "created",
          actor: { type: "system" },
          digestSnapshot: null,
          sizeBeforeBytes: null,
          meta: {},
        }),
      );
      const memoryId = first.written[0]!.memory.id;
      const again = await kit.memoryStore.createMemoriesWithOutboxAndEvents!(
        ctxA,
        [{ input, jobKinds }],
        () => ({
          tenantId: ctxA.tenantId,
          memoryId,
          kind: "created",
          actor: { type: "system" },
          digestSnapshot: null,
          sizeBeforeBytes: null,
          meta: {},
        }),
      );
      const single = await kit.memoryStore.createMemoryWithOutbox(ctxA, input, jobKinds);

      expect(again.written[0]!.created).toBe(false);
      expect(single.created).toBe(false);
      expect(await kit.jobKindsOf(ctxA.tenantId, memoryId)).toEqual([
        "consolidate",
        "embed",
        "reflect",
      ]);
    });

    it.each(["consolidate", "reflect"] as const)(
      "%s({ seedMemoryId }) は他のテナントの記憶を近傍に入れず、他のテナントの種は見つからない",
      async (operation) => {
        const kit = await makeKit();
        const seedA = await add(kit, ctxA, { digest: "同じ要旨" });
        const neighborA = await add(kit, ctxA, { digest: "同じ要旨" });
        const foreignB = await add(kit, ctxB, { digest: "同じ要旨" });
        const call = (ctx: Ctx) =>
          operation === "consolidate"
            ? kit.runtime
                .consolidate(ctx, { target: { seedMemoryId: seedA }, dryRun: true })
                .then((r) => r.sources)
            : kit.runtime
                .reflect(ctx, { target: { seedMemoryId: seedA }, dryRun: true })
                .then((r) => r.basis);

        expect(await call(ctxA)).toEqual([
          { memoryId: seedA, kind: "eligible" },
          { memoryId: neighborA, kind: "eligible" },
        ]);
        expect(await call(ctxB)).toEqual([{ memoryId: seedA, kind: "not_found" }]);
        expect((await kit.memoryStore.get(ctxB, foreignB))?.status).toBe("active");
      },
    );
  });
}
