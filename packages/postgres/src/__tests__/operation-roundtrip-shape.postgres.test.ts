import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryId, Runtime } from "@mnemora/core";
import {
  ClaimKeyBatchResultSchema,
  ConsolidationLLMResultSchema,
  ExtractionResultSchema,
  createRuntime,
} from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
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
 * 往復数そのものも時間も固定しない（実装の細部や CI の揺れで動くため）。同じ操作を件数 N だけ変えて呼び、次のどちらかの形だけを見る:
 * - N に比例しない: N を変えても往復数が等しい。
 * - 1件あたりの増分が一定: N=1→5 と N=5→20 で、1件あたりの往復の増分が等しい。これらの操作は1件ずつ CAS で書く・ジョブを1件ずつ処理する・抽出した候補を1件ずつ書く設計なので、N に比例すること自体は本来の形である。
 *   この歯が捕まえるのは、それが N の2乗（1件ごとに N に比例する処理が挟まる形）へ崩れる回帰である。
 */

const ctx: Ctx = { tenantId: "operation-roundtrip-shape", subjectId: "s1" };

async function countClientQueries(fn: () => Promise<unknown>): Promise<number> {
  let count = 0;
  const originalQuery = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    count += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any).apply(this, args);
  };
  try {
    await fn();
  } finally {
    Client.prototype.query = originalQuery;
  }
  return count;
}

/** 抽出で返す候補の件数（各 it が設定する）。claimKey も同じ件数を返す。 */
let candidates = 1;
/** 1回目の抽出だけ失敗させる（reextract の土台の全文フォールバックを作るため）。 */
let failNextExtraction = false;

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    const schema = req.schema as unknown;
    if (schema === ExtractionResultSchema) {
      if (failNextExtraction) {
        failNextExtraction = false;
        throw new Error("最初の抽出は失敗させる");
      }
      return req.schema.parse({
        memories: Array.from({ length: candidates }, (_, i) => ({
          content: `事実${i} ${Math.random()}`,
          provenanceKind: "stated",
        })),
      });
    }
    if (schema === ClaimKeyBatchResultSchema) {
      return req.schema.parse({
        claims: Array.from({ length: candidates }, (_, i) => ({
          subject: "user",
          predicate: `p${i}`,
        })),
      });
    }
    if (schema === ConsolidationLLMResultSchema) {
      return req.schema.parse({ content: "統合した本文" });
    }
    return req.schema.parse({ outcome: "reflected", content: "内省した本文" });
  },
};

interface Kit {
  runtime: Runtime;
  memoryStore: PostgresMemoryStore;
}

const CLOCK_AHEAD_MS = 60_000;

async function kit(): Promise<Kit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: llm,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => new Date(Date.now() + CLOCK_AHEAD_MS) },
  });
  return { runtime, memoryStore };
}

let seq = 0;
async function memories(k: Kit, n: number, decayed = false): Promise<MemoryId[]> {
  const ids: MemoryId[] = [];
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    const memory = await k.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        subjectId: "s1",
        contentHash: `shape-${seq}`,
        content: `記憶 ${seq}`,
        ...(decayed ? { decayFloorAt: new Date("2026-01-02T00:00:00.000Z") } : {}),
      }),
    );
    ids.push(memory.id);
  }
  return ids;
}

const ARCHIVE_NOW = new Date("2030-01-01T00:00:00.000Z");

/** 件数 N で、操作の準備をしてから、数える対象の呼び出しを返す。 */
type Prepare = (k: Kit, n: number) => Promise<() => Promise<unknown>>;

async function tripsFor(prepare: Prepare, n: number): Promise<number> {
  const k = await kit();
  const call = await prepare(k, n);
  return countClientQueries(call);
}

afterAll(async () => {
  await closeTestClient();
});

describe("N に比例しない", () => {
  it("sweepArchive: 掃引で archived にする件数 N=1 と N=20 で往復数が等しい", async () => {
    const prepare: Prepare = async (k, n) => {
      await memories(k, n, true);
      return () => k.runtime.sweepArchive(ctx, { now: ARCHIVE_NOW, limit: 1000 });
    };
    expect(await tripsFor(prepare, 20)).toBe(await tripsFor(prepare, 1));
  });
});

const LINEAR: Array<[string, Prepare]> = [
  [
    "observe（sync）: 抽出の候補 N 件",
    async (k, n) => {
      candidates = n;
      return () => k.runtime.observe(ctx, { kind: "utterance", text: `発話 ${Math.random()}` });
    },
  ],
  [
    "observe（sync）: 抽出の候補 N 件 + claimKey の矛盾検出",
    async (k, n) => {
      candidates = n;
      await memories(k, 3);
      return () =>
        k.runtime.observe(ctx, {
          kind: "utterance",
          text: `発話 ${Math.random()}`,
          claimKey: { enabled: true, detectContested: true },
        });
    },
  ],
  [
    "tick（embed）: ジョブ N 件",
    async (k, n) => {
      for (let i = 0; i < n; i += 1) {
        seq += 1;
        await k.memoryStore.createMemoryWithOutbox(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `shape-embed-${seq}` }),
          ["embed"],
        );
      }
      return () => k.runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000, limit: 100 });
    },
  ],
  [
    "tick（extract）: ジョブ N 件（各1候補）",
    async (k, n) => {
      candidates = 1;
      for (let i = 0; i < n; i += 1) {
        await k.runtime.observe(ctx, {
          kind: "utterance",
          text: `発話${i} ${Math.random()}`,
          extract: "deferred",
        });
      }
      return () => k.runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000, limit: 100 });
    },
  ],
  [
    "forget: N 件",
    async (k, n) => {
      const ids = await memories(k, n);
      return () => k.runtime.forget(ctx, { memoryIds: ids });
    },
  ],
  [
    "purge: N 件",
    async (k, n) => {
      const ids = await memories(k, n);
      await k.runtime.forget(ctx, { memoryIds: ids });
      return () => k.runtime.purge(ctx, { memoryIds: ids });
    },
  ],
  [
    "restoreArchived: N 件",
    async (k, n) => {
      const ids = await memories(k, n, true);
      await k.runtime.sweepArchive(ctx, { now: ARCHIVE_NOW, limit: 1000 });
      return () => k.runtime.restoreArchived(ctx, { memoryIds: ids });
    },
  ],
  [
    "consolidate: 統合元 N+1 件",
    async (k, n) => {
      const ids = await memories(k, n + 1);
      return () => k.runtime.consolidate(ctx, { target: { memoryIds: ids } });
    },
  ],
  [
    "reextract: 新しい候補 N 件",
    async (k, n) => {
      candidates = n;
      failNextExtraction = true;
      const observed = await k.runtime.observe(ctx, {
        kind: "utterance",
        text: `元の発話 ${Math.random()}`,
      });
      return () => k.runtime.reextract(ctx, observed.observationId);
    },
  ],
];

describe("1件あたりの往復の増分が一定（N の2乗へ崩れない）", () => {
  it.each(LINEAR)("%s: N=1→5 と N=5→20 で1件あたりの増分が等しい", async (_label, prepare) => {
    const t1 = await tripsFor(prepare, 1);
    const t5 = await tripsFor(prepare, 5);
    const t20 = await tripsFor(prepare, 20);
    expect(t5).toBeGreaterThan(t1);
    expect((t20 - t5) / 15).toBe((t5 - t1) / 4);
  });
});
