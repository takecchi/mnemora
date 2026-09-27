import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
import { ExtractionResultSchema, createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * LLM・埋め込みの provider が返らない・遅いときの今の振る舞いを縛る（Issue #1200。
 * `LLMProvider`・`EmbeddingProvider`・`TickOptions.leaseMs` の doc の 2026-09-27 追記）。振る舞いは変えていない。
 *
 * 1. runtime は時間の上限も中断の口も持たないので、provider が返るまで observe・recall・tick も返らない
 *    （provider を返すと返る）。Postgres と testkit の fixture で同じ。
 * 2. 待っている間、DB の接続を握らない（Postgres、`max: 1` の pool の横から別の DB 操作が通る）。
 * 3. tick の処理がリースより長く掛かっても、別の tick が取らなければ完了は通り、何も名乗らない。
 */

let release: () => void = () => {};
let reached: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
/** 次の provider の呼び出しを止める。止まったら解決する Promise と、再開する関数を返す。 */
function holdNextCall(): { stopped: Promise<void>; resume: () => void } {
  gate = new Promise((resolve) => (release = resolve));
  const stopped = new Promise<void>((resolve) => (reached = resolve));
  return { stopped, resume: () => release() };
}
async function passGate(): Promise<void> {
  reached();
  await gate;
}

let nowMs = Date.parse("2030-01-01T00:00:00.000Z");
const llm: LLMProvider = {
  complete: async () => ({ content: "" }),
  completeStructured: async (_ctx, req) => {
    await passGate();
    if ((req.schema as unknown) !== ExtractionResultSchema) throw new Error("unexpected schema");
    return req.schema.parse({
      memories: [{ content: `事実 ${Math.random()}`, provenanceKind: "stated" }],
    });
  },
};
const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => {
      await passGate();
      return texts.map(() => [1, 0, 0]);
    },
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  clock: { now: () => new Date(nowMs) },
};

/** `p` が `ms` のうちに決着したか。 */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]);
  clearTimeout(timer);
  return settled;
}

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
}

function testkitKit(): Kit {
  const memoryStore = new InMemoryMemoryStore();
  return {
    memoryStore,
    runtime: createRuntime({
      ...shared,
      memoryStore,
      outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
      vectorStore: new InMemoryVectorStore(memoryStore),
      eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
      tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
    }),
  };
}

function postgresKitOn(client: PostgresClient): Kit {
  const { db } = client;
  const memoryStore = new PostgresMemoryStore(db);
  return {
    memoryStore,
    runtime: createRuntime({
      ...shared,
      memoryStore,
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    }),
  };
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  ["testkit の InMemory", async () => testkitKit()],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      return postgresKitOn(await getTestClient());
    },
  ],
];

const ctx: Ctx = { tenantId: "provider-hang" };

type Call = [string, (kit: Kit) => Promise<unknown>];
const CALLS: Call[] = [
  [
    "recall（クエリ埋め込み）",
    (kit) => kit.runtime.recall(ctx, { text: "埋め込む", limit: 3, association: null }),
  ],
  ["tick（embed ジョブ）", (kit) => kit.runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 })],
  ["observe（sync 抽出）", (kit) => kit.runtime.observe(ctx, { kind: "utterance", text: "発話" })],
];

async function seedEmbedJob(kit: Kit): Promise<void> {
  await kit.memoryStore.createMemoryWithOutbox(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `hang-${Math.random()}`,
      content: "埋め込む",
    }),
    ["embed"],
  );
  nowMs += 1000;
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: provider が返らない・遅いとき（今の振る舞い）`, () => {
    it.each(CALLS)("%s は provider が返るまで返らず、返すと返る", async (_label, call) => {
      const kit = await makeKit();
      await seedEmbedJob(kit);
      const hold = holdNextCall();
      const pending = call(kit);
      await hold.stopped;
      expect(await settlesWithin(pending, 300)).toBe(false);
      hold.resume();
      expect(await settlesWithin(pending, 5000)).toBe(true);
    });

    it("tick: 処理がリースより長く掛かっても、別の tick が取らなければ完了は通り、何も名乗らない", async () => {
      const kit = await makeKit();
      await seedEmbedJob(kit);
      const hold = holdNextCall();
      const pending = kit.runtime.tick(ctx, { kinds: ["embed"], leaseMs: 1000 });
      await hold.stopped;
      nowMs += 10_000; // runtime の時計でリースを切らす
      hold.resume();
      expect(await pending).toEqual({
        processed: 1,
        failed: 0,
        unsupported: [],
        leaseConflicts: [],
      });
    });
  });
}

describe("Postgres: provider を待っている間、DB の接続を握らない（max: 1 の pool）", () => {
  it.each(CALLS)("%s が provider を待つ横から、別の DB 操作が通る", async (_label, call) => {
    await resetTestDatabase();
    await getTestClient(); // migration と埋め込み空間の登録
    const client = createPostgresClient(requireDatabaseUrl(), { max: 1 });
    try {
      const kit = postgresKitOn(client);
      await seedEmbedJob(kit);
      const hold = holdNextCall();
      const pending = call(kit);
      await hold.stopped;
      const sideWrite = kit.memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `side-${Math.random()}`,
          content: "横",
        }),
      );
      expect(await settlesWithin(sideWrite, 3000)).toBe(true);
      hold.resume();
      expect(await settlesWithin(pending, 5000)).toBe(true);
    } finally {
      await closePostgresClient(client);
    }
  });
});
