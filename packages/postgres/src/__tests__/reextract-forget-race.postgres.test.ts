import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
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
 * `reextract` の LLM を待つ間に、その Observation から出た記憶が `forget`（と `purge`）されたときの振る舞いを縛る。
 *
 * - `forget` は `forgotten` を返したのに、LLM が返った後で新しい記憶が `active` で書かれ、イベントが created → forgotten → created と積まれる、ということが起きてはならない。
 * - 打ち切ったとき、`reextract` は LLM を呼んだ後でも「退けた記憶を持つ Observation」の早期 return と同じ形（`status_not_active`・`extraction: "skipped"`・`atomicity: "not_attempted"`）で返す。
 * - `testkit` の `InMemoryMemoryStore` は `abortIfForgotten` を実装しない（runtime の読み直しだけが保護）。
 *   `PostgresMemoryStore` は実装する（書き込みと同一トランザクションの `SELECT … FOR UPDATE`）。両方に同じ入力を当てる。
 */

let release: () => void = () => {};
let reached: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
let holding = false;
let contents: string[] = [];
function holdNextCall(): { stopped: Promise<void>; resume: () => void } {
  holding = true;
  gate = new Promise((resolve) => (release = resolve));
  const stopped = new Promise<void>((resolve) => (reached = resolve));
  return { stopped, resume: () => release() };
}

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    if (holding) {
      holding = false;
      reached();
      await gate;
    }
    return req.schema.parse({
      memories: contents.map((content) => ({ content, provenanceKind: "stated" as const })),
    });
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
  eventStore: EventStore;
}

/**
 * `supersedeWithNewMemories` だけを隠した store。`reextract` の「口が無い adapter」向けの経路（`createMemoryWithOutbox` のループ）を通す。
 * それ以外は元の store にそのまま委ねる。
 */
function withoutSupersedePort(store: MemoryStore): MemoryStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "supersedeWithNewMemories") return undefined;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function makeInMemoryKit(hidePort: boolean): Promise<Kit> {
  const base = new InMemoryMemoryStore();
  const eventStore = new InMemoryEventStore(base, base.events);
  const memoryStore = hidePort ? withoutSupersedePort(base) : base;
  return {
    memoryStore,
    eventStore,
    runtime: createRuntime({
      ...shared,
      memoryStore,
      eventStore,
      vectorStore: new InMemoryVectorStore(base),
      outboxStore: new InMemoryOutboxStore(base.outboxJobs),
      tenantSettingsStore: new InMemoryTenantSettingsStore(base.activitySeq),
    }),
  };
}

async function makePostgresKit(hidePort: boolean): Promise<Kit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const base = new PostgresMemoryStore(db);
  const eventStore = new PostgresEventStore(db);
  const memoryStore = hidePort ? withoutSupersedePort(base) : base;
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
}

// 口の有る経路（`supersedeWithNewMemories`）と、口の無い adapter 向けの経路（`createMemoryWithOutbox` の
// ループ）を、どちらの store でも通す。
const KITS: Array<[string, () => Promise<Kit>]> = [
  ["testkit の InMemory（abortIfForgotten を実装しない）", () => makeInMemoryKit(false)],
  ["testkit の InMemory・supersedeWithNewMemories の口なし", () => makeInMemoryKit(true)],
  ["Postgres", () => makePostgresKit(false)],
  ["Postgres・supersedeWithNewMemories の口なし", () => makePostgresKit(true)],
];

const ctx: Ctx = { tenantId: "reextract-forget-race" };

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: reextract が LLM を待つ間に、元の記憶を forget したとき`, () => {
    for (const withPurge of [false, true]) {
      const label = withPurge ? "forget と purge" : "forget";

      it(`X を ${label} しても、言い換えの記憶は書かれず、イベントは created が増えない`, async () => {
        const kit = await makeKit();
        contents = ["猫は3匹"];
        const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
        const x = first.memoryIds[0]!;

        contents = ["猫を3匹飼っている"];
        const hold = holdNextCall();
        const pending = kit.runtime.reextract(ctx, first.observationId);
        await hold.stopped;
        expect((await kit.runtime.forget(ctx, { memoryId: x })).outcomes[0]?.kind).toBe(
          "forgotten",
        );
        if (withPurge) {
          expect((await kit.runtime.purge(ctx, { memoryId: x })).outcomes[0]?.kind).toBe("purged");
        }
        hold.resume();
        const result = await pending;

        expect(result).toMatchObject({
          observationId: first.observationId,
          memoryIds: [],
          supersededMemoryIds: [],
          atomicity: "not_attempted",
          extraction: "skipped",
          extractionFailure: null,
        });
        expect(result.skipped).toEqual([
          { kind: "status_not_active", memoryId: x, status: "forgotten" },
        ]);

        const all = await kit.memoryStore.listBySourceObservationAllVersions(
          ctx,
          first.observationId,
        );
        expect(all.map((m) => ({ id: m.id, status: m.status }))).toEqual([
          { id: x, status: "forgotten" },
        ]);

        const kinds = (await kit.eventStore.list(ctx, {})).map((e) => e.kind).sort();
        expect(kinds).toEqual(
          withPurge ? ["created", "forgotten", "purged"] : ["created", "forgotten"],
        );
      });
    }

    it("2件のうち X だけを forget しても、もう1件（X2）は置き換えられず、何も書かれない", async () => {
      const kit = await makeKit();
      contents = ["猫は3匹", "犬は1匹"];
      const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹、犬は1匹" });
      const [x, x2] = first.memoryIds as [string, string];

      contents = ["猫を3匹飼っている"];
      const hold = holdNextCall();
      const pending = kit.runtime.reextract(ctx, first.observationId);
      await hold.stopped;
      await kit.runtime.forget(ctx, { memoryId: x });
      hold.resume();
      const result = await pending;

      expect(result.memoryIds).toEqual([]);
      expect(result.supersededMemoryIds).toEqual([]);
      expect(result.atomicity).toBe("not_attempted");
      expect(result.skipped).toEqual([
        { kind: "status_not_active", memoryId: x, status: "forgotten" },
      ]);
      const stillX2 = await kit.memoryStore.get(ctx, x2);
      expect(stillX2?.status).toBe("active");
      expect(stillX2?.supersededById).toBeNull();
      expect(
        (await kit.memoryStore.listBySourceObservationAllVersions(ctx, first.observationId)).length,
      ).toBe(2);
    });

    it("待つ間に何も起きなければ、今どおり言い換えが active で書かれ X は置き換えられる（歯が空振りしない対照）", async () => {
      const kit = await makeKit();
      contents = ["猫は3匹"];
      const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
      const x = first.memoryIds[0]!;

      contents = ["猫を3匹飼っている"];
      const hold = holdNextCall();
      const pending = kit.runtime.reextract(ctx, first.observationId);
      await hold.stopped;
      hold.resume();
      const result = await pending;

      expect(result.extraction).toBe("ok");
      expect(result.supersededMemoryIds).toEqual([x]);
      expect(result.memoryIds.length).toBe(1);
      const created = await kit.memoryStore.get(ctx, result.memoryIds[0]!);
      expect(created?.status).toBe("active");
    });
  });
}
