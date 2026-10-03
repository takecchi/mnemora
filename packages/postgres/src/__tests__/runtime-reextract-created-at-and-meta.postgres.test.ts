import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  EventStore,
  LLMProvider,
  MemoryEvent,
  MemoryStore,
  Runtime,
} from "@mnemora/core";
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
 * reextract の `created` イベントの中身を、同じ操作の `superseded` と揃える歯。
 *
 * 穴（c1f4cf1）:
 * 1. `at` のずれ: reextract は入口で `now = clock.now()` を取り、`superseded` はこの `now` を使う。
 *    一方 `created` は `buildCreatedEventFor` が組み立てるときに `clock.now()` を読み直すので、
 *    LLM の待ちの分だけ `superseded` より後になる。
 * 2. meta の区別が無い: reextract の `created` の meta は observe と同じ形（`reason: "extracted"`）で、
 *    再抽出から来たことを示すキーが無い。
 *
 * 直しの方針: 同じ操作の中で `created` と `superseded` の `at` を揃える（入口の `now`）。
 * reextract の `created` の meta に、再抽出を示すキーを**足す**（既存キーの意味は変えない。
 * observe の `created` の meta の形は変えない）。
 *
 * ## 検査の形
 * 時計を注入し、`llm.completeStructured` の中で時計を進める。こうして「入口の `now`」と
 * 「組み立て時の `clock.now()`」が違う状況を作る。
 *
 * 経路は4つ（ストアは実 adapter 2つ × 3経路のうち、Postgres と InMemory の口あり、
 * それぞれを包んだ口なし・名乗らない adapter）:
 * - 口あり: `supersedeWithNewMemories` が `opts.buildCreatedEvent` で `created` を同じトランザクションで積む。
 * - 名乗らない: 口はあるが `buildCreatedEvent` を黙って無視し `createdEventsWritten` を返さない。
 *   runtime が別の `appendCreatedEvent` で積む。
 * - 口なし: `supersedeWithNewMemories` が無い。`createMemoryWithOutbox` + supersede ループ。
 *
 * ⚠ `created` と `superseded` の**並び**（同じ `at` の中での順）は縛らない。
 */

/** 再抽出を示す meta のキー。名前は実装の担当が決める——決まったらここだけを差し替える。 */
const REEXTRACT_META_KEY = "reextracted";

/** LLM の待ちの長さ。入口の `now` と組み立て時の `clock.now()` を確実に分ける。 */
const LLM_LATENCY_MS = 5_000;

let nowMs = Date.now();
/** 実時刻より1秒だけ未来（歴史的な理由で残している。今は outbox の `available_at` も注入した時計に従う。ADR 0559）。 */
const clock = { now: () => new Date(nowMs + 1_000) };

let candidates: string[] = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    // LLM を待っている間に時計が進む。
    nowMs += LLM_LATENCY_MS;
    return req.schema.parse({
      memories: candidates.map((content) => ({ content, provenanceKind: "stated" })),
    });
  },
};

const hashContent = (content: string) => createHash("sha256").update(content).digest("hex");
const shared = {
  clock,
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent,
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
}

/** ストアを包む。関数は元のストアに束ねて返す（内部状態を持つ実装でも壊れないように）。 */
function wrapStore(
  store: MemoryStore,
  override: (target: MemoryStore) => Partial<Record<string, unknown>>,
): MemoryStore {
  const overrides = override(store);
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 口なし: `supersedeWithNewMemories` を持たない adapter。 */
const withoutPort = (store: MemoryStore) =>
  wrapStore(store, () => ({ supersedeWithNewMemories: undefined }));

/** 名乗らない: 口はあるが `buildCreatedEvent` を無視し、`createdEventsWritten` を返さない adapter。 */
const withSilentPort = (store: MemoryStore) =>
  wrapStore(store, (target) => ({
    supersedeWithNewMemories: async (
      ...args: Parameters<NonNullable<MemoryStore["supersedeWithNewMemories"]>>
    ) => {
      const [ctx, news, supersedes, opts] = args;
      const { buildCreatedEvent: _ignored, ...rest } = opts ?? {};
      const result = await target.supersedeWithNewMemories!(ctx, news, supersedes, rest);
      const { createdEventsWritten: _dropped, ...withoutClaim } = result;
      return withoutClaim;
    },
  }));

type StoreVariant = "口あり" | "名乗らない" | "口なし";
const VARIANTS: Array<[StoreVariant, (s: MemoryStore) => MemoryStore]> = [
  ["口あり", (s) => s],
  ["名乗らない", withSilentPort],
  ["口なし", withoutPort],
];

type Backend = [string, (variant: (s: MemoryStore) => MemoryStore) => Promise<Kit>];
const BACKENDS: Backend[] = [
  [
    "testkit の InMemory",
    async (variant) => {
      const real = new InMemoryMemoryStore();
      const memoryStore = variant(real);
      const eventStore = new InMemoryEventStore(real, real.events);
      return {
        memoryStore,
        eventStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          eventStore,
          vectorStore: new InMemoryVectorStore(real),
          outboxStore: new InMemoryOutboxStore(real.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(real.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async (variant) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = variant(new PostgresMemoryStore(db));
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

const ctx: Ctx = { tenantId: "runtime-reextract-created-at-and-meta" };

afterAll(async () => {
  await closeTestClient();
});

async function observeThenReextract(kit: Kit) {
  candidates = ["旧い事実"];
  const observed = await kit.runtime.observe(ctx, {
    kind: "utterance",
    text: "発話",
    externalId: "reextract-at-meta",
    extract: "sync",
  });
  const observationId = observed.observationId;
  const [old] = await kit.memoryStore.listBySourceObservation(ctx, observationId, "v1");
  const createdBefore = await kit.eventStore.list(ctx, { kind: "created" });
  expect(createdBefore).toHaveLength(1);

  candidates = ["新しい事実"];
  const result = await kit.runtime.reextract(ctx, observationId);
  expect(result.memoryIds).toHaveLength(1);
  expect(result.supersededMemoryIds).toEqual([old!.id]);

  const newId = result.memoryIds[0]!;
  const createdEvents = await kit.eventStore.list(ctx, { memoryId: newId, kind: "created" });
  const supersededEvents = await kit.eventStore.list(ctx, {
    memoryId: old!.id,
    kind: "superseded",
  });
  expect(createdEvents).toHaveLength(1);
  expect(supersededEvents).toHaveLength(1);
  return {
    observed,
    oldId: old!.id,
    created: createdEvents[0] as MemoryEvent,
    superseded: supersededEvents[0] as MemoryEvent,
    observeCreated: createdBefore[0] as MemoryEvent,
  };
}

for (const [backendName, makeKit] of BACKENDS) {
  for (const [variantName, variant] of VARIANTS) {
    describe(`${backendName}・${variantName}: reextract の created（supersede が起きるとき）`, () => {
      it("(a) created の at が、同じ操作の superseded の at と等しい", async () => {
        const kit = await makeKit(variant);
        const { created, superseded } = await observeThenReextract(kit);
        expect(created.at.getTime()).toBe(superseded.at.getTime());
      });

      it("(b) created の meta に、再抽出を示すキーがある（既存の reason は変わらない）", async () => {
        const kit = await makeKit(variant);
        const { created } = await observeThenReextract(kit);
        expect(created.meta).toHaveProperty(REEXTRACT_META_KEY, true);
        expect(created.meta.reason).toBe("extracted");
      });

      it("(c) 同じ条件の observe の created には、再抽出を示すキーが無い", async () => {
        const kit = await makeKit(variant);
        const { observeCreated } = await observeThenReextract(kit);
        expect(observeCreated.meta.reason).toBe("extracted");
        expect(observeCreated.meta).not.toHaveProperty(REEXTRACT_META_KEY);
      });
    });
  }
}
