import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  EventStore,
  LLMProvider,
  MemoryStore,
  OutboxStore,
  Runtime,
} from "@mnemora/core";
import {
  ConsolidationLLMResultSchema,
  ReflectionLLMResultSchema,
  createRuntime,
} from "@mnemora/core";
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
 * tick のジョブが「書いた後・`complete` の前」に落ち、リースが切れた後に1回だけ**逐次に**
 * 再配達されたときの今の振る舞いを、Postgres と testkit の fixture の両方で縛る
 * （`Runtime.reflect` の doc の 2026-09-27 追記）。並行の2本（#1092）は扱わない。
 *
 * - `embed`・`consolidate`: 1回だけ処理したときと同じ状態になる（consolidate は ADR 0089 の
 *   「読んで status で弾く」が効く）。
 * - `reflect`: 内省の Memory が2件になる（ADR 0091 決定11「冪等性は買わない」の帰結）。
 * - `extract`（Issue #1092。`OutboxStore` の doc の 2026-09-28 追記）: LLM が2回とも同じ本文を返せば1件のまま
 *   （冪等の鍵で同じ行に当たる）。違う本文を返すと2件とも `active` で残る。1回目の LLM が落ちて全文
 *   フォールバックになり、2回目が成功すると、フォールバックの Memory と候補の2件が `active` で残る。
 *
 * 「書いた後・`complete` の前に落ちる」は、`complete`・`fail` がどちらも（リース競合ではない）
 * 例外で落ちる outbox で作る——`tick` は例外を投げて抜け、ジョブは claim されたまま残る。
 */

let nowMs = 0;
const clock = { now: () => new Date(nowMs) };
let llmCall = 0;
/** extract の LLM が順に返す本文。`null` は LLM の失敗（全文フォールバックへ倒れる）。 */
let extractOutputs: Array<string | null> = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "" }),
  completeStructured: async (_ctx, req) => {
    llmCall += 1;
    const schema = req.schema as unknown;
    if (schema === ConsolidationLLMResultSchema) {
      return req.schema.parse({ content: `統合 ${llmCall}` });
    }
    if (schema === ReflectionLLMResultSchema) {
      return req.schema.parse({ outcome: "reflected", content: `内省 ${llmCall}` });
    }
    const next = extractOutputs.shift();
    if (next === null) throw new Error("LLM が落ちた");
    if (next !== undefined) {
      return req.schema.parse({ memories: [{ content: next, provenanceKind: "stated" }] });
    }
    throw new Error("unexpected schema");
  },
};

function crashable(inner: OutboxStore): { store: OutboxStore; state: { crash: boolean } } {
  const state = { crash: false };
  return {
    state,
    store: {
      claimBatch: (ctx, opts) => inner.claimBatch(ctx, opts),
      complete: async (ctx, id, attempts) => {
        if (state.crash) throw new Error("ワーカーが止まった（complete の前）");
        return inner.complete(ctx, id, attempts);
      },
      fail: async (ctx, id, error, attempts) => {
        if (state.crash) throw new Error("ワーカーが止まった（fail の前）");
        return inner.fail(ctx, id, error, attempts);
      },
    },
  };
}

const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  clock,
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
  crash: { crash: boolean };
  upsertVector: (ctx: Ctx, memoryId: string) => Promise<void>;
  countVectors: (ctx: Ctx, memoryIds: string[]) => Promise<number>;
  listMemories: (
    ctx: Ctx,
  ) => Promise<Array<{ status: string; provenanceKind: string; embeddingStatus: string }>>;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const { store, state } = crashable(new InMemoryOutboxStore(memoryStore.outboxJobs));
      const vectorStore = new InMemoryVectorStore(memoryStore);
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        eventStore,
        crash: state,
        upsertVector: (ctx, id) => vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, [1, 0, 0]),
        countVectors: async (ctx, ids) =>
          (await vectorStore.getVectors(ctx, TEST_EMBEDDING_SPACE, ids)).length,
        listMemories: async (ctx) =>
          memoryStore.listByTenant(ctx).map((m) => ({
            status: m.status,
            provenanceKind: m.provenance.kind,
            embeddingStatus: m.embeddingStatus,
          })),
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore,
          outboxStore: store,
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db, pool } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const { store, state } = crashable(new PostgresOutboxStore(db));
      const vectorStore = new PostgresVectorStore(db);
      const eventStore = new PostgresEventStore(db);
      return {
        memoryStore,
        eventStore,
        crash: state,
        upsertVector: (ctx, id) => vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, [1, 0, 0]),
        countVectors: async (ctx, ids) =>
          (await vectorStore.getVectors!(ctx, TEST_EMBEDDING_SPACE, ids)).length,
        listMemories: async (ctx) =>
          (
            await pool.query(
              "SELECT status, provenance->>'kind' AS pk, embedding_status FROM memories WHERE tenant_id = $1",
              [ctx.tenantId],
            )
          ).rows.map((r) => ({
            status: r.status,
            provenanceKind: r.pk,
            embeddingStatus: r.embedding_status,
          })),
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore,
          outboxStore: store,
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "tick-sequential-redelivery" };
const LEASE_MS = 60_000;

/** 種と近傍（同じベクトル）を作り、種に `jobKind` のジョブを積む。 */
async function seedWithNeighbor(kit: Kit, jobKind: "consolidate" | "reflect") {
  const recent = {
    recordedAt: new Date(nowMs),
    halfLifeHours: 1e6,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "ready" as const,
  };
  const neighbor = await kit.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      content: "近傍",
      contentHash: "neighbor",
      ...recent,
    }),
  );
  await kit.upsertVector(ctx, neighbor.id);
  const { memory: seed } = await kit.memoryStore.createMemoryWithOutbox(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      content: "種",
      contentHash: "seed",
      ...recent,
    }),
    [jobKind],
  );
  await kit.upsertVector(ctx, seed.id);
  return { seedId: seed.id, neighborId: neighbor.id };
}

/** 1回目の tick を「書いた後・complete の前」に落とし、リースを切らして2回目の tick で再配達する。 */
async function crashThenRedeliver(
  kit: Kit,
  kinds: Array<"embed" | "consolidate" | "reflect" | "extract">,
) {
  kit.crash.crash = true;
  await expect(kit.runtime.tick(ctx, { kinds, leaseMs: LEASE_MS })).rejects.toThrow(
    /ワーカーが止まった/,
  );
  kit.crash.crash = false;
  nowMs += LEASE_MS * 2;
  const redelivered = await kit.runtime.tick(ctx, { kinds, leaseMs: LEASE_MS });
  expect(redelivered.processed).toBe(1);
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: tick のジョブの逐次の再配達（今の振る舞い）`, () => {
    it("embed: 再配達の後も、ベクトルは1行・Memory は ready（1回だけ処理したときと同じ）", async () => {
      nowMs = Date.parse("2030-01-01T00:00:00.000Z");
      const kit = await makeKit();
      const { memory } = await kit.memoryStore.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, content: "埋め込む", contentHash: "emb" }),
        ["embed"],
      );
      nowMs += 1000;
      await crashThenRedeliver(kit, ["embed"]);
      expect((await kit.memoryStore.get(ctx, memory.id))?.embeddingStatus).toBe("ready");
      expect(await kit.countVectors(ctx, [memory.id])).toBe(1);
    });

    it("consolidate: 再配達の後も、統合先は1件・元2件は superseded（1回だけ処理したときと同じ）", async () => {
      nowMs = Date.parse("2030-01-01T00:00:00.000Z");
      const kit = await makeKit();
      await seedWithNeighbor(kit, "consolidate");
      nowMs += 1000;
      await crashThenRedeliver(kit, ["consolidate"]);
      const memories = await kit.listMemories(ctx);
      expect(memories.filter((m) => m.provenanceKind === "consolidated")).toHaveLength(1);
      expect(memories.filter((m) => m.status === "superseded")).toHaveLength(2);
      expect(await kit.eventStore.list(ctx, { kind: "created" })).toHaveLength(1);
    });

    it("reflect: 再配達で、内省の Memory が2件になる（ADR 0091 決定11 の帰結）", async () => {
      nowMs = Date.parse("2030-01-01T00:00:00.000Z");
      const kit = await makeKit();
      await seedWithNeighbor(kit, "reflect");
      nowMs += 1000;
      await crashThenRedeliver(kit, ["reflect"]);
      const memories = await kit.listMemories(ctx);
      expect(memories.filter((m) => m.provenanceKind === "reflected")).toHaveLength(2);
      expect(await kit.eventStore.list(ctx, { kind: "created" })).toHaveLength(2);
    });

    for (const [label, outputs, expectedActive] of [
      ["同じ本文（A → A）: 1件のまま", ["候補A", "候補A"], 1],
      ["違う本文（A → B）: 2件とも active で残る", ["候補A", "候補B"], 2],
      ["LLM の失敗 → A: 全文フォールバックと候補の2件が active で残る", [null, "候補A"], 2],
    ] as const) {
      it(`extract: ${label}（#1092）`, async () => {
        nowMs = Date.parse("2030-01-01T00:00:00.000Z");
        const kit = await makeKit();
        extractOutputs = [...outputs];
        await kit.runtime.observe(ctx, { kind: "utterance", text: "発話", extract: "deferred" });
        nowMs += 1000;
        await crashThenRedeliver(kit, ["extract"]);
        expect(extractOutputs).toEqual([]);
        const memories = await kit.listMemories(ctx);
        expect(memories.filter((m) => m.status === "active")).toHaveLength(expectedActive);
        expect(memories).toHaveLength(expectedActive);
        expect(await kit.eventStore.list(ctx, { kind: "created" })).toHaveLength(expectedActive);
      });
    }
  });
}
