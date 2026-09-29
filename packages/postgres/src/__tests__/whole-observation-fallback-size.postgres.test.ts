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
import { PostgresLexicalStore } from "../lexical-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 大きさの端の今の振る舞いを縛る。
 *
 * 1. LLM が失敗したときの全文フォールバック（Issue #1222、migrations/0025・ADR 0364で直した）:
 *    語の多い本文で tsvector が1MBを超えても、`@mnemora/postgres` はフォールバックの Memory を
 *    書ける——`mnemora_lexical_tsvector`（`idx_memories_lexical` の式）が、1MBを超える本文
 *    だけ先頭150,000文字で tsvector を作り直すため。**本文は1文字も欠けずに `memories.content`
 *    へ残る**——縮退するのは語彙**索引**（先頭150,000文字だけが語彙検索の対象になる）だけで、
 *    保存される本文そのものではない。⚠ **これは 2026-09-27 に書いた「Postgres では動かない」
 *    という記録（PR #1224、`docs/memory-model.md` §4・`extraction.ts` の同日追記）を反転させる**
 *    ——このファイルの歯自体も、その反転後の振る舞いを縛る側へ書き換えた。
 * 2. claimKey の主語・述語（Issue #1074 の続き、`Ctx` の doc）: 索引の1行の上限を超える長さは、
 *    Postgres だけが例外にする（この振る舞いは本 PR の対象外——変えていない）。
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

    it(`${name}: 約1.2MB の語の多い本文でも、フォールバックの Memory が1件残り、本文が1文字も欠けない（Issue #1222、migrations/0025）`, async () => {
      const kit = await makeKit();
      // 先頭と末尾に一意な語を置く——「先頭部分の語は語彙検索で引ける」ことと
      // 「本文は丸ごと保存される（末尾の語も文字として残る）」ことを、別々に確かめるため。
      const text = `MNEMORA-FRONT-MARKER ${manyWords(1_200_000)} MNEMORA-TAIL-MARKER`;
      const result = await kit.runtime.observe(ctx, { kind: "utterance", text });

      expect(result.extraction).toBe("llm_failed_whole_observation");
      expect(result.memoryIds).toHaveLength(1);
      if (kit.counts) expect((await kit.counts()).memories).toBe(1);

      // 本文は1文字も欠けずに保存される（縮退するのは語彙索引だけ）。
      const memory = await kit.memoryStore.get(ctx, result.memoryIds[0]!);
      expect(memory?.content).toBe(text);

      if (name === "Postgres") {
        // 先頭150,000文字の中に在る語は語彙検索で引ける。
        const { db } = await getTestClient();
        const lexicalStore = new PostgresLexicalStore(db);
        const hits = await lexicalStore.search(ctx, "MNEMORA-FRONT-MARKER", {
          limit: 10,
          filter: { tenantId: ctx.tenantId },
        });
        expect(hits.map((h) => h.memoryId)).toContain(result.memoryIds[0]);
      }
    });

    it(`${name}: 約1.2MB の語の多い本文を createMemory 直接で書いても通る（observe() 経由と同じ結論）`, async () => {
      const kit = await makeKit();
      const text = manyWords(1_200_000);
      const create = kit.memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "whole-observation-fallback-size-direct",
          content: text,
        }),
      );
      await expect(create).resolves.toMatchObject({ content: text });
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
