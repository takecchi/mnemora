import { createHash, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, Runtime } from "@mnemora/core";
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
 * 大きさの端の今の振る舞いを縛る（振る舞いは変えていない）。
 *
 * 1. LLM が失敗したときの全文フォールバック（Issue #1222）: 語の多い本文で tsvector が 1MB を超えると、
 *    `@mnemora/postgres` ではフォールバックの Memory が書けず、`observe()` が DB の例外を投げる。
 *    Observation と extract ジョブは残り、Memory は0件。testkit の fixture は1件残す。
 * 2. claimKey の主語・述語（Issue #1074 の続き、`Ctx` の doc）: 索引の1行の上限を超える長さは、
 *    Postgres だけが例外にする。
 */

const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async () => {
      throw new Error("llm down");
    },
  },
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  /** Postgres だけ。fixture の表は private なので、fixture の側は戻り値で確かめる。 */
  counts?: () => Promise<{ observations: number; memories: number; pendingExtract: number }>;
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
      const { db, pool } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const count = async (sql: string) => ((await pool.query(sql)).rows[0] as { n: number }).n;
      return {
        memoryStore,
        counts: async () => ({
          observations: await count("SELECT count(*)::int AS n FROM observations"),
          memories: await count("SELECT count(*)::int AS n FROM memories"),
          pendingExtract: await count(
            "SELECT count(*)::int AS n FROM outbox WHERE kind = 'extract' AND completed_at IS NULL AND failed_at IS NULL",
          ),
        }),
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

const ctx: Ctx = { tenantId: "whole-observation-fallback-size" };

/** ランダムな12桁の16進の語を空白で区切り、およそ `bytes` バイトにする（語が多く、tsvector が大きくなる）。 */
function manyWords(bytes: number): string {
  const words: string[] = [];
  for (let n = 0; n < bytes; n += 13) words.push(randomBytes(6).toString("hex"));
  return words.join(" ");
}

/** 圧縮の効かない、長さ `n` の英数字。 */
function incompressible(n: number): string {
  return randomBytes(n)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "a")
    .slice(0, n);
}

afterAll(async () => {
  await closeTestClient();
});

describe("LLM が失敗したときの全文フォールバックと本文の大きさ（今の振る舞い、Issue #1222）", () => {
  for (const [name, makeKit] of KITS) {
    it(`${name}: 約0.5MB の本文は、フォールバックの Memory 1件として残る`, async () => {
      const kit = await makeKit();
      const result = await kit.runtime.observe(ctx, {
        kind: "utterance",
        text: manyWords(500_000),
      });
      expect(result.extraction).toBe("llm_failed_whole_observation");
      expect(result.memoryIds).toHaveLength(1);
      if (kit.counts) expect((await kit.counts()).memories).toBe(1);
    });

    it(`${name}: 約1.2MB の語の多い本文`, async () => {
      const kit = await makeKit();
      const call = kit.runtime.observe(ctx, { kind: "utterance", text: manyWords(1_200_000) });
      if (name === "Postgres") {
        await expect(call).rejects.toThrow();
        await call.catch((error: unknown) => {
          const cause = (error as { cause?: { message?: string } }).cause;
          expect(cause?.message).toMatch(/string is too long for tsvector/);
        });
        expect(await kit.counts!()).toEqual({ observations: 1, memories: 0, pendingExtract: 1 });
      } else {
        const result = await call;
        expect(result.extraction).toBe("llm_failed_whole_observation");
        expect(result.memoryIds).toHaveLength(1);
      }
    });
  }
});

describe("claimKey の主語・述語の長さ（今の振る舞い、Issue #1074 の続き）", () => {
  for (const [name, makeKit] of KITS) {
    it(`${name}: 圧縮の効かない約3KB の述語`, async () => {
      const kit = await makeKit();
      const create = kit.memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "claim-key-long",
          content: "本文",
          claimKey: { subject: "user", predicate: incompressible(3000) },
        }),
      );
      if (name === "Postgres") {
        await expect(create).rejects.toThrow();
        await create.catch((error: unknown) => {
          const cause = (error as { cause?: { message?: string } }).cause;
          expect(cause?.message).toMatch(/index row/);
        });
        expect((await kit.counts!()).memories).toBe(0);
      } else {
        await expect(create).resolves.toMatchObject({ contentHash: "claim-key-long" });
      }
    });
  }
});
