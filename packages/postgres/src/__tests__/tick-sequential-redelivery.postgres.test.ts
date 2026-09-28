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
 * - `extract`（Issue #1092。`OutboxStore` の doc）: 再配達された2回目は、その Observation から同じ抽出器の版で
 *   作られた Memory が既に在れば、LLM を呼ばずに何も書かない。⟹ LLM の出力が変わっても、1回目の分だけが残る
 *   （1回目が全文フォールバックなら、それが残る）。1回目が候補の一部だけを書いて止まった場合、残りは作られず、
 *   `reextract` で回復する。
 *
 * 「書いた後・`complete` の前に落ちる」は、`complete`・`fail` がどちらも（リース競合ではない）
 * 例外で落ちる outbox で作る——`tick` は例外を投げて抜け、ジョブは claim されたまま残る。
 */

let nowMs = 0;
const clock = { now: () => new Date(nowMs) };
let llmCall = 0;
/** extract の LLM が順に返す本文（配列なら候補を複数）。`null` は LLM の失敗（全文フォールバックへ倒れる）。 */
let extractOutputs: Array<string | readonly string[] | null> = [];
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
      const contents = typeof next === "string" ? [next] : next;
      return req.schema.parse({
        memories: contents.map((content) => ({ content, provenanceKind: "stated" })),
      });
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

/**
 * 候補を書いている途中でワーカーが止まる形を作る（候補の一部だけが書かれる）。`hangOnCreate` が n なら、
 * n 回目の `createMemoryWithOutbox` が決して返らない（プロセスが死んだのと同じ。例外にすると、止まったのではなく
 * 「保存できない候補」として落とされる）。止まった時点で `reached` が解決する。
 */
function hangableMemory(inner: MemoryStore): {
  store: MemoryStore;
  state: { hangOnCreate: number; reached: Promise<void> };
} {
  let signal = () => {};
  const state = {
    hangOnCreate: 0,
    reached: new Promise<void>((resolve) => {
      signal = resolve;
    }),
  };
  let seen = 0;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (prop !== "createMemoryWithOutbox") return value.bind(target);
      return (...args: Parameters<MemoryStore["createMemoryWithOutbox"]>) => {
        if (state.hangOnCreate > 0) {
          seen += 1;
          if (seen === state.hangOnCreate) {
            state.hangOnCreate = 0;
            signal();
            return new Promise(() => {});
          }
        }
        return (value as MemoryStore["createMemoryWithOutbox"]).apply(target, args);
      };
    },
  });
  return { store, state };
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
  memoryHang: { hangOnCreate: number; reached: Promise<void> };
  upsertVector: (ctx: Ctx, memoryId: string) => Promise<void>;
  countVectors: (ctx: Ctx, memoryIds: string[]) => Promise<number>;
  listMemories: (
    ctx: Ctx,
  ) => Promise<
    Array<{ status: string; provenanceKind: string; embeddingStatus: string; content: string }>
  >;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const hang = hangableMemory(memoryStore);
      const { store, state } = crashable(new InMemoryOutboxStore(memoryStore.outboxJobs));
      const vectorStore = new InMemoryVectorStore(memoryStore);
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        eventStore,
        crash: state,
        memoryHang: hang.state,
        upsertVector: (ctx, id) => vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, [1, 0, 0]),
        countVectors: async (ctx, ids) =>
          (await vectorStore.getVectors(ctx, TEST_EMBEDDING_SPACE, ids)).length,
        listMemories: async (ctx) =>
          memoryStore.listByTenant(ctx).map((m) => ({
            status: m.status,
            provenanceKind: m.provenance.kind,
            embeddingStatus: m.embeddingStatus,
            content: m.content,
          })),
        runtime: createRuntime({
          ...shared,
          memoryStore: hang.store,
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
      const hang = hangableMemory(memoryStore);
      const { store, state } = crashable(new PostgresOutboxStore(db));
      const vectorStore = new PostgresVectorStore(db);
      const eventStore = new PostgresEventStore(db);
      return {
        memoryStore,
        eventStore,
        crash: state,
        memoryHang: hang.state,
        upsertVector: (ctx, id) => vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, [1, 0, 0]),
        countVectors: async (ctx, ids) =>
          (await vectorStore.getVectors!(ctx, TEST_EMBEDDING_SPACE, ids)).length,
        listMemories: async (ctx) =>
          (
            await pool.query(
              "SELECT status, provenance->>'kind' AS pk, embedding_status, content FROM memories WHERE tenant_id = $1",
              [ctx.tenantId],
            )
          ).rows.map((r) => ({
            status: r.status,
            provenanceKind: r.pk,
            embeddingStatus: r.embedding_status,
            content: r.content,
          })),
        runtime: createRuntime({
          ...shared,
          memoryStore: hang.store,
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

    for (const [label, outputs, expectedContents] of [
      ["同じ本文（A → A）: 1件のまま", ["候補A", "候補A"], ["候補A"]],
      ["違う本文（A → B）: 2回目は書かず、1回目の A だけが残る", ["候補A", "候補B"], ["候補A"]],
      ["LLM の失敗 → A: 2回目は書かず、全文フォールバックだけが残る", [null, "候補A"], ["発話"]],
    ] as const) {
      it(`extract: ${label}（#1092）`, async () => {
        nowMs = Date.parse("2030-01-01T00:00:00.000Z");
        const kit = await makeKit();
        extractOutputs = [...outputs];
        await kit.runtime.observe(ctx, { kind: "utterance", text: "発話", extract: "deferred" });
        nowMs += 1000;
        await crashThenRedeliver(kit, ["extract"]);
        // 2回目は LLM を呼ばない（再配達のたびに課金しない）。
        expect(extractOutputs).toEqual([outputs[1]]);
        const memories = await kit.listMemories(ctx);
        expect(memories.filter((m) => m.status === "active").map((m) => m.content)).toEqual(
          expectedContents,
        );
        expect(memories).toHaveLength(expectedContents.length);
        expect(await kit.eventStore.list(ctx, { kind: "created" })).toHaveLength(
          expectedContents.length,
        );
      });
    }

    // ---- やりすぎを捕まえる歯（#1092 の判定が正当な抽出を塞がないこと） ----

    it("extract: 1回目の配達は、今どおり抽出して書く（#1092）", async () => {
      nowMs = Date.parse("2030-01-01T00:00:00.000Z");
      const kit = await makeKit();
      extractOutputs = [["候補A", "候補B"]];
      await kit.runtime.observe(ctx, { kind: "utterance", text: "発話", extract: "deferred" });
      nowMs += 1000;
      const result = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
      expect(result.processed).toBe(1);
      expect(extractOutputs).toEqual([]);
      expect((await kit.listMemories(ctx)).map((m) => m.content).sort()).toEqual([
        "候補A",
        "候補B",
      ]);
    });

    it("extract: 同じ Observation に旧い抽出器の版の Memory しか無ければ、今どおり抽出する（#1092・#873）", async () => {
      nowMs = Date.parse("2030-01-01T00:00:00.000Z");
      const kit = await makeKit();
      extractOutputs = ["候補A"];
      const { observationId } = await kit.runtime.observe(ctx, {
        kind: "utterance",
        text: "発話",
        extract: "deferred",
      });
      await kit.memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          content: "旧い版の記憶",
          contentHash: "old-version",
          sourceObservationId: observationId,
          extractorVersion: "v0",
        }),
      );
      nowMs += 1000;
      const result = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
      expect(result.processed).toBe(1);
      expect(extractOutputs).toEqual([]);
      expect((await kit.listMemories(ctx)).map((m) => m.content).sort()).toEqual([
        "候補A",
        "旧い版の記憶",
      ]);
    });

    it("extract: 再配達で書かれなかった候補は、reextract で回復する（全文フォールバック → A）", async () => {
      nowMs = Date.parse("2030-01-01T00:00:00.000Z");
      const kit = await makeKit();
      extractOutputs = [null, "候補A"];
      const { observationId } = await kit.runtime.observe(ctx, {
        kind: "utterance",
        text: "発話",
        extract: "deferred",
      });
      nowMs += 1000;
      await crashThenRedeliver(kit, ["extract"]);
      // deferred の抽出が済んだ Observation でも、reextract は塞がれずに抽出をやり直す。
      const reextracted = await kit.runtime.reextract(ctx, observationId);
      expect(reextracted.extraction).toBe("ok");
      expect(extractOutputs).toEqual([]);
      const memories = await kit.listMemories(ctx);
      expect(memories.filter((m) => m.status === "active").map((m) => m.content)).toEqual([
        "候補A",
      ]);
      expect(memories.filter((m) => m.status === "superseded").map((m) => m.content)).toEqual([
        "発話",
      ]);
    });

    it("extract: 1回目が候補の一部だけを書いて止まると、再配達は残りを書かず、reextract で回復する", async () => {
      nowMs = Date.parse("2030-01-01T00:00:00.000Z");
      const kit = await makeKit();
      extractOutputs = [["候補1", "候補2"], ["候補1", "候補2"]];
      const { observationId } = await kit.runtime.observe(ctx, {
        kind: "utterance",
        text: "発話",
        extract: "deferred",
      });
      nowMs += 1000;
      // 1件目の Memory を書いた後、2件目を書いている途中でワーカーが止まる（この tick は返らない）。
      kit.memoryHang.hangOnCreate = 2;
      void kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
      await kit.memoryHang.reached;
      nowMs += LEASE_MS * 2;
      const redelivered = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
      expect(redelivered.processed).toBe(1);
      expect((await kit.listMemories(ctx)).map((m) => m.content)).toEqual(["候補1"]);
      expect(extractOutputs).toEqual([["候補1", "候補2"]]);
      await kit.runtime.reextract(ctx, observationId);
      expect(extractOutputs).toEqual([]);
      const memories = await kit.listMemories(ctx);
      expect(
        memories
          .filter((m) => m.status === "active")
          .map((m) => m.content)
          .sort(),
      ).toEqual(["候補1", "候補2"]);
      expect(memories).toHaveLength(2);
    });
  });
}
